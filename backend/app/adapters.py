"""Adattatori dei modelli. Interfaccia comune:
    load(device) ; transcribe(samples_f32_16k, language, prompt) -> [ {start,end,text,words?} ] ; unload()
I tempi sono relativi all'inizio del campione passato. Nessun adattatore è stato eseguito con pesi reali in
questo ambiente (Hugging Face irraggiungibile): vedi README, sezione "Cosa NON è stato verificato"."""
import gc
from . import registry


class ASRAdapter:
    word_timestamps = False

    def load(self, device: str): ...
    def transcribe(self, samples, language, prompt=None): raise NotImplementedError
    def unload(self): gc.collect()


class WhisperAdapter(ASRAdapter):
    word_timestamps = True

    def load(self, device):
        from faster_whisper import WhisperModel
        compute = "float16" if device == "cuda" else "int8"
        self.model = WhisperModel(str(registry.model_dir("whisper-large-v3")), device=device, compute_type=compute)

    def transcribe(self, samples, language, prompt=None):
        # VAD interno disattivato: la segmentazione è già fatta a monte. condition_on_previous_text=False
        # evita la propagazione di allucinazioni/ripetizioni tra finestre.
        segs, info = self.model.transcribe(
            samples, language=None if language == "auto" else language, beam_size=5, word_timestamps=True,
            condition_on_previous_text=False, initial_prompt=prompt or None, vad_filter=False)
        out = []
        for s in segs:
            words = [{"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)} for w in (s.words or [])]
            out.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip(), "words": words})
        self.detected = info.language
        return out

    def unload(self):
        self.model = None
        gc.collect()


class ParakeetAdapter(ASRAdapter):
    word_timestamps = True

    def __init__(self, mid):
        self.mid = mid

    def load(self, device):
        import onnx_asr
        prov = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
        m = onnx_asr.load_model(registry.MODELS[self.mid]["onnx_name"], registry.model_dir(self.mid),
                                quantization="int8", providers=prov)
        self.model = m.with_timestamps()

    def transcribe(self, samples, language, prompt=None):
        r = self.model.recognize(samples, sample_rate=16000)
        text = (r.text or "").strip()
        if not text:
            return []
        words = tokens_to_words(r.tokens or [], r.timestamps or [])
        dur = len(samples) / 16000
        if words:  # chiude l'ultima parola alla fine del segnale o a +0.4 s
            for i, w in enumerate(words):
                w["e"] = words[i + 1]["s"] if i + 1 < len(words) else min(dur, w["s"] + 0.4)
        return [{"start": words[0]["s"] if words else 0.0, "end": dur, "text": text, "words": words}]

    def unload(self):
        self.model = None
        gc.collect()


def tokens_to_words(tokens, stamps):
    """Raggruppa i token SentencePiece (inizio parola = '▁') in parole con il timestamp del primo token."""
    words, cur, t0 = [], "", None
    for tok, ts in zip(tokens, stamps):
        if tok.startswith("▁") or cur == "":
            if cur.strip():
                words.append({"w": cur.strip(), "s": round(t0, 3), "e": round(t0, 3)})
            cur, t0 = tok.replace("▁", ""), ts
        else:
            cur += tok
    if cur.strip():
        words.append({"w": cur.strip(), "s": round(t0, 3), "e": round(t0, 3)})
    return words


class VoxtralAdapter(ASRAdapter):
    """SPERIMENTALE e non verificata. Usa transformers; richiede GPU e `pip install -r requirements-voxtral.txt`."""

    def load(self, device):
        try:
            import torch
            from transformers import AutoProcessor, VoxtralForConditionalGeneration  # noqa
        except ImportError as e:
            raise RuntimeError("Dipendenze Voxtral mancanti (pip install -r requirements-voxtral.txt): %s" % e)
        path = str(registry.model_dir("voxtral-mini-4b-realtime"))
        self.torch = torch
        self.device = device
        self.processor = AutoProcessor.from_pretrained(path)
        self.model = VoxtralForConditionalGeneration.from_pretrained(path, torch_dtype=torch.bfloat16).to(device)

    def transcribe(self, samples, language, prompt=None):
        inputs = self.processor.apply_transcription_request(
            language=language if language != "auto" else "en", audio=samples, format=["WAV"],
            model_id=str(registry.model_dir("voxtral-mini-4b-realtime")))
        inputs = inputs.to(self.device, dtype=self.torch.bfloat16)
        with self.torch.no_grad():
            out = self.model.generate(**inputs, max_new_tokens=1024, do_sample=False)
        text = self.processor.batch_decode(out[:, inputs.input_ids.shape[1]:], skip_special_tokens=True)[0].strip()
        return [{"start": 0.0, "end": len(samples) / 16000, "text": text, "words": []}] if text else []

    def unload(self):
        self.model = self.processor = None
        gc.collect()
        try:
            self.torch.cuda.empty_cache()
        except Exception:
            pass


class MockAdapter(ASRAdapter):
    """SOLO TEST (STUDIO_ENABLE_MOCK=1). Non è un modello ASR: restituisce testo deterministico
    derivato dalla durata del campione per esercitare l'intera pipeline."""
    word_timestamps = True

    def __init__(self, variant=False):
        self.variant = variant  # "mock2": diverge in alcune parole, per testare il confronto

    def load(self, device):
        pass

    def transcribe(self, samples, language, prompt=None):
        import os, time
        time.sleep(float(os.environ.get("STUDIO_MOCK_DELAY", "0")))
        self.calls = getattr(self, "calls", 0) + 1
        d = len(samples) / 16000
        n = max(3, int(d // 2))
        words = [{"w": f"parola{i}" if not (self.variant and i % 4 == 3) else f"parolina{i}", "s": round(i * d / n, 3), "e": round((i + 1) * d / n, 3)} for i in range(n)]
        return [{"start": 0.0, "end": round(d, 3), "text": " ".join(w["w"] for w in words), "words": words}]


def create(mid):
    if mid.startswith("mock"):
        return MockAdapter(variant=mid == "mock2")
    fam = registry.MODELS[mid]["family"]
    if fam == "whisper":
        return WhisperAdapter()
    if fam == "parakeet":
        return ParakeetAdapter(mid)
    if fam == "voxtral":
        return VoxtralAdapter()
    raise KeyError(mid)
