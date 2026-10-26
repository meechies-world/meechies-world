/* Meechie's World Radio — the 24/7 station keeper.
 *
 * The DJ booth (js/dj.js) owns the tables while it is open: every booth save stamps
 * S.boothAt, and this keeper stands down while that stamp is fresh, so Malik can take
 * control of the decks at any moment just by opening the booth. The moment the booth
 * closes, the keeper runs the Auto-DJ rotation itself — writing the exact same
 * radio/dj state the booth writes — so the tables stay live around the clock and
 * anyone who tunes in lands mid-song, like real radio.
 *
 * GET /api/station — called by listener clients every few seconds. Advances the
 * rotation when a track reaches its crossfade point, fast-forwarding through any
 * gap where nobody was listening. Writes are rare: only on an advance, or a light
 * updatedAt touch so clients keep reading the station as live. */
import { userFrom } from "../../lib/cf.js";

const XF = 3.5; // crossfade seconds, same as the booth
const BOOTH_FRESH = 90000; // booth heartbeat window — while it's fresh the TABLES own the radio, the keeper never touches a deck
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function readDoc(env, path) {
  const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (_) { return null; }
}
async function writeDoc(env, path, coll, data) {
  const nowIso = new Date().toISOString();
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(JSON.stringify(data), nowIso, path).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, coll, null, JSON.stringify(data), nowIso, nowIso).run();
  }
  // clients learn about doc changes from the changes feed — without this row the
  // new state would sit in the table unseen
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", path, coll, null, null, Date.now()).run();
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const now = Date.now();
  const origin = new URL(request.url).origin;
  // presence: every client pings this endpoint every ~12s, so a small ping table
  // doubles as the site's online count — counts only, no identities are stored
  const counts = { online: 0, listening: 0 };
  try {
    const u = new URL(request.url);
    const cid = (u.searchParams.get("cid") || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    const lis = u.searchParams.get("l") === "1" ? 1 : 0;
    const pu = (u.searchParams.get("u") || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    const pn = (u.searchParams.get("n") || "").slice(0, 40);
    await env.DB.prepare("create table if not exists pings (cid text primary key, at integer, listening integer)").run();
    try { await env.DB.prepare("alter table pings add column uid text").run(); } catch (_) {}
    try { await env.DB.prepare("alter table pings add column name text").run(); } catch (_) {}
    if (cid) await env.DB.prepare("insert into pings (cid, at, listening, uid, name) values (?,?,?,?,?) on conflict(cid) do update set at = excluded.at, listening = excluded.listening, uid = coalesce(excluded.uid, pings.uid), name = coalesce(excluded.name, pings.name)").bind(cid, now, lis, pu || null, pn || null).run();
    await env.DB.prepare("delete from pings where at < ?").bind(now - 45000).run();
    const row = await env.DB.prepare("select count(*) as n, coalesce(sum(listening), 0) as l from pings where at > ?").bind(now - 35000).first();
    if (row) { counts.online = row.n || 0; counts.listening = row.l || 0; }
    // who's online: signed-in members identify themselves on the ping, so every
    // counter on the site (header chip, Book strip, booth) reads this ONE list
    counts.users = [];
    try { const ur = await env.DB.prepare("select uid, name, max(at) as at from pings where at > ? and uid is not null and uid != '' group by uid order by at desc limit 60").bind(now - 35000).all(); counts.users = (ur.results || []).map((r) => ({ uid: r.uid, name: r.name || "" })); } catch (_) {}
  } catch (_) {}
  let S = await readDoc(env, "radio/dj");
  if (!S) return json({ ok: true, mode: "empty", online: counts.online, listening: counts.listening, users: counts.users });
  S.A = Object.assign({ src: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1 }, S.A || {});
  S.B = Object.assign({ src: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1 }, S.B || {});

  // The booth has the tables — hands off.
  if (S.boothAt && now - S.boothAt < BOOTH_FRESH) return json({ ok: true, mode: "booth", online: counts.online, listening: counts.listening, users: counts.users });
  // Auto-DJ off is Malik's setting: the keeper stays out and the playlist rules.
  if (!S.autodj) {
    if (S.live && now - (S.updatedAt || 0) > 180000) { S.live = false; S.updatedAt = now; await writeDoc(env, "radio/dj", "radio", S); }
    return json({ ok: true, mode: "playlist", online: counts.online, listening: counts.listening, users: counts.users });
  }

  const { results } = await env.DB.prepare("select data from docs where coll = 'tracks'").all();
  const lib = (results || []).map((r) => { try { return JSON.parse(r.data); } catch (_) { return null; } })
    .filter((t) => t && t.assetId && +t.duration > 3 && !String(t.assetId).includes("supabase"));
  if (!lib.length) return json({ ok: true, mode: "empty-lib", online: counts.online, listening: counts.listening, users: counts.users });
  const byAsset = new Map(lib.map((t) => [t.assetId, t]));
  const durOf = (deck) => { if (+deck.dur > 0) return +deck.dur; const t = lib.find((x) => deck.src && deck.src.includes(x.assetId)); return t ? +t.duration : 0; };
  const srcOf = (t) => origin + "/m/assets/" + t.assetId;

  const bagPick = (avoidSrc) => {
    if (!Array.isArray(S.bag) || !S.bag.length) {
      S.bag = lib.map((t) => t.assetId);
      for (let i = S.bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [S.bag[i], S.bag[j]] = [S.bag[j], S.bag[i]]; }
    }
    let id = S.bag.pop();
    if (avoidSrc && id && avoidSrc.includes(id) && S.bag.length) { const other = S.bag.pop(); S.bag.push(id); id = other; }
    return byAsset.get(id) || lib[0];
  };
  const startDeckItem = (k, item, startMs) => {
    S[k] = { src: item.src, title: item.title || "", cover: item.cover || "", start: startMs, pos: 0, playing: true, vol: S[k].vol ?? 0.9, rate: 1, dur: item.dur || 0 };
    S.log = [{ t: item.title || "", at: now, live: true }].concat((S.log || []).filter((x) => x.t !== item.title)).slice(0, 30);
  };
  const startDeck = (k, t, startMs) => startDeckItem(k, { src: srcOf(t), title: t.title || "", cover: t.cover || "", dur: +t.duration || 0 }, startMs);
  /* listener picks (docs in the requests collection, kind:"pick") jump the queue:
     they play next, ahead of the library rotation. A pick is consumed (deleted)
     whether or not its file resolves, so a dead pick can never jam the station. */
  const takePick = async () => {
    let rows = [];
    try { rows = (await env.DB.prepare("select path, data from docs where coll = 'requests'").all()).results || []; } catch (_) { return null; }
    const picks = [];
    for (const r of rows) { try { const d = JSON.parse(r.data); if (d && d.kind === "pick" && !d.played) picks.push({ path: r.path, d }); } catch (_) {} }
    picks.sort((a, b) => (a.d.at || 0) - (b.d.at || 0));
    for (const p of picks) {
      let src = p.d.src || "", iaDur = 0;
      if (src && src.includes("supabase.co")) src = "";
      if (!src && p.d.iaId) {
        try { const mj = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(p.d.iaId))).json(); const f = (mj.files || []).find((x) => /mp3/i.test(x.format || "") && /\.mp3$/i.test(x.name)) || (mj.files || []).find((x) => /\.(mp3|ogg|m4a)$/i.test(x.name)); if (f) { src = "https://archive.org/download/" + encodeURIComponent(p.d.iaId) + "/" + f.name.split("/").map(encodeURIComponent).join("/"); iaDur = +f.length || 0; } } catch (_) {}
      }
      try { await env.DB.prepare("delete from docs where path = ?").bind(p.path).run(); await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", p.path, "requests", null, null, Date.now()).run(); } catch (_) {}
      if (src) return { src, title: p.d.title || "", cover: p.d.cover || "", dur: iaDur || (+p.d.dur || 0) };
    }
    return null;
  };
  /* the mixed rotation: like a real station, the Auto-DJ alternates Meechie's own
     tracks with real-artist music from the Internet Archive pool (free/CC). The
     pool lives in the station doc and refills itself when it runs dry. */
  const POOL_QUERIES = ['creator:"Johnny Cash"', 'creator:"Miles Davis"', 'creator:"Grateful Dead"', 'creator:"James Brown"', 'creator:"Bob Marley"', 'creator:"Duke Ellington"', 'creator:"John Coltrane"', '"hip hop" mixtape', '"soul" "live"', '"rock" "live" concert', '"reggae" "live"', '"jazz" "live"'];
  async function buildPool() {
    const out = [], seen = new Set();
    for (const q of POOL_QUERIES) {
      try {
        const u = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent("(" + q + ") AND mediatype:audio AND licenseurl:*creativecommons*") + "&fl[]=identifier&fl[]=title&fl[]=creator&sort[]=downloads+desc&rows=12&output=json";
        const j = await (await fetch(u)).json();
        for (const d of (j.response?.docs || [])) { const id = String(d.identifier); if (seen.has(id)) continue; seen.add(id); out.push({ iaId: id, title: [].concat(d.title || id)[0] + (d.creator ? " · " + [].concat(d.creator)[0] : ""), cover: "https://archive.org/services/img/" + encodeURIComponent(id) }); }
      } catch (_) {}
    }
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out.slice(0, 80);
  }
  async function poolItem() {
    if (!Array.isArray(S.pool) || !S.pool.length || (S.poolAt && now - S.poolAt > 24 * 3600e3)) { S.pool = await buildPool(); S.poolAt = now; }
    while (S.pool && S.pool.length) {
      const p = S.pool.pop();
      try { const mj = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(p.iaId))).json(); const f = (mj.files || []).find((x) => /mp3/i.test(x.format || "") && /\.mp3$/i.test(x.name)) || (mj.files || []).find((x) => /\.(mp3|ogg|m4a)$/i.test(x.name)); if (f) return { src: "https://archive.org/download/" + encodeURIComponent(p.iaId) + "/" + f.name.split("/").map(encodeURIComponent).join("/"), title: p.title || "", cover: p.cover || "", dur: +f.length || 0 }; } catch (_) {}
    }
    return null;
  }
  const nextItem = async (avoidSrc) => {
    const pk = await takePick();
    if (pk) return pk;
    S.mixAlt = !S.mixAlt; // alternate: one of Meechie's, one from the world
    if (S.mixAlt) { const pi = await poolItem(); if (pi) return pi; }
    const t = bagPick(avoidSrc);
    return { src: srcOf(t), title: t.title || "", cover: t.cover || "", dur: +t.duration || 0 };
  };

  // A deliberate pause by the DJ is not dead air: the booth stamps S.pausedAt
  // when Malik pauses with nothing else playing, and the keeper respects it for
  // up to 30 minutes instead of restarting deck A over him. (A track that ends
  // naturally never sets the stamp, so the rotation still never goes quiet.)
  if (S.pausedAt && now - S.pausedAt < 30 * 60e3 && !S.A.playing && !S.B.playing) {
    if (now - (S.updatedAt || 0) > 20000) { S.updatedAt = now; await writeDoc(env, "radio/dj", "radio", S); }
    return json({ ok: true, mode: "paused", online: counts.online, listening: counts.listening, users: counts.users });
  }
  if (S.pausedAt && (S.A.playing || S.B.playing)) S.pausedAt = 0;

  let changed = false;
  let cur = S.A.playing ? "A" : S.B.playing ? "B" : null;
  if (!cur) { // dead air — start the rotation on deck A right now
    startDeckItem("A", await nextItem(""), now); S.xf = 0; changed = true; cur = "A";
  }
  for (let i = 0; i < 60; i++) {
    const other = cur === "A" ? "B" : "A";
    const dur = durOf(S[cur]) || 240;
    const endAt = (S[cur].start || now) + dur * 1000;
    if (now >= endAt) { // song fully over: stop it; the other deck (already started at the fade) takes the wheel
      if (S[cur].playing) { S[cur].playing = false; S[cur].pos = 0; changed = true; }
      if (S[other].playing) { cur = other; continue; }
      startDeckItem(other, await nextItem(S[cur].src), endAt); S.xf = other === "A" ? 0 : 1; changed = true; cur = other; continue;
    }
    if (now >= endAt - XF * 1000 && !S[other].playing) { // crossfade point: bring the next song in under this one
      startDeckItem(other, await nextItem(S[cur].src), endAt - XF * 1000);
      S.xf = other === "A" ? 0 : 1; changed = true;
    }
    break;
  }
  // station clock: about once an hour the unattended station IDs itself with
  // the first sound-board pad, the way a real station does at the top of the hour
  const pad0 = (S.pads || [])[0];
  if (pad0 && pad0.url && now - (S.clockAt || 0) > 50 * 60e3) { S.voice = { id: pad0.id || "", url: pad0.url, at: now }; S.clockAt = now; changed = true; }
  if (!S.live) { S.live = true; S.liveSince = now; changed = true; }
  // Unattended rule: while no booth is at the tables, the 24/7 station rests on the
  // clean broadcast profile. Performance FX a DJ left cranked (bitcrush grit, the
  // transformer chop, heavy flanger/reverb, a slammed boost) are for a live set —
  // left on the unattended rotation they just read as static and wash, and they
  // made the station sound like it kept "switching off" Pro Radio. The moment
  // Malik opens the booth (boothAt fresh, above) his settings rule again.
  if (S.fx) {
    const fx = S.fx;
    if ((+fx.crush || 0) !== 0) { fx.crush = 0; changed = true; }
    if ((+fx.gate || 0) !== 0) { fx.gate = 0; changed = true; }
    if ((+fx.fla || 0) > 0.25) { fx.fla = 0.25; changed = true; }
    if ((+fx.verb || 0) > 0.3) { fx.verb = 0.3; changed = true; }
    if ((+fx.pha || 0) > 0.3) { fx.pha = 0.3; changed = true; }
    if ((+fx.noise || 0) > 0.5) { fx.noise = 0.5; changed = true; }
    if ((+fx.boost || 1) > 1.3) { fx.boost = 1.3; changed = true; }
  }
  if (now - (S.updatedAt || 0) > 20000) { S.updatedAt = now; changed = true; }
  if (changed) await writeDoc(env, "radio/dj", "radio", S);
  return json({ ok: true, mode: "autodj", changed, online: counts.online, listening: counts.listening, users: counts.users });
}

