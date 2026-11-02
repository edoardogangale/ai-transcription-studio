"""Correzione AI della trascrizione (OPZIONALE). LLM locale, gratuito e open source, tramite Ollama (stesso computer).

Principi:
 - l'AI PROPONE, non modifica: ogni proposta si rivede (diff) e si approva;
 - controlli automatici su ogni riga proposta: se cambia troppe parole, altera numeri o toglie un termine del glossario
   la proposta viene scartata e resta l'originale;
 - "istruire" l'AI = darle contesto (materia, argomento della cartella, glossario, istruzioni personali, correzioni già
   approvate in passato). Non c'è addestramento/fine-tuning: richiederebbe dati e potenza che un PC/iPad non ha;
 - serve solo se la trascrizione lo richiede: l'app stima se è necessaria e può limitarsi ai soli punti dubbi."""
import difflib
import json
import re
import threading
import time
import urllib.error
import urllib.request

from . import config, db, registry, textutil, vocab

# Modelli suggeriti (nomi della libreria Ollama). Dimensioni indicative (quantizzazione Q4): da verificare al download.
RECOMMENDED = [
    {"id": "qwen3:4b", "name": "Qwen3 4B", "approx_gb": 2.6, "min_ram_gb": 8, "license": "Apache-2.0",
     "note": "Consigliato di base: leggero, multilingue (100+ lingue dichiarate dal produttore), gira anche su CPU."},
    {"id": "qwen3:8b", "name": "Qwen3 8B", "approx_gb": 5.2, "min_ram_gb": 16, "license": "Apache-2.0",
     "note": "Più accurato nel capire il contesto; più lento. Meglio con Mac Apple Silicon o GPU."},
    {"id": "qwen3:1.7b", "name": "Qwen3 1.7B", "approx_gb": 1.4, "min_ram_gb": 4, "license": "Apache-2.0",
     "note": "Velocissimo ma di qualità limitata in italiano: solo per PC molto lenti."},
]
PULL: dict = {}
MAX_CHANGE = 0.40          # oltre il 40% di parole cambiate in una riga: proposta scartata
SCHEMA = {"type": "object", "required": ["lines"], "properties": {"lines": {"type": "array", "items": {
    "type": "object", "required": ["n", "text", "off_topic"], "properties": {
        "n": {"type": "integer"}, "text": {"type": "string"}, "off_topic": {"type": "boolean"}}}}}}


def _url(path):
    return config.OLLAMA_URL.rstrip("/") + path


def _req(path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(_url(path), data, {"Content-Type": "application/json"} if data else {})
    return urllib.request.urlopen(r, timeout=timeout)


def installed_models():
    try:
        with _req("/api/tags", timeout=2) as r:
            return [m["name"] for m in json.load(r).get("models", [])]
    except Exception:
        return None            # None = Ollama non raggiungibile


def status(ram_gb=0):
    models = installed_models()
    rec = [dict(m, installed=bool(models) and any(x == m["id"] or x.startswith(m["id"] + "-") or x.split(":")[0] + ":" + x.split(":")[-1] == m["id"] for x in models),
                fits=(not ram_gb) or ram_gb >= m["min_ram_gb"], pull=PULL.get(m["id"])) for m in RECOMMENDED]
    return {"reachable": models is not None, "url": config.OLLAMA_URL, "models": models or [], "recommended": rec}


# ---------------------------------------------------------------- download del modello (una volta sola, resta in Ollama)
def pull(model):
    if PULL.get(model, {}).get("state") in ("downloading", "starting"):
        return
    PULL[model] = {"state": "starting", "completed": 0, "total": 0, "status": ""}

    def work():
        layers = {}
        try:
            with _req("/api/pull", {"name": model, "stream": True}, timeout=3600) as r:
                for line in r:
                    if not line.strip():
                        continue
                    m = json.loads(line)
                    if m.get("error"):
                        raise RuntimeError(m["error"])
                    if m.get("digest") and m.get("total"):
                        layers[m["digest"]] = (m.get("completed", 0), m["total"])
                    PULL[model] = {"state": "downloading", "status": m.get("status", ""), "completed": sum(c for c, _ in layers.values()),
                                   "total": sum(t for _, t in layers.values())}
            PULL[model] = {"state": "done", "completed": PULL[model].get("total", 0), "total": PULL[model].get("total", 0), "status": "success"}
        except Exception as e:
            PULL[model] = {"state": "error", "error": f"{type(e).__name__}: {e}"[:300], "completed": 0, "total": 0}
    threading.Thread(target=work, daemon=True, name="llm-pull").start()


# ---------------------------------------------------------------- chiamata al modello
def chat(model, system, user, timeout=900):
    body = {"model": model, "stream": False, "think": False, "format": SCHEMA, "keep_alive": "10m",
            "options": {"temperature": 0, "num_ctx": 8192},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user + "\n/no_think"}]}
    try:
        with _req("/api/chat", body, timeout) as r:
            out = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 400:                       # Ollama più vecchio: niente schema JSON, solo "json"
            body["format"] = "json"
            with _req("/api/chat", body, timeout) as r:
                out = json.load(r)
        else:
            raise
    txt = out["message"]["content"]
    return re.sub(r"<think>.*?</think>", "", txt, flags=re.S).strip()


