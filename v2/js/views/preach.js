/* ============================================================================
   v2 ASAP PREACH VIEW (Phase 5) — the live js/preach.js, ported: his
   real songs from the official channel via /api/yt?mode=songs (no
   Shorts), with the hard-coded backup list when the feed is empty.
   Playing a video steps the station's sound aside through the
   engine, the same courtesy the live MW_videoSound hook performs;
   leaving the view restores the poster (the live MW_PREACH.stop).
   ============================================================================ */

import { MARKUP } from "./preach-markup.js";
import { esc as E, videoSound } from "../platform.js";
import { getEngine } from "../engine.js";

const CHANNEL = "UCDG6YLw_vMVDRXKErys6EJQ";
const BACKUP = [
  { id: "mV3a0Mc-Xl4", title: "ASAP Preach - \"Yahweh\" (Official Music Video)" },
  { id: "8Q-eK_madnc", title: "ASAP Preach - Yeshua w/ Brett Raio (Official Music Video)" },
  { id: "PDz84Hv6CiA", title: "ASAP Preach X OfficialBigYeet X BrotherBoMusic - Nothing To Lose (Official Music Video)" },
  { id: "quNODkMw8YQ", title: "ASAP Preach X Rogue2Redeemed - Not Alone (Official Music Video)" },
  { id: "QkToQPqFShs", title: "ASAP Preach X Rezum \"Owe You Praise\" (Official Music Video)" },
  { id: "xByqCozpNwA", title: "ASAP Preach - Falling Away (Official Music Video)" },
];

export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const frame = root.querySelector("#pr-frame"), grid = root.querySelector("#pr-grid");
  const titleEl = root.querySelector("#pr-title"), dateEl = root.querySelector("#pr-date");
  if (!frame || !grid) return;
  const day = (s) => { if (!s) return ""; if (/ago$/.test(s)) return s; const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };
  let vids = [], loaded = false, cur = -1;
  /* the video-sound courtesy (live MW_videoSound): while a view
     video plays with sound, the station steps aside locally, and
     comes back when it stops. In v2 the seat's sound switch is the
     engine's listening flag — capture it, mute, restore on end. */
  const vs = videoSound(getEngine(ctx));
  const vsStart = vs.start, vsEnd = vs.end;

  function poster(i) {
    const v = vids[i]; if (!v) return;
    cur = i; titleEl.textContent = v.title; dateEl.textContent = v.published ? "Posted " + day(v.published) : "";
    frame.innerHTML = `<button class="pr-poster" type="button" aria-label="Play ${E(v.title)}" style="background-image:url('https://i.ytimg.com/vi/${E(v.id)}/hqdefault.jpg')"></button>`;
    grid.querySelectorAll(".pr-card").forEach((c) => c.classList.toggle("on", +c.dataset.i === i));
  }
  function play(i) {
    poster(i); const v = vids[i]; if (!v) return;
    vsStart();
    frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?autoplay=1&rel=0&playsinline=1" title="${E(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  }
  async function load() {
    if (loaded) return; loaded = true;
    try {
      const j = await fetch("/api/yt?mode=songs&q=" + encodeURIComponent("ASAP Preach") + "&channel=" + CHANNEL).then((r) => r.json());
      vids = (j.list || []).filter((v) => v && v.id && !/#shorts?\b/i.test(v.title || ""));
    } catch (_) { vids = []; }
    if (!vids.length) { vids = BACKUP.slice(); setTimeout(() => { loaded = false; }, 5 * 60e3); }
    grid.innerHTML = vids.map((v, i) => `<button class="pr-card" type="button" data-i="${i}"><div class="th" style="background-image:url('https://i.ytimg.com/vi/${E(v.id)}/mqdefault.jpg')"></div><b>${E(v.title)}</b><small>${E(v.published ? day(v.published) : "")}</small></button>`).join("");
    poster(0);
  }
  grid.addEventListener("click", (e) => { const c = e.target.closest(".pr-card"); if (c) { play(+c.dataset.i); frame.scrollIntoView({ behavior: "smooth", block: "center" }); } });
  frame.addEventListener("click", (e) => { if (e.target.closest(".pr-poster") && cur >= 0) play(cur); });
  root._mw2stop = () => { if (frame.querySelector("iframe") && cur >= 0) { poster(cur); vsEnd(); } };
  load();
}
export function destroy(root) { if (root && root._mw2stop) root._mw2stop(); }
