/* ============================================================================
   v2 DJ STATE — the typed WRITE layer for the shared `radio/dj` document
   (MAP §4.3), Phase 4. station.js owns the read path and the shared math;
   this module owns the booth's copy of S and every write to it, under the
   live write discipline (live dj.js @ main ebc7da70, read in full):

   - save() is OWNER-only; a corpse guard runs first (a deck flagged
     playing past dur+15 is ended or parked — a save never re-asserts a
     corpse over a keeper rescue).
   - SANDBOX (?playdj=1) persists the whole S to sessionStorage
     "mw-playdj" and guest-relays; it NEVER writes the doc or the brain.
   - Normal saves debounce 250 ms (save(true) = immediate), stamp
     updatedAt / boothAt / by, and NEVER re-stamp vstream.at (the share
     publisher supervisor owns it, proof-based).
   - Lead lock (mwLeadLock): payload._lead = {tab, base}; base is the
     stored row version this tab last based a save on. A takeover rides
     _lead.take = true and is only armed for 15 s after takeControl()
     fetched the row's real updated_at. A mirror booth (another tab
     holds a fresh lead) writes NOTHING except a fresh pad hit.
   - The booth heartbeat (10 s) re-saves while this tab leads and the
     station is live or the booth is on screen.

   The pure decision logic (lead freshness, FX broadcast caps, the queue
   draw, the stall-watchdog ladder, the dead-air gate, the blend /
   preload windows) is exported bare so the harness can pin it against
   the live constants without a DOM.
   ============================================================================ */
import { mergeState as mergeViewerState, posOf } from "./station.js";

/* the video token parse (live vparseTok, also in engine.js): bare =
   YouTube, dm: Dailymotion, vm: Vimeo */
const vparseTok = (tok) => { tok = String(tok || ""); if (tok.indexOf("dm:") === 0) return { p: "dm", id: tok.slice(3) }; if (tok.indexOf("vm:") === 0) return { p: "vm", id: tok.slice(3) }; return { p: "yt", id: tok }; };

export const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
export const ROT = { A: "B", B: "C", C: "D", D: "A" };

/* ---- live constants (dj.js @ ebc7da70 — do not retune) ---- */
export const LEAD_FRESH_MS = 20000;      // leadFresh(): now − leadAt < 20 s
export const TAKE_WINDOW_MS = 15000;     // a take stamp is honored 15 s
export const SAVE_DEBOUNCE_MS = 250;     // save() debounce
export const HEARTBEAT_MS = 10000;       // booth heartbeat save cadence
export const BLEND_LEAD_S = 5;           // handover window: remaining ∈ (0.3, 5]
export const PRELOAD_LO_S = 5;           // preload window: remaining ∈ (5, 15]
export const PRELOAD_HI_S = 15;
export const STALL_MS = 5000;            // watchdog: no advance for 5 s
export const DA_SILENCE_MS = 10000;      // dead-air rescue: 10 s of silence
export const DA_LOAD_GRACE_MS = 12000;   // a landed load gets 12 s to sound
export const DA_ABSORB_MS = 20000;       // post-fire absorb
export const DA_BACKOFF_MS = 30000;      // between rescue attempts
export const DA_MAX_TRIES = 3;           // per silence episode
export const DELIBERATE_PAUSE_MS = 30 * 60 * 1000; // keeper-identical
export const HANDOVER_STUCK_MS = 20000;  // a latch older than this is taken over

/* The station drop rotation (owner, 2026-10-29 — verbatim from live
   dj.js; the welcome line is his own dictation). One line per 3rd
   AUTOMATED transition; a drop replaces the pads[0] station ID. */
export const DROP_TEXTS = [
  "Welcome to Meechie's World. You are now tuned in to the live DJ. Please stay tuned in — make sure you put in your song that you want to hear, and we'll play it as soon as possible.",
  "Go check out the shop at Meechies World Inc dot com — new drops and fresh gear. More than clothing, it is a movement.",
  "Pull up Meechie's Book and say what's up — the community is live right now.",
  "Take the radio with you — get the Meechie's World apps and listen anywhere.",
  "Feeling lucky? The Coin Jackpot is open — play fair, win real coins.",
];

/* ---- booth-full state normalization: station.mergeState (viewer
   subset) plus the booth-only fields with their live defaults ---- */