# ---------------------------------------------------------------- prompt
SYSTEM = """Sei un correttore di trascrizioni automatiche di lezioni scolastiche. Il testo viene da un riconoscimento vocale e contiene errori di ascolto.
COMPITO: correggi SOLO gli errori del riconoscimento vocale: parole ascoltate male (omofone o foneticamente simili), nomi propri e termini tecnici scritti male,
accenti e apostrofi mancanti, parole spezzate o fuse per errore. Usa il contesto della materia e il glossario.
REGOLE RIGIDE:
- Non riformulare, non riassumere, non migliorare lo stile, non aggiungere informazioni, non spiegare.
- Mantieni lingua, ordine, numero di righe e numerazione. Non unire né dividere le righe.
- Cambia il minor numero di parole possibile. Se una riga è già corretta o non sei sicuro, restituiscila IDENTICA.
- Non modificare numeri, date, formule.
- Imposta "off_topic": true SOLO per le righe che chiaramente non fanno parte della lezione (chiacchiere fra compagni, richieste personali, rumori trascritti
  come parole, allucinazioni senza senso). Nel dubbio false. Per le righe off_topic restituisci il testo identico.
Rispondi SOLO con JSON: {"lines":[{"n":<numero>,"text":"<riga corretta>","off_topic":<true|false>}]} con una voce per ogni riga numerata."""


def build_user(ctx, lines, before):
    parts = [f"Materia: {ctx['subject']}"]
    if ctx.get("topic"):
        parts.append(f"Argomento/cartella: {ctx['topic']}")
    if ctx.get("glossary"):
        parts.append("Glossario (scritture corrette di nomi e termini): " + ", ".join(ctx["glossary"][:80]))
    if ctx.get("memory"):
        parts.append("Correzioni già approvate dall'utente in passato (errore → corretto): " + "; ".join(f"«{w}» → «{r}»" for w, r in ctx["memory"][:25]))
    if ctx.get("instructions"):
        parts.append("Istruzioni dell'utente per questa materia: " + ctx["instructions"].strip()[:800])
    if before:
        parts.append("Righe precedenti (SOLO contesto, non correggere): " + " / ".join(before))
    parts.append("Righe da correggere:\n" + "\n".join(f"[{n}] {t}" for n, t in lines))
    return "\n".join(parts)


# ---------------------------------------------------------------- controlli sulle proposte
def _norm_tokens(s):
    return [textutil.norm_token(w) for w in s.split() if textutil.norm_token(w)]


def change_ratio(old, new):
    a, b = _norm_tokens(old), _norm_tokens(new)
    if not a and not b:
        return 0.0
    return 1 - difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def check_line(old, new, glossary=()):
    """(ok, motivo). Scarta proposte pericolose: l'originale resta."""
    if not new or not new.strip():
        return False, "vuota"
    if old.strip() == new.strip():
        return True, ""
    digits = lambda s: sorted(re.findall(r"\d+(?:[.,]\d+)?", s))
    if digits(old) != digits(new):
        return False, "cambia numeri"
    n_old = max(1, len(old.split()))
    limit = MAX_CHANGE if n_old >= 6 else 0.6
    r = change_ratio(old, new)
    if r > limit:
        return False, f"troppo diversa ({round(r * 100)}% delle parole)"
    ratio_len = len(new.split()) / n_old
    if ratio_len < 0.6 or ratio_len > 1.5:
        return False, "lunghezza molto diversa"
    low = new.lower()
    for g in glossary:
        if len(g) >= 4 and g.lower() in old.lower() and g.lower() not in low:
            return False, f"rimuove il termine «{g}»"
    return True, ""


