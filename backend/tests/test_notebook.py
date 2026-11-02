import io
import json

import pytest

from app import db, notebook
from test_users_ai import mk_transcript, protected, mkuser, wait_h, up  # noqa: F401
from conftest import make_audio


def tid_with_notes(client):
    tid = mk_transcript()
    client.post(f"/api/transcripts/{tid}/annotations", json={"kind": "highlight", "t0": 0, "t1": 3})
    client.post(f"/api/transcripts/{tid}/annotations", json={"kind": "note", "t0": 9.5, "text": "Chiedere al prof è così"})
    return tid


def test_create_notebook_from_transcript(client):
    tid = tid_with_notes(client)
    assert client.get(f"/api/transcripts/{tid}/notebook").json()["exists"] is False
    nb = client.post(f"/api/transcripts/{tid}/notebook/create", json={}).json()
    html = nb["html"]
    assert "<h1>Lezione AI</h1>" in html and 'class="nb-ts"' in html and "data-t=" in html
    assert "<mark>" in html and "Oggi parliamo di Cante" in html          # evidenziazione e testo fedele (nessuna pulizia)
    assert 'class="nb-note"' in html and "Chiedere al prof è così" in html   # le note finiscono nel quaderno
    assert client.post(f"/api/transcripts/{tid}/notebook/create", json={}).status_code == 409   # non sovrascrive per sbaglio
    assert client.post(f"/api/transcripts/{tid}/notebook/create", json={"force": True}).status_code == 200


def test_notebook_save_roundtrip_and_ink_validation(client):
    tid = mk_transcript()
    client.post(f"/api/transcripts/{tid}/notebook/create", json={})
    ink = [{"id": "s1", "t": "pen", "c": "#111111", "w": 3, "a": "b0", "fy": 12, "p": [[0.1, 5, 0.5], [0.2, 9, 0.7]]},
           {"id": "s2", "t": "arrow", "c": "#dc2626", "w": 4, "a": "b0", "fy": 12, "p": [[0.1, 5, 0.5], [0.5, 40, 0.5]]},
           {"t": "evil", "c": "red", "w": 3, "p": [[0, 0, 0]]},                           # tipo sconosciuto: scartato
           {"t": "pen", "c": "url(javascript:x)", "w": 3, "p": [[0, 0, 0]]},               # colore non valido: scartato
           {"t": "pen", "c": "#000", "w": 3, "p": "non-una-lista"}]
    r = client.put(f"/api/transcripts/{tid}/notebook", json={"html": "<p data-bid='b0'>Ciao <b>mondo</b></p>", "ink": ink}).json()
    assert r["ok"] and r["strokes"] == 2
    nb = client.get(f"/api/transcripts/{tid}/notebook").json()
    assert nb["exists"] and len(nb["ink"]) == 2 and nb["ink"][0]["p"][1] == [0.2, 9.0, 0.7] and nb["ink"][1]["t"] == "arrow"
    assert "Ciao <b>mondo</b>" in nb["html"]


def test_sanitizer_blocks_scripts_events_links():
    dirty = '<p onclick="x()" class="nb-ts evil" data-bid="b1" data-t="1.5">Ciao <script>alert(1)</script><b>b</b><a href="javascript:x">l</a><img src=x onerror=y><iframe src=z></iframe></p><style>*{}</style><svg onload=1></svg>'
    clean = notebook.sanitize(dirty)
    for bad in ("script", "onclick", "onerror", "javascript", "iframe", "<img", "<style", "<svg", "<a "):
        assert bad not in clean, (bad, clean)
    assert 'class="nb-ts"' in clean and 'data-bid="b1"' in clean and 'data-t="1.5"' in clean and "<b>b</b>" in clean
    st = notebook.sanitize('<span style="color:red;background-image:url(x);position:fixed;font-weight:bold;background-color:expression(1)">x</span>')
    assert st == '<span style="color: red; font-weight: bold">x</span>'
    assert notebook.sanitize("<p>aperto<b>non chiuso") == "<p>aperto<b>non chiuso</b></p>"          # niente HTML rotto
    assert notebook.sanitize('<p data-t="javascript:1" data-bid="a b">x</p>') == "<p>x</p>"


