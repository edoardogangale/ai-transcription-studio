"""Download dei pesi su richiesta esplicita dell'utente, con avanzamento reale (byte su disco / byte totali)."""
import shutil
import threading
import time

from . import config, registry

_state: dict = {}
_lock = threading.Lock()


def status(mid):
    return _state.get(mid, {"state": "installed" if registry.is_installed(mid) else "absent"})


def _worker(mid):
    m = registry.MODELS[mid]
    d = registry.model_dir(mid)
    try:
        from huggingface_hub import HfApi, snapshot_download
        ignore = ["encoder-model.onnx*", "decoder_joint-model.onnx"] if m["family"] == "parakeet" else None
        info = HfApi(token=config.HF_TOKEN).model_info(m["repo"], files_metadata=True)
        import fnmatch
        total = sum((s.size or 0) for s in info.siblings
                    if not (ignore and any(fnmatch.fnmatch(s.rfilename, p) for p in ignore)))
        _state[mid].update(total=total, state="downloading")
        d.mkdir(parents=True, exist_ok=True)
        done_evt = threading.Event()

        def poll():
            while not done_evt.is_set():
                _state[mid]["downloaded"] = registry.disk_usage(mid)
                time.sleep(1)

        threading.Thread(target=poll, daemon=True).start()
        try:
            snapshot_download(m["repo"], local_dir=str(d), ignore_patterns=ignore, token=config.HF_TOKEN)
        finally:
            done_evt.set()
        (d / ".complete").write_text("ok")
        _state[mid] = {"state": "installed", "downloaded": registry.disk_usage(mid), "total": total}
    except Exception as e:  # rete, spazio, repo gated...
        _state[mid] = {"state": "error", "error": f"{type(e).__name__}: {e}"}


def start(mid):
    if mid not in registry.MODELS:
        raise KeyError(mid)
    with _lock:
        if _state.get(mid, {}).get("state") == "downloading":
            return
        if registry.is_installed(mid):
            return
        _state[mid] = {"state": "starting", "downloaded": 0, "total": None}
        threading.Thread(target=_worker, args=(mid,), daemon=True).start()


def delete(mid):
    if _state.get(mid, {}).get("state") == "downloading":
        raise RuntimeError("Download in corso: attendere il termine prima di eliminare.")
    shutil.rmtree(registry.model_dir(mid), ignore_errors=True)
    _state.pop(mid, None)
