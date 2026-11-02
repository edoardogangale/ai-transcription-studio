"use strict";
/* AI Transcription Studio - core: utilità, API, router, centro attività, notifiche, copia/condivisione, upload globale.
   Tutto ciò che deve continuare quando cambi pagina (upload, registrazione live, polling) vive qui o in live.js,
   non dentro le singole pagine. */
const $app = document.getElementById("app");
// dispositivi con schermo tattile (iPad compreso, anche con tastiera/trackpad): bersagli grandi e strumenti sempre visibili
try { if (navigator.maxTouchPoints > 0 || matchMedia("(any-pointer:coarse)").matches) document.documentElement.classList.add("touch"); } catch (e) {}
// replaceChildren ignora null/false e appiattisce gli array (evita "false"/"null" come testo nella pagina)
const _rc = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...n) { return _rc.apply(this, n.flat(Infinity).filter(x => x != null && x !== false)); };
const LS = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const LSJ = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { LS.set(k, JSON.stringify(v)); } };
let timers = [];
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
// gli aggiornamenti periodici falliscono in silenzio (es. la registrazione che stai guardando è stata appena eliminata)
const poll = (fn, ms) => { timers.push(setInterval(() => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch {} }, ms)); };

/* ---------- utilità ---------- */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const fmtT = s => { s = Math.max(0, s | 0); const hh = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, ss = s % 60; return (hh ? hh + ":" + String(m).padStart(2, "0") : m) + ":" + String(ss).padStart(2, "0"); };
const fmtB = b => b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : b > 1e3 ? (b / 1e3 | 0) + " KB" : b + " B";
const fmtDate = t => new Date(t * 1000).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function toast(msg, ms = 3200) { const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms); }
const token = () => LS.get("studio_token", "");
const withTok = p => token() ? p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token()) : p;
const MODEL_SHORT = { "parakeet-tdt-0.6b-v3": "Parakeet v3", "parakeet-tdt-0.6b-v2": "Parakeet v2", "whisper-large-v3": "Whisper Large v3", "whisper-large-v3-turbo": "Whisper Turbo", "whisper-small": "Whisper Small", "whisper-base": "Whisper Base", diarization: "Riconoscimento parlanti", mock: "MOCK", mock2: "MOCK B" };
const mname = id => MODEL_SHORT[id] || id;

async function api(path, opt = {}) {
  const o = { ...opt, headers: { ...(opt.headers || {}) } };
  if (token()) o.headers["X-Studio-Token"] = token();
  if (opt.json !== undefined) { o.method = o.method || "POST"; o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(opt.json); delete o.json; }
  const r = await fetch(path, o);
  if (r.status === 401) { await askLogin(); return api(path, opt); }
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch {} throw new Error(typeof m === "string" ? m : JSON.stringify(m)); }
  return r.status === 204 ? null : r.json();
}

/* accesso con codice personale (server condiviso con altre persone) */
let loginP = null;
function askLogin() {
  if (loginP) return loginP;
  loginP = new Promise(res => {
    const err = h("div", { class: "err" }), inp = h("input", { type: "password", placeholder: "Il tuo codice di accesso", autocomplete: "current-password", autofocus: true, style: "font-size:18px" });
    const go = async () => {
      const code = inp.value.trim(); if (!code) return;
      const r = await fetch("/api/me", { headers: { "X-Studio-Token": code } });
      if (r.ok) { LS.set("studio_token", code); d.close(); d.remove(); loginP = null; res(); if (typeof showWho === "function") showWho(); route(); } else err.textContent = "Codice non valido.";
    };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    const d = h("dialog", { class: "modal" }, h("h3", null, "Accedi"), h("p", { class: "m" }, "Inserisci il codice che ti ha dato chi gestisce questa app. Le tue registrazioni sono visibili solo a te."), inp, err,
      h("div", { class: "row", style: "justify-content:flex-end;margin-top:14px" }, h("button", { class: "primary", onclick: go }, "Entra")));
    d.addEventListener("cancel", e => e.preventDefault()); document.body.append(d); d.showModal(); setTimeout(() => inp.focus(), 50);
  });
  return loginP;
}
async function showWho() {
  try { const me = await api("/api/me"), w = document.getElementById("who"); if (!w) return;
    w.replaceChildren(me.multiuser ? [h("span", { class: "m" }, "👤 " + me.name), h("button", { class: "small", onclick: () => { LS.set("studio_token", ""); location.reload(); } }, "Esci")] : null); window.ME = me; } catch {}
}