def test_notebook_size_limits(client, monkeypatch):
    tid = mk_transcript()
    monkeypatch.setattr(notebook, "MAX_HTML", 1000)
    assert client.put(f"/api/transcripts/{tid}/notebook", json={"html": "x" * 2000}).status_code == 413
    monkeypatch.setattr(notebook, "MAX_INK", 500)
    big = [{"t": "pen", "c": "#000", "w": 3, "p": [[i / 1000, i, 0.5] for i in range(200)]}]
    assert client.put(f"/api/transcripts/{tid}/notebook", json={"html": "<p>a</p>", "ink": big}).status_code == 413


def test_notebook_text_is_searchable_and_exports(client):
    tid = mk_transcript()
    client.post(f"/api/transcripts/{tid}/notebook/create", json={})
    client.put(f"/api/transcripts/{tid}/notebook", json={"html": "<h1>Appunti</h1><p>Il <b>noumeno</b> è l'ippogrifo parlante</p><ul><li>primo punto</li></ul>", "ink": []})
    assert tid in [r["id"] for r in client.get("/api/search", params={"q": "ippogrifo"}).json()["results"]]   # cerca anche nel quaderno
    client.patch(f"/api/transcripts/{tid}", json={"edits": [{"i": 0, "text": "testo cambiato"}]})            # una modifica alla trascrizione non cancella l'indice del quaderno
    assert tid in [r["id"] for r in client.get("/api/search", params={"q": "ippogrifo"}).json()["results"]]
    txt = client.get(f"/api/transcripts/{tid}/notebook/export/txt").text
    assert "Appunti" in txt and "noumeno è l'ippogrifo parlante" in txt and "• primo punto" in txt
    from docx import Document
    d = Document(io.BytesIO(client.get(f"/api/transcripts/{tid}/notebook/export/docx").content))
    paras = [p.text for p in d.paragraphs]
    assert any("ippogrifo" in p for p in paras) and any(p.style.name == "List Bullet" and "primo punto" in p.text for p in d.paragraphs)
    assert any(r.bold and r.text == "noumeno" for p in d.paragraphs for r in p.runs)
    assert client.get(f"/api/transcripts/{tid}/notebook/export/pdf").status_code == 400
    client.delete(f"/api/transcripts/{tid}/notebook")
    assert client.get(f"/api/transcripts/{tid}/notebook").json()["exists"] is False
    assert tid not in [r["id"] for r in client.get("/api/search", params={"q": "ippogrifo"}).json()["results"]]


def test_teacher_only_option_and_other_voices():
    segs = [{"start": 0, "end": 4, "text": "Spiegazione del prof", "speaker": "S0", "words": []},
            {"start": 6, "end": 8, "text": "Chiacchiera del compagno", "speaker": "S1", "words": []}]
    t = {"title": "T", "segments": segs, "stats": {"teacher": "S0", "speakers": {"S0": {"label": "Insegnante"}, "S1": {"label": "Voce 2"}}}}
    assert "compagno" not in notebook.initial_html(t, [], teacher_only=True)
    assert "compagno" in notebook.initial_html(t, [], teacher_only=False)


def test_notebook_is_private_between_profiles(client, protected, tmp_path):
    adm = protected
    marco, _ = mkuser(client, adm, "Marco")
    sara, _ = mkuser(client, adm, "Sara")
    p = tmp_path / "a.wav"
    make_audio(p, [3, 3])
    m = up(client, marco, p)
    tid = client.post("/api/transcripts", headers=marco, json={"upload_id": m["upload_id"], "language": "it", "model_id": "mock"}).json()["id"]
    wait_h(client, marco, tid)
    assert client.post(f"/api/transcripts/{tid}/notebook/create", headers=marco, json={}).status_code == 200
    client.put(f"/api/transcripts/{tid}/notebook", headers=marco, json={"html": "<p>diario segretissimo</p>"})
    for h in (sara, adm):
        assert client.get(f"/api/transcripts/{tid}/notebook", headers=h).status_code == 404
        assert client.put(f"/api/transcripts/{tid}/notebook", headers=h, json={"html": "x"}).status_code == 404
        assert client.get(f"/api/transcripts/{tid}/notebook/export/txt", headers=h).status_code == 404
        assert client.delete(f"/api/transcripts/{tid}/notebook", headers=h).status_code == 404
        assert tid not in [r["id"] for r in client.get("/api/search", params={"q": "segretissimo"}, headers=h).json()["results"]]
