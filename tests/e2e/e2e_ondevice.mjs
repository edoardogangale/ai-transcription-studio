// Prova la modalità "Sul dispositivo" con un MODELLO FINTO (la libreria vera non è scaricabile qui): verifica interfaccia, VAD, salvataggio, elimina.
import { chromium, reporter } from "./lib.mjs";
import http from "http"; import fs from "fs"; import path from "path";
const [wav] = process.argv.slice(2); const root = new URL("../../ondevice/", import.meta.url).pathname;
const { ok, done } = reporter();
const srv = http.createServer((q, r) => { let p = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png" }[ext] || "application/octet-stream" }); r.end(fs.readFileSync(p)); }).listen(8791);
const FAKE = `export const env={}; let n=0; export async function pipeline(t,m,o){ o.progress_callback({file:'a',loaded:5,total:10}); return async (audio)=>({text:'frase '+(++n)+' di '+Math.round(audio.length/16000)+' secondi'}); }`;
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=" + wav] });
const ctx = await b.newContext({ viewport: { width: 1024, height: 1366 }, hasTouch: true, permissions: ["microphone"] });
await ctx.route("https://huggingface.co/**", r => { const rg = r.request().headers()["range"], body = Buffer.alloc(1000, 1), m = rg && /bytes=(\d+)-(\d+)/.exec(rg), cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range" }; if (m) { const a = +m[1], b = Math.min(+m[2], 999); return r.fulfill({ status: 206, headers: { ...cors, "Content-Range": `bytes ${a}-${b}/1000` }, body: body.subarray(a, b + 1) }); } r.fulfill({ status: 200, headers: cors, body }); });   // pesi finti (il modello vero non si scarica nei test)
await ctx.route("https://cdn.jsdelivr.net/**", r => r.fulfill({ contentType: "text/javascript", body: FAKE }));
const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("dialog", d => { errs.push("dialog"); d.dismiss(); });
await p.goto("http://localhost:8791/"); await p.waitForSelector(".fab.rec");
ok("home visibile", true);
await p.click(".fab.rec"); await p.waitForSelector("text=■ Stop", { timeout: 15000 }); ok("modello (finto) caricato e registrazione partita", true);
await p.waitForTimeout(20000);
const live = await p.locator(".tx").innerText(); ok("trascrizione live compare", /frase \d+/.test(live), live.slice(0, 80));
await p.click("text=Pausa"); await p.waitForSelector("text=Riprendi"); await p.click("text=Riprendi"); ok("pausa/riprendi", true);
// app in secondo piano: al ritorno segnala il buco di audio (simulato: sfondo per 20 s senza dati)
await p.evaluate(() => { const real = Date.now.bind(Date); window.__off = 0; Date.now = () => real() + window.__off; Object.defineProperty(document, "hidden", { get: () => window.__hid, configurable: true }); window.__hid = true; document.dispatchEvent(new Event("visibilitychange")); window.__off = 20000; window.__hid = false; document.dispatchEvent(new Event("visibilitychange")); });
await p.waitForTimeout(500);
ok("in secondo piano: al ritorno avvisa dei secondi senza audio e suggerisce Split View", /secondo piano.*Split View/.test(await p.locator(".ink-text.transcript").innerText()));

await p.click("text=■ Stop"); await p.waitForSelector("text=Copia testo", { timeout: 15000 }); ok("salvato e aperto il dettaglio", true);
ok("audio salvato (player presente)", await p.locator("audio").count() === 1);
ok("segmenti mostrati", await p.locator(".tx .spoken span").count() >= 1, (await p.locator(".tx .spoken span").count()) + " parole");
await p.click(".back"); await p.waitForSelector(".cell");
ok("compare in archivio", await p.locator(".cell >> text=Lezione").count() >= 1);
await p.locator(".cell >> text=Lezione").first().click(); await p.click(".pills >> text=Elimina"); await p.click(".modal button.primary"); await p.waitForSelector("text=Nessuna registrazione");
ok("elimina con conferma in-app", true);
// carica audio: più file insieme, uno illeggibile
await p.click("#side >> text=Carica audio"); await p.waitForSelector("text=Scegli audio");
ok("selettore con elenco esteso di formati e «Tutti i file»", (await p.locator("input[type=file] >> nth=0").getAttribute("accept")).includes(".m4a") && await p.locator("text=Tutti i file").count() === 1);
fs.writeFileSync("/tmp/voce-whatsapp.opus", Buffer.from("non e' audio, e' un finto file .opus"));
await p.setInputFiles("input[type=file] >> nth=0", [wav, "/tmp/voce-whatsapp.opus"]);
await p.waitForSelector("text=Vai alle registrazioni", { timeout: 60000 }); await p.waitForSelector(".cell >> text=✕", { timeout: 30000 });
ok("il file buono viene trascritto", await p.locator(".cell >> text=" + path.basename(wav)).count() === 0 && (await p.evaluate(async () => (await new Promise(r => { const q = indexedDB.open("od-studio"); q.onsuccess = () => { const g = q.result.transaction("notes").objectStore("notes").getAll(); g.onsuccess = () => r(g.result); }; })).length)) >= 1);
ok("il file illeggibile dà un messaggio chiaro (formato, come convertirlo) e resta in coda con «Rimuovi»", /Safari non legge questo formato.*m4a/.test(await p.locator(".cell >> text=✕").first().innerText()) && await p.locator("text=Rimuovi").count() === 1);
await p.click("text=Vai alle registrazioni"); await p.waitForSelector(".cell >> text=" + path.basename(wav).replace(/\.[^.]+$/, ""));
ok("l'audio caricato compare tra le registrazioni", true);
// coda persistente: i file scelti sono copiati nell'app; se la pagina si ricarica non si perdono
await p.click("#side >> text=Carica audio"); await p.waitForSelector("text=Scegli audio");
await p.evaluate(async () => {
  const sr = 16000, n = sr * 3, b = new ArrayBuffer(44 + n * 2), v = new DataView(b), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8) * 9000, true);
  await new Promise(r => { const q = indexedDB.open("od-studio"); q.onsuccess = () => { const tx = q.result.transaction("queue", "readwrite"); tx.objectStore("queue").put({ id: "qtest", name: "audio-amico.wav", size: b.byteLength, type: "audio/wav", blob: new Blob([b], { type: "audio/wav" }), state: "pending", created: Date.now() }); tx.oncomplete = r; }; });
});
await p.reload(); await p.waitForSelector("text=non sono andati persi"); ok("dopo il ricaricamento della pagina i file sono ancora in coda (con «Riprendi»)", await p.locator("text=audio-amico.wav").count() === 1 && await p.locator("button:has-text('Riprendi')").count() === 1);
await p.click("button:has-text('Riprendi')"); await p.waitForSelector("#side a.active", { timeout: 30000 }); await p.waitForFunction(() => location.hash.startsWith("#/note/"), null, { timeout: 60000 });
ok("«Riprendi» trascrive il file in coda e lo toglie dalla coda", /#\/note\//.test(p.url()));
// aggiornamento: mai mentre lavori (resta una scheda da toccare), solo in schermate ferme
await p.click("#side >> text=Carica audio"); await p.evaluate(() => { window.__marker = 1; window.__ats_onController(true); }); await p.waitForTimeout(500);
ok("nuova versione durante un caricamento: non ricarica, mostra «tocca per aggiornare»", await p.evaluate(() => window.__marker === 1) && await p.locator("#updbanner").count() === 1);
await p.evaluate(() => document.getElementById("updbanner")?.remove());
await p.click("#side >> text=Registrazioni"); await p.waitForTimeout(300); await p.evaluate(() => { window.__marker = 1; window.__ats_onController(true); }); await p.waitForTimeout(1200);
ok("nuova versione in una schermata ferma: ricarica da sola", await p.evaluate(() => window.__marker === undefined));
await p.click("#side >> text=Impostazioni"); await p.waitForSelector("text=Microfono"); ok("schermata impostazioni/test", true);
ok("nessun errore JS / dialogo nativo", errs.length === 0, errs.join(" | "));
await b.close(); srv.close(); process.exit(done());
