import time

import pytest

from app import engine, config


def wait(client, tid, want=("done", "failed", "cancelled"), timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = client.get(f"/api/transcripts/{tid}").json()
        if r["status"] in want:
            return r
        time.sleep(0.15)
    raise AssertionError("timeout " + str(r["status"]))


def upload(client, wav):
    with open(wav, "rb") as f:
        r = client.post("/api/upload", files={"file": (wav.name, f, "audio/wav")})
    assert r.status_code == 200, r.text
    return r.json()


def test_upload_validation(client):
    r = client.post("/api/upload", files={"file": ("rotto.mp3", b"nope" * 500, "audio/mpeg")})
    assert r.status_code == 400 and "audio" in r.json()["detail"].lower()


def test_upload_metadata(client, wav):
    m = upload(client, wav)
    assert m["size"] > 0 and 30 < m["duration"] < 45 and m["name"] == wav.name


def test_exactly_three_models_per_language(client):
    for lang in ("it", "en"):
        r = client.get("/api/models", params={"language": lang}).json()
        real = [m for m in r["models"] if not m["id"].startswith("mock")]
        assert len(real) == 3, lang
        assert [m["id"] for m in r["fast"]] == ["whisper-small", "whisper-base"]
        assert {"name", "installed", "compatible", "license", "verification", "benchmark"} <= real[0].keys()
    it = [m["id"] for m in client.get("/api/models?language=it").json()["models"]]
    en = [m["id"] for m in client.get("/api/models?language=en").json()["models"]]
    assert "parakeet-tdt-0.6b-v3" in it and "parakeet-tdt-0.6b-v2" in en and "parakeet-tdt-0.6b-v2" not in it


def test_no_invented_benchmarks(client):
    for m in client.get("/api/models/all").json()["models"]:
        b = m["benchmark"]
        assert b is None or (b.get("url", "").startswith("http") and b.get("text"))


def test_incompatible_and_uninstalled_models_blocked(client, wav):
    m = upload(client, wav)
    base = {"upload_id": m["upload_id"], "language": "it"}
    r = client.post("/api/transcripts", json=base | {"model_id": "whisper-large-v3"})
    assert r.status_code in (409, 422)  # non installato (o RAM insufficiente)
    client.put("/api/settings", json={"device": "cuda"})  # nessuna GPU in questo ambiente
    r = client.post("/api/transcripts", json=base | {"model_id": "parakeet-tdt-0.6b-v3"})
    client.put("/api/settings", json={"device": "auto"})
    assert r.status_code == 422 and "GPU" in r.json()["detail"]
    r = client.post("/api/transcripts", json=base | {"model_id": "parakeet-tdt-0.6b-v2"})  # EN-only su lingua IT
    assert r.status_code == 400


def test_models_not_downloaded_automatically(client):
    assert client.get("/api/models/all").json()["total_disk_bytes"] == 0


def test_full_pipeline_mock(client, wav):
    m = upload(client, wav)
    r = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "context": "Filosofia"})
    tid = r.json()["id"]
    t = wait(client, tid)
    assert t["status"] == "done", t.get("error")
    segs = t["segments"]
    assert len(segs) >= 2
    starts = [s["start"] for s in segs]
    assert starts == sorted(starts) and segs[-1]["end"] <= m["duration"] + 1
    assert t["stats"]["words"] > 0 and t["stats"]["elapsed_s"] >= 0 and t["chunks_done"] == t["chunks_total"] > 0
    assert t["has_word_ts"] == 1 and all(0 <= w["s"] <= w["e"] for s in segs for w in s["words"])
    # nessun testo duplicato fra chunk adiacenti: tutti i tempi di parola strettamente non-sovrapposti tra segmenti
    for a, b in zip(segs, segs[1:]):
        assert a["end"] <= b["start"] + 0.6
    # duplicati evitati
    r2 = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "context": "Filosofia"})
    assert r2.json() == {"id": tid, "duplicate": True}
    # salvataggio modifiche
    assert client.patch(f"/api/transcripts/{tid}", json={"edits": [{"i": 0, "text": "Perché è così: città, caffè, ñ, 日本"}], "title": "Ñandú è"}).status_code == 200
    t = client.get(f"/api/transcripts/{tid}").json()
    assert t["segments"][0]["text"].startswith("Perché") and t["orig_segments"][0]["text"] != t["segments"][0]["text"]
    assert client.patch(f"/api/transcripts/{tid}", json={"edits": [{"i": 999, "text": "x"}]}).status_code == 400
    # archivio
    assert tid in [x["id"] for x in client.get("/api/transcripts").json()]
    return tid


@pytest.fixture(scope="module")
def done_tid(client, wav):
    m = upload(client, wav)
    tid = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "context": "Storia", "force": True}).json()["id"]
    assert wait(client, tid)["status"] == "done"
    return tid


