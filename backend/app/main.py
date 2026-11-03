"""AI Transcription Studio - API FastAPI."""
import asyncio
import hashlib
import importlib.util
import io
import json
import mimetypes
import shutil
import threading
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import audio, auth, config, db, diarization, engine, exports, hardware, installer, live, llm, notebook, postprocess, registry, vocab
from .textutil import diff_summary, full_text, wer, word_diff


@asynccontextmanager
async def lifespan(app):
    config.ensure_dirs()
    db.conn()
    live.recover()
    engine.start_worker()
    threading.Thread(target=live.reaper, daemon=True).start()
    yield


app = FastAPI(title="AI Transcription Studio", lifespan=lifespan)


@app.middleware("http")
async def guard(request: Request, call_next):
    p = request.url.path
    if p.startswith("/api/") and p != "/api/health":
        tok = request.headers.get("x-studio-token") or request.query_params.get("token")
        user = auth.resolve(tok)
        if not user:
            return JSONResponse({"detail": "Codice di accesso mancante o errato."}, status_code=401)
        auth.current.set(user)
    return await call_next(request)


def err(code, msg):
    raise HTTPException(code, msg)


def me():
    u = auth.current.get()
    return u["id"] if u else auth.ADMIN_ID


def admin_only():
    u = auth.current.get()
    if not (u and u["admin"]):
        err(403, "Solo l'amministratore può farlo.")


def _own(t):
    return t is not None and (t.get("owner") or auth.ADMIN_ID) == me()


def _fo(fid):
    f = db.folder_get(fid)
    if not f or (f.get("owner") or auth.ADMIN_ID) != me():
        err(404, "Cartella non trovata.")
    return f


def _t(tid, need_segments=False):
    t = db.get(tid)
    if not _own(t):
        err(404, "Non trovata.")
    if need_segments and not t["segments"]:
        err(404, "Non trovata o non completata.")
    return t


# ---------------------------------------------------------------- sistema / impostazioni / attività
@app.get("/api/health")
def health():
    return {"ok": True, "auth_required": bool(config.ACCESS_TOKEN)}


def _persistence():
    """Dove stanno i modelli e se resteranno: l'utente deve scaricarli UNA volta sola."""
    import os
    d = str(config.DATA_DIR)
    if os.environ.get("CODESPACES") == "true":
        return {"ok": True, "text": f"Sei su GitHub Codespaces: modelli e archivio restano salvati in {d} finché non elimini il Codespace (quando si ferma per inattività i file restano)."}
    if os.path.exists("/.dockerenv"):
        try:
            if os.stat(config.DATA_DIR).st_dev == os.stat("/").st_dev:
                return {"ok": False, "text": f"Attenzione: sei in Docker ma {d} non è un volume: ricreando il container i modelli andrebbero riscaricati. Usa docker-compose.yml (volume studio-data)."}
        except OSError:
            pass
    return {"ok": True, "text": f"I modelli restano salvati in {d}: si scaricano una volta sola, anche se aggiorni il progetto."}


@app.get("/api/system")
def system():
    ok_d, why_d = diarization.available()
    return {"hardware": hardware.info(), "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
            "llm_models": postprocess.llm_models(), "contexts": vocab.CONTEXTS,
            "diarization": {"available": ok_d, "reason": why_d},
            "websocket": bool(importlib.util.find_spec("websockets") or importlib.util.find_spec("wsproto")),
            "settings": {"device": db.setting_get("device", "auto"), "parallel": engine.parallel_limit(),
                         "diar_threshold": db.setting_get("diar_threshold", 0.5), "mock": config.ENABLE_MOCK},
            "data_dir": str(config.DATA_DIR), "disk_free_gb": round(shutil.disk_usage(config.DATA_DIR).free / 1e9, 1),
            "persistence": _persistence(),
            "me": {**(auth.current.get() or {"id": "admin", "name": "Locale", "admin": True})}, "multiuser": auth.protected()}


class SettingsIn(BaseModel):
    device: str | None = None
    parallel: int | None = None
    diar_threshold: float | None = None


@app.put("/api/settings")
def put_settings(s: SettingsIn):
    admin_only()
    if s.device is not None:
        if s.device not in ("auto", "cpu", "cuda"):
            err(400, "Dispositivo non valido.")
        db.setting_set("device", s.device)
    if s.parallel is not None:
        if not 1 <= s.parallel <= engine.MAX_WORKERS:
            err(400, f"Lavori in parallelo: da 1 a {engine.MAX_WORKERS}.")
        db.setting_set("parallel", s.parallel)
    if s.diar_threshold is not None:
        if not 0.2 <= s.diar_threshold <= 0.95:
            err(400, "Soglia non valida (0,2 - 0,95).")
        db.setting_set("diar_threshold", s.diar_threshold)
    return system()["settings"]


@app.get("/api/activity")
def activity():
    """Tutto ciò che sta lavorando in background (per il centro attività e le notifiche)."""
    jobs = [j for j in db.list_all(owner=me()) if j["status"] in ("queued", "running", "recording")]
    dl = {k: v for k, v in installer._state.items() if v.get("state") in ("starting", "downloading", "extracting")}
    mine = {j["id"] for j in jobs}
    ai = {m: v for m, v in llm.PULL.items() if v.get("state") in ("starting", "downloading")}
    return {"jobs": jobs, "downloads": dl | {"ai:" + k: v | {"state": "downloading"} for k, v in ai.items()}, "parallel": engine.parallel_limit(),
            "live": [{"id": s.tid, **s.status_msg()} for s in live.sessions.values() if s.tid in mine]}


# ---------------------------------------------------------------- modelli
def _desc(mid, dev, measured):
    return registry.describe(mid, dev, measured) | {"install": installer.status(mid)}


@app.get("/api/models")
def models(language: str = "it"):
    if language not in registry.BY_LANGUAGE:
        err(400, "Lingua non supportata.")
    dev, meas = db.setting_get("device", "auto"), db.measured_rtf()
    rec, why = registry.recommended(language, dev)
    return {"language": language, "models": [_desc(m, dev, meas) for m in registry.BY_LANGUAGE[language]],
            "fast": [_desc(m, dev, meas) for m in registry.FAST], "recommended": rec, "recommended_reason": why}


@app.get("/api/models/all")
def models_all():
    dev, meas = db.setting_get("device", "auto"), db.measured_rtf()
    return {"models": [_desc(m, dev, meas) for m in registry.ALL],
            "total_disk_bytes": sum(registry.disk_usage(m) for m in registry.ALL)}


@app.post("/api/models/{mid}/install")
def install(mid: str):
    admin_only()
    if mid not in registry.ALL:
        err(404, "Modello sconosciuto.")
    installer.start(mid)  # solo su richiesta esplicita dell'utente
    return installer.status(mid)


@app.post("/api/models/{mid}/cancel")
def install_cancel(mid: str):
    admin_only()
    installer.cancel(mid)
    return {"ok": True}


@app.get("/api/models/{mid}/status")
def install_status(mid: str):
    if mid not in registry.ALL:
        err(404, "Modello sconosciuto.")
    return installer.status(mid)


