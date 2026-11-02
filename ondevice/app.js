// Trascrizione sul dispositivo: tutto gira nel browser (audio, modello, archivio). Nessun server.
const MODELS = {
  "onnx-community/whisper-tiny": ["Tiny — velocissimo, qualità bassa", 40],
  "onnx-community/whisper-base": ["Base — veloce, qualità discreta", 80],
  "onnx-community/whisper-small": ["Small — consigliato per iniziare", 250],
  "onnx-community/whisper-large-v3-turbo": ["Large v3 Turbo — il più preciso, pesante (prova la velocità prima!)", 800],
};
const LANGS = { italian: "Italiano", english: "English", auto: "Rileva da solo" };
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v); } for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k)); return e; }
const cfg = { get: (k, d) => { try { return localStorage.getItem("od_" + k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem("od_" + k, v); } catch {} } };
const fmt = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

// ---------- archivio (IndexedDB) ----------
let _db;
function db() { return _db ||= new Promise((res, rej) => { const r = indexedDB.open("od-studio", 1); r.onupgradeneeded = () => { r.result.createObjectStore("notes", { keyPath: "id" }); r.result.createObjectStore("audio"); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
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
class Segmenter { // VAD a energia: taglia alla pausa (≥0,7 s) o a 15 s
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
      const silent = (i - this.lastVoice) * 0.03;
      if (silent >= 0.7) this.cut(this.buf.length - Math.max(0, i - this.lastVoice - 5), false);
      else if (this.buf.length * 0.03 >= 15) { const lo = Math.max(0, this.buf.length - 50); let m = lo; for (let j = lo; j < this.buf.length; j++) if (this.bufDb[j] < this.bufDb[m]) m = j; this.cut(m + 1, true); }
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
  app.replaceChildren();
  ({ "": home, rec, note: detail, test, import: importView }[view] || home)(arg);
}
addEventListener("hashchange", route);
const modelSel = () => h("select", { "aria-label": "Modello", onchange: e => cfg.set("model", e.target.value) }, Object.entries(MODELS).map(([k, [n]]) => h("option", { value: k, selected: k === cfg.get("model", "onnx-community/whisper-small") }, n)));
const langSel = () => h("select", { "aria-label": "Lingua", onchange: e => cfg.set("lang", e.target.value) }, Object.entries(LANGS).map(([k, n]) => h("option", { value: k, selected: k === cfg.get("lang", "italian") }, n)));
function confirmBox(msg) { return new Promise(res => { const o = h("div", { style: "position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;padding:20px;z-index:9" }, h("div", { class: "card" }, h("p", null, msg), h("div", { class: "row" }, h("button", { class: "danger", onclick: () => { o.remove(); res(true); } }, "Elimina"), h("button", { onclick: () => { o.remove(); res(false); } }, "Annulla")))); document.body.append(o); }); }

async function home() {
  const list = h("div");
  app.append(h("h1", null, "Trascrizione sul dispositivo"), h("div", { class: "mut" }, "Tutto resta su questo iPad. Nessun server, nessun account."),
    h("div", { class: "card" }, h("div", { class: "row" }, h("div", { class: "grow" }, "Modello"), modelSel()), h("div", { class: "row" }, h("div", { class: "grow" }, "Lingua"), langSel()),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => go("#/rec") }, "● Registra e trascrivi"), h("button", { onclick: () => go("#/import") }, "Carica un audio"), h("button", { onclick: () => go("#/test") }, "Test dispositivo"))),
    h("h2", null, "Le tue trascrizioni"), list);
  const notes = await allNotes();
  list.replaceChildren(...(notes.length ? notes.map(n => h("div", { class: "card", onclick: () => go("#/note/" + n.id), style: "cursor:pointer" }, h("b", null, n.title), h("div", { class: "mut" }, `${new Date(n.created).toLocaleString("it-IT")} · ${fmt(n.duration || 0)} · ${(MODELS[n.model] || [n.model])[0].split(" — ")[0]}${n.status !== "done" ? " · interrotta" : ""}`))) : [h("div", { class: "mut" }, "Ancora nulla. Premi «Registra e trascrivi».")]));
}

async function rec() {
  const model = cfg.get("model", "onnx-community/whisper-small"), lang = cfg.get("lang", "italian");
  const box = h("div"), status = h("div", { class: "mut" }), txt = h("div", { class: "big card" }, ""), btn = h("button", { class: "primary", disabled: true }, "Attendi…"), lag = h("div", { class: "mut" });
  app.append(h("h1", null, "Registrazione"), box, h("div", { class: "row" }, btn, h("button", { onclick: () => go("#/") }, "Indietro")), status, lag, txt);
  if (!navigator.mediaDevices?.getUserMedia) { box.append(h("div", { class: "bad" }, "Il microfono non è disponibile: apri l'app dall'indirizzo https e consenti il microfono.")); return; }
  loadUI(box);
  try { await Engine.load(model); } catch (e) { box.replaceChildren(h("div", { class: "bad" }, "Modello non caricato: " + e.message, h("br"), "Serve Internet la prima volta (e prova un modello più piccolo)."), h("button", { onclick: () => go("#/rec") }, "Riprova")); return; }
  box.replaceChildren(h("div", { class: "ok" }, `Modello pronto (${Engine.device === "webgpu" ? "GPU" : "CPU: più lento"}).`));
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } }); } catch (e) { box.append(h("div", { class: "bad" }, "Microfono negato: consentilo nelle impostazioni di Safari.")); return; }
  const id = "n" + Date.now(), t0 = Date.now(), note = { id, title: "Lezione " + new Date().toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }), created: t0, duration: 0, model, lang, status: "recording", segments: [] };
  await putNote(note);
  let received = 0, doneTo = 0, pending = 0, chain = Promise.resolve(), paused = false, wake = null, stopped = false, ai = 0;
  const ctx = new (window.AudioContext || window.webkitAudioContext)(); await ctx.resume();
  const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), mute = ctx.createGain(); mute.gain.value = 0;
  const seg = new Segmenter((start, audio) => { pending++; const dur = audio.length / 16000; chain = chain.then(async () => { try { const r = await Engine.run(audio, lang); if (r.text) { note.segments.push({ start, text: r.text }); txt.append(h("span", null, r.text + " ")); await putNote(note); } doneTo = start + dur; } catch (e) { status.replaceChildren(h("span", { class: "bad" }, "Errore su una frase: " + e.message)); } pending--; }); });
  proc.onaudioprocess = e => { if (paused || stopped) return; const d = e.inputBuffer.getChannelData(0); received += d.length / ctx.sampleRate; seg.feed(downsample(new Float32Array(d), ctx.sampleRate)); };
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  let mr; try { mr = new MediaRecorder(stream); mr.ondataavailable = e => { if (e.data.size) putAudio(id, ai++, e.data); }; mr.onstop = () => {}; mr.start(5000); note.mime = mr.mimeType; } catch { status.append(h("div", { class: "bad" }, "Il salvataggio dell'audio non è supportato su questo browser: avrai solo il testo.")); }
  try { wake = await navigator.wakeLock?.request("screen"); } catch {}
  const tick = setInterval(() => { const l = Math.max(0, received - doneTo); status.textContent = `● ${fmt(received)}${paused ? " (in pausa)" : ""}`; lag.textContent = pending ? `Ritardo trascrizione: ~${Math.round(l)} s` + (l > 45 ? " — il modello è lento per questo iPad: dopo la lezione riascolta o scegli un modello più piccolo." : "") : ""; }, 500);
  btn.disabled = false; btn.textContent = "■ Stop e salva";
  const pause = h("button", { onclick: () => { paused = !paused; if (mr) paused ? mr.pause() : mr.resume(); pause.textContent = paused ? "Riprendi" : "Pausa"; } }, "Pausa"); btn.after(pause);
  const finish = async () => { if (stopped) return; stopped = true; clearInterval(tick); btn.disabled = true; btn.textContent = "Salvo…"; seg.flush(); try { mr && mr.state !== "inactive" && mr.stop(); } catch {} stream.getTracks().forEach(t => t.stop()); proc.disconnect(); ctx.close(); wake && wake.release().catch(() => {}); await chain; await new Promise(r => setTimeout(r, 400)); note.status = "done"; note.duration = received; await putNote(note); };
  btn.onclick = async () => { await finish(); go("#/note/" + id); };
  cleanup = async () => { if (!stopped) { await finish(); } };
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
  const n = await getNote(id); if (!n) return go("#/");
  const title = h("input", { type: "text", value: n.title, onchange: async () => { n.title = title.value; await putNote(n); } });
  const text = n.segments.map(s => s.text).join(" ");
  const aud = h("div");
  const blobs = await getAudio(id); const blob = blobs.length ? new Blob(blobs, { type: n.mime || "audio/mp4" }) : null;
  const ext = (n.mime || "").includes("webm") ? "webm" : (n.mime || "").includes("wav") ? "wav" : "m4a";
  if (blob) { const url = URL.createObjectURL(blob); cleanup = () => URL.revokeObjectURL(url); aud.append(h("audio", { controls: "", src: url, style: "width:100%" })); }
  const dl = (b, name) => { const a = h("a", { href: URL.createObjectURL(b), download: name }); document.body.append(a); a.click(); a.remove(); };
  const file = blob && new File([blob], `${n.title}.${ext}`, { type: blob.type });
  app.append(h("div", { class: "row" }, h("button", { onclick: () => go("#/") }, "← Indietro")), title,
    h("div", { class: "mut" }, `${new Date(n.created).toLocaleString("it-IT")} · ${fmt(n.duration || 0)}${n.status !== "done" ? " · registrazione interrotta (testo parziale)" : ""}`), aud,
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: async () => { try { await navigator.clipboard.writeText(text); } catch { prompt("Copia il testo:", text); } } }, "Copia testo"),
      h("button", { onclick: () => dl(new Blob([text], { type: "text/plain" }), n.title + ".txt") }, "Scarica .txt"),
      blob && h("button", { onclick: async () => { try { if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: n.title }); else dl(blob, file.name); } catch {} } }, "Condividi audio"),
      h("button", { class: "danger", onclick: async () => { if (await confirmBox("Eliminare questa trascrizione e il suo audio?")) { await delNote(id); go("#/"); } } }, "Elimina")),
    h("div", { class: "card" }, ...(n.segments.length ? n.segments.map(s => h("div", { class: "seg" }, h("span", { class: "t" }, fmt(s.start)), s.text)) : [h("div", { class: "mut" }, "Nessun testo.")])),
    h("div", { class: "mut" }, "Per la qualità massima: condividi l'audio e ritrascrivilo con l'app server (modelli grandi, parlanti, correzione AI)."));
}

