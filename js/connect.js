/* Connect: every tool a member uses, one tap away — plus link your socials in one place.
 * The tools grid is just quick-launch links (email, Google tools, socials, music, money).
 * The socials editor writes the SAME "socials" field on the member doc that Edit profile uses,
 * so the links show up on the member's profile and friend card automatically. It only ever
 * asks for @names and links — never a password for another app. */
(function () {
  "use strict";
  const view = document.getElementById("v-connect");
  if (!view) return;
  const root = view.querySelector("#cn-root");
  if (!root) return;
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const MEM = () => (typeof members !== "undefined" ? members : {});
  const sess = () => { try { if (typeof MW !== "undefined" && MW.session) return MW.session(); if (window.MW_CF && MW_CF.session) return MW_CF.session(); } catch (_) {} return null; };
  let odb = null;
  const DB = async () => { if (!odb) odb = await claude.use("db"); return odb; };

  const css = document.createElement("style");
  css.textContent = `
.cn-card{border:1px solid var(--line);border-radius:18px;padding:18px;background:linear-gradient(180deg,#17130c,#0f0d09);display:grid;gap:12px;margin-bottom:16px}
.cn-card h3{margin:2px 0 0;font-size:24px}
.cn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.cn-tile{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid var(--line);border-radius:12px;background:#0c0a07;color:var(--text);text-decoration:none;font:700 14.5px var(--body)}
.cn-tile:hover{border-color:var(--gold)}
.cn-tile .ic{font-size:21px;flex:none}
.cn-group{font:800 12px var(--body);letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:6px 0 0}
.cn-soc{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:560px){.cn-soc{grid-template-columns:1fr}}
.cn-soc label{display:grid;gap:5px;font-weight:700;font-size:13.5px}
.cn-soc input{background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text);font:16px var(--body)}
.cn-chips{display:flex;flex-wrap:wrap;gap:6px}
.cn-chips a{border:1px solid var(--line);border-radius:999px;padding:5px 11px;font-size:13px;color:var(--text);text-decoration:none}`;
  document.head.appendChild(css);

  const TOOLS = [
    ["📧 Email", [["✉️", "Gmail", "https://mail.google.com"], ["📘", "Outlook", "https://outlook.live.com/mail"], ["🟣", "Yahoo Mail", "https://mail.yahoo.com"], ["🅰️", "AOL Mail", "https://mail.aol.com"], ["☁️", "iCloud Mail", "https://www.icloud.com/mail"], ["🔒", "Proton Mail", "https://mail.proton.me"]]],
    ["🗂️ Google tools", [["📅", "Calendar", "https://calendar.google.com"], ["📁", "Drive", "https://drive.google.com"], ["📝", "Docs", "https://docs.google.com"], ["🖼️", "Photos", "https://photos.google.com"], ["🗺️", "Maps", "https://maps.google.com"], ["🎥", "Meet", "https://meet.google.com"]]],
    ["📱 Social & video", [["📸", "Instagram", "https://www.instagram.com"], ["👥", "Facebook", "https://www.facebook.com"], ["💬", "Messenger", "https://www.messenger.com"], ["🎵", "TikTok", "https://www.tiktok.com"], ["👻", "Snapchat", "https://www.snapchat.com"], ["✖️", "X", "https://x.com"], ["▶️", "YouTube", "https://www.youtube.com"], ["🧵", "Threads", "https://www.threads.net"], ["🟢", "WhatsApp", "https://web.whatsapp.com"], ["🎮", "Discord", "https://discord.com/app"], ["✈️", "Telegram", "https://web.telegram.org"]]],
    ["🎵 Music", [["🟢", "Spotify", "https://open.spotify.com"], ["🍎", "Apple Music", "https://music.apple.com"], ["🔴", "YouTube Music", "https://music.youtube.com"], ["☁️", "SoundCloud", "https://soundcloud.com"]]],
    ["💵 Money", [["💲", "Cash App", "https://cash.app"], ["🅿️", "PayPal", "https://www.paypal.com"], ["💜", "Venmo", "https://venmo.com"], ["🏦", "Chime", "https://www.chime.com"]]],
  ];
  // the main apps members link on their profiles (Edit profile has the full list of 45)
  const SOC = [["instagram", "Instagram", "@username"], ["tiktok", "TikTok", "@username"], ["snapchat", "Snapchat", "@username"], ["facebook", "Facebook", "facebook.com/yourname"], ["youtube", "YouTube", "@channel"], ["x", "X (Twitter)", "@username"], ["threads", "Threads", "@username"], ["whatsapp", "WhatsApp", "phone with area code"], ["twitch", "Twitch", "username"], ["kick", "Kick", "username"], ["spotify", "Spotify", "paste your Spotify link"], ["soundcloud", "SoundCloud", "username"], ["applemusic", "Apple Music", "paste your Apple Music link"], ["cashapp", "Cash App", "$cashtag"], ["telegram", "Telegram", "@username"], ["discord", "Discord", "paste your invite link"], ["linkedin", "LinkedIn", "linkedin.com/in/you"], ["linktree", "Linktree", "username"], ["onlinestore", "Your online store", "paste the link"], ["other", "Any other app", "paste the link"]];
  const LABEL = Object.fromEntries(SOC.map(([k, n]) => [k, n]));

  function chips(socials) {
    if (!window.MW_socUrl) return "";
    const out = Object.entries(socials || {}).map(([k, v]) => { const u = MW_socUrl(k, v); return u ? `<a href="${E(u)}" target="_blank" rel="noopener nofollow ugc">${E(LABEL[k] || k)}</a>` : ""; }).join("");
    return out ? `<div><b style="font-size:14px">On your profile now:</b><div class="cn-chips" style="margin-top:6px">${out}</div></div>` : "";
  }

  function paint() {
    const my = ME() ? (MEM()[ME()] || {}) : {};
    const socials = my.socials || {};
    const s = sess(), u = (s && s.user) || {};
    const provider = (u.app_metadata && u.app_metadata.provider) || "";
    root.innerHTML = `
      <div class="cn-card"><p class="eyebrow" style="margin:0">Your toolbox</p><h3>🔌 Your tools</h3>
        <p class="muted" style="margin:0">Every app you already use, one tap away — check your email, open your socials, get to your money. They open in a new tab; Meechie's World stays right here.</p>
        ${TOOLS.map(([g, list]) => `<p class="cn-group">${E(g)}</p><div class="cn-grid">${list.map(([ic, n, url]) => `<a class="cn-tile" href="${E(url)}" target="_blank" rel="noopener"><span class="ic">${ic}</span>${E(n)}</a>`).join("")}</div>`).join("")}
      </div>
      <div class="cn-card"><p class="eyebrow" style="margin:0">Be found everywhere</p><h3>🔗 Link your socials</h3>
        ${ME() ? `<p class="muted" style="margin:0">Add your @names and links once — they show on your profile and your friend card, so the community can find and follow you everywhere. <b>We never ask for passwords</b>, only the name or link people use to find you.</p>
        <form id="cn-form"><div class="cn-soc">${SOC.map(([k, n, ph]) => `<label>${E(n)}<input type="text" id="cn-${k}" maxlength="120" placeholder="${E(ph)}" autocomplete="off" value="${E(socials[k] || "")}"></label>`).join("")}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn" type="submit">Save my links</button><button class="btn ghost" type="button" data-profile="${E(ME())}">See my profile</button></div></form>
        <div id="cn-chips">${chips(socials)}</div>
        <small class="muted">Want more apps or your work, school and city too? That's all in Edit profile — this page covers the main ones.</small>`
      : `<p class="muted" style="margin:0">Members can link their socials here so they show on their profile — Instagram, TikTok, Snapchat, YouTube, your store, all of it, one tap for your followers.</p>
        <div><button class="btn" type="button" data-auth="signup">Join free to link yours</button></div>`}
      </div>
      <div class="cn-card"><p class="eyebrow" style="margin:0">Sign-ins</p><h3>🔐 Connected to Meechie's World</h3>
        ${ME() ? `<div style="display:grid;gap:6px;font-size:15px">
          <div>${provider === "google" ? "✅" : "✅"} <b>${provider === "google" ? "Google sign-in" : "Email sign-in"}</b> — you're signed in${u.email ? " as " + E(u.email) : ""}.</div>
          <div>⏳ <b>Facebook sign-in</b> — being finished now. The app is configured; the button lands on the sign-in screen next.</div>
          <div class="muted" style="font-size:13.5px">Other apps aren't connected to your account — the tools above just open them, the way they always worked. Nothing here can see into your other accounts.</div>
        </div>` : `<p class="muted" style="margin:0">Sign in and this card shows how your account connects. Joining with Google is one tap on the sign-in screen.</p>`}
      </div>`;
  }

  root.addEventListener("submit", async (e) => {
    if (e.target.id !== "cn-form") return;
    e.preventDefault();
    if (!ME()) return;
    const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Saving…";
    const merged = { ...((MEM()[ME()] || {}).socials || {}) };
    const skipped = [];
    SOC.forEach(([k, n]) => {
      const inp = root.querySelector("#cn-" + k); if (!inp) return;
      const raw = inp.value.trim().slice(0, 120);
      if (!raw) { delete merged[k]; return; }
      if (!window.MW_socUrl || MW_socUrl(k, raw)) merged[k] = raw; else skipped.push(n);
    });
    try {
      const d = await DB(); if (!d) throw new Error("no db");
      await d.doc("members/" + ME()).update({ socials: merged });
      const box = root.querySelector("#cn-chips"); if (box) box.innerHTML = chips(merged);
      say(skipped.length ? "Saved. These didn't look right and weren't added: " + skipped.join(", ") : "Saved — your links are on your profile now.");
    } catch (_) { say("Couldn't save. Check your connection and try again."); }
    btn.disabled = false; btn.textContent = "Save my links";
  });

  paint();
  new MutationObserver(() => { if (!view.hidden) paint(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
})();
