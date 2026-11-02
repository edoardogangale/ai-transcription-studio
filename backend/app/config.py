"""Configurazione centralizzata (variabili d'ambiente, tutte opzionali)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("STUDIO_DATA", ROOT / "data")).resolve()
UPLOADS = DATA_DIR / "uploads"
MODELS_DIR = DATA_DIR / "models"
DB_PATH = DATA_DIR / "studio.sqlite3"
FRONTEND_DIR = ROOT / "frontend"

# Se impostato, ogni chiamata /api/* richiede il token (header X-Studio-Token o ?token=).
ACCESS_TOKEN = os.environ.get("STUDIO_TOKEN", "").strip()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
# Solo per i test: abilita un adattatore finto che NON è un modello reale.
ENABLE_MOCK = os.environ.get("STUDIO_ENABLE_MOCK") == "1"
HF_TOKEN = os.environ.get("HF_TOKEN") or None


def ensure_dirs() -> None:
    for d in (DATA_DIR, UPLOADS, MODELS_DIR):
        d.mkdir(parents=True, exist_ok=True)
