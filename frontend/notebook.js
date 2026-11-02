"use strict";
/* Quaderno: testo ricco modificabile (come Word / Note di Apple) + inchiostro con Apple Pencil (penna, evidenziatore, frecce, gomma).
   - Il testo è un contenteditable; il disegno è un livello vettoriale ANCORATO al paragrafo vicino: se modifichi il testo sopra,
     i disegni si spostano con il loro paragrafo. I tratti sono salvati come punti, non come immagini.
   - Il canvas copre solo la porzione visibile (iOS limita la dimensione dei canvas), quindi funziona anche con documenti lunghissimi.
   - Per il PDF con i disegni: "Stampa / PDF" (il disegno viene rigenerato in SVG vettoriale su tutto il documento). */
const NB_COLORS = ["#111827", "#2563eb", "#dc2626", "#16a34a", "#f59e0b"];
const NB_SIZES = [2, 4, 7];

ROUTES.push([/^#\/n\/(\w+)$/, async id => {
  const t = await api("/api/transcripts/" + id);
  let nb = await api(`/api/transcripts/${id}/notebook`);
  const hasSpk = !!((t.stats || {}).speakers && Object.keys(t.stats.speakers).length > 1);
  if (!nb.exists) {
    const to = h("input", { type: "checkbox", checked: true }), nt = h("input", { type: "checkbox", checked: true });
    $app.replaceChildren(h("a", { href: "#/t/" + id, class: "m" }, "← " + (t.title || "Trascrizione")), h("h1", null, "📓 Quaderno"),
      h("p", { class: "sub" }, "Un documento di testo libero, come Word o le Note di Apple, partendo dal testo della trascrizione: puoi correggere, cancellare, scrivere con la tastiera e disegnare o scrivere a mano con l'Apple Pencil."),
      h("div", { class: "notice" }, "Il quaderno è una copia di lavoro: le modifiche qui non cambiano la trascrizione sincronizzata (timestamp e audio), che resta com'è. Ogni paragrafo ha un ▶ per riascoltare quel punto."),
      hasSpk && h("label", { class: "opt" }, to, "Solo l'insegnante (escludi le altre voci)"), h("label", { class: "opt" }, nt, "Includi le mie note ed evidenziazioni"),
      h("div", { class: "row", style: "margin-top:14px" }, h("button", { class: "primary", onclick: async () => { try { nb = await api(`/api/transcripts/${id}/notebook/create`, { json: { teacher_only: to.checked, include_notes: nt.checked } }); route(); } catch (e) { toast(e.message, 6000); } } }, "Crea il quaderno")));
    return;
  }
  const S = { tool: "text", color: NB_COLORS[0], size: NB_SIZES[1], finger: false };
  let strokes = nb.ink || [], undo = [], redo = [], saveT, savedRange = null, penActive = false, scrollP = null, cur = null, dirtyFlag = false;
  const saveState = h("span", { class: "save-state" }, "Salvato");

  const doc = h("div", { class: "nb-doc", contenteditable: "true", spellcheck: "true", lang: t.language === "auto" ? (t.detected_language || "it") : t.language, "aria-label": "Quaderno" });
  doc.innerHTML = nb.html || "<p><br></p>";
  const canvas = h("canvas", { class: "nb-ink" });
  const wrap = h("div", { class: "nb-wrap" }, canvas, doc);
  const ctx = canvas.getContext("2d");
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch {}

  /* ---------- blocchi e ancore ---------- */
  let bidN = 0; const newBid = () => "n" + Date.now().toString(36) + (bidN++).toString(36);
  function ensureBids() {   // ogni blocco di primo livello ha un id unico (Invio nel contenteditable duplica gli attributi: il primo mantiene l'id)
    const seen = new Set();
    for (const el of doc.children) { let b = el.getAttribute("data-bid"); if (!b || seen.has(b)) { b = newBid(); el.setAttribute("data-bid", b); } seen.add(b); }
    if (!doc.children.length) { doc.innerHTML = "<p><br></p>"; ensureBids(); }
  }
  const blockEl = bid => bid ? doc.querySelector(`[data-bid="${CSS.escape(bid)}"]`) : null;
  const docTop = () => doc.getBoundingClientRect().top, docRect = () => doc.getBoundingClientRect();
  const blockTop = el => el.getBoundingClientRect().top - docTop();
  function blockAtY(y) {   // blocco che contiene (o precede) l'ordinata y rispetto al documento
    let best = doc.firstElementChild; const base = docTop();
    for (const el of doc.children) { if (el.getBoundingClientRect().top - base <= y) best = el; else break; }
    return best;
  }

  /* ---------- disegno ---------- */
  function toClient(s, p, dr) {   // punto di un tratto -> coordinate client
    const el = blockEl(s.a), top = el ? blockTop(el) : s.fy;
    return [dr.left + p[0] * dr.width, dr.top + top + p[1]];
  }
  function sizeCanvas() {
    const dpr = devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function paintStroke(c, s, pts, widthScale = 1) {
    c.save(); c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = s.c; c.fillStyle = s.c;
    if (s.t === "hl") { c.globalAlpha = 0.35; c.globalCompositeOperation = "multiply"; c.lineWidth = s.w * 3 * widthScale; }
    if (s.t === "arrow" && pts.length > 1) {
      const [a, b] = [pts[0], pts[pts.length - 1]], ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = Math.max(12, s.w * 4.5);
      c.lineWidth = s.w * widthScale; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      c.beginPath(); c.moveTo(b[0], b[1]); c.lineTo(b[0] - hl * Math.cos(ang - 0.42), b[1] - hl * Math.sin(ang - 0.42)); c.moveTo(b[0], b[1]); c.lineTo(b[0] - hl * Math.cos(ang + 0.42), b[1] - hl * Math.sin(ang + 0.42)); c.stroke();
    } else if (s.t === "hl") {
      c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); if (pts.length === 1) c.lineTo(pts[0][0] + 0.1, pts[0][1]); c.stroke();
    } else {   // penna: spessore in base alla pressione, curva liscia
      if (pts.length === 1) { c.beginPath(); c.arc(pts[0][0], pts[0][1], s.w * widthScale / 2, 0, 7); c.fill(); }
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1], p1 = pts[i], pr = ((p0[2] ?? 0.5) + (p1[2] ?? 0.5)) / 2;
        c.lineWidth = s.w * widthScale * (0.4 + pr * 1.2); c.beginPath();
        const m0 = i > 1 ? [(pts[i - 2][0] + p0[0]) / 2, (pts[i - 2][1] + p0[1]) / 2] : p0, m1 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        c.moveTo(m0[0], m0[1]); c.quadraticCurveTo(p0[0], p0[1], m1[0], m1[1]); c.stroke();
      }
    }
    c.restore();
  }
  function redraw() {
    sizeCanvas(); const r = canvas.getBoundingClientRect(), dr = docRect(); ctx.clearRect(0, 0, r.width, r.height);
    for (const s of strokes) {
      const pts = s.p.map(p => { const [x, y] = toClient(s, p, dr); return [x - r.left, y - r.top, p[2]]; });
      let miny = Infinity, maxy = -Infinity; for (const q of pts) { if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
      if (maxy < -30 || miny > r.height + 30) continue;      // fuori dalla porzione visibile
      paintStroke(ctx, s, pts);
    }
    if (cur) { const pts = cur.p.map(p => { const [x, y] = toClient(cur, p, dr); return [x - r.left, y - r.top, p[2]]; }); paintStroke(ctx, cur, pts); }
  }
  let rq = 0; const redrawSoon = () => { if (!rq) rq = requestAnimationFrame(() => { rq = 0; redraw(); }); };
  addEventListener("scroll", redrawSoon, { passive: true }); addEventListener("resize", redrawSoon);
  const ro = new ResizeObserver(redrawSoon); ro.observe(doc);

  const layoutBars = () => { const top = (document.querySelector(".topbar")?.offsetHeight || 0) + (bar.offsetHeight || 0), bot = player.offsetHeight || 0; wrap.style.setProperty("--nb-top", top + "px"); wrap.style.setProperty("--nb-h", `calc(100vh - ${top + bot}px)`); bar.style.top = (document.querySelector(".topbar")?.offsetHeight || 0) + "px"; redrawSoon(); };

  /* ---------- salvataggio automatico ---------- */
  function markDirty() { dirtyFlag = true; saveState.textContent = "Modifiche non salvate…"; clearTimeout(saveT); saveT = setTimeout(save, 1200); }
  async function save() {
    if (!dirtyFlag) return; clearTimeout(saveT); dirtyFlag = false; ensureBids();
    try { const r = await api(`/api/transcripts/${id}/notebook`, { method: "PUT", json: { html: doc.innerHTML, ink: strokes } }); saveState.textContent = "Salvato " + new Date().toLocaleTimeString("it-IT") + (r.strokes ? ` · ${r.strokes} tratti` : ""); }
    catch (e) { dirtyFlag = true; saveState.textContent = "Salvataggio fallito: " + e.message; }
  }
  doc.addEventListener("input", () => { ensureBids(); markDirty(); redrawSoon(); });
  whileMounted(wrap, () => { save(); removeEventListener("scroll", redrawSoon); removeEventListener("resize", redrawSoon); ro.disconnect(); window.removeEventListener("beforeprint", bp); window.removeEventListener("afterprint", ap); delete window.__nb; delete window.__nbPrint; });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });

  /* ---------- selezione/formattazione del testo ---------- */
  document.addEventListener("selectionchange", () => { const s = getSelection(); if (s.rangeCount && doc.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); });
  function cmd(name, arg) {
    if (S.tool !== "text") setTool("text");
    doc.focus(); if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
    try { document.execCommand(name, false, arg); } catch {} ensureBids(); markDirty(); redrawSoon();
  }
  const HL = "#fde68a";
  function toggleHighlight() { const cur = (document.queryCommandValue("hiliteColor") || document.queryCommandValue("backColor") || "").toString().replace(/\s/g, ""); cmd("hiliteColor", /253,230,138|fde68a/i.test(cur) ? "transparent" : HL); }
  function insertSpace() {
    ensureBids(); const sel = getSelection(); let node = sel.anchorNode && doc.contains(sel.anchorNode) ? sel.anchorNode : doc.lastChild; while (node && node.parentNode !== doc) node = node.parentNode;
    const sp = h("div", { class: "nb-space", "data-bid": newBid() }, h("br")), p = h("p", { "data-bid": newBid() }, h("br"));
    if (node) { node.after(sp); sp.after(p); } else { doc.append(sp, p); } markDirty(); redrawSoon();
  }
  doc.addEventListener("click", e => {   // ▶ accanto ai paragrafi: riascolta quel punto
    const chip = e.target.closest && e.target.closest(".nb-ts"); if (!chip) return; const blk = chip.closest("[data-t]"); const sec = blk ? parseFloat(blk.getAttribute("data-t")) : NaN;
    if (!isNaN(sec)) { audio.currentTime = Math.max(0, sec); audio.play().catch(() => {}); }
  });

  /* ---------- strumenti ---------- */
  function setTool(tl) {
    S.tool = tl; const drawing = tl !== "text"; wrap.classList.toggle("drawing", drawing); canvas.style.pointerEvents = drawing ? "auto" : "none";
    if (drawing) { doc.blur(); getSelection().removeAllRanges(); }
    toolBtns.forEach(([k, b]) => b.classList.toggle("on", k === tl)); redrawSoon();
  }
  const pushOp = op => { undo.push(op); redo = []; markDirty(); };
  function doUndo() {
    if (S.tool === "text") return cmd("undo");
    const op = undo.pop(); if (!op) return; if (op.add) strokes = strokes.filter(s => s !== op.add); else strokes.push(...op.del); redo.push(op); markDirty(); redraw();
  }
  function doRedo() {
    if (S.tool === "text") return cmd("redo");
    const op = redo.pop(); if (!op) return; if (op.add) strokes.push(op.add); else strokes = strokes.filter(s => !op.del.includes(s)); undo.push(op); markDirty(); redraw();
  }
  const uid = () => Math.random().toString(36).slice(2, 10);

  function docPoint(e) { const dr = docRect(); return [(e.clientX - dr.left) / dr.width, e.clientY - dr.top, e.pointerType === "pen" ? (e.pressure || 0.5) : 0.5]; }
  function beginStroke(e) {
    ensureBids(); const pt = docPoint(e), el = blockAtY(pt[1]), top = blockTop(el), bid = el.getAttribute("data-bid");
    cur = { id: uid(), t: S.tool, c: S.tool === "hl" ? (S.color === NB_COLORS[0] ? "#facc15" : S.color) : S.color, w: S.size, a: bid, fy: top, p: [[pt[0], pt[1] - top, pt[2]]], _top: top };
  }
  function extendStroke(e) {
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of evs) {
      const pt = docPoint(ev), q = [pt[0], pt[1] - cur._top, pt[2]], last = cur.p[cur.p.length - 1];
      if (cur.t === "arrow") { cur.p = [cur.p[0], q]; continue; }
      if (Math.hypot((q[0] - last[0]) * docRect().width, q[1] - last[1]) >= 0.8) cur.p.push([+q[0].toFixed(4), +q[1].toFixed(1), +q[2].toFixed(2)]);
    }
  }
  function finishStroke() {
    if (!cur) return; const s = cur; cur = null; delete s._top; s.p = s.p.map(p => [+p[0].toFixed(4), +p[1].toFixed(1), +(p[2] ?? 0.5).toFixed(2)]);
    if (s.t === "arrow" && s.p.length < 2) { redraw(); return; }
    strokes.push(s); pushOp({ add: s }); redraw();
  }
  let erased = null;
  function eraseAt(e) {
    const dr = docRect(), r = Math.max(10, S.size * 3 + 6); let hit = false;
    for (const s of strokes.slice()) {
      const pts = s.p.map(p => toClient(s, p, dr)); let near = false;
      for (let i = 0; i < pts.length && !near; i++) {
        const a = pts[i], b = pts[i + 1] || a, dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, tt = Math.max(0, Math.min(1, ((e.clientX - a[0]) * dx + (e.clientY - a[1]) * dy) / l2));
        near = Math.hypot(e.clientX - (a[0] + tt * dx), e.clientY - (a[1] + tt * dy)) <= r + s.w / 2;
      }
      if (near) { strokes = strokes.filter(x => x !== s); (erased ||= []).push(s); hit = true; }
    }
    if (hit) redraw();
  }

  canvas.addEventListener("pointerdown", e => {
    if (S.tool === "text") return;
    if (e.pointerType === "touch" && !S.finger) { if (!penActive) { scrollP = { id: e.pointerId, y: e.clientY }; try { canvas.setPointerCapture(e.pointerId); } catch {} } return; }   // un dito scorre la pagina (palm rejection)
    if (e.pointerType === "touch" && penActive) return;
    e.preventDefault(); try { canvas.setPointerCapture(e.pointerId); } catch {} if (e.pointerType === "pen") penActive = true;
    if (S.tool === "eraser") { erased = []; eraseAt(e); return; }
    beginStroke(e); redraw();
  });
  canvas.addEventListener("pointermove", e => {
    if (scrollP && e.pointerId === scrollP.id) { window.scrollBy(0, scrollP.y - e.clientY); scrollP.y = e.clientY; return; }
    if (S.tool === "eraser") { if (erased) eraseAt(e); return; }
    if (cur) { extendStroke(e); redrawSoon(); }
  });
  const up = e => {
    if (scrollP && e.pointerId === scrollP.id) { scrollP = null; return; }
    if (e.pointerType === "pen") penActive = false;
    if (S.tool === "eraser") { if (erased && erased.length) pushOp({ del: erased }); erased = null; return; }
    finishStroke();
  };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);

  /* ---------- stampa / PDF con i disegni: ogni gruppo di tratti diventa un SVG vettoriale DENTRO il suo paragrafo ---------- */
  let printSvgs = [];
  function bp() {
    ensureBids(); const ns = "http://www.w3.org/2000/svg", W = docRect().width, by = new Map();
    for (const s of strokes) { const k = blockEl(s.a) ? s.a : "__orphan"; (by.get(k) || by.set(k, []).get(k)).push(s); }
    for (const [k, list] of by) {
      const host = k === "__orphan" ? doc : blockEl(k); if (!host) continue;
      const svg = document.createElementNS(ns, "svg"), H = k === "__orphan" ? Math.max(...list.map(s => s.fy + Math.max(...s.p.map(p => p[1]))), 10) + 20 : Math.max(host.getBoundingClientRect().height, ...list.map(s => Math.max(...s.p.map(p => p[1])) + 20));
      svg.setAttribute("class", "nb-print-ink"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("preserveAspectRatio", "none"); svg.style.height = H + "px";
      const mk = (name, attrs) => { const n = document.createElementNS(ns, name); for (const [kk, v] of Object.entries(attrs)) n.setAttribute(kk, v); n.setAttribute("vector-effect", "non-scaling-stroke"); svg.append(n); };
      for (const s of list) {
        const off = k === "__orphan" ? s.fy : 0, P = s.p.map(p => [p[0] * W, off + p[1], p[2]]), base = { stroke: s.c, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
        if (s.t === "hl") mk("polyline", { ...base, points: P.map(q => q.slice(0, 2).join(",")).join(" "), "stroke-width": s.w * 3, "stroke-opacity": 0.35, style: "mix-blend-mode:multiply" });
        else if (s.t === "arrow" && P.length > 1) { const a = P[0], bb = P[P.length - 1], ang = Math.atan2(bb[1] - a[1], bb[0] - a[0]), hl = Math.max(12, s.w * 4.5);
          mk("path", { ...base, "stroke-width": s.w, d: `M${a[0]},${a[1]} L${bb[0]},${bb[1]} M${bb[0]},${bb[1]} L${bb[0] - hl * Math.cos(ang - 0.42)},${bb[1] - hl * Math.sin(ang - 0.42)} M${bb[0]},${bb[1]} L${bb[0] - hl * Math.cos(ang + 0.42)},${bb[1] - hl * Math.sin(ang + 0.42)}` }); }
        else { const avg = P.reduce((acc, q) => acc + (q[2] ?? 0.5), 0) / P.length; mk("polyline", { ...base, points: P.map(q => q.slice(0, 2).join(",")).join(" "), "stroke-width": s.w * (0.4 + avg * 1.2) }); }
      }
      host.append(svg); printSvgs.push(svg);
    }
  }
  function ap() { printSvgs.forEach(n => n.remove()); printSvgs = []; }
  window.addEventListener("beforeprint", bp); window.addEventListener("afterprint", ap);
  window.__nbPrint = { bp, ap, count: () => printSvgs.length };

  /* ---------- interfaccia ---------- */
  const keep = e => e.preventDefault();      // i pulsanti non rubano la selezione del testo
  const tb = (label, title, fn, extra = {}) => h("button", Object.assign({ title, "aria-label": title, tabindex: "-1", onpointerdown: keep, onclick: fn }, extra), label);
  const toolBtns = [["text", "✎ Testo", "Scrivi e seleziona il testo (con Apple Pencil funziona anche Scribble)"], ["pen", "🖊 Penna", "Penna: scrivi o disegna"], ["hl", "🖍 Evidenz.", "Evidenziatore"], ["arrow", "➚ Freccia", "Freccia: trascina da dove a dove"], ["eraser", "⌫ Gomma", "Gomma: cancella i tratti che tocchi"]]
    .map(([k, l, ti]) => [k, tb(l, ti, () => setTool(k), { class: "tool-b" + (k === "text" ? " on" : "") })]);
  const swatches = NB_COLORS.map(c => h("button", { class: "sw" + (c === S.color ? " on" : ""), style: `background:${c}`, "aria-label": "Colore " + c, tabindex: "-1", onclick: e => { S.color = c; swatches.forEach(b => b.classList.toggle("on", b === e.currentTarget)); } }));
  const sizes = NB_SIZES.map(z => h("button", { class: "szb" + (z === S.size ? " on" : ""), "aria-label": "Spessore " + z, tabindex: "-1", onclick: e => { S.size = z; sizes.forEach(b => b.classList.toggle("on", b === e.currentTarget)); } }, h("i", { style: `width:${z * 2 + 4}px;height:${z * 2 + 4}px` })));
  const fingerCb = h("input", { type: "checkbox", onchange: e => { S.finger = e.target.checked; } });
  const exp = h("select", { "aria-label": "Esporta", onchange: async e => { const v = e.target.value; e.target.value = ""; if (v === "print") { await save(); window.print(); } else if (v === "copy") { toast((await copyText(doc.innerText)) ? "Testo copiato" : "Copia bloccata dal browser"); } else if (v) { await save(); downloadUrl(`/api/transcripts/${id}/notebook/export/${v}`); } } },
    h("option", { value: "" }, "⇩ Esporta…"), h("option", { value: "print" }, "PDF con disegni (Stampa)"), h("option", { value: "docx" }, "Word (.docx, solo testo)"), h("option", { value: "txt" }, "Testo (.txt)"), h("option", { value: "copy" }, "Copia il testo"));
  const more = h("select", { "aria-label": "Altro", onchange: async e => { const v = e.target.value; e.target.value = ""; if (v === "reset" && confirm("Ricreare il quaderno dalla trascrizione? Perderai testo e disegni di questo quaderno.")) { await api(`/api/transcripts/${id}/notebook/create`, { json: { force: true } }); route(); } else if (v === "del" && confirm("Eliminare il quaderno (testo e disegni)? La trascrizione resta.")) { await api(`/api/transcripts/${id}/notebook`, { method: "DELETE" }); location.hash = "#/t/" + id; } } },
    h("option", { value: "" }, "⋯ Altro"), h("option", { value: "reset" }, "Ricrea dalla trascrizione…"), h("option", { value: "del" }, "Elimina il quaderno…"));

  const bar = h("div", { class: "nb-bar" },
    h("div", { class: "row" }, h("a", { class: "btn small", href: "#/t/" + id }, "← Trascrizione"), h("b", { class: "nb-title" }, t.title || "Quaderno"), saveState, h("span", { class: "grow" }), exp, more),
    h("div", { class: "row nb-tools" },
      tb("B", "Grassetto", () => cmd("bold"), { class: "fmt b" }), tb("I", "Corsivo", () => cmd("italic"), { class: "fmt i" }), tb("U", "Sottolineato", () => cmd("underline"), { class: "fmt u" }),
      tb("H1", "Titolo", () => cmd("formatBlock", "<h1>")), tb("H2", "Sottotitolo", () => cmd("formatBlock", "<h2>")), tb("¶", "Testo normale", () => cmd("formatBlock", "<p>")),
      tb("•", "Elenco puntato", () => cmd("insertUnorderedList")), tb("1.", "Elenco numerato", () => cmd("insertOrderedList")), tb("🟨", "Evidenzia il testo selezionato", toggleHighlight), tb("Aa", "Togli la formattazione", () => cmd("removeFormat")),
      h("span", { class: "vr" }), toolBtns.map(([, b]) => b), h("span", { class: "vr" }), swatches, sizes,
      h("span", { class: "vr" }), tb("↶", "Annulla", doUndo), tb("↷", "Ripeti", doRedo), tb("＋ Disegno", "Inserisci uno spazio per disegnare", insertSpace),
      h("label", { class: "opt fing", title: "Di norma disegna solo la penna e il dito scorre la pagina (così il palmo non lascia segni)" }, fingerCb, "Disegna anche col dito")));
  const audio = h("audio", { src: withTok(`/api/transcripts/${id}/audio`), controls: true, preload: "metadata" });
  const player = h("div", { class: "nb-player" }, audio);
  $app.replaceChildren(h("div", { class: "nb-page" }, bar, wrap, player));
  ensureBids(); layoutBars(); setTimeout(layoutBars, 300); new ResizeObserver(layoutBars).observe(bar); addEventListener("resize", layoutBars); redraw();
  window.__nb = { strokes: () => strokes, redraw, S, setTool, ensureBids, save, doc, canvas, blockTop };   // per i test automatici
}]);
