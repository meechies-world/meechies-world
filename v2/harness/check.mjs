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

/* the PHONE DOCK (owner, 2026-10-30): at phone widths the mini is ONE
   STANDARD DOCKED SCREEN — fixed spot on all views, with sound, no
   arrival pop-up; wider viewports keep the floating mini. The pure
   breakpoint, the dock's no-pop-gate share contract, and the wiring
   (CSS class, sounding rule, pop-out target) are asserted here. */
eq("phone width presents the dock", mni.miniPresentation(390), "dock");
eq("760px exactly is still the dock", mni.miniPresentation(760), "dock");
eq("761px floats", mni.miniPresentation(761), "float");
eq("desktop floats", mni.miniPresentation(1440), "float");
ok("dock shows the share with NO pop gate (no arrival pop-up on phone)", mni.miniStep(mni.newMiniState(), minIn({ hasTargets: false, shareOn: true, shareFlowing: false, popReady: false, dock: true })).show === true);
ok("dock still steps aside on the MW TV page", mni.miniStep(mni.newMiniState(), minIn({ dock: true, onTV: true })).hidden === true);
ok("dock still steps aside for the booth", mni.miniStep(mni.newMiniState(), minIn({ dock: true, boothOn: true })).hidden === true);
ok("hidden share never docks", mni.miniStep(mni.newMiniState(), minIn({ hasTargets: false, shareOn: true, shareHidden: true, dock: true })).hidden === true);
ok("session close still hides the dock", mni.miniStep(mni.newMiniState(), minIn({ dock: true, sessOff: true })).hidden === true);
const engineCssSrc = readFileSync(join(V2, "css/engine.css"), "utf8");
const engineSrc = readFileSync(join(V2, "js/engine.js"), "utf8");
const miniSrc = readFileSync(join(V2, "js/mini.js"), "utf8");
ok("dock CSS: full-width screen docked under the shell header", /#dj-mini\.mn-docked\{[^}]*width:100%/.test(engineCssSrc) && /#dj-mini\.mn-docked\{[^}]*top:calc\(56px/.test(engineCssSrc));
ok("dock CSS: the resize grip stands down when docked", /#dj-mini\.mn-docked \.mn-grip\{display:none\}/.test(engineCssSrc));
ok("undocked phones keep the small floating mini", /#dj-mini:not\(\.mn-docked\)\{top:auto;bottom:76px;width:168px\}/.test(engineCssSrc));
ok("engine: a shown dock can be the one sounding screen", /miniDock && miniShown && miniScr/.test(engineSrc) && /setMiniDock/.test(engineSrc) && /setMiniShown/.test(engineSrc));
ok("mini: the dock class drives the presentation", /classList\.toggle\("mn-docked", dock\)/.test(miniSrc) && /matchMedia\("\(max-width: 760px\)"\)/.test(miniSrc));
ok("mini: dock renders via the sounding surface, float renders muted", /if \(dockMode\) await engine\.renderSurface\(scr\)/.test(miniSrc) && /else await engine\.renderScreen\(scr, true, 1, 1\)/.test(miniSrc));
ok("mini: the dock pops out to MW TV", /location\.hash = "#mwtv"/.test(miniSrc));
ok("mini: drag and grip stand down while docked", /mnGrip\.addEventListener\("pointerdown", \(e\) => \{ if \(dockMode\) return;/.test(miniSrc) && /mnBar\.addEventListener\("pointerdown", \(e\) => \{ if \(dockMode\) return;/.test(miniSrc));

/* ---- 5. Phase 3 social payload + fixtures ---------------------
   The Book + social core (Book, Friends, Messages, Chat, Clips)
   loads ONLY when a social view is first entered: js/social.js is
   the shared data layer (the live platform ops + the pure logic),
   each view is its own lazy module. Home and the viewer views must
   never import any of it — the byte proof below, then fixtures for
   the pure logic in js/social.js (feed ordering, the owner's count
   rules, the DM tag protocol + thread grouping, story grouping,
   the clip filter) and the friends card's socUrl builder. */
const p3Files = [
  "js/social.js",
  "js/views/community.js", "js/views/friends.js", "js/views/messages.js", "js/views/chat.js", "js/views/clips.js",
  "css/book.css", "css/friends.css", "css/messages.css", "css/chat.css", "css/clips.css",
];
console.log("\nPhase 3 social payload (lazy — first social view only, never on Home or the viewer views):");
let p3Gz = 0, p3Raw = 0;
for (const f of p3Files) {
  try {
    const s = size(f);
    p3Gz += s.gz; p3Raw += s.raw;
    console.log(`  ${f.padEnd(24)} raw ${kb(s.raw).padStart(9)}   gzip ${kb(s.gz).padStart(9)}`);
  } catch (_) { failed++; console.log("FAIL  missing", f); }
}
console.log(`  ${"TOTAL".padEnd(24)} raw ${kb(p3Raw).padStart(9)}   gzip ${kb(p3Gz).padStart(9)}`);
for (const f of ["js/views/home.js", "js/views/radio.js", "js/views/mwtv.js", "js/views/watch.js", "js/engine.js", "js/station.js", "js/mini.js"]) {
  const s = readFileSync(join(V2, f), "utf8");
  const pays = /social\.js|views\/(community|friends|messages|chat|clips)\.js/.test(s);
  console.log(`${f} imports the social layer: ${pays ? "YES — FAIL" : "no — PASS"}`);
  if (pays) failed++;
}
for (const v of ["community", "friends", "messages", "clips", "chat"]) {
  const line = coreSrc.split("\n").find((l) => l.trim().startsWith(v + ":"));
  const reg = !!line && /css:/.test(line) && /import\("\.\/views\//.test(line);
  console.log(`registry ${v}: ${reg ? "css + lazy load — PASS" : "MISSING — FAIL"}`);
  if (!reg) failed++;
}

console.log("\n--- Phase 3 social fixtures ---");
const soc = await import("../js/social.js");
const frn = await import("../js/views/friends.js");
const NOW = 1700000000000;

/* feed ordering: rank (announce 4, sponsored 2, following 1) beats
   recency; createdAt breaks ties inside a rank */
const FOL = new Set(["friend1"]);
const fp = (id, over) => Object.assign({ id, authorId: "someone", createdAt: 0, likes: [], replyCount: 0 }, over || {});
const orderedIds = soc.sortFeed([
  fp("fresh-plain", { createdAt: NOW }),
  fp("old-announce", { createdAt: 10, announce: true }),
  fp("mid-sponsored", { createdAt: 20, sponsored: true }),
  fp("friend-post", { createdAt: 30, authorId: "friend1" }),
  fp("older-plain", { createdAt: 5 }),
  fp("fresh-announce", { createdAt: NOW + 1000, announce: true }),
], FOL).map((p) => p.id);
eq("feed order: announce > sponsored > following > plain, newest first in rank", orderedIds,
  ["fresh-announce", "old-announce", "mid-sponsored", "friend-post", "fresh-plain", "older-plain"]);
eq("announce+sponsored stacks (rank 6)", soc.feedRank(fp("x", { announce: true, sponsored: true }), FOL), 6);

/* trending: last 7 days, score = likes + 2*replies >= 3, top 3 */
const trend = soc.trendingIds([
  fp("t1", { createdAt: NOW, likes: ["a", "b", "c"] }),
  fp("t2", { createdAt: NOW, likes: ["a"], replyCount: 1 }),
  fp("t3", { createdAt: NOW, likes: ["a", "b"] }),
  fp("t4", { createdAt: NOW - 8 * 864e5, likes: ["a", "b", "c", "d", "e"] }),
  fp("t5", { createdAt: NOW, replyCount: 2 }),
], NOW);
ok("trending includes score>=3 in-window", trend.has("t1") && trend.has("t2") && trend.has("t5"));
ok("trending excludes score 2 and 8-day-old", !trend.has("t3") && !trend.has("t4"));

/* the owner's count rules (Law 11 + the comment twin) */
eq("like count 24 hidden", soc.likeCountVisible(24, false), false);
eq("like count 25 shown", soc.likeCountVisible(25, false), true);
eq("like count 24 shown to the owner seat", soc.likeCountVisible(24, true), true);
eq("like count 0 never shown", soc.likeCountVisible(0, true), false);
eq("comment count 2 hidden", soc.commentCountVisible(2, false), false);
eq("comment count 3 shown", soc.commentCountVisible(3, false), true);
eq("comment count 2 shown to the owner seat", soc.commentCountVisible(2, true), true);

/* cleanRow: the platform layer's junk filter */
ok("cleanRow accepts a normal post", soc.cleanRow({ path: "posts/abc123", data: { authorId: "u-1_2", text: "hi" } }));
ok("cleanRow rejects a bad doc id", !soc.cleanRow({ path: "posts/a b!", data: {} }));
ok("cleanRow rejects an HTML authorId", !soc.cleanRow({ path: "posts/abc", data: { authorId: "<script>" } }));
ok("cleanRow accepts rows without id fields", soc.cleanRow({ path: "members/u1", data: { handle: "M" } }));

/* the DM tag protocol */
eq("tags parse in any order", soc.dmTags("⟦x:1893456000000⟧⟦g:gab12⟧⟦m:m123456⟧⟦q:42⟧hello").t, { x: "1893456000000", g: "gab12", m: "m123456", q: "42" });
eq("bareText strips every tag", soc.bareText("⟦g:gab12⟧⟦m:m123456⟧hey"), "hey");
eq("quoteOf reads the q tag", soc.quoteOf("⟦q:77⟧yo"), "77");
eq("react tail parses", soc.reactOf("⟦react:123:❤️⟧"), { target: "123", emoji: "❤️" });
eq("group react tail parses (@ form)", soc.reactOf("⟦g:gab12⟧⟦react:@m999:🔥⟧"), { target: "m999", emoji: "🔥" });
eq("a plain body is not a reaction", soc.reactOf("hello ❤️"), null);
eq("preview: legacy voice body", soc.dmPreview({ body: "🎙️ Voice message ⟦https://yjouaysczttqbytksejq.supabase.co/storage/v1/object/public/media/u1/a.webm⟧" }), "🎙️ Voice message");
eq("preview: /m/media voice body (current send format)", soc.dmPreview({ body: "🎙️ Voice message ⟦https://meechiesworldinc.com/m/media/u1/abc.webm⟧" }), "🎙️ Voice message");
eq("preview: /m/media photo body", soc.dmPreview({ body: "📷 Photo ⟦https://meechiesworldinc.com/m/media/u1/abc.jpg⟧" }), "📷 Photo");
eq("preview: reaction body", soc.dmPreview({ body: "⟦react:5:😂⟧" }), "Reacted 😂 to a message");
eq("preview: plain text", soc.dmPreview({ body: "⟦g:gab12⟧meet at 7" }), "meet at 7");
ok("expired vanish body is expired", soc.dmExpired({ body: "⟦x:1000000000000⟧gone" }));
ok("future vanish body is not expired", !soc.dmExpired({ body: "⟦x:9999999999999⟧here" }));

/* thread grouping: rows are newest-first, like the live load */
const ME = "me", T = (s) => new Date(1700000000000 + s * 1000).toISOString();
const dmr = (id, sender, recipient, body, s, read) => ({ id, sender, recipient, body, created_at: T(s), read_at: read ? T(s + 1) : null });
const rows = [
  dmr(9, "ann", ME, "⟦react:7:❤️⟧", 90),
  dmr(8, ME, "ann", "mine latest", 80, true),
  dmr(7, "ann", ME, "ann latest", 70),
  dmr(6, "bob", ME, "bob says hi", 60),
  dmr(5, ME, "bob", "⟦g:gab12⟧⟦m:mAAA111⟧group hello", 50, true),
  dmr(4, ME, "ann", "⟦g:gab12⟧⟦m:mAAA111⟧group hello", 50, true),
  dmr(3, "ann", ME, "⟦g:gab12⟧⟦m:mBBB222⟧ann in group", 40),
  dmr(2, ME, "ann", "older mine", 20, true),
  dmr(1, "ann", ME, "oldest ann", 10, true),
];
const convos = soc.groupConvos(rows, ME, { gab12: { name: "Crew", members: [ME, "ann", "bob"] } });
eq("convo list: group + two people, newest first", convos.map((c) => c.id), ["ann", "bob", "g:gab12"]);
eq("ann convo unread excludes the reaction", (convos.find((c) => c.id === "ann") || {}).unread, 1);
eq("group convo unread counts only incoming non-reactions", (convos.find((c) => c.gid === "gab12") || {}).unread, 1);
eq("unknown groups are skipped", soc.groupConvos(rows, ME, {}).map((c) => c.id), ["ann", "bob"]);
const th = soc.threadSplit(rows, ME, "ann", null);
eq("thread rows come back oldest-first, reactions split out", th.msgs.map((r) => r.id), [1, 2, 7, 8]);
eq("reactions fold onto their target", th.reacts, { 7: { ann: "❤️" } });
const gth = soc.threadSplit(rows, ME, null, "gab12");
eq("group thread keys messages by their shared muid", gth.msgs.map((r) => soc.msgKey(r, "gab12")), ["mBBB222", "mAAA111", "mAAA111"]);

/* stories: 24h window, then mine > unseen > friends > latest */
const st = (id, authorId, createdAt) => ({ id, authorId, kind: "text", text: "x", createdAt });
const sgs = soc.storyGroups([
  st("s-old", "zoe", NOW - 25 * 3600e3),
  st("s-zoe", "zoe", NOW - 3600e3),
  st("s-pal-seen", "pal", NOW - 2 * 3600e3),
  st("s-pal-new", "pal", NOW - 1800e3),
  st("s-fan", "fan", NOW - 900e3),
  st("s-me", ME, NOW - 7200e3),
], new Set(["s-pal-seen", "s-pal-new"]), ME, new Set(["pal"]), NOW);
eq("story order: mine, unseen, friends, then latest; 24h cutoff", sgs.map((g) => g.uid), [ME, "fan", "zoe", "pal"]);
ok("seen group reports no unseen", sgs.find((g) => g.uid === "pal").unseen === false);

/* clips: https only, the retired storage host excluded, newest first */
eq("clip filter", soc.clipList([
  { id: "c1", video: "https://cdn.example.com/a.mp4", createdAt: 5 },
  { id: "c2", video: "https://yjouaysczttqbytksejq.supabase.co/storage/v1/object/public/media/a.mp4", createdAt: 9 },
  { id: "c3", video: "http://example.com/b.mp4", createdAt: 7 },
  { id: "c4", video: "https://example.com/d.mp4", createdAt: 3 },
  { id: "c5", createdAt: 11 },
]).map((p) => p.id), ["c1", "c4"]);

/* the friends card URL builder (live MW_socUrl) */
eq("socUrl instagram handle", frn.socUrl("instagram", "@meechie"), "https://instagram.com/meechie");
eq("socUrl tiktok adds @", frn.socUrl("tiktok", "meechie"), "https://tiktok.com/@meechie");
eq("socUrl full link passes through", frn.socUrl("instagram", "https://instagram.com/meechie"), "https://instagram.com/meechie");
eq("socUrl link-only app needs a real link", frn.socUrl("spotify", "someartist"), "");
eq("socUrl bandcamp subdomain", frn.socUrl("bandcamp", "meechie"), "https://meechie.bandcamp.com");
eq("socUrl whatsapp number", frn.socUrl("whatsapp", "3019881469"), "https://wa.me/13019881469");


/* ---- 6. Phase 4 booth payload + fixtures ----------------------
   THE BOOTH (the heart of the rebuild) loads ONLY when the DJ view
   is first entered: djstate.js (the typed write layer), djdecks.js
   (the audio half), djshare.js (share publishing), djfree.js (the
   free shelf), views/dj.js and css/dj.css. Home, the viewer views
   and the social views must never import any of it — the byte proof
   below, then fixtures for the pure logic in djstate.js pinned
   against the live booth's constants (live dj.js @ main ebc7da70):
   the lead-lock claim rules, the FX broadcast caps, the queue draw,
   the stall-watchdog ladder, the dead-air gate, the blend/preload
   windows, the drop cadence, the stock-record rule. */
const p4Files = [
  "js/djstate.js", "js/djdecks.js", "js/djshare.js", "js/djfree.js",
  "js/views/dj.js", "css/dj.css",
];
console.log("\nPhase 4 booth payload (lazy — first DJ view only, never on Home, viewer or social views):");
let p4Gz = 0, p4Raw = 0;
for (const f of p4Files) {
  try {
    const s = size(f);
    p4Gz += s.gz; p4Raw += s.raw;
    console.log(`  ${f.padEnd(24)} raw ${kb(s.raw).padStart(9)}   gzip ${kb(s.gz).padStart(9)}`);
  } catch (_) { failed++; console.log("FAIL  missing", f); }
}
console.log(`  ${"TOTAL".padEnd(24)} raw ${kb(p4Raw).padStart(9)}   gzip ${kb(p4Gz).padStart(9)}`);
for (const f of ["js/views/home.js", "js/views/radio.js", "js/views/mwtv.js", "js/views/watch.js", "js/views/community.js", "js/views/friends.js", "js/views/messages.js", "js/views/chat.js", "js/views/clips.js", "js/engine.js", "js/station.js", "js/mini.js", "js/social.js"]) {
  const s = readFileSync(join(V2, f), "utf8");
  const pays = /djstate\.js|djdecks\.js|djshare\.js|djfree\.js|views\/dj\.js/.test(s);
  console.log(`${f} imports the booth layer: ${pays ? "YES — FAIL" : "no — PASS"}`);
  if (pays) failed++;
}
{
  const line = coreSrc.split("\n").find((l) => l.trim().startsWith("dj:"));
  const reg = !!line && /css:/.test(line) && /import\("\.\/views\//.test(line);
  console.log(`registry dj: ${reg ? "css + lazy load — PASS" : "MISSING — FAIL"}`);
  if (!reg) failed++;
}

console.log("\n--- Phase 4 booth fixtures ---");
const djs = await import("../js/djstate.js");
const djv = await import("../js/views/dj.js");

/* layout-as-data (Law 6): deck order never changes; the below-decks
   panels render in exactly the shipped priority */
eq("layout deck order A B | X | C D", djv.LAYOUT.decks, ["A", "B", "X", "C", "D"]);
eq("layout panel priority (shipped order)", djv.LAYOUT.panels.map((p) => p[0]),
  ["door", "brain", "reports", "livereq", "autodj", "mic", "record", "fx", "vfx", "pads", "midi", "log", "reqdrops", "campro", "battles", "afterhours"]);

/* lead lock: fresh for 20 s; a mirror is a fresh lead held by another tab */
const LT = 1000000;
ok("lead fresh at 19.9s", djs.leadFreshAt(LT, LT + 19900) === true);
ok("lead stale at 20s", djs.leadFreshAt(LT, LT + 20000) === false);
ok("no lead stamp is never fresh", djs.leadFreshAt(0, LT) === false);
ok("mirror: fresh lead, other tab", djs.isMirror({ leadTab: "tabB", leadAt: LT }, "tabA", LT + 5000) === true);
ok("not mirror: my own lead", djs.isMirror({ leadTab: "tabA", leadAt: LT }, "tabA", LT + 5000) === false);
ok("not mirror: stale lead", djs.isMirror({ leadTab: "tabB", leadAt: LT }, "tabA", LT + 25000) === false);
ok("take stamp honored inside 15s", djs.takeFresh(LT, LT + 14900) === true);
ok("take stamp dead at 15s", djs.takeFresh(LT, LT + 15000) === false);

/* FX broadcast caps (live applyFx): verb ≤ 0.30, fla ≤ 0.25 (×0.8 wet),
   pha ≤ 0.3 (×0.9), noise ≤ 0.5 (×0.5), crush curve ≤ 12, filter sweep */
eq("fx caps clamp the broadcast wets", djs.fxCaps({ verb: 0.9, fla: 0.9, pha: 0.9, noise: 0.9, crush: 86, mf: 100, fb: 0.58 }),
  { verbWet: 0.3, flaWet: 0.2, phaWet: 0.27, noiseWet: 0.25, noiseFreq: 400 + 0.5 * 5200, crushCurve: 12, filterFreq: 18000, echoFb: 0.58, gate: 0 });
eq("fx caps pass honest values through", djs.fxCaps({ verb: 0.1, fla: 0.1, pha: 0.1, noise: 0.2, crush: 6, mf: 50, fb: 0.34 }).verbWet, 0.1);
ok("crush steps shrink as crush rises", djs.crushSteps(12) < djs.crushSteps(2));

/* the queue draw: random splice — every item drawn exactly once
   before any repeat (no repeats until the queue empties) */
{
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const q = [{ t: 1 }, { t: 2 }, { t: 3 }, { t: 4 }, { t: 5 }, { t: 6 }];
  const drawn = [];
  while (q.length) drawn.push(djs.drawFromQueue(q, rnd()).t);
  eq("queue draw empties with no repeats", drawn.slice().sort(), [1, 2, 3, 4, 5, 6]);
  eq("draw from an empty queue is null", djs.drawFromQueue([], 0.5), null);
  eq("drawIndex clamps the top edge", djs.drawIndex(4, 0.999), 3);
  eq("drawIndex bottom edge", djs.drawIndex(4, 0), 0);
}

/* stock records: valid only for a non-playing deck holding the same key */
eq("qKeyOf file", djs.qKeyOf({ src: "https://x/a.mp3" }), "s:https://x/a.mp3");
eq("qKeyOf yt", djs.qKeyOf({ yt: "abc123" }), "y:abc123");
eq("qKeyOf dm", djs.qKeyOf({ yt: "dm:x9" }), "dm:x9");
ok("stock valid: same key, deck idle", djs.stockValid({ yt: "abc" }, { yt: "abc", playing: false }) === true);
ok("stock invalid: deck playing", djs.stockValid({ yt: "abc" }, { yt: "abc", playing: true }) === false);
ok("stock invalid: different song", djs.stockValid({ yt: "abc" }, { yt: "zzz", playing: false }) === false);
ok("stock invalid: blank record", djs.stockValid({ yt: "" }, { yt: "", playing: false }) === false);

/* automation windows: preload in (5,15], blend in (0.3,5] */
ok("preload at 15s", djs.preloadDue(15) === true);
ok("no preload at 5s (that is blend)", djs.preloadDue(5) === false);
ok("blend at 5s", djs.blendDue(5) === true);
ok("blend at 0.4s", djs.blendDue(0.4) === true);
ok("no blend at 0.3s", djs.blendDue(0.3) === false);
ok("no blend at 6s", djs.blendDue(6) === false);

/* voice drops: every 3rd automated transition */
ok("drop due on the 3rd", djs.dropDue(3) === true);
ok("drop not due on the 2nd", djs.dropDue(2) === false);
ok("drop due on the 6th", djs.dropDue(6) === true);
eq("drop rotation is the owner's five lines", djs.DROP_TEXTS.length, 5);

/* the stall watchdog ladder: kick at 5 s frozen, reload at the next
   5 s, handover after that; real movement resets; a stall after one
   reload in the same play skips the reload rung */
{
  const T0 = 5000000;
  const obs = (over) => Object.assign({ now: T0, playing: true, pausedAt: 0, pos: 10, key: "yt:a|Song", excluded: false }, over || {});
  let r = djs.stallStep(null, obs());
  eq("watchdog arms on first sample", r.action, "none");
  r = djs.stallStep(r.mem, obs({ now: T0 + 4999 }));
  eq("no kick before 5s frozen", r.action, "none");
  r = djs.stallStep(r.mem, obs({ now: T0 + 5000 }));
  eq("kick at 5s frozen", r.action, "kick");
  r = djs.stallStep(r.mem, obs({ now: T0 + 10000 }));
  eq("reload at the next 5s", r.action, "reload");
  r = djs.stallStep(r.mem, obs({ now: T0 + 15000 }));
  eq("handover after the reload rung", r.action, "handover");
  let m2 = djs.stallStep(null, obs()).mem;
  m2 = djs.stallStep(m2, obs({ now: T0 + 5000 })).mem; // kick
  const moved = djs.stallStep(m2, obs({ now: T0 + 6000, pos: 12 }));
  eq("movement resets the ladder", moved.action, "none");
  eq("movement resets the step", moved.mem.step, 0);
  const paused = djs.stallStep(moved.mem, obs({ now: T0 + 9000, pausedAt: T0 + 8000 }));
  eq("a deliberate pause stands the watchdog down", paused.action, "none");
  const excl = djs.stallStep(moved.mem, obs({ now: T0 + 60000, excluded: true }));
  eq("excluded samples (seeking/runout) never fire", excl.action, "none");
  let m3 = djs.stallStep(null, obs()).mem;
  m3 = djs.stallStep(m3, obs({ now: T0 + 5000 })).mem; // kick, step 1
  m3.reloads = 1; // a reload already spent in an earlier play of this key
  const skip = djs.stallStep(m3, obs({ now: T0 + 10000 }));
  eq("a stall with the reload spent goes straight to handover", skip.action, "handover");
}

/* the dead-air gate: 10 s of true silence fires; a live share, a
   deliberate pause, sounding decks, the load grace, the backoff and
   the 3-try cap all hold it */
{
  const T0 = 9000000;
  const obs = (over) => Object.assign({ now: T0, sandbox: false, owner: true, lead: true, mirror: false, live: true, autodj: true, shareOn: false, sounding: false, pausedAt: 0, sig: "sig1", handoverAge: null }, over || {});
  let g = djs.daGate(null, obs());
  eq("first silent sample only arms", g.fire, false);
  g = djs.daGate(g.st, obs({ now: T0 + 9999 }));
  eq("no fire before 10s of silence", g.fire, false);
  g = djs.daGate(g.st, obs({ now: T0 + 10000 }));
  eq("fires at 10s of silence", g.fire, true);
  eq("a live share is never dead air", djs.daGate(null, obs({ shareOn: true })).reason, "share-live");
  eq("a deliberate pause is respected", djs.daGate(null, obs({ pausedAt: T0 - 60000 })).reason, "deliberate-pause");
  eq("sounding decks reset the rescue", djs.daGate(null, obs({ sounding: true })).reason, "sounding");
  eq("a mirror never rescues", djs.daGate(null, obs({ mirror: true })).reason, "not-driver");
  eq("Auto-DJ off never rescues", djs.daGate(null, obs({ autodj: false })).reason, "not-armed");
  let g2 = djs.daGate(null, obs({ sig: "a" })).st;
  g2 = djs.daGate(g2, obs({ sig: "b", now: T0 + 30000 })).st; // a load landed
  const grace = djs.daGate(g2, obs({ sig: "b", now: T0 + 41000 }));
  eq("a landed load gets its grace", grace.fire, false);
  let g3 = { silenceAt: T0 - 60000, loadAt: 0, tries: 3, absorbUntil: 0, lastTry: T0 - 60000, sig: "sig1" };
  eq("three tries spent stands down", djs.daGate(g3, obs({ now: T0 + 60000 })).reason, "tries-spent");
}

/* booth mergeState: the battle default + the AI-DJ switch default ON */
{
  const S4 = djs.mergeBooth(null);
  ok("battle default shape", S4.battle && S4.battle.on === false && S4.battle.rounds === 3 && S4.battle.phase === "off");
  ok("aiDj defaults ON (the keeper kill switch)", S4.aiDj === true);
  ok("dropsOn defaults ON", S4.dropsOn === true);
  ok("hornOn defaults OFF (2026-10-29)", S4.hornOn === false);
  ok("autodj defaults ON", S4.autodj === true);
}


/* Law 22 — SCROLL AND TOUCH NEVER TOUCH THE MUSIC: the gesture
   classifier that every booth drag runs through, plus static
   passivity asserts over the booth sources (no scroll/wheel
   listener may exist in the booth layer at all; the one wake
   listener is passive; fit runs on resize, never on scroll; the
   stylesheet releases vertical drags on sliders to the page). */
console.log("\n--- Phase 4 Law 22 fixtures ---");
eq("drag: straight down is a page scroll", djv.classifyDrag(0, 20, false), "scroll");
eq("drag: down-dominant is a page scroll", djv.classifyDrag(4, 12, false), "scroll");
eq("drag: straight across engages the control", djv.classifyDrag(20, 0, false), "engage");
eq("drag: across-dominant engages", djv.classifyDrag(12, 4, false), "engage");
eq("drag: a nudge is not yet a decision", djv.classifyDrag(3, 3, false), "wait");
eq("drag: small vertical is still undecided", djv.classifyDrag(0, 7, false), "wait");
eq("drag: vertical past the line is a scroll", djv.classifyDrag(0, 9, false), "scroll");
eq("drag: once engaged, a drag stays engaged", djv.classifyDrag(0, 30, true), "engage");
{
  const boothSrc = ["js/djstate.js", "js/djdecks.js", "js/djshare.js", "js/views/dj.js"]
    .map((f) => readFileSync(join(V2, f), "utf8")).join("\n");
  ok("Law 22: no scroll listener anywhere in the booth layer", !/addEventListener\(["']scroll["']/.test(boothSrc));
  ok("Law 22: no wheel listener anywhere in the booth layer", !/addEventListener\(["']wheel["']/.test(boothSrc));
  ok("Law 22: no scroll-driven fit (boothFit is resize-only)", !/["']scroll["']\s*,\s*\(\)\s*=>\s*\{[^}]*boothFit/.test(boothSrc) && /addEventListener\("resize"/.test(boothSrc));
  ok("Law 22: the audio wake listener is passive", /addEventListener\("pointerdown", wake, \{ passive: true \}\)/.test(boothSrc));
  const djCss = readFileSync(join(V2, "css/dj.css"), "utf8");
  ok("Law 22: platter, X pad and waveform carry pan-y for the owner", /#dj-owner \.platter\{touch-action:pan-y\}/.test(djCss) && /#dj-owner \.xfpad\{touch-action:pan-y\}/.test(djCss) && /#dj-owner \.deck \.wave\{touch-action:pan-y\}/.test(djCss));
  ok("Law 22: booth sliders release vertical drags to the page", /#dj-owner input\[type="range"\]\{touch-action:pan-y\}/.test(djCss));
}

/* ---- 7. Pop-out ad bar fixtures --------------------------------
   The dock pops out to MW TV; the popped-out screen carries a slim
   house-ad bar at the bottom of its frame (owner, 2026-10-30). The
   pure inventory + eligibility logic lives in views/mwtv.js (the
   live house-ads rules: /api/store + /api/shopify, https only,
   digital taps to the buy link, 12 s rotation, the shared 24 h
   mw_ad_hide stamp). The docked mini must stay ad-free, and the
   bar owns a strip below the stage instead of covering it. */
console.log("\n--- Pop-out ad bar fixtures ---");
const twv = await import("../js/views/mwtv.js");
eq("ad inventory: printify maps through", twv.houseAdProducts([{ title: "Tee", img: "i", price: "$1", url: "https://x" }], []),
  [{ title: "Tee", img: "i", price: "$1", url: "https://x", src: "Printify" }]);
eq("ad inventory: shopify keeps https only", twv.houseAdProducts([], [
  { title: "A", img: "", price: "", url: "http://no" },
  { title: "B", img: "", price: "", url: "https://yes" },
]).map((p) => p.title), ["B"]);
eq("ad inventory: digital shopify taps to its buy link", (twv.houseAdProducts([], [{ title: "D", url: "https://p", digital: true, buy: "https://buy" }])[0] || {}).url, "https://buy");
eq("ad inventory: empty feeds mean no ads", twv.houseAdProducts([], []), []);
eq("ad inventory: junk feeds mean no ads", twv.houseAdProducts(null, undefined), []);
ok("ads hidden inside the 24h stamp", twv.houseAdsHiddenAt(1000, "2000") === true);
ok("ads back after the 24h stamp", twv.houseAdsHiddenAt(3000, "2000") === false);
ok("no stamp means ads show", twv.houseAdsHiddenAt(3000, null) === false);
ok("eligible: products and not hidden", twv.twAdEligible([{ title: "x" }], 1000, null) === true);
ok("not eligible: no products", twv.twAdEligible([], 1000, null) === false);
ok("not eligible: hidden for the day", twv.twAdEligible([{ title: "x" }], 1000, "9999") === false);
eq("rotation advances", twv.nextAdIndex(0, 3), 1);
eq("rotation wraps to the top", twv.nextAdIndex(2, 3), 0);
eq("rotation of one stays put", twv.nextAdIndex(0, 1), 0);
eq("rotation is the live 12 seconds", twv.TW_AD_ROTATE_MS, 12000);
eq("the hide is the live 24 hours", twv.TW_AD_HIDE_MS, 24 * 3600 * 1000);
{
  const twSrc = readFileSync(join(V2, "js/views/mwtv.js"), "utf8");
  const twCss = readFileSync(join(V2, "css/mwtv.css"), "utf8");
  ok("ad bar: markup ships hidden inside the TV shell", /<div id="tw-adbar" hidden><\/div>/.test(twSrc));
  ok("ad bar: same two feeds as the live house ads", /fetch\("\/api\/store"\)/.test(twSrc) && /fetch\("\/api\/shopify"\)/.test(twSrc));
  ok("ad bar: the shared mw_ad_hide stamp rules it", /mw_ad_hide/.test(twSrc));
  ok("ad bar: it owns a bottom strip, the stage gives up the height", /#tw-adbar\{[^}]*bottom:0/.test(twCss) && /tw-has-ad #tw-stagebox\{bottom:52px\}/.test(twCss));
  ok("ad bar: hidden means display none", /#tw-adbar\[hidden\]\{display:none!important\}/.test(twCss));
  ok("the docked mini stays ad-free (no ad code in mini.js)", !/tw-adbar|houseAd|mw_ad_hide/.test(miniSrc));
}

console.log(`fixtures: ${fixPass} passed, ${fixFail} failed`);
if (fixFail) failed += fixFail;

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
