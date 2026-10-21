/* Owner-only AI coder ("Edit AI" that can change the site's real code).
 * It works like a careful person would: first it explains what it understood, what it plans to change, the risks,
 * and asks if anything is unclear. Only after the owner says "Build it" does it write the code — and even then it
 * never touches the live site: it opens a pull request on GitHub with a preview link. The owner looks at the
 * preview and clicks Merge to make it live (or closes it to throw it away).
 * Needs: Workers AI binding (AI, free) and a GitHub token saved in Cloudflare as GITHUB_TOKEN
 * (fine-grained, only the meechies-world repo, "Contents" + "Pull requests" read/write). */
import { json, userFrom, isAdmin, take, setup } from "../../lib/cf.js";

const REPO = "meechies-world/meechies-world";
const GH = "https://api.github.com/repos/" + REPO;
const PLAN_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwen2.5-coder-32b-instruct"];
const CODE_MODELS = ["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
const EDITABLE = /^(index\.html|post-video\.html|upload\.html|js\/[\w.-]+\.js|css\/[\w.-]+\.css|functions\/api\/[\w.-]+\.js)$/;
const NEVER = /^(js\/config\.js|lib\/|functions\/_middleware\.js|functions\/api\/cf\/|functions\/m\/|wrangler\.toml|AGENTS\.md|CLAUDE\.md)/;

const RULES = `Owner's rules (always): keep it free (no paid services), phones first (390px wide; nothing may cover the screen or overlap),
never remove sign-in, privacy or outage protection, never put passwords/keys/tax numbers in code, no fake engagement numbers,
no copied brand designs, don't change the book cover. Plain HTML/CSS/JS, no build step. When a script changes, its ?v= number in index.html must change too.`;

const gh = (env, path, init = {}) => fetch(GH + path, { ...init, headers: { authorization: "Bearer " + env.GITHUB_TOKEN, accept: "application/vnd.github+json", "user-agent": "meechies-world-ai-coder", "x-github-api-version": "2022-11-28", ...(init.headers || {}) } });
const b64dec = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const b64enc = (s) => { const b = new TextEncoder().encode(s); let o = ""; for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(o); };
function parseJSON(t) { t = String(t || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, ""); try { return JSON.parse(t); } catch (_) {} const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} } return null; }
async function ask(env, models, system, user, max = 1800) {
  let last = "";
  for (const m of models) {
    try {
      const out = await env.AI.run(m, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: max, temperature: 0.2 });
      const raw = out && (out.response !== undefined ? out.response : out.result);
      const j = raw && typeof raw === "object" ? raw : parseJSON(raw);
      if (j) return j; last = "unreadable answer from " + m;
    } catch (e) { last = String(e.message || e); }
  }
  throw new Error("The AI couldn't answer right now (" + last.slice(0, 120) + "). Try again in a minute.");
}
async function tree(env) {
  const r = await gh(env, "/git/trees/main?recursive=1"); if (!r.ok) throw new Error("Couldn't read the site's code from GitHub (" + r.status + "). Check the GITHUB_TOKEN.");
  const j = await r.json(); return (j.tree || []).filter((f) => f.type === "blob" && EDITABLE.test(f.path) && !NEVER.test(f.path)).map((f) => ({ path: f.path, size: f.size }));
}
async function readFile(env, path, ref = "main") {
  const r = await gh(env, "/contents/" + encodeURIComponent(path).replace(/%2F/g, "/") + "?ref=" + encodeURIComponent(ref));
  if (!r.ok) return null; const j = await r.json(); return { text: b64dec(j.content || ""), sha: j.sha };
}
// big files (index.html is ~3,000 lines): only show the parts around the search words
function excerpt(text, terms, budget) {
  if (text.length <= budget) return text;
  const lines = text.split("\n"), keep = new Set();
  const ts = (terms || []).map((t) => String(t).toLowerCase()).filter((t) => t.length > 2).slice(0, 8);
  lines.forEach((l, i) => { const ll = l.toLowerCase(); if (ts.some((t) => ll.includes(t))) for (let k = Math.max(0, i - 25); k < Math.min(lines.length, i + 26); k++) keep.add(k); });
  if (!keep.size) for (let k = 0; k < 60; k++) keep.add(k);
  let out = "", prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) { if (i !== prev + 1) out += "\n/* … */\n"; out += lines[i] + "\n"; prev = i; if (out.length > budget) break; }
  return out;
}

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: "The free AI isn't connected." }, 501);
  if (!env.DB) return json({ error: "Database not connected." }, 503);
  await setup(env);
  const me = await userFrom(request, env);
  if (!me || !(await isAdmin(env, me.id))) return json({ error: "owner_only" }, 403);
  if (!env.GITHUB_TOKEN) return json({ error: "needs_token", reply: "To let me change the real code, save a GitHub token in Cloudflare as GITHUB_TOKEN (Meechie: ask Claude for the 2-minute steps)." }, 501);
  if (!(await take(env, "coder:" + me.id, 86400, 40))) return json({ error: "Daily limit reached (40 requests). Try again tomorrow." }, 429);
  const b = await request.json().catch(() => ({}));
  const want = String(b.request || "").slice(0, 1500).trim(); if (!want) return json({ error: "Tell me what to change." }, 400);
  const answers = String(b.answers || "").slice(0, 1500);

  try {
    const files = await tree(env);
    const list = files.map((f) => `${f.path} (${Math.round(f.size / 1024)} KB)`).join("\n");

    if (b.step !== "build") {
      // 1) think it through like a person, before touching anything
      const plan = await ask(env, PLAN_MODELS, `You are the senior web developer for the Meechie's World website, working for its owner Meechie.
Think like an experienced person, not a robot: picture what a visitor on a phone will actually see, think about what could break, and say it in plain friendly words.
${RULES}
Return JSON only: {"understanding":"what Meechie wants, in one or two sentences","plan":["step 1","step 2"],"files":["paths to change, from the list, at most 3"],"search":["words to find the right spot in big files"],"risk":"what could go wrong, one sentence","questions":["only if something important is unclear; otherwise []"]}`,
        `Meechie asked: ${want}\n${answers ? "His answers to your questions: " + answers + "\n" : ""}\nFiles you can change:\n${list}`, 900);
      plan.files = (plan.files || []).filter((p) => files.some((f) => f.path === p)).slice(0, 3);
      return json({ ok: true, step: "plan", plan });
    }

    // 2) write the change as exact find/replace edits
    const paths = (Array.isArray(b.files) ? b.files : []).filter((p) => files.some((f) => f.path === p)).slice(0, 3);
    if (!paths.length) return json({ error: "The plan didn't name any files to change. Ask again with more detail." }, 400);
    const read = {}; let ctx = "";
    for (const p of paths) { const f = await readFile(env, p); if (!f) continue; read[p] = f; ctx += `\n===== FILE ${p} =====\n` + excerpt(f.text, b.search, Math.floor(42000 / paths.length)); }
    const code = await ask(env, CODE_MODELS, `You change code for the Meechie's World website. ${RULES}
Return JSON only: {"summary":"what you changed, in plain words for Meechie","edits":[{"path":"file","find":"exact text copied from the file, long enough to be unique","replace":"the new text"}]}
Rules for edits: "find" must be copied EXACTLY from the file shown (same spaces), and must appear once. Keep edits small. To add new code, find a nearby line and replace it with that line plus the new code. Never delete security, sign-in or outage code.`,
      `Request: ${want}\n${answers ? "Owner's answers: " + answers + "\n" : ""}Plan: ${JSON.stringify(b.plan || []).slice(0, 1500)}\n${ctx}`, 3500);
    const edits = Array.isArray(code.edits) ? code.edits.slice(0, 12) : [];
    if (!edits.length) return json({ error: "The AI didn't produce a change. Try saying it a different way." }, 422);
    const out = {}, problems = [];
    for (const e of edits) {
      if (!read[e.path] || typeof e.find !== "string" || typeof e.replace !== "string" || !e.find) { problems.push("skipped an edit to " + e.path); continue; }
      const cur = out[e.path] !== undefined ? out[e.path] : read[e.path].text;
      const n = cur.split(e.find).length - 1;
      if (n !== 1) { problems.push(`couldn't find the exact spot in ${e.path}`); continue; }
      out[e.path] = cur.replace(e.find, () => e.replace);
    }
    if (!Object.keys(out).length) return json({ error: "The AI's change didn't line up with the real code (" + problems.join("; ") + "). Try again or describe it differently." }, 422);
    // a changed script needs a new ?v= so phones load it
    const changedJs = Object.keys(out).filter((p) => p.startsWith("js/"));
    if (changedJs.length) {
      const idx = out["index.html"] !== undefined ? { text: out["index.html"] } : await readFile(env, "index.html");
      if (idx) { let t = idx.text; const v = Math.floor(Date.now() / 1000); changedJs.forEach((p) => { t = t.replace(new RegExp(`(src="${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?v=)\\d+`, "g"), `$1${v}`); }); out["index.html"] = t; if (!read["index.html"]) read["index.html"] = await readFile(env, "index.html"); }
    }
    // 3) put it on its own branch and open a pull request — the live site is untouched
    const main = await gh(env, "/git/ref/heads/main").then((r) => r.json());
    const branch = "ai-" + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const mk = await gh(env, "/git/refs", { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + branch, sha: main.object.sha }) });
    if (!mk.ok) throw new Error("Couldn't start a draft copy on GitHub (" + mk.status + ").");
    for (const [p, text] of Object.entries(out)) {
      const r = await gh(env, "/contents/" + p, { method: "PUT", body: JSON.stringify({ message: "AI coder: " + want.slice(0, 60), content: b64enc(text), sha: read[p].sha, branch }) });
      if (!r.ok) throw new Error("Couldn't save " + p + " (" + r.status + ").");
    }
    const pr = await gh(env, "/pulls", { method: "POST", body: JSON.stringify({ title: "AI coder: " + want.slice(0, 70), head: branch, base: "main", body: `Requested by Meechie: ${want}\n\n${code.summary || ""}\n\n${problems.length ? "Notes: " + problems.join("; ") + "\n\n" : ""}Preview: https://${branch}.meechies-world.pages.dev (ready about a minute after this was opened). Merge to make it live; close to throw it away.` }) }).then((r) => r.json());
    return json({ ok: true, step: "built", summary: code.summary || "", notes: problems, pr: pr.html_url, preview: `https://${branch}.meechies-world.pages.dev`, files: Object.keys(out) });
  } catch (e) {
    return json({ error: String(e.message || e).slice(0, 300) }, 500);
  }
}
