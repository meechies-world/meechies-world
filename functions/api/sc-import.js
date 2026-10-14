/* One-time helper: fetches the owner's own SoundClick songs (grantboyrecords2013) so the owner can add them
 * to the Library from his logged-in browser. Only these song IDs are allowed. */
const IDS = new Set("12699368 12699365 12699364 12699363 12699358 12699361 12699357 12543483 12543484 12106319 12691116 12692616 12543519 12543469 12543506 12417568 12543470 12543482 12543565 12543525 12543511 12543502 12543538 12543551 12543496 12543486 12543690 12692623 12543497 12692620 12543492 12692624 12541682 12541685 12547565 12543961 12543481 12543480 12543476 12543475 12543474 12543473 12543471 12543468 12541681 12540566 12519020 12519016 12519014 12519011 12519009 12519007 12519004 12507574 12417543 12417523 12165394 12165393 12165392 12165391 12165390 12165389 12165388 12165387 12163155 12128387 12124772 12124767 12124765 12120200 12117126 12108457 12107996 12107587 12106845 12106843 12106369 12106355".split(" "));
export async function onRequestGet({ request }) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!IDS.has(id)) return new Response("not allowed", { status: 403 });
  const r = await fetch("https://www.soundclick.com/playerV5/panels/audioStream.cfm?songID=" + id, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", referer: "https://www.soundclick.com/grantboyrecords2013", accept: "audio/*,*/*" },
  });
  const ct = r.headers.get("content-type") || "";
  return new Response(r.body, { status: r.status, headers: { "content-type": ct || "application/octet-stream", "x-upstream": r.url, "cache-control": "no-store" } });
}