@app.delete("/api/models/{mid}")
def delete_model(mid: str):
    admin_only()
    if mid not in registry.ALL:
        err(404, "Modello sconosciuto.")
    try:
        installer.delete(mid)
    except RuntimeError as e:
        err(409, str(e))
    return {"ok": True}


# ---------------------------------------------------------------- vocabolario
class VocabIn(BaseModel):
    term: str
    context: str = "*"


@app.get("/api/vocab")
def vocab_get():
    return {"custom": db.vocab_list(me()), "builtin": vocab.BUILTIN, "contexts": vocab.CONTEXTS}


@app.post("/api/vocab")
def vocab_post(v: VocabIn):
    if not v.term.strip():
        err(400, "Termine vuoto.")
    if v.context != "*" and v.context not in vocab.CONTEXTS:
        err(400, "Contesto non valido.")
    db.vocab_add(v.term, v.context, me())
    return {"ok": True}


@app.delete("/api/vocab/{vid}")
def vocab_delete(vid: int):
    db.vocab_del(vid, me())
    return {"ok": True}


# ---------------------------------------------------------------- cartelle (materie > argomenti)
class FolderIn(BaseModel):
    name: str
    parent_id: str | None = None
    prefs: dict | None = None


class FolderPatch(BaseModel):
    name: str | None = None
    parent_id: str | None = None
    move: bool = False          # True: applica parent_id (anche None = radice)
    prefs: dict | None = None


def _folder_path(fid):
    names, seen = [], set()
    while fid and fid not in seen:
        seen.add(fid)
        f = db.folder_get(fid)
        if not f:
            break
        names.append(f["name"])
        fid = f["parent_id"]
    return " / ".join(reversed(names))


@app.get("/api/folders")
def folders():
    return {"folders": db.folder_list(me()), "unfiled": db.conn().execute("SELECT COUNT(*) FROM transcripts WHERE folder_id IS NULL AND owner=?", (me(),)).fetchone()[0]}


@app.post("/api/folders")
def folder_new(f: FolderIn):
    if not f.name.strip():
        err(400, "Nome vuoto.")
    if f.parent_id:
        _fo(f.parent_id)
    return {"id": db.folder_add(f.name, f.parent_id, f.prefs, me())}


@app.patch("/api/folders/{fid}")
def folder_patch(fid: str, p: FolderPatch):
    cur = _fo(fid)
    fields = {}
    if p.name is not None:
        if not p.name.strip():
            err(400, "Nome vuoto.")
        fields["name"] = p.name.strip()[:80]
    if p.move:
        if p.parent_id:
            _fo(p.parent_id)
        if p.parent_id and p.parent_id in db.folder_descendants(fid):
            err(400, "Spostamento non valido (una cartella non può stare dentro sé stessa).")
        fields["parent_id"] = p.parent_id
    if p.prefs is not None:
        fields["prefs"] = {**(cur["prefs"] or {}), **p.prefs}
    if fields:
        db.folder_update(fid, **fields)
    return {"ok": True}


@app.delete("/api/folders/{fid}")
def folder_del(fid: str):
    _fo(fid)
    db.folder_delete(fid)  # le trascrizioni NON vengono eliminate: salgono alla cartella superiore
    return {"ok": True}


class MoveIn(BaseModel):
    ids: list[str]
    folder_id: str | None = None


@app.post("/api/transcripts/move")
def move(m: MoveIn):
    if m.folder_id:
        _fo(m.folder_id)
    ids = [i for i in m.ids if _own(db.get(i))]
    db.move_to_folder(ids, m.folder_id)
    return {"ok": True, "moved": len(ids)}


# ---------------------------------------------------------------- appunti (pagine a mano libera con cartelle)
MAX_PAGE_BYTES = 30 * 1024 * 1024


def _page_data(d):
    d = d or {}
    if not isinstance(d, dict) or not isinstance(d.get("strokes", []), list) or not isinstance(d.get("texts", []), list):
        err(422, "Dati della pagina non validi.")
    if len(json.dumps(d)) > MAX_PAGE_BYTES:
        err(413, "La pagina è troppo grande.")
    w = min(max(float(d.get("w") or 820), 300), 8000)
    h = min(max(float(d.get("h") or 1160), 300), 40000)
    return {"w": w, "h": h, "paper": d.get("paper") or {"type": "lines", "gap": 32, "color": "#ffffff"},
            "strokes": d.get("strokes") or [], "texts": d.get("texts") or [], "seg_n": int(d.get("seg_n") or 0), "seg_end": float(d.get("seg_end", -1))}


def _pg(pid):
    p = db.page_get(pid, me())
    if not p:
        err(404, "Nota non trovata.")
    return p


def _page_preview(p):
    """Solo la parte alta della pagina (serve alla miniatura): la lista resta leggera anche con molte note."""
    d = p["data"]
    lim = float(d.get("w") or 820) * 1.3 + 40
    return {"w": d.get("w"), "h": d.get("h"), "paper": d.get("paper"),
            "strokes": [s for s in d.get("strokes", []) if (s.get("bb") or [0, 0])[1] <= lim],
            "texts": [x for x in d.get("texts", []) if (x.get("y") or 0) <= lim]}


class PageIn(BaseModel):
    title: str | None = None
    folder_id: str | None = None
    tid: str | None = None
    data: dict | None = None


class PagePatch(BaseModel):
    title: str | None = None
    folder_id: str | None = None
    set_folder: bool = False
    tid: str | None = None
    data: dict | None = None


@app.get("/api/pages")
def pages_list(folder_id: str | None = None, unfiled: bool = False, recursive: bool = True, q: str | None = None):
    ids = None
    if folder_id:
        _fo(folder_id)
        ids = db.folder_descendants(folder_id) if recursive else {folder_id}
    out = []
    for r in db.page_list(me(), q):
        if unfiled and r["folder_id"]:
            continue
        if ids is not None and r["folder_id"] not in ids:
            continue
        p = db.page_row(r, True)
        p["preview"] = _page_preview(p)
        p["strokes"] = len(p["data"].get("strokes", []))
        del p["data"]
        out.append(p)
    return {"pages": out}


@app.post("/api/pages")
def pages_new(b: PageIn):
    if b.folder_id:
        _fo(b.folder_id)
    if b.tid:
        _t(b.tid)
    pid = db.page_add(me(), b.title, b.folder_id, _page_data(b.data), b.tid)
    return db.page_get(pid, me())


@app.get("/api/pages/{pid}")
def pages_get(pid: str):
    p = _pg(pid)
    p["folder_path"] = _folder_path(p.get("folder_id"))
    return p


@app.put("/api/pages/{pid}")
def pages_save(pid: str, b: PagePatch):
    _pg(pid)
    fields = {}
    if b.title is not None:
        fields["title"] = b.title.strip()[:120] or "Nota"
    if b.set_folder:
        if b.folder_id:
            _fo(b.folder_id)
        fields["folder_id"] = b.folder_id
    if b.tid is not None:
        _t(b.tid)
        fields["tid"] = b.tid
    if b.data is not None:
        fields["data"] = _page_data(b.data)
    db.page_update(pid, **fields)
    return {"ok": True, "updated": db.page_get(pid, me())["updated"]}


