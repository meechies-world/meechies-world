/* Meechie's World Reverse Lookup — the paid public-data dossier.
 *
 * A signed-in member enters a US phone number; the server sweeps the
 * public web for that number (five written formats + court + crypto +
 * payment passes — 11 searches), classifies every hit DOMAIN-STRICTLY
 * (a profile counts only when the link sits on the platform's own
 * domain), and returns a dossier where every entry is source-linked and
 * empty sections say so plainly. Public records only — never sealed,
 * never invented (see lib/lookup-core.js for the honesty rules).
 *
 * Money rides the site's EXISTING coin rails, exactly like gifts and the
 * DJ tiers: the same wallets + coin_tx tables functions/api/coins writes,
 * the same atomic debit statement, the same 402 not_enough_coins answer
 * (the page then offers the existing Stripe coin packs through
 * /api/coins/checkout). 1 coin = 1 cent, so Malik's ladder lands exact:
 * first lookup 199, second 500, then unlimited for 1000 — after that,
 * lookups are included. Entitlement (paid count + unlimited flag) lives
 * server-side in lookup_state; the client is never trusted for it.
 *
 * OWNER FREE (Malik, 2026-11-13: "Make it so I can use it for free"):
 * when the signed-in id IS the owner id — the same OWNER_ID constant the
 * coins function defines — the lookup runs with zero coin deduction:
 * no wallet write, no coin_tx row, and the ladder state is never even
 * read or written. The check is server-side on the session's user id;
 * there is no client flag to flip. */
import { json, userFrom, setup, take, uuid } from "../../../lib/cf.js";
import {
  LADDER, LADDER_USD, normalizeNumber, buildQueries, numberingFacts,
  classifyResult, parseDdgHtml, parseBingHtml, findWallets,
  nextPrice, stateAfterPaid, emptySections,
} from "../../../lib/lookup-core.js";

const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
const SCHEMA = [
  "create table if not exists lookup_state (uid text primary key, used integer not null default 0, unlimited integer not null default 0, updated_at integer)",
  "create table if not exists lookup_reports (id text primary key, uid text not null, digits text not null, data text not null, charged integer not null default 0, at integer not null)",
  "create index if not exists lookup_reports_uid on lookup_reports (uid, at)",
];
let ready = null;
const ensure = (env) => (ready = ready || env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; }));
const err = (m, s = 400) => json({ error: m }, s);

/* the coin wallet, read and debited with the coins function's own
 * statements — one atomic update, so two taps can't spend the same
 * coins twice */
const wallet = async (env, uid) => (await env.DB.prepare("select coins, earned_cents, paid_cents from wallets where uid = ?").bind(uid).first()) || { coins: 0, earned_cents: 0, paid_cents: 0 };
const debit = async (env, uid, amount, now) => (await env.DB.prepare("update wallets set coins = coins - ?, updated_at = ? where uid = ? and coins >= ?").bind(amount, now, uid, amount).run()).meta.changes > 0;
const credit = (env, uid, amount, now) => env.DB.prepare("insert into wallets (uid, coins, updated_at) values (?,?,?) on conflict(uid) do update set coins = coins + excluded.coins, updated_at = excluded.updated_at").bind(uid, amount, now).run();
const txRow = (env, id, uid, kind, coins, other, at) => env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind(id, uid, kind, coins, 0, other, at);
const stateOf = async (env, uid) => (await env.DB.prepare("select used, unlimited from lookup_state where uid = ?").bind(uid).first()) || { used: 0, unlimited: 0 };

/* ---------------- the sweep (server-side, keyless) ----------------
 * Each query goes to DuckDuckGo's public HTML endpoint first; if that
 * answers with nothing usable, Bing's results page is tried. A pass that
 * no source answers is simply empty in the dossier — and if NO pass
 * answers at all, the run is a failure and the caller is refunded. */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
