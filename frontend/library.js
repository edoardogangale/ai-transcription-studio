"use strict";
/* Archivio: cartelle (materie > argomenti), ricerca nel testo, selezione multipla con copia / PDF unico / audio / sposta / elimina. */
const STATUS = { queued: ["In coda", ""], running: ["In elaborazione", "warn"], recording: ["● In registrazione", "bad"], done: ["Completata", "ok"], failed: ["Fallita", "bad"], cancelled: ["Annullata", ""] };
const EXP = { teacher_only: LSJ.get("exp_teacher", true), notes: LSJ.get("exp_notes", true) };
const LIB = { folder: LS.get("lib_folder", "all"), sel: new Set(), q: "", folders: [], unfiled: 0, items: [], hits: null, sideOpen: false };

const escapeHtml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const safeSnippet = s => escapeHtml(s).replace(/&lt;mark&gt;/g, "<mark>").replace(/&lt;\/mark&gt;/g, "</mark>");
const folderMap = () => Object.fromEntries(LIB.folders.map(f => [f.id, f]));
function folderPath(id, fm = folderMap()) { const out = []; const seen = new Set(); while (id && fm[id] && !seen.has(id)) { seen.add(id); out.unshift(fm[id].name); id = fm[id].parent_id; } return out.join(" / "); }
function folderOptions(withNone = true) {   // [{id, label}] in ordine ad albero
  const out = [], kids = p => LIB.folders.filter(f => (f.parent_id || null) === p);
  const walk = (p, d) => kids(p).forEach(f => { out.push({ id: f.id, label: " ".repeat(d) + f.name }); walk(f.id, d + 1); });
  walk(null, 0); return withNone ? [{ id: "", label: "Senza cartella" }, ...out] : out;
}

function jobRow(t) {
  const [lab, cls] = STATUS[t.status] || [t.status, ""]; const prog = t.status === "running" || t.status === "queued";
  const pct = t.chunks_total ? Math.round(100 * t.chunks_done / t.chunks_total) : 0, fm = folderMap();
  const done = t.status === "done";
  const href = t.kind === "live" && t.status === "recording" ? "#/live" : t.group_id ? "#/c/" + t.group_id : "#/t/" + t.id;
  return h("div", { class: "item" + (LIB.sel.has(t.id) ? " selected" : ""), draggable: "true", "data-id": t.id,
      ondragstart: e => { const ids = LIB.sel.has(t.id) ? [...LIB.sel] : [t.id]; e.dataTransfer.setData("text/plain", JSON.stringify(ids)); e.dataTransfer.effectAllowed = "move"; } },
    h("input", { type: "checkbox", checked: LIB.sel.has(t.id), "aria-label": "Seleziona " + (t.title || ""), onchange: e => { e.target.checked ? LIB.sel.add(t.id) : LIB.sel.delete(t.id); drawLib(); } }),
    h("a", { class: "grow item-link", href },
      h("div", { class: "t" }, (t.kind === "live" ? "● " : "") + (t.title || t.filename)),
      h("div", { class: "m" }, [t.folder_id && LIB.folder === "all" ? "📁 " + folderPath(t.folder_id, fm) : "", mname(t.model_id), t.duration ? fmtT(t.duration) : "", fmtDate(t.created), t.group_id ? "confronto" : ""].filter(Boolean).join(" · ")),
      prog && h("div", { style: "margin-top:6px" }, h("div", { class: "bar" }, h("i", { style: `width:${pct}%` })), h("div", { class: "m" }, ((t.stats || {}).phase || "") + (t.chunks_total ? ` · segmento ${t.chunks_done}/${t.chunks_total}` : " In attesa…"))),
      t.status === "failed" && h("div", { class: "m err" }, t.error)),
    h("span", { class: "chip " + cls }, lab),
    done && h("button", { class: "small", title: "Copia la trascrizione", "aria-label": "Copia", onclick: () => copyTranscripts([t.id], EXP).catch(e => toast(e.message)) }, "⧉"),
    prog && h("button", { class: "small", onclick: async () => { await api(`/api/transcripts/${t.id}/cancel`, { method: "POST" }); toast("Annullamento richiesto"); loadLib(); } }, "Annulla"),
    (t.status === "failed" || t.status === "cancelled") && h("button", { class: "small", onclick: async () => { try { await api(`/api/transcripts/${t.id}/retry`, { method: "POST" }); toast("Ripreso dai segmenti già elaborati"); loadLib(); } catch (e) { toast(e.message); } } }, "Riprendi"));
}