def diff_pairs(old, new, max_words=3):
    """Coppie (errore, corretto) brevi tra due versioni: la 'memoria' delle correzioni approvate."""
    a, b = old.split(), new.split()
    pairs = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == "replace" and 0 < i2 - i1 <= max_words and 0 < j2 - j1 <= max_words:
            w, r = " ".join(a[i1:i2]).strip(".,;:!?"), " ".join(b[j1:j2]).strip(".,;:!?")
            if w and r and w != r:
                pairs.append((w, r))
    return pairs


# ---------------------------------------------------------------- quali punti sono dubbi, e serve davvero l'AI?
def flagged(t, owner):
    """{indice_segmento: [motivi]}: punti in cui un errore è probabile (senza usare l'LLM)."""
    segs = t["segments"] or []
    out = {}
    ctx = t.get("context") or "Altro"
    for s in vocab.suggestions(segs, ctx, owner=owner):
        out.setdefault(s["seg"], []).append(f"«{s['word']}» simile a «{s['term']}» (glossario)")
    mem = db.corr_list(owner, ctx)
    for i, s in enumerate(segs):
        words = set(re.findall(r"\w+", s["text"].lower()))
        for m in mem:
            if m["wrong"].lower() in words or m["wrong"].lower() in s["text"].lower():
                out.setdefault(i, []).append(f"correzione già approvata: «{m['wrong']}» → «{m['right']}»")
        if re.search(r"\b(\w+)(\s+\1){2,}\b", s["text"], re.I):
            out.setdefault(i, []).append("parola ripetuta più volte (possibile errore)")
        if re.search(r"[^\w\s.,;:!?'’\"«»()\-–—%/+=°&@#€$àèéìòùÀÈÉÌÒÙ]", s["text"]):
            out.setdefault(i, []).append("caratteri insoliti")
    return out


def assess(t, owner):
    """Quanto serve la correzione AI? Basato sulle misure di riferimento del modello usato e sui punti dubbi trovati."""
    mid, fl = t.get("model_id"), flagged(t, owner)
    ref = registry.REFERENCE.get(mid)
    tier = (registry.ALL.get(mid) or {}).get("tier")
    reasons, level = [], "non necessaria"
    if tier == "fast":
        level = "consigliata"
        reasons.append(f"{registry.ALL[mid]['name']} è un modello veloce e poco accurato (nelle misure di riferimento WER ~{ref['wer']:.0f}% sull'italiano di prova)." if ref else "Modello veloce e poco accurato.")
    elif mid and mid.startswith("parakeet"):
        level = "facoltativa"
        reasons.append("Parakeet è velocissimo ma sbaglia più dei Whisper grandi (WER di riferimento ~10% sull'italiano di prova): può sbagliare termini tecnici e nomi propri.")
    elif mid and mid.startswith("whisper"):
        reasons.append("I Whisper grandi nelle misure di riferimento sbagliano poco (WER ~4% sull'italiano di prova): di solito la correzione AI non serve.")
    if fl:
        if level == "non necessaria":
            level = "facoltativa"
        reasons.append(f"Trovati {len(fl)} punti dubbi (termini simili al glossario, correzioni già approvate, ripetizioni).")
    if (t.get("stats") or {}).get("skipped_chunks"):
        reasons.append("Le altre voci sono già state escluse dal riconoscimento parlanti.")
    return {"level": level, "reasons": reasons, "flagged": len(fl), "total": len(t["segments"] or [])}


# ---------------------------------------------------------------- revisione
def instructions_for(t):
    """Istruzioni personali: quelle della cartella più vicina che le ha (sotto-cartella, poi materia)."""
    fid, seen = t.get("folder_id"), set()
    while fid and fid not in seen:
        seen.add(fid)
        f = db.folder_get(fid)
        if not f:
            break
        if (f.get("prefs") or {}).get("ai_instructions"):
            return f["prefs"]["ai_instructions"]
        fid = f["parent_id"]
    return ""


def _folder_path(fid):
    names, seen = [], set()
    while fid and fid not in seen:
        seen.add(fid)
        f = db.folder_get(fid)
        if not f:
            break
        names.append(f["name"])
        fid = f["parent_id"]
    return " / ".join(reversed(names))


def passages(segs, indices, max_chars=900):
    """Gruppi di righe vicine (stesso parlante) di ~900 caratteri; ritorna [[indici...], ...]."""
    out, cur, size = [], [], 0
    for i in sorted(indices):
        s = segs[i]
        if cur and (size + len(s["text"]) > max_chars or segs[cur[-1]].get("speaker") != s.get("speaker") or i - cur[-1] > 3):
            out.append(cur)
            cur, size = [], 0
        cur.append(i)
        size += len(s["text"])
    return out + ([cur] if cur else [])


