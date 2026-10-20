/* "Design your profile": shown to new members right after they join (and from Edit profile).
 * Profile picture, phone (hidden unless they choose to show it), website, a profile color,
 * and an optional job application to Meechie's World Inc, sent privately to Meechie as a message. */
(function () {
  "use strict";
  const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9"; // Meechie
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const P = () => (typeof profileMe !== "undefined" ? profileMe : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  const COLORS = [["gold", "#d4a843"], ["royal", "#7b4fd6"], ["red", "#d64545"], ["blue", "#3d7fe0"], ["green", "#2fa866"], ["pink", "#e0559a"], ["white", "#e8e4da"]];
  const JOBS = ["Barber / cosmetology", "Legal document preparation", "Music / studio / DJ", "Websites / design / video", "Shop / sales / shipping", "Remodeling / handyman", "Other"];
  const SOC = [["facebook", "Facebook", "facebook.com/yourname"], ["snapchat", "Snapchat", "@username"], ["instagram", "Instagram", "@username"], ["tiktok", "TikTok", "@username"], ["youtube", "YouTube", "@channel"], ["x", "X (Twitter)", "@username"], ["whatsapp", "WhatsApp", "phone with area code"], ["cashapp", "Cash App", "$cashtag"],
    ["threads", "Threads", "@username"], ["linkedin", "LinkedIn", "linkedin.com/in/you"], ["spotify", "Spotify", "paste your Spotify link"], ["soundcloud", "SoundCloud", "username"],
    ["applemusic", "Apple Music", "paste your Apple Music link"], ["twitch", "Twitch", "username"], ["kick", "Kick", "username"], ["discord", "Discord", "paste your invite link"],
    ["telegram", "Telegram", "@username"], ["pinterest", "Pinterest", "username"], ["reddit", "Reddit", "u/username"], ["venmo", "Venmo", "@username"],
    ["paypal", "PayPal", "paypal.me/you"], ["linktree", "Linktree", "username"], ["patreon", "Patreon", "username"], ["other", "Any other app", "paste the link"]];
  const BASE = { facebook: "https://facebook.com/", snapchat: "https://snapchat.com/add/", instagram: "https://instagram.com/", tiktok: "https://tiktok.com/@", youtube: "https://youtube.com/@", x: "https://x.com/", whatsapp: "https://wa.me/", cashapp: "https://cash.app/$", threads: "https://threads.net/@", linkedin: "https://linkedin.com/in/", soundcloud: "https://soundcloud.com/", twitch: "https://twitch.tv/", kick: "https://kick.com/", telegram: "https://t.me/", pinterest: "https://pinterest.com/", reddit: "https://reddit.com/user/", venmo: "https://venmo.com/u/", paypal: "https://paypal.me/", linktree: "https://linktr.ee/", patreon: "https://patreon.com/" };
  const LINK_ONLY = new Set(["spotify", "applemusic", "discord", "other"]); // these need a full https:// link
  // turn "@name", "name" or a full link into a safe link for that app
  function socUrl(k, v) {
    v = String(v || "").trim(); if (!v) return "";
    if (/^https:\/\//i.test(v)) { try { const u = new URL(v); return u.protocol === "https:" ? u.href : ""; } catch (_) { return ""; } }
    if (LINK_ONLY.has(k)) return "";
    if (k === "whatsapp") { const d = v.replace(/\D/g, ""); return d.length >= 10 ? BASE.whatsapp + (d.length === 10 ? "1" + d : d) : ""; }
    v = v.replace(/^(https?:\/\/)?(www\.)?[a-z.]*\.(com|me|app)\/(add\/|@)?/i, "").replace(/^[@$]/, "").replace(/[^\w.\-]/g, "");
    return v ? BASE[k] + v : "";
  }
  window.MW_socUrl = socUrl;
  let photo = "", color = "gold", busy = false;

  const css = document.createElement("style");
  css.textContent = `
#ps-dlg{border:1px solid var(--gold-lo,#8a6a2a);border-radius:20px;background:linear-gradient(180deg,#1b160d,#100e0a);color:var(--text,#fff);width:min(520px,calc(100vw - 24px));max-height:calc(100vh - 32px);padding:0;overflow:auto}
#ps-dlg::backdrop{background:rgba(0,0,0,.7)}
#ps-dlg form{display:grid;gap:14px;padding:20px}
#ps-dlg h3{margin:0;font-size:22px;color:var(--gold-hi,#f0cf78)}
#ps-dlg .lead{margin:-6px 0 0;color:var(--muted,#bbb);font-size:14px}
.ps-top{display:flex;gap:16px;align-items:center}
.ps-pic{position:relative;width:96px;height:96px;flex:none;border-radius:50%;border:3px solid var(--ps,#d4a843);background:#241d10 center/cover;display:grid;place-items:center;font:800 34px var(--body,system-ui);color:var(--gold-hi,#f0cf78);cursor:pointer;overflow:hidden}
.ps-pic input{position:absolute;inset:0;opacity:0;cursor:pointer}
.ps-pic small{position:absolute;bottom:0;left:0;right:0;background:#000b;color:#fff;font:700 11px var(--body,system-ui);text-align:center;padding:3px 0}
.ps-colors{display:flex;gap:8px;flex-wrap:wrap}.ps-colors button{width:30px;height:30px;border-radius:50%;border:2px solid #0008;cursor:pointer}.ps-colors button[aria-pressed=true]{outline:3px solid #fff;outline-offset:2px}
#ps-dlg label{display:grid;gap:5px;font-weight:700;font-size:14px}
#ps-dlg input[type=text],#ps-dlg input[type=tel],#ps-dlg input[type=url],#ps-dlg input[type=email],#ps-dlg select,#ps-dlg textarea{width:100%;background:var(--ink,#0b0a08);border:1px solid var(--line,#333);border-radius:10px;padding:10px;color:var(--text,#fff);font:16px var(--body,system-ui)}
#ps-dlg .chk{display:flex;gap:8px;align-items:flex-start;font-weight:600}
#ps-dlg .chk input{margin-top:3px}
#ps-dlg .hint{color:var(--muted,#bbb);font-size:12px;font-weight:400}
.ps-job{border:1px solid var(--line,#333);border-radius:14px;padding:12px;display:grid;gap:10px}
.ps-job[hidden]{display:none}
.ps-soc{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ps-soc label{font-size:13px!important}@media (max-width:480px){.ps-soc{grid-template-columns:1fr}}
.ps-acts{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}`;
  document.head.appendChild(css);

  function dialog() {
    let d = document.getElementById("ps-dlg"); if (d) return d;
    d = document.createElement("dialog"); d.id = "ps-dlg";
    d.innerHTML = `<form id="ps-form">
<h3>🎨 Design your profile</h3><p class="lead">Make it yours. Everything here is optional, and you can change it later in Edit profile.</p>
<div class="ps-top"><label class="ps-pic" id="ps-pic" aria-label="Add a profile picture"><span id="ps-ini"></span><small>📷 Photo</small><input type="file" accept="image/*" id="ps-file"></label>
<div style="display:grid;gap:8px"><b style="font-size:14px">Profile color</b><div class="ps-colors" id="ps-colors">${COLORS.map(([n, h]) => `<button type="button" data-col="${n}" style="background:${h}" aria-label="${n}"></button>`).join("")}</div></div></div>
<label>Phone number <input type="tel" id="ps-phone" maxlength="20" placeholder="(724) 555-0123" autocomplete="tel"></label>
<label class="chk"><input type="checkbox" id="ps-phone-pub"> <span>Show my phone number on my profile<br><span class="hint">Off by default, and then only you can see it. If you turn it on, anyone who visits can see it.</span></span></label>
<label>Website <input type="url" id="ps-web" maxlength="300" placeholder="https://yourwebsite.com" autocomplete="url"></label>
<div style="display:grid;gap:8px"><b style="font-size:14px">🔗 Connect your apps <span class="hint">(your username or link)</span></b>
<div class="ps-soc">${SOC.map(([k, n, ph]) => `<label>${n}<input type="text" id="pss-${k}" maxlength="120" placeholder="${ph}" autocomplete="off"></label>`).join("")}</div></div>
<label class="chk"><input type="checkbox" id="ps-wantjob"> <span>💼 I'd like to apply for a job with Meechie's World Inc</span></label>
<div class="ps-job" id="ps-job" hidden>
  <label>Your full name <input type="text" id="pj-name" maxlength="80" autocomplete="name"></label>
  <label>Email <input type="email" id="pj-email" maxlength="120" autocomplete="email"></label>
  <label>Job you want <select id="pj-pos">${JOBS.map((j) => `<option>${E(j)}</option>`).join("")}</select></label>
  <label>Your experience <textarea id="pj-exp" rows="3" maxlength="800" placeholder="Jobs you've had, licenses, skills"></textarea></label>
  <label>When can you work? <input type="text" id="pj-when" maxlength="120" placeholder="e.g. Weekdays after 3pm, weekends"></label>
  <span class="hint">Your application goes privately to Meechie as a message. Never send your Social Security number or bank info here.</span>
</div>
<div class="ps-acts"><button class="btn ghost" type="button" id="ps-later">Later</button><button class="btn" type="submit" id="ps-save">Save my profile</button></div>
</form>`;
    document.body.appendChild(d);
    const paint = () => { const pic = d.querySelector("#ps-pic"); pic.style.backgroundImage = photo ? `url("${photo.replace(/"/g, "")}")` : ""; d.querySelector("#ps-ini").textContent = photo ? "" : ((P()?.handle || "?").trim()[0] || "?").toUpperCase();
      const hex = (COLORS.find((c) => c[0] === color) || COLORS[0])[1]; pic.style.setProperty("--ps", hex);
      d.querySelectorAll("[data-col]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.col === color))); };
    d._paint = paint;
    d.querySelector("#ps-colors").addEventListener("click", (e) => { const b = e.target.closest("[data-col]"); if (b) { color = b.dataset.col; paint(); } });
    d.querySelector("#ps-wantjob").addEventListener("change", (e) => { d.querySelector("#ps-job").hidden = !e.target.checked; });
    d.querySelector("#ps-file").addEventListener("change", async (e) => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      say("Adding your photo…");
      try {
        const dataUrl = typeof compress === "function" ? await compress(f, 600) : await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
        photo = dataUrl; paint();
        if (window.MW && MW.uploadMedia) { const blob = await (await fetch(dataUrl)).blob(); const up = await MW.uploadMedia(blob, { type: "image/jpeg", ext: "jpg" }); if (up && /^https:\/\//.test(up.url)) photo = up.url; paint(); }
      } catch (err) { say("Couldn't add the photo: " + (err.message || err)); }
    });
    d.querySelector("#ps-later").addEventListener("click", () => { try { sessionStorage.setItem("mw_ps_later", "1"); } catch (_) {} d.close(); });
    d.querySelector("#ps-form").addEventListener("submit", save);
    return d;
  }

  async function save(e) {
    e.preventDefault(); if (busy || !DB() || !ME()) return;
    const d = dialog(), v = (id) => d.querySelector("#" + id).value.trim();
    let web = v("ps-web"); if (web && !/^https?:\/\//i.test(web)) web = "https://" + web;
    if (web && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(web)) { say("That website doesn't look right."); return; }
    const phone = v("ps-phone").replace(/[^\d+()\-.\s]/g, "").slice(0, 20);
    const want = d.querySelector("#ps-wantjob").checked;
    if (want && (!v("pj-name") || !v("pj-exp"))) { say("Add your name and experience for the job application."); return; }
    busy = true; d.querySelector("#ps-save").disabled = true;
    try {
      // member profiles can be read by anyone, so a hidden phone number is kept in the member's private account instead
      const pub = d.querySelector("#ps-phone-pub").checked && !!phone;
      const socials = {}; SOC.forEach(([k]) => { const raw = v("pss-" + k).slice(0, 120); if (raw && socUrl(k, raw)) socials[k] = raw; });
      const upd = { phone: pub ? phone : "", phonePublic: pub, website: web, socials, color, setupDone: true };
      if (photo) upd.photo = photo;
      await DB().doc("members/" + ME()).update(upd);
      try { if (window.MW && MW.sb) await MW.sb.auth.updateUser({ data: { phone_private: phone } }); } catch (_) {}
      if (want && ME() !== OWNER_ID && window.MW && MW.sb) {
        const body = ["📝 JOB APPLICATION — Meechie's World Inc", "Name: " + v("pj-name"), "Handle: " + (P()?.handle || ""), "Phone: " + (phone || "—"), "Email: " + (v("pj-email") || "—"),
          "Job wanted: " + v("pj-pos"), "Experience: " + v("pj-exp"), "Available: " + (v("pj-when") || "—")].join("\n").slice(0, 2000);
        const { error } = await MW.sb.from("dms").insert({ recipient: OWNER_ID, body });
        if (error) throw error;
        say("Profile saved, and your job application was sent to Meechie 🙌");
      } else say("Your profile looks great 🔥");
      d.close();
    } catch (err) { say("Couldn't save: " + (err.message || err.code || err)); }
    busy = false; d.querySelector("#ps-save").disabled = false;
  }

  function open() {
    if (!ME() || !P()) { if (typeof openAuth === "function") openAuth("signup"); return; }
    const d = dialog(), p = P();
    photo = p.photo || ""; color = p.color || "gold";
    let priv = ""; try { priv = MW.session()?.user?.user_metadata?.phone_private || ""; } catch (_) {}
    d.querySelector("#ps-phone").value = p.phone || priv; d.querySelector("#ps-phone-pub").checked = !!p.phonePublic; d.querySelector("#ps-web").value = p.website || ""; SOC.forEach(([k]) => { d.querySelector("#pss-" + k).value = (p.socials && p.socials[k]) || ""; });
    d.querySelector("#ps-wantjob").checked = false; d.querySelector("#ps-job").hidden = true;
    d._paint(); if (!d.open) d.showModal();
  }
  window.MW_profileSetup = { open };

  // "Design my profile" button inside Edit profile
  const pf = document.getElementById("profile-form");
  if (pf && !pf.querySelector("#ps-open")) {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn ghost"; b.id = "ps-open"; b.textContent = "🎨 Photo, phone, website, apps & job application";
    b.addEventListener("click", () => { document.getElementById("profile-dialog")?.close(); open(); });
    pf.querySelector("h3").after(b);
  }

  // new members: open once they've joined, after the welcome video and entrance are done
  let tries = 0;
  const t = setInterval(() => {
    if (++tries > 300) return clearInterval(t);
    const p = P(); if (!ME() || !p) return;
    if (p.setupDone) return clearInterval(t);
    let later = false; try { later = sessionStorage.getItem("mw_ps_later") === "1"; } catch (_) {}
    if (later) return clearInterval(t);
    const en = document.getElementById("enter");
    if ((en && !en.hidden) || document.getElementById("wv-box") || document.getElementById("mw-choices") || document.querySelector("dialog[open]") || document.documentElement.classList.contains("gated")) return;
    clearInterval(t); setTimeout(open, 1500);
  }, 2000);
})();
