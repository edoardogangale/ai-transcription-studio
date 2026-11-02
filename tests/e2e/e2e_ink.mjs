// Quaderno dell'app "Sul dispositivo": penna (mouse ≈ Pencil), dito che scorre, forme, gomma, lazo, testo, carta, gesti, live diviso.
import { chromium, reporter } from "./lib.mjs";
import http from "http"; import fs from "fs"; import path from "path";
const [wav, shots] = process.argv.slice(2); const root = new URL("../../ondevice/", import.meta.url).pathname;
const { ok, done } = reporter();
const srv = http.createServer((q, r) => { let p = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); } r.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" }[path.extname(p)] || "application/octet-stream" }); r.end(fs.readFileSync(p)); }).listen(8792);
const FAKE = `export const env={}; const T=['oggi parliamo della rivoluzione francese','iniziata nel millesettecentottantanove','con la presa della Bastiglia']; let n=0; export async function pipeline(t,m,o){ o.progress_callback({file:'a',loaded:5,total:10}); return async (a)=>({text:T[(n++)%3]}); }`;
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=" + wav] });
const ctx = await b.newContext({ viewport: { width: 1366, height: 1024 }, hasTouch: true, permissions: ["microphone"], deviceScaleFactor: 2 });
await ctx.route("https://cdn.jsdelivr.net/**", r => r.fulfill({ contentType: "text/javascript", body: FAKE }));
const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("dialog", d => { errs.push("dialog " + d.message()); d.dismiss(); });
const pages = () => p.evaluate(() => new Promise(res => { const r = indexedDB.open("od-studio", 2); r.onsuccess = () => { const q = r.result.transaction("pages").objectStore("pages").getAll(); q.onsuccess = () => res(q.result); }; }));
const cur = async () => { await p.waitForTimeout(900); const ps = await pages(); return ps.sort((a, b) => b.updated - a.updated)[0]; };
const box = async () => p.locator(".ink-stage").boundingBox();
async function draw(pts, hold = 0) { const s = await box(); await p.mouse.move(s.x + pts[0][0], s.y + pts[0][1]); await p.mouse.down(); for (const [x, y] of pts.slice(1)) await p.mouse.move(s.x + x, s.y + y, { steps: 3 }); if (hold) await p.waitForTimeout(hold); await p.mouse.up(); await p.waitForTimeout(60); }
async function touch(list) { // list di [tipo, id, x, y]
  await p.evaluate(list => { const st = document.querySelector(".ink-stage"), r = st.getBoundingClientRect(); for (const [type, id, x, y] of list) st.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", isPrimary: id === 11, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true })); }, list);
}
await p.goto("http://localhost:8792/"); await p.waitForSelector("text=+ Nuova pagina");
await p.click("text=+ Nuova pagina"); await p.waitForSelector(".modal"); await p.click(".modal >> text=Quadretti"); ok("anteprima carta nel dialogo", await p.locator(".paperprev.grid").count() === 1);
await p.click(".modal >> text=Righe"); await p.click(".modal >> text=Crea"); await p.waitForSelector(".ink-stage"); ok("pagina di appunti aperta", true);
await draw([[200, 200], [260, 230], [320, 210], [380, 260]]); let pg = await cur(); ok("la penna (mouse) scrive", pg.strokes.length === 1, pg.strokes.length + " tratti");
const c0 = await p.evaluate(() => 0); await touch([["pointerdown", 11, 500, 500], ["pointermove", 11, 500, 450], ["pointermove", 11, 500, 380], ["pointerup", 11, 500, 380]]);
pg = await cur(); ok("il dito NON scrive (scorre)", pg.strokes.length === 1);
await p.click("[aria-label=Annulla]"); pg = await cur(); ok("annulla", pg.strokes.length === 0); await p.click("[aria-label=Ripristina]"); pg = await cur(); ok("ripristina", pg.strokes.length === 1);
await touch([["pointerdown", 11, 400, 600], ["pointerdown", 12, 480, 600], ["pointerup", 11, 400, 600], ["pointerup", 12, 480, 600]]); pg = await cur(); ok("tocco con due dita = annulla", pg.strokes.length === 0, pg.strokes.length);
await touch([["pointerdown", 11, 400, 600], ["pointerdown", 12, 480, 600], ["pointerdown", 13, 560, 600], ["pointerup", 11, 400, 600], ["pointerup", 12, 480, 600], ["pointerup", 13, 560, 600]]); pg = await cur(); ok("tocco con tre dita = ripristina", pg.strokes.length === 1);
const circ = []; for (let i = 0; i <= 40; i++) { const t = i / 40 * Math.PI * 2; circ.push([600 + 80 * Math.cos(t) + (i % 3) * 3, 400 + 75 * Math.sin(t) - (i % 2) * 3]); }
await draw(circ, 800); pg = await cur(); ok("cerchio storto → cerchio perfetto (penna ferma)", pg.strokes.at(-1).shape === "cerchio", pg.strokes.at(-1).shape);
await draw([[200, 500], [300, 505], [400, 498], [500, 502], [470, 480], [500, 502], [470, 525]], 800); pg = await cur(); ok("freccia riconosciuta", pg.strokes.at(-1).shape === "freccia", pg.strokes.at(-1).shape);
await draw([[200, 650], [350, 650], [350, 760], [200, 760], [202, 652]], 800); pg = await cur(); ok("rettangolo riconosciuto", pg.strokes.at(-1).shape === "rettangolo", pg.strokes.at(-1).shape);
await draw([[700, 650], [800, 655], [900, 650]]); pg = await cur(); ok("senza fermarsi resta a mano libera", !pg.strokes.at(-1).shape);
const s = await box(); await p.mouse.move(s.x + 900, s.y + 300); await p.mouse.down(); await p.waitForTimeout(800); const quick = await p.locator(".ink-quick").count(); await p.mouse.up(); ok("penna ferma appena appoggiata → strumenti rapidi", quick === 1);
await p.click(".ink-quick [aria-label=Evidenziatore]"); await draw([[180, 210], [400, 230]]); pg = await cur(); ok("evidenziatore dagli strumenti rapidi", pg.strokes.at(-1).t === "marker");
const nBefore = pg.strokes.length; await p.click("[aria-label='Scambia strumento']"); await draw([[700, 640], [800, 670], [900, 640]]); pg = await cur(); ok("⇄ passa alla gomma e cancella", pg.strokes.length < nBefore, `${nBefore}→${pg.strokes.length}`);
await p.click("[aria-label='Scambia strumento']"); ok("⇄ torna all'evidenziatore", await p.locator(".tool.on[aria-label=Evidenziatore]").count() === 1);
await p.click("[aria-label=Penna]"); await p.click("[aria-label=Penna]"); ok("secondo tocco sullo strumento = spessore", await p.locator(".ink-pop input[type=range]").count() === 1); await p.click("[aria-label=Penna]");
await p.click("[aria-label=Stilografica]"); await draw([[200, 850], [260, 820], [320, 880], [380, 830]]); pg = await cur(); ok("stilografica", pg.strokes.at(-1).t === "fountain");
await p.click("[aria-label=Gomma]"); await p.click("[aria-label=Gomma]"); await p.click("text=Gomma a pixel"); await p.click("[aria-label=Gomma]");
const nb2 = pg.strokes.length; await draw([[290, 800], [290, 900]]); pg = await cur(); ok("gomma a pixel divide il tratto", pg.strokes.length >= nb2, `${nb2}→${pg.strokes.length}`);
await p.click("[aria-label=Lazo]"); const sq = pg.strokes.find(x => x.shape === "rettangolo"); const bb0 = sq.bb.slice();
const cam = await p.evaluate(() => 1);
await draw([[170, 620], [380, 620], [380, 800], [170, 800], [170, 620]]); ok("lazo seleziona (menu)", await p.locator(".ink-selmenu").count() === 1);
await draw([[270, 700], [370, 760]]); pg = await cur(); const sq2 = pg.strokes.find(x => x.id === sq.id); ok("trascina la selezione", sq2 && sq2.bb[0] > bb0[0] + 50, sq2 && `${bb0[0]}→${sq2.bb[0]}`);
await p.click(".ink-selmenu >> text=Fine");
await p.click("[aria-label=Testo]"); const s2 = await box(); await p.mouse.click(s2.x + 650, s2.y + 820); await p.keyboard.type("Bastiglia 1789"); await p.click("[aria-label=Penna]"); pg = await cur(); ok("casella di testo", pg.texts.some(t => t.text === "Bastiglia 1789"), JSON.stringify(pg.texts));
await p.click("[aria-label=Foglio]"); await p.click(".ink-pop >> text=Quadretti"); await p.click(".ink-pop >> text=Allarga →"); pg = await cur(); ok("carta a quadretti + foglio allargato", pg.paper.type === "grid" && pg.w > 820, `${pg.paper.type} ${pg.w}`);
await p.click("[aria-label=Righello]"); await p.waitForTimeout(200); ok("righello visibile", await p.locator(".tool.on[aria-label=Righello]").count() === 1);
if (shots) await p.screenshot({ path: shots + "/ink_page.png" });
await p.click("[aria-label=Righello]");
await p.click("[aria-label=Indietro]"); await p.waitForSelector(".pagecard"); ok("pagina in «Appunti» con anteprima", await p.locator(".pagecard").count() === 1);
// live diviso: appunti + trascrizione animata
await p.click("text=Registra e prendi appunti"); await p.waitForSelector("text=■ Stop", { timeout: 15000 }); ok("live: quaderno + trascrizione affiancati", await p.locator(".split .ink-stage").count() === 1 && await p.locator(".txpanel").count() === 1);
await draw([[150, 300], [300, 320]]);
await p.waitForSelector(".tx .w", { timeout: 25000 }); ok("parole animate nella trascrizione", await p.locator(".tx .w").count() > 2);
ok("orari/paragrafi in un altro colore (meta)", await p.locator(".tx .meta.para").count() >= 1 && await p.locator(".tx .meta").first().evaluate(e => getComputedStyle(e).color) !== await p.locator(".tx .spoken").first().evaluate(e => getComputedStyle(e).color));
if (shots) { await p.waitForTimeout(1500); await p.screenshot({ path: shots + "/ink_live.png" }); }
await p.click("text=Pausa"); await p.click("text=Riprendi"); await p.click("text=■ Stop"); await p.waitForSelector("text=Apri gli appunti", { timeout: 15000 }); ok("stop → dettaglio con «Apri gli appunti»", true);
await p.click("text=Apri gli appunti"); await p.waitForSelector(".ink-stage"); pg = await cur(); ok("appunti della lezione salvati", pg.noteId && pg.strokes.length === 1);
await p.setViewportSize({ width: 1024, height: 1366 }); await p.goto("http://localhost:8792/#/rec"); await p.waitForSelector("text=■ Stop", { timeout: 15000 }); await p.waitForTimeout(500);
const lay = await p.evaluate(() => { const a = document.querySelector(".nbhost").getBoundingClientRect(), b = document.querySelector(".txpanel").getBoundingClientRect(); return b.top >= a.bottom - 2; }); ok("verticale: trascrizione sotto gli appunti", lay);
if (shots) await p.screenshot({ path: shots + "/ink_portrait.png" });
await p.click("text=■ Stop"); await p.waitForSelector("text=Apri gli appunti", { timeout: 15000 });
ok("nessun errore JS / dialogo nativo", errs.length === 0, errs.join(" | "));
await b.close(); srv.close(); process.exit(done());
