// Worker: carica il modello Whisper (transformers.js) e trascrive. Tutto resta nel browser.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm";
env.allowLocalModels = false;
let asr = null, loadedKey = "";
const post = (m) => self.postMessage(m);
async function load(model, device) {
  const key = model + "|" + device;
  if (asr && loadedKey === key) return;
  asr = null;
  const opts = { progress_callback: (p) => post({ type: "progress", p }) };
  if (device === "webgpu") { opts.device = "webgpu"; opts.dtype = { encoder_model: "fp32", decoder_model_merged: "q4" }; }
  else { opts.dtype = "q8"; }
  asr = await pipeline("automatic-speech-recognition", model, opts);
  loadedKey = key;
}
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      try { await load(m.model, m.device); }
      catch (err) { if (m.device === "webgpu") { post({ type: "warn", msg: "WebGPU non disponibile: uso la CPU (più lenta)." }); await load(m.model, "wasm"); m.device = "wasm"; } else throw err; }
      post({ type: "ready", device: loadedKey.split("|")[1] });
    } else if (m.type === "run") {
      const t0 = performance.now();
      const out = await asr(m.audio, { language: m.lang === "auto" ? null : m.lang, task: "transcribe" });
      post({ type: "result", id: m.id, text: (out.text || "").trim(), ms: performance.now() - t0, audio_s: m.audio.length / 16000 });
    }
  } catch (err) { post({ type: "error", id: m.id, msg: String(err && err.message || err) }); }
};
