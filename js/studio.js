/*
 * Clothing Design Studio v2.
 * Layers (text, symbols, uploaded art) you drag, resize, rotate, front and back,
 * five garments, any color, fabric texture, and a straight "upload my art" path.
 */
(function () {
  "use strict";
  const cv = document.getElementById("st-canvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = 480, H = 540, SC = 2;          // logical size, export scale
  cv.width = W * SC; cv.height = H * SC;
  const $ = (s) => document.querySelector(s);
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const GARMENTS = { tee: "T-shirt", long: "Long sleeve", hoodie: "Hoodie", crew: "Sweatshirt", tank: "Tank" };
  const COLORS = ["#111111", "#f3ecdc", "#ffffff", "#d4a843", "#7a1f2b", "#1f3d7a", "#2f6b45", "#555a63", "#e58a5c", "#6b3fa0"];
  const FONTS = { "Cinzel": "Classic serif", "Cinzel Decorative": "Ornate", "Hanken Grotesk": "Modern", "Cormorant Garamond": "Elegant italic", "Impact": "Bold block", "Brush Script MT": "Script", "Courier New": "Typewriter" };
  const SYMS = { emblem: "All-seeing eye", compass: "Square & compass", star: "Star", crown: "Crown", flame: "Flame", bolt: "Bolt" };
  const PLACE = { chest: [240, 190, 150], left: [330, 150, 60], full: [240, 280, 300], low: [240, 360, 170] };

  const S = { garment: "tee", color: "#111111", texture: "none", view: "front", layers: [], sel: null, uid: 1, art: null, dirty: false };
  const imgs = new Map();                   // layer id -> HTMLImageElement
  let drag = null;

  /* ---------- garments ---------- */
  function path(kind, back) {
    ctx.beginPath();
    const nk = back ? 55 : 85;
    if (kind === "hoodie") { ctx.moveTo(150, 70); ctx.quadraticCurveTo(240, 10, 330, 70); ctx.lineTo(430, 120); ctx.lineTo(470, 330); ctx.lineTo(405, 345); ctx.lineTo(380, 200); ctx.lineTo(385, 520); ctx.lineTo(95, 520); ctx.lineTo(100, 200); ctx.lineTo(75, 345); ctx.lineTo(10, 330); ctx.lineTo(50, 120); ctx.closePath(); }
    else if (kind === "long" || kind === "crew") { ctx.moveTo(165, 40); ctx.quadraticCurveTo(240, nk, 315, 40); ctx.lineTo(430, 95); ctx.lineTo(472, 350); ctx.lineTo(406, 362); ctx.lineTo(385, 215); ctx.lineTo(388, kind === "crew" ? 500 : 515); ctx.lineTo(92, kind === "crew" ? 500 : 515); ctx.lineTo(95, 215); ctx.lineTo(74, 362); ctx.lineTo(8, 350); ctx.lineTo(50, 95); ctx.closePath(); }
    else if (kind === "tank") { ctx.moveTo(190, 22); ctx.quadraticCurveTo(240, back ? 60 : 118, 290, 22); ctx.lineTo(338, 22); ctx.lineTo(352, 120); ctx.quadraticCurveTo(352, 190, 390, 205); ctx.lineTo(388, 510); ctx.lineTo(92, 510); ctx.lineTo(90, 205); ctx.quadraticCurveTo(128, 190, 128, 120); ctx.lineTo(142, 22); ctx.closePath(); }
    else { ctx.moveTo(165, 40); ctx.quadraticCurveTo(240, nk, 315, 40); ctx.lineTo(440, 90); ctx.lineTo(475, 200); ctx.lineTo(395, 225); ctx.lineTo(385, 510); ctx.lineTo(95, 510); ctx.lineTo(85, 225); ctx.lineTo(5, 200); ctx.lineTo(40, 90); ctx.closePath(); }
  }
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000; };
  let noise = null;
  function noisePat() {
    if (noise) return noise;
    const n = document.createElement("canvas"); n.width = n.height = 96; const c = n.getContext("2d"), d = c.createImageData(96, 96);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 34; }
    c.putImageData(d, 0, 0); noise = ctx.createPattern(n, "repeat"); return noise;
  }
  function drawGarment() {
    const g = S.garment, back = S.view === "back", dark = lum(S.color) < 90;
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 24; ctx.shadowOffsetY = 10; path(g, back); ctx.fillStyle = S.color; ctx.fill(); ctx.restore();
    path(g, back); ctx.save(); ctx.clip();
    const sh = ctx.createLinearGradient(0, 0, W, 0); sh.addColorStop(0, "rgba(0,0,0,.28)"); sh.addColorStop(.3, "rgba(255,255,255,.07)"); sh.addColorStop(.62, "rgba(0,0,0,0)"); sh.addColorStop(1, "rgba(0,0,0,.32)"); ctx.fillStyle = sh; ctx.fillRect(0, 0, W, H);
    const vg = ctx.createLinearGradient(0, 0, 0, H); vg.addColorStop(0, "rgba(255,255,255,.06)"); vg.addColorStop(1, "rgba(0,0,0,.18)"); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    if (S.texture === "heather") { ctx.fillStyle = noisePat(); ctx.globalCompositeOperation = dark ? "screen" : "multiply"; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = "source-over"; }
    ctx.strokeStyle = "rgba(0,0,0,.18)"; ctx.lineWidth = 2;               // soft folds
    [[150, 300, 175, 470], [320, 280, 300, 480], [240, 330, 235, 500]].forEach(([a, b, c, d]) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.quadraticCurveTo((a + c) / 2 + 12, (b + d) / 2, c, d); ctx.stroke(); });
    // collars, cuffs, hems
    const rib = dark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.09)"; ctx.fillStyle = rib;
    if (g === "crew" || g === "hoodie") { ctx.fillRect(90, g === "hoodie" ? 470 : 470, 300, 50); ctx.fillRect(0, 338, 76, 28); ctx.fillRect(404, 338, 76, 28); }
    if (g === "long") { ctx.fillRect(0, 340, 76, 20); ctx.fillRect(404, 340, 76, 20); }
    ctx.restore();
    ctx.strokeStyle = "rgba(0,0,0,.4)"; ctx.lineWidth = 2; path(g, back); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.32)";
    if (g === "hoodie" && !back) { ctx.beginPath(); ctx.moveTo(190, 78); ctx.quadraticCurveTo(240, 150, 290, 78); ctx.stroke(); ctx.beginPath(); ctx.moveTo(225, 120); ctx.lineTo(222, 175); ctx.moveTo(255, 120); ctx.lineTo(258, 175); ctx.stroke(); ctx.fillStyle = "rgba(0,0,0,.10)"; ctx.beginPath(); ctx.moveTo(150, 400); ctx.lineTo(330, 400); ctx.lineTo(345, 470); ctx.lineTo(135, 470); ctx.closePath(); ctx.fill(); }
    if (g === "hoodie" && back) { ctx.beginPath(); ctx.moveTo(165, 72); ctx.quadraticCurveTo(240, 40, 315, 72); ctx.stroke(); }
    if (g === "crew") { ctx.beginPath(); ctx.moveTo(165, 40); ctx.quadraticCurveTo(240, back ? 62 : 95, 315, 40); ctx.stroke(); }
    if (g === "tee" || g === "long") { ctx.beginPath(); ctx.moveTo(165, 40); ctx.quadraticCurveTo(240, back ? 58 : 92, 315, 40); ctx.stroke(); }
  }

  /* ---------- layers ---------- */
  function addLayer(l) { if (S.starter && !l.starter) { S.layers = S.layers.filter((x) => !x.starter); S.starter = false; } l.id = S.uid++; l.view = S.view; l.rot = 0; l.alpha = 1; S.layers.push(l); S.sel = l.id; S.dirty = true; ui(); draw(); return l; }
  const cur = () => S.layers.find((l) => l.id === S.sel);
  const visible = () => S.layers.filter((l) => l.view === S.view);
  function addText() { addLayer({ type: "text", text: "YOUR TEXT", font: "Cinzel", color: "#d4a843", size: 40, x: 240, y: 200, outline: "#000000", outlineW: 0, curve: 0, shadow: false, spacing: 0, bold: true }); }
  function addSym(kind) { addLayer({ type: "sym", sym: kind, color: "#d4a843", size: 120, x: 240, y: 260 }); }
  function addImage(file, asArt) {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const r = Math.min(170 / img.width, 170 / img.height);
      const l = addLayer({ type: "img", w: img.width * r, h: img.height * r, size: 100, x: 240, y: 230, name: file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "My art" });
      imgs.set(l.id, img);
      if (!S.art) S.art = { img, name: l.name };
      if (asArt) { const t = $("#st-title"); if (t && !t.value) t.value = l.name; }
    };
    img.onerror = () => say("That file isn't an image we can read. Use PNG, JPG, or WEBP.");
    img.src = url;
  }
  function say(t) { if (typeof toast === "function") toast(t); }

  function textFont(l, sz) { return `${l.bold ? "700" : "400"} ${sz}px "${l.font}", Georgia, serif`; }
  function drawLayer(l, forExport) {
    ctx.save(); ctx.translate(l.x, l.y); ctx.rotate((l.rot * Math.PI) / 180); ctx.globalAlpha = l.alpha;
    let bw = 40, bh = 40;
    if (l.type === "text") {
      const sz = l.size; ctx.font = textFont(l, sz); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (l.spacing) ctx.letterSpacing = l.spacing + "px";
      if (l.shadow) { ctx.shadowColor = "rgba(0,0,0,.65)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3; }
      const tw = ctx.measureText(l.text).width; bw = Math.max(tw, 20); bh = sz * 1.1;
      const stroke = () => { if (l.outlineW > 0) { ctx.lineWidth = l.outlineW * 2; ctx.strokeStyle = l.outline; ctx.lineJoin = "round"; return true; } return false; };
      if (!l.curve) { if (stroke()) ctx.strokeText(l.text, 0, 0); ctx.fillStyle = l.color; ctx.fillText(l.text, 0, 0); }
      else {
        const R = 9000 / Math.abs(l.curve) + sz * 0.2, dir = l.curve > 0 ? 1 : -1, total = tw / R; let a = -total / 2;
        for (const ch of l.text) { const cw = ctx.measureText(ch).width, ang = a + cw / R / 2; ctx.save(); ctx.rotate(ang * dir); ctx.translate(0, -dir * R); ctx.rotate(0); if (dir < 0) ctx.rotate(0);
          if (stroke()) ctx.strokeText(ch, 0, 0); ctx.fillStyle = l.color; ctx.fillText(ch, 0, 0); ctx.restore(); a += cw / R; }
        bh = sz * 1.1 + Math.min(R * (1 - Math.cos(Math.min(total / 2, 1.5))), 160);
      }
      if (l.spacing) ctx.letterSpacing = "0px";
    } else if (l.type === "sym") {
      if (typeof drawSymbol === "function" && (l.sym === "emblem" || l.sym === "compass")) drawSymbol(ctx, l.sym, 0, 0, l.size, l.color);
      else drawShape(l);
      bw = bh = l.size;
    } else if (l.type === "img") {
      const img = imgs.get(l.id); if (img) { const k = l.size / 100, w = l.w * k, h = l.h * k; ctx.drawImage(img, -w / 2, -h / 2, w, h); bw = w; bh = h; }
    }
    ctx.restore(); l._bw = bw; l._bh = bh;
    if (!forExport && l.id === S.sel) {
      ctx.save(); ctx.translate(l.x, l.y); ctx.rotate((l.rot * Math.PI) / 180); ctx.strokeStyle = "#f0cf78"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.strokeRect(-bw / 2 - 6, -bh / 2 - 6, bw + 12, bh + 12); ctx.setLineDash([]);
      ctx.fillStyle = "#f0cf78"; ctx.beginPath(); ctx.arc(bw / 2 + 6, bh / 2 + 6, 9, 0, 7); ctx.fill(); ctx.fillStyle = "#0b0a08"; ctx.font = "700 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("⤡", bw / 2 + 6, bh / 2 + 6); ctx.restore();
    }
  }
  function drawShape(l) {
    const s = l.size / 2; ctx.fillStyle = l.color; ctx.strokeStyle = l.color; ctx.lineJoin = "round"; ctx.beginPath();
    if (l.sym === "star") { for (let i = 0; i < 10; i++) { const r = i % 2 ? s * .42 : s, a = -Math.PI / 2 + (i * Math.PI) / 5; ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.fill(); }
    else if (l.sym === "crown") { ctx.moveTo(-s, s * .6); ctx.lineTo(-s, -s * .3); ctx.lineTo(-s * .5, s * .1); ctx.lineTo(0, -s * .7); ctx.lineTo(s * .5, s * .1); ctx.lineTo(s, -s * .3); ctx.lineTo(s, s * .6); ctx.closePath(); ctx.fill(); }
    else if (l.sym === "flame") { ctx.moveTo(0, -s); ctx.bezierCurveTo(s * .9, -s * .2, s * .8, s * .9, 0, s); ctx.bezierCurveTo(-s * .8, s * .9, -s * .9, -s * .1, -s * .2, -s * .35); ctx.bezierCurveTo(-s * .2, -s * .6, 0, -s * .7, 0, -s); ctx.closePath(); ctx.fill(); }
    else if (l.sym === "bolt") { ctx.moveTo(s * .2, -s); ctx.lineTo(-s * .6, s * .15); ctx.lineTo(-s * .05, s * .15); ctx.lineTo(-s * .2, s); ctx.lineTo(s * .6, -s * .2); ctx.lineTo(s * .05, -s * .2); ctx.closePath(); ctx.fill(); }
  }

  function draw(forExport) {
    ctx.setTransform(SC, 0, 0, SC, 0, 0); ctx.clearRect(0, 0, W, H);
    if (forExport !== "plain") { const bg = ctx.createRadialGradient(240, 270, 40, 240, 270, 340); bg.addColorStop(0, "#2a2112"); bg.addColorStop(1, "#0b0a08"); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
    drawGarment(); visible().forEach((l) => drawLayer(l, !!forExport));
  }

  /* ---------- pointer: move, resize/rotate ---------- */
  function pos(e) { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; }
  function hit(p) {
    const s = cur();
    if (s && s.view === S.view) { const a = (-s.rot * Math.PI) / 180, dx = p.x - s.x, dy = p.y - s.y, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a); if (Math.hypot(lx - (s._bw / 2 + 6), ly - (s._bh / 2 + 6)) < 16) return { l: s, mode: "scale" }; }
    const vs = visible().slice().reverse();
    for (const l of vs) { const a = (-l.rot * Math.PI) / 180, dx = p.x - l.x, dy = p.y - l.y, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a); if (Math.abs(lx) <= (l._bw || 40) / 2 + 8 && Math.abs(ly) <= (l._bh || 40) / 2 + 8) return { l, mode: "move" }; }
    return null;
  }
  cv.addEventListener("pointerdown", (e) => {
    const p = pos(e), h = hit(p); cv.setPointerCapture(e.pointerId);
    if (!h) { S.sel = null; ui(); draw(); return; }
    S.sel = h.l.id; drag = { mode: h.mode, l: h.l, p0: p, x0: h.l.x, y0: h.l.y, size0: h.l.size, rot0: h.l.rot, d0: Math.hypot(p.x - h.l.x, p.y - h.l.y) || 1, a0: Math.atan2(p.y - h.l.y, p.x - h.l.x) }; ui(); draw(); e.preventDefault();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) return; const p = pos(e), l = drag.l;
    if (drag.mode === "move") { l.x = Math.max(0, Math.min(W, drag.x0 + p.x - drag.p0.x)); l.y = Math.max(0, Math.min(H, drag.y0 + p.y - drag.p0.y)); }
    else { const d = Math.hypot(p.x - l.x, p.y - l.y), a = Math.atan2(p.y - l.y, p.x - l.x); l.size = Math.max(10, Math.min(400, drag.size0 * (d / drag.d0))); l.rot = Math.round(drag.rot0 + ((a - drag.a0) * 180) / Math.PI); }
    S.dirty = true; draw(); syncSliders();
  });
  const end = () => { if (drag) { drag = null; ui(); } };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  cv.tabIndex = 0;
  cv.addEventListener("keydown", (e) => {
    const l = cur(); if (!l) return; const st = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") l.x -= st; else if (e.key === "ArrowRight") l.x += st; else if (e.key === "ArrowUp") l.y -= st; else if (e.key === "ArrowDown") l.y += st;
    else if (e.key === "Delete" || e.key === "Backspace") { remove(l.id); e.preventDefault(); return; } else return;
    e.preventDefault(); draw();
  });

  /* ---------- UI ---------- */
  function row(label, inner) { return `<div class="st-r"><label>${label}</label>${inner}</div>`; }
  function ui() {
    const g = $("#st-garments"), c = $("#st-colors");
    g.innerHTML = Object.entries(GARMENTS).map(([k, n]) => `<button type="button" class="chip" data-g="${k}" aria-pressed="${S.garment === k}">${n}</button>`).join("");
    c.innerHTML = COLORS.map((x) => `<button type="button" class="st-sw ${S.color === x ? "on" : ""}" data-c="${x}" style="background:${x}" aria-label="Garment color ${x}"></button>`).join("") + `<input type="color" id="st-cc" value="${S.color}" aria-label="Custom garment color">`;
    $("#st-tex").value = S.texture;
    $("#st-viewbtns").innerHTML = ["front", "back"].map((v) => `<button type="button" class="chip" data-v="${v}" aria-pressed="${S.view === v}">${v === "front" ? "Front" : "Back"}</button>`).join("");
    $("#st-layers").innerHTML = visible().length ? visible().slice().reverse().map((l) => `<div class="st-l ${l.id === S.sel ? "on" : ""}" data-sel="${l.id}"><span>${l.type === "text" ? "T  " + E(l.text.slice(0, 18)) : l.type === "img" ? "🖼  " + E(l.name || "Art") : "✦  " + E(SYMS[l.sym])}</span><span><button type="button" class="act" data-up="${l.id}" aria-label="Bring forward">↑</button><button type="button" class="act" data-down="${l.id}" aria-label="Send back">↓</button></span></div>`).join("") : `<p class="muted" style="margin:0;font-size:13px">Nothing on the ${S.view} yet. Add text, a symbol, or your art.</p>`;
    const l = cur(), p = $("#st-props");
    if (!l || l.view !== S.view) { p.innerHTML = `<p class="muted" style="margin:0;font-size:13px">Tap something on the shirt to edit it. Drag it to move. Drag the gold dot to resize and turn.</p>`; return; }
    let h = "";
    if (l.type === "text") h += row("Text", `<input type="text" id="sp-text" maxlength="40" value="${E(l.text)}">`) + row("Lettering", `<select id="sp-font">${Object.entries(FONTS).map(([k, n]) => `<option value="${k}" ${l.font === k ? "selected" : ""}>${n}</option>`).join("")}</select>`) + row("Curve", `<input type="range" id="sp-curve" min="-100" max="100" value="${l.curve}">`) + row("Spacing", `<input type="range" id="sp-spacing" min="-2" max="20" value="${l.spacing}">`) + row("Outline", `<span class="st-inl"><input type="color" id="sp-outline" value="${l.outline}"><input type="range" id="sp-outlinew" min="0" max="8" value="${l.outlineW}"></span>`) + row("Shadow", `<label class="st-chk"><input type="checkbox" id="sp-shadow" ${l.shadow ? "checked" : ""}> Soft shadow</label>`);
    if (l.type !== "img") h += row("Color", `<input type="color" id="sp-color" value="${l.color}">`);
    if (l.type === "sym") h += row("Symbol", `<select id="sp-sym">${Object.entries(SYMS).map(([k, n]) => `<option value="${k}" ${l.sym === k ? "selected" : ""}>${n}</option>`).join("")}</select>`);
    h += row("Size", `<input type="range" id="sp-size" min="10" max="400" value="${Math.round(l.size)}">`) + row("Turn", `<input type="range" id="sp-rot" min="-180" max="180" value="${l.rot}">`) + row("Opacity", `<input type="range" id="sp-alpha" min="10" max="100" value="${Math.round(l.alpha * 100)}">`);
    h += `<div class="st-r"><label>Place</label><span class="st-inl"><button type="button" class="act" data-place="chest">Chest</button><button type="button" class="act" data-place="left">Left chest</button><button type="button" class="act" data-place="full">Big</button><button type="button" class="act" data-place="low">Low</button><button type="button" class="act" data-center="1">Center</button></span></div>`;
    h += `<div class="st-r"><label></label><span class="st-inl"><button type="button" class="act" data-dup="1">Duplicate</button><button type="button" class="act" data-del="1">Delete</button></span></div>`;
    p.innerHTML = h;
  }
  function syncSliders() { const l = cur(); if (!l) return; const s = $("#sp-size"), r = $("#sp-rot"); if (s) s.value = Math.round(l.size); if (r) r.value = l.rot; }
  function remove(id) { S.layers = S.layers.filter((l) => l.id !== id); imgs.delete(id); S.sel = null; S.dirty = true; ui(); draw(); }

  $("#st-garments").addEventListener("click", (e) => { const b = e.target.closest("[data-g]"); if (b) { S.garment = b.dataset.g; ui(); draw(); } });
  $("#st-colors").addEventListener("click", (e) => { const b = e.target.closest("[data-c]"); if (b) { S.color = b.dataset.c; ui(); draw(); } });
  $("#st-colors").addEventListener("input", (e) => { if (e.target.id === "st-cc") { S.color = e.target.value; draw(); } });
  $("#st-colors").addEventListener("change", (e) => { if (e.target.id === "st-cc") ui(); });
  $("#st-tex").addEventListener("change", (e) => { S.texture = e.target.value; draw(); });
  $("#st-viewbtns").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) { S.view = b.dataset.v; S.sel = null; ui(); draw(); } });
  $("#st-add-text").addEventListener("click", addText);
  $("#st-add-sym").addEventListener("change", (e) => { if (e.target.value) addSym(e.target.value); e.target.value = ""; });
  ["#st-up-art", "#st-up-img"].forEach((id) => $(id).addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) addImage(f, id === "#st-up-art"); }));
  $("#st-layers").addEventListener("click", (e) => {
    const u = e.target.closest("[data-up]"), d = e.target.closest("[data-down]"), s = e.target.closest("[data-sel]");
    const mv = (id, dir) => { const i = S.layers.findIndex((l) => l.id === +id), vs = S.layers.map((l, k) => [l, k]).filter(([l]) => l.view === S.view), pos = vs.findIndex(([, k]) => k === i), tgt = vs[pos + dir]; if (!tgt) return; [S.layers[i], S.layers[tgt[1]]] = [S.layers[tgt[1]], S.layers[i]]; ui(); draw(); };
    if (u) return mv(u.dataset.up, 1); if (d) return mv(d.dataset.down, -1); if (s) { S.sel = +s.dataset.sel; ui(); draw(); }
  });
  const P = $("#st-props");
  P.addEventListener("input", (e) => {
    const l = cur(); if (!l) return; const id = e.target.id, v = e.target.value; S.dirty = true;
    if (id === "sp-text") { l.text = v.toUpperCase().slice(0, 40); if (v !== l.text) e.target.value = l.text; $("#st-layers").querySelector(".on span")?.replaceChildren("T  " + l.text.slice(0, 18)); }
    else if (id === "sp-font") l.font = v; else if (id === "sp-curve") l.curve = +v; else if (id === "sp-spacing") l.spacing = +v;
    else if (id === "sp-outline") l.outline = v; else if (id === "sp-outlinew") l.outlineW = +v; else if (id === "sp-shadow") l.shadow = e.target.checked;
    else if (id === "sp-color") l.color = v; else if (id === "sp-sym") l.sym = v; else if (id === "sp-size") l.size = +v; else if (id === "sp-rot") l.rot = +v; else if (id === "sp-alpha") l.alpha = +v / 100;
    draw();
  });
  P.addEventListener("click", (e) => {
    const l = cur(); if (!l) return; const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.place) { const [x, y, s] = PLACE[b.dataset.place]; l.x = x; l.y = y; if (l.type === "text") l.size = Math.max(14, s / 4); else l.size = l.type === "img" ? Math.min(160, s * 0.66) : s; if (l.type === "img") l.size = (s / Math.max(l.w, l.h)) * 100; }
    if (b.dataset.center) l.x = 240;
    if (b.dataset.del) return remove(l.id);
    if (b.dataset.dup) { const c = { ...l, x: l.x + 14, y: l.y + 14 }; delete c.id; const n = addLayer(c); if (imgs.has(l.id)) imgs.set(n.id, imgs.get(l.id)); return; }
    draw(); ui();
  });

  /* ---------- export & submit ---------- */
  function fitData(type, maxBytes, canvas) {
    for (const q of [0.86, 0.74, 0.62, 0.5, 0.4, 0.3]) { const u = canvas.toDataURL(type, q); if (u.length <= maxBytes && u.startsWith("data:" + type)) return u; if (!u.startsWith("data:" + type)) return null; }
    return canvas.toDataURL(type, 0.25);
  }
  function snapshot(view, maxBytes) {
    const keep = S.view, ks = S.sel; S.view = view; S.sel = null; draw(true);
    const out = document.createElement("canvas"); out.width = 360; out.height = 405; out.getContext("2d").drawImage(cv, 0, 0, out.width, out.height);
    const u = fitData("image/jpeg", maxBytes, out); S.view = keep; S.sel = ks; draw(); return u;
  }
  function artData() {
    if (!S.art) return null; const im = S.art.img; let max = 1100;
    while (max >= 300) { const r = Math.min(1, max / Math.max(im.width, im.height)); const c = document.createElement("canvas"); c.width = Math.round(im.width * r); c.height = Math.round(im.height * r); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      let u = c.toDataURL("image/webp", 0.82); if (!u.startsWith("data:image/webp")) u = c.toDataURL("image/png"); if (u.length <= 150000) return u; max = Math.round(max * 0.8); }
    return null;
  }
  $("#st-dl").addEventListener("click", () => { const keep = S.sel; S.sel = null; draw(true); const a = document.createElement("a"); a.download = (($("#st-title").value || "design").replace(/[^\w-]+/g, "-")) + "-" + S.view + ".png"; a.href = cv.toDataURL("image/png"); a.click(); S.sel = keep; draw(); });
  $("#st-form").addEventListener("submit", async (e) => {
    e.preventDefault(); if (typeof needMember === "function" && !needMember()) return;
    if (!S.layers.length) { say("Add some text, a symbol, or your art first."); return; }
    const btn = $("#st-submit"); btn.disabled = true; btn.textContent = "Submitting...";
    try {
      const img = snapshot("front", 95000) || snapshot("front", 95000), hasBack = S.layers.some((l) => l.view === "back"), img2 = hasBack ? snapshot("back", 70000) : null, art = artData();
      if (S.art && !art) say("Your art file was too large to save, so only the mockup was submitted. Send the full file when we contact you.");
      const doc = { authorId: me, title: $("#st-title").value.trim() || "Untitled design", note: $("#st-note").value.trim().slice(0, 300), garment: S.garment, color: S.color, img, votes: [], selected: false, createdAt: Date.now() };
      if (img2) doc.img2 = img2; if (art) doc.art = art;
      await db.collection("designs").add(doc);
      $("#st-title").value = ""; $("#st-note").value = ""; S.dirty = false; say("Design submitted. The community can vote now.");
    } catch (err) { say("Couldn't submit: " + (err.message || err.code)); }
    btn.disabled = false; btn.textContent = "Submit design";
  });
  window.addEventListener("beforeunload", (e) => { if (S.dirty && S.layers.length) { e.preventDefault(); e.returnValue = ""; } });

  /* start with a simple example so the page isn't empty */
  S.view = "front";
  const t1 = addLayer({ starter: true, type: "text", text: "MEECHIE'S WORLD", font: "Cinzel", color: "#d4a843", size: 34, x: 240, y: 175, outline: "#000000", outlineW: 0, curve: 0, shadow: false, spacing: 1, bold: true });
  addLayer({ starter: true, type: "sym", sym: "emblem", color: "#d4a843", size: 120, x: 240, y: 262 });
  S.starter = true; S.sel = null; S.dirty = false; ui(); draw();
  document.fonts && document.fonts.ready.then(() => draw());
})();
