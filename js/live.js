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

  let wherePromise = null;
  const where = () => { if (!wherePromise) wherePromise = fetch("/api/where").then((r) => r.json()).catch(() => ({})); return wherePromise; };

  /* ---------------- Live radio ---------------- */
  const radioView = document.getElementById("v-radio");
  const lib = radioView && radioView.querySelector("#dj-root");
  if (radioView && lib) {
    const box = document.createElement("div");
    box.className = "lv-card"; box.id = "world-radio"; box.style.scrollMarginTop = "120px";
    box.innerHTML = `<div class="lv-head"><div><p class="eyebrow" style="margin:0">Live from around the world</p><h3>Live Radio Stations</h3></div><small class="muted">Tap a station to listen. Keeps playing when your phone locks.</small></div>
      <div class="lv-chips" id="lv-chips"><button class="chip" type="button" data-local="1" aria-pressed="true">📍 Local</button>${[["hip hop", "Hip Hop"], ["rnb", "R&B"], ["gospel", "Gospel"], ["jazz", "Jazz"], ["reggae", "Reggae"], ["pop", "Top 40"], ["oldies", "Oldies"], ["news", "News"], ["sports", "Sports"], ["islamic", "Islamic"]].map(([t, n]) => `<button class="chip" type="button" data-tag="${t}" aria-pressed="false">${n}</button>`).join("")}</div>
      <form class="lv-form" id="lv-form"><input type="search" id="lv-q" placeholder="Search any station or city (e.g. Hot 97, Pittsburgh)" aria-label="Search radio stations"><button class="btn sm" type="submit">Search</button></form>
      <div class="lv-grid" id="lv-grid"><small class="muted">Loading stations...</small></div>`;
    lib.after(box);
    const API = ["https://de1.api.radio-browser.info", "https://nl1.api.radio-browser.info", "https://at1.api.radio-browser.info"];
    let stations = [], cur = null;
    // live stations get their own player (other stations' servers don't allow the volume booster)
    const liveEl = window.MW_LIVE = new Audio(); liveEl.preload = "none"; liveEl.playsInline = true;
    liveEl.addEventListener("play", () => { try { updIcons(); navigator.mediaSession.playbackState = "playing"; } catch (_) {} });
    liveEl.addEventListener("pause", () => { try { updIcons(); navigator.mediaSession.playbackState = "paused"; } catch (_) {} });
    liveEl.addEventListener("error", () => { if (cur) say("That station isn't answering. Try another one."); });
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
      paint();
    }
    function paint(head) {
      const g = box.querySelector("#lv-grid");
      g.innerHTML = (head ? `<div style="grid-column:1/-1;font-weight:700;color:var(--gold-hi)">${E(head)}</div>` : "") + (stations.length ? stations.map((s, i) => `<button class="lv-st ${cur && cur.stationuuid === s.stationuuid ? "on" : ""}" type="button" data-st="${i}">${/^https:\/\//.test(s.favicon || "") ? `<img src="${E(s.favicon)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=ph>📻</span>'">` : '<span class="ph">📻</span>'}<span><b>${E(s.name.trim())}</b><small>${E([s.state, s.countrycode].filter(Boolean).join(", "))}${s.bitrate ? " · " + s.bitrate + "k" : ""}</small></span></button>`).join("") : '<small class="muted">No stations found. Try another search.</small>');
    }
    async function showLocal() {
      const w = await where(); const g = box.querySelector("#lv-grid");
      if (w && w.lat && w.lon) {
        g.innerHTML = '<small class="muted">Finding stations near ' + E(w.city || "you") + '...</small>';
        let res = await find({ geo_lat: String(w.lat), geo_long: String(w.lon), geo_distance: "120000", limit: "60" });
        if (res.length < 6 && w.region) res = res.concat(await find({ state: w.region, countrycode: w.country || "US", limit: "40" }));
        const seen = new Set(); stations = res.filter((s) => /^https:\/\//.test(s.url_resolved || "") && !seen.has(s.name.trim().toLowerCase()) && seen.add(s.name.trim().toLowerCase())).slice(0, 36);
        paint(stations.length ? "📍 Local stations near " + (w.city || "you") + (w.regionCode ? ", " + w.regionCode : "") : "");
        if (!stations.length) show({ tag: "hip hop" });
      } else show({ tag: "hip hop" });
    }
    box.addEventListener("click", (e) => {
      const lc = e.target.closest("[data-local]");
      if (lc) { box.querySelectorAll("[data-tag],[data-local]").forEach((x) => x.setAttribute("aria-pressed", x === lc)); showLocal(); return; }
      const c = e.target.closest("[data-tag]");
      if (c) { box.querySelectorAll("[data-tag],[data-local]").forEach((x) => x.setAttribute("aria-pressed", x === c)); show({ tag: c.dataset.tag }); return; }
      const b = e.target.closest("[data-st]"); if (!b) return;
      const s = stations[+b.dataset.st]; if (!s) return;
      if (typeof media === "undefined") return;
      if (typeof mode !== "undefined" && mode === "live" && cur && cur.stationuuid === s.stationuuid && !liveEl.paused) { liveEl.pause(); return; }
      cur = s; box.querySelectorAll(".lv-st").forEach((x) => x.classList.toggle("on", x === b));
      try { mode = "live"; curIdx = -1; playTok++; room?.presence({ radio: null }); } catch (_) {}
      try { media.pause(); } catch (_) {}
      liveEl.src = s.url_resolved; liveEl.play().catch(() => say("That station isn't answering. Try another one."));
      const t = { title: s.name.trim(), artist: [s.state, s.country].filter(Boolean).join(", ") || "Live radio", cover: /^https:\/\//.test(s.favicon || "") ? s.favicon : "" };
      try { showBar(t, "LIVE RADIO · " + (s.countrycode || "")); renderTracks && renderTracks(); document.getElementById("pb-time").textContent = "● LIVE"; document.getElementById("pb-fill").style.width = "100%"; } catch (_) {}
      try { fetch(API[0] + "/json/url/" + s.stationuuid).catch(() => {}); } catch (_) {}
    });
    box.querySelector("#lv-form").addEventListener("submit", (e) => { e.preventDefault(); const q = box.querySelector("#lv-q").value.trim(); if (!q) return; box.querySelectorAll("[data-tag],[data-local]").forEach((x) => x.setAttribute("aria-pressed", "false")); show({ name: q }); });
    let loaded = false;
    const maybe = () => { if (!loaded && !radioView.hidden) { loaded = true; showLocal(); } };
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
      <div><b id="tv-local-h" style="color:var(--gold-hi)">📍 Local news</b> <form id="tv-place" style="display:inline-flex;gap:6px;margin-left:6px"><input type="search" id="tv-q" placeholder="Other city" aria-label="City for local TV" style="width:140px;background:var(--ink);border:1px solid var(--line);border-radius:999px;padding:6px 12px;color:var(--text);font:16px var(--body)"><button class="btn ghost sm" type="submit">Go</button></form></div>
      <div class="tv-grid" id="tv-pgh"></div>
      <div class="tv-grid" id="tv-local"><small class="muted">Finding live local news...</small></div>
      <b style="color:var(--gold-hi)">🌎 National & world · live now</b>
      <div class="tv-grid" id="tv-nat"><small class="muted">Checking which channels are live...</small></div>
      <b style="color:var(--gold-hi)">📺 More live channels</b>
      <div class="lv-chips" id="tv-cats">${[["news", "News"], ["sports", "Sports"], ["music", "Music"], ["hip hop", "Hip Hop"], ["comedy", "Comedy"], ["kids cartoons", "Kids"], ["gospel church", "Gospel"], ["islamic quran", "Islamic"], ["nature animals", "Nature"], ["gaming", "Gaming"], ["weather", "Weather"]].map(([q, n]) => `<button class="chip" type="button" data-cat="${E(q)}" aria-pressed="false">${n}</button>`).join("")}</div>
      <div class="tv-grid" id="tv-cat"></div>
      <b style="color:var(--gold-hi)">🎬 Free movies</b>
      <div class="lv-chips" id="tv-mg">${[["", "Popular"], ["action", "Action"], ["comedy", "Comedy"], ["drama", "Drama"], ["horror", "Horror"], ["thriller", "Thriller"], ["family", "Family"], ["western", "Western"], ["black cinema", "Black Cinema"], ["classic", "Classics"]].map(([g, n], i) => `<button class="chip" type="button" data-mg="${E(g)}" aria-pressed="${i === 0}">${n}</button>`).join("")}</div>
      <div class="mv-grid" id="tv-movies"><small class="muted">Loading free movies...</small></div>`;
    stage.before(box);
    const mvCss = document.createElement("style"); mvCss.textContent = `.mv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.mv{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#0c0a07;color:var(--text);cursor:pointer;padding:0;text-align:left}.mv img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}.mv span{display:block;padding:6px 8px;font:600 12.5px var(--body);line-height:1.3;max-height:3.9em;overflow:hidden}.mv small{display:block;padding:0 8px 8px;color:var(--muted);font-size:11px}`; document.head.appendChild(mvCss);
    const btn = (v, label) => `<button class="tv-ch" type="button" data-vid="${E(v.id)}" data-name="${E(label || v.channel || v.title)}" title="${E(v.title || "")}"><span class="dot"></span>${E(String(label || v.channel || v.title).slice(0, 34))}</button>`;
    async function national() {
      const el = box.querySelector("#tv-nat");
      const j = await fetch("/api/yt?mode=channels&ids=" + CH.map((c) => c[1]).join(",")).then((r) => r.json()).catch(() => ({ list: [] }));
      const live = (j.list || []).filter((x) => x.live && x.ok);
      el.innerHTML = live.length ? live.map((x) => btn({ id: x.id }, (CH.find((c) => c[1] === x.channel) || [])[0])).join("") : '<small class="muted">None of the national channels are live this minute. Try More live channels below.</small>';
    }
    async function cat(q, chip) {
      box.querySelectorAll("#tv-cats .chip").forEach((x) => x.setAttribute("aria-pressed", x === chip));
      const el = box.querySelector("#tv-cat"); el.innerHTML = '<small class="muted">Finding live channels...</small>';
      const j = await fetch("/api/yt?mode=live&q=" + encodeURIComponent(q)).then((r) => r.json()).catch(() => ({ list: [] }));
      el.innerHTML = (j.list || []).length ? j.list.map((v) => btn(v)).join("") : '<small class="muted">Nothing live in that category right now. Try another.</small>';
    }
    async function movies(g, chip) {
      if (chip) box.querySelectorAll("#tv-mg .chip").forEach((x) => x.setAttribute("aria-pressed", x === chip));
      const el = box.querySelector("#tv-movies"); el.innerHTML = '<small class="muted">Loading free movies...</small>';
      const j = await fetch("/api/yt?mode=movies&genre=" + encodeURIComponent(g || "")).then((r) => r.json()).catch(() => ({ list: [] }));
      el.innerHTML = (j.list || []).length ? j.list.map((v) => `<button class="mv" type="button" data-vid="${E(v.id)}" data-name="${E(v.title)}" data-movie="1"><img src="https://i.ytimg.com/vi/${E(v.id)}/hqdefault.jpg" alt="" loading="lazy"><span>${E(v.title)}</span><small>${E(v.len)} · ${E(v.channel)}</small></button>`).join("") : '<small class="muted">No free movies found for that one. Try another genre.</small>';
    }
    box.querySelector("#tv-cats").addEventListener("click", (e) => { const c = e.target.closest("[data-cat]"); if (c) cat(c.dataset.cat, c); });
    box.querySelector("#tv-mg").addEventListener("click", (e) => { const c = e.target.closest("[data-mg]"); if (c) movies(c.dataset.mg, c); });
    // Pittsburgh stations by name (shown to everyone in Meechie's area, and anyone can tap them)
    const PGH = [["KDKA · CBS 2", "KDKA CBS News Pittsburgh", "kdka|cbs news pittsburgh|cbs pittsburgh", "https://www.cbsnews.com/pittsburgh/"],
      ["WTAE · ABC 4", "WTAE Pittsburgh's Action News 4", "wtae|action news 4", "https://www.wtae.com/"],
      ["WPXI · NBC 11", "WPXI Channel 11 News", "wpxi|channel 11", "https://www.wpxi.com/"],
      ["WPGH · FOX 53", "FOX 53 Pittsburgh WPGH", "wpgh|fox 53", "https://fox53pittsburgh.com/"],
      ["WPCW · CW 19", "CW Pittsburgh WPCW", "wpcw|cw pittsburgh|cw 19", "https://www.cbsnews.com/pittsburgh/"],
      ["WQED · PBS 13", "WQED Pittsburgh", "wqed", "https://www.wqed.org/"]];
    box.querySelector("#tv-pgh").innerHTML = `<b style="width:100%;color:var(--gold-hi)">🏙️ Pittsburgh channels</b>` + PGH.map(([n, q, m, site]) => `<button class="tv-ch" type="button" data-st="${E(q)}" data-match="${E(m)}" data-site="${E(site)}" data-name="${E(n)}"><span class="dot"></span>${E(n)}</button>`).join("");
    async function localTV(place) {
      const el = box.querySelector("#tv-local"); el.innerHTML = '<small class="muted">Finding live local news...</small>';
      const j = await fetch("/api/localtv" + (place ? "?place=" + encodeURIComponent(place) : "")).then((r) => r.json()).catch(() => ({ list: [] }));
      box.querySelector("#tv-local-h").textContent = "📍 Local news" + (j.place && j.place !== "local" ? " · " + j.place : "");
      el.innerHTML = (j.list || []).length ? j.list.map((v) => `<button class="tv-ch" type="button" data-vid="${E(v.id)}" data-name="${E(v.channel || v.title)}" title="${E(v.title)}"><span class="dot"></span>${E((v.channel || v.title).slice(0, 34))}</button>`).join("") : '<small class="muted">No local stations are live right now. Local news usually streams around 6 AM, noon, 5–6 PM and 11 PM.</small>';
    }
    box.querySelector("#tv-place").addEventListener("submit", (e) => { e.preventDefault(); const q = box.querySelector("#tv-q").value.trim(); if (q) localTV(q); });
    let tvLoaded = false; const tvMaybe = () => { if (!tvLoaded && !vidView.hidden) { tvLoaded = true; localTV(); national(); movies(""); } };
    new MutationObserver(tvMaybe).observe(vidView, { attributes: true, attributeFilter: ["hidden"] }); tvMaybe();
    box.addEventListener("click", async (e) => {
      const stb = e.target.closest("[data-st]");
      if (stb) {
        stb.disabled = true; const old = stb.innerHTML; stb.innerHTML = "Checking...";
        const j = await fetch("/api/localtv?station=" + encodeURIComponent(stb.dataset.st) + "&match=" + encodeURIComponent(stb.dataset.match)).then((r) => r.json()).catch(() => ({ list: [] }));
        stb.disabled = false; stb.innerHTML = old;
        if (j.list && j.list[0]) { const fake = document.createElement("button"); fake.dataset.vid = j.list[0].id; fake.dataset.name = stb.dataset.name; return playVid(fake, stb); }
        const near = box.querySelector("#tv-local [data-vid]");
        say(stb.dataset.name + " isn't live right now (local news streams around 6 AM, noon, 5–6 PM and 11 PM)." + (near ? " Playing the nearest live local news instead." : ""));
        if (near) return playVid(near, near);
        return;
      }
      const lv = e.target.closest("[data-vid]");
      if (lv) return playVid(lv, lv);
      return chanClick(e);
    });
    function playVid(lv, btn) {
      {
        box.querySelectorAll(".tv-ch").forEach((x) => x.classList.toggle("on", x === btn));
        try { if (typeof media !== "undefined" && !media.paused) media.pause(); if (window.MW_LIVE && !MW_LIVE.paused) MW_LIVE.pause(); } catch (_) {}
        const f = vidView.querySelector("#yt-frame"); f.classList.remove("tall");
        f.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(lv.dataset.vid)}?autoplay=1&rel=0" title="${E(lv.dataset.name)} live" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
        vidView.querySelector("#yt-now").innerHTML = `<b>${lv.dataset.movie ? "🎬" : "●"} ${E(lv.dataset.name)}</b><small>${lv.dataset.movie ? "Free movie" : "Live TV"}</small>`;
        stage.scrollIntoView({ behavior: "smooth", block: "start" }); return;
      }
    }
    function chanClick(e) {
      const b = e.target.closest("[data-ch]"); if (!b) return;
      box.querySelectorAll(".tv-ch").forEach((x) => x.classList.toggle("on", x === b));
      try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {}
      const f = vidView.querySelector("#yt-frame"); f.classList.remove("tall");
      f.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/live_stream?channel=${encodeURIComponent(b.dataset.ch)}&autoplay=1&rel=0" title="${E(b.dataset.name)} live" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      vidView.querySelector("#yt-now").innerHTML = `<b>● ${E(b.dataset.name)}</b><small>Live TV</small>`;
      stage.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
})();