/* dialogo modale semplice */
function modal(title, body, actions) {
  return new Promise(res => {
    let settled = false; const done = v => { if (!settled) { settled = true; res(v); } };
    const d = h("dialog", { class: "modal" }, h("h3", null, title), h("div", { class: "modal-body" }, body),
      h("div", { class: "row", style: "justify-content:flex-end;margin-top:16px" },
        (actions || [["Chiudi", null]]).map(([label, val, cls]) => h("button", { class: cls || "", onclick: () => { done(typeof val === "function" ? val() : val); d.close(); } }, label))));
    d.addEventListener("close", () => { done(null); d.remove(); });
    document.body.append(d); d.showModal();
  });
}
/* Conferma con una finestra DELL'APP: i confirm() nativi su iPad/Safari possono essere bloccati dopo qualche richiesta e allora non succede nulla */
async function confirmBox(message, { ok = "Conferma", danger = false, title = "Sei sicuro?" } = {}) {
  return !!(await modal(title, h("p", { style: "margin:0;line-height:1.5" }, message), [["Annulla", null], [ok, () => true, danger ? "danger" : "primary"]]));
}
const askText = async (title, label, value = "") => { const i = h("input", { type: "text", value, placeholder: label }); const r = await modal(title, i, [["Annulla", null], ["OK", () => i.value.trim(), "primary"]]); return r || null; };

/* Nessun errore deve restare silenzioso: se un'azione fallisce, lo si legge a schermo */
let _lastErr = "", _lastErrAt = 0;
function showErr(msg) { msg = String(msg || "Errore sconosciuto"); if (msg === _lastErr && Date.now() - _lastErrAt < 1500) return; _lastErr = msg; _lastErrAt = Date.now(); toast("⚠ " + msg, 7000); }
addEventListener("unhandledrejection", e => { const r = e.reason; if (r && r.name === "AbortError") return; showErr(r && r.message ? r.message : r); });
addEventListener("error", e => { if (/ResizeObserver/.test(e.message || "")) return; showErr(e.message); });

/* ---------- tema ---------- */
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme(LS.get("theme", ""));
document.getElementById("themeBtn").onclick = () => {
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme:dark)").matches);
  const n = dark ? "light" : "dark"; LS.set("theme", n); applyTheme(n);
};

/* ---------- router ---------- */
const ROUTES = [];
async function route() {
  clearTimers();
  const hash = location.hash || "#/";
  const sect = hash.startsWith("#/models") ? "models" : hash.startsWith("#/settings") ? "settings" : hash.startsWith("#/live") ? "live" : "";
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === sect));
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      $app.replaceChildren(h("p", { class: "sub" }, h("span", { class: "spin" }), " Caricamento…"));
      try { await fn(...m.slice(1)); } catch (e) { $app.replaceChildren(h("div", { class: "notice bad" }, "Errore: " + e.message)); }
      window.scrollTo(0, 0); return;
    }
  }
}
addEventListener("hashchange", route);