export function mergeBooth(d) {
  const m = mergeViewerState(d);
  m.battle = Object.assign({
    on: false, id: "", p1: { uid: "", name: "" }, p2: { uid: "", name: "" },
    round: 1, rounds: 3, turnSec: 90, turn: "", turnEndsAt: 0,
    phase: "off", winner: "", at: 0, lastWrite: 0,
  }, m.battle || {});
  if (!Array.isArray(m.pads)) m.pads = [];
  if (!Array.isArray(m.pool)) m.pool = [];
  if (!Array.isArray(m.bag)) m.bag = [];
  if (!m.qStock || typeof m.qStock !== "object") m.qStock = {};
  m.dropsOn = m.dropsOn !== false;
  m.dropN = +m.dropN || 0; m.dropIx = +m.dropIx || 0;
  m.aiDj = m.aiDj !== false;               // AI-DJ kill switch, default ON (PR #407)
  m.aiDjAt = +m.aiDjAt || 0;
  m.leadTab = String(m.leadTab || ""); m.leadAt = +m.leadAt || 0;
  m.liveSince = +m.liveSince || 0;
  m.padHit = m.padHit || null;
  return m;
}

/* ---- lead lock (pure) ---- */
export const leadFreshAt = (leadAt, now) => !!leadAt && (now - leadAt) < LEAD_FRESH_MS;
export const isMirror = (S, tabId, now) => leadFreshAt(S && S.leadAt, now) && !!S.leadTab && S.leadTab !== tabId;
export const takeFresh = (takeAt, now) => !!takeAt && (now - takeAt) < TAKE_WINDOW_MS;

/* ---- FX broadcast caps (live applyFx — the caps are law) ----
   Input: S.fx. Output: the wet levels and curve values the audio
   engine actually applies. */
export function fxCaps(fx) {
  const f = fx || {};
  const v = (x, d) => { const n = +x; return isFinite(n) ? n : d; };
  return {
    verbWet: Math.min(v(f.verb, 0), 0.30),
    flaWet: Math.min(v(f.fla, 0), 0.25) * 0.8,
    phaWet: Math.min(v(f.pha, 0), 0.3) * 0.9,
    noiseWet: Math.min(v(f.noise, 0), 0.5) * 0.5,
    noiseFreq: 400 + Math.min(v(f.noise, 0), 0.5) * 5200,
    crushCurve: Math.min(v(f.crush, 0), 12),
    filterFreq: 200 * Math.pow(90, v(f.mf, 100) / 100),
    echoFb: v(f.fb, 0.34),
    gate: v(f.gate, 0),
  };
}
/* The crush waveshaper curve steps (live setCrushCurve) */
export const crushSteps = (v) => Math.pow(2, Math.max(1.5, 8 - (Math.min(v, 12) / 100) * 6.5));

/* ---- queue draw: shuffle by random splice — no repeats until the
   queue empties (live drawQueueItem) ---- */
export const drawIndex = (len, r) => (len <= 0 ? -1 : Math.min(len - 1, Math.floor((r == null ? Math.random() : r) * len)));
export function drawFromQueue(queue, r) {
  if (!queue || !queue.length) return null;
  const i = drawIndex(queue.length, r);
  return queue.splice(i, 1)[0];
}

/* ---- queue stocking records (live qKeyOf / qStockValid) ---- */
export function qKeyOf(x) {
  if (!x) return "";
  if (x.src) return "s:" + x.src;
  if (x.yt) { const t = vparseTok(x.yt); return (t.p === "yt" ? "y:" : t.p + ":") + t.id; }
  return "";
}
export const stockValid = (rec, deck) => !!rec && !!deck && !deck.playing && qKeyOf(rec) !== "" && qKeyOf(rec) === qKeyOf(deck);

/* ---- automation windows (live booth tick) ---- */
export const blendDue = (rem) => rem > 0.3 && rem <= BLEND_LEAD_S;
export const preloadDue = (rem) => rem > PRELOAD_LO_S && rem <= PRELOAD_HI_S;
/* voice drops: after the increment, every 3rd automated transition */
export const dropDue = (dropN) => dropN > 0 && dropN % 3 === 0;

/* ---- corpse check (live save guard / deckEnded veto) ---- */
export const isCorpse = (S, k, nowLocal) => { const s = S && S[k]; return !!(s && s.playing && +s.dur > 0 && posOf(S, k, nowLocal) > +s.dur + 15); };

/* ---- the position-based stall watchdog (live mwStallWatchdog) ----
   Pure step: mem is the per-deck memory {key,pos,adv,act,step,reloads};
   obs is one 500 ms sample. Returns {mem, action} with action one of
   "none" | "kick" | "reload" | "handover". A stall after one reload in
   the same play skips the reload rung straight to handover. */
