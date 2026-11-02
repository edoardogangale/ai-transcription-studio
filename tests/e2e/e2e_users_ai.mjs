// Collaudo browser: accesso con codice, profili separati, correzione AI (finto Ollama) con approvazione e memoria.
// Server: STUDIO_ENABLE_MOCK=1 STUDIO_TOKEN=adminsecret OLLAMA_URL=http://127.0.0.1:11555 ; finto Ollama: python fake_ollama.py 11555
// uso: node e2e_users_ai.mjs <base_url> <wav> <cartella_screenshot>
import fs from "fs";
import { chromium, reporter } from "./lib.mjs";
const [base, wav, shots] = process.argv.slice(2);
const { ok, done } = reporter();
const b = await chromium.launch();
const mk = async () => { const c = await b.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] }); const p = await c.newPage(); p.errors = []; p.on("pageerror", e => p.errors.push(e.message)); p.on("console", m => m.type() === "error" && !/Failed to load resource/.test(m.text()) && p.errors.push(m.text())); p.on("dialog", d => d.accept()); return { c, p }; };
const { c: ctxA, p } = await mk();
const apiA = (path, o = {}) => ctxA.request.fetch(base + path, { ...o, headers: { "X-Studio-Token": "adminsecret", ...(o.headers || {}) } });

// 1) accesso
await p.goto(base); await p.waitForSelector("dialog.modal input[type=password]");
ok("senza codice compare la schermata di accesso", await p.locator("dialog h3:has-text('Accedi')").count() === 1);
await p.fill("dialog input", "sbagliato"); await p.click("dialog >> text=Entra"); await p.waitForSelector("dialog .err:has-text('non valido')"); ok("codice errato rifiutato", true);
await p.fill("dialog input", "adminsecret"); await p.click("dialog >> text=Entra"); await p.waitForSelector("text=Tutte le registrazioni"); ok("codice amministratore accettato", true);
ok("nome del profilo in testata con 'Esci'", await p.locator("#who").innerText().then(t => /Amministratore/.test(t) && /Esci/.test(t)));

// 2) profili
await p.goto(base + "/#/settings"); await p.waitForSelector("text=Persone (archivi separati)");
await p.fill("input[placeholder^='Nome']", "Marco"); await p.click("text=Crea profilo"); await p.waitForSelector(".codebox");
const code = (await p.locator(".codebox").innerText()).trim(); ok("codice del profilo mostrato una volta", code.length >= 8, code); await p.click("dialog >> text=Chiudi");
await p.waitForSelector(".item:has-text('Marco')"); ok("profilo elencato", true);

// 3) l'amministratore crea due trascrizioni (via API per brevità)
const upload = async (name) => (await (await apiA("/api/upload", { method: "POST", multipart: { file: { name, mimeType: "audio/wav", buffer: fs.readFileSync(wav) } } })).json());
const mkT = async (m, model, title) => (await (await apiA("/api/transcripts", { method: "POST", data: { upload_id: m.upload_id, language: "it", model_id: model, title, force: true } })).json()).id;
const waitDone = async id => { for (let i = 0; i < 100; i++) { const t = await (await apiA("/api/transcripts/" + id)).json(); if (t.status === "done") return t; await new Promise(r => setTimeout(r, 300)); } throw new Error("timeout"); };
const tA = await mkT(await upload("a.wav"), "mock", "Kant per l'AI"); const tA2 = await waitDone(tA);
const tB = await mkT(await upload("b.wav"), "mock2", "Con fuori tema"); await waitDone(tB);

// 4) il profilo di Marco non vede nulla dell'amministratore
const { c: ctxM, p: pm } = await mk();
await pm.goto(base); await pm.waitForSelector("dialog input[type=password]"); await pm.fill("dialog input", code); await pm.click("dialog >> text=Entra"); await pm.waitForSelector("text=Tutte le registrazioni");
ok("Marco vede l'archivio vuoto", await pm.locator(".item").count() === 0 && await pm.locator("text=Ancora nessuna trascrizione").count() === 1);
await pm.goto(base + "/#/t/" + tA); await pm.waitForSelector("text=/Errore/"); ok("Marco non può aprire una registrazione dell'amministratore", true);
await pm.goto(base + "/#/settings"); await pm.waitForSelector("text=Persone (archivi separati)"); ok("Marco non gestisce i profili", await pm.locator("text=/gestisce l'amministratore/").count() === 1);
await pm.goto(base + "/#/models"); await pm.waitForSelector("text=Modelli principali"); ok("Marco non può installare modelli (condivisi)", await pm.locator("button:has-text('Installa'):not([disabled])").count() === 0);
await pm.screenshot({ path: `${shots}/marco-empty.png` });

