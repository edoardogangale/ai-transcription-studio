"""Diarizzazione OPZIONALE via pyannote.audio. Richiede: pip install pyannote.audio, un token HF con accettazione delle
condizioni del modello 'pyannote/speaker-diarization-3.1' (gated). Non verificata in questo ambiente."""
import importlib.util

from . import config


def available():
    if importlib.util.find_spec("pyannote") is None:
        return False, "pyannote.audio non installato (pip install pyannote.audio)."
    if not config.HF_TOKEN:
        return False, "Serve HF_TOKEN (modello gated pyannote/speaker-diarization-3.1)."
    return True, ""


def assign_speakers(wav_path, segments, device="cpu"):
    from pyannote.audio import Pipeline
    import torch
    pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=config.HF_TOKEN)
    pipe.to(torch.device(device))
    turns = [(t.start, t.end, spk) for t, _, spk in pipe(str(wav_path)).itertracks(yield_label=True)]
    for s in segments:
        best, ov_best = None, 0.0
        for a, b, spk in turns:
            ov = min(s["end"], b) - max(s["start"], a)
            if ov > ov_best:
                best, ov_best = spk, ov
        if best:
            s["speaker"] = best
    return segments
