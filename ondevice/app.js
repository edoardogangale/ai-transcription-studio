import { createNotebook, INK_CSS, PAPERS, SIZES, renderThumb } from "./ink.js";
// Trascrizione sul dispositivo: tutto gira nel browser (audio, modello, archivio). Nessun server.
const MODELS = {
  "onnx-community/whisper-tiny": ["Tiny — velocissimo, qualità bassa", 40],
  "onnx-community/whisper-base": ["Base — veloce, qualità discreta", 80],
  "onnx-community/whisper-small": ["Small — consigliato per iniziare", 250],
  "onnx-community/whisper-large-v3-turbo": ["Large v3 Turbo — il più preciso, pesante (prova la velocità prima!)", 800],
};
const LANGS = { italian: "Italiano", english: "English", auto: "Rileva da solo" };
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") e.className = v; else if (k === "html") e.innerHTML = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v); } for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k)); return e; }
const cfg = { get: (k, d) => { try { return localStorage.getItem("od_" + k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem("od_" + k, v); } catch {} } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function toast(m) { const t = h("div", { class: "apptoast" }, m); document.body.append(t); setTimeout(() => t.remove(), 1800); }
const fmt = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

// ---------- archivio (IndexedDB) ----------
let _db;
function db() { return _db ||= new Promise((res, rej) => { const r = indexedDB.open("od-studio", 2); r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("notes")) d.createObjectStore("notes", { keyPath: "id" }); if (!d.objectStoreNames.contains("audio")) d.createObjectStore("audio"); if (!d.objectStoreNames.contains("pages")) d.createObjectStore("pages", { keyPath: "id" }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function tx(store, mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const out = fn(t.objectStore(store)); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); }); }
const putNote = n => tx("notes", "readwrite", s => s.put(n));
const getNote = id => tx("notes", "readonly", s => s.get(id));
const allNotes = async () => (await tx("notes", "readonly", s => s.getAll())).sort((a, b) => b.created - a.created);
const putAudio = (id, i, blob) => tx("audio", "readwrite", s => s.put(blob, `${id}:${String(i).padStart(6, "0")}`));
async function getAudio(id) { const d = await db(); return new Promise((res, rej) => { const out = []; const r = d.transaction("audio").objectStore("audio").openCursor(IDBKeyRange.bound(id + ":", id + ":~")); r.onsuccess = () => { const c = r.result; if (c) { out.push(c.value); c.continue(); } else res(out); }; r.onerror = () => rej(r.error); }); }
async function delNote(id) { await tx("notes", "readwrite", s => s.delete(id)); await tx("audio", "readwrite", s => s.delete(IDBKeyRange.bound(id + ":", id + ":~"))); }

// ---------- modello (worker) ----------
const Engine = {
  w: null, ready: false, device: "", waiters: new Map(), onProgress: null, onWarn: null, seq: 0, loading: null,
  start() { if (!this.w) { this.w = new Worker("worker.js", { type: "module" }); this.w.onmessage = e => this.msg(e.data); this.w.onerror = e => { const m = "Impossibile avviare il modello: " + (e.message || "errore del worker. Serve Internet la prima volta."); for (const [, f] of this.waiters) f.rej(new Error(m)); this.waiters.clear(); this.w = null; this.loading = null; }; } },
  msg(m) {
    if (m.type === "progress") this.onProgress && this.onProgress(m.p);
    else if (m.type === "warn") this.onWarn && this.onWarn(m.msg);
    else if (m.type === "ready") { this.ready = true; this.device = m.device; const f = this.waiters.get("load"); f && f.res(m); this.waiters.delete("load"); }
    else if (m.type === "result") { const f = this.waiters.get(m.id); f && f.res(m); this.waiters.delete(m.id); }
    else if (m.type === "error") { const k = this.waiters.has(m.id) ? m.id : "load"; const f = this.waiters.get(k); f && f.rej(new Error(m.msg)); this.waiters.delete(k); }
  },
  load(model) {
    this.start(); this.ready = false;
    const dev = navigator.gpu ? "webgpu" : "wasm";
    return this.loading = new Promise((res, rej) => { this.waiters.set("load", { res, rej }); this.w.postMessage({ type: "load", model, device: dev }); });
  },
  run(audio, lang) { const id = ++this.seq; return new Promise((res, rej) => { this.waiters.set(id, { res, rej }); this.w.postMessage({ type: "run", id, audio, lang }, [audio.buffer]); }); },
};
function loadUI(box) { // barra di caricamento del modello
  const bar = h("i"), txt = h("div", { class: "mut" }, "Preparazione del modello…"); box.replaceChildren(h("div", { class: "bar" }, bar), txt);
  const files = {};
  Engine.onProgress = p => { if (p.file && p.total) { files[p.file] = [p.loaded || 0, p.total]; let l = 0, t = 0; for (const [a, b] of Object.values(files)) { l += a; t += b; } bar.style.width = (100 * l / t).toFixed(0) + "%"; txt.textContent = `Download del modello (solo la prima volta): ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`; } };
  Engine.onWarn = m => box.append(h("div", { class: "bad" }, m));
}

// ---------- audio ----------
function downsample(buf, inRate) { // -> Float32 16 kHz (media su finestre: anti-aliasing semplice)
  if (inRate === 16000) return buf;
  const ratio = inRate / 16000, n = Math.floor(buf.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = Math.floor(i * ratio), b = Math.min(buf.length, Math.floor((i + 1) * ratio)); let s = 0; for (let j = a; j < b; j++) s += buf[j]; out[i] = s / Math.max(1, b - a); }
  return out;
}
class Segmenter { // VAD a energia. Frasi lunghe = più contesto per Whisper (che lavora su finestre di 30 s): taglia alla pausa solo dopo ≥6 s, a fine frase dopo 2,5 s di silenzio, comunque entro 25 s
  constructor(onChunk) { this.on = onChunk; this.rest = new Float32Array(0); this.i = 0; this.hist = []; this.thr = -45; this.active = false; this.buf = []; this.bufDb = []; this.start = 0; this.lastVoice = -1; this.pre = []; }
  feed(x) {
    const a = new Float32Array(this.rest.length + x.length); a.set(this.rest); a.set(x, this.rest.length);
    const F = 480, n = Math.floor(a.length / F);
    for (let k = 0; k < n; k++) this.frame(a.subarray(k * F, (k + 1) * F));
    this.rest = a.slice(n * F);
  }
  frame(fr) {
    const i = this.i++; let e = 0; for (let j = 0; j < fr.length; j++) e += fr[j] * fr[j];
    const db = 20 * Math.log10(Math.sqrt(e / fr.length) + 1e-6); this.hist.push(db); if (this.hist.length > 700) this.hist.shift();
    if (i % 10 === 0 && this.hist.length > 30) { const s = [...this.hist].sort((p, q) => p - q), pc = p => s[Math.floor(p * (s.length - 1))]; this.thr = Math.max(Math.min(pc(.05) + 9, pc(.95) - 12), -55); }
    const copy = new Float32Array(fr);
    if (db > this.thr) { this.lastVoice = i; if (!this.active) { this.active = true; this.buf = this.pre.map(p => p[0]); this.bufDb = this.pre.map(p => p[1]); this.start = i - this.pre.length; } }
    if (this.active) {
      this.buf.push(copy); this.bufDb.push(db);
      const silent = (i - this.lastVoice) * 0.03, dur = this.buf.length * 0.03;
      if (silent >= 2.5 || (silent >= 0.8 && dur >= 6)) this.cut(this.buf.length - Math.max(0, i - this.lastVoice - 5), false);
      else if (dur >= 25) { const lo = Math.max(0, this.buf.length - 100); let m = lo; for (let j = lo; j < this.buf.length; j++) if (this.bufDb[j] < this.bufDb[m]) m = j; this.cut(m + 1, true); }
    } else { this.pre.push([copy, db]); if (this.pre.length > 8) this.pre.shift(); }
  }
  cut(n, keep) {
    n = Math.max(1, n); const chunk = this.buf.slice(0, n), start = this.start;
    if (chunk.length * 0.03 >= 0.4) { const out = new Float32Array(chunk.length * 480); chunk.forEach((c, j) => out.set(c, j * 480)); this.on(start * 0.03, out); }
    if (keep) { this.buf = this.buf.slice(n); this.bufDb = this.bufDb.slice(n); this.start = start + n; } else { this.buf = []; this.bufDb = []; this.active = false; this.pre = []; }
  }
  flush() { if (this.active && this.buf.length) this.cut(this.buf.length, false); }
}

// ---------- viste ----------
const app = $("#app"); let cleanup = null;
function go(hash) { location.hash = hash; }
async function route() {
  if (cleanup) { try { await cleanup(); } catch {} cleanup = null; }
  const [view, arg] = (location.hash || "#/").slice(2).split("/");
  app.replaceChildren(); app.classList.remove("full");
  const navKey = view === "note" ? "recs" : view === "page" ? "" : view === "test" ? "settings" : view; document.querySelectorAll("#side a").forEach(a => a.classList.toggle("active", a.dataset.nav === navKey));
  ({ "": home, recs: recsView, rec, note: detail, test: settings, settings, import: importView, page: pageView }[view] || home)(arg);
}
addEventListener("hashchange", route);
const modelSel = () => h("select", { "aria-label": "Modello", onchange: e => cfg.set("model", e.target.value) }, Object.entries(MODELS).map(([k, [n]]) => h("option", { value: k, selected: k === cfg.get("model", "onnx-community/whisper-small") }, n)));
const langSel = () => h("select", { "aria-label": "Lingua", onchange: e => cfg.set("lang", e.target.value) }, Object.entries(LANGS).map(([k, n]) => h("option", { value: k, selected: k === cfg.get("lang", "italian") }, n)));

// ---------- appunti (pagine del quaderno) ----------
const putPage = p => tx("pages", "readwrite", s => s.put(p));
const getPage = id => tx("pages", "readonly", s => s.get(id));
const allPages = async () => (await tx("pages", "readonly", s => s.getAll())).sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
const delPage = id => tx("pages", "readwrite", s => s.delete(id));
function newPage(title, extra) {
  const sz = cfg.get("paper_size", "a4"), [, w, hgt] = SIZES[sz] || SIZES.a4;
  return { id: "p" + Date.now() + Math.random().toString(36).slice(2, 5), title, created: Date.now(), updated: Date.now(), w, h: hgt, paper: { type: cfg.get("paper_type", "lines"), gap: +cfg.get("paper_gap", "32"), color: "#ffffff", size: sz }, strokes: [], texts: [], ...(extra || {}) };
}
const ic = {
  compose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg>',
  txt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M8 11l4 4 4-4M5 19h14"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 8l4-4 4 4M5 13v6a1 1 0 001 1h12a1 1 0 001-1v-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>',
  wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 10v4M8 6v12M12 3v18M16 8v8M20 11v2"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>',
};
const icon = (k, cls) => { const s = document.createElement("span"); s.className = cls || "ic"; s.style.display = "inline-flex"; s.innerHTML = ic[k]; return s; };
const when = ts => { const d = new Date(ts), n = new Date(), diff = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5); const hm = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }); return diff === 0 ? "Oggi, " + hm : diff === 1 ? "Ieri, " + hm : d.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" }); };

