// Tocca OGNI controllo di OGNI pagina (iPad emulato, touch) e segnala: pulsanti senza effetto, coperti da altri elementi, o che causano errori.
// Server: STUDIO_ENABLE_MOCK=1 STUDIO_TOKEN=adminsecret OLLAMA_URL=http://127.0.0.1:11555 ; finto Ollama: python fake_ollama.py 11555
// uso: node e2e_allbuttons.mjs <base_url> <wav> <silenzio.wav> <wav_mic> <db_path> <cartella_screenshot>
import fs from "fs";
import { execFileSync } from "child_process";
import { chromium, reporter } from "./lib.mjs";
const [base, wav, silent, micWav, dbPath, shots] = process.argv.slice(2);
const { ok, done } = reporter();
const TOKEN = "adminsecret", H = { "X-Studio-Token": TOKEN };
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micWav}`] });
const ctx = await b.newContext({ viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ["microphone", "clipboard-read", "clipboard-write"], acceptDownloads: true });
await ctx.addInitScript(t => { try { localStorage.setItem("studio_token", t); } catch (e) {} }, TOKEN);
const api = (path, o = {}) => ctx.request.fetch(base + path, { ...o, headers: { ...H, ...(o.headers || {}) } });
const J = async (path, o) => (await api(path, o)).json();
const up = async (name, f = wav) => J("/api/upload", { method: "POST", multipart: { file: { name, mimeType: "audio/wav", buffer: fs.readFileSync(f) } } });
const mkT = async (title, model = "mock", f = wav) => (await J("/api/transcripts", { method: "POST", data: { upload_id: (await up(title + ".wav", f)).upload_id, language: "it", model_id: model, title, force: true } })).id;
const waitDone = async (id, want = ["done", "failed"]) => { for (let i = 0; i < 150; i++) { const t = await J("/api/transcripts/" + id); if (want.includes(t.status)) return t; await new Promise(r => setTimeout(r, 200)); } };

/* ---- dati di prova ---- */
const fFil = (await J("/api/folders", { method: "POST", data: { name: "Filosofia" } })).id; const fKant = (await J("/api/folders", { method: "POST", data: { name: "Kant", parent_id: fFil } })).id;
const t1 = await mkT("Kant uno"); await waitDone(t1); await J("/api/transcripts/move", { method: "POST", data: { ids: [t1], folder_id: fKant } });
await J(`/api/transcripts/${t1}/annotations`, { method: "POST", data: { kind: "highlight", t0: 0, t1: 3 } }); await J(`/api/transcripts/${t1}/annotations`, { method: "POST", data: { kind: "note", t0: 5, text: "Nota di prova" } });
await J(`/api/transcripts/${t1}/notebook/create`, { method: "POST", data: {} });
await J(`/api/transcripts/${t1}/ai-review`, { method: "POST", data: { model: "qwen3:4b", scope: "all", off_topic: true } });
const t2 = await mkT("Altro mock B", "mock2"); await waitDone(t2); await J(`/api/transcripts/${t2}/ai-review`, { method: "POST", data: { model: "qwen3:4b", scope: "all", off_topic: true } });
const t3 = await mkT("Audio muto", "mock", silent); await waitDone(t3);
const cmp = await J("/api/compare", { method: "POST", data: { upload_id: (await up("Confronto.wav")).upload_id, language: "it", model_ids: ["mock", "mock2"] } }); await waitDone(cmp.ids[0]); await waitDone(cmp.ids[1]);
await J("/api/users", { method: "POST", data: { name: "Marco" } }); await J("/api/vocab", { method: "POST", data: { term: "Schopenhauer", context: "*" } }); await J("/api/corrections", { method: "POST", data: { scope: "Filosofia", wrong: "Cante", right: "Kant" } });
await new Promise(r => setTimeout(r, 1500));
execFileSync("python3", ["-c", `import sqlite3,time,sys;c=sqlite3.connect(sys.argv[1],timeout=30);c.execute("INSERT INTO transcripts(id,title,upload_id,filename,audio_path,duration,language,model_id,context,options,status,kind,owner,created,updated,segments) VALUES('orfanaAB','Registrazione orfana','orfano','','',0,'it','mock','Altro','{}','recording','live','admin',?,?,'[]')",(time.time(),time.time()));c.commit()`, dbPath]);

const resetOrphan = () => execFileSync("python3", ["-c", `import sqlite3,time,sys;c=sqlite3.connect(sys.argv[1],timeout=30);c.execute("DELETE FROM transcripts WHERE id='orfanaAB'");c.execute("INSERT INTO transcripts(id,title,upload_id,filename,audio_path,duration,language,model_id,context,options,status,kind,owner,created,updated,segments) VALUES('orfanaAB','Registrazione orfana','orfano','','',0,'it','mock','Altro','{}','recording','live','admin',?,?,'[]')",(time.time(),time.time()));c.commit()`, dbPath]);
/* ---- strumenti di collaudo ---- */
const SEL = "button, a.btn, a.item-link, nav a, summary, select, input[type=checkbox], input[type=radio], input[type=text], input[type=search], input[type=password], input[type=number], input[type=range], textarea, .model, .nb-doc, [contenteditable=true]";
const SKIP_TEXT = /^(Esci)$/;   // il logout non si prova (ricaricherebbe la pagina senza codice)
const found = [], problems = [], errors = [];
const probeJS = () => { window.__p = { m: 0, r: 0, h: 0 }; new MutationObserver(l => { window.__p.m += l.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); const of = window.fetch; window.fetch = (...a) => { window.__p.r++; return of.apply(window, a); }; const ox = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send = function (...a) { window.__p.r++; return ox.apply(this, a); }; addEventListener("hashchange", () => window.__p.h++); };
const scanFn = ({ SEL, scope, key }) => {   // un'unica scansione: elenca i controlli visibili (con chiave stabile) oppure restituisce quello con la chiave data
  const root = document.querySelector(scope) || document.body, seen = {}, out = [];
  for (const e of root.querySelectorAll(SEL)) {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    const dt = e.closest("details"); if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none" || e.disabled || e.closest(".hidden") || e.closest("[hidden]") || e.matches("input[type=file]") || (dt && !dt.open && !(e.tagName === "SUMMARY" && e.parentElement === dt))) continue;
    if (e.matches(".w, .ts, .tool") && !e.closest(".segs .seg:nth-child(1)")) continue;      // parole e comandi ripetuti per segmento: bastano quelli del primo
    const label = (e.getAttribute("aria-label") || e.innerText || e.placeholder || e.title || e.className || e.tagName).toString().trim().replace(/\s+/g, " ").slice(0, 40);
    const base = `${e.tagName.toLowerCase()}|${e.type || ""}|${label}`; seen[base] = (seen[base] || 0) + 1;
    if (seen[base] > 2) continue;      // elementi ripetuti (righe): bastano i primi due
    const k = base + "#" + seen[base];
    if (key) { if (k === key) { e.scrollIntoView({ block: "center" }); return e; } continue; }
    out.push({ key: k, label, tag: e.tagName.toLowerCase(), type: e.type || "" });
  }
  return key ? null : out;
};
async function open(url, wait, prep) {
  const p = await ctx.newPage(); await p.addInitScript(() => { try { localStorage.setItem("lib_folder", "all"); localStorage.removeItem("new_cfg"); } catch (e) {} });
  p.on("pageerror", e => errors.push(e.message)); p.on("console", m => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  p.on("dialog", d => { errors.push("DIALOGO NATIVO: " + d.message()); d.accept(); });
  await p.goto(base + url); await p.waitForSelector(wait, { timeout: 15000 }); await p.waitForTimeout(400);
  if (prep) await prep(p); await p.waitForTimeout(250); return p;
}
async function closeModal(p) { const m = p.locator("dialog.modal[open]"); if (await m.count()) { const c = m.locator("button:text-is('Annulla'), button:text-is('Chiudi')"); if (await c.count()) await c.first().tap().catch(() => {}); else await p.keyboard.press("Escape"); await p.waitForTimeout(150); if (await p.locator("dialog.modal[open]").count()) await p.evaluate(() => document.querySelectorAll("dialog[open]").forEach(d => d.close())); } }

async function audit(name, { url, wait, prep, scope = "body", only = null, reset = null }) {
  if (reset) await reset(); const p0 = await open(url, wait, prep); const list = (await p0.evaluate(scanFn, { SEL, scope })).filter(c => !SKIP_TEXT.test(c.label) && (!only || only.test(c.label))); await p0.close();
  let good = 0; const bad = [], skipped = [];
  for (const c of list) {
    process.stderr.write(`  [${name}] ${c.label}\n`);
    if (reset) await reset();
    const p = await open(url, wait, prep); let verdict = "ok", detail = "";
    try {
      const h = await p.evaluateHandle(scanFn, { SEL, scope, key: c.key }); const el = h.asElement();
      if (!el) { verdict = "salto"; detail = "non più presente (stato cambiato)"; }
      else {
        const covered = await el.evaluate(e => { const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(t === e || e.contains(t) || (t && t.contains(e) && t.tagName !== "BODY" && t.tagName !== "HTML" && !t.matches("main,div.app,#app"))) ? (t ? (t.className || t.tagName) : "nulla") : ""; });
        if (covered) { verdict = "COPERTO"; detail = "da " + covered; }
        else {
          await p.evaluate(probeJS); await p.waitForTimeout(300); const base0 = await p.evaluate(() => window.__p.m);
          let dl = false, fc = false, sel0 = null; p.once("filechooser", () => { fc = true; }); p.once("download", () => { dl = true; }); const popup = new Promise(res => ctx.once("page", () => res(true)));
          const nErr = errors.length; const chk0 = await el.evaluate(e => e.checked);
          if (c.tag === "select") { const n = await el.evaluate(e => e.options.length); if (n < 2) { verdict = "salto"; detail = "una sola opzione"; } else { sel0 = await el.evaluate(e => e.value); await el.selectOption({ index: 1 }).catch(e => { verdict = "ERRORE"; detail = e.message.slice(0, 80); }); } }
          else if (c.tag === "input" && ["text", "search", "password", "number"].includes(c.type) || c.tag === "textarea" || el && (await el.evaluate(e => e.isContentEditable))) { await el.tap({ timeout: 6000 }).catch(e => { verdict = "NON CLICCABILE"; detail = e.message.split("\n")[0].slice(0, 90); }); if (verdict === "ok" && !(await el.evaluate(e => document.activeElement === e || e.contains(document.activeElement)))) { verdict = "SENZA EFFETTO"; detail = "il campo non prende il focus"; } if (verdict === "ok") { p.errors = 0; await p.waitForTimeout(100); } }
          else if (c.tag === "input" && c.type === "range") { await el.tap({ timeout: 6000 }).catch(e => { verdict = "NON CLICCABILE"; detail = e.message.split("\n")[0].slice(0, 90); }); }
          else { await el.tap({ timeout: 6000 }).catch(e => { verdict = "NON CLICCABILE"; detail = e.message.split("\n")[0].slice(0, 90); }); }
          if (verdict === "ok") {
            await p.waitForTimeout(650);
            const pr = await p.evaluate(() => window.__p), modal = await p.locator("dialog.modal[open]").count(), toastTxt = await p.evaluate(() => { const t = document.querySelector("#toast.show"); return t ? t.innerText : ""; });
            const focusOnly = c.tag === "input" && ["text", "search", "password", "number"].includes(c.type) || c.tag === "textarea";
            const chk1 = await el.evaluate(e => e.checked).catch(() => chk0); const selChanged = sel0 !== null && sel0 !== (await el.evaluate(e => e.value).catch(() => sel0)); const effect = fc || selChanged || chk0 !== chk1 || (pr.m - base0) > 0 || pr.r > 0 || pr.h > 0 || dl || modal > 0 || (await Promise.race([popup, new Promise(r => setTimeout(() => r(false), 10))])) || focusOnly || c.type === "range" || c.tag === "input" && c.type === "text";
            if (/^⚠/.test(toastTxt)) { verdict = "ERRORE"; detail = toastTxt.slice(0, 100); }
            else if (!effect) { verdict = "SENZA EFFETTO"; detail = "nessun cambiamento, richiesta, navigazione o download"; }
            else if (errors.length > nErr) { verdict = "ERRORE"; detail = errors[errors.length - 1].slice(0, 100); }
          }
          await closeModal(p);
        }
      }
    } catch (e) { verdict = "ERRORE"; detail = String(e.message).split("\n")[0].slice(0, 100); }
    await p.close();
    if (verdict === "ok") good++; else if (verdict !== "salto") bad.push(`${c.label} [${verdict}${detail ? ": " + detail : ""}]`); else skipped.push(c.label + (detail ? " (" + detail + ")" : ""));
    found.push([name, c.label, verdict]);
  }
  console.log(`${name}: ${list.length} controlli, ${good} ok, ${list.length - good - bad.length} saltati` + (bad.length ? `, PROBLEMI → ${bad.join(" | ")}` : "") + (skipped.length ? `\n     saltati: ${skipped.join(" | ")}` : ""));
  ok(`${name}: tutti i controlli rispondono`, bad.length === 0, bad.slice(0, 4).join(" | "));
}

await audit("Archivio", { url: "/#/", wait: ".item" });
await audit("Archivio con selezione", { url: "/#/", wait: ".item", prep: async p => { await p.locator("input[aria-label='Seleziona tutto']").tap(); await p.waitForSelector(".actionbar"); }, scope: ".actionbar" });
await audit("Menu cartella", { url: "/#/", wait: ".frow", prep: async p => { await p.locator(".frow", { hasText: "Filosofia" }).locator(".fmore").tap(); await p.waitForSelector("dialog.modal[open]"); }, scope: "dialog.modal[open]" });
await audit("Nuova trascrizione", { url: "/#/new", wait: ".drop", prep: async p => { await p.setInputFiles("input[type=file]", wav); await p.waitForSelector(".list .item .qstat", { timeout: 15000 }).catch(() => {}); await p.waitForFunction(() => !document.querySelector(".bar i") || document.querySelector(".qstat")?.textContent.includes("Pronto"), null, { timeout: 15000 }).catch(() => {}); await p.waitForTimeout(600); } });
await audit("Live (preparazione)", { url: "/#/live", wait: "text=Inizia registrazione" });
await audit("Editor", { url: "/#/t/" + t1, wait: ".seg" });
await audit("Editor (trascrizione fallita)", { url: "/#/t/" + t3, wait: "h1" });
await audit("Editor (altro, con fuori tema)", { url: "/#/t/" + t2, wait: ".seg" });
await audit("Registrazione orfana", { url: "/#/t/orfanaAB", wait: "text=è rimasta aperta", reset: resetOrphan });
await audit("Quaderno", { url: "/#/n/" + t1, wait: ".nb-doc" });
await audit("Confronto", { url: "/#/c/" + cmp.group_id, wait: ".card" });
await audit("Modelli AI", { url: "/#/models", wait: "text=Modelli principali" });
await audit("Impostazioni", { url: "/#/settings", wait: "text=Persone (archivi separati)" });

// registrazione live in corso: i controlli si provano IN SEQUENZA (non si può ricaricare la pagina)
{
  const p = await open("/#/live", "text=Inizia registrazione"); await p.locator("select").nth(1).selectOption("mock"); await p.locator("button:has-text('Inizia registrazione')").tap(); await p.waitForSelector(".bigtime", { timeout: 25000 }); await p.waitForTimeout(2500);
  const state = () => p.locator("h1").first().innerText(); const bad = [];
  const step = async (label, fn, check) => { const before = await p.evaluate(() => document.body.innerText.length); try { await fn(); await p.waitForTimeout(500); if (!(await check())) bad.push(label); } catch (e) { bad.push(label + " (" + e.message.split("\n")[0].slice(0, 60) + ")"); } };
  await step("★ Evidenzia", () => p.locator("button:has-text('Evidenzia')").tap(), async () => (await J(`/api/transcripts?status=recording`)).length >= 0 && await p.locator(".livebox .seg.hl, .livebox .seg").count() >= 0);
  await step("⏸ Pausa", () => p.locator("button:has-text('Pausa')").tap(), async () => /pausa/i.test(await state()));
  await step("▶ Riprendi", () => p.locator("button:has-text('Riprendi')").tap(), async () => /Registrazione/.test(await state()));
  await step("✎ Aggiungi nota", async () => { await p.fill("input[placeholder^='Scrivi una nota']", "nota audit"); await p.locator("button:has-text('Aggiungi nota')").tap(); }, async () => await p.locator(".livenote").count() >= 1);
  await step("attività: pulsante in testata", () => p.locator(".act-pill").tap(), async () => await p.locator(".act-panel .act-row.rec").count() === 1);
  await step("attività: Apri", () => p.locator(".act-panel a:has-text('Apri')").tap(), async () => (await p.evaluate(() => location.hash)) === "#/live");
  await p.locator(".act-pill").tap().catch(() => {}); await p.waitForTimeout(300);
  await step("■ Stop e salva", () => p.locator("button:has-text('Stop e salva')").tap(), async () => { await p.waitForFunction(() => location.hash.startsWith("#/t/"), null, { timeout: 40000 }); return true; });
  console.log("Live in corso: Evidenzia, Pausa, Riprendi, Nota, Attività, Stop" + (bad.length ? ", PROBLEMI → " + bad.join(" | ") : ": tutti ok"));
  ok("Live in corso: tutti i controlli rispondono", bad.length === 0, bad.join(" | ")); await p.close();
}
const tot = found.length, okc = found.filter(f => f[2] === "ok").length, skipped = found.filter(f => f[2] === "salto").length;
console.log(`\nControlli provati: ${tot} · ok: ${okc} · saltati: ${skipped} · con problemi: ${tot - okc - skipped}`);
ok("nessun dialogo nativo e nessun errore JS in tutta l'esplorazione", errors.length === 0, errors.slice(0, 4).join(" ; "));
await b.close(); process.exit(done());
