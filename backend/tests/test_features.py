import io
import time
import zipfile

import numpy as np
import pytest

from app import audio, db, live
from conftest import make_audio
from test_api import upload, wait

REAL_MODEL = "mock"


@pytest.fixture(scope="module")
def three(client, tmp_path_factory):
    """Tre trascrizioni completate con titoli diversi."""
    ids = []
    for i, (title, bursts) in enumerate([("Kant e la ragione", [5, 6]), ("Derivate è così", [4, 7, 5]), ("Storia: il Risorgimento", [6, 6])]):
        p = tmp_path_factory.mktemp("a") / f"f{i}.wav"
        make_audio(p, bursts)
        m = upload(client, p)
        tid = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "title": title}).json()["id"]
        assert wait(client, tid)["status"] == "done"
        ids.append(tid)
    return ids


def test_folders_tree_move_and_memory(client, three):
    f = client.post("/api/folders", json={"name": "Filosofia"}).json()["id"]
    k = client.post("/api/folders", json={"name": "Kant", "parent_id": f}).json()["id"]
    assert client.post("/api/folders", json={"name": ""}).status_code == 400
    # una cartella non può finire dentro sé stessa / un suo discendente
    assert client.patch(f"/api/folders/{f}", json={"move": True, "parent_id": k}).status_code == 400
    client.post("/api/transcripts/move", json={"ids": [three[0]], "folder_id": k})
    assert client.get(f"/api/transcripts/{three[0]}").json()["folder_path"] == "Filosofia / Kant"
    in_f = [t["id"] for t in client.get("/api/transcripts", params={"folder_id": f}).json()]
    assert three[0] in in_f                                   # ricorsivo: le sotto-cartelle contano
    in_k_only = [t["id"] for t in client.get("/api/transcripts", params={"folder_id": f, "recursive": False}).json()]
    assert three[0] not in in_k_only
    assert three[0] not in [t["id"] for t in client.get("/api/transcripts", params={"unfiled": True}).json()]
    fl = {x["id"]: x for x in client.get("/api/folders").json()["folders"]}
    assert fl[k]["count"] == 1
    # memoria della cartella: le scelte dell'ultimo lavoro restano come preferenze
    m = upload(client, make_audio_file(client))
    client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "en", "model_id": "mock", "context": "Filosofia", "folder_id": k, "force": True})
    prefs = {x["id"]: x for x in client.get("/api/folders").json()["folders"]}[k]["prefs"]
    assert prefs["language"] == "en" and prefs["context"] == "Filosofia" and prefs["model_id"] == "mock"
    # eliminare la cartella NON elimina le trascrizioni: salgono di un livello
    client.delete(f"/api/folders/{k}")
    assert client.get(f"/api/transcripts/{three[0]}").json()["folder_id"] == f
    assert client.delete("/api/folders/nonesiste").status_code == 404


_n = [0]


def make_audio_file(client):
    import tempfile, pathlib
    _n[0] += 1
    p = pathlib.Path(tempfile.mkdtemp()) / f"x{_n[0]}.wav"
    make_audio(p, [3 + _n[0] % 3, 4])
    return p


def test_annotations_and_exports_with_highlights(client, three):
    tid = three[1]
    seg0 = client.get(f"/api/transcripts/{tid}").json()["segments"][0]
    a = client.post(f"/api/transcripts/{tid}/annotations", json={"kind": "highlight", "t0": seg0["start"], "t1": seg0["start"] + 1}).json()["id"]
    n = client.post(f"/api/transcripts/{tid}/annotations", json={"kind": "note", "t0": seg0["start"] + 0.5, "text": "Chiedere all'interrogazione è così"}).json()["id"]
    assert client.post(f"/api/transcripts/{tid}/annotations", json={"kind": "note", "t0": 1, "text": " "}).status_code == 400
    assert len(client.get(f"/api/transcripts/{tid}/annotations").json()["annotations"]) == 2
    txt = client.get(f"/api/transcripts/{tid}/export/txt").content.decode()
    assert "★ [" in txt and "✎ Nota: Chiedere all'interrogazione è così" in txt
    from docx import Document
    doc = Document(io.BytesIO(client.get(f"/api/transcripts/{tid}/export/docx").content))
    assert any("Nota: Chiedere" in p.text for p in doc.paragraphs)
    assert any(r.font.highlight_color for p in doc.paragraphs for r in p.runs)   # evidenziazione gialla nel DOCX
    assert b"Nota" not in client.get(f"/api/transcripts/{tid}/export/txt", params={"notes": False}).content
    assert client.get(f"/api/transcripts/{tid}/export/pdf").content[:5] == b"%PDF-"
    client.patch(f"/api/annotations/{n}", json={"text": "modificata"})
    assert "modificata" in client.get(f"/api/transcripts/{tid}/export/txt").text
    client.delete(f"/api/annotations/{a}")
    client.delete(f"/api/annotations/{n}")
    assert client.get(f"/api/transcripts/{tid}/annotations").json()["annotations"] == []
    assert "★" not in client.get(f"/api/transcripts/{tid}/export/txt").text


