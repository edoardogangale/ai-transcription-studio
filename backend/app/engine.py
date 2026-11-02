"""Coda di elaborazione in background: più lavori in parallelo (impostazione), risultati intermedi a ogni chunk,
annullamento, ripresa dopo riavvio, cache dei modelli con conteggio dei riferimenti e rilascio della memoria."""
import gc
import queue
import threading
import time

from . import adapters, audio, config, db, diarization, hardware, registry, vocab
from .textutil import full_text

q: "queue.Queue[str]" = queue.Queue()
cancel_flags: dict = {}
_cv = threading.Condition()
_active = 0
_cache: dict = {}        # (mid, device) -> {"obj", "refs"}
_load_lock = threading.Lock()
_waiting_ram = 0
_started = False
MAX_WORKERS = 4


class Cancelled(Exception):
    pass


def parallel_limit() -> int:
    try:
        return max(1, min(MAX_WORKERS, int(db.setting_get("parallel", 2))))
    except Exception:
        return 2


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
    """Avvia i thread e rimette in coda i lavori interrotti (ripresa dai chunk già salvati)."""
    global _started
    if _started:
        return
    _started = True
    for t in db.list_all():
        if t["status"] in ("running", "queued") and t.get("kind") != "live":
            db.update(t["id"], status="queued")
            submit(t["id"])
    for i in range(MAX_WORKERS):
        threading.Thread(target=_loop, daemon=True, name=f"asr-worker-{i}").start()


def _loop():
    global _active
    while True:
        tid = q.get()
        with _cv:
            while _active >= parallel_limit():
                _cv.wait(0.5)
            _active += 1
        try:
            t = db.get(tid)
            if not t or t["status"] != "queued":
                continue
            _run(tid)
        except Cancelled:
            db.update(tid, status="cancelled")
        except MemoryError:
            db.update(tid, status="failed", error="Memoria insufficiente. Prova un modello più leggero o riduci i lavori in parallelo.")
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"
            if "out of memory" in str(e).lower() or "bad_alloc" in str(e).lower():
                msg = "Memoria (RAM/VRAM) esaurita: " + msg
            db.update(tid, status="failed", error=msg[:800])
        finally:
            cancel_flags.pop(tid, None)
            with _cv:
                _active -= 1
                _cv.notify_all()


# ---------------------------------------------------------------- cache modelli
def acquire(mid, device):
    """Ottiene l'adattatore (caricandolo se serve). Se la RAM non basta per tenere un altro modello già
    caricato, attende che quello sia libero."""
    global _waiting_ram
    key = (mid, device)
    with _load_lock:
        with _cv:
            if key in _cache:
                _cache[key]["refs"] += 1
                return _cache[key]["obj"]
        need = registry.ALL.get(mid, {}).get("min_ram_gb", 0)
        budget = (hardware.ram_gb() or 9999) * 0.9
        with _cv:
            _waiting_ram += 1
            try:
                while True:
                    others = [(k, v) for k, v in _cache.items() if k != key]
                    used = sum(registry.ALL.get(k[0], {}).get("min_ram_gb", 0) for k, _ in others)
                    if not others or used + need <= budget:
                        break
                    if all(v["refs"] == 0 for _, v in others):
                        for k, v in others:
                            _drop(k)
                        break
                    _cv.wait(0.5)
            finally:
                _waiting_ram -= 1
        a = adapters.create(mid)
        a.load(device)
        with _cv:
            _cache[key] = {"obj": a, "refs": 1}
        return a


def _drop(key):
    e = _cache.pop(key, None)
    if e:
        try:
            e["obj"].unload()
        finally:
            gc.collect()


def release(mid, device):
    key = (mid, device)
    with _cv:
        e = _cache.get(key)
        if not e:
            return
        e["refs"] -= 1
        if e["refs"] <= 0 and (q.empty() or _waiting_ram):
            _drop(key)  # coda vuota (o qualcuno aspetta RAM): libera la memoria
        _cv.notify_all()


def release_all_idle():
    with _cv:
        for k in [k for k, v in _cache.items() if v["refs"] <= 0]:
            _drop(k)


def pcm_path(upload_id, opts):
    tag = f"{int(bool(opts.get('normalize')))}{int(bool(opts.get('denoise')))}"
    return config.UPLOADS / upload_id / f"audio_{tag}.pcm"


_pcm_locks: dict = {}
_pcm_locks_guard = threading.Lock()


def ensure_pcm(src, pcm_file, normalize=False, denoise=False):
    """Converte (una sola volta) l'audio in PCM 16 kHz. Lock per file: lavori paralleli sullo stesso audio non si pestano."""
    with _pcm_locks_guard:
        lock = _pcm_locks.setdefault(str(pcm_file), threading.Lock())
    with lock:
        if not pcm_file.exists():
            tmp = pcm_file.with_suffix(".tmp")
            audio.convert_to_pcm(src, tmp, normalize, denoise)
            tmp.rename(pcm_file)
    return pcm_file


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


def _phase(tid, text):
    st = (db.get(tid) or {}).get("stats") or {}
    st["phase"] = text
    db.update(tid, stats=st)


