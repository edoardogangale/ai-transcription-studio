// Download dei pesi a pezzi (ondevice/dl.js) contro un finto "Hugging Face": rete che cade, richieste che si bloccano, server senza Range, ripresa.
import { chromium, reporter } from "./lib.mjs";
import http from "http"; import fs from "fs"; import path from "path"; import crypto from "crypto";
const root = new URL("../../ondevice/", import.meta.url).pathname; const { ok, done } = reporter();
const SIZE = 20 * 1024 * 1024 + 12345, data = Buffer.alloc(SIZE); { let s = 7; for (let i = 0; i < SIZE; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data[i] = s >> 16; } }
const SHA = crypto.createHash("sha256").update(data).digest("hex");
const st = http.createServer((q, r) => { let p = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); } r.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(p)] || "application/octet-stream" }); r.end(fs.readFileSync(p)); }).listen(8812);
const hits = {}; let healed = false;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range", "Access-Control-Expose-Headers": "Content-Range, Content-Length" };
const hf = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x"), key = u.pathname; hits[key] = hits[key] || []; const rg = q.headers.range, m = rg && /bytes=(\d+)-(\d+)/.exec(rg); hits[key].push(m ? +m[1] : -1); const n = hits[key].length;
  if (q.method === "OPTIONS") { r.writeHead(204, cors); return r.end(); }
  if (key.startsWith("/gone/")) { r.writeHead(404, cors); return r.end("no"); }
  const range = !key.startsWith("/norange/") && m; const a = range ? +m[1] : 0, b = range ? Math.min(+m[2], SIZE - 1) : SIZE - 1;
  if (key.startsWith("/resume/") && range && a >= 3 * (2 << 20) && !healed) { r.writeHead(503, cors); return r.end("giù"); }
  const body = data.subarray(a, b + 1), head = range ? { ...cors, "Content-Range": `bytes ${a}-${b}/${SIZE}`, "Content-Length": body.length } : { ...cors, "Content-Length": SIZE };
  r.writeHead(range ? 206 : 200, head);
  if (key.startsWith("/drop/") && n === 3 || key.startsWith("/norange/") && n === 2) { r.write(body.subarray(0, body.length >> 1)); setTimeout(() => q.socket.destroy(), 20); return; }   // la rete cade a metà
  if (key.startsWith("/stall/") && n === 3) { r.write(body.subarray(0, 1000)); return; }                                                                                             // si blocca: non finisce mai
  r.end(body);
}).listen(8813);
const b = await chromium.launch(); const p = await (await b.newContext()).newPage();
await p.goto("http://localhost:8812/"); await p.waitForSelector("body");
const run = (name, opts = {}) => p.evaluate(async ([name, opts, SHA]) => {
  const DL = await import("/dl.js"); const url = `http://localhost:8813/${name}/f.bin`, notes = [], prog = [];
  const t0 = performance.now(); let res, err = null;
  try { res = await DL.prefetch(url, { chunk: 2 << 20, stallMs: 1500, onNote: m => notes.push(m), onProgress: x => prog.push(x.loaded), ...opts }); } catch (e) { err = String(e.message || e); }
  const c = await caches.open(DL.CACHE), keys = (await c.keys()).map(k => k.url).filter(k => k.startsWith(url));
  let sha = null; const hit = await c.match(url); if (hit) sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await (await hit.blob()).arrayBuffer()))].map(x => x.toString(16).padStart(2, "0")).join("");
  return { res, err, notes, sha, ok: sha === SHA, keys, mono: prog.every((v, i) => !i || v >= prog[i - 1] - 1), ms: Math.round(performance.now() - t0) };
}, [name, opts, SHA]);

let r = await run("ok"); ok("download a pezzi (Range): file identico (sha256)", r.ok && r.res === "ok", `${r.ms} ms`); ok("pezzi temporanei ripuliti, resta solo il file", r.keys.length === 1, r.keys.length + " voci");
ok("avanzamento sempre in crescita", r.mono);
r = await run("ok"); ok("secondo avvio: già in cache, nessun download", r.res === "cached"); ok("nessuna nuova richiesta di rete", hits["/ok/f.bin"].length === 1 + Math.ceil(SIZE / (2 << 20)), hits["/ok/f.bin"].length + " richieste");
r = await run("drop"); ok("la rete cade a metà: riprova e completa", r.ok, r.err || ""); ok("ha avvisato del nuovo tentativo", r.notes.some(n => /Riprovo/.test(n)), r.notes[0] || "nessuna nota");
r = await run("stall"); ok("richiesta bloccata: la interrompe e riprova", r.ok, r.err || ""); ok("ha segnalato il blocco", r.notes.some(n => /bloccato/.test(n)), r.notes[0] || "");
r = await run("norange"); ok("server senza Range: scarica il file intero (con nuovo tentativo dopo la caduta)", r.ok, r.err || "");
r = await run("gone"); ok("errore definitivo (404): non insiste", !!r.err && /404/.test(r.err) && (hits["/gone/f.bin"] || []).length <= 2, r.err);
// ripresa: il server cade dopo 3 pezzi, poi guarisce
r = await run("resume", { retries: 1 }); const have = r.keys.filter(k => k.includes("odpart")).length;
ok("server in errore: fallisce ma tiene i pezzi già scaricati", !!r.err && have === 3, `${have} pezzi salvati, errore: ${r.err}`);
healed = true; const before = hits["/resume/f.bin"].length; r = await run("resume");
const fresh = hits["/resume/f.bin"].slice(before).filter(a => a >= 0);
ok("alla ripresa scarica solo i pezzi mancanti (+1 richiesta per la dimensione)", r.ok && fresh.length === Math.ceil(SIZE / (2 << 20)) - 3 + 1, `${fresh.length} richieste dopo la ripresa su ${Math.ceil(SIZE / (2 << 20))} pezzi`);
// piano dei pesi
const pl = await p.evaluate(async () => { const DL = await import("/dl.js"); return { turbo: DL.plan("onnx-community/whisper-large-v3-turbo", "webgpu"), small: DL.plan("onnx-community/whisper-small", "webgpu"), cpu: DL.plan("onnx-community/whisper-base", "wasm") }; });
ok("Turbo: codificatore e decodificatore q4 (non più il file da molti GB)", pl.turbo.files.every(f => f.includes("_q4.onnx")) && !pl.turbo.files.some(f => /encoder_model\.onnx/.test(f)), pl.turbo.files.map(f => f.split("/").pop()).join(" + "));
ok("altri modelli: come prima (GPU fp32+q4, CPU q8)", pl.small.files[0].endsWith("encoder_model.onnx") && pl.small.files[1].endsWith("decoder_model_merged_q4.onnx") && pl.cpu.files[0].endsWith("encoder_model_quantized.onnx"));
await b.close(); st.close(); hf.close(); process.exit(done());
