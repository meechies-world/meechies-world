/* ============================================================================
   v2 MEECHIE'S COIN VIEW (Phase 5) — the live js/coin.js, ported: the
   crypto launch page driven by the site/coin doc and the coinlist
   notify collection, same validation (address shape, https buy link,
   live needs a contract), same owner setup form. This is the COIN
   page — the site's coin wallet and the Jackpot live in commerce.js
   and the Games view, exactly as live splits them.
   ============================================================================ */

import { MARKUP } from "./coin-markup.js";
import { firestore, esc as E } from "../platform.js";
import { toast } from "../commerce.js";

const CHAINS = { solana: "Solana", ethereum: "Ethereum", base: "Base", bsc: "BNB Chain", polygon: "Polygon", arbitrum: "Arbitrum" };
const ADDR = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const DEFAULT = {
  status: "soon", symbol: "", chain: "", contract: "", pair: "", buyUrl: "", launchDate: "",
  about: "Meechie's Coin is the coming currency of Meechie's World — built for our community of artists, creators, and supporters.",
  uses: ["Tip your favorite creators on the site", "Discounts in the Meechie's World shop", "Rewards for members who post, stream, and play"],
};
const COIN_SVG = `<svg class="cn-coin" viewBox="0 0 200 200" role="img" aria-label="Meechie's Coin">
<defs><radialGradient id="cnF" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff0b8"/><stop offset=".45" stop-color="#e6b94f"/><stop offset="1" stop-color="#8f651c"/></radialGradient>
<linearGradient id="cnR" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbe7a6"/><stop offset=".5" stop-color="#b8892e"/><stop offset="1" stop-color="#6e4c12"/></linearGradient>
<path id="cnT" d="M100 100m-72 0a72 72 0 1 1 144 0a72 72 0 1 1-144 0"/></defs>
<circle cx="100" cy="100" r="96" fill="url(#cnR)"/><circle cx="100" cy="100" r="86" fill="url(#cnF)"/>
<circle cx="100" cy="100" r="84" fill="none" stroke="#7a5512" stroke-width="1.5" stroke-dasharray="2 4"/>
<text font-family="Cinzel,Georgia,serif" font-weight="900" font-size="15" letter-spacing="3" fill="#5a3d0b"><textPath href="#cnT" startOffset="2%">MEECHIE'S COIN • MEECHIE'S WORLD INC •</textPath></text>
<circle cx="100" cy="100" r="62" fill="#0b0905" stroke="#7a5512" stroke-width="2.5"/><circle cx="100" cy="100" r="58" fill="none" stroke="#e2b54e" stroke-width=".8" opacity=".7"/>
<svg x="50" y="48" width="100" height="100" viewBox="0 0 200 200"><use href="#emblem"/></svg></svg>`;

