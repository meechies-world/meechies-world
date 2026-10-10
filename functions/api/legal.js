// Legal Help: Meechie's AI drafts court papers for people representing themselves (pro se),
// reviews drafts, revises them, and answers legal-information questions.
// Signed-in members only. Case details are sent only for the request and are not stored here.
import { runModel, SUPABASE_URL, SUPABASE_ANON } from "../../lib/brain.js";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const cut = (v, n) => String(v ?? "").replace(/\u0000/g, "").slice(0, n);

const RULES = `You are Meechie's AI, the legal document preparer for Meechie's World Inc (Legal Document Preparation • Paralegal Services).
You help people who are representing themselves (pro se) prepare court documents. You are not a lawyer and this is not legal advice; the person files and signs their own papers.

How you write court documents:
- Write a complete, ready-to-file document in plain text (no markdown symbols like ** or #). Use ALL CAPS for the court name, the case caption title and section headings.
- Start with the caption: court name, the parties (as given), case number, judge if given, then the document title centered in caps.
- Then: a short introduction (who is filing, what they ask for, under what rule), STATEMENT OF FACTS (numbered paragraphs, only facts the person gave you, in date order), LEGAL STANDARD, ARGUMENT (headed sub-points that apply the law to these facts), RELIEF REQUESTED (numbered), the signature block ("Respectfully submitted," then /s/ name, "Pro Se", address/phone placeholders), and a CERTIFICATE OF SERVICE naming who gets a copy (the prosecutor or opposing party/counsel) with a date placeholder. For a motion add a short proposed ORDER at the end when it is customary.
- Use the court rules and statutes of the right jurisdiction (state vs. federal; criminal vs. civil). Name the actual rule (for example Fed. R. Crim. P. 12, Fed. R. Civ. P. 56, W. Va. R. Crim. P. 12, 42 U.S.C. § 1983) only when you are confident it applies.
- CITATIONS: Prefer the case law in the RESEARCH list (it came from a real court database). You may also cite landmark U.S. Supreme Court cases you are certain of. Never invent a case, a quote, a page number or a holding. If you think authority exists but you are not sure of the exact citation, write [CITATION NEEDED: describe the point] instead. Put every case citation in standard Bluebook form (Name v. Name, Volume Reporter Page (Court Year)).
- Never invent facts, dates, names or numbers. Where something is missing, leave a clear placeholder in brackets like [DATE OF ARREST] or [OFFICER NAME].
- Be persuasive, respectful and professional. Keep it focused: strong arguments first, no filler.
After the document, add a line "----- NOTES FOR YOU (do not file this part) -----" with: deadlines or timing to check, what to attach (exhibits, affidavits), local rules to check (page limits, formatting, number of copies), every [placeholder] they must fill in, and a reminder to read every citation (the site's Verify button checks them).`;

const REVIEW = `You are Meechie's AI, reviewing a court document drafted by or for a pro se litigant. You are not a lawyer; this is not legal advice.
Give a clear checklist review in plain text (no markdown symbols):
1. STRENGTH: how strong the main arguments are, in one or two sentences.
2. PROBLEMS: anything missing or wrong (missing caption parts, wrong court or rule, facts that don't support the argument, no relief requested, no certificate of service, unsigned, placeholders left).
3. CITATIONS: list every case and statute cited, and flag any that look made-up, misquoted, or out of jurisdiction. Say plainly that each must be checked.
4. IMPROVEMENTS: the 3-6 most important specific fixes, with suggested wording where useful.
5. BEFORE FILING: deadlines, copies, service, local rules.`;

const ASK = `You are Meechie's AI answering a legal-information question for a person representing themselves (pro se). You are not a lawyer; say so briefly and that this is legal information, not advice.
Explain in plain words: what the law or procedure generally is, which rule or statute usually governs (only if you are confident), what papers are usually filed, deadlines to watch, and the next step. Use the RESEARCH list for case law and cite it like [1]; never invent cases. If the answer depends on the state or court, say what to check. End with one clear next step on the site (the Legal Help tab can draft the document). Plain text, short paragraphs.`;

function caseBlock(c) {
  c = c || {};
  const L = (k, v) => (v ? k + ": " + cut(v, 600) + "\n" : "");
  return L("Court system", c.system) + L("State", c.state) + L("County / district", c.county) + L("Court name", c.court) + L("Case number", c.caseNo) + L("Case type", c.type)
    + L("Judge", c.judge) + L("The person filing (their name)", c.name) + L("Their role", c.role) + L("Other side (State, prosecutor, defendant, agency, etc.)", c.other)
    + L("Other side's lawyer / prosecutor", c.otherCounsel) + L("Charges / claims", c.charges) + L("Current status / next court date", c.status)
    + L("Address for signature block", c.address) + L("Phone / email for signature block", c.contact);
}

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: "ai_off" }, 501);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign_in" }, 401);
  const who = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON, authorization: "Bearer " + token } });
  if (!who.ok) return json({ error: "sign_in" }, 401);
  let b; try { b = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const mode = ["draft", "revise", "review", "ask"].includes(b.mode) ? b.mode : "draft";
  const research = (Array.isArray(b.research) ? b.research : []).slice(0, 10).map((r, i) =>
    `[${i + 1}] ${cut(r.name, 160)}, ${cut(r.cite, 80)} (${cut(r.court, 80)} ${cut(r.year, 8)})${r.snippet ? " — " + cut(r.snippet, 420) : ""}`).join("\n");
  const R = research ? "\n\nRESEARCH (real cases from the CourtListener court database; use the ones that truly fit):\n" + research : "\n\nRESEARCH: none provided. Only cite Supreme Court cases you are certain of; otherwise use [CITATION NEEDED].";
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" });

  let system, user, max = 3800, effort = "medium";
  if (mode === "ask") {
    system = ASK; max = 1400; effort = "low";
    user = "Question: " + cut(b.question, 3000) + "\n\nTheir case (if relevant):\n" + caseBlock(b.case) + R;
  } else if (mode === "review") {
    system = REVIEW; max = 1800;
    user = "Their case:\n" + caseBlock(b.case) + "\nDocument to review:\n" + cut(b.draft, 24000) + R;
  } else if (mode === "revise") {
    system = RULES;
    user = "Today is " + today + ".\nTheir case:\n" + caseBlock(b.case) + "\nHere is the current draft:\n" + cut(b.draft, 24000)
      + "\n\nRevise it as follows (keep everything else that is good, and return the whole revised document plus the NOTES):\n" + cut(b.instructions, 3000) + R;
  } else {
    system = RULES;
    user = "Today is " + today + ".\nDocument to draft: " + cut(b.docType, 120) + "\n\nTheir case:\n" + caseBlock(b.case)
      + "\nWhat happened (their facts, in their words):\n" + cut(b.facts, 12000)
      + "\n\nWhat they want the court to do:\n" + cut(b.relief, 3000)
      + (b.issues ? "\n\nLegal issues / arguments they want made:\n" + cut(b.issues, 3000) : "")
      + (b.instructions ? "\n\nExtra instructions:\n" + cut(b.instructions, 2000) : "") + R;
  }
  const out = await runModel(env, system, [{ role: "user", content: user }], { max_tokens: max, temperature: 0.25, effort });
  if (out.error) return json(out, 503);
  return json({ text: out.reply, model: out.model });
}
