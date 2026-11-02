// Misura quanti tocchi LUNGHI (come un dito vero, ~150 ms) sono necessari per i pulsanti durante una registrazione live.
// uso: node tap_live.mjs <base_url> <wav_mic>
import { chromium } from "./lib.mjs";
const [base, micWav] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micWav}`] });
const ctx = await b.newContext({ viewport: { width: 1032, height: 1376 }, isMobile: true, hasTouch: true, permissions: ["microphone"] });
const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p);
const hold = async (loc, ms = 150) => {   // tocco con pressione di ms millisecondi, come un dito
  let bb = null; for (let k = 0; k < 20 && !bb; k++) { bb = await loc.boundingBox().catch(() => null); if (!bb) await p.waitForTimeout(50); }
  const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await p.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
await p.goto(base + "/#/live"); await p.waitForSelector("text=Inizia registrazione");
await p.locator("select").nth(1).selectOption("mock"); await p.click("text=● Inizia registrazione"); await p.waitForSelector(".bigtime", { timeout: 20000 });
await p.waitForTimeout(3000);
let ok = 0; const N = 12;
for (let i = 0; i < N; i++) {
  const paused = await p.locator("h1").first().innerText().then(t => /pausa/i.test(t));
  const btn = paused ? p.locator("button:has-text('Riprendi')") : p.locator("button:has-text('Pausa')");
  await hold(btn); await p.waitForTimeout(350);
  const now = await p.locator("h1").first().innerText().then(t => /pausa/i.test(t));
  if (now !== paused) ok++;
  await p.waitForTimeout(137 * (i % 5));   // sfasa rispetto ai ridisegni periodici
}
console.log(`Tocchi lunghi riusciti al primo colpo: ${ok}/${N}`);
await p.click("text=■ Stop e salva").catch(() => {}); await b.close(); process.exit(ok === N ? 0 : 1);
