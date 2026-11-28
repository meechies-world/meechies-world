/* MeechieBot animated character (owner, 2026-11-28: "This is how my bot is supposed to be").
 * Meechie as a flat 2D cartoon: young Black man, goatee only (mustache + chin beard, clean cheeks),
 * dark beard with no grey, plain braids with nothing on his head, glasses, gold chain, solid build.
 * The face never changes; only the outfit does. The mouth moves with the voice (real audio levels for
 * the Cloudflare voice, word-by-word for the phone voice) and the face shows the feeling of the line. */
(function () {
  "use strict";
  const COLORS = { red: "#c62828", blue: "#1e5bb8", black: "#151515", white: "#f2f2f2", gold: "#d4af37", green: "#2e7d32", purple: "#6a1b9a", pink: "#e75a9b", orange: "#ef6c00", grey: "#7a7a7a", gray: "#7a7a7a", yellow: "#f2c200", brown: "#6d4325", navy: "#16244d", cream: "#efe3c4", tan: "#c9a77c", camo: "#55603a" };
  const DEFAULT = { top: "tee", color: "black", jacketColor: "gold", hat: "none", hatColor: "black" };
  const SKIN = "#8a5636", SKIN_D = "#6e4127", HAIR = "#16100b", LINE = "#24160d";
  let outfit = Object.assign({}, DEFAULT), el = null, mouthOpen = 0, target = 0, talking = false, mood = "chill", lastPulse = 0;
  let analyser = null, buf = null;

  const c = (name) => COLORS[name] || name || "#151515";
  const darker = (hex, f = 0.72) => { const n = parseInt(String(c(hex)).slice(1), 16); const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f); return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1); };

  function torso() {
    const shirt = c(outfit.color), o = outfit;
    let s = "";
    if (o.top === "hoodie") s += `<path d="M78 262 C70 210 104 190 150 190 C196 190 230 210 222 262 Z" fill="${darker(shirt, .8)}" stroke="${LINE}" stroke-width="4"/>`;
    s += `<path d="M22 360 C22 288 70 252 150 250 C230 252 278 288 278 360 Z" fill="${o.top === "suit" ? "#f4f4f4" : shirt}" stroke="${LINE}" stroke-width="4"/>`;
    if (o.top === "hoodie") s += `<path d="M120 252 L116 300 M180 252 L184 300" stroke="${darker(shirt, .55)}" stroke-width="4" stroke-linecap="round"/><path d="M95 330 H205 V360 H95 Z" fill="${darker(shirt, .85)}" stroke="${LINE}" stroke-width="3"/>`;
    if (o.top === "suit") s += `<path d="M150 254 L139 270 L150 336 L161 270 Z" fill="${c(o.jacketColor === "gold" ? "red" : o.jacketColor)}" stroke="${LINE}" stroke-width="3"/>`;
    if (o.top === "jacket" || o.top === "suit") {
      const j = c(o.top === "suit" ? o.color : o.jacketColor);
      s += `<path d="M22 360 C22 288 70 252 128 250 L150 330 L132 360 Z" fill="${j}" stroke="${LINE}" stroke-width="4"/><path d="M278 360 C278 288 230 252 172 250 L150 330 L168 360 Z" fill="${j}" stroke="${LINE}" stroke-width="4"/>`;
      s += `<path d="M128 250 L112 288 L134 296 Z M172 250 L188 288 L166 296 Z" fill="${darker(j, .8)}" stroke="${LINE}" stroke-width="3"/>`;
    }
    // gold chain + pendant (always on: part of his look)
    s += `<path d="M112 252 Q150 318 188 252" fill="none" stroke="#e8c14e" stroke-width="6" stroke-dasharray="7 3"/><path d="M112 252 Q150 318 188 252" fill="none" stroke="#9c7a1c" stroke-width="1.5"/>`;
    s += `<circle cx="150" cy="300" r="11" fill="#f0cf5a" stroke="#9c7a1c" stroke-width="3"/><path d="M150 293 L157 305 H143 Z" fill="none" stroke="#9c7a1c" stroke-width="2"/>`;
    return s;
  }
  function hat() {
    const h = c(outfit.hatColor);
    if (outfit.hat === "cap") return `<path d="M76 98 C78 44 222 44 224 98 Z" fill="${h}" stroke="${LINE}" stroke-width="4"/><path d="M76 98 C120 86 190 84 254 100 C210 108 120 108 76 98 Z" fill="${darker(h)}" stroke="${LINE}" stroke-width="4"/><circle cx="150" cy="50" r="5" fill="${darker(h)}"/>`;
    if (outfit.hat === "beanie") return `<path d="M74 108 C72 30 228 30 226 108 Z" fill="${h}" stroke="${LINE}" stroke-width="4"/><rect x="70" y="92" width="160" height="22" rx="8" fill="${darker(h)}" stroke="${LINE}" stroke-width="4"/>`;
    if (outfit.hat === "fedora") return `<ellipse cx="150" cy="92" rx="104" ry="18" fill="${darker(h)}" stroke="${LINE}" stroke-width="4"/><path d="M92 92 C92 34 208 34 208 92 Z" fill="${h}" stroke="${LINE}" stroke-width="4"/><rect x="92" y="76" width="116" height="12" fill="${c("gold")}"/>`;
    return "";
  }
  function brows() {
    const m = mood;
    const L = m === "hype" ? "M104 104 Q122 92 140 102" : m === "curious" ? "M104 110 Q122 104 140 110" : m === "serious" ? "M104 108 Q122 108 140 114" : "M104 108 Q122 100 140 108";
    const R = m === "hype" ? "M160 102 Q178 92 196 104" : m === "curious" ? "M160 100 Q178 88 196 100" : m === "serious" ? "M160 114 Q178 108 196 108" : "M160 108 Q178 100 196 108";
    return `<path id="mb-brows" d="${L} ${R}" fill="none" stroke="${HAIR}" stroke-width="7" stroke-linecap="round"/>`;
  }
  function render() {
    if (!el) return;
    el.innerHTML = `<svg viewBox="0 0 300 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Meechie">
      <!-- braids hanging behind -->
      <g stroke="${HAIR}" stroke-width="11" stroke-linecap="round" fill="none">
        <path d="M86 120 C74 170 76 210 84 246"/><path d="M98 132 C90 178 92 214 98 244"/><path d="M214 120 C226 170 224 210 216 246"/><path d="M202 132 C210 178 208 214 202 244"/>
      </g>
      ${torso()}
      <rect x="126" y="200" width="48" height="56" rx="14" fill="${SKIN_D}" stroke="${LINE}" stroke-width="4"/>
      <ellipse cx="78" cy="146" rx="12" ry="18" fill="${SKIN}" stroke="${LINE}" stroke-width="4"/><ellipse cx="222" cy="146" rx="12" ry="18" fill="${SKIN}" stroke="${LINE}" stroke-width="4"/>
      <ellipse cx="150" cy="140" rx="74" ry="84" fill="${SKIN}" stroke="${LINE}" stroke-width="4"/>
      <!-- plain braids (cornrows) on top, nothing on his head -->
      <path d="M78 128 C70 56 230 56 222 128 C204 96 96 96 78 128 Z" fill="${HAIR}" stroke="${LINE}" stroke-width="3"/>
      <g stroke="#3a291b" stroke-width="2.5" fill="none" opacity=".9"><path d="M104 104 C110 80 120 70 128 64"/><path d="M126 98 C130 78 138 66 144 61"/><path d="M150 96 V60"/><path d="M174 98 C170 78 162 66 156 61"/><path d="M196 104 C190 80 180 70 172 64"/></g>
      ${hat()}
      ${brows()}
      <g id="mb-eyes"><ellipse cx="122" cy="134" rx="13" ry="9" fill="#fff"/><ellipse cx="178" cy="134" rx="13" ry="9" fill="#fff"/><circle cx="123" cy="135" r="5.5" fill="#1b0f08"/><circle cx="179" cy="135" r="5.5" fill="#1b0f08"/></g>
      <!-- glasses -->
      <g fill="none" stroke="#c9a227" stroke-width="3.5"><rect x="100" y="118" width="44" height="32" rx="11"/><rect x="156" y="118" width="44" height="32" rx="11"/><path d="M144 132 Q150 127 156 132"/><path d="M100 128 L82 124 M200 128 L218 124"/></g>
      <path d="M150 140 C146 156 140 162 146 166 Q150 168 156 166" fill="none" stroke="${SKIN_D}" stroke-width="4" stroke-linecap="round"/>
      <!-- goatee: mustache + chin beard, clean cheeks, no grey -->
      <path d="M124 178 Q150 166 176 178 Q164 176 150 178 Q136 176 124 178 Z" fill="${HAIR}" stroke="${HAIR}" stroke-width="5" stroke-linejoin="round"/>
      <g id="mb-mouth" transform="translate(150 190)"></g>
      <path id="mb-beard" d="M128 194 Q132 222 150 228 Q168 222 172 194 Q162 206 150 207 Q138 206 128 194 Z" fill="${HAIR}" stroke="${HAIR}" stroke-width="3"/>
    </svg>`;
    drawMouth();
  }
  function drawMouth() {
    const g = el && el.querySelector("#mb-mouth"); if (!g) return;
    const v = Math.max(0, Math.min(1, mouthOpen));
    const w = mood === "hype" ? 17 : 14;
    if (v < 0.08) {
      const curve = mood === "serious" ? 0 : mood === "hype" ? 7 : 4;
      g.innerHTML = `<path d="M${-w} 0 Q0 ${curve} ${w} 0" fill="none" stroke="#3a0f0f" stroke-width="4" stroke-linecap="round"/>`;
    } else {
      const ry = 2 + v * 11;
      g.innerHTML = `<ellipse cx="0" cy="${ry * 0.35}" rx="${w - 2 + v * 2}" ry="${ry}" fill="#3a0f0f" stroke="${LINE}" stroke-width="2.5"/><rect x="${-w + 5}" y="${-ry * 0.55}" width="${2 * w - 10}" height="${Math.min(5, ry * .5)}" rx="2" fill="#fff"/><ellipse cx="0" cy="${ry * 0.9}" rx="${w * .45}" ry="${ry * .3}" fill="#b5413f"/>`;
    }
  }
  function blink() {
    const e = el && el.querySelector("#mb-eyes"); if (!e) return;
    e.style.transformOrigin = "150px 134px"; e.style.transition = "transform .08s"; e.style.transform = "scaleY(.1)";
    setTimeout(() => { e.style.transform = ""; }, 120);
  }
  function loop() {
    let lvl = 0;
    if (analyser && talking) {
      analyser.getByteTimeDomainData(buf); let sum = 0;
      for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
      lvl = Math.min(1, Math.sqrt(sum / buf.length) * 5.5);
    } else if (talking) {
      const t = performance.now() / 1000, since = performance.now() - lastPulse;
      lvl = (0.35 + 0.55 * Math.abs(Math.sin(t * 17 + Math.sin(t * 5)))) * (since < 260 ? 1 : 0.75);
    }
    target = lvl;
    mouthOpen += (target - mouthOpen) * 0.45;
    if (el && el.offsetParent !== null) drawMouth();
    const photo = window.MB_PHOTO; if (photo) photo.style.transform = `translateY(${-mouthOpen * 4}px) scale(${1 + mouthOpen * 0.03}) rotate(${talking ? Math.sin(performance.now() / 300) * 1.2 : 0}deg)`;
    requestAnimationFrame(loop);
  }
  function feel(text) {
    const t = String(text || "").toLowerCase();
    mood = /(haha|lol|lmao|ayy|let's go|lets go|fire|hype|crazy|wild|!{1,})/.test(t) ? "hype" : /\?/.test(t) ? "curious" : /(sorry|sad|rip|unfortunately|serious|real talk)/.test(t) ? "serious" : "chill";
    const b = el && el.querySelector("#mb-brows"); if (b) { const tmp = document.createElement("div"); tmp.innerHTML = `<svg>${brows()}</svg>`; b.setAttribute("d", tmp.querySelector("path").getAttribute("d")); }
  }
  /* ---------- outfit commands: "put on a red suit", "wear a black hoodie", "take off the hat" ---------- */
  const TOPS = [[/\bsuit\b/, "suit"], [/\b(jacket|blazer|coat|bomber)\b/, "jacket"], [/\b(hoodie|hoody|sweatshirt)\b/, "hoodie"], [/\b(t-?shirt|tee|shirt|top)\b/, "tee"]];
  const HATS = [[/\b(beanie|skully|toboggan)\b/, "beanie"], [/\b(fedora)\b/, "fedora"], [/\b(cap|fitted|snapback|hat)\b/, "cap"]];
  function parseOutfit(text) {
    const t = " " + String(text || "").toLowerCase() + " ";
    if (!/(change|put on|wear|switch|throw on|rock|dress|outfit|\bfit\b|take off|remove|no hat|lose the hat)/.test(t)) return null;
    const out = {};
    if (/(take off|remove|no|lose) (the |your |that )?(hat|cap|beanie|fedora)/.test(t)) out.hat = "none";
    const colorWords = Object.keys(COLORS).filter((k) => new RegExp("\\b" + k + "\\b").test(t));
    const top = TOPS.find(([re]) => re.test(t));
    const hatM = out.hat ? null : HATS.find(([re]) => re.test(t));
    if (top) { out.top = top[1]; if (colorWords[0]) { if (top[1] === "jacket") out.jacketColor = colorWords[0]; else out.color = colorWords[0]; } if (top[1] === "jacket" && colorWords[1]) out.color = colorWords[1]; }
    if (hatM) { out.hat = hatM[1]; const hc = colorWords.find((k) => new RegExp(k + " (" + hatM[0].source.replace(/\\b/g, "") + ")").test(t)) || (!top && colorWords[0]); if (hc) out.hatColor = hc; }
    if (!top && !hatM && !out.hat && colorWords[0] && /(shirt|fit|outfit|clothes|drip|color)/.test(t)) out.color = colorWords[0];
    return Object.keys(out).length ? out : null;
  }
  function describe() {
    const o = outfit, top = o.top === "tee" ? "tee" : o.top;
    return `${o.top === "jacket" ? o.jacketColor + " jacket over a " + o.color + " tee" : o.color + " " + top}${o.hat !== "none" ? " and a " + o.hatColor + " " + o.hat : ""}, gold chain`;
  }

  window.MeechieAvatar = {
    mount(node, saved) { el = node; if (saved) Object.assign(outfit, saved); render(); if (!this._loop) { this._loop = true; requestAnimationFrame(loop); setInterval(() => { if (Math.random() < 0.7) blink(); }, 3200); } },
    setOutfit(o) { Object.assign(outfit, o || {}); render(); return Object.assign({}, outfit); },
    getOutfit() { return Object.assign({}, outfit); },
    reset() { outfit = Object.assign({}, DEFAULT); render(); return this.getOutfit(); },
    parseOutfit, describe, feel,
    talk(on) { talking = !!on; if (!on) { analyser = null; mood = mood === "hype" ? "hype" : mood; } },
    pulse() { lastPulse = performance.now(); },
    useAnalyser(a) { analyser = a; buf = a ? new Uint8Array(a.fftSize) : null; },
    COLORS: Object.keys(COLORS).filter((k) => k !== "gray"),
  };
})();
