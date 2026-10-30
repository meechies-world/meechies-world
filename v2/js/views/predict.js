/* ============================================================================
   v2 PREDICTIONS VIEW (Phase 5) — the live js/predict.js, ported: a
   free points game. Questions live in the predict collection (only
   the owner's show — the site/owners doc decides), picks in picks.
   Everyone starts with 1,000 points; winners split the pot by stake;
   cancelled questions and no-winner results refund. The balance math
   is the live file's, exported pure for the harness.
   ============================================================================ */

import { MARKUP } from "./predict-markup.js";
import { firestore, esc as E } from "../platform.js";
import { toast as say } from "../commerce.js";

export const PREDICT_START = 1000;
export function predictBalance(qs, picks, uid, START = PREDICT_START) {
  const onOpt = (q, i) => picks.filter((p) => p.q === q.id && p.opt === i).reduce((n, p) => n + p.pts, 0);
  const pot = (q) => picks.filter((p) => p.q === q.id).reduce((n, p) => n + p.pts, 0);
  let b = START;
  for (const p of picks.filter((x) => x.authorId === uid)) {
    b -= p.pts; const q = qs.find((x) => x.id === p.q); if (!q || q.resolved == null) continue;
    if (q.resolved === -1) { b += p.pts; continue; }
    const win = onOpt(q, q.resolved); if (!win) { b += p.pts; continue; }
    if (p.opt === q.resolved) b += Math.floor(p.pts / win * pot(q));
  }
  return b;
}

