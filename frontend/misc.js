"use strict";
/* Confronto modelli, gestione modelli AI, impostazioni. */

/* ---------- Confronto ---------- */
ROUTES.push([/^#\/c\/(\w+)$/, async gid => {
  const box = h("div"); $app.replaceChildren(h("h1", null, "Confronta modelli"), box);
  let pair = 0, c;
  const audioEl = h("audio", { controls: true, style: "width:100%;position:sticky;top:64px;z-index:5;margin:14px 0" });
  async function load() {
    c = await api("/api/compare/" + gid); if (!audioEl.src) audioEl.src = withTok(`/api/transcripts/${c.items[0].id}/audio`);
    draw(); if (c.items.every(i => ["done", "failed", "cancelled"].includes(i.status))) timers.forEach(clearInterval);
  }
  function draw() {
    const name = id => mname(c.items.find(i => i.id === id).model_id);
    const stats = h("div", { class: "grid g3" }, c.items.map(i => h("div", { class: "card" }, h("h3", null, mname(i.model_id)),
      i.status === "done" ? h("dl", { class: "dl" }, h("dt", null, "Tempo"), h("dd", null, fmtT(i.stats.elapsed_s) + ` (${i.stats.elapsed_s}s)`), h("dt", null, "Velocità"), h("dd", null, speedText(i.stats.realtime_factor)),
        h("dt", null, "Parole"), h("dd", null, i.word_count), h("dt", null, "RAM di picco"), h("dd", null, i.stats.peak_rss_mb + " MB"), h("dt", null, "Timestamp"), h("dd", null, i.has_word_ts ? "parola" : "segmento"))
        : i.status === "failed" ? h("p", { class: "err" }, i.error) : h("div", null, h("span", { class: "spin" }), ` ${(STATUS[i.status] || [i.status])[0]} ${i.chunks_total ? i.chunks_done + "/" + i.chunks_total : ""}`),
      h("div", { class: "row", style: "margin-top:8px" }, h("a", { class: "btn small", href: "#/t/" + i.id }, "Apri nell'editor")))));
    const parts = [stats, audioEl];
    if (c.diffs.length) {
      const d = c.diffs[Math.min(pair, c.diffs.length - 1)];
      const sel = h("select", { onchange: e => { pair = +e.target.value; draw(); } }, c.diffs.map((x, k) => h("option", { value: k, selected: k === pair }, `${name(x.a)}  ↔  ${name(x.b)}`)));
      parts.push(h("h2", null, "Differenze"), h("div", { class: "row" }, sel, h("span", { class: "chip" }, `${d.summary.differences} punti di divergenza`)), h("div", { class: "notice", style: "margin:10px 0" }, c.note),
        h("div", { class: "cmp", style: "font-weight:600" }, h("div", null, "Tempo"), h("div", null, name(d.a)), h("div", null, name(d.b)), ""),
        d.blocks.slice(0, 400).map(b => h("div", { class: "cmp" }, h("div", { class: "m" }, fmtT(b.t_a)), h("div", null, b.a ? h("span", { class: "diff-del" }, b.a) : h("i", { class: "m" }, "(assente)")), h("div", null, b.b ? h("span", { class: "diff-ins" }, b.b) : h("i", { class: "m" }, "(assente)")),
          h("button", { class: "small icon-btn", title: "Ascolta", onclick: () => { audioEl.currentTime = Math.max(0, b.t_a - 1); audioEl.play(); } }, "▶"))),
        d.blocks.length > 400 && h("p", { class: "m" }, `Mostrate le prime 400 di ${d.blocks.length} differenze.`));
    }
    const refTa = h("textarea", { placeholder: "Trascrizione di riferimento verificata (facoltativo)…" }), werOut = h("div", { class: "m" });
    parts.push(h("details", { style: "margin-top:20px" }, h("summary", null, "WER reale (solo con riferimento verificato)"), refTa,
      h("button", { onclick: async () => { werOut.replaceChildren(...await Promise.all(c.items.filter(i => i.status === "done").map(async i => { try { const r = await api(`/api/transcripts/${i.id}/wer`, { json: { reference: refTa.value } }); return h("div", null, `${mname(i.model_id)}: WER ${(r.wer * 100).toFixed(1)}% (${r.edits} errori / ${r.ref_words} parole)`); } catch (e) { return h("div", { class: "err" }, e.message); } }))); } }, "Calcola WER"), werOut));
    box.replaceChildren(...parts.flat().filter(Boolean));
  }
  await load(); poll(() => load().catch(() => {}), 2000);
}]);