// 5) correzione AI: proposta -> approvazione -> memoria
await p.goto(base + "/#/t/" + tA); await p.waitForSelector(".seg"); await p.waitForSelector("summary:has-text('Correzione con AI')");
ok("pannello AI con valutazione ('non serve' per questo modello)", await p.locator("summary:has-text('Correzione con AI') .chip").innerText().then(t => /Probabilmente non serve|facoltativa|consigliata/.test(t)));
await p.click("summary:has-text('Correzione con AI')"); await p.waitForSelector("text=Controlla con l'AI");
ok("modello AI installato rilevato", await p.locator(".ai select option:has-text('qwen3:4b')").count() >= 1);
await p.locator(".ai select").nth(1).selectOption("all"); await p.click("text=✨ Controlla con l'AI"); await p.waitForSelector(".aiitem", { timeout: 20000 });
ok("proposta con diff (parola corretta evidenziata)", await p.locator(".aiitem .diff-ins").first().innerText().then(t => /Parola0/.test(t)) && await p.locator(".aiitem .diff-del").count() >= 1);
ok("il testo NON è cambiato prima dell'approvazione", (await (await apiA("/api/transcripts/" + tA)).json()).segments.every(s => !/Parola0/.test(s.text)));
await p.screenshot({ path: `${shots}/ai-proposals.png` });
await p.click("text=Applica le selezionate"); await p.waitForTimeout(1200); await p.waitForSelector(".seg");
const after = await (await apiA("/api/transcripts/" + tA)).json();
ok("correzione applicata dopo l'approvazione", after.segments.some(s => /Parola0/.test(s.text)) && after.orig_segments.every(s => !/Parola0/.test(s.text)));
await p.goto(base + "/#/settings"); await p.waitForSelector("text=Memoria delle correzioni"); await p.waitForSelector("text=«parola0» → «Parola0»", { timeout: 5000 }); ok("correzione ricordata nella memoria", true);
ok("Ollama e modelli mostrati in Impostazioni", await p.locator("text=/Ollama attivo/").count() === 1 && await p.locator("text=Qwen3 4B").count() >= 1);
// parti fuori tema
await p.goto(base + "/#/t/" + tB); await p.waitForSelector(".seg"); await p.click("summary:has-text('Correzione con AI')"); await p.locator(".ai select").nth(1).selectOption("all"); await p.click("text=✨ Controlla con l'AI");
await p.waitForSelector("text=Fuori tema (non selezionate", { timeout: 20000 }); ok("parti fuori tema proposte ma NON preselezionate", await p.locator(".aiitem input:checked").count() === 0 || await p.locator(".aiitem:has(.chip.warn) input:checked").count() === 0);
await p.locator(".aiitem:has(.chip.warn) input[type=checkbox]").first().check(); await p.click("text=Applica le selezionate"); await p.waitForTimeout(1200); await p.waitForSelector(".seg", { state: "attached" });
ok("parte fuori tema esclusa e nascosta di default", await p.locator("label:has-text('parti fuori tema') input").count() === 1 && await p.locator(".seg.hidden").count() >= 1);
const txt = await (await apiA(`/api/transcripts/${tB}/export/txt`)).text(); const txtAll = await (await apiA(`/api/transcripts/${tB}/export/txt?teacher_only=false`)).text();
ok("l'export esclude le parti fuori tema (e con l'opzione le include)", txtAll.length > txt.length);
await p.locator("label:has-text('parti fuori tema') input").check(); await p.waitForTimeout(300); ok("mostrandole compare il pulsante per riportarle in tema", await p.locator("button:has-text('fuori tema ↺')").count() >= 1);
await p.screenshot({ path: `${shots}/ai-offtopic.png` });
// download modello AI (finto) dalle impostazioni
await p.goto(base + "/#/settings"); await p.waitForSelector("text=Qwen3 1.7B"); await p.locator(".item:has-text('Qwen3 1.7B') button:has-text('Installa')").click(); await p.waitForTimeout(1500);
ok("avvio download modello AI senza errori", p.errors.length === 0);
// profilo: nuovo codice e eliminazione
await p.goto(base + "/#/settings"); await p.waitForSelector(".item:has-text('Marco')"); await p.locator(".item:has-text('Marco') button:has-text('Elimina')").click(); await p.waitForTimeout(800);
ok("profilo eliminato", await p.locator(".item:has-text('Marco')").count() === 0);
await pm.goto(base + "/#/"); await pm.waitForSelector("dialog input[type=password]"); ok("il codice del profilo eliminato non vale più", true);
ok("nessun errore JS in console", p.errors.length === 0 && pm.errors.length === 0, [...p.errors, ...pm.errors].slice(0, 3).join(" ; "));
await b.close(); process.exit(done());
