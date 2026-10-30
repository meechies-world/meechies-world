/* ============================================================================
   v2 COIN JACKPOT (Phase 5) — the live js/games.js, ported: same eight
   games, same animations animating to the SERVER's real results, same
   pots with the 10% house rake, same /api/coins routes (commerce.js).
   The server decides every outcome; this file only presents it. The
   word visitors see is Jackpot — never the other word (Law 18). The
   live file's injected stylesheet lives in css/games.css; its global
   helpers (toast / session / members map) are the v2 doors below.
   ============================================================================ */

import { createCoins, toast as say, openWallet, esc as E } from "./commerce.js";
import { createDb } from "./platform.js";

export function mountJackpot(viewRoot, ctx) {
  const { api, tok } = createCoins(ctx.session);
  const meId = () => { const u = ctx.session.user(); return u ? u.id : ""; };
  const nameCache = {};
  const nameOf = (uid) => nameCache[uid] || "A member";
  createDb(ctx).listDocs("members", { limit: 200 }).then((rows) => {
    rows.forEach((m) => { if (m && m.id) nameCache[m.id] = m.handle || m.name || m.username || "A member"; });
    try { render(); } catch (_) {}
  }).catch(() => {});
  const ago = (t) => { const s = Math.max(1, (Date.now() - t) / 1000); if (s < 90) return "just now"; if (s < 5400) return Math.round(s / 60) + "m ago"; if (s < 129600) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; };
  const CHIP_AMTS = [5, 25, 50, 100, 250, 1000];
  const FACE = { 11: "J", 12: "Q", 13: "K", 14: "A" };
  const rank = (n) => FACE[n] || String(n);
  const SUITS = ["\u2660", "\u2665", "\u2666", "\u2663"];
  const WHEEL_SEGS = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1.5, 2, 4.5];
  const WHEEL_COL = { "0": "#221a10", "1": "#7a5c1e", "1.5": "#a37f27", "2": "#c39a2e", "4.5": "#f0cf78" };
  const PLINKO_MULTS = [8, 2.5, 1, 0.3, 0.3, 1, 2.5, 8];
  const SLOT_POOL = ["\u{1F339}", "\u{1F3A4}", "\u{1F525}", "\u{1F4B5}", "\u{1F48E}", "\u{1F451}"];
  const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };


  const root = viewRoot;
  if (!root) return;

  const S = { data: null, bet: { flip: 25, highcard: 25, dice: 25, slots: 25, race: 25, wheel: 25, plinko: 25, triple: 25 }, pick: { flip: "heads", dice: "under", triple: "mixed", potSide: "heads" }, potBet: 50, busy: {}, auto: null, autoPick: {} };
  const betOf = (g) => Math.max(S.data ? S.data.minBet : 5, Math.min(S.bet[g] || 25, (S.data && S.data.maxBet[g]) || 0));

  function chipsHtml(g) {
    const max = S.data ? S.data.maxBet[g] : 0;
    return `<div class="cz-chips" data-chips="${g}">${CHIP_AMTS.map((a) => `<button type="button" data-amt="${a}" ${a > max ? "disabled" : ""} class="${betOf(g) === a ? "on" : ""}">🪙 ${a}</button>`).join("")}</div>`;
  }
  function coinHtml(sm) {
    return `<div class="cz-coin${sm ? " sm" : ""}" data-coin><div class="cf fr"><span class="cface">👑</span></div><div class="cf bk"><span class="cface m">M</span></div></div>`;
  }
  function dieHtml() {
    return `<div class="die" data-die>${Array.from({ length: 9 }, (_, i) => `<i data-pip="${i + 1}"></i>`).join("")}</div>`;
  }
  function stageHtml(g) {
    if (g === "flip") return `<div>${coinHtml(false)}<div class="cz-cap" data-cap>Call it in the air</div></div>`;
    if (g === "highcard") return `<div><div class="cards"><div class="fcard" data-fc="you"><div class="in"><div class="fc bk">MW</div><div class="fc fr" data-fr="you"></div></div></div><div class="fcard" data-fc="dealer"><div class="in"><div class="fc bk">MW</div><div class="fc fr" data-fr="dealer"></div></div></div></div><div class="cz-cap" data-cap>Your card vs the dealer's</div></div>`;
    if (g === "dice") return `<div><div class="cz-dice">${dieHtml()}${dieHtml()}</div><div class="cz-cap" data-cap>Two dice — call the total</div></div>`;
    if (g === "slots") return `<div><div class="cz-reels">${[0, 1, 2].map(() => `<div class="cz-reel"><div class="cz-strip"><span>👑</span></div></div>`).join("")}</div><div class="cz-cap" data-cap>Three of a kind pays big</div></div>`;
    if (g === "wheel") return `<div style="width:100%"><div class="cz-wheelwrap"><div class="cz-pointer">▼</div><canvas class="cz-wheelcv" width="240" height="240"></canvas></div><div class="cz-cap" data-cap>Twelve segments — gold pays 4.5×</div></div>`;
    if (g === "plinko") return `<div style="width:100%"><canvas class="cz-plkcv" width="284" height="216"></canvas><div class="cz-plkslots">${PLINKO_MULTS.map((m) => `<i>${m}×</i>`).join("")}</div><div class="cz-cap" data-cap>Seven bounces — the edge slots pay 8×</div></div>`;
    if (g === "triple") return `<div><div class="cz-coins">${coinHtml(true)}${coinHtml(true)}${coinHtml(true)}</div><div class="cz-cap" data-cap>Three coins, one call</div></div>`;
    return `<div style="width:100%"><div class="cz-board">${Array.from({ length: 24 }, (_, i) => `<i data-cell="${i}">${i + 1}</i>`).join("")}</div><div class="cz-cap" data-cap>4 dice carry your 👑 down the board</div></div>`;
  }
  /* ---- canvas painters: the wheel and the plinko board are real drawings,
     and their results land exactly where the server said they landed ---- */
  function drawWheel(cv, hi) {
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const C = 120, R = 114;
    ctx.clearRect(0, 0, 240, 240);
    /* cabinet rim: dark ring with a gold trim line */
    ctx.beginPath(); ctx.arc(C, C, 117, 0, Math.PI * 2); ctx.fillStyle = "#0a0805"; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#8a6a2a"; ctx.stroke();
    for (let i = 0; i < 12; i++) {
      const m = WHEEL_SEGS[i], a0 = -Math.PI / 2 + i * Math.PI / 6, a1 = a0 + Math.PI / 6;
      const g = ctx.createRadialGradient(C, C, 24, C, C, R);
      g.addColorStop(0, WHEEL_COL[String(m)]); g.addColorStop(0.72, WHEEL_COL[String(m)]); g.addColorStop(1, "rgba(0,0,0,0.30)");
      ctx.beginPath(); ctx.moveTo(C, C); ctx.arc(C, C, R, a0, a1); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.beginPath(); ctx.moveTo(C, C); ctx.arc(C, C, R * 0.60, a0, a1); ctx.closePath();
      ctx.fillStyle = "rgba(255,244,200,0.08)"; ctx.fill();
      ctx.lineWidth = i === hi ? 5 : 2; ctx.strokeStyle = i === hi ? "#fff3c4" : "#0b0906"; ctx.stroke();
      if (i === hi) { ctx.beginPath(); ctx.moveTo(C, C); ctx.arc(C, C, R, a0, a1); ctx.closePath(); ctx.fillStyle = "rgba(255,243,196,.22)"; ctx.fill(); }
      ctx.save(); ctx.translate(C, C); ctx.rotate(a0 + Math.PI / 12);
      ctx.textAlign = "right"; ctx.font = "700 15px system-ui"; ctx.fillStyle = m >= 1.5 ? "#241a05" : "#e9d9a6";
      ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 2; ctx.shadowOffsetY = 1;
      ctx.fillText(m + "\u00d7", R - 12, 5); ctx.restore();
    }
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    /* metal pegs on every segment seam */
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 6, x = C + Math.cos(a) * (R - 3), y = C + Math.sin(a) * (R - 3);
      const pg = ctx.createRadialGradient(x - 1, y - 1, 0.5, x, y, 3.4);
      pg.addColorStop(0, "#fff6d8"); pg.addColorStop(0.55, "#d4a843"); pg.addColorStop(1, "#6d551f");
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = pg; ctx.fill();
    }
    /* chasing marquee bulbs around the rim (drawn lit/unlit in turn) */
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, x = C + Math.cos(a) * 117, y = C + Math.sin(a) * 117;
      ctx.beginPath(); ctx.arc(x, y, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? "#8a6a2a" : "#ffe9a8"; ctx.fill();
    }
    /* heavy branded hub */
    const hg = ctx.createRadialGradient(C - 8, C - 10, 4, C, C, 30);
    hg.addColorStop(0, "#ffeeb2"); hg.addColorStop(0.55, "#d4a843"); hg.addColorStop(1, "#7c5f22");
    ctx.beginPath(); ctx.arc(C, C, 29, 0, Math.PI * 2); ctx.fillStyle = hg; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "#4a3a1a"; ctx.stroke();
    ctx.beginPath(); ctx.arc(C, C, 23.5, 0, Math.PI * 2); ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,246,216,.65)"; ctx.stroke();
    ctx.fillStyle = "#241a05"; ctx.font = "800 13px Georgia,serif"; ctx.textAlign = "center";
    ctx.shadowColor = "rgba(255,246,216,.5)"; ctx.shadowOffsetY = 1;
    ctx.fillText("MW", C, C + 4); ctx.shadowOffsetY = 0;
  }

  function plinkoBallPos(path, hops) {
    let rights = 0; for (let i = 0; i < hops; i++) rights += path[i] ? 1 : 0;
    const slots = 4 + (rights - (hops - rights)) * 0.5;
    return { x: (slots / 8) * 284, y: 14 + hops * 26.5 };
  }
  function drawPlinko(cv, path, hops, doneSlot) {
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, 284, 216);
    /* deep inset felt with a pool of light at the top */
    const bg = ctx.createLinearGradient(0, 0, 0, 216);
    bg.addColorStop(0, "#131a0e"); bg.addColorStop(0.6, "#0d1109"); bg.addColorStop(1, "#090b06");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, 284, 216);
    const pool = ctx.createRadialGradient(142, 26, 10, 142, 110, 195);
    pool.addColorStop(0, "rgba(240,207,120,.13)"); pool.addColorStop(1, "rgba(240,207,120,0)");
    ctx.fillStyle = pool; ctx.fillRect(0, 0, 284, 216);
    for (let s = 0; s <= 8; s++) {
      ctx.beginPath(); ctx.moveTo(s * 35.5, 196); ctx.lineTo(s * 35.5, 216); ctx.lineWidth = 2; ctx.strokeStyle = "#4a3a1a"; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * 35.5 + 1, 196); ctx.lineTo(s * 35.5 + 1, 216); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,240,190,.25)"; ctx.stroke();
    }
    if (doneSlot != null && doneSlot >= 0) { ctx.fillStyle = "rgba(240,207,120,.34)"; ctx.fillRect(doneSlot * 35.5 + 1, 196, 33.5, 20); }
    /* pins as little metal studs: cast shadow, gold body, specular dot */
    for (let r = 0; r < 7; r++) for (let c = 0; c < 9; c++) {
      const x = 18 + c * 31 + (r % 2 ? 15 : 0); if (x > 282) continue;
      const y = 30 + r * 24;
      ctx.beginPath(); ctx.arc(x + 1, y + 1.6, 3.1, 0, Math.PI * 2); ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fill();
      const pg = ctx.createRadialGradient(x - 1.1, y - 1.1, 0.4, x, y, 3.4);
      pg.addColorStop(0, "#fff3c4"); pg.addColorStop(0.5, "#d4a843"); pg.addColorStop(1, "#7c5f22");
      ctx.beginPath(); ctx.arc(x, y, 3.1, 0, Math.PI * 2); ctx.fillStyle = pg; ctx.fill();
      ctx.beginPath(); ctx.arc(x - 1.1, y - 1.1, 0.9, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fill();
    }
    if (path) {
      if (hops > 0) { const gp = plinkoBallPos(path, hops - 1); ctx.beginPath(); ctx.arc(gp.x, Math.min(gp.y, 190), 7, 0, Math.PI * 2); ctx.fillStyle = "rgba(212,168,67,.28)"; ctx.fill(); }
      const p = plinkoBallPos(path, hops), by = Math.min(p.y, 190);
      ctx.beginPath(); ctx.ellipse(p.x, by + 8.5, 8.5, 2.6, 0, 0, Math.PI * 2); ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.fill();
      const gr = ctx.createRadialGradient(p.x - 2.4, by - 2.6, 1, p.x, by, 8.5);
      gr.addColorStop(0, "#fff6d8"); gr.addColorStop(0.45, "#f0cf78"); gr.addColorStop(1, "#a37f27");
      ctx.beginPath(); ctx.arc(p.x, by, 7.5, 0, Math.PI * 2); ctx.fillStyle = gr; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#8a6a2a"; ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x - 2.4, by - 2.8, 1.7, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.fill();
    }
  }

  function paintIdle() {
    root.querySelectorAll(".cz-wheelcv").forEach((cv) => drawWheel(cv, -1));
    root.querySelectorAll(".cz-plkcv").forEach((cv) => drawPlinko(cv, null, 0, -1));
    root.querySelectorAll("[data-die]").forEach((d, i) => setDie(d, i + 1));
  }
  function setDie(d, n) {
    if (!d) return;
    d.querySelectorAll("[data-pip]").forEach((p) => p.classList.toggle("on", (PIPS[n] || []).includes(+p.dataset.pip)));
  }
  /* real card faces: standard pip layouts for number cards (bottom pips
     flipped, like printed stock), gold-framed court cards, one big ace pip */
  const PIPS5 = { 2: [[1, 0], [1, 4]], 3: [[1, 0], [1, 2], [1, 4]], 4: [[0, 0], [2, 0], [0, 4], [2, 4]], 5: [[0, 0], [2, 0], [1, 2], [0, 4], [2, 4]], 6: [[0, 0], [2, 0], [0, 2], [2, 2], [0, 4], [2, 4]], 7: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2], [0, 4], [2, 4]], 8: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2], [1, 3], [0, 4], [2, 4]], 9: [[0, 0], [2, 0], [0, 1], [2, 1], [1, 2], [0, 3], [2, 3], [0, 4], [2, 4]], 10: [[0, 0], [2, 0], [0, 1], [2, 1], [1, 1], [1, 3], [0, 3], [2, 3], [0, 4], [2, 4]] };
  function cardFace(v, suit) {
    const red = suit === "\u2665" || suit === "\u2666";
    const cor = `<span class="cor tl">${rank(v)}<i>${suit}</i></span><span class="cor br">${rank(v)}<i>${suit}</i></span>`;
    if (v >= 11 && v <= 13) return cor + `<div class="court${red ? " red" : ""}"><b>${rank(v)}</b><i>${suit}</i></div>`;
    if (v === 14) return cor + `<div class="acepip${red ? " red" : ""}">${suit}</div>`;
    const ps = (PIPS5[v] || [[1, 2]]).map(([c, r]) => `<span class="pip${red ? " red" : ""}${r > 2 ? " dn" : ""}" style="grid-column:${c + 1};grid-row:${r + 1}">${suit}</span>`).join("");
    return cor + `<div class="pips">${ps}</div>`;
  }
  /* gold confetti burst inside the winning card — never covers the screen */
  function celebrate(card, big) {
    if (!card) return;
    const box = document.createElement("div"); box.className = "cz-confetti";
    const cols = ["#f0cf78", "#d4a843", "#fff3c4", "#b98f2e", "#ffe9a8"];
    const n = big ? 46 : 24;
    for (let i = 0; i < n; i++) {
      const p = document.createElement("i");
      p.style.left = (4 + Math.random() * 92) + "%";
      p.style.background = cols[i % cols.length];
      p.style.animationDuration = (0.9 + Math.random() * 0.8) + "s";
      p.style.animationDelay = (Math.random() * 0.15) + "s";
      if (i % 3 === 0) { p.style.borderRadius = "50%"; p.style.width = "5px"; p.style.height = "5px"; }
      box.appendChild(p);
    }
    card.appendChild(box);
    setTimeout(() => box.remove(), 2100);
  }
  /* auto-bet (owner, 2026-10-27 — "set their bets to auto, like DraftKings"):
     the player picks a round count, the game plays itself at their bet and
     their call, and they can stop it any time. Same server play route, same
     odds, same pool caps — it just presses the button for them. It stops on
     its own when the rounds run out, the coins run low, or the pool caps
     the bet, and it stops when they leave the Games view. Auto rounds keep
     the quick text stage — the full animation is for hand-played rounds. */
  function autoRow(g) {
    if (S.auto && S.auto.g === g) return `<div class="cz-auto"><span>🔁 Auto — <b data-autoleft="${g}">${S.auto.left}</b> rounds left · net <b data-autonet="${g}">${S.auto.net >= 0 ? "+" : ""}${S.auto.net}</b></span><button type="button" class="btn sm" data-autostop="1">⏹ Stop</button></div>`;
    const n = S.autoPick[g] || 10;
    return `<div class="cz-auto"><span>🔁 Auto-bet</span><span class="cz-chips" data-autochips="${g}">${[10, 25, 50, 100].map((x) => `<button type="button" data-an="${x}" class="${n === x ? "on" : ""}" ${S.auto ? "disabled" : ""}>${x}</button>`).join("")}</span><button type="button" class="btn sm ghost" data-auto="${g}" ${S.auto ? "disabled" : ""}>▶ Start auto</button></div>`;
  }
  function autoStage(g, r) {
    const st = stageEl(g); if (!st) return; const dt = r.j.detail || {};
    if (g === "flip") st.innerHTML = `<div class="big">${dt.land === "heads" ? "🪙" : "💰"}</div><div>It landed <b>${E(dt.land)}</b> — you called ${E(S.pick.flip)}</div>`;
    else if (g === "highcard") st.innerHTML = `<div class="cards"><span>${rank(dt.you)}</span><span>${rank(dt.dealer)}</span></div><div>You <b>${rank(dt.you)}</b> vs dealer <b>${rank(dt.dealer)}</b></div>`;
    else if (g === "dice") st.innerHTML = `<div class="big">${"⚀⚁⚂⚃⚄⚅"[dt.d1 - 1]} ${"⚀⚁⚂⚃⚄⚅"[dt.d2 - 1]}</div><div>Total <b>${dt.sum}</b></div>`;
    else if (g === "slots") st.innerHTML = `<div class="reels">${(dt.reels || []).map(E).join(" ")}</div><div>${r.j.pay > r.j.bet ? "Jackpot line!" : r.j.pay > 0 ? "A pair pays out." : "No match."}</div>`;
    else if (g === "race") st.innerHTML = `<div class="big">🏁 ${dt.total}</div><div>Final total <b>${dt.total}</b> of 24</div>`;
    else if (g === "wheel") st.innerHTML = `<div class="big">🎡 ${dt.mult}×</div><div>The wheel paid <b>${dt.mult}×</b></div>`;
    else if (g === "plinko") st.innerHTML = `<div class="big">🎯 Slot ${dt.slot + 1} — ${dt.mult}×</div><div>It landed in slot <b>${dt.slot + 1}</b> of 8</div>`;
    else if (g === "triple") st.innerHTML = `<div class="big">${(dt.flips || []).map((f) => f ? "🪙" : "💰").join(" ")}</div><div>${dt.heads} heads, ${3 - dt.heads} tails</div>`;
  }
  function syncMoney(r) {
    if (r.j.coins != null && S.data) S.data.myCoins = r.j.coins;
    if (r.j.pool != null && S.data) S.data.pool = r.j.pool;
    const bal = root.querySelector(".cz-bal b"); if (bal && S.data) bal.textContent = "🪙 " + S.data.myCoins.toLocaleString();
    const poolB = root.querySelector(".cz-pool b"); if (poolB && S.data) poolB.textContent = "🪙 " + S.data.pool.toLocaleString();
    const poolBar = root.querySelector(".cz-pool .bar i"); if (poolBar && S.data) poolBar.style.width = Math.min(100, Math.round((S.data.pool / 5000) * 100)) + "%";
  }
  async function autoRun(g) {
    if (S.auto || !S.data) return;
    const bet = betOf(g);
    if (bet < S.data.minBet) { say("The prize pool is too low for that game right now."); return; }
    if ((S.data.myCoins || 0) < bet) { say("Not enough coins for that bet — claim your welcome drop or grab a pack."); return; }
    S.auto = { g, left: S.autoPick[g] || 10, net: 0, rounds: 0, stop: false };
    render();
    while (S.auto && S.auto.g === g && !S.auto.stop && S.auto.left > 0) {
      if ((S.data.myCoins || 0) < bet) { say("🔁 Auto stopped — your coins ran below the bet."); break; }
      const r = await api("play", { game: g, bet, choice: S.pick[g] || "" });
      if (!r.ok) { say(r.j.error === "not_enough_coins" ? "🔁 Auto stopped — not enough coins for the next bet." : "🔁 Auto stopped: " + (r.j.error || "that play did not go through.")); break; }
      S.auto.left--; S.auto.rounds++; S.auto.net += (r.j.pay || 0) - bet;
      syncMoney(r); autoStage(g, r); resultLine(g, r);
      const lf = root.querySelector(`[data-autoleft="${g}"]`); if (lf) lf.textContent = S.auto.left;
      const nt = root.querySelector(`[data-autonet="${g}"]`); if (nt) nt.textContent = (S.auto.net >= 0 ? "+" : "") + S.auto.net;
      if (S.auto.left > 0 && !S.auto.stop) await new Promise((res) => setTimeout(res, 700));
    }
    const done = S.auto; S.auto = null;
    if (done && done.rounds) say(`🔁 Auto finished: ${done.rounds} rounds on ${S.data.games[g].name} — net ${done.net >= 0 ? "+" : ""}${done.net} coins.`);
    load();
  }
  function cardHtml(g) {
    const d = S.data, info = d.games[g], max = d.maxBet[g], low = max < d.minBet;
    const picks = {
      flip: `<div class="cz-pick" data-pick="flip"><button type="button" data-v="heads" class="${S.pick.flip === "heads" ? "on" : ""}">🪙 Heads</button><button type="button" data-v="tails" class="${S.pick.flip === "tails" ? "on" : ""}">Tails</button></div>`,
      dice: `<div class="cz-pick" data-pick="dice"><button type="button" data-v="under" class="${S.pick.dice === "under" ? "on" : ""}">Under 7 · 2.2×</button><button type="button" data-v="seven" class="${S.pick.dice === "seven" ? "on" : ""}">Exactly 7 · 5.4×</button><button type="button" data-v="over" class="${S.pick.dice === "over" ? "on" : ""}">Over 7 · 2.2×</button></div>`,
      triple: `<div class="cz-pick" data-pick="triple"><button type="button" data-v="heads3" class="${S.pick.triple === "heads3" ? "on" : ""}">All heads · 7×</button><button type="button" data-v="mixed" class="${S.pick.triple === "mixed" ? "on" : ""}">Mixed · 1.2×</button><button type="button" data-v="tails3" class="${S.pick.triple === "tails3" ? "on" : ""}">All tails · 7×</button></div>`,
      highcard: "", slots: "", race: "", wheel: "", plinko: ""
    };
    const notes = {
      flip: "Call heads or tails. Right call pays 1.9× your bet.",
      highcard: "Beat the dealer's card, win 1.9×. A tie gives your bet back.",
      dice: "Under 7 or over 7 pays 2.2×. Exactly 7 pays 5.4×.",
      slots: "Any pair pays 1.2×. Triples: 🌹 6× · 🎤 8× · 🔥/💵 10× · 💎 15× · 👑 25×.",
      race: "Four dice roll your 👑 down a 24-space board. Total 21+ pays 5× · 17–20 pays 1.8× · 13–16 your bet back.",
      wheel: "Twelve segments: six pay nothing, three hand your bet back, and 1.5×, 2× and the gold 4.5× pay out.",
      plinko: "The ball bounces seven times and drops in a slot. The middle pays 0.3×–1× — the two edge slots pay 8×.",
      triple: "Call all three coins at once: all heads or all tails pays 7×, any mix pays 1.2×."
    };
    return `<div class="cz-card" data-card="${g}">
      <h4>${E(info.name)}</h4>
      <div class="cz-stage" data-stage="${g}">${stageHtml(g)}</div>
      ${picks[g] || ""}
      ${chipsHtml(g)}
      <button type="button" class="btn cz-play" data-play="${g}" ${low || S.busy[g] || S.auto ? "disabled" : ""}>${low ? "Prize pool too low right now" : S.auto && S.auto.g === g ? "🔁 Auto running…" : "Bet 🪙 " + betOf(g) + " — Play"}</button>
      <div class="cz-res" data-res="${g}"></div>
      ${autoRow(g)}
      <p class="pay-note">${notes[g]}</p>
    </div>`;
  }
  function potsHtml() {
    const d = S.data, mine = meId();
    if (!d.pots.length) return `<p class="cz-muted">No open pots. Start one: put up coins on heads or tails and another member can take the other side. Winner takes the pot, minus the 10% house fee.</p>`;
    return d.pots.map((p) => `<div class="cz-pot"><span><b>${E(nameOf(p.creator))}</b> put up <b>🪙 ${p.bet}</b> on <b>${p.side === "heads" ? "🪙 Heads" : "Tails"}</b> · <span class="cz-muted">${ago(p.at)}</span></span>${p.creator === mine ? `<button type="button" class="btn sm ghost" data-pot-cancel="${p.id}">Cancel & refund</button>` : `<button type="button" class="btn sm" data-pot-join="${p.id}">Take ${p.side === "heads" ? "Tails" : "🪙 Heads"} · 🪙 ${p.bet}</button>`}</div>`).join("");
  }
  const KIND_LABEL = { game_bet: "Bet", game_win: "Won", game_fee: "House fee", pot_bet: "Pot bet", pot_win: "Won a pot", daily: "Daily check-in", promo: "Welcome drop", pot_refund: "Pot refund", pool_seed: "Seeded the pool", grant: "Granted coins" };
  function render() {
    const d = S.data; if (!d) return;
    const poolPct = Math.min(100, Math.round((d.pool / 5000) * 100));
    root.innerHTML = `
    <div class="cz-head">
      <h3>🎰 Coin Jackpot</h3>
      <div class="cz-pool"><small>🏆 PRIZE POOL · <b style="color:var(--gold-hi,#f0cf78)">🪙 ${d.pool.toLocaleString()}</b> — every win pays from here</small><div class="bar"><i style="width:${poolPct}%"></i></div></div>
      <div class="cz-bal">Your coins: <b>🪙 ${(d.myCoins ?? 0).toLocaleString()}</b> <button type="button" class="btn sm" data-coins-open style="margin-left:6px">My coins</button>${d.paid ? ` <button type="button" class="btn sm ghost" data-coins-open>＋ Buy</button>` : ""}</div>
    </div>
    <p class="cz-safe">🛡️ <b>How winning works:</b> winnings are coins, paid only out of the prize pool. The pool fills up from players' lost bets (minus a 10% house fee) — so play is always covered before you bet. Spend winnings on gifts and the person you gift earns <b>real cash value</b> (40%), or cash out your own gift earnings from My coins. ${d.paid ? "" : "The coin shop (buying coins with a card) switches on with payments — until then, play with the coins you have."}</p>
    ${d.promo && !d.promo.claimed ? `<div class="cz-promo"><span>🎁 <b>Welcome drop:</b> 🪙 ${d.promo.amount} free coins, on the house — one per member, yours to play right now.</span><button type="button" class="btn" data-promo-claim>🪙 Claim ${d.promo.amount} coins</button></div>` : ""}
    <div class="cz-grid">${["flip", "highcard", "dice", "slots", "race", "wheel", "plinko", "triple"].map(cardHtml).join("")}</div>
    <div class="cz-sec"><h4>⚔️ Player vs Player — Coin Flip Pots</h4>
      <div id="cz-pots">${potsHtml()}</div>
      <form class="cz-form" id="cz-potform"><span>Start a pot:</span><input type="number" id="cz-potbet" min="${d.minBet}" max="1000" step="1" value="${S.potBet}"><div class="cz-pick" data-pick="potSide" style="flex:none"><button type="button" data-v="heads" class="${S.pick.potSide === "heads" ? "on" : ""}">🪙 Heads</button><button type="button" data-v="tails" class="${S.pick.potSide === "tails" ? "on" : ""}">Tails</button></div><button type="submit" class="btn sm">Put up the pot</button></form>
    </div>
    <div class="cz-sec"><h4>🏆 Recent winners</h4><div class="cz-feed">${d.wins.length ? d.wins.map((w) => `<div><b>${E(nameOf(w.uid))}</b> won <b>🪙 ${w.coins}</b> · ${ago(w.at)}</div>`).join("") : `<span class="cz-muted">No wins yet — be the first name up here.</span>`}</div></div>
    ${d.mine.length ? `<div class="cz-sec"><h4>🧾 Your recent plays</h4><div class="cz-feed">${d.mine.map((t) => `<div>${E(KIND_LABEL[t.kind] || t.kind)} · ${t.coins > 0 ? "+" : ""}${t.coins} coins · ${ago(t.at)}</div>`).join("")}</div></div>` : ""}
    ${d.admin ? `<div class="cz-sec"><h4>👑 Owner corner</h4><div class="cz-owner">
      <form class="cz-form" id="cz-grant"><span>Grant coins (to you):</span><input type="number" id="cz-grant-amt" min="1" max="1000000" value="500"><button class="btn sm" type="submit">Grant</button></form>
      <form class="cz-form" id="cz-seed"><span>Seed the prize pool from your coins:</span><input type="number" id="cz-seed-amt" min="1" max="100000" value="200"><button class="btn sm" type="submit">Seed pool</button><span class="cz-muted">Seeding lets members place bigger bets — the pool caps every game's max bet.</span></form>
    </div></div>` : ""}`;
    paintIdle();
  }
  async function load() {
    if (!tok()) { root.innerHTML = `<div class="cz-head"><h3>🎰 Coin Jackpot</h3></div><p class="cz-safe">Sign in (or join free) to play for coins — win coins, gift them, and the people you gift earn real cash value.</p>`; return; }
    const r = await api("games");
    if (!r.ok) { root.innerHTML = `<div class="cz-head"><h3>🎰 Coin Jackpot</h3></div><p class="cz-safe">${E(r.j.error || "The Jackpot couldn't load right now.")}</p>`; return; }
    const me = await api("me").catch(() => null);
    S.data = r.j; S.data.myCoins = me && me.ok ? me.j.coins : 0;
    for (const g of Object.keys(S.bet)) S.bet[g] = Math.max(S.data.minBet, Math.min(S.bet[g], Math.max(S.data.minBet, S.data.maxBet[g] || S.data.minBet)));
    render();
  }
  const resEl = (g) => root.querySelector(`[data-res="${g}"]`);
  const stageEl = (g) => root.querySelector(`[data-stage="${g}"]`);
  function finish(g, r) {
    S.busy[g] = false;
    if (r.j.coins != null && S.data) S.data.myCoins = r.j.coins;
    if (r.j.pool != null && S.data) S.data.pool = r.j.pool;
    const bal = root.querySelector(".cz-bal b"); if (bal && S.data) bal.textContent = "🪙 " + S.data.myCoins.toLocaleString();
    const poolB = root.querySelector(".cz-pool b"); if (poolB && S.data) poolB.textContent = "🪙 " + S.data.pool.toLocaleString();
    const poolBar = root.querySelector(".cz-pool .bar i"); if (poolBar && S.data) poolBar.style.width = Math.min(100, Math.round((S.data.pool / 5000) * 100)) + "%";
    const btn = root.querySelector(`[data-play="${g}"]`); if (btn) { btn.disabled = false; btn.textContent = "Bet 🪙 " + betOf(g) + " — Play"; }
    setTimeout(load, 2600); // refresh pots, winners and max bets quietly
  }
  function resultLine(g, r, party) {
    const el = resEl(g); if (!el) return;
    const { bet, pay, note } = r.j;
    const big = pay > bet && pay >= bet * 5;
    el.className = "cz-res " + (pay > bet ? "win" : pay === bet ? "push" : "lose") + (big ? " big" : "");
    el.textContent = (note ? note + " " : "") + (pay > bet ? (big ? "💎 BIG WIN! " : "🎉 ") + `You won 🪙 ${pay} (+${pay - bet})!` : pay === bet ? "↩️ Push — your bet is back." : "No win this time. The pool thanks you.");
    if (party && pay > bet) {
      const st = stageEl(g); if (st) st.classList.add("celebrate");
      celebrate(root.querySelector(`[data-card="${g}"]`), big);
    }
  }
  async function play(g) {
    if (S.busy[g] || !S.data) return;
    const bet = betOf(g); if (bet < S.data.minBet) { say("The prize pool is too low for that game right now."); return; }
    S.busy[g] = true;
    const btn = root.querySelector(`[data-play="${g}"]`); if (btn) { btn.disabled = true; btn.textContent = "Playing…"; }
    const el = resEl(g); if (el) { el.className = "cz-res"; el.textContent = ""; }
    const r = await api("play", { game: g, bet, choice: S.pick[g] || "" });
    if (!r.ok) { S.busy[g] = false; if (btn) { btn.disabled = false; btn.textContent = "Bet 🪙 " + bet + " — Play"; } say(r.j.error || "That play didn't go through."); return; }
    const st = stageEl(g), dt = r.j.detail || {};
    const cap = st ? st.querySelector("[data-cap]") : null;
    if (g === "flip" && st) {
      const coin = st.querySelector("[data-coin]");
      if (cap) cap.textContent = "Flipping…";
      if (coin) {
        coin.classList.remove("landed");
        coin.style.transition = "none"; coin.style.transform = "rotateX(0deg)";
        void coin.offsetWidth;
        coin.style.transition = "transform 1.5s cubic-bezier(.2,.7,.25,1)";
        coin.style.transform = `rotateX(${dt.land === "heads" ? 1800 : 1980}deg)`;
      }
      setTimeout(() => { if (coin) coin.classList.add("landed"); if (cap) cap.innerHTML = `It landed <b>${E(dt.land)}</b> — you called ${E(S.pick.flip)}`; resultLine(g, r, true); finish(g, r); }, 1600);
      return;
    }
    if (g === "highcard" && st) {
      const s1 = SUITS[Math.floor(Math.random() * 4)], s2 = SUITS[Math.floor(Math.random() * 4)];
      const fr1 = st.querySelector('[data-fr="you"]'), fr2 = st.querySelector('[data-fr="dealer"]');
      if (fr1) fr1.innerHTML = cardFace(dt.you, s1);
      if (fr2) fr2.innerHTML = cardFace(dt.dealer, s2);
      const you = st.querySelector('[data-fc="you"]'), dl = st.querySelector('[data-fc="dealer"]');
      if (you) you.classList.add("go");
      setTimeout(() => { if (dl) dl.classList.add("go"); }, 280);
      setTimeout(() => { if (cap) cap.innerHTML = `You <b>${rank(dt.you)}</b> vs dealer <b>${rank(dt.dealer)}</b>`; resultLine(g, r, true); finish(g, r); }, 1080);
      return;
    }
    if (g === "dice" && st) {
      const dice = st.querySelectorAll("[data-die]");
      if (cap) cap.textContent = "Rolling…";
      const dbox = st.querySelector(".cz-dice"); if (dbox) dbox.classList.add("rolling");
      dice.forEach((d) => d.classList.add("tumble"));
      let n = 0;
      const iv = setInterval(() => {
        dice.forEach((d) => setDie(d, 1 + Math.floor(Math.random() * 6)));
        if (++n > 7) {
          clearInterval(iv);
          if (dbox) dbox.classList.remove("rolling");
          dice.forEach((d) => d.classList.remove("tumble"));
          setDie(dice[0], dt.d1 || 1); setDie(dice[1], dt.d2 || 1);
          if (cap) cap.innerHTML = `Total <b>${dt.sum}</b> — you called ${E(S.pick.dice === "seven" ? "exactly 7" : S.pick.dice + " 7")}`;
          resultLine(g, r, true); finish(g, r);
        }
      }, 95);
      return;
    }
    if (g === "slots" && st) {
      const strips = st.querySelectorAll(".cz-strip");
      const finals = dt.reels || ["👑", "👑", "👑"];
      const reelsBox = st.querySelector(".cz-reels"); if (reelsBox) reelsBox.classList.add("spinning");
      if (cap) cap.textContent = "Spinning…";
      strips.forEach((strip, i) => {
        const cells = [];
        for (let k = 0; k < 10; k++) cells.push(SLOT_POOL[Math.floor(Math.random() * 6)]);
        cells.push(finals[i] || "👑");
        strip.innerHTML = cells.map((s) => `<span>${E(s)}</span>`).join("");
        strip.style.transition = "none"; strip.style.transform = "translateY(0px)";
        void strip.offsetWidth;
        strip.style.transitionDuration = (1 + i * 0.45) + "s";
        strip.style.transform = `translateY(${-(cells.length - 1) * 66}px)`;
      });
      setTimeout(() => { const rb = st.querySelector(".cz-reels"); if (rb) { rb.classList.remove("spinning"); rb.classList.toggle("winline", r.j.pay > 0); } if (cap) cap.innerHTML = r.j.pay > r.j.bet ? "Jackpot line!" : r.j.pay > 0 ? "A pair pays out." : "No match."; resultLine(g, r, true); finish(g, r); }, 2080);
      return;
    }
    if (g === "race" && st) {
      const rolls = dt.rolls || [];
      let pos = 0, step = 0;
      const cells = st.querySelectorAll("[data-cell]");
      const drawBoard = () => cells.forEach((c, i) => { c.className = i < pos ? "lit" : i === pos ? "here" : ""; c.textContent = i === pos ? "👑" : String(i + 1); });
      if (!cells.length) { resultLine(g, r, true); finish(g, r); return; }
      const iv = setInterval(() => {
        if (step < rolls.length) { pos = Math.min(23, pos + rolls[step]); if (cap) cap.textContent = `Die ${step + 1}: rolled ${rolls[step]} — total so far ${rolls.slice(0, step + 1).reduce((a, b) => a + b, 0)}`; step++; drawBoard(); }
        else { clearInterval(iv); if (cap) cap.innerHTML = `🏁 Final total <b>${dt.total}</b> of 24`; resultLine(g, r, true); finish(g, r); }
      }, 620);
      drawBoard();
      return;
    }
    if (g === "wheel" && st) {
      const cv = st.querySelector(".cz-wheelcv");
      const seg = Math.max(0, Math.min(11, dt.seg | 0));
      if (cap) cap.textContent = "Spinning…";
      if (cv) {
        drawWheel(cv, -1);
        const wwrap = cv.closest(".cz-wheelwrap"); if (wwrap) wwrap.classList.add("spinning");
        cv.style.transition = "none"; cv.style.transform = "rotate(0deg)";
        void cv.offsetWidth;
        cv.style.transition = "transform 3.4s cubic-bezier(.1,.7,.08,1)";
        cv.style.transform = `rotate(${2160 - (seg * 30 + 15)}deg)`;
      }
      setTimeout(() => { if (cv) drawWheel(cv, seg); const ww2 = cv ? cv.closest(".cz-wheelwrap") : null; if (ww2) ww2.classList.remove("spinning"); if (cap) cap.innerHTML = `It stopped on <b>${WHEEL_SEGS[seg]}×</b>`; resultLine(g, r, true); finish(g, r); }, 3520);
      return;
    }
    if (g === "plinko" && st) {
      const cv = st.querySelector(".cz-plkcv");
      const path = Array.isArray(dt.path) && dt.path.length === 7 ? dt.path : [0, 0, 0, 0, 0, 0, 0];
      if (cap) cap.textContent = "Bouncing…";
      let hops = 0;
      if (cv) drawPlinko(cv, path, 0, -1);
      const iv = setInterval(() => {
        hops++;
        if (cv) drawPlinko(cv, path, hops, hops >= 7 ? dt.slot : -1);
        if (hops >= 7) {
          clearInterval(iv);
          const labels = st.querySelectorAll(".cz-plkslots i");
          if (labels[dt.slot]) labels[dt.slot].classList.add("hit");
          if (cap) cap.innerHTML = `It landed in slot <b>${dt.slot + 1}</b> of 8 — <b>${dt.mult}×</b>`;
          resultLine(g, r, true); finish(g, r);
        }
      }, 210);
      return;
    }
    if (g === "triple" && st) {
      const coins = st.querySelectorAll("[data-coin]");
      const flips = dt.flips || [0, 0, 0];
      if (cap) cap.textContent = "Flipping…";
      coins.forEach((coin, i) => {
        coin.classList.remove("landed");
        coin.style.transition = "none"; coin.style.transform = "rotateX(0deg)";
        void coin.offsetWidth;
        coin.style.transition = "transform 1.3s cubic-bezier(.2,.7,.25,1)";
        coin.style.transitionDelay = (i * 0.16) + "s";
        coin.style.transform = `rotateX(${flips[i] ? 1800 : 1980}deg)`;
      });
      setTimeout(() => { coins.forEach((c2) => c2.classList.add("landed")); if (cap) cap.innerHTML = `<b>${dt.heads} heads</b>, ${3 - (dt.heads || 0)} tails`; resultLine(g, r, true); finish(g, r); }, 1750);
      return;
    }
    resultLine(g, r, true); finish(g, r);
  }
  root.addEventListener("click", async (e) => {
    if (e.target.closest("[data-coins-open]")) { openWallet(ctx); return; }
    const chip = e.target.closest("[data-chips] button");
    if (chip) { const g = chip.closest("[data-chips]").dataset.chips; S.bet[g] = +chip.dataset.amt; render(); return; }
    const pk = e.target.closest("[data-pick] button");
    if (pk) { const key = pk.closest("[data-pick]").dataset.pick; S.pick[key] = pk.dataset.v; pk.closest("[data-pick]").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === pk)); return; }
    const pl = e.target.closest("[data-play]");
    if (pl) { play(pl.dataset.play); return; }
    const pc = e.target.closest("[data-promo-claim]");
    if (pc) { pc.disabled = true; pc.textContent = "Claiming…"; const r = await api("promo/claim", {}); if (r.ok) { say(`🎁 +${r.j.amount} coins — they're in your wallet. Good luck!`); if (S.data) { if (S.data.promo) S.data.promo.claimed = true; S.data.myCoins = r.j.coins; } load(); } else { say(r.j.error || "Couldn't claim right now."); pc.disabled = false; pc.textContent = "🪙 Claim coins"; } return; }
    const ac = e.target.closest("[data-autochips] button");
    if (ac) { const g = ac.closest("[data-autochips]").dataset.autochips; S.autoPick[g] = +ac.dataset.an; ac.closest("[data-autochips]").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === ac)); return; }
    const ab = e.target.closest("[data-auto]");
    if (ab) { autoRun(ab.dataset.auto); return; }
    const as = e.target.closest("[data-autostop]");
    if (as) { if (S.auto) { S.auto.stop = true; as.disabled = true; as.textContent = "Stopping…"; } return; }
    const join = e.target.closest("[data-pot-join]");
    if (join) { join.disabled = true; const r = await api("pot/join", { id: join.dataset.potJoin }); if (!r.ok) { say(r.j.error || "Couldn't join that pot."); join.disabled = false; return; } say(r.j.youWon ? `🎉 The coin landed ${r.j.land} — you won 🪙 ${r.j.prize}!` : `The coin landed ${r.j.land} — the pot goes to the other player this time.`); load(); return; }
    const cancel = e.target.closest("[data-pot-cancel]");
    if (cancel) { const r = await api("pot/cancel", { id: cancel.dataset.potCancel }); say(r.ok ? "Pot cancelled — your coins are back." : r.j.error || "Couldn't cancel."); load(); return; }
  });
  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.target.id === "cz-potform") {
      const bet = Math.round(+root.querySelector("#cz-potbet").value || 0); S.potBet = bet;
      const r = await api("pot/create", { bet, side: S.pick.potSide });
      say(r.ok ? "Pot is live — another member can take the other side." : r.j.error || "Couldn't start the pot."); if (r.ok) load();
    }
    if (e.target.id === "cz-grant") { const amt = Math.round(+root.querySelector("#cz-grant-amt").value || 0); const r = await api("admin/grant", { coins: amt }); say(r.ok ? `Granted 🪙 ${amt} to your wallet.` : r.j.error || "Grant failed."); if (r.ok) load(); }
    if (e.target.id === "cz-seed") { const amt = Math.round(+root.querySelector("#cz-seed-amt").value || 0); const r = await api("pool/seed", { coins: amt }); say(r.ok ? `Prize pool seeded — it's now 🪙 ${r.j.pool}.` : r.j.error || "Seeding failed."); if (r.ok) load(); }
  });
  load();
  return () => { if (S.auto) S.auto.stop = true; };

}
