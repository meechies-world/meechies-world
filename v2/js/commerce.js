/* ============================================================================
   v2 COMMERCE LAYER (Phase 5) — the shared money-side data door: the
   Shop union, the coin wallet + Jackpot client, the daily check-in,
   and the gift flow. Every call rides the EXISTING backend exactly as
   the live site calls it — /api/store + /api/shopify for the shop,
   functions/api/coins for everything coin-shaped. No new endpoints,
   no forked data, no second session shape (the shell's session,
   Bearer — MAP §4.4).

   The pure helpers (shopUnion, potPrize, dailyMath, usd) are exported
   bare for the harness, the same pattern as social.js / djstate.js.
   ============================================================================ */

export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const usd = (c) => "$" + ((+c || 0) / 100).toFixed(2);
export const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";

/* a tiny toast in the live shape (the live site's global toast) */
export function toast(msg) {
  let t = document.getElementById("mw2-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "mw2-toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 3400);
}

/* ============================ THE SHOP UNION ============================
   Phase 1a-verified (MAP correction C1): /api/store is Printify only
   (the two pop-up storefronts merged server-side, earlier store wins);
   /api/shopify is a SEPARATE feed. The single shop list a visitor
   sees is assembled here, client-side: Printify FIRST, then Shopify,
   with the store merge rule carried across AND within the feeds —
   a product whose identity (id, URL, or normalized title + price)
   already appeared is suppressed, and the earlier feed wins.
   Shopify keeps its live client rules: https product URLs only,
   eBooks (digital) first. */
export const normTitle = (t) => String(t || "").trim().toLowerCase();
/* One dedupe pass for BOTH feeds (Gate T gap 4): the old union only
   checked titles on the Shopify side, so a product listed twice in
   the Printify feed itself (the "Vegan Wallet" x3, same title + same
   $31.42, three product ids) rendered three times. A product is now
   offered once, in feed order (Printify wins), and suppressed when
   ANY identity matches an earlier offer: source product id, then
   canonical product URL, then normalized title + price as backstop.
   Title alone is NOT a key: same title at a different price is a
   different product (the two "Unisex Heavy Cotton Tee" listings at
   $27.68 / $22.99 both stay). */
const canonUrl = (u) => String(u || "").trim().toLowerCase().replace(/\/+$/, "");
export function shopUnion(printify, shopify) {
  const seenIds = new Set(), seenUrls = new Set(), seenTitlePrice = new Set();
  const out = [];
  const offer = (p, source) => {
    if (!p || !p.title) return;
    const id = p.id ? source + ":" + String(p.id) : "";
    const url = canonUrl(p.url);
    const tp = normTitle(p.title) + "|" + String(p.price || "").trim().toLowerCase();
    if ((id && seenIds.has(id)) || (url && seenUrls.has(url)) || seenTitlePrice.has(tp)) return;
    if (id) seenIds.add(id);
    if (url) seenUrls.add(url);
    seenTitlePrice.add(tp);
    out.push({ ...p, source });
  };
  for (const p of printify || []) offer(p, "printify");
  const sh = (shopify || []).filter((p) => p && /^https:\/\//.test(p.url || ""));
  sh.sort((a, b) => (b.digital ? 1 : 0) - (a.digital ? 1 : 0)); // eBooks first (live)
  for (const p of sh) offer(p, "shopify");
  return out;
}
export async function loadShopFeed() {
  const get = async (u) => { try { const r = await fetch(u); const j = await r.json(); return j.products || []; } catch (_) { return []; } };
  const [pf, sh] = await Promise.all([get("/api/store"), get("/api/shopify")]);
  return shopUnion(pf, sh);
}

/* ============================ COINS API ============================
   The live coins.js/games.js client contract, verbatim routes:
   info / me / games / play / pot/create|join|cancel / promo/claim /
   pool/seed / admin/grant / checkout / gift / cashout / admin /
   admin/paid / daily / daily/claim — all under /api/coins/, Bearer
   from the shared session. Server-settled, always (Law 18). */
export function createCoins(session) {
  const tok = () => { try { const s = session.get(); return (s && s.access_token) || ""; } catch (_) { return ""; } };
  const api = (path, body) => fetch("/api/coins/" + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: "Bearer " + tok() },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }));
  return { api, tok };
}

