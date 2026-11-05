/* Meechie's Purse — the coin account IS the purse (Malik's orders, 2026-11-05).
 *
 * One account, not two: the site's coin system (functions/api/coins) is where
 * Meechie's business money lives. Every confirmed site receipt — coin-pack
 * sales, sponsor weeks, DJ setup sales — lands here as an append-only income
 * entry in purse_log, and Meechie spends from the same account under four
 * laws Malik set out loud:
 *
 *   1. NEVER DEBT. No credit, no borrowing: the purse floor is zero and a
 *      spend can never be proposed past the balance (minus what approved
 *      proposals already committed). Enforced in gateProposal().
 *   2. PROFIT GATE. A spend proposal cannot exist without its numbers:
 *      cost, expected return and the measured evidence behind them — and
 *      the expected return must beat the cost. No evidence, no proposal.
 *   3. THE 40% LAW ("He can use 40% of the account."): Meechie's usable
 *      share is PURSE_USABLE_PCT of the balance; the rest is locked reserve
 *      that never moves without Malik himself. A proposal inside his
 *      remaining usable share is within his authority; one past it is NOT
 *      refused — it escalates to the owner in the booth queue. The owner
 *      can change the percentage from the booth purse panel (purse_meta).
 *   4. APPEND-ONLY. purse_log entries are never edited or deleted, only
 *      appended: income, proposals, decisions, config and freeze events
 *      all land as new rows, so the owner can read every move forever.
 *
 * Value: the coin system's own rate — 1 coin = 1 cent of value (see the
 * header of functions/api/coins/[[path]].js). A receipt of N cents credits
 * the purse N coins, and every entry records BOTH the coin amount and the
 * source dollar cents.
 *
 * EXECUTION IS FENCED OFF in this build: approving a proposal is a ledger
 * commitment only. Nothing here moves real money out — no Stripe call, no
 * payout, no external payment of any kind. The spend rows the balance math
 * already understands (kind "spend") are written by a future execution
 * build, never by this one.
 */
import { uuid } from "./cf.js";

/* Malik's number, named once: Meechie may use 40% of the account.
 * The live value sits in purse_meta (owner-changeable from the booth);
 * this constant is the default and the floor the code falls back to. */
export const PURSE_USABLE_PCT = 40;
export const PURSE_CATEGORIES = ["bill", "subscription", "upgrade"];

const SCHEMA = [
  "create table if not exists purse_meta (k text primary key, v text not null)",
  "create table if not exists purse_log (id text primary key, kind text not null, coins integer not null default 0, cents integer not null default 0, source text, ref text, data text, at integer not null)",
  "create index if not exists purse_log_at on purse_log (at)",
  "create table if not exists purse_proposals (id text primary key, status text not null default 'pending', authority text not null, payee text not null, purpose text not null, category text not null, cost_coins integer not null, expected_coins integer not null, evidence text not null, created_by text, at integer not null, decided_at integer, decided_by text, note text)",
  "create index if not exists purse_proposals_status on purse_proposals (status, at)",
];
/* Schema readiness is cached per database binding (not one global
 * promise), so a second binding — a test database, the own-stack
 * port — can never inherit another database's "already created". */
const readyByDb = new WeakMap();
export const ensurePurse = (env) => {
  let p = readyByDb.get(env.DB);
  if (!p) {
    p = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { readyByDb.delete(env.DB); throw e; });
    readyByDb.set(env.DB, p);
  }
  return p;
};

const metaGet = async (env, k) => {
  const r = await env.DB.prepare("select v from purse_meta where k = ?").bind(k).first();
  return r ? r.v : null;
};
const metaSet = (env, k, v) => env.DB.prepare("insert into purse_meta (k, v) values (?,?) on conflict(k) do update set v = excluded.v").bind(k, String(v));
const logRow = (env, kind, coins, cents, source, ref, data, at) =>
  env.DB.prepare("insert into purse_log (id, kind, coins, cents, source, ref, data, at) values (?,?,?,?,?,?,?,?)")
    .bind(uuid(), kind, Math.round(coins || 0), Math.round(cents || 0), source || null, ref || null, data ? JSON.stringify(data) : null, at || Date.now());