function visibleItems() {
  let it = LIB.items;
  if (LIB.q) it = it.filter(t => norm((t.title || "") + " " + (t.filename || "")).includes(norm(LIB.q)));
  return it;
}

function folderNode(f, depth) {
  const kids = LIB.folders.filter(x => x.parent_id === f.id);
  return h("div", null,
    h("div", { class: "frow" + (LIB.folder === f.id ? " on" : ""), style: `padding-left:${8 + depth * 16}px`,
        ondragover: e => { e.preventDefault(); e.currentTarget.classList.add("drop"); }, ondragleave: e => e.currentTarget.classList.remove("drop"),
        ondrop: async e => { e.preventDefault(); e.currentTarget.classList.remove("drop"); try { const ids = JSON.parse(e.dataTransfer.getData("text/plain")); await api("/api/transcripts/move", { json: { ids, folder_id: f.id } }); toast(`Spostate in «${f.name}»`); LIB.sel.clear(); loadLib(); } catch (er) { toast(er.message); } } },
      h("button", { class: "fname", onclick: () => selectFolder(f.id) }, (depth ? "◦ " : "📁 ") + f.name, h("span", { class: "cnt" }, f.count || "")),
      h("button", { class: "fmore", title: "Gestisci cartella", "aria-label": "Gestisci " + f.name, onclick: () => folderMenu(f) }, "⋯")),
    kids.map(k => folderNode(k, depth + 1)));
}

async function folderMenu(f) {
  const p = f.prefs || {};
  const body = h("div", { class: "grid" },
    h("p", { class: "m" }, p.model_id ? `Ultima scelta in questa cartella: ${mname(p.model_id)} · ${p.language || ""} · ${p.context || ""} (verrà riproposta alla prossima trascrizione)` : "Quando trascrivi qui, l'app ricorda lingua, modello e contesto."),
    h("button", { onclick: async () => { const n = await askText("Nuovo argomento in «" + f.name + "»", "Nome dell'argomento"); if (n) { await api("/api/folders", { json: { name: n, parent_id: f.id } }); document.querySelector("dialog")?.close(); loadLib(); } } }, "＋ Nuovo argomento (sottocartella)"),
    h("button", { onclick: async () => { const ta = h("textarea", { style: "min-height:110px", placeholder: "Es.: «Il professore chiama gli studenti per nome: ignorali. I termini di filosofia vanno con la maiuscola.»" }); ta.value = p.ai_instructions || "";
        const r = await modal("Istruzioni per l'AI · " + f.name, h("div", null, h("p", { class: "m" }, "Servono alla correzione AI: spiega il contesto e cosa è importante o da ignorare. Valgono anche per le sotto-cartelle."), ta), [["Annulla", null], ["Salva", () => ({ v: ta.value.trim() }), "primary"]]);
        if (r) { await api("/api/folders/" + f.id, { method: "PATCH", json: { prefs: { ai_instructions: r.v } } }); document.querySelector("dialog")?.close(); toast("Istruzioni salvate"); loadLib(); } } }, "✨ Istruzioni per l'AI"),
    h("button", { onclick: async () => { const n = await askText("Rinomina", "Nome", f.name); if (n) { await api("/api/folders/" + f.id, { method: "PATCH", json: { name: n } }); document.querySelector("dialog")?.close(); loadLib(); } } }, "Rinomina"),
    h("button", { onclick: async () => {
        const sel = h("select", null, [{ id: "", label: "Livello principale (materia)" }, ...folderOptions(false).filter(o => o.id !== f.id)].map(o => h("option", { value: o.id }, o.label)));
        const r = await modal("Sposta «" + f.name + "» dentro…", sel, [["Annulla", null], ["Sposta", () => ({ v: sel.value }), "primary"]]);
        if (r) { try { await api("/api/folders/" + f.id, { method: "PATCH", json: { move: true, parent_id: r.v || null } }); document.querySelector("dialog")?.close(); loadLib(); } catch (e) { toast(e.message, 5000); } } } }, "Sposta…"),
    h("button", { class: "danger", onclick: async () => { if (confirm(`Eliminare la cartella «${f.name}»? Le registrazioni NON vengono eliminate: restano nella cartella superiore.`)) { await api("/api/folders/" + f.id, { method: "DELETE" }); if (LIB.folder === f.id) selectFolder("all"); document.querySelector("dialog")?.close(); loadLib(); } } }, "Elimina cartella"));
  await modal("📁 " + f.name, body);
}

