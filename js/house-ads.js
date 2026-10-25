/* House ads (owner's request, 2026-10-25): a slim banner near the top of every view promoting
   the owner's own Printify products from /api/store. In-flow only: never fixed, never floating,
   never covers content (phones-first rule). Skips the Shop view (already the store) and Clips
   (full-screen video). A visitor can close it for the rest of the session. */
(function () {
  "use strict";
  if (window.__mwHouseAds) return;
  window.__mwHouseAds = true;

  var SKIP = { "v-shop": true, "v-clips": true };
  var HIDE_KEY = "mw_ad_hide";

  function isHidden() { try { return !!sessionStorage.getItem(HIDE_KEY); } catch (_) { return false; } }
  function setHidden() { try { sessionStorage.setItem(HIDE_KEY, "1"); } catch (_) {} }

  var css = document.createElement("style");
  css.textContent =
    ".mw-ad{margin:0 0 20px;border:1px solid rgba(212,175,55,.5);border-radius:14px;" +
    "background:linear-gradient(90deg,rgba(212,175,55,.16),rgba(212,175,55,.05));padding:10px 14px;position:relative}" +
    ".mw-ad a{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;padding-right:22px}" +
    ".mw-ad img{width:54px;height:54px;object-fit:cover;border-radius:10px;flex:0 0 auto;background:#141414}" +
    ".mw-ad .mw-ad-tag{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#d4af37;font-weight:700}" +
    ".mw-ad .mw-ad-title{display:block;font-weight:700;font-size:15px;line-height:1.3}" +
    ".mw-ad .mw-ad-price{margin-left:auto;color:#d4af37;font-weight:800;font-size:15px;white-space:nowrap}" +
    ".mw-ad .mw-ad-cta{white-space:nowrap;font-weight:700;font-size:13px;color:#d4af37}" +
    ".mw-ad .mw-ad-x{position:absolute;top:2px;right:6px;background:none;border:0;color:inherit;opacity:.55;font-size:18px;cursor:pointer;line-height:1;padding:6px}" +
    "@media (max-width:480px){.mw-ad{margin-bottom:14px;padding:8px 10px}.mw-ad img{width:44px;height:44px}.mw-ad .mw-ad-title{font-size:13px}.mw-ad .mw-ad-price{font-size:13px}}";
  document.head.appendChild(css);

  var products = [];
  var slots = [];

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
    var tag = document.createElement("span");
    tag.className = "mw-ad-tag"; tag.textContent = "Meechie's World Merch · Ad";
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
    x.addEventListener("click", function () {
      setHidden();
      slots.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); });
      slots = [];
    });
    slot.appendChild(a); slot.appendChild(x);
  }

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
    slots.forEach(fill);
    if (slots.length) setInterval(function () { if (!document.hidden) slots.forEach(fill); }, 12000);
  }

  function start() {
    fetch("/api/store").then(function (r) { return r.json(); }).then(function (j) {
      products = (j && j.products) || [];
      if (products.length) mount();
    }).catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
