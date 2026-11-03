// Appunti sul server: cartelle, nota a mano libera (penna), miniature, spostamento, ricerca, registrazione live scritta nella pagina, elimina.
import { chromium, reporter } from "./lib.mjs";
const [base, wav, shots] = process.argv.slice(2);
const { ok, done } = reporter();
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=" + wav] });
const ctx = await b.newContext({ viewport: { width: 1366, height: 1024 }, hasTouch: true, permissions: ["microphone"], deviceScaleFactor: 2 });
const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("dialog", d => { errs.push("dialog " + d.message()); d.dismiss(); });
const cdp = await ctx.newCDPSession(p);
const api = (path, o) => p.evaluate(async ([path, o]) => (await fetch(path, o)).json(), [path, o]);
const stroke = async (pts) => { const s = await p.locator(".ink-stage").boundingBox(); const m = (type, x, y, d) => cdp.send("Input.dispatchMouseEvent", { type, x: s.x + x, y: s.y + y, button: type === "mouseMoved" && !d ? "none" : "left", buttons: d ? 1 : 0, clickCount: 1, pointerType: "pen", force: 0.5 }); await m("mousePressed", pts[0][0], pts[0][1], 1); for (const [x, y] of pts.slice(1)) { await m("mouseMoved", x, y, 1); await p.waitForTimeout(8); } await m("mouseReleased", pts.at(-1)[0], pts.at(-1)[1], 0); };

