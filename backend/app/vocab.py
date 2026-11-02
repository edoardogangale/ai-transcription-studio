"""Vocabolario scolastico. Uso consentito solo tramite meccanismi reali:
 1) initial_prompt di Whisper (suggerimento al decoder);
 2) suggerimenti di correzione CONTROLLATI, mostrati all'utente e applicati solo con un clic.
Nessuna sostituzione automatica."""
import difflib

from . import db
from .textutil import norm_token

CONTEXTS = ["Matematica", "Fisica", "Chimica", "Filosofia", "Storia", "Italiano", "Inglese", "Scienze", "Altro"]

# Elenchi di partenza volutamente brevi: l'utente aggiunge i propri termini.
BUILTIN = {
    "Matematica": ["derivata", "integrale", "logaritmo", "asintoto", "teorema di Pitagora", "disequazione"],
    "Fisica": ["accelerazione", "entropia", "campo elettromagnetico", "momento angolare", "Newton"],
    "Chimica": ["stechiometria", "ossidoriduzione", "legame covalente", "elettronegatività", "mole"],
    "Filosofia": ["Kant", "Hegel", "Schopenhauer", "Nietzsche", "Aristotele", "Platone", "fenomenologia", "imperativo categorico"],
    "Storia": ["Risorgimento", "Congresso di Vienna", "Rivoluzione francese", "Restaurazione"],
    "Italiano": ["Leopardi", "Manzoni", "Pirandello", "Ungaretti", "endecasillabo"],
    "Inglese": ["present perfect", "subjunctive", "Shakespeare"],
    "Scienze": ["mitocondrio", "fotosintesi", "tettonica a placche", "DNA", "mitosi"],
    "Altro": [],
}


def terms_for(context: str):
    custom = [v["term"] for v in db.vocab_list() if v["context"] in (context, "*")]
    seen, out = set(), []
    for t in custom + BUILTIN.get(context, []):
        if t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out


def whisper_prompt(context: str, limit: int = 600):
    terms = terms_for(context)
    if not terms:
        return None
    p = "Glossario: " + ", ".join(terms) + "."
    return p[:limit]


def suggestions(segments, context: str, cutoff: float = 0.84):
    """Parole della trascrizione foneticamente/graficamente vicine a un termine del glossario ma diverse.
    Solo proposte: [{seg, word, term, score}]."""
    terms = [t for t in terms_for(context) if " " not in t and len(t) >= 5]
    tl = {t.lower(): t for t in terms}
    out = []
    for si, s in enumerate(segments):
        for w in s["text"].split():
            nw = norm_token(w)
            if len(nw) < 4 or nw in tl:
                continue
            m = difflib.get_close_matches(nw, list(tl), n=1, cutoff=cutoff)
            if m and nw[0] == m[0][0]:
                out.append({"seg": si, "word": w, "term": tl[m[0]],
                            "score": round(difflib.SequenceMatcher(None, nw, m[0]).ratio(), 3)})
    return out
