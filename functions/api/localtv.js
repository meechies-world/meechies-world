// Local TV: finds live news streams near the visitor (or for ?place=) from YouTube's public live search.
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "en-US,en;q=0.9" };
function walk(o, out) { if (!o || typeof o !== "object") return; if (o.videoRenderer) out.push(o.videoRenderer); for (const k in o) walk(o[k], out); }
async function search(q) {
  const u = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q) + "&sp=EgJAAQ%253D%253D"; // Live filter
  const html = await fetch(u, { headers: UA, cf: { cacheTtl: 900 } }).then((r) => r.text());
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s) || html.match(/ytInitialData"\]\s*=\s*(\{.*?\});/s);
  if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch (_) { return []; }
  const vids = []; walk(data, vids);
  return vids.filter((v) => v.videoId && JSON.stringify(v.badges || v.thumbnailOverlays || "").includes("LIVE")).map((v) => ({
    id: v.videoId, title: (v.title && (v.title.runs || []).map((r) => r.text).join("")) || "", channel: (v.ownerText && (v.ownerText.runs || [])[0] && v.ownerText.runs[0].text) || "",
  }));
}
export async function onRequestGet({ request }) {
  const url = new URL(request.url), c = request.cf || {};
  // one station by name: e.g. ?station=WPXI&match=wpxi|channel 11
  const station = (url.searchParams.get("station") || "").slice(0, 40);
  if (station) {
    const match = new RegExp((url.searchParams.get("match") || station).replace(/[^\w| ]/g, ""), "i");
    let list = []; try { list = await search(station + " live"); } catch (_) {}
    list = list.filter((v) => match.test(v.channel + " " + v.title)).slice(0, 3);
    return new Response(JSON.stringify({ station, list }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
  }
  let place = (url.searchParams.get("place") || "").slice(0, 60).trim();
  if (!place) place = [c.city, c.regionCode || c.region].filter(Boolean).join(" ");
  if (!place) place = "local";
  let list = [];
  try { list = await search(place + " local news live"); } catch (_) {}
  if (list.length < 6) { try { list = list.concat(await search(place + " weather live")); } catch (_) {} }
  if (list.length < 3 && c.region) { try { list = list.concat(await search(c.region + " news live")); } catch (_) {} }
  const words = place.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 2);
  const isNews = (v) => /news|weather|kdka|wtae|wpxi|eyewitness|action news|\b(cbs|abc|nbc|fox)\b/i.test(v.title + " " + v.channel) && !/pope|vatican|india|pakistan|tv18|\bcam\b|camera|gaming|music|lofi/i.test(v.title + " " + v.channel);
  const score = (v) => words.reduce((n, w) => n + ((v.title + " " + v.channel).toLowerCase().includes(w) ? 2 : 0), 0);
  const seen = new Set(); list = list.filter((v) => isNews(v) && !seen.has(v.id) && seen.add(v.id)).sort((a, b) => score(b) - score(a)).slice(0, 10);
  return new Response(JSON.stringify({ place, list }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
}