/* ---------- copia / condivisione ---------- */
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {}
  const ta = h("textarea", { style: "position:fixed;opacity:0;top:0" }); ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); return ok;
}
async function copyTranscripts(ids, opts = {}) {
  const q = new URLSearchParams({ ids: ids.join(","), mode: opts.mode || "fedele", teacher_only: opts.teacher_only ?? true, notes: opts.notes ?? true });
  const r = await fetch("/api/export/text?" + q, { headers: token() ? { "X-Studio-Token": token() } : {} });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Copia non riuscita");
  const ok = await copyText(await r.text());
  toast(ok ? (ids.length > 1 ? `Copiate ${ids.length} trascrizioni` : "Trascrizione copiata") : "Il browser ha bloccato la copia: usa PDF/TXT");
}
function downloadUrl(path) { const a = h("a", { href: withTok(path), download: "" }); document.body.append(a); a.click(); a.remove(); }
function exportBundle(ids, fmt, opts = {}) {
  const q = new URLSearchParams({ ids: ids.join(","), fmt, mode: opts.mode || "fedele", teacher_only: opts.teacher_only ?? true, notes: opts.notes ?? true });
  downloadUrl("/api/export/bundle?" + q);
}
/* condivisione audio: foglio di condivisione del sistema (file reali) se disponibile, altrimenti download/ZIP */
async function shareAudio(items) {   // items = [{id, title}]
  try {
    const files = [];
    for (const it of items) {
      const r = await fetch(`/api/transcripts/${it.id}/audio`, { headers: token() ? { "X-Studio-Token": token() } : {} });
      if (!r.ok) continue;
      const ct = r.headers.get("content-type") || "", blob = await r.blob();
      files.push(new File([blob], `${it.title}.${ct.includes("mp4") || ct.includes("m4a") ? "m4a" : ct.includes("mpeg") ? "mp3" : ct.includes("flac") ? "flac" : "wav"}`, { type: ct || blob.type }));
    }
    if (files.length && navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files, title: items.length > 1 ? "Registrazioni" : items[0].title }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  if (items.length === 1) downloadUrl(`/api/transcripts/${items[0].id}/audio?download=true`);
  else downloadUrl("/api/export/audio.zip?ids=" + items.map(i => i.id).join(","));
  toast("Condivisione di sistema non disponibile (serve HTTPS): scarico il file, poi condividilo da lì.", 5000);
}

/* ---------- notifiche di sistema (tipo download) ---------- */
const Notif = {
  supported: () => "Notification" in window,
  perm: () => ("Notification" in window ? Notification.permission : "denied"),
  async ask() { if (!this.supported() || Notification.permission !== "default") return Notification.permission; try { return await Notification.requestPermission(); } catch { return "denied"; } },
  async show(title, body, { tag, url = "#/", silent = true, sticky = false } = {}) {
    if (this.perm() !== "granted") return;
    const opt = { body, tag, icon: "icon-192.png", badge: "icon-192.png", silent, requireInteraction: sticky, renotify: false, data: { url }, timestamp: Date.now() };
    try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) return reg.showNotification(title, opt); } catch {}
    try { const n = new Notification(title, opt); n.onclick = () => { window.focus(); location.hash = url; }; } catch {}
  },
  async close(tag) { try { const reg = await navigator.serviceWorker?.getRegistration(); (await reg?.getNotifications({ tag }) || []).forEach(n => n.close()); } catch {} },
};

/* ---------- wake lock (tiene lo schermo acceso durante la registrazione) ---------- */
const Wake = { lock: null, want: false,
  async on() { this.want = true; try { if ("wakeLock" in navigator && !this.lock) { this.lock = await navigator.wakeLock.request("screen"); this.lock.addEventListener("release", () => { this.lock = null; }); } } catch {} },
  off() { this.want = false; try { this.lock?.release(); } catch {} this.lock = null; } };
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Wake.want) Wake.on(); });

/* ---------- centro attività (come il gestore dei download) ---------- */
const UP = { items: [], listeners: new Set() };        // caricamenti in corso (stato lato client)
const ACT = { jobs: [], downloads: {}, live: [], seen: new Map(), open: false };
const notifyUI = () => { UP.listeners.forEach(f => f()); renderActivity(); };

