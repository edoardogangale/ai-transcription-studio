"""Riconoscimento dei parlanti (sherpa-onnx: pyannote segmentation 3.0 + WeSpeaker ResNet34), tutto locale.
Strategia: la diarizzazione gira PRIMA della trascrizione e i cambi di voce diventano confini dei pezzi da
trascrivere; ogni pezzo ha quindi un solo parlante e le voci estranee (compagni) possono essere etichettate o saltate.
Limite noto: serve l'intero audio in RAM come float32 (~0,7 GB per 3 ore): è l'unico passo che non è a memoria costante."""
import numpy as np

from . import audio, registry

COMPONENT = "diarization"


def available():
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError:
        return False, "sherpa-onnx non installato."
    if not registry.is_installed(COMPONENT):
        return False, "Componente non installato: installalo da Modelli AI → Riconoscimento parlanti (circa 33 MB)."
    return True, ""


def run(pcm, num_speakers=-1, threshold=0.5, progress=None):
    """Ritorna [(start_s, end_s, 'S0'), ...] ordinati, con turni dello stesso parlante molto vicini già uniti."""
    import sherpa_onnx
    d = registry.model_dir(COMPONENT)
    seg = str(d / "model.int8.onnx") if (d / "model.int8.onnx").exists() else str(d / "model.onnx")
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg), num_threads=2),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(d / "embedding.onnx"), num_threads=2),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=threshold),
        min_duration_on=0.3, min_duration_off=0.5)
    if not cfg.validate():
        raise RuntimeError("Configurazione di diarizzazione non valida (file del componente mancanti?).")
    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    samples = np.asarray(pcm, dtype=np.float32) / 32768.0 if pcm.dtype == np.int16 else pcm
    cb = (lambda done, total: (progress(done, total), 0)[1]) if progress else None
    res = sd.process(samples, callback=cb).sort_by_start_time()
    turns = [(float(r.start), float(r.end), f"S{r.speaker}") for r in res]
    return merge_turns(turns)


def merge_turns(turns, max_gap=0.6):
    out = []
    for s, e, spk in turns:
        if out and out[-1][2] == spk and s - out[-1][1] <= max_gap:
            out[-1] = (out[-1][0], max(e, out[-1][1]), spk)
        else:
            out.append((s, e, spk))
    return out


def speaker_stats(turns):
    tot = {}
    for s, e, spk in turns:
        tot[spk] = tot.get(spk, 0.0) + (e - s)
    return tot


def label_speakers(totals, teacher=None):
    """Il parlante con più parlato è presunto 'Insegnante' (euristica modificabile dall'utente)."""
    order = sorted(totals, key=lambda k: -totals[k])
    teacher = teacher or (order[0] if order else None)
    out, n = {}, 1
    for k in order:
        if k == teacher:
            out[k] = {"label": "Insegnante", "teacher": True, "seconds": round(totals[k], 1)}
        else:
            n += 1
            out[k] = {"label": f"Voce {n}", "teacher": False, "seconds": round(totals[k], 1)}
    return out


def speaker_ranges(turns, total):
    """Intervalli [(s,e,spk)] che coprono il parlato, per pilotare la segmentazione dell'ASR."""
    return [(max(0.0, s), min(total, e), spk) for s, e, spk in turns if e - s >= 0.25]
