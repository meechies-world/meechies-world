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
const MOVIE_CHANNELS = /^(filmrise( movies)?|popcornflix|movie central|maverick movies|timeless classic movies|the film detective|grizzly imports)$/i;

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
    if (mode === "uploads") {
      // a channel's latest uploads, from YouTube's public feed
      const ch = url.searchParams.get("channel") || "";
      if (!/^UC[\w-]{20,24}$/.test(ch)) return json({ list: [], error: "bad_channel" }, 60);
      const dbg = {};
      // 1) YouTube's public feed
      const fr = await fetch("https://www.youtube.com/feeds/videos.xml?channel_id=" + ch, { headers: UA, cf: { cacheTtl: 1800 } }).catch((e) => ({ ok: false, status: String(e) }));
      const xml = fr.ok ? await fr.text() : ""; dbg.feed = fr.status;
      const un = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      let name = un((xml.match(/<author>\s*<name>([^<]*)<\/name>/) || [])[1] || "");
      let list = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
        id: (m[1].match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1],
        title: un((m[1].match(/<title>([^<]*)<\/title>/) || [])[1] || ""),
        published: (m[1].match(/<published>([^<]+)<\/published>/) || [])[1] || "",
        channel: name,
      })).filter((v) => v.id);
      // 2) if the feed is blocked or empty, read the channel's Videos page instead (newest first)
      if (!list.length) {
        const pr = await fetch("https://www.youtube.com/channel/" + ch + "/videos", { headers: UA, cf: { cacheTtl: 1800 } }).catch((e) => ({ ok: false, status: String(e) }));
        const html = pr.ok ? await pr.text() : ""; dbg.page = pr.status;
        const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
        if (m) {
          let data = null; try { data = JSON.parse(m[1]); } catch (_) {}
          name = name || (data && data.metadata && data.metadata.channelMetadataRenderer && data.metadata.channelMetadataRenderer.title) || "";
          const vr = []; walk(data, vr);
          list = vr.filter((v) => v.videoId).map((v) => ({ id: v.videoId, title: txt(v.title), published: txt(v.publishedTimeText), channel: name }));
          if (!list.length) { // newer YouTube layout
            const lk = []; (function w(o) { if (!o || typeof o !== "object") return; if (o.lockupViewModel) lk.push(o.lockupViewModel); for (const k in o) w(o[k]); })(data);
            list = lk.filter((l) => l.contentId && /VIDEO/.test(l.contentType || "VIDEO")).map((l) => {
              const md = l.metadata && l.metadata.lockupMetadataViewModel;
              const rows = JSON.stringify((md && md.metadata) || {}); const ago = (rows.match(/"content":"([^"]*ago)"/) || [])[1] || "";
              return { id: l.contentId, title: (md && md.title && md.title.content) || "", published: ago, channel: name };
            });
          }
          dbg.found = list.length;
        } else dbg.noData = true;
      }
      const seen = new Set(); list = list.filter((v) => /^[\w-]{11}$/.test(v.id) && !seen.has(v.id) && seen.add(v.id));
      if (url.searchParams.get("debug")) return json({ dbg, n: list.length, sample: list.slice(0, 3) }, 0);
      return json({ channel: name, list: await keepPlayable(list, 15) }, list.length ? 1800 : 120);
    }
    if (mode === "movies") {
      const genre = (url.searchParams.get("genre") || "").slice(0, 30);
      const official = ["FilmRise Movies", "Popcornflix", "Movie Central", "Maverick Movies", "Timeless Classic Movies"];
      const batches = await Promise.all(official.map((ch) => search((genre ? genre + " " : "") + "full movie " + ch, false).catch(() => [])));
      const seen = new Set(), long = [];
      for (const list of batches) for (const v of list) if (!v.live && !seen.has(v.id) && /^\d+:\d{2}:\d{2}$/.test(v.len) && MOVIE_CHANNELS.test(v.channel)) { seen.add(v.id); long.push(v); }
      if (url.searchParams.get("debug")) return json({ n: long.length, raw: batches.flat().slice(0, 25).map((v) => [v.channel, v.len, v.title.slice(0, 40)]) }, 0);
      return json({ genre, list: await keepPlayable(long, 12) }, 3600);
    }
  } catch (err) { return json({ list: [], error: String(err && err.message || err) }, 60); }
  return json({ list: [] }, 60);
}
