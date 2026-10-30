/* ============================================================================
   v2 HARNESS — Phase 1b checks (run: node v2/harness/check.mjs from repo root)
   1. Syntax: node --check every v2 JS module (via .mjs temp copies so ES
      module syntax parses as modules).
   2. Boot budget (MAP §4.1/§4.5): report raw + gzip sizes of the shell's
      first load (index.html + css/shell.css + js/core.js) and assert the
      core JS stays under the 60 KB transfer budget. Also report the home
      view's lazy payload separately — it must NOT count against the shell.
   Exits non-zero on any failure.
   ============================================================================ */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const V2 = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ---- 1. syntax ---- */
const jsFiles = walk(join(V2, "js")).filter((f) => f.endsWith(".js"));
const tmp = mkdtempSync(join(tmpdir(), "v2check-"));
for (const f of jsFiles) {
  const t = join(tmp, f.replaceAll("/", "_") + ".mjs");
  writeFileSync(t, readFileSync(f));
  try {
    execFileSync(process.execPath, ["--check", t], { stdio: "pipe" });
    console.log("  ok  syntax", f.slice(V2.length + 1));
  } catch (e) {
    failed++;
    console.log("FAIL  syntax", f.slice(V2.length + 1));
    console.log(String(e.stderr || e));
  }
}
rmSync(tmp, { recursive: true, force: true });

/* ---- 2. byte report ---- */
function size(rel) {
  const buf = readFileSync(join(V2, rel));
  return { raw: buf.length, gz: gzipSync(buf, { level: 9 }).length };
}
const kb = (n) => (n / 1024).toFixed(1) + " KB";
const shellFiles = ["index.html", "css/shell.css", "js/core.js"];
const homeFiles = ["css/home.css", "js/views/home.js", "js/views/placeholder.js"];
console.log("\nShell first load (what every visitor pays, on every view):");
let shellGz = 0, shellRaw = 0, coreJsGz = 0;
for (const f of shellFiles) {
  const s = size(f);
  shellGz += s.gz; shellRaw += s.raw;
  if (f === "js/core.js") coreJsGz = s.gz;
  console.log(`  ${f.padEnd(16)} raw ${kb(s.raw).padStart(9)}   gzip ${kb(s.gz).padStart(9)}`);
}
console.log(`  ${"TOTAL".padEnd(16)} raw ${kb(shellRaw).padStart(9)}   gzip ${kb(shellGz).padStart(9)}`);
console.log("\nHome view lazy payload (loads only when Home is first entered):");
let homeGz = 0;
for (const f of homeFiles) {
  const s = size(f);
  homeGz += s.gz;
  console.log(`  ${f.padEnd(24)} raw ${kb(s.raw).padStart(9)}   gzip ${kb(s.gz).padStart(9)}`);
}
console.log(`  ${"TOTAL".padEnd(24)} gzip ${kb(homeGz).padStart(9)}`);

const BUDGET = 60 * 1024;
console.log(`\nBoot budget: core JS transfer (gzip) ${kb(coreJsGz)} vs budget ${kb(BUDGET)} — ${coreJsGz <= BUDGET ? "PASS" : "FAIL"}`);
if (coreJsGz > BUDGET) failed++;

/* ---- 2b. Phase 2 viewer payload — the engine and its surfaces load
   ONLY when a viewer view (radio / mwtv / watch) is first entered.
   The home view never imports them; this is the byte proof. ---- */