def test_full_text_search_accent_insensitive_and_updates_on_edit(client, three):
    tid = three[2]
    client.patch(f"/api/transcripts/{tid}", json={"edits": [{"i": 0, "text": "Il Risorgimento è stato un processo politico, perché sì"}]})
    for q in ("perche", "PERCHÉ", "risorgim", "processo politico"):
        assert tid in [r["id"] for r in client.get("/api/search", params={"q": q}).json()["results"]], q
    r = client.get("/api/search", params={"q": "perche"}).json()["results"][0]
    assert "<mark>" in r["snippet"]
    assert client.get("/api/search", params={"q": "zzzqqq"}).json()["results"] == []
    client.patch(f"/api/transcripts/{tid}", json={"edits": [{"i": 0, "text": "altro"}]})
    assert tid not in [r["id"] for r in client.get("/api/search", params={"q": "risorgimento"}).json()["results"] if "processo" in r["snippet"]]


def test_bundle_pdf_all_transcripts_in_one_file(client, three):
    from pypdf import PdfReader
    r = client.get("/api/export/bundle", params={"ids": ",".join(three), "fmt": "pdf"})
    assert r.status_code == 200 and r.content[:5] == b"%PDF-"
    assert "Trascrizioni (3)" in r.headers["content-disposition"].replace("%20", " ").replace("%28", "(").replace("%29", ")")
    pdf = PdfReader(io.BytesIO(r.content))
    text = "\n".join(p.extract_text() for p in pdf.pages)
    titles = [client.get(f"/api/transcripts/{i}").json()["title"] for i in three]
    pos = [text.find(t) for t in titles]
    assert all(p >= 0 for p in pos), titles                  # tutte presenti, con accenti
    assert pos == sorted(pos)                                # nell'ordine selezionato: una dopo l'altra
    assert len(pdf.pages) >= 4                               # indice + una (o più) pagine per trascrizione
    assert client.get("/api/export/bundle", params={"ids": ",".join(three), "fmt": "srt"}).status_code == 400
    d = client.get("/api/export/bundle", params={"ids": ",".join(three), "fmt": "docx"})
    from docx import Document
    heads = [p.text for p in Document(io.BytesIO(d.content)).paragraphs if p.style.name == "Heading 1"]
    assert heads == titles
    t = client.get("/api/export/text", params={"ids": ",".join(three)}).text
    assert all(x in t for x in titles)
    assert client.get("/api/export/bundle", params={"ids": "nonesiste", "fmt": "pdf"}).status_code == 404


def test_audio_zip_and_download_name(client, three):
    r = client.get("/api/export/audio.zip", params={"ids": ",".join(three)})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert len(z.namelist()) == 3 and len(set(z.namelist())) == 3 and all(n.endswith(".wav") for n in z.namelist())
    one = client.get(f"/api/transcripts/{three[0]}/audio", params={"download": True})
    assert "attachment" in one.headers["content-disposition"]
    assert z.read(z.namelist()[0])[:4] == b"RIFF"


def test_delete_many_and_files(client):
    ids = []
    for _ in range(2):
        m = upload(client, make_audio_file(client))
        ids.append(client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "force": True}).json()["id"])
    for i in ids:
        wait(client, i)
    assert client.post("/api/transcripts/delete", json={"ids": ids}).json()["deleted"] == 2
    assert all(client.get(f"/api/transcripts/{i}").status_code == 404 for i in ids)


def test_parallel_jobs_run_at_the_same_time(client, tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_MOCK_DELAY", "0.8")
    client.put("/api/settings", json={"parallel": 2})
    ids = []
    for i in range(4):
        p = tmp_path / f"p{i}.wav"
        make_audio(p, [5] * 14)       # più chunk: i lavori durano abbastanza da sovrapporsi
        m = upload(client, p)
        ids.append(client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "force": True}).json()["id"])
    peak, t0 = 0, time.time()
    while time.time() - t0 < 90:
        st = [client.get(f"/api/transcripts/{i}").json()["status"] for i in ids]
        peak = max(peak, st.count("running"))
        if all(s == "done" for s in st):
            break
        time.sleep(0.1)
    assert all(s == "done" for s in st), st
    assert peak == 2, f"picco di lavori contemporanei: {peak}"
    client.put("/api/settings", json={"parallel": 1})
    assert client.put("/api/settings", json={"parallel": 9}).status_code == 400
    client.put("/api/settings", json={"parallel": 2})


