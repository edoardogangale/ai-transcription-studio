"use strict";
/* AI Transcription Studio - frontend senza build (vanilla JS). Tutti i dati arrivano dall'API locale. */
const $app = document.getElementById("app");
// replaceChildren ignora null/false e appiattisce gli array (evita "false"/"null" come testo nella pagina)
const _rc = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...n) { return _rc.apply(this, n.flat(Infinity).filter(x => x != null && x !== false)); };
const LS = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
let timers = [];                       // polling da fermare a ogni cambio pagina
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
const poll = (fn, ms) => { timers.push(setInterval(fn, ms)); };

/* ---------- utilità ---------- */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const fmtT = s => { s = Math.max(0, s | 0); const hh = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, ss = s % 60; return (hh ? hh + ":" + String(m).padStart(2, "0") : m) + ":" + String(ss).padStart(2, "0"); };
const fmtB = b => b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : b > 1e3 ? (b / 1e3 | 0) + " KB" : b + " B";
const fmtDate = t => new Date(t * 1000).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function toast(msg, ms = 3200) { const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms); }
const token = () => LS.get("studio_token", "");
const withTok = p => token() ? p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token()) : p;

async function api(path, opt = {}) {
  const o = { ...opt, headers: { ...(opt.headers || {}) } };
  if (token()) o.headers["X-Studio-Token"] = token();
  if (opt.json !== undefined) { o.method = o.method || "POST"; o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(opt.json); delete o.json; }
  const r = await fetch(path, o);
  if (r.status === 401) { const t = prompt("Questo server è protetto. Inserisci il token di accesso:"); if (t) { LS.set("studio_token", t.trim()); return api(path, opt); } throw new Error("Accesso negato"); }
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch {} throw new Error(typeof m === "string" ? m : JSON.stringify(m)); }
  return r.status === 204 ? null : r.json();
}

/* ---------- tema ---------- */
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme(LS.get("theme", ""));
document.getElementById("themeBtn").onclick = () => {
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme:dark)").matches);
  const n = dark ? "light" : "dark"; LS.set("theme", n); applyTheme(n);
};

/* ---------- router ---------- */
const routes = [[/^#\/new$/, pageNew], [/^#\/t\/(\w+)$/, pageEditor], [/^#\/c\/(\w+)$/, pageCompare], [/^#\/models$/, pageModels], [/^#\/settings$/, pageSettings], [/^#?\/?$/, pageHome]];
async function route() {
  clearTimers();
  const hash = location.hash || "#/";
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === (hash.startsWith("#/models") ? "models" : hash.startsWith("#/settings") ? "settings" : "")));
  for (const [re, fn] of routes) { const m = hash.match(re); if (m) { $app.replaceChildren(h("p", { class: "sub" }, h("span", { class: "spin" }), " Caricamento…")); try { await fn(...m.slice(1)); } catch (e) { $app.replaceChildren(h("div", { class: "notice bad" }, "Errore: " + e.message)); } window.scrollTo(0, 0); return; } }
}
addEventListener("hashchange", route);

/* ---------- Home / archivio ---------- */
const STATUS = { queued: ["In coda", ""], running: ["In elaborazione", "warn"], done: ["Completata", "ok"], failed: ["Fallita", "bad"], cancelled: ["Annullata", ""] };
const MODEL_SHORT = { "parakeet-tdt-0.6b-v3": "Parakeet v3", "parakeet-tdt-0.6b-v2": "Parakeet v2", "whisper-large-v3": "Whisper L-v3", "voxtral-mini-4b-realtime": "Voxtral 4B", mock: "MOCK", mock2: "MOCK B" };
const mname = id => MODEL_SHORT[id] || id;

function jobItem(t) {
  const [lab, cls] = STATUS[t.status] || [t.status, ""];
  const prog = t.status === "running" || t.status === "queued";
  const pct = t.chunks_total ? Math.round(100 * t.chunks_done / t.chunks_total) : 0;
  return h("a", { class: "item", href: t.group_id && t.status !== "done" ? "#/c/" + t.group_id : t.group_id ? "#/c/" + t.group_id : "#/t/" + t.id },
    h("div", { class: "grow" },
      h("div", { class: "t" }, t.title || t.filename),
      h("div", { class: "m" }, [MODEL_SHORT[t.model_id] || t.model_id, t.language, t.duration ? fmtT(t.duration) : "", fmtDate(t.created), t.group_id ? "confronto" : ""].filter(Boolean).join(" · ")),
      prog && h("div", { style: "margin-top:6px" }, h("div", { class: "bar" }, h("i", { style: `width:${pct}%` })),
        h("div", { class: "m" }, t.chunks_total ? `Segmento audio ${t.chunks_done} di ${t.chunks_total}` : "In attesa di avvio…")),
      t.status === "failed" && h("div", { class: "m err" }, t.error)),
    h("span", { class: "chip " + cls }, lab),
    prog && h("button", { class: "small", onclick: async ev => { ev.preventDefault(); await api(`/api/transcripts/${t.id}/cancel`, { method: "POST" }); toast("Annullamento richiesto"); } }, "Annulla"),
    (t.status === "failed" || t.status === "cancelled") && h("button", { class: "small", onclick: async ev => { ev.preventDefault(); try { await api(`/api/transcripts/${t.id}/retry`, { method: "POST" }); toast("Ripreso dai segmenti già elaborati"); } catch (e) { toast(e.message); } } }, "Riprendi"));
}