def max_chunk_for(mid):
    # Whisper (in questo runtime) dà timestamp solo per finestra: finestre più corte = navigazione più precisa
    return 18.0 if registry.MODELS.get(mid, {}).get("kind") == "whisper" else 28.0


def _run(tid):
    t = db.get(tid)
    mid, opts = t["model_id"], t["options"] or {}
    device = registry.resolve_device(db.setting_get("device", "auto"))
    ok, why = registry.compatibility(mid, device)
    if not ok:
        raise RuntimeError("Modello non compatibile: " + why)
    if not registry.is_installed(mid):
        raise RuntimeError("Modello non installato.")
    t0 = time.time()
    db.update(tid, status="running", error=None)
    pcm_file = pcm_path(t["upload_id"], opts)
    if not pcm_file.exists():
        _phase(tid, "Conversione audio")
        ensure_pcm(t["audio_path"], pcm_file, opts.get("normalize"), opts.get("denoise"))
    pcm = audio.open_pcm(pcm_file)
    total_dur = len(pcm) / audio.SR

    part = t.get("partial") or {}
    plan, results, speakers = part.get("plan"), part.get("results", []), part.get("speakers")
    if not plan:
        _phase(tid, "Analisi del parlato")
        db_e = audio.frame_energy(pcm)
        ml = opts.get("max_chunk", max_chunk_for(mid))
        if opts.get("diarize"):
            okd, whyd = diarization.available()
            if not okd:
                raise RuntimeError("Riconoscimento parlanti non disponibile: " + whyd)
            _phase(tid, "Riconoscimento dei parlanti")
            turns = diarization.run(pcm, num_speakers=int(opts.get("num_speakers") or -1),
                                    threshold=float(db.setting_get("diar_threshold", 0.5)))
            _check(tid)
            speakers = diarization.label_speakers(diarization.speaker_stats(turns), opts.get("teacher"))
            plan = [list(c) for c in audio.plan_in_ranges(db_e, diarization.speaker_ranges(turns, total_dur), ml)]
        else:
            plan = [[a, b, None] for a, b in audio.plan_chunks(db_e, max_len=ml, total=total_dur)]
        del db_e
    teacher = next((k for k, v in (speakers or {}).items() if v["teacher"]), None)
    db.update(tid, chunks_total=len(plan), chunks_done=len(results), partial={"plan": plan, "results": results, "speakers": speakers})
    if not plan:
        raise RuntimeError("Nessun parlato rilevato nell'audio (solo silenzio o rumore costante).")

    _phase(tid, "Caricamento del modello")
    adapter = acquire(mid, device)
    try:
        prompt = vocab.whisper_prompt(t["context"] or "Altro") if registry.MODELS.get(mid, {}).get("prompt_support") else None
        peak = hardware.process_rss_mb()
        detected = None
        skipped = 0
        _phase(tid, "Trascrizione")
        for i in range(len(results), len(plan)):
            _check(tid)
            a, b, spk = plan[i]
            if opts.get("teacher_only") and teacher and spk != teacher:
                results.append([])  # voce estranea: non trascritta (scelta esplicita dell'utente)
                skipped += 1
            else:
                segs = adapter.transcribe(audio.read_window(pcm, a, b), t["language"], prompt)
                detected = getattr(adapter, "detected", detected) or detected
                for s in segs:  # riporta i tempi sull'asse dell'intero file
                    s["start"] = round(s["start"] + a, 3)
                    s["end"] = round(min(s["end"] + a, b + 0.5), 3)
                    if spk:
                        s["speaker"] = spk
                    for w in s.get("words", []):
                        w["s"] = round(w["s"] + a, 3)
                        w["e"] = round(w["e"] + a, 3)
                results.append(segs)
            peak = max(peak, hardware.process_rss_mb())
            # risultato intermedio persistito a ogni chunk -> ripresa dopo interruzione
            db.update(tid, chunks_done=len(results), partial={"plan": plan, "results": results, "speakers": speakers})
    finally:
        release(mid, device)
    segments = [s for r in results for s in r]
    segments, removed = _collapse_loops(segments)
    has_words = any(s.get("words") for s in segments)
    words = len(full_text(segments).split())
    elapsed = round(time.time() - t0, 2)
    stats = {"elapsed_s": elapsed, "audio_s": round(total_dur, 1), "words": words, "chunks": len(plan),
             "realtime_factor": round(elapsed / total_dur, 3) if total_dur else None,
             "peak_rss_mb": peak, "memory_note": "Memoria anonima del processo (RSS meno file mappati), campionata a ogni chunk; non include la VRAM.",
             "device": device, "loops_removed": removed, "speakers": speakers, "diarized": bool(opts.get("diarize")), "teacher": teacher, "skipped_chunks": skipped}
    db.update(tid, status="done", segments=segments, orig_segments=segments, has_word_ts=int(has_words),
              detected_language=detected, stats=stats, partial=None, chunks_done=len(plan))
    db.index_text(tid, t["title"], full_text(segments))