function selectFolder(id) { LIB.folder = id; LS.set("lib_folder", id); LIB.sel.clear(); LIB.hits = null; loadLib(true); }

function sidebar() {
  const top = LIB.folders.filter(f => !f.parent_id);
  return h("aside", { class: "side" + (LIB.sideOpen ? " open" : "") },
    h("div", { class: "frow" + (LIB.folder === "all" ? " on" : "") }, h("button", { class: "fname", onclick: () => selectFolder("all") }, "🗂 Tutte", h("span", { class: "cnt" }, ""))),
    h("div", { class: "frow" + (LIB.folder === "none" ? " on" : ""),
        ondragover: e => { e.preventDefault(); e.currentTarget.classList.add("drop"); }, ondragleave: e => e.currentTarget.classList.remove("drop"),
        ondrop: async e => { e.preventDefault(); e.currentTarget.classList.remove("drop"); try { await api("/api/transcripts/move", { json: { ids: JSON.parse(e.dataTransfer.getData("text/plain")), folder_id: null } }); LIB.sel.clear(); loadLib(); } catch (er) { toast(er.message); } } },
      h("button", { class: "fname", onclick: () => selectFolder("none") }, "📥 Senza cartella", h("span", { class: "cnt" }, LIB.unfiled || ""))),
    h("div", { class: "side-title" }, "Materie e argomenti"),
    top.map(f => folderNode(f, 0)),
    h("button", { class: "small", style: "margin:8px", onclick: async () => { const n = await askText("Nuova materia", "Es. Filosofia, Matematica, Storia…"); if (n) { await api("/api/folders", { json: { name: n } }); loadLib(); } } }, "＋ Nuova materia"));
}

