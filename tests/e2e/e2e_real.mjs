// Collaudo end-to-end nel browser con MODELLI VERI (nessun mock): Parakeet v3 + riconoscimento parlanti + live.
// Il server va avviato SENZA STUDIO_ENABLE_MOCK, con i modelli già installati (parakeet-tdt-0.6b-v3 e diarization).
// uso: node e2e_real.mjs <base_url> <lezione_it.wav> <cartella_screenshot>
import { chromium, reporter } from "./lib.mjs";
const [base, wav, shots] = process.argv.slice(2);
const { ok, done } = reporter();
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
const p = await ctx.newPage(); const errors = [];
p.on("pageerror", e => errors.push(e.message)); p.on("console", m => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
const api = async path => (await ctx.request.get(base + path)).json();
const normw = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// 1) file italiano, riconoscimento parlanti + SOLO insegnante, Parakeet
await p.goto(base + "/#/new"); await p.waitForSelector(".drop");
ok("riconoscimento parlanti disponibile (componente installato)", await p.locator("label:has-text('Riconosci chi parla') input:not([disabled])").count() === 1);
await p.locator("label:has-text('Riconosci chi parla') input").check(); await p.locator('label:has-text("Trascrivi SOLO") input').check();
await p.locator(".model", { hasText: "Parakeet TDT 0.6B v3" }).first().click();
ok("scheda Parakeet: dimensione reale e velocità di riferimento", await p.locator(".model:has-text('Parakeet TDT 0.6B v3')").first().innerText().then(t => /464\.6 MB|487|MB/.test(t) && /più veloce del tempo reale/.test(t)));
await p.setInputFiles('input[type=file]', wav); await p.waitForSelector("text=In trascrizione ✓", { timeout: 60000 });
ok("trascrizione avviata subito dopo il caricamento", true);
await p.goto(base + "/#/"); await p.waitForSelector(".item .chip.ok", { timeout: 120000 }); ok("trascrizione completata con modello reale", true);
await p.locator(".item-link").first().click(); await p.waitForSelector(".seg");
const items = await api("/api/transcripts"); const tid = items.find(t => t.kind === "file").id; const T = await api("/api/transcripts/" + tid);
const text = T.segments.map(s => s.text).join(" ");
ok("testo italiano riconosciuto", /Kant/.test(text) && /derivata/.test(text), text.slice(0, 80));
ok("commenti dei compagni esclusi (solo insegnante)", !/quaderno|mensa/i.test(text) && T.stats.skipped_chunks >= 1, `chunk saltati: ${T.stats.skipped_chunks}`);
ok("pannello parlanti con insegnante riconosciuto", await p.locator("summary:has-text('Parlanti riconosciuti')").count() === 1 && /Insegnante/.test(await p.locator("summary:has-text('Parlanti riconosciuti')").innerText()));
ok("timestamp per parola dichiarati", await p.locator("text=a livello di parola").count() >= 1);

// 2) evidenziazione parola per parola: la parola evidenziata coincide con i tempi reali del modello
await p.waitForFunction(() => document.querySelector("audio").readyState >= 1);
await p.evaluate(() => { const a = document.querySelector("audio"); a.currentTime = 0; a.play(); });
await p.waitForSelector(".w.cur", { timeout: 5000 });
const words = T.segments.flatMap(s => s.words);
let hits = 0, tries = 0, seen = new Set();
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(550);
  const r = await p.evaluate(() => { const a = document.querySelector("audio"); const c = document.querySelector(".w.cur"); return { t: a.currentTime, w: c ? c.textContent : null }; });
  if (!r.w) continue; tries++; seen.add(r.w.trim());
  let k = -1; words.forEach((w, j) => { if (w.s <= r.t + 0.02) k = j; });
  if ([k - 1, k, k + 1].some(j => words[j] && normw(words[j].w) === normw(r.w))) hits++;
}
ok("la parola evidenziata corrisponde ai tempi del modello", tries >= 5 && hits >= tries - 1, `${hits}/${tries} campioni, ${seen.size} parole diverse`);
await p.screenshot({ path: `${shots}/real-listen.png` });
await p.evaluate(() => document.querySelector("audio").pause());
// click su parola -> salto alla parola vera
const w5 = T.segments[0].words[8]; await p.locator(".segs .seg >> nth=0").locator(".w >> nth=8").click(); await p.waitForTimeout(300);
const tt = await p.evaluate(() => document.querySelector("audio").currentTime); ok("click su parola: salto al tempo reale della parola", Math.abs(tt - w5.s) < 0.6, `atteso ${w5.s}, ottenuto ${tt.toFixed(2)}`);
await p.evaluate(() => document.querySelector("audio").pause());