@app.delete("/api/pages/{pid}")
def pages_del(pid: str):
    _pg(pid)
    db.page_delete(pid)
    return {"ok": True}


# ---------------------------------------------------------------- upload
@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    uid = db.new_id()
    d = config.UPLOADS / uid
    d.mkdir(parents=True)
    suffix = Path(file.filename or "audio").suffix.lower()[:8] or ".bin"
    dst = d / f"original{suffix}"
    h, size = hashlib.sha256(), 0
    with open(dst, "wb") as f:  # scrittura a blocchi: niente file intero in RAM
        while chunk := await file.read(1 << 20):
            f.write(chunk)
            h.update(chunk)
            size += len(chunk)
    try:
        info = await asyncio.to_thread(audio.probe, dst)
    except audio.AudioError as e:
        shutil.rmtree(d, ignore_errors=True)
        err(400, str(e))
    meta = {"upload_id": uid, "name": file.filename, "size": size, "sha": h.hexdigest(), "path": str(dst), "owner": me(), **info}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return meta


# Caricamento a pezzi (4 MB l'uno, con ripresa): regge i tunnel/proxy (es. Codespaces) che interrompono le richieste lunghe.
@app.post("/api/upload/begin")
async def upload_begin(request: Request):
    j = await request.json()
    uid = db.new_id()
    d = config.UPLOADS / uid
    d.mkdir(parents=True)
    suffix = Path(str(j.get("name") or "audio")).suffix.lower()[:8] or ".bin"
    (d / "partial.json").write_text(json.dumps({"owner": me(), "name": j.get("name"), "suffix": suffix}))
    (d / f"original{suffix}").write_bytes(b"")
    return {"upload_id": uid}


def _partial(uid):
    if not uid.isalnum():
        err(404, "Upload non trovato.")
    p = config.UPLOADS / uid / "partial.json"
    if not p.exists():
        err(404, "Upload non trovato.")
    m = json.loads(p.read_text())
    if (m.get("owner") or auth.ADMIN_ID) != me():
        err(404, "Upload non trovato.")
    return m, config.UPLOADS / uid / f"original{m['suffix']}"


@app.put("/api/upload/{uid}/chunk")
async def upload_chunk(uid: str, request: Request, offset: int = 0):
    _, dst = _partial(uid)
    size = dst.stat().st_size
    if offset > size:
        err(409, f"Pezzo fuori sequenza (il server ha {size} byte).")
    with open(dst, "r+b") as f:  # un pezzo ripetuto dopo un errore riscrive lo stesso punto: nessun duplicato
        f.seek(offset)
        f.truncate(offset)
        async for part in request.stream():
            f.write(part)
    return {"size": dst.stat().st_size}


@app.post("/api/upload/{uid}/finish")
async def upload_finish(uid: str):
    m, dst = _partial(uid)
    d = dst.parent

    def _sha():
        h = hashlib.sha256()
        with open(dst, "rb") as f:
            while chunk := f.read(1 << 20):
                h.update(chunk)
        return h.hexdigest()
    sha = await asyncio.to_thread(_sha)
    try:
        info = await asyncio.to_thread(audio.probe, dst)
    except audio.AudioError as e:
        shutil.rmtree(d, ignore_errors=True)
        err(400, str(e))
    meta = {"upload_id": uid, "name": m.get("name"), "size": dst.stat().st_size, "sha": sha, "path": str(dst), "owner": me(), **info}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    (d / "partial.json").unlink(missing_ok=True)
    return meta


def _upload(uid):
    p = config.UPLOADS / uid / "meta.json"
    if not p.exists():
        err(404, "Upload non trovato.")
    m = json.loads(p.read_text())
    if (m.get("owner") or auth.ADMIN_ID) != me():
        err(404, "Upload non trovato.")
    return m


# ---------------------------------------------------------------- creazione lavori
class JobIn(BaseModel):
    upload_id: str
    language: str = "it"
    model_id: str
    context: str = "Altro"
    mode: str = "fedele"
    normalize: bool = False
    denoise: bool = False
    diarize: bool = False          # riconoscimento parlanti (componente opzionale)
    num_speakers: int | None = None
    teacher_only: bool = False     # salta del tutto l'audio delle voci diverse dall'insegnante (più veloce)
    title: str | None = None
    folder_id: str | None = None
    force: bool = False


def _validate(j: JobIn):
    if j.language not in registry.BY_LANGUAGE:
        err(400, "Lingua non supportata.")
    allowed = set(registry.BY_LANGUAGE[j.language]) | set(registry.FAST)
    if j.model_id not in allowed:
        err(400, f"Il modello {j.model_id} non è disponibile per la lingua '{j.language}'.")
    ok, why = registry.compatibility(j.model_id, db.setting_get("device", "auto"))
    if not ok:
        err(422, "Modello non compatibile con l'hardware: " + why)
    if not registry.is_installed(j.model_id):
        err(409, "Modello non installato: installalo dalla sezione Modelli AI.")
    if j.context not in vocab.CONTEXTS:
        err(400, "Contesto non valido.")
    if (j.diarize or j.teacher_only) and not diarization.available()[0]:
        err(422, "Riconoscimento parlanti non disponibile: " + diarization.available()[1])
    if j.folder_id:
        _fo(j.folder_id)


def _create(j: JobIn, group=None, dedupe=True):
    m = _upload(j.upload_id)
    diar = j.diarize or j.teacher_only
    opts = {"normalize": j.normalize, "denoise": j.denoise, "diarize": diar, "teacher_only": j.teacher_only,
            "num_speakers": j.num_speakers, "mode": j.mode}
    key = "|".join(map(str, [m["sha"], j.model_id, j.language, j.context, j.normalize, j.denoise, diar, j.teacher_only, j.num_speakers]))
    if dedupe and not j.force:
        ex = db.find_dedupe(key, me())
        if ex:
            if ex["upload_id"] != j.upload_id and not db.uses_upload(j.upload_id):
                shutil.rmtree(config.UPLOADS / j.upload_id, ignore_errors=True)  # niente file orfani
            return ex["id"], True
    tid = db.insert(title=j.title or Path(m["name"] or "audio").stem, upload_id=j.upload_id, filename=m["name"],
                    audio_path=m["path"], audio_sha=m["sha"], duration=m["duration"], language=j.language,
                    model_id=j.model_id, context=j.context, options=opts, status="queued", kind="file",
                    group_id=group, folder_id=j.folder_id, owner=me(), dedupe_key=key if dedupe else None)
    if j.folder_id:  # "memoria" della cartella: la prossima registrazione parte con le stesse scelte
        db.folder_update(j.folder_id, prefs={**(db.folder_get(j.folder_id)["prefs"] or {}), "language": j.language, "model_id": j.model_id,
                                              "context": j.context, "diarize": j.diarize, "teacher_only": j.teacher_only})
    engine.submit(tid)
    return tid, False