await p.goto(base + "/#/notes"); await p.waitForSelector("text=Nessuna nota");
ok("pagina Appunti (vuota) con cartelle a lato", await p.locator(".side .frow").count() >= 2);
// cartella
await p.click("text=＋ Nuova materia"); await p.fill("dialog input", "Storia"); await p.click("dialog >> text=OK"); await p.waitForSelector(".side .fname >> text=Storia");
ok("nuova materia creata", true);
await p.click(".side .fname >> text=Storia");
// nota
await p.click("button.primary >> text=Nuova nota"); await p.waitForSelector("dialog"); await p.fill("dialog input[type=text]", "Rivoluzione francese"); await p.click("dialog >> text=Crea"); await p.waitForSelector(".ink-stage");
ok("nota aperta nell'editor a tutto schermo", await p.locator(".notes-full .ink-top").count() === 1);
let pg = (await api("/api/pages")).pages[0]; ok("nota creata nella cartella scelta", pg.title === "Rivoluzione francese" && !!pg.folder_id);
await stroke(Array.from({ length: 30 }, (_, i) => [200 + i * 12, 300 + Math.sin(i / 3) * 40]));
await p.waitForTimeout(1500);
let full = await api("/api/pages/" + pg.id); ok("la penna scrive e il salvataggio arriva al server", full.data.strokes.length === 1, full.data.strokes.length + " tratti");
// gesti con le dita
const tf = () => p.evaluate(() => document.querySelector(".ink-texts").style.transform);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
const s0 = await p.locator(".ink-stage").boundingBox(), t0 = await tf();
await touch("touchStart", [[s0.x + 500, s0.y + 700]]); for (let i = 1; i <= 12; i++) { await touch("touchMove", [[s0.x + 500, s0.y + 700 - i * 25]]); await p.waitForTimeout(16); } await touch("touchEnd", []); await p.waitForTimeout(200);
ok("un dito scorre il foglio", (await tf()) !== t0);
const t1 = await tf(); await touch("touchStart", [[s0.x + 400, s0.y + 500], [s0.x + 600, s0.y + 500]]); for (let i = 1; i <= 12; i++) { await touch("touchMove", [[s0.x + 400 - i * 8, s0.y + 500], [s0.x + 600 + i * 8, s0.y + 500]]); await p.waitForTimeout(16); } await touch("touchEnd", []); await p.waitForTimeout(200);
ok("due dita zoomano", /scale\(/.test(await tf()) && (await tf()) !== t1);
// elenco: miniatura, cartelle, ricerca
await p.click("text=‹ Appunti"); await p.waitForSelector(".ncard canvas");
ok("miniatura vera nella griglia", await p.locator(".ncard canvas").count() === 1);
await p.click(".side .fname >> text=Storia"); ok("la nota compare nella sua cartella", await p.locator(".ncard").count() === 1);
await p.click(".side .fname >> text=Senza cartella"); ok("non compare in «Senza cartella»", await p.locator(".ncard").count() === 0);
await p.click(".side .fname >> text=Tutte"); await p.fill("#notesq", "inesistente"); await p.waitForTimeout(700); ok("ricerca: nessun risultato", await p.locator(".ncard").count() === 0);
await p.fill("#notesq", "francese"); await p.waitForTimeout(700); ok("ricerca per titolo", await p.locator(".ncard").count() === 1); await p.fill("#notesq", ""); await p.waitForTimeout(700);
// sposta fuori cartella dal menu
await p.click(".ncard .more", { force: true }); await p.waitForSelector("dialog select"); await p.selectOption("dialog select", ""); await p.click("dialog >> text=Sposta qui"); await p.waitForTimeout(500);
pg = (await api("/api/pages")).pages[0]; ok("sposta la nota senza cartella", !pg.folder_id);
// registrazione live con i modelli del server (qui: modello finto di test) scritta dentro la pagina
await p.locator(".ncard").first().click(); await p.waitForSelector(".ink-stage");
await p.click(".nhead >> text=● Registra"); await p.waitForSelector("dialog select"); 
const opts = await p.locator("dialog select >> nth=1").innerText(); ok("scelta del modello del server nella finestra", /MOCK/i.test(opts), opts.slice(0, 60));
await p.click("dialog >> text=Inizia"); await p.waitForSelector(".nhead .rectime:visible", { timeout: 30000 }); ok("registrazione avviata dalla nota", true);
await p.waitForSelector(".ink-text.transcript .w", { timeout: 40000 }); ok("la trascrizione compare DENTRO la pagina, animata", await p.locator(".ink-text.transcript .w").count() > 1);
ok("etichette dell'app (paragrafo) in un altro colore", await p.locator(".ink-text.transcript .meta").first().evaluate(e => getComputedStyle(e).color) !== await p.locator(".ink-text.transcript .spoken").first().evaluate(e => getComputedStyle(e).color));
await p.click(".nhead >> text=Pausa"); await p.waitForSelector(".nhead >> text=Riprendi"); await p.click(".nhead >> text=Riprendi");
await stroke([[150, 450], [260, 470], [380, 440]]);
if (shots) await p.screenshot({ path: shots + "/notes_live.png" });
await p.click(".nhead >> text=■ Stop"); await p.waitForSelector(".nhead >> text=Trascrizione", { state: "visible", timeout: 60000 }); await p.waitForTimeout(1500);
full = await api("/api/pages/" + pg.id); ok("nota salvata con tratti + trascrizione + collegamento alla registrazione", !!full.tid && full.data.strokes.length >= 2 && full.data.texts.some(t => t.kind === "transcript" && /\S/.test(t.text)), `tid=${full.tid}`);
const tr = await api("/api/transcripts/" + full.tid); ok("la registrazione esiste anche nell'Archivio", tr.status === "done" || tr.status === "recording" || tr.status === "running", tr.status);
if (shots) { await p.screenshot({ path: shots + "/notes_after.png" }); }
await p.click(".nhead >> text=Trascrizione"); await p.waitForSelector("h1, .editor", { timeout: 15000 }); ok("apre la trascrizione nell'Archivio", /#\/t\//.test(p.url()));
// elimina
await p.goto(base + "/#/notes"); await p.waitForSelector(".ncard"); await p.locator(".ncard").first().click(); await p.waitForSelector(".ink-stage"); await p.click("[aria-label='Elimina nota']"); await p.click("dialog button.danger"); await p.waitForSelector("text=Nessuna nota");
ok("elimina con conferma dell'app", (await api("/api/pages")).pages.length === 0);
ok("nessun errore JS / dialogo nativo", errs.length === 0, errs.join(" | "));
await b.close(); process.exit(done());
