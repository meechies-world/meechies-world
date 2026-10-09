// Owner-only: copy the owner's public ReverbNation songs (artist 7533494, "halal music")
// into the site's own radio library. Skips songs already imported.
const SUPABASE_URL = "https://yjouaysczttqbytksejq.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlqb3VheXNjenR0cWJ5dGtzZWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDQzMjYsImV4cCI6MjEwNzA4MDMyNn0.4IQNTjyuF4P-WhnhBxs_kA90MhLj9I6c-xUFzOqWhcw";
const ARTIST = "7533494";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const clean = (n) => String(n || "Untitled")
  .replace(/\s*[-–]?\s*\d{1,2}:\d{1,2}:\d{2,4},?\s*\d{1,2}\.\d{2}\s*[AP]M\s*$/i, "")   // drop "1:11:23, 8.39 PM" style stamps
  .replace(/\s*[-–]?\s*\d{1,2}:\d{1,2}:\d{2,4}\s*\d{1,2}\.\d{2}\s*[AP]M\s*$/i, "")
  .replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";

export async function onRequestPost({ request }) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "owner_only" }, 401);
  const H = { apikey: SUPABASE_ANON, authorization: "Bearer " + token };
  const who = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: H });
  if (!who.ok) return json({ error: "owner_only" }, 401);
  const uid = (await who.json()).id;
  const adm = await fetch(SUPABASE_URL + "/rest/v1/admins?select=user_id&user_id=eq." + uid, { headers: H }).then((r) => r.json()).catch(() => []);
  if (!Array.isArray(adm) || !adm.length) return json({ error: "owner_only" }, 403);

  // what we already have
  const have = await fetch(SUPABASE_URL + "/rest/v1/docs?select=data&coll=eq.tracks", { headers: H }).then((r) => r.json()).catch(() => []);
  const done = new Set((have || []).map((d) => d.data && d.data.rnId).filter(Boolean).map(String));

  const list = await fetch(`https://www.reverbnation.com/api/artist/${ARTIST}/songs?page=1&per_page=50`, { headers: { "user-agent": "MeechiesWorldSite/1.0", accept: "application/json" } })
    .then((r) => r.ok ? r.json() : null).catch(() => null)
    || await fetch(`https://legacy.reverbnation.com/api/artist/${ARTIST}/songs?page=1&per_page=50`, { headers: { "user-agent": "MeechiesWorldSite/1.0", accept: "application/json" } }).then((r) => r.ok ? r.json() : null).catch(() => null);
  const songs = ((list && list.results) || []).filter((s) => s && s.url && s.public !== false && !s.streaming_restricted && /stream/.test(s.access || "stream"));
  if (!songs.length) return json({ error: "Couldn't read songs from ReverbNation right now." }, 502);

  const now = Date.now(), added = [], skipped = [], failed = [];
  const BATCH = 12; let tried = 0, remaining = 0;
  // oldest first so the radio plays them in release order
  const ordered = songs.slice().reverse();
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    if (done.has(String(s.id))) { skipped.push(clean(s.name)); continue; }
    if (tried >= BATCH) { remaining++; continue; }
    tried++;
    try {
      const mp3 = await fetch(s.url, { headers: { "user-agent": "MeechiesWorldSite/1.0" } });
      if (!mp3.ok || !mp3.body) throw new Error("download " + mp3.status);
      const id = ("rn" + s.id + Math.random().toString(36).slice(2, 8)).slice(0, 20);
      const up = await fetch(SUPABASE_URL + "/storage/v1/object/assets/" + id, {
        method: "POST", headers: { ...H, "content-type": "audio/mpeg", "x-upsert": "false" }, body: mp3.body,
      });
      if (!up.ok) throw new Error("store " + up.status + " " + (await up.text()).slice(0, 120));
      const doc = { path: "tracks/" + id, coll: "tracks", data: {
        title: clean(s.name), artist: "Meechie", assetId: id, duration: Math.round(s.duration || 0),
        cover: s.image || "", rnId: String(s.id), source: "reverbnation", addedAt: 1700000000000 + i * 1000,
      } };
      const ins = await fetch(SUPABASE_URL + "/rest/v1/docs", { method: "POST", headers: { ...H, "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify(doc) });
      if (!ins.ok) throw new Error("save " + ins.status + " " + (await ins.text()).slice(0, 120));
      added.push(clean(s.name));
    } catch (e) { failed.push(clean(s.name) + ": " + String(e.message || e).slice(0, 140)); }
  }
  return json({ added, skipped, failed, remaining, total: songs.length });
}
