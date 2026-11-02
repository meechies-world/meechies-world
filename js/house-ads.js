/* House ads (owner's request, 2026-10-25): a slim banner near the top of every view promoting
   the owner's own Printify products from /api/store. In-flow only: never fixed, never floating,
   never covers content (phones-first rule). Skips the Shop view (already the store) and Clips
   (full-screen video). A visitor can close the ads for 24 hours — the hide used to last the
   rest of the session, but inside an installed app a "session" can run for weeks, which
   starved the apps of ads for good (owner, 2026-10-27: "make sure my ads are on all my apps").
   One owner-ordered exception to the in-flow rule (2026-10-30): when the master screen is
   popped out big (the MW TV channel), a slim bar from this same pool rides the bottom of
   that screen — see mountScreenBar. Everywhere else the in-flow rule stands.
   Second owner-ordered exception (2026-11-01): on MW TV the centred picture leaves big
   black bands above and below it on portrait phones, and the owner ordered those bands
   filled with ads about our products and website — see mountTvFill. The fill zones live
   only in genuinely empty space measured off the live picture box: they never overlay
   the video, never shrink it, never cover the channel controls, the on-air chip or
   the screen bar, and they collapse to nothing when the picture fills the screen. */
(function () {
  "use strict";
  if (window.__mwHouseAds) return;
  window.__mwHouseAds = true;

  var SKIP = { "v-shop": true, "v-clips": true };
  var HIDE_KEY = "mw_ad_hide";

  function isHidden() { try { return Date.now() < (+localStorage.getItem(HIDE_KEY) || 0); } catch (_) { return false; } }
  function setHidden() { try { localStorage.setItem(HIDE_KEY, String(Date.now() + 24 * 3600 * 1000)); } catch (_) {} }

  var css = document.createElement("style");
  css.textContent =
    ".mw-ad{margin:0 0 20px;border:1px solid rgba(212,175,55,.5);border-radius:14px;min-height:76px;box-sizing:border-box;" +
    "background:linear-gradient(90deg,rgba(212,175,55,.16),rgba(212,175,55,.05));padding:10px 14px;position:relative}" +
    ".mw-ad a{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;padding-right:22px}" +
    ".mw-ad img{width:54px;height:54px;object-fit:cover;border-radius:10px;flex:0 0 auto;background:#141414}" +
    ".mw-ad .mw-ad-mid{flex:1;min-width:0}" +
    ".mw-ad .mw-ad-tag{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#d4af37;font-weight:700}" +
    ".mw-ad .mw-ad-title{display:block;font-weight:700;font-size:15px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".mw-ad .mw-ad-price{margin-left:auto;color:#d4af37;font-weight:800;font-size:15px;white-space:nowrap}" +
    ".mw-ad .mw-ad-cta{white-space:nowrap;font-weight:700;font-size:13px;color:#d4af37}" +
    ".mw-ad .mw-ad-x{position:absolute;top:2px;right:6px;background:none;border:0;color:inherit;opacity:.55;font-size:18px;cursor:pointer;line-height:1;padding:6px}" +
    "@media (max-width:480px){.mw-ad{margin-bottom:14px;padding:8px 10px;min-height:62px}.mw-ad img{width:44px;height:44px}.mw-ad .mw-ad-title{font-size:13px}.mw-ad .mw-ad-price{font-size:13px}}" +
    ".mw-shelf-h{font-size:13px;font-weight:800;letter-spacing:.12em;color:#d4af37;margin:18px 0 8px}" +
    ".mw-rail{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 10px;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch}" +
    ".mw-card{flex:0 0 148px;scroll-snap-align:start;display:block;background:#141414;border:1px solid rgba(212,175,55,.35);border-radius:12px;padding:8px;text-decoration:none;color:inherit}" +
    ".mw-card img{width:100%;height:108px;object-fit:cover;border-radius:8px;background:#1c1c1c;display:block}" +
    ".mw-card b{display:block;font-size:12.5px;line-height:1.3;margin-top:7px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:32px}" +
    ".mw-card .mw-card-pr{display:block;color:#d4af37;font-weight:800;font-size:13px;margin-top:3px}" +
    ".mw-card .mw-card-src{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#0e0c07;background:#d4af37;border-radius:99px;padding:1px 7px;margin-top:6px}" +
    ".mw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:8px}" +
    ".mw-grid .mw-card{flex:none}" +
    /* Screen ad bar (owner, 2026-10-30: "when people pop up the screen i
       want a small ad at the bottom of it"): one slim strip riding the
       bottom of the popped-out big screen (the MW TV channel shell). It
       lives only inside #tw-shell, sits below the video frame's own
       top-bar controls, and is fed by this same product pool below. */
    ".mw-adbar{position:absolute;left:0;right:0;bottom:0;z-index:10;height:42px;box-sizing:border-box;display:flex;align-items:stretch;background:rgba(8,7,4,.93);border-top:1px solid rgba(212,175,55,.55)}" +
    ".mw-adbar a{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:0 12px;text-decoration:none;color:#f3ead2}" +
    ".mw-adbar img{width:30px;height:30px;object-fit:cover;border-radius:7px;flex:0 0 auto;background:#141414}" +
    ".mw-adbar .mw-adbar-tag{flex:0 0 auto;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#d4af37;font-weight:700}" +
    ".mw-adbar .mw-adbar-title{flex:1;min-width:0;font-weight:700;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".mw-adbar .mw-adbar-price{flex:0 0 auto;color:#d4af37;font-weight:800;font-size:13.5px;white-space:nowrap}" +
    ".mw-adbar .mw-adbar-cta{flex:0 0 auto;white-space:nowrap;font-weight:700;font-size:12.5px;color:#d4af37}" +
    ".mw-adbar .mw-adbar-x{flex:0 0 auto;background:none;border:0;color:#f3ead2;opacity:.55;font-size:17px;cursor:pointer;line-height:1;padding:0 10px}" +
    "@media (max-width:640px){.mw-adbar{height:38px;bottom:66px}.mw-adbar .mw-adbar-tag{display:none}.mw-adbar .mw-adbar-title{font-size:12.5px}}" +
    /* MW TV fill zones (owner, 2026-11-01): cards centred in the black
       bands above and below the centred MW TV picture. Position and
       height are set in px by layoutTvFill() from the measured picture
       box; display:none until a band is genuinely big enough. z-index 8
       keeps them under the channel top bar (z 9) and the screen bar
       (z 10) even if a measurement ever strays. */
    ".mw-tvfill{position:absolute;left:0;right:0;z-index:8;display:none;align-items:center;justify-content:center;padding:10px 14px;box-sizing:border-box;overflow:hidden}" +
    ".mw-tvfill.on{display:flex}" +
    ".mw-tvfill .mw-tvwrap{position:relative;width:100%;max-width:560px;max-height:100%}" +
    ".mw-tvfill .mw-tvcard{display:flex;align-items:center;gap:12px;width:100%;max-height:100%;box-sizing:border-box;border:1px solid rgba(212,175,55,.5);border-radius:14px;background:linear-gradient(90deg,rgba(212,175,55,.16),rgba(212,175,55,.05));padding:10px 36px 10px 14px;text-decoration:none;color:#f3ead2}" +
    ".mw-tvfill img{width:64px;height:64px;object-fit:cover;border-radius:10px;flex:0 0 auto;background:#141414}" +
    ".mw-tvfill .mw-tv-mid{flex:1;min-width:0}" +
    ".mw-tvfill .mw-tv-tag{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#d4af37;font-weight:700}" +
    ".mw-tvfill .mw-tv-title{display:block;font-weight:700;font-size:15px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".mw-tvfill .mw-tv-line{display:block;font-size:12.5px;line-height:1.35;color:#cfc4a4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".mw-tvfill .mw-tv-price{flex:0 0 auto;color:#d4af37;font-weight:800;font-size:15px;white-space:nowrap}" +
    ".mw-tvfill .mw-tv-cta{flex:0 0 auto;white-space:nowrap;font-weight:700;font-size:13px;color:#d4af37}" +
    ".mw-tvfill .mw-tv-x{position:absolute;top:2px;right:6px;background:none;border:0;color:#f3ead2;opacity:.55;font-size:18px;cursor:pointer;line-height:1;padding:6px;z-index:2}" +
    "@media (max-width:640px){.mw-tvfill img{width:48px;height:48px}.mw-tvfill .mw-tv-title{font-size:13.5px}.mw-tvfill .mw-tv-price{font-size:13px}}";
  document.head.appendChild(css);

  var products = [];
  var slots = [];
  var shelves = [];
  var barSlots = [];
  var tvFillSlots = [];

  /* One hide for every house-ad surface (owner rule: closing an ad hides
     the ads for 24 hours): the banners, the shelves and the screen bar
     all come down together and stay down together. */
  function hideAll() {
    setHidden();
    slots.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); });
    slots = [];
    shelves.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); });
    shelves = [];
    barSlots.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); });
    barSlots = [];
    tvFillSlots.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); });
    tvFillSlots = [];
  }

  function fill(slot) {
    if (!products.length) return;
    var p = products[Math.floor(Math.random() * products.length)];
    slot.innerHTML = "";
    var a = document.createElement("a");
    a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    if (p.img) {
      var img = document.createElement("img");
      img.src = p.img; img.alt = ""; img.loading = "lazy";
      a.appendChild(img);
    }
    var mid = document.createElement("span");
    mid.className = "mw-ad-mid";
    var tag = document.createElement("span");
    tag.className = "mw-ad-tag"; tag.textContent = "Meechie's World Merch · " + (p.src || "Ad");
    var ttl = document.createElement("span");
    ttl.className = "mw-ad-title"; ttl.textContent = p.title;
    mid.appendChild(tag); mid.appendChild(ttl);
    a.appendChild(mid);
    if (p.price) {
      var pr = document.createElement("span");
      pr.className = "mw-ad-price"; pr.textContent = p.price;
      a.appendChild(pr);
    }
    var cta = document.createElement("span");
    cta.className = "mw-ad-cta"; cta.textContent = "Shop now →";
    a.appendChild(cta);
    var x = document.createElement("button");
    x.className = "mw-ad-x"; x.type = "button";
    x.setAttribute("aria-label", "Hide this ad"); x.textContent = "×";
    x.addEventListener("click", function () { hideAll(); });
    slot.appendChild(a); slot.appendChild(x);
  }

  /* The screen bar renders ONE product as a single slim line — thumb,
     title, price, Shop now — never the full banner card, so it stays a
     strip at the bottom of the big screen and nothing more. */
  function fillBar(slot) {
    if (!products.length) return;
    var p = products[Math.floor(Math.random() * products.length)];
    slot.innerHTML = "";
    var a = document.createElement("a");
    a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    if (p.img) {
      var img = document.createElement("img");
      img.src = p.img; img.alt = ""; img.loading = "lazy";
      a.appendChild(img);
    }
    var tag = document.createElement("span");
    tag.className = "mw-adbar-tag"; tag.textContent = "Meechie's World Merch · " + (p.src || "Ad");
    var ttl = document.createElement("span");
    ttl.className = "mw-adbar-title"; ttl.textContent = p.title;
    a.appendChild(tag); a.appendChild(ttl);
    if (p.price) {
      var pr = document.createElement("span");
      pr.className = "mw-adbar-price"; pr.textContent = p.price;
      a.appendChild(pr);
    }
    var cta = document.createElement("span");
    cta.className = "mw-adbar-cta"; cta.textContent = "Shop now →";
    a.appendChild(cta);
    slot.appendChild(a);
    var x = document.createElement("button");
    x.className = "mw-adbar-x"; x.type = "button";
    x.setAttribute("aria-label", "Hide ads for 24 hours"); x.textContent = "×";
    x.addEventListener("click", function () { hideAll(); });
    slot.appendChild(x);
  }

  /* The bar is created only inside the MW TV channel shell — the
     popped-out big screen. The small docked mini never gets one (it is
     hidden on the channel page anyway), the booth never gets one, and
     pages without the channel shell simply skip this. It is created
     empty and filled from the same pool as every other house ad; when
     the pool comes back empty it is removed again (see start()), so an
     empty strip never rides the screen. */
  function mountScreenBar() {
    if (isHidden()) return;
    var shell = document.getElementById("tw-shell");
    if (!shell || shell.querySelector(".mw-adbar")) return;
    var bar = document.createElement("div");
    bar.className = "mw-adbar";
    shell.appendChild(bar);
    barSlots.push(bar);
  }

  /* MW TV fill (owner, 2026-11-01): the centred MW TV picture leaves
     black bands above and below it on portrait phones, and those bands
     carry house ads — products from this same pool on top, website
     promos below. The zones are plain absolutely-positioned boxes in
     #tw-shell; layoutTvFill() measures the live picture box (the active
     .vslot rect while a mix video is showing) plus the top bar, the
     on-air chip and the screen bar, and gives a zone height only where
     a genuinely empty band of at least MIN_BAND px exists. No band, no
     zone: the picture is never shrunk, moved or covered, and a share
     or an uploaded screen video (object-fit contain over the whole
     stage, so its real picture edges are unknowable) disables the fill
     outright. Nothing here touches any player: layout is rect reads
     and style writes on the ad boxes only. */
  var TV_MIN_BAND = 84;
  var PROMOS = [
    { tag: "Meechie's World", head: "🛍️ The Shop", line: "Merch, apparel and more from the movement — new drops all the time.", href: "#shop", go: "shop", cta: "Shop →" },
    { tag: "Meechie's World", head: "🎧 Meechie's World Radio", line: "Live DJ sets, real music, real talk — all day. Tune in.", href: "#radio", go: "radio", cta: "Listen →" },
    { tag: "Meechie's World", head: "📖 Meechie's Book", line: "Post, talk, gift and build with the whole community.", href: "#community", go: "community", cta: "Open →" },
    { tag: "Meechie's World", head: "🎚️ The Studio", line: "Make beats, record and polish your sound — the full studio.", href: "#studio", go: "studio", cta: "Create →" },
    { tag: "Meechie's World", head: "🧒 Meechie's World for Kids", line: "Your playlist, your lock — hand the phone over with confidence.", href: "/kids-app/", ext: true, cta: "Open →" },
    { tag: "Meechie's World", head: "💼 Free Vendor Slots", line: "Sellers: get your products on this site FREE for a week.", href: "#promote", go: "promote", cta: "See how →" },
    { tag: "Meechie's World", head: "🎮 Meechie LIVE on Twitch", line: "Watch the live sets on Twitch — @meechiesworldinc.", href: "https://www.twitch.tv/meechiesworldinc", ext: true, cta: "Watch →" },
    { tag: "Meechie's World", head: "🚗 Car Mode", line: "On the road? The station, big and simple — TV poster, tune in, directions.", href: "/car", ext: true, cta: "Open →" }
  ];
  var promoIx = Math.floor(Math.random() * PROMOS.length);

  function tvCardShell(zone) {
    zone.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "mw-tvwrap";
    var a = document.createElement("a");
    a.className = "mw-tvcard";
    var x = document.createElement("button");
    x.className = "mw-tv-x"; x.type = "button";
    x.setAttribute("aria-label", "Hide ads for 24 hours"); x.textContent = "×";
    x.addEventListener("click", function (ev) { if (ev) { ev.preventDefault(); ev.stopPropagation(); } hideAll(); });
    wrap.appendChild(a); wrap.appendChild(x);
    zone.appendChild(wrap);
    return a;
  }

  function fillTvTop(zone) {
    if (!products.length) return;
    var p = products[Math.floor(Math.random() * products.length)];
    var a = tvCardShell(zone);
    a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    if (p.img) {
      var img = document.createElement("img");
      img.src = p.img; img.alt = ""; img.loading = "lazy";
      a.appendChild(img);
    }
    var mid = document.createElement("span");
    mid.className = "mw-tv-mid";
    var tag = document.createElement("span");
    tag.className = "mw-tv-tag"; tag.textContent = "Meechie's World Merch · " + (p.src || "Ad");
    var ttl = document.createElement("span");
    ttl.className = "mw-tv-title"; ttl.textContent = p.title;
    mid.appendChild(tag); mid.appendChild(ttl);
    a.appendChild(mid);
    if (p.price) {
      var pr = document.createElement("span");
      pr.className = "mw-tv-price"; pr.textContent = p.price;
      a.appendChild(pr);
    }
    var cta = document.createElement("span");
    cta.className = "mw-tv-cta"; cta.textContent = "Shop now →";
    a.appendChild(cta);
  }

  function fillTvBot(zone) {
    var pr = PROMOS[promoIx % PROMOS.length]; promoIx++;
    var a = tvCardShell(zone);
    a.href = pr.href;
    if (pr.go) a.setAttribute("data-go", pr.go);
    if (pr.ext) { a.target = "_blank"; a.rel = "noopener"; }
    var mid = document.createElement("span");
    mid.className = "mw-tv-mid";
    var tag = document.createElement("span");
    tag.className = "mw-tv-tag"; tag.textContent = pr.tag;
    var ttl = document.createElement("span");
    ttl.className = "mw-tv-title"; ttl.textContent = pr.head;
    var ln = document.createElement("span");
    ln.className = "mw-tv-line"; ln.textContent = pr.line;
    mid.appendChild(tag); mid.appendChild(ttl); mid.appendChild(ln);
    a.appendChild(mid);
    var cta = document.createElement("span");
    cta.className = "mw-tv-cta"; cta.textContent = pr.cta;
    a.appendChild(cta);
  }

  function mountTvFill() {
    if (isHidden()) return;
    var shell = document.getElementById("tw-shell");
    if (!shell || shell.querySelector(".mw-tvfill")) return;
    var top = document.createElement("div");
    top.className = "mw-tvfill"; top.id = "mw-tvfill-top";
    var bot = document.createElement("div");
    bot.className = "mw-tvfill"; bot.id = "mw-tvfill-bot";
    shell.appendChild(top); shell.appendChild(bot);
    tvFillSlots.push(top); tvFillSlots.push(bot);
    layoutTvFill();
  }

  function tvFillHide() {
    tvFillSlots.forEach(function (z) { z.classList.remove("on"); z.style.height = "0px"; });
  }

  function layoutTvFill() {
    if (!tvFillSlots.length) return;
    var shell = document.getElementById("tw-shell");
    var stage = document.getElementById("tw-stage");
    if (!shell || !stage || !document.body || document.body.dataset.view !== "mwtv") { tvFillHide(); return; }
    if (stage.classList.contains("vs-on") || stage.classList.contains("msv-on")) { tvFillHide(); return; }
    var slot = null, best = 0.05;
    ["tw-vs1", "tw-vs2"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var op = parseFloat(el.style.opacity || "0");
      if (op > best && el.querySelector("iframe,video,canvas")) { best = op; slot = el; }
    });
    if (!slot) { tvFillHide(); return; }
    var sr = shell.getBoundingClientRect();
    if (!sr.height) { tvFillHide(); return; }
    var pic = slot.getBoundingClientRect();
    var picTop = pic.top - sr.top, picBot = pic.bottom - sr.top;
    var bar = document.getElementById("tw-bar");
    var topEdge = 0;
    if (bar) topEdge = Math.max(0, bar.getBoundingClientRect().bottom - sr.top);
    var botEdge = sr.height;
    var adbar = shell.querySelector(".mw-adbar");
    if (adbar) botEdge = Math.min(botEdge, adbar.getBoundingClientRect().top - sr.top);
    var chip = document.getElementById("tw-vchip");
    var contentBot = picBot;
    if (chip && !chip.hidden) {
      var cr = chip.getBoundingClientRect();
      if (cr.height) contentBot = Math.max(contentBot, cr.bottom - sr.top);
    }
    var GAP = 8;
    var top = tvFillSlots[0], bot = tvFillSlots[1];
    var tH = picTop - GAP - (topEdge + GAP);
    if (top && tH >= TV_MIN_BAND) {
      top.style.top = (topEdge + GAP) + "px"; top.style.height = tH + "px"; top.classList.add("on");
    } else if (top) { top.classList.remove("on"); top.style.height = "0px"; }
    var bH = (botEdge - GAP) - (contentBot + GAP);
    if (bot && bH >= TV_MIN_BAND) {
      bot.style.top = (contentBot + GAP) + "px"; bot.style.height = bH + "px"; bot.classList.add("on");
    } else if (bot) { bot.classList.remove("on"); bot.style.height = "0px"; }
  }

  /* No-jump rule (owner, 2026-10-27: "when they refresh it, it doesn't jump"):
     the ad boxes are created IMMEDIATELY, empty, at their final size — the space
     is reserved before the product fetch returns, so when the ads fill in (and
     every 12 seconds when they rotate) nothing on the page moves. If the
     products never arrive, the reserved boxes are taken back out. */
  function mount() {
    if (isHidden()) return;
    document.querySelectorAll("section.view").forEach(function (sec) {
      if (SKIP[sec.id]) return;
      var wrap = sec.querySelector(".wrap");
      if (!wrap || wrap.querySelector(".mw-ad")) return;
      var slot = document.createElement("div");
      slot.className = "mw-ad";
      var head = wrap.querySelector(".section-head");
      if (head && head.parentNode === wrap) wrap.insertBefore(slot, head.nextSibling);
      else if (wrap.children.length > 1) wrap.insertBefore(slot, wrap.children[1]);
      else wrap.appendChild(slot);
      slots.push(slot);
    });
    mountRadioSlots();
    mountScreenBar();
    mountTvFill();
  }

  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  function card(p) {
    var a = document.createElement("a");
    a.className = "mw-card"; a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    if (p.img) { var img = document.createElement("img"); img.src = p.img; img.alt = ""; img.loading = "lazy"; a.appendChild(img); }
    var b = document.createElement("b"); b.textContent = p.title; a.appendChild(b);
    if (p.price) { var pr = document.createElement("span"); pr.className = "mw-card-pr"; pr.textContent = p.price; a.appendChild(pr); }
    var s = document.createElement("span"); s.className = "mw-card-src"; s.textContent = p.src || "Store"; a.appendChild(s);
    return a;
  }

  function shelf(heading, cls) {
    var w = document.createElement("div");
    var h = document.createElement("div"); h.className = "mw-shelf-h"; h.textContent = heading; w.appendChild(h);
    var row = document.createElement("div"); row.className = cls; w.appendChild(row);
    shelves.push(w);
    return { wrap: w, row: row, h: h };
  }

  /* The Radio page carries the full advertising load (owner's ask, 2026-10-26):
     a scrolling product rail under the station card and a product grid under
     the song library, Printify + Shopify mixed, on top of the rotating banner
     every view already gets. The shelves are placed empty with reserved height
     the moment the page builds (see the no-jump rule above) and filled when
     the products land. */
  var radioRail = null, radioGrid = null;
  function mountRadioSlots() {
    if (isHidden()) return;
    var sec = document.getElementById("v-radio");
    if (!sec || sec.dataset.mwAdsFull) return;
    sec.dataset.mwAdsFull = "1";
    var station = document.getElementById("dj-root");
    if (station && station.parentNode) {
      radioRail = shelf("", "mw-rail");
      radioRail.wrap.style.minHeight = "250px";
      station.parentNode.insertBefore(radioRail.wrap, station.nextSibling);
    }
    var tracks = document.getElementById("tracks");
    if (tracks && tracks.parentNode) {
      radioGrid = shelf("", "mw-grid");
      radioGrid.wrap.style.minHeight = "250px";
      tracks.parentNode.insertBefore(radioGrid.wrap, tracks.nextSibling);
      var tail = document.createElement("div");
      tail.className = "mw-ad";
      radioGrid.wrap.parentNode.insertBefore(tail, radioGrid.wrap.nextSibling);
      slots.push(tail);
    }
  }
  function fillRadio() {
    var mix = shuffle(products.slice());
    if (radioRail) {
      radioRail.h.textContent = "🛍️ MEECHIE'S WORLD MERCH — FROM THE STORES";
      mix.slice(0, 14).forEach(function (p) { radioRail.row.appendChild(card(p)); });
      radioRail.wrap.style.minHeight = "";
    }
    if (radioGrid) {
      radioGrid.h.textContent = "🔥 MORE FROM THE STORES";
      mix.slice(14, 22).forEach(function (p) { radioGrid.row.appendChild(card(p)); });
      radioGrid.wrap.style.minHeight = "";
    }
  }

  function start() {
    var got = { printify: [], shopify: [] };
    var done = function () {
      var pf = got.printify.map(function (p) { return { title: p.title, img: p.img, price: p.price, url: p.url, src: "Printify" }; });
      var sh = got.shopify.filter(function (p) { return /^https:\/\//.test(p.url || ""); }).map(function (p) { return { title: p.title, img: p.img, price: p.price, url: (p.digital && p.buy) ? p.buy : p.url, src: "Shopify" }; });
      products = shuffle(pf.concat(sh));
      if (!products.length) {
        // no ads to show: hand the reserved space back so nothing sits empty
        slots.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); }); slots = [];
        shelves.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); }); shelves = [];
        barSlots.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); }); barSlots = [];
        tvFillSlots.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); }); tvFillSlots = [];
        return;
      }
      slots.forEach(fill);
      barSlots.forEach(fillBar);
      if (tvFillSlots.length) { fillTvTop(tvFillSlots[0]); fillTvBot(tvFillSlots[1]); layoutTvFill(); }
      fillRadio();
      if (slots.length || barSlots.length || tvFillSlots.length) setInterval(function () { if (!document.hidden) { slots.forEach(fill); barSlots.forEach(fillBar); if (tvFillSlots.length) { fillTvTop(tvFillSlots[0]); fillTvBot(tvFillSlots[1]); layoutTvFill(); } } }, 12000);
      if (tvFillSlots.length) {
        // geometry watch: rotation changes, orientation flips and the
        // top bar wrapping all move the empty bands — re-measure only,
        // never touching the players (rect reads + ad-box styles).
        setInterval(layoutTvFill, 1000);
        window.addEventListener("resize", layoutTvFill);
        window.addEventListener("orientationchange", layoutTvFill);
      }
    };
    var n = 0, step = function () { if (++n === 2) done(); };
    if (window.MW_shopCatalog) {
      // device-max B2: read the one device-held catalog app-core maintains
      // instead of fetching the union a second time; if the background
      // revalidation swaps in a fresher catalog, refresh the rotation pool
      // (the 12s rotation picks the new products up on its next pass).
      window.MW_shopCatalog().then(function (c) { got.printify = (c && c.store) || []; got.shopify = (c && c.shopify) || []; }).catch(function () {}).then(function () { step(); step(); });
      window.addEventListener("mw-catalog", function () {
        window.MW_shopCatalog().then(function (c) { if (!c) return;
          var pf = (c.store || []).map(function (p) { return { title: p.title, img: p.img, price: p.price, url: p.url, src: "Printify" }; });
          var sh = (c.shopify || []).filter(function (p) { return /^https:\/\//.test(p.url || ""); }).map(function (p) { return { title: p.title, img: p.img, price: p.price, url: (p.digital && p.buy) ? p.buy : p.url, src: "Shopify" }; });
          if (pf.length || sh.length) products = shuffle(pf.concat(sh));
        }).catch(function () {});
      });
    } else {
      fetch("/api/store").then(function (r) { return r.json(); }).then(function (j) { got.printify = (j && j.products) || []; }).catch(function () {}).then(step);
      fetch("/api/shopify").then(function (r) { return r.json(); }).then(function (j) { got.shopify = (j && j.products) || []; }).catch(function () {}).then(step);
    }
  }

  function boot() { mount(); start(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
