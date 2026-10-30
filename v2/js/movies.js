/* v2 CINEMA (Phase 5) — the live js/movies.js, ported: Meechie's
   World Cinema inside the TV view. The same public-domain shelves
   from the Internet Archive (famous PD classics by name, pre-1930
   features, Sci-Fi & Horror, the Prelinger Vault, pre-1950
   cartoons, and the holiday shelves built from the same sets),
   the same in-set search, playing on the page. Nothing here
   touches the radio or the decks, as live. */
import { videoSound } from "../platform.js";
import { getEngine } from "../engine.js";

export function mountMovies(viewRoot, ctx) {
  const vs = videoSound(getEngine(ctx));

  "use strict";
  const $ = (s) => viewRoot.querySelector(s);
  const E = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const IA = "https://archive.org";
  const FAME = [
    ["Night.Of.The.Living.Dead_1080p", "Night of the Living Dead (1968)"],
    ["plan-9-from-outer-space", "Plan 9 from Outer Space (1959)"],
    ["Nosferatu1922", "Nosferatu (1922)"],
    ["Metropolis1927EnglishVersion", "Metropolis (1927)"],
    ["thecabinetofdrcaligari", "The Cabinet of Dr. Caligari (1920)"],
    ["TheLittleShopOfHorrors1960_765", "The Little Shop of Horrors (1960)"],
    ["CarnivalofSouls", "Carnival of Souls (1962)"],
    ["reefer_madness1938", "Reefer Madness (1936)"],
    ["BattleshipPotemkin", "Battleship Potemkin (1925)"],
    ["ThePhantomoftheOpera", "The Phantom of the Opera (1925)"],
    ["silent-safety-last", "Safety Last! (1923)"],
    ["his_girl_friday", "His Girl Friday (1940)"],
    ["TheGeneral1926", "The General (1926)"],
    ["HouseOnHauntedHill1959", "House on Haunted Hill (1959)"],
    ["TheLastManOnEarth_72", "The Last Man on Earth (1964)"],
  ];
  const SHELVES = {
    classics: { q: "collection:feature_films AND mediatype:movies AND year:[1000 TO 1929]", label: "Silent-Era Classics" },
    scifi: { q: "collection:SciFi_Horror AND mediatype:movies", label: "Sci-Fi & Horror classics" },
    prelinger: { q: "collection:prelinger AND mediatype:movies", label: "The Prelinger Vault — vintage films & ads, all public domain" },
    cartoons: { q: "collection:animationandcartoons AND mediatype:movies AND year:[1000 TO 1949]", label: "Classic Cartoons" },
  };
  const SEARCH_SET = "(collection:prelinger OR collection:SciFi_Horror OR collection:animationandcartoons OR (collection:feature_films AND year:[1000 TO 1929]))";
  const kwQ = (words) => { const kw = words.join(" OR "); return `(title:(${kw}) OR description:(${kw})) AND mediatype:movies AND ${SEARCH_SET}`; };
  SHELVES.halloween = { q: kwQ(["halloween", "horror", "ghost", "haunted", "vampire", "zombie", "witch", "terror", "demon", "monster", "dracula", "frankenstein", "mummy", "werewolf"]), label: "Halloween horror & spooky classics" };
  SHELVES.thanksgiving = { q: kwQ(["thanksgiving", "turkey", "pilgrim", "harvest"]), label: "Thanksgiving films, cartoons & vintage specials" };
  SHELVES.christmas = { q: kwQ(["christmas", "santa", "scrooge", "rudolph", "noel"]), label: "Christmas films, cartoons & vintage specials" };
  let cur = { mode: "fame", q: "", page: 1 }, busy = false;

  async function iaSearch(q, page) {
    const p = new URLSearchParams();
    p.set("q", q);
    ["identifier", "title", "year"].forEach((f) => p.append("fl[]", f));
    p.append("sort[]", "downloads desc");
    p.set("rows", "24"); p.set("page", String(page)); p.set("output", "json");
    const r = await fetch(IA + "/advancedsearch.php?" + p.toString());
    const j = await r.json();
    return j.response || { docs: [], numFound: 0 };
  }
  const card = (d) => `<button class="mv-card" type="button" data-mv="${E(d.identifier)}" data-mvt="${E(d.title || d.identifier)}" style="text-align:left;background:#0d0b08;border:1px solid var(--gold-lo);border-radius:12px;padding:8px;cursor:pointer;color:inherit;font:inherit"><img loading="lazy" decoding="async" onerror="this.style.display='none'" src="${IA}/services/img/${E(d.identifier)}" alt="" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;background:#000"><b style="display:block;font-size:13px;margin-top:6px;line-height:1.3">${E(d.title || d.identifier)}</b>${d.year ? `<small class="muted">${E(d.year)}</small>` : ""}</button>`;

  /* SPEED + POLISH (2026-10-29): the shelf never sits as a silent void.
   * While a shelf or search loads, skeleton cards shimmer in the grid; a
   * failed fetch gets an honest line with a working Try again button
   * (data-mv-retry, wired in the click handler below); an empty shelf says
   * so in the same framed note. The Hall of Fame paints instantly from
   * local data, exactly as before. */
  const SKEL = '<div class="mv-skel" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line" style="width:55%"></div></div>';
  const skelHTML = (n) => '<div class="mv-note"><b>🍿 Loading the shelves…</b>Free movies are on the way — this only takes a moment.</div>' + SKEL.repeat(n || 8);
  const errHTML = '<div class="mv-note"><b>🍿 The movie vault did not answer</b>The free-movie library is not responding right now.<br><button class="btn ghost sm" type="button" data-mv-retry style="margin-top:10px">↻ Try again</button></div>';
  const emptyHTML = '<div class="mv-note"><b>🍿 Nothing on this shelf matches</b>Try another shelf, or search a different title.</div>';
  async function load(append) {
    if (busy) return; busy = true;
    const grid = $("#mv-grid"), count = $("#mv-count"), more = $("#mv-more");
    try {
      if (cur.mode === "fame") {
        grid.innerHTML = FAME.map(([id, t]) => card({ identifier: id, title: t })).join("");
        count.textContent = "⭐ The Hall of Fame — the most famous free films ever made, ready to watch.";
        more.hidden = true;
        return;
      }
      if (!append) { grid.innerHTML = skelHTML(8); count.textContent = "Loading the shelves…"; more.hidden = true; }
      else grid.insertAdjacentHTML("beforeend", '<div id="mv-skel-row" style="display:contents">' + SKEL.repeat(4) + "</div>");
      const res = await iaSearch(cur.q, cur.page);
      const docs = (res.docs || []).filter((d) => d && d.identifier);
      const html = docs.map(card).join("");
      if (append) { const sk = $("#mv-skel-row"); if (sk) sk.remove(); grid.insertAdjacentHTML("beforeend", html); }
      else grid.innerHTML = html || emptyHTML;
      count.textContent = cur.mode === "search" ? `${res.numFound.toLocaleString()} free movies match your search` : `${res.numFound.toLocaleString()} free movies on this shelf`;
      more.hidden = docs.length < 24;
    } catch (_) {
      const sk = $("#mv-skel-row"); if (sk) sk.remove();
      if (!append) { grid.innerHTML = errHTML; count.textContent = "The movie vault did not answer — tap Try again."; }
    } finally { busy = false; }
  }

  async function play(id, title) {
    const stage = $("#mv-stage"), frame = $("#mv-frame"), ttl = $("#mv-title");
    stage.hidden = false; ttl.textContent = title + " — loading...";
    frame.innerHTML = '<div style="aspect-ratio:16/9;background:#000;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#c9a227">Loading the film...</div>';
    stage.scrollIntoView({ behavior: "smooth", block: "start" });
    let src = "";
    try {
      const r = await fetch(IA + "/metadata/" + encodeURIComponent(id));
      const j = await r.json();
      const files = (j.files || []).filter((f) => /\.(mp4|m4v|ogv|webm)$/i.test(f.name || "") && !/thumb|sample|trailer/i.test(f.name || ""));
      files.sort((a, b) => (parseFloat(b.size) || 0) - (parseFloat(a.size) || 0));
      const pick = files.find((f) => /\.mp4$/i.test(f.name) && (parseFloat(f.size) || 0) <= 9e8) || files.find((f) => /\.mp4$/i.test(f.name)) || files[0];
      if (pick) src = IA + "/download/" + encodeURIComponent(id) + "/" + encodeURIComponent(pick.name);
    } catch (_) {}
    ttl.textContent = title;
    if (src) {
      frame.innerHTML = `<video controls playsinline autoplay src="${src}" style="width:100%;aspect-ratio:16/9;border-radius:12px;background:#000"></video>`;
    } else {
      frame.innerHTML = `<iframe src="${IA}/embed/${encodeURIComponent(id)}" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000"></iframe>`;
    }
  }

  // the cinema is its own TV view: load the first shelf the first time the
  // view is opened (the router unhides the section when you tap the TV tab)
  let kicked = false;
  const kick = () => { if (kicked) return; kicked = true; load(false); };
  const tvSec = viewRoot;
  if (tvSec && window.MutationObserver) new MutationObserver(kick).observe(tvSec, { attributes: true, attributeFilter: ["hidden"] });

  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-go="tv"]')) setTimeout(kick, 80);
    const sh = e.target.closest(".mv-shelf");
    if (sh) {
      document.querySelectorAll(".mv-shelf").forEach((b) => b.classList.toggle("ghost", b !== sh));
      const k = sh.dataset.shelf;
      cur = k === "fame" ? { mode: "fame", q: "", page: 1 } : { mode: "shelf", q: SHELVES[k].q, page: 1 };
      load(false); return;
    }
    const c = e.target.closest("[data-mv]"); if (c) { play(c.dataset.mv, c.dataset.mvt || ""); return; }
    if (e.target.closest("[data-mv-retry]")) { load(false); return; }
    if (e.target.closest("#mv-more")) { cur.page++; load(true); return; }
    if (e.target.closest("#mv-close")) { $("#mv-frame").innerHTML = ""; $("#mv-stage").hidden = true; }
  });
  const form = $("#mv-form");
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    const terms = $("#mv-q").value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").trim();
    if (!terms) return;
    document.querySelectorAll(".mv-shelf").forEach((b) => b.classList.add("ghost"));
    cur = { mode: "search", q: `(title:(${terms}) OR description:(${terms})) AND mediatype:movies AND ${SEARCH_SET}`, page: 1 };
    load(false);
  });
  kick();

  return () => { try { vs.end(); } catch (_) {} };
}
