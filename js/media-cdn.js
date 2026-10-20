/* Send every song, video and picture through the site's own /m/ relay (Cloudflare cache) instead of
   straight from Supabase storage, so the free Supabase download allowance isn't used up.
   Load this before any other script. */
(function () {
  const PUB = "https://yjouaysczttqbytksejq.supabase.co/storage/v1/object/public/";
  const fix = (u) => (typeof u === "string" && u.startsWith(PUB)) ? location.origin + "/m/" + u.slice(PUB.length).split("?")[0] : u;
  window.mwMedia = fix;

  const wrap = (proto, prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, { ...d, set(v) { d.set.call(this, fix(v)); } });
  };
  [[HTMLMediaElement.prototype, "src"], [HTMLImageElement.prototype, "src"], [HTMLSourceElement.prototype, "src"],
   [HTMLVideoElement.prototype, "poster"], [HTMLAnchorElement.prototype, "href"]].forEach(([p, k]) => wrap(p, k));

  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    return setAttr.call(this, n, /^(src|poster|href)$/i.test(n) ? fix(String(v)) : v);
  };

  const A = window.Audio;
  if (A) { window.Audio = function (src) { return src === undefined ? new A() : new A(fix(src)); }; window.Audio.prototype = A.prototype; }

  const f = window.fetch;
  window.fetch = function (input, init) { return f.call(this, typeof input === "string" ? fix(input) : input, init); };

  const scan = (el, deep = true) => {
    if (!el || el.nodeType !== 1) return;
    for (const n of ["src", "poster", "href"]) {
      const v = el.getAttribute && el.getAttribute(n);
      if (v && v.startsWith(PUB)) {
        setAttr.call(el, n, fix(v));
        if ((el.tagName === "SOURCE") && el.parentElement && el.parentElement.load) el.parentElement.load();
      }
    }
    if (el.style && el.style.backgroundImage && el.style.backgroundImage.includes(PUB)) el.style.backgroundImage = el.style.backgroundImage.split(PUB).join(location.origin + "/m/");
    if (deep && el.querySelectorAll) el.querySelectorAll("[src],[poster],[href],[style*='supabase.co']").forEach((c) => scan(c, false));
  };
  const start = () => {
    scan(document.documentElement);
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "attributes") scan(m.target, false);
        else m.addedNodes.forEach((n) => scan(n, true));
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "poster", "href", "style"] });
  };
  if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
})();
