"use strict";
/* Pannello "Correzione AI": propone correzioni (diff) e parti fuori tema; l'utente approva. Non cambia nulla da solo. */
function wordDiffNodes(oldT, newT) {
  const a = oldT.split(/\s+/).filter(Boolean), b = newT.split(/\s+/).filter(Boolean), n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push(a[i] + " "); i++; j++; }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { out.push(h("span", { class: "diff-ins" }, b[j]), " "); j++; }
    else { out.push(h("span", { class: "diff-del" }, a[i]), " "); i++; }
  }
  return out;
}
function nearestInstructions(fid) {
  const seen = new Set(); while (fid && !seen.has(fid)) { seen.add(fid); const f = LIB.folders.find(x => x.id === fid); if (!f) break; if (f.prefs && f.prefs.ai_instructions) return { text: f.prefs.ai_instructions, fid: f.id }; fid = f.parent_id; }
  return { text: "", fid: null };
}

async function buildAIPanel({ id, t, seekTo, reload }) {
  const [as, st] = await Promise.all([api(`/api/transcripts/${id}/ai-assessment`), api("/api/ai/status")]);
  let rv = (t.stats || {}).ai_review || null;
  const lvl = { consigliata: ["warn", "Correzione AI consigliata"], facoltativa: ["", "Correzione AI facoltativa"], "non necessaria": ["ok", "Probabilmente non serve la correzione AI"] }[as.level];
  const box = h("details", { class: "notice ai", open: as.level === "consigliata" || (rv && rv.status !== "done") || (rv && rv.items && rv.items.length > 0 && !rv.items.every(i => i.applied)) });
  const body = h("div");
  const installed = st.models.filter(m => !/embed/i.test(m));
  const fid = t.folder_id, ins0 = nearestInstructions(fid);
  const modelSel = h("select", null, installed.map(m => h("option", { value: m, selected: m.startsWith("qwen3:4b") }, m)));
  const scopeSel = h("select", null, h("option", { value: "flagged", selected: as.flagged > 0 }, `Solo i punti dubbi (${as.flagged})`), h("option", { value: "all", selected: as.flagged === 0 }, "Tutto il testo (più lento)"));
  const offCb = h("input", { type: "checkbox", checked: true }), memCb = h("input", { type: "checkbox", checked: true });
  const instr = h("textarea", { placeholder: "Es.: «Il professore chiama gli studenti per nome: non è contenuto della lezione. I termini di filosofia vanno scritti con la maiuscola come nel libro.»", style: "min-height:70px" }); instr.value = ins0.text;

  const start = async () => {
    try {
      if (memCb.checked && fid && instr.value.trim() !== ins0.text.trim()) { await api("/api/folders/" + (ins0.fid || fid), { method: "PATCH", json: { prefs: { ai_instructions: instr.value.trim() } } }); const f = LIB.folders.find(x => x.id === (ins0.fid || fid)); if (f) f.prefs = { ...(f.prefs || {}), ai_instructions: instr.value.trim() }; }
      await api(`/api/transcripts/${id}/ai-review`, { json: { model: modelSel.value, scope: scopeSel.value, instructions: instr.value.trim(), off_topic: offCb.checked } });
      rv = { status: "running", done: 0, total: 0, items: [] }; draw(); watch();
    } catch (e) { toast(e.message, 7000); }
  };
  const watch = () => { const iv = setInterval(async () => { try { const tt = await api("/api/transcripts/" + id); rv = (tt.stats || {}).ai_review; if (!rv || rv.status !== "running") { clearInterval(iv); draw(); } else draw(); } catch {} }, 1500); timers.push(iv); };

  function setupView() {
    return h("div", null,
      h("p", { class: "m" }, as.reasons.join(" ")),
      !st.reachable ? h("div", { class: "notice warn" }, "Ollama (il programma gratuito che esegue l'AI) non è in esecuzione su questo computer. ", h("a", { href: "#/settings" }, "Come installarlo →"))
        : !installed.length ? h("div", { class: "notice warn" }, "Nessun modello AI installato. ", h("a", { href: "#/settings" }, "Installa Qwen3 4B (2,6 GB, una volta sola) →"))
          : h("div", null,
            h("div", { class: "grid g2" }, h("div", null, h("label", null, "Modello"), modelSel), h("div", null, h("label", null, "Cosa controllare"), scopeSel)),
            h("label", { class: "opt" }, offCb, "Segnala anche le parti fuori tema (chiacchiere, rumori, frasi senza senso): le escludi tu"),
            h("label", { style: "margin-top:8px;display:block" }, "Istruzioni per l'AI su questa materia (facoltative)"), instr,
            fid && h("label", { class: "opt" }, memCb, "Ricorda queste istruzioni per tutta la cartella"),
            h("p", { class: "m" }, "L'AI usa materia, argomento, glossario, queste istruzioni e le correzioni che hai già approvato. Propone soltanto: tu approvi ogni modifica."),
            h("button", { class: "primary", onclick: start }, "✨ Controlla con l'AI")));
  }
  function runView() {
    const pct = rv.total ? 100 * rv.done / rv.total : 0;
    return h("div", null, h("div", { class: "bar" }, h("i", { style: `width:${Math.max(3, pct)}%` })), h("div", { class: "m" }, `Passaggio ${rv.done} di ${rv.total || "…"} · ${rv.model || ""}${rv.failed ? " · " + rv.failed + " non riusciti" : ""}`),
      h("button", { class: "small", onclick: () => api(`/api/transcripts/${id}/ai-review/cancel`, { method: "POST" }) }, "Ferma"));
  }
  function resultView() {
    const items = (rv.items || []).slice().sort((a, b) => a.start - b.start), edits = items.filter(i => !i.off_topic && !i.rejected && i.new !== i.old), offs = items.filter(i => i.off_topic), rej = items.filter(i => i.rejected);
    const picked = new Set(edits.filter(i => !i.applied).map(i => "e" + i.i)); const offPicked = new Set();
    const row = (it, kind) => {
      const key = (kind === "off" ? "o" : "e") + it.i, done = it.applied;
      const cb = h("input", { type: "checkbox", disabled: done, checked: kind === "off" ? false : !done, "aria-label": "Seleziona", onchange: e => { const set = kind === "off" ? offPicked : picked; e.target.checked ? set.add(kind === "off" ? it.i : key) : set.delete(kind === "off" ? it.i : key); } });
      if (kind === "off" && !done) { /* default non selezionato */ } else if (kind !== "off" && !done) picked.add(key);
      return h("div", { class: "aiitem" + (done ? " applied" : "") }, cb, h("button", { class: "ts", onclick: () => seekTo(it.start) }, "▶ " + fmtT(it.start)),
        h("div", { class: "grow" }, kind === "off" ? h("span", null, h("span", { class: "chip warn" }, "fuori tema"), " ", it.old) : wordDiffNodes(it.old, it.new), done && h("span", { class: "chip ok", style: "margin-left:6px" }, "applicata")));
    };
    const apply = async () => {
      const e = [...picked].map(k => +k.slice(1)), o = [...offPicked];
      if (!e.length && !o.length) { toast("Non hai selezionato nulla."); return; }
      const r = await api(`/api/transcripts/${id}/ai-review/apply`, { json: { edits: e, off_topic: o } }); toast(`Applicate ${r.edits} correzioni, escluse ${r.off_topic} parti. Le correzioni sono ricordate per le prossime trascrizioni.`, 6000); reload();
    };
    return h("div", null,
      h("p", { class: "m" }, `${edits.length} ${edits.length === 1 ? "correzione proposta" : "correzioni proposte"} · ${offs.length} fuori tema · ${rej.length} scartate dai controlli di sicurezza${rv.failed ? " · " + rv.failed + " passaggi non riusciti" : ""}. Il testo non è stato modificato.`),
      edits.length ? h("div", null, h("h3", null, "Correzioni"), h("div", { class: "aiitems" }, edits.map(i => row(i, "edit")))) : h("p", null, "✓ Nessuna correzione necessaria: il testo sembra già a posto."),
      offs.length ? h("div", null, h("h3", { style: "margin-top:12px" }, "Fuori tema (non selezionate: scegli tu cosa escludere)"), h("div", { class: "aiitems" }, offs.map(i => row(i, "off")))) : null,
      rej.length ? h("details", { style: "margin-top:10px" }, h("summary", null, `${rej.length} proposte scartate (mantenuto il testo originale)`), rej.map(i => h("div", { class: "m", style: "margin:4px 0" }, `${fmtT(i.start)} · ${i.rejected}: «${i.proposed || ""}»`))) : null,
      h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "primary", onclick: apply }, "Applica le selezionate"), h("button", { onclick: async () => { await api(`/api/transcripts/${id}/ai-review/discard`, { method: "POST" }); rv = null; draw(); } }, "Ignora e chiudi"),
        h("button", { onclick: () => { rv = null; draw(); } }, "Nuova revisione")));
  }
  function draw() { body.replaceChildren(!rv ? setupView() : rv.status === "running" ? runView() : rv.status === "error" ? h("div", { class: "notice bad" }, "Errore: " + rv.error, h("div", null, h("button", { class: "small", onclick: () => { rv = null; draw(); } }, "Riprova"))) : resultView()); }
  box.append(h("summary", null, h("span", { class: "chip " + lvl[0] }, lvl[1]), " ✨ Correzione con AI"), body); draw(); if (rv && rv.status === "running") watch();
  return box;
}

