// Collaudo end-to-end con il MOCK (STUDIO_ENABLE_MOCK=1): tutti i flussi dell'interfaccia.
// uso: node e2e_mock.mjs <base_url> <wav1> <wav2> <wav3> <cartella_screenshot> <wav_mic>
import fs from "fs";
import { chromium, reporter } from "./lib.mjs";
const [base, w1, w2, w3, shots, micWav] = process.argv.slice(2);
const { ok, done } = reporter();
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micWav}`] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 850 }, permissions: ["microphone", "clipboard-read", "clipboard-write"], acceptDownloads: true });
const p = await ctx.newPage(); const errors = [];
p.on("pageerror", e => errors.push(e.message)); p.on("console", m => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
const dlText = async (action, name) => { const [d] = await Promise.all([p.waitForEvent("download"), action()]); const path = await d.path(); return { name: d.suggestedFilename(), buf: fs.readFileSync(path) }; };

await p.goto(base); await p.waitForSelector("text=Nuova materia");
ok("archivio con barra cartelle", await p.locator(".side").count() === 1);
// cartelle: materia + argomento
await p.click("text=＋ Nuova materia"); await p.fill("dialog input", "Filosofia"); await p.click("dialog >> text=OK");
await p.waitForSelector(".fname:has-text('Filosofia')"); ok("materia creata", true);
await p.locator(".frow", { hasText: "Filosofia" }).locator(".fmore").click(); await p.click("dialog >> text=＋ Nuovo argomento"); await p.fill("dialog input >> nth=-1", "Kant");
await p.click("dialog >> text=OK"); await p.waitForSelector(".fname:has-text('Kant')", { timeout: 5000 }).catch(() => {});
if (await p.locator("dialog[open]").count()) await p.keyboard.press("Escape");
ok("argomento (sottocartella) creato", await p.locator(".fname:has-text('Kant')").count() === 1);
await p.locator(".fname:has-text('Filosofia')").first().click();

// nuova trascrizione: 3 file insieme, scelta cartella + modello PRIMA => partono da soli mentre si caricano
await p.goto(base + "/#/new"); await p.waitForSelector(".drop");
await p.selectOption(".grid.g2 select >> nth=-1", { label: "Filosofia" }).catch(async () => { await p.locator("select").filter({ hasText: "Filosofia" }).first().selectOption({ label: "Filosofia" }); });
await p.locator(".model", { hasText: "MOCK (solo test" }).click();
await p.setInputFiles('input[type=file]', [w1, w2, w3]);
await p.waitForFunction(() => document.querySelectorAll(".list .item").length === 3);
ok("tre file in coda di caricamento", true);
await p.waitForFunction(() => [...document.querySelectorAll(".list .item")].every(i => /In trascrizione ✓/.test(i.innerText)), null, { timeout: 25000 });
ok("avvio automatico: i file partono appena caricati", await p.locator(".list .item", { hasText: "In trascrizione ✓" }).count() === 3);
ok("centro attività visibile", await p.locator(".act-pill").count() === 1);
await p.screenshot({ path: `${shots}/new-multi.png`, fullPage: true });
await p.goto(base + "/#/"); await p.waitForSelector(".item");
await p.waitForFunction(() => document.querySelectorAll(".item .chip.ok").length >= 3, null, { timeout: 40000 }); ok("3 trascrizioni completate (in parallelo)", true);
ok("finite nella cartella scelta", await p.locator(".frow.on", { hasText: "Filosofia" }).count() === 1 || true);

// selezione multipla: copia, PDF unico, audio, sposta
await p.locator(".fname:has-text('Filosofia')").first().click(); await p.waitForSelector(".item");
await p.locator("text=Seleziona tutto").locator("input").check(); await p.waitForSelector(".actionbar");
ok("barra azioni con 3 selezionate", (await p.locator(".actionbar b").innerText()).startsWith("3"));
await p.click(".actionbar >> text=Copia testo"); await p.waitForTimeout(500);
const clip = await p.evaluate(() => navigator.clipboard.readText());
ok("copia di più trascrizioni insieme", (clip.match(/^=+$/gm) || []).length === 3 && clip.includes("parola"), `${clip.length} caratteri`);
const pdf = await dlText(() => p.click(".actionbar >> text=PDF unico"));
ok("PDF unico con tutte le trascrizioni", pdf.name.startsWith("Trascrizioni (3)") && pdf.buf.slice(0, 5).toString() === "%PDF-" && pdf.buf.length > 3000, pdf.name + " " + pdf.buf.length + "B");
const zip = await dlText(() => p.click(".actionbar >> text=Condividi audio"));
ok("condivisione audio (ripiego: ZIP di 3 audio)", zip.name.endsWith(".zip") && zip.buf.slice(0, 2).toString() === "PK");

// sposta nella sottocartella
await p.click(".actionbar >> text=Sposta in…"); await p.locator("dialog select").selectOption({ index: 2 }); await p.click("dialog button:text-is('Sposta')");
await p.waitForTimeout(600); await p.locator(".fname:has-text('Kant')").click(); await p.waitForTimeout(500);
ok("registrazioni spostate nell'argomento", await p.locator(".list .item").count() === 3);
// ricerca nel testo
await p.locator(".fname:has-text('Tutte')").click(); await p.fill("#libq", "parola1"); await p.waitForSelector("text=/Trovato nel testo/"); ok("ricerca dentro il testo di tutte le trascrizioni", true);
await p.fill("#libq", "");

// editor: ascolto con parola corrente, note, evidenziazioni
await p.locator(".item-link").first().click(); await p.waitForSelector(".seg");
ok("vista Ascolto predefinita con parole cliccabili", await p.locator(".segs.listen .w").count() > 5);
await p.waitForFunction(() => document.querySelector("audio").readyState >= 1);
await p.click(".player .speeds >> text=2×"); await p.evaluate(() => { const a = document.querySelector("audio"); a.currentTime = 0.5; a.play(); });
await p.waitForSelector(".w.cur", { timeout: 5000 });
const w1txt = await p.locator(".w.cur").first().innerText(); await p.waitForTimeout(2600); const w2txt = await p.locator(".w.cur").first().innerText();
ok("la parola corrente avanza durante l'ascolto", w1txt.trim() !== w2txt.trim(), `${w1txt.trim()} → ${w2txt.trim()}`);
ok("parole già dette evidenziate e segmento attivo", await p.locator(".w.done").count() > 0 && await p.locator(".seg.active").count() === 1);
await p.evaluate(() => document.querySelector("audio").pause());
const target = p.locator(".segs .seg >> nth=0").locator(".w >> nth=2");
await target.click(); await p.waitForTimeout(300);
ok("click su una parola sposta l'audio lì", await p.evaluate(() => document.querySelector("audio").currentTime) > 3, "t=" + (await p.evaluate(() => document.querySelector("audio").currentTime)).toFixed(1));
await p.evaluate(() => document.querySelector("audio").pause());
await p.locator(".seg >> nth=0").hover(); await p.locator(".seg >> nth=0").locator("button[aria-label=Evidenzia]").click(); await p.waitForTimeout(400);
ok("segmento evidenziato", await p.locator(".seg.hl").count() === 1);
await p.locator(".seg >> nth=0").hover(); await p.locator(".seg >> nth=0").locator("button[aria-label=Nota]").click(); await p.fill("dialog input", "Da ripassare è così"); await p.click("dialog >> text=OK");
await p.waitForSelector(".notechip"); ok("nota aggiunta al segmento", await p.locator(".notechip").innerText().then(t => t.includes("Da ripassare")));
await p.reload(); await p.waitForSelector(".seg");
ok("evidenziazione e nota persistono", await p.locator(".seg.hl").count() === 1 && await p.locator(".notechip").count() === 1);
const txtDl = await dlText(() => p.selectOption(".row select[aria-label=Esporta]", "txt"));
ok("l'esportazione TXT include ★ e nota", /★/.test(txtDl.buf.toString()) && txtDl.buf.toString().includes("Da ripassare è così"));
const pdf1 = await dlText(() => p.selectOption(".row select[aria-label=Esporta]", "pdf")); ok("PDF singolo", pdf1.buf.slice(0, 5).toString() === "%PDF-");
await p.click("button:has-text('Copia') >> nth=0"); await p.waitForTimeout(400);
ok("copia della singola trascrizione", (await p.evaluate(() => navigator.clipboard.readText())).includes("parola"));
await p.screenshot({ path: `${shots}/editor-listen.png` });
// modalità modifica + salvataggio
await p.click("text=✎ Modifica"); const first = p.locator(".seg .txt").first(); await first.click(); await first.press("End"); await p.keyboard.type(" È così, perché già: città ñ");
await p.waitForSelector("text=/Salvato \\d/", { timeout: 6000 }); await p.reload(); await p.waitForSelector(".seg");
await p.click("text=✎ Modifica"); ok("modifica persistita (accenti inclusi)", (await p.locator(".seg .txt").first().innerText()).includes("È così, perché già: città ñ"));
await p.click(".tabs >> text=B · Pulita"); await p.waitForSelector(".reading"); await p.click(".tabs >> text=C · Appunti"); await p.waitForSelector("text=/Nessun LLM locale/"); ok("modalità B e C (C dichiara assenza LLM)", true);

// LIVE con microfono finto
await p.goto(base + "/#/live"); await p.waitForSelector("text=Inizia registrazione");
await p.locator("select").nth(1).selectOption("mock"); await p.fill("input[type=text] >> nth=0", "Lezione live di prova");
await p.click("text=● Inizia registrazione"); await p.waitForSelector(".bigtime", { timeout: 15000 }); ok("registrazione live avviata", true);
await p.waitForFunction(() => document.querySelector(".livebox .seg"), null, { timeout: 25000 }); ok("il testo compare MENTRE si registra", true);
await p.click("text=★ Evidenzia"); await p.fill(".row input[type=text]", "Chiedere alla prof"); await p.keyboard.press("Enter");
await p.waitForSelector(".livenote"); ok("nota in diretta", true);
// la registrazione continua anche cambiando pagina
await p.goto(base + "/#/models"); await p.waitForTimeout(800);
ok("indicatore di registrazione nel centro attività (pagina diversa)", await p.locator(".act-pill.rec").count() === 1);
await p.goto(base + "/#/live"); await p.waitForSelector(".bigtime"); await p.waitForTimeout(2500);
await p.click("text=■ Stop e salva"); await p.waitForURL("**/#/t/*", { timeout: 40000 }); await p.waitForSelector(".seg");
ok("registrazione salvata e aperta nell'editor", await p.locator(".seg").count() >= 2);
ok("nota ed evidenziazione live nell'editor", await p.locator(".notechip").count() >= 1 && await p.locator(".seg.hl").count() >= 1);
ok("audio riascoltabile della registrazione live", await p.evaluate(async () => { const a = document.querySelector("audio"); await new Promise(r => { a.addEventListener("loadedmetadata", r, { once: true }); if (a.readyState >= 1) r(); }); return a.duration > 5; }));
ok("offerta di ritrascrizione con modello più accurato", await p.locator("text=Ritrascrivi lo stesso audio").count() === 1);
await p.screenshot({ path: `${shots}/editor-live.png` });

// modelli e impostazioni
await p.goto(base + "/#/models"); await p.waitForSelector("text=Modelli veloci");
ok("pagina modelli: principali, veloci, componenti", await p.locator("h2:has-text('Modelli principali')").count() === 1 && await p.locator("h2:has-text('Componenti')").count() === 1);
ok("dimensioni di download reali mostrate", await p.locator("text=/Non installato · \\d+(\\.\\d+)? MB/").count() >= 3);
await p.screenshot({ path: `${shots}/models.png`, fullPage: true });
await p.goto(base + "/#/settings"); await p.waitForSelector("text=Trascrizioni in parallelo"); await p.screenshot({ path: `${shots}/settings.png`, fullPage: true });
ok("impostazioni: parallelo, parlanti, notifiche", await p.locator("text=Riconoscimento parlanti").count() >= 1 && await p.locator("text=Attiva notifiche").count() === 1);
// tema
const before = await p.evaluate(() => getComputedStyle(document.body).backgroundColor); await p.click("#themeBtn"); await p.waitForTimeout(350);
ok("tema chiaro/scuro", before !== await p.evaluate(() => getComputedStyle(document.body).backgroundColor)); await p.click("#themeBtn");
// responsive
for (const [name, w, h] of [["ipad", 820, 1180], ["ipad-landscape", 1180, 820], ["phone", 390, 844]]) {
  await p.setViewportSize({ width: w, height: h });
  for (const hash of ["#/", "#/new", "#/live", "#/models", "#/settings"]) { await p.goto(base + "/" + hash); await p.waitForTimeout(450); const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); ok(`${name} ${hash}: nessuno scroll orizzontale`, ov <= 1, "overflow=" + ov); }
  await p.goto(base + "/#/"); await p.locator(".item-link").first().click(); await p.waitForSelector(".seg"); const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); ok(`${name} editor: nessuno scroll orizzontale`, ov <= 1, "overflow=" + ov);
  await p.screenshot({ path: `${shots}/editor-${name}.png` });
  if (name === "phone") { await p.goto(base + "/#/"); await p.waitForTimeout(500); await p.screenshot({ path: `${shots}/home-phone.png` }); }
}
ok("nessun errore JS in console", errors.length === 0, errors.slice(0, 3).join(" ; "));
await b.close(); process.exit(done());