def test_activity_endpoint(client):
    a = client.get("/api/activity").json()
    assert {"jobs", "downloads", "live", "parallel"} <= a.keys()


# ---------------------------------------------------------------- LIVE
def _pcm_bursts(bursts, gap=1.2, sr=16000):
    parts = []
    for i, d in enumerate(bursts):
        t = np.arange(int(d * sr)) / sr
        parts += [(0.4 * np.sin(2 * np.pi * (300 + 40 * i) * t) * 32767).astype(np.int16), np.zeros(int(gap * sr), np.int16)]
    return np.concatenate(parts)


def test_live_session_end_to_end(client):
    r = client.post("/api/live", json={"language": "it", "model_id": "mock", "context": "Storia", "title": "Lezione live è"})
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    pcm = _pcm_bursts([4, 5, 3, 6])
    msgs, note_t = [], None
    with client.websocket_connect(f"/api/live/{tid}/ws") as ws:
        assert ws.receive_json()["type"] == "ready"
        for off in range(0, len(pcm), 1600):                      # frame da 100 ms, come il browser
            ws.send_bytes(pcm[off:off + 1600].tobytes())
            if off == 16000 * 6:                                   # nota ed evidenziazione "in diretta" a ~6 s di audio
                note_t = off / 16000
                client.post(f"/api/transcripts/{tid}/annotations", json={"kind": "note", "t0": note_t, "text": "Importante per il compito"})
                client.post(f"/api/transcripts/{tid}/annotations", json={"kind": "highlight", "t0": note_t - 3, "t1": note_t})
        ws.send_text('{"type":"stop"}')
        while True:
            m = ws.receive_json()
            msgs.append(m)
            if m["type"] == "done":
                break
    segs_live = [m["seg"] for m in msgs if m["type"] == "segment"]
    assert len(segs_live) >= 3, "le frasi arrivano durante la registrazione, non solo alla fine"
    t = wait(client, tid)
    assert t["status"] == "done" and t["kind"] == "live" and t["audio_path"].endswith("original.m4a")
    assert abs(t["duration"] - len(pcm) / 16000) < 1.0
    starts = [s["start"] for s in t["segments"]]
    assert starts == sorted(starts) and len(t["segments"]) == len(segs_live)
    assert t["stats"]["live"] is True and t["stats"]["words"] > 0
    assert client.get(f"/api/transcripts/{tid}/audio").status_code == 200       # audio riascoltabile (m4a)
    assert len(client.get(f"/api/transcripts/{tid}/annotations").json()["annotations"]) == 2
    assert "Importante per il compito" in client.get(f"/api/transcripts/{tid}/export/txt").text
    assert tid in [r["id"] for r in client.get("/api/search", params={"q": "parola1"}).json()["results"]]
    # la sessione è chiusa: nessun file PCM grezzo residuo e nessuna sessione attiva
    assert not (live.config.UPLOADS / t["upload_id"] / "live.pcm").exists() and tid not in live.sessions
    # ritrascrizione con un altro modello sullo stesso audio
    rr = client.post(f"/api/transcripts/{tid}/retranscribe", json={"model_id": "mock2"})
    assert rr.status_code == 200 and wait(client, rr.json()["id"])["status"] == "done"


def test_live_recovers_audio_after_crash(client):
    tid = client.post("/api/live", json={"language": "it", "model_id": "mock"}).json()["id"]
    s = live.sessions[tid]
    s.feed(_pcm_bursts([3, 3]).tobytes())
    time.sleep(0.5)
    # simula un crash del server: la sessione sparisce senza finish()
    s.stopped = True
    s.jobs.put(None)
    s.f.close()
    live.sessions.pop(tid)
    assert db.get(tid)["status"] == "recording"
    live.recover()
    t = db.get(tid)
    assert t["status"] == "done" and t["stats"]["recovered"] is True and t["duration"] > 5   # l'audio salvato non va perso


def test_live_rejects_uninstalled_or_wrong_model(client):
    assert client.post("/api/live", json={"language": "it", "model_id": "whisper-large-v3"}).status_code in (409, 422)
    assert client.post("/api/live", json={"language": "it", "model_id": "nope"}).status_code == 400


def test_live_ws_requires_token(client, monkeypatch):
    from app import config
    monkeypatch.setattr(config, "ACCESS_TOKEN", "x")
    with pytest.raises(Exception):
        with client.websocket_connect("/api/live/qualunque/ws"):
            pass


