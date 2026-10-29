/* DJ BATTLES (owner ask 2026-10-29): two approved members go head-to-head on
 * the decks, taking timed turns; the crowd backs them live; the winner is
 * announced on air. This endpoint owns everything that must be trusted:
 *
 *   BATTLES 2.0 — the TikTok model (owner, later on 2026-10-29): "Whoever
 *   gets the most gifts wins", plus likes with a like count, plus sharing.
 *   The win input is now GIFTS, likes are the free hype layer:
 *   POST {action:"gift", battleId, side, amount} — amount is one of
 *     10/50/100/500 coins and settles EXACTLY like a gift in
 *     functions/api/coins/[[path]].js (the same atomic wallet debit, the
 *     recipient battler earning floor(amount × 0.4) into earned_cents, the
 *     rest recorded as the owner gift_fee in coin_tx, and a "gifts" doc;
 *     coins.js keeps that settlement inline in its route, so the same
 *     writes are replicated here — there is no second balance anywhere).
 *     The denomination maps onto the coins gift catalog (10=mic, 50=crown,
 *     100=gold, 500=moneygun) so the gifts doc is a normal catalog gift
 *     with context "battle". Each gift is ALSO recorded in "battlegifts"
 *     (path battlegifts/<battleId>-<giftId>) for the battle tally.
 *   POST {action:"like", battleId, side} — free taps, rate-limited; one
 *     doc per member per side in "battlelikes"
 *     (path battlelikes/<battleId>-<uid>-<side>) holding a count this
 *     endpoint increments server-side.
 *   WIN RULE: most gift coins wins; a gift tie breaks on likes; still
 *   tied is a draw.
 *   POST {action:"vote", battleId, side:"p1"|"p2"} — v1, kept harmless:
 *     one vote per member per ROUND. The round is read from the radio/dj
 *     doc server-side, never from the client. The vote itself is a doc in
 *     the "battlevotes" collection at path
 *     battlevotes/<battleId>-<round>-<uid>, so the dedupe is the primary
 *     key: a second tap in the same round finds the doc already there and
 *     counts nothing. Nothing reads votes for the result any more.
 *   GET ?battleId= — { gifts:{p1,p2}, likes:{p1,p2} } summed from the
 *     battlegifts / battlelikes docs, plus the v1 vote fields {p1, p2}.
 *   POST {action:"advance"} — the turn engine. Any signed-in client may
 *     call it (Malik's booth ticks it, the battler whose turn just ended
 *     backstops it); the transition only happens when the stored
 *     turnEndsAt has actually passed, and the write is optimistic-checked
 *     against the turnEndsAt it was computed from, so two callers racing
 *     can never flip twice. Every switch stamps the horn (fxHornAt);
 *     round changes and the finish also stamp a voice drop + ticker.
 *   POST {action:"switch"} / {action:"end"} — owner-only (admins table):
 *     force a turn switch now, or finish the battle now.
 *
 * Battle STATE lives in the radio/dj doc (S.battle) — written at START by
 * Malik's booth through the normal owner save, and after that only here.
 * Scores are never stored in S; they are counted from the gift/like docs.
 * At the finish the winner uid is stored in S.battle.winner and the
 * numbers ride the voice-drop / ticker text.
 */
import { userFrom, isAdmin, json, change, setup, take, uuid } from "../../lib/cf.js";

const STATION = "radio/dj";
const ID_OK = /^[a-z0-9][a-z0-9-]{3,40}$/;
const nm = (w) => { const n = String((w && w.name) || "").trim(); return n ? (n.includes("@") ? n.split("@")[0] : n) : "DJ"; };

/* --- the coins economy, mirrored from functions/api/coins/[[path]].js ---
 * Same owner, same member share, same tables. The battle gift settlement
 * below performs the identical writes coins.js performs for its gift
 * route (wallets debit/credit, the three coin_tx rows, the gifts doc). */
const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
const MEMBER_SHARE = 0.4; // the person who receives a gift earns 40%
const GIFT_KIND = { 10: "mic", 50: "crown", 100: "gold", 500: "moneygun" }; // battle denomination -> coins gift catalog key (same coin cost)
const COIN_SCHEMA = [
  "create table if not exists wallets (uid text primary key, coins integer not null default 0, earned_cents integer not null default 0, paid_cents integer not null default 0, updated_at integer)",
  "create table if not exists coin_tx (id text primary key, uid text not null, kind text not null, coins integer not null default 0, cents integer not null default 0, other text, at integer not null)",
  "create index if not exists coin_tx_uid on coin_tx (uid, at)",
];
let coinReady = null;
const ensureCoins = (env) => (coinReady = coinReady || env.DB.batch(COIN_SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { coinReady = null; throw e; }));

