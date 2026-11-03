"use strict";
/* Appunti a mano libera (stile Note / GoodNotes) con cartelle, e registrazione live che scrive la trascrizione DENTRO la pagina,
   con i modelli del server (più forti di quelli che girano nel browser). Il motore di scrittura è ink.js (lo stesso dell'app "Sul dispositivo"). */
const NOTES = { folder: LS.get("notes_folder", "all"), pages: [], q: "", sideOpen: false, loaded: false };
let InkMod = null;
async function loadInk() {
  if (!InkMod) { InkMod = await import("./ink.js"); const s = document.createElement("style"); s.textContent = InkMod.INK_CSS; document.head.append(s); }
  return InkMod;
}
const PAPER_NAMES = { blank: "Bianco", lines: "Righe", grid: "Quadretti", dots: "Puntini" };
const SIZE_NAMES = { a4: ["A4 verticale", 820, 1160], a4l: ["A4 orizzontale", 1160, 820], wide: ["Largo", 1400, 1000], inf: ["Infinito (si allunga)", 1100, 1600] };

/* ---------- elenco ---------- */
function notesInFolder() {
  let ps = NOTES.pages;
  if (NOTES.folder === "none") ps = ps.filter(p => !p.folder_id);
  else if (NOTES.folder !== "all") { const ids = new Set(); const walk = f => { ids.add(f); LIB.folders.filter(x => x.parent_id === f).forEach(x => walk(x.id)); }; walk(NOTES.folder); ps = ps.filter(p => ids.has(p.folder_id)); }
  return ps;
}
function notesCount(fid) { const ids = new Set(); const walk = f => { ids.add(f); LIB.folders.filter(x => x.parent_id === f).forEach(x => walk(x.id)); }; walk(fid); return NOTES.pages.filter(p => ids.has(p.folder_id)).length; }
function selectNotesFolder(id) { NOTES.folder = id; LS.set("notes_folder", id); drawNotes(); }

async function notesFolderMenu(f) {
  const body = h("div", { class: "grid" },
    h("button", { onclick: async () => { const n = await askText("Nuovo argomento in «" + f.name + "»", "Nome dell'argomento"); if (n) { await api("/api/folders", { json: { name: n, parent_id: f.id } }); document.querySelector("dialog")?.close(); await loadNotes(); } } }, "＋ Nuovo argomento qui dentro"),
    h("button", { onclick: async () => { const n = await askText("Rinomina", "Nome", f.name); if (n) { await api("/api/folders/" + f.id, { method: "PATCH", json: { name: n } }); document.querySelector("dialog")?.close(); await loadNotes(); } } }, "Rinomina"),
    h("button", { class: "danger", onclick: async () => { if (await confirmBox(`Eliminare la cartella «${f.name}»? Appunti e registrazioni NON vengono eliminati: restano nella cartella superiore.`, { ok: "Elimina", danger: true })) { await api("/api/folders/" + f.id, { method: "DELETE" }); document.querySelector("dialog")?.close(); if (NOTES.folder === f.id) { NOTES.folder = "all"; LS.set("notes_folder", "all"); } await loadNotes(); } } }, "Elimina cartella"));
  await modal("📁 " + f.name, body);
}
function notesFolderNode(f, depth) {
  const kids = LIB.folders.filter(x => x.parent_id === f.id), n = notesCount(f.id);
  return h("div", null,
    h("div", { class: "frow" + (NOTES.folder === f.id ? " on" : ""), style: `padding-left:${8 + depth * 16}px` },
      h("button", { class: "fname", onclick: () => selectNotesFolder(f.id) }, (depth ? "◦ " : "📁 ") + f.name, h("span", { class: "cnt" }, n || "")),
      h("button", { class: "fmore", title: "Gestisci cartella", "aria-label": "Gestisci " + f.name, onclick: () => notesFolderMenu(f) }, "⋯")),
    kids.map(k => notesFolderNode(k, depth + 1)));
}
function notesSidebar() {
  return h("aside", { class: "side" + (NOTES.sideOpen ? " open" : "") },
    h("div", { class: "frow" + (NOTES.folder === "all" ? " on" : "") }, h("button", { class: "fname", onclick: () => selectNotesFolder("all") }, "🗂 Tutte", h("span", { class: "cnt" }, NOTES.pages.length || ""))),
    h("div", { class: "frow" + (NOTES.folder === "none" ? " on" : "") }, h("button", { class: "fname", onclick: () => selectNotesFolder("none") }, "📥 Senza cartella", h("span", { class: "cnt" }, NOTES.pages.filter(p => !p.folder_id).length || ""))),
    h("div", { class: "side-title" }, "Materie e argomenti"),
    LIB.folders.filter(f => !f.parent_id).map(f => notesFolderNode(f, 0)),
    h("button", { class: "small", style: "margin:8px", onclick: async () => { const n = await askText("Nuova materia", "Es. Filosofia, Matematica, Storia…"); if (n) { await api("/api/folders", { json: { name: n } }); await loadNotes(); } } }, "＋ Nuova materia"));
}

