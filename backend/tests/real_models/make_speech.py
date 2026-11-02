"""Genera l'audio di prova usato dai test con modelli veri: una 'lezione' di filosofia/matematica letta da una voce
femminile (insegnante) con due interruzioni di una voce maschile (compagno). Voci piper (rhasspy/piper, licenza delle
singole voci: vedi MODEL_CARD scaricata) prese dalle release GitHub di sherpa-onnx; sintesi con il pacchetto piper-tts.
  pip install piper-tts && python make_speech.py /percorso/uscita
Crea lezione_it.wav (16 kHz mono) e truth.json (testo e tempi di riferimento). È parlato SINTETICO: serve a verificare la
pipeline (parlanti, segmentazione, timestamp), non a misurare l'accuratezza su parlato reale."""
import glob, io, json, sys, tarfile, urllib.request, wave
from pathlib import Path
import numpy as np

out = Path(sys.argv[1] if len(sys.argv) > 1 else "."); out.mkdir(parents=True, exist_ok=True)
BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
voices = {}
for who, name in (("P", "vits-piper-it_IT-paola-medium"), ("R", "vits-piper-it_IT-riccardo-x_low")):
    d = out / name
    if not d.exists():
        d.mkdir(); data = urllib.request.urlopen(BASE + name + ".tar.bz2").read()
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:bz2") as t: t.extractall(d, filter="data")
    voices[who] = glob.glob(str(d / "**" / "*.onnx"), recursive=True)[0]
from piper import PiperVoice
V = {k: PiperVoice.load(v) for k, v in voices.items()}

def say(who, text):
    b = io.BytesIO()
    with wave.open(b, "wb") as w: V[who].synthesize_wav(text, w)
    b.seek(0)
    with wave.open(b) as w: sr = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    n = int(len(x) * 16000 / sr); return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)

script = [("P", "Oggi parliamo di Immanuel Kant e della critica della ragion pura. Kant sostiene che la conoscenza nasce dall'esperienza, ma non deriva interamente da essa."),
 ("P", "Le forme a priori dello spazio e del tempo rendono possibile l'esperienza. Il fenomeno è la cosa come ci appare, il noumeno è la cosa in sé."),
 ("R", "Scusa, hai portato il quaderno di matematica per domani?"),
 ("P", "Passiamo ora all'imperativo categorico. Agisci soltanto secondo quella massima che al tempo stesso puoi volere che diventi una legge universale."),
 ("R", "Ho fame, andiamo in mensa dopo?"),
 ("P", "Per domani studiate il capitolo sulla derivata e sull'integrale.")]
parts, marks, t = [], [], 0.0
for who, text in script:
    x = say(who, text); parts += [x, np.zeros(16000, np.float32)]
    marks.append({"who": who, "start": round(t, 2), "end": round(t + len(x) / 16000, 2), "text": text}); t += len(x) / 16000 + 1.0
y = np.concatenate(parts); y = (y / np.abs(y).max() * 0.8 * 32767).astype(np.int16)
with wave.open(str(out / "lezione_it.wav"), "wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(y.tobytes())
json.dump(marks, open(out / "truth.json", "w"), ensure_ascii=False, indent=1); print("creati", out / "lezione_it.wav", round(len(y) / 16000, 1), "s")
