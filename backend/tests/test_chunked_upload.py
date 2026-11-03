"""Caricamento a pezzi: ripresa dopo errore, nessun duplicato, risultato identico al caricamento unico."""
import hashlib
from pathlib import Path

from test_api import upload


def test_chunked_upload_matches_single(client, wav):
    data = Path(wav).read_bytes()
    ref = upload(client, wav)
    uid = client.post("/api/upload/begin", json={"name": "lezione.wav"}).json()["upload_id"]
    cut = len(data) // 3
    assert client.put(f"/api/upload/{uid}/chunk?offset=0", content=data[:cut]).json()["size"] == cut
    assert client.put(f"/api/upload/{uid}/chunk?offset=0", content=data[:cut]).json()["size"] == cut  # pezzo ripetuto dopo un errore di rete
    assert client.put(f"/api/upload/{uid}/chunk?offset={cut * 2}", content=data[cut * 2:]).status_code == 409  # buco: rifiutato
    assert client.put(f"/api/upload/{uid}/chunk?offset={cut}", content=data[cut:]).json()["size"] == len(data)
    m = client.post(f"/api/upload/{uid}/finish").json()
    assert m["sha"] == hashlib.sha256(data).hexdigest() == ref["sha"]
    assert m["size"] == len(data) and abs(m["duration"] - ref["duration"]) < 0.01


def test_chunked_upload_bad_audio_and_unknown_id(client):
    uid = client.post("/api/upload/begin", json={"name": "x.wav"}).json()["upload_id"]
    client.put(f"/api/upload/{uid}/chunk?offset=0", content=b"non e' audio")
    assert client.post(f"/api/upload/{uid}/finish").status_code == 400
    assert client.put("/api/upload/nonesiste/chunk?offset=0", content=b"x").status_code == 404
    assert client.put("/api/upload/..%2F..%2Fx/chunk?offset=0", content=b"x").status_code in (404, 405, 422)
