#!/usr/bin/env bash
# Avvio di AI Transcription Studio (Linux/macOS/Codespaces).
#   ./scripts/start.sh            solo questo computer  -> http://localhost:8000
#   ./scripts/start.sh --lan      accessibile da iPad/altri dispositivi, protetto da codice
#   ./scripts/start.sh --lan --https   come sopra con HTTPS autofirmato (rete locale: serve per microfono da iPad)
# I DATI (modelli scaricati, audio, archivio) stanno FUORI dalla cartella del progetto, in ~/.ai-transcription-studio:
# i modelli si scaricano UNA volta sola, anche se aggiorni o riscarichi il progetto. Cambia posizione con STUDIO_DATA.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=127.0.0.1; PORT="${PORT:-8000}"; HTTPS=0
for a in "$@"; do case "$a" in --lan) HOST=0.0.0.0;; --https) HTTPS=1;; esac; done

if [ -z "${STUDIO_DATA:-}" ]; then
  if ls "$PWD"/data/models/*/.complete >/dev/null 2>&1; then export STUDIO_DATA="$PWD/data"; else export STUDIO_DATA="$HOME/.ai-transcription-studio"; fi
fi
mkdir -p "$STUDIO_DATA"

command -v ffmpeg >/dev/null || { echo "ERRORE: FFmpeg non trovato. Installalo (es. 'sudo apt install ffmpeg' o 'brew install ffmpeg')."; exit 1; }
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' || { echo "ERRORE: serve Python 3.11 o superiore."; exit 1; }
[ -d .venv ] || "$PY" -m venv .venv
. .venv/bin/activate
[ -f .venv/.deps_ok ] && cmp -s requirements.txt .venv/.deps_ok || { pip install -q --upgrade pip; pip install -r requirements.txt; cp requirements.txt .venv/.deps_ok; }

EXTRA=()
if [ "$HOST" = "0.0.0.0" ]; then
  [ -f "$STUDIO_DATA/token.txt" ] || python -c "import secrets;print(secrets.token_urlsafe(18))" > "$STUDIO_DATA/token.txt"
  export STUDIO_TOKEN="$(cat "$STUDIO_DATA/token.txt")"
  SCHEME=http
  if [ -n "${CODESPACE_NAME:-}" ]; then      # GitHub Codespaces: indirizzo pubblico HTTPS già pronto
    URL="https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  else
    IP="$( (hostname -I 2>/dev/null | awk '{print $1}') || true )"; IP="${IP:-IP-DEL-COMPUTER}"
    if [ "$HTTPS" = 1 ]; then
      command -v openssl >/dev/null || { echo "openssl non trovato"; exit 1; }
      [ -f "$STUDIO_DATA/cert.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$STUDIO_DATA/key.pem" -out "$STUDIO_DATA/cert.pem" -subj "/CN=$IP" -addext "subjectAltName=IP:$IP,DNS:localhost" 2>/dev/null
      EXTRA=(--ssl-keyfile "$STUDIO_DATA/key.pem" --ssl-certfile "$STUDIO_DATA/cert.pem"); SCHEME=https
    fi
    URL="$SCHEME://$IP:$PORT"
  fi
  echo "============================================================"
  echo " Apri dall'iPad/PC:   $URL"
  echo " Codice AMMINISTRATORE (alla prima apertura):   $STUDIO_TOKEN"
  echo " (poi, da Impostazioni → Persone, crei un codice per ogni compagno)"
  echo " Dati e modelli in:   $STUDIO_DATA"
  echo "============================================================"
else
  echo "Apri http://localhost:$PORT   (dati e modelli in: $STUDIO_DATA)"
fi
exec python -m uvicorn app.main:app --app-dir backend --host "$HOST" --port "$PORT" "${EXTRA[@]}"
