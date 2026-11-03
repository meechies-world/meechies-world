  /* [C1 split] WATCH THE SETUP + SETUP PLANS + spectator booth pack.
   * This file is NOT a standalone script: js/dj.js fetches it and direct-evals
   * it INSIDE the dj closure on demand (the dj-booth.js pattern), so every
   * function below keeps working on the real S / net / deck state with zero
   * rewrites. It loads when a seat first needs it — entering the Watch view,
   * a plans/watch door, or immediately in the Playground (SANDBOX), where
   * today's eager entitlement + trial-lock behavior is preserved. The URL
   * rides LAZY_SRC.watchpack (app-core) so the B5 idle prefetcher warms the
   * bytes for everyone; lazyKick("watchpack") must NEVER be called. */
  /* ---------- WATCH THE SETUP (owner ask 2026-10-29) ----------
   * Guests and members watch the booth live and hear the station while
   * they watch. READ-ONLY BY CONSTRUCTION: this block only ever reads S
   * and writes #ws-* / #wb-* nodes. Nothing here calls save() or any
   * deck control, and the one DB write in the block is the member own
   * trial stamp on members/<uid>, the same pattern the profile saves
   * use. The mirror control surfaces carry class ws-ctl, whose only
   * click path runs the upsell card. Watching and listening to Meechie
   * stay free — plans are only for running a setup of your own.
   * watch-setup2 (same day, the owner correction): the first mirror was
   * rows of text and he rejected it — "they cant see my turn tables...
   * i want them to see what i see like my set up my radio tab". So
   * paintWatch now builds the booth itself a second time under #wb-root
   * (see the spectator booth note at paintWatch). */
  let wsUpsellAt = 0, wsSig = "", wsTrialAt = 0, wsTrialChecked = false;
  function wsLiveNow() { return isLive() || (vsBroadcast() && !(S.vstream || {}).hidden); }
  function wsEnsureModals() {
    if (!document.getElementById("ws-upsell")) {
      const u = document.createElement("div"); u.id = "ws-upsell"; u.className = "ws-modal"; u.hidden = true;
      u.innerHTML = `<div class="ws-card"><button type="button" class="btn ghost sm ws-x wsu-x" aria-label="Close">✕</button><h3 style="margin:0 0 8px">👀 You are watching Meechie's setup</h3><p style="margin:0 0 10px">This is Meechie's live DJ setup. You can watch everything he does on it — the controls answer to Meechie only.</p><p style="margin:0 0 14px">Want tables of your own? You get an <b>exact copy of Meechie's own setup</b> — the same tables, the same look, the same arrangement as his radio. Run the <b>full setup FREE for 7 days</b>. After the trial, <b>Tables are $10/month</b>, <b>YouTube search is $15</b>, <b>save sessions is $20</b> — and the <b>DJ Video Package is $35/month</b>.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn wsu-free">🎛️ Open the tables</button><button type="button" class="btn ghost wsu-plans">See plans</button></div></div>`;
      document.body.appendChild(u);
    }
    if (!document.getElementById("ws-plans")) {
      const p = document.createElement("div"); p.id = "ws-plans"; p.className = "ws-modal"; p.hidden = true;
      p.innerHTML = `<div class="ws-card"><button type="button" class="btn ghost sm ws-x wpl-x" aria-label="Close">✕</button><h3 style="margin:0 0 6px">🎛️ Run your own setup</h3><p class="muted" style="margin:0 0 6px">Watching and listening to Meechie live is always free. Plans are only for running your own tables.</p><div class="wpl-row"><div class="wpl-nm"><b>Full setup — 7-day free trial</b><span>Every feature free for 7 days: the tables, YouTube search, save sessions and the DJ Video Package</span></div><b class="wpl-pr">$0</b></div><div id="wpl-trial-note"></div><div id="wpl-manage-row" hidden><button type="button" class="btn ghost sm wpl-manage">⚙️ Manage my plan / cancel</button></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 6px"><button type="button" class="btn wpl-trial" id="wpl-trial">Start my 7-day free trial</button><button type="button" class="btn ghost wpl-free">🎛️ Open the tables</button></div><div class="wpl-row"><div class="wpl-nm"><b>Tables</b><span>Keep the exact same setup Meechie runs — same tables, same look, same arrangement. Play manually, or run your set the way he does</span></div><b class="wpl-pr">$10/month</b><button type="button" class="btn sm wpl-buy" data-tier="10">Get this plan</button></div><div class="wpl-row"><div class="wpl-nm"><b>Tables + YouTube search</b><span>Everything in Tables, plus search YouTube right from your tables</span></div><b class="wpl-pr">$15/month</b><button type="button" class="btn sm wpl-buy" data-tier="15">Get this plan</button></div><div class="wpl-row"><div class="wpl-nm"><b>Tables + YouTube search + Save sessions</b><span>Everything in YouTube search, plus save your sessions and playlists to run again</span></div><b class="wpl-pr">$20/month</b><button type="button" class="btn sm wpl-buy" data-tier="20">Get this plan</button></div><div class="wpl-row"><div class="wpl-nm"><b>🎬 DJ VIDEO PACKAGE</b><span>Everything in Save sessions, plus the master screen: video mixes and your camera, like Meechie's TV station</span></div><b class="wpl-pr">Coming soon</b></div><div id="wpl-signal-row" hidden><button type="button" class="btn ghost sm wpl-signal">🔗 Connect the Stripe signal</button> <span class="muted" id="wpl-signal-note"></span></div></div>`;
      document.body.appendChild(p);
    }
  }
  function wsModal(id, show) { wsEnsureModals(); const m = document.getElementById(id); if (m) m.hidden = !show; if (show && id === "ws-plans") wsTrialPaint(); }
  function wsUpsell() { const now = Date.now(); if (now - wsUpsellAt < 60000) return; wsUpsellAt = now; wsModal("ws-upsell", true); }
  function wsGoBasic() { if (typeof go === "function") go("dj"); const pg = document.getElementById("pg-open"); if (pg) { try { pg.click(); } catch (_) {} } }
  function wsTrialPaint() { const note = document.getElementById("wpl-trial-note"); const btn = document.getElementById("wpl-trial"); if (btn && wsTrialAt) { btn.disabled = true; btn.textContent = wsTrialActive() ? "✅ Trial on" : "⌛ Trial ended"; }
    /* plans-card charging states (2026-11-02): a member on a plan sees it
     * marked on its own row and gets the Manage door; everybody else gets
     * live buy buttons. Plan changes ride Manage (the Stripe billing
     * portal) — a second checkout can never stack two subscriptions. */
    document.querySelectorAll(".wpl-buy").forEach((b) => { const tier = +(b.getAttribute("data-tier") || 0); if (wsTier >= 10 && tier === wsTier) { b.disabled = true; b.textContent = "✅ Your plan"; } else if (wsTier >= 10) { b.disabled = true; b.textContent = "On a plan"; } else { b.disabled = false; b.textContent = "Get this plan"; } });
    const mr = document.getElementById("wpl-manage-row"); if (mr) mr.hidden = !(wsTier >= 10);
    const sr = document.getElementById("wpl-signal-row"); if (sr) sr.hidden = !wsRealOwner();
    if (!note) return; if (wsTier >= 10) note.innerHTML = `<p style="margin:6px 0">✅ Your plan is on: <b>${SETUP_TIERS[wsTier] || "Tables"}</b> — $${wsTier}/month. Every feature in your plan is open on your tables.</p>`; else if (wsTrialAt && wsTrialActive()) { const daysLeft = Math.max(1, Math.ceil((wsTrialAt + SETUP_TRIAL_MS - Date.now()) / 864e5)); note.innerHTML = `<p style="margin:6px 0">✅ Your 7-day free trial is on — every feature is open until ${new Date(wsTrialAt + SETUP_TRIAL_MS).toLocaleDateString()} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left). Nothing is charged when it ends — pick a plan below only if you want to keep your tables.</p>`; } else if (wsTrialAt) note.innerHTML = `<p style="margin:6px 0">⌛ Your 7-day free trial ended. Pick a plan below to keep your tables running — watching and listening to Meechie stays free forever.</p>`; else note.innerHTML = ""; }
  function wsPaintPlans() { const ses = mySess(); const uid = ses && ses.user && ses.user.id; if (!uid) return; if (wsEntLoaded) { wsTrialPaint(); return; } wsLoadEnt().then(() => wsTrialPaint()); }
  async function wsStartTrial(btn) {
    const ses = mySess(); const uid = ses && ses.user && ses.user.id;
    if (!uid) { wsModal("ws-plans", false); if (typeof openAuth === "function") openAuth("signup"); say("Join free first — the trial rides on your free account."); return; }
    if (wsTrialAt) { wsTrialPaint(); return; }
    const d = DB(); if (!d) { say("One moment — still connecting."); return; }
    if (btn) btn.disabled = true;
    try { await d.doc("members/" + uid).update({ trial_started_at: Date.now() }); wsTrialAt = Date.now(); wsTrialChecked = true; wsEntLoaded = true; wsTrialPaint(); }
    catch (e) { if (btn) btn.disabled = false; say("That did not save — tap it once more."); }
  }
  /* ---------- SETUP PLANS — charging (owner launch, 2026-11-02) ----------
   * The buy buttons ride the site own Stripe rails: /api/dj/checkout makes
   * a subscription Checkout Session on the server (the price lives there,
   * never in the tap), and the Stripe webhook is the only writer of
   * setup_tier. Trial conversion is PAY-TO-CONTINUE: the trial ending
   * charges nobody — the member picks a plan here to keep the tier. The
   * $35 DJ Video Package stays "coming soon" (owner ruling) — no button. */
  async function wsBuyTier(btn) {
    const tier = +(btn && btn.getAttribute ? btn.getAttribute("data-tier") : 0) || 0;
    if (tier !== 10 && tier !== 15 && tier !== 20) return;
    const ses = mySess(); const uid = ses && ses.user && ses.user.id;
    if (!uid) { wsModal("ws-plans", false); if (typeof openAuth === "function") openAuth("signup"); say("Join free first — plans ride on your free account."); return; }
    if (wsTier >= 10) { say("You already have a plan — use Manage my plan to change or cancel it."); return; }
    if (btn) { btn.disabled = true; btn.textContent = "One moment…"; }
    try {
      const r = await fetch("/api/dj/checkout", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + ses.access_token }, body: JSON.stringify({ tier }) }).then(async (x) => ({ ok: x.ok, status: x.status, j: await x.json().catch(() => ({})) }));
      if (r.ok && r.j && /^https:\/\/checkout\.stripe\.com\//.test(r.j.url || "")) { location.href = r.j.url; return; }
      if (r.status === 501) say("Payments are not switched on yet — your trial and tables still work.");
      else if (r.status === 409) say("You already have a plan — use Manage my plan to change or cancel it.");
      else say("That did not start — tap it once more.");
    } catch (_) { say("That did not start — tap it once more."); }
    if (btn) { btn.disabled = false; btn.textContent = "Get this plan"; }
  }
  async function wsManagePlan(btn) {
    const ses = mySess(); const uid = ses && ses.user && ses.user.id;
    if (!uid) return;
    if (btn) btn.disabled = true;
    try {
      const r = await fetch("/api/dj/portal", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + ses.access_token }, body: "{}" }).then(async (x) => ({ ok: x.ok, status: x.status, j: await x.json().catch(() => ({})) }));
      if (r.ok && r.j && /^https:\/\/billing\.stripe\.com\//.test(r.j.url || "")) { location.href = r.j.url; return; }
      say("No plan to manage yet.");
    } catch (_) { say("That did not open — tap it once more."); }
    if (btn) btn.disabled = false;
  }
  /* Owner-only one-time setup (2026-11-02): the Stripe webhook endpoint is
   * created from INSIDE the site — the owner cannot sign in to the Stripe
   * Dashboard from his browser, so there is no dashboard step. This button
   * shows only on the owner's own session (painted in wsTrialPaint); the
   * server route re-checks the owner uid before touching Stripe. */
  async function wsConnectSignal(btn) {
    const ses = mySess(); const uid = ses && ses.user && ses.user.id;
    if (!uid || !wsRealOwner()) return;
    if (btn) btn.disabled = true;
    try {
      const r = await fetch("/api/dj/setup-webhook", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + ses.access_token }, body: "{}" }).then(async (x) => ({ ok: x.ok, status: x.status, j: await x.json().catch(() => ({})) }));
      const note = document.getElementById("wpl-signal-note");
      if (r.ok && r.j && r.j.connected) { if (note) note.textContent = r.j.already ? "Signal already connected ✅" : "Signal connected ✅"; if (btn) btn.textContent = "🔗 Stripe signal connected ✅"; say(r.j.already ? "The Stripe signal was already connected ✅" : "Stripe signal connected ✅ — plan payments now flip tiers on by themselves."); return; }
      say("That did not connect — tap it once more.");
    } catch (_) { say("That did not connect — tap it once more."); }
    if (btn) btn.disabled = false;
  }
  /* ---------- SETUP PLANS — entitlement (owner directive 2026-10-30,
   * supersedes the #366 ladder): 7 days free, then Tables $10/month,
   * +YouTube search $15, +Save sessions $20, DJ Video Package $35.
   * The member doc carries the stamps: trial_started_at (already the
   * #366 field, window now 7 days) + setup_tier (the dollar tier:
   * 0/10/15/20/35). Charging went live 2026-11-02 for $10/$15/$20
   * (see SETUP PLANS — charging above): real Stripe subscriptions via
   * /api/dj, the webhook writes the tier. $35 stays presentation-only
   * ("coming soon") until its video feature exists. Malik (the real isOwner) is never
   * gated, the station is never gated, watching/listening stays free
   * forever, and a member performing on the station under Malik's own
   * grant (guest DJ / battle) is on air, not on a plan. ------------ */
  const SETUP_TRIAL_MS = 7 * 24 * 3600 * 1000;
  const SETUP_TIERS = { 10: "Tables", 15: "YouTube Search", 20: "Save Sessions", 35: "DJ Video Package" };
  let wsTier = 0, wsEntLoaded = false, wsEntPromise = null;
  const wsRealOwner = () => typeof isOwner !== "undefined" && !!isOwner;
  const wsOnAir = () => { try { return sessionStorage.getItem("mw-guestlive") === "1" || sessionStorage.getItem("mw-battlelive") === "1"; } catch (_) { return false; } };
  const wsTrialActive = () => !!wsTrialAt && (Date.now() - wsTrialAt) < SETUP_TRIAL_MS;
  function wsEntitled(level) { if (wsRealOwner() || wsOnAir()) return true; if (wsTrialActive()) return true; return (wsTier || 0) >= level; }
  function wsLoadEnt() {
    if (wsEntPromise) return wsEntPromise;
    wsEntPromise = (async () => {
      const ses = mySess(); const uid = ses && ses.user && ses.user.id; if (!uid) { wsEntLoaded = true; wsTrialChecked = true; return; }
      for (let i = 0; i < 12; i++) {
        const d = DB(); if (!d) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        try { const snap = await d.doc("members/" + uid).get(); const data = snap && snap.exists && snap.data ? snap.data() : null; if (data) { if (data.trial_started_at) wsTrialAt = +data.trial_started_at || 0; if (data.setup_tier) wsTier = +data.setup_tier || 0; } } catch (_) {}
        break;
      }
      wsEntLoaded = true; wsTrialChecked = true;
    })();
    return wsEntPromise;
  }
  /* feature gate for a signed-in setup user in the Playground: returns
   * true when the tap must stop here (plan card shown instead). Guests
   * keep today's behavior — their door is the join flow on the cards. */
  function setupGate(level) {
    const ses = mySess(); const uid = ses && ses.user && ses.user.id;
    if (!uid || wsRealOwner() || wsOnAir()) return false;
    if (!wsEntLoaded) { wsLoadEnt(); say("One moment — checking your plan."); return true; }
    if (wsEntitled(level)) return false;
    say(level >= 20 ? "💾 Save sessions rides the $20/month plan — here are the plans." : "🔒 That feature rides a plan — here are the plans.");
    wsModal("ws-plans", true);
    return true;
  }
  /* the Tables gate on the Playground itself: a member whose 7-day
   * trial has ended with no Tables plan gets the word at the door of
   * their own setup (presentation — their tables stay visible). */
  if (SANDBOX) wsLoadEnt().then(() => {
    const ses = mySess(); const uid = ses && ses.user && ses.user.id;
    if (!uid || wsRealOwner() || wsOnAir()) return;
    if (wsTrialAt && !wsTrialActive() && (wsTier || 0) < 10) {
      const host = document.getElementById("v-dj"); if (!host || document.getElementById("setup-lock")) return;
      const card = document.createElement("div"); card.className = "card"; card.id = "setup-lock"; card.style.marginBottom = "14px";
      card.innerHTML = `<h3 style="margin-top:0">⌛ Your 7-day free trial ended</h3><p class="muted">The <b>Tables plan — $10/month</b> — keeps your setup running. Watching and listening to Meechie stays free forever.</p><button class="btn" type="button" id="setup-lock-plans">See the plans</button>`;
      host.insertBefore(card, host.firstChild);
      const b = document.getElementById("setup-lock-plans"); if (b) b.addEventListener("click", () => wsModal("ws-plans", true));
    }
  });
  /* ---------- the spectator booth (watch-setup2) ----------
   * The booth itself, built a second time for the room: the same markup
   * and classes the owner console uses (deck, platter, wave, beatbox,
   * xfpad, fxgrid, dj-panel), in the booth own order — master screen,
   * decks A-D, the X fader strip, MASTER FX, the queue — under #wb-root
   * with wb- ids so nothing collides with the real booth. It is painted
   * from S with the booth own values and formulas: posOf() for deck
   * position, the paintOwner deck values (title, cover on the platter,
   * spin on the playing deck, pitch/volume), the paintXfPads math for
   * the X dot, the pan readout and the volume knobs, paintBeat values
   * for BPM and key, paintEdit values for the FX. The platter spin is
   * the booth own .spin animation, started and stopped purely by the
   * shared playing flag. The master screen is a real screen in the
   * stage system (scrWatch, and #wb-stage rides vsStageEls), so the
   * video mix and the live share land on it exactly like the station
   * stage — rendered by the site from state, never a capture. The
   * waveform is drawn locally from the deck record (position over
   * duration) because a spectator loads no audio of its own — the
   * sound itself rides the listener engine, started by the Watch
   * buttons like TUNE IN. Owner-only panels (Door, live-DJ requests,
   * After Hours, Customize, Studio) are not part of the show and are
   * not built here. */
  let wbBuilt = false, wbQSsig = "", wbWaveSig = {};
  const WB_DK = { A: "#f0cf78", B: "#38bdf8", C: "#4ade80", D: "#f472b6" };
  function wbDeckHTML(k) {
    return `<div class="deck ws-ctl" data-deck="${k}" style="--dk:${WB_DK[k]}"><h4>DECK ${k}</h4><div class="platter" id="wb-pl-${k}"></div>
    <canvas class="wave" id="wb-wv-${k}" width="520" height="84"></canvas>
    <div class="wb-yt" id="wb-yt-${k}" hidden>🎬 MUSIC VIDEO — playing on the master screen above</div>
    <div class="ttl" id="wb-ttl-${k}">Load a song</div><div class="tm" id="wb-tm-${k}">0:00</div>
    <div class="beatbox"><span class="bpmv" id="wb-bpm-${k}">BPM —</span><span class="keyv" id="wb-key-${k}"></span><span class="bdots" id="wb-dots-${k}"><i></i><i></i><i></i><i></i></span></div>
    <div class="row"><button class="btn sm" type="button" id="wb-play-${k}">▶ Play</button><button class="btn ghost sm" type="button">⏮ Cue</button><button class="btn ghost sm" type="button">🛑 Brake</button></div>
    <label class="lab">Pitch <span id="wb-pitv-${k}">0.0%</span><input type="range" min="0.92" max="1.08" step="0.001" value="1" id="wb-pit-${k}" disabled></label>
    <label class="lab">Volume<input type="range" min="0" max="2" step="0.01" value="0.9" id="wb-vol-${k}" disabled></label></div>`;
  }
  function wbFxCell(id, lab, min, max, step) {
    return `<div class="fxcell"><small>${lab} · <span id="wb-fxv-${id}"></span></small><input type="range" min="${min}" max="${max}" step="${step}" value="${min}" id="wb-fx-${id}" disabled></div>`;
  }
  function wbBuild(body) {
    const deckA = wbDeckHTML("A"), deckB = wbDeckHTML("B"), deckC = wbDeckHTML("C"), deckD = wbDeckHTML("D");
    const xv = (k) => `<div class="xv" id="wb-xv-${k}" style="--dk:${WB_DK[k]}"><i></i><span>VOL ${k}</span><b id="wb-xvb-${k}">90%</b></div>`;
    body.innerHTML = `<div id="wb-root">
    <div class="wb-top"><span class="onair-lamp" id="wb-lamp"><span class="dot"></span>OFF AIR</span><span class="wb-now" id="wb-now"></span></div>
    <div class="dj-screen"><small>📺 MASTER SCREEN — MUSIC VIDEO · EVERYONE SEES THIS SCREEN LIVE</small>
    <div class="stage-row"><aside class="srail" id="wb-rail-l" aria-label="From the shop"></aside><div class="stage-mid"><div class="vstage" id="wb-stage"><div class="vslot" id="wb-vs1"></div><div class="vslot" id="wb-vs2"></div><div class="vstandby" id="wb-vstandby">Meechie is live on the tables — the video mix lands here the moment a music video plays.</div><div class="vposter" id="wb-vposter"><img src="/img/radio-promo.jpg" srcset="/img/radio-promo-640.webp 640w, /img/radio-promo-1080.webp 1080w" sizes="100vw" alt="Meechie's World Radio" loading="lazy" decoding="async"></div><div class="vchip" id="wb-vchip" hidden></div></div><div class="st-shout" id="wb-shout" hidden></div><div class="stage-bar"><button class="btn" type="button" data-rqopen="wb">🎤 SONG REQUEST / SHOUT-OUT</button><span class="rq-mystat" id="wb-mystat"></span></div><div class="rq-form2" id="wb-rqform" hidden><div class="dj-search"><input type="text" id="wb-rq-song" maxlength="100" placeholder="Type a song — Meechie AI finds the video" aria-label="Song to request"><input type="text" id="wb-rq-shout" maxlength="140" placeholder="Shout-out (optional) — it shows when your song plays" aria-label="Shout-out"></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn sm" type="button" data-rqgo="wb">🎵 Request it</button><small class="muted">One request at a time. It joins the DJ queue and plays right after the current song — and its video takes the screen.</small></div><div class="rq-results" id="wb-rqres"></div></div></div><aside class="srail" id="wb-rail-r" aria-label="Promotions"></aside></div><div class="stage-strip" id="wb-strip"></div></div>
    <div class="dj-panel wb-band"><h4>🎶 UP NEXT — THE QUEUE</h4><div class="dj-list" id="wb-queue"></div></div>
    <div class="dj-decks wb-decks">${deckA}${deckB}
    <div class="mixer xfbar ws-ctl"><div class="xfrow"><div class="xfvols">${xv("A")}${xv("B")}</div><div class="xfpad big"><span class="xfpl tl">A</span><span class="xfpl tr">B</span><span class="xfpl bl">C</span><span class="xfpl br">D</span><div class="xfdot" id="wb-xfdot"></div></div><div class="xfvols">${xv("C")}${xv("D")}</div></div>
    <small>✕ THE X FADER — slide toward a corner deck to give it the volume; the center is all even, and the master screen up top blends with it</small>
    <div style="display:flex;gap:8px;align-items:center;justify-content:center"><small id="wb-pan-read">A 100% · B 100% · C 100% · D 100%</small></div>
    <div class="xfcurve" role="group" aria-label="Crossfader curve"><span>CURVE</span><button type="button" class="wb-xfc" data-v="smooth">Smooth</button><button type="button" class="wb-xfc" data-v="sharp">Sharp</button><button type="button" class="wb-xfc" data-v="cut">Cut</button></div></div>
    ${deckC}${deckD}</div>
    <div class="dj-panel ws-ctl"><h4>🎛️ MASTER FX</h4><div class="fxgrid">
    ${wbFxCell("boost", "🔊 BOOST", 1, 2, 0.01)}
    ${wbFxCell("mf", "FILTER", 0, 100, 1)}
    ${wbFxCell("echo", "ECHO", 0, 0.6, 0.02)}
    ${wbFxCell("fb", "ECHO REPEAT", 0, 0.7, 0.02)}
    ${wbFxCell("verb", "REVERB", 0, 0.7, 0.02)}
    ${wbFxCell("fla", "FLANGER", 0, 1, 0.02)}
    ${wbFxCell("pha", "PHASER", 0, 1, 0.02)}
    ${wbFxCell("noise", "NOISE", 0, 1, 0.02)}
    ${wbFxCell("crush", "GRIT (CRUSH)", 0, 100, 1)}
    <div class="fxcell wide"><small>TRANSFORMER (CHOP)</small><div style="display:flex;gap:5px"><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="0">OFF</button><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="2">SLOW</button><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="4">MED</button><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="8">FAST</button></div></div>
    </div></div>
    </div>`;
    wbBuilt = true; wbQSsig = ""; wbWaveSig = {};
  }
  function wbWave(k) {
    const cv = document.getElementById("wb-wv-" + k); if (!cv) return;
    const s = S[k] || {}; const dur = +s.dur || 0, pos = posOf(k);
    const sig = (s.title || "") + "|" + Math.floor(pos * 4) + "|" + dur + "|" + (s.playing ? 1 : 0);
    if (wbWaveSig[k] === sig) return; wbWaveSig[k] = sig;
    const g = cv.getContext("2d"); if (!g) return;
    const W = cv.width, H = cv.height, frac = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
    const seed = k.charCodeAt(0) * 131 + (s.title || "").length * 17 + ((s.title || " ").charCodeAt(0) || 0);
    g.clearRect(0, 0, W, H);
    const n = 72, bw = W / n;
    for (let i = 0; i < n; i++) {
      const v = 0.25 + 0.75 * Math.abs(Math.sin(seed + i * 1.7) * Math.cos(seed * 0.3 + i * 0.53));
      const h = Math.max(2, v * (H - 10));
      g.fillStyle = i / n <= frac ? "#f7b928" : "rgba(230,220,195,.28)";
      g.fillRect(i * bw + 0.5, (H - h) / 2, Math.max(1, bw - 1.5), h);
    }
    if (dur > 0) { g.fillStyle = "#fff"; g.fillRect(Math.max(0, frac * W - 1), 0, 2, H); }
  }
  function paintWatch() {
    const body = document.getElementById("ws-body"); if (!body) return;
    if (!document.body || document.body.dataset.view !== "watch") return;
    if (SANDBOX) { if (wsSig !== "sb") { wsSig = "sb"; wbBuilt = false; body.innerHTML = `<p class="muted">The Playground is a sandbox — the live setup mirror runs on the real site.</p>`; } return; }
    if (!wbBuilt || !document.getElementById("wb-root")) wbBuild(body);
    const live = wsLiveNow();
    const lamp = document.getElementById("wb-lamp");
    if (lamp) { lamp.classList.toggle("on", live); const lt = live ? "ON AIR" : "OFF AIR"; if (lamp.lastChild && lamp.lastChild.textContent !== lt) lamp.lastChild.textContent = lt; }
    const nowEl = document.getElementById("wb-now");
    if (nowEl) {
      const tvLive = vsBroadcast() && !(S.vstream || {}).hidden;
      const playing = DECKS.filter((k) => S[k] && S[k].playing && S[k].title).map((k) => S[k].title);
      const gN = S.djGuest && S.djGuest.until > Date.now() ? gName(S.djGuest) : null;
      nowEl.textContent = tvLive && !playing.length && !gN ? "📺 Meechie is live on the master screen — the tables pick back up when the share ends." : live ? (playing.length ? "🎧 Live now: " + playing.join("  ×  ") : gN ? "🎧 " + gN + " is live on the decks." : "🎧 Meechie is live on the decks.") : "The station is on the playlist right now — the booth wakes up the moment Meechie goes live.";
    }
    const sb = document.getElementById("wb-sound");
    if (sb) { const t = listening ? "🔊 Sound on — tap to mute" : "🔇 Sound off — tap for sound"; if (sb.textContent !== t) sb.textContent = t; }
    DECKS.forEach((k) => {
      const s = S[k] || {};
      const ttl = document.getElementById("wb-ttl-" + k);
      if (ttl) { const t = s.title || "Load a song"; if (ttl.textContent !== t) ttl.textContent = t; const card = ttl.closest(".deck"); if (card) card.classList.toggle("playing", !!s.playing); }
      const pl = document.getElementById("wb-pl-" + k);
      if (pl) { pl.classList.toggle("spin", !!s.playing); pl.classList.toggle("has-cover", okUrl(s.cover)); if (okUrl(s.cover)) pl.style.setProperty("--cv", `url("${s.cover}")`); }
      const yt = document.getElementById("wb-yt-" + k); if (yt) yt.hidden = !s.yt;
      const pb = document.getElementById("wb-play-" + k); if (pb) { const t = s.playing ? "⏸ Pause" : "▶ Play"; if (pb.textContent !== t) pb.textContent = t; }
      const tm = document.getElementById("wb-tm-" + k);
      if (tm) { const dur = +s.dur || 0, pos = posOf(k); tm.textContent = fmt(pos) + (dur ? " / " + fmt(dur) + " · −" + fmt(Math.max(0, dur - pos)) : ""); }
      const bp = document.getElementById("wb-bpm-" + k); if (bp) { const t = s.bpm > 0 ? s.bpm.toFixed(1) + " BPM" : "BPM —"; if (bp.textContent !== t) bp.textContent = t; }
      const kv = document.getElementById("wb-key-" + k); if (kv) { const t = s.cam ? s.cam + (s.key ? " · " + s.key : "") : ""; if (kv.textContent !== t) kv.textContent = t; }
      const dots = document.getElementById("wb-dots-" + k);
      if (dots) { const on = s.playing && s.bpm > 0 ? Math.floor(posOf(k) / (60 / s.bpm)) % 4 : -1; const kids = dots.children; for (let i = 0; i < kids.length; i++) kids[i].classList.toggle("on", i === on); }
      const pit = document.getElementById("wb-pit-" + k); if (pit) pit.value = s.rate || 1;
      const pv = document.getElementById("wb-pitv-" + k); if (pv) pv.textContent = (((s.rate || 1) - 1) * 100).toFixed(1).replace("-", "−") + "%";
      const vol = document.getElementById("wb-vol-" + k); if (vol) vol.value = s.vol ?? 0.9;
      const kn = document.getElementById("wb-xv-" + k); if (kn) kn.style.setProperty("--rot", (-135 + ((s.vol || 0) / 2) * 270) + "deg");
      const xb = document.getElementById("wb-xvb-" + k); if (xb) xb.textContent = Math.round((s.vol || 0) * 100) + "%";
      wbWave(k);
    });
    const dot = document.getElementById("wb-xfdot");
    if (dot) { const xfv = S.panX == null ? 0.5 : S.panX; dot.style.left = (50 + (xfv - 0.5) * 84) + "%"; dot.style.top = (50 + (S.panY || 0) * 42) + "%"; }
    const rd = document.getElementById("wb-pan-read");
    if (rd) { const py = S.panY || 0, ab = py > 0 ? 1 - py : 1, cd = py < 0 ? 1 + py : 1; const g = { A: xfGain(S.xf, "A") * ab * pairXGain(S.panX, false), B: xfGain(S.xf, "B") * ab * pairXGain(S.panX, false), C: xfGain(S.xf2 ?? 0.5, "A") * cd * pairXGain(S.panX, true), D: xfGain(S.xf2 ?? 0.5, "B") * cd * pairXGain(S.panX, true) }; const mx = Math.max(g.A, g.B, g.C, g.D, 0.0001); rd.textContent = ["A", "B", "C", "D"].map((k) => k + " " + Math.round(g[k] / mx * 100) + "%").join(" · "); }
    document.querySelectorAll(".wb-xfc").forEach((x) => x.classList.toggle("on", x.dataset.v === (S.xfCurve || "smooth")));
    const fx = S.fx || {};
    const fxSet = (id, v, lab) => { const el = document.getElementById("wb-fx-" + id); if (el) el.value = v; const t = document.getElementById("wb-fxv-" + id); if (t) t.textContent = lab; };
    fxSet("boost", fx.boost || 1, Math.round((fx.boost || 1) * 100) + "%");
    fxSet("mf", fx.mf == null ? 100 : fx.mf, Math.round(fx.mf == null ? 100 : fx.mf) + "%");
    fxSet("echo", fx.echo || 0, Math.round((fx.echo || 0) * 100) + "%");
    fxSet("fb", fx.fb == null ? 0.34 : fx.fb, Math.round((fx.fb == null ? 0.34 : fx.fb) * 100) + "%");
    fxSet("verb", fx.verb || 0, Math.round((fx.verb || 0) * 100) + "%");
    fxSet("fla", fx.fla || 0, Math.round((fx.fla || 0) * 100) + "%");
    fxSet("pha", fx.pha || 0, Math.round((fx.pha || 0) * 100) + "%");
    fxSet("noise", fx.noise || 0, Math.round((fx.noise || 0) * 100) + "%");
    fxSet("crush", fx.crush || 0, String(fx.crush || 0));
    document.querySelectorAll(".wb-gate").forEach((x) => x.classList.toggle("on", +x.dataset.v === (+fx.gate || 0)));
    const q = pkLine.map((p) => ({ title: p.title || "", yt: p.yt || "", pick: true })).concat(Array.isArray(S.queue) ? S.queue : []); // the DJ queue line: listener requests at its head, then his queue
    const qsig = q.length + "|" + q.map((x) => ((x || {}).title || "")).join("~");
    if (qsig !== wbQSsig) { wbQSsig = qsig; const qEl = document.getElementById("wb-queue"); if (qEl) qEl.innerHTML = q.length ? q.map((x, i) => `<div class="dj-item"><span>${(x || {}).pick ? "🎤 " : ""}${i + 1}. ${(x || {}).yt ? "🎬 " : ""}${E((x || {}).title || "Untitled")}</span>${(x || {}).pick ? '<small class="muted">song request</small>' : ""}</div>`).join("") : `<small class="muted">The queue is empty — Auto-DJ pulls from the full rotation.</small>`; }
  }
  setInterval(() => { try { paintWatch(); } catch (_) {} }, 1000);
  /* cross-boundary surface for the dj.js stubs (the BOOTH idiom) */
  Object.assign(WPACK, { paintWatch, wsModal, wsGoBasic, wsPaintPlans, wsTrialPaint, wsUpsell, wsStartTrial, wsBuyTier, wsManagePlan, wsConnectSignal, setupGate });
