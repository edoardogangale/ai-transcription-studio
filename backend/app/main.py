"""AI Transcription Studio - API FastAPI."""
import hashlib
import json
import mimetypes
import shutil
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import audio, auth, config, db, diarization, engine, exports, hardware, installer, postprocess, registry, vocab
from .textutil import diff_summary, full_text, wer, word_diff


@asynccontextmanager
async def lifespan(app):
    config.ensure_dirs()
    db.conn()
    engine.start_worker()
    yield


app = FastAPI(title="AI Transcription Studio", lifespan=lifespan)


@app.middleware("http")
async def guard(request: Request, call_next):
    p = request.url.path
    if p.startswith("/api/") and p != "/api/health":
        tok = request.headers.get("x-studio-token") or request.query_params.get("token")
        if not auth.valid(tok):
            return JSONResponse({"detail": "Token di accesso mancante o errato."}, status_code=401)
    return await call_next(request)


def err(code, msg):
    raise HTTPException(code, msg)


# ---------------------------------------------------------------- sistema / impostazioni
@app.get("/api/health")
def health():
    return {"ok": True, "auth_required": bool(config.ACCESS_TOKEN)}


@app.get("/api/system")
def system():
    import shutil as sh
    ok_d, why_d = diarization.available()
    return {"hardware": hardware.info(), "ffmpeg": bool(sh.which("ffmpeg") and sh.which("ffprobe")),
            "llm_models": postprocess.llm_models(), "contexts": vocab.CONTEXTS,
            "diarization": {"available": ok_d, "reason": why_d},
            "settings": {"device": db.setting_get("device", "auto"), "mock": config.ENABLE_MOCK},
            "data_dir": str(config.DATA_DIR),
            "disk_free_gb": round(shutil.disk_usage(config.DATA_DIR).free / 1e9, 1)}


class SettingsIn(BaseModel):
    device: str


@app.put("/api/settings")
def put_settings(s: SettingsIn):
    if s.device not in ("auto", "cpu", "cuda"):
        err(400, "Dispositivo non valido.")
    db.setting_set("device", s.device)
    return {"device": s.device}


# ---------------------------------------------------------------- modelli
@app.get("/api/models")
def models(language: str = "it"):
    if language not in registry.BY_LANGUAGE:
        err(400, "Lingua non supportata.")
    dev = db.setting_get("device", "auto")
    rec, why = registry.recommended(language, dev)
    return {"language": language, "models": [registry.describe(m, dev) | {"install": installer.status(m)} for m in registry.BY_LANGUAGE[language]],
            "recommended": rec, "recommended_reason": why}


@app.get("/api/models/all")
def models_all():
    dev = db.setting_get("device", "auto")
    return {"models": [registry.describe(m, dev) | {"install": installer.status(m)} for m in registry.MODELS],
            "total_disk_bytes": sum(registry.disk_usage(m) for m in registry.MODELS)}


@app.post("/api/models/{mid}/install")
def install(mid: str):
    if mid not in registry.MODELS:
        err(404, "Modello sconosciuto.")
    installer.start(mid)  # solo su richiesta esplicita dell'utente
    return installer.status(mid)


@app.get("/api/models/{mid}/status")
def install_status(mid: str):
    if mid not in registry.MODELS:
        err(404, "Modello sconosciuto.")
    return installer.status(mid)


@app.delete("/api/models/{mid}")
def delete_model(mid: str):
    if mid not in registry.MODELS:
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
    return {"custom": db.vocab_list(), "builtin": vocab.BUILTIN, "contexts": vocab.CONTEXTS}


@app.post("/api/vocab")
def vocab_post(v: VocabIn):
    if not v.term.strip():
        err(400, "Termine vuoto.")
    if v.context != "*" and v.context not in vocab.CONTEXTS:
        err(400, "Contesto non valido.")
    db.vocab_add(v.term, v.context)
    return {"ok": True}


@app.delete("/api/vocab/{vid}")
def vocab_delete(vid: int):
    db.vocab_del(vid)
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
        info = audio.probe(dst)
    except audio.AudioError as e:
        shutil.rmtree(d, ignore_errors=True)
        err(400, str(e))
    meta = {"upload_id": uid, "name": file.filename, "size": size, "sha": h.hexdigest(), "path": str(dst), **info}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return meta


def _upload(uid):
    p = config.UPLOADS / uid / "meta.json"
    if not p.exists():
        err(404, "Upload non trovato.")
    return json.loads(p.read_text())