function actionBar() {
  const ids = [...LIB.sel], items = LIB.items.filter(t => LIB.sel.has(t.id)), done = items.filter(t => t.status === "done");
  if (!ids.length) return null;
  const doneIds = done.map(t => t.id);
  return h("div", { class: "actionbar" },
    h("b", null, `${ids.length} selezionat${ids.length > 1 ? "e" : "a"}`),
    h("div", { class: "row", style: "gap:6px" },
      h("button", { class: "primary", disabled: !doneIds.length, title: "Copia il testo di tutte le trascrizioni selezionate", onclick: () => copyTranscripts(doneIds, EXP).catch(e => toast(e.message)) }, "⧉ Copia testo"),
      h("button", { class: "primary", disabled: !doneIds.length, title: "Un solo PDF con tutte le trascrizioni una dopo l'altra", onclick: () => exportBundle(doneIds, "pdf", EXP) }, "⇩ PDF unico"),
      h("button", { disabled: !doneIds.length, onclick: () => exportBundle(doneIds, "docx", EXP) }, "DOCX"),
      h("button", { disabled: !doneIds.length, onclick: () => exportBundle(doneIds, "txt", EXP) }, "TXT"),
      h("button", { disabled: !doneIds.length, onclick: () => shareAudio(done.map(t => ({ id: t.id, title: t.title }))) }, "↗ Condividi audio"),
      h("button", { onclick: moveSelected }, "📁 Sposta in…"),
      h("button", { class: "danger", onclick: async () => { if (confirm(`Eliminare DEFINITIVAMENTE ${ids.length} registrazioni (trascrizioni e file audio)?`)) { const r = await api("/api/transcripts/delete", { json: { ids } }); toast(`Eliminate ${r.deleted}`); LIB.sel.clear(); loadLib(); } } }, "Elimina"),
      h("button", { onclick: () => { LIB.sel.clear(); drawLib(); } }, "✕")),
    h("div", { class: "row m", style: "gap:14px" },
      h("label", { class: "opt" }, h("input", { type: "checkbox", checked: EXP.teacher_only, onchange: e => { EXP.teacher_only = e.target.checked; LSJ.set("exp_teacher", EXP.teacher_only); } }), "solo l'insegnante (se riconosciuto)"),
      h("label", { class: "opt" }, h("input", { type: "checkbox", checked: EXP.notes, onchange: e => { EXP.notes = e.target.checked; LSJ.set("exp_notes", EXP.notes); } }), "note ed evidenziazioni")));
}

async function moveSelected() {
  const sel = h("select", null, folderOptions().map(o => h("option", { value: o.id }, o.label)));
  const r = await modal(`Sposta ${LIB.sel.size} registrazioni in…`, sel, [["Annulla", null], ["Sposta", () => ({ v: sel.value }), "primary"]]);
  if (r) { await api("/api/transcripts/move", { json: { ids: [...LIB.sel], folder_id: r.v || null } }); toast("Spostate"); LIB.sel.clear(); loadLib(); }
}

