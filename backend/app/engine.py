"""Coda di elaborazione in background (un job alla volta per limitare la RAM), con risultati intermedi,
annullamento, ripresa dopo riavvio e rilascio della memoria a coda vuota."""
import gc
import queue
import subprocess
import threading
import time
import wave

from . import adapters, audio, config, db, diarization, hardware, registry, vocab
from .textutil import full_text

q: "queue.Queue[str]" = queue.Queue()
cancel_flags: dict = {}
_adapter = {"key": None, "obj": None}
_started = False


class Cancelled(Exception):
    pass


def submit(tid):
    cancel_flags[tid] = threading.Event()
    q.put(tid)


def cancel(tid):
    t = db.get(tid)
    if not t:
        return False
    if t["status"] == "queued":
        db.update(tid, status="cancelled")
    cancel_flags.setdefault(tid, threading.Event()).set()
    return True


def start_worker():
    """Avvia il thread e rimette in coda i lavori interrotti (ripresa dai chunk già salvati)."""
    global _started
    if _started:
        return
    _started = True
    for t in db.list_all():
        if t["status"] in ("running", "queued"):
            db.update(t["id"], status="queued")
            submit(t["id"])
    threading.Thread(target=_loop, daemon=True, name="asr-worker").start()


def _loop():
    while True:
        tid = q.get()
        try:
            t = db.get(tid)
            if not t or t["status"] != "queued":
                continue
            _run(tid)
        except Cancelled:
            db.update(tid, status="cancelled")
        except MemoryError:
            db.update(tid, status="failed", error="Memoria insufficiente. Prova una CPU/GPU con più memoria o un modello più leggero.")
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"
            if "out of memory" in str(e).lower():
                msg = "Memoria (RAM/VRAM) esaurita: " + msg
            db.update(tid, status="failed", error=msg[:800])
        finally:
            cancel_flags.pop(tid, None)
            if q.empty():
                release_model()


def release_model():
    if _adapter["obj"] is not None:
        try:
            _adapter["obj"].unload()
        finally:
            _adapter.update(key=None, obj=None)
            gc.collect()


def _get_adapter(mid, device):
    key = (mid, device)
    if _adapter["key"] != key:
        release_model()
        a = adapters.create(mid)
        a.load(device)
        _adapter.update(key=key, obj=a)
    return _adapter["obj"]


def pcm_path(upload_id, opts):
    tag = f"{int(bool(opts.get('normalize')))}{int(bool(opts.get('denoise')))}"
    return config.UPLOADS / upload_id / f"audio_{tag}.pcm"


def _check(tid):
    if cancel_flags.get(tid) and cancel_flags[tid].is_set():
        raise Cancelled()


def _collapse_loops(segs, max_rep=2):
    """Allucinazioni a ciclo: stesso testo >= 3 volte di fila -> ne tiene max_rep. Ritorna (segmenti, rimossi)."""
    out, removed, rep = [], 0, 0
    for s in segs:
        if out and s["text"].strip().lower() == out[-1]["text"].strip().lower() and len(s["text"]) > 3:
            rep += 1
            if rep >= max_rep:
                removed += 1
                continue
        else:
            rep = 0
        out.append(s)
    return out, removed


def _run(tid):
    t = db.get(tid)
    mid, opts = t["model_id"], t["options"] or {}
    device = registry.resolve_device(db.setting_get("device", "auto"))
    ok, why = registry.compatibility(mid, device)
    if not ok:
        raise RuntimeError("Modello non compatibile: " + why)
    if not mid.startswith("mock") and not registry.is_installed(mid):
        raise RuntimeError("Modello non installato.")
    t0 = time.time()
    db.update(tid, status="running", error=None)
    src = t["audio_path"]
    pcm_file = pcm_path(t["upload_id"], opts)
    if not pcm_file.exists():
        audio.convert_to_pcm(src, pcm_file.with_suffix(".tmp"), opts.get("normalize"), opts.get("denoise"))
        pcm_file.with_suffix(".tmp").rename(pcm_file)
    pcm = audio.open_pcm(pcm_file)
    total_dur = len(pcm) / audio.SR

    part = t.get("partial") or {}
    plan = part.get("plan")
    if not plan:
        db_e = audio.frame_energy(pcm)
        plan = audio.plan_chunks(db_e, max_len=opts.get("max_chunk", 28.0), total=total_dur)
        del db_e
    results = part.get("results", [])
    db.update(tid, chunks_total=len(plan), chunks_done=len(results), partial={"plan": plan, "results": results})
    if not plan:
        raise RuntimeError("Nessun parlato rilevato nell'audio (solo silenzio o rumore costante).")

    adapter = _get_adapter(mid, device)
    prompt = vocab.whisper_prompt(t["context"] or "Altro") if registry.MODELS.get(mid, {}).get("prompt_support") else None
    peak = hardware.process_rss_mb()
    detected = None
    for i in range(len(results), len(plan)):
        _check(tid)
        a, b = plan[i]
        samples = audio.read_window(pcm, a, b)
        segs = adapter.transcribe(samples, t["language"], prompt)
        detected = getattr(adapter, "detected", detected)
        for s in segs:  # riporta i tempi sull'asse dell'intero file
            s["start"] = round(s["start"] + a, 3)
            s["end"] = round(min(s["end"] + a, b + 0.5), 3)
            for w in s.get("words", []):
                w["s"] = round(w["s"] + a, 3)
                w["e"] = round(w["e"] + a, 3)
        results.append(segs)
        del samples
        peak = max(peak, hardware.process_rss_mb())
        # risultato intermedio persistito a ogni chunk -> ripresa dopo interruzione
        db.update(tid, chunks_done=len(results), partial={"plan": plan, "results": results})
    segments = [s for r in results for s in r]
    segments, removed = _collapse_loops(segments)

    diar_note = None
    if opts.get("diarize"):
        okd, whyd = diarization.available()
        if okd:
            wav = pcm_file.with_suffix(".wav")
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", str(pcm_file), str(wav)], check=True)
            segments = diarization.assign_speakers(wav, segments, device)
            wav.unlink(missing_ok=True)
        else:
            diar_note = "Diarizzazione non eseguita: " + whyd
    has_words = any(s.get("words") for s in segments)
    words = len(full_text(segments).split())
    elapsed = round(time.time() - t0, 2)
    stats = {"elapsed_s": elapsed, "audio_s": round(total_dur, 1), "words": words, "chunks": len(plan),
             "realtime_factor": round(elapsed / total_dur, 3) if total_dur else None,
             "peak_rss_mb": peak, "memory_note": "Memoria anonima del processo (RSS meno file mappati), campionata a ogni chunk; non include la VRAM.",
             "device": device, "loops_removed": removed, "diarization_note": diar_note}
    db.update(tid, status="done", segments=segments, orig_segments=segments, has_word_ts=int(has_words),
              detected_language=detected, stats=stats, partial=None, chunks_done=len(plan))