export function stallStep(mem, obs) {
  const m = Object.assign({ key: "", pos: 0, adv: 0, act: 0, step: 0, reloads: 0 }, mem || {});
  const now = obs.now;
  if (!obs.playing || obs.pausedAt) { return { mem: { key: obs.key || "", pos: obs.pos || 0, adv: now, act: now, step: 0, reloads: 0 }, action: "none" }; }
  if (obs.key !== m.key) { return { mem: { key: obs.key, pos: obs.pos || 0, adv: now, act: now, step: 0, reloads: 0 }, action: "none" }; }
  if (Math.abs((obs.pos || 0) - m.pos) >= 0.25) { m.pos = obs.pos; m.adv = now; m.step = 0; return { mem: m, action: "none" }; }
  m.pos = obs.pos;
  if (obs.excluded) { m.act = now; return { mem: m, action: "none" }; } // seeking / noSync / scratch / runout / ended
  if (now - m.adv < STALL_MS || now - m.act < STALL_MS) return { mem: m, action: "none" };
  if (m.step === 0) { m.step = 1; m.act = now; return { mem: m, action: "kick" }; }
  if (m.step === 1 && m.reloads < 1) { m.step = 2; m.reloads++; m.act = now; return { mem: m, action: "reload" }; }
  return { mem: m, action: "handover" };
}

/* ---- the dead-air rescue gate (live mwDeadAirRescue, 1 s tick) ----
   Pure decision: st is the rescue memory {silenceAt, loadAt, tries,
   absorbUntil, lastTry, sig}; obs is the gate sample. Returns
   {fire, reason, st}. A live share is tables-paused BY DESIGN, never
   dead air; a deliberate pause is respected for 30 minutes. */
export function daGate(st, obs) {
  const s = Object.assign({ silenceAt: 0, loadAt: 0, tries: 0, absorbUntil: 0, lastTry: 0, sig: "" }, st || {});
  const now = obs.now;
  const reset = (reason) => ({ fire: false, reason, st: { silenceAt: 0, loadAt: 0, tries: 0, absorbUntil: s.absorbUntil, lastTry: s.lastTry, sig: obs.sig || "" } });
  if (obs.sandbox || !obs.owner || !obs.lead || obs.mirror) return reset("not-driver");
  if (!obs.live || !obs.autodj) return reset("not-armed");
  if (obs.shareOn) return reset("share-live");
  if (obs.sounding) return reset("sounding");
  if (obs.pausedAt && now - obs.pausedAt < DELIBERATE_PAUSE_MS) return reset("deliberate-pause");
  if (obs.sig !== s.sig) { // a load landed: restart the silence clock (outside absorb)
    // the FIRST observation only arms — it is not a load, and must not
    // buy the 12 s load grace, or every rescue starts 12 s late
    if (s.sig) { s.loadAt = now; if (now >= s.absorbUntil) { s.silenceAt = now; s.tries = 0; } }
    s.sig = obs.sig;
  }
  if (!s.silenceAt) s.silenceAt = now;
  if (obs.handoverAge != null && obs.handoverAge < HANDOVER_STUCK_MS) return { fire: false, reason: "handover-busy", st: s };
  if (now - s.silenceAt < DA_SILENCE_MS) return { fire: false, reason: "silence-short", st: s };
  if (now - s.loadAt < DA_LOAD_GRACE_MS && s.loadAt) return { fire: false, reason: "load-grace", st: s };
  if (s.tries >= DA_MAX_TRIES) return { fire: false, reason: "tries-spent", st: s };
  if (s.lastTry && now - s.lastTry < DA_BACKOFF_MS) return { fire: false, reason: "backoff", st: s };
  s.tries++; s.lastTry = now; s.absorbUntil = now + DA_ABSORB_MS;
  return { fire: true, reason: "fire", st: s };
}

/* ============================================================================
   THE STORE — browser side. One per booth mount.
   opts: { sandbox, session, gateway, say, onDeckEnded }
   ============================================================================ */
