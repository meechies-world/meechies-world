// Owner-only: copy Meechie's public ReverbNation songs (artist 7533494, "halal music") onto the radio.
// Songs are kept in Meechie's World's own free file storage (Cloudflare KV), so they keep playing even
// when the old Supabase storage is over its free limit. It also brings back songs that were already on
// the radio but whose files were stuck on Supabase: same song, same id, so playlists don't change.
import { json, userFrom, isAdmin, setup, change } from "../../lib/cf.js";

const ARTIST = "7533494";
const MAX = 25 * 1024 * 1024; // KV's limit for one file
const BATCH = 6;              // songs per request (each call stays well inside Cloudflare's free time limit)
const UA = { "user-agent": "MeechiesWorldSite/1.0" };

const clean = (n) => String(n || "Untitled")
  .replace(/\s*[-–]?\s*\d{1,2}:\d{1,2}:\d{2,4},?\s*\d{1,2}\.\d{2}\s*[AP]M\s*$/i, "")   // drop "1:11:23, 8.39 PM" style stamps
  .replace(/\s*[-–]?\s*\d{1,2}:\d{1,2}:\d{2,4}\s*\d{1,2}\.\d{2}\s*[AP]M\s*$/i, "")
  .replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";

async function songList() {
  for (const host of ["www", "legacy"]) {
    const j = await fetch(`https://${host}.reverbnation.com/api/artist/${ARTIST}/songs?page=1&per_page=50`, { headers: { ...UA, accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const list = ((j && j.results) || []).filter((s) => s && s.url && s.public !== false && !s.streaming_restricted && /stream/.test(s.access || "stream"));
    if (list.length) return list;
  }
  return [];
}

async function store(env, assetId, url) {
  const mp3 = await fetch(url, { headers: UA });
  if (!mp3.ok) throw new Error("download " + mp3.status);
  const buf = await mp3.arrayBuffer();
  if (buf.byteLength < 1000) throw new Error("empty file");
  if (buf.byteLength > MAX) throw new Error("over 25 MB");
  const type = /audio\//.test(mp3.headers.get("content-type") || "") ? mp3.headers.get("content-type") : "audio/mpeg";
  await env.MEDIA.put("assets/" + assetId, buf, { metadata: { type, size: buf.byteLength } });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.MEDIA) return json({ error: "Storage isn't connected." }, 503);
  await setup(env);
  const me = await userFrom(request, env);
  if (!me || !(await isAdmin(env, me.id))) return json({ error: "owner_only" }, 403);

  const rows = (await env.DB.prepare("select path, data from docs where coll = 'tracks'").all()).results || [];
  const byRn = new Map();
  for (const r of rows) { try { const d = JSON.parse(r.data); if (d.rnId) byRn.set(String(d.rnId), d); } catch (_) {} }

  const songs = await songList();
  if (!songs.length) return json({ error: "Couldn't read songs from ReverbNation right now. Try again in a minute." }, 502);

  const added = [], restored = [], failed = []; let ok = 0, tried = 0, remaining = 0;
  const ordered = songs.slice().reverse(); // oldest first, so the radio plays them in release order
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i], have = byRn.get(String(s.id));
    if (have && have.assetId && (await env.MEDIA.list({ prefix: "assets/" + have.assetId, limit: 1 })).keys.length) { ok++; continue; }
    if (tried >= BATCH) { remaining++; continue; }
    tried++;
    try {
      if (have && have.assetId) { await store(env, have.assetId, s.url); restored.push(clean(s.name)); ok++; continue; }
      const id = ("rn" + s.id + Math.random().toString(36).slice(2, 8)).slice(0, 20);
      await store(env, id, s.url);
      const path = "tracks/" + id, now = new Date().toISOString();
      const data = { title: clean(s.name), artist: "Meechie", assetId: id, duration: Math.round(s.duration || 0), cover: s.image || "", rnId: String(s.id), source: "reverbnation", addedAt: 1700000000000 + i * 1000 };
      await env.DB.batch([env.DB.prepare("insert into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, "tracks", me.id, JSON.stringify(data), now, now), change(env, "docs", path, "tracks")]);
      added.push(data.title); ok++;
    } catch (e) { failed.push(clean(s.name) + ": " + String(e.message || e).slice(0, 100)); }
  }
  return json({ added, restored, failed, remaining, ok, total: songs.length });
}