function sheet(content, { center = false } = {}) { // lastra stile iOS: si chiude toccando fuori
  const o = h("div", { class: "modal" + (center ? " center" : ""), onclick: e => { if (e.target === o) { o.remove(); o.onclose && o.onclose(); } } }, h("div", { class: "sheet" }, content));
  document.body.append(o); return o;
}
function confirmBox(msg, ok = "Elimina") { return new Promise(res => { const o = sheet([h("h3", null, msg), h("div", { class: "row" }, h("button", { class: "primary grow", style: "background:var(--bad);color:#fff", onclick: () => { o.remove(); res(true); } }, ok), h("button", { onclick: () => { o.remove(); res(false); } }, "Annulla"))], { center: true }); o.onclose = () => res(false); }); }
function promptBox(title, value) { return new Promise(res => { const inp = h("input", { type: "text", value }); const o = sheet([h("h3", null, title), inp, h("div", { class: "row" }, h("button", { class: "primary grow", onclick: () => { o.remove(); res(inp.value.trim() || null); } }, "Salva"), h("button", { onclick: () => { o.remove(); res(null); } }, "Annulla"))], { center: true }); o.onclose = () => res(null); setTimeout(() => inp.select(), 50); inp.addEventListener("keydown", e => { if (e.key === "Enter") { o.remove(); res(inp.value.trim() || null); } }); }); }
function newPageDialog() {
  return new Promise(res => {
    let type = cfg.get("paper_type", "lines"), size = cfg.get("paper_size", "a4"), gap = cfg.get("paper_gap", "32");
    const papers = h("div", { class: "papers" }), sizes = h("div", { class: "chips" }), gaps = h("div", { class: "chips" });
    const draw = () => {
      papers.replaceChildren(...Object.entries(PAPERS).map(([k, v]) => h("button", { class: "paper" + (type === k ? " on" : ""), onclick: () => { type = k; draw(); } }, h("i", { class: k }), v)));
      sizes.replaceChildren(...Object.entries(SIZES).map(([k, v]) => h("button", { class: "chip" + (size === k ? " on" : ""), onclick: () => { size = k; draw(); } }, v[0])));
      gaps.replaceChildren(...Object.entries({ 24: "Stretta", 32: "Media", 44: "Larga" }).map(([k, v]) => h("button", { class: "chip" + (gap === k ? " on" : ""), onclick: () => { gap = k; draw(); } }, v)));
    };
    const name = h("input", { type: "text", value: "Nota " + new Date().toLocaleDateString("it-IT", { day: "numeric", month: "long" }), "aria-label": "Titolo" });
    const o = sheet([h("h3", null, "Nuova nota"), name, h("label", { class: "l" }, "Carta"), papers, h("label", { class: "l" }, "Formato"), sizes, h("label", { class: "l" }, "Distanza delle righe"), gaps,
      h("div", { class: "row" }, h("button", { class: "primary grow", onclick: () => { cfg.set("paper_type", type); cfg.set("paper_size", size); cfg.set("paper_gap", gap); o.remove(); res({ title: name.value.trim() || "Nota", type, size, gap: +gap }); } }, "Crea"), h("button", { onclick: () => { o.remove(); res(null); } }, "Annulla"))]);
    o.onclose = () => res(null); draw();
  });
}
async function createFromDialog() { const r = await newPageDialog(); if (!r) return; const p = newPage(r.title); p.paper.type = r.type; p.paper.gap = r.gap; const [, w, hh] = SIZES[r.size]; p.w = w; p.h = hh; p.paper.size = r.size; await putPage(p); go("#/page/" + p.id); }