/* the PvP pot prize: winner takes the 2x pot minus the house rake of
   floor(2 x bet x GAME_FEE) = 10% (Law 18, code-verified) */
export const potPrize = (bet) => 2 * bet - Math.floor(2 * bet * 0.10);

/* daily check-in math (server constants, code-verified): base 10,
   every 7th straight day pays base + 40 bonus */
export const DAILY = { base: 10, bonusEvery: 7, bonus: 40 };
export const dailyAmount = (streakNext) => DAILY.base + (streakNext % DAILY.bonusEvery === 0 ? DAILY.bonus : 0);

/* ============================ THE WALLET ============================
   The live "🪙 My coins" dialog (coins.js), same shape: balances,
   packs (Stripe checkout hand-off — the checkout itself is Stripe's
   page, exactly as live; no charging is faked here), the cash-out
   form (earned cents only, min from /api/coins/info, the request
   sweeps the full available balance server-side), recent activity,
   and the owner's Payouts panel. */
const PACK_ORDER = ["p100", "p550", "p1150", "p3000", "p6250"];
let walletCtx = null, walletCoins = null;

function packsHtml(info) {
  const P = (info && info.packs) || {};
  return `<div class="coin-packs">${PACK_ORDER.filter((k) => P[k]).map((k) => `<button type="button" data-buy="${k}"><span>🪙 ${P[k].coins.toLocaleString()}</span><small>${usd(P[k].cents)}</small></button>`).join("")}</div>`;
}

export async function openWallet(ctx) {
  walletCtx = ctx;
  if (!walletCoins) walletCoins = createCoins(ctx.session);
  const coins = walletCoins;
  if (!coins.tok()) { toast("Join free to use your coin wallet."); return; }
  let d = document.getElementById("coin-dlg");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "coin-dlg";
    d.innerHTML = `<div class="in" id="coin-in"></div>`;
    document.body.appendChild(d);
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    d.addEventListener("click", onWalletClick);
    d.addEventListener("submit", onWalletSubmit);
  }
  const box = document.getElementById("coin-in");
  box.innerHTML = `<h3>🪙 My coins</h3><p class="muted">Loading…</p>`;
  if (!d.open) d.showModal();
  const infoR = await fetch("/api/coins/info").then((x) => x.json()).catch(() => ({}));
  const info = infoR && infoR.packs ? infoR : { paid: false };
  const r = await coins.api("me");
  if (!r.ok) { box.innerHTML = `<h3>🪙 My coins</h3><p class="muted">Your wallet could not load right now.</p>`; return; }
  const m = r.j;
  const u = ctx.session.user();
  const owner = !!u && u.id === OWNER_ID;
  const minC = info.minCashout || 1000;
  const share = Math.round((info.memberShare || 0.4) * 100);
  const label = { buy: "Bought coins", gift_sent: "Sent a gift", gift_received: "Earned from a gift", gift_fee: "Your share of a gift", daily: "Daily check-in", promo: "Welcome drop" };
  box.innerHTML = `<h3>🪙 My coins</h3>
${info.paid ? "" : `<p class="muted" style="margin:0">The coin shop opens as soon as Meechie switches on payments. Until then, gifts are free.</p>`}
<div class="stats"><div><b>${(m.coins || 0).toLocaleString()}</b><small>coins to spend</small></div><div><b>${usd(m.availableCents || 0)}</b><small>earned, ready to cash out</small></div><div><b>${usd(m.paidOutCents || 0)}</b><small>paid to you so far</small></div></div>
${info.paid ? `<div><b style="font-size:14px">Buy coins</b>${packsHtml(info)}</div>` : ""}
<form class="co" id="co-form"><b>💸 Cash out your earnings</b>
<small class="muted">You earn ${share}% of every gift people send you. Cash out once you have ${usd(minC)}. Cashing out asks for everything you have earned and ready — Meechie sends it to you, usually within a few days.${m.pendingCents ? ` <b>${usd(m.pendingCents)} is on its way.</b>` : ""}</small>
<select id="co-m"><option>Cash App</option><option>PayPal</option><option>Zelle</option><option>Venmo</option></select>
<input id="co-h" maxlength="80" placeholder="$cashtag, PayPal email, or Zelle phone/email" autocomplete="off">
<small class="muted">Never type your Social Security, bank or card number here.</small>
<button class="btn" type="submit" ${(m.availableCents || 0) >= minC ? "" : "disabled"}>Cash out ${usd(m.availableCents || 0)}</button></form>
${(m.recent || []).length ? `<div><b style="font-size:14px">Recent</b><div class="hist">${m.recent.map((t) => `<div>${esc(label[t.kind] || t.kind)} · ${t.coins ? (t.coins > 0 ? "+" : "") + t.coins + " coins" : usd(t.cents)} · ${new Date(t.at).toLocaleDateString()}</div>`).join("")}</div></div>` : ""}
${owner ? `<div class="pay" id="co-pay"><b>👑 Payouts (owner)</b><span class="muted">Loading…</span></div>` : ""}
<div style="display:flex;justify-content:flex-end"><button class="btn ghost" type="button" data-coins-close>Close</button></div>`;
  if (owner) paintPayouts(coins);
}

