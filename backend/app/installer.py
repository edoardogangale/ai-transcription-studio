"""Download dei pesi SOLO su richiesta esplicita, con avanzamento reale (byte scaricati / Content-Length),
estrazione e marcatura di completamento. Sorgenti: release GitHub di sherpa-onnx."""
import shutil
import tarfile
import threading
import urllib.request
from pathlib import Path

from . import registry

_state: dict = {}
_lock = threading.Lock()
_cancel: dict = {}


def status(mid):
    return _state.get(mid, {"state": "installed" if registry.is_installed(mid) else "absent"})


def _download(url, dst: Path, mid, base_done, total):
    req = urllib.request.Request(url, headers={"User-Agent": "ai-transcription-studio"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dst, "wb") as f:
        while True:
            if _cancel.get(mid):
                raise InterruptedError("Download annullato.")
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
            base_done[0] += len(b)
            _state[mid].update(downloaded=base_done[0], total=total)


def _worker(mid):
    m = registry.ALL[mid]
    d = registry.model_dir(mid)
    tmp = d.with_name(d.name + ".part")
    try:
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        total = sum(s["bytes"] for s in m["sources"])
        _state[mid].update(state="downloading", total=total)
        done = [0]
        for s in m["sources"]:
            fn = tmp / (s.get("name") or Path(s["url"]).name)
            _download(s["url"], fn, mid, done, total)
            if s["type"] == "tar.bz2":
                _state[mid]["state"] = "extracting"
                with tarfile.open(fn, "r:bz2") as t:
                    top = {n.split("/")[0] for n in t.getnames()}
                    t.extractall(tmp, filter="data")  # filtro 'data': blocca path traversal / link pericolosi
                fn.unlink()
                if len(top) == 1 and (tmp / next(iter(top))).is_dir():  # appiattisce la cartella radice
                    sub = tmp / next(iter(top))
                    for p in sub.iterdir():
                        p.rename(tmp / p.name)
                    sub.rmdir()
                _state[mid]["state"] = "downloading"
        (tmp / ".complete").write_text("ok")
        shutil.rmtree(d, ignore_errors=True)
        tmp.rename(d)
        _state[mid] = {"state": "installed", "downloaded": total, "total": total}
    except InterruptedError:
        shutil.rmtree(tmp, ignore_errors=True)
        _state[mid] = {"state": "absent"}
    except Exception as e:  # rete, spazio, file corrotto...
        shutil.rmtree(tmp, ignore_errors=True)
        _state[mid] = {"state": "error", "error": f"{type(e).__name__}: {e}"}
    finally:
        _cancel.pop(mid, None)


def start(mid):
    if mid not in registry.ALL:
        raise KeyError(mid)
    with _lock:
        if _state.get(mid, {}).get("state") in ("downloading", "starting", "extracting") or registry.is_installed(mid):
            return
        _state[mid] = {"state": "starting", "downloaded": 0, "total": registry.ALL[mid]["download_bytes"]}
        threading.Thread(target=_worker, args=(mid,), daemon=True, name=f"dl-{mid}").start()


def cancel(mid):
    if _state.get(mid, {}).get("state") in ("downloading", "starting", "extracting"):
        _cancel[mid] = True


def delete(mid):
    if _state.get(mid, {}).get("state") in ("downloading", "starting", "extracting"):
        raise RuntimeError("Download in corso: annullalo prima di eliminare.")
    shutil.rmtree(registry.model_dir(mid), ignore_errors=True)
    _state.pop(mid, None)
