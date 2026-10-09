/* Friends: send and accept friend requests, see your friends, message them, and a friends-only feed.
 * Each member keeps one doc friends/<their id> = { list: [ids they added or accepted] }.
 * Two people are friends when each one is on the other's list. */
(function () {
  "use strict";
  const view = document.getElementById("v-friends");
  if (!view) return;
  const root = view.querySelector("#fr-root");
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  const MEM = () => (typeof members !== "undefined" ? members : {});
  const HANDLE = (id) => (typeof handleOf === "function" ? handleOf(id) : "Member");
  const AV = (id) => (typeof avatarOf === "function" ? avatarOf(id) : "");
  let lists = {}, q = "", tab = "friends";

  const css = document.createElement("style");
  css.textContent = `
#fr-root{display:grid;gap:16px}
.fr-tabs{display:flex;gap:8px;flex-wrap:wrap}
.fr-search{display:flex;gap:8px}.fr-search input{flex:1;min-width:0;background:var(--ink);border:1px solid var(--line);border-radius:12px;padding:12px;color:var(--text);font:16px var(--body)}
.fr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.fr-card{display:grid;grid-template-columns:48px minmax(0,1fr);gap:10px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,#17130c,#0f0d09)}
.fr-card .avatar{width:48px;height:48px;font-size:18px}
.fr-card b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fr-card small{color:var(--muted);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fr-card .acts{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap}
.fr-badge{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#e5484d;color:#fff;font:800 11px var(--body);margin-left:6px}
.fr-feed{display:grid;gap:12px}`;
  document.head.appendChild(css);

  const mine = () => new Set(lists[ME()] || []);
  const theyAdded = (id) => (lists[id] || []).includes(ME());
  const friendsOf = () => { const m = mine(); return [...m].filter((id) => theyAdded(id) && MEM()[id]); };
  const requests = () => Object.keys(lists).filter((id) => id !== ME() && (lists[id] || []).includes(ME()) && !mine().has(id) && MEM()[id]);
  const pending = () => [...mine()].filter((id) => !theyAdded(id) && MEM()[id]);
  window.MW_FRIENDS = { isFriend: (id) => mine().has(id) && theyAdded(id), list: friendsOf };

  async function setList(arr) {
    const d = DB(); if (!d || !ME()) return;
    await d.doc("friends/" + ME()).set({ list: [...new Set(arr)].slice(0, 2000) }).catch((e) => say(e.message || e.code));
  }
  function card(id, acts) {
    const m = MEM()[id] || {};
    return `<div class="fr-card">${AV(id)}<span><b>${E(m.handle || "Member")}</b><small>${E(m.bio || "Member")}</small></span><div class="acts">${acts}</div></div>`;
  }
  function render() {
    if (!ME()) { root.innerHTML = `<div class="empty"><h3>Sign in to add friends</h3><button class="btn" type="button" data-auth="signup" style="margin-top:12px">Join free</button></div>`; return; }
    const fr = friendsOf(), rq = requests(), pd = pending(), m = mine();
    const tabs = `<div class="fr-tabs">${[["friends", "My friends", fr.length], ["requests", "Requests", rq.length], ["find", "Find people", 0], ["feed", "Friends' posts", 0]].map(([k, n, c]) => `<button class="chip" type="button" data-ftab="${k}" aria-pressed="${tab === k}">${n}${k === "requests" && c ? `<span class="fr-badge">${c}</span>` : k === "friends" ? ` (${c})` : ""}</button>`).join("")}</div>`;
    let body = "";
    if (tab === "friends") body = fr.length ? `<div class="fr-grid">${fr.map((id) => card(id, `<button class="btn sm" type="button" data-dm="${E(id)}">Message</button><button class="act" type="button" data-unf="${E(id)}">Unfriend</button>`)).join("")}</div>` : `<div class="empty"><h3>No friends yet</h3><p>Tap Find people to add some.</p></div>`;
    if (tab === "requests") body = (rq.length ? `<h3 class="sub-h">Friend requests</h3><div class="fr-grid">${rq.map((id) => card(id, `<button class="btn sm" type="button" data-acc="${E(id)}">Accept</button><button class="act" type="button" data-ign="${E(id)}">Ignore</button>`)).join("")}</div>` : `<div class="empty"><h3>No new requests</h3></div>`) + (pd.length ? `<h3 class="sub-h" style="margin-top:20px">Requests you sent</h3><div class="fr-grid">${pd.map((id) => card(id, `<span class="muted" style="font-size:13px">Waiting...</span><button class="act" type="button" data-unf="${E(id)}">Cancel</button>`)).join("")}</div>` : "");
    if (tab === "find") {
      const all = Object.entries(MEM()).filter(([id, x]) => id !== ME() && x && x.handle && (!q || x.handle.toLowerCase().includes(q) || (x.bio || "").toLowerCase().includes(q))).slice(0, 60);
      body = `<form class="fr-search" id="fr-sf"><input type="search" id="fr-q" placeholder="Search by name or what they do" value="${E(q)}" aria-label="Search members"><button class="btn sm" type="submit">Search</button></form><div class="fr-grid" style="margin-top:12px">${all.map(([id]) => card(id, window.MW_FRIENDS.isFriend(id) ? `<span class="muted" style="font-size:13px">✓ Friends</span><button class="btn ghost sm" type="button" data-dm="${E(id)}">Message</button>` : m.has(id) ? `<span class="muted" style="font-size:13px">Request sent</span>` : theyAdded(id) ? `<button class="btn sm" type="button" data-acc="${E(id)}">Accept request</button>` : `<button class="btn sm" type="button" data-add="${E(id)}">＋ Add friend</button>`)).join("") || '<p class="muted">Nobody found.</p>'}</div>`;
    }
    if (tab === "feed") {
      const ids = new Set(fr); const ps = (typeof posts !== "undefined" ? posts : []).filter((p) => ids.has(p.authorId)).slice(0, 40);
      body = ps.length ? `<div class="fr-feed">${ps.map((p) => `<article class="post"><div class="post-head">${AV(p.authorId)}<div class="who"><b>${E(HANDLE(p.authorId))}</b><small>${typeof ago === "function" ? ago(p.createdAt) : ""}</small></div></div>${p.text ? `<p class="post-text">${E(p.text)}</p>` : ""}${/^(https:|data:image\/)/.test(p.photo || "") ? `<img class="photo" src="${E(p.photo)}" alt="" loading="lazy">` : ""}${/^https:\/\//.test(p.video || "") ? `<video class="vid" src="${E(p.video)}#t=0.1" controls playsinline preload="metadata"></video>` : ""}${/^https:\/\//.test(p.audio || "") ? `<audio src="${E(p.audio)}" controls preload="none" style="width:100%"></audio>` : ""}</article>`).join("")}</div>` : `<div class="empty"><h3>Nothing from friends yet</h3><p>When your friends post, it shows up here.</p></div>`;
    }
    const keepFocus = document.activeElement && document.activeElement.id === "fr-q";
    root.innerHTML = tabs + body;
    if (keepFocus) { const i = root.querySelector("#fr-q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
    const rqN = rq.length; document.querySelectorAll('[data-go="friends"]').forEach((a) => { let b = a.querySelector(".fr-badge"); if (rqN) { if (!b) { b = document.createElement("span"); b.className = "fr-badge"; a.appendChild(b); } b.textContent = rqN; } else b?.remove(); });
  }
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.ftab) { tab = b.dataset.ftab; render(); return; }
    if (typeof needMember === "function" && (b.dataset.add || b.dataset.acc) && !needMember()) return;
    const m = mine();
    if (b.dataset.add) { m.add(b.dataset.add); await setList([...m]); say("Friend request sent to " + HANDLE(b.dataset.add)); }
    if (b.dataset.acc) { m.add(b.dataset.acc); await setList([...m]); say("You and " + HANDLE(b.dataset.acc) + " are friends now!"); }
    if (b.dataset.unf) { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Tap again"; return; } m.delete(b.dataset.unf); await setList([...m]); }
    if (b.dataset.ign) { b.closest(".fr-card").remove(); }
  });
  root.addEventListener("submit", (e) => { if (e.target.id === "fr-sf") { e.preventDefault(); q = root.querySelector("#fr-q").value.trim().toLowerCase(); render(); } });
  root.addEventListener("input", (e) => { if (e.target.id === "fr-q") { q = e.target.value.trim().toLowerCase(); clearTimeout(root._t); root._t = setTimeout(render, 250); } });

  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) { render(); return; }
    d.collection("friends").limit(2000).onSnapshot((s) => { lists = {}; s.docs.forEach((x) => { const v = x.data(); lists[x.id] = Array.isArray(v.list) ? v.list.filter((i) => typeof i === "string") : []; }); render(); }, () => {});
    document.addEventListener("mw-posts", () => { if (tab === "feed" && !view.hidden) render(); });
    new MutationObserver(() => { if (!view.hidden) render(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
    setTimeout(render, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
