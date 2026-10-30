/* ============================================================================
   v2 HOME VIEW — visual parity with the live #v-home (Law 0).
   Same sections, same order, same classes, same copy, same assets as the
   live home at main 1be5b8fe — reproduced as clean structured markup
   (the live view's inline #home2-styles live in css/home.css, scoped to
   this module as .view-home).

   Live-data fills (same live backend, read-only):
   - #home-live + #home-now-air: the shared radio/dj station document.
   - #home-now-online: /api/station presence (via core).
   - #home-now-shop: /api/store (verified Printify feed, PHASE1-VERIFY).
   The Originals row and the TikTok grid render their live pre-JS states
   (empty row / "Loading…" line); their data modules land in later phases.
   ============================================================================ */

function onAirTitle(S) {
  if (!S) return "";
  for (const d of ["A", "B", "C", "D"]) {
    if (S[d] && S[d].playing && S[d].title) return S[d].title;
  }
  const vm = S.vmix;
  if (vm && vm.a && S[vm.a] && S[vm.a].title) return S[vm.a].title;
  return "";
}

const MARKUP = `
<div class="wrap">
  <section class="lux-hero" aria-label="Welcome to Meechie's World">
    <div class="crestimg"></div>
    <div class="eyebrow">Ideas · Business · Legacy</div>
    <h1 class="lux-foil">Meechies World</h1>
    <p class="inc">INC.</p>
    <p class="tag">Same Vision · Bigger Moves</p>
    <div class="pillars"><span>Business</span><span>Mindset</span><span>Wealth</span><span>Family</span><span>Community</span></div>
    <div class="cta-row">
      <a class="btn" href="#community" data-go="community">Join Meechie's Book — free</a>
      <a class="btn ghost" href="#shop" data-go="shop">Shop the movement</a>
      <a class="btn ghost" href="#services" data-go="services">Our services</a>
    </div>
  </section>

  <!-- Live station bar: filled from the shared station state when live -->
  <section id="home-live" hidden></section>

  <div class="section-head">
    <div>
      <div class="eyebrow">Inside the platform</div>
      <h2>Everything in one world</h2>
      <p class="muted">Pick a lane — the radio, the games, the shop, the books. Every room is one tap away.</p>
    </div>
  </div>
  <div class="home-jump-grid">
    <a class="home-card" href="#radio" data-go="radio"><span class="home-card-ic">🎧</span><span class="home-card-t">Live Radio &amp; DJ Battles</span><span class="home-card-d">Listen live and watch DJs battle</span></a>
    <a class="home-card" href="#live" data-go="live"><span class="home-card-ic">📡</span><span class="home-card-t">Go Live</span><span class="home-card-d">Stream and watch live rooms</span></a>
    <a class="home-card" href="#games" data-go="games"><span class="home-card-ic">🎰</span><span class="home-card-t">Coin Jackpot</span><span class="home-card-d">Win the community prize</span></a>
    <a class="home-card" href="#shop" data-go="shop"><span class="home-card-ic">🛍️</span><span class="home-card-t">Shop the Drop</span><span class="home-card-d">New gear and movement pieces</span></a>
    <a class="home-card" href="#community" data-go="community"><span class="home-card-ic">📖</span><span class="home-card-t">Meechie's Book</span><span class="home-card-d">The community feed</span></a>
    <a class="home-card" href="#tv" data-go="tv"><span class="home-card-ic">🎬</span><span class="home-card-t">Cinema &amp; TV</span><span class="home-card-d">Free movies, shows and videos</span></a>
    <a class="home-card" href="#mwtv" data-go="mwtv"><span class="home-card-ic">📺</span><span class="home-card-t">MW TV</span><span class="home-card-d">The shop TV channel — watch it big</span></a>
    <a class="home-card" href="#contact" data-go="contact"><span class="home-card-ic">🏠</span><span class="home-card-t">We Remodel Houses</span><span class="home-card-d">Free estimates — kitchens, baths, full homes</span></a>
    <button class="home-card home-card-btn" type="button" data-ai-open><span class="home-card-ic">🤖</span><span class="home-card-t">Ask Meechie AI</span><span class="home-card-d">Questions, help and ideas</span></button>
    <div class="home-card"><span class="home-card-ic">📱</span><span class="home-card-t">Get the Apps</span><span class="home-card-d"><a href="../radio-app/">📻 Radio app</a> · <a href="../ai-app/">🎙️ Meechie AI app</a></span></div>
  </div>

  <!-- Right now inside Meechie's World: filled from live state -->
  <section id="home-now" hidden>
    <div id="home-now-air" class="home-now-block"></div>
    <div id="home-now-online" class="home-now-block"></div>
    <div id="home-now-shop" class="home-now-block"></div>
  </section>

  <div class="feat-vid">
    <video id="fv" poster="/media/the-world-gone-be.jpg" preload="none" playsinline muted loop><source src="/m/media/e5aaace5-4272-4817-8f3c-883b24006026/4970054c6ef54b42881c.bin" type="video/mp4"><source src="/media/the-world-gone-be.mp4" type="video/mp4"></video>
    <button id="fv-snd" type="button">🔇 Tap for sound</button>
    <div class="feat-vid-cap"><div class="eyebrow">New from Halal Music</div><b>The World Gone Be What The World Gone Be</b></div>
  </div>

  <section class="hero">
    <div class="pillar-col" aria-hidden="true"><svg class="pillar"><use href="#pillar"/></svg><b>B</b></div>
    <div class="hero-center">
      <svg class="crest" viewBox="0 0 300 340" role="img" aria-label="Meechie's World crest"><use href="#crest-full"/></svg>
      <div class="eyebrow">Est. Meechie's World Inc</div>
      <h1>Meechie's World</h1>
      <p class="motto">CONSCIENTIA</p>
      <p class="latin">Lux e tenebris · Ordo ab chao · Fructus ex labore · Veritas vos liberabit</p>
      <p class="lead">Where ideas turn into ownership — music, media, AI, legal help, books, apparel,
      and a community building wealth together. Free to join. Yours to build on.</p>
      <div class="cta-row">
        <a class="btn" href="#community" data-go="community">Join the community — free</a>
        <a class="btn ghost" href="#services" data-go="services">See our services</a>
      </div>
      <p class="latin">Fides · Familia · Fortuna — "Conscience in every creation.
      From struggle to legacy."</p>
    </div>
    <div class="pillar-col" aria-hidden="true"><svg class="pillar"><use href="#pillar"/></svg><b>J</b></div>
  </section>

  <div class="ticker" aria-hidden="true"><div class="ticker-in">
    <span>Custom Printing</span><span>Apparel Design</span><span>Branding</span><span>Artist Development</span><span>Photography</span><span>Video Production</span><span>Music Publishing</span><span>Business Strategy</span><span>Digital Marketing</span><span>Entertainment</span><span>Community</span><span>Legacy Building</span>
    <span>Custom Printing</span><span>Apparel Design</span><span>Branding</span><span>Artist Development</span><span>Photography</span><span>Video Production</span><span>Music Publishing</span><span>Business Strategy</span><span>Digital Marketing</span><span>Entertainment</span><span>Community</span><span>Legacy Building</span>
  </div></div>

  <section class="lux-wall" aria-label="Meechies World Inc — the movement">
    <div class="lux-wall-head">
      <div class="eyebrow">Meechies World Inc</div>
      <h2 class="lux-foil">The Movement</h2>
    </div>
    <div class="lux-strip">
      <a href="#shop" data-go="shop" style="background-image:url(/img/lux/p-hat.jpg)" aria-label="Meechie's World snapback"></a>
      <a href="#shop" data-go="shop" style="background-image:url(/img/lux/p-tee.jpg)" aria-label="Meechie's World tee"></a>
      <a href="#shop" data-go="shop" style="background-image:url(/img/lux/p-crew.jpg)" aria-label="Meechie's World crewneck"></a>
      <a href="#shop" data-go="shop" style="background-image:url(/img/lux/p-hoodie.jpg)" aria-label="Meechie's World hoodie"></a>
      <a href="#shop" data-go="shop" style="background-image:url(/img/lux/p-sweats.jpg)" aria-label="Meechie's World sweats"></a>
      <a href="#shop" data-go="shop" style="background-image:url(/img/lux/p-tee2.jpg)" aria-label="Meechie's World tee, second look"></a>
      <a href="#shop" data-go="shop" style="background-image:url(/img/lux/p-chain.jpg)" aria-label="Meechie's World chain"></a>
      <a href="#shop" data-go="shop" style="background-image:url(/img/lux/p-kids.jpg)" aria-label="Meechie's World kids tee"></a>
      <a href="#shop" data-go="shop" style="background-image:url(/img/lux/p-full.jpg)" aria-label="Meechie's World full look"></a>
      <a href="#community" data-go="community" style="background-image:url(/img/lux/p-sign.jpg)" aria-label="Join the movement"></a>
    </div>
  </section>

  <div class="stats">
    <div class="stat"><b>9</b><span>Divisions</span></div>
    <div class="stat"><b>$0</b><span>To join and chat</span></div>
    <div class="stat"><b>$0</b><span>Community ads</span></div>
    <div class="stat"><b>$50</b><span>Services start at</span></div>
  </div>

  <section class="mw-launchpad" aria-label="Choose your next step">
    <div class="mw-launchpad-head">
      <div><span class="eyebrow">Find your path</span><h2>What brings you to Meechie's World?</h2></div>
      <p class="muted">Start with the lane that fits today. Everything here stays under one account and one brand.</p>
    </div>
    <div class="mw-path-grid">
      <a class="mw-path" href="#legal" data-go="legal">
        <div class="mw-path-art" aria-hidden="true"><span>§</span></div>
        <div class="mw-path-copy"><small>Path 01</small><b>Legal Help</b><em>Document preparation, deadlines, and clear next steps without the mystery.</em><strong>Explore legal help →</strong></div>
      </a>
      <a class="mw-path" href="#services" data-go="services">
        <div class="mw-path-art" aria-hidden="true"><span>✦</span></div>
        <div class="mw-path-copy"><small>Path 02</small><b>Creative Services</b><em>Design, printing, media, and brand work for people building something real.</em><strong>See services →</strong></div>
      </a>
      <a class="mw-path" href="#community" data-go="community">
        <div class="mw-path-art" aria-hidden="true"><span>◉</span></div>
        <div class="mw-path-copy"><small>Path 03</small><b>Community</b><em>Meet the community, follow the movement, and join the conversation free.</em><strong>Enter the community →</strong></div>
      </a>
      <a class="mw-path" href="#exclusives" data-go="exclusives">
        <div class="mw-path-art" aria-hidden="true"><span>◆</span></div>
        <div class="mw-path-copy"><small>Path 04</small><b>Meechies Exclusives</b><em>Premium drops, members-only experiences, and pieces you will not find twice.</em><strong>Unlock exclusives →</strong></div>
      </a>
    </div>
  </section>

  <section class="card" aria-label="Meechie's World Originals">
    <div class="section-head"><div><div class="eyebrow">Meechie's World</div><h2>🎬 Originals</h2><p class="muted">Shows made right here — watch them free.</p></div></div>
    <div data-originals></div>
  </section>

  <section class="card" aria-label="Meechie on TikTok">
    <div class="section-head">
      <div><div class="eyebrow">@meechiesworldinc</div><h2>🎵 Meechie on TikTok</h2></div>
      <a class="btn sm" href="https://www.tiktok.com/@meechiesworldinc" target="_blank" rel="noopener">Follow on TikTok</a>
    </div>
    <div id="home-tt-grid"><p class="muted">Loading Meechie's TikToks…</p></div>
  </section>

  <div class="section-head">
    <div>
      <h2>The divisions</h2>
      <p class="muted">Tap a world to enter it. Everything is free to explore.</p>
    </div>
  </div>
  <div class="bento">
    <a class="tile t-radio" href="#dj" data-go="dj"><span class="live-dot">● Live now</span><div class="vinyl" aria-hidden="true"></div><h3>🎧 Live Radio</h3><p>Meechie's World Radio — tap to listen live, see what's playing, and step into the DJ booth.</p></a>
    <a class="tile t-world" href="#world" data-go="world"><div class="world-art" aria-hidden="true"></div><h3>🌐 Virtual World</h3><p>Dress up your character and hang out with the community.</p></a>
    <a class="tile" href="#community" data-go="community"><h3>📖 Meechie's Book</h3><p>The community feed — post, talk, gift, and build with everybody.</p></a>
    <a class="tile" href="#chat" data-go="chat"><h3>🎙️ Chat &amp; Walkie-Talkie</h3><p>Channels for every topic, plus voice clips.</p></a>
    <a class="tile" href="#live" data-go="live"><h3>🔴 Go Live</h3><p>Stream from your camera — or watch Meechie and friends live.</p></a>
    <a class="tile" href="#ads" data-go="ads"><h3>🏪 Shops &amp; Free Ads</h3><p>Local businesses, free to list.</p></a>
    <a class="tile wide" href="#promote" data-go="promote"><h3>📣 Promote With Us</h3><p>Spotlight, Featured &amp; Takeover campaigns — get your business in front of the whole community, from $50.</p></a>
    <a class="tile wide" href="#radio" data-go="radio"><h3>🤖 Meechie's AI</h3><p>Ask Meechie anything — business, lyrics, ideas, math, the site. Free for members.</p></a>
  </div>

  <section class="card support" data-paybox hidden aria-label="Support Meechie's World">
    <svg class="sqc" viewBox="0 0 64 64" aria-hidden="true"><use href="#sqc"/></svg>
    <div>
      <h3>Support Meechie's World</h3>
      <p class="muted">Every contribution keeps the radio on and the books free.</p>
    </div>
    <a class="btn" href="#services" data-go="services">Donate</a>
  </section>

  <div class="roadmap">
    <div class="section-head">
      <div>
        <div class="eyebrow">Coming with the public launch</div>
        <h2>Security &amp; more</h2>
      </div>
    </div>
    <div class="roadmap-grid">
      <div>🔒 Login with passkeys</div>
      <div>📅 Online event invites</div>
      <div>🤝 Creator storefronts</div>
      <div>🎓 Free business courses</div>
      <div>🎮 More games &amp; markets</div>
    </div>
  </div>
</div>`;

