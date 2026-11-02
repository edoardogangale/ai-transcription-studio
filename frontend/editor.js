"use strict";
/* Editor sincronizzato: modalità Ascolto (evidenziazione parola per parola) e Modifica, note/evidenziazioni, parlanti. */
ROUTES.push([/^#\/t\/(\w+)$/, async id => {
  let t = await api("/api/transcripts/" + id);
  if (t.status === "recording") { location.hash = "#/live"; return; }
  if (t.status !== "done") {
    const box = h("div"); $app.replaceChildren(h("h1", null, t.title || "Trascrizione"), box);
    const draw = () => box.replaceChildren(jobRow(t), t.status === "failed" ? h("div", { class: "notice bad" }, t.error) : null);
    draw(); poll(async () => { t = await api("/api/transcripts/" + id); draw(); if (t.status === "done") route(); }, 1500); return;
  }
  const [sys, fl] = await Promise.all([api("/api/system"), api("/api/folders")]); LIB.folders = fl.folders;
  const segs = t.segments, orig = t.orig_segments || t.segments; let ann = t.notes || [];
  const st = t.stats || {}; const speakers = st.speakers || null, teacher = st.teacher || null, multiSpk = speakers && Object.keys(speakers).length > 1;
  const hasOff = segs.some(s => s.off_topic);
  const S = { listen: LS.get("ed_listen", "1") === "1", showOthers: !(multiSpk || hasOff), follow: true, mode: "fedele" };

  /* ---------- tempi delle parole: reali se disponibili e coerenti, altrimenti stimati in proporzione ai caratteri ---------- */
  const wcache = new Map();
  function wordTimes(i) {
    const s = segs[i], key = s.text; const c = wcache.get(i); if (c && c.key === key) return c;
    const toks = s.text.match(/\S+/g) || [], ws = (orig[i] && orig[i].text === s.text && orig[i].words) || s.words || [];
    let times, exact = false;
    if (ws.length && ws.length === toks.length) { times = ws.map(w => [w.s, w.e]); exact = true; }
    else { const tot = toks.reduce((a, w) => a + w.length + 1, 0) || 1; let acc = 0; times = toks.map(w => { const a = s.start + (s.end - s.start) * acc / tot; acc += w.length + 1; return [a, s.start + (s.end - s.start) * acc / tot]; }); }
    const r = { key, toks, times, exact }; wcache.set(i, r); return r;
  }

  const audioEl = h("audio", { src: withTok(`/api/transcripts/${id}/audio`), preload: "metadata", controls: true, style: "width:100%" });
  const canvas = h("canvas", { class: "wave" }), seek = h("input", { type: "range", min: 0, max: 1000, value: 0, "aria-label": "Timeline" });
  const timeLbl = h("div", { class: "m" }, "0:00 / " + fmtT(t.duration));
  const dirty = new Set(); let saveTimer, activeIdx = -1, curWord = -1, peaks = [], lastUser = 0;
  const saveState = h("span", { class: "save-state" }, "Salvataggio automatico attivo");
  const list = h("div", { class: "segs" });
  const rows = [];

  /* ---------- annotazioni ---------- */
  const hlOverlap = s => ann.filter(a => a.kind === "highlight" && a.t0 <= s.end && (a.t1 ?? a.t0) >= s.start);
  const notesOf = i => { const s = segs[i], next = segs.slice(i + 1).find(x => x) , end = next ? next.start : Infinity; return ann.filter(a => a.kind === "note" && a.t0 >= (i === 0 ? 0 : s.start) && a.t0 < end); };
  async function toggleHighlight(i) {
    const s = segs[i], ov = hlOverlap(s);
    if (!ov.length) { const body = { kind: "highlight", t0: s.start, t1: s.end }; const r = await api(`/api/transcripts/${id}/annotations`, { json: body }); ann.push({ id: r.id, ...body }); }
    else for (const a of ov) {   // toglie l'evidenziazione solo da questo segmento, conservando le parti che coprono altri segmenti
      const left = a.t0 < s.start - 0.05, right = (a.t1 ?? a.t0) > s.end + 0.05;
      if (!left && !right) { await api("/api/annotations/" + a.id, { method: "DELETE" }); ann = ann.filter(x => x.id !== a.id); }
      else { if (left) { await api("/api/annotations/" + a.id, { method: "PATCH", json: { t1: s.start } }); const old = a.t1; a.t1 = s.start; if (right) { const b = { kind: "highlight", t0: s.end, t1: old }; const r = await api(`/api/transcripts/${id}/annotations`, { json: b }); ann.push({ id: r.id, ...b }); } }
        else { await api("/api/annotations/" + a.id, { method: "PATCH", json: { t0: s.end } }); a.t0 = s.end; } }
    }
    paintSeg(i); drawWave();
  }
  async function addNoteAt(i) {
    const txt = await askText("Nota al minuto " + fmtT(segs[i].start), "Scrivi la nota…"); if (!txt) return;
    const body = { kind: "note", t0: segs[i].start, text: txt }; const r = await api(`/api/transcripts/${id}/annotations`, { json: body }); ann.push({ id: r.id, ...body }); paintSeg(i);
  }
  async function editNote(a, i) {
    const inp = h("input", { type: "text", value: a.text });
    const r = await modal("Nota · " + fmtT(a.t0), inp, [["Elimina", () => "del", "danger"], ["Annulla", null], ["Salva", () => "save", "primary"]]);
    if (r === "del") { await api("/api/annotations/" + a.id, { method: "DELETE" }); ann = ann.filter(x => x.id !== a.id); }
    else if (r === "save" && inp.value.trim()) { await api("/api/annotations/" + a.id, { method: "PATCH", json: { text: inp.value.trim() } }); a.text = inp.value.trim(); }
    rows.forEach((_, k) => paintSeg(k)); drawWave();
  }

  /* ---------- segmenti ---------- */
  const spkLabel = s => speakers && s.speaker && speakers[s.speaker] ? speakers[s.speaker].label : null;
  const isOther = s => !!s.off_topic || (multiSpk && teacher && s.speaker && s.speaker !== teacher);
  function renderText(i) {
    const s = segs[i], r = rows[i], el = r.txt;
    if (S.listen) {
      el.contentEditable = "false"; const wt = wordTimes(i);
      el.replaceChildren(wt.toks.map((w, k) => h("span", { class: "w", "data-k": k }, w + " ")));
    } else {
      el.contentEditable = "plaintext-only"; if (el.contentEditable !== "plaintext-only") el.contentEditable = "true"; el.textContent = s.text;
    }
  }
  function paintSeg(i) {
    const r = rows[i], s = segs[i]; r.row.classList.toggle("hl", hlOverlap(s).length > 0);
    r.row.classList.toggle("hidden", !S.showOthers && isOther(s)); r.row.classList.toggle("other", isOther(s));
    r.spk.replaceChildren(s.off_topic ? h("button", { class: "spk other", title: "Riporta questa parte nella lezione", onclick: async () => { await api(`/api/transcripts/${id}/off-topic`, { json: { edits: [i], off_topic: [] } }); delete s.off_topic; paintSeg(i); toast("Riportata nella lezione"); } }, "fuori tema ↺")
      : spkLabel(s) && multiSpk ? h("button", { class: "spk" + (isOther(s) ? " other" : ""), title: "Cambia parlante", onclick: () => reassign(i) }, spkLabel(s)) : null);
    r.notes.replaceChildren(notesOf(i).map(a => h("button", { class: "notechip", title: "Modifica o elimina la nota", onclick: () => editNote(a, i) }, "✎ " + a.text)));
    r.star.classList.toggle("on", hlOverlap(s).length > 0);
  }
  async function reassign(i) {
    const sel = h("select", null, Object.entries(speakers).map(([k, v]) => h("option", { value: k, selected: segs[i].speaker === k }, v.label)));
    const r = await modal("Chi parla in questo segmento?", sel, [["Annulla", null], ["OK", () => sel.value, "primary"]]);
    if (r) { segs[i].speaker = r; await api("/api/transcripts/" + id, { method: "PATCH", json: { edits: [{ i, speaker: r }] } }); paintSeg(i); }
  }
  segs.forEach((s, i) => {
    const txt = h("div", { class: "txt", spellcheck: "true", lang: t.language === "auto" ? (t.detected_language || "it") : t.language });
    const spk = h("div"), notes = h("div", { class: "notes" });
    const star = h("button", { class: "tool", title: "Evidenzia / togli evidenziazione", "aria-label": "Evidenzia", onclick: () => toggleHighlight(i).catch(e => toast(e.message)) }, "★");
    const nbtn = h("button", { class: "tool", title: "Aggiungi una nota", "aria-label": "Nota", onclick: () => addNoteAt(i).catch(e => toast(e.message)) }, "✎");
    txt.addEventListener("input", () => { s.text = txt.textContent; wcache.delete(i); dirty.add(i); saveState.textContent = "Modifiche non salvate…"; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 900); });
    txt.addEventListener("click", e => {
      if (S.listen) { const w = e.target.closest(".w"); if (w) seekTo(wordTimes(i).times[+w.dataset.k][0]); else seekTo(s.start); return; }
      const sel = getSelection(); if (!sel.isCollapsed || !sel.anchorNode) return; seekTo(editWordTime(i, txt, sel));
    });
    txt.addEventListener("blur", flush);
    const row = h("div", { class: "seg", "data-i": i }, h("div", { class: "segl" }, h("button", { class: "ts", onclick: () => seekTo(s.start), title: "Vai a questo punto" }, fmtT(s.start)), spk),
      h("div", { class: "segm" }, txt, notes), h("div", { class: "tools" }, star, nbtn));
    list.append(row); rows.push({ row, txt, spk, notes, star });
  });
  function applyView() { rows.forEach((_, i) => { renderText(i); paintSeg(i); }); curWord = -1; activeIdx = -1; list.classList.toggle("listen", S.listen); syncPlayback(true); }
  function editWordTime(i, el, sel) {
    const r = document.createRange(); r.setStart(el, 0); try { r.setEnd(sel.anchorNode, sel.anchorOffset); } catch { return segs[i].start; }
    const before = r.toString(), idx = (before.match(/\S+/g) || []).length - (/\s$/.test(before) || before === "" ? 0 : 1);
    const wt = wordTimes(i); return wt.times[Math.max(0, Math.min(idx, wt.toks.length - 1))][0];
  }
  async function flush() {
    if (!dirty.size) return; const edits = [...dirty].map(i => ({ i, text: segs[i].text })); dirty.clear();
    try { await api("/api/transcripts/" + id, { method: "PATCH", json: { edits } }); saveState.textContent = "Salvato " + new Date().toLocaleTimeString("it-IT"); }
    catch (e) { edits.forEach(x => dirty.add(x.i)); saveState.textContent = "Salvataggio fallito: " + e.message; }
  }
  function seekTo(sec) { audioEl.currentTime = Math.max(0, sec); audioEl.play().catch(() => {}); }

  /* ---------- riproduzione sincronizzata: segmento e parola correnti ---------- */
  function syncPlayback(force) {
    const now = audioEl.currentTime; let lo = 0, hi = segs.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].start <= now + 0.05) { k = m; lo = m + 1; } else hi = m - 1; }
    while (k > 0 && !S.showOthers && isOther(segs[k])) k--;       // le voci nascoste non diventano "attive"
    if (k !== activeIdx || force) {
      if (activeIdx >= 0 && rows[activeIdx]) { rows[activeIdx].row.classList.remove("active"); rows[activeIdx].txt.querySelectorAll(".w.done,.w.cur").forEach(w => w.classList.remove("done", "cur")); }
      activeIdx = k; curWord = -1;
      if (k >= 0) { rows[k].row.classList.add("active"); if (S.follow && !audioEl.paused && Date.now() - lastUser > 4000 && document.activeElement !== rows[k].txt) rows[k].row.scrollIntoView({ block: "center", behavior: "smooth" }); }
    }
    if (S.listen && k >= 0) {
      const wt = wordTimes(k); let w = -1; for (let j = 0; j < wt.times.length; j++) { if (wt.times[j][0] <= now + 0.02) w = j; else break; }
      if (now > segs[k].end + 0.6) w = wt.times.length;    // oltre la fine del segmento: tutto "detto"
      if (w !== curWord) { const ws = rows[k].txt.children; for (let j = 0; j < ws.length; j++) { ws[j].classList.toggle("done", j < w); ws[j].classList.toggle("cur", j === w); } curWord = w; }
    }
    list.classList.toggle("playing", !audioEl.paused || now > 0);
    const d = audioEl.duration || t.duration; seek.value = d ? now / d * 1000 : 0; timeLbl.textContent = fmtT(now) + " / " + fmtT(d); drawWave();
  }
  let raf = 0; const loop = () => { syncPlayback(); raf = audioEl.paused ? 0 : requestAnimationFrame(loop); };
  audioEl.addEventListener("play", () => { if (!raf) raf = requestAnimationFrame(loop); }); audioEl.addEventListener("pause", () => syncPlayback()); audioEl.addEventListener("seeked", () => syncPlayback()); audioEl.addEventListener("timeupdate", () => { if (!raf) syncPlayback(); });
  ["wheel", "touchmove"].forEach(ev => window.addEventListener(ev, () => { lastUser = Date.now(); }, { passive: true }));
  whileMounted(list, () => { cancelAnimationFrame(raf); window.removeEventListener("keydown", keys); });
  const keys = e => { if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable || document.querySelector("dialog[open]")) return;
    if (e.code === "Space") { e.preventDefault(); audioEl.paused ? audioEl.play() : audioEl.pause(); } else if (e.code === "ArrowLeft") audioEl.currentTime -= 5; else if (e.code === "ArrowRight") audioEl.currentTime += 5; };
  window.addEventListener("keydown", keys);

  const speeds = h("div", { class: "speeds" }, [0.75, 1, 1.25, 1.5, 2].map(v => h("button", { class: v === 1 ? "on" : "", onclick: e => { audioEl.playbackRate = v; speeds.querySelectorAll("button").forEach(b => b.classList.remove("on")); e.target.classList.add("on"); } }, v.toString().replace(".", ",") + "×")));
  function drawWave() {
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, hh = canvas.clientHeight; if (!w) return; canvas.width = w * dpr; canvas.height = hh * dpr;
    const c = canvas.getContext("2d"); c.scale(dpr, dpr); c.clearRect(0, 0, w, hh);
    const cs = getComputedStyle(document.documentElement), col = cs.getPropertyValue("--mute").trim() || "#888", acc = cs.getPropertyValue("--accent").trim() || "#26e";
    const dur = audioEl.duration || t.duration, pos = dur ? audioEl.currentTime / dur : 0;
    c.fillStyle = "rgba(250,204,21,.35)"; ann.filter(a => a.kind === "highlight").forEach(a => { c.fillRect(a.t0 / dur * w, 0, Math.max(2, ((a.t1 ?? a.t0) - a.t0) / dur * w), hh); });
    if (peaks.length) { const n = peaks.length, mx = Math.max(...peaks) || 1; for (let x = 0; x < w; x++) { const p = peaks[Math.min(n - 1, (x / w * n) | 0)] / mx; c.fillStyle = x / w < pos ? acc : col; c.fillRect(x, hh / 2 - p * hh / 2 + 1, 1, Math.max(1, p * hh - 2)); } }
    else { c.fillStyle = col; c.fillRect(0, hh / 2, w, 1); }
    c.fillStyle = "#1d4ed8"; ann.filter(a => a.kind === "note").forEach(a => { c.beginPath(); c.arc(a.t0 / dur * w, 6, 4, 0, 7); c.fill(); });
    c.fillStyle = acc; c.fillRect(pos * w, 0, 2, hh);
  }
  api(`/api/transcripts/${id}/waveform`).then(w => { peaks = w.peaks; drawWave(); }).catch(() => {});
  const seekCanvas = e => { const r = canvas.getBoundingClientRect(); audioEl.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (audioEl.duration || t.duration); };
  canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); seekCanvas(e); canvas.onpointermove = seekCanvas; }); canvas.addEventListener("pointerup", () => canvas.onpointermove = null);
  seek.oninput = () => audioEl.currentTime = seek.value / 1000 * (audioEl.duration || t.duration);
  addEventListener("resize", drawWave);

  /* ---------- ricerca ---------- */
  const count = h("span", { class: "m" });
  const search = h("input", { type: "search", placeholder: "Cerca nel testo…", oninput: () => doSearch(search.value) });
  function doSearch(q) {
    const nq = norm(q.trim()); let n = 0; const ranges = [];
    rows.forEach(({ row, txt }, i) => {
      const other = !S.showOthers && isOther(segs[i]), hit = !nq || norm(segs[i].text).includes(nq); row.classList.toggle("hidden", other || !hit);
      if (hit && !other && nq) { const tn = !S.listen && txt.firstChild; const nt = norm(segs[i].text); let p = 0; while ((p = nt.indexOf(nq, p)) >= 0) { if (tn) try { const r = new Range(); r.setStart(tn, p); r.setEnd(tn, p + nq.length); ranges.push(r); } catch {} n++; p += nq.length; } }
    });
    if (window.CSS && CSS.highlights) CSS.highlights.set("search", new Highlight(...ranges));
    count.textContent = nq ? `${n} risultati` : "";
  }

  /* ---------- modalità A/B/C ---------- */
  const body = h("div"), tabs = h("div", { class: "tabs" }), expOpt = () => ({ mode: S.mode, teacher_only: !S.showOthers, notes: EXP.notes });
  ["fedele", "pulita", "appunti"].forEach(m => tabs.append(h("button", { "data-m": m, class: m === "fedele" ? "on" : "", onclick: () => setMode(m) }, { fedele: "A · Fedele", pulita: "B · Pulita", appunti: "C · Appunti" }[m])));
  async function setMode(m) {
    await flush(); S.mode = m; tabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.m === m)); viewBar.style.display = m === "fedele" ? "" : "none";
    if (m === "fedele") return body.replaceChildren(list);
    body.replaceChildren(h("span", { class: "spin" }));
    try {
      if (m === "appunti" && !((await api("/api/transcripts/" + id)).stats || {}).notes) throw new Error("Appunti non ancora generati.");
      const r = await api(`/api/transcripts/${id}/render?mode=${m}&teacher_only=${!S.showOthers}`);
      body.replaceChildren(h("div", { class: "notice" }, r.note), h("div", { class: "reading", style: "margin-top:12px" }, r.text),
        h("button", { style: "margin-top:12px", onclick: async () => toast((await copyText(r.text)) ? "Copiato" : "Copia bloccata dal browser") }, "⧉ Copia testo"));
    } catch (e) {
      if (m !== "appunti") return body.replaceChildren(h("div", { class: "notice bad" }, e.message));
      const sel = h("select", null, sys.llm_models.map(x => h("option", null, x))); const stt = (await api("/api/transcripts/" + id)).stats || {};
      body.replaceChildren(h("div", { class: "notice" + (sys.llm_models.length ? "" : " warn") }, sys.llm_models.length ? "Gli appunti sono una rielaborazione generata da un LLM locale (Ollama): non sono testo pronunciato e possono contenere errori. Verifica sempre sul testo fedele."
          : "Nessun LLM locale rilevato (Ollama non raggiunto). Gli appunti strutturati richiedono un modello linguistico locale: i modelli ASR non rielaborano il testo. Installa Ollama e un modello (vedi README)."),
        stt.notes_status === "running" && h("p", null, h("span", { class: "spin" }), " Generazione in corso con " + stt.notes_llm + "…"), stt.notes_status === "error" && h("p", { class: "err" }, stt.notes_error),
        sys.llm_models.length > 0 && h("div", { class: "row", style: "margin-top:12px" }, sel, h("button", { class: "primary", onclick: async () => { try { await api(`/api/transcripts/${id}/study-notes`, { json: { llm: sel.value } }); toast("Generazione avviata"); const iv = setInterval(async () => { const s2 = (await api("/api/transcripts/" + id)).stats || {}; if (s2.notes_status !== "running") { clearInterval(iv); setMode("appunti"); } }, 3000); timers.push(iv); } catch (er) { toast(er.message, 6000); } } }, "Genera appunti")));
    }
  }

  /* ---------- barra comandi ---------- */
  const sugBox = h("div");
  api(`/api/transcripts/${id}/suggestions`).then(r => { if (!r.suggestions.length) return; sugBox.replaceChildren(h("details", { class: "notice" }, h("summary", null, `${r.suggestions.length} possibili correzioni dal glossario (da confermare)`),
    r.suggestions.slice(0, 40).map(s => h("div", { class: "row", style: "margin:4px 0" }, h("span", null, `${fmtT(segs[s.seg].start)} “${s.word}” → “${s.term}”`), h("button", { class: "small", onclick: e => { segs[s.seg].text = segs[s.seg].text.replace(s.word, s.term); wcache.delete(s.seg); renderText(s.seg); dirty.add(s.seg); flush(); e.target.disabled = true; } }, "Applica"))))); }).catch(() => {});
  const exp = h("select", { "aria-label": "Esporta", onchange: e => { if (e.target.value) { downloadUrl(`/api/transcripts/${id}/export/${e.target.value}?` + new URLSearchParams({ mode: S.mode, teacher_only: !S.showOthers, notes: EXP.notes })); e.target.value = ""; } } },
    h("option", { value: "" }, "⇩ Esporta…"), ["pdf", "docx", "txt", "srt", "vtt", "json"].map(f => h("option", { value: f }, f.toUpperCase())));
  const viewBar = h("div", { class: "tabs" }, h("button", { class: S.listen ? "on" : "", onclick: e => setView(true, e) }, "▶ Ascolto"), h("button", { class: S.listen ? "" : "on", onclick: e => setView(false, e) }, "✎ Modifica"));
  function setView(l, e) { flush(); S.listen = l; LS.set("ed_listen", l ? "1" : "0"); viewBar.querySelectorAll("button").forEach((b, k) => b.classList.toggle("on", (k === 0) === l)); applyView(); }
  const werBox = h("details", null, h("summary", null, "Calcola il WER con una trascrizione di riferimento verificata"), h("p", null, "Incolla una trascrizione corretta a mano. Il WER ha senso solo con un riferimento affidabile."),
    h("textarea", { placeholder: "Testo di riferimento…" }), h("button", { onclick: async () => { try { const r = await api(`/api/transcripts/${id}/wer`, { json: { reference: werBox.querySelector("textarea").value } }); toast(`WER ${(r.wer * 100).toFixed(1)}% (${r.edits} errori su ${r.ref_words} parole)`, 8000); } catch (e) { toast(e.message); } } }, "Calcola"));
  const precision = t.has_word_ts ? "Timestamp a livello di parola: nella vista Ascolto la parola corrente è evidenziata e puoi cliccare qualsiasi parola per ripartire da lì. Nei segmenti che modifichi l'evidenziazione diventa una stima proporzionale."
    : "Questo modello fornisce timestamp solo per segmento (finestre di ~18 s): la parola evidenziata durante l'ascolto è una STIMA proporzionale alla lunghezza delle parole, non un tempo misurato.";
  const title = h("input", { type: "text", value: t.title, class: "title-in", onchange: e => api("/api/transcripts/" + id, { method: "PATCH", json: { title: e.target.value } }).then(() => toast("Titolo salvato")) });
  const followCb = h("input", { type: "checkbox", checked: true, onchange: e => S.follow = e.target.checked });

  const spkPanel = multiSpk ? h("details", { class: "notice", open: false }, h("summary", null, `Parlanti riconosciuti: ${Object.values(speakers).map(v => v.label).join(", ")}`),
    h("p", { class: "m" }, "L'insegnante è presunto il parlante con più parlato: se è sbagliato, cambialo qui. Le altre voci sono nascoste e escluse da copia/PDF a meno che tu non le mostri."),
    Object.entries(speakers).map(([k, v]) => h("div", { class: "row", style: "margin:6px 0" }, h("input", { type: "text", value: v.label, style: "max-width:180px", onchange: async e => { await api(`/api/transcripts/${id}/speakers`, { method: "PATCH", json: { id: k, label: e.target.value } }); toast("Salvato"); route(); } }),
      h("label", { class: "opt" }, h("input", { type: "radio", name: "tch", checked: v.teacher, onchange: async () => { await api(`/api/transcripts/${id}/speakers`, { method: "PATCH", json: { id: k, teacher: true } }); route(); } }), "è l'insegnante"), h("span", { class: "m" }, fmtT(v.seconds) + " di parlato")))) : null;
  const othersCb = (multiSpk || hasOff) ? h("label", { class: "opt" }, h("input", { type: "checkbox", onchange: e => { S.showOthers = e.target.checked; rows.forEach((_, i) => paintSeg(i)); doSearch(search.value); if (S.mode !== "fedele") setMode(S.mode); } }), "Mostra anche le altre voci e le parti fuori tema") : null;

  const recomp = h("select", { "aria-label": "Ritrascrivi con" }); api("/api/models?language=" + (t.language === "auto" ? "it" : t.language)).then(r => { [...r.models, ...r.fast].filter(m => m.compatible && m.installed).forEach(m => recomp.append(h("option", { value: m.id }, m.name))); });
  const live = t.kind === "live";
  const aiHost = h("div", { style: "margin-bottom:10px" });
  buildAIPanel({ id, t, seekTo, reload: () => route() }).then(p => aiHost.replaceChildren(p)).catch(() => {});

  $app.replaceChildren(
    h("div", { class: "row sp" }, title, h("div", { class: "row" },
      h("button", { onclick: async () => { try { await copyTranscripts([id], expOpt()); } catch (e) { toast(e.message); } } }, "⧉ Copia"), exp,
      h("button", { onclick: () => shareAudio([{ id, title: t.title }]) }, "↗ Condividi audio"),
      h("button", { onclick: async () => { const sel = h("select", null, folderOptions().map(o => h("option", { value: o.id, selected: (o.id || null) === (t.folder_id || null) }, o.label))); const r = await modal("Sposta in…", sel, [["Annulla", null], ["Sposta", () => ({ v: sel.value }), "primary"]]); if (r) { await api("/api/transcripts/" + id, { method: "PATCH", json: { set_folder: true, folder_id: r.v || null } }); toast("Spostata"); route(); } } }, "📁 " + (t.folder_path || "Senza cartella")),
      h("button", { class: "danger", onclick: async () => { if (confirm("Eliminare definitivamente trascrizione e file audio?")) { await api("/api/transcripts/" + id, { method: "DELETE" }); location.hash = "#/"; } } }, "Elimina"))),
    h("div", { class: "m" }, [live ? "● registrazione live" : null, mname(t.model_id), t.language === "auto" ? "lingua rilevata: " + (t.detected_language || "n/d") : t.language, st.words && `${st.words} parole`, st.elapsed_s != null && !live && `elaborata in ${fmtT(st.elapsed_s)}`, st.realtime_factor && !live && !st.diarized && `${speedText(st.realtime_factor)}`, st.peak_rss_mb && `RAM di picco ${st.peak_rss_mb} MB`].filter(Boolean).join(" · ")),
    live && h("div", { class: "notice", style: "margin-top:10px" }, "Trascritta in diretta con un modello veloce? Ritrascrivi lo stesso audio con uno più accurato: ", recomp, h("button", { class: "small", onclick: async () => { try { const r = await api(`/api/transcripts/${id}/retranscribe`, { json: { model_id: recomp.value } }); location.hash = "#/t/" + r.id; } catch (e) { toast(e.message, 6000); } } }, "Ritrascrivi")),
    h("div", { class: "editor", style: "margin-top:16px" },
      h("div", { class: "player card" }, audioEl, canvas, seek, timeLbl, speeds, h("label", { class: "opt" }, followCb, "Segui la riproduzione"), h("div", { class: "m" }, "Barra spaziatrice: play/pausa · ←/→: ±5 s")),
      h("div", null, h("div", { class: "notice", style: "margin-bottom:10px" }, precision), spkPanel, sugBox, aiHost,
        h("div", { class: "row sp", style: "margin:12px 0" }, h("div", { class: "row" }, tabs, viewBar), h("div", { class: "row" }, search, count, saveState)), othersCb, body, werBox)));
  body.replaceChildren(list); applyView(); drawWave();
  if (live && st.recovered) toast("Registrazione recuperata dopo un'interruzione.", 6000);
  const m0 = (t.options || {}).mode; if (m0 === "pulita" || m0 === "appunti") setMode(m0);
}]);
