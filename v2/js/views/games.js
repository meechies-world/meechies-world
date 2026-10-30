/* ============================================================================
   v2 GAMES VIEW (Phase 5) — the live Games view, all three parts:
   the Coin Jackpot on top (js/jackpot.js, the ported live games.js —
   eight server-settled games + PvP pots), Gold Rush Arena (the
   app-core arena, ported: same canvas game, same room lobby over the
   changes feed, same scores board), and the Fortnite Squad Finder
   (the squads collection, same shape). Markup is the live section's.
   ============================================================================ */

import { mountJackpot } from "../jackpot.js";
import { createDb, esc } from "../platform.js";
import { toast } from "../commerce.js";

const SECTION = `
<div class="wrap">
  <div class="jackpot"></div>
  <div class="section-head">
    <div><p class="eyebrow">Play together</p><h2>Games</h2></div>
    <p class="muted">Win coins in the Coin Jackpot, battle other members live in Gold Rush Arena, and find a squad for Fortnite.</p>
  </div>
  <div class="arena-wrap">
    <div class="arena-top">
      <div><h3 class="sub-h" style="font-size:30px">Gold Rush Arena</h3><p class="muted" style="margin:4px 0 0;font-size:14px">Last one standing in the storm. Eliminate players, stay inside the gold circle, respawn and go again.</p></div>
      <div class="arena-stats"><span>Eliminations <b id="g-k">0</b></span><span>Health <b id="g-hp">100</b></span><span id="g-players">Practice mode</span></div>
    </div>
    <div class="arena" id="arena">
      <canvas id="g-canvas" width="960" height="560" aria-label="Gold Rush Arena game"></canvas>
      <div class="g-over" id="g-start">
        <h3>Gold Rush Arena</h3>
        <p>Move: <b>WASD</b> or arrow keys · Aim: <b>mouse</b> · Shoot: <b>click</b> or <b>space</b><br>On a phone: touch to move, tap <b>FIRE</b> to auto-aim.</p>
        <button class="btn" type="button" id="g-play">Play now</button>
        <small class="muted" id="g-mode-note">Signed-in members battle each other live. Bots fill in when you're alone.</small>
      </div>
      <div class="g-dead" id="g-dead" hidden>Eliminated. Back in <b id="g-rs">3</b>…</div>
      <button class="g-fire" id="g-fire" type="button" aria-label="Fire">FIRE</button>
    </div>
    <div class="arena-bottom">
      <div class="card"><h3 style="font-size:16px;letter-spacing:.06em;margin-bottom:10px">LIVE FEED</h3><div class="killfeed" id="g-feed"><span class="muted">Eliminations show here.</span></div></div>
      <div class="card"><h3 style="font-size:16px;letter-spacing:.06em;margin-bottom:10px">ALL-TIME LEADERS</h3><ol class="leaders" id="g-leaders"><li class="muted">Get an elimination to make the board.</li></ol></div>
    </div>
  </div>

  <h3 class="sub-h" style="margin-top:64px">Fortnite Squad Finder</h3>
  <p class="muted center-p">Post your Epic name and what you want to play. Add each other in Fortnite and squad up.</p>
  <form class="card" id="sq-form" style="max-width:760px;margin:0 auto">
    <div class="req">
      <div class="field"><label for="sq-epic">Epic Games name</label><input type="text" id="sq-epic" maxlength="40" required></div>
      <div class="field"><label for="sq-plat">Platform</label><select id="sq-plat"><option>PlayStation</option><option>Xbox</option><option>PC</option><option>Switch</option><option>Mobile</option></select></div>
      <div class="field"><label for="sq-mode">Mode</label><select id="sq-mode"><option>Battle Royale squads</option><option>Duos</option><option>Zero Build</option><option>Ranked</option><option>Creative / box fights</option><option>Custom match</option></select></div>
      <div class="field"><label for="sq-note">Note (optional)</label><input type="text" id="sq-note" maxlength="80" placeholder="On tonight 9pm, mic on"></div>
    </div>
    <div style="display:flex;justify-content:center;margin-top:14px"><button class="btn" type="submit">Post to Squad Finder</button></div>
  </form>
  <div class="squads" id="squads"><div class="empty">No squads posted yet. Be the first.</div></div>
</div>`;