let io = null;

export function render(root, ctx) {
  root.innerHTML = MARKUP;

  // "Ask Meechie AI" card — the AI panel is a later-phase module.
  root.querySelector("[data-ai-open]").addEventListener("click", (e) => {
    const d = e.currentTarget.querySelector(".home-card-d");
    if (d) d.textContent = "Meechie AI arrives in a later phase of the new build — it is live on the main site today.";
  });

  /* Featured video — the live rule (appnav): autoplays MUTED when more
     than half visible while Home is showing; sound is the visitor's tap.
     On the live site, unmuting also rests the station player; the v2
     player arrives with the station module (Phase 2), which will take
     over this hook. */
  const fv = root.querySelector("#fv");
  const snd = root.querySelector("#fv-snd");
  if (fv && "IntersectionObserver" in window) {
    io = new IntersectionObserver((es) => {
      for (const en of es) {
        if (en.intersectionRatio >= 0.5) fv.play().catch(() => {});
        else if (!fv.paused) fv.pause();
      }
    }, { threshold: [0.5] });
    io.observe(fv);
  }
  if (snd && fv) snd.addEventListener("click", () => {
    fv.muted = !fv.muted;
    if (!fv.muted) fv.play().catch(() => {});
    snd.textContent = fv.muted ? "🔇 Tap for sound" : "🔊 Sound on";
  });

  fillLive(ctx);
}