export async function purseConfig(env) {
  await ensurePurse(env);
  const pctRaw = await metaGet(env, "usable_pct");
  const pct = pctRaw == null ? NaN : parseInt(pctRaw, 10);
  return {
    usablePct: Number.isInteger(pct) && pct >= 0 && pct <= 100 ? pct : PURSE_USABLE_PCT,
    frozen: (await metaGet(env, "frozen")) === "1",
  };
}

/* The purse's numbers, all derived from the append-only log + the
 * proposal queue (nothing is ever stored as a mutable balance):
 *   balance   = income − spends            (the whole account)
 *   committed = costs of APPROVED proposals (draws Malik or the 40%
 *               law already authorized; they reserve real coins)
 *   usableCap = floor(balance × usablePct / 100)   (the 40% law)
 *   authority = usableCap − committed      (what Meechie can still
 *               commit on his own word)                              */
export async function purseTotals(env, cfg) {
  await ensurePurse(env);
  cfg = cfg || (await purseConfig(env));
  const inc = (await env.DB.prepare("select coalesce(sum(coins),0) c, coalesce(sum(cents),0) d from purse_log where kind = 'income'").first()) || { c: 0, d: 0 };
  const spd = (await env.DB.prepare("select coalesce(sum(coins),0) c from purse_log where kind = 'spend'").first()) || { c: 0 };
  const com = (await env.DB.prepare("select coalesce(sum(cost_coins),0) c from purse_proposals where status = 'approved'").first()) || { c: 0 };
  const balanceCoins = (inc.c || 0) - (spd.c || 0);
  const committedCoins = com.c || 0;
  const usableCapCoins = Math.floor(balanceCoins * cfg.usablePct / 100);
  return {
    incomeCoins: inc.c || 0, incomeCents: inc.d || 0, spendCoins: spd.c || 0,
    balanceCoins, committedCoins, usableCapCoins,
    authorityCoins: usableCapCoins - committedCoins,
    reserveCoins: balanceCoins - usableCapCoins,
  };
}

/* THE GATE — pure, no database: the harness pins this function down.
 * input: { payee, purpose, category, costCoins, expectedCoins, evidence }
 * Returns { ok: true, authority: "meechie" | "owner" } or
 *         { ok: false, code, error }.
 * Refusals (the laws): frozen purse, incomplete profit-gate fields,
 * expected return not beating cost, and the never-debt floor.
 * Past the usable share is NOT a refusal — authority comes back
 * "owner" and the proposal escalates to Malik's booth queue. */
export function gateProposal(totals, cfg, input) {
  const refuse = (code, error) => ({ ok: false, code, error });
  if (cfg && cfg.frozen) return refuse("purse_frozen", "The purse is frozen — no new proposals until the owner unfreezes it.");
  const payee = String((input && input.payee) || "").trim();
  const purpose = String((input && input.purpose) || "").trim();
  const category = String((input && input.category) || "").trim();
  const cost = Math.round(+(input && input.costCoins) || 0);
  const expected = Math.round(+(input && input.expectedCoins) || 0);
  const evidence = String((input && input.evidence) || "").trim();
  if (!payee || !purpose || !PURSE_CATEGORIES.includes(category) || !(cost > 0) || !(expected > 0) || !evidence)
    return refuse("profit_gate_incomplete", "A proposal needs a payee, a purpose, a category (bill, subscription or upgrade), a cost, an expected return, and the measured evidence behind the numbers.");
  if (expected <= cost)
    return refuse("profit_gate_no_profit", "The profit gate: the expected return must beat the cost. This one's numbers don't.");
  if (cost + totals.committedCoins > totals.balanceCoins)
    return refuse("purse_floor", "Never debt: that costs more than the purse holds (after what approved proposals already committed).");
  return { ok: true, authority: cost <= totals.authorityCoins ? "meechie" : "owner" };
}

/* A confirmed site receipt lands in the purse. Idempotent by ref: the
 * callers pass the receipt's own id ("cs:<stripe session>", "claim:<id>")
 * and the log row id is "in:" + ref under insert-or-ignore, so a webhook
 * replay or a verify retry can never credit the same dollar twice. */
export async function creditPurse(env, { coins, cents, source, ref, data } = {}) {
  await ensurePurse(env);
  const c = Math.round(coins || 0), d = Math.round(cents != null ? cents : coins || 0);
  if (!(c > 0) || !ref) return false;
  const r = await env.DB.prepare("insert or ignore into purse_log (id, kind, coins, cents, source, ref, data, at) values (?,?,?,?,?,?,?,?)")
    .bind("in:" + ref, "income", c, d, source || "receipt", ref, data ? JSON.stringify(data) : null, Date.now()).run();
  return !!(r.meta && r.meta.changes);
}