/* ---------- Modelli AI ---------- */
ROUTES.push([/^#\/models$/, async () => {
  const box = h("div"); $app.replaceChildren(h("h1", null, "Modelli AI"), h("p", { class: "sub" }, "I pesi si scaricano solo quando premi “Installa”, da GitHub (nessun account, nessun token, nessun Hugging Face). Un solo runtime per tutti: sherpa-onnx."), box);
  const card = m => {
    const ins = m.install || {}, dl = ["downloading", "starting", "extracting"].includes(ins.state), pct = ins.total ? Math.min(100, 100 * (ins.downloaded || 0) / ins.total) : 0;
    return h("div", { class: "card" }, h("div", { class: "row sp" }, h("h3", null, m.name), m.installed ? h("span", { class: "chip ok" }, "Installato · " + fmtB(m.disk_bytes)) : h("span", { class: "chip" }, "Non installato · " + fmtB(m.download_bytes))),
      h("p", { class: "m" }, `${m.runtime} · ${m.params} parametri · lingue: ${m.languages.join(", ")} · RAM ≥ ${m.min_ram_gb} GB`),
      m.measured_rtf != null || m.reference ? h("p", { class: "m" }, m.measured_rtf != null ? h("span", null, h("b", null, "Sul tuo PC: "), speedText(m.measured_rtf), " · ") : null, m.reference ? "Riferimento (4 core CPU): " + speedText(m.reference.rtf) : null) : null,
      !m.compatible && h("div", { class: "notice warn" }, "Non compatibile con questo hardware: " + m.incompatible_reason),
      h("details", null, h("summary", null, "Note, licenza e stato di verifica"), h("p", null, m.notes), h("p", null, h("b", null, "Verifica: "), m.verification || "—"), h("p", null, "Licenza: " + m.license), h("p", null, "Origine: ", h("code", null, m.sources?.[0]?.url?.split("/").pop() || m.upstream))),
      dl && h("div", null, h("div", { class: "bar" }, h("i", { style: `width:${pct}%` })), h("div", { class: "m" }, ins.state === "extracting" ? "Estrazione…" : ins.total ? `${fmtB(ins.downloaded || 0)} / ${fmtB(ins.total)}` : "Preparazione…")),
      ins.state === "error" && h("div", { class: "notice bad" }, ins.error),
      h("div", { class: "row", style: "margin-top:10px" },
        !m.installed && !dl && h("button", { class: "primary", disabled: !m.compatible, onclick: async () => { if (confirm(`Scaricare ${m.name} (${fmtB(m.download_bytes)})?`)) { try { await api(`/api/models/${m.id}/install`, { method: "POST" }); load(); } catch (e) { toast(e.message); } } } }, "Installa"),
        dl && h("button", { onclick: async () => { await api(`/api/models/${m.id}/cancel`, { method: "POST" }); load(); } }, "Annulla download"),
        m.installed && h("button", { class: "danger", onclick: async () => { if (confirm("Eliminare i pesi di " + m.name + "?")) { try { await api("/api/models/" + m.id, { method: "DELETE" }); load(); } catch (e) { toast(e.message); } } } }, "Elimina pesi")));
  };
  async function load() {
    const [r, sys] = await Promise.all([api("/api/models/all"), api("/api/system")]);
    const by = t => r.models.filter(m => m.tier === t);
    box.replaceChildren(h("div", { class: "notice" }, `Spazio occupato dai modelli: ${fmtB(r.total_disk_bytes)} · spazio libero: ${sys.disk_free_gb} GB`),
      h("h2", null, "Modelli principali (tre per lingua)"), h("div", { class: "grid g2" }, by("main").map(card)),
      h("h2", null, "Modelli veloci (meno accurati)"), h("div", { class: "grid g2" }, by("fast").map(card)),
      h("h2", null, "Componenti"), h("div", { class: "grid g2" }, by("component").map(card)));
  }
  await load(); poll(() => load().catch(() => {}), 2500);
}]);

