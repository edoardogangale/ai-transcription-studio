import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import config, db, llm
from conftest import make_audio
from test_api import wait


# ------------------------------------------------------------------ profili
@pytest.fixture()
def protected(client, monkeypatch):
    monkeypatch.setattr(config, "ACCESS_TOKEN", "adminsecret")
    yield {"X-Studio-Token": "adminsecret"}
    for u in client.get("/api/users", headers={"X-Studio-Token": "adminsecret"}).json()["users"]:
        client.delete(f"/api/users/{u['id']}", headers={"X-Studio-Token": "adminsecret"})


def mkuser(client, adm, name):
    r = client.post("/api/users", json={"name": name}, headers=adm).json()
    return {"X-Studio-Token": r["code"]}, r


def up(client, h, path):
    with open(path, "rb") as f:
        r = client.post("/api/upload", files={"file": (path.name, f, "audio/wav")}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def test_profiles_are_isolated(client, protected, tmp_path):
    adm = protected
    marco, mr = mkuser(client, adm, "Marco")
    sara, sr = mkuser(client, adm, "Sara")
    p = tmp_path / "lezione.wav"
    make_audio(p, [4, 5])
    m = up(client, marco, p)
    tid = client.post("/api/transcripts", headers=marco, json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock", "title": "Segreto di Marco"}).json()["id"]
    assert wait_h(client, marco, tid)["status"] == "done"
    fid = client.post("/api/folders", headers=marco, json={"name": "Filosofia"}).json()["id"]
    client.post("/api/vocab", headers=marco, json={"term": "Schopenhauer", "context": "*"})
    ann = client.post(f"/api/transcripts/{tid}/annotations", headers=marco, json={"kind": "note", "t0": 1, "text": "privata"}).json()["id"]
    # Sara (e l'amministratore) NON vedono nulla di Marco
    for h in (sara, adm):
        assert client.get(f"/api/transcripts/{tid}", headers=h).status_code == 404
        assert tid not in [t["id"] for t in client.get("/api/transcripts", headers=h).json()]
        assert tid not in [r["id"] for r in client.get("/api/search", params={"q": "parola1"}, headers=h).json()["results"]]
        assert client.get(f"/api/transcripts/{tid}/audio", headers=h).status_code == 404
        assert client.get(f"/api/transcripts/{tid}/export/txt", headers=h).status_code == 404
        assert client.get("/api/export/bundle", params={"ids": tid}, headers=h).status_code == 404
        assert client.get("/api/export/audio.zip", params={"ids": tid}, headers=h).status_code == 404
        assert client.get("/api/export/text", params={"ids": tid}, headers=h).status_code == 404
        assert client.get(f"/api/transcripts/{tid}/annotations", headers=h).status_code == 404
        assert client.delete(f"/api/annotations/{ann}", headers=h).status_code == 404
        assert client.delete(f"/api/transcripts/{tid}", headers=h).status_code == 404
        assert client.post(f"/api/transcripts/{tid}/retranscribe", headers=h, json={"model_id": "mock2"}).status_code == 404
        assert client.post(f"/api/transcripts/{tid}/cancel", headers=h).status_code == 404
        assert client.post("/api/transcripts", headers=h, json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock"}).status_code == 404
        assert client.patch(f"/api/folders/{fid}", headers=h, json={"name": "x"}).status_code == 404
        assert client.get("/api/folders", headers=h).json()["folders"] == [] or all(f["id"] != fid for f in client.get("/api/folders", headers=h).json()["folders"])
        assert all(v["term"] != "Schopenhauer" for v in client.get("/api/vocab", headers=h).json()["custom"])
    assert client.post("/api/transcripts/move", headers=sara, json={"ids": [tid], "folder_id": None}).json()["moved"] == 0
    # stesso audio, altra persona: trascrizione propria (nessun dedupe incrociato)
    ms = up(client, sara, p)
    t2 = client.post("/api/transcripts", headers=sara, json={"upload_id": ms["upload_id"], "language": "it", "model_id": "mock"}).json()
    assert t2["id"] != tid and t2["duplicate"] is False
    # il profilo vede solo il proprio
    assert [t["id"] for t in client.get("/api/transcripts", headers=marco).json()] == [tid]
    assert client.get("/api/me", headers=marco).json()["name"] == "Marco"


def wait_h(client, h, tid, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = client.get(f"/api/transcripts/{tid}", headers=h).json()
        if r["status"] in ("done", "failed", "cancelled"):
            return r
        time.sleep(0.15)
    raise AssertionError("timeout")


def test_only_admin_manages_users_models_settings(client, protected):
    adm = protected
    marco, _ = mkuser(client, adm, "Marco")
    assert client.get("/api/users", headers=marco).status_code == 403
    assert client.post("/api/users", headers=marco, json={"name": "x"}).status_code == 403
    assert client.put("/api/settings", headers=marco, json={"parallel": 2}).status_code == 403
    assert client.post("/api/models/whisper-base/install", headers=marco).status_code == 403
    assert client.delete("/api/models/whisper-base", headers=marco).status_code == 403
    assert client.post("/api/ai/pull", headers=marco, json={"model": "qwen3:4b"}).status_code == 403
    assert client.put("/api/settings", headers=adm, json={"parallel": 2}).status_code == 200
    # accesso: senza codice o con codice errato = 401; la lista dei modelli è condivisa
    assert client.get("/api/transcripts").status_code == 401
    assert client.get("/api/transcripts", headers={"X-Studio-Token": "no"}).status_code == 401
    assert client.get("/api/models", headers=marco).status_code == 200


def test_reset_code_and_delete_purges_data(client, protected, tmp_path):
    adm = protected
    h, u = mkuser(client, adm, "Luca")
    p = tmp_path / "a.wav"
    make_audio(p, [3, 3])
    m = up(client, h, p)
    tid = client.post("/api/transcripts", headers=h, json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock"}).json()["id"]
    wait_h(client, h, tid)
    from pathlib import Path
    assert Path(m["path"]).exists()
    new = client.post(f"/api/users/{u['id']}/reset", headers=adm).json()["code"]
    assert client.get("/api/transcripts", headers=h).status_code == 401           # il vecchio codice non vale più
    assert client.get("/api/transcripts", headers={"X-Studio-Token": new}).status_code == 200
    assert client.delete(f"/api/users/{u['id']}", headers=adm).status_code == 200
    assert db.get(tid) is None and not Path(m["path"]).exists()                    # eliminazione definitiva di dati e audio
    assert client.get("/api/transcripts", headers={"X-Studio-Token": new}).status_code == 401
    assert "hash" not in json.dumps(client.get("/api/users", headers=adm).json())


def test_users_need_protected_mode(client):
    assert client.post("/api/users", json={"name": "x"}).status_code == 409        # senza codice di accesso non ha senso


def test_ws_isolated(client, protected, tmp_path):
    adm = protected
    marco, mr = mkuser(client, adm, "Marco")
    sara, sr = mkuser(client, adm, "Sara")
    tid = client.post("/api/live", headers=marco, json={"language": "it", "model_id": "mock"}).json()["id"]
    with pytest.raises(Exception):
        with client.websocket_connect(f"/api/live/{tid}/ws?token={sr['code']}"):
            pass
    with client.websocket_connect(f"/api/live/{tid}/ws?token={mr['code']}") as ws:
        assert ws.receive_json()["type"] == "ready"
        ws.send_text('{"type":"stop"}')
        while ws.receive_json()["type"] != "done":
            pass


# ------------------------------------------------------------------ AI di correzione (finto Ollama)
class FakeOllama(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._send({"models": [{"name": "qwen3:4b"}]} if self.path == "/api/tags" else {}, 200 if self.path == "/api/tags" else 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/pull":
            self.send_response(200)
            self.end_headers()
            for done in (0, 500, 1000):
                self.wfile.write((json.dumps({"status": "pulling", "digest": "sha:1", "total": 1000, "completed": done}) + "\n").encode())
            self.wfile.write((json.dumps({"status": "success"}) + "\n").encode())
            return
        FakeOllama.calls.append(body)
        user = body["messages"][1]["content"]
        out = []
        for n, text in re.findall(r"^\[(\d+)\] (.*)$", user.split("Righe da correggere:")[1], flags=re.M):
            new, off = text, False
            if "Cante" in text:
                new = text.replace("Cante", "Kant")
            if "quaderno" in text:
                off = True
            if "RISCRIVI" in text:
                new = "Una frase totalmente diversa che non c'entra con quella originale per niente affatto"
            if "42" in text:
                new = text.replace("42", "24")
            out.append({"n": int(n), "text": new, "off_topic": off})
        self._send({"message": {"content": "<think>ok</think>" + json.dumps({"lines": out})}})


@pytest.fixture(scope="module")
def ollama():
    srv = HTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    old = config.OLLAMA_URL
    config.OLLAMA_URL = f"http://127.0.0.1:{srv.server_port}"
    yield srv
    config.OLLAMA_URL = old
    srv.shutdown()


def mk_transcript(model="parakeet-tdt-0.6b-v3", folder=None):
    segs = [{"start": 0, "end": 4, "text": "Oggi parliamo di Cante e della critica della ragion pura", "words": []},
            {"start": 5, "end": 8, "text": "Scusa hai portato il quaderno di matematica per domani", "words": []},
            {"start": 9, "end": 12, "text": "Il capitolo 42 riguarda la RISCRIVI derivata seconda", "words": []},
            {"start": 13, "end": 16, "text": "Questa riga è già perfetta e non va toccata", "words": []},
            {"start": 17, "end": 20, "text": "Il noumeno secondo Cante è la cosa in sé", "words": []}]
    return db.insert(title="Lezione AI", upload_id="u", filename="x", audio_path="", duration=20, language="it", model_id=model, context="Filosofia",
                     options={}, status="done", kind="file", owner="admin", folder_id=folder, segments=segs, orig_segments=json.loads(json.dumps(segs)), has_word_ts=0, stats={})


def run_review(client, tid, **kw):
    body = {"model": "qwen3:4b", "scope": "all", **kw}
    r = client.post(f"/api/transcripts/{tid}/ai-review", json=body)
    assert r.status_code == 200, r.text
    for _ in range(100):
        rv = (client.get(f"/api/transcripts/{tid}").json()["stats"] or {}).get("ai_review") or {}
        if rv.get("status") in ("done", "error", "cancelled"):
            return rv
        time.sleep(0.1)
    raise AssertionError("revisione non terminata")


def test_ai_review_proposes_but_never_changes_text(client, ollama):
    client.post("/api/vocab", json={"term": "Kant", "context": "Filosofia"})
    fid = client.post("/api/folders", json={"name": "Filosofia", "prefs": {"ai_instructions": "Il professore chiama gli studenti per nome: non è contenuto della lezione."}}).json()["id"]
    tid = mk_transcript(folder=fid)
    FakeOllama.calls.clear()
    rv = run_review(client, tid)
    assert rv["status"] == "done" and rv["failed"] == 0
    by = {it["i"]: it for it in rv["items"]}
    assert by[0]["new"].count("Kant") == 1 and not by[0].get("rejected")        # correzione proposta
    assert by[1]["off_topic"] is True                                           # chiacchiera di classe segnalata
    assert by[2]["rejected"] and by[2]["new"] == by[2]["old"]                   # riscrittura/numero cambiato: SCARTATA
    assert 3 not in by                                                          # riga perfetta: nessuna proposta
    assert by[4]["new"].count("Kant") == 1
    # il testo NON è cambiato finché l'utente non approva
    t = client.get(f"/api/transcripts/{tid}").json()
    assert "Cante" in t["segments"][0]["text"] and not any(s.get("off_topic") for s in t["segments"])
    # il prompt contiene contesto, glossario e istruzioni personali; Qwen3 senza "thinking"
    sent = FakeOllama.calls[0]
    user = sent["messages"][1]["content"]
    assert "Materia: Filosofia" in user and "Kant" in user and "chiama gli studenti per nome" in user
    assert sent["think"] is False and sent["options"]["temperature"] == 0 and "/no_think" in user


def test_apply_selected_remember_and_exclude_off_topic(client, ollama):
    tid = mk_transcript()
    rv = run_review(client, tid)
    r = client.post(f"/api/transcripts/{tid}/ai-review/apply", json={"edits": [0, 2], "off_topic": [1]}).json()
    assert r == {"edits": 1, "off_topic": 1}                                     # la riga 2 era scartata: non applicabile
    t = client.get(f"/api/transcripts/{tid}").json()
    assert "Kant" in t["segments"][0]["text"] and "Cante" in t["segments"][4]["text"]   # solo ciò che ho scelto
    assert "Cante" in t["orig_segments"][0]["text"]                              # l'originale resta
    assert t["segments"][1].get("off_topic") is True
    assert "quaderno" not in client.get(f"/api/transcripts/{tid}/export/txt").text    # fuori tema escluso dall'export
    assert "quaderno" in client.get(f"/api/transcripts/{tid}/export/txt", params={"teacher_only": False}).text
    assert tid in [x["id"] for x in client.get("/api/search", params={"q": "Kant"}).json()["results"]]
    # memoria: la correzione approvata è ricordata
    mem = client.get("/api/corrections").json()["corrections"]
    assert any(c["wrong"] == "Cante" and c["right"] == "Kant" and c["scope"] == "Filosofia" for c in mem)
    # ...e riproposta (senza AI) su un'altra trascrizione, mai applicata da sola
    t2 = mk_transcript()
    sug = client.get(f"/api/transcripts/{t2}/suggestions").json()["suggestions"]
    assert any(s["source"] == "memoria" and s["term"] == "Kant" for s in sug)
    assert "Cante" in client.get(f"/api/transcripts/{t2}").json()["segments"][0]["text"]
    # le correzioni ricordate entrano nel prompt successivo
    FakeOllama.calls.clear()
    run_review(client, t2, scope="all")
    assert "«Cante» → «Kant»" in FakeOllama.calls[0]["messages"][1]["content"]
    # off-topic ripristinabile
    client.post(f"/api/transcripts/{tid}/off-topic", json={"edits": [1]})
    assert not client.get(f"/api/transcripts/{tid}").json()["segments"][1].get("off_topic")


def test_flagged_scope_only_touches_doubtful_points(client, ollama):
    tid = mk_transcript()
    client.post("/api/corrections", json={"scope": "Filosofia", "wrong": "Cante", "right": "Kant"})
    FakeOllama.calls.clear()
    rv = run_review(client, tid, scope="flagged")
    asked = " ".join(c["messages"][1]["content"].split("Righe da correggere:")[1] for c in FakeOllama.calls)
    assert "Cante" in asked and "già perfetta" not in asked                      # solo i punti dubbi
    assert rv["status"] == "done"


def test_assessment_says_when_ai_is_needed(client):
    weak = mk_transcript(model="whisper-tiny")
    mid = mk_transcript(model="parakeet-tdt-0.6b-v3")
    strong = mk_transcript(model="whisper-large-v3-turbo")
    a = lambda t: client.get(f"/api/transcripts/{t}/ai-assessment").json()
    assert a(weak)["level"] == "consigliata" and "veloce" in a(weak)["reasons"][0]
    assert a(mid)["level"] == "facoltativa"
    assert a(strong)["level"] in ("facoltativa", "non necessaria") and a(strong)["reasons"]
    clean = db.insert(title="pulita", upload_id="u", filename="x", audio_path="", duration=5, language="it", model_id="whisper-large-v3", context="Altro", options={}, status="done",
                      kind="file", owner="admin", segments=[{"start": 0, "end": 3, "text": "Una frase corretta e semplice", "words": []}], orig_segments=[], stats={})
    assert a(clean)["level"] == "non necessaria"


def test_ai_pull_progress_and_status(client, ollama):
    r = client.get("/api/ai/status").json()
    assert r["reachable"] and "qwen3:4b" in r["models"] and r["recommended"][0]["id"] == "qwen3:4b" and r["recommended"][0]["installed"]
    assert client.post("/api/ai/pull", json={"model": "qwen3:8b"}).status_code == 200
    for _ in range(50):
        p = llm.PULL["qwen3:8b"]
        if p["state"] == "done":
            break
        time.sleep(0.1)
    assert p["state"] == "done" and p["total"] == 1000 and p["completed"] == 1000


def test_ai_errors_are_clear(client):
    old = config.OLLAMA_URL
    config.OLLAMA_URL = "http://127.0.0.1:9"        # nessun server
    try:
        tid = mk_transcript()
        r = client.post(f"/api/transcripts/{tid}/ai-review", json={"model": "qwen3:4b"})
        assert r.status_code == 409 and "Ollama" in r.json()["detail"]
        assert client.get("/api/ai/status").json()["reachable"] is False
        assert client.post("/api/ai/pull", json={"model": "qwen3:4b"}).status_code == 409
    finally:
        config.OLLAMA_URL = old


def test_check_line_guardrails():
    ok = lambda o, n, g=(): llm.check_line(o, n, g)[0]
    assert ok("Oggi parliamo di Cante e della critica", "Oggi parliamo di Kant e della critica")
    assert not ok("Il capitolo 42 riguarda la derivata", "Il capitolo 24 riguarda la derivata")           # numeri
    assert not ok("Una frase di prova abbastanza lunga da controllare", "Tutt'altro discorso completamente inventato dal modello oggi")
    assert not ok("Secondo Kant la ragione è limitata", "Secondo la ragione è limitata", ["Kant"])          # termine del glossario rimosso
    assert not ok("Una frase lunga di prova con tante parole qui dentro", "ok")
    assert not ok("testo", "  ")
    assert llm.diff_pairs("secondo Cante la cosa", "secondo Kant la cosa") == [("Cante", "Kant")]
    assert llm.diff_pairs("a b c d e f", "x y z w q r") == []                                               # troppo grandi per essere una coppia


def test_passages_group_by_speaker_and_size():
    segs = [{"text": "a" * 400, "speaker": "S0"}, {"text": "b" * 400, "speaker": "S0"}, {"text": "c" * 400, "speaker": "S0"}, {"text": "d" * 10, "speaker": "S1"}]
    g = llm.passages(segs, [0, 1, 2, 3])
    assert g == [[0, 1], [2], [3]]