const p2Files = [
  "js/station.js", "js/engine.js", "js/mini.js",
  "js/views/radio.js", "js/views/mwtv.js", "js/views/watch.js",
  "css/engine.css", "css/radio.css", "css/mwtv.css", "css/watch.css",
];
console.log("\nPhase 2 viewer payload (lazy — first viewer view only, never on Home):");
let p2Gz = 0, p2Raw = 0;
for (const f of p2Files) {
  try {
    const s = size(f);
    p2Gz += s.gz; p2Raw += s.raw;
    console.log(`  ${f.padEnd(24)} raw ${kb(s.raw).padStart(9)}   gzip ${kb(s.gz).padStart(9)}`);
  } catch (_) { failed++; console.log("FAIL  missing", f); }
}
console.log(`  ${"TOTAL".padEnd(24)} raw ${kb(p2Raw).padStart(9)}   gzip ${kb(p2Gz).padStart(9)}`);
const homeSrc = readFileSync(join(V2, "js/views/home.js"), "utf8");
const coreSrc = readFileSync(join(V2, "js/core.js"), "utf8");
const homePaysForEngine = /engine\.js|station\.js|mini\.js/.test(homeSrc) ||
  /from\s+["']\.\/(station|engine|mini)\.js/.test(coreSrc);
console.log(`Home view imports the engine/station/mini: ${homePaysForEngine ? "YES — FAIL" : "no — PASS"}`);
if (homePaysForEngine) failed++;

console.log("\nLive comparison (main 1be5b8fe): index.html 180,268 B + 45 JS files" +
  " (~478 KB transfer) + 100 KB CSS load on EVERY view, DJ booth included.");

/* ---- 3. inventory ---- */
console.log("\nv2 file inventory:");
for (const f of walk(V2).sort()) console.log("  " + f.slice(V2.length + 1));

/* ---- 4. Phase 2 engine fixtures --------------------------------
   The pure logic of the player engine, the station feed and the mini
   gates, run against the live site's shipped rules (PRs
   #404/#408/#410). DOM rendering itself is not fixture-able in node;
   the mask COVER decision (bufStep) and the mini gate math are — that
   is what these pin. */
console.log("\n--- Phase 2 engine fixtures ---");
let fixPass = 0, fixFail = 0;
function eq(name, got, want) {
  const okEq = JSON.stringify(got) === JSON.stringify(want);
  if (okEq) fixPass++; else { fixFail++; console.log(`FIXTURE FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) fixPass++; else { fixFail++; console.log("FIXTURE FAIL ", name); } }

const eng = await import("../js/engine.js");
const stn = await import("../js/station.js");
const mni = await import("../js/mini.js");

/* the NO-SKIP cushion: the exact config object the live site builds
   its HLS players with (dj.js vsShowHls + obs.js attachHls, identical
   at both sites) — compared key-sorted so order cannot false-fail */
function canon(o) { return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])); }
eq("HLS cushion = live #404 values", canon(eng.HLS_CUSHION), canon({
  maxBufferLength: 90, maxMaxBufferLength: 120, backBufferLength: 60,
  liveSyncDurationCount: 8, liveMaxLatencyDurationCount: 24, maxLiveSyncPlaybackRate: 1.5,
  fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 1000,
  levelLoadingMaxRetry: 6, levelLoadingRetryDelay: 1000,
  manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 1000,
}));
eq("vparseTok dm", eng.vparseTok("dm:abc"), { p: "dm", id: "abc" });
eq("vparseTok yt", eng.vparseTok("abc"), { p: "yt", id: "abc" });

/* the two-clock sync lock — thresholds never retuned */
eq("sync deadband", eng.syncLockCalc(0.05, 1), { act: "none", rate: 1 });
eq("sync nudge slow (ahead)", eng.syncLockCalc(0.2, 1), { act: "nudge", rate: 0.95 });
eq("sync nudge fast (behind)", eng.syncLockCalc(-0.2, 1), { act: "nudge", rate: 1.05 });
eq("sync snap", eng.syncLockCalc(0.5, 1), { act: "snap", rate: 1 });
eq("sync DM x3 widens nudge", eng.syncLockCalc(0.5, 3).act, "nudge");
eq("sync DM x3 still snaps past", eng.syncLockCalc(1.2, 3).act, "snap");

/* bufStep — the mask cover decision (live #408):
   BUFFERING masks at once; a frozen clock masks past 1.2s; the lift
   needs 800ms of ACCUMULATED clean play, so one flap sample does not
   restart the wait, but a dirty stretch over 400ms wipes it. */
function bs() { return {}; }
let sl = bs(); eng.bufStep(sl, 3, 0, 10, true, 1000);
ok("BUFFERING masks immediately", sl._bMask === true && sl._bufSince === 1000);
sl = bs(); eng.bufStep(sl, 1, 5, 10, true, 1000000); eng.bufStep(sl, 1, 5, 10, true, 1001300);
ok("frozen clock masks past 1.2s", sl._bMask === true);
sl = bs(); eng.bufStep(sl, 3, 0, 10, true, 0);
/* clean, one flap, clean, clean — accumulated clean reaches 800ms */
eng.bufStep(sl, 1, 0.7, 10, true, 200);
eng.bufStep(sl, 3, 0.7, 10, true, 300);
eng.bufStep(sl, 1, 1.4, 10, true, 400);
ok("flap has not lifted the mask yet", sl._bMask === true);
eng.bufStep(sl, 1, 2.1, 10, true, 1200);
ok("flap-tolerant lift at 800ms accumulated clean", sl._bMask === false);
sl = bs(); eng.bufStep(sl, 3, 0, 10, true, 0);
eng.bufStep(sl, 1, 0.7, 10, true, 700);
eng.bufStep(sl, 1, 1.4, 10, true, 1400);
eng.bufStep(sl, 3, 1.4, 10, true, 2100);
eng.bufStep(sl, 1, 2.1, 10, true, 4200); /* dirty stretch 2100ms > 400ms wiped the 700ms banked */
ok("long dirty stretch wipes accumulated clean", sl._bMask === true);
eng.bufStep(sl, 1, 2.8, 10, true, 4900); eng.bufStep(sl, 1, 3.5, 10, true, 5600);
ok("mask lifts again after a fresh 800ms clean", sl._bMask === false);
sl = bs(); sl._bMask = true; eng.bufStep(sl, 1, 0, 10, true, 1000);
ok("masked slot may re-lock once when >2s off", sl._maskSnap === true);
eng.bufStep(sl, 1, 0, 10, true, 1700);
ok("mask snap is spent on the next pass", sl._maskSnap === false);

/* vmixTargets — blend follow, from the live stageGain math */
let S = stn.mergeState({ live: true, xf: 0, xf2: 0.5, panX: 0.5, A: { yt: "a1", playing: true, vol: 1 }, B: { yt: "b1", playing: true, vol: 1 } });
eq("fader hard A: only A shows", stn.vmixTargets(S), [{ k: "A", op: 1 }]);
S = stn.mergeState({ live: true, xf: 0.5, xf2: 0.5, panX: 0.5, A: { yt: "a1", playing: true, vol: 1 }, B: { yt: "b1", playing: true, vol: 1 } });
const midT = stn.vmixTargets(S);
ok("fader center: A and B blend 50/50", midT.length === 2 && Math.abs(midT[0].op - 0.5) < 0.01 && Math.abs(midT[1].op - 0.5) < 0.01);
S = stn.mergeState({ live: true, vmix: { mode: "man", a: "C", b: "D", t: 0.25, tr: "fade", trMs: 650, at: 0 }, C: { yt: "c1" }, D: { yt: "d1" } });
eq("manual vmix t blend", stn.vmixTargets(S), [{ k: "C", op: 0.75 }, { k: "D", op: 0.25 }]);
S = stn.mergeState(null);
ok("mergeState defaults: vmix auto, fx.fb 0.34", S.vmix.mode === "auto" && S.fx.fb === 0.34 && S.A.playing === false);
S = stn.mergeState({ A: { yt: "a1", playing: true, start: 1000000 } });
eq("bcastPos runs off the deck start stamp", stn.bcastPos(S, "A", 1005000), 5);

/* the mini gates (live #410): it renders even while hidden, steps
   aside only for its four reasons, the proof gate is bounded, and
   the buffer step-aside restores only on real play evidence. */
const T0 = 1000000;
function minIn(over) {
  return Object.assign({ vid: "v1", hasTargets: true, shareOn: false, shareHidden: false, sessOff: false, stageInView: false, onTV: false, boothOn: false, shareFlowing: false, popReady: false, camOn: false, now: T0 }, over || {});
}
let ms = mni.newMiniState(); ms.okVid = "v1";
eq("mini shows when proven", mni.miniStep(ms, minIn()), { show: true, hidden: false, render: true });
eq("stage in view: steps aside but STILL RENDERS", mni.miniStep(ms, minIn({ stageInView: true })), { show: false, hidden: true, render: true });
eq("user close: hidden but still renders", mni.miniStep(ms, minIn({ sessOff: true })), { show: false, hidden: true, render: true });
eq("MW TV page: steps aside, still renders", mni.miniStep(ms, minIn({ onTV: true })), { show: false, hidden: true, render: true });
eq("booth on screen: steps aside, still renders", mni.miniStep(ms, minIn({ boothOn: true })), { show: false, hidden: true, render: true });
eq("nothing to mirror: no render", mni.miniStep(ms, minIn({ hasTargets: false })), { show: false, hidden: true, render: false });
ms = mni.newMiniState(); ms.lastVid = "v0"; ms.errVid = "v0"; /* error-latched outgoing: no grace */
ok("unproven vid is gate-hidden", mni.miniStep(ms, minIn()).hidden === true);
ok("proof gate still holds at 20s", mni.miniStep(ms, minIn({ now: T0 + 20000 })).hidden === true);
ok("proof gate is BOUNDED: force-show past 20s", mni.miniStep(ms, minIn({ now: T0 + 20001 })).hidden === false);
ms = mni.newMiniState(); mni.miniMarkOk(ms, "v1");
eq("durable proof shows at once", mni.miniStep(ms, minIn()), { show: true, hidden: false, render: true });
ms = mni.newMiniState(); ms.lastVid = "v1"; ms.errVid = "v1";
ok("error-latched vid stays hidden past the gate", mni.miniStep(ms, minIn({ now: T0 + 999999 })).hidden === true);
ms = mni.newMiniState(); ms.lastVid = "v0"; /* clean outgoing: the 18s grace opens */
ok("clean change opens grace (no hide)", mni.miniStep(ms, minIn()).hidden === false);
ok("share pop-out shows when flowing + ready", mni.miniStep(mni.newMiniState(), minIn({ hasTargets: false, shareOn: true, shareFlowing: true, popReady: true })).show === true);
ok("hidden share never pops out", mni.miniStep(mni.newMiniState(), minIn({ hasTargets: false, shareOn: true, shareHidden: true, shareFlowing: true, popReady: true })).hidden === true);
ms = mni.newMiniState(); ms.okVid = "v1";
eq("buffering steps the mini aside", mni.miniPost(ms, { vid: "v1", show: true, hidden: false, bufMasked: true, topErr: false, topSawPlay: false, topState1: false, now: T0 }), { hidden: true });
ok("aside still holds at 15s", mni.miniPost(ms, { vid: "v1", show: true, hidden: true, bufMasked: true, topErr: false, topSawPlay: false, topState1: false, now: T0 + 15000 }).hidden === true);
eq("aside restores past 15s on play evidence", mni.miniPost(ms, { vid: "v1", show: true, hidden: true, bufMasked: true, topErr: false, topSawPlay: true, topState1: true, now: T0 + 15001 }), { hidden: false });
ms = mni.newMiniState(); ms.okVid = "v1";
mni.miniPost(ms, { vid: "v1", show: false, hidden: true, bufMasked: true, topErr: false, topSawPlay: false, topState1: false, now: T0 });
ok("aside never restores over a step-aside", mni.miniPost(ms, { vid: "v1", show: false, hidden: true, bufMasked: true, topErr: false, topSawPlay: true, topState1: true, now: T0 + 15001 }).hidden === true);
ms = mni.newMiniState();
mni.miniPost(ms, { vid: "v1", show: true, hidden: false, bufMasked: false, topErr: true, topSawPlay: false, topState1: false, now: T0 });
ok("slot error latches the vid", ms.errVid === "v1");
mni.miniPost(ms, { vid: "v1", show: true, hidden: false, bufMasked: false, topErr: false, topSawPlay: true, topState1: true, now: T0 + 700 });
ok("play evidence proves the vid and clears the latch", ms.okVid === "v1" && ms.errVid === "");

console.log(`fixtures: ${fixPass} passed, ${fixFail} failed`);
if (fixFail) failed += fixFail;

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