async function pollActivity() {
  try {
    const a = await api("/api/activity"); ACT.downloads = a.downloads; ACT.live = a.live; ACT.parallel = a.parallel;
    const now = new Map(a.jobs.map(j => [j.id, j]));
    for (const [id] of ACT.seen) {            // lavori spariti dall'elenco attivo = finiti: avvisa
      if (!now.has(id)) {
        api("/api/transcripts/" + id).then(t => {
          if (t.kind === "live") return;
          if (t.status === "done") { Notif.show("Trascrizione completata", t.title, { tag: "done-" + id, url: "#/t/" + id, silent: false }); toast("✓ Trascrizione completata: " + t.title); }
          else if (t.status === "failed") Notif.show("Trascrizione fallita", t.title + ": " + (t.error || ""), { tag: "fail-" + id, url: "#/t/" + id, silent: false });
        }).catch(() => {});
      }
    }
    if ([...ACT.seen.keys()].some(id => !now.has(id)) || [...now.keys()].some(id => !ACT.seen.has(id))) window.dispatchEvent(new CustomEvent("jobs-changed"));
    ACT.seen = now; ACT.jobs = a.jobs;
    const running = a.jobs.filter(j => j.status !== "recording");
    if (document.hidden && running.length) {        // notifica di avanzamento "viva" mentre l'app è in secondo piano
      const done = running.reduce((s, j) => s + (j.chunks_done || 0), 0), tot = running.reduce((s, j) => s + (j.chunks_total || 0), 0);
      Notif.show(`Trascrizione in corso (${running.length})`, tot ? `Segmenti ${done}/${tot}` : "In preparazione…", { tag: "ats-progress", url: "#/" });
    } else if (!running.length) Notif.close("ats-progress");
  } catch {}
  renderActivity();
}
function activityCount() { return UP.items.filter(u => u.state !== "done" && u.state !== "error").length + ACT.jobs.filter(j => j.status !== "recording").length + Object.keys(ACT.downloads).length; }
/* Tocchi: se un dito è appoggiato, i ridisegni periodici aspettano (altrimenti il pulsante viene sostituito e il tocco va perso) */
let _pressAt = 0;
["pointerdown", "touchstart", "mousedown"].forEach(ev => addEventListener(ev, () => { _pressAt = Date.now(); }, true));
["pointerup", "pointercancel", "touchend", "touchcancel", "mouseup"].forEach(ev => addEventListener(ev, () => { setTimeout(() => { _pressAt = 0; }, 80); }, true));
const isPressing = () => _pressAt && Date.now() - _pressAt < 2500;
function safeRedraw(fn) { if (isPressing()) setTimeout(() => safeRedraw(fn), 100); else fn(); }
const sigOf = o => { try { return JSON.stringify(o); } catch { return String(Math.random()); } };

