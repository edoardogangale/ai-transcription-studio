// Quaderno a mano libera ispirato a Note di Apple / GoodNotes.
// - Apple Pencil (pointerType "pen") scrive; il DITO scorre e zooma (pizzico). Tocco con 2 dita = annulla, 3 dita = ripristina.
// - Strumenti: penna (pressione), stilografica (tratto variabile con la direzione), matita, evidenziatore, gomma (a oggetto o
//   a pixel), lazo (seleziona e sposta), testo, righello (sposta con un dito, ruota con due), forme: tieni ferma la penna a
//   fine tratto e linee/frecce/cerchi/rettangoli/triangoli si raddrizzano.
// - Penna tenuta ferma 0,5 s appena appoggiata = strumenti rapidi.
// - Il foglio si allarga a destra e in basso; carta bianca/righe/quadretti/puntini.
// Limite del web: il doppio tocco e la "stretta" della Apple Pencil NON arrivano a Safari: c'è il pulsante ⇄ (gomma ↔ strumento).

export const COLORS = ["#1c1c1e", "#0a84ff", "#ff3b30", "#34c759", "#ff9f0a", "#af52de", "#8e8e93"];
const HL_COLORS = ["#ffe066", "#7cf29c", "#7cc4ff", "#ff9ecb", "#ffb86b"];
export const PAPERS = { blank: "Bianco", lines: "Righe", grid: "Quadretti", dots: "Puntini" };
export const SIZES = { a4: ["A4 verticale", 820, 1160], a4l: ["A4 orizzontale", 1160, 820], wide: ["Largo", 1400, 1000], inf: ["Infinito (si allunga)", 1100, 1600] };
const TOOLS = {
  pen: ["Penna", 3], fountain: ["Stilografica", 4], pencil: ["Matita", 2.5], marker: ["Evidenziatore", 7],
  eraser: ["Gomma", 12], lasso: ["Lazo", 0], text: ["Testo", 0],
};
const ICON = {
  pen: '<path d="M8 30 L14 6 L20 30 Z" fill="currentColor" opacity=".9"/><rect x="8" y="30" width="12" height="16" rx="2" fill="#f2f2f7" stroke="#8e8e93"/>',
  fountain: '<path d="M14 4 L20 18 L17 30 L11 30 L8 18 Z" fill="currentColor"/><line x1="14" y1="10" x2="14" y2="22" stroke="#fff" stroke-width="1.2"/><rect x="9" y="30" width="10" height="16" rx="2" fill="#1c1c1e"/>',
  pencil: '<path d="M10 22 L14 6 L18 22 Z" fill="#e8c39e"/><path d="M12.6 12 L14 6 L15.4 12 Z" fill="currentColor"/><rect x="10" y="22" width="8" height="24" fill="#ffcc00" stroke="#c9a200"/>',
  marker: '<path d="M9 18 L11 8 L19 8 L19 18 Z" fill="currentColor"/><rect x="8" y="18" width="12" height="28" rx="2" fill="#f2f2f7" stroke="#8e8e93"/>',
  eraser: '<rect x="7" y="10" width="14" height="36" rx="4" fill="#ff8fa3" stroke="#c75b6e"/><rect x="7" y="26" width="14" height="20" rx="2" fill="#f2f2f7" stroke="#8e8e93"/>',
  lasso: '<ellipse cx="14" cy="18" rx="10" ry="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/><path d="M8 23 q-2 8 3 12" fill="none" stroke="currentColor" stroke-width="2"/>',
  text: '<text x="14" y="32" text-anchor="middle" font-size="26" font-family="-apple-system,system-ui" fill="currentColor">A</text>',
  ruler: '<rect x="2" y="16" width="24" height="14" rx="2" fill="#d1d1d6" stroke="#8e8e93" transform="rotate(-35 14 23)"/>',
};
const svg = (k, c) => `<svg viewBox="0 0 28 48" width="26" height="44" style="color:${c}">${ICON[k]}</svg>`;
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 10);
function el(tag, attrs, ...kids) { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") e.className = v; else if (k === "html") e.innerHTML = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v != null && v !== false) e.setAttribute(k, v); } for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k)); return e; }

// ---------- geometria dei tratti ----------
function bbox(pts) { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (let i = 0; i < pts.length; i += 3) { a = Math.min(a, pts[i]); b = Math.min(b, pts[i + 1]); c = Math.max(c, pts[i]); d = Math.max(d, pts[i + 1]); } return [a, b, c, d]; }
export function makeStroke(t, c, s, pts, extra) { const r = { id: uid(), t, c, s, pts: pts.map(v => Math.round(v * 10) / 10), ...(extra || {}) }; r.bb = bbox(r.pts); return r; }
function widthFn(st) {
  const s = st.s;
  if (st.t === "fountain") return (p, ang) => s * (0.3 + 0.7 * p) * (0.28 + 1.05 * Math.abs(Math.sin(ang - Math.PI / 4)));
  if (st.t === "pencil") return p => s * (0.45 + 0.6 * p);
  return p => s * (0.35 + 0.95 * p);
}
const pathCache = new WeakMap();
function strokePath(st) {
  let P = pathCache.get(st); if (P) return P;
  const pts = st.pts, n = pts.length / 3; P = new Path2D();
  if (st.t === "marker") { P.moveTo(pts[0], pts[1]); for (let i = 1; i < n; i++) P.lineTo(pts[i * 3], pts[i * 3 + 1]); if (n === 1) P.lineTo(pts[0] + 0.1, pts[1]); pathCache.set(st, P); return P; }
  const wf = widthFn(st);
  if (n < 2) { P.arc(pts[0], pts[1], Math.max(0.6, wf(pts[2] || 0.5, 0) / 2), 0, Math.PI * 2); pathCache.set(st, P); return P; }
  // levigatura leggera dei punti e delle larghezze
  const X = [], Y = [], W = [];
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1); X.push((pts[a * 3] + 2 * pts[i * 3] + pts[b * 3]) / 4); Y.push((pts[a * 3 + 1] + 2 * pts[i * 3 + 1] + pts[b * 3 + 1]) / 4); }
  X[0] = pts[0]; Y[0] = pts[1]; X[n - 1] = pts[(n - 1) * 3]; Y[n - 1] = pts[(n - 1) * 3 + 1];
  const NX = [], NY = [];
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1); let dx = X[b] - X[a], dy = Y[b] - Y[a]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; NX.push(-dy); NY.push(dx); W.push(Math.max(0.5, wf(pts[i * 3 + 2], Math.atan2(dy, dx)) / 2)); }
  for (let k = 0; k < 2; k++) for (let i = 1; i < n - 1; i++) W[i] = (W[i - 1] + 2 * W[i] + W[i + 1]) / 4;
  const L = [], R = [];
  for (let i = 0; i < n; i++) { L.push([X[i] + NX[i] * W[i], Y[i] + NY[i] * W[i]]); R.push([X[i] - NX[i] * W[i], Y[i] - NY[i] * W[i]]); }
  const curve = (arr) => { for (let i = 1; i < arr.length - 1; i++) { const m = [(arr[i][0] + arr[i + 1][0]) / 2, (arr[i][1] + arr[i + 1][1]) / 2]; P.quadraticCurveTo(arr[i][0], arr[i][1], m[0], m[1]); } P.lineTo(arr[arr.length - 1][0], arr[arr.length - 1][1]); };
  P.moveTo(L[0][0], L[0][1]); curve(L);
  const ae = Math.atan2(NY[n - 1], NX[n - 1]); P.arc(X[n - 1], Y[n - 1], W[n - 1], ae, ae - Math.PI, true);
  const Rr = R.slice().reverse(); curve(Rr);
  const as = Math.atan2(NY[0], NX[0]); P.arc(X[0], Y[0], W[0], as + Math.PI, as, true);
  P.closePath(); pathCache.set(st, P); return P;
}
export function drawStroke(ctx, st, dx = 0, dy = 0) {
  ctx.save(); if (dx || dy) ctx.translate(dx, dy);
  const P = strokePath(st);
  if (st.t === "marker") { ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha = 0.42; ctx.strokeStyle = st.c; ctx.lineWidth = st.s * 2.6; ctx.lineCap = "butt"; ctx.lineJoin = "round"; ctx.stroke(P); }
  else { if (st.t === "pencil") ctx.globalAlpha = 0.78; ctx.fillStyle = st.c; ctx.fill(P); }
  ctx.restore();
}
function segDist(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy; let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = clamp(t, 0, 1); return Math.hypot(px - ax - t * dx, py - ay - t * dy); }
function hitStroke(st, x, y, r) {
  const [a, b, c, d] = st.bb, pad = r + st.s * 2; if (x < a - pad || x > c + pad || y < b - pad || y > d + pad) return false;
  const p = st.pts, n = p.length / 3, rr = r + (st.t === "marker" ? st.s * 1.3 : st.s * 0.6);
  if (n === 1) return Math.hypot(p[0] - x, p[1] - y) < rr;
  for (let i = 1; i < n; i++) if (segDist(x, y, p[i * 3 - 3], p[i * 3 - 2], p[i * 3], p[i * 3 + 1]) < rr) return true;
  return false;
}
function inPoly(x, y, poly) { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; } return ins; }

