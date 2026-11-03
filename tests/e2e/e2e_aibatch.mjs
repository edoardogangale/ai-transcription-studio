// Correzione AI di più trascrizioni insieme (finto Ollama): selezione multipla → ✨ Correggi con AI → coda → revisione → applica insieme.
// Server: STUDIO_ENABLE_MOCK=1 OLLAMA_URL=http://127.0.0.1:11556 ; finto Ollama: python fake_ollama.py 11556
import { chromium, reporter } from "./lib.mjs";
import fs from "fs";
const [base, wav] = process.argv.slice(2); const { ok, done } = reporter();
const J = async (path, o) => (await fetch(base + path, o)).json();
const ids = [];
for (let i = 0; i < 3; i++) {
  const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(wav)], { type: "audio/wav" }), `lezione${i}.wav`);
  const up = await J("/api/upload", { method: "POST", body: fd });
  const r = await J("/api/transcripts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ upload_id: up.upload_id, language: "it", model_id: "mock", force: true, title: "Lezione " + (i + 1) }) });
  ids.push(r.id);
}
for (const id of ids) for (let k = 0; k < 120; k++) { const t = await J("/api/transcripts/" + id); if (t.status === "done") break; await new Promise(r => setTimeout(r, 500)); }
const txt = async id => (await J("/api/transcripts/" + id)).segments.map(s => s.text).join(" ");
const before = await Promise.all(ids.map(txt)); ok("3 trascrizioni pronte, con testo da correggere", before.every(t => /parola0/.test(t)));
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1366, height: 1000 } })).newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("dialog", d => { errs.push("dialog"); d.dismiss(); });
await p.goto(base + "/#/"); await p.waitForSelector("text=Lezione 1");
ok("senza selezione non c'è il pulsante", await p.locator("text=✨ Correggi con AI").count() === 0);
await p.click("text=Seleziona tutto"); await p.waitForSelector("text=✨ Correggi con AI"); ok("con più trascrizioni selezionate compare «✨ Correggi con AI»", true);
await p.click("text=✨ Correggi con AI"); await p.waitForSelector("dialog >> text=Avvia su 3"); ok("finestra di avvio: modello, ambito, istruzioni", await p.locator("dialog select").count() === 2 && await p.locator("dialog textarea").count() === 1);
await p.selectOption("dialog select >> nth=1", "all"); await p.click("dialog >> text=Avvia su 3");
await p.waitForSelector("dialog >> text=Applica le", { timeout: 60000 }); ok("tutte e 3 elaborate in coda e passate alla revisione", await p.locator("dialog details").count() === 3);
ok("il testo NON è cambiato da solo", (await Promise.all(ids.map(txt))).every((t, i) => t === before[i]));
ok("le correzioni sono già spuntate, il pulsante dice quante", /Applica le \d+ selezionate/.test(await p.locator("dialog button.primary").innerText()));
await p.click("dialog >> text=Deseleziona tutto"); ok("«Deseleziona tutto» disattiva Applica", await p.locator("dialog button.primary").isDisabled());
await p.click("dialog >> text=Seleziona tutte le correzioni");
await p.locator("dialog details", { hasText: "Lezione 3" }).evaluate(d => { d.open = true; d.querySelectorAll("input[type=checkbox]").forEach(c => c.click()); });   // «Lezione 3» la escludo
const n = +(/\d+/.exec(await p.locator("dialog button.primary").innerText())[0]); ok("escludendo una trascrizione il conteggio scende", n > 0);
await p.click("dialog button.primary"); await p.waitForSelector("dialog", { state: "detached", timeout: 20000 });
const after = await Promise.all(ids.map(txt));
ok("applicate le correzioni delle prime due insieme (parola0 → Parola0)", after[0] !== before[0] && after[1] !== before[1] && /Parola0/.test(after[0]) && /Parola0/.test(after[1]), after.map(a => a.slice(0, 40)).join(" / "));
ok("la terza, esclusa, è rimasta com'era", after[2] === before[2]);
ok("nessun errore JS / dialogo nativo", errs.length === 0, errs.join(" | "));
await b.close(); process.exit(done());
