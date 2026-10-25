/* Share the song you're listening to — to anything (owner's rule).
 * Phones get the native share sheet (every app they have). Desktops get a menu with
 * X / Facebook / WhatsApp / Telegram / text / email / copy link. The link carries
 * ?play=<song title>: whoever opens it lands on the site and that exact song starts
 * on their first tap (browsers require one tap before sound). */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const SITE = "https://meechiesworldinc.com";
  function current() {
    let title = "", artist = "";
    try {
      const list = typeof MW_TRACKS === "function" ? MW_TRACKS() : [];
      const t = (typeof curIdx === "number" && list && list[curIdx]) || null;
      if (t) { title = t.title || ""; artist = t.artist || ""; }
    } catch (_) {}
    if (!title) { const el = $("#pb-title"); if (el) title = el.textContent.trim(); }
    if (!artist) { const el = $("#pb-sub"); if (el) artist = el.textContent.trim(); }
    const radio = (() => { try { return typeof mode === "string" && mode === "radio"; } catch (_) { return false; } })();
    return { title, artist, radio };
  }
  function shareData() {
    const c = current();
    const url = c.title ? SITE + "/?play=" + encodeURIComponent(c.title) : SITE + "/";
    const text = c.title
      ? `🎵 I'm listening to "${c.title}"${c.artist ? " by " + c.artist : ""}${c.radio ? " — LIVE on the station" : ""} on Meechie's World. Tap in:`
      : "🎵 Tap into Meechie's World — the music, the Book, the shop, all in one place:";
    return { title: "Meechie's World", text, url };
  }
  function toast(msg) {
    try { if (typeof note === "function") { note(msg); return; } } catch (_) {}
    const d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText = "position:fixed;left:50%;bottom:110px;transform:translateX(-50%);background:#1c1c1e;color:#f2f2f2;border:1px solid #d4af37;padding:9px 16px;border-radius:999px;font:600 13px system-ui;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.5)";
    document.body.appendChild(d); setTimeout(() => d.remove(), 2600);
  }
  function closeMenu() { const m = $("#mw-share-menu"); if (m) m.remove(); }
  function openMenu() {
    closeMenu();
    const d = shareData();
    const enc = encodeURIComponent;
    const dests = [
      ["𝕏 Post it", "https://twitter.com/intent/tweet?text=" + enc(d.text) + "&url=" + enc(d.url)],
      ["f Facebook", "https://www.facebook.com/sharer/sharer.php?u=" + enc(d.url) + "&quote=" + enc(d.text)],
      ["✆ WhatsApp", "https://wa.me/?text=" + enc(d.text + " " + d.url)],
      ["✈ Telegram", "https://t.me/share/url?url=" + enc(d.url) + "&text=" + enc(d.text)],
      ["💬 Text it", "sms:?&body=" + enc(d.text + " " + d.url)],
      ["✉ Email", "mailto:?subject=" + enc("Meechie's World") + "&body=" + enc(d.text + " " + d.url)],
    ];
    const m = document.createElement("div");
    m.id = "mw-share-menu";
    m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998;display:flex;align-items:flex-end;justify-content:center";
    m.innerHTML = `<div style="background:#141416;border:1px solid #2c2c2e;border-bottom:0;border-radius:16px 16px 0 0;padding:16px;width:min(430px,100%);color:#f2f2f2;font:14px system-ui">
      <div style="font-weight:800;margin-bottom:4px">Share this song</div>
      <div style="opacity:.75;font-size:12.5px;margin-bottom:12px">${d.text.replace(/</g, "&lt;")}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${dests.map(([label, href]) => `<a href="${href}" target="_blank" rel="noopener" style="background:#242426;color:#f2f2f2;text-decoration:none;padding:11px 12px;border-radius:10px;font-weight:700;text-align:center">${label}</a>`).join("")}
        <button type="button" id="mw-share-copy" style="grid-column:1/-1;background:#d4af37;color:#111;border:0;padding:11px;border-radius:10px;font-weight:800;cursor:pointer">🔗 Copy the link</button>
        <button type="button" id="mw-share-x" style="grid-column:1/-1;background:none;border:0;color:#9a9aa0;padding:6px;cursor:pointer;font-weight:600">Cancel</button>
      </div></div>`;
    m.addEventListener("click", (e) => { if (e.target === m) closeMenu(); });
    document.body.appendChild(m);
    $("#mw-share-x").onclick = closeMenu;
    m.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeMenu));
    $("#mw-share-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(d.url); toast("Link copied — paste it anywhere."); }
      catch (_) { window.prompt("Copy your song link:", d.url); }
      closeMenu();
    };
  }
  async function shareSong() {
    const d = shareData();
    if (navigator.share) { try { await navigator.share(d); return; } catch (_) { return; } } // sheet closed = their call
    openMenu();
  }
  const btn = $("#pb-share");
  if (btn) btn.addEventListener("click", shareSong);
  window.MW_shareSong = shareSong;

  /* ---- incoming ?play=<title>: start that song on the visitor's first tap ---- */
  const want = new URLSearchParams(location.search).get("play");
  if (want) {
    document.addEventListener("pointerdown", function h() {
      document.removeEventListener("pointerdown", h);
      let n = 0;
      const t = setInterval(() => {
        n++;
        let list = [];
        try { list = MW_TRACKS() || []; } catch (_) {}
        const i = list.findIndex((x) => (x.title || "").toLowerCase() === want.toLowerCase());
        if (i >= 0) {
          clearInterval(t);
          try { playLib(i); toast("▶ " + want + " — shared with you on Meechie's World"); } catch (_) { try { tuneIn(); } catch (__) {} }
        } else if (n > 24) { clearInterval(t); try { tuneIn(); } catch (_) {} } // song gone? at least give them the station
      }, 400);
    });
  }
})();