// ---------- riconoscimento delle forme (tieni ferma la penna a fine tratto) ----------
function rdp(P, eps) { if (P.length < 3) return P; let dm = 0, k = 0; const [a, b] = [P[0], P[P.length - 1]]; for (let i = 1; i < P.length - 1; i++) { const d = segDist(P[i][0], P[i][1], a[0], a[1], b[0], b[1]); if (d > dm) { dm = d; k = i; } } if (dm > eps) { const l = rdp(P.slice(0, k + 1), eps), r = rdp(P.slice(k), eps); return l.slice(0, -1).concat(r); } return [a, b]; }
const plen = P => { let s = 0; for (let i = 1; i < P.length; i++) s += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return s; };
const flat = (P, p = 0.6) => P.flatMap(q => [q[0], q[1], p]);
function densify(P, step = 6) { const o = [P[0]]; for (let i = 1; i < P.length; i++) { const [ax, ay] = P[i - 1], [bx, by] = P[i]; const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step)); for (let k = 1; k <= n; k++) o.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]); } return o; }
export function recognize(pts) {
  const P = []; for (let i = 0; i < pts.length; i += 3) P.push([pts[i], pts[i + 1]]);
  if (P.length < 4) return null;
  const [a, b, c, d] = bbox(pts), diag = Math.hypot(c - a, d - b); if (diag < 18) return null;
  const L = plen(P), closed = Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < Math.max(18, 0.12 * L);
  if (!closed) {
    const S = rdp(P, Math.max(5, 0.05 * diag));
    if (S.length === 2) return { kind: "linea", pts: flat(densify([P[0], P[P.length - 1]])) };
    // freccia: asta fino alla punta (punto più lontano dall'inizio), poi una "testa" corta vicino alla punta
    let k = 0, dm = 0; P.forEach((q, i) => { const dd = Math.hypot(q[0] - P[0][0], q[1] - P[0][1]); if (dd > dm) { dm = dd; k = i; } });
    const shaft = P.slice(0, k + 1), head = P.slice(k), Ls = dm;
    const straight = rdp(shaft, Math.max(5, 0.06 * Ls)).length <= 2;
    if (straight && head.length > 2 && plen(head) > 0.08 * Ls && plen(head) < 1.2 * Ls && head.every(q => Math.hypot(q[0] - P[k][0], q[1] - P[k][1]) < 0.45 * Ls)) {
      const tip = P[k], ang = Math.atan2(tip[1] - P[0][1], tip[0] - P[0][0]), hl = clamp(0.22 * Ls, 12, 48);
      const h1 = [tip[0] - hl * Math.cos(ang - 0.5), tip[1] - hl * Math.sin(ang - 0.5)], h2 = [tip[0] - hl * Math.cos(ang + 0.5), tip[1] - hl * Math.sin(ang + 0.5)];
      return { kind: "freccia", pts: flat(densify([P[0], tip, h1])).concat(flat(densify([h1, tip, h2]))) };
    }
    if (S.length <= 5) return { kind: "spezzata", pts: flat(densify(S)) };
    return null;
  }
  const cx = P.reduce((s, q) => s + q[0], 0) / P.length, cy = P.reduce((s, q) => s + q[1], 0) / P.length;
  const S = rdp(P, Math.max(6, 0.08 * diag)); let C = S.slice(0, -1);
  if (C.length > 2 && Math.hypot(C[0][0] - S[S.length - 1][0], C[0][1] - S[S.length - 1][1]) < 0.15 * diag) { /* già chiuso */ }
  if (C.length === 3) return { kind: "triangolo", pts: flat(densify([...C, C[0]])) };
  if (C.length === 4) {
    const ang = i => { const p0 = C[(i + 3) % 4], p1 = C[i], p2 = C[(i + 1) % 4]; const a1 = Math.atan2(p0[1] - p1[1], p0[0] - p1[0]), a2 = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]); let x = Math.abs(a1 - a2) * 180 / Math.PI; if (x > 180) x = 360 - x; return x; };
    const right = [0, 1, 2, 3].every(i => Math.abs(ang(i) - 90) < 22);
    if (right) { // rettangolo pulito: usa l'orientamento del primo lato
      const t = Math.atan2(C[1][1] - C[0][1], C[1][0] - C[0][0]), co = Math.cos(t), si = Math.sin(t);
      const loc = C.map(q => [(q[0] - cx) * co + (q[1] - cy) * si, -(q[0] - cx) * si + (q[1] - cy) * co]);
      const xs = loc.map(q => q[0]), ys = loc.map(q => q[1]); const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const R = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [cx + x * co - y * si, cy + x * si + y * co]);
      return { kind: "rettangolo", pts: flat(densify([...R, R[0]])) };
    }
    return { kind: "quadrilatero", pts: flat(densify([...C, C[0]])) };
  }
  const ds = P.map(q => Math.hypot(q[0] - cx, q[1] - cy)), m = ds.reduce((s, v) => s + v, 0) / ds.length;
  const cv = Math.sqrt(ds.reduce((s, v) => s + (v - m) ** 2, 0) / ds.length) / m;
  const rx = (c - a) / 2, ry = (d - b) / 2, ex = (a + c) / 2, ey = (b + d) / 2;
  if (cv < 0.32) {
    const circle = Math.abs(rx - ry) / Math.max(rx, ry) < 0.18, R = (rx + ry) / 2, O = [];
    for (let i = 0; i <= 72; i++) { const t = i / 72 * Math.PI * 2; O.push([ex + (circle ? R : rx) * Math.cos(t), ey + (circle ? R : ry) * Math.sin(t)]); }
    return { kind: circle ? "cerchio" : "ellisse", pts: flat(O) };
  }
  return null;
}

