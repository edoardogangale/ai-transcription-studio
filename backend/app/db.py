"""SQLite minimale: una tabella per le trascrizioni/lavori, vocabolario, impostazioni."""
import json
import sqlite3
import threading
import time
import uuid

from . import config

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS transcripts(
  id TEXT PRIMARY KEY, title TEXT, upload_id TEXT, filename TEXT, audio_path TEXT,
  audio_sha TEXT, duration REAL, language TEXT, detected_language TEXT, model_id TEXT, context TEXT,
  options TEXT, status TEXT, error TEXT, group_id TEXT, dedupe_key TEXT,
  chunks_total INTEGER DEFAULT 0, chunks_done INTEGER DEFAULT 0, partial TEXT,
  segments TEXT, orig_segments TEXT, has_word_ts INTEGER DEFAULT 0, stats TEXT,
  reference_text TEXT, created REAL, updated REAL);
CREATE INDEX IF NOT EXISTS ix_t_status ON transcripts(status);
CREATE INDEX IF NOT EXISTS ix_t_group ON transcripts(group_id);
CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, prefs TEXT, created REAL);
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, tid TEXT NOT NULL, kind TEXT NOT NULL, t0 REAL NOT NULL, t1 REAL, text TEXT, created REAL);
CREATE INDEX IF NOT EXISTS ix_notes_tid ON notes(tid);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(tid UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS vocab2(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, term TEXT, context TEXT, UNIQUE(owner, term, context));
CREATE TABLE IF NOT EXISTS corrections(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, scope TEXT, wrong TEXT, right TEXT, n INTEGER DEFAULT 1, UNIQUE(owner, scope, wrong, right));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, owner TEXT, title TEXT, folder_id TEXT, tid TEXT, text TEXT, created REAL, updated REAL, data TEXT);
CREATE INDEX IF NOT EXISTS ix_pages_owner ON pages(owner, updated);
"""

JSON_COLS = {"options", "partial", "segments", "orig_segments", "stats", "prefs", "notebook"}
MIGRATIONS = [("transcripts", "folder_id", "TEXT"), ("transcripts", "kind", "TEXT DEFAULT 'file'"),
              ("transcripts", "owner", "TEXT"), ("folders", "owner", "TEXT"), ("transcripts", "notebook", "TEXT")]


def conn() -> sqlite3.Connection:
    c = getattr(_local, "c", None)
    if c is None or getattr(_local, "path", None) != str(config.DB_PATH):
        config.ensure_dirs()
        c = sqlite3.connect(config.DB_PATH, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        for table, col, typ in MIGRATIONS:  # migrazione non distruttiva di database creati da versioni precedenti
            if col not in [r[1] for r in c.execute(f"PRAGMA table_info({table})")]:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
        c.execute("UPDATE transcripts SET owner='admin' WHERE owner IS NULL")   # dati di versioni precedenti: all'amministratore
        c.execute("UPDATE folders SET owner='admin' WHERE owner IS NULL")
        if c.execute("SELECT name FROM sqlite_master WHERE name='vocab'").fetchone():   # vocabolario di versioni precedenti
            c.execute("INSERT OR IGNORE INTO vocab2(owner,term,context) SELECT 'admin',term,context FROM vocab")
            c.execute("DROP TABLE vocab")
        c.commit()
        _local.c, _local.path = c, str(config.DB_PATH)
    return c


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def _row(r, with_big=True):
    if r is None:
        return None
    d = dict(r)
    for k in JSON_COLS:
        if k in d and isinstance(d[k], str):
            d[k] = json.loads(d[k])
    return d


def insert(**f) -> str:
    f.setdefault("id", new_id())
    f.setdefault("created", time.time())
    f["updated"] = time.time()
    for k in JSON_COLS & f.keys():
        f[k] = json.dumps(f[k], ensure_ascii=False)
    cols = ",".join(f)
    c = conn()
    c.execute(f"INSERT INTO transcripts({cols}) VALUES({','.join('?' * len(f))})", list(f.values()))
    c.commit()
    return f["id"]


def update(tid: str, **f) -> None:
    f["updated"] = time.time()
    for k in JSON_COLS & f.keys():
        f[k] = json.dumps(f[k], ensure_ascii=False)
    c = conn()
    c.execute(f"UPDATE transcripts SET {','.join(k + '=?' for k in f)} WHERE id=?", [*f.values(), tid])
    c.commit()


def get(tid: str):
    return _row(conn().execute("SELECT * FROM transcripts WHERE id=?", (tid,)).fetchone())


LIST_COLS = ("id,title,filename,duration,language,model_id,context,status,error,group_id,folder_id,kind,"
             "chunks_total,chunks_done,has_word_ts,stats,created,updated")


def list_all(status=None, owner=None):
    q = f"SELECT {LIST_COLS} FROM transcripts"
    where, args = [], []
    if status:
        where.append("status=?")
        args.append(status)
    if owner:
        where.append("owner=?")
        args.append(owner)
    if where:
        q += " WHERE " + " AND ".join(where)
    q += " ORDER BY created DESC"
    return [_row(r) for r in conn().execute(q, args).fetchall()]


def delete(tid: str) -> None:
    c = conn()
    c.execute("DELETE FROM transcripts WHERE id=?", (tid,))
    c.execute("DELETE FROM notes WHERE tid=?", (tid,))
    c.execute("DELETE FROM fts WHERE tid=?", (tid,))
    c.commit()


# ---- ricerca full-text (FTS5, insensibile ad accenti/maiuscole) ----
def index_text(tid: str, title: str, body: str) -> None:
    c = conn()
    r = c.execute("SELECT notebook FROM transcripts WHERE id=?", (tid,)).fetchone()   # anche il testo del quaderno si cerca
    if r and r[0]:
        try:
            from . import notebook as _nb
            body = (body or "") + "\n" + _nb.to_text(json.loads(r[0]).get("html", ""))
        except Exception:
            pass
    c.execute("DELETE FROM fts WHERE tid=?", (tid,))
    c.execute("INSERT INTO fts(tid,title,body) VALUES(?,?,?)", (tid, title or "", body or ""))
    c.commit()


def search(q: str, limit: int = 50, owner=None):
    terms = [t for t in "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in q).split() if t]
    if not terms:
        return []
    match = " ".join(f'"{t}"*' for t in terms)
    own = " AND tid IN (SELECT id FROM transcripts WHERE owner=?)" if owner else ""
    rows = conn().execute(f"SELECT tid, snippet(fts,2,'<mark>','</mark>','…',14) AS snip FROM fts WHERE fts MATCH ?{own} ORDER BY rank LIMIT ?",
                          ((match, owner, limit) if owner else (match, limit))).fetchall()
    return [{"id": r["tid"], "snippet": r["snip"]} for r in rows]


# ---- cartelle (materie > argomenti) ----
def folder_list(owner=None):
    rows = [_row(r) for r in conn().execute("SELECT * FROM folders" + (" WHERE owner=?" if owner else "") + " ORDER BY name COLLATE NOCASE", ((owner,) if owner else ())).fetchall()]
    counts = {r[0]: r[1] for r in conn().execute("SELECT folder_id, COUNT(*) FROM transcripts WHERE folder_id IS NOT NULL GROUP BY folder_id")}
    for r in rows:
        r["count"] = counts.get(r["id"], 0)
    return rows


def folder_get(fid):
    return _row(conn().execute("SELECT * FROM folders WHERE id=?", (fid,)).fetchone())


def folder_add(name, parent_id=None, prefs=None, owner="admin"):
    fid = new_id()
    c = conn()
    c.execute("INSERT INTO folders(id,name,parent_id,prefs,created,owner) VALUES(?,?,?,?,?,?)",
              (fid, name.strip()[:80], parent_id, json.dumps(prefs or {}), time.time(), owner))
    c.commit()
    return fid


def folder_update(fid, **f):
    if "prefs" in f:
        f["prefs"] = json.dumps(f["prefs"])
    c = conn()
    c.execute(f"UPDATE folders SET {','.join(k + '=?' for k in f)} WHERE id=?", [*f.values(), fid])
    c.commit()


def folder_delete(fid):
    """Le sotto-cartelle salgono di un livello e le trascrizioni restano (passano alla cartella superiore)."""
    f = folder_get(fid)
    c = conn()
    c.execute("UPDATE folders SET parent_id=? WHERE parent_id=?", (f["parent_id"], fid))
    c.execute("UPDATE transcripts SET folder_id=? WHERE folder_id=?", (f["parent_id"], fid))
    c.execute("UPDATE pages SET folder_id=? WHERE folder_id=?", (f["parent_id"], fid))
    c.execute("DELETE FROM folders WHERE id=?", (fid,))
    c.commit()


def folder_descendants(fid):
    out, todo = {fid}, [fid]
    while todo:
        cur = todo.pop()
        for r in conn().execute("SELECT id FROM folders WHERE parent_id=?", (cur,)):
            if r[0] not in out:
                out.add(r[0])
                todo.append(r[0])
    return out


def move_to_folder(ids, folder_id):
    c = conn()
    c.executemany("UPDATE transcripts SET folder_id=? WHERE id=?", [(folder_id, i) for i in ids])
    c.commit()


# ---- note ed evidenziazioni ----
def note_list(tid):
    return [dict(r) for r in conn().execute("SELECT id,kind,t0,t1,text,created FROM notes WHERE tid=? ORDER BY t0", (tid,))]


def note_add(tid, kind, t0, t1=None, text=""):
    nid = new_id()
    c = conn()
    c.execute("INSERT INTO notes(id,tid,kind,t0,t1,text,created) VALUES(?,?,?,?,?,?,?)", (nid, tid, kind, t0, t1, text, time.time()))
    c.commit()
    return nid


def note_update(nid, **f):
    c = conn()
    c.execute(f"UPDATE notes SET {','.join(k + '=?' for k in f)} WHERE id=?", [*f.values(), nid])
    c.commit()


def note_delete(nid):
    c = conn()
    c.execute("DELETE FROM notes WHERE id=?", (nid,))
    c.commit()


def measured_rtf():
    """Fattore di tempo reale mediano (secondi di calcolo per secondo di audio) per modello, dai lavori già completati."""
    import statistics
    by = {}
    for r in conn().execute("SELECT model_id, stats FROM transcripts WHERE status='done' AND kind!='live'"):
        st = json.loads(r["stats"] or "{}")
        if st.get("realtime_factor") and st.get("device") == "cpu" and not st.get("diarized"):
            by.setdefault(r["model_id"], []).append(st["realtime_factor"])
    return {k: round(statistics.median(v), 3) for k, v in by.items()}


def find_dedupe(key: str, owner=None):
    return _row(conn().execute(
        "SELECT * FROM transcripts WHERE dedupe_key=? AND owner=? AND status IN ('queued','running','done') LIMIT 1", (key, owner)).fetchone())


def uses_upload(upload_id: str) -> int:
    return conn().execute("SELECT COUNT(*) FROM transcripts WHERE upload_id=?", (upload_id,)).fetchone()[0]


def setting_get(key, default=None):
    r = conn().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(r[0]) if r else default


def setting_set(key, value) -> None:
    c = conn()
    c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              (key, json.dumps(value)))
    c.commit()


def vocab_list(owner="admin"):
    return [dict(r) for r in conn().execute("SELECT id,term,context FROM vocab2 WHERE owner=? ORDER BY term", (owner,)).fetchall()]


def vocab_add(term: str, context: str, owner="admin") -> None:
    c = conn()
    c.execute("INSERT OR IGNORE INTO vocab2(owner,term,context) VALUES(?,?,?)", (owner, term.strip(), context))
    c.commit()


def vocab_del(vid: int, owner="admin") -> None:
    c = conn()
    c.execute("DELETE FROM vocab2 WHERE id=? AND owner=?", (vid, owner))
    c.commit()


# ---- memoria delle correzioni approvate dall'utente (per materia/contesto) ----
def corr_add(owner, scope, wrong, right):
    c = conn()
    c.execute("INSERT INTO corrections(owner,scope,wrong,right,n) VALUES(?,?,?,?,1) ON CONFLICT(owner,scope,wrong,right) DO UPDATE SET n=n+1",
              (owner, scope, wrong, right))
    c.commit()


def corr_list(owner, scope=None):
    q, a = "SELECT id,scope,wrong,right,n FROM corrections WHERE owner=?", [owner]
    if scope:
        q += " AND scope=?"
        a.append(scope)
    return [dict(r) for r in conn().execute(q + " ORDER BY n DESC, id DESC", a).fetchall()]


def corr_del(owner, cid):
    c = conn()
    c.execute("DELETE FROM corrections WHERE id=? AND owner=?", (cid, owner))
    c.commit()


def note_tid(nid):
    r = conn().execute("SELECT tid FROM notes WHERE id=?", (nid,)).fetchone()
    return r[0] if r else None


def purge_owner(owner):
    """Elimina DEFINITIVAMENTE i dati di un profilo. Ritorna gli upload_id da cancellare dal disco."""
    c = conn()
    ids = [r[0] for r in c.execute("SELECT id FROM transcripts WHERE owner=?", (owner,))]
    ups = [r[0] for r in c.execute("SELECT DISTINCT upload_id FROM transcripts WHERE owner=?", (owner,)) if r[0]]
    for tid in ids:
        c.execute("DELETE FROM notes WHERE tid=?", (tid,))
        c.execute("DELETE FROM fts WHERE tid=?", (tid,))
    c.execute("DELETE FROM transcripts WHERE owner=?", (owner,))
    c.execute("DELETE FROM folders WHERE owner=?", (owner,))
    c.execute("DELETE FROM pages WHERE owner=?", (owner,))
    c.execute("DELETE FROM vocab2 WHERE owner=?", (owner,))
    c.execute("DELETE FROM corrections WHERE owner=?", (owner,))
    c.commit()
    return ups


# ---------------------------------------------------------------- appunti (pagine a mano libera, per cartella)
def page_text(data):
    return " ".join((x.get("text") or "") for x in (data.get("texts") or []))[:20000]


def page_add(owner, title, folder_id, data, tid=None):
    pid = new_id()
    now = time.time()
    c = conn()
    c.execute("INSERT INTO pages(id,owner,title,folder_id,tid,text,created,updated,data) VALUES(?,?,?,?,?,?,?,?,?)",
              (pid, owner, (title or "Nota").strip()[:120], folder_id, tid, page_text(data), now, now, json.dumps(data)))
    c.commit()
    return pid


def page_row(r, with_data=False):
    if not r:
        return None
    d = {k: r[k] for k in ("id", "owner", "title", "folder_id", "tid", "created", "updated")}
    if with_data:
        d["data"] = json.loads(r["data"] or "{}")
    return d


def page_get(pid, owner=None):
    r = conn().execute("SELECT * FROM pages WHERE id=?" + (" AND owner=?" if owner else ""), (pid, owner) if owner else (pid,)).fetchone()
    return page_row(r, True)


def page_list(owner, q=None):
    rows = conn().execute("SELECT * FROM pages WHERE owner=? ORDER BY updated DESC", (owner,)).fetchall()
    out = []
    ql = (q or "").strip().lower()
    for r in rows:
        if ql and ql not in (r["title"] or "").lower() and ql not in (r["text"] or "").lower():
            continue
        out.append(r)
    return out


def page_update(pid, **f):
    if "data" in f:
        f["text"] = page_text(f["data"])
        f["data"] = json.dumps(f["data"])
    f["updated"] = time.time()
    c = conn()
    c.execute(f"UPDATE pages SET {','.join(k + '=?' for k in f)} WHERE id=?", [*f.values(), pid])
    c.commit()


def page_delete(pid):
    c = conn()
    c.execute("DELETE FROM pages WHERE id=?", (pid,))
    c.commit()