/* ---------- Correzione AI di più trascrizioni insieme (selezione multipla nell'Archivio) ----------
   Parte in coda sul server (una dopo l'altra), propone soltanto; poi si rivedono e si applicano tutte insieme le correzioni scelte. */
async function aiBatch(ids) {
  const st = await api("/api/ai/status"), installed = (st.models || []).filter(m => !/embed/i.test(m));
  if (!st.reachable || !installed.length) {
    await modal("✨ Correzione con AI", h("div", null, h("p", null, !st.reachable ? "Ollama (il programma gratuito che esegue l'AI) non è in esecuzione su questo computer." : "Nessun modello AI installato."),
      h("p", { class: "m" }, "Nel terminale del Codespace:  bash scripts/install_ollama.sh  e poi scarica Qwen3 4B da Impostazioni → Correzione con AI (una volta sola). ", h("a", { href: "#/settings", onclick: () => document.querySelector("dialog")?.close() }, "Vai alle impostazioni →"))));
    return;
  }
  const model = h("select", null, installed.map(m => h("option", { value: m, selected: m.startsWith("qwen3:4b") }, m)));
  const scope = h("select", null, h("option", { value: "flagged" }, "Solo i punti dubbi (più veloce)"), h("option", { value: "all" }, "Tutto il testo (più lento, più completo)"));
  const off = h("input", { type: "checkbox", checked: true });
  const instr = h("textarea", { placeholder: "Facoltative. Se le lasci vuote usa quelle della cartella di ogni trascrizione.", style: "min-height:70px" });
  const cfg = await modal(`✨ Correggi con AI ${ids.length} trascrizioni`, h("div", { class: "grid" },
    h("p", { class: "m" }, "L'AI controlla le trascrizioni una dopo l'altra (non insieme, per non sovraccaricare il computer) e PROPONE correzioni: non cambia nulla finché non approvi. Alla fine le rivedi e le applichi tutte con un clic."),
    h("div", null, h("label", null, "Modello"), model), h("div", null, h("label", null, "Cosa controllare"), scope),
    h("label", { class: "opt" }, off, "Segnala anche le parti fuori tema (le escludi tu)"), h("div", null, h("label", null, "Istruzioni per l'AI"), instr)),
    [["Annulla", null], [`✨ Avvia su ${ids.length}`, () => ({ model: model.value, scope: scope.value, off: off.checked, instr: instr.value.trim() }), "primary"]]);
  if (!cfg) return;
  let res;
  try { res = await api("/api/ai/review-batch", { json: { ids, model: cfg.model, scope: cfg.scope, instructions: cfg.instr, off_topic: cfg.off } }); }
  catch (e) { toast(e.message, 7000); return; }
  if (!res.started.length) { toast("Nessuna trascrizione da controllare: " + (res.skipped.map(s => `${s.title || s.id}: ${s.reason}`).join("; ") || "elenco vuoto"), 8000); return; }
  if (res.skipped.length) toast(`${res.skipped.length} saltate (${res.skipped.map(s => s.reason).filter((v, i, a) => a.indexOf(v) === i).join(", ")})`, 6000);
  aiBatchDialog(res.started);
}

