/* Share Meechie's World anywhere — products especially.
 * Phones get the native share sheet (Messages/SMS + every social app on the phone).
 * Everywhere else gets a link sheet: Facebook, X, WhatsApp, Telegram, SMS, Pinterest,
 * Email, copy link, and a "More apps" row when the device has a native sheet.
 * Product cards carry [data-share] with data-title / data-price / data-url; one delegated
 * listener handles every share button on the site. */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : alert(t));
  const css = document.createElement("style");
  css.textContent = `
.prod>a.prod-a{display:grid;gap:8px;color:inherit;text-decoration:none;min-width:0}
.prod-share{border:1px solid var(--gold-lo,#8a6a2a);background:#171208;color:var(--gold-hi,#f0cf78);border-radius:999px;padding:8px 12px;font:700 13px var(--body,system-ui);cursor:pointer;width:100%}
.prod-share:active{transform:scale(.98)}
#share-sheet{position:fixed;inset:0;z-index:100002;display:grid;align-items:end}
#share-sheet .bk{position:absolute;inset:0;background:rgba(0,0,0,.6)}
#share-sheet .pn{position:relative;background:linear-gradient(180deg,#1d1810,#100e0a);border-top:1px solid var(--gold,#d4a843);border-radius:20px 20px 0 0;padding:18px 16px calc(14px + env(safe-area-inset-bottom,0px));display:grid;gap:12px;animation:shUp .28s cubic-bezier(.2,1.2,.4,1)}
@keyframes shUp{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
#share-sheet h4{margin:0;font-size:16px;color:var(--gold-hi,#f0cf78);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#share-sheet .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
#share-sheet .grid a,#share-sheet .grid button{display:grid;justify-items:center;gap:5px;background:#171208;border:1px solid #3a3223;border-radius:14px;padding:11px 4px;color:var(--text,#f3ecdc);font:600 11.5px var(--body,system-ui);text-decoration:none;cursor:pointer}
#share-sheet .grid .ic{font-size:21px;line-height:1}
#share-sheet .row{display:flex;gap:8px}
#share-sheet .row button{flex:1;padding:11px;border-radius:12px;border:1px solid var(--gold-lo,#8a6a2a);background:#171208;color:var(--gold-hi,#f0cf78);font:700 13.5px var(--body,system-ui);cursor:pointer}
@media(min-width:640px){#share-sheet{align-items:center;justify-items:center}#share-sheet .pn{width:min(440px,calc(100vw - 32px));border:1px solid var(--gold,#d4a843);border-radius:20px}}`;
  document.head.appendChild(css);

  let sheet = null;
  const enc = encodeURIComponent;
  function close() { if (sheet) { sheet.remove(); sheet = null; } }
  function openSheet(d) {
    close();
    const full = (d.text + " " + d.url).trim();
    const links = [
      ["📘", "Facebook", "https://www.facebook.com/sharer/sharer.php?u=" + enc(d.url)],
      ["𝕏", "X", "https://twitter.com/intent/tweet?text=" + enc(d.text) + "&url=" + enc(d.url)],
      ["💬", "WhatsApp", "https://wa.me/?text=" + enc(full)],
      ["✈️", "Telegram", "https://t.me/share/url?url=" + enc(d.url) + "&text=" + enc(d.text)],
      ["📱", "SMS", "sms:?&body=" + enc(full)],
      ["📌", "Pinterest", "https://pinterest.com/pin/create/button/?url=" + enc(d.url) + "&description=" + enc(d.text)],
      ["📧", "Email", "mailto:?subject=" + enc(d.title) + "&body=" + enc(full)]
    ];
    sheet = document.createElement("div");
    sheet.id = "share-sheet";
    sheet.innerHTML = `<div class="bk"></div><div class="pn" role="dialog" aria-label="Share">
      <h4>Share: ${E(d.title)}</h4>
      <div class="grid">${links.map(([ic, n, u]) => `<a href="${E(u)}" target="_blank" rel="noopener"><span class="ic">${ic}</span>${n}</a>`).join("")}</div>
      <div class="row"><button type="button" data-sh="copy">🔗 Copy link</button>${navigator.share ? `<button type="button" data-sh="more">📤 More apps…</button>` : ""}<button type="button" data-sh="x">Cancel</button></div>
    </div>`;
    document.body.appendChild(sheet);
    sheet.querySelector(".bk").addEventListener("click", close);
    sheet.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-sh]"); if (!b) return;
      if (b.dataset.sh === "x") close();
      else if (b.dataset.sh === "copy") { try { await navigator.clipboard.writeText(d.url); say("Link copied — paste it anywhere."); } catch (_) { say(d.url); } close(); }
      else if (b.dataset.sh === "more") { close(); try { await navigator.share({ title: d.title, text: d.text, url: d.url }); } catch (_) {} }
    });
  }
  window.MW_share = function (data) {
    const d = { title: (data && data.title) || "Meechie's World", text: (data && data.text) || (data && data.title) || "", url: (data && data.url) || location.href };
    const open = () => { if (navigator.share) navigator.share({ title: d.title, text: d.text, url: d.url }).catch((err) => { if (err && err.name !== "AbortError") openSheet(d); }); else openSheet(d); };
    // pop-ups wait their turn on this site; a share tap is the user's own tap, so one short retry is enough
    if (typeof window.MW_screenClear === "function" && !window.MW_screenClear()) setTimeout(open, 700); else open();
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-share]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const title = b.dataset.title || "Meechie's World";
    const price = b.dataset.price || "";
    const text = `Check this out at Meechie's World 👑 ${title}${price ? " — " + price : ""}`;
    window.MW_share({ title, text, url: b.dataset.url || location.href });
  }, true);
})();