export async function createProposal(env, input, by) {
  await ensurePurse(env);
  const cfg = await purseConfig(env);
  const totals = await purseTotals(env, cfg);
  const g = gateProposal(totals, cfg, input || {});
  if (!g.ok) return g;
  const now = Date.now();
  const p = {
    id: uuid(), status: "pending", authority: g.authority,
    payee: String(input.payee).trim().slice(0, 120), purpose: String(input.purpose).trim().slice(0, 300),
    category: String(input.category).trim(),
    cost_coins: Math.round(+input.costCoins || 0), expected_coins: Math.round(+input.expectedCoins || 0),
    evidence: String(input.evidence).trim().slice(0, 1000),
    created_by: by || null, at: now, decided_at: null, decided_by: null, note: null,
  };
  await env.DB.batch([
    env.DB.prepare("insert into purse_proposals (id, status, authority, payee, purpose, category, cost_coins, expected_coins, evidence, created_by, at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(p.id, p.status, p.authority, p.payee, p.purpose, p.category, p.cost_coins, p.expected_coins, p.evidence, p.created_by, p.at),
    logRow(env, "proposal", p.cost_coins, p.cost_coins, "proposal:" + p.category, p.id, { authority: p.authority, payee: p.payee }, now),
  ]);
  return { ok: true, proposal: p };
}

/* Owner decision on a queued proposal. Approving commits the coins
 * against the usable share (see purseTotals) but executes NOTHING —
 * payment execution is fenced off in this build. The owner is never
 * blocked by the purse rules (a frozen purse can still be decided). */
export async function decideProposal(env, id, decision, by) {
  await ensurePurse(env);
  if (!["approve", "deny"].includes(decision)) return { ok: false, code: "bad_decision", error: "Say approve or deny." };
  const row = await env.DB.prepare("select * from purse_proposals where id = ?").bind(String(id || "")).first();
  if (!row) return { ok: false, code: "not_found", error: "No such proposal." };
  if (row.status !== "pending") return { ok: false, code: "already_decided", error: "That proposal was already " + row.status + "." };
  const now = Date.now();
  const status = decision === "approve" ? "approved" : "denied";
  await env.DB.batch([
    env.DB.prepare("update purse_proposals set status = ?, decided_at = ?, decided_by = ? where id = ? and status = 'pending'").bind(status, now, by || null, row.id),
    logRow(env, "decision", row.cost_coins, row.cost_coins, "decision:" + decision, row.id, { authority: row.authority, payee: row.payee }, now),
  ]);
  return { ok: true, id: row.id, status };
}

export async function setUsablePct(env, pct, by) {
  await ensurePurse(env);
  const n = Math.round(+pct);
  if (!(Number.isInteger(n) && n >= 0 && n <= 100)) return { ok: false, code: "bad_pct", error: "The usable share is a whole percent, 0 to 100." };
  const now = Date.now();
  await env.DB.batch([metaSet(env, "usable_pct", n), logRow(env, "config", 0, 0, "config:usable_pct", null, { usablePct: n, by: by || null }, now)]);
  return { ok: true, usablePct: n };
}

export async function setFrozen(env, frozen, by) {
  await ensurePurse(env);
  const now = Date.now();
  await env.DB.batch([metaSet(env, "frozen", frozen ? "1" : "0"), logRow(env, frozen ? "freeze" : "unfreeze", 0, 0, "config:frozen", null, { frozen: !!frozen, by: by || null }, now)]);
  return { ok: true, frozen: !!frozen };
}

/* Everything the booth purse panel paints, in one read. */
export async function purseView(env) {
  await ensurePurse(env);
  const cfg = await purseConfig(env);
  const totals = await purseTotals(env, cfg);
  const proposals = ((await env.DB.prepare("select * from purse_proposals order by at desc limit 100").all()).results || []);
  const log = ((await env.DB.prepare("select id, kind, coins, cents, source, ref, data, at from purse_log order by at desc limit 60").all()).results || [])
    .map((r) => { let data = null; try { data = r.data ? JSON.parse(r.data) : null; } catch (_) {} return { ...r, data }; });
  return { ok: true, config: cfg, totals, proposals, log };
}