// ---------- disegno della carta ----------
function drawPaper(ctx, page, vx0, vy0, vx1, vy1, z) {
  const p = page.paper || {}; ctx.fillStyle = p.color || "#ffffff"; ctx.fillRect(0, 0, page.w, page.h);
  const gap = p.gap || 32, col = p.color === "#1c1c1e" ? "rgba(255,255,255,.14)" : "rgba(60,90,140,.22)";
  const x0 = Math.max(0, vx0), y0 = Math.max(0, vy0), x1 = Math.min(page.w, vx1), y1 = Math.min(page.h, vy1);
  ctx.lineWidth = 1 / Math.max(z, 0.5); ctx.strokeStyle = col; ctx.fillStyle = col;
  if (p.type === "lines" || p.type === "grid") {
    ctx.beginPath(); const top = p.type === "lines" ? gap * 2 : gap;
    for (let y = Math.max(top, Math.ceil((y0 - top) / gap) * gap + top); y <= y1; y += gap) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    if (p.type === "grid") for (let x = Math.ceil(x0 / gap) * gap; x <= x1; x += gap) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke();
    if (p.type === "lines") { ctx.strokeStyle = "rgba(255,59,48,.28)"; ctx.beginPath(); ctx.moveTo(gap * 2.5, y0); ctx.lineTo(gap * 2.5, y1); ctx.stroke(); }
  } else if (p.type === "dots") {
    const r = 1.3; for (let y = Math.ceil(y0 / gap) * gap; y <= y1; y += gap) for (let x = Math.ceil(x0 / gap) * gap; x <= x1; x += gap) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
  }
}