async function paintPayouts(coins) {
  const el = document.getElementById("co-pay"); if (!el) return;
  const r = await coins.api("admin");
  if (!r.ok) { el.innerHTML = "<b>👑 Payouts</b><span class='muted'>Couldn't load.</span>"; return; }
  const j = r.j, open = (j.cashouts || []).filter((c) => c.status === "requested");
  el.innerHTML = `<b>👑 Payouts (owner)</b><small class="muted">Coins sold: ${usd(j.soldCents || 0)} · your 60%: ${usd(j.yourShareCents || 0)} · members' 40%: ${usd(j.memberShareCents || 0)}. Stripe's card fee comes out of your share.</small>
${open.length ? open.map((c) => `<div class="p"><span><b>${esc(c.name || "Member")}</b> · ${usd(c.cents)} · ${esc(c.method)}: <b>${esc(c.handle)}</b><br><small class="muted">asked ${new Date(c.at).toLocaleString()}</small></span><button class="btn sm" type="button" data-paid="${c.id}">Mark paid</button></div>`).join("") : `<span class="muted">No one is waiting to be paid.</span>`}`;
}

async function buyPack(coins, pack) {
  toast("Opening secure checkout…");
  const r = await coins.api("checkout", { pack });
  if (r.ok && r.j.url && /^https:\/\/checkout\.stripe\.com\//.test(r.j.url)) location.href = r.j.url;
  else toast(r.j.error || "Checkout isn't available right now.");
}

function onWalletClick(e) {
  const coins = walletCoins; if (!coins) return;
  const buy = e.target.closest("[data-buy]");
  if (buy) { e.preventDefault(); buyPack(coins, buy.dataset.buy); return; }
  if (e.target.closest("[data-coins-close]")) { document.getElementById("coin-dlg").close(); return; }
  const paid = e.target.closest("[data-paid]");
  if (paid) {
    if (!paid.dataset.sure) { paid.dataset.sure = "1"; paid.textContent = "Tap again once you've paid"; return; }
    paid.disabled = true;
    coins.api("admin/paid", { id: +paid.dataset.paid }).then((r) => { toast(r.ok ? "Marked paid. They got a message." : r.j.error || "Couldn't mark it."); paintPayouts(coins); });
  }
}
async function onWalletSubmit(e) {
  if (e.target.id !== "co-form") return;
  e.preventDefault();
  const r = await walletCoins.api("cashout", { method: document.getElementById("co-m").value, handle: document.getElementById("co-h").value.trim() });
  toast(r.ok ? "Cash-out requested: " + usd(r.j.cents) + ". Meechie will send it soon." : r.j.error || "Couldn't request it.");
  if (r.ok) openWallet(walletCtx);
}

/* the gift-bar / balance strip the gift dialog carries (live #coin-bar) */
export async function paintCoinBar(el, ctx) {
  if (!el) return;
  const coins = createCoins(ctx.session);
  const info = await fetch("/api/coins/info").then((x) => x.json()).catch(() => null);
  if (!info || !info.paid) {
    el.hidden = false;
    el.innerHTML = `<div class="row"><span>🪙 Gifts are bought with coins.</span></div><small class="muted">The coin shop opens very soon. Gifts can't be sent for free.</small>`;
    return { paid: false, coins };
  }
  const r = await coins.api("me");
  const bal = r.ok ? (r.j.coins || 0) : 0;
  el.hidden = false;
  el.innerHTML = `<div class="row"><span>You have <b>🪙 ${bal.toLocaleString()}</b> coins</span><span style="display:flex;gap:6px"><button class="btn sm ghost" type="button" data-mw2-wallet>My coins</button></span></div><small class="muted">The person you gift earns ${Math.round((info.memberShare || 0.4) * 100)}% of its value.</small>`;
  const b = el.querySelector("[data-mw2-wallet]");
  if (b) b.addEventListener("click", () => openWallet(ctx));
  return { paid: true, coins, balance: bal, info };
}

/* send a gift through the coin route — the live MW_COINS.send
   contract: "paid" on success; 402 needs coins; 409 free mode */
export async function sendGift(ctx, to, kind, note) {
  const coins = createCoins(ctx.session);
  const r = await coins.api("gift", { to, kind, note, context: (location.hash || "").slice(1, 20) });
  if (r.status === 402) { toast("You need more coins for that gift — open My coins to grab a pack."); return false; }
  if (r.status === 409) { toast("Gifts are bought with coins. The coin shop opens very soon!"); return false; }
  if (!r.ok) { toast(r.j.error || "Couldn't send the gift."); return false; }
  return "paid";
}

/* ============================ DAILY CHECK-IN ============================
   The live card that tops Meechie's Book (#daily-card): GET
   /api/coins/daily paints it, POST /api/coins/daily/claim claims.
   10 coins a day; every 7th straight day pays 50 (base + 40 bonus). */
export async function paintDailyCard(el, ctx) {
  if (!el) return;
  const coins = createCoins(ctx.session);
  if (!coins.tok()) {
    el.hidden = false;
    el.innerHTML = `<div><div class="dc-t">📅 Daily check-in</div><div class="dc-s">Members claim <b>🪙 10 free coins</b> every day — every 7th straight day pays 🪙 50.</div></div><button class="btn sm" type="button" data-daily-signin>Join free & claim</button>`;
    const b = el.querySelector("[data-daily-signin]");
    if (b) b.addEventListener("click", () => toast("Join free from the gate or the Join button — then claim here every day."));
    return;
  }
  const r = await coins.api("daily");
  if (!r.ok) { el.hidden = true; return; }
  const j = r.j;
  el.hidden = false;
  if (j.claimed) {
    el.innerHTML = `<div><div class="dc-t">✅ Checked in today</div><div class="dc-s"><span class="dc-fire">🔥 ${j.streak}-day streak</span> · you have <b>🪙 ${(j.coins || 0).toLocaleString()}</b> · come back tomorrow for more</div></div><span style="display:flex;gap:6px"><a class="btn sm" href="#games" data-go="games">🎰 Play the Jackpot</a><button class="btn sm ghost" type="button" data-mw2-wallet>My coins</button></span>`;
  } else {
    const bonusDay = (j.streak + 1) % j.bonusEvery === 0;
    el.innerHTML = `<div><div class="dc-t">📅 Daily check-in ${j.streak ? `· <span class="dc-fire">🔥 ${j.streak}-day streak</span>` : ""}</div><div class="dc-s">Claim <b>🪙 ${j.base} free coins</b> today${bonusDay ? ` — <b>streak bonus day: 🪙 ${j.base + j.bonus}!</b>` : ` · every ${j.bonusEvery}th straight day pays 🪙 ${j.base + j.bonus}`}</div></div><button class="btn" type="button" data-daily-claim>🪙 Claim ${j.base} coins</button>`;
    const b = el.querySelector("[data-daily-claim]");
    if (b) b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "Claiming…";
      const rr = await coins.api("daily/claim", {});
      if (rr.ok) toast(`🪙 +${rr.j.amount} coins! ${rr.j.bonus ? "Streak bonus! " : ""}🔥 ${rr.j.streak}-day streak. Go play the Jackpot.`);
      else toast(rr.j.error || "Couldn't claim right now.");
      paintDailyCard(el, ctx);
    });
  }
  const w = el.querySelector("[data-mw2-wallet]");
  if (w) w.addEventListener("click", () => openWallet(ctx));
}

