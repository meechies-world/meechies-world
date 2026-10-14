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
- Start with the caption: court name, then the parties in the correct order, the case number, the judge if given, then the document title centered in caps. In a CRIMINAL case the government always comes first: "STATE OF [STATE], Plaintiff, v. [NAME], Defendant." (federal: "UNITED STATES OF AMERICA, Plaintiff, v. ..."; Pennsylvania/Massachusetts/Kentucky/Virginia: "COMMONWEALTH OF ..."). In a civil case the plaintiff comes first.
- Then: a short introduction (who is filing, what they ask for, under what rule), STATEMENT OF FACTS (numbered paragraphs, only facts the person gave you, in date order), LEGAL STANDARD, ARGUMENT (headed sub-points that apply the law to these facts), RELIEF REQUESTED (numbered), the signature block ("Respectfully submitted," then /s/ name, "Pro Se", address/phone placeholders), and a CERTIFICATE OF SERVICE naming who gets a copy (the prosecutor or opposing party/counsel) with a date placeholder. For a motion add a short proposed ORDER at the end when it is customary.
- Use the court rules and statutes of the right jurisdiction (state vs. federal; criminal vs. civil). Name the actual rule (for example Fed. R. Crim. P. 12, Fed. R. Civ. P. 56, W. Va. R. Crim. P. 12, 42 U.S.C. § 1983) only when you are confident it applies.
- CITATIONS: Prefer the case law in the RESEARCH list (it came from a real court database). You may also cite landmark U.S. Supreme Court cases you are certain of. Never invent a case, a quote, a page number or a holding. If you think authority exists but you are not sure of the exact citation, write [CITATION NEEDED: describe the point] instead. Put every case citation in standard Bluebook form (Name v. Name, Volume Reporter Page (Court Year)).
- QUOTES: Never put words in quotation marks as a quote from a case unless those exact words appear in that case's RESEARCH passage. Never add pin cites (page numbers after the first page) unless given. When you only know what a case is about, describe it in your own words with "See" (no quote marks), and if you are not sure the case holds exactly that, add [VERIFY HOLDING] after the citation.
- FACTS: The STATEMENT OF FACTS may only restate what the person told you. Do not add, assume or embellish anything (no extra actions by officers, places, times, words spoken, or what the person was thinking). Never invent facts, dates, names or numbers. Where something is missing, leave a clear placeholder in brackets like [DATE OF ARREST] or [OFFICER NAME].
- STATE LAW: Do not cite state statutes, state constitution sections, state court rules or state cases unless they are in the RESEARCH list; write [CITATION NEEDED: the state law on ...] instead, so the person can look it up.
- Describe a case's holding only if TRUSTED AUTHORITY or the RESEARCH passage says it; otherwise cite it with "See also" and add [VERIFY HOLDING].
- Be persuasive, respectful and professional. Keep it focused: strong arguments first, no filler.
After the document, add a line "----- NOTES FOR YOU (do not file this part) -----" with: deadlines or timing to check, what to attach (exhibits, affidavits), local rules to check (page limits, formatting, number of copies), every [placeholder] they must fill in, and a reminder to read every citation (the site's Verify button checks them).`;


// Landmark U.S. Supreme Court cases the AI may rely on, with their accepted holdings (checked by hand).
const TRUSTED = `TRUSTED AUTHORITY (real U.S. Supreme Court cases with their accepted holdings; cite only those that fit; never quote them, paraphrase only):
Terry v. Ohio, 392 U.S. 1 (1968): a brief investigative stop requires reasonable, articulable suspicion of criminal activity.
Rodriguez v. United States, 575 U.S. 348 (2015): police may not prolong a completed traffic stop to conduct a dog sniff without independent reasonable suspicion.
Illinois v. Caballes, 543 U.S. 405 (2005): a dog sniff during a lawful traffic stop is not a search only if the stop is not prolonged beyond the time reasonably required.
Florida v. Royer, 460 U.S. 491 (1983): an investigative detention must last no longer than necessary to carry out its purpose.
Whren v. United States, 517 U.S. 806 (1996): a traffic stop is reasonable when there is probable cause of a traffic violation, whatever the officer's motive.
Arizona v. Gant, 556 U.S. 332 (2009): limits on searching a vehicle incident to a recent occupant's arrest.
Katz v. United States, 389 U.S. 347 (1967): the Fourth Amendment protects reasonable expectations of privacy.
Mapp v. Ohio, 367 U.S. 643 (1961): evidence from an unconstitutional search is inadmissible in state court.
Wong Sun v. United States, 371 U.S. 471 (1963): evidence derived from an illegal search or seizure is suppressed as fruit of the poisonous tree.
Brown v. Illinois, 422 U.S. 590 (1975): Miranda warnings alone do not purge the taint of an illegal arrest from a later statement.
Miranda v. Arizona, 384 U.S. 436 (1966): custodial interrogation requires warnings; statements taken without them are inadmissible in the prosecution's case in chief.
Barker v. Wingo, 407 U.S. 514 (1972): speedy-trial claims weigh length of delay, reason for delay, the defendant's assertion of the right, and prejudice.
Doggett v. United States, 505 U.S. 647 (1992): excessive delay can be presumptively prejudicial in the speedy-trial analysis.
Stack v. Boyle, 342 U.S. 1 (1951): bail set higher than an amount reasonably calculated to assure the defendant's appearance is excessive under the Eighth Amendment.
United States v. Salerno, 481 U.S. 739 (1987): pretrial detention without bail is permitted only with strong procedural protections; liberty is the norm.
Brady v. Maryland, 373 U.S. 83 (1963): suppressing evidence favorable to the accused that is material to guilt or punishment violates due process.
Giglio v. United States, 405 U.S. 150 (1972): Brady covers evidence that impeaches a government witness.
Kyles v. Whitley, 514 U.S. 419 (1995): the prosecution must learn of favorable evidence known to others acting for it, including police.
Gideon v. Wainwright, 372 U.S. 335 (1963): the right to appointed counsel for felony defendants applies to the states.
Strickland v. Washington, 466 U.S. 668 (1984): ineffective assistance requires deficient performance and resulting prejudice.
Hill v. Lockhart, 474 U.S. 52 (1985): Strickland applies to guilty pleas; prejudice means a reasonable probability the defendant would have gone to trial.
Missouri v. Frye, 566 U.S. 134 (2012): counsel must communicate formal plea offers.
Lafler v. Cooper, 566 U.S. 156 (2012): ineffective advice that leads to rejecting a plea offer can be prejudicial.
Padilla v. Kentucky, 559 U.S. 356 (2010): counsel must advise a noncitizen client about deportation risk of a plea.
Faretta v. California, 422 U.S. 806 (1975): a defendant has the right to represent himself.
Boykin v. Alabama, 395 U.S. 238 (1969): a guilty plea must be knowing and voluntary, shown on the record.
Santobello v. New York, 404 U.S. 257 (1971): the government must keep promises made in a plea agreement.
Jackson v. Virginia, 443 U.S. 307 (1979): evidence is sufficient only if a rational juror could find every element beyond a reasonable doubt.
Haines v. Kerner, 404 U.S. 519 (1972): pro se pleadings are held to less stringent standards than those drafted by lawyers.
Erickson v. Pardus, 551 U.S. 89 (2007): a pro se complaint must be liberally construed.
Bell Atlantic Corp. v. Twombly, 550 U.S. 544 (2007): a complaint must state a plausible claim, not just conclusions.
Ashcroft v. Iqbal, 556 U.S. 662 (2009): the plausibility standard applies to all civil actions; bare conclusions are not assumed true.
Monell v. Department of Social Services, 436 U.S. 658 (1978): a local government is liable under § 1983 only for its own policy or custom.
Graham v. Connor, 490 U.S. 386 (1989): excessive-force claims in an arrest are judged by objective reasonableness under the Fourth Amendment.
Estelle v. Gamble, 429 U.S. 97 (1976): deliberate indifference to a prisoner's serious medical needs violates the Eighth Amendment.
Heck v. Humphrey, 512 U.S. 477 (1994): a § 1983 claim that would imply a conviction is invalid can't proceed unless the conviction has been set aside.
Pearson v. Callahan, 555 U.S. 223 (2009): courts may decide either qualified-immunity question first.
Celotex Corp. v. Catrett, 477 U.S. 317 (1986): summary judgment against a party who can't show evidence on an element it must prove.
Anderson v. Liberty Lobby, Inc., 477 U.S. 242 (1986): a dispute is genuine if a reasonable jury could find for the non-moving party.
Winter v. Natural Resources Defense Council, Inc., 555 U.S. 7 (2008): a preliminary injunction requires likely success, likely irreparable harm, a favorable balance of equities, and the public interest.
Mathews v. Eldridge, 424 U.S. 319 (1976): due-process balancing of private interest, risk of error, and government interest.`;
const TRUSTED_CITES = [...TRUSTED.matchAll(/(\d+ U\.S\. \d+)/g)].map((m) => m[1]);

// After the AI writes: flag anything that can't be traced to the court database or the trusted list.
const CITE_RE = /\b(\d{1,4}) (U\.S\.|S\. ?Ct\.|L\. ?Ed\. ?2d|F\.(?: ?2d| ?3d| ?4th)?|F\. ?Supp\.(?: ?2d| ?3d)?|F\. ?App'x|S\.E\.(?:2d)?|N\.E\.(?:2d|3d)?|N\.W\.(?:2d)?|S\.W\.(?:2d|3d)?|So\.(?: ?2d| ?3d)?|A\.(?:2d|3d)?|P\.(?:2d|3d)?|W\. ?Va\.|Md\.|Pa\.|Va\.) (\d{1,5})\b/g;
const norm = (c) => String(c || "").replace(/\s+/g, " ").replace(/S\. ?Ct\./, "S. Ct.").trim();
function guard(text, research) {
  let t = String(text || "").replace(/[\u2010-\u2015]/g, "-").replace(/[\u00a0\u202f\u2007]/g, " ").replace(/[\u2018\u2019]/g, "'").replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, "$1$2").replace(/^#{1,6}\s*/gm, "");
  const allowed = new Set([...TRUSTED_CITES, ...research.map((r) => norm(r.cite))].map(norm));
  const snippets = research.map((r) => String(r.snippet || "").toLowerCase()).join(" ");
  const flagged = [];
  const [body, notes = ""] = t.split(/(-{3,}\s*NOTES FOR YOU[\s\S]*)$/i);
  let b = body;
  // citations not from the database or the trusted list
  b = b.replace(CITE_RE, (m) => { const c = norm(m); if (allowed.has(c)) return m; flagged.push(c); return m + " [VERIFY: not from the court database]"; });
  // pin cites ("138 F.4th at 803", "71 F.4th 195, 199") were never given to the AI
  b = b.replace(/\b(\d{1,4} (?:U\.S\.|F\.(?: ?2d| ?3d| ?4th)?|S\.E\.2d|S\. ?Ct\.|F\. ?Supp\.(?: ?2d| ?3d)?)) at (\d{1,5})\b/g, (m) => m + " [VERIFY PAGE]");
  b = b.replace(/\b(\d{1,4} (?:U\.S\.|F\.(?: ?2d| ?3d| ?4th)?|S\.E\.2d|F\. ?Supp\.(?: ?2d| ?3d)?) \d{1,5}), (\d{1,5})(?=[\s(])/g, (m) => m + " [VERIFY PAGE]");
  // quotes of 6+ words that don't appear in any research passage
  b = b.replace(/[“"]([^”"\n]{30,400})[”"]/g, (m, q) => {
    const words = q.trim().split(/\s+/); if (words.length < 6) return m;
    const probe = q.toLowerCase().replace(/[^\w ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (probe && snippets.replace(/[^\w ]+/g, " ").replace(/\s+/g, " ").includes(probe)) return m;
    return m + " [QUOTE NOT VERIFIED: check the case or reword without quote marks]";
  });
  // state codes and constitution sections must be looked up
  b = b.replace(/\b((?:W\. ?Va\.|Md\.|Pa\.|Va\.|Ohio|N\.C\.|Ky\.|[A-Z][a-z]+\.) (?:Code|Const\.)(?: Ann\.)?,? (?:art\. [IVXLC]+, )?§+ ?[\w.-]*\w)/g, (m) => m + " [VERIFY]");
  let out = b + notes;
  if (flagged.length) out += "\n\nAUTO-CHECK: " + flagged.length + " citation(s) didn't come from the court database search, so they're marked [VERIFY]. Tap Verify citations, or remove them.";
  return out;
}

const REVIEW = `You are Meechie's AI, reviewing a court document drafted by or for a pro se litigant. You are not a lawyer; this is not legal advice.
Give a clear checklist review in plain text (no markdown symbols):
1. STRENGTH: how strong the main arguments are, in one or two sentences.
2. PROBLEMS: anything missing or wrong (missing caption parts, wrong court or rule, facts that don't support the argument, no relief requested, no certificate of service, unsigned, placeholders left).
3. CITATIONS: list every case and statute cited, and flag any that look made-up, misquoted, or out of jurisdiction. Say plainly that each must be checked.
4. IMPROVEMENTS: the 3-6 most important specific fixes, with suggested wording where useful.
5. BEFORE FILING: deadlines, copies, service, local rules.`;

const ASK = `You are Meechie's AI answering a legal-information question for a person representing themselves (pro se). You are not a lawyer; say so briefly and that this is legal information, not advice.
Explain in plain words: what the law or procedure generally is, which rule or statute usually governs (only if you are confident), what papers are usually filed, deadlines to watch, and the next step. Use the RESEARCH list for case law and cite it like [1]; never invent cases. If the answer depends on the state or court, say what to check. End with one clear next step on the site (the Legal Help tab can draft the document). Plain text, short paragraphs.`;

const SUGGEST = `You are Meechie's AI helping a pro se litigant decide what to file. You are not a lawyer; this is legal information.
From their facts, list the 2-4 documents from the provided list that best fit, most useful first. For each, one line in this exact form:
DOCUMENT: <exact name from the list> | WHY: <one plain sentence> | TIMING: <when it is usually filed or the deadline to check>
Then one line starting "ALSO:" with anything urgent (deadlines, bond, asking for a lawyer). Plain text only.`;

const FACTCHECK = `You are a careful legal fact-checker reviewing a court document written for a pro se litigant. You are not their lawyer.
Check every statement of law: each case and what the document says it holds, each quote, each rule and statute and whether it fits this court (state vs federal, criminal vs civil), and each legal standard.
Use the automatic citation check results: a citation marked NOT FOUND or a quote marked NOT IN THE CASE must be flagged as unreliable.
Answer in plain text (no markdown symbols) in this order:
VERIFIED: statements you are confident are correct.
NEEDS CHECKING: statements that may be right but must be confirmed, and how to confirm each.
LIKELY WRONG: statements that look wrong, made up, misquoted or from the wrong jurisdiction, with the fix.
MISSING: key law or arguments the document should probably include (name real, well-known authority only).
Be specific and short. Never invent authority.`;

async function claude(env, system, user) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 2500, system,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    return text ? "✓ Double-checked by Claude (Anthropic) with a web search.\n\n" + text : null;
  } catch (_) { return null; }
}

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
  const mode = ["draft", "revise", "review", "ask", "suggest", "factcheck"].includes(b.mode) ? b.mode : "draft";
  const research = (Array.isArray(b.research) ? b.research : []).slice(0, 10).map((r, i) =>
    `[${i + 1}] ${cut(r.name, 160)}, ${cut(r.cite, 80)} (${cut(r.court, 80)} ${cut(r.year, 8)})${r.snippet ? "\n    Passage from the opinion: " + cut(r.snippet, 700) : ""}`).join("\n");
  const R = research ? "\n\nRESEARCH (real cases from the CourtListener court database; use the ones that truly fit):\n" + research : "\n\nRESEARCH: none provided. Only cite Supreme Court cases you are certain of; otherwise use [CITATION NEEDED]." + "\n\n" + TRUSTED;
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" });

  let system, user, max = 3800, effort = "medium";
  if (mode === "suggest") {
    system = SUGGEST; max = 1200; effort = "low";
    user = "Their case:\n" + caseBlock(b.case) + "\nWhat happened:\n" + cut(b.facts, 8000) + "\n\nWhat they want:\n" + cut(b.relief, 2000) + "\n\nDocuments the site can draft (pick only from this list):\n" + cut(b.options, 3000);
  } else if (mode === "factcheck") {
    system = FACTCHECK; max = 2200; effort = "medium";
    user = "Their case:\n" + caseBlock(b.case) + "\nAutomatic citation check results (from the CourtListener court database):\n" + cut(b.checks, 6000) + "\n\nDocument to fact-check:\n" + cut(b.draft, 24000) + R;
    if (env.ANTHROPIC_API_KEY) { // ask Claude to double-check, with web search
      const c = await claude(env, system, user);
      if (c) return json({ text: c, model: "claude" });
    }
  } else if (mode === "ask") {
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
  const raw = (Array.isArray(b.research) ? b.research : []).slice(0, 10).map((r) => ({ cite: cut(r.cite, 80), snippet: cut(r.snippet, 700) }));
  const text = mode === "draft" || mode === "revise" ? guard(out.reply, raw) : out.reply;
  return json({ text, model: out.model });
}
