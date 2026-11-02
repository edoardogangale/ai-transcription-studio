// Collaudo end-to-end nel browser (Chromium). Richiede il server avviato con STUDIO_ENABLE_MOCK=1.
// uso: node e2e.mjs <base_url> <file.wav> <cartella_screenshot>
import { createRequire } from "module";
const { chromium } = createRequire(import.meta.url)("playwright");
const [base, wav, shots] = process.argv.slice(2);
const results = []; const ok = (n, c, extra = "") => { results.push([n, !!c]); console.log((c ? "PASS " : "FAIL ") + n + (extra ? "  " + extra : "")); };
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage();
const errors = []; p.on("pageerror", e => errors.push(e.message)); p.on("console", m => m.type() === "error" && errors.push(m.text()));
await p.goto(base); await p.waitForSelector("text=Trascrizioni");
ok("dashboard mostra pulsante Nuova trascrizione", await p.locator("a.btn.primary").innerText().then(t => t.includes("Nuova trascrizione")));
await p.click("a.btn.primary"); await p.waitForSelector(".drop");
await p.setInputFiles('input[type=file]', wav); await p.waitForSelector("text=Durata");
ok("upload mostra durata e dimensione", await p.locator("text=/Durata \\d+:\\d+ · /").count() === 1);
// selezione lingua + 3 schede reali
for (const lang of ["it", "en"]) {
  await p.locator(`input[name=lang]`).nth(lang === "it" ? 0 : 1).check(); await p.waitForTimeout(400);
  const names = await p.locator(".model h3").allInnerTexts();
  ok(`lingua ${lang}: 3 modelli reali + 2 mock di test`, names.filter(n => !n.startsWith("MOCK")).length === 3 && names.length === 5, names.join(" | "));
}
ok("benchmark non verificati dichiarati", await p.locator("text=nessun benchmark verificato").count() >= 2);
ok("Voxtral su CPU: non compatibile e non selezionabile", await p.locator(".model.off", { hasText: "Voxtral" }).locator("text=Non compatibile").count() === 1);
await p.screenshot({ path: `${shots}/new-desktop.png`, fullPage: true });
await p.locator(".model", { hasText: "MOCK (solo test" }).click();
ok("modello selezionato", await p.locator(".model.sel").count() === 1);
await p.click("text=Avvia trascrizione"); await p.waitForURL("**/#/");
await p.waitForSelector("text=Completata", { timeout: 30000 });
ok("job completato e visibile in archivio", true);
await p.locator("a.item").first().click(); await p.waitForSelector(".seg");
const nseg = await p.locator(".seg").count(); ok("editor con segmenti", nseg >= 2, "n=" + nseg);
ok("banner precisione timestamp (parola)", await p.locator(".notice", { hasText: "a livello di parola" }).count() === 1);
// click su parola -> seek
await p.waitForFunction(() => document.querySelector("audio").readyState >= 1);
const seg = p.locator(".seg").nth(1); const segStart = await p.evaluate(() => 0);
const box = await seg.locator(".txt").boundingBox();
await seg.locator(".txt").click({ position: { x: box.width * 0.8, y: 8 } });
await p.waitForTimeout(400);
const t1 = await p.evaluate(() => document.querySelector("audio").currentTime);
const tsLabel = await seg.locator(".ts").innerText();
const [mm, ss] = tsLabel.split(":").map(Number); const segSec = mm * 60 + ss;
ok("click su parola sposta l'audio dentro/dopo il segmento", t1 >= segSec - 0.5, `currentTime=${t1.toFixed(2)} inizio-seg=${tsLabel}`);
await p.locator(".seg").nth(2).locator(".ts").click(); await p.waitForTimeout(400);
const t2 = await p.evaluate(() => document.querySelector("audio").currentTime);
const [m2, s2] = (await p.locator(".seg").nth(2).locator(".ts").innerText()).split(":").map(Number);
ok("click su timestamp riporta l'audio al segmento", Math.abs(t2 - (m2 * 60 + s2)) < 1.5, `t=${t2.toFixed(2)}`);
await p.waitForTimeout(500);
ok("segmento attivo evidenziato durante la riproduzione", await p.locator(".seg.active").count() === 1);
// velocità
await p.click(".speeds >> text=1,5×"); ok("velocità 1,5×", await p.evaluate(() => document.querySelector("audio").playbackRate) === 1.5);
await p.click(".speeds >> text=0,75×"); ok("velocità 0,75×", await p.evaluate(() => document.querySelector("audio").playbackRate) === 0.75);
await p.evaluate(() => document.querySelector("audio").pause());
// ricerca
await p.fill('input[type=search]', "zzzzqq"); await p.waitForTimeout(300);
ok("ricerca senza risultati nasconde i segmenti", await p.locator(".seg:not(.hidden)").count() === 0 && await p.locator("text=0 risultati").count() === 1);
await p.fill('input[type=search]', "PAROLA1"); await p.waitForTimeout(300);
ok("ricerca insensibile alle maiuscole, conta i risultati", await p.locator(".seg:not(.hidden)").count() === nseg && /\d+ risultati/.test(await p.locator(".m", { hasText: "risultati" }).first().innerText()));
await p.fill('input[type=search]', "");
// modifica + autosave
const first = p.locator(".seg .txt").first(); await first.click(); await first.press("End"); await p.keyboard.type(" È così, perché già: città ñ");
await p.waitForSelector("text=/Salvato \\d/", { timeout: 6000 }); ok("salvataggio automatico", true);
await p.reload(); await p.waitForSelector(".seg");
ok("modifica persistita dopo il ricaricamento (accenti inclusi)", (await p.locator(".seg .txt").first().innerText()).includes("È così, perché già: città ñ"));
// modalità pulita
await p.click(".tabs >> text=B · Pulita"); await p.waitForSelector(".reading"); ok("modalità B visibile", true);
await p.click(".tabs >> text=C · Appunti"); await p.waitForSelector("text=/Nessun LLM locale/"); ok("modalità C dichiara l'assenza di LLM locale", true);
await p.click(".tabs >> text=A · Fedele");
// download
const [dl] = await Promise.all([p.waitForEvent("download"), p.selectOption(".row select", "srt")]);
ok("esportazione SRT scaricabile", dl.suggestedFilename().endsWith(".srt"), dl.suggestedFilename());
// tema
const before = await p.evaluate(() => getComputedStyle(document.body).backgroundColor); await p.click("#themeBtn"); await p.waitForTimeout(350);
const after = await p.evaluate(() => getComputedStyle(document.body).backgroundColor); ok("tema chiaro/scuro", before !== after, `${before} -> ${after}`);
await p.screenshot({ path: `${shots}/editor-desktop-dark.png` });
await p.click("#themeBtn");
// responsive
for (const [name, w, h] of [["ipad", 820, 1180], ["ipad-landscape", 1180, 820], ["phone", 390, 844]]) {
  await p.setViewportSize({ width: w, height: h }); await p.waitForTimeout(300);
  for (const hash of ["#/", "#/new", "#/models", "#/settings"]) { await p.goto(base + "/" + hash); await p.waitForTimeout(500); const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); ok(`${name} ${hash}: nessuno scroll orizzontale`, ov <= 1, "overflow=" + ov); }
  await p.locator("a.item").first().click().catch(() => {}); 
  await p.goto(base + "/#/"); await p.locator("a.item").first().click(); await p.waitForSelector(".seg"); const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); ok(`${name} editor: nessuno scroll orizzontale`, ov <= 1, "overflow=" + ov);
  await p.screenshot({ path: `${shots}/editor-${name}.png` });
}
// confronto
await p.setViewportSize({ width: 1280, height: 900 }); await p.goto(base + "/#/new"); await p.waitForSelector(".drop");
await p.setInputFiles('input[type=file]', wav); await p.waitForSelector("text=Durata");
await p.locator("label", { hasText: "Confronta modelli" }).locator("input").check();
await p.locator(".model", { hasText: "MOCK (solo test" }).click(); await p.locator(".model", { hasText: "MOCK B" }).click();
await p.click("text=Avvia confronto"); await p.waitForURL("**/#/c/*");
await p.waitForSelector(".cmp .diff-del", { timeout: 30000 }); ok("confronto: differenze evidenziate", true);
ok("confronto: tempo e parole registrati", await p.locator("dt", { hasText: "Tempo" }).count() === 2 && await p.locator("dt", { hasText: "Parole" }).count() === 2);
ok("confronto: dichiara che differenza ≠ accuratezza", await p.locator("text=NON quale sia più accurato").count() === 1);
await p.screenshot({ path: `${shots}/compare.png`, fullPage: true });
// modelli
await p.goto(base + "/#/models"); await p.waitForSelector(".notice");
ok("pagina modelli: nessun download automatico", await p.locator("text=Spazio occupato dai modelli: 0 B").count() === 1);
await p.screenshot({ path: `${shots}/models.png`, fullPage: true });
ok("nessun errore JS in console", errors.length === 0, errors.slice(0, 3).join(" ; "));
await b.close();
const failed = results.filter(r => !r[1]); console.log(`\n${results.length - failed.length}/${results.length} controlli superati`); process.exit(failed.length ? 1 : 0);