# ---------------------------------------------------------------- parlanti
def _fake_diarized():
    segs = [{"start": 0, "end": 5, "text": "Spiegazione del professore uno", "speaker": "S0", "words": []},
            {"start": 6, "end": 8, "text": "Hai il quaderno di matematica", "speaker": "S1", "words": []},
            {"start": 9, "end": 14, "text": "Spiegazione del professore due", "speaker": "S0", "words": []}]
    return db.insert(title="Diarizzata", upload_id="u", filename="x", audio_path="", duration=14, language="it", model_id="mock", context="Altro",
                     options={}, status="done", kind="file", segments=segs, orig_segments=segs, has_word_ts=0,
                     stats={"teacher": "S0", "speakers": {"S0": {"label": "Insegnante", "teacher": True, "seconds": 10},
                                                         "S1": {"label": "Voce 2", "teacher": False, "seconds": 2}}})


def test_teacher_only_filter_in_exports_and_switching_teacher(client):
    tid = _fake_diarized()
    only = client.get(f"/api/transcripts/{tid}/export/txt").text            # predefinito: solo insegnante
    assert "professore uno" in only and "quaderno" not in only
    all_ = client.get(f"/api/transcripts/{tid}/export/txt", params={"teacher_only": False}).text
    assert "quaderno" in all_ and "Voce 2:" in all_                        # con le altre voci: etichettate
    assert "quaderno" not in client.get(f"/api/transcripts/{tid}/export/srt").text
    assert "quaderno" in client.get(f"/api/transcripts/{tid}/export/srt", params={"teacher_only": False}).text
    assert client.get(f"/api/transcripts/{tid}/render", params={"mode": "pulita"}).json()["text"].count("quaderno") == 0
    # l'utente corregge l'euristica: il vero insegnante era S1
    r = client.patch(f"/api/transcripts/{tid}/speakers", json={"id": "S1", "teacher": True}).json()
    assert r["teacher"] == "S1" and r["speakers"]["S1"]["label"] == "Insegnante" and r["speakers"]["S0"]["label"] == "Voce 0"
    assert "quaderno" in client.get(f"/api/transcripts/{tid}/export/txt").text
    assert client.patch(f"/api/transcripts/{tid}/speakers", json={"id": "S9", "label": "x"}).status_code == 404
    client.patch(f"/api/transcripts/{tid}/speakers", json={"id": "S0", "label": "Mario"})
    assert "Mario:" in client.get(f"/api/transcripts/{tid}/export/txt", params={"teacher_only": False}).text
    # riassegnazione manuale di un segmento
    client.patch(f"/api/transcripts/{tid}", json={"edits": [{"i": 1, "speaker": "S0"}]})
    assert client.get(f"/api/transcripts/{tid}").json()["segments"][1]["speaker"] == "S0"


def test_diarization_needs_component(client, wav):
    m = upload(client, wav)
    r = client.post("/api/transcripts", json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "diarize": True, "force": True})
    assert r.status_code == 422 and "parlanti" in r.json()["detail"]


def test_plan_in_ranges_one_speaker_per_chunk():
    db_e = np.full(1500, -80.0)                       # 45 s
    db_e[0:500] = -20; db_e[600:900] = -20; db_e[1000:1400] = -20
    ranges = [(0.0, 15.0, "S0"), (18.0, 27.0, "S1"), (30.0, 42.0, "S0")]
    plan = audio.plan_in_ranges(db_e, ranges, max_len=10)
    assert plan and all(spk in ("S0", "S1") for _, _, spk in plan)
    for a, b, spk in plan:
        owner = [r for r in ranges if r[0] - 0.1 <= a and b <= r[1] + 0.1]
        assert owner and owner[0][2] == spk, (a, b, spk)   # il chunk sta dentro un solo intervallo di parlante
    assert [p[0] for p in plan] == sorted(p[0] for p in plan)


def test_diarization_helpers():
    from app import diarization as d
    turns = [(0, 5, "S0"), (5.3, 9, "S0"), (10, 12, "S1"), (14, 20, "S0")]
    assert d.merge_turns(turns) == [(0, 9, "S0"), (10, 12, "S1"), (14, 20, "S0")]
    lab = d.label_speakers(d.speaker_stats(turns))
    assert lab["S0"]["teacher"] and lab["S0"]["label"] == "Insegnante" and lab["S1"]["label"] == "Voce 2"
    assert d.label_speakers({"S0": 1, "S1": 9}, teacher="S0")["S0"]["teacher"]


def test_settings_validation(client):
    assert client.put("/api/settings", json={"diar_threshold": 5}).status_code == 400
    assert client.put("/api/settings", json={"device": "tpu"}).status_code == 400
