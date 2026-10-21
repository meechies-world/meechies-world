/* Gift a store item to another member.
 * 1) The buyer picks a product, a size/option and a member → we save the gift and send the buyer to Shopify checkout.
 *    The order arrives in Shopify with a note: "🎁 GIFT MWG-XXXX for @Name — Meechie's World will get their address".
 * 2) When the order shows up as paid, Meechie taps "Paid ✓" (Shop → Gift orders). The member who receives it gets a private
 *    message asking for their shipping address (only Meechie sees their reply), and the buyer gets a thank-you.
 * Addresses never go into the public database. Owner can also cancel a gift that was never paid. */
import { json, userFrom, isAdmin, setup, take, change } from "../../../lib/cf.js";

const STORE = "https://meechiesworldinc.myshopify.com";
const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
const SCHEMA = ["create table if not exists shop_gifts (id integer primary key autoincrement, code text unique not null, buyer text not null, recipient text not null, product text not null, variant_id text not null, variant_title text, price text, digital integer default 0, note text, status text not null default 'started', at integer not null, done_at integer)"];
let ready = null;
const ensure = (env) => (ready = ready || env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; }));
const err = (m, s = 400) => json({ error: m }, s);
const handle = async (env, uid) => { const r = await env.DB.prepare("select json_extract(data, '$.handle') h from docs where path = ?").bind("members/" + uid).first(); return (r && r.h) || null; };
const dm = (env, from, to, body) => [env.DB.prepare("insert into dms (sender, recipient, body, created_at) values (?,?,?,?)").bind(from, to, body, new Date().toISOString()), change(env, "dms", null, null, from, to)];

export async function onRequest({ request, env, params }) {
  if (!env.DB) return err("Database not connected.", 503);
  await setup(env); await ensure(env);
  const route = (Array.isArray(params.path) ? params.path : [params.path || ""]).join("/"), method = request.method;
  const me = await userFrom(request, env); if (!me) return err("Sign in first.", 401);
  const admin = await isAdmin(env, me.id);

  if (route === "start" && method === "POST") {
    if (!(await take(env, "sgift:" + me.id, 3600, 15))) return err("Too many tries. Wait a little.", 429);
    const b = await request.json().catch(() => ({}));
    const to = String(b.to || ""), vid = String(b.variantId || "");
    if (!/^[0-9a-f-]{36}$/.test(to) || to === me.id) return err("Pick who the gift is for.");
    if (!/^\d{5,20}$/.test(vid)) return err("Pick a size or option.");
    const toName = await handle(env, to); if (!toName) return err("That member doesn't exist.");
    // check the item is really in Meechie's store and use the store's own title and price
    const pj = await fetch(STORE + "/products.json?limit=250", { headers: { accept: "application/json", "user-agent": "MeechiesWorldSite/1.0" } }).then((r) => r.json()).catch(() => null);
    let prod = null, v = null;
    for (const p of (pj && pj.products) || []) { const hit = (p.variants || []).find((x) => String(x.id) === vid); if (hit) { prod = p; v = hit; break; } }
    if (!prod) return err("That item isn't in the store anymore.");
    const code = "MWG-" + [...crypto.getRandomValues(new Uint8Array(4))].map((x) => x.toString(36).padStart(2, "0")).join("").toUpperCase().slice(0, 6);
    const note = String(b.note || "").replace(/[\r\n]+/g, " ").slice(0, 120);
    const digital = v.requires_shipping === false ? 1 : 0;
    await env.DB.prepare("insert into shop_gifts (code, buyer, recipient, product, variant_id, variant_title, price, digital, note, at) values (?,?,?,?,?,?,?,?,?,?)")
      .bind(code, me.id, to, String(prod.title).slice(0, 140), vid, String(v.title || "").slice(0, 80), String(v.price || ""), digital, note, Date.now()).run();
    const orderNote = `🎁 GIFT ${code} for @${toName} on Meechie's World.` + (digital ? " Digital item: send the download to them." : " Meechie's World will message them for their shipping address.") + (note ? ` Card: "${note}"` : "");
    const q = new URLSearchParams({ note: orderNote, "attributes[gift_code]": code, "attributes[gift_for]": "@" + toName });
    return json({ ok: true, code, checkout: `${STORE}/cart/${vid}:1?${q}` });
  }

  if (route === "mine" && method === "GET") {
    const rows = (await env.DB.prepare("select code, buyer, recipient, product, variant_title, status, at from shop_gifts where (buyer = ? or (recipient = ? and status = 'paid')) order by at desc limit 30").bind(me.id, me.id).all()).results || [];
    return json({ gifts: rows.map((r) => ({ ...r, sent: r.buyer === me.id })) });
  }

  if (route === "admin" && method === "GET") {
    if (!admin) return err("owner_only", 403);
    const rows = (await env.DB.prepare("select g.*, json_extract(a.data,'$.handle') buyer_name, json_extract(b.data,'$.handle') to_name from shop_gifts g left join docs a on a.path = 'members/' || g.buyer left join docs b on b.path = 'members/' || g.recipient order by g.status = 'started' desc, g.at desc limit 100").all()).results || [];
    return json({ gifts: rows });
  }
  if ((route === "admin/paid" || route === "admin/cancel") && method === "POST") {
    if (!admin) return err("owner_only", 403);
    const b = await request.json().catch(() => ({}));
    const g = await env.DB.prepare("select * from shop_gifts where id = ? and status = 'started'").bind(+b.id).first(); if (!g) return err("Not found or already handled.", 404);
    const now = Date.now();
    if (route === "admin/cancel") { await env.DB.prepare("update shop_gifts set status = 'canceled', done_at = ? where id = ?").bind(now, g.id).run(); return json({ ok: true }); }
    const buyerName = (await handle(env, g.buyer)) || "A member", toName = (await handle(env, g.recipient)) || "them";
    const item = g.product + (g.variant_title && g.variant_title !== "Default Title" ? " (" + g.variant_title + ")" : "");
    const toMsg = `🎁 ${buyerName} sent you a gift from the Meechie's World store: ${item}!` + (g.note ? ` Their note: "${g.note}"` : "") +
      (g.digital ? " Meechie will send it to you here." : " Reply to this message with your full shipping address (name, street, city, state, ZIP) so Meechie can ship it. Only Meechie sees your reply.") + ` Gift code ${g.code}.`;
    const buyerMsg = `✅ Your gift (${item}) for ${toName} is confirmed. We've let them know. Thank you for supporting Meechie's World! 👑 Gift code ${g.code}.`;
    await env.DB.batch([env.DB.prepare("update shop_gifts set status = 'paid', done_at = ? where id = ?").bind(now, g.id), ...dm(env, OWNER_ID, g.recipient, toMsg), ...dm(env, OWNER_ID, g.buyer, buyerMsg)]);
    return json({ ok: true });
  }
  return err("Not found", 404);
}