@app.post("/api/transcripts")
def create(j: JobIn):
    _validate(j)
    tid, dup = _create(j)
    return {"id": tid, "duplicate": dup}


class CompareIn(JobIn):
    model_id: str = ""
    model_ids: list[str]


@app.post("/api/compare")
def compare(c: CompareIn):
    ids = list(dict.fromkeys(c.model_ids))
    if not 2 <= len(ids) <= 3:
        err(400, "Seleziona 2 o 3 modelli.")
    gid = db.new_id()
    jobs = []
    for mid in ids:  # valida tutto prima di creare qualsiasi lavoro
        _validate(c.model_copy(update={"model_id": mid}))
    for mid in ids:
        tid, _ = _create(c.model_copy(update={"model_id": mid}), group=gid, dedupe=False)
        jobs.append(tid)
    return {"group_id": gid, "ids": jobs}


@app.get("/api/compare/{gid}")
def compare_get(gid: str):
    items = [db.get(r["id"]) for r in db.conn().execute("SELECT id FROM transcripts WHERE group_id=? ORDER BY created", (gid,))]
    items = [t for t in items if _own(t)]
    if not items:
        err(404, "Confronto non trovato.")
    done = [t for t in items if t["status"] == "done"]
    diffs = []
    for i in range(len(done)):
        for j in range(i + 1, len(done)):
            b = word_diff(done[i]["segments"], done[j]["segments"])
            diffs.append({"a": done[i]["id"], "b": done[j]["id"], "summary": diff_summary(b),
                          "blocks": [x for x in b if x["op"] != "equal"][:2000]})
    brief = [{k: t[k] for k in ("id", "model_id", "status", "error", "stats", "chunks_done", "chunks_total", "duration", "has_word_ts")} |
             {"word_count": len(full_text(t["segments"]).split()) if t["segments"] else None,
              "text": full_text(t["segments"]) if t["segments"] else None} for t in items]
    return {"group_id": gid, "items": brief, "diffs": diffs,
            "note": "Le differenze indicano dove i modelli divergono, NON quale sia più accurato. "
                    "Il WER si calcola solo con un riferimento verificato (endpoint /wer)."}


# ---------------------------------------------------------------- archivio / dettaglio
@app.get("/api/transcripts")
def list_t(status: str | None = None, folder_id: str | None = None, unfiled: bool = False, recursive: bool = True):
    items = db.list_all(status, owner=me())
    if unfiled:
        items = [t for t in items if not t["folder_id"]]
    elif folder_id:
        ids = db.folder_descendants(folder_id) if recursive else {folder_id}
        items = [t for t in items if t["folder_id"] in ids]
    return items


@app.get("/api/search")
def search(q: str):
    """Ricerca nel testo di TUTTE le trascrizioni (e nei titoli): accenti e maiuscole ignorati, prefissi ammessi."""
    hits = db.search(q, owner=me())
    out = []
    for h in hits:
        t = db.conn().execute("SELECT id,title,folder_id,duration,created,model_id FROM transcripts WHERE id=?", (h["id"],)).fetchone()
        if t:
            out.append(dict(t) | {"snippet": h["snippet"], "folder": _folder_path(t["folder_id"])})
    return {"results": out}


@app.get("/api/transcripts/{tid}")
def get_t(tid: str):
    t = _t(tid)
    t.pop("partial", None)
    t["notes"] = db.note_list(tid)
    t["folder_path"] = _folder_path(t.get("folder_id"))
    return t


class PatchIn(BaseModel):
    title: str | None = None
    edits: list[dict] = []  # [{i: indice segmento, text?: nuovo testo, speaker?: id}]
    folder_id: str | None = None
    set_folder: bool = False


@app.patch("/api/transcripts/{tid}")
def patch_t(tid: str, p: PatchIn):
    t = _t(tid)
    fields = {}
    if p.title is not None:
        fields["title"] = p.title.strip()[:200] or t["title"]
    if p.set_folder:
        if p.folder_id:
            _fo(p.folder_id)
        fields["folder_id"] = p.folder_id
    if p.edits:
        segs = t["segments"] or []
        for e in p.edits:
            if not isinstance(e.get("i"), int) or not 0 <= e["i"] < len(segs):
                err(400, "Indice segmento non valido.")
            if "text" in e:
                segs[e["i"]]["text"] = str(e["text"])
            if "speaker" in e:
                segs[e["i"]]["speaker"] = e["speaker"]
        fields["segments"] = segs
    if fields:
        db.update(tid, **fields)
        if "segments" in fields or "title" in fields:
            db.index_text(tid, fields.get("title", t["title"]), full_text(fields.get("segments", t["segments"]) or []))
    return {"ok": True}


class SpeakerIn(BaseModel):
    id: str
    label: str | None = None
    teacher: bool | None = None


@app.patch("/api/transcripts/{tid}/speakers")
def speakers_patch(tid: str, s: SpeakerIn):
    t = _t(tid, True)
    st = t["stats"] or {}
    sp = st.get("speakers") or {}
    if s.id not in sp:
        err(404, "Parlante sconosciuto.")
    if s.label is not None:
        sp[s.id]["label"] = s.label.strip()[:40] or sp[s.id]["label"]
    if s.teacher:
        old = st.get("teacher")
        for k, v in sp.items():
            v["teacher"] = k == s.id
        if old and old != s.id and sp[old]["label"] == "Insegnante":
            sp[old]["label"] = "Voce " + old.lstrip("S")
        if sp[s.id]["label"].startswith("Voce"):
            sp[s.id]["label"] = "Insegnante"
        st["teacher"] = s.id
    st["speakers"] = sp
    db.update(tid, stats=st)
    return {"speakers": sp, "teacher": st.get("teacher")}


@app.post("/api/transcripts/{tid}/cancel")
def cancel_t(tid: str):
    _t(tid)
    if not engine.cancel(tid):
        err(404, "Non trovata.")
    return {"ok": True}


@app.post("/api/transcripts/{tid}/retry")
def retry_t(tid: str):
    t = db.get(tid)
    if not _own(t) or t["status"] not in ("failed", "cancelled"):
        err(409, "Solo i lavori falliti o annullati possono essere ripresi.")
    db.update(tid, status="queued", error=None)  # riprende dai chunk già salvati
    engine.submit(tid)
    return {"ok": True}


class ReIn(BaseModel):
    model_id: str
    language: str | None = None
    diarize: bool = False
    teacher_only: bool = False


@app.post("/api/transcripts/{tid}/retranscribe")
def retranscribe(tid: str, r: ReIn):
    """Ritrascrive lo stesso audio con un altro modello (es. dopo una sessione live con un modello veloce)."""
    t = _t(tid)
    opts = t["options"] or {}
    j = JobIn(upload_id=t["upload_id"], language=r.language or t["language"], model_id=r.model_id, context=t["context"] or "Altro",
              normalize=bool(opts.get("normalize")), denoise=bool(opts.get("denoise")), diarize=r.diarize, teacher_only=r.teacher_only,
              title=(t["title"] or "") + f" ({registry.ALL[r.model_id]['name'].split(' (')[0]})" if r.model_id in registry.ALL else t["title"],
              folder_id=t.get("folder_id"))
    _validate(j)
    new_id, dup = _create(j)
    return {"id": new_id, "duplicate": dup}