let actStruct = "";
function activityRows() {
  const rows = [], rec = window.Recorder && Recorder.state !== "idle";
  if (rec) rows.push({ key: "rec", icon: "dot", title: Recorder.state === "paused" ? "Registrazione in pausa" : "Registrazione live", pct: null, cls: "rec",
    sub: fmtT(Recorder.elapsed()) + (Recorder.status?.lag_s > 3 ? ` · trascrizione in ritardo di ${Recorder.status.lag_s}s` : ""), actions: [{ label: "Apri", href: "#/live" }, { label: "Stop", cls: "danger", fn: () => Recorder.stop() }] });
  UP.items.slice(-8).forEach(u => rows.push({ key: "up:" + u.id, icon: u.state === "done" ? "✓" : u.state === "error" ? "⚠" : "⬆", title: u.name, pct: u.state === "uploading" ? u.pct : null, state: u.state,
    sub: u.state === "uploading" ? `Caricamento ${Math.round(u.pct)}%` : { queued: "In attesa", done: u.queued ? "Caricato · in trascrizione" : "Caricato", error: u.error || "Errore", ready: "Caricato: scegli il modello e avvia" }[u.state] || u.state,
    err: u.state === "error", actions: u.state === "uploading" || u.state === "queued" ? [{ label: "✕", fn: () => Uploads.cancel(u.id) }] : [] }));
  ACT.jobs.filter(j => j.status !== "recording").forEach(j => rows.push({ key: "job:" + j.id, icon: "✎", title: j.title, href: j.group_id ? "#/c/" + j.group_id : "#/t/" + j.id, state: j.status,
    pct: j.status === "running" ? (j.chunks_total ? 100 * j.chunks_done / j.chunks_total : 0) : null,
    sub: j.status === "running" ? ((j.stats || {}).phase || "Trascrizione") + (j.chunks_total ? ` · ${j.chunks_done}/${j.chunks_total}` : "") : "In coda",
    actions: [{ label: "✕", fn: () => api(`/api/transcripts/${j.id}/cancel`, { method: "POST" }) }] }));
  Object.entries(ACT.downloads).forEach(([id, d]) => rows.push({ key: "dl:" + id, icon: "⬇", title: "Download " + mname(id.replace(/^ai:/, "")), state: d.state, pct: d.total ? 100 * (d.downloaded ?? d.completed ?? 0) / d.total : 0,
    sub: d.state === "extracting" ? "Estrazione…" : `${fmtB(d.downloaded ?? d.completed ?? 0)} / ${fmtB(d.total || 0)}`, actions: [] }));
  return rows;
}
function renderActivity() {
  const box = document.getElementById("activity"); if (!box) return;
  const n = activityCount(), rec = !!(window.Recorder && Recorder.state !== "idle");
  if (!n && !rec && !UP.items.length) { if (actStruct) { actStruct = ""; box.replaceChildren(); } return; }
  const rows = activityRows(), label = rec ? "● Registrazione" : n ? `${n} attività` : "Attività", clearable = UP.items.some(u => u.state === "done" || u.state === "error");
  const struct = sigOf([ACT.open, rec, label, clearable, rows.map(r => [r.key, r.state, r.err, r.href, r.actions.map(a => a.label), r.pct === null])]);
  if (struct === actStruct) {   // stessa struttura: si aggiornano solo barre e testi, i pulsanti restano gli stessi nodi
    rows.forEach(r => { const el = box.querySelector(`[data-key="${CSS.escape(r.key)}"]`); if (!el) return; const i = el.querySelector(".bar i"), sub = el.querySelector(".act-sub"); if (i && r.pct != null) i.style.width = Math.max(2, r.pct) + "%"; if (sub && sub.textContent !== r.sub) sub.textContent = r.sub; });
    return;
  }
  safeRedraw(() => {
    actStruct = struct;
    const act = (a, r) => a.href ? h("a", { class: "btn small", href: a.href }, a.label) : h("button", { class: "small" + (a.cls ? " " + a.cls : ""), onclick: e => { e.preventDefault(); a.fn(); } }, a.label);
    const rowEl = r => { const inner = [h("span", null, r.icon === "dot" ? h("span", { class: "dot" }) : r.icon), h("div", { class: "grow" }, h("div", { class: "t" }, r.title), r.pct != null ? h("div", { class: "bar" }, h("i", { style: `width:${Math.max(2, r.pct)}%` })) : null, h("div", { class: "m act-sub" + (r.err ? " err" : "") }, r.sub)), r.actions.map(a => act(a, r))];
      return r.href ? h("a", { class: "act-row", href: r.href, "data-key": r.key }, inner) : h("div", { class: "act-row" + (r.cls ? " " + r.cls : ""), "data-key": r.key }, inner); };
    box.replaceChildren(h("div", { class: "act-wrap" }, ACT.open ? h("div", { class: "act-panel card" }, rows.length ? rows.map(rowEl) : h("div", { class: "m" }, "Niente in corso."),
      clearable && h("button", { class: "small", onclick: () => { UP.items = UP.items.filter(u => ["uploading", "queued", "ready"].includes(u.state)); notifyUI(); } }, "Pulisci elenco")) : null,
      h("button", { class: "act-pill" + (rec ? " rec" : ""), onclick: () => { ACT.open = !ACT.open; actStruct = ""; renderActivity(); } }, rec ? h("span", { class: "dot" }) : n ? h("span", { class: "spin" }) : null, label)));
  });
}

