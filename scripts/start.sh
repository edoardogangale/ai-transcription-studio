#!/usr/bin/env bash
# Avvio di AI Transcription Studio (Linux/macOS).
#   ./scripts/start.sh            solo questo computer  -> http://localhost:8000
#   ./scripts/start.sh --lan      accessibile da iPad/altri PC in rete locale, protetto da token
#   ./scripts/start.sh --lan --https   come sopra con HTTPS autofirmato (serve per il microfono da iPad)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=127.0.0.1; PORT="${PORT:-8000}"; HTTPS=0
for a in "$@"; do case "$a" in --lan) HOST=0.0.0.0;; --https) HTTPS=1;; esac; done

command -v ffmpeg >/dev/null || { echo "ERRORE: FFmpeg non trovato. Installalo (es. 'sudo apt install ffmpeg' o 'brew install ffmpeg')."; exit 1; }
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' || { echo "ERRORE: serve Python 3.11 o superiore."; exit 1; }
[ -d .venv ] || "$PY" -m venv .venv
. .venv/bin/activate
[ -f .venv/.deps_ok ] && cmp -s requirements.txt .venv/.deps_ok || { pip install -q --upgrade pip; pip install -r requirements.txt; cp requirements.txt .venv/.deps_ok; }
mkdir -p data
if [ "$HOST" = "0.0.0.0" ]; then
  [ -f data/token.txt ] || python -c "import secrets;print(secrets.token_urlsafe(18))" > data/token.txt
  export STUDIO_TOKEN="$(cat data/token.txt)"
  IP="$( (hostname -I 2>/dev/null | awk '{print $1}') || true )"; IP="${IP:-IP-DEL-COMPUTER}"
  SCHEME=http
  EXTRA=()
  if [ "$HTTPS" = 1 ]; then
    command -v openssl >/dev/null || { echo "openssl non trovato"; exit 1; }
    [ -f data/cert.pem ] || openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout data/key.pem -out data/cert.pem -subj "/CN=$IP" -addext "subjectAltName=IP:$IP,DNS:localhost" 2>/dev/null
    EXTRA=(--ssl-keyfile data/key.pem --ssl-certfile data/cert.pem); SCHEME=https
  fi
  echo "============================================================"
  echo " Apri dall'iPad/PC:  $SCHEME://$IP:$PORT"
  echo " Token di accesso (da inserire alla prima apertura):  $STUDIO_TOKEN"
  echo "============================================================"
else
  EXTRA=(); echo "Apri http://localhost:$PORT"
fi
exec python -m uvicorn app.main:app --app-dir backend --host "$HOST" --port "$PORT" "${EXTRA[@]}"