def _delete_one(t, with_audio=True):
    db.delete(t["id"])
    if with_audio and t.get("upload_id") and not db.uses_upload(t["upload_id"]):
        shutil.rmtree(config.UPLOADS / t["upload_id"], ignore_errors=True)  # eliminazione definitiva dei file


def _discard(t, with_audio=True):
    """Elimina una registrazione IN QUALUNQUE STATO: se è una registrazione live aperta la chiude senza salvarla, se è un lavoro
    in corso lo annulla, poi cancella dati e file. (Prima rispondeva 409 e la registrazione restava lì per sempre.)"""
    tid = t["id"]
    s = live.sessions.get(tid)
    if s:
        s.abort()
    if t["status"] in ("running", "queued"):
        engine.cancel(tid)
        for _ in range(80):                       # fino a ~8 s perché il lavoro si fermi tra un segmento e l'altro
            cur = db.get(tid)
            if not cur or cur["status"] != "running":
                break
            time.sleep(0.1)
    _delete_one(db.get(tid) or t, with_audio)


@app.delete("/api/transcripts/{tid}")
def delete_t(tid: str, with_audio: bool = True):
    _discard(_t(tid), with_audio)
    return {"ok": True}


class IdsIn(BaseModel):
    ids: list[str]


@app.post("/api/transcripts/delete")
def delete_many(b: IdsIn):
    n = 0
    for tid in b.ids:
        t = db.get(tid)
        if _own(t):
            _discard(t)
            n += 1
    return {"deleted": n}


@app.post("/api/live/{tid}/recover")
def live_recover(tid: str):
    """Recupera una registrazione rimasta 'aperta' (pagina chiusa, riavvio): converte l'audio già salvato e chiude la sessione."""
    t = _t(tid)
    if t["status"] != "recording" or tid in live.sessions:
        err(409, "Questa registrazione non è in attesa di recupero.")
    live.finalize_audio(tid, t["upload_id"], t.get("segments") or [], {"live": True, "recovered": True})
    return {"status": db.get(tid)["status"]}


@app.get("/api/transcripts/{tid}/audio")
def audio_file(tid: str, download: bool = False):
    t = _t(tid)
    if not t["audio_path"] or not Path(t["audio_path"]).exists():
        err(404, "Audio non disponibile.")
    p = Path(t["audio_path"])
    mt = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote((t['title'] or 'audio') + p.suffix)}"} if download else None
    return FileResponse(p, media_type=mt, headers=headers)  # supporta Range (necessario a Safari/iPad)


@app.get("/api/transcripts/{tid}/waveform")
def waveform(tid: str, bins: int = 1600):
    t = _t(tid)
    if not t["audio_path"] or not Path(t["audio_path"]).exists():
        return {"peaks": [], "available": False}
    p = engine.pcm_path(t["upload_id"], t["options"] or {})
    if not p.exists():
        try:
            engine.ensure_pcm(t["audio_path"], p, (t["options"] or {}).get("normalize"), (t["options"] or {}).get("denoise"))
        except audio.AudioError:
            return {"peaks": [], "available": False}
    return {"peaks": audio.waveform_peaks(audio.open_pcm(p), min(max(bins, 100), 4000)), "available": True}


@app.get("/api/transcripts/{tid}/suggestions")
def suggestions(tid: str):
    t = _t(tid, True)
    sug = vocab.suggestions(t["segments"], t["context"] or "Altro", owner=me())
    for m in db.corr_list(me(), t["context"] or "Altro"):      # correzioni già approvate in passato (memoria)
        for i, s in enumerate(t["segments"]):
            for w in s["text"].split():
                if w.strip(".,;:!?") == m["wrong"]:
                    sug.append({"seg": i, "word": w, "term": m["right"], "score": 1.0, "source": "memoria"})
    return {"suggestions": sug,
            "note": "Proposte da confermare manualmente: nessuna parola viene sostituita automaticamente."}


class WerIn(BaseModel):
    reference: str


@app.post("/api/transcripts/{tid}/wer")
def wer_t(tid: str, w: WerIn):
    t = _t(tid, True)
    try:
        r = wer(w.reference, full_text(exports.visible_segments(t, True)))
    except ValueError as e:
        err(400, str(e))
    db.update(tid, reference_text=w.reference)
    return r | {"note": "WER valido solo se il riferimento è una trascrizione verificata manualmente."}


# ---------------------------------------------------------------- annotazioni ed evidenziazioni
class AnnIn(BaseModel):
    kind: str = "note"             # "note" | "highlight"
    t0: float
    t1: float | None = None
    text: str = ""


@app.get("/api/transcripts/{tid}/annotations")
def ann_list(tid: str):
    _t(tid)
    return {"annotations": db.note_list(tid)}


@app.post("/api/transcripts/{tid}/annotations")
def ann_add(tid: str, a: AnnIn):
    _t(tid)
    if a.kind not in ("note", "highlight"):
        err(400, "Tipo non valido.")
    if a.kind == "note" and not a.text.strip():
        err(400, "Nota vuota.")
    return {"id": db.note_add(tid, a.kind, a.t0, a.t1, a.text.strip()[:2000])}


class AnnPatch(BaseModel):
    text: str | None = None
    t0: float | None = None
    t1: float | None = None


@app.patch("/api/annotations/{nid}")
def ann_patch(nid: str, a: AnnPatch):
    _t(db.note_tid(nid) or "")
    f = {k: v for k, v in a.model_dump().items() if v is not None}
    if f:
        db.note_update(nid, **f)
    return {"ok": True}


@app.delete("/api/annotations/{nid}")
def ann_del(nid: str):
    _t(db.note_tid(nid) or "")
    db.note_delete(nid)
    return {"ok": True}


# ---------------------------------------------------------------- LIVE
class LiveIn(BaseModel):
    language: str = "it"
    model_id: str
    context: str = "Altro"
    title: str | None = None
    folder_id: str | None = None


@app.post("/api/live")
def live_start(b: LiveIn):
    """Crea la sessione e CARICA il modello (può richiedere qualche secondo) prima di far partire la registrazione."""
    _validate(JobIn(upload_id="x", language=b.language, model_id=b.model_id, context=b.context, folder_id=b.folder_id))
    device = registry.resolve_device(db.setting_get("device", "auto"))
    uid = db.new_id()
    (config.UPLOADS / uid).mkdir(parents=True)
    title = b.title or "Lezione " + time.strftime("%d/%m/%Y %H:%M")
    tid = db.insert(title=title, upload_id=uid, filename=None, audio_path="", duration=0, language=b.language, model_id=b.model_id,
                    context=b.context, options={"live": True}, status="recording", kind="live", folder_id=b.folder_id, owner=me(), segments=[])
    s = live.LiveSession(tid, uid, b.model_id, device, b.language, b.context)
    try:
        s.start()
    except Exception as e:
        db.delete(tid)
        shutil.rmtree(config.UPLOADS / uid, ignore_errors=True)
        err(500, f"Impossibile avviare il modello: {type(e).__name__}: {e}")
    live.sessions[tid] = s
    return {"id": tid, "sample_rate": audio.SR}


