/* Meechie's World Coins: members buy coins (Stripe Checkout), send paid gifts, and the person who
 * receives a gift earns 40% of its value; Meechie keeps 60%. Members ask to cash out their earnings and
 * Meechie pays them himself (Cash App / PayPal / Zelle), then marks the request paid.
 *
 * Owner setup (he enters these himself in Cloudflare → Pages → meechies-world → Settings → Variables and secrets):
 *   STRIPE_SECRET_KEY      his Stripe secret key (sk_live_… or sk_test_… to try it first)
 *   STRIPE_WEBHOOK_SECRET  from Stripe → Developers → Webhooks, endpoint https://meechiesworldinc.com/api/coins/webhook,
 *                          event checkout.session.completed
 * Until STRIPE_SECRET_KEY is set, gifts stay free like before.
 *
 * 1 coin = 1 cent of value. Stripe's card fee comes out of Meechie's 60%. */
import { json, userFrom, isAdmin, setup, take, change, uuid } from "../../../lib/cf.js";

export const PACKS = { p100: { coins: 100, cents: 100 }, p550: { coins: 550, cents: 500 }, p1150: { coins: 1150, cents: 1000 }, p3000: { coins: 3000, cents: 2500 }, p6250: { coins: 6250, cents: 5000 } };
// Meechie's World gifts, smallest to biggest (1 coin = 1¢). "fx" gifts play a full-screen animation for everyone watching.
export const GIFTS = [
  ["rose", "🌹", "Rose", 1], ["heart", "💛", "Gold Heart", 5], ["mic", "🎤", "Mic Drop", 10], ["gg", "👏", "GG", 15], ["fire", "🔥", "Fire", 25],
  ["crown", "👑", "Crown", 50], ["cash", "💵", "Cash Stack", 99], ["diamond", "💎", "Diamond", 199], ["chain", "⛓️", "Gold Chain", 299],
  ["moneygun", "💸", "Money Gun", 500], ["lion", "🦁", "Lion", 1000], ["ride", "🚘", "Luxury Ride", 2000], ["jet", "🛩️", "Private Jet", 5000],
  ["mansion", "🏰", "Mansion", 10000], ["world", "🌍", "Meechie's World", 20000],
];
export const GIFT_COINS = Object.fromEntries(GIFTS.map((g) => [g[0], g[3]]));
GIFT_COINS.gold = 100; // older gift name, still accepted
const MEMBER_SHARE = 0.4;          // the person who receives the gift
const MIN_CASHOUT_CENTS = 1000;    // $10 — a 1000-coin cashout minimum (owner, 2026-10-27)
const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
const SCHEMA = [
  "create table if not exists wallets (uid text primary key, coins integer not null default 0, earned_cents integer not null default 0, paid_cents integer not null default 0, updated_at integer)",
  "create table if not exists coin_tx (id text primary key, uid text not null, kind text not null, coins integer not null default 0, cents integer not null default 0, other text, at integer not null)",
  "create index if not exists coin_tx_uid on coin_tx (uid, at)",
  "create table if not exists cashouts (id integer primary key autoincrement, uid text not null, cents integer not null, method text, handle text, status text not null default 'requested', at integer not null, paid_at integer)",
  "create table if not exists game_pool (id integer primary key, coins integer not null default 0)",
  "insert or ignore into game_pool (id, coins) values (1, 0)",
  "create table if not exists game_pots (id text primary key, creator text not null, joiner text, bet integer not null, side text not null, status text not null default 'open', winner text, at integer not null, done_at integer)",
  "create index if not exists game_pots_status on game_pots (status, at)",
];
let ready = null;
const ensure = (env) => (ready = ready || env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; }));
const err = (m, s = 400) => json({ error: m }, s);
const wallet = async (env, uid) => (await env.DB.prepare("select coins, earned_cents, paid_cents from wallets where uid = ?").bind(uid).first()) || { coins: 0, earned_cents: 0, paid_cents: 0 };
const pending = async (env, uid) => ((await env.DB.prepare("select coalesce(sum(cents),0) n from cashouts where uid = ? and status = 'requested'").bind(uid).first()) || {}).n || 0;