async function home() {
  const grid = h("div", { class: "grid" }); let all = [];
  const q = h("input", { type: "search", placeholder: "Cerca negli appunti", "aria-label": "Cerca" });
  const draw = () => {
    const term = q.value.trim().toLowerCase(), ps = all.filter(p => !term || (p.title || "").toLowerCase().includes(term) || (p.texts || []).some(t => (t.text || "").toLowerCase().includes(term)));
    if (!ps.length) { grid.className = ""; grid.replaceChildren(h("div", { class: "empty" }, icon("note"), h("b", null, term ? "Nessun risultato" : "Nessuna nota"), term ? "Prova con un'altra parola." : "Tocca «Nuova nota» per scrivere con la Pencil, oppure «Registra» per trascrivere una lezione.")); return; }
    grid.className = "grid";
    grid.replaceChildren(...ps.map((p, i) => {
      const cv = h("div", { class: "cover" });
      const b = h("div", { class: "nb", style: `animation-delay:${Math.min(i, 12) * 35}ms`, role: "button", tabindex: "0", onclick: () => go("#/page/" + p.id) }, cv, h("b", null, p.title || "Senza titolo"), h("span", { class: "m" }, when(p.updated || p.created)),
        h("button", { class: "more", "aria-label": "Altro", onclick: e => { e.stopPropagation(); pageMenu(p); } }, "⋯"));
      if (p.noteId) cv.append(h("span", { class: "badge" }, "● lezione"));
      requestAnimationFrame(() => { try { cv.prepend(renderThumb(p, 200)); } catch (e) { console.error("thumb", e.message); } });
      return b;
    }));
  };
  const pageMenu = p => { const o = sheet([h("h3", null, p.title || "Nota"), h("div", { class: "group" },
    h("button", { class: "cell", onclick: async () => { o.remove(); const t = await promptBox("Rinomina", p.title); if (t) { p.title = t; await putPage(p); draw(); } } }, h("div", { class: "grow" }, "Rinomina")),
    h("button", { class: "cell danger", onclick: async () => { o.remove(); if (await confirmBox("Eliminare questa nota?")) { await delPage(p.id); all = all.filter(x => x.id !== p.id); draw(); } } }, h("div", { class: "grow" }, "Elimina")))], { center: true }); };
  app.append(h("h1", null, "Appunti"), h("div", { class: "sub" }, "Scrivi con la Apple Pencil e trascrivi le lezioni, tutto su questo iPad."),
    h("div", { class: "search" }, icon("search"), q), grid,
    h("div", { class: "fabs" }, h("button", { class: "fab rec", onclick: () => go("#/rec") }, icon("mic"), "Registra"), h("button", { class: "fab new", onclick: createFromDialog }, icon("compose"), "Nuova nota")));
  q.addEventListener("input", draw); all = await allPages(); draw();
}