async function noteMenu(p) {
  const fsel = h("select", null, folderOptions().map(o => h("option", { value: o.id, selected: (o.id || null) === (p.folder_id || null) }, o.label)));
  const body = h("div", { class: "grid" }, h("label", null, "Cartella"), fsel,
    h("button", { onclick: async () => { const n = await askText("Rinomina", "Titolo", p.title); if (n) { await api("/api/pages/" + p.id, { method: "PUT", json: { title: n } }); document.querySelector("dialog")?.close(); await loadNotes(); } } }, "Rinomina"),
    h("button", { class: "danger", onclick: async () => { if (await confirmBox(`Eliminare «${p.title}»?` + (p.tid ? " La registrazione collegata resta nell'Archivio." : ""), { ok: "Elimina", danger: true })) { await api("/api/pages/" + p.id, { method: "DELETE" }); document.querySelector("dialog")?.close(); await loadNotes(); } } }, "Elimina"));
  const r = await modal(p.title, body, [["Chiudi", null], ["Sposta qui", () => ({ folder: fsel.value || null }), "primary"]]);
  if (r && (r.folder || null) !== (p.folder_id || null)) { await api("/api/pages/" + p.id, { method: "PUT", json: { set_folder: true, folder_id: r.folder } }); toast("Nota spostata"); await loadNotes(); }
}

function noteCard(p) {
  const cv = h("div", { class: "cover" });
  const card = h("div", { class: "ncard", role: "button", tabindex: "0", onclick: () => { location.hash = "#/note/" + p.id; } }, cv,
    h("b", null, p.title || "Senza titolo"), h("span", { class: "m" }, new Date(p.updated * 1000).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + (p.folder_id ? " · " + folderPath(p.folder_id) : "")),
    h("button", { class: "more", "aria-label": "Altro", onclick: e => { e.stopPropagation(); noteMenu(p); } }, "⋯"));
  if (p.tid) cv.append(h("span", { class: "badge" }, "🎙 lezione"));
  requestAnimationFrame(() => { try { cv.prepend(InkMod.renderThumb(p.preview, 220)); } catch (e) { console.error("miniatura", e); } });
  return card;
}