async function fetchText(u, ms = 6000) {
  const c = new AbortController(); const t = setTimeout(() => { try { c.abort(); } catch (_) {} }, ms);
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, signal: c.signal });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
async function fetchJson(u, ms = 6000) {
  const t = await fetchText(u, ms);
  return JSON.parse(t);
}
async function searchOne(query) {
  try {
    const html = await fetchText("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query));
    const rows = parseDdgHtml(html);
    if (rows.length) return { rows, answered: true };
  } catch (_) {}
  try {
    const html = await fetchText("https://www.bing.com/search?q=" + encodeURIComponent(query));
    const rows = parseBingHtml(html);
    if (rows.length) return { rows, answered: true };
    return { rows: [], answered: true };
  } catch (_) {}
  return { rows: [], answered: false };
}

/* Public on-chain facts for a wallet a public page tied to the number —
 * keyless public explorers only, and only the facts the explorer itself
 * returns (a fact it doesn't give stays null, never estimated). */
async function walletFacts(w, source) {
  const out = { kind: "wallet", chain: w.chain, address: w.address, sourceUrl: source.url, sourceTitle: source.title, balance: null, txCount: null, lastActivity: null, firstActivity: null, explorerUrl: null };
  try {
    if (w.chain === "BTC") {
      out.explorerUrl = "https://blockstream.info/address/" + w.address;
      const a = await fetchJson("https://blockstream.info/api/address/" + w.address);
      const cs = a && a.chain_stats;
      if (cs) {
        out.balance = ((cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0)) / 1e8 + " BTC";
        out.txCount = cs.tx_count;
        const txs = await fetchJson("https://blockstream.info/api/address/" + w.address + "/txs");
        if (Array.isArray(txs) && txs.length) {
          const times = txs.map((x) => x && x.status && x.status.block_time).filter(Boolean).sort((x, y) => x - y);
          if (times.length) {
            out.lastActivity = new Date(times[times.length - 1] * 1000).toISOString();
            if (cs.tx_count <= txs.length) out.firstActivity = new Date(times[0] * 1000).toISOString();
          }
        }
      }
    } else {
      out.explorerUrl = "https://etherscan.io/address/" + w.address;
      const a = await fetchJson("https://eth.blockscout.com/api/v2/addresses/" + w.address);
      if (a && a.coin_balance != null) {
        const wei = BigInt(String(a.coin_balance));
        out.balance = (Number(wei / 100000000000000n) / 1e4).toFixed(4) + " ETH";
      }
      const txs = await fetchJson("https://eth.blockscout.com/api/v2/addresses/" + w.address + "/transactions?page_size=1");
      const item = txs && Array.isArray(txs.items) && txs.items[0];
      if (item && item.timestamp) out.lastActivity = item.timestamp;
    }
  } catch (_) {}
  return out;
}

async function sweep(n) {
  const queries = buildQueries(n);
  const sections = emptySections();
  const seen = new Set();
  let answered = 0;
  for (let i = 0; i < queries.length; i += 4) {
    const wave = await Promise.all(queries.slice(i, i + 4).map((q) => searchOne(q.query)));
    for (const r of wave) {
      if (r.answered) answered++;
      for (const row of r.rows) {
        if (seen.has(row.url)) continue;
        seen.add(row.url);
        const c = classifyResult(row.url);
        const sec = sections[c.section];
        if (sec.items.length >= 10) continue;
        sec.items.push({ kind: "link", platform: c.platform, title: row.title, url: row.url, snippet: row.snippet || "" });
      }
    }
  }
  /* wallet scan: read a few of the pages the sweep already tied to the
   * number (crypto + people-search hits first) and look for addresses
   * printed on them — a wallet counts only with its tying page linked */
  const candidates = [...sections.crypto.items, ...sections.people.items].slice(0, 4);
  const wallets = [], wseen = new Set();
  for (const cand of candidates) {
    try {
      const text = await fetchText(cand.url);
      for (const w of findWallets(text)) {
        const k = w.chain + ":" + w.address;
        if (wseen.has(k)) continue;
        wseen.add(k);
        if (wallets.length < 3) wallets.push(await walletFacts(w, cand));
      }
    } catch (_) {}
  }
  for (const w of wallets) sections.crypto.items.push(w);
  const dossier = {
    number: `(${n.npa}) ${n.nxx}-${n.line}`, digits: n.digits, e164: n.e164,
    facts: numberingFacts(n), sections,
    meta: { searches: queries.length, searchesAnswered: answered, ranAt: new Date().toISOString() },
  };
  return { dossier, ok: answered > 0 };
}

export async function onRequest({ request, env, params }) {
  if (!env.DB) return err("Database not connected.", 503);
  await setup(env); await ensure(env);
  const parts = Array.isArray(params.path) ? params.path : [params.path || ""];
  const route = parts.join("/"), method = request.method;

  // public: what a lookup costs (coin packs themselves live in /api/coins)
  if (route === "info") return json({ ladder: LADDER.map((coins, i) => ({ coins, usd: LADDER_USD[i] })), unlimitedAfter: LADDER.length });

  const me = await userFrom(request, env);
  if (!me) return err("Sign in first.", 401);
  const owner = me.id === OWNER_ID;

  if (route === "me" && method === "GET") {
    const w = await wallet(env, me.id);
    if (owner) return json({ owner: true, coins: w.coins, used: 0, unlimited: true, nextPrice: 0, nextUsd: "Free for you" });
    const st = await stateOf(env, me.id);
    const price = nextPrice(st);
    return json({ owner: false, coins: w.coins, used: st.used, unlimited: !!st.unlimited, nextPrice: price, nextUsd: price ? LADDER_USD[st.used] : "Included — unlimited" });
  }

  if (route === "run" && method === "POST") {
    if (!(await take(env, "lookup:" + me.id, 3600, 20))) return err("Slow down a little — that's a lot of lookups for one hour.", 429);
    const b = await request.json().catch(() => ({}));
    const n = normalizeNumber(b.number);
    if (!n) return err("That doesn't look like a US phone number. Enter the 10 digits.");
    const now = Date.now();
    /* OWNER BYPASS: before any state or wallet touch. No debit, no
     * coin_tx, no lookup_state read or write — the ladder never moves. */
    if (owner) {
      const { dossier, ok } = await sweep(n);
      if (!ok) return err("The public search sources didn't answer just now. Try again in a minute.", 502);
      const id = uuid();
      await env.DB.prepare("insert into lookup_reports (id, uid, digits, data, charged, at) values (?,?,?,?,?,?)").bind(id, me.id, n.digits, JSON.stringify(dossier), 0, now).run();
      const w = await wallet(env, me.id);
      return json({ ok: true, owner: true, charged: 0, coins: w.coins, state: { used: 0, unlimited: true, nextPrice: 0 }, report: { id, dossier } });
    }
    const st = await stateOf(env, me.id);
    const price = nextPrice(st);
    if (price > 0 && !(await debit(env, me.id, price, now))) {
      const w = await wallet(env, me.id);
      return json({ error: "not_enough_coins", need: price, coins: w.coins }, 402);
    }
    const { dossier, ok } = await sweep(n);
    if (!ok) {
      if (price > 0) {
        await credit(env, me.id, price, Date.now());
        await env.DB.batch([
          txRow(env, "lk:" + uuid(), me.id, "lookup", -price, n.digits, now),
          txRow(env, "lr:" + uuid(), me.id, "lookup_refund", price, n.digits, Date.now()),
        ]);
      }
      return err("The public search sources didn't answer just now — you were not charged. Try again in a minute.", 502);
    }
    const id = uuid();
    const stmts = [env.DB.prepare("insert into lookup_reports (id, uid, digits, data, charged, at) values (?,?,?,?,?,?)").bind(id, me.id, n.digits, JSON.stringify(dossier), price, now)];
    if (price > 0) {
      const after = stateAfterPaid(st, price);
      stmts.push(txRow(env, "lk:" + uuid(), me.id, "lookup", -price, n.digits, now));
      stmts.push(env.DB.prepare("insert into lookup_state (uid, used, unlimited, updated_at) values (?,?,?,?) on conflict(uid) do update set used = excluded.used, unlimited = excluded.unlimited, updated_at = excluded.updated_at").bind(me.id, after.used, after.unlimited, now));
    }
    await env.DB.batch(stmts);
    const w = await wallet(env, me.id);
    const stNow = await stateOf(env, me.id);
    return json({ ok: true, owner: false, charged: price, coins: w.coins, state: { used: stNow.used, unlimited: !!stNow.unlimited, nextPrice: nextPrice(stNow) }, report: { id, dossier } });
  }

  if (route === "history" && method === "GET") {
    const rows = (await env.DB.prepare("select id, digits, charged, at from lookup_reports where uid = ? order by at desc limit 20").bind(me.id).all()).results || [];
    return json({ reports: rows });
  }

  if (route === "report" && method === "GET") {
    const id = new URL(request.url).searchParams.get("id") || "";
    const row = await env.DB.prepare("select id, digits, data, charged, at from lookup_reports where id = ? and uid = ?").bind(id, me.id).first();
    if (!row) return err("That report isn't in your history.", 404);
    let dossier = null; try { dossier = JSON.parse(row.data); } catch (_) {}
    return json({ id: row.id, digits: row.digits, charged: row.charged, at: row.at, dossier });
  }

  return err("Not found", 404);
}
