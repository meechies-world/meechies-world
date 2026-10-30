/* ============================================================================
   v2 STATION-STATE — the typed state layer for the shared `radio/dj`
   document (MAP §4.3), READ PATH ONLY for Phase 2.

   Owns: the schema (field names, types, defaults — the live mergeState
   normalization, viewer subset), the position rules (posOf on the local
   clock for time displays; bcastPos on the server-corrected broadcast
   clock for every picture — the sync-lock law: ONE broadcast clock),
   the gain math (stageGain / xfGain / pairXGain, the fader law of
   Law 7), and the vmix target rules. Every viewer surface reads the
   station through here; no surface keeps its own copy of the math.

   The feed: one shared subscription for the whole tab. It reads the
   SAME live `radio/dj` doc through the shell gateway — an immediate
   read on first subscribe, then the changes-feed pattern of MAP §4.4
   (poll the public `changes` rows; a radio/dj row triggers a doc
   re-read), a 30 s safety re-read, and a plain doc-poll fallback if
   the changes read ever fails. It NEVER writes radio/dj (viewer
   surfaces never write it — Law: read path first).

   The broadcast clock offset (clockOff) is learned from the shell
   presence pings (/api/station answers `now`) with the live site's
   own smoothing (0.7 old + 0.3 new), exactly as dj.js learns it.
   ============================================================================ */

export const DECKS = ["A", "B", "C", "D"];
export const PAIR = { A: "B", B: "A", C: "D", D: "C" };

export const defFx = () => ({ mf: 100, echo: 0, fb: 0.34, verb: 0, fla: 0, pha: 0, noise: 0, ediv: 0.75, gate: 0, crush: 0, sync: true, boost: 1 });
export const blankDeck = () => ({ src: "", yt: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1, dur: 0, bpm: 0, beat0: 0, key: "", cam: "", vcut: false, bcut: false, loop: null, loopBeats: 0, cues: null });

const num = (v, d) => { const n = +v; return isFinite(n) ? n : d; };

/* The live mergeState normalization, viewer subset: a raw snapshot is
   never trusted for types — decks, fx, vmix, vstream, vcam always come
   out whole, with the live defaults. */
export function mergeState(d) {
  const m = Object.assign({
    live: false, xf: 0.5, xf2: 0.5, panX: 0.5, panY: 0, xfCurve: "smooth",
    duck: false, quant: true, voice: null, liveSince: 0, ticker: "",
    log: [], show: null, queue: [], schedQ: [], aiQ: [], autodj: true,
    pausedAt: 0, boothAt: 0, updatedAt: 0, by: "", fxHornAt: 0, hornOn: false,
    djGuest: null, battle: null, fx: defFx(),
    vmix: { mode: "auto", a: "", b: "", t: 0, tr: "fade", trMs: 650, at: 0 },
    vfx: { kind: "", at: 0 },
    vcam: { on: false, at: 0 },
    vstream: { on: false, kind: "", at: 0, by: "", meeting: "", hidden: false, stopAt: 0, diag: null },
  }, d || {});
  for (const k of DECKS) {
    const s = Object.assign(blankDeck(), m[k] || {});
    s.playing = !!s.playing;
    s.pos = num(s.pos, 0); s.start = num(s.start, 0); s.dur = num(s.dur, 0);
    s.vol = s.vol == null ? 0.9 : num(s.vol, 0.9); s.rate = num(s.rate, 1) || 1;
    s.yt = String(s.yt || ""); s.src = String(s.src || ""); s.title = String(s.title || "");
    m[k] = s;
  }
  m.fx = Object.assign(defFx(), m.fx || {});
  m.vmix = Object.assign({ mode: "auto", a: "", b: "", t: 0, tr: "fade", trMs: 650, at: 0 }, m.vmix || {});
  m.vstream = Object.assign({ on: false, kind: "", at: 0, by: "", meeting: "", hidden: false, stopAt: 0, diag: null }, m.vstream || {});
  m.vstream.on = !!m.vstream.on; m.vstream.hidden = !!m.vstream.hidden;
  m.vcam = Object.assign({ on: false, at: 0 }, m.vcam || {});
  m.vfx = Object.assign({ kind: "", at: 0 }, m.vfx || {});
  if (!Array.isArray(m.log)) m.log = [];
  if (!Array.isArray(m.queue)) m.queue = [];
  if (!Array.isArray(m.schedQ)) m.schedQ = [];
  if (!Array.isArray(m.aiQ)) m.aiQ = [];
  m.live = !!m.live; m.autodj = m.autodj !== false;
  m.xf = num(m.xf, 0.5); m.xf2 = num(m.xf2, 0.5); m.panX = num(m.panX, 0.5); m.panY = num(m.panY, 0);
  /* the broadcast frame no longer rides inside radio/dj (live rule):
     a stale frame still sitting in the stored doc is ignored */
  delete m.vcam.frame; delete m.vcam.frameAt;
  return m;
}

/* ---- position rules ----
   posOf: the live rule verbatim (local clock) — time displays.
   bcastPos: the screens' clock — viewers ride the server-corrected
   basis (Date.now() + clockOff), the same basis syncDecks uses. */
export function posOf(S, k, nowLocal) {
  const s = S && S[k]; if (!s) return 0;
  return s.playing ? Math.max(0, (nowLocal - (s.start || nowLocal)) / 1000) : (s.pos || 0);
}
export function bcastPos(S, k, nowBcast) {
  const s = S && S[k]; if (!s) return 0;
  if (!s.playing) return s.pos || 0;
  return Math.max(0, (nowBcast - (s.start || nowBcast)) / 1000);
}