// ---------- il quaderno ----------
export function createNotebook(host, page, opts = {}) {
  page.strokes ||= []; page.texts ||= []; page.paper ||= { type: "lines", gap: 32, color: "#ffffff" }; page.w ||= 820; page.h ||= 1160;
  const st = { tool: localStorage.getItem("ink_tool") || "pen", prev: "eraser", colors: {}, sizes: {}, eraserMode: localStorage.getItem("ink_er") || "object", fingerDraw: localStorage.getItem("ink_finger") === "1", ruler: null };
  try { Object.assign(st.colors, JSON.parse(localStorage.getItem("ink_colors") || "{}")); Object.assign(st.sizes, JSON.parse(localStorage.getItem("ink_sizes") || "{}")); } catch {}
  const colorOf = t => st.colors[t] || (t === "marker" ? HL_COLORS[0] : COLORS[0]), sizeOf = t => st.sizes[t] || TOOLS[t][1];
  const persist = () => { try { localStorage.setItem("ink_tool", st.tool); localStorage.setItem("ink_colors", JSON.stringify(st.colors)); localStorage.setItem("ink_sizes", JSON.stringify(st.sizes)); localStorage.setItem("ink_er", st.eraserMode); localStorage.setItem("ink_finger", st.fingerDraw ? "1" : "0"); } catch {} };

  const root = el("div", { class: "ink" });
  const stage = el("div", { class: "ink-stage" });
  const bg = el("canvas", { class: "ink-c" }), live = el("canvas", { class: "ink-c" });
  const textLayer = el("div", { class: "ink-texts" });
  const toast = el("div", { class: "ink-toast" });
  stage.append(bg, textLayer, live, toast);
  const top = el("div", { class: "ink-top" }), bar = el("div", { class: "ink-bar" });
  root.append(top, stage, bar); host.append(root);
  const bctx = bg.getContext("2d"), lctx = live.getContext("2d");
  let W = 0, H = 0, cam = { z: 1, tx: 0, ty: 0 }, dirty = true, raf = 0;

  // ----- annulla / ripristina -----
  const undoS = [], redoS = [];
  const snap = () => ({ strokes: page.strokes.slice(), texts: JSON.parse(JSON.stringify(page.texts)), w: page.w, h: page.h });
  const restore = s => { page.strokes = s.strokes; page.texts = s.texts; page.w = s.w; page.h = s.h; sel = null; renderTexts(); changed(); };
  const pushUndo = () => { undoS.push(snap()); if (undoS.length > 80) undoS.shift(); redoS.length = 0; updUndo(); };
  const undo = () => { if (!undoS.length) return; redoS.push(snap()); restore(undoS.pop()); updUndo(); say("Annullato"); };
  const redo = () => { if (!redoS.length) return; undoS.push(snap()); restore(redoS.pop()); updUndo(); say("Ripristinato"); };
  let saveT = 0; const changed = () => { dirty = true; schedule(); page.updated = Date.now(); clearTimeout(saveT); saveT = setTimeout(() => opts.onChange && opts.onChange(page), 600); };
  const say = (m) => { toast.textContent = m; toast.classList.add("show"); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove("show"), 1200); };

  // ----- camera -----
  function fit() { const z = clamp((W - 32) / page.w, 0.25, 1.4); cam = { z, tx: (W - page.w * z) / 2, ty: 16 }; }
  function clampCam() {
    const pw = page.w * cam.z, ph = page.h * cam.z;
    cam.tx = clamp(cam.tx, Math.min(60, W - pw - 60), Math.max(60, W - pw - 60));
    cam.ty = clamp(cam.ty, Math.min(40, H - ph - 220), 40);
  }
  const toPage = (sx, sy) => [(sx - cam.tx) / cam.z, (sy - cam.ty) / cam.z];
  function resize() {
    const r = stage.getBoundingClientRect(); const first = !W; W = Math.max(50, r.width); H = Math.max(50, r.height);
    for (const c of [bg, live]) { c.width = Math.round(W * dpr()); c.height = Math.round(H * dpr()); c.style.width = W + "px"; c.style.height = H + "px"; }
    if (first) fit(); clampCam(); dirty = true; schedule();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame() { raf = 0; if (dirty) { drawBg(); dirty = false; } drawLive(); applyTextCam(); }
  function drawBg() {
    const d = dpr(); bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.fillStyle = "#d8d8dd"; bctx.fillRect(0, 0, bg.width, bg.height);
    bctx.setTransform(d * cam.z, 0, 0, d * cam.z, d * cam.tx, d * cam.ty);
    const [vx0, vy0] = toPage(0, 0), [vx1, vy1] = toPage(W, H);
    bctx.save(); bctx.shadowColor = "rgba(0,0,0,.18)"; bctx.shadowBlur = 14 * cam.z; bctx.fillStyle = "#fff"; bctx.fillRect(0, 0, page.w, page.h); bctx.restore();
    bctx.save(); bctx.beginPath(); bctx.rect(0, 0, page.w, page.h); bctx.clip();
    drawPaper(bctx, page, vx0, vy0, vx1, vy1, cam.z);
    for (const s of page.strokes) { const [a, b, c, e] = s.bb, m = s.s * 3; if (c + m < vx0 || a - m > vx1 || e + m < vy0 || b - m > vy1) continue; if (sel && drag && sel.ids.has(s.id)) continue; drawStroke(bctx, s); }
    bctx.restore();
  }
  function drawLive() {
    const d = dpr(); lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height);
    lctx.setTransform(d * cam.z, 0, 0, d * cam.z, d * cam.tx, d * cam.ty);
    if (cur && cur.pts.length) drawStroke(lctx, cur);
    if (sel) {
      if (drag) for (const s of page.strokes) if (sel.ids.has(s.id)) drawStroke(lctx, s, drag.dx, drag.dy);
      const [a, b, c, e] = selBox(); const ox = drag ? drag.dx : 0, oy = drag ? drag.dy : 0;
      lctx.save(); lctx.setLineDash([6 / cam.z, 5 / cam.z]); lctx.strokeStyle = "#0a84ff"; lctx.lineWidth = 1.5 / cam.z; lctx.fillStyle = "rgba(10,132,255,.06)";
      lctx.fillRect(a - 8 + ox, b - 8 + oy, c - a + 16, e - b + 16); lctx.strokeRect(a - 8 + ox, b - 8 + oy, c - a + 16, e - b + 16); lctx.restore();
    }
    if (lasso && lasso.length > 1) { lctx.save(); lctx.setLineDash([5 / cam.z, 5 / cam.z]); lctx.strokeStyle = "#0a84ff"; lctx.lineWidth = 1.5 / cam.z; lctx.beginPath(); lasso.forEach(([x, y], i) => i ? lctx.lineTo(x, y) : lctx.moveTo(x, y)); lctx.stroke(); lctx.restore(); }
    if (eraserAt) { lctx.save(); lctx.strokeStyle = "rgba(0,0,0,.35)"; lctx.lineWidth = 1 / cam.z; lctx.beginPath(); lctx.arc(eraserAt[0], eraserAt[1], eraserR(), 0, 7); lctx.stroke(); lctx.restore(); }
    if (st.ruler) drawRuler(d);
  }

  // ----- righello (in coordinate dello schermo, come su iPad) -----
  const RW = 92;
  function drawRuler(d) {
    const r = st.ruler; lctx.setTransform(d, 0, 0, d, 0, 0); lctx.save(); lctx.translate(r.cx, r.cy); lctx.rotate(r.a);
    const len = Math.hypot(W, H) * 1.2; lctx.fillStyle = "rgba(142,142,147,.55)"; lctx.strokeStyle = "rgba(60,60,67,.6)"; lctx.lineWidth = 1;
    lctx.fillRect(-len / 2, -RW / 2, len, RW); lctx.strokeRect(-len / 2, -RW / 2, len, RW);
    lctx.beginPath(); for (let x = -Math.floor(len / 2 / 10) * 10; x < len / 2; x += 10) { const t = x % 50 === 0 ? 16 : 8; lctx.moveTo(x, -RW / 2); lctx.lineTo(x, -RW / 2 + t); lctx.moveTo(x, RW / 2); lctx.lineTo(x, RW / 2 - t); } lctx.stroke();
    let deg = Math.round(((-r.a * 180 / Math.PI) % 180 + 180) % 180); lctx.rotate(-r.a); lctx.fillStyle = "#1c1c1e"; lctx.font = "600 15px -apple-system,system-ui"; lctx.textAlign = "center"; lctx.textBaseline = "middle";
    lctx.fillStyle = "rgba(255,255,255,.85)"; lctx.beginPath(); lctx.arc(0, 0, 22, 0, 7); lctx.fill(); lctx.fillStyle = "#1c1c1e"; lctx.fillText(deg + "°", 0, 0); lctx.restore();
  }
  const rulerLocal = (sx, sy) => { const r = st.ruler, dx = sx - r.cx, dy = sy - r.cy, c = Math.cos(-r.a), s = Math.sin(-r.a); return [dx * c - dy * s, dx * s + dy * c]; };
  const rulerWorld = (lx, ly) => { const r = st.ruler, c = Math.cos(r.a), s = Math.sin(r.a); return [r.cx + lx * c - ly * s, r.cy + lx * s + ly * c]; };
  const onRuler = (sx, sy) => st.ruler && Math.abs(rulerLocal(sx, sy)[1]) < RW / 2;

  // ----- testo -----
  function applyTextCam() { textLayer.style.transform = `translate(${cam.tx}px,${cam.ty}px) scale(${cam.z})`; }
  function renderTexts() {
    textLayer.replaceChildren(...page.texts.map(t => {
      const d = el("div", { class: "ink-text" + (sel && sel.tids.has(t.id) ? " sel" : ""), "data-id": t.id, contenteditable: st.tool === "text" ? "true" : "false", style: `left:${t.x}px;top:${t.y}px;width:${t.w}px;font-size:${t.size}px;color:${t.color}` });
      d.innerText = t.text || "";
      d.addEventListener("focus", () => { d._before = snap(); });
      d.addEventListener("input", () => { t.text = d.innerText; changed(); });
      d.addEventListener("blur", () => { if (!t.text.trim()) { page.texts = page.texts.filter(x => x !== t); renderTexts(); } if (d._before) { undoS.push(d._before); redoS.length = 0; updUndo(); } changed(); });
      return d;
    }));
  }
  function addText(x, y) {
    const t = { id: uid(), x, y: y - 14, w: Math.min(520, page.w - x - 20), size: 20, color: colorOf("pen"), text: "" };
    page.texts.push(t); renderTexts(); const d = textLayer.querySelector(`[data-id="${t.id}"]`); if (d) { d.focus(); setTimeout(() => { if (document.activeElement !== d) d.focus(); }, 0); } // focus sincrono: su iPad apre la tastiera solo dentro il gesto
  }

  // ----- selezione (lazo) -----
  let sel = null, drag = null, lasso = null;
  function selBox() {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const s of page.strokes) if (sel.ids.has(s.id)) { a = Math.min(a, s.bb[0]); b = Math.min(b, s.bb[1]); c = Math.max(c, s.bb[2]); d = Math.max(d, s.bb[3]); }
    for (const t of page.texts) if (sel.tids.has(t.id)) { a = Math.min(a, t.x); b = Math.min(b, t.y); c = Math.max(c, t.x + t.w); d = Math.max(d, t.y + t.size * 1.4 * Math.max(1, (t.text || "").split("\n").length)); }
    return [a, b, c, d];
  }
  const selMenu = el("div", { class: "ink-selmenu" });
  function showSelMenu() {
    if (!sel) { selMenu.remove(); return; }
    selMenu.replaceChildren(
      el("button", { onclick: () => { pushUndo(); page.strokes = page.strokes.filter(s => !sel.ids.has(s.id)); page.texts = page.texts.filter(t => !sel.tids.has(t.id)); sel = null; renderTexts(); showSelMenu(); changed(); } }, "Elimina"),
      el("button", { onclick: () => { pushUndo(); const ids = new Set(), tids = new Set(); for (const s of page.strokes.filter(s => sel.ids.has(s.id))) { const n = makeStroke(s.t, s.c, s.s, s.pts.map((v, i) => i % 3 === 2 ? v : v + 30)); page.strokes.push(n); ids.add(n.id); } for (const t of page.texts.filter(t => sel.tids.has(t.id))) { const n = { ...t, id: uid(), x: t.x + 30, y: t.y + 30 }; page.texts.push(n); tids.add(n.id); } sel = { ids, tids }; renderTexts(); changed(); } }, "Duplica"),
      ...COLORS.slice(0, 5).map(c => el("button", { class: "dot", style: `background:${c}`, "aria-label": "Colore " + c, onclick: () => { pushUndo(); page.strokes = page.strokes.map(s => sel.ids.has(s.id) && s.t !== "marker" ? Object.assign(makeStroke(s.t, c, s.s, s.pts), { id: s.id }) : s); page.texts.forEach(t => { if (sel.tids.has(t.id)) t.color = c; }); renderTexts(); changed(); } })),
      el("button", { onclick: () => { sel = null; renderTexts(); showSelMenu(); dirty = true; schedule(); } }, "Fine"));
    stage.append(selMenu);
  }
  function finishLasso() {
    const poly = lasso; lasso = null; if (!poly || poly.length < 3) { sel = null; showSelMenu(); return; }
    const ids = new Set(), tids = new Set();
    for (const s of page.strokes) { let inside = 0, n = 0; for (let i = 0; i < s.pts.length; i += 9) { n++; if (inPoly(s.pts[i], s.pts[i + 1], poly)) inside++; } if (n && inside / n >= 0.5) ids.add(s.id); }
    for (const t of page.texts) if (inPoly(t.x + 10, t.y + 10, poly)) tids.add(t.id);
    sel = ids.size || tids.size ? { ids, tids } : null; renderTexts(); showSelMenu(); dirty = true;
  }
  const inSel = (x, y) => { if (!sel) return false; const [a, b, c, d] = selBox(); return x > a - 14 && x < c + 14 && y > b - 14 && y < d + 14; };

  // ----- gomma -----
  const eraserR = () => sizeOf("eraser") / cam.z * (st.eraserMode === "pixel" ? 1 : 0.6);
  let eraserAt = null;
  function eraseAt(x, y) {
    const r = eraserR(); let hit = false;
    if (st.eraserMode === "object") { const keep = page.strokes.filter(s => !hitStroke(s, x, y, r)); hit = keep.length !== page.strokes.length; page.strokes = keep; }
    else {
      const out = [];
      for (const s of page.strokes) {
        if (!hitStroke(s, x, y, r)) { out.push(s); continue; } hit = true;
        let run = []; const flush = () => { if (run.length >= 3) out.push(makeStroke(s.t, s.c, s.s, run)); run = []; };
        for (let i = 0; i < s.pts.length; i += 3) { if (Math.hypot(s.pts[i] - x, s.pts[i + 1] - y) < r + s.s * 0.5) flush(); else run.push(s.pts[i], s.pts[i + 1], s.pts[i + 2]); }
        flush();
      }
      page.strokes = out;
    }
    if (hit) changed();
  }

  // ----- input: Pencil scrive, dito scorre/zooma -----
  let cur = null, penId = null, penDown = false, holdT = 0, quickT = 0, lastMove = 0, rulerSide = 0, startPt = null, erasing = false, moved = false;
  const touches = new Map(); let gesture = null, momentum = 0;
  const isDrawPointer = e => e.pointerType === "pen" || e.pointerType === "mouse" || (e.pointerType === "touch" && st.fingerDraw && !touches.size);
  const local = e => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  stage.addEventListener("pointerdown", e => {
    if (e.target.closest(".ink-selmenu, .ink-quick")) return;
    if (e.target.classList.contains("ink-text") && st.tool === "text") return;
    if (e.pointerType === "touch" && penDown) return; // palmo appoggiato mentre si scrive
    if (e.pointerType === "mouse" && e.button !== 0) return;
    cancelAnimationFrame(momentum); closeQuick();
    const [sx, sy] = local(e);
    const selTouch = e.pointerType === "touch" && !touches.size && sel && inSel(...toPage(sx, sy));
    if (selTouch || (isDrawPointer(e) && !(e.pointerType === "touch" && onRuler(sx, sy)))) {
      e.preventDefault(); try { stage.setPointerCapture(e.pointerId); } catch {}
      penId = e.pointerId; penDown = true; moved = false; startPt = [sx, sy];
      const [x, y] = toPage(sx, sy), p = e.pointerType === "pen" ? (e.pressure || 0.5) : 0.5;
      if (sel && inSel(x, y)) { drag = { x0: x, y0: y, dx: 0, dy: 0, before: snap() }; dirty = true; schedule(); return; }
      if (sel) { sel = null; renderTexts(); showSelMenu(); dirty = true; }
      const t = st.tool;
      if (t === "text") { pushUndo(); addText(x, y); penDown = false; return; }
      if (t === "lasso") { lasso = [[x, y]]; schedule(); return; }
      if (t === "eraser") { pushUndo(); erasing = true; eraserAt = [x, y]; eraseAt(x, y); schedule(); return; }
      rulerSide = 0;
      if (st.ruler) { const [, ly] = rulerLocal(sx, sy); if (Math.abs(Math.abs(ly) - RW / 2) < 34) rulerSide = Math.sign(ly) || 1; }
      cur = makeStroke(t, colorOf(t), sizeOf(t), []); cur.pts = []; addPt(sx, sy, p);
      quickT = setTimeout(() => { if (!moved && cur) { cur = null; showQuick(sx, sy); penDown = false; schedule(); } }, 520);
      return;
    }
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: sx, y: sy, x0: sx, y0: sy });
      if (!gesture || touches.size > gesture.max) startGesture(sx, sy);
    }
  }, { passive: false });
  function addPt(sx, sy, p) {
    if (rulerSide) { const [lx] = rulerLocal(sx, sy); [sx, sy] = rulerWorld(lx, rulerSide * (RW / 2 + sizeOf(cur.t) / 2)); }
    const [x, y] = toPage(sx, sy); const n = cur.pts.length;
    if (n && Math.hypot(cur.pts[n - 3] - x, cur.pts[n - 2] - y) < 0.6 / cam.z) return;
    cur.pts.push(x, y, p); pathCache.delete(cur);
  }
  stage.addEventListener("pointermove", e => {
    const [sx, sy] = local(e);
    if (e.pointerId === penId && penDown) {
      e.preventDefault();
      if (Math.hypot(sx - startPt[0], sy - startPt[1]) > 4) { moved = true; clearTimeout(quickT); }
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; const list = evs.length ? evs : [e];
      if (drag) { const [x, y] = toPage(sx, sy); drag.dx = x - drag.x0; drag.dy = y - drag.y0; schedule(); return; }
      if (lasso) { lasso.push(toPage(sx, sy)); schedule(); return; }
      if (erasing) { for (const ev of list) { const [ax, ay] = local(ev); const [x, y] = toPage(ax, ay); eraserAt = [x, y]; eraseAt(x, y); } schedule(); return; }
      if (cur && !cur.shape) {
        for (const ev of list) { const [ax, ay] = local(ev); addPt(ax, ay, ev.pointerType === "pen" ? (ev.pressure || 0.5) : 0.5); }
        clearTimeout(holdT); lastMove = performance.now();
        holdT = setTimeout(() => { if (cur && penDown && moved) { const r = recognize(cur.pts); if (r) { cur.pts = r.pts; cur.shape = r.kind; cur.bb = bbox(cur.pts); pathCache.delete(cur); say("Forma: " + r.kind); schedule(); } } }, 550);
        schedule();
      }
      return;
    }
    const t = touches.get(e.pointerId); if (!t) return;
    e.preventDefault(); t.x = sx; t.y = sy; moveGesture();
  }, { passive: false });
  const endPointer = e => {
    if (e.pointerId === penId) {
      clearTimeout(holdT); clearTimeout(quickT); penId = null; penDown = false;
      if (drag) { const { dx, dy, before } = drag; drag = null; if (Math.abs(dx) + Math.abs(dy) > 0.5) { undoS.push(before); redoS.length = 0; updUndo(); page.strokes = page.strokes.map(s => sel.ids.has(s.id) ? Object.assign(makeStroke(s.t, s.c, s.s, s.pts.map((v, i) => i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v), s.shape ? { shape: s.shape } : null), { id: s.id }) : s); page.texts.forEach(t => { if (sel.tids.has(t.id)) { t.x += dx; t.y += dy; } }); renderTexts(); changed(); } dirty = true; schedule(); return; }
      if (lasso) { finishLasso(); schedule(); return; }
      if (erasing) { erasing = false; eraserAt = null; schedule(); return; }
      if (cur && cur.pts.length) {
        pushUndo(); cur.bb = bbox(cur.pts); const s = cur; cur = null; page.strokes.push(s);
        if (s.bb[3] > page.h - 160) page.h += 800; // il foglio si allunga da solo
        if (s.bb[2] > page.w - 40 && opts.autoWiden !== false && (page.paper.size === "inf")) page.w += 400;
        changed();
      }
      cur = null; schedule(); return;
    }
    if (touches.has(e.pointerId)) { touches.delete(e.pointerId); if (!touches.size) endGesture(); else startGesture(); }
  };
  stage.addEventListener("pointerup", endPointer); stage.addEventListener("pointercancel", endPointer);

  function startGesture() {
    const pts = [...touches.values()]; const max = Math.max(gesture ? gesture.max : 0, pts.length);
    const t0 = gesture ? gesture.t0 : performance.now(), travel = gesture ? gesture.travel : 0;
    const mid = pts.reduce((a, p) => [a[0] + p.x / pts.length, a[1] + p.y / pts.length], [0, 0]);
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0, ang = pts.length > 1 ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) : 0;
    const ruler = gesture ? gesture.ruler : !!(st.ruler && pts.length && onRuler(pts[0].x, pts[0].y));
    gesture = { max, t0, travel, mid, dist, ang, cam: { ...cam }, ruler, r0: st.ruler ? { ...st.ruler } : null, vel: [0, 0], lt: performance.now(), lm: mid };
  }
  function moveGesture() {
    const pts = [...touches.values()], g = gesture; if (!g || !pts.length) return;
    const mid = pts.reduce((a, p) => [a[0] + p.x / pts.length, a[1] + p.y / pts.length], [0, 0]);
    g.travel = Math.max(g.travel, ...pts.map(p => Math.hypot(p.x - p.x0, p.y - p.y0)));
    if (g.ruler) {
      st.ruler.cx = g.r0.cx + mid[0] - g.mid[0]; st.ruler.cy = g.r0.cy + mid[1] - g.mid[1];
      if (pts.length > 1) { let a = g.r0.a + Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) - g.ang; const deg = a * 180 / Math.PI, snapd = Math.round(deg / 45) * 45; if (Math.abs(deg - snapd) < 2.5) a = snapd * Math.PI / 180; st.ruler.a = a; }
      schedule(); return;
    }
    if (g.travel < 6) return;
    let z = g.cam.z;
    if (pts.length > 1 && g.dist > 0) z = clamp(g.cam.z * Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / g.dist, 0.25, 5);
    const px = (g.mid[0] - g.cam.tx) / g.cam.z, py = (g.mid[1] - g.cam.ty) / g.cam.z;
    cam.z = z; cam.tx = mid[0] - px * z; cam.ty = mid[1] - py * z; clampCam();
    const now = performance.now(), dt = Math.max(1, now - g.lt); g.vel = [(mid[0] - g.lm[0]) / dt, (mid[1] - g.lm[1]) / dt]; g.lt = now; g.lm = mid;
    dirty = true; schedule();
  }
  function endGesture() {
    const g = gesture; gesture = null; if (!g) return;
    const quick = performance.now() - g.t0 < 320 && g.travel < 12;
    if (quick && g.max === 2) return undo();
    if (quick && g.max === 3) return redo();
    if (g.ruler) return;
    let [vx, vy] = g.vel; if (performance.now() - g.lt > 80) return;
    const step = () => { vx *= 0.95; vy *= 0.95; cam.tx += vx * 16; cam.ty += vy * 16; const before = [cam.tx, cam.ty]; clampCam(); if (before[0] !== cam.tx) vx = 0; if (before[1] !== cam.ty) vy = 0; dirty = true; schedule(); if (Math.hypot(vx, vy) > 0.02) momentum = requestAnimationFrame(step); };
    momentum = requestAnimationFrame(step);
  }
  stage.addEventListener("wheel", e => {
    e.preventDefault(); const [sx, sy] = local(e);
    if (e.ctrlKey) { const z = clamp(cam.z * Math.exp(-e.deltaY * 0.01), 0.25, 5), px = (sx - cam.tx) / cam.z, py = (sy - cam.ty) / cam.z; cam.z = z; cam.tx = sx - px * z; cam.ty = sy - py * z; }
    else { cam.tx -= e.deltaX; cam.ty -= e.deltaY; }
    clampCam(); dirty = true; schedule();
  }, { passive: false });
  stage.addEventListener("touchstart", e => { if (e.target.closest(".ink-text[contenteditable=true], .ink-selmenu, .ink-quick")) return; e.preventDefault(); }, { passive: false }); // niente zoom/selezione di Safari

  // ----- strumenti rapidi (penna tenuta ferma) -----
  let quick = null;
  function closeQuick() { if (quick) { quick.remove(); quick = null; } }
  function showQuick(sx, sy) {
    closeQuick();
    quick = el("div", { class: "ink-quick", style: `left:${clamp(sx - 150, 8, W - 308)}px;top:${clamp(sy - 120, 8, H - 130)}px` },
      el("div", { class: "row" }, ...["pen", "fountain", "pencil", "marker", "eraser", "lasso"].map(t => el("button", { class: "qt" + (st.tool === t ? " on" : ""), "aria-label": TOOLS[t][0], html: svg(t, colorOf(t)), onclick: () => { setTool(t); closeQuick(); } }))),
      el("div", { class: "row" }, ...(st.tool === "marker" ? HL_COLORS : COLORS).map(c => el("button", { class: "dot", style: `background:${c}`, "aria-label": "Colore " + c, onclick: () => { st.colors[st.tool === "eraser" || st.tool === "lasso" ? "pen" : st.tool] = c; persist(); buildBar(); closeQuick(); } }))));
    stage.append(quick);
  }

  // ----- barre -----
  const undoB = el("button", { class: "ib", "aria-label": "Annulla", onclick: undo }, "↶"), redoB = el("button", { class: "ib", "aria-label": "Ripristina", onclick: redo }, "↷");
  const updUndo = () => { undoB.disabled = !undoS.length; redoB.disabled = !redoS.length; };
  const swapB = el("button", { class: "ib", title: "Come il doppio tocco della Pencil: passa alla gomma e torna indietro", "aria-label": "Scambia strumento", onclick: () => swapTool() }, "⇄");
  function swapTool() { if (st.tool === "eraser") setTool(st.prev && st.prev !== "eraser" ? st.prev : "pen"); else { st.prev = st.tool; setTool("eraser"); } say(TOOLS[st.tool][0]); }
  function setTool(t) { if (t !== st.tool && t !== "eraser") st.prev = t; if (st.tool !== "eraser" && t === "eraser") st.prev = st.tool; st.tool = t; persist(); buildBar(); renderTexts(); if (t !== "lasso" && sel) { sel = null; showSelMenu(); dirty = true; schedule(); } }
  const paperB = el("button", { class: "ib", "aria-label": "Foglio", onclick: () => paperMenu() }, "▦");
  const moreB = el("button", { class: "ib", "aria-label": "Altro", onclick: () => moreMenu() }, "⋯");
  top.append(...(opts.header ? [opts.header] : []), el("div", { class: "grow" }), undoB, redoB, swapB, paperB, moreB); updUndo();
  let pop = null; const closePop = () => { if (pop) { pop.remove(); pop = null; } };
  function popup(anchor, ...kids) { closePop(); pop = el("div", { class: "ink-pop" }, ...kids); root.append(pop); const r = anchor.getBoundingClientRect(), rr = root.getBoundingClientRect(); pop.style.left = clamp(r.left - rr.left - 120, 8, rr.width - 288) + "px"; if (anchor.closest(".ink-bar")) pop.style.bottom = (rr.bottom - r.top + 8) + "px"; else pop.style.top = (r.bottom - rr.top + 8) + "px"; }
  root.addEventListener("pointerdown", e => { if (pop && !e.target.closest(".ink-pop, .ib, .tool")) closePop(); }, true);
  function paperMenu() {
    const p = page.paper; const seg = (vals, curv, fn) => el("div", { class: "seg" }, ...Object.entries(vals).map(([k, v]) => el("button", { class: curv === k ? "on" : "", onclick: () => { pushUndo(); fn(k); changed(); paperMenu(); } }, v)));
    popup(paperB, el("b", null, "Foglio"), seg(PAPERS, p.type, k => p.type = k),
      el("div", { class: "mut" }, "Distanza righe"), seg({ 24: "Stretta", 32: "Media", 44: "Larga" }, String(p.gap), k => p.gap = +k),
      el("div", { class: "mut" }, "Colore"), seg({ "#ffffff": "Bianco", "#fdf8e7": "Crema", "#1c1c1e": "Scuro" }, p.color, k => p.color = k),
      el("div", { class: "mut" }, `Dimensione: ${Math.round(page.w)} × ${Math.round(page.h)}`),
      el("div", { class: "row" }, el("button", { onclick: () => { pushUndo(); page.w += 400; changed(); paperMenu(); } }, "Allarga →"), el("button", { onclick: () => { pushUndo(); page.h += 800; changed(); paperMenu(); } }, "Allunga ↓"), el("button", { onclick: () => { fit(); clampCam(); dirty = true; schedule(); } }, "Adatta")));
  }
  function moreMenu() {
    popup(moreB, el("label", { class: "row" }, el("input", { type: "checkbox", ...(st.fingerDraw ? { checked: "" } : {}), onchange: e => { st.fingerDraw = e.target.checked; persist(); } }), " Scrivi anche col dito (senza Apple Pencil)"),
      el("div", { class: "mut" }, "Pencil: scrive · dito: scorre, pizzica per lo zoom · 2 dita tocco: annulla · 3 dita: ripristina · penna ferma all'inizio: strumenti rapidi · penna ferma a fine tratto: forma perfetta"),
      el("button", { onclick: () => { closePop(); exportPNG(); } }, "Esporta immagine (PNG)"),
      el("button", { class: "danger", onclick: () => { pushUndo(); page.strokes = []; page.texts = []; renderTexts(); changed(); closePop(); } }, "Svuota pagina"));
  }
  function buildBar() {
    const t = st.tool;
    const tools = ["pen", "fountain", "pencil", "marker", "eraser", "lasso", "text"].map(k => el("button", { class: "tool" + (t === k ? " on" : ""), "aria-label": TOOLS[k][0], title: TOOLS[k][0], html: svg(k, colorOf(k)), onclick: ev => { if (st.tool === k) toolPop(ev.currentTarget, k); else setTool(k); } }));
    const ruler = el("button", { class: "tool" + (st.ruler ? " on" : ""), "aria-label": "Righello", title: "Righello", html: svg("ruler"), onclick: () => { st.ruler = st.ruler ? null : { cx: W / 2, cy: H / 2, a: -Math.PI / 12 }; buildBar(); schedule(); } });
    const pal = (t === "marker" ? HL_COLORS : COLORS).map(c => el("button", { class: "dot" + (colorOf(t === "eraser" || t === "lasso" || t === "text" ? "pen" : t) === c ? " on" : ""), style: `background:${c}`, "aria-label": "Colore " + c, onclick: () => { st.colors[t === "eraser" || t === "lasso" ? "pen" : t] = c; persist(); buildBar(); } }));
    const custom = el("input", { type: "color", "aria-label": "Altro colore", value: colorOf(t === "marker" ? "marker" : "pen"), oninput: e => { st.colors[t === "eraser" || t === "lasso" ? "pen" : t] = e.target.value; persist(); } , onchange: () => buildBar() });
    const sizes = (t === "lasso" || t === "text") ? [] : [0.5, 1, 2].map(m => { const base = TOOLS[t][1], v = +(base * m).toFixed(1); return el("button", { class: "sz" + (Math.abs(sizeOf(t) - v) < 0.05 ? " on" : ""), "aria-label": "Spessore " + v, onclick: () => { st.sizes[t] = v; persist(); buildBar(); } }, el("i", { style: `width:${4 + m * 5}px;height:${4 + m * 5}px` })); });
    bar.replaceChildren(el("div", { class: "grp" }, ...tools, ruler), el("div", { class: "grp" }, ...pal, custom), el("div", { class: "grp" }, ...sizes));
  }
  function toolPop(anchor, k) {
    const range = el("input", { type: "range", min: k === "eraser" ? 4 : 0.5, max: k === "eraser" ? 60 : k === "marker" ? 20 : 14, step: 0.5, value: sizeOf(k), oninput: e => { st.sizes[k] = +e.target.value; persist(); val.textContent = e.target.value; }, onchange: () => buildBar() });
    const val = el("span", null, String(sizeOf(k)));
    popup(anchor, el("b", null, TOOLS[k][0]), k !== "lasso" && k !== "text" && el("div", { class: "row" }, "Spessore ", range, val),
      k === "eraser" && el("div", { class: "seg" }, ...[["object", "Gomma a oggetto"], ["pixel", "Gomma a pixel"]].map(([m, n]) => el("button", { class: st.eraserMode === m ? "on" : "", onclick: () => { st.eraserMode = m; persist(); toolPop(anchor, k); } }, n))),
      k === "text" && el("div", { class: "mut" }, "Tocca il foglio per scrivere con la tastiera."), k === "lasso" && el("div", { class: "mut" }, "Cerchia tratti o testi, poi trascinali."));
  }

  // ----- esporta -----
  function exportPNG() {
    const s = Math.min(2, Math.sqrt(16e6 / (page.w * page.h))), c = document.createElement("canvas"); c.width = Math.round(page.w * s); c.height = Math.round(page.h * s);
    const x = c.getContext("2d"); x.scale(s, s); drawPaper(x, page, 0, 0, page.w, page.h, 1); for (const st2 of page.strokes) drawStroke(x, st2);
    for (const t of page.texts) { x.fillStyle = t.color; x.font = `${t.size}px -apple-system,system-ui,sans-serif`; (t.text || "").split("\n").forEach((l, i) => x.fillText(l, t.x, t.y + t.size * (1 + i * 1.3))); }
    c.toBlob(async b => { const f = new File([b], (page.title || "appunti") + ".png", { type: "image/png" }); try { if (navigator.canShare && navigator.canShare({ files: [f] })) return await navigator.share({ files: [f] }); } catch {} const a = el("a", { href: URL.createObjectURL(b), download: f.name }); document.body.append(a); a.click(); a.remove(); }, "image/png");
  }

  buildBar(); renderTexts();
  const ro = new ResizeObserver(resize); ro.observe(stage); resize();
  return {
    el: root, undo, redo, setTool, swapTool, exportPNG, get page() { return page; }, get state() { return st; }, cam: () => ({ ...cam }),
    destroy() { ro.disconnect(); cancelAnimationFrame(raf); cancelAnimationFrame(momentum); clearTimeout(saveT); opts.onChange && opts.onChange(page); root.remove(); },
  };
}

