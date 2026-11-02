"""Trascrizione LIVE. Il browser invia PCM 16 kHz mono int16 via WebSocket; il server:
 1) salva subito tutto l'audio su disco (live.pcm): niente si perde se la pagina o il server si interrompono;
 2) rileva le pause con un VAD a energia in streaming e trascrive ogni frase appena finisce (ritardo = pausa + calcolo);
 3) alla fine converte l'audio in m4a e completa la trascrizione, che da quel momento è una trascrizione normale
    (si può ritrascrivere con un modello più accurato).
Il ritardo reale (audio ricevuto - audio trascritto) è esposto: se il modello è più lento del tempo reale cresce."""
import asyncio
import collections
import hashlib
import json
import queue
import subprocess
import threading
import time

import numpy as np

from . import audio, config, db, engine, hardware, registry
from .textutil import full_text

FRAME = 480            # 30 ms @ 16 kHz
SR = audio.SR
sessions: dict = {}


class LiveSession:
    def __init__(self, tid, upload_id, mid, device, language, context, max_len=15.0):
        self.tid, self.upload_id, self.mid, self.device = tid, upload_id, mid, device
        self.language, self.context, self.max_len = language, context, max_len
        self.dir = config.UPLOADS / upload_id
        self.pcm_path = self.dir / "live.pcm"
        self.f = open(self.pcm_path, "ab")
        self.adapter = None
        self.segments, self.segs_lock = [], threading.Lock()
        self.rest = np.zeros(0, np.int16)
        self.frame_i = 0                       # frame ricevuti (30 ms ciascuno)
        self.hist = collections.deque(maxlen=700)
        self.thr = -45.0
        self.pre = collections.deque(maxlen=8)  # pre-roll: non tagliare l'attacco della parola
        self.buf, self.buf_db, self.buf_start = [], [], 0
        self.active, self.last_voice = False, -1
        self.jobs: "queue.Queue" = queue.Queue()
        self.transcribed_to = 0.0
        self.outq = None
        self.loop = None
        self.last_rx = time.time()
        self.stopped = False
        self.error = None
        self.worker = threading.Thread(target=self._work, daemon=True, name=f"live-{tid}")
        self.t0 = time.time()

    # ---- uscita verso i client ----
    def attach(self, loop, outq):
        self.loop, self.outq = loop, outq

    def emit(self, msg):
        if self.outq is not None and self.loop is not None:
            try:
                self.loop.call_soon_threadsafe(self.outq.put_nowait, msg)
            except RuntimeError:
                pass

    @property
    def received_s(self):
        return round(self.frame_i * FRAME / SR, 2)

    def status_msg(self):
        return {"type": "status", "received_s": self.received_s, "transcribed_s": round(self.transcribed_to, 2),
                "lag_s": round(max(0.0, self.received_s - self.transcribed_to), 1), "pending": self.jobs.qsize(),
                "segments": len(self.segments), "error": self.error}

    def start(self):
        self.adapter = engine.acquire(self.mid, self.device)  # carica il modello PRIMA di iniziare a registrare
        self.worker.start()

    # ---- ingresso audio ----
    def feed(self, data: bytes):
        if self.stopped:
            return
        self.last_rx = time.time()
        self.f.write(data)
        self.f.flush()
        x = np.concatenate([self.rest, np.frombuffer(data[: len(data) // 2 * 2], dtype=np.int16)])
        n = len(x) // FRAME
        for k in range(n):
            self._frame(x[k * FRAME:(k + 1) * FRAME])
        self.rest = x[n * FRAME:]

    def _frame(self, fr):
        i = self.frame_i
        self.frame_i += 1
        f = fr.astype(np.float32) / 32768.0
        db_ = 20 * np.log10(np.sqrt(np.mean(f * f) + 1e-12))
        self.hist.append(db_)
        if i % 10 == 0 and len(self.hist) > 30:
            h = np.fromiter(self.hist, dtype=np.float32)
            self.thr = float(max(min(np.percentile(h, 5) + 9.0, np.percentile(h, 95) - 12.0), -55.0))
        voiced = db_ > self.thr
        if voiced:
            self.last_voice = i
            if not self.active:
                self.active = True
                self.buf = [p[0] for p in self.pre]
                self.buf_db = [p[1] for p in self.pre]
                self.buf_start = i - len(self.pre)
        if self.active:
            self.buf.append(fr)
            self.buf_db.append(db_)
            silent_for = (i - self.last_voice) * FRAME / SR
            if silent_for >= 0.7:
                self._cut(len(self.buf) - max(0, (i - self.last_voice) - 5), keep_rest=False)
            elif len(self.buf) * FRAME / SR >= self.max_len:
                lo = int(len(self.buf) - 2.0 * SR / FRAME)           # cerca la pausa nell'ultimo secondo e mezzo
                seg = self.buf_db[lo:]
                cut = lo + int(np.argmin(seg)) + 1
                self._cut(cut, keep_rest=True)
        else:
            self.pre.append((fr, db_))

    def _cut(self, n, keep_rest):
        n = max(1, n)
        chunk, rest = self.buf[:n], self.buf[n:]
        rest_db = self.buf_db[n:]
        start_frame = self.buf_start
        if len(chunk) * FRAME / SR >= 0.4:
            self.jobs.put((start_frame * FRAME / SR, np.concatenate(chunk).astype(np.float32) / 32768.0))
        if keep_rest:
            self.buf, self.buf_db, self.buf_start = rest, rest_db, start_frame + n
        else:
            self.buf, self.buf_db, self.active = [], [], False
            self.pre.clear()

    # ---- trascrizione ----
    def _work(self):
        while True:
            job = self.jobs.get()
            if job is None:
                return
            a, samples = job
            try:
                segs = self.adapter.transcribe(samples, self.language, None)
                new = []
                for s in segs:
                    s["start"] = round(s["start"] + a, 3)
                    s["end"] = round(min(s["end"] + a, a + len(samples) / SR + 0.5), 3)
                    for w in s.get("words", []):
                        w["s"] = round(w["s"] + a, 3)
                        w["e"] = round(w["e"] + a, 3)
                    new.append(s)
                with self.segs_lock:
                    self.segments += new
                    snap = list(self.segments)
                self.transcribed_to = a + len(samples) / SR
                db.update(self.tid, segments=snap)
                for s in new:
                    self.emit({"type": "segment", "seg": s, "index": len(snap) - len(new) + new.index(s)})
            except Exception as e:  # un errore su una frase non deve fermare la registrazione
                self.error = f"{type(e).__name__}: {e}"[:300]
            self.emit(self.status_msg())

    # ---- chiusura ----
    def finish(self):
        """Svuota il buffer, attende la trascrizione, converte l'audio e completa il record. Idempotente."""
        if self.stopped:
            return
        self.stopped = True
        if self.active and self.buf:
            self._cut(len(self.buf), keep_rest=False)
        self.jobs.put(None)
        self.worker.join(timeout=3600)
        self.f.close()
        engine.release(self.mid, self.device)
        finalize_audio(self.tid, self.upload_id, self.segments, live_stats={
            "live": True, "model_wall_s": round(time.time() - self.t0, 1), "device": self.device,
            "peak_rss_mb": hardware.process_rss_mb(), "live_error": self.error})
        sessions.pop(self.tid, None)
        self.emit({"type": "done"})


def finalize_audio(tid, upload_id, segments, live_stats=None):
    """Converte live.pcm in m4a, scrive meta.json (così si può ritrascrivere) e completa la trascrizione."""
    d = config.UPLOADS / upload_id
    pcm = d / "live.pcm"
    if not pcm.exists() or pcm.stat().st_size < SR * 2 * 0.3:
        db.update(tid, status="failed", error="Registrazione vuota o troppo breve.")
        return
    dst = d / "original.m4a"
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", str(pcm),
                        "-c:a", "aac", "-b:a", "64k", str(dst)], capture_output=True, text=True)
    if r.returncode != 0:
        db.update(tid, status="failed", error="Conversione dell'audio registrato fallita: " + r.stderr[-200:])
        return
    info = audio.probe(dst)
    sha = hashlib.sha256(dst.read_bytes()).hexdigest()
    t = db.get(tid)
    meta = {"upload_id": upload_id, "name": (t["title"] or "registrazione") + ".m4a", "size": dst.stat().st_size, "sha": sha,
            "path": str(dst), **info}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    has_words = any(s.get("words") for s in segments)
    st = dict(t.get("stats") or {})
    st.update(live_stats or {})
    st.update(words=len(full_text(segments).split()), audio_s=round(info["duration"], 1))
    db.update(tid, status="done", audio_path=str(dst), audio_sha=sha, duration=info["duration"], segments=segments,
              orig_segments=segments, has_word_ts=int(has_words), stats=st, dedupe_key=None)
    db.index_text(tid, t["title"], full_text(segments))
    # il PCM grezzo non serve più: l'audio è nel m4a (si risparmia spazio)
    pcm.unlink(missing_ok=True)


def recover():
    """All'avvio: sessioni live rimaste 'in registrazione' (crash/riavvio) -> recupera l'audio salvato su disco."""
    for t in db.list_all():
        if t.get("kind") == "live" and t["status"] == "recording" and t["id"] not in sessions:
            full = db.get(t["id"])
            finalize_audio(t["id"], full["upload_id"], full.get("segments") or [], {"live": True, "recovered": True})


def reaper():
    """Chiude le sessioni senza audio da 15 minuti (client sparito senza fare stop)."""
    while True:
        time.sleep(30)
        for s in list(sessions.values()):
            if time.time() - s.last_rx > 900:
                threading.Thread(target=s.finish, daemon=True).start()
