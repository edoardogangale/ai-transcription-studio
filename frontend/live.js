"use strict";
/* Registrazione + trascrizione LIVE. Il Recorder è globale: continua se cambi pagina; il server salva l'audio man mano. */
const SR16 = 16000;
const Recorder = {
  state: "idle",            // idle | starting | recording | paused | stopping
  tid: null, ws: null, ctx: null, stream: null, node: null, analyser: null, gain: null,
  samples: 0,               // orologio dell'audio: campioni a 16 kHz catturati (le note usano QUESTO tempo = tempo dell'audio)
  serverRecv: 0, status: null, segs: [], notes: [], ring: [], cfgLive: null, listeners: new Set(), stopping: false, reconnectTimer: null, down: null, out: [], lastNotif: 0,
  elapsed() { return this.samples / SR16; },
  emit() { this.listeners.forEach(f => f()); renderActivity(); },

  async start(cfg) {
    if (this.state !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Il microfono richiede HTTPS o localhost: avvia l'app con --https (vedi README, sezione iPad).");
    this.state = "starting"; this.emit();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      const r = await api("/api/live", { json: cfg });     // carica il modello PRIMA di partire
      this.tid = r.id; this.cfgLive = cfg;
    } catch (e) { this.cleanup(); this.state = "idle"; this.emit(); throw e; }
    this.samples = 0; this.serverRecv = 0; this.segs = []; this.notes = []; this.ring = []; this.out = []; this.stopping = false; this.status = null;
    await this.openAudio(); this.connect();
    this.state = "recording"; Wake.on(); this.mediaSession(); Notif.ask().then(() => this.notifyRec(true));
    this.timer = setInterval(() => { this.emit(); if (document.hidden) this.notifyRec(); }, 1000);
    this.emit();
  },

  async openAudio() {
    const AC = window.AudioContext || window.webkitAudioContext; this.ctx = new AC();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 512; src.connect(this.analyser);
    this.gain = this.ctx.createGain(); this.gain.gain.value = 0; this.gain.connect(this.ctx.destination);   // il nodo deve essere collegato per girare, ma muto (niente eco)
    const ratio = this.ctx.sampleRate / SR16; this.down = { sum: 0, cnt: 0, pos: 0, ratio };
    const onData = f32 => this.onSamples(f32);
    if (this.ctx.audioWorklet) {
      const code = `class P extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0}process(i){const c=i[0][0];if(c){this.b.push(new Float32Array(c));this.n+=c.length;if(this.n>=2048){const o=new Float32Array(this.n);let k=0;for(const x of this.b){o.set(x,k);k+=x.length}this.port.postMessage(o,[o.buffer]);this.b=[];this.n=0}}return true}}registerProcessor('pcm-cap',P)`;
      const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, "pcm-cap"); this.node.port.onmessage = e => onData(e.data);
    } else {   // ripiego per browser vecchi
      this.node = this.ctx.createScriptProcessor(4096, 1, 1); this.node.onaudioprocess = e => onData(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    src.connect(this.node); this.node.connect(this.gain);
  },

  /* filtro a media (box) + decimazione a 16 kHz, poi int16 */
  onSamples(f32) {
    if (this.state === "paused" || this.state === "stopping" || this.state === "idle") return;
    const d = this.down, o = [];
    for (let i = 0; i < f32.length; i++) {
      d.sum += f32[i]; d.cnt++; d.pos += 1;
      if (d.pos >= d.ratio) { o.push(Math.max(-1, Math.min(1, d.sum / d.cnt))); d.sum = 0; d.cnt = 0; d.pos -= d.ratio; }
    }
    for (const v of o) this.out.push(v < 0 ? v * 32768 : v * 32767);
    while (this.out.length >= 1600) this.frame(Int16Array.from(this.out.splice(0, 1600)));
  },
  frame(i16) {
    this.ring.push({ start: this.samples, data: i16 }); this.samples += i16.length;
    while (this.ring.length && this.ring[0].start < this.samples - SR16 * 180) this.ring.shift();   // ricorda gli ultimi 3 minuti per il reinvio
    if (this.ws && this.ws.readyState === 1) this.ws.send(i16.buffer.slice(0));
  },

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/live/${this.tid}/ws` + (token() ? "?token=" + encodeURIComponent(token()) : ""));
    ws.binaryType = "arraybuffer"; this.ws = ws;
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === "ready") { this.resend(Math.round(m.received_s * SR16)); }
      else if (m.type === "status") { this.status = m; this.serverRecv = Math.round(m.received_s * SR16); }
      else if (m.type === "segment") { this.segs.push(m.seg); }
      else if (m.type === "done") { this.finished(); }
      this.emit();
    };
    ws.onclose = () => { if (this.ws === ws && !this.stopping && this.state !== "idle") { this.status = { ...(this.status || {}), offline: true }; this.reconnectTimer = setTimeout(() => this.connect(), 2000); this.emit(); } };
    ws.onerror = () => {};
  },
  /* dopo una riconnessione: reinvia l'audio che il server non ha ricevuto (o silenzio per un buco non recuperabile, così i tempi restano allineati) */
  resend(have) {
    if (this.status) this.status.offline = false;
    if (have >= this.samples) return;
    const first = this.ring[0]?.start ?? this.samples;
    if (have < first) { const gap = new Int16Array(Math.min(first - have, SR16 * 600)); for (let o = 0; o < gap.length; o += 16000) this.ws.send(gap.slice(o, o + 16000).buffer); }
    for (const f of this.ring) { const end = f.start + f.data.length; if (end <= have) continue; const part = f.start >= have ? f.data : f.data.slice(have - f.start); this.ws.send(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)); }
  },

  pause() { if (this.state === "recording") { this.state = "paused"; this.emit(); } },
  resume() { if (this.state === "paused") { this.state = "recording"; this.ctx?.resume(); this.emit(); } },

  async stop() {
    if (this.state === "idle" || this.state === "stopping") return;
    this.stopping = true; const tid = this.tid; this.state = "stopping"; this.emit();
    if (this.out.length) { const pad = Int16Array.from(this.out); this.out = []; this.frame(pad); }
    this.node?.disconnect(); this.stream?.getTracks().forEach(t => t.stop());
    clearInterval(this.timer); clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "stop" }));
    else { try { await api(`/api/live/${tid}/stop`, { method: "POST" }); this.finished(); } catch (e) { toast("Errore nel salvataggio: " + e.message, 6000); } }
    setTimeout(() => { if (this.state === "stopping") api(`/api/live/${tid}/stop`, { method: "POST" }).then(() => this.finished()).catch(() => {}); }, 120000);
  },
  finished() {
    if (this.state === "idle") return; const tid = this.tid;
    this.cleanup(); this.state = "idle"; this.emit(); Notif.close("ats-rec");
    Notif.show("Registrazione salvata", "La trascrizione è pronta nell'archivio.", { tag: "rec-done", url: "#/t/" + tid, silent: false });
    toast("✓ Registrazione salvata"); window.dispatchEvent(new CustomEvent("jobs-changed"));
    if (location.hash === "#/live") location.hash = "#/t/" + tid;
  },
  cleanup() { try { this.ws?.close(); } catch {} try { this.stream?.getTracks().forEach(t => t.stop()); } catch {} try { this.ctx?.close(); } catch {} clearInterval(this.timer); clearTimeout(this.reconnectTimer); Wake.off(); try { navigator.mediaSession.playbackState = "none"; } catch {} this.ws = this.ctx = this.stream = this.node = null; },

  async addNote(text) {
    if (!text.trim() || !this.tid) return; const t0 = this.elapsed();
    const a = { kind: "note", t0, text: text.trim() }; this.notes.push(a); this.emit();
    try { await api(`/api/transcripts/${this.tid}/annotations`, { json: a }); } catch (e) { toast("Nota non salvata: " + e.message); }
  },
  async highlight(secs = 10) {
    if (!this.tid) return; const t1 = this.elapsed(), a = { kind: "highlight", t0: Math.max(0, t1 - secs), t1 }; this.notes.push(a); this.emit();
    toast(`★ Evidenziati gli ultimi ${secs} s`, 1500);
    try { await api(`/api/transcripts/${this.tid}/annotations`, { json: a }); } catch (e) { toast("Evidenziazione non salvata: " + e.message); }
  },
  level() { if (!this.analyser) return 0; const b = new Uint8Array(this.analyser.fftSize); this.analyser.getByteTimeDomainData(b); let m = 0; for (const v of b) m = Math.max(m, Math.abs(v - 128)); return m / 128; },

  mediaSession() {   // controlli sul blocco schermo / notifica multimediale (dove il browser li supporta)
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: "Registrazione in corso", artist: "AI Transcription Studio" }); navigator.mediaSession.playbackState = "playing";
      navigator.mediaSession.setActionHandler("pause", () => this.pause()); navigator.mediaSession.setActionHandler("play", () => this.resume()); navigator.mediaSession.setActionHandler("stop", () => this.stop()); } catch {}
  },
  notifyRec(force) {
    if (Date.now() - this.lastNotif < 30000 && !force) return; this.lastNotif = Date.now();
    Notif.show("● Registrazione in corso", `${fmtT(this.elapsed())}${this.status?.lag_s > 3 ? " · trascrizione in ritardo di " + this.status.lag_s + " s" : ""}`, { tag: "ats-rec", url: "#/live", sticky: true });
  },
};
window.Recorder = Recorder;
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Recorder.ctx?.state === "suspended") Recorder.ctx.resume(); });

function whileMounted(el, fn) { const mo = new MutationObserver(() => { if (!el.isConnected) { fn(); mo.disconnect(); } }); mo.observe($app, { childList: true }); }

ROUTES.push([/^#\/live$/, async () => {
  const [sys, fl] = await Promise.all([api("/api/system"), api("/api/folders")]); LIB.folders = fl.folders;
  const cfgs = LSJ.get("live_cfg", { language: "it", model_id: null, context: "Altro", folder_id: CFG.folder, hl: 10 }), root = h("div");
  const modelsFor = async lang => { const r = await api("/api/models?language=" + lang); return [...r.models, ...r.fast].filter(m => m.compatible && m.installed).map(m => ({ m, rec: m.id === "parakeet-tdt-0.6b-v3" })); };
  let avail = [];

  const meter = h("canvas", { class: "meter", width: 600, height: 40 }); let raf;
  function drawMeter() { const c = meter.getContext("2d"); c.clearRect(0, 0, 600, 40); const L = Recorder.state === "recording" ? Recorder.level() : 0; const cs = getComputedStyle(document.documentElement); c.fillStyle = cs.getPropertyValue("--accent").trim(); const w = Math.min(1, L * 2.5) * 600; c.fillRect(0, 12, w, 16); c.fillStyle = cs.getPropertyValue("--line").trim(); c.fillRect(w, 19, 600 - w, 2); raf = requestAnimationFrame(drawMeter); }
  whileMounted(root, () => { cancelAnimationFrame(raf); Recorder.listeners.delete(onRec); });

  const noteIn = h("input", { type: "text", placeholder: "Scrivi una nota e premi Invio (si aggancia a questo istante)…", onkeydown: e => { if (e.key === "Enter") addNote(); } });
  const addNote = () => { Recorder.addNote(noteIn.value); noteIn.value = ""; };

  function setupView() {
    const langSel = h("select", { onchange: async e => { cfgs.language = e.target.value; avail = await modelsFor(cfgs.language); LSJ.set("live_cfg", cfgs); render(); } }, [["it", "Italiano"], ["en", "Inglese"]].map(([v, l]) => h("option", { value: v, selected: cfgs.language === v }, l)));
    const modelSel = h("select", { onchange: e => { cfgs.model_id = e.target.value; LSJ.set("live_cfg", cfgs); render(); } }, avail.map(({ m }) => h("option", { value: m.id, selected: cfgs.model_id === m.id }, `${m.name}${m.tier === "fast" ? " · veloce" : ""}`)));
    const ctxSel = h("select", { onchange: e => { cfgs.context = e.target.value; LSJ.set("live_cfg", cfgs); } }, sys.contexts.map(c => h("option", { value: c, selected: cfgs.context === c }, c)));
    const folderSel = h("select", { onchange: e => { cfgs.folder_id = e.target.value || null; LSJ.set("live_cfg", cfgs); } }, folderOptions().map(o => h("option", { value: o.id, selected: (o.id || null) === cfgs.folder_id }, o.label)));
    const title = h("input", { type: "text", placeholder: "Titolo (facoltativo): es. Filosofia - Kant" });
    const cur = avail.find(a => a.m.id === cfgs.model_id)?.m, rtf = cur && (cur.measured_rtf ?? cur.reference?.rtf);
    const slow = rtf != null && rtf > 0.7;
    return h("div", null,
      h("h1", null, "Registra con trascrizione live"), h("p", { class: "sub" }, "Il testo compare mentre parli, l'audio viene salvato sul server man mano e puoi aggiungere note ed evidenziazioni in diretta."),
      !navigator.mediaDevices?.getUserMedia && h("div", { class: "notice bad" }, "Il microfono non è disponibile: il browser lo permette solo su HTTPS o localhost. Avvia con ./scripts/start.sh --lan --https."),
      !avail.length && h("div", { class: "notice warn" }, "Nessun modello installato e compatibile per questa lingua. ", h("a", { href: "#/models" }, "Installa un modello →")),
      h("div", { class: "grid g2" }, h("div", null, h("label", null, "Lingua"), langSel), h("div", null, h("label", null, "Modello"), modelSel),
        h("div", null, h("label", null, "Materia / contesto"), ctxSel), h("div", null, h("label", null, "Salva in"), folderSel)),
      h("div", { style: "margin-top:10px" }, h("label", null, "Titolo"), title),
      h("div", { class: "notice" + (slow ? " warn" : ""), style: "margin-top:12px" },
        rtf == null ? "Velocità di questo modello su questo PC non ancora misurata: se il testo resta indietro rispetto alla voce, scegli un modello più veloce (Parakeet è il più rapido tra quelli misurati)."
          : slow ? `Attenzione: ${cur.name} ha velocità ${rtf.toFixed(2)}× il tempo reale su questo hardware: il testo resterà indietro e il ritardo crescerà. Puoi registrare lo stesso e ritrascrivere dopo con un altro modello.`
            : `${cur.name}: ${speedText(rtf)}${cur.measured_rtf != null ? " (misurato sul tuo PC)" : " (misura di riferimento, 4 core CPU)"}: adatto al live.`),
      h("div", { class: "row", style: "margin-top:16px" }, h("button", { class: "primary rec-btn", disabled: !avail.length || !navigator.mediaDevices?.getUserMedia || !cfgs.model_id, onclick: async () => {
        try { await Recorder.start({ language: cfgs.language, model_id: cfgs.model_id, context: cfgs.context, title: title.value.trim() || null, folder_id: cfgs.folder_id }); }
        catch (e) { toast(e.message, 7000); } render(); } }, Recorder.state === "starting" ? "Avvio (carico il modello)…" : "● Inizia registrazione")),
      h("details", { style: "margin-top:20px" }, h("summary", null, "Registrazione in secondo piano: cosa aspettarsi"),
        h("ul", { class: "m" }, h("li", null, "La trascrizione e il salvataggio dell'audio avvengono sul server: continuano anche se chiudi la pagina."),
          h("li", null, "Il browser può mettere in pausa il microfono se l'app va in secondo piano o lo schermo si blocca (soprattutto su iPad/iPhone). Per questo l'app tiene lo schermo acceso, mostra una notifica persistente e, se la connessione cade, reinvia l'audio mancante."),
          h("li", null, "Se tutto si interrompe, l'audio già inviato viene recuperato al riavvio dell'app."))));
  }

  function recView() {
    const S = Recorder.status || {}, items = [];
    Recorder.segs.forEach(s => items.push({ t: s.start, seg: s })); Recorder.notes.filter(n => n.kind === "note").forEach(n => items.push({ t: n.t0, note: n })); items.sort((a, b) => a.t - b.t);
    const isHl = s => Recorder.notes.some(n => n.kind === "highlight" && n.t0 <= s.end && n.t1 >= s.start);
    const stopping = Recorder.state === "stopping";
    const hlSel = h("select", { style: "width:auto", onchange: e => { cfgs.hl = +e.target.value; LSJ.set("live_cfg", cfgs); } }, [5, 10, 20, 30, 60].map(v => h("option", { value: v, selected: cfgs.hl === v }, `ultimi ${v} s`)));
    const live = h("div", { class: "livebox" }, items.length ? items.map(x => x.seg ? h("div", { class: "seg" + (isHl(x.seg) ? " hl" : "") }, h("span", { class: "ts" }, fmtT(x.seg.start)), h("div", { class: "txt" }, x.seg.text)) : h("div", { class: "livenote" }, "✎ " + fmtT(x.note.t0) + " — " + x.note.text))
      : h("p", { class: "m" }, "In ascolto… il testo appare alla fine di ogni frase."));
    return h("div", null,
      h("div", { class: "row sp" }, h("h1", null, Recorder.state === "paused" ? "In pausa" : stopping ? "Salvataggio…" : "● Registrazione"), h("div", { class: "bigtime" }, fmtT(Recorder.elapsed()))),
      h("div", { class: "m" }, `${mname(Recorder.cfgLive?.model_id)} · trascritto fino a ${fmtT(S.transcribed_s || 0)} · ritardo ${S.lag_s ?? 0} s` + (S.offline ? " · ⚠ connessione persa: riprovo, l'audio non va perso" : "") + (S.error ? " · errore su una frase: " + S.error : "")),
      meter,
      h("div", { class: "row", style: "margin:12px 0" },
        h("button", { class: "star-btn", disabled: stopping, onclick: () => Recorder.highlight(cfgs.hl || 10) }, "★ Evidenzia"), hlSel,
        Recorder.state === "paused" ? h("button", { onclick: () => Recorder.resume() }, "▶ Riprendi") : h("button", { disabled: stopping, onclick: () => Recorder.pause() }, "⏸ Pausa"),
        h("button", { class: "danger", disabled: stopping, onclick: () => Recorder.stop() }, "■ Stop e salva")),
      h("div", { class: "row" }, h("div", { class: "grow" }, noteIn), h("button", { disabled: stopping, onclick: addNote }, "✎ Aggiungi nota")),
      h("h2", null, "Trascrizione in diretta"), live);
  }

  async function render() {
    const body = Recorder.state === "idle" ? setupView() : recView();
    root.replaceChildren(body);
    const lb = root.querySelector(".livebox"); if (lb) lb.scrollTop = lb.scrollHeight;
  }
  const onRec = () => { if (root.isConnected && Recorder.state !== "idle" && document.activeElement === noteIn) { const lb = root.querySelector(".livebox"); /* non ridisegnare mentre scrivi una nota */ if (lb) { lb.replaceChildren(...recView().querySelector(".livebox").childNodes); lb.scrollTop = lb.scrollHeight; } root.querySelector(".bigtime") && (root.querySelector(".bigtime").textContent = fmtT(Recorder.elapsed())); } else if (root.isConnected) render(); };
  Recorder.listeners.add(onRec);
  $app.replaceChildren(root);
  avail = await modelsFor(cfgs.language);
  if (!avail.some(a => a.m.id === cfgs.model_id)) cfgs.model_id = (avail.find(a => a.rec) || avail[0])?.m.id || null;
  render(); drawMeter();
}]);
