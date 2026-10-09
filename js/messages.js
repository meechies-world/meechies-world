/*
 * Private messages (member to member).
 * Stored in the `dms` table. Row-level security means only the sender and the
 * recipient can ever read a message. Not end-to-end encrypted.
 */
(function () {
  "use strict";
  const view = document.getElementById("v-messages");
  if (!view || !window.MW || !MW.ready) return;
  const sb = MW.sb;
  let uid = null, all = [], other = null, q = "", timer = null, started = false;

  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const handle = (id) => (typeof members !== "undefined" && members[id] && members[id].handle) || "Member";
  const ini = (s) => (String(s || "?").trim()[0] || "?").toUpperCase();
  const when = (iso) => { const ms = new Date(iso).getTime(), s = (Date.now() - ms) / 1000; if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return new Date(ms).toLocaleDateString(); };
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  /* walkie-talkie voice messages: body = "🎙️ Voice message ⟦<our storage url>⟧" */
  const VOICE_RE = /^🎙️ Voice message ⟦(https:\/\/yjouaysczttqbytksejq\.supabase\.co\/storage\/v1\/object\/public\/media\/[A-Za-z0-9_\-\/]+\.(?:webm|m4a|mp4|ogg))⟧$/;
  const voiceUrl = (b) => (VOICE_RE.exec(b || "") || [])[1] || "";
  const preview = (b) => (voiceUrl(b) ? "🎙️ Voice message" : b);
  const bootAt = Date.now(); const heard = new Set();
  function autoPlayVoices() {
    let walkieOn = true; try { walkieOn = localStorage.getItem("mw_walkie_auto") !== "0"; } catch (_) {}
    for (const r of all) {
      const u = voiceUrl(r.body); if (!u || r.sender === uid || heard.has(r.id) || new Date(r.created_at).getTime() < bootAt - 5000) continue;
      heard.add(r.id);
      const isFriend = window.MW_FRIENDS && MW_FRIENDS.isFriend(r.sender);
      if (!walkieOn || !(isFriend || r.sender === other)) continue;
      say("📻 Walkie from " + handle(r.sender));
      try { if (typeof media !== "undefined" && !media.paused) { media.volume = 0.25; } } catch (_) {}
      const a = new Audio(u); a.play().catch(() => {}); a.onended = a.onerror = () => { try { media.volume = 1; } catch (_) {} };
    }
  }

  function convos() {
    const m = new Map();
    for (const r of all) {
      const o = r.sender === uid ? r.recipient : r.sender;
      let c = m.get(o); if (!c) { c = { id: o, last: r, unread: 0 }; m.set(o, c); }
      if (r.recipient === uid && !r.read_at) c.unread++;
    }
    return [...m.values()].sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
  }
  function paintDot() {
    const n = all.filter((r) => r.recipient === uid && !r.read_at).length;
    document.querySelectorAll("[data-go=messages] .dm-dot").forEach((d) => { d.hidden = !n; d.textContent = n > 9 ? "9+" : n; });
  }

  async function load() {
    const { data, error } = await sb.from("dms").select("*").order("created_at", { ascending: false }).limit(600);
    if (error) { console.warn(error); return; }
    all = data || []; paintDot(); autoPlayVoices(); if (!view.hidden) render();
  }
  function later() { clearTimeout(timer); timer = setTimeout(load, 200); }

  async function markRead() {
    if (!other) return;
    if (!all.some((r) => r.sender === other && r.recipient === uid && !r.read_at)) return;
    await sb.from("dms").update({ read_at: new Date().toISOString() }).eq("recipient", uid).eq("sender", other).is("read_at", null);
    all.forEach((r) => { if (r.sender === other && r.recipient === uid && !r.read_at) r.read_at = new Date().toISOString(); });
    paintDot();
  }

  function render() {
    if (!uid) {
      view.querySelector(".dm-app").innerHTML = `<div class="empty" style="grid-column:1/-1">Join free to send private messages.<br><button class="btn" type="button" data-auth="signup" style="margin-top:12px">Join free</button></div>`;
      return;
    }
    const app = view.querySelector(".dm-app");
    app.classList.toggle("has-thread", !!other);
    const list = view.querySelector(".dm-list"), thread = view.querySelector(".dm-thread");
    const ms = typeof members !== "undefined" ? members : {};
    let items = "";
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      const found = Object.keys(ms).filter((id) => id !== uid && (ms[id].handle || "").toLowerCase().includes(t)).slice(0, 12);
      items = found.length ? found.map((id) => `<button type="button" class="dm-row" data-open="${id}"><span class="avatar">${E(ini(ms[id].handle))}</span><span class="dm-t"><b>${E(ms[id].handle)}</b><small>${E(ms[id].bio || "Member")}</small></span></button>`).join("") : `<p class="muted" style="margin:10px 4px">No member found with that name.</p>`;
    } else {
      const cs = convos();
      items = cs.length ? cs.map((c) => `<button type="button" class="dm-row ${c.id === other ? "on" : ""}" data-open="${c.id}"><span class="avatar">${E(ini(handle(c.id)))}</span><span class="dm-t"><b>${E(handle(c.id))}</b><small>${c.last.sender === uid ? "You: " : ""}${E(preview(c.last.body).slice(0, 60))}</small></span><span class="dm-m">${when(c.last.created_at)}${c.unread ? `<i>${c.unread}</i>` : ""}</span></button>`).join("") : `<p class="muted" style="margin:10px 4px">No messages yet. Search for a member above, or tap Message on a member card.</p>`;
    }
    list.innerHTML = items;
    if (!other) { thread.innerHTML = `<div class="dm-none"><svg class="sqc-ico" aria-hidden="true" style="width:46px;height:46px"><use href="#sqc"/></svg><b>Private messages</b><span class="muted">Only you and the other person can read these. They are not end-to-end encrypted, so never send passwords or card numbers.</span></div>`; return; }
    const msgs = all.filter((r) => (r.sender === uid && r.recipient === other) || (r.sender === other && r.recipient === uid)).slice().reverse();
    thread.innerHTML = `<div class="dm-head"><button type="button" class="act dm-back" data-back>← Back</button><span class="avatar">${E(ini(handle(other)))}</span><b>${E(handle(other))}</b></div>
<div class="dm-msgs" id="dm-msgs">${msgs.length ? msgs.map((r) => `<div class="dm-b ${r.sender === uid ? "me" : ""}"><div>${voiceUrl(r.body) ? `<span style="font-size:13px">🎙️ Walkie</span><audio src="${E(voiceUrl(r.body))}" controls preload="none" style="display:block;max-width:240px;margin-top:4px"></audio>` : E(r.body)}</div><small>${when(r.created_at)}${r.sender === uid && r.read_at ? " · seen" : ""}</small></div>`).join("") : `<p class="muted" style="text-align:center;margin:auto">Say hello to ${E(handle(other))}.</p>`}</div>
<form class="dm-form" id="dm-form"><button type="button" class="dm-walkie" id="dm-walkie" aria-label="Hold to talk (walkie-talkie)">📻</button><input type="text" id="dm-in" aria-label="Message" maxlength="2000" placeholder="Message, or hold 📻 to talk" autocomplete="off" required><button class="btn" type="submit">Send</button></form>`;
    const box = document.getElementById("dm-msgs"); if (box) box.scrollTop = box.scrollHeight;
    markRead();
  }

  function open(id) { other = id; q = ""; const s = view.querySelector(".dm-search"); if (s) s.value = ""; if (typeof go === "function") go("messages"); render(); setTimeout(() => { const i = document.getElementById("dm-in"); if (i) i.focus(); }, 50); }

  function build() {
    const css = document.createElement("style");
    css.textContent = `
.dm-app{display:grid;grid-template-columns:minmax(0,320px) minmax(0,1fr);gap:14px;min-height:520px}
.dm-side,.dm-thread{background:linear-gradient(180deg,#17130c,#0f0d09);border:1px solid var(--line);border-radius:16px;display:flex;flex-direction:column;min-height:0}
.dm-side{padding:12px;gap:10px;max-height:640px}
.dm-search{width:100%;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--text);font:inherit}
.dm-list{display:grid;gap:4px;overflow:auto;align-content:start}
.dm-row{display:flex;gap:10px;align-items:center;text-align:left;background:none;border:1px solid transparent;border-radius:12px;padding:8px;color:var(--text);cursor:pointer;font:inherit;width:100%}
.dm-row:hover,.dm-row.on{background:var(--panel-2);border-color:var(--line)}
.dm-t{display:grid;min-width:0;flex:1}.dm-t b,.dm-t small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dm-t small{color:var(--muted)}
.dm-m{display:grid;justify-items:end;gap:4px;font-size:12px;color:var(--muted)}
.dm-m i{font-style:normal;background:var(--gold);color:var(--ink);border-radius:999px;padding:1px 7px;font-weight:700}
.dm-thread{min-height:520px;max-height:640px}
.dm-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)}
.dm-back{display:none}
.dm-msgs{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.dm-b{max-width:78%;background:var(--panel-2);border:1px solid var(--line);border-radius:14px 14px 14px 4px;padding:8px 12px;align-self:flex-start;overflow-wrap:anywhere}
.dm-b.me{align-self:flex-end;background:rgba(212,168,67,.16);border-color:var(--gold-lo);border-radius:14px 14px 4px 14px}
.dm-b small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.dm-form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line)}
.dm-walkie{width:46px;height:46px;flex:none;border-radius:50%;border:2px solid var(--gold);background:#1d1810;color:#fff;font-size:20px;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}
.dm-walkie.on{background:#e5484d;border-color:#e5484d;box-shadow:0 0 0 6px rgba(229,72,77,.3)}
.dm-form input{flex:1;min-width:0;background:var(--ink);border:1px solid var(--line);border-radius:999px;padding:11px 16px;color:var(--text);font:inherit}
.dm-none{margin:auto;display:grid;gap:10px;justify-items:center;text-align:center;padding:24px;max-width:30em}
.dm-dot{display:inline-block;margin-left:6px;background:var(--gold);color:var(--ink);border-radius:999px;font-size:11px;font-weight:800;padding:0 6px;line-height:16px}
.dm-btn{margin-left:auto}
@media (max-width:760px){.dm-app{grid-template-columns:1fr}.dm-app.has-thread .dm-side{display:none}.dm-app:not(.has-thread) .dm-thread{display:none}.dm-back{display:inline-block}}`;
    document.head.appendChild(css);
    view.querySelector(".dm-search").addEventListener("input", (e) => { q = e.target.value; render(); });
    view.addEventListener("click", (e) => {
      const o = e.target.closest("[data-open]"); if (o) { open(o.dataset.open); return; }
      if (e.target.closest("[data-back]")) { other = null; render(); }
    });
    view.addEventListener("submit", async (e) => {
      if (e.target.id !== "dm-form") return; e.preventDefault();
      const i = document.getElementById("dm-in"), body = i.value.trim(); if (!body || !other) return; i.value = ""; i.disabled = true;
      const { error } = await sb.from("dms").insert({ recipient: other, body });
      i.disabled = false; i.focus();
      if (error) { i.value = body; say("Could not send: " + error.message); return; }
      load();
    });
    /* walkie-talkie: hold the 📻 button, talk, let go. Friends hear it right away if they're on the site. */
    let rec = null, chunks = [], stream = null, t0 = 0;
    const wBtn = () => document.getElementById("dm-walkie");
    view.addEventListener("pointerdown", async (e) => {
      if (!e.target.closest("#dm-walkie") || rec || !other) return; e.preventDefault();
      try { stream = stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (_) { say("Allow the microphone to use the walkie-talkie."); return; }
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((x) => window.MediaRecorder && MediaRecorder.isTypeSupported(x)) || "";
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); chunks = []; rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.start(); t0 = Date.now(); wBtn()?.classList.add("on"); const i = document.getElementById("dm-in"); if (i) i.placeholder = "Talking... let go to send";
    });
    const release = async () => {
      if (!rec) return; const r = rec; rec = null; wBtn()?.classList.remove("on");
      const i = document.getElementById("dm-in"); if (i) i.placeholder = "Message, or hold 📻 to talk";
      await new Promise((res) => { r.onstop = res; try { r.stop(); } catch (_) { res(); } });
      if (Date.now() - t0 < 500) { say("Hold the 📻 button while you talk."); return; }
      const mime = (r.mimeType || "audio/webm").split(";")[0], ext = /mp4/.test(mime) ? "m4a" : "webm";
      try {
        const up = await MW.uploadMedia(new Blob(chunks, { type: mime }), { type: mime, ext });
        const { error } = await sb.from("dms").insert({ recipient: other, body: "🎙️ Voice message ⟦" + up.url + "⟧" });
        if (error) throw error; say("📻 Sent"); load();
      } catch (err) { say("Couldn't send: " + (err.message || err)); }
    };
    ["pointerup", "pointercancel"].forEach((ev) => document.addEventListener(ev, release));
    view.addEventListener("contextmenu", (e) => { if (e.target.closest("#dm-walkie")) e.preventDefault(); });

    /* "Message" buttons anywhere on the site */
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-dm]"); if (!b) return; e.preventDefault();
      if (!uid) { if (typeof openAuth === "function") openAuth("signup"); return; }
      if (b.dataset.dm === uid) { say("That's you."); return; }
      open(b.dataset.dm);
    });
    new MutationObserver(() => { if (!view.hidden) { render(); } }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  }

  async function init() {
    await MW.sessionReady;
    const s = MW.session(); uid = s && s.user ? s.user.id : null;
    build(); if (!uid) { render(); return; }
    await load();
    sb.channel("dms-live").on("postgres_changes", { event: "*", schema: "public", table: "dms" }, later).subscribe();
    started = true; setInterval(() => { if (!document.hidden) load(); }, 45000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
