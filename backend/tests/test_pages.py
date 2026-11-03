"""Appunti a mano libera sul server: cartelle, isolamento tra profili, ricerca, anteprime leggere."""
import json


def _data(n_strokes=2, text="Rivoluzione francese"):
    return {"w": 820, "h": 1160, "paper": {"type": "grid", "gap": 32, "color": "#ffffff"},
            "strokes": [{"id": f"s{i}", "t": "pen", "c": "#1c1c1e", "s": 3, "pts": [10, 10 + i * 5, .5, 40, 30 + i * 5, .5], "bb": [10, 10 + i * 900, 40, 30 + i * 900]} for i in range(n_strokes)],
            "texts": [{"id": "t1", "x": 40, "y": 50, "w": 400, "size": 20, "color": "#000", "text": text}]}


def test_page_crud_and_folders(client):
    fid = client.post("/api/folders", json={"name": "Storia"}).json()["id"]
    p = client.post("/api/pages", json={"title": "Lezione 1", "folder_id": fid, "data": _data()}).json()
    assert p["folder_id"] == fid and len(p["data"]["strokes"]) == 2
    got = client.get(f"/api/pages/{p['id']}").json()
    assert got["title"] == "Lezione 1" and got["folder_path"] == "Storia"
    # salvataggio
    d = _data(3)
    assert client.put(f"/api/pages/{p['id']}", json={"data": d, "title": "Lezione 1 (rev)"}).status_code == 200
    assert len(client.get(f"/api/pages/{p['id']}").json()["data"]["strokes"]) == 3
    # lista per cartella + ricerca nel testo
    assert [x["id"] for x in client.get("/api/pages", params={"folder_id": fid}).json()["pages"]] == [p["id"]]
    assert client.get("/api/pages", params={"q": "francese"}).json()["pages"][0]["id"] == p["id"]
    assert client.get("/api/pages", params={"q": "inesistente"}).json()["pages"] == []
    # sposta fuori cartella
    client.put(f"/api/pages/{p['id']}", json={"set_folder": True, "folder_id": None})
    assert client.get("/api/pages", params={"unfiled": True}).json()["pages"][0]["id"] == p["id"]
    assert client.get("/api/pages", params={"folder_id": fid}).json()["pages"] == []
    # eliminare
    assert client.delete(f"/api/pages/{p['id']}").status_code == 200
    assert client.get(f"/api/pages/{p['id']}").status_code == 404


def test_delete_folder_moves_pages_up(client):
    top = client.post("/api/folders", json={"name": "Materia"}).json()["id"]
    sub = client.post("/api/folders", json={"name": "Argomento", "parent_id": top}).json()["id"]
    p = client.post("/api/pages", json={"title": "x", "folder_id": sub, "data": _data()}).json()
    client.delete(f"/api/folders/{sub}")
    assert client.get(f"/api/pages/{p['id']}").json()["folder_id"] == top
    # ricorsivo: la nota è visibile guardando la cartella superiore
    assert any(x["id"] == p["id"] for x in client.get("/api/pages", params={"folder_id": top}).json()["pages"])


def test_list_is_light_and_preview_cut(client):
    p = client.post("/api/pages", json={"title": "lunga", "data": _data(5)}).json()  # tratti a y=10, 910, 1810, ...
    item = [x for x in client.get("/api/pages").json()["pages"] if x["id"] == p["id"]][0]
    assert "data" not in item and item["strokes"] == 5
    assert len(item["preview"]["strokes"]) < 5  # solo la parte alta della pagina


def test_invalid_data_and_unknown_folder(client):
    assert client.post("/api/pages", json={"data": {"strokes": "no"}}).status_code == 422
    assert client.post("/api/pages", json={"folder_id": "nonesiste"}).status_code == 404
    assert client.get("/api/pages/nonesiste").status_code == 404


def test_pages_are_private_per_profile(client, monkeypatch):
    from app import config
    from test_users_ai import mkuser
    monkeypatch.setattr(config, "ACCESS_TOKEN", "adminsecret")
    adm = {"X-Studio-Token": "adminsecret"}
    try:
        sara, _ = mkuser(client, adm, "Sara")
        marco, _ = mkuser(client, adm, "Marco")
        p = client.post("/api/pages", json={"title": "segreta", "data": _data()}, headers=sara).json()
        assert client.get(f"/api/pages/{p['id']}", headers=sara).status_code == 200
        for h in (marco, adm):
            assert client.get(f"/api/pages/{p['id']}", headers=h).status_code == 404
            assert client.put(f"/api/pages/{p['id']}", json={"title": "x"}, headers=h).status_code == 404
            assert client.delete(f"/api/pages/{p['id']}", headers=h).status_code == 404
            assert all(x["id"] != p["id"] for x in client.get("/api/pages", headers=h).json()["pages"])
        # la cartella di un altro profilo non si può usare
        f = client.post("/api/folders", json={"name": "Mia"}, headers=sara).json()["id"]
        assert client.post("/api/pages", json={"folder_id": f}, headers=marco).status_code == 404
    finally:
        for u in client.get("/api/users", headers=adm).json()["users"]:
            client.delete(f"/api/users/{u['id']}", headers=adm)
