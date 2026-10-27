/* Meechie's World Coins (client side).
 * - The gift box shows each gift's price, your coins, and coin packs to buy (Stripe checkout).
 * - "🪙 My coins" (#coins): your balance, what you've earned from gifts (40% of each gift), and Cash out.
 * - Meechie also sees Payouts: who asked to cash out, and a "Mark paid" button after he pays them.
 * Server: functions/api/coins/[[path]].js. Until Stripe is set up there, gifts stay free. */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : alert(t));
  const $ = (s, r = document) => r.querySelector(s);
  const usd = (c) => "$" + (c / 100).toFixed(2);
  const tok = () => { try { return MW.session().access_token; } catch (_) { return ""; } };
  const api = (path, body) => fetch("/api/coins/" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }));
  const C = window.MW_COINS = { paid: false, info: null, coins: 0, send };
  const PACK_ORDER = ["p100", "p550", "p1150", "p3000", "p6250"];

  const css = document.createElement("style");
  css.textContent = `#coin-bar{display:grid;gap:8px;border:1px solid var(--gold-lo,#8a6a2a);border-radius:14px;padding:10px 12px;background:linear-gradient(180deg,#1a150b,#0d0b07)}
#coin-bar .row{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}
#coin-bar b{color:var(--gold-hi,#f0cf78)}
.coin-packs{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px}
.coin-packs button{display:grid;gap:2px;justify-items:center;padding:10px 6px;border-radius:12px;border:1px solid var(--gold,#d4a843);background:#120f09;color:#fff;font:700 13px var(--body,system-ui);cursor:pointer}
.coin-packs button span{font-size:18px;color:var(--gold-hi,#f0cf78)}
.coin-packs button small{color:var(--muted,#bbb);font-weight:600}
#daily-card{border:1px solid var(--gold-lo,#8a6a2a);background:linear-gradient(180deg,#1a150b,#0d0b07);display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between}
#daily-card .dc-t{font:700 16px var(--body,system-ui);color:var(--gold-hi,#f0cf78)}
#daily-card .dc-s{color:var(--muted,#a99f8b);font-size:13px}
#daily-card .dc-fire{color:#ff9d45;font-weight:700}
.gift small.price{display:block;color:var(--gold-hi,#f0cf78);font:700 11px var(--body,system-ui)}
#coin-dlg{border:1px solid var(--gold,#d4a843);border-radius:20px;background:linear-gradient(180deg,#17120a,#0b0a07);color:var(--text,#fff);width:min(520px,calc(100vw - 24px));max-height:calc(100vh - 32px);overflow:auto;padding:0}
#coin-dlg::backdrop{background:rgba(0,0,0,.75)}
#coin-dlg .in{display:grid;gap:14px;padding:20px}
#coin-dlg h3{margin:0;font-size:22px;color:var(--gold-hi,#f0cf78)}
#coin-dlg .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
#coin-dlg .stats div{border:1px solid #3a3223;border-radius:12px;padding:10px;text-align:center}
#coin-dlg .stats b{display:block;font-size:20px;color:var(--gold-hi,#f0cf78)}
#coin-dlg .stats small{color:var(--muted,#bbb);font-size:12px}
#coin-dlg .co{display:grid;gap:8px;border:1px solid #3a3223;border-radius:12px;padding:12px}
#coin-dlg input,#coin-dlg select{width:100%;background:#0b0a08;border:1px solid #333;border-radius:10px;padding:10px;color:#fff;font:16px var(--body,system-ui)}
#coin-dlg .hist{display:grid;gap:4px;font-size:13px;color:var(--muted,#bbb);max-height:180px;overflow:auto}
#coin-dlg .pay{display:grid;gap:6px;border:1px solid #3a3223;border-radius:12px;padding:10px}
#coin-dlg .pay .p{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;border-bottom:1px solid #2a2418;padding:6px 0}`;
  document.head.appendChild(css);

  async function load() {
    try { const r = await fetch("/api/coins/info").then((x) => x.json()); C.info = r; C.paid = !!r.paid; } catch (_) {}
    prices(); if (C.paid) await refresh(); else closedBar();
  }
  // shop not open yet: say so in the gift box instead of letting anyone send a free gift
  function closedBar() { const el = $("#coin-bar"); if (!el) return; el.hidden = false; el.innerHTML = `<div class="row"><span>🪙 Gifts are bought with coins.</span></div><small class="muted">The coin shop opens very soon. Gifts can't be sent for free.</small>`; const sb = document.querySelector('#gift-form button[type="submit"]'); if (sb) { sb.disabled = true; sb.textContent = "Coin shop opening soon"; } }
  async function refresh() { if (!tok()) return; const r = await api("me"); if (r.ok) { C.me = r.j; C.coins = r.j.coins || 0; bar(); } }
  function prices() {
    const g = C.info && C.info.gifts; if (!g) return;
    document.querySelectorAll("#gift-grid [data-gift]").forEach((b) => { if (b.querySelector(".price")) return; const n = g[b.dataset.gift]; if (n) b.insertAdjacentHTML("beforeend", `<small class="price">🪙 ${n}</small>`); });
  }
  function packsHtml() { const P = (C.info && C.info.packs) || {}; return `<div class="coin-packs">${PACK_ORDER.filter((k) => P[k]).map((k) => `<button type="button" data-buy="${k}"><span>🪙 ${P[k].coins.toLocaleString()}</span><small>${usd(P[k].cents)}</small></button>`).join("")}</div>`; }
  function bar(showPacks) {
    const el = $("#coin-bar"); if (!el || !C.paid) return; el.hidden = false;
    el.innerHTML = `<div class="row"><span>You have <b>🪙 ${C.coins.toLocaleString()}</b> coins</span><span style="display:flex;gap:6px"><button class="btn sm ghost" type="button" data-coins-open>My coins</button><button class="btn sm" type="button" data-coins-buy>＋ Buy coins</button></span></div>
${showPacks ? `<small class="muted">Pick a pack. You'll pay securely with Stripe (card, Apple Pay, Google Pay or Cash App Pay), then come right back.</small>${packsHtml()}` : ""}
<small class="muted">The person you gift earns ${Math.round(((C.info && C.info.memberShare) || 0.4) * 100)}% of its value.</small>`;
  }
  async function buy(pack) {
    if (!tok()) { if (typeof openAuth === "function") openAuth("signup"); return; }
    say("Opening secure checkout…");
    const r = await api("checkout", { pack });
    if (r.ok && r.j.url && /^https:\/\/checkout\.stripe\.com\//.test(r.j.url)) location.href = r.j.url; else say(r.j.error || "Checkout isn't available right now.");
  }
  async function send(to, kind, note) {
    const r = await api("gift", { to, kind, note, context: location.hash.slice(1, 20) });
    if (r.status === 402) { bar(true); say("You need more coins for that gift. Pick a pack below."); return false; }
    if (r.status === 409) { C.paid = false; say("Gifts are bought with coins. The coin shop opens very soon!"); return false; }
    if (!r.ok) { say(r.j.error || "Couldn't send the gift."); return false; }
    C.coins = r.j.coins; bar(); return "paid";
  }

  /* ---------- My coins / cash out / payouts ---------- */
  function dlg() {
    let d = $("#coin-dlg"); if (d) return d;
    d = document.createElement("dialog"); d.id = "coin-dlg"; d.innerHTML = `<div class="in" id="coin-in"></div>`; document.body.appendChild(d);
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    return d;
  }
  async function openWallet() {
    if (!tok()) { if (typeof openAuth === "function") openAuth("signup"); return; }
    const d = dlg(), box = $("#coin-in"); box.innerHTML = `<h3>🪙 My coins</h3><p class="muted">Loading…</p>`; if (!d.open) d.showModal();
    await refresh(); const m = C.me || {}; const owner = (() => { try { return typeof isOwner !== "undefined" && !!isOwner; } catch (_) { return false; } })();
    const minC = (C.info && C.info.minCashout) || 2000;
    const label = { buy: "Bought coins", gift_sent: "Sent a gift", gift_received: "Earned from a gift", gift_fee: "Your share of a gift" };
    box.innerHTML = `<h3>🪙 My coins</h3>
${C.paid ? "" : `<p class="muted" style="margin:0">The coin shop opens as soon as Meechie switches on payments. Until then, gifts are free.</p>`}
<div class="stats"><div><b>${(m.coins || 0).toLocaleString()}</b><small>coins to spend</small></div><div><b>${usd(m.availableCents || 0)}</b><small>earned, ready to cash out</small></div><div><b>${usd(m.paidOutCents || 0)}</b><small>paid to you so far</small></div></div>
${C.paid ? `<div><b style="font-size:14px">Buy coins</b>${packsHtml()}</div>` : ""}
<form class="co" id="co-form"><b>💸 Cash out your earnings</b>
<small class="muted">You earn ${Math.round(((C.info && C.info.memberShare) || 0.4) * 100)}% of every gift people send you. Cash out once you have ${usd(minC)}. Meechie sends it to you, usually within a few days.${m.pendingCents ? ` <b>${usd(m.pendingCents)} is on its way.</b>` : ""}</small>
<select id="co-m"><option>Cash App</option><option>PayPal</option><option>Zelle</option><option>Venmo</option></select>
<input id="co-h" maxlength="80" placeholder="$cashtag, PayPal email, or Zelle phone/email" autocomplete="off">
<small class="muted">Never type your Social Security, bank or card number here.</small>
<button class="btn" type="submit" ${(m.availableCents || 0) >= minC ? "" : "disabled"}>Cash out ${usd(m.availableCents || 0)}</button></form>
${(m.recent || []).length ? `<div><b style="font-size:14px">Recent</b><div class="hist">${m.recent.map((t) => `<div>${E(label[t.kind] || t.kind)} · ${t.coins ? (t.coins > 0 ? "+" : "") + t.coins + " coins" : usd(t.cents)} · ${new Date(t.at).toLocaleDateString()}</div>`).join("")}</div></div>` : ""}
${owner ? `<div class="pay" id="co-pay"><b>👑 Payouts (owner)</b><span class="muted">Loading…</span></div>` : ""}
<div style="display:flex;justify-content:flex-end"><button class="btn ghost" type="button" data-coins-close>Close</button></div>`;
    if (owner) payouts();
  }
  async function payouts() {
    const el = $("#co-pay"); if (!el) return; const r = await api("admin"); if (!r.ok) { el.innerHTML = "<b>👑 Payouts</b><span class='muted'>Couldn't load.</span>"; return; }
    const j = r.j, open = (j.cashouts || []).filter((c) => c.status === "requested");
    el.innerHTML = `<b>👑 Payouts (owner)</b><small class="muted">Coins sold: ${usd(j.soldCents || 0)} · your 60%: ${usd(j.yourShareCents || 0)} · members' 40%: ${usd(j.memberShareCents || 0)}. Stripe's card fee comes out of your share.</small>
${open.length ? open.map((c) => `<div class="p"><span><b>${E(c.name || "Member")}</b> · ${usd(c.cents)} · ${E(c.method)}: <b>${E(c.handle)}</b><br><small class="muted">asked ${new Date(c.at).toLocaleString()}</small></span><button class="btn sm" type="button" data-paid="${c.id}">Mark paid</button></div>`).join("") : `<span class="muted">No one is waiting to be paid.</span>`}`;
  }
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-buy],[data-coins-buy],[data-coins-open],[data-coins-close],[data-paid],a[href='#coins']"); if (!t) return;
    if (t.dataset.buy) { e.preventDefault(); buy(t.dataset.buy); }
    else if (t.hasAttribute("data-coins-buy")) { e.preventDefault(); bar(true); }
    else if (t.hasAttribute("data-coins-open") || t.matches("a[href='#coins']")) { e.preventDefault(); const g = $("#gift-dialog"); if (g && g.open) g.close(); openWallet(); }
    else if (t.hasAttribute("data-coins-close")) { $("#coin-dlg").close(); }
    else if (t.dataset.paid) { if (!t.dataset.sure) { t.dataset.sure = 1; t.textContent = "Tap again once you've paid"; return; } t.disabled = true; const r = await api("admin/paid", { id: +t.dataset.paid }); say(r.ok ? "Marked paid. They got a message." : r.j.error || "Couldn't mark it."); payouts(); }
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "co-form") return; e.preventDefault();
    const r = await api("cashout", { method: $("#co-m").value, handle: $("#co-h").value.trim() });
    say(r.ok ? "Cash-out requested: " + usd(r.j.cents) + ". Meechie will send it soon." : r.j.error || "Couldn't request it."); if (r.ok) openWallet();
  });
  /* ---------- Daily check-in card (top of Meechie's Book) ---------- */
  async function paintDaily() {
    const el = $("#daily-card"); if (!el) return;
    if (!tok()) { el.hidden = false; el.innerHTML = `<div><div class="dc-t">📅 Daily check-in</div><div class="dc-s">Members claim <b>🪙 10 free coins</b> every day — every 7th straight day pays 🪙 50.</div></div><button class="btn sm" type="button" data-daily-signin>Join free & claim</button>`; return; }
    const r = await api("daily"); if (!r.ok) { el.hidden = true; return; }
    const j = r.j; el.hidden = false;
    if (j.claimed) el.innerHTML = `<div><div class="dc-t">✅ Checked in today</div><div class="dc-s"><span class="dc-fire">🔥 ${j.streak}-day streak</span> · you have <b>🪙 ${(j.coins || 0).toLocaleString()}</b> · come back tomorrow for more</div></div><span style="display:flex;gap:6px"><a class="btn sm" href="#games" data-go="games">🎰 Play the Jackpot</a><button class="btn sm ghost" type="button" data-coins-open>My coins</button></span>`;
    else el.innerHTML = `<div><div class="dc-t">📅 Daily check-in ${j.streak ? `· <span class="dc-fire">🔥 ${j.streak}-day streak</span>` : ""}</div><div class="dc-s">Claim <b>🪙 ${j.base} free coins</b> today${(j.streak + 1) % j.bonusEvery === 0 ? ` — <b>streak bonus day: 🪙 ${j.base + j.bonus}!</b>` : ` · every ${j.bonusEvery}th straight day pays 🪙 ${j.base + j.bonus}`}</div></div><button class="btn" type="button" data-daily-claim>🪙 Claim ${j.base} coins</button>`;
  }
  document.addEventListener("click", async (e) => {
    const s = e.target.closest("[data-daily-signin]"); if (s) { if (typeof openAuth === "function") openAuth("signup"); return; }
    const b = e.target.closest("[data-daily-claim]"); if (!b) return;
    b.disabled = true; b.textContent = "Claiming…";
    const r = await api("daily/claim", {});
    if (r.ok) { C.coins = r.j.coins; say(`🪙 +${r.j.amount} coins! ${r.j.bonus ? "Streak bonus! " : ""}🔥 ${r.j.streak}-day streak. Go play the Jackpot.`); bar(); }
    else say(r.j.error || "Couldn't claim right now.");
    paintDaily();
  });
  setTimeout(paintDaily, 1600);
  window.addEventListener("hashchange", () => { if (location.hash === "#community") setTimeout(paintDaily, 400); });

  // coming back from Stripe
  if (location.hash === "#coins-thanks") { history.replaceState(null, "", "#home"); setTimeout(() => { say("Thanks! Your coins will show up in a few seconds."); setTimeout(openWallet, 2500); }, 1500); }
  if (location.hash === "#coins") setTimeout(openWallet, 1500);
  // keep the balance fresh whenever the gift box opens
  const gd = document.getElementById("gift-dialog");
  if (gd) new MutationObserver(() => { if (!gd.open) return; prices(); if (C.paid) refresh(); else closedBar(); }).observe(gd, { attributes: true, attributeFilter: ["open"] });
  setTimeout(load, 1200);
})();