export function destroy() {
  if (io) { io.disconnect(); io = null; }
}

async function fillLive(ctx) {
  const S = await ctx.gateway.readStation().catch(() => null);
  const liveEl = document.getElementById("home-live");
  const nowEl = document.getElementById("home-now");
  const air = document.getElementById("home-now-air");
  const onl = document.getElementById("home-now-online");
  const shop = document.getElementById("home-now-shop");
  if (!liveEl || !air || !onl || !shop) return; // navigated away while loading
  const title = onAirTitle(S);
  if (S && S.live) {
    liveEl.hidden = false;
    liveEl.innerHTML = `<span class="hl-dot" aria-hidden="true"></span>
      <span class="hl-tx"><b>🔴 Meechie's World Radio is LIVE</b>${title ? `<span class="muted"> — now playing: ${esc(title)}</span>` : ""}</span>
      <a class="btn sm" href="#radio" data-go="radio">🎧 Tune in</a>`;
    air.innerHTML = `<span class="hn-ic">🎧</span><div><small>NOW ON AIR</small><b>${title ? esc(title) : "Meechie's World Radio"}</b></div>`;
  }
  const p = ctx.presence && ctx.presence.last;
  if (p && typeof p.online === "number") {
    onl.innerHTML = `<span class="hn-ic">👥</span><div><small>ONLINE NOW</small><b>${p.online} here${typeof p.listening === "number" ? ` · ${p.listening} listening` : ""}</b></div>`;
  }
  try {
    const r = await fetch("/api/store", { cache: "no-store" });
    const j = await r.json().catch(() => null);
    const prods = (j && j.products) || [];
    if (prods.length && shop) {
      shop.innerHTML = `<span class="hn-ic">🛍️</span><div><small>FRESH IN THE SHOP</small><b>${prods.slice(0, 3).map((x) => esc(x.title)).join(" · ")}</b></div>`;
    }
  } catch (_) {}
  if (air.innerHTML || onl.innerHTML || (shop && shop.innerHTML)) nowEl.hidden = false;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
