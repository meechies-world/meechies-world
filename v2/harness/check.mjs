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

console.log("\nLive comparison (main 1be5b8fe): index.html 180,268 B + 45 JS files" +
  " (~478 KB transfer) + 100 KB CSS load on EVERY view, DJ booth included.");

/* ---- 3. inventory ---- */
console.log("\nv2 file inventory:");
for (const f of walk(V2).sort()) console.log("  " + f.slice(V2.length + 1));

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