async function readDoc(env, path) {
  const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
  if (!row) return null;
  try { return JSON.parse(row.data || "{}"); } catch (_) { return null; }
}

/* Same write shape as functions/api/station.js: update the doc (insert if
 * missing) and drop a changes row in the same batch so sync clients see it. */
async function writeDoc(env, path, coll, data) {
  const now = new Date().toISOString();
  const existing = await env.DB.prepare("select path from docs where path = ?").bind(path).first();
  const stmts = existing
    ? [env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(JSON.stringify(data), now, path)]
    : [env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, coll, null, JSON.stringify(data), now, now)];
  stmts.push(change(env, "docs", path, coll));
  await env.DB.batch(stmts);
}

async function countVotes(env, battleId) {
  const out = { p1: 0, p2: 0 };
  try {
    const { results } = await env.DB.prepare("select data from docs where coll = 'battlevotes' and path like ? limit 4000").bind("battlevotes/" + battleId + "-%").all();
    for (const r of results || []) {
      try { const d = JSON.parse(r.data || "{}"); if (d.side === "p1") out.p1++; else if (d.side === "p2") out.p2++; } catch (_) {}
    }
  } catch (_) {}
  return out;
}

/* 2.0 tallies: gift coins summed from the battlegifts docs, likes summed
 * from the per-member battlelikes count docs. */
async function countGifts(env, battleId) {
  const out = { p1: 0, p2: 0 };
  try {
    const { results } = await env.DB.prepare("select data from docs where coll = 'battlegifts' and path like ? limit 4000").bind("battlegifts/" + battleId + "-%").all();
    for (const r of results || []) {
      try { const d = JSON.parse(r.data || "{}"); const a = Math.max(0, +d.amount || 0); if (d.side === "p1") out.p1 += a; else if (d.side === "p2") out.p2 += a; } catch (_) {}
    }
  } catch (_) {}
  return out;
}

async function countLikes(env, battleId) {
  const out = { p1: 0, p2: 0 };
  try {
    const { results } = await env.DB.prepare("select data from docs where coll = 'battlelikes' and path like ? limit 4000").bind("battlelikes/" + battleId + "-%").all();
    for (const r of results || []) {
      try { const d = JSON.parse(r.data || "{}"); const n = Math.max(0, +d.count || 0); if (d.side === "p1") out.p1 += n; else if (d.side === "p2") out.p2 += n; } catch (_) {}
    }
  } catch (_) {}
  return out;
}

async function fullTally(env, battleId) {
  return { gifts: await countGifts(env, battleId), likes: await countLikes(env, battleId) };
}

/* The 2.0 win rule: most gift coins wins; a gift tie breaks on likes;
 * still tied is a draw. tally = { gifts:{p1,p2}, likes:{p1,p2} }. */
function finishBattle(S, tally, now) {
  const b = S.battle;
  const g = tally.gifts, l = tally.likes;
  let w = "";
  if (g.p1 !== g.p2) w = g.p1 > g.p2 ? b.p1.uid : b.p2.uid;
  else if (l.p1 !== l.p2) w = l.p1 > l.p2 ? b.p1.uid : b.p2.uid;
  b.phase = "done"; b.winner = w; b.turn = ""; b.turnEndsAt = 0; b.at = now;
  if (w) {
    const wn = nm(w === b.p1.uid ? b.p1 : b.p2);
    const wg = w === b.p1.uid ? g.p1 : g.p2, lg = w === b.p1.uid ? g.p2 : g.p1;
    const wl = w === b.p1.uid ? l.p1 : l.p2, ll = w === b.p1.uid ? l.p2 : l.p1;
    S.voice = { id: "battle-" + b.id + "-final", text: "The battle is over! " + wn + " takes it, " + wg + " coins to " + lg + "!", at: now };
    S.ticker = "⚔️ " + wn + " wins the DJ battle, " + wg + "–" + lg + " coins!" + (wg === lg ? " (likes " + wl + "–" + ll + ")" : "");
  } else {
    S.voice = { id: "battle-" + b.id + "-final", text: "The battle is over! It is a draw — " + g.p1 + " coins to " + g.p2 + "!", at: now };
    S.ticker = "⚔️ The DJ battle ends in a DRAW, " + g.p1 + "–" + g.p2 + " coins!";
  }
  return b;
}

/* One deterministic transition. Returns null when nothing is due, {raced}
 * when another caller transitioned first, or {done, battle, tally}. */
