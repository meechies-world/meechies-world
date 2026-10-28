/* Coin Jackpot — games for Meechie's World coins, mounted at the top of the Games view.
 * Server: functions/api/coins/[[path]].js (routes games / play / pot/* / pool/seed / admin/grant).
 * The house can never lose: every payout comes out of the prize pool, which is filled only by
 * players' lost bets (minus the 10% house fee) and by coins the owner seeds in. Winnings are
 * coins — spend them on gifts (the person you gift earns real cash value) or play them again. */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : alert(t));
  const tok = () => { try { return MW.session().access_token; } catch (_) { return ""; } };
  const meId = () => { try { return (MW.session().user || {}).id || ""; } catch (_) { return ""; } };
  const api = (path, body) => fetch("/api/coins/" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }));
  const nameOf = (uid) => { try { const m = (window.members || {})[uid]; return (m && (m.name || m.username)) || "A member"; } catch (_) { return "A member"; } };
  const ago = (t) => { const s = Math.max(1, (Date.now() - t) / 1000); if (s < 90) return "just now"; if (s < 5400) return Math.round(s / 60) + "m ago"; if (s < 129600) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; };
  const CHIP_AMTS = [5, 25, 50, 100, 250, 1000];
  const FACE = { 11: "J", 12: "Q", 13: "K", 14: "A" };
  const rank = (n) => FACE[n] || String(n);
  const SUITS = ["♠", "♥", "♦", "♣"];

  const css = document.createElement("style");
  css.textContent = `
#casino{border:1px solid var(--gold-lo,#8a6a2a);border-radius:18px;padding:16px;margin:0 0 18px;background:linear-gradient(180deg,#171208,#0c0a06)}
#casino .cz-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:space-between}
#casino h3{margin:0;font-size:26px;color:var(--gold-hi,#f0cf78)}
#casino .cz-bal{font:700 15px var(--body,system-ui)}
#casino .cz-bal b{color:var(--gold-hi,#f0cf78);font-size:18px}
.cz-pool{display:grid;gap:4px;min-width:200px;flex:1;max-width:380px}
.cz-pool .bar{height:10px;border-radius:99px;background:#241c0d;border:1px solid #3a2f16;overflow:hidden}
.cz-pool .bar i{display:block;height:100%;background:linear-gradient(90deg,#8a6a2a,#f0cf78);border-radius:99px;transition:width .6s}
.cz-pool small{color:var(--muted,#a99f8b)}
#casino .cz-safe{margin:10px 0 0;color:var(--muted,#a99f8b);font-size:13px}
#casino .cz-promo{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:12px;border:1px solid var(--gold,#d4a843);border-radius:14px;padding:12px 14px;background:linear-gradient(90deg,rgba(212,168,67,.18),rgba(212,168,67,.05));font-size:15px}
#casino .cz-auto{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;border-top:1px dashed #3a3223;padding-top:10px;font-size:13.5px}
#casino .cz-auto .cz-chips button{font-size:12px;padding:4px 9px}
#casino .cz-auto b{color:var(--gold-hi,#f0cf78)}
.cz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-top:14px}
.cz-card{border:1px solid #3a3223;border-radius:14px;padding:14px;background:#100d08;display:grid;gap:10px;align-content:start}
.cz-card h4{margin:0;font-size:18px;color:var(--gold-hi,#f0cf78)}
.cz-card .pay-note{margin:0;font-size:12.5px;color:var(--muted,#a99f8b);line-height:1.45}
.cz-stage{min-height:64px;display:grid;place-items:center;border:1px dashed #3a3223;border-radius:12px;padding:10px;text-align:center;font-size:15px}
.cz-stage .big{font-size:34px;line-height:1.2}
.cz-stage .reels{font-size:40px;letter-spacing:8px}
.cz-stage .cards{font-size:30px;display:flex;gap:14px}
.cz-stage .cards span{display:grid;place-items:center;width:54px;height:72px;border-radius:8px;background:#f5efdd;color:#171208;font-weight:800;box-shadow:0 4px 12px rgba(0,0,0,.5)}
.cz-stage .cards span small{font-size:11px;color:#8a6a2a}
.cz-chips{display:flex;gap:6px;flex-wrap:wrap}
.cz-chips button{border:1px solid var(--gold-lo,#8a6a2a);background:#171208;color:var(--gold-hi,#f0cf78);border-radius:999px;padding:5px 11px;font:700 12.5px var(--body,system-ui);cursor:pointer}
.cz-chips button.on{background:var(--gold,#d4a843);color:#120f09}
.cz-chips button:disabled{opacity:.35;cursor:default}
.cz-pick{display:flex;gap:6px;flex-wrap:wrap}
.cz-pick button{flex:1;border:1px solid #3a3223;background:#171208;color:#fff;border-radius:10px;padding:9px 6px;font:700 13.5px var(--body,system-ui);cursor:pointer;min-width:70px}
.cz-pick button.on{border-color:var(--gold,#d4a843);background:rgba(212,168,67,.16);color:var(--gold-hi,#f0cf78)}
.cz-play{width:100%;padding:11px;font-size:15px}
.cz-res{min-height:1.3em;font-size:13.5px;text-align:center}
.cz-res.win{color:#7dd87d;font-weight:700}.cz-res.push{color:var(--gold-hi,#f0cf78);font-weight:700}.cz-res.lose{color:var(--muted,#a99f8b)}
.cz-board{display:grid;grid-template-columns:repeat(8,1fr);gap:4px;width:100%}
.cz-board i{aspect-ratio:1;border:1px solid #3a3223;border-radius:6px;display:grid;place-items:center;font:700 10px var(--body,system-ui);color:var(--muted,#a99f8b);font-style:normal;background:#0b0906}
.cz-board i.lit{background:rgba(212,168,67,.25);border-color:var(--gold-lo,#8a6a2a);color:#fff}
.cz-board i.here{background:var(--gold,#d4a843);color:#120f09;font-size:14px}
.cz-sec{margin-top:18px;border-top:1px solid #2a2418;padding-top:14px}
.cz-sec h4{margin:0 0 8px;font-size:18px;color:var(--gold-hi,#f0cf78)}
.cz-pot{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;border:1px solid #3a3223;border-radius:12px;padding:10px 12px;margin-bottom:8px;background:#100d08;font-size:14px}
.cz-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.cz-form input{width:110px;background:#0b0a08;border:1px solid #3a3223;border-radius:10px;padding:9px 10px;color:#fff;font:15px var(--body,system-ui)}
.cz-feed{display:grid;gap:5px;font-size:13.5px;color:var(--muted,#cbbf9f)}
.cz-feed b{color:var(--gold-hi,#f0cf78)}
.cz-owner{display:grid;gap:10px;border:1px dashed var(--gold-lo,#8a6a2a);border-radius:12px;padding:12px}
.cz-muted{color:var(--muted,#a99f8b);font-size:13px}`;
  document.head.appendChild(css);

  const wrap = document.querySelector("#v-games .wrap");
  if (!wrap) return;
  const root = document.createElement("div");
  root.id = "casino";
  wrap.insertBefore(root, wrap.firstChild);

  const S = { data: null, bet: { flip: 25, highcard: 25, dice: 25, slots: 25, race: 25, wheel: 25, plinko: 25, triple: 25 }, pick: { flip: "heads", dice: "under", triple: "mixed", potSide: "heads" }, potBet: 50, busy: {}, auto: null, autoPick: {} };
  const betOf = (g) => Math.max(S.data ? S.data.minBet : 5, Math.min(S.bet[g] || 25, (S.data && S.data.maxBet[g]) || 0));

  function chipsHtml(g) {
    const max = S.data ? S.data.maxBet[g] : 0;
    return `<div class="cz-chips" data-chips="${g}">${CHIP_AMTS.map((a) => `<button type="button" data-amt="${a}" ${a > max ? "disabled" : ""} class="${betOf(g) === a ? "on" : ""}">🪙 ${a}</button>`).join("")}</div>`;
  }
  function stageHtml(g) {
    if (g === "flip") return `<div class="big">🪙</div><div>Call it in the air</div>`;
    if (g === "highcard") return `<div class="cards"><span>?</span><span>?</span></div><div>Your card vs the dealer's</div>`;
    if (g === "dice") return `<div class="big">🎲 🎲</div><div>Two dice — call the total</div>`;
    if (g === "slots") return `<div class="reels">🌹 🎤 🔥</div><div>Three of a kind pays big</div>`;
    if (g === "wheel") return `<div class="big">🎡</div><div>Twelve segments — gold pays 4.5×</div>`;
    if (g === "plinko") return `<div class="big">🎯</div><div>Seven bounces — the edge slots pay 8×</div>`;
    if (g === "triple") return `<div class="big">🪙 🪙 🪙</div><div>Three coins, one call</div>`;
    return `<div class="cz-board">${Array.from({ length: 24 }, (_, i) => `<i data-cell="${i}">${i + 1}</i>`).join("")}</div><div>4 dice carry your 👑 down the board</div>`;
  }
  /* auto-bet (owner, 2026-10-27 — "set their bets to auto, like DraftKings"):
     the player picks a round count, the game plays itself at their bet and
     their call, and they can stop it any time. Same server play route, same
     odds, same pool caps — it just presses the button for them. It stops on
     its own when the rounds run out, the coins run low, or the pool caps
     the bet, and it stops when they leave the Games view. */
  function autoRow(g) {
    if (S.auto && S.auto.g === g) return `<div class="cz-auto"><span>🔁 Auto — <b data-autoleft="${g}">${S.auto.left}</b> rounds left · net <b data-autonet="${g}">${S.auto.net >= 0 ? "+" : ""}${S.auto.net}</b></span><button type="button" class="btn sm" data-autostop="1">⏹ Stop</button></div>`;
    const n = S.autoPick[g] || 10;
    return `<div class="cz-auto"><span>🔁 Auto-bet</span><span class="cz-chips" data-autochips="${g}">${[10, 25, 50, 100].map((x) => `<button type="button" data-an="${x}" class="${n === x ? "on" : ""}" ${S.auto ? "disabled" : ""}>${x}</button>`).join("")}</span><button type="button" class="btn sm ghost" data-auto="${g}" ${S.auto ? "disabled" : ""}>▶ Start auto</button></div>`;
  }
  function autoStage(g, r) {
    const st = stageEl(g); if (!st) return; const dt = r.j.detail || {};
    if (g === "flip") st.innerHTML = `<div class="big">${dt.land === "heads" ? "🪙" : "💰"}</div><div>It landed <b>${E(dt.land)}</b> — you called ${E(S.pick.flip)}</div>`;
    else if (g === "highcard") st.innerHTML = `<div class="cards"><span>${rank(dt.you)}</span><span>${rank(dt.dealer)}</span></div><div>You <b>${rank(dt.you)}</b> vs dealer <b>${rank(dt.dealer)}</b></div>`;
    else if (g === "dice") st.innerHTML = `<div class="big">${"⚀⚁⚂⚃⚄⚅"[dt.d1 - 1]} ${"⚀⚁⚂⚃⚄⚅"[dt.d2 - 1]}</div><div>Total <b>${dt.sum}</b></div>`;
    else if (g === "slots") st.innerHTML = `<div class="reels">${(dt.reels || []).map(E).join(" ")}</div><div>${r.j.pay > r.j.bet ? "Jackpot line!" : r.j.pay > 0 ? "A pair pays out." : "No match."}</div>`;
    else if (g === "race") st.innerHTML = `<div class="big">🏁 ${dt.total}</div><div>Final total <b>${dt.total}</b> of 24</div>`;
    else if (g === "wheel") st.innerHTML = `<div class="big">🎡 ${dt.mult}×</div><div>The wheel paid <b>${dt.mult}×</b></div>`;
    else if (g === "plinko") st.innerHTML = `<div class="big">🎯 Slot ${dt.slot + 1} — ${dt.mult}×</div><div>It landed in slot <b>${dt.slot + 1}</b> of 8</div>`;
    else if (g === "triple") st.innerHTML = `<div class="big">${(dt.flips || []).map((f) => f ? "🪙" : "💰").join(" ")}</div><div>${dt.heads} heads, ${3 - dt.heads} tails</div>`;
  }
  function syncMoney(r) {
    if (r.j.coins != null && S.data) S.data.myCoins = r.j.coins;
    if (r.j.pool != null && S.data) S.data.pool = r.j.pool;
    const bal = root.querySelector(".cz-bal b"); if (bal && S.data) bal.textContent = "🪙 " + S.data.myCoins.toLocaleString();
    const poolB = root.querySelector(".cz-pool b"); if (poolB && S.data) poolB.textContent = "🪙 " + S.data.pool.toLocaleString();
    const poolBar = root.querySelector(".cz-pool .bar i"); if (poolBar && S.data) poolBar.style.width = Math.min(100, Math.round((S.data.pool / 5000) * 100)) + "%";
  }
  async function autoRun(g) {
    if (S.auto || !S.data) return;
    const bet = betOf(g);
    if (bet < S.data.minBet) { say("The prize pool is too low for that game right now."); return; }
    if ((S.data.myCoins || 0) < bet) { say("Not enough coins for that bet — claim your welcome drop or grab a pack."); return; }
    S.auto = { g, left: S.autoPick[g] || 10, net: 0, rounds: 0, stop: false };
    render();
    while (S.auto && S.auto.g === g && !S.auto.stop && S.auto.left > 0) {
      if ((S.data.myCoins || 0) < bet) { say("🔁 Auto stopped — your coins ran below the bet."); break; }
      const r = await api("play", { game: g, bet, choice: S.pick[g] || "" });
      if (!r.ok) { say(r.j.error === "not_enough_coins" ? "🔁 Auto stopped — not enough coins for the next bet." : "🔁 Auto stopped: " + (r.j.error || "that play did not go through.")); break; }
      S.auto.left--; S.auto.rounds++; S.auto.net += (r.j.pay || 0) - bet;
      syncMoney(r); autoStage(g, r); resultLine(g, r);
      const lf = root.querySelector(`[data-autoleft="${g}"]`); if (lf) lf.textContent = S.auto.left;
      const nt = root.querySelector(`[data-autonet="${g}"]`); if (nt) nt.textContent = (S.auto.net >= 0 ? "+" : "") + S.auto.net;
      if (S.auto.left > 0 && !S.auto.stop) await new Promise((res) => setTimeout(res, 700));
    }
    const done = S.auto; S.auto = null;
    if (done && done.rounds) say(`🔁 Auto finished: ${done.rounds} rounds on ${S.data.games[g].name} — net ${done.net >= 0 ? "+" : ""}${done.net} coins.`);
    load();
  }
  function cardHtml(g) {
    const d = S.data, info = d.games[g], max = d.maxBet[g], low = max < d.minBet;
    const picks = {
      flip: `<div class="cz-pick" data-pick="flip"><button type="button" data-v="heads" class="${S.pick.flip === "heads" ? "on" : ""}">🪙 Heads</button><button type="button" data-v="tails" class="${S.pick.flip === "tails" ? "on" : ""}">Tails</button></div>`,
      dice: `<div class="cz-pick" data-pick="dice"><button type="button" data-v="under" class="${S.pick.dice === "under" ? "on" : ""}">Under 7 · 2.2×</button><button type="button" data-v="seven" class="${S.pick.dice === "seven" ? "on" : ""}">Exactly 7 · 5.4×</button><button type="button" data-v="over" class="${S.pick.dice === "over" ? "on" : ""}">Over 7 · 2.2×</button></div>`,
      triple: `<div class="cz-pick" data-pick="triple"><button type="button" data-v="heads3" class="${S.pick.triple === "heads3" ? "on" : ""}">All heads · 7×</button><button type="button" data-v="mixed" class="${S.pick.triple === "mixed" ? "on" : ""}">Mixed · 1.2×</button><button type="button" data-v="tails3" class="${S.pick.triple === "tails3" ? "on" : ""}">All tails · 7×</button></div>`,
      highcard: "", slots: "", race: "", wheel: "", plinko: ""
    };
    const notes = {
      flip: "Call heads or tails. Right call pays 1.9× your bet.",
      highcard: "Beat the dealer's card, win 1.9×. A tie gives your bet back.",
      dice: "Under 7 or over 7 pays 2.2×. Exactly 7 pays 5.4×.",
      slots: "Any pair pays 1.2×. Triples: 🌹 6× · 🎤 8× · 🔥/💵 10× · 💎 15× · 👑 25×.",
      race: "Four dice roll your 👑 down a 24-space board. Total 21+ pays 5× · 17–20 pays 1.8× · 13–16 your bet back.",
      wheel: "Twelve segments: six pay nothing, three hand your bet back, and 1.5×, 2× and the gold 4.5× pay out.",
      plinko: "The ball bounces seven times and drops in a slot. The middle pays 0.3×–1× — the two edge slots pay 8×.",
      triple: "Call all three coins at once: all heads or all tails pays 7×, any mix pays 1.2×."
    };
    return `<div class="cz-card" data-card="${g}">
      <h4>${E(info.name)}</h4>
      <div class="cz-stage" data-stage="${g}">${stageHtml(g)}</div>
      ${picks[g] || ""}
      ${chipsHtml(g)}
      <button type="button" class="btn cz-play" data-play="${g}" ${low || S.busy[g] || S.auto ? "disabled" : ""}>${low ? "Prize pool too low right now" : S.auto && S.auto.g === g ? "🔁 Auto running…" : "Bet 🪙 " + betOf(g) + " — Play"}</button>
      <div class="cz-res" data-res="${g}"></div>
      ${autoRow(g)}
      <p class="pay-note">${notes[g]}</p>
    </div>`;
  }
  function potsHtml() {
    const d = S.data, mine = meId();
    if (!d.pots.length) return `<p class="cz-muted">No open pots. Start one: put up coins on heads or tails and another member can take the other side. Winner takes the pot, minus the 10% house fee.</p>`;
    return d.pots.map((p) => `<div class="cz-pot"><span><b>${E(nameOf(p.creator))}</b> put up <b>🪙 ${p.bet}</b> on <b>${p.side === "heads" ? "🪙 Heads" : "Tails"}</b> · <span class="cz-muted">${ago(p.at)}</span></span>${p.creator === mine ? `<button type="button" class="btn sm ghost" data-pot-cancel="${p.id}">Cancel & refund</button>` : `<button type="button" class="btn sm" data-pot-join="${p.id}">Take ${p.side === "heads" ? "Tails" : "🪙 Heads"} · 🪙 ${p.bet}</button>`}</div>`).join("");
  }
  const KIND_LABEL = { game_bet: "Bet", game_win: "Won", game_fee: "House fee", pot_bet: "Pot bet", pot_win: "Won a pot", daily: "Daily check-in", promo: "Welcome drop", pot_refund: "Pot refund", pool_seed: "Seeded the pool", grant: "Granted coins" };
  function render() {
    const d = S.data; if (!d) return;
    const poolPct = Math.min(100, Math.round((d.pool / 5000) * 100));
    root.innerHTML = `
    <div class="cz-head">
      <h3>🎰 Coin Jackpot</h3>
      <div class="cz-pool"><small>🏆 PRIZE POOL · <b style="color:var(--gold-hi,#f0cf78)">🪙 ${d.pool.toLocaleString()}</b> — every win pays from here</small><div class="bar"><i style="width:${poolPct}%"></i></div></div>
      <div class="cz-bal">Your coins: <b>🪙 ${(d.myCoins ?? 0).toLocaleString()}</b> <button type="button" class="btn sm" data-coins-open style="margin-left:6px">My coins</button>${d.paid ? ` <button type="button" class="btn sm ghost" data-coins-open>＋ Buy</button>` : ""}</div>
    </div>
    <p class="cz-safe">🛡️ <b>How winning works:</b> winnings are coins, paid only out of the prize pool. The pool fills up from players' lost bets (minus a 10% house fee) — so play is always covered before you bet. Spend winnings on gifts and the person you gift earns <b>real cash value</b> (40%), or cash out your own gift earnings from My coins. ${d.paid ? "" : "The coin shop (buying coins with a card) switches on with payments — until then, play with the coins you have."}</p>
    ${d.promo && !d.promo.claimed ? `<div class="cz-promo"><span>🎁 <b>Welcome drop:</b> 🪙 ${d.promo.amount} free coins, on the house — one per member, yours to play right now.</span><button type="button" class="btn" data-promo-claim>🪙 Claim ${d.promo.amount} coins</button></div>` : ""}
    <div class="cz-grid">${["flip", "highcard", "dice", "slots", "race", "wheel", "plinko", "triple"].map(cardHtml).join("")}</div>
    <div class="cz-sec"><h4>⚔️ Player vs Player — Coin Flip Pots</h4>
      <div id="cz-pots">${potsHtml()}</div>
      <form class="cz-form" id="cz-potform"><span>Start a pot:</span><input type="number" id="cz-potbet" min="${d.minBet}" max="1000" step="1" value="${S.potBet}"><div class="cz-pick" data-pick="potSide" style="flex:none"><button type="button" data-v="heads" class="${S.pick.potSide === "heads" ? "on" : ""}">🪙 Heads</button><button type="button" data-v="tails" class="${S.pick.potSide === "tails" ? "on" : ""}">Tails</button></div><button type="submit" class="btn sm">Put up the pot</button></form>
    </div>
    <div class="cz-sec"><h4>🏆 Recent winners</h4><div class="cz-feed">${d.wins.length ? d.wins.map((w) => `<div><b>${E(nameOf(w.uid))}</b> won <b>🪙 ${w.coins}</b> · ${ago(w.at)}</div>`).join("") : `<span class="cz-muted">No wins yet — be the first name up here.</span>`}</div></div>
    ${d.mine.length ? `<div class="cz-sec"><h4>🧾 Your recent plays</h4><div class="cz-feed">${d.mine.map((t) => `<div>${E(KIND_LABEL[t.kind] || t.kind)} · ${t.coins > 0 ? "+" : ""}${t.coins} coins · ${ago(t.at)}</div>`).join("")}</div></div>` : ""}
    ${d.admin ? `<div class="cz-sec"><h4>👑 Owner corner</h4><div class="cz-owner">
      <form class="cz-form" id="cz-grant"><span>Grant coins (to you):</span><input type="number" id="cz-grant-amt" min="1" max="1000000" value="500"><button class="btn sm" type="submit">Grant</button></form>
      <form class="cz-form" id="cz-seed"><span>Seed the prize pool from your coins:</span><input type="number" id="cz-seed-amt" min="1" max="100000" value="200"><button class="btn sm" type="submit">Seed pool</button><span class="cz-muted">Seeding lets members place bigger bets — the pool caps every game's max bet.</span></form>
    </div></div>` : ""}`;
  }
  async function load() {
    if (!tok()) { root.innerHTML = `<div class="cz-head"><h3>🎰 Coin Jackpot</h3></div><p class="cz-safe">Sign in (or join free) to play for coins — win coins, gift them, and the people you gift earn real cash value.</p>`; return; }
    const r = await api("games");
    if (!r.ok) { root.innerHTML = `<div class="cz-head"><h3>🎰 Coin Casino</h3></div><p class="cz-safe">${E(r.j.error || "The Jackpot couldn't load right now.")}</p>`; return; }
    const me = await api("me").catch(() => null);
    S.data = r.j; S.data.myCoins = me && me.ok ? me.j.coins : 0;
    for (const g of Object.keys(S.bet)) S.bet[g] = Math.max(S.data.minBet, Math.min(S.bet[g], Math.max(S.data.minBet, S.data.maxBet[g] || S.data.minBet)));
    render();
  }
  const resEl = (g) => root.querySelector(`[data-res="${g}"]`);
  const stageEl = (g) => root.querySelector(`[data-stage="${g}"]`);
  function finish(g, r) {
    S.busy[g] = false;
    if (r.j.coins != null && S.data) S.data.myCoins = r.j.coins;
    if (r.j.pool != null && S.data) S.data.pool = r.j.pool;
    const bal = root.querySelector(".cz-bal b"); if (bal && S.data) bal.textContent = "🪙 " + S.data.myCoins.toLocaleString();
    const poolB = root.querySelector(".cz-pool b"); if (poolB && S.data) poolB.textContent = "🪙 " + S.data.pool.toLocaleString();
    const poolBar = root.querySelector(".cz-pool .bar i"); if (poolBar && S.data) poolBar.style.width = Math.min(100, Math.round((S.data.pool / 5000) * 100)) + "%";
    const btn = root.querySelector(`[data-play="${g}"]`); if (btn) { btn.disabled = false; btn.textContent = "Bet 🪙 " + betOf(g) + " — Play"; }
    setTimeout(load, 2600); // refresh pots, winners and max bets quietly
  }
  function resultLine(g, r) {
    const el = resEl(g); if (!el) return;
    const { bet, pay, note } = r.j;
    el.className = "cz-res " + (pay > bet ? "win" : pay === bet ? "push" : "lose");
    el.textContent = (note ? note + " " : "") + (pay > bet ? `🎉 You won 🪙 ${pay} (+${pay - bet})!` : pay === bet ? "↩️ Push — your bet is back." : "No win this time. The pool thanks you.");
  }
  async function play(g) {
    if (S.busy[g] || !S.data) return;
    const bet = betOf(g); if (bet < S.data.minBet) { say("The prize pool is too low for that game right now."); return; }
    S.busy[g] = true;
    const btn = root.querySelector(`[data-play="${g}"]`); if (btn) { btn.disabled = true; btn.textContent = "Playing…"; }
    const el = resEl(g); if (el) { el.className = "cz-res"; el.textContent = ""; }
    const r = await api("play", { game: g, bet, choice: S.pick[g] || "" });
    if (!r.ok) { S.busy[g] = false; if (btn) { btn.disabled = false; btn.textContent = "Bet 🪙 " + bet + " — Play"; } say(r.j.error || "That play didn't go through."); return; }
    const st = stageEl(g), dt = r.j.detail || {};
    if (g === "flip" && st) {
      let n = 0; st.innerHTML = `<div class="big">🪙</div><div>Flipping…</div>`;
      const iv = setInterval(() => { st.querySelector(".big").textContent = ++n % 2 ? "🪙" : "💰"; if (n > 7) { clearInterval(iv); st.innerHTML = `<div class="big">${dt.land === "heads" ? "🪙" : "💰"}</div><div>It landed <b>${E(dt.land)}</b> — you called ${E(S.pick.flip)}</div>`; resultLine(g, r); finish(g, r); } }, 110);
      return;
    }
    if (g === "highcard" && st) {
      const s1 = SUITS[Math.floor(Math.random() * 4)], s2 = SUITS[Math.floor(Math.random() * 4)];
      st.innerHTML = `<div class="cards"><span>${rank(dt.you)}<small>${s1}</small></span><span>${rank(dt.dealer)}<small>${s2}</small></span></div><div>You <b>${rank(dt.you)}</b> vs dealer <b>${rank(dt.dealer)}</b></div>`;
    }
    if (g === "dice" && st) st.innerHTML = `<div class="big">${"⚀⚁⚂⚃⚄⚅"[dt.d1 - 1]} ${"⚀⚁⚂⚃⚄⚅"[dt.d2 - 1]}</div><div>Total <b>${dt.sum}</b> — you called ${E(S.pick.dice === "seven" ? "exactly 7" : S.pick.dice + " 7")}</div>`;
    if (g === "slots" && st) {
      const pool = ["🌹", "🎤", "🔥", "💵", "💎", "👑"]; let n = 0;
      const iv = setInterval(() => { st.innerHTML = `<div class="reels">${pool[Math.floor(Math.random() * 6)]} ${pool[Math.floor(Math.random() * 6)]} ${pool[Math.floor(Math.random() * 6)]}</div><div>Spinning…</div>`; if (++n > 8) { clearInterval(iv); st.innerHTML = `<div class="reels">${dt.reels.map(E).join(" ")}</div><div>${r.j.pay > r.j.bet ? "Jackpot line!" : r.j.pay > 0 ? "A pair pays out." : "No match."}</div>`; resultLine(g, r); finish(g, r); } }, 90);
      return;
    }
    if (g === "race" && st) {
      let pos = 0, step = 0;
      const cells = st.querySelectorAll("[data-cell]");
      const drawBoard = () => cells.forEach((c, i) => { c.className = i < pos ? "lit" : i === pos ? "here" : ""; c.textContent = i === pos ? "👑" : String(i + 1); });
      if (!cells.length) { resultLine(g, r); finish(g, r); return; }
      const note = document.createElement("div"); st.appendChild(note);
      const iv = setInterval(() => {
        if (step < dt.rolls.length) { pos = Math.min(23, pos + dt.rolls[step]); note.textContent = `Die ${step + 1}: rolled ${dt.rolls[step]} — total so far ${dt.rolls.slice(0, step + 1).reduce((a, b) => a + b, 0)}`; step++; drawBoard(); }
        else { clearInterval(iv); note.textContent = `🏁 Final total ${dt.total} of 24`; resultLine(g, r); finish(g, r); }
      }, 620);
      drawBoard();
      return;
    }
    if (g === "wheel" && st) {
      const SEGL = ["0", "0", "0", "0", "0", "0", "1×", "1×", "1×", "1.5×", "2×", "4.5×"]; let n = 0;
      const iv = setInterval(() => { st.innerHTML = `<div class="big">🎡 ${SEGL[Math.floor(Math.random() * 12)]}</div><div>Spinning…</div>`; if (++n > 8) { clearInterval(iv); st.innerHTML = `<div class="big">🎡 ${SEGL[dt.seg]}</div><div>It stopped on <b>${SEGL[dt.seg]}</b></div>`; resultLine(g, r); finish(g, r); } }, 90);
      return;
    }
    if (g === "plinko" && st) {
      let n = 0;
      const iv = setInterval(() => { st.innerHTML = `<div class="big">🪙</div><div>Bouncing${".".repeat(n % 4)}</div>`; if (++n > 7) { clearInterval(iv); st.innerHTML = `<div class="big">🎯 Slot ${dt.slot + 1} — ${dt.mult}×</div><div>It landed in slot <b>${dt.slot + 1}</b> of 8</div>`; resultLine(g, r); finish(g, r); } }, 100);
      return;
    }
    if (g === "triple" && st) {
      let n = 0;
      const iv = setInterval(() => { st.innerHTML = `<div class="big">${[0, 1, 2].map(() => Math.random() < 0.5 ? "🪙" : "💰").join(" ")}</div><div>Flipping…</div>`; if (++n > 7) { clearInterval(iv); st.innerHTML = `<div class="big">${dt.flips.map((f) => f ? "🪙" : "💰").join(" ")}</div><div>${dt.heads} heads, ${3 - dt.heads} tails</div>`; resultLine(g, r); finish(g, r); } }, 110);
      return;
    }
    resultLine(g, r); finish(g, r);
  }
  root.addEventListener("click", async (e) => {
    const chip = e.target.closest("[data-chips] button");
    if (chip) { const g = chip.closest("[data-chips]").dataset.chips; S.bet[g] = +chip.dataset.amt; render(); return; }
    const pk = e.target.closest("[data-pick] button");
    if (pk) { const key = pk.closest("[data-pick]").dataset.pick; S.pick[key] = pk.dataset.v; pk.closest("[data-pick]").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === pk)); return; }
    const pl = e.target.closest("[data-play]");
    if (pl) { play(pl.dataset.play); return; }
    const pc = e.target.closest("[data-promo-claim]");
    if (pc) { pc.disabled = true; pc.textContent = "Claiming…"; const r = await api("promo/claim", {}); if (r.ok) { say(`🎁 +${r.j.amount} coins — they're in your wallet. Good luck!`); if (S.data) { if (S.data.promo) S.data.promo.claimed = true; S.data.myCoins = r.j.coins; } load(); } else { say(r.j.error || "Couldn't claim right now."); pc.disabled = false; pc.textContent = "🪙 Claim coins"; } return; }
    const ac = e.target.closest("[data-autochips] button");
    if (ac) { const g = ac.closest("[data-autochips]").dataset.autochips; S.autoPick[g] = +ac.dataset.an; ac.closest("[data-autochips]").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === ac)); return; }
    const ab = e.target.closest("[data-auto]");
    if (ab) { autoRun(ab.dataset.auto); return; }
    const as = e.target.closest("[data-autostop]");
    if (as) { if (S.auto) { S.auto.stop = true; as.disabled = true; as.textContent = "Stopping…"; } return; }
    const join = e.target.closest("[data-pot-join]");
    if (join) { join.disabled = true; const r = await api("pot/join", { id: join.dataset.potJoin }); if (!r.ok) { say(r.j.error || "Couldn't join that pot."); join.disabled = false; return; } say(r.j.youWon ? `🎉 The coin landed ${r.j.land} — you won 🪙 ${r.j.prize}!` : `The coin landed ${r.j.land} — the pot goes to the other player this time.`); load(); return; }
    const cancel = e.target.closest("[data-pot-cancel]");
    if (cancel) { const r = await api("pot/cancel", { id: cancel.dataset.potCancel }); say(r.ok ? "Pot cancelled — your coins are back." : r.j.error || "Couldn't cancel."); load(); return; }
  });
  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.target.id === "cz-potform") {
      const bet = Math.round(+root.querySelector("#cz-potbet").value || 0); S.potBet = bet;
      const r = await api("pot/create", { bet, side: S.pick.potSide });
      say(r.ok ? "Pot is live — another member can take the other side." : r.j.error || "Couldn't start the pot."); if (r.ok) load();
    }
    if (e.target.id === "cz-grant") { const amt = Math.round(+root.querySelector("#cz-grant-amt").value || 0); const r = await api("admin/grant", { coins: amt }); say(r.ok ? `Granted 🪙 ${amt} to your wallet.` : r.j.error || "Grant failed."); if (r.ok) load(); }
    if (e.target.id === "cz-seed") { const amt = Math.round(+root.querySelector("#cz-seed-amt").value || 0); const r = await api("pool/seed", { coins: amt }); say(r.ok ? `Prize pool seeded — it's now 🪙 ${r.j.pool}.` : r.j.error || "Seeding failed."); if (r.ok) load(); }
  });
  const view = document.getElementById("v-games");
  if (view) new MutationObserver(() => { if (!view.hidden) load(); else if (S.auto) S.auto.stop = true; }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  if (view && !view.hidden) load(); else setTimeout(() => { if (!S.data) load(); }, 2500);
})();
