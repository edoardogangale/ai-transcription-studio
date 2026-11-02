// Eliminare deve funzionare SEMPRE e dare un esito visibile. Il server va avviato con STUDIO_ENABLE_MOCK=1 e STUDIO_MOCK_DELAY=0.8 (lavori lenti).
// uso: node e2e_delete.mjs <base_url> <wav> <wav_mic> <db_path> <cartella_screenshot>
import fs from "fs";
import { execFileSync } from "child_process";
import { chromium, reporter } from "./lib.mjs";
const [base, wav, micWav, dbPath, shots] = process.argv.slice(2);
const { ok, done } = reporter();
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micWav}`] });
const ctx = await b.newContext({ viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ["microphone"], acceptDownloads: true });
const errors = []; let nativeDialogs = 0;
const mkPage = async () => { const p = await ctx.newPage(); p.on("pageerror", e => errors.push(e.message)); p.on("console", m => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text())); p.on("dialog", d => { nativeDialogs++; d.accept(); }); return p; };
const p = await mkPage();
const api = (path, o = {}) => ctx.request.fetch(base + path, o);
const J = async (path, o) => (await api(path, o)).json();
const exists = async id => (await api("/api/transcripts/" + id)).status() === 200;
const upload = async (name, buf = fs.readFileSync(wav)) => J("/api/upload", { method: "POST", multipart: { file: { name, mimeType: "audio/wav", buffer: buf } } });
const mkT = async (title, model = "mock") => (await J("/api/transcripts", { method: "POST", data: { upload_id: (await upload(title + ".wav")).upload_id, language: "it", model_id: model, title, force: true } })).id;
const waitStatus = async (id, st, ms = 30000) => { for (let i = 0; i < ms / 200; i++) { const t = await J("/api/transcripts/" + id); if (st.includes(t.status)) return t.status; await new Promise(r => setTimeout(r, 200)); } return "timeout"; };
const confirmDelete = async (label = "Elimina") => { await p.waitForSelector("dialog.modal[open]"); await p.locator(`dialog.modal[open] button:text-is("${label}")`).tap(); await p.waitForSelector("dialog.modal", { state: "detached", timeout: 5000 }).catch(() => {}); };

// A) cestino su una riga, trascrizione completata
const a = await mkT("Prova A"); await waitStatus(a, ["done"]);
await p.goto(base); await p.waitForSelector(".item");
await p.locator(".item", { hasText: "Prova A" }).locator("button[aria-label^='Elimina']").tap(); await p.waitForSelector("dialog.modal[open] h3");
ok("conferma con finestra dell'app (non il dialogo nativo)", await p.locator("dialog.modal[open]").innerText().then(t => /Prova A/.test(t) && /Elimina/.test(t)) && nativeDialogs === 0);
await p.locator("dialog.modal[open] button:text-is('Annulla')").tap(); await p.waitForTimeout(300); ok("Annulla non elimina nulla", await exists(a));
await p.locator(".item", { hasText: "Prova A" }).locator("button[aria-label^='Elimina']").tap(); await confirmDelete();
await p.waitForFunction(() => ![...document.querySelectorAll(".item")].some(e => /Prova A/.test(e.innerText)), null, { timeout: 8000 });
ok("elimina una registrazione completata (sparisce dall'elenco e dal server)", !(await exists(a)));

// B) lavoro in corso (lento): prima dava 409 e restava lì
const bId = await mkT("Prova B lavoro in corso");
await p.goto(base); await p.waitForSelector(".item"); await waitStatus(bId, ["running"]);
await p.locator(".item", { hasText: "Prova B" }).locator("button[aria-label^='Elimina']").tap(); await confirmDelete();
await p.waitForFunction(() => ![...document.querySelectorAll(".item")].some(e => /Prova B/.test(e.innerText)), null, { timeout: 15000 });
ok("elimina un lavoro ANCORA IN CORSO", !(await exists(bId)));

// C) registrazione live rimasta aperta (nessun browser collegato): prima 'eliminate 0'
const live1 = (await J("/api/live", { method: "POST", data: { language: "it", model_id: "mock", title: "Prova C live aperta" } })).id;
await p.goto(base); await p.waitForSelector(".item:has-text('Prova C')"); ok("la registrazione aperta compare come 'In registrazione'", await p.locator(".item:has-text('Prova C') .chip").innerText().then(t => /registrazione/i.test(t)));
await p.locator(".item", { hasText: "Prova C" }).locator("button[aria-label^='Elimina']").tap(); await p.waitForSelector("dialog.modal[open]");
ok("il messaggio spiega che verrà chiusa senza salvare", await p.locator("dialog.modal[open]").innerText().then(t => /ancora aperta/.test(t))); await confirmDelete();
await p.waitForFunction(() => ![...document.querySelectorAll(".item")].some(e => /Prova C/.test(e.innerText)), null, { timeout: 15000 });
ok("elimina una registrazione live ancora aperta", !(await exists(live1)));

// D) registrazione orfana (dopo riavvio/chiusura della pagina): recupera oppure elimina dalla pagina
const mkOrphan = title => { const id = "orf" + Math.random().toString(36).slice(2, 9); execFileSync("python3", ["-c", `import sqlite3,time,sys;c=sqlite3.connect(sys.argv[1],timeout=30);c.execute("INSERT INTO transcripts(id,title,upload_id,filename,audio_path,duration,language,model_id,context,options,status,kind,owner,created,updated,segments) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(sys.argv[2],sys.argv[3],'orfano','', '',0,'it','mock','Altro','{}','recording','live','admin',time.time(),time.time(),'[]'));c.commit()`, dbPath, id, title]); return id; };
const o1 = mkOrphan("Prova D orfana");
await p.goto(base + "/#/t/" + o1); await p.waitForSelector("text=è rimasta aperta");
ok("registrazione orfana: pagina con 'Recupera' ed 'Elimina'", await p.locator("button:has-text('Recupera audio e testo')").count() === 1 && await p.locator(".notice.warn button.danger").count() === 1);
await p.locator(".notice.warn button.danger").tap(); await confirmDelete(); await p.waitForFunction(() => location.hash === "#/", null, { timeout: 8000 });
ok("elimina la registrazione orfana dalla sua pagina", !(await exists(o1)));
const o2 = mkOrphan("Prova D2 orfana"); await p.goto(base + "/#/t/" + o2); await p.waitForSelector("button:has-text('Recupera audio e testo')"); await p.locator("button:has-text('Recupera audio e testo')").tap(); await p.waitForTimeout(1200);
ok("recupero senza audio: errore chiaro e la registrazione si può comunque eliminare", (await J("/api/transcripts/" + o2)).status === "failed");
await J("/api/transcripts/" + o2, { method: "DELETE" });

// E) editor: Elimina
const e = await mkT("Prova E editor"); await waitStatus(e, ["done"]);
await p.goto(base + "/#/t/" + e); await p.waitForSelector(".seg"); await p.locator("button.danger:text-is('Elimina')").tap(); await confirmDelete();
await p.waitForFunction(() => location.hash === "#/", null, { timeout: 8000 }); ok("elimina dall'editor e torna all'archivio", !(await exists(e)));

// F) selezione multipla in stati diversi (completata, in corso, live aperta, orfana)
const f1 = await mkT("Prova F1"); await waitStatus(f1, ["done"]); const f2 = await mkT("Prova F2 in corso"); const f3 = (await J("/api/live", { method: "POST", data: { language: "it", model_id: "mock", title: "Prova F3 live" } })).id; const f4 = mkOrphan("Prova F4 orfana");
await p.goto(base); await p.waitForSelector(".item:has-text('Prova F4')"); await waitStatus(f2, ["running"]);
await p.locator("text=Seleziona tutto").locator("input").tap(); await p.waitForSelector(".actionbar");
const n = await p.locator(".item").count(); await p.locator(".actionbar button:text-is('Elimina')").tap(); await confirmDelete();
await p.waitForFunction(() => document.querySelectorAll(".item").length === 0, null, { timeout: 20000 });
ok(`elimina in un colpo ${n} registrazioni in stati diversi`, !(await exists(f1)) && !(await exists(f2)) && !(await exists(f3)) && !(await exists(f4)));

// G) la registrazione che sto facendo viene eliminata da un'altra pagina: il registratore si ferma e lo dice
const rec = await mkPage(); await rec.goto(base + "/#/live"); await rec.waitForSelector("text=Inizia registrazione"); await rec.locator("select").nth(1).selectOption("mock"); await rec.click("text=● Inizia registrazione"); await rec.waitForSelector(".bigtime", { timeout: 20000 }); await rec.waitForTimeout(2500);
const live2 = (await J("/api/transcripts")).find(t => t.status === "recording").id;
await p.goto(base); await p.waitForSelector(".item"); await p.locator(".item", { hasText: "Lezione" }).locator("button[aria-label^='Elimina']").tap(); await confirmDelete();
await rec.waitForSelector("text=Inizia registrazione", { timeout: 15000 }); ok("la registrazione in corso, eliminata altrove, si ferma e torna alla schermata iniziale", !(await exists(live2)) && await rec.locator("text=Inizia registrazione").count() >= 1);
ok("nessun dialogo nativo usato (confirm/prompt/alert)", nativeDialogs === 0, "nativi: " + nativeDialogs);

// H) altre eliminazioni dell'app: annotazione, quaderno, cartella, vocabolario, memoria correzioni
const h1 = await mkT("Prova H"); await waitStatus(h1, ["done"]);
await J(`/api/transcripts/${h1}/annotations`, { method: "POST", data: { kind: "note", t0: 1, text: "nota da togliere" } });
await p.goto(base + "/#/t/" + h1); await p.waitForSelector(".notechip"); await p.locator(".notechip").tap(); await p.waitForSelector("dialog.modal[open] input"); await p.locator("dialog.modal[open] button:text-is('Elimina')").tap(); await p.waitForTimeout(500);
ok("elimina una nota dall'editor", (await J(`/api/transcripts/${h1}/annotations`)).annotations.length === 0);
await J(`/api/transcripts/${h1}/notebook/create`, { method: "POST", data: {} }); await p.goto(base + "/#/n/" + h1); await p.waitForSelector(".nb-doc");
await p.selectOption("select[aria-label=Altro]", "del"); await confirmDelete(); await p.waitForFunction(h => location.hash === "#/t/" + h, h1, { timeout: 8000 });
ok("elimina il quaderno (la trascrizione resta)", !(await J(`/api/transcripts/${h1}/notebook`)).exists && await exists(h1));
const fid = (await J("/api/folders", { method: "POST", data: { name: "Cartella da togliere" } })).id; await J("/api/transcripts/move", { method: "POST", data: { ids: [h1], folder_id: fid } });
await p.goto(base); await p.waitForSelector(".fname:has-text('Cartella da togliere')"); await p.locator(".frow", { hasText: "Cartella da togliere" }).locator(".fmore").tap(); await p.waitForSelector("dialog.modal[open]"); await p.locator("dialog.modal[open] button:text-is('Elimina cartella')").tap(); await confirmDelete();
await p.waitForTimeout(600); ok("elimina una cartella (le registrazioni restano)", (await J("/api/folders")).folders.every(f => f.id !== fid) && await exists(h1));
await J("/api/vocab", { method: "POST", data: { term: "Termine di prova", context: "*" } }); await J("/api/corrections", { method: "POST", data: { scope: "Altro", wrong: "sbagliatoX", right: "giustoX" } });
await p.goto(base + "/#/settings"); await p.waitForSelector(".item:has-text('Termine di prova')"); await p.locator(".item:has-text('Termine di prova') button:text-is('Rimuovi')").tap(); await p.waitForTimeout(500);
await p.waitForSelector(".item:has-text('sbagliatoX')"); await p.locator(".item:has-text('sbagliatoX') button:text-is('Rimuovi')").tap(); await p.waitForTimeout(500);
ok("rimuove un termine del vocabolario e una correzione ricordata", (await J("/api/vocab")).custom.every(v => v.term !== "Termine di prova") && (await J("/api/corrections")).corrections.every(c => c.wrong !== "sbagliatoX"));
ok("nessun dialogo nativo in tutto il collaudo", nativeDialogs === 0, "nativi: " + nativeDialogs);
ok("nessun errore JS in console", errors.length === 0, errors.slice(0, 3).join(" ; "));
await b.close(); process.exit(done());