async function pageHome() {
  const box = h("div"); let q = "";
  const searchInput = h("input", { type: "search", placeholder: "Cerca nell'archivio…", oninput: e => { q = norm(e.target.value); draw(); } });
  $app.replaceChildren(
    h("div", { class: "row sp" }, h("div", null, h("h1", null, "Trascrizioni"), h("p", { class: "sub" }, "Tutto resta sul tuo computer.")),
      h("div", { class: "row" }, h("a", { class: "btn primary", href: "#/new" }, "＋ Nuova trascrizione"))),
    searchInput, box);
  let items = [];
  function draw() {
    const act = items.filter(t => ["queued", "running"].includes(t.status));
    const rest = items.filter(t => !["queued", "running"].includes(t.status) && norm((t.title || "") + " " + (t.filename || "")).includes(q));
    box.replaceChildren(
      act.length ? h("div", null, h("h2", null, "Processi in corso"), h("div", { class: "list" }, act.map(jobItem))) : null,
      rest.length ? h("div", null, h("h2", null, q ? "Risultati" : "Archivio"), h("div", { class: "list" }, rest.map(jobItem)))
        : (!act.length && h("div", { class: "notice", style: "margin-top:20px" }, q ? "Nessun risultato." : "Ancora nessuna trascrizione. Premi “Nuova trascrizione” per iniziare.")));
  }
  async function load() { items = await api("/api/transcripts"); if (document.activeElement !== searchInput || true) draw(); }
  await load(); poll(() => load().catch(() => {}), 2000);
}