/* ============================ GIFT DIALOG =============================
   The live #gift-dialog (body-level in the live index): pick from
   the /api/coins/info catalog (gift denominations 10/50/100/500
   ride the battle-gift buttons in Battles; the dialog catalog is
   the priced gift list), the coin bar, an optional note, send via
   sendGift; the recipient's giftsReceived bumps +1 and the
   mw-gift-sent event fires, exactly the live coins.js flow. */
const GIFT_DLG_HTML = `<dialog id="gift-dialog">
  <form id="gift-form" method="dialog">
    <h3 style="font-size:22px">Send a gift to <span id="gift-to"></span></h3>
    <div class="gift-grid" id="gift-grid"></div>
    <div id="coin-bar" hidden></div>
    <div class="field"><label for="gift-note">Note (optional)</label><input type="text" id="gift-note" maxlength="80"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="submit">Send gift</button></div>
  </form>
</dialog>`;
let giftState = null;
export async function openGift(ctx, toId, toName) {
  if (!document.getElementById("gift-dialog")) document.body.insertAdjacentHTML("beforeend", GIFT_DLG_HTML);
  const dlg = document.getElementById("gift-dialog");
  const coins = createCoins(ctx.session);
  const info = (await coins.api("info")).j || {};
  const catalog = info.catalog || [];
  giftState = { to: toId, kind: catalog.length ? catalog[0][0] : "rose", ctx };
  document.getElementById("gift-to").textContent = toName || "Member";
  const grid = document.getElementById("gift-grid");
  grid.innerHTML = catalog.map(([k, e, n, c]) => `<button type="button" class="gift-opt" data-gift="${esc(k)}" aria-pressed="${giftState.kind === k}"><span>${e}</span>${esc(n)}<small>${c} coins</small></button>`).join("");
  grid.querySelectorAll("[data-gift]").forEach((b) => b.addEventListener("click", () => { giftState.kind = b.dataset.gift; grid.querySelectorAll("[data-gift]").forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
  const bar = document.getElementById("coin-bar");
  paintCoinBar(bar, ctx);
  const form = document.getElementById("gift-form");
  if (!form._mw2wired) {
    form._mw2wired = true;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!giftState) return;
      const { ctx: c2, to, kind } = giftState;
      const note = document.getElementById("gift-note").value.trim();
      const info2 = (await createCoins(c2.session).api("info")).j || {};
      if (!info2.paid) { toast("Gifts are bought with coins. The coin shop opens very soon!"); return; }
      const ok = await sendGift(c2, to, kind, note);
      if (ok === "paid") {
        try { const doc = await c2.gateway.readDoc("members/" + to); const n = ((doc && doc.giftsReceived) || 0) + 1; await c2.gateway.call("rpc", { name: "merge_doc", args: { p_path: "members/" + to, p_patch: { giftsReceived: n } } }); } catch (_) {}
        dlg.close();
        toast("Gift sent 🎁");
        document.dispatchEvent(new CustomEvent("mw-gift-sent", { detail: { to, kind } }));
      }
    });
    dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  }
  if (!dlg.open) dlg.showModal();
}