let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = SECTION;
  const db = createDb(ctx);
  const me = db.me();
  const stopJackpot = mountJackpot(root.querySelector(".jackpot"), ctx);
  if (stopJackpot) cleanup.push(stopJackpot);

  /* ---------------- Gold Rush Arena (app-core port) ---------------- */
  const $ = (s) => root.querySelector(s);
  const gc = $("#g-canvas"), gx = gc.getContext("2d");
  const AW = 960, AH = 560, PR = 16, SPEED = 3.2, BSPEED = 11, BLIFE = 55, CYCLE = 120000;
  const WALLS = [[150, 110, 120, 26], [690, 110, 120, 26], [150, 424, 120, 26], [690, 424, 120, 26], [440, 250, 80, 60], [300, 230, 26, 100], [634, 230, 26, 100], [60, 260, 60, 40], [840, 260, 60, 40]];
  const myName = () => { const u = ctx.session.user(); return (u && u.name) || "You"; };
  let alive = true;
  const GM = { on: false, me: null, bullets: [], remote: new Map(), seenShots: new Set(), seenDeaths: {}, bots: [], keys: {}, aim: { x: AW / 2, y: AH / 2 }, moveT: null, arena: null, myPeer: null, kills: 0, total: 0, last: 0, fireCd: 0, feed: [] };
  const freeSpot = () => { for (let i = 0; i < 60; i++) { const x = 60 + Math.random() * (AW - 120), y = 60 + Math.random() * (AH - 120); if (!hitWall(x, y, PR + 6)) return { x, y }; } return { x: AW / 2, y: 80 }; };
  const hitWall = (x, y, r) => WALLS.some(([wx, wy, ww, wh]) => x + r > wx && x - r < wx + ww && y + r > wy && y - r < wy + wh);
  const storm = () => { const t = (Date.now() % CYCLE) / CYCLE; return { x: AW / 2, y: AH / 2, r: Math.max(150, 560 - t * 1.2 * 410) }; };
  const newMe = () => { const p = freeSpot(); return { x: p.x, y: p.y, a: 0, hp: 100, dead: false, deaths: (GM.me && GM.me.deaths) || 0, killedBy: null, shots: [], look: { c: "#232323", s: "#a26a43", t: "#d4a843" }, n: myName(), uid: me }; };
  const spawnBots = () => { GM.bots = [0, 1, 2].map((i) => { const p = freeSpot(); return { id: "bot" + i, x: p.x, y: p.y, a: 0, hp: 100, dead: false, deaths: 0, cd: 0, tx: p.x, ty: p.y, n: ["Ms. Baddie", "Melody", "Gold Bot"][i], look: { c: ["#7a1f2b", "#1f3d7a", "#2f6b45"][i], s: ["#c68a5e", "#7a4a2b", "#e0ac83"][i], t: "#d4a843" }, respawn: 0 }; }); };
  function syncRemote() {
    const live = new Set();
    (GM.peers || []).forEach((p) => {
      if (p.isMe || !p.presence || !p.presence.g) return;
      const g = p.presence.g; live.add(p.peer);
      let r = GM.remote.get(p.peer); if (!r) { r = { rx: g.x, ry: g.y }; GM.remote.set(p.peer, r); }
      Object.assign(r, g, { peer: p.peer });
      (g.shots || []).forEach((s) => { const k = p.peer + ":" + s.i; if (GM.seenShots.has(k)) return; GM.seenShots.add(k); if (Date.now() - s.t < 1500) GM.bullets.push({ x: s.x, y: s.y, dx: Math.cos(s.a) * BSPEED, dy: Math.sin(s.a) * BSPEED, life: BLIFE, from: p.peer, mine: false }); });
      const d = g.deaths || 0;
      if (GM.seenDeaths[p.peer] === undefined) GM.seenDeaths[p.peer] = d;
      else if (d > GM.seenDeaths[p.peer]) { GM.seenDeaths[p.peer] = d; const killer = g.killedBy; if (killer && killer === GM.myPeer) creditKill(g.n || "a player"); else addFeed((killer && GM.remote.get(killer) && GM.remote.get(killer).n) || "The storm", g.n || "a player"); }
    });
    for (const k of GM.remote.keys()) if (!live.has(k)) GM.remote.delete(k);
    $("#g-players").textContent = GM.remote.size ? (GM.remote.size + 1) + " players live" : "Practice mode · bots";
  }
  function addFeed(a, b) { GM.feed.unshift(`<div><b>${esc(a)}</b> eliminated <b>${esc(b)}</b></div>`); GM.feed = GM.feed.slice(0, 12); $("#g-feed").innerHTML = GM.feed.join(""); }
  function creditKill(victim, isBot) {
    GM.kills++; GM.total++; addFeed(GM.me.n, victim); updHud(); toast("Eliminated " + victim);
    if (me && !isBot) db.setDoc("scores/" + me, { elims: GM.total, name: myName(), updatedAt: Date.now() }).catch(() => {});
  }
  function updHud() { $("#g-k").textContent = GM.kills; $("#g-hp").textContent = Math.max(0, Math.round((GM.me && GM.me.hp) != null ? GM.me.hp : 100)); }
  function shoot() {
    const m = GM.me; if (!m || m.dead || GM.fireCd > 0) return; GM.fireCd = 12;
    const s = { i: Math.random().toString(36).slice(2, 8), x: m.x + Math.cos(m.a) * (PR + 4), y: m.y + Math.sin(m.a) * (PR + 4), a: m.a, t: Date.now() };
    GM.bullets.push({ x: s.x, y: s.y, dx: Math.cos(s.a) * BSPEED, dy: Math.sin(s.a) * BSPEED, life: BLIFE, from: "me", mine: true });
    m.shots = [...m.shots, s].slice(-6);
  }
  function damageMe(n, by) {
    const m = GM.me; if (!m || m.dead) return; m.hp -= n;
    if (m.hp <= 0) {
      m.hp = 0; m.dead = true; m.deaths++; m.killedBy = by; let t = 3;
      $("#g-dead").hidden = false; $("#g-rs").textContent = t;
      const iv = setInterval(() => { t--; const rs = $("#g-rs"); if (rs) rs.textContent = t; if (t <= 0 || !alive) { clearInterval(iv); const d = m.deaths; GM.me = newMe(); GM.me.deaths = d; const gd = $("#g-dead"); if (gd) gd.hidden = true; updHud(); } }, 1000);
      if (by && String(by).startsWith("bot")) addFeed((GM.bots.find((b) => b.id === by) || {}).n || "Bot", m.n);
      if (!by) addFeed("The storm", m.n);
    }
    updHud();
  }
  function botAI(b) {
    if (b.dead) { if (Date.now() > b.respawn) { const p = freeSpot(); Object.assign(b, { x: p.x, y: p.y, hp: 100, dead: false }); } return; }
    const tgt = GM.me && !GM.me.dead ? GM.me : null; const st = storm();
    if (Math.hypot(b.tx - b.x, b.ty - b.y) < 10 || Math.random() < .01) { const ang = Math.random() * Math.PI * 2, rr = Math.random() * st.r * .7; b.tx = st.x + Math.cos(ang) * rr; b.ty = st.y + Math.sin(ang) * rr; }
    const dx = b.tx - b.x, dy = b.ty - b.y, d = Math.hypot(dx, dy) || 1;
    const nx = b.x + dx / d * SPEED * .7, ny = b.y + dy / d * SPEED * .7;
    if (!hitWall(nx, ny, PR)) { b.x = nx; b.y = ny; } else { b.tx = b.x + (Math.random() - .5) * 300; b.ty = b.y + (Math.random() - .5) * 300; }
    if (tgt) { const ad = Math.hypot(tgt.x - b.x, tgt.y - b.y); b.a = Math.atan2(tgt.y - b.y, tgt.x - b.x) + (Math.random() - .5) * .25; b.cd -= 1; if (ad < 420 && b.cd <= 0) { b.cd = 40 + Math.random() * 40; GM.bullets.push({ x: b.x + Math.cos(b.a) * 20, y: b.y + Math.sin(b.a) * 20, dx: Math.cos(b.a) * BSPEED * .8, dy: Math.sin(b.a) * BSPEED * .8, life: BLIFE, from: b.id, mine: false }); } }
    if (Math.hypot(b.x - st.x, b.y - st.y) > st.r) b.hp -= .08;
    if (b.hp <= 0) { b.dead = true; b.respawn = Date.now() + 3000; }
  }
  function drawPlayer(p, x, y, isMe) {
    if (p.dead) return;
    gx.save(); gx.translate(x, y);
    gx.fillStyle = "rgba(0,0,0,.4)"; gx.beginPath(); gx.ellipse(3, 5, PR, PR * .8, 0, 0, 7); gx.fill();
    gx.rotate(p.a || 0); gx.fillStyle = "#222"; gx.fillRect(PR - 4, -3, 16, 6); gx.fillStyle = (p.look && p.look.t) || "#d4a843"; gx.fillRect(PR + 8, -3, 4, 6);
    gx.fillStyle = (p.look && p.look.c) || "#111"; gx.beginPath(); gx.arc(0, 0, PR, 0, 7); gx.fill(); gx.lineWidth = 2.5; gx.strokeStyle = isMe ? "#f0cf78" : ((p.look && p.look.t) || "#8c6d26"); gx.stroke();
    gx.fillStyle = (p.look && p.look.s) || "#a26a43"; gx.beginPath(); gx.arc(3, 0, 8, 0, 7); gx.fill();
    gx.restore();
    gx.font = "700 12px Hanken Grotesk, system-ui, sans-serif"; gx.textAlign = "center"; gx.fillStyle = isMe ? "#f0cf78" : "#fff"; gx.fillText(isMe ? "You" : (p.n || "Player"), x, y - PR - 14);
    gx.fillStyle = "rgba(0,0,0,.6)"; gx.fillRect(x - 18, y - PR - 9, 36, 5); gx.fillStyle = p.hp > 50 ? "#6fbf8b" : p.hp > 25 ? "#e5b44d" : "#e5484d"; gx.fillRect(x - 18, y - PR - 9, 36 * Math.max(0, p.hp) / 100, 5);
  }
  function drawArena(st) {
    for (let y = 0; y < AH; y += 40) for (let x = 0; x < AW; x += 40) { gx.fillStyle = ((x + y) / 40) % 2 ? "#14110b" : "#1d1810"; gx.fillRect(x, y, 40, 40); }
    gx.strokeStyle = "rgba(212,168,67,.25)"; gx.lineWidth = 2; gx.strokeRect(20, 20, AW - 40, AH - 40);
    gx.save(); gx.globalAlpha = .18; gx.strokeStyle = "#d4a843"; gx.lineWidth = 3; gx.beginPath(); gx.moveTo(480, 190); gx.lineTo(560, 330); gx.lineTo(400, 330); gx.closePath(); gx.stroke(); gx.restore();
    WALLS.forEach(([x, y, w, h]) => { gx.fillStyle = "#0a0806"; gx.fillRect(x + 4, y + 6, w, h); const gr = gx.createLinearGradient(x, y, x, y + h); gr.addColorStop(0, "#3a2d14"); gr.addColorStop(1, "#241b0c"); gx.fillStyle = gr; gx.fillRect(x, y, w, h); gx.strokeStyle = "#8c6d26"; gx.lineWidth = 1.5; gx.strokeRect(x + .5, y + .5, w - 1, h - 1); });
    gx.save(); gx.fillStyle = "rgba(90,30,140,.38)"; gx.beginPath(); gx.rect(0, 0, AW, AH); gx.arc(st.x, st.y, st.r, 0, Math.PI * 2, true); gx.fill("evenodd"); gx.strokeStyle = "#f0cf78"; gx.lineWidth = 3; gx.setLineDash([12, 8]); gx.beginPath(); gx.arc(st.x, st.y, st.r, 0, 7); gx.stroke(); gx.restore();
    GM.bullets.forEach((b) => { gx.strokeStyle = b.mine ? "#fff3c9" : "#ff8a8d"; gx.lineWidth = 3; gx.beginPath(); gx.moveTo(b.x, b.y); gx.lineTo(b.x - b.dx * 1.4, b.y - b.dy * 1.4); gx.stroke(); });
    if (GM.remote.size === 0) GM.bots.forEach((b) => drawPlayer(b, b.x, b.y, false));
    for (const r of GM.remote.values()) drawPlayer(r, r.rx, r.ry, false);
    drawPlayer(GM.me, GM.me.x, GM.me.y, true);
    const left = Math.ceil((CYCLE - (Date.now() % CYCLE)) / 1000); gx.font = "700 14px Cinzel, Georgia, serif"; gx.fillStyle = "#f0cf78"; gx.textAlign = "left"; gx.fillText("STORM RESETS IN " + left + "s", 28, 46);
  }
  function loop(now) {
    if (!GM.on || !alive) return;
    const dt = Math.min(3, (now - GM.last) / 16.67); GM.last = now;
    const m = GM.me, st = storm();
    if (!m.dead) {
      let vx = (GM.keys.d || GM.keys.arrowright ? 1 : 0) - (GM.keys.a || GM.keys.arrowleft ? 1 : 0), vy = (GM.keys.s || GM.keys.arrowdown ? 1 : 0) - (GM.keys.w || GM.keys.arrowup ? 1 : 0);
      if (GM.moveT) { const dx = GM.moveT.x - m.x, dy = GM.moveT.y - m.y, d = Math.hypot(dx, dy); if (d > 8) { vx = dx / d; vy = dy / d; } }
      const l = Math.hypot(vx, vy) || 1; const nx = m.x + vx / l * SPEED * dt, ny = m.y + vy / l * SPEED * dt;
      if (!hitWall(nx, m.y, PR)) m.x = Math.min(AW - PR, Math.max(PR, nx));
      if (!hitWall(m.x, ny, PR)) m.y = Math.min(AH - PR, Math.max(PR, ny));
      m.a = Math.atan2(GM.aim.y - m.y, GM.aim.x - m.x);
      if (GM.keys[" "] || GM.mouseDown) shoot();
      if (Math.hypot(m.x - st.x, m.y - st.y) > st.r) damageMe(.09 * dt, null);
    }
    GM.fireCd -= dt;
    const solo = GM.remote.size === 0; if (solo) GM.bots.forEach((b) => botAI(b));
    GM.bullets = GM.bullets.filter((b) => {
      b.x += b.dx * dt; b.y += b.dy * dt; b.life -= dt;
      if (b.life <= 0 || hitWall(b.x, b.y, 2) || b.x < 0 || b.y < 0 || b.x > AW || b.y > AH) return false;
      if (!b.mine && !m.dead && Math.hypot(b.x - m.x, b.y - m.y) < PR) { damageMe(20, b.from); return false; }
      if (b.mine) {
        if (solo) for (const bot of GM.bots) { if (!bot.dead && Math.hypot(b.x - bot.x, b.y - bot.y) < PR) { bot.hp -= 20; if (bot.hp <= 0) { bot.dead = true; bot.respawn = Date.now() + 3000; creditKill(bot.n, true); } return false; } }
        for (const r of GM.remote.values()) if (!r.dead && Math.hypot(b.x - r.rx, b.y - r.ry) < PR) return false;
      }
      return true;
    });
    for (const r of GM.remote.values()) { r.rx += (r.x - r.rx) * .35; r.ry += (r.y - r.ry) * .35; }
    if (GM.arena) { try { GM.arena.track({ uid: me, g: { x: Math.round(m.x), y: Math.round(m.y), a: +m.a.toFixed(2), hp: Math.round(m.hp), dead: m.dead, deaths: m.deaths, killedBy: m.killedBy, shots: m.shots, n: m.n, look: m.look } }); } catch (_) {} }
    drawArena(st);
    requestAnimationFrame(loop);
  }
  async function startGame() {
    $("#g-start").hidden = true; GM.on = true; GM.me = newMe(); GM.kills = 0; updHud();
    if (me) {
      GM.arena = db.room("arena");
      GM.myPeer = GM.arena.peer;
      GM.arena.onPresence(() => { GM.peers = GM.arena.peers(me); syncRemote(); });
    }
    spawnBots(); GM.last = performance.now(); requestAnimationFrame(loop);
  }
  const toArena = (e) => { const r = gc.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * AW, y: (e.clientY - r.top) / r.height * AH }; };
  gc.addEventListener("mousemove", (e) => { GM.aim = toArena(e); });
  gc.addEventListener("mousedown", (e) => { if (e.pointerType === "touch") return; GM.aim = toArena(e); GM.mouseDown = true; shoot(); });
  window.addEventListener("mouseup", () => { GM.mouseDown = false; });
  gc.addEventListener("touchstart", (e) => { e.preventDefault(); GM.moveT = toArena(e.touches[0]); }, { passive: false });
  gc.addEventListener("touchmove", (e) => { e.preventDefault(); GM.moveT = toArena(e.touches[0]); }, { passive: false });
  gc.addEventListener("touchend", () => { GM.moveT = null; });
  $("#g-fire").addEventListener("click", () => {
    const m = GM.me; if (!m) return;
    const targets = [...(GM.remote.size ? [...GM.remote.values()].map((r) => ({ x: r.rx, y: r.ry, dead: r.dead })) : GM.bots)].filter((t) => !t.dead);
    let best = null, bd = 1e9; targets.forEach((t) => { const d = Math.hypot(t.x - m.x, t.y - m.y); if (d < bd) { bd = d; best = t; } });
    if (best) GM.aim = { x: best.x, y: best.y };
    m.a = Math.atan2(GM.aim.y - m.y, GM.aim.x - m.x); shoot();
  });
  const onKey = (down) => (e) => {
    if (!alive || !GM.on || !root.isConnected) return;
    if (e.target.matches("input,textarea,select")) return;
    const k = e.key.toLowerCase();
    if (down && ["w", "a", "s", "d", " ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) { GM.keys[k] = true; e.preventDefault(); }
    if (!down) GM.keys[k] = false;
  };
  const kd = onKey(true), ku = onKey(false);
  window.addEventListener("keydown", kd); window.addEventListener("keyup", ku);
  cleanup.push(() => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); });
  $("#g-play").addEventListener("click", startGame);
  GM.me = newMe(); spawnBots(); drawArena(storm());
  cleanup.push(() => { alive = false; GM.on = false; if (GM.arena) GM.arena.leave(); });

  /* leaders (scores collection) */
  const paintLeaders = async () => {
    const rows = await db.listDocs("scores", { field: "elims", limit: 200 });
    const top = rows.sort((a, b) => (b.elims || 0) - (a.elims || 0)).slice(0, 10);
    const el = $("#g-leaders"); if (!el || !top.length) return;
    el.innerHTML = top.map((v) => `<li>${esc(v.name || "Member")} · <b>${(+v.elims) || 0}</b></li>`).join("");
  };
  paintLeaders();
  cleanup.push(db.watchDocs("scores", paintLeaders));

  /* ---------------- Fortnite Squad Finder ---------------- */
  const ago = (t) => { const s = Math.max(1, (Date.now() - (t || 0)) / 1000); if (s < 90) return "just now"; if (s < 5400) return Math.round(s / 60) + "m ago"; if (s < 129600) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; };
  const names = {};
  db.listDocs("members", { limit: 200 }).then((rows) => rows.forEach((m) => { names[m.id] = m.handle || m.name || m.username || "Member"; })).catch(() => {});
  const paintSquads = async () => {
    const rows = await db.listDocs("squads", { field: "createdAt", limit: 60 });
    const box = $("#squads"); if (!box) return;
    const list = rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 60);
    if (!list.length) { box.innerHTML = '<div class="empty">No squads posted yet. Be the first.</div>'; return; }
    box.innerHTML = list.map((q) => `<div class="squad"><small>${esc(names[q.authorId] || "Member")} · ${ago(q.createdAt)}</small><span class="epic">${esc(q.epic)}</span><span class="badge">${esc(q.platform)}</span><b>${esc(q.mode)}</b>${q.note ? `<small>${esc(q.note)}</small>` : ""}<div class="fit-acts"><button class="btn sm ghost" type="button" data-epic="${esc(q.epic)}">Copy Epic name</button>${q.authorId === me || db.isOwner() ? `<button class="act" type="button" data-sqdel="${q.id}">Delete</button>` : ""}</div></div>`).join("");
  };
  paintSquads();
  cleanup.push(db.watchDocs("squads", paintSquads));
  $("#squads").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.epic && navigator.clipboard) navigator.clipboard.writeText(b.dataset.epic).then(() => toast("Epic name copied: " + b.dataset.epic));
    if (b.dataset.sqdel) { if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Tap again"; return; } db.delDoc("squads/" + b.dataset.sqdel).catch((err) => toast(err.message)); }
  });
  $("#sq-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!me) { toast("Join free to post to the Squad Finder."); return; }
    try {
      await db.addDoc("squads", { authorId: me, epic: $("#sq-epic").value.trim(), platform: $("#sq-plat").value, mode: $("#sq-mode").value, note: $("#sq-note").value.trim(), createdAt: Date.now() });
      e.target.reset(); toast("Posted to the Squad Finder"); paintSquads();
    } catch (err) { toast(err.message); }
  });
  cleanup.push(() => db.stop());
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
