"""Test con MODELLI VERI (nessun mock). Richiedono i modelli installati e un audio di prova.
  STUDIO_REAL=1 STUDIO_DATA=/percorso/data STUDIO_TEST_WAV=lezione_it.wav STUDIO_TEST_TRUTH=truth.json pytest tests/real_models
Il WAV si genera con tests/real_models/make_speech.py (voci TTS: professoressa + compagno che interrompe)."""
import json
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if os.environ.get("STUDIO_REAL") != "1":
    pytest.skip("STUDIO_REAL=1 richiesto", allow_module_level=True)

from app import registry
from app.textutil import wer
from conftest import client  # noqa: F401

WAV = Path(os.environ.get("STUDIO_TEST_WAV", "/tmp/ita-test/lezione_it.wav"))
TRUTH = Path(os.environ.get("STUDIO_TEST_TRUTH", "/tmp/ita-test/truth.json"))
need_audio = pytest.mark.skipif(not (WAV.exists() and TRUTH.exists()), reason="audio di prova mancante")


def wait(client, tid, timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = client.get(f"/api/transcripts/{tid}").json()
        if r["status"] in ("done", "failed", "cancelled"):
            return r
        time.sleep(0.5)
    raise AssertionError("timeout")


def up(client, path):
    with open(path, "rb") as f:
        return client.post("/api/upload", files={"file": (Path(path).name, f, "audio/wav")}).json()


def need(mid):
    return pytest.mark.skipif(not registry.is_installed(mid), reason=f"{mid} non installato")


@need_audio
@need("parakeet-tdt-0.6b-v3")
def test_real_parakeet_italian_with_speakers_teacher_only(client):
    truth = json.load(open(TRUTH))
    teacher_ref = " ".join(m["text"] for m in truth if m["who"] == "P")
    m = up(client, WAV)
    r = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "parakeet-tdt-0.6b-v3",
                                              "diarize": True, "teacher_only": True, "context": "Filosofia"})
    assert r.status_code == 200, r.text
    t = wait(client, r.json()["id"])
    assert t["status"] == "done", t.get("error")
    text = " ".join(s["text"] for s in t["segments"])
    assert "Kant" in text
    assert "quaderno" not in text and "mensa" not in text, "le frasi del compagno non devono finire nella trascrizione"
    assert t["stats"]["skipped_chunks"] >= 1 and t["stats"]["teacher"]
    assert wer(teacher_ref, text)["wer"] < 0.25
    assert all(s.get("speaker") == t["stats"]["teacher"] for s in t["segments"])
    assert t["has_word_ts"] == 1 and t["segments"][0]["words"][0]["s"] >= 0
    # velocità realmente misurata e riportata
    assert 0 < t["stats"]["realtime_factor"] < 1.5
    print("\nRTF", t["stats"]["realtime_factor"], "WER insegnante", wer(teacher_ref, text))


@need_audio
@need("parakeet-tdt-0.6b-v3")
def test_real_speakers_labelled_not_skipped_and_export_filters(client):
    m = up(client, WAV)
    r = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "parakeet-tdt-0.6b-v3",
                                              "diarize": True, "force": True, "num_speakers": 2})
    t = wait(client, r.json()["id"])
    assert t["status"] == "done", t.get("error")
    assert len(t["stats"]["speakers"]) == 2                       # con 2 voci dichiarate le trova distinte
    all_text = client.get(f"/api/transcripts/{t['id']}/export/txt", params={"teacher_only": False}).text
    only = client.get(f"/api/transcripts/{t['id']}/export/txt").text
    assert "quaderno" in all_text.lower() and "quaderno" not in only.lower()
    assert "Kant" in only and "Voce 2:" in all_text
    assert t["stats"]["skipped_chunks"] == 0


@need_audio
@need("parakeet-tdt-0.6b-v3")
def test_real_live_streaming(client):
    import wave
    import numpy as np
    w = wave.open(str(WAV))
    pcm = np.frombuffer(w.readframes(w.getnframes()), np.int16)
    rr = client.post("/api/live", json={"language": "it", "model_id": "parakeet-tdt-0.6b-v3", "context": "Filosofia", "title": "Live vero"})
    assert rr.status_code == 200, rr.text
    tid, got = rr.json()["id"], []
    with client.websocket_connect(f"/api/live/{tid}/ws") as ws:
        ws.receive_json()
        for off in range(0, len(pcm), 1600):
            ws.send_bytes(pcm[off:off + 1600].tobytes())
        ws.send_text('{"type":"stop"}')
        while True:
            m = ws.receive_json()
            got.append(m)
            if m["type"] == "done":
                break
    segs = [m["seg"] for m in got if m["type"] == "segment"]
    t = wait(client, tid)
    text = " ".join(s["text"] for s in t["segments"])
    assert len(segs) >= 4 and "Kant" in text and "derivata" in text
    assert t["status"] == "done" and abs(t["duration"] - len(pcm) / 16000) < 1.0
    truth = json.load(open(TRUTH))
    ref = " ".join(m["text"] for m in truth)
    print("\nWER live (tutte le voci):", wer(ref, text))
    assert wer(ref, text)["wer"] < 0.35


@need_audio
def test_real_all_installed_models_transcribe_english(client):
    en = Path(os.environ.get("STUDIO_TEST_EN", "")) if os.environ.get("STUDIO_TEST_EN") else None
    if not en or not en.exists():
        pytest.skip("STUDIO_TEST_EN mancante")
    m = up(client, en)
    done = []
    for mid in registry.BY_LANGUAGE["en"] + registry.FAST:
        if not registry.is_installed(mid) or (mid == "whisper-large-v3" and not os.environ.get("STUDIO_REAL_SLOW")):
            continue
        r = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "en", "model_id": mid, "force": True})
        assert r.status_code == 200, (mid, r.text)
        t = wait(client, r.json()["id"])
        assert t["status"] == "done", (mid, t.get("error"))
        assert "country" in " ".join(s["text"] for s in t["segments"]).lower(), mid
        done.append(mid)
    assert len(done) >= 3
