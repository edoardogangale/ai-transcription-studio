#!/usr/bin/env bash
# Mostra indirizzo e codice per aprire l'app (utile in Codespaces dopo l'avvio).
for _ in $(seq 1 90); do curl -s localhost:8000/api/health >/dev/null 2>&1 && break; sleep 2; done
sed -n '/=====/,/=====/p' /tmp/studio.log 2>/dev/null | head -8 || true
echo "Se non vedi l'indirizzo qui sopra: scheda PORTE → porta 8000 → icona del globo."