let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const db = firestore(ctx);
  const ME = () => db.base.me();
  const OWNER = () => db.base.isOwner();
  const names = {};
  const HANDLE = (id) => names[id] || "Member";
  db.base.listDocs("members", { limit: 200 }).then((rows) => { rows.forEach((m) => { names[m.id] = m.handle || m.name || "Member"; }); paint(); }).catch(() => {});
  let qs = [], picks = [], owners = new Set(), tab = "open";
  const box = root.querySelector("#pr-root");
  const official = (q) => owners.has(q.authorId);
  const pot = (q) => picks.filter((p) => p.q === q.id).reduce((n, p) => n + p.pts, 0);
  const onOpt = (q, i) => picks.filter((p) => p.q === q.id && p.opt === i).reduce((n, p) => n + p.pts, 0);
  const balance = (uid) => predictBalance(qs, picks, uid);
  const typing = () => { const f = box.querySelector("#pr-new"); return !!(f && f.contains(document.activeElement)); };

  function paint() {
    if (!box) return;
    if (!ME()) { box.innerHTML = `<div class="empty"><h3>Sign in to play Predictions</h3><p style="margin-top:12px">Join free from the gate or the Join button, then come back and make your picks.</p></div>`; return; }
    const list = qs.filter(official).filter((q) => tab === "open" ? q.resolved == null : q.resolved != null).sort((a, b) => tab === "open" ? (a.closesAt || 9e15) - (b.closesAt || 9e15) : (b.createdAt || 0) - (a.createdAt || 0));
    const players = [...new Set(picks.map((p) => p.authorId))].map((id) => [id, balance(id)]).sort((a, b) => b[1] - a[1]).slice(0, 15);
    box.innerHTML = `<div class="pr-me"><span>Your points<br><b>${balance(ME()).toLocaleString()}</b></span><span class="muted" style="flex:1;min-width:200px">Free game. Everyone starts with ${PREDICT_START.toLocaleString()} points. Pick right and you win a share of the pot. Points can't be bought or cashed out.</span></div>
      ${OWNER() ? `<form class="pr-new" id="pr-new"><b>Owner: ask a new question</b><input id="pr-q" maxlength="140" required placeholder="e.g. Who wins Sunday: Steelers or Ravens?"><input id="pr-o" maxlength="200" required placeholder="Answers, separated by commas (e.g. Steelers, Ravens)"><label class="muted" style="font-size:13px">Picks close at <input type="datetime-local" id="pr-c" style="width:auto"></label><button class="btn" type="submit">Post question</button></form>` : ""}
      <div class="lv-chips"><button class="chip" type="button" data-ptab="open" aria-pressed="${tab === "open"}">🔮 Open</button><button class="chip" type="button" data-ptab="done" aria-pressed="${tab === "done"}">✅ Results</button></div>
      ${list.map((q) => { const P = pot(q), closed = q.resolved != null || (q.closesAt && Date.now() > q.closesAt), mine = picks.find((p) => p.q === q.id && p.authorId === ME());
        return `<div class="pr-q"><h3>${E(q.q)}</h3><small class="muted">Pot: ${P.toLocaleString()} points${q.closesAt ? " · " + (closed ? "closed" : "closes " + new Date(q.closesAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })) : ""}${mine ? ` · you picked <b>${E(q.options[mine.opt])}</b> (${mine.pts} pts)` : ""}</small>
        <div class="pr-opts">${(q.options || []).map((o, i) => { const v = onOpt(q, i), pct = P ? Math.round(v / P * 100) : 0; return `<button class="pr-opt ${mine && mine.opt === i ? "mine" : ""} ${q.resolved === i ? "win" : ""}" type="button" data-pick="${E(q.id)}" data-opt="${i}" ${closed || mine ? "disabled" : ""}><i style="width:${pct}%"></i><span>${q.resolved === i ? "🏆 " : ""}${E(o)}</span><span>${pct}%</span></button>`; }).join("")}</div>
        ${OWNER() && q.resolved == null ? `<div style="display:flex;gap:6px;flex-wrap:wrap"><small class="muted" style="align-self:center">Owner: mark the result →</small>${(q.options || []).map((o, i) => `<button class="act" type="button" data-res="${E(q.id)}" data-opt="${i}">${E(o)} won</button>`).join("")}<button class="act" type="button" data-res="${E(q.id)}" data-opt="-1">Cancel (refund)</button></div>` : ""}</div>`; }).join("") || `<div class="empty"><h3>${tab === "open" ? "No open questions right now" : "No results yet"}</h3><p>Meechie posts new ones for games and events. Check back soon.</p></div>`}
      <h3 class="sub-h" style="margin:8px 0 0">🏆 Leaderboard</h3><div class="pr-lb">${players.map(([id, b], i) => `<div><b style="width:28px;color:var(--gold-hi)">#${i + 1}</b><span style="flex:1">${E(HANDLE(id))}</span><b>${b.toLocaleString()}</b></div>`).join("") || '<p class="muted">Make a pick to get on the board.</p>'}</div>`;
  }
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.ptab) { tab = b.dataset.ptab; paint(); return; }
    if (b.dataset.pick) {
      if (!ME()) { say("Join free to play."); return; }
      const q = qs.find((x) => x.id === b.dataset.pick), bal = balance(ME());
      if (bal <= 0) { say("You're out of points. They come back when your other picks win."); return; }
      const amt = Math.floor(+prompt(`How many points on "${q.options[+b.dataset.opt]}"? You have ${bal}.`, String(Math.min(100, bal))));
      if (!(amt > 0) || amt > bal) { if (amt > bal) say("You only have " + bal + " points."); return; }
      await db.collection("picks").add({ authorId: ME(), q: q.id, opt: +b.dataset.opt, pts: amt, createdAt: Date.now() }).then(() => say("Pick locked in!"), (er) => say(er.message || er.code));
      return;
    }
    if (b.dataset.res) { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Tap again to confirm"; return; } await db.doc("predict/" + b.dataset.res).update({ resolved: +b.dataset.opt }).then(() => say("Result posted. Points paid out."), (er) => say(er.message || er.code)); }
  });
  box.addEventListener("submit", async (e) => {
    if (e.target.id !== "pr-new") return; e.preventDefault();
    const opts = box.querySelector("#pr-o").value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
    if (opts.length < 2) { say("Give at least two answers, separated by commas."); return; }
    const c = box.querySelector("#pr-c").value;
    await db.collection("predict").add({ authorId: ME(), q: box.querySelector("#pr-q").value.trim().slice(0, 140), options: opts, closesAt: c ? new Date(c).getTime() : null, resolved: null, createdAt: Date.now() }).then(() => { say("Question posted"); if (document.activeElement) document.activeElement.blur(); paint(); }, (er) => say(er.message || er.code));
  });
  const unsubs = [
    db.doc("site/owners").onSnapshot((s) => { owners = new Set((s.exists && s.data().ids) || []); if (OWNER() && ME() && !owners.has(ME())) db.doc("site/owners").set({ ids: [...owners, ME()] }).catch(() => {}); if (!typing()) paint(); }),
    db.collection("predict").orderBy("createdAt", "desc").limit(100).onSnapshot((s) => { qs = s.docs.map((x) => ({ id: x.id, ...x.data() })); if (!typing()) paint(); }, () => {}),
    db.collection("picks").limit(5000).onSnapshot((s) => { const seen = new Set(); picks = s.docs.map((x) => x.data()).filter((p) => Number.isFinite(p.pts) && p.pts > 0 && p.pts <= 100000).filter((p) => { const k = p.authorId + "|" + p.q; if (seen.has(k)) return false; seen.add(k); return true; }); if (!typing()) paint(); }, () => {}),
  ];
  paint();
  cleanup.push(() => { unsubs.forEach((u) => { if (typeof u === "function") u(); }); db.base.stop(); });
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
