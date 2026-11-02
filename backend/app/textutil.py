"""Utilità testuali: appiattimento parole, diff tra trascrizioni, WER (solo con riferimento verificato)."""
import difflib
import re
import unicodedata

TOKEN = re.compile(r"\S+")


def seg_words(seg):
    """[(parola, tempo_inizio)] per un segmento. Usa i timestamp di parola se coerenti col testo,
    altrimenti interpola linearmente nel segmento (e il chiamante lo dichiara come approssimato)."""
    toks = TOKEN.findall(seg.get("text", ""))
    ws = seg.get("words") or []
    if ws and len(ws) == len(toks):
        return [(t, w["s"]) for t, w in zip(toks, ws)], True
    n, a, b = len(toks), seg["start"], seg["end"]
    return [(t, round(a + (b - a) * i / max(n, 1), 3)) for i, t in enumerate(toks)], False


def flatten(segments):
    out = []
    for s in segments:
        ws, _ = seg_words(s)
        out += ws
    return out


def full_text(segments, sep=" "):
    return sep.join(s["text"].strip() for s in segments if s["text"].strip())


def norm_token(t):
    t = unicodedata.normalize("NFC", t.lower())
    return re.sub(r"^[^\w]+|[^\w]+$", "", t)


def word_diff(segs_a, segs_b):
    """Diff a livello di parola (confronto normalizzato: minuscole, senza punteggiatura ai bordi).
    Ritorna blocchi {op, a, b, t_a, t_b}. Misura DIFFERENZA, non accuratezza."""
    A, B = flatten(segs_a), flatten(segs_b)
    sm = difflib.SequenceMatcher(None, [norm_token(w) for w, _ in A], [norm_token(w) for w, _ in B], autojunk=False)
    blocks = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        blocks.append({"op": op, "a": " ".join(w for w, _ in A[i1:i2]), "b": " ".join(w for w, _ in B[j1:j2]),
                       "t_a": A[i1][1] if i1 < len(A) else (A[-1][1] if A else 0),
                       "t_b": B[j1][1] if j1 < len(B) else (B[-1][1] if B else 0)})
    return blocks


def diff_summary(blocks):
    return {"differences": sum(1 for b in blocks if b["op"] != "equal"),
            "words_changed": sum(max(len(b["a"].split()), len(b["b"].split())) for b in blocks if b["op"] != "equal")}


def wer(reference: str, hypothesis: str):
    """WER classico (Levenshtein su parole, normalizzato come sopra). Va usato solo con un riferimento verificato."""
    r = [x for x in (norm_token(t) for t in reference.split()) if x]
    h = [x for x in (norm_token(t) for t in hypothesis.split()) if x]
    if not r:
        raise ValueError("Riferimento vuoto.")
    prev = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        cur = [i]
        for j, hw in enumerate(h, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rw != hw)))
        prev = cur
    return {"wer": round(prev[-1] / len(r), 4), "edits": prev[-1], "ref_words": len(r), "hyp_words": len(h)}


def ts(seconds, sep=","):
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"
