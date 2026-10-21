/* 🎁 Gift a store item to another member (Shop → any store item → "Gift this").
 * Pick the member and size, add a note, then pay in Shopify. The order is marked as a gift with a code.
 * Meechie confirms it under "🎁 Gift orders" and the member gets a private message to send their address.
 * Server: functions/api/shop-gift/[[path]].js */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : alert(t));
  const $ = (s, r = document) => r.querySelector(s);
  const tok = () => { try { return MW.session().access_token; } catch (_) { return ""; } };
  const api = (path, body) => fetch("/api/shop-gift/" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }));
  const MEM = () => { try { return typeof members !== "undefined" ? members : {}; } catch (_) { return {}; } };
  const ME = () => { try { return typeof me !== "undefined" ? me : null; } catch (_) { return null; } };
  const OWNER = () => { try { return typeof isOwner !== "undefined" && !!isOwner; } catch (_) { return false; } };

  const css = document.createElement("style");
  css.textContent = `.prod-wrap{display:grid;gap:8px;align-content:start;min-width:0}
.prod-wrap .sg-btn{border:1px solid var(--gold,#d6aa4a);background:rgba(10,8,5,.7);color:var(--gold-hi,#ffe08a);border-radius:999px;padding:9px 12px;font:800 13px var(--display,serif);letter-spacing:.05em;cursor:pointer}
.prod-wrap .sg-btn:hover{box-shadow:0 0 16px rgba(255,190,70,.3)}
#sg-dlg{width:min(460px,calc(100vw - 24px));max-height:calc(100vh - 32px);overflow:auto;padding:0}
#sg-dlg form{display:grid;gap:12px;padding:20px}
#sg-dlg .item{display:flex;gap:12px;align-items:center}#sg-dlg .item img{width:72px;height:72px;object-fit:cover;border-radius:12px}
#sg-dlg label{display:grid;gap:5px;font-weight:700;font-size:14px}
#sg-dlg input,#sg-dlg select{width:100%;padding:10px;border-radius:10px;font:16px var(--body,system-ui)}
#sg-list{display:grid;gap:4px;max-height:180px;overflow:auto}
#sg-list button{display:flex;gap:8px;align-items:center;text-align:left;border:1px solid #3a3223;background:#0e0c09;color:#fff;border-radius:10px;padding:6px 8px;cursor:pointer;font:600 14px var(--body,system-ui)}
#sg-list button[aria-pressed=true]{border-color:#ffe08a;box-shadow:0 0 0 1px #ffe08a inset}
#sg-list .avatar{width:30px;height:30px;margin:0}
#sg-own{display:grid;gap:8px}#sg-own .g{display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap;border-bottom:1px solid #2a2418;padding:8px 0}`;
  document.head.appendChild(css);

  let cur = null, pick = null;
  function decorate() {
    const grid = $("#shopify-grid"), ps = window.MW_SHOPIFY || []; if (!grid) return;
    grid.querySelectorAll(":scope > a.prod").forEach((a, i) => {
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
    const fr = (() => { try { return new Set(window.MW_FRIENDS && MW_FRIENDS.list ? MW_FRIENDS.list() : []); } catch (_) { return new Set(); } })();
    return Object.entries(all).filter(([id, m]) => id !== mine && m && m.handle && (!q || String(m.handle).toLowerCase().includes(q)))
      .sort((a, b) => (fr.has(b[0]) ? 1 : 0) - (fr.has(a[0]) ? 1 : 0)).slice(0, 30);
  }
  function paintPeople(q) {
    const box = $("#sg-list"); if (!box) return;
    const AV = (id) => { try { return typeof avatarOf === "function" ? avatarOf(id) : ""; } catch (_) { return ""; } };
    const list = people(q);
    box.innerHTML = list.map(([id, m]) => `<button type="button" data-sgto="${E(id)}" aria-pressed="${pick === id}">${AV(id)}${E(m.handle)}</button>`).join("") || `<span class="muted">No one found. Try another name.</span>`;
  }
  function open(i) {
    if (!ME()) { if (typeof openAuth === "function") openAuth("signup"); return; }
    const p = (window.MW_SHOPIFY || [])[i]; if (!p) return; cur = p; pick = null;
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
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-sg],[data-sgto],[data-sgclose],#sg-owner-btn,[data-sgpaid],[data-sgcancel]"); if (!t) return;
    if (t.dataset.sg !== undefined) { e.preventDefault(); open(+t.dataset.sg); }
    else if (t.dataset.sgto) { pick = t.dataset.sgto; paintPeople($("#sg-q").value); }
    else if (t.hasAttribute("data-sgclose")) $("#sg-dlg").close();
    else if (t.id === "sg-owner-btn") owner();
    else if (t.dataset.sgpaid || t.dataset.sgcancel) { const paid = !!t.dataset.sgpaid; if (!t.dataset.sure) { t.dataset.sure = 1; t.textContent = "Tap again"; return; } const r = await api(paid ? "admin/paid" : "admin/cancel", { id: +(t.dataset.sgpaid || t.dataset.sgcancel) }); say(r.ok ? (paid ? "Done. They've been messaged." : "Marked not paid.") : r.j.error || "Couldn't update."); owner(); }
  });
  document.addEventListener("input", (e) => { if (e.target.id === "sg-q") paintPeople(e.target.value); });
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "sg-form") return; e.preventDefault();
    if (!pick) { say("Pick who the gift is for."); return; }
    // open the checkout tab right away (phones block pop-ups that open after waiting)
    const w = window.open("about:blank", "_blank");
    const r = await api("start", { to: pick, variantId: $("#sg-v").value, note: $("#sg-note").value.trim() });
    if (!r.ok || !/^https:\/\/meechiesworldinc\.myshopify\.com\/cart\//.test(r.j.checkout || "")) { if (w) w.close(); say(r.j.error || "Couldn't start the gift."); return; }
    if (w) w.location.href = r.j.checkout; else location.href = r.j.checkout;
    $("#sg-dlg").close(); say("Checkout opened. Your gift code is " + r.j.code + ".");
  });
  window.MW_shopGifts = { decorate, owner };
})();
