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


# ------------------------------------------------------------------ correzione AI di più trascrizioni insieme
def wait_batch(client, ids, secs=15):
    for _ in range(int(secs * 10)):
        r = client.post("/api/ai/review-status", json={"ids": ids}).json()
        if not r["active"] and all(i["status"] in ("done", "error", "cancelled", "none") for i in r["items"]):
            return r
        time.sleep(0.1)
    raise AssertionError("correzione multipla non terminata")


def test_batch_review_runs_all_proposes_then_applies_together(client, ollama):
    a, b, c = mk_transcript(), mk_transcript(), mk_transcript()
    client.post("/api/folders", json={"name": "x"})
    r = client.post("/api/ai/review-batch", json={"ids": [a, b, c, a, "nonesiste"], "model": "qwen3:4b", "scope": "all"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["started"] == [a, b, c] and [s["reason"] for s in j["skipped"]] == ["non trovata"]       # duplicati tolti, id sconosciuto segnalato
    st = wait_batch(client, [a, b, c])
    assert [i["status"] for i in st["items"]] == ["done", "done", "done"]
    assert all(i["edits"] >= 2 and i["off_topic"] == 1 for i in st["items"])
    for tid in (a, b, c):                                                                              # NIENTE è stato cambiato da solo
        assert "Cante" in client.get(f"/api/transcripts/{tid}").json()["segments"][0]["text"]
    # applico insieme le correzioni di due trascrizioni (non della terza)
    items = []
    for tid in (a, b):
        rv = client.get(f"/api/transcripts/{tid}").json()["stats"]["ai_review"]
        items.append({"id": tid, "edits": [i["i"] for i in rv["items"] if not i["off_topic"] and not i.get("rejected") and i["new"] != i["old"]], "off_topic": []})
    ap = client.post("/api/ai/apply-batch", json={"items": items}).json()
    assert ap["transcripts"] == 2 and ap["edits"] >= 4
    assert "Kant" in client.get(f"/api/transcripts/{a}").json()["segments"][0]["text"]
    assert "Kant" in client.get(f"/api/transcripts/{b}").json()["segments"][0]["text"]
    assert "Cante" in client.get(f"/api/transcripts/{c}").json()["segments"][0]["text"]               # la terza resta com'era


def test_batch_review_skips_busy_unfinished_and_other_profiles(client, ollama):
    done = mk_transcript()
    running = db.insert(title="in corso", upload_id="u", filename="x", audio_path="", duration=1, language="it", model_id="m", context="Altro", options={}, status="running", kind="file", owner="admin", folder_id=None, segments=[], orig_segments=[], has_word_ts=0, stats={})
    r = client.post("/api/ai/review-batch", json={"ids": [running, done], "model": "qwen3:4b", "scope": "all"}).json()
    assert r["started"] == [done] and r["skipped"][0]["reason"] == "non ancora completata"
    wait_batch(client, [done])
    assert client.post("/api/ai/review-batch", json={"ids": [done], "model": "modello-che-non-c-e"}).status_code == 409
    assert client.post("/api/ai/review-batch", json={"ids": [done], "model": "qwen3:4b", "scope": "boh"}).status_code == 400


def test_batch_cancel_removes_waiting_ones(client, ollama):
    ids = [mk_transcript() for _ in range(3)]
    orig = FakeOllama.do_POST
    def slow(self):
        time.sleep(0.4)
        return orig(self)
    FakeOllama.do_POST = slow
    try:
        assert client.post("/api/ai/review-batch", json={"ids": ids, "model": "qwen3:4b", "scope": "all"}).status_code == 200
        time.sleep(0.3)
        assert client.post("/api/ai/review-batch/cancel").json()["was_active"] is True
        st = wait_batch(client, ids, 20)
        statuses = [i["status"] for i in st["items"]]
        assert "done" not in statuses[1:] and statuses.count("none") + statuses.count("cancelled") >= 2      # quelle in attesa non partono
        assert client.post("/api/ai/review-batch", json={"ids": ids[:1], "model": "qwen3:4b", "scope": "all"}).status_code == 200  # si può rilanciare
        wait_batch(client, ids[:1])
    finally:
        FakeOllama.do_POST = orig


def test_batch_review_is_private(client, ollama, protected):
    from test_pages import _data  # noqa: F401
    sara, _ = mkuser(client, protected, "Sara")
    mine = mk_transcript()                          # appartiene all'amministratore
    r = client.post("/api/ai/review-batch", json={"ids": [mine], "model": "qwen3:4b"}, headers=sara).json()
    assert r["started"] == [] and r["skipped"][0]["reason"] == "non trovata"
    assert client.post("/api/ai/apply-batch", json={"items": [{"id": mine, "edits": [0]}]}, headers=sara).json()["transcripts"] == 0


# ------------------------------------------------------------------ in parallelo, nelle Attività, stop immediato
@pytest.fixture()
def ollama_slow(monkeypatch):
    """Finto Ollama MULTI-richiesta e lento (0,4 s per passaggio; regolabile con .delay)."""
    from http.server import ThreadingHTTPServer
    orig = FakeOllama.do_POST
    box = {"delay": 0.4}

    def slow(self):
        time.sleep(box["delay"])
        try:
            return orig(self)
        except (BrokenPipeError, ConnectionResetError):   # il client ha chiuso (stop): normale
            return None
    monkeypatch.setattr(FakeOllama, "do_POST", slow)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(config, "OLLAMA_URL", f"http://127.0.0.1:{srv.server_port}")
    yield box
    srv.shutdown()


def test_batch_runs_several_in_parallel(client, ollama_slow):
    ids = [mk_transcript() for _ in range(3)]
    t0 = time.time()
    assert client.post("/api/ai/review-batch", json={"ids": ids, "model": "qwen3:4b", "scope": "all", "parallel": 1}).status_code == 200
    wait_batch(client, ids, 30)
    seq = time.time() - t0
    ids2 = [mk_transcript() for _ in range(3)]
    t0 = time.time()
    assert client.post("/api/ai/review-batch", json={"ids": ids2, "model": "qwen3:4b", "scope": "all", "parallel": 3}).status_code == 200
    st = wait_batch(client, ids2, 30)
    par = time.time() - t0
    assert all(i["status"] == "done" for i in st["items"])
    assert par < seq * 0.7, f"in parallelo {par:.2f}s vs una alla volta {seq:.2f}s"


def test_activity_lists_ai_reviews_while_running(client, ollama_slow):
    ids = [mk_transcript() for _ in range(3)]
    assert client.post("/api/ai/review-batch", json={"ids": ids, "model": "qwen3:4b", "scope": "all", "parallel": 1}).status_code == 200
    seen = {}
    for _ in range(60):
        for r in client.get("/api/activity").json()["ai_reviews"]:
            seen.setdefault(r["id"], set()).add(r["status"])
        if len(seen) == 3 and any("running" in s for s in seen.values()):
            break
        time.sleep(0.05)
    assert set(seen) == set(ids), seen                                            # tutte e tre compaiono nelle Attività
    row = [r for r in client.get("/api/activity").json()["ai_reviews"] if r["id"] == ids[0]]
    assert not row or (row[0]["batch"] == ids and row[0]["title"] == "Lezione AI")  # con elenco del gruppo e titolo
    wait_batch(client, ids, 30)
    assert client.get("/api/activity").json()["ai_reviews"] == []                  # a fine lavoro spariscono


def test_stop_is_immediate_even_with_a_long_request(client, ollama_slow):
    ollama_slow["delay"] = 6                     # un passaggio "dura" 6 secondi
    ids = [mk_transcript() for _ in range(2)]
    assert client.post("/api/ai/review-batch", json={"ids": ids, "model": "qwen3:4b", "scope": "all", "parallel": 2}).status_code == 200
    time.sleep(0.8)                              # le richieste sono in volo
    t0 = time.time()
    assert client.post("/api/ai/review-batch/cancel").json()["was_active"] is True
    st = wait_batch(client, ids, 10)
    assert time.time() - t0 < 2.5, f"fermata dopo {time.time() - t0:.1f}s"          # non aspetta i 6 s
    assert all(i["status"] in ("cancelled", "none") for i in st["items"]) and not st["active"]
    assert client.get("/api/activity").json()["ai_reviews"] == []


def test_single_review_stop_is_immediate(client, ollama_slow):
    ollama_slow["delay"] = 6
    tid = mk_transcript()
    assert client.post(f"/api/transcripts/{tid}/ai-review", json={"model": "qwen3:4b", "scope": "all"}).status_code == 200
    time.sleep(0.8)
    t0 = time.time()
    client.post(f"/api/transcripts/{tid}/ai-review/cancel")
    for _ in range(40):
        rv = (client.get(f"/api/transcripts/{tid}").json()["stats"] or {}).get("ai_review") or {}
        if rv.get("status") in ("cancelled", "done", "error"):
            break
        time.sleep(0.1)
    assert rv["status"] == "cancelled" and time.time() - t0 < 2.5
