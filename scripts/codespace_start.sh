#!/usr/bin/env bash
# Usato da GitHub Codespaces a ogni avvio: fa partire l'app in background. Log in /tmp/studio.log
cd "$(dirname "$0")/.."
if curl -s localhost:8000/api/health >/dev/null 2>&1; then exit 0; fi
nohup bash scripts/start.sh --lan > /tmp/studio.log 2>&1 &
