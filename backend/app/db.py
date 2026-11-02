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
CREATE TABLE IF NOT EXISTS vocab(id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT, context TEXT, UNIQUE(term, context));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
"""

JSON_COLS = {"options", "partial", "segments", "orig_segments", "stats"}


def conn() -> sqlite3.Connection:
    c = getattr(_local, "c", None)
    if c is None or getattr(_local, "path", None) != str(config.DB_PATH):
        config.ensure_dirs()
        c = sqlite3.connect(config.DB_PATH, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
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


LIST_COLS = ("id,title,filename,duration,language,model_id,context,status,error,group_id,"
             "chunks_total,chunks_done,has_word_ts,stats,created,updated")


def list_all(status=None):
    q = f"SELECT {LIST_COLS} FROM transcripts"
    args = []
    if status:
        q += " WHERE status=?"
        args.append(status)
    q += " ORDER BY created DESC"
    return [_row(r) for r in conn().execute(q, args).fetchall()]


def delete(tid: str) -> None:
    c = conn()
    c.execute("DELETE FROM transcripts WHERE id=?", (tid,))
    c.commit()


def find_dedupe(key: str):
    return _row(conn().execute(
        "SELECT * FROM transcripts WHERE dedupe_key=? AND status IN ('queued','running','done') LIMIT 1", (key,)).fetchone())


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


def vocab_list():
    return [dict(r) for r in conn().execute("SELECT id,term,context FROM vocab ORDER BY term").fetchall()]


def vocab_add(term: str, context: str) -> None:
    c = conn()
    c.execute("INSERT OR IGNORE INTO vocab(term,context) VALUES(?,?)", (term.strip(), context))
    c.commit()


def vocab_del(vid: int) -> None:
    c = conn()
    c.execute("DELETE FROM vocab WHERE id=?", (vid,))
    c.commit()