let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const db = firestore(ctx);
  const me = db.base.me();
  const isOwner = db.base.isOwner();
  const $ = (s) => root.querySelector(s);
  let C = { ...DEFAULT };
  $("#cn-coin").innerHTML = COIN_SVG;

  function renderCoin() {
    const live = C.status === "live";
    const sym = String(C.symbol || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase();
    $("#cn-badge").textContent = live ? "LIVE NOW" : C.launchDate ? "LAUNCHING " + C.launchDate.toUpperCase() : "COMING SOON";
    $("#cn-badge").classList.toggle("live", live);
    $("#cn-sym").textContent = sym ? "$" + sym + (CHAINS[C.chain] ? " · on " + CHAINS[C.chain] : "") : CHAINS[C.chain] ? "On " + CHAINS[C.chain] : "";
    $("#cn-about").textContent = C.about || DEFAULT.about;
    $("#cn-uses").innerHTML = (C.uses && C.uses.length ? C.uses : DEFAULT.uses).map((u) => `<li>${E(u)}</li>`).join("");
    const buy = $("#cn-buy"), okBuy = live && /^https:\/\//.test(C.buyUrl || "");
    buy.hidden = !okBuy; if (okBuy) buy.href = C.buyUrl;
    const okAddr = ADDR.test(C.contract || "");
    $("#cn-addr-card").hidden = !okAddr;
    if (okAddr) { $("#cn-addr").textContent = C.contract; $("#cn-addr-chain").textContent = CHAINS[C.chain] || ""; }
    $("#cn-warn-text").textContent = live && okAddr
      ? "The only real Meechie's Coin is the one with the contract address shown on this page. Always check the address before you buy. Meechie's World will never DM you asking for your wallet's secret phrase."
      : "Meechie's Coin is not on sale yet. Anyone selling it right now is not us. When it launches, the official contract address will be posted here and announced by Meechie. Meechie's World will never DM you asking for your wallet's secret phrase.";
    const ch = $("#cn-chart"), okPair = live && CHAINS[C.chain] && /^[A-Za-z0-9]{20,66}$/.test(C.pair || "");
    ch.hidden = !okPair;
    if (okPair) { const src = `https://dexscreener.com/${C.chain}/${C.pair}?embed=1&theme=dark&trades=0&info=0`; if (ch.dataset.src !== src) { ch.dataset.src = src; ch.innerHTML = `<iframe src="${E(src)}" title="Meechie's Coin live price chart" loading="lazy"></iframe>`; } }
    else { ch.innerHTML = ""; ch.dataset.src = ""; }
    if (isOwner) fillForm();
  }
  async function count() {
    try { const s = await db.collection("coinlist").limit(1000).get(); const n = s.docs ? s.docs.length : s.size || 0; $("#cn-count").textContent = n ? n + (n === 1 ? " member is" : " members are") + " on the launch list" : ""; return s; } catch (_) { return null; }
  }
  async function notifyState() {
    const b = $("#cn-notify");
    if (!me) { b.textContent = "Join free to get notified"; b.dataset.auth = "signup"; return; }
    delete b.dataset.auth;
    try { const d = await db.doc("coinlist/" + me).get(); const on = !!d.exists; b.textContent = on ? "✓ You're on the launch list" : "🔔 Notify me at launch"; b.disabled = !!on; } catch (_) { b.textContent = "🔔 Notify me at launch"; }
  }
  $("#cn-notify").addEventListener("click", async (e) => {
    const b = e.currentTarget; if (b.dataset.auth) { toast("Join free from the gate or the Join button, then tap Notify here."); return; }
    try { const h = (ctx.session.user() && ctx.session.user().name) || ""; await db.doc("coinlist/" + me).set({ handle: String(h).slice(0, 40), at: Date.now() }); toast("You're on the Meechie's Coin launch list"); notifyState(); count(); }
    catch (_) { toast("Couldn't add you yet. Make sure you're signed in."); }
  });
  $("#cn-copy").addEventListener("click", () => { const a = C.contract || ""; if (navigator.clipboard) navigator.clipboard.writeText(a).then(() => toast("Contract address copied")).catch(() => toast("Press and hold the address to copy it")); });

  function fillForm() {
    const f = $("#cn-form"); if (!f || f.dataset.dirty) return;
    f.status.value = C.status || "soon"; f.symbol.value = C.symbol || ""; f.chain.value = C.chain || ""; f.contract.value = C.contract || "";
    f.pair.value = C.pair || ""; f.buyUrl.value = C.buyUrl || ""; f.launchDate.value = C.launchDate || ""; f.about.value = C.about || DEFAULT.about;
    f.uses.value = (C.uses && C.uses.length ? C.uses : DEFAULT.uses).join("\n");
  }
  $("#cn-form").addEventListener("input", (e) => (e.currentTarget.dataset.dirty = "1"));
  $("#cn-form").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.currentTarget, msg = $("#cn-msg");
    const d = { status: f.status.value === "live" ? "live" : "soon", symbol: f.symbol.value.trim().slice(0, 10), chain: CHAINS[f.chain.value] ? f.chain.value : "",
      contract: f.contract.value.trim(), pair: f.pair.value.trim(), buyUrl: f.buyUrl.value.trim(), launchDate: f.launchDate.value.trim().slice(0, 30),
      about: f.about.value.trim().slice(0, 600), uses: f.uses.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 8).map((s) => s.slice(0, 120)) };
    if (d.contract && !ADDR.test(d.contract)) { msg.textContent = "That contract address doesn't look right. Solana addresses are 32–44 letters and numbers; Ethereum-style ones start with 0x."; return; }
    if (d.buyUrl && !/^https:\/\//.test(d.buyUrl)) { msg.textContent = "The buy link has to start with https://"; return; }
    if (d.status === "live" && !d.contract) { msg.textContent = "Add the contract address before setting the coin to Live, so buyers can check it."; return; }
    try { await db.doc("site/coin").set(d); delete f.dataset.dirty; msg.textContent = "Saved. Everyone sees the update now."; } catch (err) { msg.textContent = "Couldn't save: " + (err.message || err); }
  });

  (async () => {
    $("#cn-owner").hidden = !isOwner;
    if (isOwner) { const s = await count(); const names = s && s.docs ? s.docs.map((d) => (d.data ? d.data() : {}).handle).filter(Boolean) : []; $("#cn-list").textContent = names.length ? "On the list: " + names.slice(0, 60).join(", ") + (names.length > 60 ? "…" : "") : "Nobody on the launch list yet."; }
    else count();
    notifyState();
  })();
  renderCoin();
  const unsub = db.doc("site/coin").onSnapshot((s) => { const d = s && (typeof s.data === "function" ? s.data() : null); C = { ...DEFAULT, ...(d || {}) }; renderCoin(); });
  cleanup.push(() => { if (typeof unsub === "function") unsub(); db.base.stop(); });
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
