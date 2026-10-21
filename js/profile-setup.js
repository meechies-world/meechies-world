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
  let photo = "", pics = [], cover = "", color = "gold", busy = false, intro = "", albums = [];
  const MAXALB = 10, MAXALBPICS = 30; // up to 10 albums, 30 album photos in all

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
.ps-acts{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.ps-meter{display:grid;gap:6px;border:1px solid var(--line,#333);border-radius:14px;padding:10px 12px;background:#0f0c08}
.ps-meter .bar{height:10px;border-radius:999px;background:#2a2316;overflow:hidden}.ps-meter .bar i{display:block;height:100%;background:linear-gradient(90deg,#b8862b,#f0cf78);border-radius:999px;transition:width .3s}
.ps-meter b{font-size:14px}.ps-meter small{color:var(--muted,#bbb);font-size:12px;line-height:1.4}
.ps-vid{display:grid;gap:6px}.ps-vid video{width:100%;max-height:240px;border-radius:12px;background:#000}
.ps-alb{border:1px solid var(--line,#333);border-radius:12px;padding:10px;display:grid;gap:8px}
.ps-alb .row{display:flex;gap:6px;align-items:center}.ps-alb .row input{flex:1}
.ps-alb .ph{display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:6px}
.ps-alb .ph div{position:relative;aspect-ratio:1;border-radius:8px;background:#1d1810 center/cover}
.ps-alb .ph .x{position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;border:0;background:#000c;color:#fff;font:700 11px system-ui;cursor:pointer;padding:0}
.ps-alb .add{position:relative;aspect-ratio:1;border-radius:8px;border:1px dashed #6b5a35;display:grid;place-items:center;color:#a99f8b;font:700 20px system-ui;cursor:pointer}
.ps-alb .add input{position:absolute;inset:0;opacity:0;cursor:pointer}`;
  document.head.appendChild(css);

  function dialog() {
    let d = document.getElementById("ps-dlg"); if (d) return d;
    d = document.createElement("dialog"); d.id = "ps-dlg";
    d.innerHTML = `<form id="ps-form">
<h3>🎨 Design your profile</h3><p class="lead">Start with your <b>profile picture</b> and <b>phone number</b> so friends know it's you. You can change anything later in Edit profile.</p>
<div class="ps-meter" id="ps-meter" aria-live="polite"></div>
<div class="ps-top"><label class="ps-pic" id="ps-pic" aria-label="Add a profile picture"><span id="ps-ini"></span><small>📷 Photo</small><input type="file" accept="image/*" id="ps-file"></label>
<div style="display:grid;gap:8px"><b style="font-size:14px">Profile color</b><div class="ps-colors" id="ps-colors">${COLORS.map(([n, h]) => `<button type="button" data-col="${n}" style="background:${h}" aria-label="${n}"></button>`).join("")}</div></div></div>
<div style="display:grid;gap:6px"><b style="font-size:14px">📷 Profile pictures <span class="hint">(at least 1, up to 5; tap one to make it your main picture)</span></b><div id="ps-pics"></div></div>
<label>📱 Phone number <input type="tel" id="ps-phone" maxlength="20" placeholder="(724) 555-0123" autocomplete="tel"></label>
<label class="chk"><input type="checkbox" id="ps-phone-pub"> <span>Show my phone number on my profile<br><span class="hint">Off by default, and then only you can see it. If you turn it on, anyone who visits can see it.</span></span></label>
<label>Cover photo <span class="hint">(the wide picture across the top of your profile)</span><input type="file" accept="image/*" id="ps-cover-f"><span class="ps-cov" id="ps-cov"></span></label>
<div class="ps-vid"><b style="font-size:14px">🎥 Intro video <span class="hint">(a short clip that plays on your profile, under about 1 minute)</span></b><div id="ps-vid-box"></div>
<label class="btn ghost sm" style="position:relative;justify-self:start;cursor:pointer;display:inline-flex;gap:6px;align-items:center">📹 <span id="ps-vid-lbl">Add intro video</span><input type="file" accept="video/*" id="ps-vid-f" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label></div>
<div style="display:grid;gap:8px"><b style="font-size:14px">📁 Photo albums <span class="hint">(up to ${MAXALB} albums, ${MAXALBPICS} photos in all)</span></b><div id="ps-albums" style="display:grid;gap:8px"></div>
<button class="btn ghost sm" type="button" id="ps-alb-new" style="justify-self:start">＋ New album</button></div>
<div class="ps-soc"><label>Works at<input type="text" id="ps-work" maxlength="80" placeholder="Company or job"></label><label>Went to school at<input type="text" id="ps-school" maxlength="80" placeholder="School"></label>
<label>Lives in<input type="text" id="ps-city" maxlength="60" placeholder="City, State"></label><label>From<input type="text" id="ps-home" maxlength="60" placeholder="Hometown"></label>
<label>Relationship<select id="ps-rel"><option value="">Don't show</option><option>Single</option><option>In a relationship</option><option>Engaged</option><option>Married</option><option>It's complicated</option></select></label>
<label>Job title<input type="text" id="ps-title" maxlength="60" placeholder="e.g. Barber, Owner, Artist"></label><label>College<input type="text" id="ps-college" maxlength="80" placeholder="College or trade school"></label>
<label>High school<input type="text" id="ps-hs" maxlength="80" placeholder="High school"></label><label>Languages<input type="text" id="ps-lang" maxlength="80" placeholder="English, Spanish…"></label>
<label>Pronouns <span class="hint">(optional)</span><input type="text" id="ps-pron" maxlength="20" placeholder="he/him, she/her…"></label>
<label>Birthday<input type="date" id="ps-bday" max="${new Date().toISOString().slice(0, 10)}"></label></div>
<label class="chk"><input type="checkbox" id="ps-bday-pub"> <span>Show my birthday (month and day only) on my profile<br><span class="hint">Your birth year is never shown. Off = only you know it.</span></span></label>
<label>About me <span class="hint">(tell people who you are)</span><textarea id="ps-about" rows="3" maxlength="600" placeholder="A few lines about you, what you do and what you're about"></textarea></label>
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
    const drawPics = picStrip(d.querySelector("#ps-pics"), () => pics, (a) => { pics = a; photo = a[0] || ""; paint(); if (d._meter) d._meter(); });
    d._paint = () => { paint(); drawPics(); d.querySelector("#ps-cov").style.backgroundImage = cover ? `url("${cover.replace(/"/g, "")}")` : ""; drawVid(); drawAlbums(); meter(); };
    const drawVid = () => { d.querySelector("#ps-vid-box").innerHTML = intro ? `<video src="${E(intro)}#t=0.1" controls playsinline preload="metadata"></video><button class="btn ghost sm" type="button" id="ps-vid-x" style="justify-self:start">✕ Remove video</button>` : ""; d.querySelector("#ps-vid-lbl").textContent = intro ? "Change intro video" : "Add intro video"; };
    const albCount = () => albums.reduce((n, a) => n + a.photos.length, 0);
    const drawAlbums = () => {
      d.querySelector("#ps-albums").innerHTML = albums.map((a, i) => `<div class="ps-alb" data-alb="${i}"><div class="row"><input type="text" data-albname="${i}" maxlength="40" value="${E(a.name)}" placeholder="Album name"><button class="btn ghost sm" type="button" data-albdel="${i}">Delete</button></div>
<div class="ph">${a.photos.map((u, j) => `<div style="background-image:url('${E(safe(u))}')"><button type="button" class="x" data-albx="${i}:${j}" aria-label="Remove">✕</button></div>`).join("")}${albCount() < MAXALBPICS ? `<label class="add" aria-label="Add photos">＋<input type="file" accept="image/*" multiple data-albadd="${i}"></label>` : ""}</div></div>`).join("");
      d.querySelector("#ps-alb-new").hidden = albums.length >= MAXALB;
    };
    const meter = () => { const sc = score(current(), true); d.querySelector("#ps-meter").innerHTML = `<b>Profile ${sc.pct}% complete${sc.pct === 100 ? " 🏆" : ""}</b><div class="bar"><i style="width:${sc.pct}%"></i></div>${sc.missing.length ? `<small>Still to add: ${sc.missing.map(E).join(" · ")}</small>` : `<small>Your profile is complete. Looking good!</small>`}`; };
    d._meter = meter;
    d.querySelector("#ps-form").addEventListener("input", () => meter());
    d.querySelector("#ps-vid-f").addEventListener("change", async (e) => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      if (!(window.MW && MW.uploadVideo)) { say("Video upload isn't ready yet."); return; }
      const lbl = d.querySelector("#ps-vid-lbl"); lbl.textContent = "Uploading… 0%";
      try { const up = await MW.uploadVideo(f, (x) => { lbl.textContent = "Uploading… " + Math.round(x * 100) + "%"; }); if (!up || !/^https:\/\//.test(up.url)) throw new Error("Upload failed"); intro = up.url; say("Intro video added. Tap Save to keep it."); }
      catch (err) { say("Couldn't add the video: " + (err.message || err)); }
      d._paint();
    });
    d.querySelector("#ps-alb-new").addEventListener("click", () => { if (albums.length >= MAXALB) return; albums.push({ name: "", photos: [] }); d._paint(); const ins = d.querySelectorAll("[data-albname]"); if (ins.length) ins[ins.length - 1].focus(); });
    const albBox = d.querySelector("#ps-albums");
    albBox.addEventListener("input", (e) => { const i = e.target.dataset.albname; if (i !== undefined && albums[+i]) albums[+i].name = e.target.value.slice(0, 40); });
    albBox.addEventListener("click", (e) => {
      const del = e.target.closest("[data-albdel]"); if (del) { const b = del; if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "Tap again"; return; } albums.splice(+b.dataset.albdel, 1); d._paint(); return; }
      const x = e.target.closest("[data-albx]"); if (x) { const [i, j] = x.dataset.albx.split(":").map(Number); albums[i].photos.splice(j, 1); d._paint(); }
    });
    albBox.addEventListener("change", async (e) => {
      const i = e.target.dataset.albadd; if (i === undefined) return; const files = [...(e.target.files || [])]; e.target.value = "";
      for (const f of files) {
        if (albCount() >= MAXALBPICS) { say("That's the most album photos (" + MAXALBPICS + ")."); break; }
        say("Adding your picture…");
        try { const url = await readPhoto(f, 1280); if (!/^https:\/\//.test(url)) throw new Error("Upload failed, try again."); albums[+i].photos.push(url); d._paint(); }
        catch (err) { say("Couldn't add the picture: " + (err.message || err)); }
      }
    });
    d.addEventListener("click", (e) => { if (e.target.id === "ps-vid-x") { intro = ""; d._paint(); } });
    d.querySelector("#ps-int").addEventListener("click", (e) => { const b = e.target.closest("[data-int]"); if (!b) return; const x = b.dataset.int; picked.has(x) ? picked.delete(x) : picked.add(x); b.setAttribute("aria-pressed", String(picked.has(x))); if (d._meter) d._meter(); });
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
    const bday = v("ps-bday"), bdayPub = d.querySelector("#ps-bday-pub").checked;
    if (!pics.length) { say("Add at least 1 profile picture (tap the circle)."); return; }
    if (phone && phone.replace(/\D/g, "").length < 10) { say("Put in your full phone number with area code."); return; }
    if (want && (!v("pj-name") || !v("pj-exp"))) { say("Add your name and experience for the job application."); return; }
    busy = true; d.querySelector("#ps-save").disabled = true;
    try {
      // member profiles can be read by anyone, so a hidden phone number is kept in the member's private account instead
      const pub = d.querySelector("#ps-phone-pub").checked && !!phone;
      const socials = {}; SOC.forEach(([k]) => { const raw = v("pss-" + k).slice(0, 120); if (raw && socUrl(k, raw)) socials[k] = raw; });
      const upd = { phone: pub ? phone : "", phonePublic: pub, website: web, socials, color, work: v("ps-work"), school: v("ps-school"), city: v("ps-city"), hometown: v("ps-home"), relationship: d.querySelector("#ps-rel").value, interests: [...picked].slice(0, 22), emailFind: d.querySelector("#ps-emailfind").checked, setupDone: true,
        title: v("ps-title"), college: v("ps-college"), highschool: v("ps-hs"), languages: v("ps-lang"), pronouns: v("ps-pron"), about: v("ps-about").slice(0, 600),
        birthday: bdayPub && /^\d{4}-\d{2}-\d{2}$/.test(bday) ? bday.slice(5) : "", // month-day only; the year is never public
        introVideo: /^https:\/\//.test(intro) ? intro : "", albums: cleanAlbums() };
      if (!upd.emailFind) upd.emailHash = "";
      if (cover && /^https:\/\//.test(cover)) upd.cover = cover;
      Object.assign(upd, picsUpd(pics));
      await DB().doc("members/" + ME()).update(upd);
      try { if (window.MW && MW.sb) await MW.sb.auth.updateUser({ data: { phone_private: phone, birthday_private: bday } }); } catch (_) {}
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
    let privB = ""; try { privB = MW.session()?.user?.user_metadata?.birthday_private || ""; } catch (_) {}
    d.querySelector("#ps-title").value = p.title || ""; d.querySelector("#ps-college").value = p.college || ""; d.querySelector("#ps-hs").value = p.highschool || ""; d.querySelector("#ps-lang").value = p.languages || ""; d.querySelector("#ps-pron").value = p.pronouns || ""; d.querySelector("#ps-about").value = p.about || "";
    d.querySelector("#ps-bday").value = /^\d{4}-\d{2}-\d{2}$/.test(privB) ? privB : ""; d.querySelector("#ps-bday-pub").checked = !!p.birthday;
    intro = /^https:\/\//.test(p.introVideo || "") ? p.introVideo : "";
    albums = (Array.isArray(p.albums) ? p.albums : []).slice(0, MAXALB).map((a) => ({ name: String((a && a.name) || "").slice(0, 40), photos: (a && Array.isArray(a.photos) ? a.photos : []).filter((u) => safe(u)) }));
    d._paint(); if (!d.open) d.showModal();
  }
  const safe = (u) => (typeof safeImg === "function" ? safeImg(u) : (/^https:\/\/[^\s"'()<>\\]+$/i.test(String(u || "")) ? String(u) : ""));
  function cleanAlbums() { let n = 0; return albums.map((a) => ({ name: (a.name || "").trim().slice(0, 40) || "Album", photos: a.photos.filter((u) => safe(u) && n++ < MAXALBPICS) })).filter((a) => a.photos.length).slice(0, MAXALB); }
  // what the form currently holds, in the same shape as a saved profile (for the live meter)
  function current() {
    const d = document.getElementById("ps-dlg"), p = P() || {}; if (!d) return p; const v = (id) => (d.querySelector("#" + id)?.value || "").trim();
    return { ...p, photo: pics[0] || "", photos: pics, cover, introVideo: intro, albums, about: v("ps-about"), city: v("ps-city"), hometown: v("ps-home"), work: v("ps-work"), title: v("ps-title"), school: v("ps-school"), college: v("ps-college"), highschool: v("ps-hs"),
      interests: [...picked], website: v("ps-web"), socials: Object.fromEntries(SOC.map(([k]) => [k, v("pss-" + k)]).filter(([, x]) => x)), _phone: v("ps-phone"), _bday: v("ps-bday") };
  }
  /* How complete a profile is: 10 things, 10% each. Shared with the profile page (MW_profileScore). */
  function score(p, mine) {
    p = p || {}; const has = (x) => typeof x === "string" ? !!x.trim() : !!x;
    const ph = (Array.isArray(p.photos) ? p.photos : []).filter(Boolean);
    const items = [
      ["a profile picture", has(p.photo)], ["3 or more pictures", ph.length >= 3], ["a cover photo", has(p.cover)],
      ["About me", has(p.about) || has(p.bio)], ["where you live", has(p.city) || has(p.hometown)], ["work or school", has(p.work) || has(p.title) || has(p.school) || has(p.college) || has(p.highschool)],
      ["3 or more interests", Array.isArray(p.interests) && p.interests.length >= 3], ["an intro video", has(p.introVideo)],
      ["a photo album", Array.isArray(p.albums) && p.albums.some((a) => a && Array.isArray(a.photos) && a.photos.length)],
      [mine ? "your phone or apps" : "apps or website", has(p.website) || (p.socials && Object.values(p.socials).some(has)) || (mine && (has(p._phone) || has(p.phone) || has(privPhone())))],
    ];
    const done = items.filter((x) => x[1]).length;
    return { pct: done * 10, missing: items.filter((x) => !x[1]).map((x) => x[0]) };
  }
  window.MW_profileScore = score;
  // the picture from Google / Facebook sign-in, if they used one
  function signInPhoto() { try { const u = MW.session()?.user?.user_metadata?.avatar_url || ""; return /^https:\/\//.test(u) ? u : ""; } catch (_) { return ""; } }
  function privPhone() { try { return MW.session()?.user?.user_metadata?.phone_private || ""; } catch (_) { return ""; } }
  async function readPhoto(f, max) {
    const dataUrl = typeof compress === "function" ? await compress(f, max || 600) : await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
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
