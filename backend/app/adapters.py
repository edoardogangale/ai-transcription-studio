"""Adattatori dei modelli (tutti su sherpa-onnx). Interfaccia comune:
    load(device) ; transcribe(samples_f32_16k, language, prompt) -> [ {start,end,text,words?} ] ; unload()
I tempi sono relativi all'inizio del campione passato. L'adattatore è thread-safe (lock interno), così più lavori
possono usare lo stesso modello alternandosi chunk per chunk."""
import gc
import os
import threading
from pathlib import Path

from . import registry


class ASRAdapter:
    word_timestamps = False
    detected = None

    def __init__(self):
        self.lock = threading.Lock()

    def load(self, device: str): ...
    def transcribe(self, samples, language, prompt=None): raise NotImplementedError
    def unload(self): gc.collect()


def _find(d: Path, *patterns):
    """Primo file che combacia, preferendo le versioni int8 (più leggere su CPU)."""
    hits = []
    for p in patterns:
        hits += sorted(d.glob(p))
    hits = [h for h in hits if h.suffix == ".onnx"] or hits
    int8 = [h for h in hits if "int8" in h.name]
    return str((int8 or hits)[0]) if hits else None


def _threads():
    return max(1, int(os.environ.get("STUDIO_THREADS", os.cpu_count() or 1)))


class TransducerAdapter(ASRAdapter):
    """Parakeet TDT (NeMo transducer) via sherpa-onnx. Timestamp per token -> per parola."""
    word_timestamps = True

    def __init__(self, mid):
        super().__init__()
        self.mid = mid

    def load(self, device):
        import sherpa_onnx
        d = registry.model_dir(self.mid)
        self.rec = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=_find(d, "encoder*.onnx"), decoder=_find(d, "decoder*.onnx"), joiner=_find(d, "joiner*.onnx"),
            tokens=str(d / "tokens.txt"), num_threads=_threads(), model_type="nemo_transducer",
            provider="cuda" if device == "cuda" else "cpu")

    def transcribe(self, samples, language, prompt=None):
        with self.lock:
            s = self.rec.create_stream()
            s.accept_waveform(16000, samples)
            self.rec.decode_stream(s)
            r = s.result
        text = (r.text or "").strip()
        if not text:
            return []
        dur = len(samples) / 16000
        words = tokens_to_words(list(r.tokens), list(r.timestamps))
        for i, w in enumerate(words):  # fine parola = inizio della successiva (o +0.4 s sull'ultima)
            w["e"] = words[i + 1]["s"] if i + 1 < len(words) else min(dur, w["s"] + 0.4)
        return [{"start": words[0]["s"] if words else 0.0, "end": dur, "text": text, "words": words}]

    def unload(self):
        self.rec = None
        gc.collect()


class WhisperAdapter(ASRAdapter):
    """Whisper (small/base/turbo/large-v3) via sherpa-onnx, con timestamp di segmento/token quando disponibili."""

    def __init__(self, mid):
        super().__init__()
        self.mid = mid

    def load(self, device):
        import sherpa_onnx
        d = registry.model_dir(self.mid)
        self.d, self.device = d, device
        self.recs = {}  # una istanza per lingua (la lingua è fissata alla creazione)

    def _rec(self, lang):
        import sherpa_onnx
        if lang not in self.recs:
            kw = dict(encoder=_find(self.d, "*encoder*.onnx"), decoder=_find(self.d, "*decoder*.onnx"),
                      tokens=_find(self.d, "*tokens.txt"), language="" if lang == "auto" else lang, task="transcribe",
                      num_threads=_threads(), provider="cuda" if self.device == "cuda" else "cpu")
            try:
                self.recs[lang] = sherpa_onnx.OfflineRecognizer.from_whisper(enable_token_timestamps=True, enable_segment_timestamps=True, **kw)
                self.ts = True
            except TypeError:
                self.recs[lang] = sherpa_onnx.OfflineRecognizer.from_whisper(**kw)
                self.ts = False
        return self.recs[lang]

    def transcribe(self, samples, language, prompt=None):
        with self.lock:
            rec = self._rec(language)
            s = rec.create_stream()
            s.accept_waveform(16000, samples)
            rec.decode_stream(s)
            r = s.result
        text = (r.text or "").strip()
        self.detected = getattr(r, "lang", None) or self.detected
        if not text:
            return []
        dur = len(samples) / 16000
        words = []
        toks, stamps = list(getattr(r, "tokens", []) or []), list(getattr(r, "timestamps", []) or [])
        if toks and len(toks) == len(stamps) and stamps:
            words = _whisper_words(toks, stamps, dur)
        return [{"start": words[0]["s"] if words else 0.0, "end": dur, "text": text, "words": words}]

    def unload(self):
        self.recs = {}
        gc.collect()


def _whisper_words(tokens, stamps, dur):
    words = tokens_to_words(tokens, stamps)
    for i, w in enumerate(words):
        w["e"] = words[i + 1]["s"] if i + 1 < len(words) else min(dur, w["s"] + 0.4)
    return words


def tokens_to_words(tokens, stamps):
    """Raggruppa i token BPE in parole col tempo del primo token. L'inizio-parola è marcato da '▁' (SentencePiece)
    oppure da uno spazio iniziale (come restituisce sherpa-onnx: ' par', 'ler', 'emo')."""
    words, cur, t0 = [], "", None
    for tok, ts in zip(tokens, stamps):
        starts = tok[:1] in (" ", "▁")
        if (starts or cur == "") and cur.strip():
            words.append({"w": cur.strip(), "s": round(t0, 3), "e": round(t0, 3)})
            cur = ""
        if cur == "":
            t0 = ts
        cur += tok.replace("▁", " ") if cur == "" else tok
    if cur.strip():
        words.append({"w": cur.strip(), "s": round(t0, 3), "e": round(t0, 3)})
    return words


class MockAdapter(ASRAdapter):
    """SOLO TEST (STUDIO_ENABLE_MOCK=1). Non è un modello ASR: restituisce testo deterministico
    derivato dalla durata del campione per esercitare l'intera pipeline."""
    word_timestamps = True

    def __init__(self, variant=False):
        super().__init__()
        self.variant = variant  # "mock2": diverge in alcune parole, per testare il confronto

    def load(self, device):
        pass

    def transcribe(self, samples, language, prompt=None):
        import time
        time.sleep(float(os.environ.get("STUDIO_MOCK_DELAY", "0")))
        d = len(samples) / 16000
        n = max(3, int(d // 2))
        words = [{"w": f"parola{i}" if not (self.variant and i % 4 == 3) else f"parolina{i}", "s": round(i * d / n, 3),
                  "e": round((i + 1) * d / n, 3)} for i in range(n)]
        return [{"start": 0.0, "end": round(d, 3), "text": " ".join(w["w"] for w in words), "words": words}]


def create(mid):
    if mid.startswith("mock"):
        return MockAdapter(variant=mid == "mock2")
    kind = registry.MODELS[mid]["kind"]
    return TransducerAdapter(mid) if kind == "transducer" else WhisperAdapter(mid)
