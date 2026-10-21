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
    ["paypal", "PayPal", "paypal.me/you"], ["linktree", "Linktree", "username"], ["patreon", "Patreon", "username"], ["bluesky", "Bluesky", "name.bsky.social"], ["tumblr", "Tumblr", "username"], ["vimeo", "Vimeo", "username"], ["rumble", "Rumble", "channel name"], ["lemon8", "Lemon8", "@username"], ["triller", "Triller", "@username"], ["audiomack", "Audiomack", "artist name"], ["bandcamp", "Bandcamp", "artist name"], ["substack", "Substack", "name"], ["medium", "Medium", "@username"], ["etsy", "Etsy", "shop name"], ["depop", "Depop", "username"], ["poshmark", "Poshmark", "closet name"], ["truthsocial", "Truth Social", "@username"], ["mastodon", "Mastodon", "paste your profile link"], ["signal", "Signal", "paste your Signal link"], ["tidal", "Tidal", "paste your Tidal link"], ["amazonmusic", "Amazon Music", "paste your link"], ["clubhouse", "Clubhouse", "@username"], ["bereal", "BeReal", "username"], ["messenger", "Facebook Messenger", "username"], ["onlinestore", "Your online store", "paste the link"], ["other", "Any other app", "paste the link"]];
  const BASE = { facebook: "https://facebook.com/", snapchat: "https://snapchat.com/add/", instagram: "https://instagram.com/", tiktok: "https://tiktok.com/@", youtube: "https://youtube.com/@", x: "https://x.com/", whatsapp: "https://wa.me/", cashapp: "https://cash.app/$", threads: "https://threads.net/@", linkedin: "https://linkedin.com/in/", soundcloud: "https://soundcloud.com/", twitch: "https://twitch.tv/", kick: "https://kick.com/", telegram: "https://t.me/", pinterest: "https://pinterest.com/", reddit: "https://reddit.com/user/", venmo: "https://venmo.com/u/", paypal: "https://paypal.me/", linktree: "https://linktr.ee/", patreon: "https://patreon.com/", bluesky: "https://bsky.app/profile/", tumblr: "https://tumblr.com/", vimeo: "https://vimeo.com/", rumble: "https://rumble.com/c/", lemon8: "https://www.lemon8-app.com/@", triller: "https://triller.co/@", audiomack: "https://audiomack.com/", bandcamp: "https://{v}.bandcamp.com", substack: "https://{v}.substack.com", medium: "https://medium.com/@", etsy: "https://etsy.com/shop/", depop: "https://depop.com/", poshmark: "https://poshmark.com/closet/", truthsocial: "https://truthsocial.com/@", clubhouse: "https://clubhouse.com/@", bereal: "https://bere.al/", messenger: "https://m.me/" };
  const LINK_ONLY = new Set(["spotify", "applemusic", "discord", "other", "mastodon", "signal", "tidal", "amazonmusic", "onlinestore"]); // these need a full https:// link
  // turn "@name", "name" or a full link into a safe link for that app
  function socUrl(k, v) {
    v = String(v || "").trim(); if (!v) return "";
    if (/^https:\/\//i.test(v)) { try { const u = new URL(v); return u.protocol === "https:" ? u.href : ""; } catch (_) { return ""; } }
    if (LINK_ONLY.has(k)) return "";
    if (k === "whatsapp") { const d = v.replace(/\D/g, ""); return d.length >= 10 ? BASE.whatsapp + (d.length === 10 ? "1" + d : d) : ""; }
    v = v.replace(/^(https?:\/\/)?(www\.)?[a-z.]*\.(com|me|app)\/(add\/|@)?/i, "").replace(/^[@$]/, "").replace(/[^\w.\-]/g, "");
    return v ? (BASE[k].includes("{v}") ? BASE[k].replace("{v}", v) : BASE[k] + v) : "";
  }
  window.MW_socUrl = socUrl;
  const socBox = ([k, n, ph]) => `<label>${n}<input type="text" id="pss-${k}" maxlength="120" placeholder="${ph}" autocomplete="off"></label>`;
  const INTERESTS = ["🎤 Hip-hop & rap", "🎶 R&B & soul", "🙏 Gospel", "🎧 Making beats", "🎬 Movies & TV", "📺 Live TV", "📚 Books", "👗 Fashion & clothes", "💇 Hair & nails", "💈 Barber", "⚖️ Legal help", "💼 Business & money", "🪙 Crypto", "🎮 Games", "🏀 Sports", "🍳 Cooking", "💻 Tech & AI", "🌍 History & Egypt", "❤️ Dating", "👨‍👩‍👧 Family", "🛠️ Remodeling", "✈️ Travel"];
  let picked = new Set();
  let photo = "", pics = [], cover = "", color = "gold", busy = false;

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
.ps-more summary{cursor:pointer;color:var(--gold-hi,#f0cf78);font-weight:700;font-size:14px;margin:4px 0 8px}
.ps-cov{display:block;height:70px;border-radius:10px;background:#241d10 center/cover;border:1px solid var(--line,#333)}
.ps-int{display:flex;flex-wrap:wrap;gap:6px}.ps-int button{border:1px solid var(--line,#444);background:#1d1810;color:var(--text,#fff);border-radius:999px;padding:6px 11px;font:600 13px var(--body,system-ui);cursor:pointer}.ps-int button[aria-pressed=true]{background:var(--gold,#d4a843);color:#0b0a08;border-color:var(--gold-hi,#f0cf78)}
.ps-acts{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}`;
  document.head.appendChild(css);

  function dialog() {
    let d = document.getElementById("ps-dlg"); if (d) return d;
    d = document.createElement("dialog"); d.id = "ps-dlg";
    d.innerHTML = `<form id="ps-form">
<h3>🎨 Design your profile</h3><p class="lead">Start with your <b>profile picture</b> and <b>phone number</b> so friends know it's you. You can change anything later in Edit profile.</p>
<div class="ps-top"><label class="ps-pic" id="ps-pic" aria-label="Add a profile picture"><span id="ps-ini"></span><small>📷 Photo</small><input type="file" accept="image/*" id="ps-file"></label>
<div style="display:grid;gap:8px"><b style="font-size:14px">Profile color</b><div class="ps-colors" id="ps-colors">${COLORS.map(([n, h]) => `<button type="button" data-col="${n}" style="background:${h}" aria-label="${n}"></button>`).join("")}</div></div></div>
<div style="display:grid;gap:6px"><b style="font-size:14px">📷 Profile pictures <span class="hint">(at least 1, up to 5; tap one to make it your main picture)</span></b><div id="ps-pics"></div></div>
<label>📱 Phone number <input type="tel" id="ps-phone" maxlength="20" placeholder="(724) 555-0123" autocomplete="tel"></label>
<label class="chk"><input type="checkbox" id="ps-phone-pub"> <span>Show my phone number on my profile<br><span class="hint">Off by default, and then only you can see it. If you turn it on, anyone who visits can see it.</span></span></label>
<label>Cover photo <span class="hint">(the wide picture across the top of your profile)</span><input type="file" accept="image/*" id="ps-cover-f"><span class="ps-cov" id="ps-cov"></span></label>
<div class="ps-soc"><label>Works at<input type="text" id="ps-work" maxlength="80" placeholder="Company or job"></label><label>Went to school at<input type="text" id="ps-school" maxlength="80" placeholder="School"></label>
<label>Lives in<input type="text" id="ps-city" maxlength="60" placeholder="City, State"></label><label>From<input type="text" id="ps-home" maxlength="60" placeholder="Hometown"></label>
<label>Relationship<select id="ps-rel"><option value="">Don't show</option><option>Single</option><option>In a relationship</option><option>Engaged</option><option>Married</option><option>It's complicated</option></select></label></div>
<div style="display:grid;gap:8px"><b style="font-size:14px">⭐ What are you into? <span class="hint">(pick all you like, so Meechie can make more of it)</span></b><div class="ps-int" id="ps-int">${INTERESTS.map((x) => `<button type="button" data-int="${E(x)}" aria-pressed="false">${E(x)}</button>`).join("")}</div></div>
<label>Website <input type="url" id="ps-web" maxlength="300" placeholder="https://yourwebsite.com" autocomplete="url"></label>
<div style="display:grid;gap:8px"><b style="font-size:14px">🔗 Connect your apps <span class="hint">(your username or link)</span></b>
<div class="ps-soc">${SOC.slice(0, 8).map(socBox).join("")}</div>
<details class="ps-more"><summary>➕ More apps (${SOC.length - 8})</summary><div class="ps-soc">${SOC.slice(8).map(socBox).join("")}</div></details></div>
<label class="chk"><input type="checkbox" id="ps-emailfind" checked> <span>🔎 Let people find me by my email<br><span class="hint">Only someone who types your exact email can find you. Your email is never shown.</span></span></label>
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
    const drawPics = picStrip(d.querySelector("#ps-pics"), () => pics, (a) => { pics = a; photo = a[0] || ""; paint(); });
    d._paint = () => { paint(); drawPics(); d.querySelector("#ps-cov").style.backgroundImage = cover ? `url("${cover.replace(/"/g, "")}")` : ""; };
    d.querySelector("#ps-int").addEventListener("click", (e) => { const b = e.target.closest("[data-int]"); if (!b) return; const x = b.dataset.int; picked.has(x) ? picked.delete(x) : picked.add(x); b.setAttribute("aria-pressed", String(picked.has(x))); });
    d.querySelector("#ps-colors").addEventListener("click", (e) => { const b = e.target.closest("[data-col]"); if (b) { color = b.dataset.col; paint(); } });
    d.querySelector("#ps-wantjob").addEventListener("change", (e) => { d.querySelector("#ps-job").hidden = !e.target.checked; });
    d.querySelector("#ps-file").addEventListener("change", async (e) => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      say("Adding your photo…");
      // the round picture: the new one becomes the main picture (the others stay, up to 5)
      try { const url = await readPhoto(f); pics = [url, ...pics].slice(0, MAXPICS); photo = url; d._paint(); }
      catch (err) { say("Couldn't add the photo: " + (err.message || err)); }
    });
    d.querySelector("#ps-cover-f").addEventListener("change", async (e) => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return; say("Adding your cover photo…");
      try { const dataUrl = typeof compress === "function" ? await compress(f, 1400) : ""; if (!dataUrl) return; cover = dataUrl; d._paint();
        if (window.MW && MW.uploadMedia) { const up = await MW.uploadMedia(await (await fetch(dataUrl)).blob(), { type: "image/jpeg", ext: "jpg" }); if (up && /^https:\/\//.test(up.url)) cover = up.url; d._paint(); }
      } catch (err) { say("Couldn't add the cover photo: " + (err.message || err)); }
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
    if (!pics.length) { say("Add at least 1 profile picture (tap the circle)."); return; }
    if (phone && phone.replace(/\D/g, "").length < 10) { say("Put in your full phone number with area code."); return; }
    if (want && (!v("pj-name") || !v("pj-exp"))) { say("Add your name and experience for the job application."); return; }
    busy = true; d.querySelector("#ps-save").disabled = true;
    try {
      // member profiles can be read by anyone, so a hidden phone number is kept in the member's private account instead
      const pub = d.querySelector("#ps-phone-pub").checked && !!phone;
      const socials = {}; SOC.forEach(([k]) => { const raw = v("pss-" + k).slice(0, 120); if (raw && socUrl(k, raw)) socials[k] = raw; });
      const upd = { phone: pub ? phone : "", phonePublic: pub, website: web, socials, color, work: v("ps-work"), school: v("ps-school"), city: v("ps-city"), hometown: v("ps-home"), relationship: d.querySelector("#ps-rel").value, interests: [...picked].slice(0, 22), emailFind: d.querySelector("#ps-emailfind").checked, setupDone: true };
      if (!upd.emailFind) upd.emailHash = "";
      if (cover && /^https:\/\//.test(cover)) upd.cover = cover;
      Object.assign(upd, picsUpd(pics));
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
    pics = picsOf(p); photo = pics[0] || ""; cover = p.cover || ""; d.querySelector("#ps-emailfind").checked = p.emailFind !== false; picked = new Set(Array.isArray(p.interests) ? p.interests : []); d.querySelectorAll("[data-int]").forEach((b) => b.setAttribute("aria-pressed", String(picked.has(b.dataset.int)))); color = p.color || "gold";
    let priv = ""; try { priv = MW.session()?.user?.user_metadata?.phone_private || ""; } catch (_) {}
    d.querySelector("#ps-phone").value = p.phone || priv; d.querySelector("#ps-phone-pub").checked = !!p.phonePublic; d.querySelector("#ps-web").value = p.website || ""; d.querySelector("#ps-work").value = p.work || ""; d.querySelector("#ps-school").value = p.school || ""; d.querySelector("#ps-city").value = p.city || ""; d.querySelector("#ps-home").value = p.hometown || ""; d.querySelector("#ps-rel").value = p.relationship || "";
    SOC.forEach(([k]) => { d.querySelector("#pss-" + k).value = (p.socials && p.socials[k]) || ""; });
    d.querySelector("#ps-wantjob").checked = false; d.querySelector("#ps-job").hidden = true;
    d._paint(); if (!d.open) d.showModal();
  }
  // the picture from Google / Facebook sign-in, if they used one
  function signInPhoto() { try { const u = MW.session()?.user?.user_metadata?.avatar_url || ""; return /^https:\/\//.test(u) ? u : ""; } catch (_) { return ""; } }
  function privPhone() { try { return MW.session()?.user?.user_metadata?.phone_private || ""; } catch (_) { return ""; } }
  async function readPhoto(f) {
    const dataUrl = typeof compress === "function" ? await compress(f, 600) : await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    if (window.MW && MW.uploadMedia) { try { const up = await MW.uploadMedia(await (await fetch(dataUrl)).blob(), { type: "image/jpeg", ext: "jpg" }); if (up && /^https:\/\//.test(up.url)) return up.url; } catch (_) {} }
    return dataUrl;
  }

  /* Up to 5 profile pictures: the first is the main one (the round picture), the rest show on their profile's Photos.
   * host gets 5 square slots; tap an empty one to add, tap ✕ to remove, tap a picture to make it the main one. */
  const MAXPICS = 5;
  const css2 = document.createElement("style");
  css2.textContent = `.mw-pics{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}.mw-pics .s{position:relative;aspect-ratio:1;border-radius:10px;border:1px dashed #6b5a35;background:#1d1810 center/cover;display:grid;place-items:center;color:#a99f8b;font:700 20px system-ui;cursor:pointer;overflow:hidden}
.mw-pics .s.on{border:1px solid #3a3223}.mw-pics .s.main{outline:2px solid #f0cf78}.mw-pics .s input{position:absolute;inset:0;opacity:0;cursor:pointer}
.mw-pics .x{position:absolute;top:2px;right:2px;width:22px;height:22px;border-radius:50%;border:0;background:#000c;color:#fff;font:700 12px system-ui;cursor:pointer;padding:0}
.mw-pics .m{position:absolute;bottom:0;left:0;right:0;background:#000b;color:#f0cf78;font:700 9px system-ui;text-align:center;padding:2px 0}`;
  document.head.appendChild(css2);
  function picStrip(host, get, set) {
    const draw = () => {
      const a = get();
      host.innerHTML = Array.from({ length: MAXPICS }, (_, i) => a[i]
        ? `<div class="s on${i === 0 ? " main" : ""}" data-i="${i}" style="background-image:url('${E(a[i])}')" title="${i === 0 ? "Main picture" : "Tap to make this your main picture"}"><button type="button" class="x" data-x="${i}" aria-label="Remove">✕</button>${i === 0 ? '<span class="m">MAIN</span>' : ""}</div>`
        : `<label class="s" aria-label="Add a picture">＋<input type="file" accept="image/*" ${i === a.length ? "" : "disabled"}></label>`).join("");
    };
    host.classList.add("mw-pics");
    host.addEventListener("click", (e) => {
      const x = e.target.closest("[data-x]"); if (x) { e.preventDefault(); const a = get().slice(); a.splice(+x.dataset.x, 1); set(a); draw(); return; }
      const s = e.target.closest(".s.on"); if (s && +s.dataset.i > 0) { const a = get().slice(); a.unshift(a.splice(+s.dataset.i, 1)[0]); set(a); draw(); }
    });
    host.addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
      say("Adding your picture…");
      try { const url = await readPhoto(f); const a = get().slice(); if (a.length < MAXPICS) a.push(url); set(a); draw(); }
      catch (err) { say("Couldn't add the picture: " + (err.message || err)); }
    });
    draw(); return draw;
  }
  const picsOf = (p) => { const a = Array.isArray(p.photos) ? p.photos.filter((u) => typeof u === "string" && u) : []; const main = p.photo || signInPhoto(); return (main && !a.includes(main) ? [main, ...a] : a).slice(0, MAXPICS); };
  // only uploaded https pictures go in the list (a big photo stuck inside the profile itself would slow everyone down)
  const picsUpd = (a) => ({ photo: a[0] || "", photos: a.filter((u) => /^https:\/\//.test(u)).slice(0, MAXPICS) });

  /* Members who already set up their profile but still have no picture or no phone number:
   * a short card asking for just those two, once per visit ("Skip for now" waits until next time). */
  let qPics = [], qBusy = false;
  function quick() {
    let d = document.getElementById("pq-dlg");
    if (!d) {
      d = document.createElement("dialog"); d.id = "pq-dlg";
      d.style.cssText = "border:1px solid #8a6a2a;border-radius:20px;background:linear-gradient(180deg,#1b160d,#100e0a);color:#fff;width:min(420px,calc(100vw - 24px));max-height:calc(100vh - 32px);padding:0;overflow:auto";
      d.innerHTML = `<form id="pq-form" style="display:grid;gap:14px;padding:20px">
<h3 style="margin:0;font-size:21px;color:#f0cf78">📸 Finish your profile</h3>
<p style="margin:-6px 0 0;color:#bbb;font-size:14px">Add your profile pictures and phone number so friends know it's really you.</p>
<div style="display:grid;gap:6px"><b style="font-size:14px">📷 Profile pictures <span style="color:#bbb;font-size:12px;font-weight:400">(at least 1, up to 5; tap one to make it your main picture)</span></b><div id="pq-pics"></div></div>
<label style="display:grid;gap:5px;font-weight:700;font-size:14px">📱 Phone number<input type="tel" id="pq-phone" maxlength="20" placeholder="(724) 555-0123" autocomplete="tel" style="width:100%;background:#0b0a08;border:1px solid #333;border-radius:10px;padding:10px;color:#fff;font:16px system-ui"></label>
<label style="display:flex;gap:8px;align-items:flex-start;font-weight:600;font-size:14px"><input type="checkbox" id="pq-pub" style="margin-top:3px"> <span>Show it on my profile<br><span style="color:#bbb;font-size:12px;font-weight:400">Off by default, and then only you can see it.</span></span></label>
<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button class="btn ghost" type="button" id="pq-later">Skip for now</button><button class="btn" type="submit" id="pq-save">Save</button></div></form>`;
      document.body.appendChild(d);
      d._paint = picStrip(d.querySelector("#pq-pics"), () => qPics, (a) => { qPics = a; });
      d.querySelector("#pq-later").addEventListener("click", () => { try { sessionStorage.setItem("mw_pq_later", "1"); } catch (_) {} d.close(); });
      d.querySelector("#pq-form").addEventListener("submit", async (e) => {
        e.preventDefault(); if (qBusy || !DB() || !ME()) return;
        const phone = d.querySelector("#pq-phone").value.trim().replace(/[^\d+()\-.\s]/g, "").slice(0, 20);
        if (!qPics.length) { say("Add at least 1 profile picture."); return; }
        if (phone && phone.replace(/\D/g, "").length < 10) { say("Put in your full phone number with area code."); return; }
        qBusy = true; d.querySelector("#pq-save").disabled = true;
        try {
          const upd = picsUpd(qPics);
          if (phone) { const pub = d.querySelector("#pq-pub").checked; upd.phone = pub ? phone : ""; upd.phonePublic = pub; }
          await DB().doc("members/" + ME()).update(upd);
          // the private copy of the phone number lives in the member's own account, never on the public profile
          if (phone && window.MW && MW.sb) { try { await MW.sb.auth.updateUser({ data: { phone_private: phone } }); } catch (_) {} }
          say("Thanks! Your profile is all set 🔥"); d.close();
        } catch (err) { say("Couldn't save: " + (err.message || err.code || err)); }
        qBusy = false; d.querySelector("#pq-save").disabled = false;
      });
    }
    const p = P() || {}; qPics = picsOf(p);
    d.querySelector("#pq-phone").value = p.phone || privPhone(); d.querySelector("#pq-pub").checked = !!p.phonePublic;
    d._paint(); if (!d.open) d.showModal();
  }
  window.MW_profileSetup = { open, quick };

  // "Design my profile" button inside Edit profile
  const pf = document.getElementById("profile-form");
  if (pf && !pf.querySelector("#ps-open")) {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn ghost"; b.id = "ps-open"; b.textContent = "🎨 Photo, phone, website, apps & job application";
    b.addEventListener("click", () => { document.getElementById("profile-dialog")?.close(); open(); });
    pf.querySelector("h3").after(b);
  }

  // on entry: new members get the full designer (picture + phone at the top);
  // members who skipped the picture or phone get the short card, once per visit.
  // Both wait for the welcome video, the entrance and any other pop-up to finish first.
  let tries = 0;
  const t = setInterval(() => {
    if (++tries > 300) return clearInterval(t);
    const p = P(); if (!ME() || !p) return;
    const flag = (k) => { try { return sessionStorage.getItem(k) === "1"; } catch (_) { return false; } };
    const missing = !p.photo || !(p.phone || privPhone());
    const which = !p.setupDone ? (flag("mw_ps_later") ? null : "full") : (missing && !flag("mw_pq_later") ? "quick" : null);
    if (!which) return clearInterval(t);
    const en = document.getElementById("enter");
    if ((en && !en.hidden) || document.getElementById("wv-box") || document.getElementById("mw-choices") || document.querySelector("dialog[open]") || document.documentElement.classList.contains("gated")) return;
    if (window.MW_screenClear && !MW_screenClear("pq")) return;
    clearInterval(t); setTimeout(() => { if (!document.querySelector("dialog[open]")) (which === "full" ? open : quick)(); }, 1500);
  }, 2000);
})();
