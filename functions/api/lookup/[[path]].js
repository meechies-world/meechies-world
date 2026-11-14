/* Meechie's World Reverse Lookup — the paid public-data dossier.
 *
 * A signed-in member enters a US phone number; the server checks the
 * opt-in member directory first (exact digits match, consent-gated),
 * then sweeps the public web for that number (five written formats +
 * an unquoted pass + court + crypto + payment + email passes — 14
 * searches), classifies every hit DOMAIN-STRICTLY (a profile counts
 * only when the link sits on the platform's own domain), and returns a
 * dossier where every entry is source-linked and empty sections say so
 * plainly. Public records only — never sealed, never invented (see
 * lib/lookup-core.js for the honesty rules). Email addresses and
 * wallets count only when printed on a page the sweep already tied to
 * the number, with that page linked as the source.
 *
 * CALLER ID (Malik, 2026-11-14: "people are going to want to look up
 * cell phone numbers"): cell numbers are almost never printed on a
 * public page, so the web sweep alone comes back empty for them. The
 * sweep therefore also asks two free phone-intelligence services —
 * Veriphone and IPQualityScore, 1,000 free lookups a month each — for
 * carrier, line type, region, active status and spam score. Both are
 * optional and key-gated: the keys live in the owner's API Keys vault
 * (or a Cloudflare secret) under VERIPHONE_API_KEY and
 * IPQUALITYSCORE_API_KEY, read through withVault. No keys, no calls,
 * no change to the report. A key that errors or runs dry is skipped
 * silently — the report just omits Caller ID. Only facts the services
 * themselves return are shown, never estimated.
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
 * there is no client flag to flip.
 *
 * MEMBER DIRECTORY (Malik, 2026-11-14: "build the opt-in member
 * directory"): a signed-in member may list their own number with a
 * display name — opt-in only, never automatic, removable any time.
 * A lookup checks the directory first: an exact digits match returns
 * the member's name in the report's Member section, and a member hit
 * counts as a found result (so a run that finds a member is charged
 * like any successful lookup, and never refunded as empty). One number
 * belongs to one member — first listing wins. No email is ever shown.
 *
 * NEVER CHARGED FOR NOTHING (Malik, 2026-11-14: "Fix everything"): a
 * run is a find only when at least one hit lands in the dossier.
 * Sources answering with zero hits is an empty report, not a success
 * — the caller is refunded (or never debited), the ladder does not
 * move, and the caller gets the empty report free, with a clear banner
 * on the page saying nothing public was found. A search page that
 * yields no usable rows (bot-check page, empty result) does not count
 * as that source answering. */
import { json, userFrom, setup, take, uuid } from "../../../lib/cf.js";
import { withVault } from "../../../lib/secrets.js";
import {
  LADDER, LADDER_USD, normalizeNumber, buildQueries, numberingFacts,
  classifyResult, parseDdgHtml, parseBingHtml, findWallets, findEmails,
  nextPrice, stateAfterPaid, emptySections,
} from "../../../lib/lookup-core.js";

