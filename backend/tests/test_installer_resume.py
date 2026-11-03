"""Download dei modelli riprendibile: rete che cade, richieste che si bloccano, server senza Range, riavvio, archivio rovinato."""
import io
import os
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app import installer, registry


def make_archive(n_bytes=3 * 1024 * 1024):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as t:
        for name, size in (("modello/encoder.onnx", n_bytes), ("modello/tokens.txt", 2000)):
            data = os.urandom(size)
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            t.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


class Srv:
    def __init__(self, data):
        self.data, self.hits, self.mode = data, [], {}
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                n = len(outer.hits)
                rg = self.headers.get("Range")
                outer.hits.append(rg)
                start = int(rg.split("=")[1].split("-")[0]) if rg and "range" not in outer.mode else 0
                code = 206 if start else 200
                body = outer.data[start:]
                if start >= len(outer.data):
                    self.send_response(416)
                    self.end_headers()
                    return
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                if code == 206:
                    self.send_header("Content-Range", f"bytes {start}-{len(outer.data) - 1}/{len(outer.data)}")
                self.end_headers()
                cut = outer.mode.get("drop_after", {}).get(n)          # la rete cade dopo tot byte
                try:
                    if cut is not None:
                        self.wfile.write(body[:cut])
                        self.wfile.flush()
                        self.connection.close()
                        return
                    if outer.mode.get("stall_on") == n:                  # si blocca: manda un po' e poi niente
                        self.wfile.write(body[:1000])
                        self.wfile.flush()
                        time.sleep(3)
                        return
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}/m.tar.bz2"

    def close(self):
        self.srv.shutdown()


@pytest.fixture()
def model(monkeypatch, tmp_path):
    from app import config
    monkeypatch.setattr(config, "MODELS_DIR", tmp_path / "models")
    (tmp_path / "models").mkdir()
    data = make_archive()
    srv = Srv(data)
    mid = "testmodel-resume"
    entry = {"name": "T", "sources": [{"url": srv.url, "type": "tar.bz2", "bytes": len(data)}], "download_bytes": len(data)}
    monkeypatch.setitem(registry.ALL, mid, entry)
    monkeypatch.setattr(installer, "STALL_S", 1.0)
    monkeypatch.setattr(installer, "_sleep", lambda s: None)
    installer._state.pop(mid, None)
    yield mid, srv, data
    srv.close()
    installer._state.pop(mid, None)


def run(mid, secs=20):
    installer.start(mid)
    for _ in range(int(secs * 20)):
        st = installer.status(mid)
        if st["state"] in ("installed", "error", "absent"):
            return st
        time.sleep(0.05)
    raise AssertionError("download non terminato")


def test_resumes_after_dropped_connections(model):
    mid, srv, data = model
    srv.mode = {"drop_after": {0: 400_000, 1: 300_000}}                 # cade due volte a metà
    st = run(mid)
    assert st["state"] == "installed", st
    assert (registry.model_dir(mid) / "encoder.onnx").stat().st_size == 3 * 1024 * 1024
    ranges = [h for h in srv.hits if h]
    assert len(srv.hits) == 3 and len(ranges) == 2                      # 1ª da zero, poi due riprese con Range
    assert int(ranges[0].split("=")[1][:-1]) == 400_000                 # riparte esattamente dove era arrivato


def test_stalled_request_is_interrupted_and_resumed(model):
    mid, srv, data = model
    srv.mode = {"stall_on": 0}
    t0 = time.time()
    assert run(mid)["state"] == "installed"
    assert time.time() - t0 < 10 and len(srv.hits) >= 2


def test_server_without_range_restarts_cleanly(model):
    mid, srv, data = model
    srv.mode = {"range": False, "drop_after": {0: 200_000}}              # niente Range e cade: si riparte da capo, senza file corrotti
    assert run(mid)["state"] == "installed"
    assert (registry.model_dir(mid) / "tokens.txt").stat().st_size == 2000


def test_gives_up_but_keeps_partial_then_resumes_after_restart(model, monkeypatch):
    mid, srv, data = model
    orig = installer._download
    monkeypatch.setattr(installer, "_download", lambda *a, **k: orig(*a, retries=0, **k))
    srv.mode = {"drop_after": {0: 500_000}}
    st = run(mid)
    assert st["state"] == "error" and "riprendere" in st["error"]        # messaggio chiaro
    part = registry.model_dir(mid).with_name(mid + ".part")
    assert part.exists() and (part / installer.WANTED).exists()
    assert installer.status("x-not-started")["state"] in ("absent", "installed")
    installer._state.pop(mid, None)
    assert installer.status(mid)["partial_bytes"] >= 500_000             # si vede quanto è già scaricato
    # "riavvio" del server: riprende da solo da dove era arrivato
    srv.mode = {}
    assert installer.resume_pending() >= 1
    for _ in range(300):
        if installer.status(mid)["state"] == "installed":
            break
        time.sleep(0.05)
    assert installer.status(mid)["state"] == "installed"
    assert [h for h in srv.hits if h], "la ripresa doveva usare Range"


def test_corrupt_archive_is_discarded_not_looped(model):
    mid, srv, data = model
    srv.data = b"questo non e' un archivio bz2" * 1000
    registry.ALL[mid]["sources"][0]["bytes"] = len(srv.data)
    st = run(mid)
    assert st["state"] == "error" and "rovinato" in st["error"]
    assert not registry.model_dir(mid).with_name(mid + ".part").exists()   # niente file rovinato lasciato a girare in tondo


def test_cancel_removes_partial(model):
    mid, srv, data = model
    srv.mode = {"stall_on": 0}
    installer.start(mid)
    time.sleep(0.3)
    installer.cancel(mid)
    for _ in range(100):
        if installer.status(mid)["state"] == "absent":
            break
        time.sleep(0.05)
    assert installer.status(mid)["state"] == "absent"
    assert not registry.model_dir(mid).with_name(mid + ".part").exists()