async function recsView() {
  const list = h("div", { class: "group" }), notes = await allNotes();
  app.append(h("h1", null, "Registrazioni"), h("div", { class: "sub" }, notes.length ? `${notes.length} ${notes.length === 1 ? "registrazione" : "registrazioni"}` : "Le lezioni registrate compaiono qui."),
    notes.length ? list : h("div", { class: "empty" }, icon("wave"), h("b", null, "Nessuna registrazione"), "Premi «Registra» per trascrivere una lezione."),
    h("div", { class: "fabs" }, h("button", { class: "fab rec", onclick: () => go("#/rec") }, icon("mic"), "Registra")));
  list.replaceChildren(...notes.map(n => h("button", { class: "cell", onclick: () => go("#/note/" + n.id) }, h("span", { class: "ico", style: "background:var(--rec)", html: ic.wave }),
    h("div", { class: "grow" }, h("div", { class: "t" }, n.title), h("div", { class: "m" }, `${when(n.created)} · ${fmt(n.duration || 0)} · ${(MODELS[n.model] || [n.model])[0].split(" — ")[0]}${n.status !== "done" ? " · interrotta" : ""}`)), h("span", { class: "chev", html: ic.chev }))));
}

// trascrizione: il testo detto è nero; ciò che aggiunge l'app (orari, paragrafi, avvisi) è viola e corsivo
function transcriptView() {
  const box = h("div", { class: "tx" }); let lastEnd = -1, follow = true;
  box.addEventListener("scroll", () => { follow = box.scrollTop + box.clientHeight > box.scrollHeight - 40; });
  const api = {
    el: box,
    add(seg, animate = true) {
      if (lastEnd < 0 || seg.start - lastEnd > 4) box.append(h("div", { class: "meta para" + (animate ? " in" : "") }, `¶ ${lastEnd < 0 ? "Inizio" : "Nuovo paragrafo"} · ${fmt(seg.start)}`));
      const p = box.lastElementChild && box.lastElementChild.classList.contains("spoken") ? box.lastElementChild : box.appendChild(h("p", { class: "spoken" }));
      const words = seg.text.split(/\s+/).filter(Boolean);
      words.forEach((w, i) => { const s = h("span", { class: animate ? "w" : "" }, w); if (animate) s.style.animationDelay = (i * 55) + "ms"; p.append(s, " "); });
      lastEnd = seg.start + (seg.dur || 3);
      if (follow) requestAnimationFrame(() => box.scrollTo({ top: box.scrollHeight, behavior: animate ? "smooth" : "auto" }));
    },
    meta(text, cls = "") { box.append(h("div", { class: "meta in " + cls }, text)); if (follow) box.scrollTop = box.scrollHeight; },
  };
  return api;
}

