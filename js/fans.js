/* 🔞 Meechie's Fans (#fans): an 18+ creator platform. Server: functions/api/fans/[[path]].js
 * Tabs: Feed · Creators · Wallet · Creator studio (or Become a creator) · Owner (Meechie only). */
(function () {
  "use strict";
  const view = document.getElementById("v-fans"); if (!view) return;
  const root = view.querySelector("#fans-root");
  const U = (u) => (/^https:\/\/[^\s"'()<>\\]+$/.test(String(u || "")) ? String(u) : ""); // safe inside CSS url('…')
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : alert(t));
  const $ = (s, r = root) => r.querySelector(s);
  const usd = (c) => "$" + ((c || 0) / 100).toFixed(2);
  const tok = () => { try { return MW.session().access_token; } catch (_) { return ""; } };
  const api = (path, body) => fetch("/api/fans/" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }));
  const upload = async (file, kind) => {
    let body = file, type = file.type || "image/jpeg";
    if (/^image\//.test(type) && typeof compress === "function" && file.size > 600e3) { const d = await compress(file, kind === "id" ? 1600 : 1600); body = await (await fetch(d)).blob(); type = "image/jpeg"; }
    const r = await fetch("/api/fans/upload?kind=" + kind, { method: "POST", headers: { "content-type": type, authorization: "Bearer " + tok() }, body });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Upload failed"); return j;
  };
  let st = null, tab = "feed", feedFor = null;

  const css = document.createElement("style");
  css.textContent = `#fans-root{display:grid;gap:16px}
.fn-tabs{display:flex;gap:6px;flex-wrap:wrap}
.fn-tabs button{border:1px solid var(--gold,#d6aa4a);background:rgba(10,8,5,.6);color:var(--gold-hi,#ffe08a);border-radius:999px;padding:8px 14px;font:800 13px var(--display,serif);letter-spacing:.05em;cursor:pointer}
.fn-tabs button[aria-pressed=true]{background:linear-gradient(172deg,#fff6cf,#ffd76a 30%,#e0a93a 60%,#ffe08a);color:#130e04}
.fn-card{border-radius:18px;padding:16px;display:grid;gap:10px;background:linear-gradient(165deg,rgba(22,18,11,.95),rgba(8,7,5,.97));border:1px solid rgba(214,170,74,.45)}
.fn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.fn-head{display:flex;gap:10px;align-items:center}
.fn-av{width:44px;height:44px;border-radius:50%;background:#241d10 center/cover;flex:none;box-shadow:0 0 0 2px #d6aa4a}
.fn-media{display:grid;gap:6px}.fn-media img,.fn-media video{width:100%;max-height:80vh;object-fit:contain;background:#000;border-radius:14px}
.fn-lock{position:relative;min-height:260px;border-radius:14px;overflow:hidden;display:grid;place-items:center;text-align:center;background:#0b0906 center/cover}
.fn-lock::before{content:"";position:absolute;inset:0;background:inherit;filter:blur(18px) brightness(.55);transform:scale(1.15)}
.fn-lock>div{position:relative;display:grid;gap:8px;justify-items:center;padding:20px}
.fn-lock b{font:800 18px var(--display,serif);color:#ffe08a}
.fn-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.fn-form{display:grid;gap:10px}.fn-form label{display:grid;gap:5px;font-weight:700;font-size:14px}
.fn-form input,.fn-form textarea,.fn-form select{width:100%;padding:10px;border-radius:10px;font:16px var(--body,system-ui)}
.fn-form .chk{display:flex;gap:8px;align-items:flex-start;font-weight:600}.fn-form .chk input{width:auto;margin-top:4px}
.fn-note{font-size:13px;color:var(--muted,#bbb);line-height:1.5}
.fn-warn{border-left:3px solid #e0a93a;padding:10px 12px;background:rgba(224,169,58,.08);border-radius:0 10px 10px 0;font-size:14px}
.fn-packs{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}
.fn-packs button{display:grid;gap:2px;justify-items:center;padding:12px 6px;border-radius:12px;border:1px solid #d6aa4a;background:#120f09;color:#fff;font:700 13px var(--body,system-ui);cursor:pointer}
.fn-packs button span{font-size:18px;color:#ffe08a}
.fn-thumbs{display:flex;gap:6px;flex-wrap:wrap}.fn-thumbs img,.fn-thumbs video{width:72px;height:72px;object-fit:cover;border-radius:8px}
.fn-rel{border:1px dashed #6b5a35;border-radius:12px;padding:10px;display:grid;gap:8px}
.fn-id img{max-width:100%;max-height:340px;border-radius:10px;background:#000}`;
  document.head.appendChild(css);

  async function load() { const r = await api("status"); st = r.j || {}; }
  async function render() {
    if (!tok()) { root.innerHTML = `<div class="fn-card"><h3>🔞 Meechie's Fans is for adults 18+</h3><p>Sign in or join free to enter.</p><button class="btn" type="button" data-auth="signup">Join free</button></div>`; return; }
    if (!st) await load();
    if (!st.viewer && !st.owner) return gate();
    const isCreator = st.creator && st.creator.status === "approved";
    const tabs = [["feed", "🔥 Feed"], ["creators", "⭐ Creators"], ["wallet", "🪙 Wallet"], [isCreator ? "studio" : "apply", isCreator ? "🎬 Creator studio" : "💼 Become a creator"], ...(st.owner ? [["owner", "👑 Owner"]] : [])];
    root.innerHTML = `<div class="fn-tabs">${tabs.map(([k, n]) => `<button type="button" data-ftab="${k}" aria-pressed="${tab === k}">${n}</button>`).join("")}</div><div id="fn-body"><p class="muted">Loading…</p></div>`;
    const body = $("#fn-body");
    try { await ({ feed, creators, wallet, apply, studio, owner }[tab] || feed)(body); } catch (e) { body.innerHTML = `<p class="fn-warn">${E(e.message || e)}</p>`; }
  }

  /* ---------- 18+ gate ---------- */
  function gate() {
    root.innerHTML = `<form class="fn-card fn-form" id="fn-gate"><h3>🔞 Adults only</h3>
<p>Meechie's Fans has adult content, including nudity and sexual content, from verified adult creators.</p>
<label>Your date of birth<input type="date" id="fn-dob" required max="${new Date().toISOString().slice(0, 10)}"></label>
<label class="chk"><input type="checkbox" id="fn-agree" required><span>I'm 18 or older (and of legal age where I live), I want to see adult content, and viewing it is legal where I am. I won't record, screenshot, share or resell anything I see here.</span></label>
<button class="btn" type="submit">Enter Meechie's Fans</button>
<p class="fn-note">Lying about your age is against our rules and can get your account removed. Never share anything showing someone under 18. We report it to the authorities.</p></form>`;
  }

  /* ---------- feed ---------- */
  async function feed(body) {
    const r = await api("feed" + (feedFor ? "?creator=" + encodeURIComponent(feedFor) : "")); if (!r.ok) throw new Error(r.j.error || "Couldn't load.");
    const ps = r.j.posts || [];
    body.innerHTML = (feedFor ? `<button class="btn ghost sm" type="button" data-fall>← All creators' posts</button>` : "") + (ps.length ? ps.map(post).join("") : `<div class="fn-card"><h3>No posts yet</h3><p>Approved creators' posts show up here.</p></div>`);
  }
  function post(p) {
    const av = p.by && U(p.by.photo) ? `style="background-image:url('${E(U(p.by.photo))}')"` : "";
    const media = p.locked
      ? `<div class="fn-lock" ${p.preview ? `style="background-image:url('${E(p.preview)}')"` : ""}><div><span style="font-size:34px">🔒</span><b>${p.price_cents ? "Unlock for " + usd(p.price_cents) : "Subscribers only"}</b><span class="fn-note">${p.count} ${p.count === 1 ? "photo/video" : "photos/videos"}</span>
         ${p.price_cents ? `<button class="btn" type="button" data-funlock="${E(p.id)}">Unlock for ${usd(p.price_cents)}</button>` : `<button class="btn" type="button" data-fsub="${E(p.creator)}">Subscribe ${usd(p.by.price_cents)}/month</button>`}</div></div>`
      : `<div class="fn-media" oncontextmenu="return false">${p.media.map((m) => m.video ? `<video src="${E(m.url)}" controls playsinline controlslist="nodownload" preload="metadata"></video>` : `<img src="${E(m.url)}" alt="" loading="lazy" draggable="false">`).join("")}</div>`;
    return `<article class="fn-card"><div class="fn-head"><span class="fn-av" ${av}></span><div style="flex:1;min-width:0"><b style="color:#ffe08a">${E(p.by.name)}</b><div class="fn-note">${new Date(p.created_at).toLocaleString()}${p.price_cents ? " · pay-per-view" : ""}</div></div><button class="btn ghost sm" type="button" data-fcreator="${E(p.creator)}">Profile</button></div>
${p.caption ? `<p style="margin:0;white-space:pre-wrap">${E(p.caption)}</p>` : ""}${media}
<div class="fn-acts">${p.mine ? `<button class="btn ghost sm" type="button" data-fdel="${E(p.id)}">Delete</button>` : `<button class="btn sm" type="button" data-ftip="${E(p.creator)}" data-fpost="${E(p.id)}">💸 Tip</button><button class="btn ghost sm" type="button" data-freport="${E(p.id)}">⚑ Report</button>`}</div></article>`;
  }

  /* ---------- creators ---------- */
  async function creators(body) {
    const r = await api("creators"); if (!r.ok) throw new Error(r.j.error || "Couldn't load.");
    const cs = r.j.creators || [];
    body.innerHTML = cs.length ? `<div class="fn-grid">${cs.map((c) => `<div class="fn-card"><div class="fn-head"><span class="fn-av" ${U(c.photo) ? `style="background-image:url('${E(U(c.photo))}')"` : ""}></span><div><b style="color:#ffe08a">${E(c.name)}</b><div class="fn-note">${c.posts} posts</div></div></div>${c.bio ? `<p class="fn-note" style="margin:0">${E(c.bio)}</p>` : ""}
<div class="fn-acts">${c.subscribed ? `<span class="fn-note">✓ Subscribed</span>` : `<button class="btn sm" type="button" data-fsub="${E(c.uid)}">Subscribe ${usd(c.price_cents)}/mo</button>`}<button class="btn ghost sm" type="button" data-fcreator="${E(c.uid)}">See posts</button></div></div>`).join("")}</div>` : `<div class="fn-card"><h3>No creators yet</h3><p>Be the first. Tap "Become a creator".</p></div>`;
  }

  /* ---------- wallet ---------- */
  function packs(p) { return `<div class="fn-packs">${Object.entries(p || {}).map(([k, v]) => `<button type="button" data-fbuy="${k}"><span>🪙 ${v.tokens.toLocaleString()}</span>${usd(v.cents)}</button>`).join("")}</div>`; }
  async function wallet(body) {
    const r = await api("wallet"); if (!r.ok) throw new Error(r.j.error || "Couldn't load."); const w = r.j;
    body.innerHTML = `<div class="fn-card"><h3 style="margin:0">🪙 Fans tokens: ${w.tokens.toLocaleString()}</h3><p class="fn-note" style="margin:0">1 token = 1¢. Use them to subscribe, unlock posts and tip creators.</p>
${w.payOn ? packs(w.packs) + `<p class="fn-note">Payment is handled by CCBill, a secure processor for adult sites. It shows up on your statement discreetly.</p>` : `<p class="fn-warn">Buying tokens opens as soon as Meechie's adult payment account (CCBill) is approved.</p>`}</div>
${(w.subs || []).length ? `<div class="fn-card"><h3 style="margin:0">Your subscriptions</h3>${w.subs.map((s) => `<div class="fn-note">${E(s.name)}: active until ${new Date(s.until).toLocaleDateString()}</div>`).join("")}</div>` : ""}
${st.creator && st.creator.status === "approved" ? `<form class="fn-card fn-form" id="fn-cash"><h3 style="margin:0">💸 Your earnings: ${usd(w.availableCents)} ready</h3><p class="fn-note" style="margin:0">You keep ${Math.round((1 - (st.ownerShare || 0.6)) * 100)}% of every subscription, unlock and tip. Cash out at $20. Paid so far: ${usd(w.paidCents)}${w.pendingCents ? ` · ${usd(w.pendingCents)} on its way` : ""}.</p>
<select id="fn-cm"><option>Cash App</option><option>PayPal</option><option>Zelle</option><option>Venmo</option></select><input id="fn-ch" placeholder="$cashtag, PayPal email, or Zelle phone/email" maxlength="80"><button class="btn" type="submit" ${w.availableCents >= 2000 ? "" : "disabled"}>Cash out ${usd(w.availableCents)}</button></form>` : ""}`;
  }

  /* ---------- become a creator ---------- */
  function apply(body) {
    const c = st.creator;
    body.innerHTML = `${c && c.status === "pending" ? `<p class="fn-warn">⏳ Your application is being reviewed. You'll get a message when you're approved.</p>` : ""}${c && c.status === "rejected" ? `<p class="fn-warn">Your last application wasn't approved${c.review_note ? ": " + E(c.review_note) : ""}. You can apply again.</p>` : ""}
<form class="fn-card fn-form" id="fn-apply"><h3 style="margin:0">💼 Become a Meechie's Fans creator</h3>
<p class="fn-note">Sell subscriptions and pay-per-view posts and get tips. You keep ${Math.round((1 - (st.ownerShare || 0.6)) * 100)}% of everything you make. To keep everyone safe, every creator is checked by hand before they can post. Your ID is private: only Meechie can see it.</p>
<label>Creator name (shown to fans)<input id="fa-name" maxlength="40" required></label>
<label>About you<textarea id="fa-bio" maxlength="300" rows="2"></textarea></label>
<label>Monthly subscription price ($3 to $50)<input id="fa-price" type="number" min="3" max="50" step="0.01" value="9.99" required></label>
<label>Full legal name (exactly as on your ID)<input id="fa-legal" maxlength="100" required autocomplete="name"></label>
<label>Date of birth<input id="fa-dob" type="date" required></label>
<label>📄 Photo of your government ID (driver's license, state ID or passport)<input id="fa-id" type="file" accept="image/*" required></label>
<label>🤳 Selfie holding that ID next to your face<input id="fa-selfie" type="file" accept="image/*" capture="user" required></label>
<label class="chk"><input type="checkbox" id="fa-agree" required><span>I'm 18 or older. I own or have the rights to everything I post. <b>Everyone</b> in my content is 18+, agreed to be filmed or photographed and agreed to it being posted, and I'll upload their ID and signed release with any post they're in. I won't post anything illegal, anything with someone under 18, or anything without consent. Meechie's World keeps these records as the law requires and can remove content or accounts.</span></label>
<button class="btn" type="submit">Send my application</button></form>`;
  }

  /* ---------- creator studio ---------- */
  let draft = { media: [], thumbs: [], preview: "", releases: [] };
  function studio(body) {
    const c = st.creator;
    body.innerHTML = `<form class="fn-card fn-form" id="fn-post"><h3 style="margin:0">🎬 New post</h3>
<label>Photos or videos (up to 10, videos under 25 MB)<input id="fp-files" type="file" accept="image/*,video/mp4,video/quicktime,video/webm" multiple></label><div class="fn-thumbs" id="fp-thumbs"></div>
<label>Caption<textarea id="fp-cap" maxlength="1000" rows="3"></textarea></label>
<label>Who can see it<select id="fp-who"><option value="sub">My subscribers</option><option value="ppv">Pay-per-view (set a price)</option></select></label>
<label id="fp-pricewrap" hidden>Price to unlock ($1 to $200)<input id="fp-price" type="number" min="1" max="200" step="0.01" value="5.00"></label>
<label class="chk"><input type="checkbox" id="fp-adults" required><span>Everyone shown is 18 or older.</span></label>
<label class="chk"><input type="checkbox" id="fp-consent" required><span>Everyone shown agreed to be in it and to it being posted here.</span></label>
<label class="chk"><input type="checkbox" id="fp-others"><span>Someone other than me appears in this post.</span></label>
<div id="fp-rels" hidden></div>
<button class="btn" type="submit">Post</button></form>
<form class="fn-card fn-form" id="fn-prof"><h3 style="margin:0">⚙️ Your creator page</h3><label>Creator name<input id="fc-name" maxlength="40" value="${E(c.name)}"></label><label>About you<textarea id="fc-bio" maxlength="300" rows="2">${E(c.bio || "")}</textarea></label><label>Monthly price<input id="fc-price" type="number" min="3" max="50" step="0.01" value="${(c.price_cents / 100).toFixed(2)}"></label><button class="btn ghost" type="submit">Save</button></form>`;
    draft = { media: [], thumbs: [], preview: "", releases: [] };
  }
  function relRow(i) { return `<div class="fn-rel" data-rel="${i}"><b>Person ${i + 1}</b><label>Their full legal name<input data-rn></label><label>Their date of birth<input type="date" data-rd></label><label>Photo of their ID<input type="file" accept="image/*" data-ri></label><label>Their signed release (photo of the signed form)<input type="file" accept="image/*,application/pdf" data-rr></label></div>`; }
  async function blurPreview(file) {
    try { const url = URL.createObjectURL(file); const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const c = document.createElement("canvas"); c.width = 24; c.height = Math.max(8, Math.round(24 * img.height / img.width)); const x = c.getContext("2d"); x.filter = "blur(2px)"; x.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); return c.toDataURL("image/jpeg", 0.5);
    } catch (_) { return ""; }
  }

  /* ---------- owner ---------- */
  async function owner(body) {
    const r = await api("admin"); if (!r.ok) throw new Error(r.j.error || "Couldn't load."); const a = r.j;
    body.innerHTML = `<div class="fn-card"><h3 style="margin:0">👑 Meechie's Fans: owner</h3><p class="fn-note" style="margin:0">Tokens sold: ${usd(a.sum.sold)} · your ${Math.round((st.ownerShare || 0.6) * 100)}%: ${usd(a.sum.yours)} · creators: ${usd(a.sum.creators)}</p>${a.payOn ? "" : `<p class="fn-warn">Payments are off until you add your CCBill details in Cloudflare (Settings → Variables and secrets: CCBILL_ACCOUNT, CCBILL_SUBACCOUNT, CCBILL_FLEX_ID, CCBILL_SALT).</p>`}</div>
<div class="fn-card"><h3 style="margin:0">🪪 Creator applications (${a.apps.length})</h3><p class="fn-note" style="margin:0">Approve only if the ID is real and current, the selfie is the same person holding that ID, the birthday shows 18+, and the legal name matches.</p>
${a.apps.map((x) => `<div class="fn-rel"><b>${E(x.name)}</b> <span class="fn-note">(member: ${E(x.handle || "")})</span><div class="fn-note">Legal name: <b>${E(x.legal_name)}</b> · Born ${E(x.dob)} · Price ${usd(x.price_cents)}/mo</div><div class="fn-grid fn-id"><img src="${E(x.id_front_url)}" alt="ID"><img src="${E(x.id_selfie_url)}" alt="Selfie with ID"></div>
<input placeholder="Note to them if you say no (optional)" data-fnote="${E(x.uid)}"><div class="fn-acts"><button class="btn sm" type="button" data-fapprove="${E(x.uid)}">✅ Approve</button><button class="btn ghost sm" type="button" data-freject="${E(x.uid)}">Not approved</button></div></div>`).join("") || `<span class="fn-note">None waiting.</span>`}</div>
<div class="fn-card"><h3 style="margin:0">🚨 Reports (${a.reports.length})</h3>${a.reports.map((x) => `<div class="fn-rel"><b>${E({ minor: "May show someone under 18", consent: "Posted without consent", stolen: "Stolen content", other: "Other" }[x.reason] || x.reason)}</b><span class="fn-note">${E(x.details || "")} · post is ${E(x.post_status)} · ${new Date(x.at).toLocaleString()}</span><div class="fn-acts"><button class="btn ghost sm" type="button" data-fview="${E(x.post_id)}">View post</button><button class="btn ghost sm" type="button" data-frec="${E(x.post_id)}">Records (IDs & releases)</button><button class="btn sm" type="button" data-fremove="${x.id}">Remove post</button><button class="btn ghost sm" type="button" data-fkeep="${x.id}">It's fine, keep it</button></div><div data-fout="${E(x.post_id)}"></div></div>`).join("") || `<span class="fn-note">No open reports.</span>`}
<p class="fn-note">If something shows a child, remove it and report it to the NCMEC CyberTipline (report.cybertip.org). Don't download or share it.</p></div>
<div class="fn-card"><h3 style="margin:0">💸 Cash-outs</h3>${a.cashouts.map((x) => `<div class="fn-acts"><span>${E(x.name || "Creator")} · ${usd(x.cents)} · ${E(x.method)}: <b>${E(x.handle)}</b></span><button class="btn sm" type="button" data-fpaid="${x.id}">Mark paid</button></div>`).join("") || `<span class="fn-note">No one waiting.</span>`}</div>
<div class="fn-card"><h3 style="margin:0">Creators</h3>${a.creators.map((x) => `<div class="fn-note">${E(x.name)} · ${E(x.status)} · ${E(x.legal_name)} · born ${E(x.dob)}</div>`).join("") || `<span class="fn-note">None yet.</span>`}</div>`;
  }

  /* ---------- buying ---------- */
  async function needTokens() { tab = "wallet"; await render(); say("You need more tokens for that."); }
  async function buy(pack) { const r = await api("buy", { pack }); if (r.ok && /^https:\/\/api\.ccbill\.com\//.test(r.j.url || "")) location.href = r.j.url; else say(r.j.error || "Payments aren't open yet."); }

  /* ---------- events ---------- */
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return; const d = b.dataset;
    if (d.ftab) { tab = d.ftab; feedFor = null; return render(); }
    if (d.fall !== undefined) { feedFor = null; return render(); }
    if (d.fcreator) { feedFor = d.fcreator; tab = "feed"; return render(); }
    if (d.fbuy) return buy(d.fbuy);
    if (d.fsub) { b.disabled = true; const r = await api("subscribe", { creator: d.fsub }); if (r.status === 402) return needTokens(); say(r.ok ? "Subscribed for 30 days 🔥" : r.j.error || "Couldn't subscribe."); return render(); }
    if (d.funlock) { b.disabled = true; const r = await api("unlock", { id: d.funlock }); if (r.status === 402) return needTokens(); say(r.ok ? "Unlocked 🔓" : r.j.error || "Couldn't unlock."); return render(); }
    if (d.ftip) { const n = Math.round(+prompt("How many tokens to tip? (100 tokens = $1)", "500") || 0); if (!n) return; const r = await api("tip", { creator: d.ftip, tokens: n, post: d.fpost }); if (r.status === 402) return needTokens(); say(r.ok ? "Tip sent 💸" : r.j.error || "Couldn't tip."); return; }
    if (d.freport) { const reason = prompt("Why are you reporting this?\n1 = May show someone under 18\n2 = Posted without consent\n3 = Stolen content\n4 = Something else", "1"); const map = { 1: "minor", 2: "consent", 3: "stolen", 4: "other" }; if (!map[reason]) return; const r = await api("report", { id: d.freport, reason: map[reason] }); say(r.ok ? "Thanks. Meechie will review it." + (+reason <= 2 ? " It's hidden for now." : "") : r.j.error || "Couldn't report."); return render(); }
    if (d.fdel) { if (!d.sure) { d.sure = 1; b.textContent = "Tap again to delete"; return; } await api("post/delete", { id: d.fdel }); return render(); }
    if (d.fapprove || d.freject) { const uid = d.fapprove || d.freject; const note = (root.querySelector(`[data-fnote="${CSS.escape(uid)}"]`) || {}).value || ""; const r = await api("admin/review", { uid, decision: d.fapprove ? "approve" : "reject", note }); say(r.ok ? "Saved. They got a message." : r.j.error); return render(); }
    if (d.fremove || d.fkeep) { const r = await api("admin/report", { id: +(d.fremove || d.fkeep), action: d.fremove ? "remove" : "keep" }); say(r.ok ? "Done." : r.j.error); return render(); }
    if (d.fpaid) { if (!d.sure) { d.sure = 1; b.textContent = "Tap again once you've paid"; return; } const r = await api("admin/paid", { id: +d.fpaid }); say(r.ok ? "Marked paid." : r.j.error); return render(); }
    if (d.fview || d.frec) { const out = root.querySelector(`[data-fout="${CSS.escape(d.fview || d.frec)}"]`);
      if (d.fview) { const r = await api("admin/view-post", { post: d.fview }); out.innerHTML = r.ok ? `<p>${E(r.j.caption || "")}</p><div class="fn-grid fn-id">${r.j.media.map((m) => m.video ? `<video src="${E(m.url)}" controls></video>` : `<img src="${E(m.url)}" alt="">`).join("")}</div>` : E(r.j.error); }
      else { const r = await api("admin/records", { post: d.frec }); out.innerHTML = r.ok ? (r.j.releases.length ? r.j.releases.map((x) => `<div class="fn-note">${E(x.person_name)} · born ${E(x.dob)}</div><div class="fn-grid fn-id"><img src="${E(x.id_url)}" alt="ID"><a class="btn ghost sm" href="${E(x.release_url)}" target="_blank" rel="noopener">Open signed release</a></div>`).join("") : `<span class="fn-note">Only the creator appears (their ID is on their application).</span>`) : E(r.j.error); } }
  });
  root.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.id === "fp-who") $("#fp-pricewrap").hidden = t.value !== "ppv";
    if (t.id === "fp-others") { const w = $("#fp-rels"); w.hidden = !t.checked; if (t.checked && !w.children.length) w.innerHTML = relRow(0) + `<button class="btn ghost sm" type="button" id="fp-addrel">＋ Add another person</button>`; }
    if (t.id === "fp-files") {
      const files = [...t.files].slice(0, 10 - draft.media.length); t.value = ""; const th = $("#fp-thumbs");
      for (const f of files) { th.insertAdjacentHTML("beforeend", `<span class="fn-note" data-up>Uploading…</span>`);
        try { const up = await upload(f, "post"); draft.media.push(up.key); if (!draft.preview && /^image\//.test(f.type)) draft.preview = await blurPreview(f);
          th.querySelector("[data-up]").outerHTML = /^video\//.test(f.type) ? `<video src="${E(up.url)}" muted></video>` : `<img src="${E(up.url)}" alt="">`;
        } catch (er) { th.querySelector("[data-up]").remove(); say(er.message); } }
    }
  });
  root.addEventListener("click", (e) => { if (e.target.id === "fp-addrel") { const w = $("#fp-rels"); const n = w.querySelectorAll("[data-rel]").length; if (n < 6) e.target.insertAdjacentHTML("beforebegin", relRow(n)); } });
  root.addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target, btn = f.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
    try {
      if (f.id === "fn-gate") { const r = await api("gate", { dob: $("#fn-dob").value, agree: $("#fn-agree").checked }); if (!r.ok) throw new Error(r.j.error); st = null; tab = "feed"; return render(); }
      if (f.id === "fn-apply") {
        say("Uploading your ID privately…");
        const id = await upload($("#fa-id").files[0], "id"), selfie = await upload($("#fa-selfie").files[0], "id");
        const r = await api("apply", { name: $("#fa-name").value, bio: $("#fa-bio").value, price_cents: Math.round(+$("#fa-price").value * 100), legalName: $("#fa-legal").value, dob: $("#fa-dob").value, idFront: id.key, idSelfie: selfie.key, agree: $("#fa-agree").checked });
        if (!r.ok) throw new Error(r.j.error); say("Application sent. You'll get a message once you're reviewed."); st = null; return render();
      }
      if (f.id === "fn-post") {
        const others = $("#fp-others").checked, releases = [];
        if (others) for (const row of f.querySelectorAll("[data-rel]")) {
          const fi = row.querySelector("[data-ri]").files[0], fr = row.querySelector("[data-rr]").files[0]; if (!fi || !fr) throw new Error("Add each person's ID and signed release.");
          const a = await upload(fi, "id"), b2 = await upload(fr, "id");
          releases.push({ name: row.querySelector("[data-rn]").value, dob: row.querySelector("[data-rd]").value, id: a.key, release: b2.key });
        }
        const ppv = $("#fp-who").value === "ppv";
        const r = await api("post", { media: draft.media, caption: $("#fp-cap").value, price_cents: ppv ? Math.round(+$("#fp-price").value * 100) : 0, preview: draft.preview, allAdults: $("#fp-adults").checked, consent: $("#fp-consent").checked, others, releases });
        if (!r.ok) throw new Error(r.j.error); say("Posted 🔥"); tab = "feed"; return render();
      }
      if (f.id === "fn-prof") { const r = await api("profile", { name: $("#fc-name").value, bio: $("#fc-bio").value, price_cents: Math.round(+$("#fc-price").value * 100) }); if (!r.ok) throw new Error(r.j.error); say("Saved."); st = null; return render(); }
      if (f.id === "fn-cash") { const r = await api("cashout", { method: $("#fn-cm").value, handle: $("#fn-ch").value }); if (!r.ok) throw new Error(r.j.error); say("Cash-out requested."); return render(); }
    } catch (er) { say(er.message || String(er)); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  });
  new MutationObserver(() => { if (!view.hidden) { st = null; render(); } }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  if (!view.hidden) render();
})();
