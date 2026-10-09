/* Live radio stations from around the world (Radio Browser, free and open) on the Radio page,
 * and Live TV (official free live streams on YouTube) on the Videos page. */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const css = document.createElement("style");
  css.textContent = `
.lv-card{grid-template-columns:minmax(0,1fr);margin-top:40px;border:1px solid var(--line);border-radius:18px;padding:18px;background:linear-gradient(180deg,#17130c,#0f0d09);display:grid;gap:12px}
.lv-head{display:flex;justify-content:space-between;align-items:end;gap:12px;flex-wrap:wrap}
.lv-head h3{margin:4px 0 0;font-size:26px}
.lv-chips{display:flex;gap:8px;flex-wrap:wrap}
.lv-form{display:flex;gap:8px}.lv-form input{flex:1;min-width:0;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text);font:16px var(--body)}
.lv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.lv-st{display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px;align-items:center;text-align:left;padding:10px;border:1px solid var(--line);border-radius:12px;background:#0c0a07;color:var(--text);cursor:pointer;font:inherit}
.lv-st:hover,.lv-st.on{border-color:var(--gold)}
.lv-st img,.lv-st .ph{width:44px;height:44px;border-radius:10px;object-fit:cover;background:#1d1810;display:grid;place-items:center;font-size:20px}
.lv-st b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.lv-st small{color:var(--muted);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.tv-grid{display:flex;gap:8px;flex-wrap:wrap}
.tv-ch{border:1px solid var(--line);background:#0c0a07;color:var(--text);border-radius:999px;padding:9px 14px;font:700 13px var(--body);cursor:pointer}
.tv-ch.on{background:var(--gold);color:#0b0a08;border-color:var(--gold)}
.tv-ch .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#e5484d;margin-right:6px;vertical-align:1px}`;
  document.head.appendChild(css);

  /* ---------------- Live radio ---------------- */
  const radioView = document.getElementById("v-radio");
  const lib = radioView && radioView.querySelector("#dj-root");
  if (radioView && lib) {
    const box = document.createElement("div");
    box.className = "lv-card"; box.id = "world-radio"; box.style.scrollMarginTop = "120px";
    box.innerHTML = `<div class="lv-head"><div><p class="eyebrow" style="margin:0">Live from around the world</p><h3>Live Radio Stations</h3></div><small class="muted">Tap a station to listen. Keeps playing when your phone locks.</small></div>
      <div class="lv-chips" id="lv-chips">${[["hip hop", "Hip Hop"], ["rnb", "R&B"], ["gospel", "Gospel"], ["jazz", "Jazz"], ["reggae", "Reggae"], ["pop", "Top 40"], ["oldies", "Oldies"], ["news", "News"], ["sports", "Sports"], ["islamic", "Islamic"]].map(([t, n], i) => `<button class="chip" type="button" data-tag="${t}" aria-pressed="${i === 0}">${n}</button>`).join("")}</div>
      <form class="lv-form" id="lv-form"><input type="search" id="lv-q" placeholder="Search any station or city (e.g. Hot 97, Pittsburgh)" aria-label="Search radio stations"><button class="btn sm" type="submit">Search</button></form>
      <div class="lv-grid" id="lv-grid"><small class="muted">Loading stations...</small></div>`;
    lib.after(box);
    const API = ["https://de1.api.radio-browser.info", "https://nl1.api.radio-browser.info", "https://at1.api.radio-browser.info"];
    let stations = [], cur = null;
    async function find(params) {
      const qs = new URLSearchParams({ limit: "40", hidebroken: "true", order: "clickcount", reverse: "true", ...params }).toString();
      for (const base of API) {
        try { const r = await fetch(base + "/json/stations/search?" + qs); if (r.ok) return await r.json(); } catch (_) {}
      }
      return [];
    }
    async function show(params) {
      const g = box.querySelector("#lv-grid"); g.innerHTML = '<small class="muted">Loading stations...</small>';
      const raw = await find(params);
      const seen = new Set();
      stations = raw.filter((s) => /^https:\/\//.test(s.url_resolved || "") && !seen.has(s.name.trim().toLowerCase()) && seen.add(s.name.trim().toLowerCase())).slice(0, 30);
      g.innerHTML = stations.length ? stations.map((s, i) => `<button class="lv-st ${cur && cur.stationuuid === s.stationuuid ? "on" : ""}" type="button" data-st="${i}">${/^https:\/\//.test(s.favicon || "") ? `<img src="${E(s.favicon)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=ph>📻</span>'">` : '<span class="ph">📻</span>'}<span><b>${E(s.name.trim())}</b><small>${E([s.state, s.countrycode].filter(Boolean).join(", "))}${s.bitrate ? " · " + s.bitrate + "k" : ""}</small></span></button>`).join("") : '<small class="muted">No stations found. Try another search.</small>';
    }
    box.addEventListener("click", (e) => {
      const c = e.target.closest("[data-tag]");
      if (c) { box.querySelectorAll("[data-tag]").forEach((x) => x.setAttribute("aria-pressed", x === c)); show({ tag: c.dataset.tag }); return; }
      const b = e.target.closest("[data-st]"); if (!b) return;
      const s = stations[+b.dataset.st]; if (!s) return;
      if (typeof media === "undefined") return;
      if (typeof mode !== "undefined" && mode === "live" && cur && cur.stationuuid === s.stationuuid && !media.paused) { media.pause(); return; }
      cur = s; box.querySelectorAll(".lv-st").forEach((x) => x.classList.toggle("on", x === b));
      try { mode = "live"; curIdx = -1; playTok++; room?.presence({ radio: null }); } catch (_) {}
      media.onloadedmetadata = media.onerror = null; media.src = s.url_resolved; media.play().catch(() => say("That station isn't answering. Try another one."));
      const t = { title: s.name.trim(), artist: [s.state, s.country].filter(Boolean).join(", ") || "Live radio", cover: /^https:\/\//.test(s.favicon || "") ? s.favicon : "" };
      try { showBar(t, "LIVE RADIO · " + (s.countrycode || "")); renderTracks && renderTracks(); } catch (_) {}
      try { fetch(API[0] + "/json/url/" + s.stationuuid).catch(() => {}); } catch (_) {}
    });
    box.querySelector("#lv-form").addEventListener("submit", (e) => { e.preventDefault(); const q = box.querySelector("#lv-q").value.trim(); if (!q) return; box.querySelectorAll("[data-tag]").forEach((x) => x.setAttribute("aria-pressed", "false")); show({ name: q }); });
    let loaded = false;
    const maybe = () => { if (!loaded && !radioView.hidden) { loaded = true; show({ tag: "hip hop" }); } };
    new MutationObserver(maybe).observe(radioView, { attributes: true, attributeFilter: ["hidden"] }); maybe();
  }

  /* ---------------- Live TV ---------------- */
  const vidView = document.getElementById("v-videos");
  const stage = vidView && vidView.querySelector(".yt-stage");
  if (vidView && stage) {
    const CH = [
      ["ABC News Live", "UCBi2mrWuNuyYy4gbM6fU18Q"], ["NBC News NOW", "UCeY0bbntWzzVIaj2z3QigXg"], ["CBS News 24/7", "UC8p1vwvWtl6T73JiExfWs1g"],
      ["Sky News", "UCoMdktPbSTixAyNGwb-UYkQ"], ["Al Jazeera English", "UCNye-wNBqNL5ZzHSJj3l8Bg"], ["DW News", "UCknLrEdhRCp1aegoMqRaCZg"],
      ["France 24", "UCQfwfsi5VrQ8yKZ-UWmAEFg"], ["Bloomberg", "UCIALMKvObZNtJ6AmdCLP7Lg"], ["NASA TV", "UCLA_DiR1FfKNvjuUpBHmylQ"],
      ["Lofi Girl (music)", "UCSJ4gkVC6NrvII8umztf0Ow"]
    ];
    const box = document.createElement("div");
    box.className = "lv-card"; box.id = "live-tv"; box.style.margin = "0 auto 28px"; box.style.maxWidth = "960px"; box.style.scrollMarginTop = "120px";
    box.innerHTML = `<div class="lv-head"><div><p class="eyebrow" style="margin:0">On now</p><h3>Live TV</h3></div><small class="muted">Free live channels. If one is off air, try another.</small></div>
      <div class="tv-grid">${CH.map(([n, id]) => `<button class="tv-ch" type="button" data-ch="${id}" data-name="${E(n)}"><span class="dot"></span>${E(n)}</button>`).join("")}</div>`;
    stage.before(box);
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ch]"); if (!b) return;
      box.querySelectorAll(".tv-ch").forEach((x) => x.classList.toggle("on", x === b));
      try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {}
      const f = vidView.querySelector("#yt-frame"); f.classList.remove("tall");
      f.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/live_stream?channel=${encodeURIComponent(b.dataset.ch)}&autoplay=1&rel=0" title="${E(b.dataset.name)} live" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      vidView.querySelector("#yt-now").innerHTML = `<b>● ${E(b.dataset.name)}</b><small>Live TV</small>`;
      stage.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
})();