async function transition(env, S, now, force, finishNow) {
  const b = S.battle;
  if (!b || !b.on || !b.id || b.phase !== "live") return null;
  if (!force && !finishNow && now <= (+b.turnEndsAt || 0)) return null;
  const wasEndsAt = +b.turnEndsAt || 0;
  S.fxHornAt = now; // the horn fires on every switch, this one included
  let tally = null;
  if (finishNow || (b.turn === b.p2.uid && (+b.round || 1) >= (+b.rounds || 3))) {
    tally = await fullTally(env, b.id);
    finishBattle(S, tally, now);
  } else if (b.turn === b.p1.uid) {
    b.turn = b.p2.uid; b.turnEndsAt = now + (+b.turnSec || 90) * 1000; b.at = now;
  } else {
    // p2's turn ended and rounds remain: next round, p1 leads it off
    b.round = (+b.round || 1) + 1; b.turn = b.p1.uid; b.turnEndsAt = now + (+b.turnSec || 90) * 1000; b.at = now;
    S.voice = { id: "battle-" + b.id + "-r" + b.round, text: "Round " + b.round + " — " + nm(b.p1) + ", you are up!", at: now };
  }
  // optimistic write: only land if the stored battle has not already moved
  const cur = await readDoc(env, STATION);
  const cb = cur && cur.battle;
  if (!cb || cb.id !== b.id || cb.phase !== "live" || (+cb.turnEndsAt || 0) !== wasEndsAt) {
    return { raced: true, battle: cb || null, tally };
  }
  S.updatedAt = now;
  await writeDoc(env, STATION, "radio", S);
  return { done: b.phase === "done", battle: b, tally };
}

export async function onRequestGet({ request, env }) {
  setup(env);
  const id = new URL(request.url).searchParams.get("battleId") || "";
  if (!ID_OK.test(id)) return json({ error: "bad_id" }, 400);
  const votes = await countVotes(env, id); // v1 fields, kept additive
  const tally = await fullTally(env, id);
  const S = await readDoc(env, STATION);
  const b = S && S.battle;
  const cur = b && b.id === id ? { phase: b.phase, round: b.round, rounds: b.rounds, turn: b.turn, turnEndsAt: b.turnEndsAt, winner: b.winner } : null;
  return json({ ok: true, battleId: id, p1: votes.p1, p2: votes.p2, gifts: tally.gifts, likes: tally.likes, battle: cur });
}

