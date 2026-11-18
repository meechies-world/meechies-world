/* App-page house ads (owner, 2026-10-27: "make sure my ads are on all my apps"):
   one slim rotating merch banner for the standalone app pages (the App Store at
   /apps/ and the per-section install pages), which are separate pages that the
   in-site house-ads script never reaches. Same products as the site ads
   (Printify /api/store + Shopify /api/shopify), same 12-second rotation, and
   the same dismissal as the site: closing any ad hides them all for 24 hours
   (shared localStorage stamp with house-ads.js — a "session" inside an
   installed app can last for weeks, so a session-long hide starved the apps
   of ads for good). In-flow only; sits wherever the page puts [data-app-ad]. */
(function () {
  "use strict";
  if (window.__mwAppAd) return;
  window.__mwAppAd = true;
  var slots = [].slice.call(document.querySelectorAll("[data-app-ad]"));
  var rails = [].slice.call(document.querySelectorAll("[data-app-ad-rail]"));
  if (!slots.length && !rails.length) return;

  var HIDE_KEY = "mw_ad_hide";
  function isHidden() { try { return Date.now() < (+localStorage.getItem(HIDE_KEY) || 0); } catch (_) { return false; } }
  function setHidden() { try { localStorage.setItem(HIDE_KEY, String(Date.now() + 24 * 3600 * 1000)); } catch (_) {} }
  if (isHidden()) return;

  var css = document.createElement("style");
  css.textContent =
    ".mw-ad{margin:18px 0 0;border:1px solid rgba(212,175,55,.5);border-radius:14px;min-height:76px;box-sizing:border-box;background:linear-gradient(90deg,rgba(212,175,55,.16),rgba(212,175,55,.05));padding:10px 14px;position:relative;text-align:left}" +
    ".mw-ad a{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;padding-right:22px}" +
    ".mw-ad img{width:54px;height:54px;object-fit:cover;border-radius:10px;flex:0 0 auto;background:#141414}" +
    ".mw-ad .mw-ad-mid{flex:1;min-width:0}" +
    ".mw-ad .mw-ad-tag{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#d4af37;font-weight:700}" +
    ".mw-ad .mw-ad-title{display:block;font-weight:700;font-size:15px;line-height:1.3;color:#f5f0e6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".mw-ad .mw-ad-price{margin-left:auto;color:#d4af37;font-weight:800;font-size:15px;white-space:nowrap}" +
    ".mw-ad .mw-ad-cta{white-space:nowrap;font-weight:700;font-size:13px;color:#d4af37}" +
    ".mw-ad .mw-ad-x{position:absolute;top:2px;right:6px;background:none;border:0;color:#f5f0e6;opacity:.55;font-size:18px;cursor:pointer;line-height:1;padding:6px}" +
    ".mw-ad-rail{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 10px;-webkit-overflow-scrolling:touch}" +
    ".mw-ad-card{flex:0 0 148px;display:block;background:#141414;border:1px solid rgba(212,175,55,.35);border-radius:12px;padding:8px;text-decoration:none;color:#f5f0e6}" +
    ".mw-ad-card img{width:100%;height:108px;object-fit:cover;border-radius:8px;background:#1c1c1c;display:block}" +
    ".mw-ad-card b{display:block;font-size:12.5px;line-height:1.3;margin-top:7px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:32px}" +
    ".mw-ad-card .pr{display:block;color:#d4af37;font-weight:800;font-size:13px;margin-top:3px}";
  document.head.appendChild(css);

  /* Reserve the space up front (the no-jump rule, same as the site's house
     ads): the boxes take their final size before the product fetch returns, so
     refreshing an app page never shoves the content around when the ads land.
     If no products come back, the reserved boxes are removed again. */
  slots.forEach(function (s) { s.className = "mw-ad"; });
  rails.forEach(function (r) { r.style.minHeight = "178px"; });

  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  var products = [];

  function fill(slot) {
    if (!products.length) return;
    var p = products[Math.floor(Math.random() * products.length)];
    slot.innerHTML = "";
    slot.className = "mw-ad";
    var a = document.createElement("a");
    a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    if (p.img) { var img = document.createElement("img"); img.src = p.img; img.alt = ""; img.loading = "lazy"; a.appendChild(img); }
    var mid = document.createElement("span");
    mid.className = "mw-ad-mid";
    var tag = document.createElement("span"); tag.className = "mw-ad-tag"; tag.textContent = "Meechie's World Merch · " + (p.src || "Ad");
    var ttl = document.createElement("span"); ttl.className = "mw-ad-title"; ttl.textContent = p.title;
    mid.appendChild(tag); mid.appendChild(ttl); a.appendChild(mid);
    if (p.price) { var pr = document.createElement("span"); pr.className = "mw-ad-price"; pr.textContent = p.price; a.appendChild(pr); }
    var cta = document.createElement("span"); cta.className = "mw-ad-cta"; cta.textContent = "Shop now →"; a.appendChild(cta);
    var x = document.createElement("button");
    x.className = "mw-ad-x"; x.type = "button"; x.setAttribute("aria-label", "Hide ads for a day"); x.textContent = "×";
    x.addEventListener("click", function () {
      setHidden();
      slots.concat(rails).forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); });
      slots = []; rails = [];
    });
    slot.appendChild(a); slot.appendChild(x);
  }

  function card(p) {
    var a = document.createElement("a");
    a.className = "mw-ad-card"; a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    if (p.img) { var img = document.createElement("img"); img.src = p.img; img.alt = ""; img.loading = "lazy"; a.appendChild(img); }
    var b = document.createElement("b"); b.textContent = p.title; a.appendChild(b);
    if (p.price) { var pr = document.createElement("span"); pr.className = "pr"; pr.textContent = p.price; a.appendChild(pr); }
    return a;
  }

  function start() {
    var got = { printify: [], shopify: [] };
    var n = 0, step = function () {
      if (++n !== 2) return;
      var pf = got.printify.map(function (p) { return { title: p.title, img: p.img, price: p.price, url: p.url, src: "Printify" }; });
      var sh = got.shopify.filter(function (p) { return /^https:\/\//.test(p.url || ""); }).map(function (p) { return { title: p.title, img: p.img, price: p.price, url: (p.digital && p.buy) ? p.buy : p.url, src: "Shopify" }; });
      products = shuffle(pf.concat(sh));
      if (!products.length) { slots.concat(rails).forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); }); slots = []; rails = []; return; }
      slots.forEach(fill);
      rails.forEach(function (r) { r.className = "mw-ad-rail"; products.slice(0, 10).forEach(function (p) { r.appendChild(card(p)); }); r.style.minHeight = ""; });
      if (slots.length) setInterval(function () { if (!document.hidden) slots.forEach(fill); }, 12000);
    };
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem("mw-catalog-v1") || "null"); } catch (e) {}
    if (cached && Array.isArray(cached.store) && Array.isArray(cached.shopify) && (Date.now() - (cached.at || 0) < 15 * 60 * 1000)) {
      got.printify = cached.store; got.shopify = cached.shopify; step(); step();
    } else {
      var fresh = { at: Date.now(), store: [], shopify: [], sUp: 0, hUp: 0 };
      fetch("/api/store").then(function (r) { return r.json(); }).then(function (j) { got.printify = (j && j.products) || []; fresh.store = got.printify; fresh.sUp = (j && j.updated) || 0; }).catch(function () {}).then(step);
      fetch("/api/shopify").then(function (r) { return r.json(); }).then(function (j) { got.shopify = (j && j.products) || []; fresh.shopify = got.shopify; fresh.hUp = (j && j.updated) || 0; }).catch(function () {}).then(function () { try { var cur = JSON.parse(localStorage.getItem("mw-catalog-v1") || "null"); if ((!cur || (cur.at || 0) <= fresh.at) && (fresh.store.length || fresh.shopify.length)) localStorage.setItem("mw-catalog-v1", JSON.stringify(fresh)); } catch (e) {} }).then(step);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
