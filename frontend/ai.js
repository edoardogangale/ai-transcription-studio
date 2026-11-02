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
