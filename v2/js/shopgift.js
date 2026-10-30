/* v2 SHOP GIFTS (Phase 5) — the live js/shop-gift.js, ported:
   🎁 Gift this on Shopify store items (pick the member + size,
   pay in Shopify; the order carries a GIFT MWG- code), and the
   owner's 🎁 Gift orders panel (Paid ✓ messages the recipient
   for their address). Same /api/shop-gift doors, same words.
   Styles live in css/shop.css. */
import { createDb } from "./platform.js";
import { toast } from "./commerce.js";
import { createSocial } from "./social.js";

export function createShopGifts(ctx) {
  const db = createDb(ctx);
  const soc = createSocial(ctx);
  let membersMap = {}, products = [];
  const friendsSet = new Set();
  const avatarOf = (id) => soc.avatarOf(id);
  db.listDocs("members", { limit: 200 }).then((rows) => { rows.forEach((m) => { membersMap[m.id] = m; }); }).catch(() => {});
  soc.loadLists().then(() => { try { (soc.friends[soc.me()] || []).forEach((id) => friendsSet.add(id)); soc.friendIds().forEach((id) => friendsSet.add(id)); } catch (_) {} }).catch(() => {});

  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = toast;
  const tok = () => { try { const s = ctx.session.get(); return (s && s.access_token) || ""; } catch (_) { return ""; } };
  const api = (path, body) => fetch("/api/shop-gift/" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }));
  const MEM = () => membersMap;
  const ME = () => db.base.me();
  const OWNER = () => db.base.isOwner();

  

  let cur = null, pick = null;
  function decorate(grid, ps) {
    products = ps || products; if (!grid) return;
    grid.querySelectorAll(":scope > .prod").forEach((a, i) => {
      const p = ps[i]; if (!p || !(p.variants || []).length) return;
      const w = document.createElement("div"); w.className = "prod-wrap"; a.replaceWith(w); w.appendChild(a);
      const b = document.createElement("button"); b.type = "button"; b.className = "sg-btn"; b.dataset.sg = i; b.textContent = "🎁 Gift this to someone"; w.appendChild(b);
    });
    if (OWNER() && !$("#sg-owner-btn")) { const o = document.createElement("button"); o.id = "sg-owner-btn"; o.type = "button"; o.className = "btn ghost"; o.textContent = "🎁 Gift orders (owner)"; o.style.margin = "14px auto 0"; o.style.display = "block"; grid.after(o); }
  }
  function dlg() {
    let d = $("#sg-dlg"); if (d) return d;
    d = document.createElement("dialog"); d.id = "sg-dlg"; document.body.appendChild(d);
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    return d;
  }
  function people(q) {
    q = (q || "").toLowerCase().trim(); const all = MEM(), mine = ME();
    const fr = friendsSet;
    return Object.entries(all).filter(([id, m]) => id !== mine && m && m.handle && (!q || String(m.handle).toLowerCase().includes(q)))
      .sort((a, b) => (fr.has(b[0]) ? 1 : 0) - (fr.has(a[0]) ? 1 : 0)).slice(0, 30);
  }
  function paintPeople(q) {
    const box = $("#sg-list"); if (!box) return;
    const AV = (id) => avatarOf(id);
    const list = people(q);
    box.innerHTML = list.map(([id, m]) => `<button type="button" data-sgto="${E(id)}" aria-pressed="${pick === id}">${AV(id)}${E(m.handle)}</button>`).join("") || `<span class="muted">No one found. Try another name.</span>`;
  }
  function open(i) {
    if (!ME()) { toast("Join free to send a gift."); location.hash = "#community"; return; }
    const p = (products)[i]; if (!p) return; cur = p; pick = null;
    const d = dlg(), vs = p.variants || [];
    d.innerHTML = `<form id="sg-form"><h3 style="margin:0">🎁 Send a gift</h3>
<div class="item">${p.img ? `<img src="${E(p.img)}" alt="">` : ""}<div><b>${E(p.title)}</b><div class="muted">${E(p.price || "")}</div></div></div>
${vs.length > 1 ? `<label>Size / option<select id="sg-v">${vs.map((v) => `<option value="${E(v.id)}">${E(v.title)} · $${E(v.price)}</option>`).join("")}</select></label>` : `<input type="hidden" id="sg-v" value="${E(vs[0].id)}">`}
<label>Who is it for?<input id="sg-q" placeholder="Type their name" autocomplete="off"></label>
<div id="sg-list"></div>
<label>Gift note (optional)<input id="sg-note" maxlength="120" placeholder="Happy birthday! 👑"></label>
<small class="muted">You'll pay in Shopify. ${vs.every((v) => !v.ship) ? "It's a digital item, so Meechie sends it to them." : "Ship it to yourself, or if you don't know their address, Meechie's World messages them privately for it once your order comes in."}</small>
<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost" type="button" data-sgclose>Cancel</button><button class="btn" type="submit">Continue to checkout</button></div></form>`;
    paintPeople(""); if (!d.open) d.showModal(); setTimeout(() => $("#sg-q").focus(), 50);
  }
  async function owner() {
    const d = dlg(); d.innerHTML = `<form method="dialog"><h3 style="margin:0">🎁 Gift orders</h3><p class="muted" style="margin:0">When a gift order shows up as paid in Shopify (its note says GIFT MWG-…), tap <b>Paid ✓</b>. We message the person it's for to get their address, and thank the buyer.</p><div id="sg-own"><span class="muted">Loading…</span></div><div style="display:flex;justify-content:flex-end"><button class="btn ghost" type="button" data-sgclose>Close</button></div></form>`;
    if (!d.open) d.showModal();
    const r = await api("admin"); const box = $("#sg-own"); if (!r.ok) { box.innerHTML = "Couldn't load."; return; }
    const gs = r.j.gifts || [];
    box.innerHTML = gs.length ? gs.map((g) => `<div class="g"><span><b>${E(g.code)}</b> · ${E(g.product)}${g.variant_title && g.variant_title !== "Default Title" ? " (" + E(g.variant_title) + ")" : ""}<br><small class="muted">${E(g.buyer_name || "Member")} → ${E(g.to_name || "Member")} · ${new Date(g.at).toLocaleString()} · ${E(g.status)}</small></span>${g.status === "started" ? `<span style="display:flex;gap:6px"><button class="btn sm" type="button" data-sgpaid="${g.id}">Paid ✓</button><button class="btn sm ghost" type="button" data-sgcancel="${g.id}">Not paid</button></span>` : ""}</div>`).join("") : `<span class="muted">No gift orders yet.</span>`;
  }
  const onDocClick = async (e) => {
    const t = e.target.closest("[data-sg],[data-sgto],[data-sgclose],#sg-owner-btn,[data-sgpaid],[data-sgcancel]"); if (!t) return;
    if (t.dataset.sg !== undefined) { e.preventDefault(); open(+t.dataset.sg); }
    else if (t.dataset.sgto) { pick = t.dataset.sgto; paintPeople($("#sg-q").value); }
    else if (t.hasAttribute("data-sgclose")) $("#sg-dlg").close();
    else if (t.id === "sg-owner-btn") owner();
    else if (t.dataset.sgpaid || t.dataset.sgcancel) { const paid = !!t.dataset.sgpaid; if (!t.dataset.sure) { t.dataset.sure = 1; t.textContent = "Tap again"; return; } const r = await api(paid ? "admin/paid" : "admin/cancel", { id: +(t.dataset.sgpaid || t.dataset.sgcancel) }); say(r.ok ? (paid ? "Done. They've been messaged." : "Marked not paid.") : r.j.error || "Couldn't update."); owner(); }
  };
  const onDocInput = (e) => { if (e.target.id === "sg-q") paintPeople(e.target.value); };
  const onDocSubmit = async (e) => {
    if (e.target.id !== "sg-form") return; e.preventDefault();
    if (!pick) { say("Pick who the gift is for."); return; }
    // open the checkout tab right away (phones block pop-ups that open after waiting)
    const w = window.open("about:blank", "_blank");
    const r = await api("start", { to: pick, variantId: $("#sg-v").value, note: $("#sg-note").value.trim() });
    if (!r.ok || !/^https:\/\/meechiesworldinc\.myshopify\.com\/cart\//.test(r.j.checkout || "")) { if (w) w.close(); say(r.j.error || "Couldn't start the gift."); return; }
    if (w) w.location.href = r.j.checkout; else location.href = r.j.checkout;
    $("#sg-dlg").close(); say("Checkout opened. Your gift code is " + r.j.code + ".");
  };


  document.addEventListener("click", onDocClick);
  document.addEventListener("input", onDocInput);
  document.addEventListener("submit", onDocSubmit);
  return { decorate, owner, destroy() { document.removeEventListener("click", onDocClick); document.removeEventListener("input", onDocInput); document.removeEventListener("submit", onDocSubmit); try { soc.destroy(); } catch (_) {} db.stop(); } };
}