# ---------------------------------------------------------------- creazione lavori
class JobIn(BaseModel):
    upload_id: str
    language: str = "it"
    model_id: str
    context: str = "Altro"
    mode: str = "fedele"
    normalize: bool = False
    denoise: bool = False
    diarize: bool = False
    title: str | None = None
    force: bool = False


def _validate(j: JobIn):
    if j.language not in registry.BY_LANGUAGE:
        err(400, "Lingua non supportata.")
    allowed = registry.BY_LANGUAGE[j.language] + (["mock", "mock2"] if config.ENABLE_MOCK else [])
    if j.model_id not in allowed:
        err(400, f"Il modello {j.model_id} non è disponibile per la lingua '{j.language}'.")
    ok, why = registry.compatibility(j.model_id, db.setting_get("device", "auto"))
    if not ok:
        err(422, "Modello non compatibile con l'hardware: " + why)
    if not registry.is_installed(j.model_id):
        err(409, "Modello non installato: installalo dalla sezione Modelli AI.")
    if j.context not in vocab.CONTEXTS:
        err(400, "Contesto non valido.")
    if j.diarize and not diarization.available()[0]:
        err(422, "Diarizzazione non disponibile: " + diarization.available()[1])


def _create(j: JobIn, group=None, dedupe=True):
    m = _upload(j.upload_id)
    opts = {"normalize": j.normalize, "denoise": j.denoise, "diarize": j.diarize, "mode": j.mode}
    key = "|".join(map(str, [m["sha"], j.model_id, j.language, j.context, j.normalize, j.denoise, j.diarize]))
    if dedupe and not j.force:
        ex = db.find_dedupe(key)
        if ex:
            if ex["upload_id"] != j.upload_id and not db.uses_upload(j.upload_id):
                shutil.rmtree(config.UPLOADS / j.upload_id, ignore_errors=True)  # niente file orfani
            return ex["id"], True
    tid = db.insert(title=j.title or Path(m["name"] or "audio").stem, upload_id=j.upload_id, filename=m["name"],
                    audio_path=m["path"], audio_sha=m["sha"], duration=m["duration"], language=j.language,
                    model_id=j.model_id, context=j.context, options=opts, status="queued",
                    group_id=group, dedupe_key=key if dedupe else None)
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
def list_t(status: str | None = None):
    return db.list_all(status)


@app.get("/api/transcripts/{tid}")
def get_t(tid: str):
    t = db.get(tid)
    if not t:
        err(404, "Non trovata.")
    t.pop("partial", None)
    return t


class PatchIn(BaseModel):
    title: str | None = None
    edits: list[dict] = []  # [{i: indice segmento, text: nuovo testo}]


@app.patch("/api/transcripts/{tid}")
def patch_t(tid: str, p: PatchIn):
    t = db.get(tid)
    if not t:
        err(404, "Non trovata.")
    fields = {}
    if p.title is not None:
        fields["title"] = p.title.strip()[:200] or t["title"]
    if p.edits:
        segs = t["segments"] or []
        for e in p.edits:
            if not isinstance(e.get("i"), int) or not 0 <= e["i"] < len(segs):
                err(400, "Indice segmento non valido.")
            segs[e["i"]]["text"] = str(e["text"])
        fields["segments"] = segs
    if fields:
        db.update(tid, **fields)
    return {"ok": True}


@app.post("/api/transcripts/{tid}/cancel")
def cancel_t(tid: str):
    if not engine.cancel(tid):
        err(404, "Non trovata.")
    return {"ok": True}


@app.post("/api/transcripts/{tid}/retry")
def retry_t(tid: str):
    t = db.get(tid)
    if not t or t["status"] not in ("failed", "cancelled"):
        err(409, "Solo i lavori falliti o annullati possono essere ripresi.")
    db.update(tid, status="queued", error=None)  # riprende dai chunk già salvati
    engine.submit(tid)
    return {"ok": True}


@app.delete("/api/transcripts/{tid}")
def delete_t(tid: str, with_audio: bool = True):
    t = db.get(tid)
    if not t:
        err(404, "Non trovata.")
    if t["status"] == "running":
        err(409, "Annulla il lavoro prima di eliminarlo.")
    db.delete(tid)
    if with_audio and not db.uses_upload(t["upload_id"]):
        shutil.rmtree(config.UPLOADS / t["upload_id"], ignore_errors=True)  # eliminazione definitiva dei file
    return {"ok": True}


