#!/usr/bin/env python3
"""Scarica i modelli da terminale, in modo RIPRENDIBILE (se la rete cade o il Codespace si ferma, riparte da dove era arrivato).

  python scripts/download_models.py --list
  python scripts/download_models.py whisper-large-v3-turbo diarization

Stampa una riga di avanzamento ogni 15 secondi: in un Codespace l'output nel terminale conta come attività e
rimanda lo spegnimento per inattività (la sola connessione del browser no). Si può interrompere con Ctrl+C e rilanciare."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import config, installer, registry  # noqa: E402


def mb(n):
    return f"{n / 1e6:.0f} MB"


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--list":
        for mid, m in registry.ALL.items():
            if mid.startswith("mock"):
                continue
            st = installer.status(mid)
            note = "installato" if st["state"] == "installed" else (f"a metà: {mb(st['partial_bytes'])}" if st.get("partial_bytes") else "non installato")
            print(f"{mid:28s} {mb(m['download_bytes']):>8s}  {note:20s} {m['name']}")
        return 0
    unknown = [a for a in argv if a not in registry.ALL]
    if unknown:
        print("Modello sconosciuto:", ", ".join(unknown), "(vedi --list)")
        return 2
    config.ensure_dirs()
    print(f"Cartella dei modelli: {config.MODELS_DIR}")
    for mid in argv:
        installer.start(mid)
    last = 0
    while True:
        busy = False
        for mid in argv:
            st = installer.status(mid)
            if st["state"] in ("starting", "downloading", "extracting"):
                busy = True
        if time.time() - last >= 15 or not busy:
            last = time.time()
            for mid in argv:
                st = installer.status(mid)
                tot = st.get("total") or registry.ALL[mid]["download_bytes"]
                line = {"installed": "✓ installato", "error": "✕ " + str(st.get("error", "")), "absent": "annullato"}.get(st["state"])
                if line is None:
                    line = f"{st['state']} {mb(st.get('downloaded', 0))} / {mb(tot)} ({100 * st.get('downloaded', 0) / max(1, tot):.0f}%)" + (f" — {st['note']}" if st.get("note") else "")
                print(f"[{time.strftime('%H:%M:%S')}] {mid}: {line}", flush=True)
        if not busy:
            return 0 if all(installer.status(m)["state"] == "installed" for m in argv) else 1
        time.sleep(1)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\nInterrotto: quello già scaricato resta, rilancia lo stesso comando per riprendere.")
        sys.exit(130)
