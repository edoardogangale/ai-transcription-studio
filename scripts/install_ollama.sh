#!/usr/bin/env bash
# Installa e avvia Ollama (gratuito, open source) per la correzione AI. Linux / Codespaces / server.
# Su Mac e Windows: scarica l'app da https://ollama.com e aprila (poi non serve questo script).
set -euo pipefail
if ! command -v ollama >/dev/null; then
  echo "Installo Ollama (installer ufficiale: ollama.com)…"
  curl -fsSL https://ollama.com/install.sh | sh
fi
if ! curl -s localhost:11434/api/tags >/dev/null 2>&1; then
  echo "Avvio Ollama in background…"
  nohup ollama serve > "${TMPDIR:-/tmp}/ollama.log" 2>&1 &
  for _ in $(seq 1 20); do curl -s localhost:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
fi
curl -s localhost:11434/api/tags >/dev/null 2>&1 && echo "Ollama pronto. Ora, nell'app: Impostazioni → Correzione con AI → Installa (si scarica una volta sola)." || { echo "Ollama non è partito: vedi $TMPDIR/ollama.log"; exit 1; }
