"""Download dei pesi SOLO su richiesta esplicita, con avanzamento reale (byte scaricati / Content-Length),
estrazione e marcatura di completamento. Sorgenti: release GitHub di sherpa-onnx.
RIPRENDIBILE: se la rete cade o il Codespace si spegne il file resta a metà e riparte da dove era arrivato (Range), anche dopo il riavvio."""
import http.client
import shutil
import tarfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import registry

_state: dict = {}
_lock = threading.Lock()
_cancel: dict = {}


def status(mid):
    if mid in _state:
        return _state[mid]
    if registry.is_installed(mid):
        return {"state": "installed"}
    part = registry.model_dir(mid)
    part = part.with_name(part.name + ".part")
    have = sum(p.stat().st_size for p in part.rglob("*") if p.is_file()) if part.exists() else 0
    return {"state": "absent", "partial_bytes": have} if have else {"state": "absent"}


RETRIES = 40            # nuovi tentativi per ogni file (rete che cade, Codespace riavviato...)
STALL_S = 45            # se per tanti secondi non arriva nulla, la richiesta viene interrotta e ripresa
WANTED = ".wanted"      # segna che l'utente ha chiesto il modello: alla riaccensione il download riparte da solo


def _fetch_into(url, dst: Path, mid, base_done, total, stall=STALL_S):
    """Un tentativo: scarica da dove il file è arrivato (Range). Ritorna quando il file è completo."""
    have = dst.stat().st_size if dst.exists() else 0
    headers = {"User-Agent": "ai-transcription-studio"}
    if have:
        headers["Range"] = f"bytes={have}-"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=stall) as r:
        code = getattr(r, "status", 200)
        if have and code != 206:          # il server ignora Range: si riparte da capo
            base_done[0] -= have
            have = 0
        want = r.length                    # byte attesi in QUESTA risposta (None se sconosciuto)
        got = 0
        with open(dst, "ab" if have else "wb") as f:
            while True:
                if _cancel.get(mid):
                    raise InterruptedError("Download annullato.")
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
                got += len(b)
                base_done[0] += len(b)
                _state[mid].update(downloaded=base_done[0], total=total, state="downloading")
        if want is not None and got != want:
            raise OSError(f"download interrotto ({got} di {want} byte)")


_sleep = time.sleep      # sostituibile nei test


def _download(url, dst: Path, mid, base_done, total, retries=RETRIES, stall=STALL_S):
    """File completo, con ripresa: se la rete cade o si blocca riprova da dove era arrivato (non da zero)."""
    last = None
    for k in range(retries + 1):
        try:
            _fetch_into(url, dst, mid, base_done, total, stall)
            return
        except InterruptedError:
            raise
        except urllib.error.HTTPError as e:
            if e.code == 416:             # intervallo oltre la fine: il file era già completo
                return
            if 400 <= e.code < 500 and e.code not in (408, 429):
                raise
            last = e
        except (urllib.error.URLError, OSError, http.client.HTTPException, TimeoutError) as e:
            last = e
        _state[mid].update(state="downloading", note=f"Connessione interrotta ({type(last).__name__}): riprendo da dove ero arrivato… ({k + 1}/{retries})")
        for _ in range(min(30, 2 * (k + 1))):
            if _cancel.get(mid):
                raise InterruptedError("Download annullato.")
            _sleep(1)
    raise last


class _BadArchive(Exception):
    pass



def _worker(mid):
    m = registry.ALL[mid]
    d = registry.model_dir(mid)
    tmp = d.with_name(d.name + ".part")
    try:
        tmp.mkdir(parents=True, exist_ok=True)    # NON si cancella: se esiste un download a metà, riprende
        (tmp / WANTED).write_text("1")
        total = sum(s["bytes"] for s in m["sources"])
        _state[mid].update(state="downloading", total=total)
        done = [0]
        for s in m["sources"]:
            name = s.get("name") or Path(s["url"]).name
            fn = tmp / name
            marker = tmp / (name + ".done")
            if marker.exists():                    # sorgente già scaricata ed estratta in un tentativo precedente
                done[0] += s["bytes"]
                continue
            if fn.exists():
                done[0] += fn.stat().st_size
            _state[mid].update(downloaded=done[0], total=total)
            _download(s["url"], fn, mid, done, total)
            if s["type"] == "tar.bz2":
                _state[mid]["state"] = "extracting"
                try:
                    with tarfile.open(fn, "r:bz2") as t:
                        top = {n.split("/")[0] for n in t.getnames()}
                        t.extractall(tmp, filter="data")  # filtro 'data': blocca path traversal / link pericolosi
                except (tarfile.TarError, EOFError, OSError) as e:    # archivio rovinato: si butta tutto e si riparte da zero
                    raise _BadArchive(f"{type(e).__name__}: {e}")
                fn.unlink()
                if len(top) == 1 and (tmp / next(iter(top))).is_dir():  # appiattisce la cartella radice
                    sub = tmp / next(iter(top))
                    for p in sub.iterdir():
                        p.rename(tmp / p.name)
                    sub.rmdir()
                _state[mid]["state"] = "downloading"
            marker.write_text("ok")
        (tmp / ".complete").write_text("ok")
        for p in tmp.glob("*.done"):
            p.unlink()
        (tmp / WANTED).unlink(missing_ok=True)
        shutil.rmtree(d, ignore_errors=True)
        tmp.rename(d)
        _state[mid] = {"state": "installed", "downloaded": total, "total": total}
    except InterruptedError:
        shutil.rmtree(tmp, ignore_errors=True)
        _state[mid] = {"state": "absent"}
    except _BadArchive as e:          # archivio rovinato: si butta e si riparte da zero al prossimo tentativo
        shutil.rmtree(tmp, ignore_errors=True)
        _state[mid] = {"state": "error", "error": f"File rovinato ({e}): premi Installa, scaricherà di nuovo."}
    except Exception as e:  # rete ancora giù dopo tutti i tentativi, spazio, ...: i byte già scaricati restano per la ripresa
        _state[mid] = {"state": "error", "error": f"{type(e).__name__}: {e}. Premi Installa per riprendere da dove era arrivato."}
    finally:
        _cancel.pop(mid, None)


def resume_pending():
    """All'avvio: i download rimasti a metà (Codespace spento, riavvio) ripartono da soli, da dove erano arrivati."""
    n = 0
    for mid in registry.ALL:
        tmp = registry.model_dir(mid)
        tmp = tmp.with_name(tmp.name + ".part")
        if (tmp / WANTED).exists() and not registry.is_installed(mid):
            start(mid)
            n += 1
    return n


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
