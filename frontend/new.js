"use strict";
/* Nuova trascrizione: più file insieme, upload in parallelo con avvio automatico, modelli (3 + 2 veloci), parlanti. */
function speedText(rtf) {
  if (rtf == null) return null;
  return rtf < 1 ? `${(1 / rtf).toFixed(rtf < 0.2 ? 0 : 1)}× più veloce del tempo reale` : `${rtf.toFixed(1)}× PIÙ LENTO del tempo reale (una lezione di 2 h ≈ ${(2 * rtf).toFixed(1).replace(".", ",")} h)`;
}
function modelCard(m, rec, selected, onPick) {
  const usable = m.compatible && m.installed;
  const bench = m.benchmark ? h("span", null, m.benchmark.text + " ", h("a", { href: m.benchmark.url, target: "_blank", rel: "noopener", onclick: e => e.stopPropagation() }, "fonte")) : "nessun benchmark pubblico verificato";
  const ref = m.reference;
  const req = [`RAM ≥ ${m.min_ram_gb} GB`, m.min_vram_gb ? `VRAM ≥ ${m.min_vram_gb} GB` : null, m.gpu ? "CPU o GPU" : "solo CPU"].filter(Boolean).join(" · ");
  const mine = m.measured_rtf != null ? h("div", null, h("b", null, "Sul tuo PC: "), speedText(m.measured_rtf)) : null;
  return h("div", { class: "card model " + (selected ? "sel " : "") + (usable ? "" : "off"), tabindex: 0, onclick: () => onPick(m, usable), onkeydown: e => { if (e.key === "Enter") onPick(m, usable); } },
    h("div", { class: "row sp" }, h("h3", null, m.name), m.id === rec.id && h("span", { class: "chip rec", title: rec.why }, "Consigliato")),
    h("dl", null,
      h("dt", null, "Download"), h("dd", null, fmtB(m.download_bytes) + (m.installed ? ` · ${fmtB(m.disk_bytes)} su disco` : "")),
      h("dt", null, "Requisiti"), h("dd", null, req),
      h("dt", null, "Accuratezza"), h("dd", null, bench, ref && h("div", { class: "m" }, `Prova interna (italiano sintetico, 95 parole): WER ${String(ref.wer).replace(".", ",")}% — solo indicativo`)),
      h("dt", null, "Velocità"), h("dd", null, mine || (ref ? h("span", null, "Riferimento (4 core CPU): ", speedText(ref.rtf)) : "non ancora misurata"), mine && ref && h("div", { class: "m" }, "Riferimento (4 core CPU): " + speedText(ref.rtf))),
      h("dt", null, "Timestamp"), h("dd", null, m.word_timestamps ? "per parola" : "per segmento (finestre ~18 s)"),
      h("dt", null, "Stato"), h("dd", null, !m.compatible ? h("span", { class: "err" }, "Non compatibile: " + m.incompatible_reason) : m.installed ? h("span", { class: "chip ok" }, "Installato") : h("span", { class: "chip warn" }, "Non installato"))),
    !m.installed && m.compatible && h("button", { class: "small", onclick: async e => { e.stopPropagation(); if (confirm(`Scaricare ${m.name} (${fmtB(m.download_bytes)})?`)) { await api(`/api/models/${m.id}/install`, { method: "POST" }); ACT.open = true; pollActivity(); toast("Download avviato: lo vedi nel centro attività"); } } }, `⬇ Installa (${fmtB(m.download_bytes)})`),
    h("details", { onclick: e => e.stopPropagation() }, h("summary", null, "Note e verifica"), h("p", null, m.notes), h("p", null, h("b", null, "Verifica: "), m.verification || "—"), h("p", null, "Licenza: " + m.license)),
    h("button", { class: selected ? "primary" : "", disabled: !usable }, selected ? "Selezionato ✓" : "Seleziona"));
}

