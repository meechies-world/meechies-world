/* ============================================================================
   v2 VIEW — FRIENDS (#friends). MAP §4.4: "Friends are mutual: doc
   friends/<uid> = {list:[ids]}; if we both list each other we're
   friends; if only they list me it's a request."

   A faithful port of the live js/friends.js: the same four tabs (My
   friends / Requests / Find people / Friends' posts), the same card
   (avatar, name, bio, website, socials via the live MW_socUrl builder
   from profile-setup.js, public phone), the same full-replace list
   writes with my list loaded first so a save can never wipe it, the
   same two-tap unfriend, local-only Ignore, and find-by-email through
   the SHA-256 fingerprint (live email-find.js).
   ============================================================================ */
import { createSocial, esc, ago, say, emailHash, isEmail } from "../social.js";

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

/* MW_socUrl, verbatim from the live profile-setup.js */
const SOC_BASE = { facebook: "https://facebook.com/", snapchat: "https://snapchat.com/add/", instagram: "https://instagram.com/", tiktok: "https://tiktok.com/@", youtube: "https://youtube.com/@", x: "https://x.com/", whatsapp: "https://wa.me/", cashapp: "https://cash.app/$", threads: "https://threads.net/@", linkedin: "https://linkedin.com/in/", soundcloud: "https://soundcloud.com/", twitch: "https://twitch.tv/", kick: "https://kick.com/", telegram: "https://t.me/", pinterest: "https://pinterest.com/", reddit: "https://reddit.com/user/", venmo: "https://venmo.com/u/", paypal: "https://paypal.me/", linktree: "https://linktr.ee/", patreon: "https://patreon.com/", bluesky: "https://bsky.app/profile/", tumblr: "https://tumblr.com/", vimeo: "https://vimeo.com/", rumble: "https://rumble.com/c/", lemon8: "https://www.lemon8-app.com/@", triller: "https://triller.co/@", audiomack: "https://audiomack.com/", bandcamp: "https://{v}.bandcamp.com", substack: "https://{v}.substack.com", medium: "https://medium.com/@", etsy: "https://etsy.com/shop/", depop: "https://depop.com/", poshmark: "https://poshmark.com/closet/", truthsocial: "https://truthsocial.com/@", clubhouse: "https://clubhouse.com/@", bereal: "https://bere.al/", messenger: "https://m.me/" };
const SOC_LINK_ONLY = new Set(["spotify", "applemusic", "discord", "other", "mastodon", "signal", "tidal", "amazonmusic", "onlinestore"]);
export function socUrl(k, v) {
  v = String(v || "").trim(); if (!v) return "";
  if (/^https:\/\//i.test(v)) { try { const u = new URL(v); return u.protocol === "https:" ? u.href : ""; } catch (_) { return ""; } }
  if (SOC_LINK_ONLY.has(k)) return "";
  if (k === "whatsapp") { const d = v.replace(/\D/g, ""); return d.length >= 10 ? SOC_BASE.whatsapp + (d.length === 10 ? "1" + d : d) : ""; }
  v = v.replace(/^(https?:\/\/)?(www\.)?[a-z.]*\.(com|me|app)\/(add\/|@)?/i, "").replace(/^[@$]/, "").replace(/[^\w.\-]/g, "");
  return v ? (SOC_BASE[k].includes("{v}") ? SOC_BASE[k].replace("{v}", v) : SOC_BASE[k] + v) : "";
}
const SOC_NAMES = { facebook: "Facebook", snapchat: "Snapchat", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", whatsapp: "WhatsApp", cashapp: "Cash App", threads: "Threads", linkedin: "LinkedIn", spotify: "Spotify", soundcloud: "SoundCloud", applemusic: "Apple Music", twitch: "Twitch", kick: "Kick", discord: "Discord", telegram: "Telegram", pinterest: "Pinterest", reddit: "Reddit", venmo: "Venmo", paypal: "PayPal", linktree: "Linktree", patreon: "Patreon", bluesky: "Bluesky", tumblr: "Tumblr", vimeo: "Vimeo", rumble: "Rumble", lemon8: "Lemon8", triller: "Triller", audiomack: "Audiomack", bandcamp: "Bandcamp", substack: "Substack", medium: "Medium", etsy: "Etsy", depop: "Depop", poshmark: "Poshmark", truthsocial: "Truth Social", mastodon: "Mastodon", signal: "Signal", tidal: "Tidal", amazonmusic: "Amazon Music", clubhouse: "Clubhouse", bereal: "BeReal", messenger: "Facebook Messenger", onlinestore: "Your online store", other: "Link" };

let cur = null;
export function destroy() { if (cur) { cur.teardown(); cur = null; } }

export async function render(root, ctx) {
  const S = createSocial(ctx);
  const me = S.me();
  const state = { tab: "friends", q: "", emailQ: "", emailHits: null, posts: null, timer: null };

  root.innerHTML = `
  <div class="section-head"><div><p class="kicker">Real people only</p><h2>Friends</h2></div>
  <p class="muted">Add people you know. When you both add each other, you're friends — and you'll see each other first in the Book.</p></div>
  <div id="fr-root"><p class="muted">Loading your people…</p></div>`;
  const frRoot = $("#fr-root", root);

  await S.loadMembers();
  await S.loadLists();

  const mine = () => new Set(S.friends[me] || []);
  const pending = () => { const f = new Set(S.friendIds()); return [...mine()].filter((id) => !f.has(id) && S.members[id]); };

  function card(id, acts) {
    const m = S.members[id] || {};
    return `<div class="fr-card"><span>${S.avatarOf(id)}</span><span><b>${esc(m.handle || "Member")}</b><small>${esc(m.bio || "Member")}</small>${/^https?:\/\/[^\s"<>]+$/i.test(m.website || "") ? `<small><a href="${esc(m.website)}" target="_blank" rel="noopener nofollow ugc">🌐 ${esc(String(m.website).replace(/^https?:\/\/(www\.)?/i, "").slice(0, 40))}</a></small>` : ""}${m.socials ? `<small class="fr-soc">${Object.entries(m.socials).slice(0, 12).map(([k, x]) => { const u = socUrl(k, x); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener nofollow ugc">${esc(SOC_NAMES[k] || k)}</a>` : ""; }).join(" · ")}</small>` : ""}${m.phonePublic && m.phone ? `<small><a href="tel:${esc(String(m.phone).replace(/[^\d+]/g, ""))}">📞 ${esc(m.phone)}</a></small>` : ""}</span><div class="acts">${acts}</div></div>`;
  }
  const dmBtn = (id, cls) => `<button class="${cls || "btn sm"}" type="button" data-dm="${esc(id)}">Message</button>`;

  function paint() {
    if (!me) { frRoot.innerHTML = `<div class="empty"><h3>Sign in to add friends</h3><a class="btn" href="/" style="margin-top:12px">Join free</a></div>`; return; }
    const fr = S.friendIds(), rq = S.friendRequests(), pd = pending(), m = mine();
    const tabs = `<div class="fr-tabs">${[["friends", "My friends", fr.length], ["requests", "Requests", rq.length], ["find", "Find people", 0], ["feed", "Friends' posts", 0]].map(([k, n, c]) => `<button class="chip" type="button" data-ftab="${k}" aria-pressed="${state.tab === k}">${n}${k === "requests" && c ? `<span class="fr-badge">${c}</span>` : k === "friends" ? ` (${c})` : ""}</button>`).join("")}</div>`;
    let body = "";
    if (state.tab === "friends") body = fr.length ? `<div class="fr-grid">${fr.map((id) => card(id, `${dmBtn(id)}<button class="btn ghost sm" type="button" data-walkie="${esc(id)}" title="Hold 📻 in the chat to talk">📻 Walkie</button><button class="act" type="button" data-unf="${esc(id)}">Unfriend</button>`)).join("")}</div>` : `<div class="empty"><h3>No friends yet</h3><p>Tap Find people to add some. Friends can walkie-talkie each other: open a chat and hold 📻 to talk.</p></div>`;
    if (state.tab === "requests") body = (rq.length ? `<h3 class="sub-h">Friend requests</h3><div class="fr-grid">${rq.map((id) => card(id, `<button class="btn sm" type="button" data-acc="${esc(id)}">Accept</button><button class="act" type="button" data-ign="${esc(id)}">Ignore</button>`)).join("")}</div>` : `<div class="empty"><h3>No new requests</h3></div>`) + (pd.length ? `<h3 class="sub-h" style="margin-top:20px">Requests you sent</h3><div class="fr-grid">${pd.map((id) => card(id, `<span class="muted" style="font-size:13px">Waiting...</span><button class="act" type="button" data-unf="${esc(id)}">Cancel</button>`)).join("")}</div>` : "");
    if (state.tab === "find") {
      const q = state.q, byEmail = isEmail(q);
      if (byEmail && state.emailQ !== q) { state.emailQ = q; state.emailHits = null; emailHash(q).then((h) => { if (state.emailQ === q) { state.emailHits = Object.keys(S.members).filter((id) => S.members[id] && S.members[id].emailHash === h); paint(); } }); }
      const all = Object.entries(S.members).filter(([id, x]) => id !== me && x && x.handle && (byEmail ? (state.emailHits || []).includes(id) : (!q || String(x.handle).toLowerCase().includes(q) || String(x.bio || "").toLowerCase().includes(q)))).slice(0, 60);
      body = `<form class="fr-search" id="fr-sf"><input type="search" id="fr-q" placeholder="Search by name, what they do, or their email" value="${esc(q)}" aria-label="Search members"><button class="btn sm" type="submit">Search</button></form><div class="fr-grid" style="margin-top:12px">${all.map(([id]) => card(id, S.friendStatus(id) === "friends" ? `<span class="muted" style="font-size:13px">✓ Friends</span>${dmBtn(id, "btn ghost sm")}` : m.has(id) ? `<span class="muted" style="font-size:13px">Request sent</span>` : S.friendStatus(id) === "request" ? `<button class="btn sm" type="button" data-acc="${esc(id)}">Accept request</button>` : `<button class="btn sm" type="button" data-add="${esc(id)}">＋ Add friend</button>`)).join("") || '<p class="muted">Nobody found.</p>'}</div>`;
    }
    if (state.tab === "feed") {
      const ids = new Set(fr);
      const ps = (state.posts || []).filter((p) => ids.has(p.authorId)).slice(0, 40);
      body = ps.length ? `<div class="fr-feed">${ps.map((p) => `<article class="post"><div class="post-head">${S.avatarOf(p.authorId)}<div class="who"><b>${esc(S.handleOf(p.authorId))}</b><small>${ago(p.createdAt)}</small></div></div>${p.text ? `<p class="post-text">${esc(p.text)}</p>` : ""}${/^(https:|data:image\/)/.test(p.photo || "") ? `<img class="photo" src="${esc(p.photo)}" alt="" loading="lazy">` : ""}${/^https:\/\//.test(p.video || "") ? `<video class="vid" src="${esc(p.video)}#t=0.1" controls playsinline preload="metadata"></video>` : ""}${/^https:\/\//.test(p.audio || "") ? `<audio src="${esc(p.audio)}" controls preload="none" style="width:100%"></audio>` : ""}</article>`).join("")}</div>` : `<div class="empty"><h3>Nothing from friends yet</h3><p>When your friends post, it shows up here.</p></div>`;
    }
    const keepFocus = document.activeElement && document.activeElement.id === "fr-q";
    frRoot.innerHTML = tabs + body;
    if (keepFocus) { const i = $("#fr-q", frRoot); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }

  async function loadFeedPosts() {
    if (state.posts) return;
    state.posts = await S.docs("posts", { field: "createdAt", limit: 100 });
    if (state.tab === "feed") paint();
  }

  frRoot.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.ftab) { state.tab = b.dataset.ftab; paint(); if (state.tab === "feed") loadFeedPosts(); return; }
    if (b.dataset.dm) { try { sessionStorage.setItem("mw2-dm-target", b.dataset.dm); } catch (_) {} location.hash = "#messages"; return; }
    if (b.dataset.walkie) { try { sessionStorage.setItem("mw2-dm-target", b.dataset.walkie); sessionStorage.setItem("mw2-dm-walkie", "1"); } catch (_) {} location.hash = "#messages"; return; }
    if ((b.dataset.add || b.dataset.acc) && !S.needMember()) return;
    if (!(b.dataset.add || b.dataset.acc || b.dataset.unf)) { if (b.dataset.ign) { const c = b.closest(".fr-card"); if (c) c.remove(); } return; }
    await S.ensureList("friends");
    const m = mine();
    if (b.dataset.add) { m.add(b.dataset.add); await S.setList("friends", [...m]); say("Friend request sent to " + S.handleOf(b.dataset.add)); paint(); }
    if (b.dataset.acc) { m.add(b.dataset.acc); await S.setList("friends", [...m]); say("You and " + S.handleOf(b.dataset.acc) + " are friends now!"); paint(); }
    if (b.dataset.unf) { if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Tap again"; return; } m.delete(b.dataset.unf); await S.setList("friends", [...m]); paint(); }
  });
  frRoot.addEventListener("submit", (e) => { if (e.target.id === "fr-sf") { e.preventDefault(); state.q = $("#fr-q", frRoot).value.trim().toLowerCase(); paint(); } });
  frRoot.addEventListener("input", (e) => { if (e.target.id === "fr-q") { state.q = e.target.value.trim().toLowerCase(); clearTimeout(state.timer); state.timer = setTimeout(paint, 250); } });

  paint();
  S.bus.watch(["friends", "follows", "members"], async () => { await S.loadMembers(); await S.loadLists(); paint(); });

  cur = { teardown() { clearTimeout(state.timer); S.destroy(); } };
}
