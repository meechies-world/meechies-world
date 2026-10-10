/* ASAP Preach page: newest videos from his official YouTube channel (via /api/yt?mode=uploads).
 * Tap a video to play it in the big player. Videos only load when the page is opened. */
(function () {
  const CHANNEL = "UCDG6YLw_vMVDRXKErys6EJQ"; // youtube.com/@officialasappreach
  const view = document.getElementById("v-preach"); if (!view) return;
  const frame = document.getElementById("pr-frame"), grid = document.getElementById("pr-grid");
  const titleEl = document.getElementById("pr-title"), dateEl = document.getElementById("pr-date");
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // dates come as a full date from the feed, or as "3 weeks ago" from the channel page
  const day = (s) => { if (!s) return ""; if (/ago$/.test(s)) return s; const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };
  let vids = [], loaded = false, cur = -1;

  const css = document.createElement("style");
  css.textContent = `
.pr-stage{padding:0;overflow:hidden}
.pr-frame{aspect-ratio:16/9;background:#000;display:grid;place-items:center}
.pr-frame iframe{width:100%;height:100%;border:0;display:block}
.pr-frame .pr-poster{width:100%;height:100%;border:0;padding:0;cursor:pointer;background:#000 center/cover no-repeat;position:relative}
.pr-frame .pr-poster::after{content:"▶";position:absolute;inset:0;margin:auto;width:76px;height:76px;border-radius:50%;display:grid;place-items:center;background:var(--gold);color:var(--ink);font-size:30px;box-shadow:0 0 0 10px rgba(212,168,67,.25)}
.pr-now{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:14px 16px}
.pr-now b{display:block;font-size:17px;line-height:1.3}
.pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:18px}
.pr-card{display:grid;gap:8px;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:0 0 12px;color:var(--text);cursor:pointer;overflow:hidden;font:inherit}
.pr-card:hover,.pr-card.on{border-color:var(--gold)}
.pr-card .th{aspect-ratio:16/9;background:#000 center/cover no-repeat}
.pr-card b{font-size:14px;line-height:1.35;padding:0 12px}
.pr-card small{color:var(--muted);padding:0 12px;font-size:12px}`;
  document.head.appendChild(css);

  function poster(i) {
    const v = vids[i]; if (!v) return;
    cur = i; titleEl.textContent = v.title; dateEl.textContent = v.published ? "Posted " + day(v.published) : "";
    frame.innerHTML = `<button class="pr-poster" type="button" aria-label="Play ${E(v.title)}" style="background-image:url('https://i.ytimg.com/vi/${E(v.id)}/hqdefault.jpg')"></button>`;
    grid.querySelectorAll(".pr-card").forEach((c) => c.classList.toggle("on", +c.dataset.i === i));
  }
  function play(i) {
    poster(i); const v = vids[i];
    try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {} // pause the radio so they don't play over each other
    frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?autoplay=1&rel=0&playsinline=1" title="${E(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  }
  async function load() {
    if (loaded) return; loaded = true;
    try {
      const j = await fetch("/api/yt?mode=uploads&channel=" + CHANNEL).then((r) => r.json());
      vids = (j.list || []).filter((v) => v && v.id);
    } catch (_) { vids = []; }
    if (!vids.length) {
      loaded = false;
      frame.innerHTML = '<div class="yt-empty"><span>Couldn\'t load ASAP Preach\'s videos right now. <a href="https://www.youtube.com/@officialasappreach" target="_blank" rel="noopener">Watch on YouTube</a></span></div>';
      return;
    }
    grid.innerHTML = vids.map((v, i) => `<button class="pr-card" type="button" data-i="${i}"><div class="th" style="background-image:url('https://i.ytimg.com/vi/${E(v.id)}/mqdefault.jpg')"></div><b>${E(v.title)}</b><small>${E(v.published ? day(v.published) : "")}</small></button>`).join("");
    poster(0);
  }
  grid.addEventListener("click", (e) => { const c = e.target.closest(".pr-card"); if (c) { play(+c.dataset.i); frame.scrollIntoView({ behavior: "smooth", block: "center" }); } });
  frame.addEventListener("click", (e) => { if (e.target.closest(".pr-poster") && cur >= 0) play(cur); });

  // stop the video when leaving the page
  window.MW_PREACH = { stop() { if (frame.querySelector("iframe") && cur >= 0) poster(cur); } };
  new MutationObserver(() => { if (!view.hidden) load(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  if (!view.hidden) load();
})();