@app.get("/api/transcripts/{tid}/audio")
def audio_file(tid: str):
    t = db.get(tid)
    if not t or not Path(t["audio_path"]).exists():
        err(404, "Audio non disponibile.")
    mt = mimetypes.guess_type(t["audio_path"])[0] or "application/octet-stream"
    return FileResponse(t["audio_path"], media_type=mt)  # supporta Range (necessario a Safari/iPad)


@app.get("/api/transcripts/{tid}/waveform")
def waveform(tid: str, bins: int = 1600):
    t = db.get(tid)
    if not t:
        err(404, "Non trovata.")
    from . import engine as eng
    p = eng.pcm_path(t["upload_id"], t["options"] or {})
    if not p.exists():
        return {"peaks": [], "available": False}
    return {"peaks": audio.waveform_peaks(audio.open_pcm(p), min(max(bins, 100), 4000)), "available": True}


@app.get("/api/transcripts/{tid}/suggestions")
def suggestions(tid: str):
    t = db.get(tid)
    if not t or not t["segments"]:
        err(404, "Non trovata o non completata.")
    return {"suggestions": vocab.suggestions(t["segments"], t["context"] or "Altro"),
            "note": "Proposte da confermare manualmente: nessuna parola viene sostituita automaticamente."}


class WerIn(BaseModel):
    reference: str


@app.post("/api/transcripts/{tid}/wer")
def wer_t(tid: str, w: WerIn):
    t = db.get(tid)
    if not t or not t["segments"]:
        err(404, "Non trovata o non completata.")
    try:
        r = wer(w.reference, full_text(t["segments"]))
    except ValueError as e:
        err(400, str(e))
    db.update(tid, reference_text=w.reference)
    return r | {"note": "WER valido solo se il riferimento è una trascrizione verificata manualmente."}


# ---------------------------------------------------------------- modalità / appunti / export
def _render(t, mode):
    if mode == "fedele":
        return full_text(t["segments"], "\n")
    if mode == "pulita":
        return postprocess.clean_paragraphs(t["segments"], t["language"] if t["language"] != "auto" else (t.get("detected_language") or "it"))
    if mode == "appunti":
        n = (t.get("stats") or {}).get("notes")
        if not n:
            err(404, "Appunti non ancora generati.")
        return n
    err(400, "Modalità sconosciuta.")


@app.get("/api/transcripts/{tid}/render")
def render(tid: str, mode: str = "fedele"):
    t = db.get(tid)
    if not t or not t["segments"]:
        err(404, "Non trovata o non completata.")
    return {"mode": mode, "text": _render(t, mode),
            "ai_generated": mode == "appunti",
            "note": {"fedele": "Testo del modello, con le tue correzioni.",
                     "pulita": "Rimossi solo intercalari e raddoppi di parole funzione; paragrafi dalle pause. Nessun LLM.",
                     "appunti": "Rielaborazione generata da un LLM locale: NON è testo pronunciato."}[mode]}


class NotesIn(BaseModel):
    llm: str


@app.post("/api/transcripts/{tid}/notes")
def make_notes(tid: str, n: NotesIn):
    t = db.get(tid)
    if not t or not t["segments"]:
        err(404, "Non trovata o non completata.")
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
            txt = postprocess.structured_notes(postprocess.clean_paragraphs(t["segments"], lang), lang, n.llm)
            st = db.get(tid)["stats"] or {}
            st.update(notes=txt, notes_status="done")
        except Exception as e:
            st = db.get(tid)["stats"] or {}
            st.update(notes_status="error", notes_error=str(e)[:300])
        db.update(tid, stats=st)

    threading.Thread(target=work, daemon=True).start()
    return {"started": True}


@app.get("/api/transcripts/{tid}/export/{fmt}")
def export(tid: str, fmt: str, mode: str = "fedele"):
    t = db.get(tid)
    if not t or not t["segments"]:
        err(404, "Non trovata o non completata.")
    if fmt not in exports.FORMATS:
        err(400, "Formato non supportato.")
    ctype, fn = exports.FORMATS[fmt]
    text = None if mode == "fedele" or fmt in ("srt", "vtt", "json") else _render(t, mode)
    data = fn(t, text) if fmt in ("txt", "docx", "pdf") else fn(t)
    name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in (t["title"] or "trascrizione")).strip() or "trascrizione"
    from urllib.parse import quote
    return Response(data, media_type=ctype, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}.{fmt}"})


# ---------------------------------------------------------------- frontend statico (PWA)
if config.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