/* ---------- Nuova trascrizione ---------- */
async function pageNew() {
  const sys = await api("/api/system");
  const st = { file: null, meta: null, lang: LS.get("lang", "it"), model: null, multi: [], compare: false, uploading: false, rec: null };
  const hw = sys.hardware;
  const fileInput = h("input", { type: "file", accept: "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.webm,.mp4", hidden: true, onchange: e => e.target.files[0] && setFile(e.target.files[0]) });
  const info = h("div"), drop = h("div", { class: "drop" });
  const recBtn = h("button", { onclick: toggleRec }, "🎙 Registra dal microfono");
  drop.append(h("div", { style: "font-size:34px" }, "⬆"), h("p", null, "Trascina qui un file audio (MP3, WAV, M4A, AAC, FLAC, OGG…)"),
    h("div", { class: "row", style: "justify-content:center" }, h("button", { onclick: () => fileInput.click() }, "Scegli file"), recBtn), fileInput);
  ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => e.dataTransfer.files[0] && setFile(e.dataTransfer.files[0]));

  async function toggleRec() {
    if (st.rec) { st.rec.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { toast("Il microfono richiede HTTPS o localhost: vedi README (sezione iPad)."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream), chunks = [];
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); st.rec = null; recBtn.textContent = "🎙 Registra dal microfono"; const type = rec.mimeType || "audio/webm"; const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"; setFile(new File(chunks, `registrazione-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${ext}`, { type })); };
      rec.start(); st.rec = rec; recBtn.textContent = "⏹ Ferma registrazione";
    } catch (e) { toast("Microfono non autorizzato o non disponibile: " + e.message); }
  }

  function setFile(f) {
    st.file = f; st.meta = null; st.uploading = true; renderInfo();
    const fd = new FormData(); fd.append("file", f);
    const x = new XMLHttpRequest(); x.open("POST", "/api/upload");
    if (token()) x.setRequestHeader("X-Studio-Token", token());
    x.upload.onprogress = e => { if (e.lengthComputable) { info.querySelector(".bar i").style.width = (100 * e.loaded / e.total) + "%"; } };
    x.onload = () => { st.uploading = false; if (x.status === 200) st.meta = JSON.parse(x.responseText); else { st.file = null; let m = "Caricamento fallito"; try { m = JSON.parse(x.responseText).detail; } catch {} toast(m, 5000); } renderInfo(); updateStart(); };
    x.onerror = () => { st.uploading = false; st.file = null; toast("Errore di rete"); renderInfo(); };
    x.send(fd);
  }
  function renderInfo() {
    if (!st.file) return info.replaceChildren();
    info.replaceChildren(h("div", { class: "card", style: "margin-top:12px" },
      h("div", { class: "t" }, st.file.name),
      st.uploading ? h("div", null, h("div", { class: "bar" }, h("i", { style: "width:0" })), h("div", { class: "m" }, "Caricamento e verifica integrità…"))
        : st.meta && h("div", { class: "m" }, `Durata ${fmtT(st.meta.duration)} · ${fmtB(st.meta.size)} · ${st.meta.codec}`)));
  }

  const ctxSel = h("select", null, sys.contexts.map(c => h("option", { value: c, selected: c === "Altro" }, c)));
  const modeSel = h("select", null, [["fedele", "A — Fedele"], ["pulita", "B — Pulita"], ["appunti", "C — Appunti strutturati (richiede LLM locale)"]].map(([v, l]) => h("option", { value: v }, l)));
  const norm_ = h("input", { type: "checkbox" }), den = h("input", { type: "checkbox" }), dia = h("input", { type: "checkbox", disabled: !sys.diarization.available });
  const langBox = h("div", { class: "row" });
  const modelBox = h("div", { class: "grid g3" });
  const startBtn = h("button", { class: "primary", disabled: true, onclick: start }, "Avvia trascrizione");
  const cmpToggle = h("input", { type: "checkbox", onchange: e => { st.compare = e.target.checked; st.multi = []; st.model = null; drawModels(); updateStart(); } });
  const hint = h("div", { class: "m" });

  function langs() {
    langBox.replaceChildren(...[["it", "Italiano"], ["en", "Inglese"], ["auto", "Rilevamento automatico"]].map(([v, l]) =>
      h("label", { class: "opt" }, h("input", { type: "radio", name: "lang", checked: st.lang === v, onchange: () => { st.lang = v; LS.set("lang", v); st.model = null; st.multi = []; langs(); loadModels(); } }), l)));
  }
  async function loadModels() {
    const r = await api("/api/models?language=" + st.lang); st.models = r; st.rec_id = r.recommended; st.rec_why = r.recommended_reason; drawModels(); updateStart();
  }
  function drawModels() {
    const r = st.models; if (!r) return;
    modelBox.replaceChildren(...r.models.map(m => {
      const selected = st.compare ? st.multi.includes(m.id) : st.model === m.id;
      const usable = m.compatible && m.installed;
      const bench = m.benchmark ? h("span", null, m.benchmark.text + " ", h("a", { href: m.benchmark.url, target: "_blank", rel: "noopener" }, "fonte")) : "nessun benchmark verificato";
      const req = [`RAM ≥ ${m.min_ram_gb} GB`, m.min_vram_gb ? `VRAM ≥ ${m.min_vram_gb} GB` : null, m.cpu ? "CPU" : "solo GPU"].filter(Boolean).join(" · ");
      return h("div", { class: "card model " + (selected ? "sel " : "") + (usable ? "" : "off"), tabindex: 0, onclick: () => pick(m, usable) },
        h("div", { class: "row sp" }, h("h3", null, m.name), m.id === r.recommended && h("span", { class: "chip rec", title: r.recommended_reason }, "Consigliato")),
        h("dl", null,
          h("dt", null, "Dimensione"), h("dd", null, m.installed ? fmtB(m.disk_bytes) + " su disco" : "noto dopo il download"),
          h("dt", null, "Requisiti"), h("dd", null, req),
          h("dt", null, "Accuratezza"), h("dd", null, bench),
          h("dt", null, "Velocità"), h("dd", null, "non misurata su questo PC"),
          h("dt", null, "Timestamp"), h("dd", null, m.word_timestamps ? "per parola" : "solo per segmento"),
          h("dt", null, "Stato"), h("dd", null, !m.compatible ? h("span", { class: "err" }, "Non compatibile: " + m.incompatible_reason) : m.installed ? h("span", { class: "chip ok" }, "Installato") : h("span", { class: "chip warn" }, "Non installato"))),
        !m.installed && m.compatible && h("a", { href: "#/models", onclick: e => e.stopPropagation() }, "Installa dalla sezione Modelli AI →"),
        h("details", { onclick: e => e.stopPropagation() }, h("summary", null, "Note e verifica"), h("p", null, m.notes), h("p", null, h("b", null, "Verifica: "), m.verification), h("p", null, "Licenza: " + m.license)),
        h("button", { class: selected ? "primary" : "", disabled: !usable }, selected ? "Selezionato ✓" : "Seleziona"));
    }));
    hint.textContent = r.recommended_reason || "";
  }
  function pick(m, usable) {
    if (!usable) { toast(!m.compatible ? m.incompatible_reason : "Modello non installato: installalo dalla sezione Modelli AI."); return; }
    if (st.compare) { st.multi = st.multi.includes(m.id) ? st.multi.filter(x => x !== m.id) : [...st.multi, m.id].slice(0, 3); } else st.model = m.id;
    drawModels(); updateStart();
  }
  function updateStart() {
    const ready = st.meta && (st.compare ? st.multi.length >= 2 : st.model);
    startBtn.disabled = !ready; startBtn.textContent = st.compare ? "Avvia confronto" : "Avvia trascrizione";
  }
  async function start() {
    startBtn.disabled = true;
    const body = { upload_id: st.meta.upload_id, language: st.lang, context: ctxSel.value, mode: modeSel.value, normalize: norm_.checked, denoise: den.checked, diarize: dia.checked };
    try {
      if (st.compare) { const r = await api("/api/compare", { json: { ...body, model_ids: st.multi } }); location.hash = "#/c/" + r.group_id; }
      else { const r = await api("/api/transcripts", { json: { ...body, model_id: st.model } }); if (r.duplicate) toast("Questa trascrizione esiste già: la apro."); location.hash = r.duplicate ? "#/t/" + r.id : "#/"; }
    } catch (e) { toast(e.message, 6000); startBtn.disabled = false; }
  }

  $app.replaceChildren(h("h1", null, "Nuova trascrizione"), h("p", { class: "sub" }, `Hardware: ${hw.cpu_threads} thread CPU · ${hw.ram_gb} GB RAM · ${hw.gpus.length ? hw.gpus.map(g => g.name + " " + g.vram_gb + " GB").join(", ") : "nessuna GPU NVIDIA"}`),
    !sys.ffmpeg && h("div", { class: "notice bad" }, "FFmpeg non trovato: installalo per elaborare l'audio."),
    drop, info,
    h("h2", null, "Lingua"), langBox,
    h("h2", null, "Contesto e opzioni"),
    h("div", { class: "grid g2" },
      h("div", null, h("label", null, "Contesto della registrazione"), ctxSel, h("div", { class: "m" }, "Con Whisper, il glossario del contesto è passato come suggerimento al decoder. Con gli altri modelli genera solo suggerimenti di correzione nell'editor.")),
      h("div", null, h("label", null, "Vista iniziale"), modeSel)),
    h("div", { style: "margin-top:8px" },
      h("label", { class: "opt" }, norm_, h("span", null, "Normalizza il volume (consigliato per registrazioni deboli)")),
      h("label", { class: "opt" }, den, h("span", null, "Riduci il rumore di fondo (può togliere dettaglio: provalo solo se serve)")),
      h("label", { class: "opt" }, dia, h("span", null, "Distingui i parlanti (opzionale)" + (sys.diarization.available ? "" : " — non disponibile: " + sys.diarization.reason)))),
    h("div", { class: "row sp" }, h("h2", null, "Modello"), h("label", { class: "opt" }, cmpToggle, "Confronta modelli (scegline 2 o 3)")), hint, modelBox,
    h("div", { class: "row", style: "margin-top:20px" }, startBtn));
  langs(); renderInfo(); await loadModels();
}

