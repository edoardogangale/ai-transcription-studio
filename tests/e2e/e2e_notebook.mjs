// Collaudo browser del QUADERNO: testo ricco, formattazione, inchiostro (eventi 'pen' sintetici + mouse), gomma/annulla, ancoraggio,
// dito che scorre senza disegnare, salvataggio, ricerca, stampa PDF con disegni, touch/iPad.
// uso: node e2e_notebook.mjs <base_url> <wav> <cartella_screenshot>   (server con STUDIO_ENABLE_MOCK=1)
import fs from "fs";
import { chromium, reporter } from "./lib.mjs";
const [base, wav, shots] = process.argv.slice(2);
const { ok, done } = reporter();
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
const p = await ctx.newPage(); const errors = [];
p.on("pageerror", e => errors.push(e.message)); p.on("console", m => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text())); p.on("dialog", d => d.accept());
const api = (path, o = {}) => ctx.request.fetch(base + path, o);
const up = await (await api("/api/upload", { method: "POST", multipart: { file: { name: "Quaderno prova.wav", mimeType: "audio/wav", buffer: fs.readFileSync(wav) } } })).json();
const tid = (await (await api("/api/transcripts", { method: "POST", data: { upload_id: up.upload_id, language: "it", model_id: "mock", title: "Kant: quaderno", force: true } })).json()).id;
for (let i = 0; i < 100; i++) { if ((await (await api("/api/transcripts/" + tid)).json()).status === "done") break; await new Promise(r => setTimeout(r, 300)); }
await api(`/api/transcripts/${tid}/annotations`, { method: "POST", data: { kind: "highlight", t0: 0, t1: 3 } }); await api(`/api/transcripts/${tid}/annotations`, { method: "POST", data: { kind: "note", t0: 6, text: "Da ripassare è così" } });

// 1) creazione dalla trascrizione
await p.goto(base + "/#/t/" + tid); await p.waitForSelector(".seg"); await p.click("a:has-text('Quaderno')");
await p.waitForSelector("text=Crea il quaderno"); ok("offerta di creare il quaderno dalla trascrizione", await p.locator("text=le modifiche qui non cambiano la trascrizione").count() === 1);
await p.click("button:has-text('Crea il quaderno')"); await p.waitForSelector(".nb-doc");
ok("quaderno con titolo, ▶ tempo, evidenziazione e nota", await p.locator(".nb-doc h1").innerText() === "Kant: quaderno" && await p.locator(".nb-ts").count() >= 1 && await p.locator(".nb-doc mark").count() >= 1 && await p.locator(".nb-note").innerText().then(t => t.includes("Da ripassare è così")));
const ts0 = parseFloat(await p.locator(".nb-doc p[data-t]").first().getAttribute("data-t"));
await p.locator(".nb-ts").first().click(); await p.waitForTimeout(300);
ok("▶ sul paragrafo riascolta quel punto", Math.abs(await p.evaluate(() => document.querySelector(".nb-player audio").currentTime) - ts0) < 0.6); await p.evaluate(() => document.querySelector(".nb-player audio").pause());