async function stripe(env, path, form) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { method: "POST", headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && j.error.message) || "Stripe error " + r.status); return j;
}
// Stripe signs each webhook: "t=<time>,v1=<hmac-sha256 of `${t}.${body}`>"
async function stripeSigned(env, body, header) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")).filter((x) => x.length === 2 && x[0] !== "v1").map(([k, v]) => [k, v]));
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  const t = +parts.t; if (!t || Math.abs(Date.now() / 1000 - t) > 600) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === mac.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ mac.charCodeAt(i)), 0) === 0);
}

/* ---------------- Coin Casino (games for coins) ----------------
 * The house can never lose: every payout comes out of the prize pool, and the pool is only ever
 * filled by players — the losing part of every bet (minus a 10% house fee) plus any coins the
 * owner seeds in. A bet is refused up front when its biggest possible win beats the pool, so the
 * site never owes a coin it didn't collect first. Winnings are coins: spend them on gifts (the
 * person you gift earns cash value at the usual 40%) or play them again. Members flagged
 * under 18 can't play. */
const GAMES = {
  flip: { name: "Coin Flip", maxMult: 1.9 },
  highcard: { name: "High Card", maxMult: 1.9 },
  dice: { name: "Lucky Dice", maxMult: 5.4 },
  slots: { name: "Gold Slots", maxMult: 25 },
  race: { name: "Meechie Race", maxMult: 5 },
  wheel: { name: "Wheel of Gold", maxMult: 4.5 },
  plinko: { name: "Gold Drop", maxMult: 8 },
  triple: { name: "Triple Flip", maxMult: 7 },
};
const GAME_MIN_BET = 5, GAME_MAX_BET = 1000, GAME_FEE = 0.10;
const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
const die = () => 1 + rnd(6);
function settleGame(game, bet, choice) {
  // pay = TOTAL coins credited back (0 = lost, bet = push)
  if (game === "flip") {
    const land = rnd(2) ? "tails" : "heads";
    return { pay: land === choice ? Math.floor(bet * 1.9) : 0, detail: { land } };
  }
  if (game === "highcard") {
    const you = 2 + rnd(13), dealer = 2 + rnd(13);
    return { pay: you > dealer ? Math.floor(bet * 1.9) : you === dealer ? bet : 0, detail: { you, dealer } };
  }
  if (game === "dice") {
    const d1 = die(), d2 = die(), sum = d1 + d2;
    const win = choice === "seven" ? sum === 7 : choice === "over" ? sum > 7 : sum < 7;
    return { pay: win ? Math.floor(bet * (choice === "seven" ? 5.4 : 2.2)) : 0, detail: { d1, d2, sum } };
  }
  if (game === "slots") {
    const W = [["🌹", 3], ["🎤", 3], ["🔥", 2], ["💵", 2], ["💎", 1], ["👑", 1]];
    const bag = W.flatMap(([s, w]) => Array(w).fill(s));
    const reels = [bag[rnd(12)], bag[rnd(12)], bag[rnd(12)]];
    const TRIPLE = { "👑": 25, "💎": 15, "💵": 10, "🔥": 10, "🎤": 8, "🌹": 6 };
    let pay = 0;
    if (reels[0] === reels[1] && reels[1] === reels[2]) pay = Math.floor(bet * TRIPLE[reels[0]]);
    else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) pay = Math.floor(bet * 1.2);
    return { pay, detail: { reels } };
  }
  if (game === "wheel") {
    // 12 segments; pays back about 92 per 100 bet over time, same house math as the rest of the floor
    const SEGS = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1.5, 2, 4.5];
    const seg = rnd(12), mult = SEGS[seg];
    return { pay: Math.floor(bet * mult), detail: { seg, mult } };
  }
  if (game === "plinko") {
    // 7 bounces, 8 slots: the middle is common and pays small, the edges are rare and pay big — about 89 back per 100
    const MULTS = [8, 2.5, 1, 0.3, 0.3, 1, 2.5, 8];
    const path = Array.from({ length: 7 }, () => rnd(2));
    const slot = path.reduce((a, b) => a + b, 0), mult = MULTS[slot];
    return { pay: Math.floor(bet * mult), detail: { path, slot, mult } };
  }
  if (game === "triple") {
    const flips = [rnd(2), rnd(2), rnd(2)], heads = flips.reduce((a, b) => a + b, 0);
    const win = choice === "heads3" ? heads === 3 : choice === "tails3" ? heads === 0 : heads === 1 || heads === 2;
    return { pay: win ? Math.floor(bet * (choice === "mixed" ? 1.2 : 7)) : 0, detail: { flips, heads } };
  }
  const rolls = [die(), die(), die(), die()], total = rolls.reduce((a, b) => a + b, 0); // race: 4 dice down a 24-space board
  return { pay: total >= 21 ? bet * 5 : total >= 17 ? Math.floor(bet * 1.8) : total >= 13 ? bet : 0, detail: { rolls, total } };
}
const poolRow = async (env) => ((await env.DB.prepare("select coins from game_pool where id = 1").first()) || { coins: 0 }).coins;