/* ---------- Editor sincronizzato ---------- */
async function pageEditor(id) {
  let t = await api("/api/transcripts/" + id);
  if (t.status !== "done") {
    const box = h("div");
    $app.replaceChildren(h("h1", null, t.title || "Trascrizione"), box);
    const draw = () => box.replaceChildren(jobItem(t), t.status === "failed" ? h("div", { class: "notice bad" }, t.error) : null);
    draw(); poll(async () => { t = await api("/api/transcripts/" + id); draw(); if (t.status === "done") route(); }, 1500);
    return;
  }
  const segs = t.segments, orig = t.orig_segments;
  const sys = await api("/api/system");
  const audioEl = h("audio", { src: withTok(`/api/transcripts/${id}/audio`), preload: "metadata", controls: true, style: "width:100%" });
  const canvas = h("canvas", { class: "wave" }), seek = h("input", { type: "range", min: 0, max: 1000, value: 0, "aria-label": "Timeline" });
  const timeLbl = h("div", { class: "m" }, "0:00 / " + fmtT(t.duration));
  const dirty = new Set(); let saveTimer, activeIdx = -1, follow = true, peaks = [];
  const saveState = h("span", { class: "save-state" }, "Salvataggio automatico attivo");
  const list = h("div", { class: "segs" });
  const rows = segs.map((s, i) => {
    const txt = h("div", { class: "txt", contenteditable: "plaintext-only", spellcheck: "true", lang: t.language === "auto" ? (t.detected_language || "it") : t.language }, s.text);
    if (txt.contentEditable !== "plaintext-only") txt.contentEditable = "true";
    txt.addEventListener("input", () => { s.text = txt.textContent; dirty.add(i); saveState.textContent = "Modifiche non salvate…"; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 900); });
    txt.addEventListener("click", () => { const sel = getSelection(); if (!sel.isCollapsed || !sel.anchorNode) return; seekTo(wordTime(i, txt, sel)); });
    txt.addEventListener("blur", flush);
    const row = h("div", { class: "seg", "data-i": i }, h("div", null, h("button", { class: "ts", onclick: () => seekTo(s.start), title: "Vai a questo punto" }, fmtT(s.start)), s.speaker && h("div", { class: "sp-l" }, s.speaker)), txt);
    list.append(row); return { row, txt };
  });
  async function flush() {
    if (!dirty.size) return; const edits = [...dirty].map(i => ({ i, text: segs[i].text })); dirty.clear();
    try { await api("/api/transcripts/" + id, { method: "PATCH", json: { edits } }); saveState.textContent = "Salvato " + new Date().toLocaleTimeString("it-IT"); }
    catch (e) { edits.forEach(x => dirty.add(x.i)); saveState.textContent = "Salvataggio fallito: " + e.message; }
  }
  /* tempo di una parola cliccata: timestamp di parola se il segmento non è stato modificato, altrimenti stima proporzionale */
  function wordTime(i, el, sel) {
    const s = segs[i]; const r = document.createRange(); r.setStart(el, 0); try { r.setEnd(sel.anchorNode, sel.anchorOffset); } catch { return s.start; }
    const before = r.toString(); const idx = (before.match(/\S+/g) || []).length - (/\s$/.test(before) || before === "" ? 0 : 1);
    const toks = s.text.match(/\S+/g) || []; const k = Math.max(0, Math.min(idx, toks.length - 1));
    const ws = (orig[i] && orig[i].words) || [];
    if (ws.length && orig[i].text === s.text && ws.length === toks.length) return ws[k].s;
    return s.start + (s.end - s.start) * k / Math.max(toks.length, 1);
  }
  function seekTo(sec) { audioEl.currentTime = sec; audioEl.play().catch(() => {}); }
  /* player */
  const speeds = h("div", { class: "speeds" }, [0.75, 1, 1.25, 1.5, 2].map(v => h("button", { class: v === 1 ? "on" : "", onclick: e => { audioEl.playbackRate = v; speeds.querySelectorAll("button").forEach(b => b.classList.remove("on")); e.target.classList.add("on"); } }, v.toString().replace(".", ",") + "×")));
  function drawWave() {
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, hh = canvas.clientHeight; canvas.width = w * dpr; canvas.height = hh * dpr;
    const c = canvas.getContext("2d"); c.scale(dpr, dpr); c.clearRect(0, 0, w, hh);
    const cs = getComputedStyle(document.documentElement), col = cs.getPropertyValue("--mute").trim() || "#888", acc = cs.getPropertyValue("--accent").trim() || "#26e";
    const dur = audioEl.duration || t.duration, pos = dur ? audioEl.currentTime / dur : 0;
    if (peaks.length) { const n = peaks.length, mx = Math.max(...peaks) || 1; for (let x = 0; x < w; x++) { const p = peaks[Math.min(n - 1, (x / w * n) | 0)] / mx; c.fillStyle = x / w < pos ? acc : col; c.fillRect(x, hh / 2 - p * hh / 2 + 1, 1, Math.max(1, p * hh - 2)); } }
    else { c.fillStyle = col; c.fillRect(0, hh / 2, w, 1); }
    c.fillStyle = acc; c.fillRect(pos * w, 0, 2, hh);
  }
  api(`/api/transcripts/${id}/waveform`).then(w => { peaks = w.peaks; drawWave(); }).catch(() => {});
  const seekCanvas = e => { const r = canvas.getBoundingClientRect(); audioEl.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (audioEl.duration || t.duration); };
  canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); seekCanvas(e); canvas.onpointermove = seekCanvas; });
  canvas.addEventListener("pointerup", () => canvas.onpointermove = null);
  seek.oninput = () => audioEl.currentTime = seek.value / 1000 * (audioEl.duration || t.duration);
  audioEl.ontimeupdate = () => {
    const d = audioEl.duration || t.duration; seek.value = d ? audioEl.currentTime / d * 1000 : 0; timeLbl.textContent = fmtT(audioEl.currentTime) + " / " + fmtT(d); drawWave();
    let lo = 0, hi = segs.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].start <= audioEl.currentTime + 0.05) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k !== activeIdx) { rows[activeIdx]?.row.classList.remove("active"); activeIdx = k; if (k >= 0) { rows[k].row.classList.add("active"); if (follow && !audioEl.paused && document.activeElement !== rows[k].txt) rows[k].row.scrollIntoView({ block: "center", behavior: "smooth" }); } }
  };
  addEventListener("resize", drawWave);

  /* ricerca */
  const count = h("span", { class: "m" });
  const search = h("input", { type: "search", placeholder: "Cerca nel testo…", oninput: () => doSearch(search.value) });
  function doSearch(q) {
    const nq = norm(q.trim()); let n = 0; const ranges = [];
    rows.forEach(({ row, txt }, i) => {
      const hit = !nq || norm(segs[i].text).includes(nq); row.classList.toggle("hidden", !hit);
      if (hit && nq && txt.firstChild) { const nt = norm(txt.firstChild.textContent); let p = 0; while ((p = nt.indexOf(nq, p)) >= 0) { try { const r = new Range(); r.setStart(txt.firstChild, p); r.setEnd(txt.firstChild, p + nq.length); ranges.push(r); } catch {} n++; p += nq.length; } }
    });
    if (CSS.highlights) CSS.highlights.set("search", new Highlight(...ranges));
    count.textContent = nq ? `${n} risultati` : "";
  }

  /* modalità, suggerimenti, esportazione, WER */
  let mode = "fedele"; const body = h("div"), tabs = h("div", { class: "tabs" });
  ["fedele", "pulita", "appunti"].forEach(m => tabs.append(h("button", { "data-m": m, class: m === "fedele" ? "on" : "", onclick: () => setMode(m) }, { fedele: "A · Fedele", pulita: "B · Pulita", appunti: "C · Appunti" }[m])));
  async function setMode(m) {
    await flush(); mode = m; tabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.m === m));
    if (m === "fedele") return body.replaceChildren(list);
    body.replaceChildren(h("span", { class: "spin" }));
    try {
      if (m === "appunti" && !((await api("/api/transcripts/" + id)).stats || {}).notes) throw new Error("Appunti non ancora generati.");
      const r = await api(`/api/transcripts/${id}/render?mode=${m}`);
      body.replaceChildren(h("div", { class: "notice" }, r.note), h("div", { class: "reading", style: "margin-top:12px" }, r.text),
        h("button", { style: "margin-top:12px", onclick: () => navigator.clipboard?.writeText(r.text).then(() => toast("Copiato")) }, "Copia testo"));
    } catch (e) {
      if (m !== "appunti") return body.replaceChildren(h("div", { class: "notice bad" }, e.message));
      const sel = h("select", null, sys.llm_models.map(x => h("option", null, x)));
      const stt = (await api("/api/transcripts/" + id)).stats || {};
      body.replaceChildren(h("div", { class: "notice" + (sys.llm_models.length ? "" : " warn") },
        sys.llm_models.length ? "Gli appunti sono una rielaborazione generata da un LLM locale (Ollama): non sono testo pronunciato e possono contenere errori. Verifica sempre sul testo fedele."
          : "Nessun LLM locale rilevato (Ollama non raggiunto). Gli appunti strutturati richiedono un modello linguistico locale: i modelli ASR non rielaborano il testo. Installa Ollama e un modello (vedi README)."),
        stt.notes_status === "running" && h("p", null, h("span", { class: "spin" }), " Generazione in corso con " + stt.notes_llm + "…"),
        stt.notes_status === "error" && h("p", { class: "err" }, stt.notes_error),
        sys.llm_models.length > 0 && h("div", { class: "row", style: "margin-top:12px" }, sel, h("button", { class: "primary", onclick: async () => { try { await api(`/api/transcripts/${id}/notes`, { json: { llm: sel.value } }); toast("Generazione avviata"); const iv = setInterval(async () => { const s2 = (await api("/api/transcripts/" + id)).stats || {}; if (s2.notes_status !== "running") { clearInterval(iv); setMode("appunti"); } }, 3000); timers.push(iv); } catch (er) { toast(er.message, 6000); } } }, "Genera appunti")));
    }
  }
  const sugBox = h("div");
  api(`/api/transcripts/${id}/suggestions`).then(r => { if (!r.suggestions.length) return; sugBox.replaceChildren(h("details", { open: true, class: "notice" }, h("summary", null, `${r.suggestions.length} possibili correzioni dal glossario (da confermare)`),
    r.suggestions.slice(0, 40).map(s => h("div", { class: "row", style: "margin:4px 0" }, h("span", null, `${fmtT(segs[s.seg].start)} “${s.word}” → “${s.term}”`), h("button", { class: "small", onclick: e => { const el = rows[s.seg].txt; el.textContent = el.textContent.replace(s.word, s.term); segs[s.seg].text = el.textContent; dirty.add(s.seg); flush(); e.target.disabled = true; } }, "Applica"))))); }).catch(() => {});
  const exp = h("select", { onchange: e => { if (e.target.value) { window.open(withTok(`/api/transcripts/${id}/export/${e.target.value}?mode=${mode}`)); e.target.value = ""; } } },
    h("option", { value: "" }, "Esporta…"), ["txt", "pdf", "docx", "srt", "vtt", "json"].map(f => h("option", { value: f }, f.toUpperCase())));
  const werBox = h("details", null, h("summary", null, "Calcola il WER con una trascrizione di riferimento verificata"),
    h("p", null, "Incolla una trascrizione corretta a mano. Il WER ha senso solo con un riferimento affidabile."),
    h("textarea", { id: "ref", placeholder: "Testo di riferimento…" }), h("button", { onclick: async () => { try { const r = await api(`/api/transcripts/${id}/wer`, { json: { reference: werBox.querySelector("textarea").value } }); toast(`WER ${(r.wer * 100).toFixed(1)}% (${r.edits} errori su ${r.ref_words} parole)`, 8000); } catch (e) { toast(e.message); } } }, "Calcola"));
  const precision = t.has_word_ts
    ? "Timestamp a livello di parola: clicca una parola per ascoltare da lì. Dopo aver modificato un segmento il salto diventa una stima proporzionale all'interno del segmento."
    : "Questo modello fornisce timestamp solo a livello di segmento: cliccando una parola si riparte dall'inizio del segmento.";
  const title = h("input", { type: "text", value: t.title, style: "font-size:22px;font-weight:650;border:none;background:transparent;padding:0", onchange: e => api("/api/transcripts/" + id, { method: "PATCH", json: { title: e.target.value } }).then(() => toast("Titolo salvato")) });
  const followCb = h("input", { type: "checkbox", checked: true, onchange: e => follow = e.target.checked });

  $app.replaceChildren(
    h("div", { class: "row sp" }, title, h("div", { class: "row" }, exp, h("button", { class: "danger", onclick: async () => { if (confirm("Eliminare definitivamente trascrizione e file audio?")) { await api("/api/transcripts/" + id, { method: "DELETE" }); location.hash = "#/"; } } }, "Elimina"))),
    h("div", { class: "m" }, [MODEL_SHORT[t.model_id] || t.model_id, t.language === "auto" ? "lingua rilevata: " + (t.detected_language || "n/d") : t.language, t.stats && `${t.stats.words} parole`, t.stats && `elaborata in ${fmtT(t.stats.elapsed_s)}`, t.stats && `RAM di picco ${t.stats.peak_rss_mb} MB`].filter(Boolean).join(" · ")),
    h("div", { class: "editor", style: "margin-top:16px" },
      h("div", { class: "player card" }, audioEl, canvas, seek, timeLbl, speeds, h("label", { class: "opt" }, followCb, "Segui la riproduzione")),
      h("div", null, h("div", { class: "notice", style: "margin-bottom:10px" }, precision), sugBox,
        h("div", { class: "row sp", style: "margin:12px 0" }, tabs, h("div", { class: "row" }, search, count, saveState)), body, werBox)));
  body.replaceChildren(list); drawWave();
  if (!t.has_word_ts && t.stats?.diarization_note) toast(t.stats.diarization_note, 6000);
  const hashMode = ["pulita", "appunti"]; if (hashMode.includes((t.options || {}).mode)) setMode(t.options.mode);
}

