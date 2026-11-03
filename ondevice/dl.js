// Scaricamento robusto dei pesi del modello (Whisper) per l'app "Sul dispositivo".
// - a pezzi da 8 MB con richiesta Range: se la rete si blocca o cade, si riprova solo quel pezzo (i pezzi già scaricati restano, anche se chiudi l'app);
// - controllo di blocco: se per 25 s non arriva nemmeno un byte, la richiesta viene interrotta e ripetuta;
// - se il server non supporta Range si scarica il file intero (con lo stesso controllo e nuovi tentativi);
// - tutto va nella Cache API ("od-models"), che transformers.js legge come cache personalizzata: niente doppio download.

export const CACHE = "od-models-v1";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const keyOf = req => (typeof req === "string" ? req : req.url).split("#")[0];

/** Cache personalizzata per transformers.js (env.customCache). */
export const cacheImpl = {
  async match(req) { return (await caches.open(CACHE)).match(keyOf(req)); },
  async put(req, res) { return (await caches.open(CACHE)).put(keyOf(req), res); },
};

const SUF = { fp32: "", fp16: "_fp16", q8: "_quantized", int8: "_int8", uint8: "_uint8", q4: "_q4", q4f16: "_q4f16", bnb4: "_bnb4" };

/** Quali pesi servono. Whisper Large v3 Turbo: codificatore a precisione piena = molti GB (si bloccava): qui q4/q4 (~0,8 GB). */
export function plan(model, device) {
  let dtype;
  if (/large-v3-turbo/.test(model)) dtype = { encoder_model: "q4", decoder_model_merged: "q4" };
  else if (device === "webgpu") dtype = { encoder_model: "fp32", decoder_model_merged: "q4" };
  else dtype = "q8";
  const d = typeof dtype === "string" ? { encoder_model: dtype, decoder_model_merged: dtype } : dtype;
  const base = `https://huggingface.co/${model}/resolve/main/onnx/`;
  return { dtype, files: [base + `encoder_model${SUF[d.encoder_model]}.onnx`, base + `decoder_model_merged${SUF[d.decoder_model_merged]}.onnx`] };
}

/** Il modello è già scaricato (nei pesi grandi)? */
export async function isCached(model, device) {
  try { const c = await caches.open(CACHE); for (const f of plan(model, device).files) if (!(await c.match(f))) return false; return true; } catch { return false; }
}

class NetErr extends Error { constructor(msg, extra) { super(msg); Object.assign(this, extra); } }

async function readBody(res, ctl, arm, onBytes) {
  const reader = res.body.getReader(), out = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; arm(); out.push(value); onBytes(value.length); }
  return new Blob(out);
}
/** una richiesta con controllo di blocco: se non arrivano byte per stallMs, si interrompe */
async function request(url, { range, stallMs, onBytes = () => {}, headOnly }) {
  const ctl = new AbortController(); let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), stallMs); };
  arm();
  try {
    const res = await fetch(url, { headers: range ? { Range: `bytes=${range[0]}-${range[1]}` } : {}, signal: ctl.signal });
    if (range && res.status === 200) { try { ctl.abort(); } catch {} throw new NetErr("il server ignora Range", { noRange: true, res }); }
    if (!res.ok && res.status !== 206) throw new NetErr("HTTP " + res.status, { status: res.status });
    if (headOnly) { try { ctl.abort(); } catch {} return res; }
    return { res, blob: await readBody(res, ctl, arm, onBytes) };
  } catch (e) {
    if (e instanceof NetErr) throw e;
    throw new NetErr(ctl.signal.aborted ? "download bloccato (nessun dato per " + Math.round(stallMs / 1000) + " s)" : (e.message || "errore di rete"), { stalled: ctl.signal.aborted });
  } finally { clearTimeout(timer); }
}
const fatal = e => e && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
async function retry(fn, { retries, onNote, what }) {
  for (let k = 0; ; k++) {
    try { return await fn(); }
    catch (e) {
      if (e.noRange || fatal(e) || k >= retries) throw e;
      onNote(`${what}: ${e.message}. Riprovo (${k + 1}/${retries})…`); await sleep(Math.min(8000, 800 * (k + 1)));
    }
  }
}
async function sizeOf(url, stallMs) {
  try {
    const res = await request(url, { range: [0, 0], stallMs, headOnly: true });
    const cr = res.headers.get("Content-Range"), m = cr && /\/(\d+)\s*$/.exec(cr);
    if (m) return { total: +m[1], range: true };
  } catch (e) { if (!e.noRange) throw e; const len = e.res && +e.res.headers.get("Content-Length"); return { total: len || 0, range: false }; }
  return { total: 0, range: false };
}

/** Scarica `url` nella cache (se non c'è già). Ritorna "cached" | "ok". */
export async function prefetch(url, o = {}) {
  const { chunk = 8 << 20, stallMs = 25000, retries = 8, onProgress = () => {}, onNote = () => {}, label = url.split("/").pop() } = o;
  const cache = await caches.open(CACHE);
  if (await cache.match(url)) { onProgress({ file: label, loaded: 1, total: 1 }); return "cached"; }
  const info = await retry(() => sizeOf(url, stallMs), { retries, onNote, what: label });
  const total = info.total;
  let done = 0; const emit = extra => onProgress({ file: label, loaded: done + (extra || 0), total: total || done + (extra || 0) + 1 });
  const putFull = async blob => { await cache.put(url, new Response(blob, { status: 200, headers: { "Content-Length": String(blob.size), "Content-Type": "application/octet-stream" } })); };

  const whole = async () => { // senza Range: file intero, con controllo di blocco e nuovi tentativi (riparte da capo)
    const { blob } = await retry(async () => { done = 0; return request(url, { stallMs, onBytes: n => { done += n; emit(); } }); }, { retries, onNote, what: label });
    await putFull(blob); return "ok";
  };
  if (!info.range || !total) return whole();
  const n = Math.ceil(total / chunk), pk = i => `${url}?odpart=${i}`;
  try {
  for (let i = 0; i < n; i++) {
    const have = await cache.match(pk(i)), start = i * chunk, end = Math.min(total, start + chunk) - 1;
    if (have && (await have.clone().blob()).size === end - start + 1) { done += end - start + 1; emit(); continue; }   // pezzo già scaricato (ripresa)
    let got = 0;
    const part = await retry(async () => {
      got = 0; const r = await request(url, { range: [start, end], stallMs, onBytes: b => { got += b; emit(got); } });
      if (r.blob.size !== end - start + 1) throw new NetErr("pezzo incompleto");
      return r.blob;
    }, { retries, onNote, what: `${label} (${Math.round(100 * start / total)}%)` });
    await cache.put(pk(i), new Response(part)); done += part.size; emit();
  }
  } catch (e) { if (e.noRange) return whole(); throw e; }
  const blobs = [];
  for (let i = 0; i < n; i++) blobs.push(await (await cache.match(pk(i))).blob());
  const full = new Blob(blobs, { type: "application/octet-stream" });
  if (full.size !== total) { for (let i = 0; i < n; i++) await cache.delete(pk(i)); throw new NetErr("file incompleto: riprova"); }
  await putFull(full);
  for (let i = 0; i < n; i++) await cache.delete(pk(i));
  return "ok";
}