/* ---------------- Daily check-in ----------------
 * One claim per member per America/New_York day: 10 free coins, and every
 * 7th straight day pays a 40-coin bonus (50 total). The claim is a coin_tx
 * row with kind "daily" and a deterministic id, so a double claim can never
 * pay twice; the wallet is credited only when the insert actually landed. */
const DAILY_BASE = 10, DAILY_BONUS_EVERY = 7, DAILY_BONUS = 40;
const dayET = (back = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - back * 864e5));
const dailyDays = async (env, uid) => new Set(((await env.DB.prepare("select id from coin_tx where uid = ? and kind = 'daily' order by at desc limit 90").bind(uid).all()).results || []).map((r) => String(r.id).split(":").pop()));

/* ---------------- Welcome promo drop ----------------
 * One-time 100 free coins per member (owner promo, 2026-10-27). Same
 * insert-or-ignore claim shape as the daily, so nobody can claim twice.
 * The drop costs the owner nothing out of pocket by design: game payouts
 * only ever come out of the player-funded prize pool, and every game pays
 * back less than fair odds, so promo coins played here mostly flow back
 * into the pool and the house fee — and players who run out buy packs. */
const PROMO_ID = "launch100", PROMO_COINS = 100;
const streakFrom = (days, includeToday) => { let n = 0; for (let i = includeToday ? 0 : 1; ; i++) { if (days.has(dayET(i))) n++; else break; } return n; };
const isUnder18 = async (env, uid) => { const r = await env.DB.prepare("select data from docs where path = ?").bind("members/" + uid).first(); try { return !!(r && JSON.parse(r.data || "{}").under18); } catch (_) { return false; } };

