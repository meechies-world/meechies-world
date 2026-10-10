/* Meechie's Coin page: launch page for Meechie's World's own crypto coin.
 * Before launch: "coming soon", a scam warning, and a Notify me list for members.
 * The owner fills in the coin's details (blockchain, contract address, buy link) in the owner panel;
 * once set to Live, the page shows the live price chart, the contract address and a Buy button.
 * Settings are saved in site/coin (only the owner can change them). Notify list: coinlist/<member id>. */
(function () {
  const view = document.getElementById("v-coin"); if (!view) return;
  const $ = (s) => view.querySelector(s);
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CHAINS = { solana: "Solana", ethereum: "Ethereum", base: "Base", bsc: "BNB Chain", polygon: "Polygon", arbitrum: "Arbitrum" };
  const ADDR = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
  const DEFAULT = {
    status: "soon", symbol: "", chain: "", contract: "", pair: "", buyUrl: "", launchDate: "",
    about: "Meechie's Coin is the coming currency of Meechie's World — built for our community of artists, creators, and supporters.",
    uses: ["Tip your favorite creators on the site", "Discounts in the Meechie's World shop", "Rewards for members who post, stream, and play"],
  };
  let C = { ...DEFAULT }, unsub = null, started = false;

  const css = document.createElement("style");
  css.textContent = `
.cn-hero{display:grid;grid-template-columns:auto 1fr;gap:28px;align-items:center;padding:26px;border:1px solid var(--gold-lo,#8c6d26);border-radius:18px;background:radial-gradient(ellipse at 20% 30%,rgba(212,168,67,.18),transparent 60%),var(--panel)}
.cn-coin{width:190px;height:190px;filter:drop-shadow(0 10px 30px rgba(212,168,67,.35));animation:cnspin 5s ease-in-out infinite}
@keyframes cnspin{0%,100%{transform:perspective(600px) rotateY(-22deg)}50%{transform:perspective(600px) rotateY(22deg)}}
@media (prefers-reduced-motion:reduce){.cn-coin{animation:none}}
.cn-hero h2{margin:4px 0 8px}
.cn-badge{display:inline-block;font:800 12px var(--body);letter-spacing:1.5px;padding:5px 11px;border-radius:999px;background:rgba(212,168,67,.15);color:var(--gold-hi);border:1px solid var(--gold-lo,#8c6d26)}
.cn-badge.live{background:#1f7a3a;color:#fff;border-color:#2ea44f}
.cn-acts{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center}
.cn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:16px}
.cn-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
.cn-card h3{margin:0 0 10px;font-size:16px}
.cn-card ul{margin:0;padding-left:20px}.cn-card li{margin:6px 0}
.cn-warn{border-color:#8a3b2a;background:rgba(138,59,42,.12)}
.cn-addr{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cn-addr code{font:500 13px "IBM Plex Mono",monospace;word-break:break-all;background:#000;padding:8px 10px;border-radius:8px;border:1px solid var(--line);flex:1;min-width:0}
.cn-chart{margin-top:16px;border:1px solid var(--line);border-radius:14px;overflow:hidden;height:560px;background:#000}
.cn-chart iframe{width:100%;height:100%;border:0}
.cn-own{margin-top:18px;border:1px dashed var(--gold);border-radius:14px;padding:18px}
.cn-own form{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.cn-own label{display:grid;gap:5px;font-size:13px;color:var(--muted)}
.cn-own input,.cn-own select,.cn-own textarea{font:15px var(--body);padding:9px 10px;border-radius:9px;border:1px solid var(--line);background:#0b0a08;color:var(--text)}
.cn-own .full{grid-column:1/-1}
.cn-steps li{margin:8px 0}
@media (max-width:640px){.cn-hero{grid-template-columns:1fr;justify-items:center;text-align:center}.cn-acts{justify-content:center}.cn-coin{width:150px;height:150px}.cn-chart{height:480px}}`;
  document.head.appendChild(css);

  // the coin itself: gold coin with the Conscientia emblem
  $("#cn-coin").innerHTML = `<svg class="cn-coin" viewBox="0 0 200 200" role="img" aria-label="Meechie's Coin">
<defs><radialGradient id="cnF" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff0b8"/><stop offset=".45" stop-color="#e6b94f"/><stop offset="1" stop-color="#8f651c"/></radialGradient>
<linearGradient id="cnR" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbe7a6"/><stop offset=".5" stop-color="#b8892e"/><stop offset="1" stop-color="#6e4c12"/></linearGradient>
<path id="cnT" d="M100 100m-72 0a72 72 0 1 1 144 0a72 72 0 1 1-144 0"/></defs>
<circle cx="100" cy="100" r="96" fill="url(#cnR)"/><circle cx="100" cy="100" r="86" fill="url(#cnF)"/>
<circle cx="100" cy="100" r="84" fill="none" stroke="#7a5512" stroke-width="1.5" stroke-dasharray="2 4"/>
<text font-family="Cinzel,Georgia,serif" font-weight="900" font-size="15" letter-spacing="3" fill="#5a3d0b"><textPath href="#cnT" startOffset="2%">MEECHIE'S COIN • MEECHIE'S WORLD INC •</textPath></text>
<circle cx="100" cy="100" r="58" fill="none" stroke="#7a5512" stroke-width="2"/>
<g fill="none" stroke="#4a320a" stroke-linejoin="round" stroke-linecap="round"><path d="M100 58 128 104H72Z" stroke-width="5"/><path d="M87 89q13-10 26 0q-13 10-26 0Z" stroke-width="3"/>
<path d="M70 110 100 116 130 110V128L100 135 70 128Z" stroke-width="4"/><path d="M100 116V135" stroke-width="3"/></g><circle cx="100" cy="89" r="4" fill="#4a320a"/></svg>`;

  function render() {
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
    if (typeof isOwner !== "undefined" && isOwner) fillForm();
  }

  async function count() {
    try { const s = await db.collection("coinlist").limit(1000).get(); const n = s.docs ? s.docs.length : s.size || 0; $("#cn-count").textContent = n ? n + (n === 1 ? " member is" : " members are") + " on the launch list" : ""; return s; } catch (_) { return null; }
  }
  async function notifyState() {
    const b = $("#cn-notify");
    if (typeof me === "undefined" || !me) { b.textContent = "Join free to get notified"; b.dataset.auth = "signup"; return; }
    delete b.dataset.auth;
    try { const d = await db.doc("coinlist/" + me).get(); const on = !!d.exists; b.textContent = on ? "✓ You're on the launch list" : "🔔 Notify me at launch"; b.disabled = !!on; } catch (_) { b.textContent = "🔔 Notify me at launch"; }
  }
  $("#cn-notify").addEventListener("click", async (e) => {
    const b = e.currentTarget; if (b.dataset.auth) return; // the site's Join free handler opens sign-up
    try { const h = (typeof profileMe !== "undefined" && profileMe && profileMe.handle) || ""; await db.doc("coinlist/" + me).set({ handle: String(h).slice(0, 40), at: Date.now() }); toast("You're on the Meechie's Coin launch list"); notifyState(); count(); }
    catch (err) { toast("Couldn't add you yet. Make sure you're signed in."); }
  });
  $("#cn-copy").addEventListener("click", () => { const a = C.contract || ""; navigator.clipboard?.writeText(a).then(() => toast("Contract address copied")).catch(() => toast("Press and hold the address to copy it")); });

  /* owner panel */
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

  async function start() {
    if (started) { notifyState(); return; }
    if (typeof db === "undefined" || !db) { render(); setTimeout(() => { if (!view.hidden) start(); }, 1500); return; } // site still starting up
    started = true;
    const own = typeof isOwner !== "undefined" && isOwner;
    $("#cn-owner").hidden = !own;
    if (own) { const s = await count(); const names = s && s.docs ? s.docs.map((d) => (d.data ? d.data() : {}).handle).filter(Boolean) : []; $("#cn-list").textContent = names.length ? "On the list: " + names.slice(0, 60).join(", ") + (names.length > 60 ? "…" : "") : "Nobody on the launch list yet."; }
    else count();
    notifyState();
    try { unsub = db.doc("site/coin").onSnapshot((s) => { const d = s && (typeof s.data === "function" ? s.data() : null); C = { ...DEFAULT, ...(d || {}) }; render(); }, () => render()); } catch (_) { render(); }
  }
  render();
  new MutationObserver(() => { if (!view.hidden) { const own = typeof isOwner !== "undefined" && isOwner; $("#cn-owner").hidden = !own; start(); } }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  if (!view.hidden) setTimeout(start, 1500);
})();