/* ---------- Impostazioni ---------- */
ROUTES.push([/^#\/settings$/, async () => {
  const sys = await api("/api/system"), v = await api("/api/vocab");
  const dev = h("select", { onchange: async e => { await api("/api/settings", { method: "PUT", json: { device: e.target.value } }); toast("Dispositivo aggiornato"); } },
    [["auto", "Automatico (GPU se presente)"], ["cpu", "CPU"], ["cuda", "GPU NVIDIA (CUDA)"]].map(([k, l]) => h("option", { value: k, selected: sys.settings.device === k }, l)));
  const par = h("select", { onchange: async e => { await api("/api/settings", { method: "PUT", json: { parallel: +e.target.value } }); toast("Salvato"); } }, [1, 2, 3, 4].map(n => h("option", { value: n, selected: sys.settings.parallel === n }, n === 1 ? "1 (una alla volta)" : `${n} insieme`)));
  const thr = h("input", { type: "range", min: 0.3, max: 0.9, step: 0.05, value: sys.settings.diar_threshold, onchange: async e => { await api("/api/settings", { method: "PUT", json: { diar_threshold: +e.target.value } }); thrLbl.textContent = (+e.target.value).toFixed(2); toast("Salvato"); } });
  const thrLbl = h("b", null, (+sys.settings.diar_threshold).toFixed(2));
  const term = h("input", { type: "text", placeholder: "Nuovo termine (es. Schopenhauer, mitocondrio)" }), ctx = h("select", null, h("option", { value: "*" }, "Tutti i contesti"), v.contexts.map(c => h("option", null, c))), vbox = h("div");
  const drawV = list => vbox.replaceChildren(list.length ? h("div", { class: "list" }, list.map(x => h("div", { class: "item" }, h("span", { class: "grow" }, x.term), h("span", { class: "chip" }, x.context === "*" ? "tutti" : x.context), h("button", { class: "small danger", onclick: async () => { await api("/api/vocab/" + x.id, { method: "DELETE" }); drawV((await api("/api/vocab")).custom); } }, "Rimuovi")))) : h("p", { class: "m" }, "Nessun termine personalizzato."));
  drawV(v.custom);
  const nstate = h("span", { class: "m" }), upN = () => nstate.textContent = Notif.supported() ? { granted: "attive ✓", denied: "bloccate dal browser (riattivale dalle impostazioni del sito)", default: "non ancora attivate" }[Notif.perm()] : "non supportate da questo browser";
  upN();
  const tok = h("input", { type: "password", value: token(), placeholder: "Token di accesso (se il server è protetto)", onchange: e => { LS.set("studio_token", e.target.value.trim()); toast("Token salvato"); } });
  $app.replaceChildren(h("h1", null, "Impostazioni"),
    h("h2", null, "Elaborazione"), h("div", { class: "grid g2" }, h("div", null, h("label", null, "Dispositivo di inferenza"), dev), h("div", null, h("label", null, "Trascrizioni in parallelo"), par, h("div", { class: "m" }, "Più lavori insieme condividono la stessa CPU: la velocità totale non aumenta molto, ma i file procedono tutti insieme. Con modelli diversi serve più RAM (l'app attende se non basta)."))),
    h("p", { class: "m" }, `CPU: ${sys.hardware.cpu_threads} thread · RAM ${sys.hardware.ram_gb} GB · GPU: ${sys.hardware.gpus.map(g => g.name + " " + g.vram_gb + "GB").join(", ") || "nessuna rilevata"}`),
    h("h2", null, "Riconoscimento parlanti"), h("label", null, "Sensibilità nel distinguere le voci: ", thrLbl), thr, h("div", { class: "m" }, "Più bassa = distingue più voci (rischio: divide la stessa persona in due). Più alta = ne unisce di più (rischio: fonde insegnante e compagni). 0,50 ha funzionato bene sul campione di prova; puoi indicare il numero di voci quando avvii una trascrizione."),
    h("h2", null, "Notifiche"), h("div", { class: "row" }, h("button", { onclick: async () => { await Notif.ask(); upN(); if (Notif.perm() === "granted") Notif.show("Notifiche attive", "Riceverai avvisi di avanzamento e completamento.", { tag: "test" }); } }, "Attiva notifiche"), nstate),
    h("p", { class: "m" }, "Le notifiche arrivano finché la pagina è aperta (anche in secondo piano). A app completamente chiusa il sistema non le consegna: la trascrizione però continua sul server e la trovi nell'archivio."),
    h("h2", null, "Vocabolario personalizzato"), h("div", { class: "row" }, h("div", { class: "grow" }, term), ctx, h("button", { class: "primary", onclick: async () => { if (!term.value.trim()) return; await api("/api/vocab", { json: { term: term.value, context: ctx.value } }); term.value = ""; drawV((await api("/api/vocab")).custom); } }, "Aggiungi")),
    h("p", { class: "m" }, "Usato per i suggerimenti di correzione nell'editor (parole molto simili a un tuo termine): li applichi tu con un clic, nessuna sostituzione automatica."), vbox,
    h("h2", null, "Accesso"), tok,
    h("h2", null, "Sistema"), h("div", { class: "notice" }, `Dati in: ${sys.data_dir} · FFmpeg: ${sys.ffmpeg ? "ok" : "MANCANTE"} · LLM locali (Ollama): ${sys.llm_models.join(", ") || "nessuno"} · Riconoscimento parlanti: ${sys.diarization.available ? "installato" : sys.diarization.reason}`));
}]);
