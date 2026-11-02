"""Registro dei modelli ASR.

REGOLA: ogni campo "benchmark" contiene solo dati con una fonte realmente consultata;
altrimenti è None e l'interfaccia mostra "nessun benchmark verificato".
Lo stato "verification" dice cosa è stato realmente controllato durante lo sviluppo.
"""
from . import config, hardware

MODELS = {
    "parakeet-tdt-0.6b-v3": {
        "name": "NVIDIA Parakeet TDT 0.6B v3",
        "family": "parakeet", "runtime": "onnx-asr (ONNX Runtime)",
        "repo": "istupakov/parakeet-tdt-0.6b-v3-onnx", "upstream": "nvidia/parakeet-tdt-0.6b-v3",
        "onnx_name": "nemo-parakeet-tdt-0.6b-v3",
        "license": "CC-BY-4.0 (riportata da fonti terze; confermare sulla model card)",
        "params": "600M", "languages": ["it", "en"], "auto_language": True,
        "word_timestamps": True, "prompt_support": False,
        "cpu": True, "gpu": True, "min_ram_gb": 4, "min_vram_gb": 0,
        "approx_download_gb": None,
        "benchmark": {"text": "WER medio 6,34% su 8 dataset Open ASR Leaderboard (SOLO inglese; nessun dato verificato per l'italiano)",
                      "url": "https://openwhispr.com/it/blog/parakeet-vs-whisper-vs-nemotron"},
        "notes": "Multilingue (25 lingue europee, italiano incluso). Non supporta prompt/vocabolario: i termini "
                 "personalizzati producono solo suggerimenti di correzione, mai sostituzioni automatiche. "
                 "NB: non ho trovato alcun modello 'Parakeet Ultra': sostituito con il v3 realmente esistente.",
        "verification": "Esistenza confermata indirettamente (elenco ufficiale dei modelli del pacchetto onnx-asr). "
                        "Repo HF non raggiungibile dal sandbox: licenza, dimensioni e inferenza NON verificate.",
    },
    "parakeet-tdt-0.6b-v2": {
        "name": "NVIDIA Parakeet TDT 0.6B v2 (solo inglese)",
        "family": "parakeet", "runtime": "onnx-asr (ONNX Runtime)",
        "repo": "istupakov/parakeet-tdt-0.6b-v2-onnx", "upstream": "nvidia/parakeet-tdt-0.6b-v2",
        "onnx_name": "nemo-parakeet-tdt-0.6b-v2",
        "license": "CC-BY-4.0 (da confermare sulla model card)",
        "params": "600M", "languages": ["en"], "auto_language": False,
        "word_timestamps": True, "prompt_support": False,
        "cpu": True, "gpu": True, "min_ram_gb": 4, "min_vram_gb": 0, "approx_download_gb": None,
        "benchmark": None,
        "notes": "Scelto al posto del v3 per l'inglese perché addestrato solo su inglese (il v3 è già la scheda italiana, "
                 "evitando due schede identiche). Differenza di WER v2/v3 in inglese: NON verificata in questa sessione.",
        "verification": "Esistenza confermata indirettamente (onnx-asr). Inferenza NON verificata.",
    },
    "whisper-large-v3": {
        "name": "OpenAI Whisper Large V3",
        "family": "whisper", "runtime": "faster-whisper (CTranslate2)",
        "repo": "Systran/faster-whisper-large-v3", "upstream": "openai/whisper-large-v3",
        "license": "Apache-2.0 (originale OpenAI) / MIT (conversione Systran) - da confermare",
        "params": "1.55B", "languages": ["it", "en"], "auto_language": True,
        "word_timestamps": True, "prompt_support": True,
        "cpu": True, "gpu": True, "min_ram_gb": 8, "min_vram_gb": 6, "approx_download_gb": None,
        "benchmark": None,
        "notes": "Supporta initial_prompt: il vocabolario scolastico viene passato come suggerimento al decoder. "
                 "Può allucinare nei silenzi: segmentazione VAD e condition_on_previous_text=False riducono il rischio. "
                 "Su CPU è molto più lento di Parakeet (velocità non misurata in questa sessione).",
        "verification": "Libreria faster-whisper installata e importabile. Checkpoint non scaricabile dal sandbox: inferenza NON verificata.",
    },
    "voxtral-mini-4b-realtime": {
        "name": "Mistral Voxtral Mini 4B Realtime",
        "family": "voxtral", "runtime": "transformers (PyTorch) - sperimentale",
        "repo": "mistralai/Voxtral-Mini-4B-Realtime-2602", "upstream": "mistralai/Voxtral-Mini-4B-Realtime-2602",
        "license": "Apache-2.0 (da confermare)",
        "params": "~4B", "languages": ["it", "en"], "auto_language": False,
        "word_timestamps": False, "prompt_support": False,
        "cpu": False, "gpu": True, "min_ram_gb": 16, "min_vram_gb": 16, "approx_download_gb": None,
        "benchmark": None,
        "notes": "Modello progettato per lo streaming; l'uso su file passa dal chunking dell'app. Timestamp solo a "
                 "livello di segmento. Richiede GPU (soglia prudenziale dell'app: 16 GB VRAM). Pipeline ufficiale: vLLM; "
                 "l'adattatore transformers incluso è SPERIMENTALE.",
        "verification": "NON verificato: né checkpoint, né licenza, né API transformers (repo non raggiungibile). "
                        "L'adattatore è scritto sulla documentazione generale di Voxtral e può richiedere correzioni.",
    },
}

