// I pulsanti della pagina Live e del centro attività devono restare gli STESSI nodi durante la registrazione (altrimenti i tocchi si perdono).
// uso: node stable_live.mjs <base_url> <wav_mic>
import { chromium } from "./lib.mjs";
const [base, micWav] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micWav}`] });
const ctx = await b.newContext({ viewport: { width: 1032, height: 1376 }, isMobile: true, hasTouch: true, permissions: ["microphone"] });
const p = await ctx.newPage();
await p.goto(base + "/#/live"); await p.waitForSelector("text=Inizia registrazione");
await p.locator("select").nth(1).selectOption("mock"); await p.click("text=● Inizia registrazione"); await p.waitForSelector(".bigtime", { timeout: 20000 });
await p.waitForTimeout(1500);
const handles = { pausa: await p.$("button:has-text('Pausa')"), stop: await p.$("button:has-text('Stop e salva')"), evid: await p.$("button:has-text('Evidenzia')") };
await p.evaluate(() => { window.__renders = 0; new MutationObserver(m => { window.__renders += m.length; }).observe(document.querySelector("main"), { childList: true, subtree: true }); });
await p.waitForTimeout(6000);
var alive = {}; for (const [k, h] of Object.entries(handles)) alive[k] = await h.evaluate(e => e.isConnected);
const mut0 = mut;
var mut = await p.evaluate(() => window.__renders);
// pannello attività aperto durante la registrazione: anche i suoi pulsanti devono restare stabili
await p.click(".act-pill"); await p.waitForSelector(".act-panel .act-row.rec button.danger"); await p.waitForTimeout(400);
handles.actStop = await p.$(".act-panel .act-row.rec button.danger"); handles.pill = await p.$(".act-pill");
await p.waitForTimeout(6000); alive.actStop = await handles.actStop.evaluate(e => e.isConnected); alive.pill = await handles.pill.evaluate(e => e.isConnected);
console.log("nodi ancora gli stessi dopo 6 s:", JSON.stringify(alive), "| mutazioni DOM in 6 s:", mut);
await p.click("text=■ Stop e salva").catch(() => {}); await b.close();
process.exit(Object.values(alive).every(Boolean) ? 0 : 1);