async function rec() {
  app.classList.add("full");
  const model = cfg.get("model", "onnx-community/whisper-small"), lang = cfg.get("lang", "italian");
  const box = h("div", { class: "recmsg" }), status = h("span", { class: "recstat" }, "Preparazione…"), lag = h("span", { class: "mut" });
  const tv = transcriptView(), btn = h("button", { class: "primary", disabled: true }, "Attendi…");
  const panel = h("aside", { class: "txpanel" }, h("div", { class: "txhead" }, h("b", null, "Trascrizione live"), h("span", { class: "legend" }, h("i", { class: "lg-s" }), "detto ", h("i", { class: "lg-m" }), "aggiunto dall'app")), box, tv.el);
  const handle = h("div", { class: "split-h", "aria-label": "Ridimensiona" });
  const nbHost = h("div", { class: "nbhost" });
  const back = h("button", { class: "ib", "aria-label": "Indietro", onclick: () => go("#/") }, "‹");
  const head = h("div", { class: "rechead" }, back, status, lag);
  const body = h("div", { class: "split" + (cfg.get("txpanel", "0") === "1" ? "" : " nopanel") }, nbHost, handle, panel);
  app.append(body);
  const savedW = +cfg.get("txw", "360"); panel.style.setProperty("--w", savedW + "px");
  handle.addEventListener("pointerdown", e => { e.preventDefault(); const portrait = innerHeight > innerWidth; const r = body.getBoundingClientRect(); const mv = ev => { const v = portrait ? clamp(r.bottom - ev.clientY, 120, r.height - 200) : clamp(r.right - ev.clientX, 220, r.width - 300); panel.style.setProperty("--w", v + "px"); cfg.set("txw", v); }; const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); }; addEventListener("pointermove", mv); addEventListener("pointerup", up); });
  const id = "n" + Date.now(), t0 = Date.now(), note = { id, title: "Lezione " + new Date().toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }), created: t0, duration: 0, model, lang, status: "recording", segments: [] };
  const page = newPage(note.title, { noteId: id }); note.pageId = page.id;
  const nb = createNotebook(nbHost, page, { header: head, onChange: p => putPage(p) });
  head.after(btn); const pauseB = h("button", { disabled: true }, "Pausa"); btn.after(pauseB);
  const panB = h("button", { class: "ib small", title: "Mostra anche il pannello laterale della trascrizione", "aria-label": "Pannello trascrizione", onclick: () => { const on = body.classList.toggle("nopanel"); cfg.set("txpanel", on ? "0" : "1"); } }, "▤"); pauseB.after(panB);
  let finished = false;
  cleanup = async () => { if (finishFn) await finishFn(); nb.destroy(); app.classList.remove("full"); };
  let finishFn = null;
  if (!navigator.mediaDevices?.getUserMedia) { box.append(h("div", { class: "bad" }, "Il microfono non è disponibile: apri l'app dall'indirizzo https e consenti il microfono. Puoi comunque prendere appunti.")); status.textContent = "Solo appunti"; delete page.noteId; await putPage(page); return; }
  loadUI(box);
  try { await Engine.load(model); } catch (e) { box.replaceChildren(h("div", { class: "bad" }, "Modello non caricato: " + e.message + " — serve Internet la prima volta (prova un modello più piccolo). Puoi comunque prendere appunti."), h("button", { onclick: () => location.reload() }, "Riprova")); status.textContent = "Solo appunti"; delete page.noteId; await putPage(page); return; }
  box.replaceChildren();
  tv.meta(`Modello pronto · ${Engine.device === "webgpu" ? "GPU" : "CPU (più lento)"} · ${(MODELS[model] || [model])[0].split(" — ")[0]}`);
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } }); } catch (e) { tv.meta("Microfono negato: consentilo nelle impostazioni di Safari. Puoi comunque prendere appunti.", "bad"); status.textContent = "Solo appunti"; delete page.noteId; await putPage(page); return; }
  await putNote(note); await putPage(page);
  let lastEnd = -1, received = 0, doneTo = 0, pending = 0, chain = Promise.resolve(), paused = false, wake = null, stopped = false, ai = 0;
  const ctx = new (window.AudioContext || window.webkitAudioContext)(); await ctx.resume();
  const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), mute = ctx.createGain(); mute.gain.value = 0;
  const seg = new Segmenter((start, audio) => { pending++; const dur = audio.length / 16000; chain = chain.then(async () => { try { const r = await Engine.run(audio, lang); if (r.text) { const s = { start, dur, text: r.text }; const para = lastEnd < 0 || start - lastEnd > 4; nb.addTranscript(s, para ? `¶ ${lastEnd < 0 ? "Inizio" : "Nuovo paragrafo"} · ${fmt(start)}` : null); lastEnd = start + dur; note.segments.push(s); tv.add(s); await putNote(note); } doneTo = start + dur; } catch (e) { tv.meta("Errore su una frase: " + e.message, "bad"); } pending--; }); });
  proc.onaudioprocess = e => { if (paused || stopped) return; const d = e.inputBuffer.getChannelData(0); received += d.length / ctx.sampleRate; seg.feed(downsample(new Float32Array(d), ctx.sampleRate)); };
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  let mr; try { mr = new MediaRecorder(stream); mr.ondataavailable = e => { if (e.data.size) putAudio(id, ai++, e.data); }; mr.start(5000); note.mime = mr.mimeType; } catch { tv.meta("Il salvataggio dell'audio non è supportato su questo browser: avrai solo il testo.", "bad"); }
  try { wake = await navigator.wakeLock?.request("screen"); } catch {}
  const tick = setInterval(() => { const l = Math.max(0, received - doneTo); status.textContent = `${paused ? "❚❚" : "●"} ${fmt(received)}`; status.classList.toggle("paused", paused); lag.textContent = pending ? ` · ritardo ~${Math.round(l)} s` + (l > 45 ? " (modello lento: scegline uno più piccolo)" : "") : ""; }, 500);
  btn.disabled = false; btn.textContent = "■ Stop"; pauseB.disabled = false;
  pauseB.onclick = () => { paused = !paused; if (mr) try { paused ? mr.pause() : mr.resume(); } catch {} pauseB.textContent = paused ? "Riprendi" : "Pausa"; { const m = paused ? `❚❚ In pausa · ${fmt(received)}` : `▶ Ripresa · ${fmt(received)}`; tv.meta(m); nb.addTranscriptMeta(m); } };
  finishFn = async () => { if (stopped) return; stopped = true; clearInterval(tick); btn.disabled = true; btn.textContent = "Salvo…"; seg.flush(); try { mr && mr.state !== "inactive" && mr.stop(); } catch {} stream.getTracks().forEach(t => t.stop()); proc.disconnect(); ctx.close(); wake && wake.release().catch(() => {}); await chain; await new Promise(r => setTimeout(r, 400)); note.status = "done"; note.duration = received; await putNote(note); await putPage(nb.page); window.onbeforeunload = null; };
  btn.onclick = async () => { await finishFn(); go("#/note/" + id); };
  window.onbeforeunload = () => stopped ? null : "Registrazione in corso";
}

