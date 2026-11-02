"""Modalità di trascrizione.
A Fedele: testo del modello, invariato.
B Pulita: regole deterministiche (niente LLM): rimuove solo intercalari non lessicali (ehm, uhm...) e
   raddoppi immediati di parole funzione ("il il"), ricostruisce paragrafi dalle pause, maiuscola dopo il punto.
   NON inventa punteggiatura: quella è solo ciò che produce il modello ASR.
C Appunti: richiede un LLM locale (Ollama). Se assente la modalità è indisponibile."""
import json
import re
import urllib.request

from . import config

FILLERS = {"it": r"\b(?:e+h+m*|u+h+m+|m+h*m+|e+e+h*|a+h+m+)\b", "en": r"\b(?:u+m+|u+h+|e+r+m*|h+m+)\b"}
STOP_DUP = {"it": {"il", "lo", "la", "i", "gli", "le", "un", "una", "di", "a", "da", "in", "che", "e", "è", "non", "per", "con"},
            "en": {"the", "a", "an", "of", "to", "in", "and", "is", "that", "it", "i", "we", "you"}}


def clean_text(text: str, lang: str = "it") -> str:
    lg = lang if lang in FILLERS else "it"
    t = re.sub(FILLERS[lg] + r"[,.]?\s*", "", text, flags=re.I)

    def dup(m):
        return m.group(1) if m.group(1).lower() in STOP_DUP[lg] else m.group(0)
    t = re.sub(r"\b(\w+)(?:,)?\s+\1\b", dup, t, flags=re.I)
    t = re.sub(r"\s+([,.;:!?])", r"\1", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    t = re.sub(r"([.!?]\s+)([a-zà-ÿ])", lambda m: m.group(1) + m.group(2).upper(), t)
    return t[:1].upper() + t[1:] if t else t


def clean_paragraphs(segments, lang="it", gap=1.6, max_chars=700):
    paras, cur, last_end = [], [], None
    for s in segments:
        txt = clean_text(s["text"], lang)
        if not txt:
            continue
        if cur and ((last_end is not None and s["start"] - last_end > gap) or sum(map(len, cur)) > max_chars):
            paras.append(" ".join(cur))
            cur = []
        cur.append(txt)
        last_end = s["end"]
    if cur:
        paras.append(" ".join(cur))
    return "\n\n".join(paras)


# ---- LLM locale (Ollama) -------------------------------------------------------------------------
def llm_models():
    try:
        with urllib.request.urlopen(config.OLLAMA_URL + "/api/tags", timeout=2) as r:
            return [m["name"] for m in json.load(r).get("models", [])]
    except Exception:
        return []


NOTES_PROMPT = {
    "it": ("Sei un assistente che riorganizza la trascrizione di una lezione in appunti. Usa SOLO informazioni presenti "
           "nel testo: non aggiungere nulla. Struttura in Markdown con titoli (##), sottotitoli (###), elenchi di concetti, "
           "**Definizione:** per le definizioni, **Formula:** per le formule, **Esempio:** per gli esempi del professore. "
           "Rispondi in italiano."),
    "en": ("You reorganise a lecture transcript into study notes. Use ONLY information present in the text; add nothing. "
           "Structure in Markdown (##, ###, bullet lists, **Definition:**, **Formula:**, **Example:**). Reply in English."),
}


def split_for_llm(text: str, max_chars=6000):
    parts, cur = [], ""
    for p in text.split("\n\n"):
        if len(cur) + len(p) > max_chars and cur:
            parts.append(cur)
            cur = ""
        cur += p + "\n\n"
    return parts + ([cur] if cur.strip() else [])


def structured_notes(text: str, lang: str, model: str, progress=None):
    out = []
    parts = split_for_llm(text)
    for i, part in enumerate(parts):
        body = json.dumps({"model": model, "stream": False, "options": {"temperature": 0.1},
                           "messages": [{"role": "system", "content": NOTES_PROMPT.get(lang, NOTES_PROMPT["it"])},
                                        {"role": "user", "content": part}]}).encode()
        req = urllib.request.Request(config.OLLAMA_URL + "/api/chat", body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=1800) as r:
            out.append(json.load(r)["message"]["content"].strip())
        if progress:
            progress(i + 1, len(parts))
    return "\n\n".join(out)