ROUTES.push([/^#\/new$/, async () => {
  const [sys, fl] = await Promise.all([api("/api/system"), api("/api/folders")]);
  LIB.folders = fl.folders; const hw = sys.hardware;
  CFG.compare = false;
  const fileInput = h("input", { type: "file", multiple: true, accept: "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.webm,.mp4", hidden: true, onchange: e => { Uploads.add([...e.target.files]); e.target.value = ""; } });
  const drop = h("div", { class: "drop" }, h("div", { style: "font-size:34px" }, "⬆"), h("p", null, "Trascina qui uno o più file audio (MP3, WAV, M4A, AAC, FLAC, OGG…)"),
    h("div", { class: "row", style: "justify-content:center" }, h("button", { onclick: () => fileInput.click() }, "Scegli file"), h("a", { class: "btn", href: "#/live" }, "● Registra con trascrizione live")), fileInput);
  ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => e.dataTransfer.files.length && Uploads.add([...e.dataTransfer.files]));

  const queue = h("div", { class: "list", style: "margin-top:12px" });
  const drawQueue = () => queue.replaceChildren(UP.items.map(u => h("div", { class: "item" }, h("span", null, u.state === "done" ? "✓" : u.state === "error" ? "⚠" : "♪"),
    h("div", { class: "grow" }, h("div", { class: "t" }, u.name), u.state === "uploading" ? h("div", { class: "bar" }, h("i", { style: `width:${u.pct}%` })) : null,
      h("div", { class: "m" + (u.state === "error" ? " err" : "") }, u.meta ? `Durata ${fmtT(u.meta.duration)} · ${fmtB(u.meta.size)} · ${u.meta.codec}` : fmtB(u.size)),
      h("div", { class: "m" }, { queued: "In attesa di caricamento", uploading: `Caricamento ${Math.round(u.pct)}%`, ready: "Pronto: scegli un modello e premi Avvia", done: u.queued ? "In trascrizione ✓" : "Caricato", error: u.error }[u.state])),
    (u.state === "done" && u.tid) ? h("a", { class: "btn small", href: "#/t/" + u.tid }, "Apri") : null,
    u.state !== "done" ? h("button", { class: "small", onclick: () => Uploads.cancel(u.id) }, "✕") : null)));
  UP.listeners.add(drawQueue); const unlisten = new MutationObserver((_, o) => { if (!queue.isConnected) { UP.listeners.delete(drawQueue); o.disconnect(); } }); unlisten.observe($app, { childList: true });

  const ctxSel = h("select", { onchange: e => { CFG.context = e.target.value; saveCfg(); } }, sys.contexts.map(c => h("option", { value: c, selected: c === CFG.context }, c)));
  const folderSel = h("select", { onchange: e => { CFG.folder = e.target.value || null; applyFolderPrefs(); saveCfg(); } }, folderOptions().map(o => h("option", { value: o.id, selected: (o.id || null) === CFG.folder }, o.label)));
  const mkCb = (key, label, extra = {}) => h("label", { class: "opt" }, h("input", Object.assign({ type: "checkbox", checked: !!CFG[key], onchange: e => { CFG[key] = e.target.checked; saveCfg(); upd(); if (key === "diarize" || key === "teacher_only") drawDia(); } }, extra)), h("span", null, label));
  const diaOK = sys.diarization.available;
  const langBox = h("div", { class: "row" }), modelBox = h("div", { class: "grid g3" }), fastBox = h("div", { class: "grid g3" });
  const startBtn = h("button", { class: "primary", onclick: start }, "Avvia trascrizione"), hint = h("div", { class: "m" });
  const diaBox = h("div");
  let state = { models: null };

  function applyFolderPrefs() {   // "memoria" della cartella: riporta le ultime scelte fatte in quella cartella
    const f = LIB.folders.find(x => x.id === CFG.folder), p = f && f.prefs; if (!p || !p.model_id) return;
    if (p.language) CFG.lang = p.language; if (p.model_id) CFG.model = p.model_id; if (p.context) { CFG.context = p.context; ctxSel.value = p.context; }
    CFG.diarize = !!p.diarize; CFG.teacher_only = !!p.teacher_only; langs(); loadModels(); drawDia(); toast(`Impostazioni di «${f.name}» ripristinate`);
  }
  function langs() {
    langBox.replaceChildren([["it", "Italiano"], ["en", "Inglese"], ["auto", "Rilevamento automatico"]].map(([v, l]) =>
      h("label", { class: "opt" }, h("input", { type: "radio", name: "lang", checked: CFG.lang === v, onchange: () => { CFG.lang = v; CFG.model = null; saveCfg(); langs(); loadModels(); } }), l)));
  }
  function drawDia() {
    diaBox.replaceChildren(
      mkCb("diarize", "Riconosci chi parla (distingue l'insegnante dagli altri)", { disabled: !diaOK }),
      !diaOK && h("div", { class: "notice warn", style: "margin:4px 0 8px" }, "Componente non installato (33 MB, locale). ", h("button", { class: "small", onclick: async () => { await api("/api/models/diarization/install", { method: "POST" }); ACT.open = true; pollActivity(); toast("Download avviato"); } }, "⬇ Installa")),
      diaOK && (CFG.diarize || CFG.teacher_only) && h("div", { style: "margin-left:30px" },
        mkCb("teacher_only", "Trascrivi SOLO l'insegnante (salta commenti dei compagni: più veloce, ma l'audio saltato non verrà trascritto)"),
        h("label", { class: "m", style: "display:flex;gap:8px;align-items:center" }, "Numero di voci (facoltativo, aiuta se lo sai):", h("input", { type: "number", min: 1, max: 8, style: "width:80px", value: CFG.num_speakers, onchange: e => { CFG.num_speakers = e.target.value; saveCfg(); } }))));
  }
  async function loadModels() {
    const r = await api("/api/models?language=" + CFG.lang); state.models = r;
    if (CFG.model && ![...r.models, ...r.fast].some(m => m.id === CFG.model && m.compatible && m.installed)) CFG.model = null;
    draw();
  }
  function draw() {
    const r = state.models; if (!r) return; const rec = { id: r.recommended, why: r.recommended_reason };
    const sel = m => CFG.compare ? (CFG.multi || []).includes(m.id) : CFG.model === m.id;
    const pick = (m, usable) => { if (!usable) { toast(!m.compatible ? m.incompatible_reason : "Modello non installato: usa il pulsante Installa."); return; }
      if (CFG.compare) CFG.multi = (CFG.multi || []).includes(m.id) ? CFG.multi.filter(x => x !== m.id) : [...(CFG.multi || []), m.id].slice(0, 3); else { CFG.model = m.id; saveCfg(); Uploads.submitAllReady(); } draw(); upd(); };
    modelBox.replaceChildren(r.models.map(m => modelCard(m, rec, sel(m), pick)));
    fastBox.replaceChildren(r.fast.map(m => modelCard(m, rec, sel(m), pick)));
    hint.textContent = r.recommended_reason || ""; upd();
  }
  function upd() {
    const ready = UP.items.filter(u => u.state === "ready"), any = UP.items.some(u => u.meta);
    startBtn.textContent = CFG.compare ? "Avvia confronto" : ready.length > 1 ? `Avvia ${ready.length} trascrizioni` : "Avvia trascrizione";
    startBtn.disabled = CFG.compare ? !(any && (CFG.multi || []).length >= 2) : !(ready.length && CFG.model);
  }
  async function start() {
    startBtn.disabled = true;
    try {
      if (CFG.compare) {
        const u = UP.items.find(x => x.meta && x.state !== "error"); const body = { ...Uploads.body(u), model_ids: CFG.multi };
        const r = await api("/api/compare", { json: body }); u.queued = true; u.state = "done"; notifyUI(); Notif.ask(); location.hash = "#/c/" + r.group_id;
      } else { await Uploads.submitAllReady(); Notif.ask(); location.hash = "#/"; }
    } catch (e) { toast(e.message, 6000); upd(); }
  }
  UP.listeners.add(upd);

  $app.replaceChildren(h("h1", null, "Nuova trascrizione"),
    h("p", { class: "sub" }, `Hardware: ${hw.cpu_threads} thread CPU · ${hw.ram_gb} GB RAM · ${hw.gpus.length ? hw.gpus.map(g => g.name + " " + g.vram_gb + " GB").join(", ") : "nessuna GPU NVIDIA"} · fino a ${ACT.parallel || sys.settings.parallel} trascrizioni in parallelo`),
    !sys.ffmpeg && h("div", { class: "notice bad" }, "FFmpeg non trovato: installalo per elaborare l'audio."),
    drop, queue,
    h("label", { class: "opt", style: "margin-top:10px" }, h("input", { type: "checkbox", checked: CFG.autostart, onchange: e => { CFG.autostart = e.target.checked; saveCfg(); } }), h("span", null, "Avvia ogni trascrizione appena il file è caricato (si trascrive mentre gli altri file sono ancora in caricamento)")),
    h("div", { class: "grid g2" }, h("div", null, h("h2", null, "Lingua"), langBox),
      h("div", null, h("h2", null, "Salva in"), folderSel, h("div", { class: "m" }, "Le scelte fatte vengono ricordate per ogni cartella."))),
    h("h2", null, "Contesto e opzioni"),
    h("div", { class: "grid g2" }, h("div", null, h("label", null, "Contesto della registrazione (materia)"), ctxSel, h("div", { class: "m" }, "Con questi modelli il contesto genera suggerimenti di correzione per i termini del tuo vocabolario nell'editor (non sostituisce mai nulla da solo).")), h("div")),
    h("div", { style: "margin-top:8px" }, mkCb("normalize", "Normalizza il volume (consigliato per registrazioni deboli)"), mkCb("denoise", "Riduci il rumore di fondo (può togliere dettaglio: provalo solo se serve)"), diaBox),
    h("div", { class: "row sp" }, h("h2", null, "Modello"), h("label", { class: "opt" }, h("input", { type: "checkbox", onchange: e => { CFG.compare = e.target.checked; CFG.multi = []; draw(); } }), "Confronta modelli (scegline 2 o 3, un solo file)")), hint, modelBox,
    h("h2", null, "Modelli veloci (meno accurati)"), h("p", { class: "m" }, "Per bozze e live su PC lenti. Per un compromesso migliore di velocità e qualità guarda anche Parakeet nella lista sopra."), fastBox,
    h("div", { class: "row", style: "margin-top:20px" }, startBtn));
  langs(); drawDia(); drawQueue(); await loadModels(); if (CFG.folder && !CFG.model) applyFolderPrefs();
}]);