export const INK_CSS = `
.ink{display:flex;flex-direction:column;height:100%;min-height:0;background:#d8d8dd;position:relative;font-family:-apple-system,"SF Pro Text",system-ui,sans-serif;color:#1c1c1e;-webkit-user-select:none;user-select:none}
.ink-top{display:flex;align-items:center;gap:4px;padding:6px 10px;background:rgba(248,248,250,.92);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid rgba(0,0,0,.08);z-index:3}
.ink-top .grow{flex:1}
.ink .ib{min-width:44px;min-height:44px;border:0;background:transparent;color:#0a84ff;font-size:24px;border-radius:10px;margin:0;padding:0 8px}
.ink .ib:disabled{color:#c7c7cc}.ink .ib:active{background:rgba(0,0,0,.06)}
.ink-stage{flex:1;position:relative;overflow:hidden;touch-action:none;min-height:0}
.ink-c{position:absolute;left:0;top:0}
.ink-texts{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none}
.ink-text{position:absolute;min-height:1.3em;line-height:1.3;outline:none;white-space:pre-wrap;word-break:break-word;font-family:-apple-system,"SF Pro Text",system-ui,sans-serif}
.ink-text[contenteditable=true]{pointer-events:auto;-webkit-user-select:text;user-select:text;border:1px dashed rgba(10,132,255,.5);border-radius:4px;padding:2px 4px;margin:-3px -5px}
.ink-text.sel{outline:2px solid #0a84ff;border-radius:4px}
.ink-bar{display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:nowrap;overflow-x:auto;padding:6px 12px calc(6px + env(safe-area-inset-bottom));background:rgba(248,248,250,.94);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-top:1px solid rgba(0,0,0,.08);z-index:3}
.ink-bar .grp{display:flex;align-items:flex-end;gap:2px;flex-shrink:0}
.ink .tool{border:0;background:transparent;padding:0 3px;margin:0;min-height:52px;display:flex;align-items:flex-end;transition:transform .18s cubic-bezier(.3,.7,.3,1.3)}
.ink .tool svg{display:block}.ink .tool.on{transform:translateY(-8px)}
.ink .dot{width:28px;height:28px;min-height:28px;border-radius:50%;border:2px solid rgba(0,0,0,.12);padding:0;margin:4px 3px}
.ink .dot.on{box-shadow:0 0 0 2px #fff,0 0 0 4px #0a84ff}
.ink input[type=color]{width:30px;height:30px;border:0;padding:0;background:none;margin:0 4px}
.ink .sz{width:34px;height:40px;min-height:40px;border:0;background:transparent;display:flex;align-items:center;justify-content:center;padding:0;margin:0;border-radius:8px}
.ink .sz i{display:block;border-radius:50%;background:#1c1c1e}.ink .sz.on{background:rgba(10,132,255,.15)}
.ink-pop{position:absolute;z-index:6;width:280px;background:rgba(255,255,255,.97);backdrop-filter:blur(20px);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);padding:12px;display:flex;flex-direction:column;gap:8px;animation:inkPop .18s ease-out}
.ink-pop button{min-height:40px;border-radius:9px;border:0;background:#f2f2f7;color:#1c1c1e;font:inherit;margin:0;padding:6px 10px}
.ink-pop button.danger{background:#ffe5e5;color:#d70015}.ink-pop .mut{color:#8e8e93;font-size:13px}
.ink-pop .seg{display:flex;background:#eeeef0;border-radius:9px;padding:2px;gap:2px}.ink-pop .seg button{flex:1;background:transparent;font-size:14px;padding:4px}
.ink-pop .seg button.on{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.ink-pop .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.ink-pop input[type=range]{flex:1}
.ink-quick{position:absolute;z-index:7;background:rgba(255,255,255,.97);border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:8px;display:flex;flex-direction:column;gap:4px;animation:inkPop .2s cubic-bezier(.3,.7,.3,1.3)}
.ink-quick .row{display:flex;gap:2px;align-items:flex-end}
.ink-quick .qt{border:0;background:transparent;padding:2px 6px;border-radius:10px;min-height:48px;margin:0}.ink-quick .qt.on{background:rgba(10,132,255,.15)}
.ink-selmenu{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:5;display:flex;gap:4px;align-items:center;background:#1c1c1e;border-radius:12px;padding:4px 6px;box-shadow:0 6px 24px rgba(0,0,0,.3);animation:inkPop .18s ease-out}
.ink-selmenu button{background:transparent;color:#fff;border:0;min-height:38px;font:inherit;font-size:15px;padding:0 10px;margin:0}
.ink-selmenu .dot{width:22px;height:22px;min-height:22px;border-color:rgba(255,255,255,.4)}
.ink-toast{position:absolute;top:14px;left:50%;transform:translate(-50%,-10px);background:rgba(28,28,30,.85);color:#fff;padding:6px 14px;border-radius:20px;font-size:14px;opacity:0;transition:.2s;pointer-events:none;z-index:6}
.ink-toast.show{opacity:1;transform:translate(-50%,0)}
@keyframes inkPop{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}
.ink-selmenu{animation:none}
`;