// 2) scrittura e formattazione (come in Word)
await p.locator(".nb-doc p").first().click(); await p.keyboard.press("End"); await p.keyboard.type(" Appunto mio: è così, città ñ");
await p.keyboard.press("Enter"); await p.keyboard.type("Nuovo paragrafo da cancellare");
await p.evaluate(() => { const el = [...document.querySelectorAll(".nb-doc p")].pop(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
await p.locator("button[aria-label='Grassetto']").tap(); await p.waitForTimeout(150);
ok("grassetto sul testo selezionato", await p.locator(".nb-doc p:last-of-type b, .nb-doc p:last-of-type strong").count() >= 1);
await p.locator("button[aria-label='Elenco puntato']").tap(); await p.waitForTimeout(150); ok("elenco puntato", await p.locator(".nb-doc ul li").count() >= 1);
await p.locator("button[aria-label='Titolo']").tap(); await p.waitForTimeout(150); ok("titolo (H1)", await p.locator(".nb-doc h1").count() >= 2 || await p.locator(".nb-doc li h1").count() >= 1);
await p.locator(".nb-doc p").first().click(); await p.keyboard.press("End"); for (let i = 0; i < 5; i++) await p.keyboard.press("Shift+ArrowLeft");
await p.keyboard.press("Backspace"); await p.waitForTimeout(100);
ok("cancellare parole con la tastiera", !(await p.locator(".nb-doc p").first().innerText()).includes("città ñ") && (await p.locator(".nb-doc p").first().innerText()).includes("Appunto mio"));
await p.locator("button[aria-label='Annulla']").tap(); await p.waitForTimeout(150);
ok("annulla ripristina il testo (annulla del testo)", (await p.locator(".nb-doc p").first().innerText()).includes("ñ"));
await p.keyboard.press("End"); await p.keyboard.type(" parolaunica4242");
await p.waitForSelector("text=/Salvato \\d/", { timeout: 8000 }); ok("salvataggio automatico del testo", true);
const saved = await (await api(`/api/transcripts/${tid}/notebook`)).json();
const savedTxt = saved.html.replace(/\u00a0/g, " ").replace(/<[^>]+>/g, "");   // il browser inserisce spazi non separabili mentre si scrive: sono normali
ok("testo salvato sul server (accenti inclusi)", savedTxt.includes("Appunto mio: è così, città") && savedTxt.includes("parolaunica4242"), JSON.stringify(savedTxt.slice(savedTxt.indexOf("Appunto") - 2, savedTxt.indexOf("Appunto") + 70)));
ok("la ricerca trova il testo scritto nel quaderno", (await (await api("/api/search?q=parolaunica4242")).json()).results.some(r => r.id === tid));

// 3) inchiostro
// documento alto, così si può scorrere
await api(`/api/transcripts/${tid}/notebook`, { method: "PUT", data: { html: Array.from({ length: 40 }, (_, i) => `<p>Paragrafo ${i + 1} della lezione su Kant e la critica della ragion pura.</p>`).join(""), ink: [] } });
await p.reload(); await p.waitForSelector(".nb-doc"); await p.waitForTimeout(500);
const pen = (pts, o = {}) => p.evaluate(({ pts, type, pid }) => {
  const c = document.querySelector(".nb-ink"), r = c.getBoundingClientRect();
  const fire = (t, [x, y, pr]) => c.dispatchEvent(new PointerEvent(t, { pointerId: pid, pointerType: type, isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: pr ?? 0.5, bubbles: true, cancelable: true, buttons: t === "pointerup" ? 0 : 1 }));
  fire("pointerdown", pts[0]); for (const q of pts.slice(1)) fire("pointermove", q); fire("pointerup", pts[pts.length - 1]);
}, { pts, type: o.type || "pen", pid: o.pid || 7 });
const nStrokes = () => p.evaluate(() => window.__nb.strokes().length);
await p.locator("button:has-text('Penna')").tap(); ok("modalità penna attiva (il testo non si seleziona)", await p.evaluate(() => getComputedStyle(document.querySelector(".nb-ink")).pointerEvents) === "auto");
const wave = Array.from({ length: 30 }, (_, i) => [120 + i * 12, 200 + Math.sin(i / 3) * 30, 0.15 + (i / 30) * 0.8]);
await pen(wave); ok("tratto con Apple Pencil (pen) registrato con la pressione", await nStrokes() === 1 && await p.evaluate(() => { const s = window.__nb.strokes()[0]; return s.t === "pen" && s.p.length > 10 && Math.max(...s.p.map(q => q[2])) > 0.8 && Math.min(...s.p.map(q => q[2])) < 0.3; }));
await pen(wave.map(([x, y]) => [x, y + 100, 0.5]), { type: "touch", pid: 11 }); ok("un dito NON disegna (palm rejection)", await nStrokes() === 1);
const y0 = await p.evaluate(() => window.scrollY);
await pen([[300, 500], [300, 450], [300, 400], [300, 300], [300, 200]], { type: "touch", pid: 12 }); await p.waitForTimeout(100);
ok("un dito trascina la pagina (scorre)", await p.evaluate(() => window.scrollY) > y0 + 100, `scrollY ${y0} → ${await p.evaluate(() => window.scrollY)}`);
await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(100);
await p.locator("button:has-text('Freccia')").tap(); await pen([[200, 400, 0.5], [450, 330, 0.5]]); ok("freccia (2 punti)", await nStrokes() === 2 && await p.evaluate(() => window.__nb.strokes()[1].t === "arrow" && window.__nb.strokes()[1].p.length === 2));
await p.locator("button:has-text('Evidenz.')").tap(); await pen([[100, 260], [400, 262], [700, 258]]); ok("evidenziatore", await nStrokes() === 3 && await p.evaluate(() => window.__nb.strokes()[2].t === "hl"));
await p.locator("button.sw").nth(2).tap(); await p.locator("button:has-text('Penna')").tap(); await pen([[100, 600], [200, 650], [300, 600]]); ok("colore scelto applicato al tratto", await p.evaluate(() => window.__nb.strokes()[3].c) === "#dc2626");
await p.locator("button:has-text('Gomma')").tap(); await pen([[200, 640], [200, 660]]); ok("gomma: cancella il tratto toccato", await nStrokes() === 3);
await p.locator("button[aria-label='Annulla']").tap(); ok("annulla ripristina il tratto cancellato", await nStrokes() === 4);
await p.locator("button[aria-label='Ripeti']").tap(); ok("ripeti lo cancella di nuovo", await nStrokes() === 3);
await p.locator("button[aria-label='Annulla']").tap();
const px = () => p.evaluate(() => { const c = document.querySelector(".nb-ink"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++; return n; });
ok("i tratti sono davvero disegnati sul canvas", await px() > 300);
await p.screenshot({ path: `${shots}/notebook-ink.png` });
await p.waitForSelector("text=/Salvato .* tratti/", { timeout: 8000 }); ok("i tratti si salvano da soli", (await (await api(`/api/transcripts/${tid}/notebook`)).json()).ink.length === 4);

// 4) ancoraggio: scrivere sopra sposta il disegno insieme al suo paragrafo
await p.locator("button:has-text('Testo')").tap();
const minInkY = () => p.evaluate(() => { const c = document.querySelector(".nb-ink"), dpr = devicePixelRatio, d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4 + 3] > 0) return y / dpr; return -1; });
const before = await minInkY(); const anchorTop = await p.evaluate(() => { const s = window.__nb.strokes()[0]; return document.querySelector(`[data-bid="${s.a}"]`).getBoundingClientRect().top; });
await p.locator(".nb-doc p").first().click(); await p.keyboard.press("Control+Home"); for (let i = 0; i < 4; i++) { await p.keyboard.press("Enter"); } await p.keyboard.type("Quattro righe nuove in cima"); await p.waitForTimeout(300);
const after = await minInkY(); const anchorTop2 = await p.evaluate(() => { const s = window.__nb.strokes()[0]; return document.querySelector(`[data-bid="${s.a}"]`).getBoundingClientRect().top; });
ok("il disegno segue il suo paragrafo quando aggiungo testo sopra", anchorTop2 - anchorTop > 20 && Math.abs((after - before) - (anchorTop2 - anchorTop)) < 4, `paragrafo +${(anchorTop2 - anchorTop).toFixed(0)}px, disegno +${(after - before).toFixed(0)}px`);

// 5) spazio per disegnare, ricarica, stampa
await p.locator("button[aria-label*='spazio per disegnare']").tap(); await p.waitForTimeout(200); ok("spazio per disegnare inserito", await p.locator(".nb-space").count() === 1);
await p.evaluate(() => window.__nb.save()); await p.reload(); await p.waitForSelector(".nb-doc"); await p.waitForTimeout(500);
ok("dopo il ricaricamento testo e disegni ci sono ancora", await nStrokes() === 4 && await p.locator(".nb-space").count() === 1 && (await p.locator(".nb-doc").innerText()).includes("Quattro righe nuove in cima") && await px() > 300);
const nbefore = await p.evaluate(() => { window.__nbPrint.bp(); return window.__nbPrint.count(); });
ok("stampa: i disegni diventano SVG vettoriali dentro il proprio paragrafo", nbefore >= 1 && await p.locator(".nb-doc > * svg.nb-print-ink").count() >= 1 && await p.locator("svg.nb-print-ink polyline, svg.nb-print-ink path").count() >= 4);
await p.evaluate(() => window.__nbPrint.ap()); ok("dopo la stampa gli SVG temporanei spariscono", await p.locator("svg.nb-print-ink").count() === 0);
await p.evaluate(() => window.__nbPrint.bp()); await p.emulateMedia({ media: "print" });
ok("in stampa spariscono barre e lettore, resta il documento", await p.locator(".nb-bar").isHidden() && await p.locator(".nb-player").isHidden() && await p.locator(".nb-doc").isVisible());
const pdfInk = await p.pdf({ format: "A4", printBackground: true }); await p.evaluate(() => window.__nbPrint.ap());
await api(`/api/transcripts/${tid}/notebook`, { method: "PUT", data: { html: await p.evaluate(() => document.querySelector(".nb-doc").innerHTML), ink: [] } });
await p.evaluate(() => { window.__nb.strokes().length = 0; }); await p.evaluate(() => window.__nbPrint.bp()); const pdfNoInk = await p.pdf({ format: "A4", printBackground: true }); await p.evaluate(() => window.__nbPrint.ap()); await p.emulateMedia({ media: "screen" });
const hasRG = buf => buf.toString("latin1").includes(" RG");   // operatore PDF "colore del tratto": presente solo se ci sono tracciati vettoriali
ok("il PDF stampato contiene i disegni vettoriali", pdfInk.slice(0, 5).toString() === "%PDF-" && pdfInk.length > pdfNoInk.length, `PDF con disegni ${pdfInk.length} B, senza ${pdfNoInk.length} B`);

// 6) esportazione, copia
await p.reload(); await p.waitForSelector(".nb-doc");
const [dl] = await Promise.all([p.waitForEvent("download"), p.selectOption("select[aria-label=Esporta]", "docx")]); const docx = fs.readFileSync(await dl.path());
ok("esporta in Word (.docx)", docx.slice(0, 2).toString() === "PK" && dl.suggestedFilename().endsWith(".docx"), dl.suggestedFilename());
await p.selectOption("select[aria-label=Esporta]", "copy"); await p.waitForTimeout(300); ok("copia il testo del quaderno", (await p.evaluate(() => navigator.clipboard.readText())).includes("Quattro righe nuove"));

// 7) iPad: bersagli touch, nessuno scroll orizzontale
const bad = await p.evaluate(() => [...document.querySelectorAll(".nb-bar button, .nb-bar select, .nb-bar a.btn, .nb-bar label")].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0; }).map(e => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute("aria-label") || e.innerText || "").slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }; }).filter(x => Math.min(x.w, x.h) < 40));
ok("quaderno: bersagli touch ≥ 40 px", bad.length === 0, bad.slice(0, 6).map(x => `${x.t}(${x.w}x${x.h})`).join(", "));
ok("quaderno: nessuno scroll orizzontale della pagina", await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1);
await p.screenshot({ path: `${shots}/notebook-ipad13.png` });
for (const [w, h] of [[834, 1210], [1376, 1032]]) { await p.setViewportSize({ width: w, height: h }); await p.waitForTimeout(400); ok(`quaderno ${w}x${h}: nessuno scroll orizzontale`, await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1); }
ok("nessun errore JS in console", errors.length === 0, errors.slice(0, 3).join(" ; "));
await b.close(); process.exit(done());