@app.post("/api/live/{tid}/stop")
async def live_stop(tid: str):
    _t(tid)
    s = live.sessions.get(tid)
    if not s:
        t = _t(tid)
        return {"id": tid, "status": t["status"]}
    await asyncio.to_thread(s.finish)
    return {"id": tid, "status": db.get(tid)["status"]}


@app.websocket("/api/live/{tid}/ws")
async def live_ws(ws: WebSocket, tid: str):
    user = auth.resolve(ws.query_params.get("token"))
    if not user:
        await ws.close(code=4401)
        return
    auth.current.set(user)
    if not _own(db.get(tid)):
        await ws.close(code=4404)
        return
    s = live.sessions.get(tid)
    if not s:
        await ws.close(code=4404)
        return
    await ws.accept()
    outq: asyncio.Queue = asyncio.Queue()
    s.attach(asyncio.get_running_loop(), outq)
    await ws.send_json({"type": "ready", "received_s": s.received_s, "segments": s.segments})

    async def sender():
        while True:
            msg = await outq.get()
            await ws.send_json(msg)
            if msg.get("type") == "done":
                return

    task = asyncio.create_task(sender())
    try:
        while True:
            m = await ws.receive()
            if m.get("type") == "websocket.disconnect":
                break
            if m.get("bytes"):
                s.feed(m["bytes"])
                if s.frame_i % 10 == 0:
                    outq.put_nowait(s.status_msg())
            elif m.get("text"):
                msg = json.loads(m["text"])
                if msg.get("type") == "stop":
                    await asyncio.to_thread(s.finish)
                    break
    except WebSocketDisconnect:
        pass
    finally:
        await asyncio.sleep(0.05)
        task.cancel()
        s.attach(None, None)  # la sessione resta viva: il client può riconnettersi


# ---------------------------------------------------------------- modalità / appunti LLM / export
def _render(t, mode, teacher_only=True):
    segs = exports.visible_segments(t, teacher_only)
    if mode == "fedele":
        return full_text(segs, "\n")
    if mode == "pulita":
        return postprocess.clean_paragraphs(segs, t["language"] if t["language"] != "auto" else (t.get("detected_language") or "it"))
    if mode == "appunti":
        n = (t.get("stats") or {}).get("notes")
        if not n:
            err(404, "Appunti non ancora generati.")
        return n
    err(400, "Modalità sconosciuta.")


@app.get("/api/transcripts/{tid}/render")
def render(tid: str, mode: str = "fedele", teacher_only: bool = True):
    t = _t(tid, True)
    return {"mode": mode, "text": _render(t, mode, teacher_only), "ai_generated": mode == "appunti",
            "note": {"fedele": "Testo del modello, con le tue correzioni.",
                     "pulita": "Rimossi solo intercalari e raddoppi di parole funzione; paragrafi dalle pause. Nessun LLM.",
                     "appunti": "Rielaborazione generata da un LLM locale: NON è testo pronunciato."}[mode]}


class NotesIn(BaseModel):
    llm: str


@app.post("/api/transcripts/{tid}/study-notes")
def make_notes(tid: str, n: NotesIn):
    t = _t(tid, True)
    avail = postprocess.llm_models()
    if not avail:
        err(422, "Nessun LLM locale disponibile (Ollama non raggiunto su %s). Gli appunti strutturati richiedono un modello linguistico locale; "
                 "un modello ASR non può rielaborare il testo." % config.OLLAMA_URL)
    if n.llm not in avail:
        err(400, "LLM non installato in Ollama.")
    lang = t["language"] if t["language"] != "auto" else (t.get("detected_language") or "it")

    def work():
        st = db.get(tid)["stats"] or {}
        st.update(notes_status="running", notes_llm=n.llm)
        db.update(tid, stats=st)
        try:
            txt = postprocess.structured_notes(postprocess.clean_paragraphs(exports.visible_segments(t, True), lang), lang, n.llm)
            st = db.get(tid)["stats"] or {}
            st.update(notes=txt, notes_status="done")
        except Exception as e:
            st = db.get(tid)["stats"] or {}
            st.update(notes_status="error", notes_error=str(e)[:300])
        db.update(tid, stats=st)

    threading.Thread(target=work, daemon=True).start()
    return {"started": True}


def _fname(name):
    return "".join(c if c.isalnum() or c in "-_ " else "_" for c in (name or "trascrizione")).strip() or "trascrizione"


