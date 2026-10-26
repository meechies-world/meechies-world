/* Members: tap "👥 members" (top bar) for the member directory, "● online now" for who's on,
 * or any member's picture or name for their profile card (Message, Follow, their stores). */
(function () {
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const all = () => (typeof members !== "undefined" && members) || {};
  const ME = () => (typeof me !== "undefined" && me) || null;
  const online = () => window.MW_ONLINE instanceof Set ? window.MW_ONLINE : new Set();
  const pic = (m) => { const p = m && m.photo; return /^https:\/\//.test(p || "") || /^data:image\/(png|jpe?g|webp);base64,/.test(p || "") ? p : ""; };
  const ini = (s) => (String(s || "?").trim()[0] || "?").toUpperCase();
  const url = (u) => (/^https:\/\//.test(u || "") ? u : "");
  const joined = (t) => (t ? new Date(t).toLocaleDateString([], { month: "long", year: "numeric" }) : "");

  const css = document.createElement("style");
  css.textContent = `
#mw-stats span{cursor:pointer;border-radius:999px;padding:2px 8px;transition:background .15s}#mw-stats span:hover{background:rgba(212,168,67,.12)}
#pp-sheet{position:fixed;inset:0;z-index:10040;background:rgba(0,0,0,.65);display:grid;place-items:end center}
#pp-sheet .in{width:min(560px,100%);max-height:88vh;overflow:auto;background:#12100c;border:1px solid var(--gold-lo,#8c6d26);border-radius:20px 20px 0 0;padding:16px 16px 28px}
@media (min-width:700px){#pp-sheet{place-items:center}#pp-sheet .in{border-radius:20px}}
#pp-sheet .top{display:flex;align-items:center;gap:10px;margin-bottom:10px}#pp-sheet .top h3{margin:0;font-size:20px;flex:1}
#pp-sheet .x{background:none;border:0;color:var(--muted);font-size:26px;cursor:pointer;line-height:1}
#pp-sheet .tabs{display:flex;gap:6px;margin-bottom:10px}#pp-sheet .tabs button{font:700 13px var(--body);padding:7px 13px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--text);cursor:pointer}#pp-sheet .tabs button.on{background:var(--gold);color:#0b0a08;border-color:var(--gold)}
#pp-sheet input[type=search]{width:100%;font:15px var(--body);padding:10px 14px;border-radius:999px;border:1px solid var(--line);background:#0b0a08;color:var(--text);margin-bottom:10px}
.pp-row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:none;border:0;border-radius:12px;padding:8px;color:var(--text);cursor:pointer;font:inherit}
.pp-row:hover{background:#1d1a14}.pp-row .t{flex:1;min-width:0;display:grid}.pp-row .t b,.pp-row .t small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pp-row .t small{color:var(--muted)}
.pp-av{position:relative;flex:none;width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#3a2c14,#1d1810);border:1px solid var(--gold-lo,#8c6d26);overflow:visible}
.pp-av img{width:100%;height:100%;border-radius:50%;object-fit:cover}.pp-av b{color:var(--gold-hi);font:800 18px var(--body)}
.pp-av .on{position:absolute;right:-1px;bottom:-1px;width:13px;height:13px;border-radius:50%;background:#31d158;border:2.5px solid #12100c}
.pp-av.xl{width:110px;height:110px}.pp-av.xl b{font-size:42px}.pp-av.xl .on{width:20px;height:20px;border-width:3px;right:4px;bottom:4px}
.pp-card{display:grid;justify-items:center;gap:8px;text-align:center;padding:6px 0 4px}
.pp-card h3{margin:4px 0 0;font-size:24px}.pp-card .muted{margin:0}
.pp-badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}.pp-badges span{font:700 12px var(--body);border:1px solid var(--line);border-radius:999px;padding:4px 10px}
.pp-acts{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px}
.pp-stores{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}.pp-stores a{font:600 13px var(--body);color:var(--gold-hi)}
.avatar[data-uid],[data-profile]{cursor:pointer}`;
  document.head.appendChild(css);

  function av(id, cls = "") { const m = all()[id] || {}, p = pic(m); return `<span class="pp-av ${cls}">${p ? `<img src="${E(p)}" alt="">` : `<b>${E(ini(m.handle))}</b>`}${online().has(id) ? '<i class="on" title="Online now"></i>' : ""}</span>`; }
  function sheet(html) { close(); const s = document.createElement("div"); s.id = "pp-sheet"; s.innerHTML = `<div class="in" role="dialog" aria-modal="true">${html}</div>`; document.body.appendChild(s); s.addEventListener("click", (e) => { if (e.target === s || e.target.closest(".x")) close(); }); return s; }
  function close() { document.getElementById("pp-sheet")?.remove(); }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  /* ---------- the member directory ---------- */
  function directory(tab = "all") {
    const s = sheet(`<div class="top"><h3>👥 Members</h3><button class="x" type="button" aria-label="Close">×</button></div>
      <div class="tabs"><button type="button" data-tab="all">Everyone</button><button type="button" data-tab="online">● Online now</button><button type="button" data-tab="new">Newest</button></div>
      <input type="search" placeholder="Search members" aria-label="Search members"><div class="list"></div>`);
    let q = "";
    const paint = () => {
      s.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
      const on = online(); let ids = Object.keys(all()).filter((id) => all()[id] && all()[id].handle);
      if (tab === "online") ids = ids.filter((id) => on.has(id));
      if (q) ids = ids.filter((id) => (all()[id].handle + " " + (all()[id].bio || "")).toLowerCase().includes(q));
      ids.sort((a, b) => tab === "new" ? (all()[b].joinedAt || 0) - (all()[a].joinedAt || 0) : (on.has(b) - on.has(a)) || (all()[b].joinedAt || 0) - (all()[a].joinedAt || 0));
      s.querySelector(".list").innerHTML = ids.length ? ids.slice(0, 300).map((id) => `<button type="button" class="pp-row" data-profile="${E(id)}">${av(id)}<span class="t"><b>${E(all()[id].handle)}${id === ME() ? " (you)" : ""}</b><small>${E(all()[id].bio || (on.has(id) ? "Online now" : "Member"))}</small></span></button>`).join("")
        : `<p class="muted" style="text-align:center;margin:20px 0">${tab === "online" ? "Nobody else is online right now." : "No members found."}</p>`;
    };
    s.querySelector("input").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); paint(); });
    s.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; paint(); } });
    paint();
  }

  /* ---------- a member's profile card ---------- */
  function profile(id) {
    const m = all()[id]; if (!m) return;
    const mine = id === ME(), on = online().has(id);
    const fol = typeof window.MW_FOLLOWERS === "function" ? window.MW_FOLLOWERS(id) : 0;
    const stores = [["Printify store", m.printify], ["Shopify store", m.shopify], ["Store", m.store || m.other]].filter(([, u]) => url(u));
    sheet(`<div class="top"><h3></h3><button class="x" type="button" aria-label="Close">×</button></div>
      <div class="pp-card">${av(id, "xl")}<h3>${E(m.handle)}</h3>${m.bio ? `<p class="muted">${E(m.bio)}</p>` : ""}
        <div class="pp-badges">${on ? '<span style="color:#31d158;border-color:#2f7d4a">● Online now</span>' : ""}${m.ageVerified ? "<span>✅ Age verified</span>" : ""}${m.idVerified ? "<span>🪪 ID verified</span>" : ""}<span>❤️ ${fol} follower${fol === 1 ? "" : "s"}</span>${m.joinedAt ? `<span>Joined ${E(joined(m.joinedAt))}</span>` : ""}</div>
        ${stores.length ? `<div class="pp-stores">${stores.map(([n, u]) => `<a href="${E(url(u))}" target="_blank" rel="noopener nofollow">🛍️ ${E(n)}</a>`).join("")}</div>` : ""}
        <div class="pp-acts">${mine ? `<button class="btn" type="button" data-pp-edit>Edit my profile</button>` : `<button class="btn" type="button" data-dm="${E(id)}">💬 Message</button><button class="btn ghost" type="button" data-follow="${E(id)}">＋ Follow</button>`}</div>
        <button class="act" type="button" data-pp-all style="margin-top:8px">See all members</button></div>`);
    try { document.querySelectorAll("#pp-sheet [data-follow]").forEach((b) => { const f = window.MW_FOLLOWING && window.MW_FOLLOWING.has(id); b.textContent = f ? "Following" : "＋ Follow"; b.classList.toggle("on", !!f); }); } catch (_) {}
  }
  window.MW_PROFILE = profile;
  window.MW_showOnline = () => directory("online");

  document.addEventListener("click", (e) => {
    const st = e.target.closest("#mw-stats span");
    if (st) { const t = st.textContent; if (/members/.test(t)) { directory("all"); return; } if (/online/.test(t)) { directory("online"); return; } }
    const pr = e.target.closest("[data-profile]"); if (pr) { e.preventDefault(); profile(pr.dataset.profile); return; }
    if (e.target.closest("[data-pp-all]")) { directory("all"); return; }
    if (e.target.closest("[data-pp-edit]")) { close(); const b = document.querySelector('[data-edit-profile], #edit-profile, #me-edit'); if (b) b.click(); else if (typeof go === "function") go("community"); return; }
    if (e.target.closest("#pp-sheet [data-dm]")) { setTimeout(close, 0); return; } // Messenger opens the chat
    // a member's picture anywhere on the site (not inside another button or link)
    const a = e.target.closest(".avatar[data-uid]");
    if (a && !a.closest("button,a,#pp-sheet")) { e.preventDefault(); profile(a.dataset.uid); return; }
    // the member list on Home: tap a row
    const row = e.target.closest("#members > div");
    if (row && !e.target.closest("button,a")) { const u = row.querySelector(".avatar[data-uid]"); if (u) profile(u.dataset.uid); }
  });
})();
