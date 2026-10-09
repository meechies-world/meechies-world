/* Predictions: a free game. Meechie posts questions (games, events, anything); members pick an answer using free
 * points (everyone starts with 1,000). When Meechie marks the result, winners split the whole pot by how much they
 * put in. Leaderboard of top players. Points have no cash value and can't be bought or cashed out. */
(function () {
  "use strict";
  const view = document.getElementById("v-predict");
  if (!view) return;
  const root = view.querySelector("#pr-root");
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  const OWNER = () => typeof isOwner !== "undefined" && isOwner;
  const HANDLE = (id) => (typeof handleOf === "function" ? handleOf(id) : "Member");
  const START = 1000;
  let qs = [], picks = [], owners = new Set(), tab = "open";

  const css = document.createElement("style");
  css.textContent = `
#pr-root{display:grid;gap:16px}
.pr-me{display:flex;gap:16px;flex-wrap:wrap;align-items:center;padding:14px 16px;border:1px solid var(--gold-lo);border-radius:16px;background:radial-gradient(ellipse at 0 0,#2a2112,#0f0d09 70%)}
.pr-me b{font-size:26px;color:var(--gold-hi)}
.pr-q{border:1px solid var(--line);border-radius:16px;padding:16px;background:linear-gradient(180deg,#17130c,#0f0d09);display:grid;gap:10px}
.pr-q h3{margin:0;font-size:18px}
.pr-opts{display:grid;gap:8px}
.pr-opt{position:relative;display:flex;justify-content:space-between;gap:8px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:10px 12px;overflow:hidden;background:#0c0a07;color:var(--text);cursor:pointer;font:600 15px var(--body);text-align:left}
.pr-opt i{position:absolute;left:0;top:0;bottom:0;background:rgba(212,168,67,.18);z-index:0}
.pr-opt span{position:relative;z-index:1}.pr-opt.mine{border-color:var(--gold)}.pr-opt.win{border-color:#4ade80;background:#0e1f14}
.pr-lb{display:grid;gap:6px}.pr-lb div{display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:10px}
.pr-new{display:grid;gap:8px;border:1px dashed var(--gold-lo);border-radius:14px;padding:14px}
.pr-new input{width:100%;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text);font:16px var(--body)}`;
  document.head.appendChild(css);

  const official = (q) => owners.has(q.authorId);
  const pot = (q) => picks.filter((p) => p.q === q.id).reduce((n, p) => n + p.pts, 0);
  const onOpt = (q, i) => picks.filter((p) => p.q === q.id && p.opt === i).reduce((n, p) => n + p.pts, 0);
  function balance(uid) {
    let b = START;
    for (const p of picks.filter((x) => x.authorId === uid)) {
      b -= p.pts; const q = qs.find((x) => x.id === p.q); if (!q || q.resolved == null) continue;
      if (q.resolved === -1) { b += p.pts; continue; } // cancelled: refund
      const win = onOpt(q, q.resolved); if (!win) { b += p.pts; continue; } // nobody won: refund
      if (p.opt === q.resolved) b += Math.floor(p.pts / win * pot(q));
    }
    return b;
  }
  function render() {
    if (!ME()) { root.innerHTML = `<div class="empty"><h3>Sign in to play Predictions</h3><button class="btn" type="button" data-auth="signup" style="margin-top:12px">Join free</button></div>`; return; }
    const list = qs.filter(official).filter((q) => tab === "open" ? q.resolved == null : q.resolved != null).sort((a, b) => tab === "open" ? (a.closesAt || 9e15) - (b.closesAt || 9e15) : b.createdAt - a.createdAt);
    const players = [...new Set(picks.map((p) => p.authorId))].map((id) => [id, balance(id)]).sort((a, b) => b[1] - a[1]).slice(0, 15);
    root.innerHTML = `<div class="pr-me"><span>Your points<br><b>${balance(ME()).toLocaleString()}</b></span><span class="muted" style="flex:1;min-width:200px">Free game. Everyone starts with ${START.toLocaleString()} points. Pick right and you win a share of the pot. Points can't be bought or cashed out.</span></div>
      ${OWNER() ? `<form class="pr-new" id="pr-new"><b>Owner: ask a new question</b><input id="pr-q" maxlength="140" required placeholder="e.g. Who wins Sunday: Steelers or Ravens?"><input id="pr-o" maxlength="200" required placeholder="Answers, separated by commas (e.g. Steelers, Ravens)"><label class="muted" style="font-size:13px">Picks close at <input type="datetime-local" id="pr-c" style="width:auto"></label><button class="btn" type="submit">Post question</button></form>` : ""}
      <div class="lv-chips"><button class="chip" type="button" data-ptab="open" aria-pressed="${tab === "open"}">🔮 Open</button><button class="chip" type="button" data-ptab="done" aria-pressed="${tab === "done"}">✅ Results</button></div>
      ${list.map((q) => { const P = pot(q), closed = q.resolved != null || (q.closesAt && Date.now() > q.closesAt), mine = picks.find((p) => p.q === q.id && p.authorId === ME());
        return `<div class="pr-q"><h3>${E(q.q)}</h3><small class="muted">Pot: ${P.toLocaleString()} points${q.closesAt ? " · " + (closed ? "closed" : "closes " + new Date(q.closesAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })) : ""}${mine ? ` · you picked <b>${E(q.options[mine.opt])}</b> (${mine.pts} pts)` : ""}</small>
        <div class="pr-opts">${(q.options || []).map((o, i) => { const v = onOpt(q, i), pct = P ? Math.round(v / P * 100) : 0; return `<button class="pr-opt ${mine && mine.opt === i ? "mine" : ""} ${q.resolved === i ? "win" : ""}" type="button" data-pick="${E(q.id)}" data-opt="${i}" ${closed || mine ? "disabled" : ""}><i style="width:${pct}%"></i><span>${q.resolved === i ? "🏆 " : ""}${E(o)}</span><span>${pct}%</span></button>`; }).join("")}</div>
        ${OWNER() && q.resolved == null ? `<div style="display:flex;gap:6px;flex-wrap:wrap"><small class="muted" style="align-self:center">Owner: mark the result →</small>${(q.options || []).map((o, i) => `<button class="act" type="button" data-res="${E(q.id)}" data-opt="${i}">${E(o)} won</button>`).join("")}<button class="act" type="button" data-res="${E(q.id)}" data-opt="-1">Cancel (refund)</button></div>` : ""}</div>`; }).join("") || `<div class="empty"><h3>${tab === "open" ? "No open questions right now" : "No results yet"}</h3><p>Meechie posts new ones for games and events. Check back soon.</p></div>`}
      <h3 class="sub-h" style="margin:8px 0 0">🏆 Leaderboard</h3><div class="pr-lb">${players.map(([id, b], i) => `<div><b style="width:28px;color:var(--gold-hi)">#${i + 1}</b>${typeof avatarOf === "function" ? avatarOf(id) : ""}<span style="flex:1">${E(HANDLE(id))}</span><b>${b.toLocaleString()}</b></div>`).join("") || '<p class="muted">Make a pick to get on the board.</p>'}</div>`;
  }
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.ptab) { tab = b.dataset.ptab; render(); return; }
    if (b.dataset.pick) {
      if (typeof needMember === "function" && !needMember()) return;
      const q = qs.find((x) => x.id === b.dataset.pick), bal = balance(ME());
      if (bal <= 0) { say("You're out of points. They come back when your other picks win."); return; }
      const amt = Math.floor(+prompt(`How many points on "${q.options[+b.dataset.opt]}"? You have ${bal}.`, String(Math.min(100, bal))));
      if (!(amt > 0) || amt > bal) { if (amt > bal) say("You only have " + bal + " points."); return; }
      await DB().collection("picks").add({ authorId: ME(), q: q.id, opt: +b.dataset.opt, pts: amt, createdAt: Date.now() }).catch((er) => say(er.message || er.code));
      say("Pick locked in!"); return;
    }
    if (b.dataset.res) { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Tap again to confirm"; return; } await DB().doc("predict/" + b.dataset.res).update({ resolved: +b.dataset.opt }).catch((er) => say(er.message || er.code)); say("Result posted. Points paid out."); }
  });
  root.addEventListener("submit", async (e) => {
    if (e.target.id !== "pr-new") return; e.preventDefault();
    const opts = root.querySelector("#pr-o").value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
    if (opts.length < 2) { say("Give at least two answers, separated by commas."); return; }
    const c = root.querySelector("#pr-c").value;
    await DB().collection("predict").add({ authorId: ME(), q: root.querySelector("#pr-q").value.trim().slice(0, 140), options: opts, closesAt: c ? new Date(c).getTime() : null, resolved: null, createdAt: Date.now() }).catch((er) => say(er.message || er.code));
    say("Question posted");
  });
  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) { render(); return; }
    // which accounts are the owner's (so only Meechie's questions show)
    d.doc("site/owners").onSnapshot((s) => { owners = new Set((s.exists && s.data().ids) || []); if (OWNER() && ME() && !owners.has(ME())) d.doc("site/owners").set({ ids: [...owners, ME()] }).catch(() => {}); if (!view.hidden) render(); }, () => {});
    d.collection("predict").orderBy("createdAt", "desc").limit(100).onSnapshot((s) => { qs = s.docs.map((x) => ({ id: x.id, ...x.data() })); if (!view.hidden) render(); }, () => {});
    d.collection("picks").limit(5000).onSnapshot((s) => { const seen = new Set(); picks = s.docs.map((x) => x.data()).filter((p) => Number.isFinite(p.pts) && p.pts > 0 && p.pts <= 100000).filter((p) => { const k = p.authorId + "|" + p.q; if (seen.has(k)) return false; seen.add(k); return true; }); if (!view.hidden) render(); }, () => {});
    new MutationObserver(() => { if (!view.hidden) render(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