export async function onRequestPost({ request, env }) {
  setup(env);
  const me = await userFrom(request, env);
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const action = String(body.action || "");

  /* --- 2.0: gift coins to a battler. Settles exactly like the gift route
   * in functions/api/coins/[[path]].js: one atomic debit statement (a
   * balance can never go negative or be spent twice), the recipient
   * earns floor(cost × 0.4) into earned_cents, the rest is the owner
   * gift_fee, and the three coin_tx rows + a "gifts" doc are written in
   * the same batch. The extra battlegifts doc is the battle tally. --- */
  if (action === "gift") {
    if (!me) return json({ error: "not_signed_in" }, 401);
    if (!(await take(env, "bgift:" + me.id, 60, 30))) return json({ error: "too_fast" }, 429);
    const battleId = String(body.battleId || "");
    const side = body.side === "p1" || body.side === "p2" ? body.side : "";
    const amount = +body.amount || 0;
    if (!ID_OK.test(battleId) || !side || !GIFT_KIND[amount]) return json({ error: "bad_gift" }, 400);
    const S = await readDoc(env, STATION);
    const b = S && S.battle;
    if (!b || !b.on || b.id !== battleId || b.phase !== "live") return json({ error: "not_live" }, 409);
    const to = side === "p1" ? b.p1.uid : b.p2.uid;
    if (!/^[0-9a-f-]{36}$/.test(String(to || "")) || to === me.id) return json({ error: "bad_recipient" }, 400);
    if (!(await env.DB.prepare("select 1 from docs where path = ?").bind("members/" + to).first())) return json({ error: "no_member" }, 404);
    await ensureCoins(env);
    const cost = amount, earn = Math.floor(cost * MEMBER_SHARE), now = Date.now(), id = uuid(), iso = new Date(now).toISOString();
    // take the coins only if they have enough (one statement, so two taps can't spend the same coins twice)
    const spent = await env.DB.prepare("update wallets set coins = coins - ?, updated_at = ? where uid = ? and coins >= ?").bind(cost, now, me.id, cost).run();
    if (!spent.meta.changes) return json({ ok: false, error: "coins" }, 402);
    const gift = { from: me.id, to, kind: GIFT_KIND[amount], qty: 1, note: "", coins: cost, paid: true, context: "battle", battle: battleId, createdAt: now };
    const gp = "gifts/" + id, bp = "battlegifts/" + battleId + "-" + id;
    await env.DB.batch([
      env.DB.prepare("insert into wallets (uid, earned_cents, updated_at) values (?,?,?) on conflict(uid) do update set earned_cents = earned_cents + excluded.earned_cents, updated_at = excluded.updated_at").bind(to, earn, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("gs:" + id, me.id, "gift_sent", -cost, 0, to, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("gr:" + id, to, "gift_received", 0, earn, me.id, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("go:" + id, OWNER_ID, "gift_fee", 0, cost - earn, me.id, now),
      env.DB.prepare("insert into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(gp, "gifts", me.id, JSON.stringify(gift), iso, iso),
      change(env, "docs", gp, "gifts"),
      env.DB.prepare("insert into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(bp, "battlegifts", me.id, JSON.stringify({ battleId, giftId: id, side, amount: cost, from: me.id, to, at: now }), iso, iso),
      change(env, "docs", bp, "battlegifts"),
    ]);
    const w = await env.DB.prepare("select coins from wallets where uid = ?").bind(me.id).first();
    const tally = await fullTally(env, battleId);
    return json({ ok: true, side, amount: cost, coins: w ? w.coins : 0, gifts: tally.gifts, likes: tally.likes });
  }

  /* --- 2.0: likes. Free, unlimited taps, rate-limited to ~5 per second
   * per member (take() counts a rolling 1-second window). One doc per
   * member per side holds the count; this endpoint is the only writer,
   * so the read-modify-write below is the tally of record. --- */
  if (action === "like") {
    if (!me) return json({ error: "not_signed_in" }, 401);
    if (!(await take(env, "blike:" + me.id, 1, 5))) return json({ error: "too_fast" }, 429);
    const battleId = String(body.battleId || "");
    const side = body.side === "p1" || body.side === "p2" ? body.side : "";
    if (!ID_OK.test(battleId) || !side) return json({ error: "bad_like" }, 400);
    const S = await readDoc(env, STATION);
    const b = S && S.battle;
    if (!b || !b.on || b.id !== battleId || b.phase !== "live") return json({ error: "not_live" }, 409);
    const path = "battlelikes/" + battleId + "-" + me.id + "-" + side;
    const prev = await readDoc(env, path);
    const count = Math.max(0, +((prev && prev.count) || 0)) + 1;
    const data = JSON.stringify({ battleId, uid: me.id, side, count, at: Date.now() });
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      prev
        ? env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, path)
        : env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, "battlelikes", me.id, data, nowIso, nowIso),
      change(env, "docs", path, "battlelikes"),
    ]);
    const likes = await countLikes(env, battleId);
    return json({ ok: true, side, likes });
  }

  if (action === "vote") {
    if (!me) return json({ error: "not_signed_in" }, 401);
    if (!(await take(env, "bvote:" + me.id, 60, 30))) return json({ error: "too_fast" }, 429);
    const battleId = String(body.battleId || "");
    const side = body.side === "p1" || body.side === "p2" ? body.side : "";
    if (!ID_OK.test(battleId) || !side) return json({ error: "bad_vote" }, 400);
    const S = await readDoc(env, STATION);
    const b = S && S.battle;
    if (!b || !b.on || b.id !== battleId || b.phase !== "live") return json({ error: "not_live" }, 409);
    const round = Math.max(1, +b.round || 1); // the round comes from the doc, never the client
    const tally = await countVotes(env, battleId);
    const path = "battlevotes/" + battleId + "-" + round + "-" + me.id;
    const ex = await env.DB.prepare("select path from docs where path = ?").bind(path).first();
    if (ex) return json({ ok: true, dup: true, round, p1: tally.p1, p2: tally.p2 });
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)")
        .bind(path, "battlevotes", me.id, JSON.stringify({ battleId, round, uid: me.id, side, at: Date.now() }), nowIso, nowIso),
      change(env, "docs", path, "battlevotes"),
    ]);
    tally[side]++;
    return json({ ok: true, round, side, p1: tally.p1, p2: tally.p2 });
  }

  if (action === "advance" || action === "switch" || action === "end") {
    if (!me) return json({ error: "not_signed_in" }, 401);
    const force = action !== "advance";
    if (force && !(await isAdmin(env, me.id))) return json({ error: "owner_only" }, 403);
    if (!(await take(env, "badv:" + me.id, 10, 20))) return json({ error: "too_fast" }, 429);
    const S = await readDoc(env, STATION);
    if (!S) return json({ error: "no_state" }, 404);
    const r = await transition(env, S, Date.now(), force, action === "end");
    const b = (r && r.battle) || S.battle || null;
    const tally = r && r.tally ? r.tally : (b && b.id ? await fullTally(env, b.id) : { gifts: { p1: 0, p2: 0 }, likes: { p1: 0, p2: 0 } });
    const votes = b && b.id ? await countVotes(env, b.id) : { p1: 0, p2: 0 };
    return json({ ok: true, moved: !!(r && !r.raced), done: !!(r && r.done), battle: b, p1: votes.p1, p2: votes.p2, gifts: tally.gifts, likes: tally.likes });
  }

  return json({ error: "bad_action" }, 400);
}