/* ---------- Confronto ---------- */
async function pageCompare(gid) {
  const box = h("div"); $app.replaceChildren(h("h1", null, "Confronta modelli"), box);
  let pair = 0, c, audioId;
  const audioEl = h("audio", { controls: true, style: "width:100%;position:sticky;top:64px;z-index:5;margin:14px 0" });
  async function load() {
    c = await api("/api/compare/" + gid); audioId = c.items[0].id;
    if (!audioEl.src) audioEl.src = withTok(`/api/transcripts/${audioId}/audio`);
    draw(); if (c.items.every(i => ["done", "failed", "cancelled"].includes(i.status))) timers.forEach(clearInterval);
  }
  function draw() {
    const name = id => mname(c.items.find(i => i.id === id).model_id);
    const stats = h("div", { class: "grid g3" }, c.items.map(i => h("div", { class: "card" }, h("h3", null, mname(i.model_id)),
      i.status === "done" ? h("dl", { style: "margin:8px 0 0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:14px" },
        h("dt", null, "Tempo"), h("dd", { style: "margin:0" }, fmtT(i.stats.elapsed_s) + ` (${i.stats.elapsed_s}s)`), h("dt", null, "Parole"), h("dd", { style: "margin:0" }, i.word_count),
        h("dt", null, "RAM di picco"), h("dd", { style: "margin:0" }, i.stats.peak_rss_mb + " MB"), h("dt", null, "Timestamp"), h("dd", { style: "margin:0" }, i.has_word_ts ? "parola" : "segmento"))
        : i.status === "failed" ? h("p", { class: "err" }, i.error) : h("div", null, h("span", { class: "spin" }), ` ${STATUS[i.status]?.[0]} ${i.chunks_total ? i.chunks_done + "/" + i.chunks_total : ""}`),
      h("div", { class: "row", style: "margin-top:8px" }, h("a", { class: "btn small", href: "#/t/" + i.id }, "Apri nell'editor")))));
    const parts = [stats, audioEl];
    if (c.diffs.length) {
      const d = c.diffs[Math.min(pair, c.diffs.length - 1)];
      const sel = h("select", { onchange: e => { pair = +e.target.value; draw(); } }, c.diffs.map((x, k) => h("option", { value: k, selected: k === pair }, `${name(x.a)}  ↔  ${name(x.b)}`)));
      parts.push(h("h2", null, "Differenze"), h("div", { class: "row" }, sel, h("span", { class: "chip" }, `${d.summary.differences} punti di divergenza`)),
        h("div", { class: "notice", style: "margin:10px 0" }, c.note),
        h("div", { class: "cmp", style: "font-weight:600" }, h("div", null, "Tempo"), h("div", null, name(d.a)), h("div", null, name(d.b)), ""),
        d.blocks.slice(0, 400).map(b => h("div", { class: "cmp" }, h("div", { class: "m" }, fmtT(b.t_a)), h("div", null, b.a ? h("span", { class: "diff-del" }, b.a) : h("i", { class: "m" }, "(assente)")), h("div", null, b.b ? h("span", { class: "diff-ins" }, b.b) : h("i", { class: "m" }, "(assente)")),
          h("button", { class: "small icon-btn", title: "Ascolta", onclick: () => { audioEl.currentTime = Math.max(0, b.t_a - 1); audioEl.play(); } }, "▶"))),
        d.blocks.length > 400 && h("p", { class: "m" }, `Mostrate le prime 400 di ${d.blocks.length} differenze.`));
    }
    const refTa = h("textarea", { placeholder: "Trascrizione di riferimento verificata (facoltativo)…" });
    const werOut = h("div", { class: "m" });
    parts.push(h("details", { style: "margin-top:20px" }, h("summary", null, "WER reale (solo con riferimento verificato)"), refTa,
      h("button", { onclick: async () => { werOut.replaceChildren(...await Promise.all(c.items.filter(i => i.status === "done").map(async i => { try { const r = await api(`/api/transcripts/${i.id}/wer`, { json: { reference: refTa.value } }); return h("div", null, `${mname(i.model_id)}: WER ${(r.wer * 100).toFixed(1)}% (${r.edits} errori / ${r.ref_words} parole)`); } catch (e) { return h("div", { class: "err" }, e.message); } }))); } }, "Calcola WER"), werOut));
    box.replaceChildren(...parts.flat().filter(Boolean));
  }
  await load(); poll(() => load().catch(() => {}), 2000);
}

