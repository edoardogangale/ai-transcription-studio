"""Registro dei modelli ASR.

Tutti i modelli girano con un solo runtime, sherpa-onnx (k2-fsa, Apache-2.0), e i pesi si scaricano dalle release
GitHub di sherpa-onnx (nessun account, nessun token, nessun Hugging Face). Le dimensioni di download sono state
MISURATE (Content-Length reale dei file). I benchmark compaiono solo con fonte consultata; altrimenti None.
Lo stato "verification" dice cosa è stato realmente provato durante lo sviluppo."""
from . import config, hardware

GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
HANDY_IT = {"text": "WER FLEURS italiano {v}% (aggregatore terzo, pesi quantizzati Q8_0: indicativo, non è la model card)",
            "url": "https://models.handy.computer/languages/it"}


def _it(v):
    return {"text": HANDY_IT["text"].format(v=v), "url": HANDY_IT["url"]}


# Misure di riferimento eseguite DAVVERO in sviluppo: 4 core CPU, nessuna GPU, 36 s di italiano sintetico (voci TTS piper,
# 95 parole). La velocità (RTF = secondi di calcolo / secondi di audio) è affidabile come ordine di grandezza; il WER su un
# campione così piccolo e sintetico è solo indicativo e NON rappresenta il parlato reale di una classe.
REFERENCE = {
    "parakeet-tdt-0.6b-v3": {"rtf": 0.08, "wer": 10.5}, "whisper-large-v3-turbo": {"rtf": 0.50, "wer": 4.2},
    "whisper-large-v3": {"rtf": 5.52, "wer": 4.2}, "whisper-base": {"rtf": 0.19, "wer": 29.5}, "whisper-tiny": {"rtf": 0.11, "wer": 37.9},
}


def _m(name, tier, kind, asset, size, langs, auto, params, upstream, license_, bench, notes, ram, **kw):
    return {"name": name, "tier": tier, "kind": kind, "family": "sherpa", "runtime": "sherpa-onnx (ONNX Runtime)",
            "sources": [{"url": f"{GH}/asr-models/{asset}", "type": "tar.bz2", "bytes": size}],
            "download_bytes": size, "languages": langs, "auto_language": auto, "params": params,
            "upstream": upstream, "license": license_, "benchmark": bench, "notes": notes,
            "min_ram_gb": ram, "min_vram_gb": 0, "cpu": True, "gpu": True,
            "word_timestamps": kw.get("word_ts", False), "prompt_support": False,
            "verification": kw.get("verification", "")}


