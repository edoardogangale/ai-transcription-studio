"""Eliminare deve funzionare SEMPRE, in qualunque stato (prima: registrazione live aperta o lavoro in corso => 409 / 'eliminate 0')."""
import time
from pathlib import Path

import numpy as np
import pytest

from app import config, db, live
from conftest import make_audio
from test_api import upload, wait
from test_features import _pcm_bursts


def gone(client, tid):
    return client.get(f"/api/transcripts/{tid}").status_code == 404 and db.get(tid) is None


def test_delete_done_removes_files_and_index(client, wav):
    m = upload(client, wav)
    tid = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "force": True}).json()["id"]
    wait(client, tid)
    assert Path(m["path"]).exists()
    assert client.delete(f"/api/transcripts/{tid}").status_code == 200
    assert gone(client, tid) and not Path(m["path"]).exists()
    assert tid not in [r["id"] for r in client.get("/api/search", params={"q": "parola1"}).json()["results"]]


def test_delete_active_live_recording(client):
    r = client.post("/api/live", json={"language": "it", "model_id": "mock", "title": "Prova live"})
    tid = r.json()["id"]
    assert tid in live.sessions
    upload_dir = config.UPLOADS / db.get(tid)["upload_id"]
    live.sessions[tid].feed(_pcm_bursts([3, 3]).tobytes())          # la registrazione è davvero in corso e ha già dell'audio
    assert upload_dir.exists()
    assert client.delete(f"/api/transcripts/{tid}").status_code == 200       # prima: 409
    assert gone(client, tid) and tid not in live.sessions and not upload_dir.exists()
    with pytest.raises(Exception):                                            # il WebSocket non esiste più
        with client.websocket_connect(f"/api/live/{tid}/ws"):
            pass


def test_delete_stuck_recording_without_session(client):
    """Registrazione rimasta 'in registrazione' dopo un riavvio/chiusura della pagina: non c'è più la sessione, deve essere eliminabile."""
    tid = db.insert(title="Orfana", upload_id="orfano", filename=None, audio_path="", duration=0, language="it", model_id="mock", context="Altro",
                    options={"live": True}, status="recording", kind="live", owner="admin", segments=[])
    assert client.delete(f"/api/transcripts/{tid}").status_code == 200 and gone(client, tid)


def test_delete_running_job(client, tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_MOCK_DELAY", "0.8")
    p = tmp_path / "lunga.wav"
    make_audio(p, [5] * 16)
    m = upload(client, p)
    tid = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "force": True}).json()["id"]
    t0 = time.time()
    while client.get(f"/api/transcripts/{tid}").json()["status"] != "running" and time.time() - t0 < 20:
        time.sleep(0.1)
    assert client.get(f"/api/transcripts/{tid}").json()["status"] == "running"
    assert client.delete(f"/api/transcripts/{tid}").status_code == 200        # prima: 409 "Annulla/ferma il lavoro prima di eliminarlo"
    assert gone(client, tid)
    time.sleep(1.5)                                                           # il lavoro, fermandosi, NON deve resuscitare la riga né l'indice
    assert gone(client, tid) and tid not in [r["id"] for r in client.get("/api/search", params={"q": "parola1"}).json()["results"]]
    monkeypatch.setenv("STUDIO_MOCK_DELAY", "0")


def test_delete_queued_job_and_many_in_mixed_states(client, tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_MOCK_DELAY", "0.5")
    ids = []
    for i in range(4):
        p = tmp_path / f"m{i}.wav"
        make_audio(p, [4] * 10)
        m = upload(client, p)
        ids.append(client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "force": True}).json()["id"])
    live_id = client.post("/api/live", json={"language": "it", "model_id": "mock"}).json()["id"]
    stuck = db.insert(title="Orfana2", upload_id="o2", filename=None, audio_path="", duration=0, language="it", model_id="mock", context="Altro",
                      options={}, status="recording", kind="live", owner="admin", segments=[])
    all_ids = ids + [live_id, stuck]
    r = client.post("/api/transcripts/delete", json={"ids": all_ids}).json()
    assert r["deleted"] == len(all_ids)                                         # prima: 0 per i lavori in corso e le registrazioni aperte
    assert all(gone(client, i) for i in all_ids) and not live.sessions.get(live_id)
    monkeypatch.setenv("STUDIO_MOCK_DELAY", "0")
    time.sleep(1.0)
    assert all(gone(client, i) for i in all_ids)


def test_recover_orphan_recording(client):
    r = client.post("/api/live", json={"language": "it", "model_id": "mock"})
    tid = r.json()["id"]
    s = live.sessions[tid]
    s.feed(_pcm_bursts([3, 3]).tobytes())
    time.sleep(0.5)
    s.stopped = True; s.jobs.put(None); s.f.close(); live.sessions.pop(tid)      # simula la pagina chiusa / il riavvio
    assert client.get(f"/api/transcripts/{tid}").json()["status"] == "recording"
    assert client.post(f"/api/live/{tid}/recover").json()["status"] == "done"
    assert client.post(f"/api/live/{tid}/recover").status_code == 409              # non più in attesa di recupero
    t = client.get(f"/api/transcripts/{tid}").json()
    assert t["duration"] > 5 and t["stats"]["recovered"] is True
    assert client.delete(f"/api/transcripts/{tid}").status_code == 200