def _download(data, ctype, name):
    return Response(data, media_type=ctype, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


def _items(ids, mode, teacher_only, with_notes):
    items = []
    for tid in ids:
        t = db.get(tid)
        if not _own(t) or not t["segments"]:
            continue
        items.append({"t": t, "notes": db.note_list(tid) if with_notes else [], "folder": _folder_path(t.get("folder_id")),
                      "paragraphs": None if mode == "fedele" else _render(t, mode, teacher_only)})
    if not items:
        err(404, "Nessuna trascrizione completata tra quelle selezionate.")
    return items


@app.get("/api/transcripts/{tid}/export/{fmt}")
def export(tid: str, fmt: str, mode: str = "fedele", teacher_only: bool = True, notes: bool = True):
    t = _t(tid, True)
    if fmt not in exports.FORMATS:
        err(400, "Formato non supportato.")
    if fmt in exports.SINGLE_ONLY:
        data = exports.SINGLE_ONLY[fmt](t, teacher_only=teacher_only, notes=db.note_list(tid))
    else:
        data = exports.MULTI[fmt](_items([tid], mode, teacher_only, notes), teacher_only, notes)
    return _download(data, exports.FORMATS[fmt], f"{_fname(t['title'])}.{fmt}")


def _ids(s):
    return [i for i in s.split(",") if i]


@app.get("/api/export/bundle")
def export_bundle(ids: str, fmt: str = "pdf", mode: str = "fedele", teacher_only: bool = True, notes: bool = True):
    """UNA sola esportazione (PDF/DOCX/TXT) con tutte le trascrizioni selezionate una dopo l'altra."""
    if fmt not in exports.MULTI:
        err(400, "Formato non supportato per l'esportazione multipla (usa pdf, docx o txt).")
    items = _items(_ids(ids), mode, teacher_only, notes)
    data = exports.MULTI[fmt](items, teacher_only, notes)
    return _download(data, exports.FORMATS[fmt], f"Trascrizioni ({len(items)}).{fmt}")


@app.get("/api/export/text")
def export_text(ids: str, mode: str = "fedele", teacher_only: bool = True, notes: bool = True):
    """Testo semplice da copiare negli appunti (una o più trascrizioni)."""
    items = _items(_ids(ids), mode, teacher_only, notes)
    return Response(exports.to_txt(items, teacher_only, notes), media_type="text/plain; charset=utf-8")


@app.get("/api/export/audio.zip")
def export_audio_zip(ids: str):
    """Tutti gli audio selezionati in un unico ZIP (senza ricompressione: l'audio è già compresso)."""
    buf = io.BytesIO()
    used = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for tid in _ids(ids):
            t = db.get(tid)
            if not _own(t) or not t["audio_path"] or not Path(t["audio_path"]).exists():
                continue
            p = Path(t["audio_path"])
            name, k = f"{_fname(t['title'])}{p.suffix}", 1
            while name in used:
                k += 1
                name = f"{_fname(t['title'])} ({k}){p.suffix}"
            used.add(name)
            z.write(p, name)
    if not used:
        err(404, "Nessun audio disponibile.")
    return _download(buf.getvalue(), "application/zip", "Audio registrazioni.zip")


# ---------------------------------------------------------------- quaderno (testo ricco + inchiostro Apple Pencil)
def _reindex(t):
    db.index_text(t["id"], t["title"], full_text([s for s in (t["segments"] or []) if not s.get("off_topic")]))


@app.get("/api/transcripts/{tid}/notebook")
def nb_get(tid: str):
    nb = _t(tid).get("notebook")
    return {"exists": bool(nb), **(nb or {})}


class NbCreate(BaseModel):
    teacher_only: bool = True
    include_notes: bool = True
    force: bool = False


@app.post("/api/transcripts/{tid}/notebook/create")
def nb_create(tid: str, b: NbCreate):
    """Crea il quaderno dalla trascrizione (testo fedele in paragrafi, con evidenziazioni e note). Poi è indipendente."""
    t = _t(tid, True)
    if t.get("notebook") and not b.force:
        err(409, "Il quaderno esiste già.")
    nb = {"v": 1, "html": notebook.initial_html(t, db.note_list(tid), b.teacher_only, b.include_notes), "ink": [], "updated": time.time()}
    db.update(tid, notebook=nb)
    _reindex(t)
    return {"exists": True, **nb}


class NbPut(BaseModel):
    html: str
    ink: list = []


@app.put("/api/transcripts/{tid}/notebook")
def nb_put(tid: str, b: NbPut):
    t = _t(tid)
    if len(b.html) > notebook.MAX_HTML:
        err(413, "Il quaderno è troppo grande (testo).")
    ink = notebook.validate_ink(b.ink)
    if len(json.dumps(ink)) > notebook.MAX_INK:
        err(413, "Troppo inchiostro in un solo quaderno: cancella o dividi qualche disegno.")
    nb = {"v": 1, "html": notebook.sanitize(b.html), "ink": ink, "updated": time.time()}
    db.update(tid, notebook=nb)
    _reindex(t)
    return {"ok": True, "updated": nb["updated"], "strokes": len(ink)}


@app.delete("/api/transcripts/{tid}/notebook")
def nb_delete(tid: str):
    t = _t(tid)
    db.update(tid, notebook=None)
    _reindex(db.get(tid))
    return {"ok": True}


@app.get("/api/transcripts/{tid}/notebook/export/{fmt}")
def nb_export(tid: str, fmt: str):
    """Testo e DOCX del quaderno (senza inchiostro). Per un PDF con i disegni usa 'Stampa / PDF' dal browser."""
    t = _t(tid)
    nb = t.get("notebook")
    if not nb:
        err(404, "Quaderno non creato.")
    if fmt == "txt":
        return _download(notebook.to_text(nb["html"]).encode("utf-8"), "text/plain; charset=utf-8", f"{_fname(t['title'])} (quaderno).txt")
    if fmt == "docx":
        return _download(notebook.to_docx(nb["html"], t["title"]), exports.FORMATS["docx"], f"{_fname(t['title'])} (quaderno).docx")
    err(400, "Formato non supportato (txt, docx).")


# ---------------------------------------------------------------- profili (più persone, archivi separati)
@app.get("/api/me")
def whoami():
    return {**auth.current.get(), "multiuser": auth.protected()}


class UserIn(BaseModel):
    name: str


@app.get("/api/users")
def users_list():
    admin_only()
    return {"users": auth.list_users(), "multiuser": auth.protected()}


@app.post("/api/users")
def users_new(u: UserIn):
    admin_only()
    if not auth.protected():
        err(409, "I profili richiedono un codice di accesso: avvia l'app con --lan (o imposta STUDIO_TOKEN).")
    if not u.name.strip():
        err(400, "Nome vuoto.")
    return auth.create_user(u.name)     # il codice viene mostrato UNA volta sola


@app.post("/api/users/{uid}/reset")
def users_reset(uid: str):
    admin_only()
    code = auth.reset_code(uid)
    if not code:
        err(404, "Profilo non trovato.")
    return {"code": code}


@app.delete("/api/users/{uid}")
def users_del(uid: str, purge: bool = True):
    admin_only()
    if not auth.delete_user(uid):
        err(404, "Profilo non trovato.")
    if purge:      # elimina DEFINITIVAMENTE registrazioni, audio, cartelle e vocabolario di quella persona
        for up in db.purge_owner(uid):
            shutil.rmtree(config.UPLOADS / up, ignore_errors=True)
    return {"ok": True}


# ---------------------------------------------------------------- correzione AI (opzionale)
_ai_cancel: dict = {}


@app.get("/api/ai/status")
def ai_status():
    st = llm.status(hardware.ram_gb())
    st["install_hint"] = "Installa Ollama (gratuito, open source: ollama.com) sul computer che esegue l'app, poi torna qui."
    return st


class PullIn(BaseModel):
    model: str


@app.post("/api/ai/pull")
def ai_pull(b: PullIn):
    """Scarica il modello una volta sola: resta nell'archivio di Ollama (solo amministratore)."""
    admin_only()
    if llm.installed_models() is None:
        err(409, "Ollama non è in esecuzione su questo computer.")
    llm.pull(b.model)
    return llm.PULL[b.model]


@app.get("/api/transcripts/{tid}/ai-assessment")
def ai_assessment(tid: str):
    t = _t(tid, True)
    return llm.assess(t, me())


class ReviewIn(BaseModel):
    model: str
    scope: str = "flagged"           # "flagged" = solo i punti dubbi, "all" = tutto il testo
    instructions: str = ""
    off_topic: bool = True


@app.post("/api/transcripts/{tid}/ai-review")
def ai_review(tid: str, b: ReviewIn):
    t = _t(tid, True)
    if b.scope not in ("flagged", "all"):
        err(400, "Ambito non valido.")
    models = llm.installed_models()
    if models is None:
        err(409, "Ollama non è in esecuzione su questo computer: avvialo (vedi Impostazioni → Correzione AI).")
    if b.model not in models:
        err(409, f"Il modello {b.model} non è installato in Ollama.")
    if ((t.get("stats") or {}).get("ai_review") or {}).get("status") == "running":
        err(409, "Una revisione è già in corso.")
    _ai_cancel[tid] = False
    owner = me()
    threading.Thread(target=lambda: llm.review(tid, b.model, b.scope, b.instructions, b.off_topic, owner, lambda: _ai_cancel.get(tid, False)), daemon=True, name="ai-review").start()
    return {"started": True}


# ---- correzione AI di più trascrizioni insieme (in coda, una dopo l'altra; propone soltanto) ----
_ai_batches: dict = {}


class BatchReviewIn(BaseModel):
    ids: list[str]
    model: str
    scope: str = "flagged"
    instructions: str = ""
    off_topic: bool = True


def _owned_done(tid):
    t = db.get(tid)
    if not t or (t.get("owner") or auth.ADMIN_ID) != me():
        return None, "non trovata"
    if t["status"] != "done":
        return None, "non ancora completata"
    if not (t.get("segments") or []):
        return None, "senza testo"
    st = ((t.get("stats") or {}).get("ai_review") or {}).get("status")
    if st in ("running", "queued"):
        return None, "già in revisione"
    return t, None


@app.post("/api/ai/review-batch")
def ai_review_batch(b: BatchReviewIn):
    if b.scope not in ("flagged", "all"):
        err(400, "Ambito non valido.")
    models = llm.installed_models()
    if models is None:
        err(409, "Ollama non è in esecuzione su questo computer: avvialo (vedi Impostazioni → Correzione AI).")
    if b.model not in models:
        err(409, f"Il modello {b.model} non è installato in Ollama.")
    owner = me()
    if owner in _ai_batches:
        err(409, "Una correzione multipla è già in corso: attendi che finisca o fermala.")
    ids, skipped = [], []
    for tid in dict.fromkeys(b.ids):
        t, why = _owned_done(tid)
        if why:
            skipped.append({"id": tid, "title": (db.get(tid) or {}).get("title"), "reason": why})
            continue
        st = dict(t.get("stats") or {})
        st["ai_review"] = {"status": "queued", "model": b.model, "scope": b.scope, "done": 0, "total": 0, "items": [], "failed": 0}
        db.update(tid, stats=st)
        ids.append(tid)
    if not ids:
        return {"started": [], "skipped": skipped}
    batch = {"ids": ids, "cancel": False}
    _ai_batches[owner] = batch

    def run():
        try:
            for tid in ids:
                if batch["cancel"]:
                    st = (db.get(tid) or {}).get("stats") or {}
                    if (st.get("ai_review") or {}).get("status") == "queued":
                        st.pop("ai_review", None)
                        db.update(tid, stats=st)
                    continue
                _ai_cancel[tid] = False
                try:
                    llm.review(tid, b.model, b.scope, b.instructions, b.off_topic, owner, lambda tid=tid: batch["cancel"] or _ai_cancel.get(tid, False))
                except Exception as e:  # un errore su una trascrizione non ferma le altre
                    st = (db.get(tid) or {}).get("stats") or {}
                    st["ai_review"] = {"status": "error", "error": f"{type(e).__name__}: {e}"[:200], "items": []}
                    db.update(tid, stats=st)
        finally:
            _ai_batches.pop(owner, None)
    threading.Thread(target=run, daemon=True, name="ai-batch").start()
    return {"started": ids, "skipped": skipped}


class IdsIn(BaseModel):
    ids: list[str]


@app.post("/api/ai/review-status")
def ai_review_status(b: IdsIn):
    out = []
    for tid in dict.fromkeys(b.ids):
        t = db.get(tid)
        if not t or (t.get("owner") or auth.ADMIN_ID) != me():
            continue
        rv = (t.get("stats") or {}).get("ai_review") or {}
        items = rv.get("items") or []
        out.append({"id": tid, "title": t["title"], "status": rv.get("status") or "none", "done": rv.get("done", 0), "total": rv.get("total", 0),
                    "failed": rv.get("failed", 0), "error": rv.get("error"),
                    "edits": sum(1 for i in items if not i.get("off_topic") and not i.get("rejected") and i.get("new") != i.get("old")),
                    "off_topic": sum(1 for i in items if i.get("off_topic")), "applied": sum(1 for i in items if i.get("applied"))})
    return {"items": out, "active": me() in _ai_batches}


@app.post("/api/ai/review-batch/cancel")
def ai_review_batch_cancel():
    b = _ai_batches.get(me())
    if b:
        b["cancel"] = True
    return {"ok": True, "was_active": bool(b)}


class BatchApplyItem(BaseModel):
    id: str
    edits: list[int] = []
    off_topic: list[int] = []


class BatchApplyIn(BaseModel):
    items: list[BatchApplyItem]


@app.post("/api/ai/apply-batch")
def ai_apply_batch(b: BatchApplyIn):
    edits = off = n = 0
    for it in b.items:
        t = db.get(it.id)
        if not t or (t.get("owner") or auth.ADMIN_ID) != me():
            continue
        r = llm.apply(it.id, it.edits, it.off_topic, me())
        edits += r["edits"]
        off += r["off_topic"]
        n += 1
    return {"transcripts": n, "edits": edits, "off_topic": off}


@app.post("/api/transcripts/{tid}/ai-review/cancel")
def ai_review_cancel(tid: str):
    _t(tid)
    _ai_cancel[tid] = True
    return {"ok": True}


class ApplyIn(BaseModel):
    edits: list[int] = []
    off_topic: list[int] = []


@app.post("/api/transcripts/{tid}/ai-review/apply")
def ai_apply(tid: str, b: ApplyIn):
    _t(tid, True)
    return llm.apply(tid, b.edits, b.off_topic, me())


@app.post("/api/transcripts/{tid}/ai-review/discard")
def ai_discard(tid: str):
    t = _t(tid)
    st = t.get("stats") or {}
    st.pop("ai_review", None)
    db.update(tid, stats=st)
    return {"ok": True}


@app.post("/api/transcripts/{tid}/off-topic")
def set_off_topic(tid: str, b: ApplyIn):
    """Segna/riporta parti come fuori tema (edits = indici da riportare in tema, off_topic = indici da escludere)."""
    t = _t(tid, True)
    segs = t["segments"]
    for i in b.off_topic:
        if 0 <= i < len(segs):
            segs[i]["off_topic"] = True
    for i in b.edits:
        if 0 <= i < len(segs):
            segs[i].pop("off_topic", None)
    db.update(tid, segments=segs)
    return {"ok": True}


# memoria delle correzioni approvate
class CorrIn(BaseModel):
    scope: str = "Altro"
    wrong: str
    right: str


@app.get("/api/corrections")
def corr_get():
    return {"corrections": db.corr_list(me())}


@app.post("/api/corrections")
def corr_post(c: CorrIn):
    if not c.wrong.strip() or not c.right.strip() or c.wrong == c.right:
        err(400, "Coppia non valida.")
    db.corr_add(me(), c.scope, c.wrong.strip(), c.right.strip())
    return {"ok": True}


@app.delete("/api/corrections/{cid}")
def corr_del(cid: int):
    db.corr_del(me(), cid)
    return {"ok": True}


# ---------------------------------------------------------------- frontend statico (PWA)
if config.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
