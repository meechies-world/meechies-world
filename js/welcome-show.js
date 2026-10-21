/* Entrance show (owner's request): after people tap Enter and the welcome video ends,
 * Meechie's videos play one after another in a small floating player that stays on screen
 * while they scroll and move around the site. Music does NOT start by itself; a welcome card
 * offers quick bubbles: Grant Boy Records radio, another station, shop, read a book, legal help. */
(function () {
  "use strict";
  let box = null, v = null, i = 0, on = false, list = [];
  const $ = (s, r = document) => r.querySelector(s);

  const css = document.createElement("style");
  css.textContent = `
#mw-show{position:fixed;left:14px;bottom:calc(var(--tabbar,0px) + 76px + env(safe-area-inset-bottom,0px));z-index:9995;width:160px;aspect-ratio:9/16;border-radius:16px;overflow:hidden;border:2px solid var(--gold,#d4a843);background:#000;box-shadow:0 16px 40px rgba(0,0,0,.6);transition:width .25s}
body.has-player #mw-show{bottom:calc(var(--tabbar,0px) + 150px + env(safe-area-inset-bottom,0px))}
#mw-show.big{width:min(300px,62vw)}
#mw-show video{width:100%;height:100%;object-fit:cover;display:block}
#mw-show .ctl{position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;gap:4px;padding:6px;background:linear-gradient(#000a,#0000)}
#mw-show .ctl button{width:30px;height:30px;border-radius:50%;border:1px solid #fff4;background:#000a;color:#fff;font-size:14px;cursor:pointer;display:grid;place-items:center;padding:0}
#mw-show .tap{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);border:1px solid var(--gold-hi,#f0cf78);background:#000c;color:#fff;font:700 12px var(--body,system-ui);padding:6px 11px;border-radius:999px;cursor:pointer;white-space:nowrap}
#mw-show .n{position:absolute;right:7px;bottom:7px;background:#000b;color:#fff;border-radius:999px;padding:2px 7px;font:700 10px var(--body,system-ui)}
#mw-show-pill{position:fixed;left:14px;bottom:calc(var(--tabbar,0px) + 76px + env(safe-area-inset-bottom,0px));z-index:9995;border:1px solid var(--gold,#d4a843);background:#14110b;color:var(--gold-hi,#f0cf78);font:700 13px var(--body,system-ui);padding:9px 14px;border-radius:999px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.5)}
body.has-player #mw-show-pill{bottom:calc(var(--tabbar,0px) + 92px + env(safe-area-inset-bottom,0px))}
#mw-choices{position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 70px);z-index:9998;width:min(440px,calc(100vw - 24px));background:linear-gradient(180deg,#1f1a10,#13110c);border:1px solid var(--gold-lo,#8a6a2a);border-radius:20px;box-shadow:0 22px 50px rgba(0,0,0,.65);padding:16px 16px 14px;animation:mwCh .45s cubic-bezier(.2,1.4,.4,1)}
@keyframes mwCh{from{opacity:0;transform:translate(-50%,-20px) scale(.95)}to{opacity:1;transform:translate(-50%,0)}}
#mw-choices{max-height:calc(100vh - 160px);overflow:auto}
#mw-choices h3{margin:0 26px 4px 0;font:800 18px var(--display,var(--body,system-ui));color:var(--gold-hi,#f0cf78)}
#mw-choices p{margin:0 0 10px;color:var(--muted,#bbb);font-size:14px;line-height:1.4}
#mw-choices .x{position:absolute;right:10px;top:8px;background:none;border:0;color:var(--muted,#bbb);font-size:22px;cursor:pointer}
#mw-choices .chips{display:flex;flex-wrap:wrap;gap:8px}
#mw-choices .chips button{border:1px solid var(--gold,#d4a843);background:#1d1810;color:var(--text,#fff);font:700 14px var(--body,system-ui);padding:9px 13px;border-radius:999px;cursor:pointer}
#mw-choices .chips button:hover{background:#2c2312}
#mw-choices .chips button.main{background:linear-gradient(135deg,#e2b54e,#c99a3a);color:#0b0a08;border-color:#f0cf78}
#mw-choices .legal{margin-top:12px;padding-top:12px;border-top:1px solid var(--line,#333)}
#mw-choices .legal b{display:block;color:var(--text,#fff);margin-bottom:4px}
body.mw-editing #mw-show,body.mw-editing #mw-choices,body.mw-editing #mw-show-pill{display:none}`;
  document.head.appendChild(css);

  const loud = () => on && v && !v.paused && !v.muted;
  // while the show has sound, other videos on the page start muted
  const canSound = window.MW_canSound;
  if (canSound) window.MW_canSound = () => !loud() && canSound();
  // another video (or the radio) takes the sound: the show steps aside
  const vs = window.MW_videoSound;
  if (vs && vs.start) { const s = vs.start; vs.start = function () { if (on) pause(true); return s.apply(this, arguments); }; }

  function src(k) { const o = list[k]; return `<source src="${o.src}" type="video/mp4"><source src="${o.local}" type="video/mp4">`; }
  function play(k, sound) {
    i = (k + list.length) % list.length;
    v.poster = list[i].poster; v.innerHTML = src(i); v.load();
    v.muted = !sound; paintTap();
    box.querySelector(".n").textContent = (i + 1) + " / " + list.length;
    v.play().catch(() => { v.muted = true; paintTap(); v.play().catch(() => {}); });
  }
  function paintTap() { const t = box.querySelector(".tap"); t.hidden = !v.muted; box.querySelector("[data-s=mute]").textContent = v.muted ? "🔇" : "🔊"; }
  function build() {
    box = document.createElement("div"); box.id = "mw-show"; box.setAttribute("aria-label", "Meechie's World videos");
    box.innerHTML = `<video playsinline preload="auto"></video><div class="ctl"><button type="button" data-s="close" aria-label="Close videos">×</button><span style="display:flex;gap:4px"><button type="button" data-s="mute" aria-label="Sound on or off">🔊</button><button type="button" data-s="big" aria-label="Bigger or smaller">⤢</button><button type="button" data-s="next" aria-label="Next video">⏭</button></span></div><button type="button" class="tap">🔊 Tap for sound</button><span class="n"></span>`;
    document.body.appendChild(box);
    v = box.querySelector("video");
    v.addEventListener("ended", () => play(i + 1, !v.muted));
    v.addEventListener("click", () => { if (v.paused) v.play().catch(() => {}); else v.pause(); });
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-s],.tap"); if (!b) return; e.stopPropagation();
      const s = b.dataset.s;
      if (s === "close") return pause(false);
      if (s === "next") return play(i + 1, !v.muted);
      if (s === "big") return box.classList.toggle("big");
      v.muted = !v.muted; if (!v.muted) { quietRadio(); v.play().catch(() => {}); } paintTap();
    });
  }
  function quietRadio() { try { if (typeof media !== "undefined" && media && !media.paused) media.pause(); } catch (_) {} }
  function pause(pill) {
    on = false; if (v) v.pause(); if (box) box.hidden = true;
    let p = $("#mw-show-pill");
    if (!p) { p = document.createElement("button"); p.type = "button"; p.id = "mw-show-pill"; p.textContent = "▶ Meechie's videos"; p.addEventListener("click", () => resume(true)); document.body.appendChild(p); }
    p.hidden = false;
  }
  function resume(sound) {
    if (!box) return start();
    on = true; box.hidden = false; const p = $("#mw-show-pill"); if (p) p.hidden = true;
    if (sound) { quietRadio(); v.muted = false; paintTap(); }
    v.play().catch(() => { v.muted = true; paintTap(); v.play().catch(() => {}); });
  }

  /* "Message Meechie directly": shows once his number is set in MW_CONFIG.OWNER_PHONE */
  function ownerPhone() {
    const raw = String((window.MW_CONFIG || {}).OWNER_PHONE || "").trim(); const d = raw.replace(/[^\d+]/g, "");
    if (d.replace(/\D/g, "").length < 10) return "";
    return `<div class="legal"><b>📱 Want to talk to Meechie?</b><p>Text or call him directly at <a href="tel:${d}" style="color:var(--gold-hi,#f0cf78);font-weight:800">${raw.replace(/[<>&"]/g, "")}</a>.</p>
<div class="chips"><a class="main" href="sms:${d}" style="text-decoration:none;border:1px solid #f0cf78;background:linear-gradient(135deg,#e2b54e,#c99a3a);color:#0b0a08;font:700 14px var(--body,system-ui);padding:9px 13px;border-radius:999px">💬 Text Meechie</a><a href="tel:${d}" style="text-decoration:none;border:1px solid var(--gold,#d4a843);background:#1d1810;color:var(--text,#fff);font:700 14px var(--body,system-ui);padding:9px 13px;border-radius:999px">📞 Call</a></div></div>`;
  }
  function choices() {
    if ($("#mw-choices")) return;
    const c = document.createElement("div"); c.id = "mw-choices"; c.setAttribute("role", "dialog"); c.setAttribute("aria-label", "What would you like to do?");
    c.innerHTML = `<button type="button" class="x" aria-label="Close">×</button>
<h3>Welcome to Meechie's World 👑</h3>
<p>Enjoy the videos. There's a lot waiting for you: Meechie's own <b>books</b>, original <b>Meechie's World gear</b> in the shop, <b>dating</b> to meet someone new, music and more. Pick one:</p>
<div class="chips">
  <button type="button" class="main" data-c="gbr">🎧 Listen to GRANT BOY RECORDS</button>
  <button type="button" data-c="stations">📻 Pick a different radio station</button>
  <button type="button" data-c="books">📚 Read Meechie's books</button>
  <button type="button" data-c="shop">🛍️ Shop original gear</button>
  <button type="button" data-c="dating">💘 Dating (18+)</button>
</div>${ownerPhone()}
<div class="legal"><b>⚖️ Need legal help? Criminal or civil?</b>
<p>We help you fight your case and file against anyone who violated your rights. No one is above the law.</p>
<div class="chips"><button type="button" data-c="criminal">🛡️ Criminal case</button><button type="button" data-c="civil">📄 Civil case / sue someone</button></div></div>`;
    document.body.appendChild(c);
    const close = () => c.remove();
    c.addEventListener("click", (e) => {
      if (e.target.closest(".x")) return close();
      const b = e.target.closest("[data-c]"); if (!b) return;
      const k = b.dataset.c, go = (x) => { if (typeof window.go === "function") window.go(x); };
      close();
      if (k === "gbr") { pause(true); try { sessionStorage.removeItem("mw_radio_off"); } catch (_) {} if (typeof window.tuneIn === "function") window.tuneIn(); go("radio"); }
      else if (k === "stations") { pause(true); go("liveradio"); }
      else if (k === "shop") go("shop");
      else if (k === "books") go("books");
      else if (k === "dating") go("dating");
      else { go("legal"); try { sessionStorage.setItem("mw_legal_kind", k); } catch (_) {} const v = document.getElementById("v-legal"); if (v) setTimeout(() => v.scrollIntoView({ behavior: "smooth", block: "start" }), 120); }
    });
  }

  function start() {
    list = window.MW_ORIGINALS || [];
    if (!list.length) { choices(); return; }
    if (!box) build();
    on = true; box.hidden = false; const p = $("#mw-show-pill"); if (p) p.hidden = true;
    quietRadio(); play(i, true); choices();
  }
  window.MW_show = { start, pause: () => pause(true), resume, active: () => on, loud };
})();
