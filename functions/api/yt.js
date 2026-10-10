// YouTube helper for Live TV and Free Movies. Only returns videos that are allowed to play inside other websites,
// so every button on Meechie's World actually plays on the page.
//   /api/yt?mode=live&q=hip hop        -> live-now streams for a topic
//   /api/yt?mode=channels&ids=UC..,UC..  -> which of these channels are live now (and their video)
//   /api/yt?mode=movies&genre=action    -> free full-length movies from official free-movie channels
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "en-US,en;q=0.9" };
const json = (o, age = 600) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + age } });
function walk(o, out) { if (!o || typeof o !== "object") return; if (o.videoRenderer) out.push(o.videoRenderer); for (const k in o) walk(o[k], out); }
const txt = (r) => (r && (r.simpleText || (r.runs || []).map((x) => x.text).join(""))) || "";
async function search(q, live, newest) {
  // live filter, long (>20 min) videos, or long videos sorted newest first
  const u = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q) + (live ? "&sp=EgJAAQ%253D%253D" : newest ? "&sp=CAISAhgC" : "&sp=EgIYAg%253D%253D");
  const html = await fetch(u, { headers: UA, cf: { cacheTtl: 900 } }).then((r) => r.text());
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s); if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch (_) { return []; }
  const vids = []; walk(data, vids);
  return vids.filter((v) => v.videoId).map((v) => ({ id: v.videoId, title: txt(v.title), channel: txt(v.ownerText), len: txt(v.lengthText), ago: txt(v.publishedTimeText), live: JSON.stringify(v.badges || v.thumbnailOverlays || "").includes("LIVE") }));
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
const MOVIE_CHANNELS = /^(filmrise( movies| documentaries)?|popcornflix|movie central|maverick movies|timeless classic movies|the film detective|grizzly imports|free documentary)$/i;

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
      // 3) still nothing: search YouTube for the channel's name, newest first, keeping only this channel's videos
      const q = (url.searchParams.get("q") || "").slice(0, 60);
      if (!list.length && q) {
        const sr = await fetch("https://www.youtube.com/results?search_query=" + encodeURIComponent(q) + "&sp=CAI%253D", { headers: UA, cf: { cacheTtl: 1800 } }).catch((e) => ({ ok: false, status: String(e) }));
        const html = sr.ok ? await sr.text() : ""; dbg.search = sr.status;
        const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s); let data = null; if (m) { try { data = JSON.parse(m[1]); } catch (_) {} }
        const vr = []; walk(data, vr);
        list = vr.filter((v) => v.videoId && JSON.stringify(v.ownerText || v.longBylineText || "").includes(ch)).map((v) => ({ id: v.videoId, title: txt(v.title), published: txt(v.publishedTimeText), channel: txt(v.ownerText) }));
        name = name || (list[0] && list[0].channel) || ""; dbg.searchFound = list.length;
      }
      const seen = new Set(); list = list.filter((v) => /^[\w-]{11}$/.test(v.id) && !seen.has(v.id) && seen.add(v.id));
      if (url.searchParams.get("debug")) return json({ dbg, n: list.length, sample: list.slice(0, 3) }, 0);
      if (!list.length) return json({ channel: name, list: [] }, 120);
      // the embeddable check also talks to YouTube; if it gets blocked, keep the official uploads rather than show nothing
      const playable = await keepPlayable(list, 15);
      return json({ channel: name, list: playable.length ? playable : list.slice(0, 15) }, 1800);
    }
    if (mode === "movies") {
      const genre = (url.searchParams.get("genre") || "").slice(0, 30), newest = url.searchParams.get("new") === "1";
      const official = ["FilmRise Movies", "Popcornflix", "Movie Central", "Maverick Movies", "Timeless Classic Movies"];
      const docs = /documentary|true story|biography/i.test(genre);
      if (docs) official.push("FilmRise Documentaries", "Free Documentary"); // official free documentary channels
      const what = docs ? "full documentary" : "full movie";
      const batches = await Promise.all(official.map((ch) => search((genre ? genre + " " : "") + what + " " + ch, false, newest).catch(() => [])));
      const seen = new Set(), long = [];
      for (const list of batches) for (const v of list) if (!v.live && !seen.has(v.id) && /^\d+:\d{2}:\d{2}$/.test(v.len) && MOVIE_CHANNELS.test(v.channel)) { seen.add(v.id); long.push(v); }
      // newest: sort by how long ago each was posted ("3 days ago", "2mo ago", "1y ago" ...)
      if (newest) {
        const U = { s: 1 / 86400, sec: 1 / 86400, second: 1 / 86400, min: 1 / 1440, minute: 1 / 1440, h: 1 / 24, hr: 1 / 24, hour: 1 / 24, d: 1, day: 1, w: 7, wk: 7, week: 7, mo: 30, month: 30, y: 365, yr: 365, year: 365 };
        const days = (a) => { const m = String(a || "").toLowerCase().match(/(\d+)\s*([a-z]+)/); if (!m) return 99999; const u = m[2].replace(/s$/, ""); return +m[1] * (U[u] ?? U[u.slice(0, 2)] ?? U[u[0]] ?? 99999); };
        long.sort((a, b) => days(a.ago) - days(b.ago));
      }
      if (url.searchParams.get("debug")) return json({ n: long.length, raw: batches.flat().slice(0, 25).map((v) => [v.channel, v.len, v.title.slice(0, 40), v.ago]) }, 0);
      return json({ genre, newest, list: await keepPlayable(long, 12) }, newest ? 1800 : 3600);
    }
  } catch (err) { return json({ list: [], error: String(err && err.message || err) }, 60); }
  return json({ list: [] }, 60);
}
