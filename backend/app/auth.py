"""Accesso e profili. Tre situazioni:
 - nessun STUDIO_TOKEN: uso locale su un solo computer, nessun accesso richiesto, un solo profilo ('admin');
 - STUDIO_TOKEN impostato: quel codice è l'amministratore; l'amministratore crea profili per altre persone (data/users.json),
   ognuno con un proprio codice e un archivio PRIVATO (nessuno vede le registrazioni degli altri, nemmeno l'amministratore);
 - i modelli e la potenza di calcolo sono condivisi (si scaricano una volta sola per tutti).
I codici dei profili sono salvati solo come hash."""
import contextvars
import hashlib
import hmac
import json
import secrets
import threading

from . import config

ADMIN_ID = "admin"
_lock = threading.Lock()
current: contextvars.ContextVar = contextvars.ContextVar("current_user", default=None)


def protected() -> bool:
    return bool(config.ACCESS_TOKEN)


def _file():
    return config.DATA_DIR / "users.json"


def _load() -> list:
    try:
        return json.loads(_file().read_text()).get("users", [])
    except (OSError, ValueError):
        return []


def _save(users):
    config.ensure_dirs()
    _file().write_text(json.dumps({"users": users}, ensure_ascii=False, indent=1))


def _h(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def resolve(token):
    """token -> {'id','name','admin'} oppure None."""
    if not protected():
        return {"id": ADMIN_ID, "name": "Locale", "admin": True}
    if not token:
        return None
    if hmac.compare_digest(token, config.ACCESS_TOKEN):
        return {"id": ADMIN_ID, "name": "Amministratore", "admin": True}
    hh = _h(token)
    for u in _load():
        if hmac.compare_digest(hh, u["hash"]):
            return {"id": u["id"], "name": u["name"], "admin": False}
    return None


def valid(token) -> bool:
    return resolve(token) is not None


def list_users():
    return [{"id": u["id"], "name": u["name"], "created": u.get("created")} for u in _load()]


def create_user(name: str):
    code = secrets.token_urlsafe(9)
    with _lock:
        users = _load()
        uid = "u" + secrets.token_hex(4)
        users.append({"id": uid, "name": name.strip()[:40], "hash": _h(code), "created": __import__("time").time()})
        _save(users)
    return {"id": uid, "name": name.strip()[:40], "code": code}


def reset_code(uid: str):
    code = secrets.token_urlsafe(9)
    with _lock:
        users = _load()
        for u in users:
            if u["id"] == uid:
                u["hash"] = _h(code)
                _save(users)
                return code
    return None


def delete_user(uid: str) -> bool:
    with _lock:
        users = _load()
        keep = [u for u in users if u["id"] != uid]
        _save(keep)
        return len(keep) != len(users)
