// YouTube helper for Live TV and Free Movies. Only returns videos that are allowed to play inside other websites,
// so every button on Meechie's World actually plays on the page.
//   /api/yt?mode=live&q=hip hop        -> live-now streams for a topic
//   /api/yt?mode=channels&ids=UC..,UC..  -> which of these channels are live now (and their video)
//   /api/yt?mode=movies&genre=action    -> free full-length movies from official free-movie channels
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "en-US,en;q=0.9" };
const json = (o, age = 600) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + age } });
function walk(o, out) { if (!o || typeof o !== "object") return; if (o.videoRenderer) out.push(o.videoRenderer); for (const k in o) walk(o[k], out); }
const txt = (r) => (r && (r.simpleText || (r.runs || []).map((x) => x.text).join(""))) || "";
async function search(q, live) {
  const u = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q) + (live ? "&sp=EgJAAQ%253D%253D" : "&sp=EgIYAg%253D%253D"); // live filter, or long (>20 min) videos
  const html = await fetch(u, { headers: UA, cf: { cacheTtl: 900 } }).then((r) => r.text());
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s); if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch (_) { return []; }
  const vids = []; walk(data, vids);
  return vids.filter((v) => v.videoId).map((v) => ({ id: v.videoId, title: txt(v.title), channel: txt(v.ownerText), len: txt(v.lengthText), live: JSON.stringify(v.badges || v.thumbnailOverlays || "").includes("LIVE") }));
}
async function embeddable(id) {
  const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id), { headers: UA, cf: { cacheTtl: 3600 } }).catch(() => null);
  return !!(r && r.ok);
}
async function keepPlayable(list, max) {
  const out = [];
  const checks = await Promise.all(list.slice(0, max + 6).map((v) => embeddable(v.id).then((ok) => (ok ? v : null))));
  for (const v of checks) if (v && out.length < max) out.push(v);
  return out;
}
const MOVIE_CHANNELS = /filmrise|popcornflix|movie central|maverick movies|grizzly imports|timeless classic|full movies free|the film detective|hoopla|tubi|crackle|moviestime|free movies by cineverse|cineverse|bonanza|black cinema|urban movie channel|umc|hallmark|kino|shout! factory|mill creek/i;

export async function onRequestGet({ request }) {
  const url = new URL(request.url), mode = url.searchParams.get("mode") || "live";
  try {
    if (mode === "live") {
      const q = (url.searchParams.get("q") || "news").slice(0, 60);
      const list = (await search(q + " live", true)).filter((v) => v.live);
      return json({ q, list: await keepPlayable(list, 10) }, 600);
    }
    if (mode === "channels") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter((x) => /^UC[\w-]{20,24}$/.test(x)).slice(0, 20);
      const res = await Promise.all(ids.map(async (id) => {
        try {
          const html = await fetch("https://www.youtube.com/channel/" + id + "/live", { headers: UA, cf: { cacheTtl: 600 } }).then((r) => r.text());
          const vid = (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/) || [])[1];
          const live = /"isLiveNow":true|"isLive":true/.test(html);
          if (!vid || !live) return { channel: id, live: false };
          return { channel: id, live: true, id: vid, ok: await embeddable(vid) };
        } catch (_) { return { channel: id, live: false }; }
      }));
      return json({ list: res }, 600);
    }
    if (mode === "movies") {
      const genre = (url.searchParams.get("genre") || "").slice(0, 30);
      const raw = await search((genre ? genre + " " : "") + "full movie free", false);
      const long = raw.filter((v) => !v.live && /^\d+:\d{2}:\d{2}$/.test(v.len) && MOVIE_CHANNELS.test(v.channel));
      return json({ genre, list: await keepPlayable(long, 12) }, 3600);
    }
  } catch (err) { return json({ list: [], error: String(err && err.message || err) }, 60); }
  return json({ list: [] }, 60);
}