def review(tid, model, scope, instructions, off_topic, owner, cancelled=lambda: False):
    """Esegue la revisione in background e salva le PROPOSTE in stats['ai_review']. Non modifica il testo."""
    t = db.get(tid)
    segs = t["segments"] or []
    fl = flagged(t, owner)
    ctx_name = t.get("context") or "Altro"
    idx = [i for i, s in enumerate(segs) if s["text"].strip() and not s.get("off_topic")]
    if scope == "flagged":
        idx = [i for i in idx if i in fl]
    teacher = (t.get("stats") or {}).get("teacher")
    if teacher:                                     # le altre voci sono già escluse: non si sprecano chiamate
        idx = [i for i in idx if segs[i].get("speaker") in (None, teacher)]
    glossary = vocab.terms_for(ctx_name, owner)
    ctx = {"subject": ctx_name if ctx_name != "Altro" else "non specificata", "topic": _folder_path(t.get("folder_id")), "glossary": glossary,
           "memory": [(m["wrong"], m["right"]) for m in db.corr_list(owner, ctx_name)], "instructions": instructions or instructions_for(t)}
    groups = passages(segs, idx)
    state = {"status": "running", "model": model, "scope": scope, "off_topic": off_topic, "done": 0, "total": len(groups), "items": [], "failed": 0, "started": time.time(),
             "instructions_used": bool(ctx["instructions"])}

    def save():
        st = (db.get(tid) or {}).get("stats") or {}
        st["ai_review"] = state
        db.update(tid, stats=st)

    save()
    try:
        for g in groups:
            if cancelled():
                state["status"] = "cancelled"
                break
            lines = [(k + 1, segs[i]["text"]) for k, i in enumerate(g)]
            before = [segs[j]["text"] for j in range(max(0, g[0] - 2), g[0]) if segs[j]["text"].strip()]
            data = None
            for attempt in range(2):
                try:
                    raw = chat(model, SYSTEM, build_user(ctx, lines, before))
                    data = json.loads(raw)["lines"]
                    if sorted(int(x["n"]) for x in data) == [n for n, _ in lines]:
                        break
                    data = None
                except Exception as e:
                    state["last_error"] = f"{type(e).__name__}: {e}"[:200]
                    data = None
            state["done"] += 1
            if data is None:
                state["failed"] += 1
                save()
                continue
            for x in data:
                i = g[int(x["n"]) - 1]
                old, new = segs[i]["text"], str(x.get("text", "")).strip()
                if x.get("off_topic") and off_topic:
                    state["items"].append({"i": i, "old": old, "new": old, "off_topic": True, "start": segs[i]["start"]})
                    continue
                if new == old.strip():
                    continue
                ok, why = check_line(old, new, glossary)
                state["items"].append({"i": i, "old": old, "new": new if ok else old, "off_topic": False, "start": segs[i]["start"],
                                       "rejected": None if ok else why, "proposed": new if not ok else None})
            save()
        else:
            state["status"] = "done"
    except Exception as e:
        state["status"] = "error"
        state["error"] = f"{type(e).__name__}: {e}"[:300]
    state["finished"] = time.time()
    save()


def apply(tid, accept_edits, accept_off, owner):
    """Applica le proposte scelte dall'utente. Il testo originale resta in orig_segments. Ricorda le correzioni approvate."""
    t = db.get(tid)
    segs, st = t["segments"], t.get("stats") or {}
    rv = st.get("ai_review") or {}
    items = {it["i"]: it for it in rv.get("items", [])}
    n_edit = n_off = 0
    scope = t.get("context") or "Altro"
    for i in accept_edits:
        it = items.get(i)
        if it and not it["off_topic"] and not it.get("rejected") and it["new"] != it["old"] and segs[i]["text"] == it["old"]:
            segs[i]["text"] = it["new"]
            it["applied"] = True
            n_edit += 1
            for w, r in diff_pairs(it["old"], it["new"]):
                db.corr_add(owner, scope, w, r)
    for i in accept_off:
        it = items.get(i)
        if it and it["off_topic"]:
            segs[i]["off_topic"] = True
            it["applied"] = True
            n_off += 1
    rv["items"] = list(items.values())
    st["ai_review"] = rv
    db.update(tid, segments=segs, stats=st)
    db.index_text(tid, t["title"], textutil.full_text([s for s in segs if not s.get("off_topic")]))
    return {"edits": n_edit, "off_topic": n_off}