MODELS = {
    "parakeet-tdt-0.6b-v3": _m(
        "NVIDIA Parakeet TDT 0.6B v3", "main", "transducer", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2", 487170055,
        ["it", "en"], True, "600M", "nvidia/parakeet-tdt-0.6b-v3", "CC-BY-4.0 (da fonti terze: confermare sulla model card)",
        _it("3,02"), "Multilingue (25 lingue europee, italiano incluso) con rilevamento lingua. Molto veloce su CPU. "
        "Timestamp per parola (dai token del trasduttore). Nessun 'Parakeet Ultra' trovato in nessuna fonte.", 4, word_ts=True),
    "parakeet-tdt-0.6b-v2": _m(
        "NVIDIA Parakeet TDT 0.6B v2 (solo inglese)", "main", "transducer", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2", 482468385,
        ["en"], False, "600M", "nvidia/parakeet-tdt-0.6b-v2", "CC-BY-4.0 (da confermare sulla model card)",
        None, "Addestrato solo su inglese. Timestamp per parola. Confronto di accuratezza v2 vs v3 in inglese: non verificato.", 4, word_ts=True),
    "whisper-large-v3": _m(
        "OpenAI Whisper Large V3", "main", "whisper", "sherpa-onnx-whisper-large-v3.tar.bz2", 1068482488,
        ["it", "en"], True, "1.55B", "openai/whisper-large-v3", "Apache-2.0 / MIT (da confermare)",
        _it("2,54"), "Il più accurato tra i modelli confrontati in italiano da quella fonte, ma su CPU è molto lento (misura di riferimento: 5,5× il tempo "
        "reale: ~11 ore per una lezione di 2 h su 4 core). Pensato per GPU. 99 lingue, rilevamento lingua. Nessun vocabolario/prompt in questo runtime.", 10),
    "whisper-large-v3-turbo": _m(
        "OpenAI Whisper Large V3 Turbo", "main", "whisper", "sherpa-onnx-whisper-turbo.tar.bz2", 563790207,
        ["it", "en"], True, "809M", "openai/whisper-large-v3-turbo", "MIT (da confermare)",
        _it("2,77"), "Versione sfoltita di Large V3: accuratezza vicina (stessa fonte) con meno parametri nel decoder, quindi più rapida.", 6),
    "whisper-base": _m(
        "OpenAI Whisper Base (veloce)", "fast", "whisper", "sherpa-onnx-whisper-base.tar.bz2", 207557382,
        ["it", "en"], True, "74M", "openai/whisper-base", "MIT (da confermare)", None,
        "Piccolo e rapido, ma qualità molto inferiore (misura di riferimento: WER ~30% sull'italiano di prova). Utile per bozze e per il live "
        "su PC lenti; per qualità usa Parakeet (altrettanto veloce e molto più accurato) o Turbo.", 2),
    "whisper-tiny": _m(
        "OpenAI Whisper Tiny (velocissimo)", "fast", "whisper", "sherpa-onnx-whisper-tiny.tar.bz2", 116204861,
        ["it", "en"], True, "39M", "openai/whisper-tiny", "MIT (da confermare)", None,
        "Il più rapido e piccolo; qualità scarsa soprattutto in italiano. Solo per prove, bozze o hardware molto limitato.", 1),
}

BY_LANGUAGE = {
    "it": ["parakeet-tdt-0.6b-v3", "whisper-large-v3", "whisper-large-v3-turbo"],
    "en": ["parakeet-tdt-0.6b-v2", "whisper-large-v3", "whisper-large-v3-turbo"],
    "auto": ["parakeet-tdt-0.6b-v3", "whisper-large-v3", "whisper-large-v3-turbo"],
}
FAST = ["whisper-base", "whisper-tiny"]

# Componenti opzionali (non sono modelli ASR): riconoscimento dei parlanti.
COMPONENTS = {
    "diarization": {
        "name": "Riconoscimento parlanti (pyannote segmentation 3.0 + WeSpeaker ResNet34)", "tier": "component",
        "sources": [{"url": f"{GH}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", "type": "tar.bz2", "bytes": 6958444},
                    {"url": f"{GH}/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx", "type": "file", "bytes": 26530550, "name": "embedding.onnx"}],
        "download_bytes": 6958444 + 26530550, "languages": ["it", "en"], "runtime": "sherpa-onnx", "params": "~7M + ~26M",
        "upstream": "pyannote/segmentation-3.0 + wespeaker", "license": "MIT (pyannote 3.0) / Apache-2.0 (WeSpeaker) - da confermare",
        "benchmark": None, "min_ram_gb": 4, "min_vram_gb": 0, "cpu": True, "gpu": False, "word_timestamps": False, "prompt_support": False,
        "notes": "Distingue chi parla. L'embedding è addestrato su voci in inglese (VoxCeleb): su italiano funziona in pratica, "
                 "ma l'accuratezza non è stata misurata.", "verification": ""},
}

ALL = {**MODELS, **COMPONENTS}