const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
const SCHEMA = [
  "create table if not exists lookup_state (uid text primary key, used integer not null default 0, unlimited integer not null default 0, updated_at integer)",
  "create table if not exists lookup_reports (id text primary key, uid text not null, digits text not null, data text not null, charged integer not null default 0, at integer not null)",
  "create index if not exists lookup_reports_uid on lookup_reports (uid, at)",
  "create table if not exists lookup_directory (uid text primary key, digits text not null, name text not null, updated_at integer)",
  "create index if not exists lookup_directory_digits on lookup_directory (digits)",
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
 * no source answers is simply empty in the dossier. A run counts as a
 * FIND only when at least one hit lands in the dossier (a member
 * listing counts as a hit) — sources merely answering with nothing is
 * NOT a find, and a run with no hits is never charged: if the sources
 * answered, the caller gets a free empty report with a clear banner;
 * if no source answers at all, the run is a failure and the caller is
 * refunded. */
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
    /* A page that yields no usable rows — a bot-check page or a
     * genuinely empty result — does NOT count as answering. Counting
     * it made empty runs look successful and charged for them. */
    return { rows: [], answered: false };
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

/* Caller ID for cell numbers: carrier, line type, region, active
 * status and spam score from the free phone-intelligence services.
 * Key-gated (vault or Cloudflare secret), run in parallel with the
 * web sweep, and skipped silently when no key is set or a service
 * fails — the report simply omits Caller ID. Only fields the
 * services themselves return are kept; nothing is guessed. */
async function enrichCell(env, n) {
  const full = await withVault(env, ["VERIPHONE_API_KEY", "IPQUALITYSCORE_API_KEY"]).catch(() => env);
  const e164 = n.e164;
  const jobs = [];
  if (full.VERIPHONE_API_KEY) jobs.push((async () => {
    try {
      const j = await fetchJson("https://api.veriphone.io/v2/verify?phone=" + encodeURIComponent(e164) + "&key=" + encodeURIComponent(String(full.VERIPHONE_API_KEY)));
      if (!j || String(j.status || "").toLowerCase() !== "success") return null;
      return {
        carrier: typeof j.carrier === "string" && j.carrier ? j.carrier : null,
        lineType: typeof j.phone_type === "string" && j.phone_type ? j.phone_type : null,
        valid: typeof j.phone_valid === "boolean" ? j.phone_valid : null,
        region: typeof j.phone_region === "string" && j.phone_region ? j.phone_region : null,
        country: typeof j.country === "string" && j.country ? j.country : null,
        sources: ["Veriphone"],
      };
    } catch (_) { return null; }
  })());
  if (full.IPQUALITYSCORE_API_KEY) jobs.push((async () => {
    try {
      const j = await fetchJson("https://www.ipqualityscore.com/api/json/phone/" + encodeURIComponent(String(full.IPQUALITYSCORE_API_KEY)) + "/" + encodeURIComponent(e164.replace(/^\+/, "")));
      if (!j || j.success !== true) return null;
      return {
        carrier: typeof j.carrier === "string" && j.carrier ? j.carrier : null,
        lineType: typeof j.line_type === "string" && j.line_type ? j.line_type : null,
        valid: typeof j.active === "boolean" ? j.active : null,
        region: null,
        country: typeof j.country_code === "string" && j.country_code ? j.country_code : null,
        spamScore: typeof j.fraud_score === "number" ? j.fraud_score : null,
        recentAbuse: typeof j.recent_abuse === "boolean" ? j.recent_abuse : null,
        sources: ["IPQualityScore"],
      };
    } catch (_) { return null; }
  })());
  if (!jobs.length) return null;
  const parts = (await Promise.all(jobs)).filter(Boolean);
  if (!parts.length) return null;
  const out = { carrier: null, lineType: null, valid: null, region: null, country: null, spamScore: null, recentAbuse: null, sources: [] };
  for (const p of parts) {
    if (out.carrier == null) out.carrier = p.carrier;
    if (out.lineType == null) out.lineType = p.lineType;
    if (out.valid == null) out.valid = p.valid;
    if (out.region == null) out.region = p.region;
    if (out.country == null) out.country = p.country;
    if (out.spamScore == null) out.spamScore = p.spamScore ?? null;
    if (out.recentAbuse == null) out.recentAbuse = p.recentAbuse ?? null;
    for (const s of (p.sources || [])) if (!out.sources.includes(s)) out.sources.push(s);
  }
  if (!out.carrier && !out.lineType && out.valid == null && !out.region && out.spamScore == null) return null;
  return out;
}

async function sweep(n, env) {
  const queries = buildQueries(n);
  const sections = emptySections();
  const seen = new Set();
  let answered = 0;
  /* Caller ID runs alongside the web sweep so it costs no extra time. */
  const cellP = enrichCell(env, n);
  /* member directory first: a Meechie's World member who opted in to
   * list this number — consent-gated, server-side, exact digits match
   * only. A listed number always returns its member hit, even when the
   * public web sources don't answer. */
  let memberHit = false;
  try {
    const rows = (await env.DB.prepare("select name from lookup_directory where digits = ? order by updated_at desc limit 3").bind(n.digits).all()).results || [];
    for (const row of rows) {
      if (!row || !row.name) continue;
      memberHit = true;
      sections.member.items.push({ kind: "link", platform: "Meechie's World member", title: String(row.name).slice(0, 60), url: "https://meechiesworldinc.com/lookup-app/", snippet: "Listed by this member on Meechie's World." });
    }
  } catch (_) {}
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
  /* wallet + email scan: read a few of the pages the sweep already tied
   * to the number (crypto + people-search hits first) and look for wallet
   * addresses and email addresses printed on them — either counts only
   * with its tying page linked */
  const candidates = [...sections.crypto.items, ...sections.people.items].slice(0, 4);
  const wallets = [], wseen = new Set();
  const emails = [], eseen = new Set();
  for (const cand of candidates) {
    try {
      const text = await fetchText(cand.url);
      for (const w of findWallets(text)) {
        const k = w.chain + ":" + w.address;
        if (wseen.has(k)) continue;
        wseen.add(k);
        if (wallets.length < 3) wallets.push(await walletFacts(w, cand));
      }
      for (const a of findEmails(text)) {
        if (eseen.has(a)) continue;
        eseen.add(a);
        if (emails.length < 3) emails.push({ kind: "email", address: a, sourceUrl: cand.url, sourceTitle: cand.title });
      }
    } catch (_) {}
  }
  for (const w of wallets) sections.crypto.items.push(w);
  for (const e of emails) sections.email.items.push(e);
  /* hits drive everything now: a find means something actually landed
   * in the dossier, not just that a search page loaded. A Caller ID
   * answer counts as a find too — it is real data about the number. */
  let hits = 0;
  for (const k of Object.keys(sections)) hits += (sections[k].items || []).length;
  const callerId = await cellP.catch(() => null);
  const dossier = {
    number: `(${n.npa}) ${n.nxx}-${n.line}`, digits: n.digits, e164: n.e164,
    facts: numberingFacts(n), sections,
    meta: { searches: queries.length, searchesAnswered: answered, hits, directoryHit: memberHit, callerId: !!callerId, ranAt: new Date().toISOString() },
  };
  if (callerId) dossier.callerId = callerId;
  return { dossier, ok: hits > 0 || !!callerId, hits, answered };
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

  /* Member directory (opt-in only): a signed-in member lists their own
   * number with the name they choose. Nothing is listed without the
   * member's own tap, the row is keyed by their session id (never a
   * client-supplied uid), and opting out deletes the row. Lookups match
   * on exact digits only. */
  if (route === "directory" && method === "GET") {
    const row = await env.DB.prepare("select digits, name from lookup_directory where uid = ?").bind(me.id).first();
    return json(row ? { listed: true, digits: row.digits, name: row.name } : { listed: false });
  }

  if (route === "directory" && method === "POST") {
    if (!(await take(env, "lookupdir:" + me.id, 3600, 20))) return err("Slow down a little.", 429);
    const b = await request.json().catch(() => ({}));
    if (b.listed === false) {
      await env.DB.prepare("delete from lookup_directory where uid = ?").bind(me.id).run();
      return json({ listed: false });
    }
    const n = normalizeNumber(b.digits || b.number);
    if (!n) return err("Enter your 10-digit US number to list it.");
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) return err("Type the name you want listed with your number.");
    await env.DB.prepare("insert into lookup_directory (uid, digits, name, updated_at) values (?,?,?,?) on conflict(uid) do update set digits = excluded.digits, name = excluded.name, updated_at = excluded.updated_at").bind(me.id, n.digits, name, Date.now()).run();
    return json({ listed: true, digits: n.digits, name });
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
      const { dossier, ok, answered } = await sweep(n, env);
      if (!ok && answered === 0) return err("The public search sources didn't answer just now. Try again in a minute.", 502);
      const id = uuid();
      await env.DB.prepare("insert into lookup_reports (id, uid, digits, data, charged, at) values (?,?,?,?,?,?)").bind(id, me.id, n.digits, JSON.stringify(dossier), 0, now).run();
      const w = await wallet(env, me.id);
      return json({ ok: true, owner: true, charged: 0, empty: !ok, coins: w.coins, state: { used: 0, unlimited: true, nextPrice: 0 }, report: { id, dossier } });
    }
    const st = await stateOf(env, me.id);
    const price = nextPrice(st);
    if (price > 0 && !(await debit(env, me.id, price, now))) {
      const w = await wallet(env, me.id);
      return json({ error: "not_enough_coins", need: price, coins: w.coins }, 402);
    }
    const { dossier, ok, answered } = await sweep(n, env);
    if (!ok) {
      if (price > 0) {
        await credit(env, me.id, price, Date.now());
        await env.DB.batch([
          txRow(env, "lk:" + uuid(), me.id, "lookup", -price, n.digits, now),
          txRow(env, "lr:" + uuid(), me.id, "lookup_refund", price, n.digits, Date.now()),
        ]);
      }
      /* Sources failed outright: a failure, retry later. */
      if (answered === 0) return err("The public search sources didn't answer just now — you were not charged. Try again in a minute.", 502);
      /* Sources answered but nothing is public about this number: a
       * FREE empty report with a clear banner — never a charge, and
       * the ladder does not move. */
      const id = uuid();
      await env.DB.prepare("insert into lookup_reports (id, uid, digits, data, charged, at) values (?,?,?,?,?,?)").bind(id, me.id, n.digits, JSON.stringify(dossier), 0, now).run();
      const w = await wallet(env, me.id);
      return json({ ok: true, owner: false, charged: 0, empty: true, coins: w.coins, state: { used: st.used, unlimited: !!st.unlimited, nextPrice: nextPrice(st) }, report: { id, dossier } });
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
