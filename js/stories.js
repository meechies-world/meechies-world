/* Meechie's Book Stories: real 24-hour stories (photo, video or text on a gold background), like Facebook/Instagram but nicer.
 * - "Your story" first, then everyone else's. A gold ring means there's something you haven't seen yet.
 * - Full-screen viewer: progress bars, tap left/right, hold to pause, swipe down (or ×) to close.
 * - Reply or send a quick reaction: it goes to them as a private message.
 * - On your own story: see who viewed it, and delete it.
 * Data: stories/<id> {authorId, kind, url, text, bg, caption, createdAt} · storyviews/<story>_<viewer> {authorId: viewer, story, owner, at}
 * Stories older than 24 hours aren't shown. */
(function () {
  "use strict";
  const view = document.getElementById("v-community"); if (!view) return;
  window.MW_REAL_STORIES = true;
  const DAY = 864e5, PHOTO_MS = 6000, MAX_VIDEO_MS = 30000;
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => { try { return typeof me !== "undefined" ? me : null; } catch (_) { return null; } };
  const NAME = (id) => { try { return typeof handleOf === "function" ? handleOf(id) : "Member"; } catch (_) { return "Member"; } };
  const AV = (id) => { try { return typeof avatarOf === "function" ? avatarOf(id) : ""; } catch (_) { return ""; } };
  const MEM = () => { try { return typeof members !== "undefined" ? members : {}; } catch (_) { return {}; } };
  const okUrl = (u) => /^https:\/\/|^\/m\//.test(u || "") || String(u || "").startsWith(location.origin + "/m/");
  const safe = (u) => (okUrl(u) && !/[\s"'()<>\\]/.test(String(u)) ? u : ""); // no quotes/brackets: these go inside CSS url('…')
  const BGS = { gold: "linear-gradient(160deg,#fff1b8,#e3ad3c 45%,#8a5a12)", night: "radial-gradient(120% 90% at 50% 0%,#3a2a0c,#050505 70%)", royal: "linear-gradient(160deg,#2b0a3d,#7b3fb0 55%,#e3ad3c)", fire: "linear-gradient(160deg,#ffcc4d,#ff5a1f 55%,#5a0d0d)", ocean: "linear-gradient(160deg,#56ccf2,#2f80ed 55%,#0b1a3a)", rose: "linear-gradient(160deg,#ffd1dc,#e0559a 55%,#3a0a24)" };
  const REACT = ["😍", "🔥", "😂", "👏", "💯", "👑"];
  let db = null, stories = [], views = [], seen = new Set();
  try { seen = new Set(JSON.parse(localStorage.getItem("mw_story_seen") || "[]")); } catch (_) {}
  const saveSeen = () => { try { localStorage.setItem("mw_story_seen", JSON.stringify([...seen].slice(-800))); } catch (_) {} };

  const css = document.createElement("style");
  css.textContent = `#fb-stories .st{flex:none;width:112px;height:196px;border-radius:14px;position:relative;overflow:hidden;cursor:pointer;border:0;padding:0;color:#fff;text-align:left;background:#15120c center/cover;box-shadow:0 0 0 1px rgba(255,224,138,.35),0 10px 24px rgba(0,0,0,.5)}
#fb-stories .st::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.35),transparent 35%,transparent 60%,rgba(0,0,0,.7))}
#fb-stories .st .ring{position:absolute;left:8px;top:8px;z-index:1;width:40px;height:40px;border-radius:50%;padding:3px;background:conic-gradient(#fff3c4,#ffcf55,#d08a1c,#ffe9a0,#fff3c4)}
#fb-stories .st.seen .ring{background:#6b6355}
#fb-stories .st .ring .avatar{width:34px!important;height:34px!important;margin:0!important;border:2px solid #0b0906}
#fb-stories .st b{position:absolute;left:8px;right:8px;bottom:8px;z-index:1;font:700 13px/1.2 system-ui;text-shadow:0 1px 3px #000}
#fb-stories .st .txt{position:absolute;inset:0;display:grid;place-items:center;padding:12px;text-align:center;font:800 15px/1.2 var(--brush,system-ui);text-shadow:0 2px 6px rgba(0,0,0,.4)}
#fb-stories .st.add{background:#0e0c09}#fb-stories .st.add::after{display:none}
#fb-stories .st.add .top{height:132px;background:#241d10 center/cover;display:grid;place-items:center;font-size:38px}
#fb-stories .st.add .plus{position:absolute;left:50%;top:116px;transform:translateX(-50%);width:36px;height:36px;border-radius:50%;background:linear-gradient(172deg,#fff6cf,#ffd76a 30%,#e0a93a 60%,#ffe08a);border:4px solid #0e0c09;display:grid;place-items:center;font:900 22px/1 system-ui;color:#130e04;z-index:2}
#fb-stories .st.add b{text-align:center;text-shadow:none;color:#ffe08a}
#st-view{position:fixed;inset:0;z-index:10070;background:#000;display:grid;place-items:center;touch-action:none;user-select:none;-webkit-user-select:none}
#st-view .stage{position:absolute;inset:0;margin:auto;max-width:min(100vw,calc(100dvh*9/16));display:grid;place-items:center;overflow:hidden}
#st-view .stage img,#st-view .stage video{width:100%;height:100%;object-fit:contain;background:#000}
#st-view .stage .text{width:100%;height:100%;display:grid;place-items:center;padding:28px;text-align:center;font:400 clamp(28px,8vw,46px)/1.15 var(--brush,system-ui);color:#fff;text-shadow:0 3px 14px rgba(0,0,0,.45);white-space:pre-wrap;overflow-wrap:anywhere}
#st-view .cap{position:absolute;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 88px);z-index:3;text-align:center;padding:0 22px;color:#fff;font:600 16px/1.35 system-ui;text-shadow:0 2px 8px #000}
#st-view .bars{position:absolute;z-index:4;top:calc(env(safe-area-inset-top,0px) + 8px);left:10px;right:10px;display:flex;gap:4px;max-width:min(100vw - 20px,calc(100dvh*9/16 - 20px));margin:auto}
#st-view .bars i{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.3);overflow:hidden}#st-view .bars b{display:block;height:100%;width:0;background:linear-gradient(90deg,#fff3c4,#ffcf55)}
#st-view .who{position:absolute;z-index:4;top:calc(env(safe-area-inset-top,0px) + 20px);left:14px;display:flex;align-items:center;gap:8px;color:#fff;font:700 15px system-ui;text-shadow:0 1px 4px #000}
#st-view .who .avatar{width:36px;height:36px;margin:0}#st-view .who small{font-weight:500;opacity:.8}
#st-view .x{position:absolute;z-index:5;top:calc(env(safe-area-inset-top,0px) + 16px);right:12px;width:40px;height:40px;border-radius:50%;border:0;background:rgba(0,0,0,.45);color:#fff;font-size:24px;cursor:pointer}
#st-view .tap{position:absolute;z-index:2;top:70px;bottom:150px;width:35%}#st-view .tap.l{left:0}#st-view .tap.r{right:0}
#st-view .foot{position:absolute;z-index:5;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);display:grid;gap:8px;padding:0 14px;max-width:560px;margin:auto}
#st-view .reacts{display:flex;gap:6px;justify-content:center}#st-view .reacts button{border:0;background:rgba(0,0,0,.35);border-radius:50%;width:44px;height:44px;font-size:24px;cursor:pointer}
#st-view form{display:flex;gap:8px}#st-view form input{flex:1;min-width:0;border-radius:999px;border:1px solid rgba(255,255,255,.55);background:rgba(0,0,0,.35);color:#fff;padding:11px 14px;font:16px system-ui}
#st-view form button,#st-view .own button{border:0;border-radius:999px;background:linear-gradient(172deg,#fff6cf,#ffd76a 30%,#e0a93a 60%,#ffe08a);color:#130e04;font:800 14px system-ui;padding:0 16px;cursor:pointer}
#st-view .own{display:flex;gap:8px;justify-content:center}#st-view .own button{padding:11px 16px}#st-view .own button.ghost{background:rgba(0,0,0,.45);color:#fff;border:1px solid rgba(255,255,255,.5)}
#st-seen{position:absolute;z-index:6;left:0;right:0;bottom:0;max-height:55dvh;overflow:auto;background:#0e0c09;border-top:1px solid #d6aa4a;border-radius:18px 18px 0 0;padding:14px;color:#fff}
#st-seen div{display:flex;gap:10px;align-items:center;padding:6px 0;font:600 14px system-ui}#st-seen .avatar{width:34px;height:34px;margin:0}
#st-new{width:min(440px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:0}
#st-new form{display:grid;gap:12px;padding:18px}
#st-new .tabs{display:flex;gap:6px}#st-new .tabs button{flex:1;border:1px solid #d6aa4a;background:transparent;color:#ffe08a;border-radius:999px;padding:9px;font:800 13px system-ui;cursor:pointer}#st-new .tabs button[aria-pressed=true]{background:linear-gradient(172deg,#fff6cf,#ffd76a 30%,#e0a93a 60%,#ffe08a);color:#130e04}
#st-new .prev{aspect-ratio:9/16;height:min(46dvh,420px);margin:0 auto;width:auto;max-width:100%;border-radius:16px;overflow:hidden;display:grid;place-items:center;background:#000;position:relative}
#st-new .prev img,#st-new .prev video{width:100%;height:100%;object-fit:cover}
#st-new .prev .text{position:absolute;inset:0;display:grid;place-items:center;padding:18px;text-align:center;font:400 30px/1.15 var(--brush,system-ui);color:#fff;text-shadow:0 3px 14px rgba(0,0,0,.45);white-space:pre-wrap;overflow-wrap:anywhere}
#st-new .bgs{display:flex;gap:8px;justify-content:center}#st-new .bgs button{width:34px;height:34px;border-radius:50%;border:2px solid #0008;cursor:pointer}#st-new .bgs button[aria-pressed=true]{outline:3px solid #fff;outline-offset:2px}
#st-new textarea,#st-new input[type=text]{width:100%;border-radius:12px;padding:10px;font:16px system-ui}`;
  document.head.appendChild(css);

  const live = () => stories.filter((s) => s.createdAt > Date.now() - DAY && (s.url || s.text)).sort((a, b) => a.createdAt - b.createdAt);
  function groups() {
    const by = new Map(); for (const s of live()) { if (!by.has(s.authorId)) by.set(s.authorId, []); by.get(s.authorId).push(s); }
    const mine = ME(), fr = (() => { try { return new Set(window.MW_FRIENDS && MW_FRIENDS.list ? MW_FRIENDS.list() : []); } catch (_) { return new Set(); } })();
    return [...by.entries()].map(([uid, list]) => ({ uid, list, unseen: list.some((s) => !seen.has(s.id)), last: list[list.length - 1].createdAt }))
      .sort((a, b) => (b.uid === mine) - (a.uid === mine) || b.unseen - a.unseen || fr.has(b.uid) - fr.has(a.uid) || b.last - a.last);
  }
  function thumb(s) { return s.kind === "text" ? `<span class="txt" style="background:${BGS[s.bg] || BGS.gold}">${E(String(s.text).slice(0, 60))}</span>` : ""; }
  function paint() {
    const box = document.getElementById("fb-stories"); if (!box) return;
    const gs = groups(), mine = ME(), myG = gs.find((g) => g.uid === mine);
    const myPhoto = (() => { const m = MEM()[mine] || {}; return safe(m.photo); })();
    let html = `<button type="button" class="st add" data-st-new><div class="top" ${myPhoto ? `style="background-image:url('${E(myPhoto)}')"` : ""}>${myPhoto ? "" : "📷"}</div><span class="plus">+</span><b>${myG ? "Add to story" : "Create story"}</b></button>`;
    html += gs.map((g, i) => { const s = g.list[g.list.length - 1]; const bg = s.kind === "photo" ? `style="background-image:url('${E(safe(s.url))}')"` : "";
      return `<button type="button" class="st${g.unseen ? "" : " seen"}" data-st-open="${i}" ${bg}>${s.kind === "video" ? `<video src="${E(safe(s.url))}#t=0.5" muted playsinline preload="metadata" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>` : ""}${thumb(s)}<span class="ring">${AV(g.uid)}</span><b>${g.uid === mine ? "Your story" : E(NAME(g.uid))}</b></button>`; }).join("");
    box.innerHTML = html; box._groups = gs;
  }

  /* ---------- viewer ---------- */
  let V = null;
  function open(gi, si) {
    const gs = groups(); if (!gs[gi]) return;
    close(); V = { gs, gi, si: si || 0, t0: 0, paused: false, pausedAt: 0, dur: PHOTO_MS, timer: null };
    const el = document.createElement("div"); el.id = "st-view"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Story");
    el.innerHTML = `<div class="stage"></div><div class="bars"></div><div class="who"></div><button type="button" class="x" aria-label="Close">×</button><div class="tap l"></div><div class="tap r"></div><div class="cap" hidden></div><div class="foot"></div>`;
    document.body.appendChild(el); V.el = el; document.documentElement.style.overflow = "hidden";
    // hold to pause, swipe down to close
    let y0 = null, held = null;
    el.addEventListener("pointerdown", (e) => { if (e.target.closest("button,input,form,#st-seen")) return; y0 = e.clientY; held = setTimeout(() => pause(true), 180); });
    el.addEventListener("pointerup", (e) => { clearTimeout(held); if (y0 != null && e.clientY - y0 > 90) { close(); return; } if (V && V.paused && !V.hold) pause(false); y0 = null; });
    el.addEventListener("click", onClick);
    el.addEventListener("submit", onReply);
    show();
    V.timer = setInterval(tick, 80);
  }
  function close() { if (!V) return; clearInterval(V.timer); V.el.remove(); V = null; document.documentElement.style.overflow = ""; paint(); }
  function cur() { return V && V.gs[V.gi] && V.gs[V.gi].list[V.si]; }
  function show() {
    const g = V.gs[V.gi], s = cur(); if (!s) return close();
    const mine = s.authorId === ME();
    V.t0 = Date.now(); V.paused = false; V.dur = PHOTO_MS;
    const stage = V.el.querySelector(".stage");
    if (s.kind === "video") {
      stage.innerHTML = `<video src="${E(safe(s.url))}" playsinline autoplay ${window.MW_canSound && !window.MW_canSound() ? "muted" : ""}></video>`;
      const v = stage.querySelector("video"); v.addEventListener("loadedmetadata", () => { V && (V.dur = Math.min(MAX_VIDEO_MS, (v.duration || 6) * 1000)); });
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    } else if (s.kind === "text") stage.innerHTML = `<div class="text" style="background:${BGS[s.bg] || BGS.gold}">${E(s.text)}</div>`;
    else stage.innerHTML = `<img src="${E(safe(s.url))}" alt="" draggable="false">`;
    const cap = V.el.querySelector(".cap"); cap.hidden = !s.caption; cap.textContent = s.caption || "";
    V.el.querySelector(".bars").innerHTML = g.list.map((_, k) => `<i><b style="width:${k < V.si ? 100 : 0}%"></b></i>`).join("");
    const mins = Math.floor((Date.now() - s.createdAt) / 6e4), ago = mins < 1 ? "now" : mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h";
    V.el.querySelector(".who").innerHTML = `${AV(g.uid)}<span>${E(mine ? "Your story" : NAME(g.uid))} <small>${ago}</small></span>`;
    const foot = V.el.querySelector(".foot");
    if (mine) {
      const n = views.filter((v) => v.story === s.id).length;
      foot.innerHTML = `<div class="own"><button type="button" class="ghost" data-st-seen>👁 Seen by ${n}</button><button type="button" class="ghost" data-st-del>🗑 Delete</button><button type="button" data-st-new>＋ Add</button></div>`;
    } else {
      foot.innerHTML = `<div class="reacts">${REACT.map((r) => `<button type="button" data-st-react="${r}" aria-label="React ${r}">${r}</button>`).join("")}</div><form><input maxlength="300" placeholder="Reply to ${E(NAME(g.uid))}…" aria-label="Reply"><button type="submit">Send</button></form>`;
      markSeen(s);
    }
    seen.add(s.id); saveSeen();
  }
  function tick() {
    if (!V || V.paused) return; const f = Math.min(1, (Date.now() - V.t0) / V.dur);
    const b = V.el.querySelectorAll(".bars b")[V.si]; if (b) b.style.width = f * 100 + "%";
    if (f >= 1) next();
  }
  function pause(on) {
    if (!V) return; const vid = V.el.querySelector(".stage video");
    if (on && !V.paused) { V.paused = true; V.pausedAt = Date.now(); if (vid) vid.pause(); }
    else if (!on && V.paused) { V.paused = false; V.t0 += Date.now() - V.pausedAt; if (vid) vid.play().catch(() => {}); }
  }
  function next() { if (!V) return; if (V.si < V.gs[V.gi].list.length - 1) { V.si++; return show(); } if (V.gi < V.gs.length - 1) { V.gi++; V.si = 0; return show(); } close(); }
  function prev() { if (!V) return; if (V.si > 0) { V.si--; return show(); } if (V.gi > 0) { V.gi--; V.si = V.gs[V.gi].list.length - 1; return show(); } V.t0 = Date.now(); }
  async function onClick(e) {
    if (e.target.closest(".x")) return close();
    if (e.target.closest(".tap.l")) return prev();
    if (e.target.closest(".tap.r")) return next();
    const s = cur(); if (!s) return;
    const r = e.target.closest("[data-st-react]"); if (r) { await sendDm(s.authorId, `${r.dataset.stReact} reacted to your story`); flyUp(r.dataset.stReact); return; }
    if (e.target.closest("[data-st-del]")) { const b = e.target.closest("[data-st-del]"); if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "Tap again to delete"; pause(true); return; } try { await db.doc("stories/" + s.id).delete(); stories = stories.filter((x) => x.id !== s.id); say("Story deleted"); } catch (er) { say(er.message || er.code); } V.gs = groups(); const gi = V.gs.findIndex((g) => g.uid === ME()); if (gi < 0) return close(); V.gi = gi; V.si = Math.min(V.si, V.gs[gi].list.length - 1); return show(); }
    if (e.target.closest("[data-st-seen]")) { pause(true); const list = views.filter((v) => v.story === s.id).sort((a, b) => b.at - a.at); const sh = document.createElement("div"); sh.id = "st-seen"; sh.innerHTML = `<b style="display:block;margin-bottom:8px">👁 Seen by ${list.length}</b>` + (list.map((v) => `<div>${AV(v.authorId)}${E(NAME(v.authorId))}</div>`).join("") || `<span class="muted">No views yet.</span>`) + `<button type="button" class="btn ghost sm" style="margin-top:10px" data-st-seen-x>Close</button>`; V.el.appendChild(sh); return; }
    if (e.target.closest("[data-st-seen-x]")) { V.el.querySelector("#st-seen")?.remove(); pause(false); return; }
    if (e.target.closest("[data-st-new]")) { close(); return compose(); }
  }
  async function onReply(e) {
    e.preventDefault(); const s = cur(); if (!s) return; const inp = e.target.querySelector("input"); const t = inp.value.trim(); if (!t) return; inp.value = "";
    await sendDm(s.authorId, `↩️ Replied to your story: ${t}`); say("Sent to " + NAME(s.authorId)); pause(false);
  }
  function flyUp(emo) { if (!V) return; const f = document.createElement("span"); f.textContent = emo; f.style.cssText = "position:absolute;z-index:7;left:50%;bottom:140px;font-size:56px;transform:translateX(-50%);transition:transform 1.1s ease-out,opacity 1.1s;pointer-events:none"; V.el.appendChild(f); requestAnimationFrame(() => { f.style.transform = "translate(-50%,-260px) scale(1.3)"; f.style.opacity = "0"; }); setTimeout(() => f.remove(), 1200); }
  async function sendDm(to, body) {
    if (!ME()) { say("Sign in first."); return; } if (to === ME()) return;
    try { const r = await MW.sb.from("dms").insert({ recipient: to, body }); if (r.error) throw r.error; } catch (er) { say(er.message || "Couldn't send."); }
  }
  async function markSeen(s) {
    const mine = ME(); if (!mine || !db || s.authorId === mine) return;
    const id = (s.id + "_" + mine.replace(/-/g, "")).slice(0, 64);
    if (views.some((v) => v.story === s.id && v.authorId === mine)) return;
    views.push({ story: s.id, authorId: mine, at: Date.now() });
    try { await db.doc("storyviews/" + id).set({ authorId: mine, story: s.id, owner: s.authorId, at: Date.now() }); } catch (_) {}
  }

  /* ---------- create ---------- */
  let draft = null;
  function compose() {
    if (!ME()) { const j = document.querySelector('[data-auth="signup"]'); if (j) j.click(); return; }
    draft = { kind: "photo", file: null, url: "", text: "", bg: "gold", caption: "" };
    let d = document.getElementById("st-new"); if (!d) { d = document.createElement("dialog"); d.id = "st-new"; document.body.appendChild(d); d.addEventListener("click", (e) => { if (e.target === d) d.close(); }); }
    d.innerHTML = `<form id="st-form"><h3 style="margin:0">✨ Create a story</h3><p class="muted" style="margin:0;font-size:13px">Stories disappear after 24 hours.</p>
<div class="tabs"><button type="button" data-st-kind="photo" aria-pressed="true">📷 Photo / video</button><button type="button" data-st-kind="text" aria-pressed="false">Aa Text</button></div>
<div class="prev" id="st-prev"><span class="muted">Pick a photo or video</span></div>
<input type="file" id="st-file" accept="image/*,video/*" hidden>
<div id="st-photo-row"><button type="button" class="btn ghost" style="width:100%" data-st-pick>📁 Choose from your phone</button></div>
<div id="st-text-row" hidden><textarea id="st-text" maxlength="200" rows="3" placeholder="Start typing…"></textarea><div class="bgs" style="margin-top:8px">${Object.entries(BGS).map(([k, v]) => `<button type="button" data-st-bg="${k}" style="background:${v}" aria-pressed="${k === "gold"}" aria-label="${k}"></button>`).join("")}</div></div>
<input type="text" id="st-cap" maxlength="140" placeholder="Add a caption (optional)">
<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn ghost" data-st-cancel>Cancel</button><button class="btn" type="submit" id="st-share">Share to story</button></div></form>`;
    d.showModal();
  }
  function paintPrev() {
    const p = document.getElementById("st-prev"); if (!p) return;
    if (draft.kind === "text") p.innerHTML = `<div class="text" style="background:${BGS[draft.bg]}">${E(draft.text || "Start typing…")}</div>`;
    else if (draft.file) { const u = URL.createObjectURL(draft.file); p.innerHTML = /^video\//.test(draft.file.type) ? `<video src="${u}" muted autoplay loop playsinline></video>` : `<img src="${u}" alt="">`; }
    else p.innerHTML = `<span class="muted">Pick a photo or video</span>`;
  }
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("[data-st-new]") && !V) { e.preventDefault(); e.stopPropagation(); return compose(); }
    const o = t.closest("[data-st-open]"); if (o) { e.preventDefault(); e.stopImmediatePropagation(); const box = document.getElementById("fb-stories"); const gs = box && box._groups; const g = gs && gs[+o.dataset.stOpen]; if (!g) return; const firstUnseen = Math.max(0, g.list.findIndex((s) => !seen.has(s.id))); return open(+o.dataset.stOpen, firstUnseen); }
    if (!draft) return;
    const k = t.closest("[data-st-kind]"); if (k) { draft.kind = k.dataset.stKind; document.querySelectorAll("[data-st-kind]").forEach((b) => b.setAttribute("aria-pressed", String(b === k))); document.getElementById("st-photo-row").hidden = draft.kind === "text"; document.getElementById("st-text-row").hidden = draft.kind !== "text"; paintPrev(); if (draft.kind === "text") document.getElementById("st-text").focus(); return; }
    if (t.closest("[data-st-pick]")) return document.getElementById("st-file").click();
    const bg = t.closest("[data-st-bg]"); if (bg) { draft.bg = bg.dataset.stBg; document.querySelectorAll("[data-st-bg]").forEach((b) => b.setAttribute("aria-pressed", String(b === bg))); return paintPrev(); }
    if (t.closest("[data-st-cancel]")) { document.getElementById("st-new").close(); draft = null; }
  }, true);
  document.addEventListener("change", (e) => { if (e.target.id === "st-file" && draft) { draft.file = e.target.files[0] || null; draft.kind = draft.file && /^video\//.test(draft.file.type) ? "video" : "photo"; paintPrev(); } });
  document.addEventListener("input", (e) => { if (e.target.id === "st-text" && draft) { draft.text = e.target.value; paintPrev(); } });
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "st-form" || !draft) return; e.preventDefault();
    const btn = document.getElementById("st-share"); btn.disabled = true;
    try {
      const data = { authorId: ME(), caption: document.getElementById("st-cap").value.trim().slice(0, 140), createdAt: Date.now() };
      if (draft.kind === "text") { if (!draft.text.trim()) throw new Error("Type something first."); Object.assign(data, { kind: "text", text: draft.text.trim().slice(0, 200), bg: draft.bg }); }
      else {
        if (!draft.file) throw new Error("Pick a photo or video.");
        btn.textContent = "Uploading…";
        if (/^video\//.test(draft.file.type)) { const up = await MW.uploadVideo(draft.file, (f) => { btn.textContent = "Uploading " + Math.round(f * 100) + "%"; }); data.kind = "video"; data.url = up.url; }
        else { const small = typeof compress === "function" ? await compress(draft.file, 1440) : null; const blob = small ? await (await fetch(small)).blob() : draft.file; const up = await MW.uploadMedia(blob, { type: "image/jpeg", ext: "jpg" }); data.kind = "photo"; data.url = up.url; }
        if (!okUrl(data.url)) throw new Error("Upload failed. Try again.");
      }
      const ref = await db.collection("stories").add(data);
      stories.push({ id: ref.id, ...data }); seen.add(ref.id); saveSeen(); paint();
      document.getElementById("st-new").close(); draft = null; say("Your story is up for 24 hours ✨");
    } catch (er) { say(er.message || String(er)); btn.disabled = false; btn.textContent = "Share to story"; }
  });
  document.addEventListener("keydown", (e) => { if (!V) return; if (e.key === "Escape") close(); if (e.key === "ArrowRight") next(); if (e.key === "ArrowLeft") prev(); });

  /* ---------- data ---------- */
  async function init() {
    if (!window.claude) return setTimeout(init, 500);
    db = await claude.use("db"); if (!db) return;
    db.collection("stories").orderBy("createdAt", "desc").limit(150).onSnapshot((s) => { stories = s.docs.map((d) => ({ id: d.id, ...d.data() })); if (!V) paint(); }, () => {});
    db.collection("storyviews").orderBy("at", "desc").limit(400).onSnapshot((s) => { views = s.docs.map((d) => d.data()); }, () => {});
    // fb-feed.js rebuilds the row when the page opens; draw ours again right after
    new MutationObserver(() => { if (!view.hidden) setTimeout(paint, 60); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
    setInterval(() => { if (!view.hidden && !V) paint(); }, 60000);
    paint();
  }
  init();
  window.MW_stories = { compose, open: (uid) => { const gs = groups(); const i = gs.findIndex((g) => g.uid === uid); if (i >= 0) open(i, 0); } };
})();