let notesRoot = null;
function drawNotes() {
  if (!notesRoot) return;
  const items = notesInFolder(), cur = NOTES.folder === "all" ? "Tutti gli appunti" : NOTES.folder === "none" ? "Senza cartella" : folderPath(NOTES.folder) || "Appunti";
  notesRoot.replaceChildren(notesSidebar(), h("section", { class: "lib-main" },
    h("div", { class: "row sp" }, h("div", null, h("h1", null, cur), h("p", { class: "sub" }, "Scrivi con la Apple Pencil; la registrazione live scrive la trascrizione dentro la pagina, con i modelli del server.")),
      h("div", { class: "row" }, h("button", { class: "side-toggle", onclick: () => { NOTES.sideOpen = !NOTES.sideOpen; drawNotes(); } }, "📁 Cartelle"),
        h("button", { class: "primary", onclick: () => newNote() }, "＋ Nuova nota"))),
    h("input", { type: "search", id: "notesq", placeholder: "Cerca nei titoli e nel testo degli appunti…", value: NOTES.q, oninput: e => { NOTES.q = e.target.value; clearTimeout(drawNotes._t); drawNotes._t = setTimeout(async () => { await loadNotes(true); const q = document.getElementById("notesq"); q && q.focus(); }, 250); } }),
    items.length ? h("div", { class: "ngrid" }, items.map(noteCard)) : h("div", { class: "notice", style: "margin-top:14px" }, NOTES.q ? "Nessun appunto corrisponde alla ricerca." : "Nessuna nota qui. Premi «＋ Nuova nota» per scrivere con la Pencil, oppure aprila e premi «● Registra» per trascrivere una lezione.")));
  if (document.activeElement?.id === "notesq") { const q = document.getElementById("notesq"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}
async function loadNotes(keepFocus) {
  const [fl, pg] = await Promise.all([api("/api/folders"), api("/api/pages" + (NOTES.q.trim() ? "?q=" + encodeURIComponent(NOTES.q.trim()) : ""))]);
  LIB.folders = fl.folders; NOTES.pages = pg.pages; NOTES.loaded = true;
  if (NOTES.folder !== "all" && NOTES.folder !== "none" && !LIB.folders.some(f => f.id === NOTES.folder)) NOTES.folder = "all";
  drawNotes();
}

async function newNote(folderId) {
  await loadInk();
  const fsel = h("select", null, folderOptions().map(o => h("option", { value: o.id, selected: (o.id || null) === (folderId ?? (NOTES.folder !== "all" && NOTES.folder !== "none" ? NOTES.folder : null)) }, o.label)));
  const title = h("input", { type: "text", value: "Nota " + new Date().toLocaleDateString("it-IT", { day: "numeric", month: "long" }) });
  const sel = (key, def, vals) => h("select", null, Object.entries(vals).map(([k, v]) => h("option", { value: k, selected: LS.get(key, def) === k }, Array.isArray(v) ? v[0] : v)));
  const paper = sel("notes_paper", "lines", PAPER_NAMES), size = sel("notes_size", "a4", SIZE_NAMES), gap = sel("notes_gap", "32", { 24: "Righe strette", 32: "Righe medie", 44: "Righe larghe" });
  const r = await modal("Nuova nota", h("div", { class: "grid" }, h("label", null, "Titolo"), title, h("label", null, "Cartella"), fsel, h("label", null, "Carta"), paper, h("label", null, "Formato (si può allargare e allungare)"), size, h("label", null, "Distanza delle righe"), gap),
    [["Annulla", null], ["Crea", () => ({ title: title.value.trim() || "Nota", folder: fsel.value || null, paper: paper.value, size: size.value, gap: +gap.value }), "primary"]]);
  if (!r) return;
  LS.set("notes_paper", r.paper); LS.set("notes_size", r.size); LS.set("notes_gap", String(r.gap));
  const [, w, hh] = SIZE_NAMES[r.size];
  const p = await api("/api/pages", { json: { title: r.title, folder_id: r.folder, data: { w, h: hh, paper: { type: r.paper, gap: r.gap, color: "#ffffff", size: r.size }, strokes: [], texts: [] } } });
  location.hash = "#/note/" + p.id;
}

ROUTES.push([/^#\/notes$/, async () => {
  await loadInk(); notesRoot = h("div", { class: "lib" }); $app.replaceChildren(notesRoot);
  await loadNotes();
  whileMounted(notesRoot, () => { notesRoot = null; });
}]);

/* ---------- editor di una nota ---------- */
ROUTES.push([/^#\/note\/(\w+)$/, async id => {
  const [ink, p] = await Promise.all([loadInk(), api("/api/pages/" + id)]);
  const page = { ...p.data, id: p.id }; let title = p.title, folderId = p.folder_id, tid = p.tid;
  const root = h("div", { class: "notes-full" }); $app.replaceChildren(root);
  const toData = () => ({ w: page.w, h: page.h, paper: page.paper, texts: page.texts, seg_n: page.seg_n || 0, seg_end: page.seg_end ?? -1,
    strokes: page.strokes.map(({ id: i, t, c, s, pts, bb, shape }) => ({ id: i, t, c, s, pts, bb, ...(shape ? { shape } : {}) })) });
  let saving = Promise.resolve(), gone = false;
  const save = () => { if (gone) return saving; saving = saving.then(() => api("/api/pages/" + id, { method: "PUT", json: { data: toData() } })).catch(e => showErr("Appunti non salvati: " + e.message)); return saving; };

  /* barra in alto: indietro, titolo, cartella, registrazione, trascrizione, elimina */
  const back = h("a", { class: "ib txt", href: "#/notes", "aria-label": "Torna agli appunti" }, "‹ Appunti");
  const titleIn = h("input", { type: "text", class: "ptitle", value: title, "aria-label": "Titolo", onchange: async () => { title = titleIn.value.trim() || "Nota"; try { await api("/api/pages/" + id, { method: "PUT", json: { title } }); } catch (e) { showErr(e.message); } } });
  const folderB = h("button", { class: "ib txt", "aria-label": "Cartella", title: "Cambia cartella", onclick: async () => {
    const fsel = h("select", null, folderOptions().map(o => h("option", { value: o.id, selected: (o.id || null) === (folderId || null) }, o.label)));
    const r = await modal("Cartella", fsel, [["Annulla", null], ["Sposta", () => ({ f: fsel.value || null }), "primary"]]);
    if (r) { folderId = r.f; await api("/api/pages/" + id, { method: "PUT", json: { set_folder: true, folder_id: folderId } }); paintFolder(); toast("Nota spostata"); }
  } });
  const paintFolder = () => { folderB.textContent = "📁 " + (folderId ? (folderPath(folderId).split(" / ").pop()) : "Senza cartella"); };
  const recB = h("button", { class: "ib txt rec", onclick: () => startRec() }, "● Registra");
  const timeS = h("span", { class: "rectime" }), pauseB = h("button", { class: "ib txt", onclick: () => (Recorder.state === "paused" ? Recorder.resume() : Recorder.pause()) }, "Pausa"), stopB = h("button", { class: "ib txt rec", onclick: () => Recorder.stop() }, "■ Stop");
  const trB = h("a", { class: "ib txt", href: "#", "aria-label": "Apri la trascrizione" }, "🎙 Trascrizione");
  const delB = h("button", { class: "ib small", "aria-label": "Elimina nota", onclick: async () => { if (await confirmBox(`Eliminare «${title}»?` + (tid ? " La registrazione collegata resta nell'Archivio." : ""), { ok: "Elimina", danger: true })) { gone = true; await api("/api/pages/" + id, { method: "DELETE" }); location.hash = "#/notes"; } } }, "🗑");
  const header = h("div", { class: "nhead" }, back, titleIn, folderB, recB, timeS, pauseB, stopB, trB, delB); paintFolder();

  const nb = ink.createNotebook(root, page, { header, onChange: () => save() });

  /* registrazione live → trascrizione dentro la pagina */
  let lastEnd = page.seg_end ?? -1;
  const appendSeg = seg => {
    const para = lastEnd < 0 || seg.start - lastEnd > 4;
    nb.addTranscript({ text: seg.text }, para ? `¶ ${lastEnd < 0 ? "Inizio" : "Nuovo paragrafo"} · ${fmtT(seg.start)}` : null);
    lastEnd = seg.end ?? seg.start + 3; page.seg_n = (page.seg_n || 0) + 1; page.seg_end = lastEnd;
  };
  let prevState = Recorder.state;
  const mine = () => Recorder.pageId === id && Recorder.state !== "idle";
  const onRec = () => {
    const m = mine(), st = Recorder.state;
    recB.hidden = m || (st !== "idle"); recB.disabled = st !== "idle";
    timeS.hidden = pauseB.hidden = stopB.hidden = !m;
    if (m) { timeS.textContent = (st === "paused" ? "❚❚ " : "● ") + fmtT(Recorder.elapsed()); const pl = st === "paused" ? "Riprendi" : "Pausa"; if (pauseB.textContent !== pl) pauseB.textContent = pl; pauseB.disabled = stopB.disabled = st === "stopping"; }
    if (m && prevState !== st) { if (st === "paused") { nb.addTranscriptMeta(`❚❚ In pausa · ${fmtT(Recorder.elapsed())}`); } else if (st === "recording" && prevState === "paused") { nb.addTranscriptMeta(`▶ Ripresa · ${fmtT(Recorder.elapsed())}`); } }
    if (Recorder.pageId === id && st === "idle" && prevState !== "idle") { Recorder.pageId = null; save(); }
    prevState = st;
    trB.hidden = !tid; if (tid) trB.href = "#/t/" + tid;
  };
  Recorder.segHooks.add(appendSeg); Recorder.listeners.add(onRec); onRec();
  if (mine()) Recorder.segs.slice(page.seg_n || 0).forEach(appendSeg);   // tornando su una nota con registrazione in corso: recupera le frasi arrivate nel frattempo

  async function startRec() {
    const cfgs = Object.assign({ language: "it", model_id: null, after_model: "" }, LSJ.get("live_cfg", {}));
    const sys = await api("/api/system");
    const modelsFor = async lang => { const r = await api("/api/models?language=" + lang); return [...r.models, ...r.fast].filter(m => m.compatible && m.installed); };
    let avail = await modelsFor(cfgs.language);
    const lang = h("select", null, [["it", "Italiano"], ["en", "Inglese"]].map(([v, l]) => h("option", { value: v, selected: cfgs.language === v }, l)));
    const model = h("select"), after = h("select");
    const fill = () => {
      if (!avail.some(m => m.id === cfgs.model_id)) cfgs.model_id = (avail.find(m => m.id === "parakeet-tdt-0.6b-v3") || avail[0])?.id || null;
      model.replaceChildren(...avail.map(m => h("option", { value: m.id, selected: m.id === cfgs.model_id }, `${m.name}${m.tier === "fast" ? " · veloce" : ""}`)));
      after.replaceChildren(h("option", { value: "" }, "No, tieni la trascrizione live"), ...avail.map(m => h("option", { value: m.id, selected: cfgs.after_model === m.id }, "Sì, con " + m.name)));
    };
    fill(); lang.onchange = async () => { cfgs.language = lang.value; avail = await modelsFor(cfgs.language); fill(); };
    const notes = [];
    if (!sys.websocket) notes.push(h("div", { class: "notice bad" }, "Il server non ha il supporto WebSocket (serve per il live): pip install \"uvicorn[standard]\"."));
    if (!navigator.mediaDevices?.getUserMedia) notes.push(h("div", { class: "notice bad" }, "Il microfono richiede HTTPS (apri l'indirizzo https del Codespace)."));
    if (!avail.length) notes.push(h("div", { class: "notice warn" }, "Nessun modello installato per questa lingua: installalo da «Modelli AI»."));
    const r = await modal("● Registra e scrivi nella nota", h("div", { class: "grid" }, ...notes, h("label", null, "Lingua"), lang, h("label", null, "Modello (sul server)"), model,
      h("label", null, "A fine registrazione ritrascrivi l'audio con un modello più accurato?"), after, h("p", { class: "m" }, "Il testo live compare nella pagina mentre parli; l'audio e la trascrizione completa vanno anche nell'Archivio.")),
      [["Annulla", null], ["Inizia", () => ({ language: lang.value, model_id: model.value, after: after.value }), "primary"]]);
    if (!r || !r.model_id) return;
    LSJ.set("live_cfg", { ...cfgs, language: r.language, model_id: r.model_id, after_model: r.after });
    Recorder.pageId = id; Recorder.afterModel = r.after || ""; recB.disabled = true;
    try {
      await Recorder.start({ language: r.language, model_id: r.model_id, context: "Altro", title: title, folder_id: folderId });
      tid = Recorder.tid; await api("/api/pages/" + id, { method: "PUT", json: { tid } }); onRec();
    } catch (e) { Recorder.pageId = null; toast(e.message, 7000); onRec(); }
  }

  const vis = () => { if (document.visibilityState === "hidden") save(); }; document.addEventListener("visibilitychange", vis);
  whileMounted(root, () => { Recorder.segHooks.delete(appendSeg); Recorder.listeners.delete(onRec); document.removeEventListener("visibilitychange", vis); try { nb.destroy(); } catch {} });
}]);