/* ---------- Modelli AI ---------- */
async function pageModels() {
  const box = h("div"); $app.replaceChildren(h("h1", null, "Modelli AI"), h("p", { class: "sub" }, "I pesi vengono scaricati solo quando premi “Installa”."), box);
  async function load() {
    const r = await api("/api/models/all"); const sys = await api("/api/system");
    box.replaceChildren(h("div", { class: "notice" }, `Spazio occupato dai modelli: ${fmtB(r.total_disk_bytes)} · spazio libero: ${sys.disk_free_gb} GB`),
      h("div", { class: "grid g2", style: "margin-top:14px" }, r.models.map(m => {
        const ins = m.install || {}, dl = ins.state === "downloading" || ins.state === "starting";
        const pct = ins.total ? Math.min(100, 100 * (ins.downloaded || 0) / ins.total) : 0;
        return h("div", { class: "card" }, h("div", { class: "row sp" }, h("h3", null, m.name), m.installed ? h("span", { class: "chip ok" }, "Installato · " + fmtB(m.disk_bytes)) : h("span", { class: "chip" }, "Non installato")),
          h("p", { class: "m" }, `${m.runtime} · ${m.params} parametri · lingue: ${m.languages.join(", ")}`),
          h("p", { class: "m" }, `Licenza: ${m.license}`),
          !m.compatible && h("div", { class: "notice warn" }, "Non compatibile con questo hardware: " + m.incompatible_reason),
          h("details", null, h("summary", null, "Note e stato di verifica"), h("p", null, m.notes), h("p", null, h("b", null, "Verifica: "), m.verification), h("p", null, "Repository: ", h("code", null, m.repo))),
          dl && h("div", null, h("div", { class: "bar" }, h("i", { style: `width:${pct}%` })), h("div", { class: "m" }, ins.total ? `${fmtB(ins.downloaded || 0)} / ${fmtB(ins.total)}` : "Preparazione…")),
          ins.state === "error" && h("div", { class: "notice bad" }, ins.error),
          h("div", { class: "row", style: "margin-top:10px" },
            !m.installed && h("button", { class: "primary", disabled: dl || !m.compatible, onclick: async () => { if (confirm(`Scaricare ${m.name}? Possono essere diversi GB.`)) { try { await api(`/api/models/${m.id}/install`, { method: "POST" }); load(); } catch (e) { toast(e.message); } } } }, dl ? "Download in corso…" : "Installa"),
            (m.installed || ins.state === "error") && h("button", { class: "danger", onclick: async () => { if (confirm("Eliminare i pesi di " + m.name + "?")) { try { await api("/api/models/" + m.id, { method: "DELETE" }); load(); } catch (e) { toast(e.message); } } } }, "Elimina pesi")));
      })));
  }
  await load(); poll(() => load().catch(() => {}), 2500);
}

