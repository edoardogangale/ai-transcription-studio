// Collaudo iPad Pro (EMULATO in Chromium: viewport, touch, user-agent; non è Safari reale).
// uso: node e2e_ipad.mjs <base_url> <wav1> <wav2> <wav3> <cartella_screenshot>
import fs from "fs";
import { chromium, reporter } from "./lib.mjs";
const [base, w1, w2, w3, shots] = process.argv.slice(2);
const { ok, done } = reporter();
const UA = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
const p = await ctx.newPage(); const errors = [];
p.on("pageerror", e => errors.push(e.message)); p.on("console", m => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
p.on("dialog", d => d.accept());
const audit = async (name) => {
  const bad = await p.evaluate(() => {
    const sel = "button, a.btn, select, summary, nav a, label.opt, input[type=text], input[type=search], input[type=password], input[type=number], .fname, .fmore, .ts, .tool";
    return [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && !e.closest(".hidden") && e.getAttribute("hidden") == null; })
      .map(e => { const r = e.getBoundingClientRect(); return { t: (e.innerText || e.getAttribute("aria-label") || e.className || e.tagName).slice(0, 30).replace(/\n/g, " "), w: Math.round(r.width), h: Math.round(r.height), c: e.className }; }).filter(x => Math.min(x.w, x.h) < 40);
  });
  const dbg = bad.length ? await p.evaluate(() => `coarse=${matchMedia("(pointer:coarse)").matches} w=${innerWidth} sheets=${document.styleSheets.length} rules=${[...document.styleSheets].reduce((a, s) => a + s.cssRules.length, 0)} smallMin=${getComputedStyle(document.querySelector("button.small") || document.body).minHeight}`) : "";
  ok(`${name}: bersagli touch ≥ 40 px`, bad.length === 0, bad.slice(0, 5).map(x => `${x.t}(${x.w}x${x.h})`).join(", ") + " " + dbg);
};

await p.goto(base); await p.waitForSelector("text=Tutte le registrazioni");
const env = await p.evaluate(() => ({ touch: document.documentElement.classList.contains("touch"), meta: document.querySelector("meta[name=viewport]").content, manifest: !!document.querySelector("link[rel=manifest]"), touchIcon: !!document.querySelector("link[rel=apple-touch-icon]"), capable: document.querySelector("meta[name=apple-mobile-web-app-capable]")?.content }));
ok("ambiente iPad: modalità touch attiva (bersagli grandi, strumenti sempre visibili)", env.touch);
ok("PWA: manifest, icona iOS, modalità app, viewport", env.manifest && env.touchIcon && env.capable === "yes" && /viewport-fit=cover/.test(env.meta));
await audit("archivio");
// flusso interamente a tocchi
await p.tap("a.btn.primary"); await p.waitForSelector(".drop");
await p.locator(".model", { hasText: "MOCK (solo test" }).tap();
await p.setInputFiles('input[type=file]', [w1, w2, w3]); await p.waitForFunction(() => [...document.querySelectorAll(".list .item")].filter(i => /In trascrizione ✓/.test(i.innerText)).length === 3, null, { timeout: 30000 });
ok("3 file caricati e avviati con un tocco sul modello", true);
await audit("nuova trascrizione"); await p.screenshot({ path: `${shots}/ipad13-new.png`, fullPage: true });
await p.goto(base + "/#/"); await p.waitForFunction(() => document.querySelectorAll(".item .chip.ok").length >= 3, null, { timeout: 40000 });
await p.locator("text=Seleziona tutto").locator("input").tap(); await p.waitForSelector(".actionbar"); await audit("barra azioni");
const [dl] = await Promise.all([p.waitForEvent("download"), p.locator(".actionbar >> text=PDF unico").tap()]); ok("PDF unico con un tocco", dl.suggestedFilename().startsWith("Trascrizioni"));
await p.screenshot({ path: `${shots}/ipad13-library.png` });
await p.locator(".actionbar >> text=✕").tap();
await p.locator(".item-link").first().tap(); await p.waitForSelector(".seg");
ok("strumenti dei segmenti sempre visibili senza passare il mouse", await p.evaluate(() => getComputedStyle(document.querySelector(".tools")).opacity) === "1");
await p.locator(".seg >> nth=0").locator("button[aria-label=Evidenzia]").tap(); await p.waitForSelector(".seg.hl"); ok("evidenzia con un tocco", true);
await p.locator(".seg >> nth=0").locator(".w >> nth=2").tap(); await p.waitForTimeout(400);
ok("tocco su una parola: l'audio salta lì", await p.evaluate(() => document.querySelector("audio").currentTime) > 3);
await p.evaluate(() => document.querySelector("audio").pause()); await p.locator(".speeds >> text=1,5×").tap(); ok("velocità 1,5× con un tocco", await p.evaluate(() => document.querySelector("audio").playbackRate) === 1.5);
await audit("editor"); await p.screenshot({ path: `${shots}/ipad13-editor.png` });
for (const hash of ["#/live", "#/models", "#/settings"]) { await p.goto(base + "/" + hash); await p.waitForTimeout(700); await audit(hash); }
// orientamento e iPad Pro 11"
for (const [name, w, h] of [["13 orizzontale", 1376, 1032], ["11 verticale", 834, 1210], ["11 orizzontale", 1210, 834]]) {
  await p.setViewportSize({ width: w, height: h });
  for (const hash of ["#/", "#/new", "#/live", "#/models", "#/settings"]) { await p.goto(base + "/" + hash); await p.waitForTimeout(450); const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); ok(`iPad ${name} ${hash}: nessuno scroll orizzontale`, ov <= 1, "overflow=" + ov); }
  await p.goto(base + "/#/"); await p.locator(".item-link").first().tap(); await p.waitForSelector(".seg");
  const lay = await p.evaluate(() => { const pl = document.querySelector(".player").getBoundingClientRect(), segs = document.querySelector(".segs").getBoundingClientRect(); return { side: pl.right <= segs.left + 4, ov: document.documentElement.scrollWidth - innerWidth }; });
  ok(`iPad ${name} editor: ${w > 860 ? "player a sinistra e testo a destra" : "layout a colonna"}, nessuno scroll orizzontale`, lay.ov <= 1 && (w > 860 ? lay.side : true));
  await p.screenshot({ path: `${shots}/ipad-${name.replace(/ /g, "-")}-editor.png` });
}
ok("nessun errore JS in console", errors.length === 0, errors.slice(0, 3).join(" ; "));
await b.close(); process.exit(done());