function aiBatchDialog(ids) {
  const d = h("dialog", { class: "modal wide" }), body = h("div"), foot = h("div", { class: "row", style: "justify-content:flex-end;margin-top:14px" });
  d.append(h("h3", null, "✨ Correzione AI di " + ids.length + " trascrizioni"), body, foot); document.body.append(d); d.showModal();
  let iv = null, phase = "run", sel = new Map(), data = new Map(), closed = false;
  d.addEventListener("close", () => { closed = true; clearInterval(iv); d.remove(); });
  const chipFor = i => ({ none: ["", "—"], queued: ["", "In coda"], running: ["warn", `In corso ${i.done}/${i.total || "…"}`], done: ["ok", `✓ ${i.edits} ${i.edits === 1 ? "correzione" : "correzioni"} · ${i.off_topic} fuori tema`], cancelled: ["", "Fermata"], error: ["bad", "Errore"] }[i.status] || ["", i.status]);
  const drawRun = r => {
    const total = r.items.length, fin = r.items.filter(i => ["done", "error", "cancelled", "none"].includes(i.status)).length;
    body.replaceChildren(h("div", { class: "bar" }, h("i", { style: `width:${total ? Math.max(3, 100 * fin / total) : 3}%` })), h("p", { class: "m" }, `${fin} di ${total} completate. Puoi chiudere: le proposte restano salvate in ogni trascrizione e si rivedono dal suo pannello «Correzione con AI».`),
      h("div", { class: "list" }, r.items.map(i => { const [c, t] = chipFor(i); return h("div", { class: "item" }, h("div", { class: "grow t" }, i.title), h("span", { class: "chip " + c }, t), i.error && h("div", { class: "m err" }, i.error)); })));
    foot.replaceChildren(r.active ? h("button", { class: "danger", onclick: () => api("/api/ai/review-batch/cancel", { method: "POST" }).then(() => toast("Fermo dopo la trascrizione in corso…")) }, "Ferma") : null, h("button", { onclick: () => d.close() }, "Chiudi"));
  };
  const review = async r => {
    phase = "review"; const ok = r.items.filter(i => i.status === "done" && (i.edits || i.off_topic));
    if (!ok.length) { body.replaceChildren(h("p", null, "✓ Nessuna correzione proposta: i testi sembrano già a posto."), ...(r.items.some(i => i.status === "error") ? [h("p", { class: "err" }, "Alcune trascrizioni hanno dato errore: riprova.")] : [])); foot.replaceChildren(h("button", { onclick: () => d.close() }, "Chiudi")); return; }
    const full = await Promise.all(ok.map(i => api("/api/transcripts/" + i.id)));
    full.forEach(t => { const rv = (t.stats || {}).ai_review || { items: [] }, items = rv.items.slice().sort((a, b) => a.start - b.start); data.set(t.id, { t, edits: items.filter(x => !x.off_topic && !x.rejected && x.new !== x.old && !x.applied), offs: items.filter(x => x.off_topic && !x.applied) }); sel.set(t.id, { e: new Set(data.get(t.id).edits.map(x => x.i)), o: new Set() }); });
    const count = () => [...sel.values()].reduce((s, v) => s + v.e.size + v.o.size, 0);
    const applyB = h("button", { class: "primary" }), setApply = () => { const n = count(); applyB.textContent = n ? `Applica le ${n} selezionate` : "Nessuna selezionata"; applyB.disabled = !n; };
    const row = (tid, it, off) => { const set = off ? sel.get(tid).o : sel.get(tid).e; return h("div", { class: "aiitem" }, h("input", { type: "checkbox", checked: set.has(it.i), "aria-label": "Seleziona", onchange: e => { e.target.checked ? set.add(it.i) : set.delete(it.i); setApply(); } }), h("span", { class: "ts" }, fmtT(it.start)), h("div", { class: "grow" }, off ? h("span", null, h("span", { class: "chip warn" }, "fuori tema"), " ", it.old) : wordDiffNodes(it.old, it.new))); };
    const opened = new Set([...data.keys()].slice(0, 1));   // quali trascrizioni sono aperte (si ricordano quando si ridisegna)
    const paintReview = () => {
      body.replaceChildren(h("p", { class: "m" }, "Spunta ciò che vuoi applicare (le correzioni sono già selezionate, i «fuori tema» no). Il testo originale resta salvato. Le correzioni approvate vengono ricordate per le prossime trascrizioni."),
        h("div", { class: "row", style: "margin:6px 0" }, h("button", { class: "small", onclick: () => { sel.forEach((v, k) => { v.e = new Set(data.get(k).edits.map(x => x.i)); }); paintReview(); } }, "Seleziona tutte le correzioni"), h("button", { class: "small", onclick: () => { sel.forEach(v => { v.e.clear(); v.o.clear(); }); paintReview(); } }, "Deseleziona tutto")),
        h("div", null, [...data.values()].map(({ t, edits, offs }) => { const det = h("details", { style: "margin:8px 0", ontoggle: () => { det.open ? opened.add(t.id) : opened.delete(t.id); } }, h("summary", null, h("b", null, t.title), h("span", { class: "chip", style: "margin-left:8px" }, `${edits.length} correzioni · ${offs.length} fuori tema`)),
          h("div", { class: "aiitems" }, edits.map(x => row(t.id, x, false)), offs.map(x => row(t.id, x, true)))); if (opened.has(t.id)) det.open = true; return det; })));
      setApply();
    };
    applyB.onclick = async () => {
      applyB.disabled = true;
      try { const out = await api("/api/ai/apply-batch", { json: { items: [...sel].map(([id, v]) => ({ id, edits: [...v.e], off_topic: [...v.o] })).filter(x => x.edits.length || x.off_topic.length) } }); toast(`Applicate ${out.edits} correzioni in ${out.transcripts} trascrizioni, escluse ${out.off_topic} parti.`, 6000); d.close(); if (typeof loadLib === "function") loadLib(true); }
      catch (e) { toast(e.message, 7000); applyB.disabled = false; }
    };
    foot.replaceChildren(applyB, h("button", { onclick: async () => { for (const i of ok) await api(`/api/transcripts/${i.id}/ai-review/discard`, { method: "POST" }).catch(() => {}); toast("Proposte scartate"); d.close(); } }, "Scarta tutte"), h("button", { onclick: () => d.close() }, "Chiudi"));
    paintReview();
  };
  const tick = async () => {
    if (closed || phase !== "run") return;
    try { const r = await api("/api/ai/review-status", { json: { ids } }); drawRun(r); if (!r.active && r.items.every(i => ["done", "error", "cancelled", "none"].includes(i.status))) { clearInterval(iv); await review(r); } } catch (e) { /* rete: riprova al prossimo giro */ }
  };
  iv = setInterval(tick, 1500); tick();
}