async function importView() {
  const model = cfg.get("model", "onnx-community/whisper-small"), lang = cfg.get("lang", "italian");
  const box = h("div"), out = h("div", { class: "card big" }), st = h("div", { class: "mut" });
  const inp = h("input", { type: "file", accept: "audio/*,video/*", style: "display:none", onchange: async () => {
    const f = inp.files[0]; if (!f) return; pick.disabled = true;
    try {
      loadUI(box); await Engine.load(model); box.replaceChildren(h("div", { class: "ok" }, "Modello pronto."));
      st.textContent = "Leggo il file…"; const ac = new (window.AudioContext || window.webkitAudioContext)(); const dec = await ac.decodeAudioData(await f.arrayBuffer()); ac.close();
      const mono = dec.numberOfChannels > 1 ? (() => { const a = dec.getChannelData(0), b = dec.getChannelData(1), o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = (a[i] + b[i]) / 2; return o; })() : new Float32Array(dec.getChannelData(0));
      const pcm = downsample(mono, dec.sampleRate), W = 16000 * 25, id = "n" + Date.now();
      const note = { id, title: f.name.replace(/\.[^.]+$/, ""), created: Date.now(), duration: pcm.length / 16000, model, lang, status: "recording", segments: [], mime: f.type || "audio/mp4" };
      await putNote(note); await putAudio(id, 0, f);
      for (let o = 0, k = 0; o < pcm.length; o += W, k++) { st.textContent = `Trascrivo… ${Math.min(100, Math.round(100 * o / pcm.length))}%`; const r = await Engine.run(pcm.slice(o, o + W), lang); if (r.text) { note.segments.push({ start: o / 16000, text: r.text }); out.append(h("span", null, r.text + " ")); await putNote(note); } }
      note.status = "done"; await putNote(note); go("#/note/" + id);
    } catch (e) { st.replaceChildren(h("span", { class: "bad" }, "Errore: " + e.message + " (file troppo lungo o formato non leggibile? Prova un file più corto)")); pick.disabled = false; }
  } });
  const pick = h("button", { class: "primary", onclick: () => inp.click() }, "Scegli un file audio");
  app.append(h("h1", null, "Carica un audio"), h("div", { class: "mut" }, "Es. le registrazioni mandate da un amico. Il file viene decodificato in memoria: per lezioni molto lunghe (oltre ~1 ora) conviene registrare dal vivo."), h("div", { class: "row" }, modelSel(), langSel()), box, h("div", { class: "row" }, pick, h("button", { onclick: () => go("#/") }, "Indietro")), inp, st, out);
}

