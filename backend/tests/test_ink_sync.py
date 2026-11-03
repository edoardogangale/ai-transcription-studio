"""Il motore di scrittura è lo stesso per l'app sul dispositivo e per quella del server: le due copie devono restare identiche."""
from pathlib import Path


def test_ink_copies_identical():
    root = Path(__file__).resolve().parents[2]
    assert (root / "ondevice" / "ink.js").read_bytes() == (root / "frontend" / "ink.js").read_bytes(), "Aggiorna frontend/ink.js: cp ondevice/ink.js frontend/ink.js"
