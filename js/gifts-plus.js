/* TikTok-style gifting for Meechie's World (our own gifts, not TikTok's):
 * - Gift menu from 🌹 Rose (1 coin) up to 🌍 Meechie's World (20,000 coins), big ones marked ✨
 * - Send x1 / x5 / x10 / x99, and tap Send again within 3 seconds to build a combo (x2, x3 …)
 * - Big gifts (500+ coins) play a full-screen animation for the person who gets it and everyone watching their Live
 * - MW_GIFTS.quick(to, kind, battleId) sends one gift instantly (used by Live battles)
 * Coins and the 60/40 split are handled by the server (functions/api/coins). There are no free gifts. */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const $ = (s, r = document) => r.querySelector(s);
  const ME = () => { try { return typeof me !== "undefined" ? me : null; } catch (_) { return null; } };
  const NAME = (id) => { try { return typeof handleOf === "function" ? handleOf(id) : "Someone"; } catch (_) { return "Someone"; } };
  const tok = () => { try { return MW.session().access_token; } catch (_) { return ""; } };
  let CAT = [], BY = {}, qty = 1, combo = { kind: "", n: 0, t: 0 }, paid = false;

  const css = document.createElement("style");
  css.textContent = `#gift-grid.gp{display:grid!important;grid-template-columns:repeat(4,1fr)!important;gap:8px!important;max-height:44dvh;overflow:auto;padding:2px}
#gift-grid.gp .gift{display:grid;justify-items:center;gap:2px;padding:10px 4px 8px;border-radius:14px;border:1px solid rgba(214,170,74,.3);background:rgba(10,8,5,.7);color:#f3ecdc;font:700 11.5px system-ui;cursor:pointer;position:relative}
#gift-grid.gp .gift span{font-size:30px;line-height:1.1}
#gift-grid.gp .gift .price{color:#ffd76a;font:800 11px system-ui}
#gift-grid.gp .gift.fx::after{content:"✨";position:absolute;top:3px;right:5px;font-size:11px}
#gift-grid.gp .gift[aria-pressed=true]{background:linear-gradient(172deg,#fff6cf,#ffd76a 30%,#e0a93a 60%,#ffe08a)!important;color:#130e04!important;border-color:#ffe08a;transform:scale(1.04)}
#gift-grid.gp .gift[aria-pressed=true] .price{color:#3a2600}
#gp-qty{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
#gp-qty button{border:1px solid #d6aa4a;background:transparent;color:#ffe08a;border-radius:999px;padding:6px 12px;font:800 13px system-ui;cursor:pointer}
#gp-qty button[aria-pressed=true]{background:#d6aa4a;color:#130e04}
#gp-total{margin-left:auto;font:800 14px system-ui;color:#ffe08a}
#gp-combo{position:absolute;right:18px;top:14px;font:900 28px/1 system-ui;color:#ffd76a;text-shadow:0 0 14px rgba(255,190,60,.8),0 2px 0 #000;transform-origin:center;pointer-events:none}
#gp-combo.pop{animation:gpPop .35s ease-out}@keyframes gpPop{0%{transform:scale(1.8)}100%{transform:scale(1)}}
#gift-fx{position:fixed;inset:0;z-index:10090;pointer-events:none;display:grid;place-items:center;overflow:hidden;background:radial-gradient(60% 50% at 50% 50%,rgba(255,190,70,.35),rgba(0,0,0,.55) 70%);animation:gfxBg 3.2s ease forwards}
@keyframes gfxBg{0%{opacity:0}10%{opacity:1}80%{opacity:1}100%{opacity:0}}
#gift-fx .rays{position:absolute;width:160vmax;height:160vmax;background:repeating-conic-gradient(from 0deg,rgba(255,215,106,.22) 0 8deg,transparent 8deg 20deg);animation:gfxSpin 3.2s linear}
@keyframes gfxSpin{to{transform:rotate(80deg)}}
#gift-fx .big{position:relative;font-size:min(42vw,260px);line-height:1;filter:drop-shadow(0 10px 40px rgba(0,0,0,.6)) drop-shadow(0 0 30px rgba(255,200,90,.7));animation:gfxBig 3.2s cubic-bezier(.2,1.4,.4,1) forwards}
@keyframes gfxBig{0%{transform:scale(.1) rotate(-20deg)}18%{transform:scale(1.15) rotate(4deg)}30%{transform:scale(1) rotate(0)}85%{transform:scale(1.05)}100%{transform:scale(1.4);opacity:0}}
#gift-fx .who{position:absolute;bottom:20dvh;left:0;right:0;text-align:center;font:400 clamp(26px,7vw,44px)/1.1 var(--brush,system-ui);color:#fff3c4;text-shadow:0 3px 14px #000,0 0 18px rgba(255,190,60,.8);padding:0 16px}
#gift-fx i{position:absolute;top:-10vh;font-style:normal;font-size:28px;animation:gfxFall 2.6s linear forwards}
@keyframes gfxFall{to{transform:translateY(120vh) rotate(540deg)}}`;
  document.head.appendChild(css);

  async function load() {
    try { const j = await fetch("/api/coins/info").then((r) => r.json()); CAT = j.catalog || []; paid = !!j.paid; } catch (_) {}
    if (!CAT.length) return;
    BY = Object.fromEntries(CAT.map((g) => [g.k, g]));
    // the feed's "recent gifts" list uses the page's GIFTS list: teach it the new ones
    try { if (typeof GIFTS !== "undefined") CAT.forEach((g) => { if (!GIFTS.find((x) => x[0] === g.k)) GIFTS.push([g.k, g.e, g.n]); }); } catch (_) {}
    build();
  }
  function build() {
    const grid = $("#gift-grid"); if (!grid || !CAT.length) return;
    grid.classList.add("gp");
    const cur = (() => { try { return typeof giftKind !== "undefined" ? giftKind : "rose"; } catch (_) { return "rose"; } })();
    grid.innerHTML = CAT.map((g) => `<button class="gift${g.fx ? " fx" : ""}" type="button" data-gift="${g.k}" aria-pressed="${g.k === cur}" title="${E(g.n)}: ${g.c} coins"><span>${g.e}</span>${E(g.n)}<small class="price">🪙 ${g.c.toLocaleString()}</small></button>`).join("");
    if (!BY[cur]) { try { giftKind = "rose"; } catch (_) {} grid.querySelector('[data-gift="rose"]')?.setAttribute("aria-pressed", "true"); }
    const form = $("#gift-form");
    if (form && !$("#gp-qty")) {
      const q = document.createElement("div"); q.id = "gp-qty";
      q.innerHTML = [1, 5, 10, 99].map((n) => `<button type="button" data-gpq="${n}" aria-pressed="${n === qty}">x${n}</button>`).join("") + `<span id="gp-total"></span>`;
      grid.after(q);
      const c = document.createElement("div"); c.id = "gp-combo"; form.style.position = "relative"; form.appendChild(c);
    }
    total();
  }
  const kindNow = () => { try { return typeof giftKind !== "undefined" ? giftKind : "rose"; } catch (_) { return "rose"; } };
  function total() { const g = BY[kindNow()]; const el = $("#gp-total"); if (el && g) el.textContent = "🪙 " + (g.c * qty).toLocaleString(); }

  async function send(to, kind, n, extra = {}) {
    if (!tok()) { if (typeof openAuth === "function") openAuth("signup"); return false; }
    if (!paid) { say("Gifts are bought with coins. The coin shop opens very soon!"); return false; }
    const r = await fetch("/api/coins/gift", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: JSON.stringify({ to, kind, qty: n, note: extra.note || "", context: location.hash.slice(1, 20), battle: extra.battle || "" }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 402) { needCoins(); return false; }
    if (!r.ok) { say(j.error || "Couldn't send the gift."); return false; }
    if (window.MW_COINS) MW_COINS.coins = j.coins;
    const bal = document.querySelector("#coin-bar .row b"); if (bal && typeof j.coins === "number") bal.textContent = "🪙 " + j.coins.toLocaleString();
    const g = BY[kind]; if (g && g.fx) fx(g, ME(), n);
    document.dispatchEvent(new CustomEvent("mw-gift-sent", { detail: { to, kind, qty: n } }));
    return j;
  }
  function needCoins() {
    say("You need more coins. Pick a pack 🪙");
    const gd = $("#gift-dialog"); if (gd && !gd.open) { const b = document.createElement("button"); b.setAttribute("data-coins-open", ""); document.body.appendChild(b); b.click(); b.remove(); return; }
    const buy = document.querySelector("[data-coins-buy]"); if (buy) buy.click();
  }
  // full-screen animation for big gifts
  let fxQ = [], fxOn = false;
  function fx(g, from, n) { fxQ.push({ g, from, n }); if (!fxOn) nextFx(); }
  function nextFx() {
    const it = fxQ.shift(); if (!it) { fxOn = false; return; } fxOn = true; window.MW_GIFTS && (MW_GIFTS.fxCount = (MW_GIFTS.fxCount || 0) + 1);
    const d = document.createElement("div"); d.id = "gift-fx"; d.setAttribute("aria-hidden", "true");
    d.innerHTML = `<div class="rays"></div><div class="big">${it.g.e}</div><div class="who">${E(it.from === ME() ? "You" : NAME(it.from))} sent ${E(it.g.n)}${it.n > 1 ? " x" + it.n : ""}!</div>` + Array.from({ length: 22 }, () => `<i style="left:${Math.random() * 100}%;animation-delay:${(Math.random() * 1.2).toFixed(2)}s">${Math.random() < 0.5 ? it.g.e : ["✨", "🪙", "💛", "👑"][Math.floor(Math.random() * 4)]}</i>`).join("");
    // an open dialog (like the gift box) sits above everything else, so play inside it when one is open
    (document.querySelector("dialog[open]") || document.body).appendChild(d); setTimeout(() => { d.remove(); nextFx(); }, 3300);
  }

  // the gift box: pick a gift, how many, then Send (keep tapping Send for a combo)
  document.addEventListener("click", (e) => {
    const q = e.target.closest("[data-gpq]"); if (q) { qty = +q.dataset.gpq; document.querySelectorAll("[data-gpq]").forEach((b) => b.setAttribute("aria-pressed", String(b === q))); total(); return; }
    if (e.target.closest("#gift-grid [data-gift]")) setTimeout(total, 0);
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "gift-form") return;
    e.preventDefault(); e.stopImmediatePropagation();
    const to = (() => { try { return giftTo; } catch (_) { return null; } })(); if (!to) return;
    const kind = kindNow(), note = ($("#gift-note") || {}).value || "", btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const ok = await send(to, kind, qty, { note: note.trim(), battle: window.MW_BATTLE_ID || "" });
    if (btn) btn.disabled = false;
    if (!ok) return;
    const now = Date.now(); combo = combo.kind === kind && now - combo.t < 3000 ? { kind, n: combo.n + qty, t: now } : { kind, n: qty, t: now };
    const c = $("#gp-combo"); if (c) { c.textContent = (BY[kind] ? BY[kind].e + " " : "") + "x" + combo.n; c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop"); }
    if ($("#gift-note")) $("#gift-note").value = "";
    if (btn) btn.textContent = "Send again (combo!)";
    clearTimeout(send._t); send._t = setTimeout(() => { if (btn) btn.textContent = "Send gift"; if (c) c.textContent = ""; }, 3000);
    say(`${BY[kind] ? BY[kind].e : "🎁"} Sent to ${NAME(to)}`);
  }, true);
  const gd = document.getElementById("gift-dialog");
  if (gd) new MutationObserver(() => { if (gd.open) { build(); const c = $("#gp-combo"); if (c) c.textContent = ""; const b = gd.querySelector('button[type="submit"]'); if (b && paid) { b.disabled = false; b.textContent = "Send gift"; } } }).observe(gd, { attributes: true, attributeFilter: ["open"] });

  // big gifts others send: show the animation if it's for me, or for a Live I'm watching
  let seenAt = Date.now();
  setInterval(() => {
    let log = []; try { log = typeof giftLog !== "undefined" ? giftLog : []; } catch (_) {}
    const watching = new Set(window.MW_LIVE_IDS ? MW_LIVE_IDS() : []);
    for (const g of log) {
      if (!(g.createdAt > seenAt)) continue;
      const def = BY[g.kind]; if (!def || !def.fx || g.from === ME()) continue;
      if (g.to === ME() || watching.has(g.to)) fx(def, g.from, g.qty || 1);
    }
    seenAt = Math.max(seenAt, ...log.map((g) => g.createdAt || 0));
  }, 1500);

  window.MW_GIFTS = { quick: (to, kind, battle) => send(to, kind, 1, { battle }), catalog: () => CAT, fx: (k, from) => BY[k] && fx(BY[k], from, 1) };
  setTimeout(load, 900);
})();