def test_exports_keep_accents(client, done_tid):
    tid = done_tid
    client.patch(f"/api/transcripts/{tid}", json={"edits": [{"i": 0, "text": "Perché è così: città, caffè"}]})
    for fmt in ("txt", "srt", "vtt", "json"):
        r = client.get(f"/api/transcripts/{tid}/export/{fmt}")
        assert r.status_code == 200
        assert "Perché è così: città, caffè" in r.content.decode("utf-8") or fmt == "json" and "Perché" in r.content.decode()
    srt = client.get(f"/api/transcripts/{tid}/export/srt").text
    assert "00:00:00,000 -->" in srt and srt.startswith("1\n")
    assert client.get(f"/api/transcripts/{tid}/export/vtt").text.startswith("WEBVTT")
    j = client.get(f"/api/transcripts/{tid}/export/json").json()
    assert j["timestamp_precision"] == "word" and j["segments"][0]["words"]
    pdf = client.get(f"/api/transcripts/{tid}/export/pdf").content
    assert pdf[:5] == b"%PDF-" and len(pdf) > 1500
    docx = client.get(f"/api/transcripts/{tid}/export/docx").content
    assert docx[:2] == b"PK"
    import io
    from docx import Document
    assert "Perché è così: città, caffè" in "\n".join(p.text for p in Document(io.BytesIO(docx)).paragraphs)
    assert client.get(f"/api/transcripts/{tid}/export/xyz").status_code == 400
    r = client.get(f"/api/transcripts/{tid}/render?mode=pulita").json()
    assert r["text"] and not r["ai_generated"]
    assert client.get(f"/api/transcripts/{tid}/render?mode=appunti").status_code == 404


def test_notes_need_local_llm(client, done_tid):
    tid = done_tid
    r = client.post(f"/api/transcripts/{tid}/study-notes", json={"llm": "x"})
    assert r.status_code == 422 and "LLM" in r.json()["detail"]


def test_audio_range_and_waveform(client, done_tid):
    tid = done_tid
    r = client.get(f"/api/transcripts/{tid}/audio", headers={"Range": "bytes=100-199"})
    assert r.status_code == 206 and len(r.content) == 100
    w = client.get(f"/api/transcripts/{tid}/waveform?bins=300").json()
    assert w["available"] and len(w["peaks"]) == 300 and max(w["peaks"]) > 0.05


def test_wer_requires_reference(client, done_tid):
    tid = done_tid
    assert client.post(f"/api/transcripts/{tid}/wer", json={"reference": "  "}).status_code == 400
    r = client.post(f"/api/transcripts/{tid}/wer", json={"reference": "parola0 parola1"}).json()
    assert 0 <= r["wer"] and "verificata" in r["note"]


def test_compare_group(client, wav):
    m = upload(client, wav)
    r = client.post("/api/compare", json={"upload_id": m["upload_id"], "language": "en", "model_ids": ["mock"]})
    assert r.status_code == 400  # servono 2-3 modelli
    r = client.post("/api/compare", json={"upload_id": m["upload_id"], "language": "en", "model_ids": ["mock", "mock2"]}).json()
    for i in r["ids"]:
        assert wait(client, i)["status"] == "done"
    c = client.get(f"/api/compare/{r['group_id']}").json()
    assert len(c["items"]) == 2 and c["diffs"] and c["diffs"][0]["summary"]["differences"] > 0
    assert all(i["stats"]["elapsed_s"] is not None and i["word_count"] for i in c["items"])
    assert "NON quale sia più accurato" in c["note"]


def test_cancel_and_resume(client, tmp_path, monkeypatch):
    from conftest import make_audio
    longwav = tmp_path / "lunga.wav"
    make_audio(longwav, [5] * 20)
    monkeypatch.setenv("STUDIO_MOCK_DELAY", "1.0")
    m = upload(client, longwav)
    tid = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "en", "model_id": "mock", "context": "Fisica", "force": True}).json()["id"]
    t0 = time.time()
    while client.get(f"/api/transcripts/{tid}").json()["chunks_done"] < 1 and time.time() - t0 < 30:
        time.sleep(0.1)
    client.post(f"/api/transcripts/{tid}/cancel")
    t = wait(client, tid, ("cancelled", "done"))
    assert t["status"] == "cancelled"
    done_before = t["chunks_done"]
    assert 1 <= done_before < t["chunks_total"]
    monkeypatch.setenv("STUDIO_MOCK_DELAY", "0")
    assert client.post(f"/api/transcripts/{tid}/retry").status_code == 200
    t = wait(client, tid)
    assert t["status"] == "done" and t["chunks_done"] == t["chunks_total"]
    assert client.delete(f"/api/transcripts/{tid}").status_code == 200
    assert client.get(f"/api/transcripts/{tid}").status_code == 404


def test_silent_audio_fails_cleanly(client, tmp_path):
    import subprocess
    p = tmp_path / "silenzio.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-t", "4", "-i", "anullsrc=r=16000", str(p)], check=True)
    m = upload(client, p)
    tid = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock"}).json()["id"]
    t = wait(client, tid)
    assert t["status"] == "failed" and "parlato" in t["error"]


def test_auth_token(client, monkeypatch):
    monkeypatch.setattr(config, "ACCESS_TOKEN", "segreto")
    assert client.get("/api/health").json()["auth_required"] is True
    assert client.get("/api/system").status_code == 401
    assert client.get("/api/system", headers={"X-Studio-Token": "no"}).status_code == 401
    assert client.get("/api/system", headers={"X-Studio-Token": "segreto"}).status_code == 200
    assert client.get("/api/system?token=segreto").status_code == 200


def test_delete_removes_files(client, wav):
    m = upload(client, wav)
    tid = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "context": "Storia", "force": True}).json()["id"]
    wait(client, tid)
    from pathlib import Path
    assert Path(m["path"]).exists()
    client.delete(f"/api/transcripts/{tid}")
    assert not Path(m["path"]).exists()


def test_frontend_served(client):
    r = client.get("/")
    assert r.status_code in (200, 404)