BY_LANGUAGE = {
    "it": ["parakeet-tdt-0.6b-v3", "whisper-large-v3", "voxtral-mini-4b-realtime"],
    "en": ["parakeet-tdt-0.6b-v2", "whisper-large-v3", "voxtral-mini-4b-realtime"],
    "auto": ["parakeet-tdt-0.6b-v3", "whisper-large-v3"],  # solo modelli con rilevamento lingua
}


if config.ENABLE_MOCK:  # SOLO TEST: finto adattatore per esercitare pipeline e UI. Non è un modello ASR.
    MODELS["mock"] = {"name": "MOCK (solo test, NON è un modello)", "family": "mock", "runtime": "nessuno",
                      "repo": "-", "upstream": "-", "license": "-", "params": "-", "languages": ["it", "en"],
                      "auto_language": True, "word_timestamps": True, "prompt_support": False, "cpu": True, "gpu": True,
                      "min_ram_gb": 0, "min_vram_gb": 0, "approx_download_gb": None, "benchmark": None,
                      "notes": "Testo fittizio generato dalla durata.", "verification": "Solo test."}
    MODELS["mock2"] = MODELS["mock"] | {"name": "MOCK B (solo test, NON è un modello)"}
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
    if pref == "cuda":
        return "cuda"
    if pref == "cpu":
        return "cpu"
    return "cuda" if "cuda" in hw["devices"] else "cpu"


def compatibility(mid: str, device: str):
    """Ritorna (ok, motivo). Impedisce l'avvio di processi destinati a fallire."""
    if config.ENABLE_MOCK and mid.startswith("mock"):
        return True, ""
    m = MODELS.get(mid)
    if not m:
        return False, "Modello sconosciuto."
    hw = hardware.info()
    dev = resolve_device(device)
    if dev == "cuda":
        if not hw["gpus"]:
            return False, "È stata scelta la GPU ma non è stata rilevata alcuna GPU NVIDIA (nvidia-smi assente)."
        if not m["gpu"]:
            return False, f"{m['name']} non supporta la GPU."
        if hw["gpus"][0]["vram_gb"] < m["min_vram_gb"]:
            return False, (f"VRAM insufficiente: {hw['gpus'][0]['vram_gb']} GB disponibili, "
                           f"{m['min_vram_gb']} GB richiesti (soglia prudenziale dell'app).")
    else:
        if not m["cpu"]:
            return False, f"{m['name']} richiede una GPU e non è eseguibile su CPU."
    if hw["ram_gb"] and hw["ram_gb"] < m["min_ram_gb"]:
        return False, f"RAM insufficiente: {hw['ram_gb']} GB disponibili, {m['min_ram_gb']} GB richiesti."
    return True, ""


def recommended(language: str, device: str):
    """Euristica dichiarata: su CPU il modello più leggero compatibile (Parakeet, 600M);
    su GPU Whisper Large V3 (unico con supporto al vocabolario). Non è un giudizio di accuratezza."""
    ids = BY_LANGUAGE.get(language, BY_LANGUAGE["it"])
    pref = ["whisper-large-v3"] if resolve_device(device) == "cuda" else [i for i in ids if i.startswith("parakeet")]
    for mid in pref + ids:
        if mid in ids and compatibility(mid, device)[0]:
            why = ("Euristica: con GPU, Whisper supporta il vocabolario personalizzato."
                   if mid.startswith("whisper") else "Euristica: modello più leggero eseguibile sul tuo hardware.")
            return mid, why
    return None, "Nessun modello compatibile con l'hardware rilevato."


def describe(mid: str, device: str) -> dict:
    m = dict(MODELS[mid])
    ok, why = compatibility(mid, device)
    m.update(id=mid, installed=is_installed(mid), disk_bytes=disk_usage(mid), compatible=ok, incompatible_reason=why)
    return m