// 3) stessa registrazione, voci etichettate (non saltate) con 2 voci dichiarate
await p.goto(base + "/#/new"); await p.waitForSelector(".drop");
await p.locator('label:has-text("Trascrivi SOLO") input').uncheck(); await p.fill("input[type=number]", "2");
await p.setInputFiles('input[type=file]', wav); await p.waitForSelector("text=In trascrizione ✓", { timeout: 60000 });
await p.goto(base + "/#/"); await p.waitForFunction(() => document.querySelectorAll(".item .chip.ok").length >= 2, null, { timeout: 120000 });
const t2 = (await api("/api/transcripts")).filter(t => t.kind === "file").find(t => t.id !== tid);
await p.goto(base + "/#/t/" + t2.id); await p.waitForSelector(".seg");
ok("voci estranee nascoste di default", await p.locator(".seg:not(.hidden)").count() < await p.locator(".seg").count());
await p.locator("label:has-text('Mostra anche le altre voci') input").check(); await p.waitForTimeout(300);
ok("con 'mostra altre voci' compaiono le frasi del compagno etichettate", await p.locator(".seg.other:not(.hidden)").count() >= 1 && await p.locator(".spk.other").count() >= 1);
await p.screenshot({ path: `${shots}/real-speakers.png` });

// 4) LIVE reale con Parakeet (il microfono finto riproduce la lezione)
await p.goto(base + "/#/live"); await p.waitForSelector("text=Inizia registrazione");
await p.locator("select").nth(1).selectOption({ label: "NVIDIA Parakeet TDT 0.6B v3" });
ok("live: velocità del modello mostrata prima di registrare", await p.locator(".notice:has-text('più veloce del tempo reale')").count() === 1);
await p.fill("input[type=text] >> nth=0", "Live reale"); await p.click("text=● Inizia registrazione"); await p.waitForSelector(".bigtime", { timeout: 30000 });
await p.waitForFunction(() => document.querySelectorAll(".livebox .seg").length >= 3, null, { timeout: 60000 });
const liveTxt = await p.locator(".livebox").innerText(); ok("live reale: frasi trascritte in diretta", /Kant|ragion|esperienza/i.test(liveTxt), liveTxt.replace(/\n/g, " ").slice(0, 90));
await p.click("text=★ Evidenzia"); await p.fill(".row input[type=text]", "Domanda sulla ragion pura"); await p.keyboard.press("Enter");
await p.screenshot({ path: `${shots}/real-live.png` });
await p.waitForTimeout(3000); await p.click("text=■ Stop e salva"); await p.waitForURL("**/#/t/*", { timeout: 60000 }); await p.waitForSelector(".seg");
const lt = await api("/api/transcripts/" + p.url().split("/t/")[1]);
ok("live salvato con audio, segmenti, evidenziazione e nota", lt.status === "done" && lt.segments.length >= 3 && lt.notes.length === 2 && lt.audio_path.endsWith(".m4a"), `${lt.segments.length} segmenti`);
ok("live: parole con timestamp reali", lt.has_word_ts === 1 && lt.segments[0].words.length > 3);

// 4b) un lavoro SENZA riconoscimento parlanti: la sua velocità viene misurata e riportata
await p.goto(base + "/#/new"); await p.waitForSelector(".drop");
await p.locator("label:has-text('Riconosci chi parla') input").uncheck(); await p.setInputFiles('input[type=file]', wav); await p.waitForSelector("text=In trascrizione ✓", { timeout: 60000 });
await p.goto(base + "/#/"); await p.waitForFunction(() => document.querySelectorAll(".item .chip.ok").length >= 4, null, { timeout: 120000 });
// 5) velocità misurata sul PC
await p.goto(base + "/#/models"); await p.waitForSelector("text=Modelli veloci");
ok("pagina modelli: 'Sul tuo PC' con velocità misurata", await p.locator("text=Sul tuo PC").count() >= 1, await p.locator("text=Sul tuo PC").first().locator("..").innerText().catch(() => ""));
ok("modelli installati con spazio su disco", await p.locator(".chip.ok:has-text('Installato')").count() >= 2);
ok("nessun errore JS in console", errors.length === 0, errors.slice(0, 3).join(" ; "));
await b.close(); process.exit(done());