let libRoot = null;
function drawLib() {
  if (!libRoot) return;
  const fm = folderMap(), items = visibleItems(), cur = LIB.folder === "all" ? "Tutte le registrazioni" : LIB.folder === "none" ? "Senza cartella" : folderPath(LIB.folder, fm) || "Archivio";
  const act = items.filter(t => ["queued", "running", "recording"].includes(t.status)), rest = items.filter(t => !["queued", "running", "recording"].includes(t.status));
  const allSel = rest.length && rest.every(t => LIB.sel.has(t.id));
  libRoot.replaceChildren(
    sidebar(),
    h("section", { class: "lib-main" },
      h("div", { class: "row sp" }, h("div", null, h("h1", null, cur), h("p", { class: "sub" }, "Tutto resta sul tuo computer.")),
        h("div", { class: "row" }, h("button", { class: "side-toggle", onclick: () => { LIB.sideOpen = !LIB.sideOpen; drawLib(); } }, "📁 Cartelle"),
          h("a", { class: "btn", href: "#/live" }, "● Registra live"), h("a", { class: "btn primary", href: "#/new" }, "＋ Nuova trascrizione"))),
      h("input", { type: "search", id: "libq", placeholder: "Cerca nei titoli e dentro il testo di tutte le trascrizioni…", value: LIB.q, oninput: e => { LIB.q = e.target.value; searchContent(); drawListOnly(); } }),
      h("div", { id: "libhits" }, hitsView()),
      h("div", { id: "liblist" }, listView(act, rest, allSel)),
      actionBar()));
  const q = document.getElementById("libq"); if (document.activeElement?.id === "libq") q.focus();
}
function hitsView() {
  if (!LIB.q || LIB.q.length < 2 || !LIB.hits) return null;
  if (!LIB.hits.length) return h("div", { class: "m", style: "margin:10px 0" }, "Nessuna corrispondenza nel testo.");
  return h("div", null, h("h2", null, `Trovato nel testo (${LIB.hits.length})`), h("div", { class: "list" }, LIB.hits.map(r => {
    const a = h("a", { class: "item", href: "#/t/" + r.id }, h("div", { class: "grow" }, h("div", { class: "t" }, r.title), h("div", { class: "m" }, [r.folder ? "📁 " + r.folder : "", fmtDate(r.created)].filter(Boolean).join(" · ")), h("div", { class: "snip" })));
    a.querySelector(".snip").innerHTML = safeSnippet(r.snippet); return a; })));
}
function listView(act, rest, allSel) {
  return [act.length ? h("div", null, h("h2", null, "Processi in corso"), h("div", { class: "list" }, act.map(jobRow))) : null,
    rest.length ? h("div", null, h("div", { class: "row sp" }, h("h2", null, LIB.q ? "Titoli corrispondenti" : "Registrazioni"),
      h("label", { class: "opt m" }, h("input", { type: "checkbox", checked: !!allSel, onchange: e => { rest.forEach(t => e.target.checked ? LIB.sel.add(t.id) : LIB.sel.delete(t.id)); drawLib(); } }), "Seleziona tutto")),
      h("div", { class: "list" }, rest.map(jobRow)))
      : (!act.length && h("div", { class: "notice", style: "margin-top:20px" }, LIB.q ? "Nessun titolo corrispondente." : LIB.folder === "all" ? "Ancora nessuna trascrizione. Premi “Nuova trascrizione” o “Registra live” per iniziare." : "Cartella vuota: trascina qui delle registrazioni o scegli questa cartella quando ne crei una nuova."))];
}
function drawListOnly() {   // durante la digitazione non ridisegna l'input (niente perdita di focus)
  const items = visibleItems(), act = items.filter(t => ["queued", "running", "recording"].includes(t.status)), rest = items.filter(t => !["queued", "running", "recording"].includes(t.status));
  document.getElementById("liblist")?.replaceChildren(listView(act, rest, rest.length && rest.every(t => LIB.sel.has(t.id))));
}
let searchT;
function searchContent() {
  clearTimeout(searchT);
  if (LIB.q.length < 2) { LIB.hits = null; document.getElementById("libhits")?.replaceChildren(); return; }
  searchT = setTimeout(async () => { try { LIB.hits = (await api("/api/search?q=" + encodeURIComponent(LIB.q))).results; document.getElementById("libhits")?.replaceChildren(hitsView()); } catch {} }, 250);
}

async function loadLib(force) {
  const f = await api("/api/folders"); LIB.folders = f.folders; LIB.unfiled = f.unfiled;
  if (LIB.folder !== "all" && LIB.folder !== "none" && !LIB.folders.some(x => x.id === LIB.folder)) LIB.folder = "all";
  const qs = LIB.folder === "none" ? "?unfiled=true" : LIB.folder !== "all" ? "?folder_id=" + LIB.folder : "";
  LIB.items = await api("/api/transcripts" + qs);
  const ids = new Set(LIB.items.map(t => t.id)); [...LIB.sel].forEach(i => ids.has(i) || LIB.sel.delete(i));
  CFG.folder = LIB.folder !== "all" && LIB.folder !== "none" ? LIB.folder : CFG.folder; saveCfg();
  const sig = sigOf([LIB.folder, LIB.folders, LIB.unfiled, LIB.items]);
  if (!force && sig === LIB._sig) return;                 // niente è cambiato: non si ridisegna (i pulsanti restano stabili)
  LIB._sig = sig; safeRedraw(drawLib);
}

ROUTES.push([/^#?\/?$/, async () => {
  libRoot = h("div", { class: "lib" }); $app.replaceChildren(libRoot); LIB._sig = "";
  await loadLib(true);
  const reload = () => { if (libRoot?.isConnected && document.activeElement?.id !== "libq") loadLib().catch(() => {}); };
  poll(reload, 3000); const ev = () => reload(); window.addEventListener("jobs-changed", ev);
  new MutationObserver((_, o) => { if (!libRoot?.isConnected) { window.removeEventListener("jobs-changed", ev); o.disconnect(); } }).observe($app, { childList: true });
}]);