/* ---------- caricamenti globali: continuano anche se cambi pagina ---------- */
const CFG = Object.assign({ lang: "it", model: null, context: "Altro", folder: null, diarize: false, teacher_only: false, normalize: false, denoise: false, autostart: true, num_speakers: "", compare: false }, LSJ.get("new_cfg", {}));
CFG.compare = false;
const saveCfg = () => LSJ.set("new_cfg", CFG);
const Uploads = {
  active: 0, MAX: 3,
  add(files) {
    for (const f of files) UP.items.push({ id: Math.random().toString(36).slice(2), file: f, name: f.name, size: f.size, pct: 0, state: "queued", meta: null, queued: false });
    this.pump(); notifyUI();
  },
  cancel(id) { const u = UP.items.find(x => x.id === id); if (!u) return; if (u.xhr) u.xhr.abort(); UP.items = UP.items.filter(x => x.id !== id); notifyUI(); },
  pump() {
    while (this.active < this.MAX) {
      const u = UP.items.find(x => x.state === "queued"); if (!u) break;
      this.active++; u.state = "uploading"; this.send(u);
    }
  },
  send(u) {
    const fd = new FormData(); fd.append("file", u.file);
    const x = new XMLHttpRequest(); u.xhr = x; x.open("POST", "/api/upload"); if (token()) x.setRequestHeader("X-Studio-Token", token());
    x.upload.onprogress = e => { if (e.lengthComputable) { u.pct = 100 * e.loaded / e.total; notifyUI(); } };
    const end = () => { this.active--; this.pump(); notifyUI(); };
    x.onload = () => {
      if (x.status === 200) { u.meta = JSON.parse(x.responseText); u.state = "ready"; u.pct = 100; end(); this.maybeSubmit(u); }
      else { u.state = "error"; try { u.error = JSON.parse(x.responseText).detail; } catch { u.error = "Caricamento fallito"; } end(); }
    };
    x.onerror = () => { u.state = "error"; u.error = "Errore di rete"; end(); };
    x.onabort = () => { this.active--; this.pump(); };
    x.send(fd);
  },
  body(u) { return { upload_id: u.meta.upload_id, language: CFG.lang, context: CFG.context, normalize: CFG.normalize, denoise: CFG.denoise, diarize: CFG.diarize || CFG.teacher_only, teacher_only: CFG.teacher_only, num_speakers: CFG.num_speakers ? +CFG.num_speakers : null, folder_id: CFG.folder }; },
  /* appena un file è caricato, se c'è un modello scelto parte subito la trascrizione (mentre gli altri file si caricano) */
  async maybeSubmit(u) { if (CFG.autostart && CFG.model && !CFG.compare && !u.queued) await this.submit(u); },
  async submit(u) {
    if (u.queued || !u.meta) return;
    try { const r = await api("/api/transcripts", { json: { ...this.body(u), model_id: CFG.model } }); u.queued = true; u.state = "done"; u.tid = r.id; if (r.duplicate) toast("«" + u.name + "» era già stata trascritta."); Notif.ask(); }
    catch (e) { u.state = "error"; u.error = e.message; toast(e.message, 5000); }
    notifyUI(); pollActivity(); window.dispatchEvent(new CustomEvent("jobs-changed"));
  },
  async submitAllReady() { for (const u of UP.items.filter(x => x.state === "ready")) await this.submit(u); },
};

function startApp() {
  // toccare il link della sezione in cui sei già: ricarica la vista (altrimenti sembrerebbe che il pulsante non faccia nulla)
  document.querySelectorAll(".topbar nav a, .topbar .brand").forEach(a => a.addEventListener("click", () => { if (a.getAttribute("href") === (location.hash || "#/")) route(); }));
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
  showWho(); pollActivity(); setInterval(pollActivity, 2000);
  addEventListener("beforeunload", e => { if (UP.items.some(u => u.state === "uploading") || (window.Recorder && Recorder.state !== "idle")) { e.preventDefault(); e.returnValue = ""; } });
  route();
}