async function detail(id) {
  const n = await getNote(id); if (!n) return go("#/recs");
  const title = h("input", { type: "text", class: "titlein", value: n.title, "aria-label": "Titolo", onchange: async () => { n.title = title.value; await putNote(n); } });
  const text = n.segments.map(s => s.text).join(" ");
  const blobs = await getAudio(id); const blob = blobs.length ? new Blob(blobs, { type: n.mime || "audio/mp4" }) : null;
  const ext = (n.mime || "").includes("webm") ? "webm" : (n.mime || "").includes("wav") ? "wav" : "m4a";
  let aud = null; if (blob) { const url = URL.createObjectURL(blob); cleanup = () => URL.revokeObjectURL(url); aud = h("div", { class: "card" }, h("audio", { controls: "", src: url })); }
  const dl = (b, name) => { const a = h("a", { href: URL.createObjectURL(b), download: name }); document.body.append(a); a.click(); a.remove(); };
  const file = blob && new File([blob], `${n.title}.${ext}`, { type: blob.type });
  const tv = transcriptView(); tv.el.classList.add("static"); n.segments.forEach(s => tv.add(s, false));
  const page = n.pageId && await getPage(n.pageId);
  const pill = (k, label, fn, cls) => h("button", { class: cls || "", onclick: fn }, icon(k), label);
  app.append(h("button", { class: "back", onclick: () => go("#/recs") }, icon("back"), "Registrazioni"), title,
    h("div", { class: "sub" }, `${when(n.created)} · ${fmt(n.duration || 0)}${n.status !== "done" ? " · registrazione interrotta (testo parziale)" : ""}`), aud,
    h("div", { class: "pills" },
      page && pill("compose", "Apri gli appunti", () => go("#/page/" + page.id), "primary"),
      pill("copy", "Copia testo", async () => { try { await navigator.clipboard.writeText(text); toast("Testo copiato"); } catch { prompt("Copia il testo:", text); } }),
      pill("txt", "Scarica .txt", () => dl(new Blob([text], { type: "text/plain" }), n.title + ".txt")),
      blob && pill("share", "Condividi audio", async () => { try { if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: n.title }); else dl(blob, file.name); } catch {} }),
      pill("trash", "Elimina", async () => { if (await confirmBox("Eliminare questa registrazione e il suo audio?" + (page ? " Gli appunti scritti restano in «Appunti»." : ""))) { await delNote(id); go("#/recs"); } }, "danger")),
    h("div", { class: "card transcript" }, n.segments.length ? tv.el : h("div", { class: "mut" }, "Nessun testo.")),
    h("div", { class: "mut", style: "padding:0 6px" }, "Per la qualità massima: condividi l'audio e ritrascrivilo con l'app server (modelli grandi, parlanti, correzione AI)."));
}

