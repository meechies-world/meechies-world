/* DJ BATTLES (owner ask 2026-10-29): two approved members go head-to-head on
 * the decks, taking timed turns; the crowd votes live; the winner is
 * announced on air. This endpoint owns everything that must be trusted:
 *
 *   POST {action:"vote", battleId, side:"p1"|"p2"} — one vote per member
 *     per ROUND. The round is read from the radio/dj doc server-side,
 *     never from the client. The vote itself is a doc in the "battlevotes"
 *     collection at path battlevotes/<battleId>-<round>-<uid>, so the
 *     dedupe is the primary key: a second tap in the same round finds the
 *     doc already there and counts nothing.
 *   GET ?battleId= — the tally {p1, p2}, counted from the vote docs.
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
 * Scores are never stored in S; they are counted from the vote docs. At
 * the finish the winner uid is stored in S.battle.winner and the numbers
 * ride the voice-drop / ticker text.
 */
import { userFrom, isAdmin, json, change, setup, take } from "../../lib/cf.js";

const STATION = "radio/dj";
const ID_OK = /^[a-z0-9][a-z0-9-]{3,40}$/;
const nm = (w) => { const n = String((w && w.name) || "").trim(); return n ? (n.includes("@") ? n.split("@")[0] : n) : "DJ"; };

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

function finishBattle(S, tally, now) {
  const b = S.battle;
  const w = tally.p1 > tally.p2 ? b.p1.uid : tally.p2 > tally.p1 ? b.p2.uid : "";
  b.phase = "done"; b.winner = w; b.turn = ""; b.turnEndsAt = 0; b.at = now;
  const hi = Math.max(tally.p1, tally.p2), lo = Math.min(tally.p1, tally.p2);
  if (w) {
    const wn = nm(w === b.p1.uid ? b.p1 : b.p2);
    S.voice = { id: "battle-" + b.id + "-final", text: "The battle is over! " + wn + " takes it, " + hi + " votes to " + lo + "!", at: now };
    S.ticker = "⚔️ " + wn + " wins the DJ battle, " + hi + "–" + lo + "!";
  } else {
    S.voice = { id: "battle-" + b.id + "-final", text: "The battle is over! It is a draw — " + tally.p1 + " votes to " + tally.p2 + "!", at: now };
    S.ticker = "⚔️ The DJ battle ends in a DRAW, " + tally.p1 + "–" + tally.p2 + "!";
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
    tally = await countVotes(env, b.id);
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
  const tally = await countVotes(env, id);
  const S = await readDoc(env, STATION);
  const b = S && S.battle;
  const cur = b && b.id === id ? { phase: b.phase, round: b.round, rounds: b.rounds, turn: b.turn, turnEndsAt: b.turnEndsAt, winner: b.winner } : null;
  return json({ ok: true, battleId: id, p1: tally.p1, p2: tally.p2, battle: cur });
}

export async function onRequestPost({ request, env }) {
  setup(env);
  const me = await userFrom(request, env);
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const action = String(body.action || "");

  if (action === "vote") {
    if (!me) return json({ error: "not_signed_in" }, 401);
    if (await take(env, "bvote:" + me.id, 60, 30)) return json({ error: "too_fast" }, 429);
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
    if (await take(env, "badv:" + me.id, 10, 20)) return json({ error: "too_fast" }, 429);
    const S = await readDoc(env, STATION);
    if (!S) return json({ error: "no_state" }, 404);
    const r = await transition(env, S, Date.now(), force, action === "end");
    const b = (r && r.battle) || S.battle || null;
    const tally = r && r.tally ? r.tally : (b && b.id ? await countVotes(env, b.id) : { p1: 0, p2: 0 });
    return json({ ok: true, moved: !!(r && !r.raced), done: !!(r && r.done), battle: b, p1: tally.p1, p2: tally.p2 });
  }

  return json({ error: "bad_action" }, 400);
}