async function test() {
  const out = h("div", { class: "card" }), box = h("div");
  const line = (ok, t) => out.append(h("div", { class: ok ? "ok" : "bad" }, (ok ? "✓ " : "✗ ") + t));
  line(!!navigator.gpu, navigator.gpu ? "WebGPU disponibile (modelli veloci)" : "WebGPU non disponibile: si usa la CPU, più lenta (meglio Tiny/Base/Small)");
  line(!!navigator.mediaDevices?.getUserMedia, "Microfono (richiede https)");
  line(!!window.MediaRecorder, "Salvataggio audio");
  line(!!navigator.wakeLock, "Schermo sempre acceso durante la registrazione");
  line(!!(navigator.storage && navigator.storage.persist), "Archivio persistente");
  try { const e = await navigator.storage.estimate(); out.append(h("div", { class: "mut" }, `Spazio disponibile: ~${Math.round((e.quota - e.usage) / 1e9)} GB`)); } catch {}
  try { await navigator.storage.persist(); } catch {}
  const r = h("div", { class: "mut" });
  app.append(h("h1", null, "Test dispositivo"), out, box, r, h("div", { class: "row" }, modelSel(), h("button", { class: "primary", onclick: async e => { e.target.disabled = true; const t = performance.now(); loadUI(box); try { await Engine.load(cfg.get("model", "onnx-community/whisper-small")); r.textContent = `Modello caricato in ${((performance.now() - t) / 1000).toFixed(1)} s su ${Engine.device === "webgpu" ? "GPU" : "CPU"}. La velocità vera si vede nel «Ritardo trascrizione» durante la registrazione: se cresce, scegli un modello più piccolo.`; } catch (err) { r.replaceChildren(h("span", { class: "bad" }, "Errore: " + err.message)); } e.target.disabled = false; } }, "Scarica e prova il modello"), h("button", { onclick: () => go("#/") }, "Indietro")));
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
// recupero: registrazioni rimaste "in corso" dopo una chiusura improvvisa
(async () => { for (const n of await allNotes()) if (n.status === "recording" && Date.now() - n.created > 60000 && !(location.hash || "").includes(n.id)) { n.status = "interrupted"; await putNote(n); } route(); })();
