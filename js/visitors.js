/* Visitors: alerts for the owner, plus the "stay connected" contact box for members.
 *  - Every visit tells /api/visit, which pushes an alert to the owner's phone (free ntfy app).
 *  - While the owner has the site open: a pop-up, a chime and a desktop notification when someone comes on,
 *    and a "👁 on now" button that lists who's here and who came today.
 *  - Members who stay 60 seconds get asked (once) for their contact info. It goes to the owner as a private
 *    message in Messages, so only the owner sees it. */
(function () {
  const ss = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (_) { return null; } };
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { return null; } };
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const gated = () => document.documentElement.classList.contains("gated");
  const ready = () => typeof db !== "undefined" && db && typeof me !== "undefined";
  const tok = () => (window.MW && MW.session && MW.session() && MW.session().access_token) || "";

  function ping(kind) {
    const t = tok(); if (kind !== "gate" && !t) return;
    fetch("/api/visit", { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: JSON.stringify({ kind }), keepalive: true }).catch(() => {});
  }
  window.MW_VISIT = ping;

  // someone on the sign-up screen
  setTimeout(() => { if (gated() && !ss("mw_v_gate")) { ss("mw_v_gate", "1"); ping("gate"); } }, 3000);

  // a signed-in member came on (once per visit); a brand-new account also says "new member"
  let started = false; const wasNew = !!ls("mw_join_name"); // they just made their account on the sign-up screen
  const wait = setInterval(() => {
    if (!ready() || !me || gated()) return; clearInterval(wait); if (started) return; started = true;
    if (!ss("mw_v_enter") || (typeof isOwner !== "undefined" && isOwner)) { ss("mw_v_enter", "1"); setTimeout(() => ping(wasNew ? "joined" : "enter"), 2500); }
    if (typeof isOwner !== "undefined" && isOwner) ownerTools(); else contactTimer();
  }, 700);

  /* ---------- owner: live visitor alerts ---------- */
  const css = document.createElement("style");
  css.textContent = `
#vz-pill{position:fixed;left:14px;bottom:calc(var(--tabbar,0px) + 70px + env(safe-area-inset-bottom,0px));z-index:9995;border:1px solid var(--gold);background:#0b0a08e6;color:var(--gold-hi);font:700 13px var(--body);padding:8px 13px;border-radius:999px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.5)}
#vz-pill.new{animation:vzp 1s ease-in-out 3}@keyframes vzp{50%{background:var(--gold);color:#0b0a08}}
#vz-sheet{position:fixed;inset:0;z-index:10010;background:rgba(0,0,0,.6);display:grid;place-items:end center}
#vz-sheet .in{width:min(560px,100%);max-height:86vh;overflow:auto;background:#12100c;border:1px solid var(--gold-lo,#8c6d26);border-radius:18px 18px 0 0;padding:18px 18px 28px}
#vz-sheet h3{margin:0 0 6px;font-size:20px}#vz-sheet h4{margin:18px 0 8px;font-size:15px;color:var(--gold-hi)}
#vz-sheet .row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #2a2418;font-size:14px}
#vz-sheet .row small{color:var(--muted)}
#vz-sheet code{font:600 15px "IBM Plex Mono",monospace;background:#000;border:1px solid var(--line);padding:8px 10px;border-radius:8px;display:block;word-break:break-all;margin:6px 0}
#vz-sheet ol{padding-left:20px;margin:6px 0}#vz-sheet li{margin:5px 0}
#vz-sheet .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
#ct-box{position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.65);display:grid;place-items:center;padding:16px}
#ct-box form{width:min(440px,100%);display:grid;gap:11px;background:#12100c;border:1px solid var(--gold);border-radius:18px;padding:20px;max-height:92vh;overflow:auto}
#ct-box h3{margin:0;font-size:22px;text-align:center}#ct-box p{margin:0;text-align:center;color:var(--muted);font-size:14px}
#ct-box label{display:grid;gap:5px;font-size:14px;font-weight:600}
#ct-box input,#ct-box select{font:16px var(--body);padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:#0b0a08;color:var(--text)}
#ct-box .chips{display:flex;flex-wrap:wrap;gap:6px}
#ct-box .chips label{display:inline-flex;align-items:center;gap:6px;font-weight:500;font-size:13px;border:1px solid var(--line);border-radius:999px;padding:6px 10px;cursor:pointer}
#ct-box .chips input{width:auto;padding:0}
#ct-box .msg{min-height:1.1em;color:var(--gold-hi)}
#ct-box .later{background:none;border:0;color:var(--muted);text-decoration:underline;cursor:pointer;font:14px var(--body)}`;
  document.head.appendChild(css);

  function chime() {
    try { const c = new (window.AudioContext || window.webkitAudioContext)(); const o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(880, c.currentTime); o.frequency.setValueAtTime(1320, c.currentTime + 0.12);
      g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.5);
      o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.55); setTimeout(() => c.close(), 800); } catch (_) {}
  }
  function ownerTools() {
    const pill = document.createElement("button"); pill.id = "vz-pill"; pill.type = "button"; pill.textContent = "👁 0 on now"; document.body.appendChild(pill);
    const today = [], t0 = Date.now(); let seen = new Set();
    const nameOf = (id) => (typeof members !== "undefined" && members[id] && members[id].handle) || "A member";
    function onNow() { const ps = (typeof room !== "undefined" && room && room.peers ? room.peers() : []); const ids = new Set(); ps.forEach((p) => { if (p.by && p.by !== me) ids.add(p.by); }); return [...ids]; }
    function paint() { const n = onNow().length; pill.textContent = "👁 " + n + " on now"; }
    function hook() {
      if (typeof room === "undefined" || !room || !room.onPeers) { setTimeout(hook, 1000); return; }
      room.onPeers((ch) => {
        const now = onNow();
        if (Date.now() - t0 < 6000) { now.forEach((id) => seen.add(id)); paint(); return; } // people already here when you opened the site
        now.forEach((id) => { if (seen.has(id)) return; seen.add(id); const nm = nameOf(id);
          today.unshift({ id, nm, at: Date.now() }); toast("🔔 " + nm + " just came on the site"); chime(); pill.classList.remove("new"); void pill.offsetWidth; pill.classList.add("new");
          if (document.hidden && "Notification" in window && Notification.permission === "granted") { try { new Notification("Someone's on Meechie's World", { body: nm + " just came on the site", icon: "/img/icon-192.png", tag: "mw-visit-" + id }); } catch (_) {} } });
        [...seen].forEach((id) => { if (!now.includes(id)) seen.delete(id); }); // left: count them again if they come back
        paint();
      });
    }
    hook(); setInterval(paint, 5000);
    pill.addEventListener("click", async () => {
      let al = {}; try { const d = await db.doc("site/alerts").get(); al = (d.exists && d.data()) || {}; } catch (_) {}
      const here = onNow();
      const sh = document.createElement("div"); sh.id = "vz-sheet";
      const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      sh.innerHTML = `<div class="in" role="dialog" aria-label="Visitors">
        <h3>👁 Visitors</h3>
        <h4>On the site right now (${here.length})</h4>${here.length ? here.map((id) => `<div class="row"><b>${E(nameOf(id))}</b><small>here now</small></div>`).join("") : '<p class="muted" style="margin:0">Nobody else is on right now.</p>'}
        <h4>Came on since you opened the site</h4>${today.length ? today.slice(0, 50).map((v) => `<div class="row"><b>${E(v.nm)}</b><small>${t(v.at)}</small></div>`).join("") : '<p class="muted" style="margin:0">No one yet.</p>'}
        <h4>📱 Alerts on your phone (even when the site is closed)</h4>
        ${al.topic && !al.off ? `<p style="margin:0">Phone alerts are <b>on</b>. In the free <b>ntfy</b> app, subscribe to this channel:</p><code>${E(al.topic)}</code>
          <ol><li>Install <b>ntfy</b> (App Store or Google Play, free).</li><li>Tap <b>+</b>, type the channel name above, tap <b>Subscribe</b>.</li><li>That's it: you'll get a buzz every time someone comes on, joins, or sends their contact info.</li></ol>
          <p class="muted" style="margin:0;font-size:13px">Keep the channel name private. Anyone who has it could see your alerts.</p>
          <div class="acts"><button class="btn sm" type="button" data-a="copy">Copy channel name</button><a class="btn sm ghost" href="https://ntfy.sh/${encodeURIComponent(al.topic)}" target="_blank" rel="noopener">Open in browser</a><button class="btn sm ghost" type="button" data-a="new">Make a new channel</button><button class="btn sm ghost" type="button" data-a="off">Turn phone alerts off</button></div>`
        : `<p style="margin:0">Get a buzz on your phone every time someone comes on your site, makes an account, or sends their contact info. Free, using the ntfy app.</p><div class="acts"><button class="btn sm" type="button" data-a="new">Turn on phone alerts</button></div>`}
        <h4>💻 Alerts on this computer</h4>
        <div class="acts"><button class="btn sm ghost" type="button" data-a="desk">${"Notification" in window && Notification.permission === "granted" ? "✓ On" : "Turn on"}</button></div>
        <div class="acts" style="margin-top:18px"><button class="btn" type="button" data-a="close">Close</button></div></div>`;
      document.body.appendChild(sh);
      sh.addEventListener("click", async (e) => {
        if (e.target === sh) { sh.remove(); return; }
        const a = e.target.closest("[data-a]"); if (!a) return; const k = a.dataset.a;
        if (k === "close") sh.remove();
        if (k === "copy") navigator.clipboard?.writeText(al.topic).then(() => toast("Channel name copied")).catch(() => toast("Press and hold the name to copy it"));
        if (k === "new") { const r = new Uint8Array(12); crypto.getRandomValues(r); const topic = "mw-alerts-" + [...r].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 18);
          try { await db.doc("site/alerts").set({ topic, off: false, updatedAt: Date.now() }); ping("enter"); sh.remove(); pill.click(); } catch (err) { toast("Couldn't save: " + (err.message || err)); } }
        if (k === "off") { try { await db.doc("site/alerts").set({ ...al, off: true, updatedAt: Date.now() }); ping("enter"); sh.remove(); toast("Phone alerts are off"); } catch (err) { toast("Couldn't save: " + (err.message || err)); } }
        if (k === "desk") { if (!("Notification" in window)) { toast("This browser can't show notifications"); return; } const p = await Notification.requestPermission(); a.textContent = p === "granted" ? "✓ On" : "Blocked in browser settings"; }
      });
    });
  }

  /* ---------- members: ask for contact info after 60 seconds ---------- */
  function contactTimer() {
    if (ls("mw_contact_done") === "1") return;
    const snooze = +ls("mw_contact_later") || 0; if (Date.now() - snooze < 7 * 864e5) return; // asked to wait: ask again in a week
    let secs = 0;
    const t = setInterval(() => {
      if (document.hidden || gated()) return;
      if (++secs < 60) return;
      if (document.querySelector("dialog[open], #ct-box, #vz-sheet") || (typeof profileMe !== "undefined" && !profileMe)) { secs = 50; return; } // wait until they're not in the middle of something
      if (typeof profileMe !== "undefined" && profileMe && profileMe.contactShared) { ls("mw_contact_done", "1"); clearInterval(t); return; }
      clearInterval(t); showContact();
    }, 1000);
  }
  function showContact() {
    const nm = (typeof profileMe !== "undefined" && profileMe && profileMe.handle) || "";
    const em = (window.MW && MW.session && MW.session() && MW.session().user && MW.session().user.email) || "";
    const box = document.createElement("div"); box.id = "ct-box";
    box.innerHTML = `<form role="dialog" aria-labelledby="ct-t">
      <h3 id="ct-t">Stay connected${nm ? ", " + E(nm.split(" ")[0]) : ""}</h3>
      <p>Leave your contact info so Meechie's World can reach you about new music, events and deals. Only Meechie sees it.</p>
      <label>Phone number<input name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="(555) 555-5555"></label>
      <label>Email<input name="email" type="email" autocomplete="email" value="${E(em)}"></label>
      <label>Instagram, TikTok or Snapchat<input name="social" maxlength="60" placeholder="@yourname"></label>
      <label>Best way to reach you<select name="how"><option>Text</option><option>Call</option><option>Email</option><option>DM on social media</option></select></label>
      <div><b style="font-size:14px">What are you interested in?</b><div class="chips" style="margin-top:6px">${["Music & radio", "Studio time", "Websites & apps", "Legal documents", "Apparel", "Crypto & Meechie's Coin", "Events"].map((x) => `<label><input type="checkbox" name="int" value="${E(x)}">${E(x)}</label>`).join("")}</div></div>
      <p class="msg" aria-live="polite"></p>
      <button class="btn" type="submit">Send to Meechie</button>
      <button class="later" type="button">Not now</button></form>`;
    document.body.appendChild(box);
    const f = box.querySelector("form"), msg = box.querySelector(".msg");
    box.querySelector(".later").addEventListener("click", () => { ls("mw_contact_later", String(Date.now())); box.remove(); });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const phone = f.phone.value.trim(), email = f.email.value.trim(), social = f.social.value.trim();
      if (!phone && !social && !email) { msg.textContent = "Add a phone number, email or social handle."; return; }
      if (phone && phone.replace(/\D/g, "").length < 10) { msg.textContent = "That phone number looks too short."; return; }
      const ints = [...f.querySelectorAll('input[name="int"]:checked')].map((x) => x.value);
      const body = ["📇 My contact info", phone && "Phone: " + phone, email && "Email: " + email, social && "Social: " + social, "Best way to reach me: " + f.how.value, ints.length && "Interested in: " + ints.join(", ")].filter(Boolean).join("\n").slice(0, 1500);
      msg.textContent = "Sending...";
      try {
        const a = await MW.sb.from("admins").select("user_id").limit(1); const owner = a.data && a.data[0] && a.data[0].user_id;
        if (!owner) throw new Error("Couldn't reach Meechie right now.");
        const r = await MW.sb.from("dms").insert({ recipient: owner, body }); if (r.error) throw r.error;
        try { await db.doc("members/" + me).update({ contactShared: true }); } catch (_) {}
        ls("mw_contact_done", "1"); ping("contact");
        f.innerHTML = `<h3>Thank you${nm ? ", " + E(nm.split(" ")[0]) : ""}! 🙏</h3><p>Meechie got your info. Welcome to the family.</p><button class="btn" type="button">Back to the site</button>`;
        f.querySelector("button").addEventListener("click", () => box.remove());
      } catch (err) { msg.textContent = (err && err.message) || "Couldn't send. Try again."; }
    });
  }
})();
