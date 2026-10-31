/* SoundCloud search proxy (owner, 2026-10-31: "i want to use soundcloud
 * to play my music as well make it so i can serch soundcloud").
 *
 * The booth's SoundCloud tab searches through here so the web-player
 * client_id never ships to a browser. That id is not an account
 * credential — it is the public id embedded in SoundCloud's own web
 * player for anonymous catalog reads — but it rotates, so this endpoint
 * extracts it from the JS bundles soundcloud.com currently serves,
 * caches it in the brain/sccid doc, and re-extracts ONCE when the API
 * answers 401/403 (a stale cached id), never in a loop.
 *
 * Results are filtered to tracks an outside player can actually play in
 * full: public tracks, access "playable", never snippet-only (policy
 * SNIP) and never streamable=false — a 30-second preview or a blocked
 * track must never reach a deck or the keeper. Playback itself is
 * keyless through the official SoundCloud Widget API in dj.js; this
 * endpoint is search only. Zero spend, no SoundCloud account. */
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CID_DOC = "brain/sccid", CID_TTL = 6 * 3600 * 1000, PAGE_N = 20;
let cidMem = "", cidMemAt = 0;

async function readCidDoc(env) {
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind(CID_DOC).first();
    if (!row) return null;
    const d = JSON.parse(row.data);
    return d && d.id ? d : null;
  } catch (_) { return null; }
}
async function writeCidDoc(env, id) {
  try {
    const nowIso = new Date().toISOString(), data = JSON.stringify({ id: id, at: Date.now() });
    const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, CID_DOC).run();
    if (!r.meta || !r.meta.changes) await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(CID_DOC, "brain", null, data, nowIso, nowIso).run();
    await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", CID_DOC, "brain", null, null, Date.now()).run();
  } catch (_) {}
}

async function fetchText(u) {
  const c = new AbortController(); const t = setTimeout(() => { try { c.abort(); } catch (_) {} }, 6000);
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, signal: c.signal });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

/* The homepage's sndcdn asset URLs, in document order. */
export function extractBundleUrls(html) {
  const out = [], re = /https:\/\/a-v2\.sndcdn\.com\/assets\/[A-Za-z0-9._~\/-]+\.js/g;
  let m; const s = String(html || "");
  while ((m = re.exec(s))) { if (!out.includes(m[0])) out.push(m[0]); }
  return out;
}
/* The classic literal in the app bundles: client_id:"<32 chars>". */
export function extractClientId(text) {
  const s = String(text || "");
  const m = s.match(/client_id\s*:\s*"([A-Za-z0-9]{32})"/) || s.match(/client_id=([A-Za-z0-9]{32})/);
  return m ? m[1] : "";
}

async function extractFreshCid() {
  const html = await fetchText("https://soundcloud.com/");
  const direct = extractClientId(html);
  if (direct) return direct;
  const urls = extractBundleUrls(html);
  /* the id lives in the big app bundles, which the page loads last —
   * scan from the end and stop at the first hit */
  for (let i = urls.length - 1, n = 0; i >= 0 && n < 12; i--, n++) {
    try { const id = extractClientId(await fetchText(urls[i])); if (id) return id; } catch (_) {}
  }
  return "";
}

async function getCid(env, force) {
  const now = Date.now();
  if (!force && cidMem && now - cidMemAt < CID_TTL) return cidMem;
  if (!force && env && env.DB) {
    const d = await readCidDoc(env);
    if (d && now - (+d.at || 0) < CID_TTL) { cidMem = String(d.id); cidMemAt = +d.at || now; return cidMem; }
  }
  let id = "";
  try { id = await extractFreshCid(); } catch (_) {}
  if (id) { cidMem = id; cidMemAt = now; if (env && env.DB) writeCidDoc(env, id); }
  return id;
}

/* Shape one raw api-v2 search page into the booth's trimmed results:
 * full-play public tracks only, duration in seconds, artwork upgraded
 * from the 100px "-large" cut to the 500px cut. */
export function shapeResults(j) {
  const col = (j && Array.isArray(j.collection)) ? j.collection : [];
  const out = [];
  for (const t of col) {
    if (!t || t.kind !== "track") continue;
    if (t.public === false) continue;
    if (t.access && t.access !== "playable") continue;
    if (t.policy === "SNIP") continue;
    if (t.streamable === false) continue;
    if (!t.id || !t.permalink_url) continue;
    const art = String(t.artwork_url || (t.user && t.user.avatar_url) || "").replace("-large", "-t500x500");
    out.push({ id: t.id, title: String(t.title || "SoundCloud track").slice(0, 140), artist: String((t.user && t.user.username) || "").slice(0, 80), dur: Math.round((+t.duration || 0) / 1000), art: art, url: String(t.permalink_url) });
    if (out.length >= PAGE_N) break;
  }
  return out;
}

async function scApi(q, page, cid) {
  const off = Math.max(0, ((+page || 1) - 1) * PAGE_N);
  const u = "https://api-v2.soundcloud.com/search/tracks?q=" + encodeURIComponent(q) + "&client_id=" + encodeURIComponent(cid) + "&limit=" + PAGE_N + "&offset=" + off + "&linked_partitioning=1&app_locale=en";
  const c = new AbortController(); const t = setTimeout(() => { try { c.abort(); } catch (_) {} }, 6000);
  try { return await fetch(u, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: c.signal }); }
  finally { clearTimeout(t); }
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    const page = Math.max(1, Math.min(5, parseInt(url.searchParams.get("page") || "1", 10) || 1));
    if (!q) return json({ ok: false, error: "empty_query" });
    let cid = await getCid(env, false);
    if (!cid) return json({ ok: false, error: "no_client_id" });
    let r = await scApi(q, page, cid);
    if (r.status === 401 || r.status === 403) {
      /* the cached id rotated: re-extract once and retry, never loop */
      cid = await getCid(env, true);
      if (!cid) return json({ ok: false, error: "no_client_id" });
      r = await scApi(q, page, cid);
    }
    if (!r.ok) return json({ ok: false, error: "sc_http_" + r.status });
    const j = await r.json().catch(() => null);
    return json({ ok: true, q: q, page: page, results: shapeResults(j) });
  } catch (e) { return json({ ok: false, error: "search_failed" }); }
}