export function createBoothStore(ctx, opts) {
  const gateway = ctx.gateway, session = ctx.session;
  const sandbox = !!(opts && opts.sandbox);
  const say = (opts && opts.say) || (() => {});
  let tabId = "";
  try {
    tabId = sessionStorage.getItem("mw-v2-tab");
    if (!tabId) { tabId = "t" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); sessionStorage.setItem("mw-v2-tab", tabId); }
  } catch (_) { tabId = "t" + Math.random().toString(36).slice(2, 10); }

  const me = () => { const u = session.user && session.user(); return u || null; };
  const isOwner = () => { const u = me(); return !!u && u.id === OWNER_ID; };

  let S = mergeBooth(null);
  let queue = [];
  try { queue = JSON.parse(localStorage.getItem("mw-dj-queue") || "[]"); if (!Array.isArray(queue)) queue = []; } catch (_) { queue = []; }
  let lastBaseAt = 0, leadTakeAt = 0, padSentAt = 0, saveT = null, hbT = null;
  let lastQueueEditAt = 0;

  if (sandbox) {
    try { const raw = sessionStorage.getItem("mw-playdj"); if (raw) S = mergeBooth(JSON.parse(raw)); } catch (_) {}
    S.queue = queue.slice();
  }

  const store = {
    get S() { return S; },
    get tabId() { return tabId; },
    get sandbox() { return sandbox; },
    isOwner,
    me,
    leadFresh() { return leadFreshAt(S.leadAt, Date.now()); },
    serverMirror() { return isMirror(S, tabId, Date.now()); },
    leadDrive() {
      if (!isOwner() && !sandbox) return false;
      if (sandbox) return true;
      if (this.leadFresh()) return S.leadTab === tabId;
      return boothLeadLocal;
    },
    /* Take control for real (live takeControl): fetch the row's real
       updated_at first so the server honors the take stamp, then the
       next save carries _lead.take. The base rides as the row's ISO
       updated_at STRING, verbatim — the server compares it to the
       stored column with strict equality (functions/api/cf leadLock:
       lead.base === row.updated_at), so a millisecond number could
       never match. The current live client sends the string; an
       earlier v2 build parsed it to a number, which would have made
       every v2 takeover a silent no-op — caught by the Phase 5
       server-acceptance audit and fixed here. */
    async takeControl() {
      try {
        const { data } = await gateway.rest({ table: "docs", select: "updated_at", filters: [["path", "eq", "radio/dj"]], limit: 1 });
        const iso = data && data[0] && data[0].updated_at;
        if (iso) lastBaseAt = String(iso);
      } catch (_) {}
      leadTakeAt = Date.now();
      boothLeadLocal = true;
      this.save(true);
    },
    /* Adopt a fresh remote snapshot (the station feed's S) under the
       live echo rules: a mirror adopts whole; the lead keeps its decks
       and adopts the furniture other actors write (queue via the
       adopt-if-different rule, vstream / vcam / vmix / battle / log),
       plus the lead stamps so mirror math stays true. */
    adopt(remote) {
      if (sandbox || !remote) return;
      const r = mergeBooth(remote);
      if (this.serverMirror() || r.by === tabId) {
        if (r.by !== tabId) { S = r; adoptQueue(r, true); }
        return;
      }
      // we lead (or nobody does): furniture follows the server
      if (JSON.stringify(r.queue || []) !== JSON.stringify(S.queue || []) && Date.now() - lastQueueEditAt > 1000) adoptQueue(r, false);
      S.vstream = r.vstream; S.vcam = r.vcam; S.vmix = r.vmix; S.battle = r.battle;
      S.log = r.log; S.leadTab = r.leadTab; S.leadAt = r.leadAt;
      S.djGuest = r.djGuest; S.ticker = r.ticker; S.show = r.show;
      S.aiDj = r.aiDj; S.aiDjAt = r.aiDjAt;
      if (!this.leadFresh()) { S.boothAt = r.boothAt; S.updatedAt = r.updatedAt; }
    },
    /* ---- the queue mirror (live saveQueue) ---- */
    get queue() { return queue; },
    saveQueue() {
      lastQueueEditAt = Date.now();
      try { localStorage.setItem("mw-dj-queue", JSON.stringify(queue)); } catch (_) {}
      if (!sandbox && isOwner()) { S.queue = queue.slice(); this.save(); }
      else if (sandbox) { S.queue = queue.slice(); }
    },
    drawQueue(r) { const it = drawFromQueue(queue, r); if (it) this.saveQueuePaintOnly(); return it; },
    saveQueuePaintOnly() { try { localStorage.setItem("mw-dj-queue", JSON.stringify(queue)); } catch (_) {} if (!sandbox && isOwner()) { S.queue = queue.slice(); this.save(); } },

    /* ---- save(): the live discipline, verbatim in structure ---- */
    save(immediate) {
      if (!sandbox && !isOwner()) return;
      // corpse guard first: never serialize a corpse over a rescue
      for (const k of ["A", "B", "C", "D"]) {
        if (isCorpse(S, k, Date.now())) {
          if (opts && opts.onDeckEnded && this.leadDrive()) { try { opts.onDeckEnded(k); } catch (_) {} }
          if (S[k].playing) S[k].playing = false;
        }
      }
      if (sandbox) {
        S.updatedAt = Date.now(); S.boothAt = Date.now();
        try { sessionStorage.setItem("mw-playdj", JSON.stringify(S)); } catch (_) {}
        this.guestRelay();
        return;
      }
      clearTimeout(saveT);
      const run = () => {
        S.updatedAt = Date.now(); S.boothAt = Date.now(); S.by = tabId;
        // saves NEVER re-stamp vstream.at — the publisher supervisor owns it
        const payload = JSON.parse(JSON.stringify(S));
        const taking = takeFresh(leadTakeAt, Date.now());
        if (this.serverMirror() && !taking) {
          if (S.padHit && (S.padHit.at || 0) > padSentAt) {
            padSentAt = S.padHit.at; lastBaseAt = S.updatedAt;
            gateway.call("rpc", { name: "set_doc", args: { p_path: "radio/dj", p_coll: "radio", p_data: payload } }).catch(() => {});
          }
          return;
        }
        payload._lead = { tab: tabId, base: lastBaseAt || 0 };
        if (taking) { payload._lead.take = true; leadTakeAt = 0; }
        lastBaseAt = S.updatedAt;
        gateway.call("rpc", { name: "set_doc", args: { p_path: "radio/dj", p_coll: "radio", p_data: payload } })
          .then((j) => { if (j && j.error) say(j.error.message || "Save failed."); }).catch(() => {});
      };
      if (immediate) run(); else saveT = setTimeout(run, SAVE_DEBOUNCE_MS);
    },

    /* ---- guest DJ relay (live guestRelay): a granted guest's table
       drives the radio through the keeper's POST relay, never the doc */
    _relayAt: 0,
    guestRelay() {
      let on = false;
      try { on = sessionStorage.getItem("mw-guestlive") === "1"; } catch (_) {}
      if (!on) return;
      const now = Date.now();
      if (now - this._relayAt < 2500) return;
      this._relayAt = now;
      const s = (session.get && session.get()) || null;
      fetch("/api/station", {
        method: "POST",
        headers: { "content-type": "application/json", ...(s && s.access_token ? { authorization: "Bearer " + s.access_token } : {}) },
        body: JSON.stringify({ kind: "guestdj", A: S.A, B: S.B, C: S.C, D: S.D, xf: S.xf, xf2: S.xf2, panX: S.panX, panY: S.panY, fx: S.fx, hornOn: S.hornOn, voice: S.voice }),
      }).then((r) => r.json()).then((j) => {
        if (j && j.ok === false) { try { sessionStorage.removeItem("mw-guestlive"); } catch (_) {} say("Your live slot has ended."); }
      }).catch(() => {});
    },

    /* ---- brain capture (live brainFlush): batched events, owner +
       lead only, never in the sandbox ---- */
    _brainQ: [], _brainT: null,
    brainEmit(ev) {
      if (sandbox || !isOwner() || !this.leadDrive()) return;
      this._brainQ.push(ev);
      clearTimeout(this._brainT);
      this._brainT = setTimeout(() => {
        const batch = this._brainQ.splice(0, this._brainQ.length);
        if (!batch.length) return;
        const s = (session.get && session.get()) || null;
        fetch("/api/brain/event", {
          method: "POST", keepalive: true,
          headers: { "content-type": "application/json", ...(s && s.access_token ? { authorization: "Bearer " + s.access_token } : {}) },
          body: JSON.stringify({ events: batch }),
        }).catch(() => {});
      }, 800);
    },

    /* ---- heartbeat: the lead booth re-saves every 10 s while live
       or on screen (live booth heartbeat) ---- */
    startHeartbeat(isBoothVisible) {
      clearInterval(hbT);
      hbT = setInterval(() => {
        if (sandbox || !isOwner()) return;
        if (this.leadDrive() && (S.live || isBoothVisible())) this.save(true);
      }, HEARTBEAT_MS);
    },
    destroy() { clearInterval(hbT); clearTimeout(saveT); clearTimeout(this._brainT); },
  };

  let boothLeadLocal = false;
  function adoptQueue(r, whole) {
    const rq = Array.isArray(r.queue) ? r.queue : [];
    if (JSON.stringify(rq) !== JSON.stringify(queue)) {
      queue = rq.slice();
      try { localStorage.setItem("mw-dj-queue", JSON.stringify(queue)); } catch (_) {}
    }
    if (whole) S.queue = queue.slice();
  }
  return store;
}