/* ---------- Impostazioni ---------- */
async function pageSettings() {
  const sys = await api("/api/system"), v = await api("/api/vocab");
  const dev = h("select", { onchange: async e => { await api("/api/settings", { method: "PUT", json: { device: e.target.value } }); toast("Dispositivo aggiornato"); } },
    [["auto", "Automatico (GPU se presente)"], ["cpu", "CPU"], ["cuda", "GPU NVIDIA (CUDA)"]].map(([k, l]) => h("option", { value: k, selected: sys.settings.device === k }, l)));
  const term = h("input", { type: "text", placeholder: "Nuovo termine (es. Schopenhauer, ∫ f(x)dx, mitocondrio)" });
  const ctx = h("select", null, h("option", { value: "*" }, "Tutti i contesti"), v.contexts.map(c => h("option", null, c)));
  const vbox = h("div");
  function drawV(list) {
    vbox.replaceChildren(list.length ? h("div", { class: "list" }, list.map(x => h("div", { class: "item" }, h("span", { class: "grow" }, x.term), h("span", { class: "chip" }, x.context === "*" ? "tutti" : x.context), h("button", { class: "small danger", onclick: async () => { await api("/api/vocab/" + x.id, { method: "DELETE" }); refreshV(); } }, "Rimuovi")))) : h("p", { class: "m" }, "Nessun termine personalizzato."));
  }
  const refreshV = async () => drawV((await api("/api/vocab")).custom);
  drawV(v.custom);
  const tok = h("input", { type: "password", value: token(), placeholder: "Token di accesso (se il server è protetto)", onchange: e => { LS.set("studio_token", e.target.value.trim()); toast("Token salvato"); } });
  $app.replaceChildren(h("h1", null, "Impostazioni"),
    h("h2", null, "Dispositivo di inferenza"), dev,
    h("p", { class: "m" }, `CPU: ${sys.hardware.cpu_threads} thread · RAM ${sys.hardware.ram_gb} GB · GPU: ${sys.hardware.gpus.map(g => g.name + " " + g.vram_gb + "GB").join(", ") || "nessuna rilevata"}`),
    h("h2", null, "Vocabolario personalizzato"), h("div", { class: "row" }, h("div", { class: "grow" }, term), ctx, h("button", { class: "primary", onclick: async () => { if (!term.value.trim()) return; await api("/api/vocab", { json: { term: term.value, context: ctx.value } }); term.value = ""; refreshV(); } }, "Aggiungi")),
    h("p", { class: "m" }, "Usato come glossario per Whisper (initial_prompt) e per i suggerimenti di correzione nell'editor. Non sostituisce mai parole in automatico."), vbox,
    h("h2", null, "Accesso"), tok,
    h("h2", null, "Sistema"), h("div", { class: "notice" }, `Dati in: ${sys.data_dir} · FFmpeg: ${sys.ffmpeg ? "ok" : "MANCANTE"} · LLM locali (Ollama): ${sys.llm_models.join(", ") || "nessuno"} · Diarizzazione: ${sys.diarization.available ? "disponibile" : sys.diarization.reason}`));
}

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
route();