async function pageView(id) {
  const p = await getPage(id); if (!p) return go("#/");
  app.classList.add("full");
  const title = h("input", { type: "text", class: "ptitle", value: p.title, "aria-label": "Titolo", onchange: () => { p.title = title.value; putPage(p); } });
  const head = h("div", { class: "rechead" }, h("button", { class: "ib", "aria-label": "Indietro", onclick: () => go("#/") }, "‹"), title,
    p.noteId && h("button", { class: "ib small", "aria-label": "Apri la registrazione", onclick: () => go("#/note/" + p.noteId) }, "🎙"),
    h("button", { class: "ib small", "aria-label": "Elimina pagina", onclick: async () => { if (await confirmBox("Eliminare questa nota?")) { p._deleted = true; await delPage(id); go("#/"); } } }, "🗑"));
  const host = h("div", { class: "nbhost solo" }); app.append(host);
  const nb = createNotebook(host, p, { header: head, onChange: x => { if (!x._deleted) putPage(x); } });
  cleanup = () => { nb.destroy(); app.classList.remove("full"); };
}

async function settings() {
  const out = h("div", { class: "group" }), box = h("div"), r = h("div", { class: "mut", style: "padding:8px 12px" });
  const chk = (ok, t) => h("div", { class: "cell" }, h("span", { class: "chk" }, h("span", { class: "d" + (ok ? "" : " no") }, ok ? "✓" : "✕")), h("div", { class: "grow" }, t));
  out.append(chk(!!navigator.gpu, navigator.gpu ? "GPU (WebGPU): modelli veloci" : "GPU non disponibile: userà la CPU, più lenta"), chk(!!navigator.mediaDevices?.getUserMedia, "Microfono (serve https)"), chk(!!window.MediaRecorder, "Salvataggio dell'audio"), chk(!!navigator.wakeLock, "Schermo acceso durante la registrazione"));
  try { const e = await navigator.storage.estimate(); out.append(h("div", { class: "cell" }, h("div", { class: "grow" }, "Spazio disponibile"), h("span", { class: "mut" }, `~${Math.round((e.quota - e.usage) / 1e9)} GB`))); } catch {}
  try { await navigator.storage.persist(); } catch {}
  const test = h("button", { class: "primary", onclick: async e => { e.target.disabled = true; const t = performance.now(); loadUI(box); try { await Engine.load(cfg.get("model", "onnx-community/whisper-small")); r.textContent = `Modello caricato in ${((performance.now() - t) / 1000).toFixed(1)} s su ${Engine.device === "webgpu" ? "GPU" : "CPU"}. La velocità vera si vede in registrazione: se compare «ritardo» che cresce, scegli un modello più piccolo.`; r.className = "ok"; } catch (err) { r.replaceChildren(h("span", { class: "bad" }, "Errore: " + err.message)); } e.target.disabled = false; } }, "Scarica e prova il modello");
  app.append(h("h1", null, "Impostazioni"), h("div", { class: "sub" }, "Il modello si scarica una sola volta e resta sull'iPad."),
    h("h2", null, "Trascrizione"), h("div", { class: "group" },
      h("div", { class: "cell" }, h("span", { class: "ico", html: ic.cpu }), h("div", { class: "grow" }, "Modello"), modelSel()),
      h("div", { class: "cell" }, h("span", { class: "ico", style: "background:#34a853", html: ic.globe }), h("div", { class: "grow" }, "Lingua"), langSel())),
    h("div", { class: "row", style: "margin:12px 0" }, test), box, r,
    h("h2", null, "Questo iPad"), out,
    h("h2", null, "Privacy"), h("div", { class: "card mut" }, "Audio, testi e appunti restano nell'archivio del browser di questo iPad. Nessun server, nessun account. Se cancelli i dati di Safari per questo sito, l'archivio si cancella: condividi l'audio o copia il testo di ciò che vuoi conservare."));
}

document.head.append(h("style", null, INK_CSS));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
// recupero: registrazioni rimaste "in corso" dopo una chiusura improvvisa
(async () => { for (const n of await allNotes()) if (n.status === "recording" && Date.now() - n.created > 60000 && !(location.hash || "").includes(n.id)) { n.status = "interrupted"; await putNote(n); } route(); })();