if config.ENABLE_MOCK:  # SOLO TEST: finti adattatori per esercitare pipeline e UI. Non sono modelli ASR.
    _mock = {"name": "MOCK (solo test, NON è un modello)", "tier": "main", "kind": "mock", "family": "mock", "runtime": "nessuno",
             "sources": [], "download_bytes": 0, "languages": ["it", "en"], "auto_language": True, "params": "-", "upstream": "-",
             "license": "-", "benchmark": None, "notes": "Testo fittizio generato dalla durata.", "min_ram_gb": 0, "min_vram_gb": 0,
             "cpu": True, "gpu": True, "word_timestamps": True, "prompt_support": False, "verification": "Solo test."}
    MODELS["mock"] = _mock
    MODELS["mock2"] = _mock | {"name": "MOCK B (solo test, NON è un modello)"}
    ALL.update(MODELS)
    for _l in BY_LANGUAGE.values():
        _l += ["mock", "mock2"]


def model_dir(mid):
    return config.MODELS_DIR / mid


def is_installed(mid) -> bool:
    if mid.startswith("mock"):
        return True
    return (model_dir(mid) / ".complete").exists()


def disk_usage(mid) -> int:
    d = model_dir(mid)
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file()) if d.exists() else 0


def resolve_device(pref: str) -> str:
    hw = hardware.info()
    if pref in ("cpu", "cuda"):
        return pref
    return "cuda" if "cuda" in hw["devices"] else "cpu"


def compatibility(mid: str, device: str):
    """Ritorna (ok, motivo). Impedisce l'avvio di processi destinati a fallire."""
    if config.ENABLE_MOCK and mid.startswith("mock"):
        return True, ""
    m = ALL.get(mid)
    if not m:
        return False, "Modello sconosciuto."
    hw = hardware.info()
    dev = resolve_device(device)
    if dev == "cuda":
        if not hw["gpus"]:
            return False, "È stata scelta la GPU ma non è stata rilevata alcuna GPU NVIDIA (nvidia-smi assente)."
        if not m["gpu"]:
            return False, f"{m['name']} gira solo su CPU."
        if hw["gpus"][0]["vram_gb"] < m["min_vram_gb"]:
            return False, f"VRAM insufficiente: {hw['gpus'][0]['vram_gb']} GB disponibili, {m['min_vram_gb']} GB richiesti."
    if hw["ram_gb"] and hw["ram_gb"] < m["min_ram_gb"]:
        return False, f"RAM insufficiente: {hw['ram_gb']} GB disponibili, {m['min_ram_gb']} GB richiesti (soglia prudenziale)."
    return True, ""


def recommended(language: str, device: str):
    """Euristica dichiarata basata sulle misure di riferimento (NON una classifica di accuratezza generale):
    con GPU Whisper Large V3; su CPU Whisper Turbo (nelle misure di riferimento stessa accuratezza di Large V3 a 1/10 del tempo)."""
    ids = BY_LANGUAGE.get(language, BY_LANGUAGE["it"])
    cuda = resolve_device(device) == "cuda"
    order = (["whisper-large-v3"] if cuda else []) + ["whisper-large-v3-turbo"] + [i for i in ids if i.startswith("parakeet")] + ids
    for mid in order:
        if mid in ids and compatibility(mid, device)[0]:
            why = {"whisper-large-v3": "Con GPU il Large V3 è la scelta più accurata nella fonte citata.",
                   "whisper-large-v3-turbo": "Su CPU: nelle misure di riferimento accuratezza pari a Large V3 con ~1/10 del tempo di calcolo."}.get(
                mid, "Euristica: il più veloce tra quelli compatibili con il tuo hardware.")
            return mid, why
    return None, "Nessun modello compatibile con l'hardware rilevato."


def describe(mid: str, device: str, measured=None) -> dict:
    m = dict(ALL[mid])
    ok, why = compatibility(mid, device)
    m.update(reference=REFERENCE.get(mid), id=mid, installed=is_installed(mid), disk_bytes=disk_usage(mid), compatible=ok, incompatible_reason=why,
             measured_rtf=(measured or {}).get(mid))
    return m