export async function onRequest({ request, env, params }) {
  if (!env.DB) return err("Database not connected.", 503);
  await setup(env); await ensure(env);
  const parts = Array.isArray(params.path) ? params.path : [params.path || ""];
  const route = parts.join("/"), method = request.method;
  const paid = !!env.STRIPE_SECRET_KEY;

  // public: is the coin shop on, what things cost
  if (route === "info") return json({ paid, packs: PACKS, gifts: GIFT_COINS, catalog: GIFTS.map(([k, e, n, c]) => ({ k, e, n, c, fx: c >= 500 })), memberShare: MEMBER_SHARE, minCashout: MIN_CASHOUT_CENTS });

  // Stripe → us: a purchase finished
  if (route === "webhook" && method === "POST") {
    const body = await request.text();
    if (!(await stripeSigned(env, body, request.headers.get("stripe-signature")))) return err("bad signature", 400);
    const ev = JSON.parse(body);
    if (ev.type === "checkout.session.completed") {
      const s = ev.data.object, uid = s.metadata && s.metadata.uid, coins = +(s.metadata && s.metadata.coins) || 0;
      if (uid && coins > 0 && s.payment_status === "paid") {
        const now = Date.now();
        const r = await env.DB.prepare("insert or ignore into coin_tx (id, uid, kind, coins, cents, at) values (?,?,?,?,?,?)").bind("cs:" + s.id, uid, "buy", coins, s.amount_total || 0, now).run();
        if (r.meta.changes) await env.DB.prepare("insert into wallets (uid, coins, updated_at) values (?,?,?) on conflict(uid) do update set coins = coins + excluded.coins, updated_at = excluded.updated_at").bind(uid, coins, now).run();
      }
    }
    return json({ received: true });
  }

  const me = await userFrom(request, env);
  if (!me) return err("Sign in first.", 401);
  const admin = await isAdmin(env, me.id);

  if (route === "me" && method === "GET") {
    const w = await wallet(env, me.id), p = await pending(env, me.id);
    const recent = (await env.DB.prepare("select kind, coins, cents, other, at from coin_tx where uid = ? order by at desc limit 30").bind(me.id).all()).results || [];
    const outs = (await env.DB.prepare("select id, cents, method, status, at, paid_at from cashouts where uid = ? order by at desc limit 10").bind(me.id).all()).results || [];
    return json({ paid, coins: w.coins, earnedCents: w.earned_cents, paidOutCents: w.paid_cents, pendingCents: p, availableCents: w.earned_cents - w.paid_cents - p, recent, cashouts: outs });
  }

  /* ---------------- Coin Casino routes ---------------- */
  if (route === "games" && method === "GET") {
    const pool = await poolRow(env);
    const maxBet = {}; for (const [k, g] of Object.entries(GAMES)) maxBet[k] = Math.max(0, Math.min(GAME_MAX_BET, Math.floor(pool / (g.maxMult - 1))));
    const pots = (await env.DB.prepare("select id, creator, bet, side, at from game_pots where status = 'open' order by at desc limit 20").all()).results || [];
    const wins = (await env.DB.prepare("select uid, kind, coins, other, at from coin_tx where kind in ('game_win','pot_win') order by at desc limit 12").all()).results || [];
    const mine = (await env.DB.prepare("select kind, coins, other, at from coin_tx where (uid = ? and kind like 'game%') or (uid = ? and kind like 'pot%') order by at desc limit 10").bind(me.id, me.id).all()).results || [];
    const promoClaimed = !!(await env.DB.prepare("select 1 from coin_tx where id = ?").bind("promo:" + PROMO_ID + ":" + me.id).first());
    return json({ pool, games: Object.fromEntries(Object.entries(GAMES).map(([k, g]) => [k, { name: g.name, maxMult: g.maxMult }])), maxBet, minBet: GAME_MIN_BET, fee: GAME_FEE, pots, wins, mine, admin, paid, promo: { amount: PROMO_COINS, claimed: promoClaimed } });
  }

  if (route === "daily" && method === "GET") {
    const days = await dailyDays(env, me.id);
    const claimed = days.has(dayET(0));
    return json({ claimed, base: DAILY_BASE, bonusEvery: DAILY_BONUS_EVERY, bonus: DAILY_BONUS, streak: streakFrom(days, claimed), coins: (await wallet(env, me.id)).coins });
  }

  if (route === "daily/claim" && method === "POST") {
    if (!(await take(env, "daily:" + me.id, 60, 10))) return err("Slow down a little.", 429);
    const days = await dailyDays(env, me.id);
    const streak = streakFrom(days, false) + 1;
    const amount = DAILY_BASE + (streak % DAILY_BONUS_EVERY === 0 ? DAILY_BONUS : 0);
    const now = Date.now();
    const ins = await env.DB.prepare("insert or ignore into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("daily:" + me.id + ":" + dayET(0), me.id, "daily", amount, 0, "checkin", now).run();
    if (!ins.meta.changes) return err("You already claimed today's coins. Come back tomorrow for more.");
    await env.DB.prepare("insert into wallets (uid, coins, updated_at) values (?,?,?) on conflict(uid) do update set coins = coins + excluded.coins, updated_at = excluded.updated_at").bind(me.id, amount, now).run();
    return json({ ok: true, amount, streak, bonus: amount - DAILY_BASE, coins: (await wallet(env, me.id)).coins });
  }

  if (route === "promo/claim" && method === "POST") {
    if (!(await take(env, "promo:" + me.id, 60, 10))) return err("Slow down a little.", 429);
    const now = Date.now();
    const ins = await env.DB.prepare("insert or ignore into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("promo:" + PROMO_ID + ":" + me.id, me.id, "promo", PROMO_COINS, 0, "welcome drop", now).run();
    if (!ins.meta.changes) return err("You already claimed your welcome drop.");
    await env.DB.prepare("insert into wallets (uid, coins, updated_at) values (?,?,?) on conflict(uid) do update set coins = coins + excluded.coins, updated_at = excluded.updated_at").bind(me.id, PROMO_COINS, now).run();
    return json({ ok: true, amount: PROMO_COINS, coins: (await wallet(env, me.id)).coins });
  }

  if (route === "play" && method === "POST") {
    if (await isUnder18(env, me.id)) return err("Members under 18 can't play coin games.");
    if (!(await take(env, "play:" + me.id, 60, 120))) return err("Slow down a little.", 429);
    const b = await request.json().catch(() => ({}));
    const game = String(b.game || ""), G = GAMES[game]; if (!G) return err("Pick a game.");
    const bet = Math.round(+b.bet || 0);
    if (!(bet >= GAME_MIN_BET && bet <= GAME_MAX_BET)) return err("Bets are " + GAME_MIN_BET + " to " + GAME_MAX_BET + " coins.");
    let choice = String(b.choice || "");
    if (game === "flip" && !["heads", "tails"].includes(choice)) return err("Pick heads or tails.");
    if (game === "dice" && !["under", "over", "seven"].includes(choice)) return err("Pick under 7, over 7, or exactly 7.");
    if (game === "triple" && !["heads3", "tails3", "mixed"].includes(choice)) return err("Pick all heads, all tails, or mixed.");
    const pool = await poolRow(env);
    const maxNow = Math.min(GAME_MAX_BET, Math.floor(pool / (G.maxMult - 1)));
    if (bet > maxNow) return err(pool < GAME_MIN_BET ? "The prize pool is empty right now. PvP pots are still open, and every lost bet refills the pool." : "The prize pool (" + pool + " coins) caps this game's bet at " + maxNow + " right now.");
    const now = Date.now(), id = uuid();
    const spent = await env.DB.prepare("update wallets set coins = coins - ?, updated_at = ? where uid = ? and coins >= ?").bind(bet, now, me.id, bet).run();
    if (!spent.meta.changes) return err("not_enough_coins", 402);
    const { pay, detail } = settleGame(game, bet, choice);
    const fee = Math.floor(bet * GAME_FEE);
    const tx = (pfx, uid2, kind, coins, cents) => env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind(pfx + id, uid2, kind, coins, cents, game, now);
    let stmts, note = "";
    if (pay > bet) {
      stmts = [tx("gb:", me.id, "game_bet", -bet, 0),
        env.DB.prepare("update game_pool set coins = coins - ? where id = 1 and coins >= ?").bind(pay - bet, pay - bet),
        env.DB.prepare("update wallets set coins = coins + ?, updated_at = ? where uid = ?").bind(pay, now, me.id),
        tx("gw:", me.id, "game_win", pay, 0)];
    } else if (pay === bet) {
      stmts = [tx("gb:", me.id, "game_bet", -bet, 0),
        env.DB.prepare("update wallets set coins = coins + ?, updated_at = ? where uid = ?").bind(bet, now, me.id),
        tx("gp:", me.id, "game_push", bet, 0)];
    } else if (pay > 0) {
      const fee2 = Math.min(fee, bet - pay);
      stmts = [tx("gb:", me.id, "game_bet", -bet, 0),
        env.DB.prepare("update wallets set coins = coins + ?, updated_at = ? where uid = ?").bind(pay, now, me.id),
        tx("gw:", me.id, "game_win", pay, 0),
        env.DB.prepare("update game_pool set coins = coins + ? where id = 1").bind(bet - pay - fee2)];
      if (fee2) stmts.push(tx("gf:", OWNER_ID, "game_fee", 0, fee2));
    } else {
      stmts = [tx("gb:", me.id, "game_bet", -bet, 0),
        env.DB.prepare("update game_pool set coins = coins + ? where id = 1").bind(bet - fee)];
      if (fee) stmts.push(tx("gf:", OWNER_ID, "game_fee", 0, fee));
    }
    const res = await env.DB.batch(stmts);
    let finalPay = pay;
    if (pay > bet && !res[1].meta.changes) {
      // two big wins landed at the same moment and the pool can't fund this profit: the round becomes a push, bet back
      await env.DB.batch([
        env.DB.prepare("update wallets set coins = coins - ?, updated_at = ? where uid = ? and coins >= ?").bind(pay - bet, Date.now(), me.id, pay - bet),
        env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("gx:" + id, me.id, "game_push", bet, 0, game, Date.now()),
      ]);
      finalPay = bet; note = "The prize pool just ran low, so this round is a push — your bet is back.";
    }
    const w = await wallet(env, me.id);
    return json({ ok: true, game, bet, pay: finalPay, detail, note, coins: w.coins, pool: await poolRow(env) });
  }

  if (route === "pot/create" && method === "POST") {
    if (await isUnder18(env, me.id)) return err("Members under 18 can't play coin games.");
    if (!(await take(env, "pot:" + me.id, 60, 10))) return err("Slow down a little.", 429);
    const b = await request.json().catch(() => ({}));
    const bet = Math.round(+b.bet || 0), side = String(b.side || "");
    if (!(bet >= GAME_MIN_BET && bet <= GAME_MAX_BET)) return err("Bets are " + GAME_MIN_BET + " to " + GAME_MAX_BET + " coins.");
    if (!["heads", "tails"].includes(side)) return err("Pick heads or tails.");
    const open = await env.DB.prepare("select count(*) n from game_pots where creator = ? and status = 'open'").bind(me.id).first();
    if (open && open.n >= 3) return err("You already have 3 open pots. Wait for a player or cancel one.");
    const now = Date.now(), id = uuid();
    const spent = await env.DB.prepare("update wallets set coins = coins - ?, updated_at = ? where uid = ? and coins >= ?").bind(bet, now, me.id, bet).run();
    if (!spent.meta.changes) return err("not_enough_coins", 402);
    await env.DB.batch([
      env.DB.prepare("insert into game_pots (id, creator, bet, side, status, at) values (?,?,?,?,'open',?)").bind(id, me.id, bet, side, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("pb:" + id, me.id, "pot_bet", -bet, 0, "flip-pvp", now),
    ]);
    return json({ ok: true, id });
  }

  if (route === "pot/join" && method === "POST") {
    if (await isUnder18(env, me.id)) return err("Members under 18 can't play coin games.");
    const b = await request.json().catch(() => ({})); const id = String(b.id || "");
    const pot = await env.DB.prepare("select * from game_pots where id = ? and status = 'open'").bind(id).first();
    if (!pot) return err("That pot is gone — someone beat you to it.");
    if (pot.creator === me.id) return err("That's your own pot.");
    const now = Date.now();
    const spent = await env.DB.prepare("update wallets set coins = coins - ?, updated_at = ? where uid = ? and coins >= ?").bind(pot.bet, now, me.id, pot.bet).run();
    if (!spent.meta.changes) return err("not_enough_coins", 402);
    const claim = await env.DB.prepare("update game_pots set status = 'done', joiner = ?, done_at = ? where id = ? and status = 'open'").bind(me.id, now, id).run();
    if (!claim.meta.changes) { await env.DB.prepare("update wallets set coins = coins + ?, updated_at = ? where uid = ?").bind(pot.bet, now, me.id).run(); return err("That pot just got taken. Your coins are back."); }
    const land = rnd(2) ? "tails" : "heads";
    const creatorWon = land === pot.side, winner = creatorWon ? pot.creator : me.id, loser = creatorWon ? me.id : pot.creator;
    const potTotal = pot.bet * 2, rake = Math.floor(potTotal * GAME_FEE), prize = potTotal - rake;
    await env.DB.batch([
      env.DB.prepare("update game_pots set winner = ? where id = ?").bind(winner, id),
      env.DB.prepare("update wallets set coins = coins + ?, updated_at = ? where uid = ?").bind(prize, now, winner),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("pb:" + id + ":j", me.id, "pot_bet", -pot.bet, 0, "flip-pvp", now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("pw:" + id, winner, "pot_win", prize, 0, "flip-pvp", now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("pf:" + id, OWNER_ID, "game_fee", 0, rake, loser, now),
    ]);
    const w = await wallet(env, me.id);
    return json({ ok: true, land, creatorSide: pot.side, youWon: winner === me.id, prize, coins: w.coins });
  }

  if (route === "pot/cancel" && method === "POST") {
    const b = await request.json().catch(() => ({})); const id = String(b.id || "");
    const pot = await env.DB.prepare("select * from game_pots where id = ? and status = 'open' and creator = ?").bind(id, me.id).first();
    if (!pot) return err("No open pot of yours with that id.");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("update game_pots set status = 'cancelled', done_at = ? where id = ?").bind(now, id),
      env.DB.prepare("update wallets set coins = coins + ?, updated_at = ? where uid = ?").bind(pot.bet, now, me.id),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("pc:" + id, me.id, "pot_refund", pot.bet, 0, "flip-pvp", now),
    ]);
    return json({ ok: true });
  }

  if (route === "pool/seed" && method === "POST") {
    const b = await request.json().catch(() => ({})); const amt = Math.round(+b.coins || 0);
    if (!(amt >= 1 && amt <= 100000)) return err("Pick an amount.");
    const now = Date.now();
    const spent = await env.DB.prepare("update wallets set coins = coins - ?, updated_at = ? where uid = ? and coins >= ?").bind(amt, now, me.id, amt).run();
    if (!spent.meta.changes) return err("not_enough_coins", 402);
    await env.DB.batch([
      env.DB.prepare("update game_pool set coins = coins + ? where id = 1").bind(amt),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("ps:" + uuid(), me.id, "pool_seed", -amt, 0, "casino", now),
    ]);
    return json({ ok: true, pool: await poolRow(env) });
  }

  if (route === "admin/grant" && method === "POST") {
    if (!admin) return err("owner_only", 403);
    const b = await request.json().catch(() => ({})); const amt = Math.round(+b.coins || 0); const to = String(b.to || me.id);
    if (!(amt >= 1 && amt <= 1000000)) return err("Pick an amount.");
    if (!/^[0-9a-f-]{36}$/.test(to)) return err("Bad member id.");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("insert into wallets (uid, coins, updated_at) values (?,?,?) on conflict(uid) do update set coins = coins + excluded.coins, updated_at = excluded.updated_at").bind(to, amt, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("ag:" + uuid(), to, "grant", amt, 0, "casino", now),
    ]);
    return json({ ok: true });
  }

  if (route === "checkout" && method === "POST") {
    if (!paid) return err("The coin shop isn't switched on yet.", 501);
    if (!(await take(env, "buy:" + me.id, 3600, 20))) return err("Too many tries. Wait a little.", 429);
    const b = await request.json().catch(() => ({})); const pk = PACKS[b.pack]; if (!pk) return err("Pick a coin pack.");
    const origin = new URL(request.url).origin;
    const s = await stripe(env, "checkout/sessions", {
      mode: "payment", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(pk.cents),
      "line_items[0][price_data][product_data][name]": pk.coins + " Meechie's World Coins", "metadata[uid]": me.id, "metadata[coins]": String(pk.coins),
      client_reference_id: me.id, success_url: origin + "/#coins-thanks", cancel_url: origin + "/#coins",
    });
    return json({ url: s.url });
  }

  if (route === "gift" && method === "POST") {
    if (!paid) return err("free_mode", 409);
    if (!(await take(env, "gift:" + me.id, 60, 150))) return err("Slow down a little.", 429);
    const b = await request.json().catch(() => ({}));
    const qty = Math.max(1, Math.min(99, Math.round(+b.qty || 1)));
    const to = String(b.to || ""), kind = String(b.kind || ""), cost = GIFT_COINS[kind] * qty;
    if (!GIFT_COINS[kind]) return err("Pick a gift.");
    if (!/^[0-9a-f-]{36}$/.test(to) || to === me.id) return err("You can't send a gift to that person.");
    if (!(await env.DB.prepare("select 1 from docs where path = ?").bind("members/" + to).first())) return err("That member doesn't exist.");
    const note = String(b.note || "").slice(0, 80), now = Date.now(), id = uuid();
    const earn = Math.floor(cost * MEMBER_SHARE);           // coins are cents of value
    // take the coins only if they have enough (one statement, so two taps can't spend the same coins twice)
    const spent = await env.DB.prepare("update wallets set coins = coins - ?, updated_at = ? where uid = ? and coins >= ?").bind(cost, now, me.id, cost).run();
    if (!spent.meta.changes) return err("not_enough_coins", 402);
    const gift = { from: me.id, to, kind, qty, note, coins: cost, paid: true, context: String(b.context || "").slice(0, 20), battle: String(b.battle || "").slice(0, 40), createdAt: now };
    const gp = "gifts/" + id, iso = new Date(now).toISOString();
    await env.DB.batch([
      env.DB.prepare("insert into wallets (uid, earned_cents, updated_at) values (?,?,?) on conflict(uid) do update set earned_cents = earned_cents + excluded.earned_cents, updated_at = excluded.updated_at").bind(to, earn, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("gs:" + id, me.id, "gift_sent", -cost, 0, to, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("gr:" + id, to, "gift_received", 0, earn, me.id, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("go:" + id, OWNER_ID, "gift_fee", 0, cost - earn, me.id, now),
      env.DB.prepare("insert into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(gp, "gifts", me.id, JSON.stringify(gift), iso, iso),
      change(env, "docs", gp, "gifts"),
    ]);
    const w = await wallet(env, me.id);
    return json({ ok: true, coins: w.coins, gift });
  }

  if (route === "cashout" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const methodName = String(b.method || "").slice(0, 20), handle = String(b.handle || "").trim().slice(0, 80);
    if (!["Cash App", "PayPal", "Zelle", "Venmo"].includes(methodName) || handle.length < 3) return err("Tell us where to send it (Cash App, PayPal, Zelle or Venmo).");
    if (/\b\d{3}-?\d{2}-?\d{4}\b|\b\d{12,19}\b/.test(handle)) return err("Never send your Social Security or card number. Just your $cashtag, PayPal email or Zelle phone/email.");
    const w = await wallet(env, me.id), avail = w.earned_cents - w.paid_cents - (await pending(env, me.id));
    if (avail < MIN_CASHOUT_CENTS) return err("You can cash out once you've earned $" + (MIN_CASHOUT_CENTS / 100).toFixed(0) + ".");
    const now = Date.now();
    await env.DB.prepare("insert into cashouts (uid, cents, method, handle, at) values (?,?,?,?,?)").bind(me.id, avail, methodName, handle, now).run();
    // let Meechie know privately
    await env.DB.batch([
      env.DB.prepare("insert into dms (sender, recipient, body, created_at) values (?,?,?,?)").bind(me.id, OWNER_ID, `💸 Cash-out request: $${(avail / 100).toFixed(2)} by ${methodName} to ${handle}. Pay it, then mark it paid in Coins → Payouts.`, new Date(now).toISOString()),
      change(env, "dms", null, null, me.id, OWNER_ID),
    ]);
    return json({ ok: true, cents: avail });
  }

  // owner only: everything that's been bought and earned, and payouts to make
  if (route === "admin" && method === "GET") {
    if (!admin) return err("owner_only", 403);
    const reqs = (await env.DB.prepare("select c.id, c.uid, c.cents, c.method, c.handle, c.status, c.at, c.paid_at, json_extract(d.data, '$.handle') name from cashouts c left join docs d on d.path = 'members/' || c.uid order by c.status = 'requested' desc, c.at desc limit 100").all()).results || [];
    const sum = await env.DB.prepare("select coalesce(sum(case when kind='buy' then cents end),0) sold, coalesce(sum(case when kind='gift_fee' then cents end),0) yours, coalesce(sum(case when kind='gift_received' then cents end),0) members from coin_tx").first();
    return json({ paid, cashouts: reqs, soldCents: sum.sold, yourShareCents: sum.yours, memberShareCents: sum.members });
  }
  if (route === "admin/paid" && method === "POST") {
    if (!admin) return err("owner_only", 403);
    const b = await request.json().catch(() => ({})); const id = +b.id;
    const row = await env.DB.prepare("select * from cashouts where id = ? and status = 'requested'").bind(id).first(); if (!row) return err("Not found or already paid.", 404);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("update cashouts set status = 'paid', paid_at = ? where id = ?").bind(now, id),
      env.DB.prepare("update wallets set paid_cents = paid_cents + ?, updated_at = ? where uid = ?").bind(row.cents, now, row.uid),
      env.DB.prepare("insert into dms (sender, recipient, body, created_at) values (?,?,?,?)").bind(OWNER_ID, row.uid, `✅ Your cash-out of $${(row.cents / 100).toFixed(2)} was sent by ${row.method}. Thanks for being part of Meechie's World!`, new Date(now).toISOString()),
      change(env, "dms", null, null, OWNER_ID, row.uid),
    ]);
    return json({ ok: true });
  }
  return err("Not found", 404);
}