/* ---- fader law (Law 7): the same gain math the booth paints ---- */
export function xfGain(xf, side, curve) {
  const t = side === "A" ? xf : 1 - xf, c = Math.cos(t * Math.PI / 2);
  if (curve === "sharp") return Math.sqrt(Math.max(0, c));
  if (curve === "cut") return t < 0.5 ? 1 : (t > 0.5 ? 0 : 0.7071);
  return c;
}
export function pairXGain(px, cd) {
  const p = Math.min(1, Math.max(0, px == null ? 0.5 : px));
  return cd ? (p >= 0.5 ? 1 : Math.cos((0.5 - p) * Math.PI)) : (p <= 0.5 ? 1 : Math.cos((p - 0.5) * Math.PI));
}
export function stageGain(S, k) {
  const s = S[k], cd = k === "C" || k === "D", x = cd ? (S.xf2 ?? 0.5) : S.xf,
    side = k === "B" || k === "D" ? "B" : "A", py = S.panY || 0,
    pairG = cd ? (py < 0 ? 1 + py : 1) : (py > 0 ? 1 - py : 1);
  return (s.vol ?? 0.9) * xfGain(x, side, S.xfCurve || "smooth") * pairG * pairXGain(S.panX, cd);
}
export const boostMk = (S) => Math.min(1.5, Math.max(1, +(S.fx && S.fx.boost) || 1));

/* ---- the mix the master screens show (live vmixTargets, verbatim) ---- */
export function vmixTargets(S) {
  const vm = S.vmix || { mode: "auto", a: "", b: "", t: 0 };
  if (vm.mode === "man" && vm.a && S[vm.a] && S[vm.a].yt) {
    const t = Math.max(0, Math.min(1, +vm.t || 0)), out = [{ k: vm.a, op: 1 - t }];
    if (vm.b && S[vm.b] && S[vm.b].yt && S[vm.b].yt !== S[vm.a].yt) out.push({ k: vm.b, op: t });
    return out.filter((x) => x.op > 0.01);
  }
  const gs = DECKS.filter((k) => S[k].yt && S[k].playing).map((k) => ({ k, g: stageGain(S, k) })).filter((x) => x.g > 0.02).sort((a, b) => b.g - a.g).slice(0, 2);
  if (!gs.length) return [];
  const sum = gs.reduce((a, x) => a + x.g, 0) || 1;
  return gs.map((x) => ({ k: x.k, op: Math.max(0.02, x.g / sum) }));
}

/* SHARING = LIVE (Law 2): a live stream switch lights every LIVE
   surface, radio switch or not. */
export const vsBroadcast = (S) => !!((S.vstream || {}).on && (S.vstream || {}).meeting);
export const stationLive = (S) => !!(S.live || (vsBroadcast(S) && !(S.vstream || {}).hidden));

export const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ============================================================================
   THE FEED — one shared read subscription per tab.
   getFeed(ctx) is a singleton: the first viewer surface to ask starts
   it; every later surface shares it. Subscribers are called on every
   new snapshot (and once immediately with the current state).
   ============================================================================ */
let _feed = null;
export function getFeed(ctx) { if (!_feed) _feed = createFeed(ctx); return _feed; }

export function createFeed(ctx) {
  const gateway = ctx.gateway, presence = ctx.presence;
  const subs = new Set();
  let S = mergeState(null);
  let seen = false;
  let clockOff = 0;
  let timer = null, safety = null;
  let lastSeq = 0, changesOk = true, changesErrs = 0;
  let stopped = false;

  function learnClock() {
    try {
      const j = presence && presence.last;
      if (j && j.now) clockOff = clockOff * 0.7 + (j.now - Date.now()) * 0.3;
    } catch (_) {}
  }
  function emit() { subs.forEach((fn) => { try { fn(S); } catch (_) {} }); }
  async function readDocNow() {
    const d = await gateway.readStation().catch(() => null);
    if (stopped) return;
    if (d) { S = mergeState(d); seen = true; learnClock(); emit(); }
  }
  async function pollChanges() {
    if (stopped) return;
    if (!changesOk) { await readDocNow(); return; }
    try {
      const { data, error } = await gateway.rest({
        table: "changes", select: "seq,tbl,path,coll",
        filters: [["seq", "gt", lastSeq]], limit: 50,
      });
      if (error) throw new Error("changes");
      const rows = Array.isArray(data) ? data : [];
      let hit = false;
      for (const r of rows) {
        if (+r.seq > lastSeq) lastSeq = +r.seq;
        if (r.tbl === "docs" && r.path === "radio/dj") hit = true;
      }
      changesErrs = 0;
      if (hit) await readDocNow(); else learnClock();
    } catch (_) {
      changesErrs++;
      if (changesErrs >= 2) changesOk = false; // degrade to the doc poll
      await readDocNow();
    }
  }
  return {
    get S() { return S; },
    get seen() { return seen; },
    get clockOff() { return clockOff; },
    nowLocal() { return Date.now(); },
    nowBcast() { return Date.now() + clockOff; },
    subscribe(fn) {
      subs.add(fn);
      if (seen) { try { fn(S); } catch (_) {} }
      if (!timer) {
        readDocNow();
        timer = setInterval(pollChanges, 2500);
        safety = setInterval(readDocNow, 30000);
      }
      return () => { subs.delete(fn); };
    },
    /* the camera-frame doc rides beside the station doc (live rule:
       frames live in radio/camframe, never inside radio/dj) */
    readCamFrame() { return gateway.readDoc("radio/camframe").catch(() => null); },
    refresh: readDocNow,
  };
}
