#!/usr/bin/env bash
# Esegue la suite automatica (backend). Aggiungi --slow per includere il test da 190 minuti di audio.
set -euo pipefail
cd "$(dirname "$0")/../backend"
pip install -q -r ../requirements-dev.txt
python -m pytest -q "$@"
