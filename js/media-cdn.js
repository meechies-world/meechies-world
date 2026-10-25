/* Send every song, video and picture through the site's own /m/ relay (Cloudflare cache) instead of
   straight from Supabase storage, so the free Supabase download allowance isn't used up.
   Load this before any other script. */
(function () {
  const PUB = "https://yjouaysczttqbytksejq.supabase.co/storage/v1/object/public/";
  const fix = (u) => (typeof u === "string" && u.startsWith(PUB)) ? location.origin + "/m/" + u.slice(PUB.length).split("?")[0] : u;
  window.mwMedia = fix;

  /* The old Supabase storage is shut off (402 for every file), so anything still pointing there is dead.
     Hide it instead of showing broken players and picture frames: dead post/clip videos take their whole
     card with them, dead photos just disappear (initials/placeholder show through). A video that fails to
     play for any other reason (e.g. a phone codec browsers refuse) hides its post/clip card too. */
  const DEAD = (u) => typeof u === "string" && u.includes("supabase.co/");
  const GONE_PX = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  function bury(el) {
    if (!el || el.nodeType !== 1 || el.dataset.dead) return;
    const tag = el.tagName;
    if (tag === "IMG") { el.dataset.dead = "1"; el.style.display = "none"; try { el.src = GONE_PX; } catch (_) {} return; }
    if (tag === "VIDEO" || tag === "SOURCE" || tag === "AUDIO") {
      const v = tag === "SOURCE" ? el.parentElement : el;
      const box = (v && v.closest && v.closest(".post,.clip,.fb-story,.dt-card")) || v;
      if (!box || box.dataset.dead) return; box.dataset.dead = "1";
      if (v && v.pause) try { v.pause(); } catch (_) {}
      box.style.display = "none";
    }
  }
  document.addEventListener("error", (e) => { const t = e.target; if (t && (t.tagName === "VIDEO" || t.tagName === "SOURCE") && t.closest && t.closest(".post,.clip")) bury(t); }, true);

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
      if (v && DEAD(v) && n !== "href") { bury(el); continue; }
      if (v && v.startsWith(PUB)) {
        setAttr.call(el, n, fix(v));
        if ((el.tagName === "SOURCE") && el.parentElement && el.parentElement.load) el.parentElement.load();
      }
    }
    if (el.style && el.style.backgroundImage && el.style.backgroundImage.includes(PUB)) el.style.backgroundImage = "none";
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