/* Guest song requests: the picker in js/dj.js first tries the member write; when
 * that is refused (a visitor who is not signed in), it posts the pick here instead.
 * The pick lands as a normal requests doc that the booth and this keeper already
 * know how to play. Only picks with a resolved, trusted src and short text
 * requests are accepted, rate-limited per visitor. */
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  let b = null; try { b = await request.json(); } catch (_) {}
  if (!b) return json({ ok: false, error: "bad_body" }, 400);
  /* guest DJ relay: a member Malik approved (S.djGuest in the station doc, set only
     by his own booth) performs on their sandboxed table and posts the performance
     here. The gate is strict: a live session, a grant naming that exact member,
     unexpired — and only performance fields are merged, each one sanitized, so a
     guest can never touch the station's own settings, log, show or grant. The
     write stamps boothAt, so the keeper treats a guest set exactly like Malik's
     own booth and keeps its hands off; Malik opening his booth overrides at once. */
  if (b.kind === "guestdj") {
    const user = await userFrom(request, env).catch(() => null);
    if (!user) return json({ ok: false, error: "no_session" }, 401);
    const S = await readDoc(env, "radio/dj");
    const g = S && S.djGuest;
    if (!S || !g || g.uid !== user.id || !(g.until > Date.now())) return json({ ok: false, error: "no_grant" }, 403);
    if (g.lastWrite && Date.now() - g.lastWrite < 1500) return json({ ok: true, skipped: true });
    const num = (v, lo, hi, dft) => { v = +v; return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dft; };
    const deck = (p) => { p = p || {}; const src = String(p.src || "").slice(0, 500); const yt = /^[A-Za-z0-9_-]{6,20}$/.test(p.yt || "") ? p.yt : ""; return { src: (src.startsWith("https://") || src.startsWith("/m/")) ? src : "", yt, title: String(p.title || "").slice(0, 120), cover: String(p.cover || "").slice(0, 300), start: num(p.start, 0, Date.now() + 60000, 0), pos: num(p.pos, 0, 7200, 0), playing: !!p.playing, vol: num(p.vol, 0, 1, 0.9), rate: num(p.rate, 0.5, 2, 1), dur: num(p.dur, 0, 7200, 0), eq: [0, 1, 2].map((i) => num((p.eq || [])[i], -15, 15, 0)), flt: num(p.flt, 0, 1, 1), bpm: num(p.bpm, 0, 300, 0), beat0: num(p.beat0, 0, 7200, 0), key: String(p.key || "").slice(0, 8), cam: String(p.cam || "").slice(0, 8), vcut: !!p.vcut, bcut: !!p.bcut, cues: [0, 1, 2].map((i) => num((p.cues || [])[i], 0, 7200, 0)), loop: (p.loop && typeof p.loop === "object") ? { a: num(p.loop.a, 0, 7200, 0), b: num(p.loop.b, 0, 7200, 0) } : null, loopBeats: num(p.loopBeats, 0, 64, 0) }; };
    S.A = deck(b.A); S.B = deck(b.B); S.C = deck(b.C); S.D = deck(b.D);
    S.xf = num(b.xf, 0, 1, S.xf ?? 0.5); S.xf2 = num(b.xf2, 0, 1, S.xf2 ?? 0.5); S.panY = num(b.panY, -1, 1, S.panY ?? 0);
    const fxIn = b.fx || {};
    S.fx = Object.assign({}, S.fx, { mf: num(fxIn.mf, 0, 100, 100), echo: num(fxIn.echo, 0, 0.6, 0), fb: num(fxIn.fb, 0, 0.6, 0.3), verb: num(fxIn.verb, 0, 0.3, 0.1), fla: num(fxIn.fla, 0, 0.25, 0), pha: num(fxIn.pha, 0, 0.3, 0), noise: num(fxIn.noise, 0, 0.5, 0), gate: 0, crush: num(fxIn.crush, 0, 12, 0), sync: fxIn.sync !== false, boost: num(fxIn.boost, 1, 1.3, 1) });
    S.voice = (b.voice && typeof b.voice === "object" && /^https:\/\/|\/m\//.test(String(b.voice.url || ""))) ? { id: String(b.voice.id || "").slice(0, 80), url: String(b.voice.url).slice(0, 300), at: num(b.voice.at, 0, Date.now() + 60000, Date.now()) } : null;
    S.updatedAt = Date.now(); S.boothAt = Date.now(); S.by = "guest:" + user.id; g.lastWrite = Date.now(); S.djGuest = g;
    await writeDoc(env, "radio/dj", "radio", S);
    return json({ ok: true });
  }
  const ipRaw = request.headers.get("CF-Connecting-IP") || "";
  let h = 0; for (let i = 0; i < ipRaw.length; i++) h = ((h * 31) + ipRaw.charCodeAt(i)) >>> 0;
  const ip = "g" + h.toString(36);
  const recent = await env.DB.prepare("select count(*) as n from docs where coll = 'requests' and data like ? and created_at > ?").bind("%" + ip + "%", new Date(Date.now() - 60000).toISOString()).first();
  if (recent && recent.n >= 3) return json({ ok: false, error: "slow_down" }, 429);
  const now = Date.now();
  let data = null;
  if (b.kind === "pick") {
    const title = String(b.title || "").slice(0, 120).trim();
    const src = String(b.src || "");
    const okSrc = src.startsWith("https://archive.org/download/") || src.startsWith(new URL(request.url).origin + "/m/assets/");
    if (!title || !okSrc) return json({ ok: false, error: "bad_pick" }, 422);
    data = { kind: "pick", title, src, cover: String(b.cover || "").slice(0, 300), dur: Math.max(0, Math.min(3600, +b.dur || 0)), at: now, guest: true, ip };
  } else if (b.kind === "text") {
    const text = String(b.text || "").slice(0, 120).trim();
    if (!text) return json({ ok: false, error: "bad_text" }, 422);
    data = { kind: "text", text, at: now, guest: true, ip };
  } else return json({ ok: false, error: "bad_kind" }, 422);
  const path = "requests/g" + now.toString(36) + Math.random().toString(36).slice(2, 8);
  await writeDoc(env, path, "requests", data);
  return json({ ok: true });
}
