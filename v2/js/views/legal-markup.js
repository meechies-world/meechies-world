/* legal view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="section-head">
      <div><p class="eyebrow">Iustitiam quaerimus · We seek justice</p><h2>Legal Help</h2></div>
      <p class="muted">Representing yourself (pro se)? Build your case, and let Meechie's AI draft your motion, petition or complaint with real case law, then check every citation before you file.</p>
    </div>
    <div class="lg-warn"><b>⚖️ Legal document preparation, not legal advice.</b> Meechie's World isn't a law firm and the AI isn't a lawyer. You review, sign and file your own papers. Always read the cases you cite, check your court's local rules and deadlines, and talk to a lawyer or legal aid if you can. Your draft stays on this device unless you choose to request paid document preparation. If you submit a request, the case details you include are sent privately to Meechie for that purpose.</div>
    <nav class="lg-track" id="lg-track" aria-label="Your progress">
      <a href="#" data-to="lg-c1"><i>1</i>Your case</a><a href="#" data-to="lg-c2"><i>2</i>What happened</a><a href="#" data-to="lg-c3"><i>3</i>Document</a><a href="#" data-to="lg-draft-card"><i>4</i>Check &amp; file</a>
    </nav>
    <div class="lg-cases"><label>My cases<select id="lg-cases"></select></label><button class="btn sm ghost" type="button" id="lg-newcase">＋ New case</button><button class="btn sm ghost" type="button" id="lg-example">✨ Try an example</button></div>
    <div class="lg-steps">
      <div class="lg-card" id="lg-c1">
        <h3><span class="n">1</span>Your case</h3>
        <p>Fill in what you know. Leave anything blank you don't have. It saves on this device as you type.</p>
        <div class="lg-grid">
          <label>Court system<select data-k="system"><option>State court</option><option>Federal court</option></select></label>
          <label>State<select data-k="state" id="lg-state"></select></label>
          <label>County / federal district<input data-k="county" placeholder="e.g. Monongalia County / N.D. W. Va."></label>
          <label>Court name<input data-k="court" placeholder="e.g. Circuit Court of Monongalia County"></label>
          <label>Case number<input data-k="caseNo" placeholder="e.g. 22-F-163"></label>
          <label>Type of case<select data-k="type"><option>Criminal</option><option>Post-conviction / appeal</option><option>Civil rights (§ 1983)</option><option>Civil</option><option>Family</option><option>Landlord / tenant</option><option>Small claims</option><option>Other</option></select></label>
          <label>Judge<input data-k="judge" placeholder="Hon. ..."></label>
          <label>Your name (as on the case)<input data-k="name"></label>
          <label>You are the<select data-k="role"><option>Defendant</option><option>Plaintiff</option><option>Petitioner</option><option>Respondent</option><option>Appellant</option><option>Appellee</option></select></label>
          <label>Other side<input data-k="other" placeholder="e.g. State of West Virginia"></label>
          <label>Prosecutor / other side's lawyer<input data-k="otherCounsel" placeholder="Name and office"></label>
          <label>Charges or claims<input data-k="charges" placeholder="e.g. W. Va. Code § 61-2-9"></label>
          <label class="full">Where the case is now / next court date<input data-k="status" placeholder="e.g. Pretrial hearing set for Nov 3, 2026; in custody since ..."></label>
          <label>Your mailing address (for the signature)<input data-k="address" autocomplete="street-address"></label>
          <label>Phone / email (for the signature)<input data-k="contact"></label>
        </div>
        <div class="acts"><button class="btn sm ghost" type="button" id="lg-export">💾 Save case file</button><label class="btn sm ghost" style="cursor:pointer">📂 Open case file<input type="file" id="lg-import" accept="application/json,.json" hidden></label><button class="btn sm ghost" type="button" id="lg-clear">Start a new case</button></div>
      </div>

      <div class="lg-card" id="lg-c2">
        <h3><span class="n">2</span>What happened &amp; what you want</h3>
        <p>Write it in your own words, in order, with dates. The AI only uses facts you give it, and never makes facts up.</p>
        <div class="lg-grid">
          <label class="full">What happened<textarea data-k="facts" rows="8" placeholder="e.g. On March 3, 2026 police stopped my car for a broken taillight. They searched the trunk without asking or a warrant..."></textarea></label>
          <label class="full">What do you want the court to do?<textarea data-k="relief" rows="3" placeholder="e.g. Throw out the evidence from the search and dismiss the charge."></textarea></label>
          <label class="full">Legal issues or arguments <small>(optional: what you think was wrong)</small><textarea data-k="issues" rows="3" placeholder="e.g. illegal search, no probable cause, speedy trial, ineffective counsel"></textarea></label>
        </div>
      </div>

      <div class="lg-card" id="lg-c3">
        <h3><span class="n">3</span>Pick your document &amp; find real case law</h3>
        <p>The AI uses the cases you check here. They come from CourtListener, a free database of real court opinions.</p>
        <div class="lg-grid">
          <label class="full">Document<select data-k="doc" id="lg-doc"></select></label>
          <div class="full"><button class="btn sm ghost" type="button" id="lg-suggest">🤔 Not sure? Ask the AI what to file</button> <span class="lg-msg" id="lg-sug-msg"></span><div id="lg-sug" class="lg-ver"></div></div>
          <label class="full">Search case law about<input id="lg-q" placeholder="Leave blank to use your issues and document type"></label>
        </div>
        <div class="acts"><button class="btn sm" type="button" id="lg-find">🔎 Find real case law</button><span class="lg-msg" id="lg-find-msg"></span></div>
        <div class="lg-res" id="lg-res"></div>
        <label class="full" style="margin-top:12px">Extra instructions for the AI <small>(optional)</small><textarea data-k="instructions" rows="2" placeholder="e.g. Keep it under 6 pages. Mention that I asked my lawyer to file this and he refused."></textarea></label>
        <div class="acts"><button class="btn" type="button" id="lg-go">✍️ Draft my document</button><span class="lg-msg" id="lg-go-msg"></span></div>
      </div>

      <div class="lg-card" id="lg-draft-card">
        <h3><span class="n">4</span>Your document</h3>
        <p>Edit anything right here. Then tap <b>Verify</b> (checks every case and every quote against the real court opinions), <b>Double-check the law</b> (a second AI fact-checks every legal statement), and download it.</p>
        <textarea data-k="draft" id="lg-draft" spellcheck="true" placeholder="Your drafted document shows up here. You can also paste a document you already wrote to check or fix it."></textarea>
        <div class="acts"><button class="btn sm" type="button" id="lg-verify">✅ Verify citations &amp; quotes</button><button class="btn sm" type="button" id="lg-fact">🔍 Double-check the law</button><button class="btn sm ghost" type="button" id="lg-check">🧐 AI review</button><select id="lg-hist" style="width:auto"><option value="">Earlier versions</option></select><button class="btn sm ghost" type="button" id="lg-pdf">📄 Download PDF</button><button class="btn sm ghost" type="button" id="lg-print">🖨️ Print</button><button class="btn sm ghost" type="button" id="lg-copy">📋 Copy</button><label style="display:inline-flex;align-items:center;gap:6px;font-weight:500"><input type="checkbox" id="lg-dbl" checked style="width:auto">Double-spaced</label></div>
        <div class="lg-ver" id="lg-ver"></div>
        <div class="acts"><input id="lg-rev-ins" placeholder="Tell the AI what to change (e.g. add an argument about the 3-term rule)" style="flex:1;min-width:220px"><button class="btn sm" type="button" id="lg-revise">🔁 Revise</button><span class="lg-msg" id="lg-tools-msg"></span></div>
        <div class="lg-out" id="lg-fact-out" hidden></div>
        <div class="lg-out" id="lg-review" hidden></div>
      </div>

      <div class="lg-card" id="lg-hire" style="border-color:var(--gold)">
        <h3>👨🏽‍💼 Have Meechie prepare it for you <span class="badge" style="margin-left:auto">$20 + $20 per document</span></h3>
        <p>Meechie's World Inc can prepare and format your requested document for you to review, sign, and file. This is document preparation—not legal representation or legal advice. Meechie's World is not a law firm.</p>
        <div class="lg-fee-steps">
          <div><span class="lg-fee-num">01</span><div><b>Case processing · $20</b><p>Due after you submit your case information for review.</p></div></div>
          <div><span class="lg-fee-num">02</span><div><b>Document delivery · $20 per document</b><p>Due when your prepared document is ready to receive.</p></div></div>
        </div>
        <div class="lg-fee-total"><span>Estimated total for this request</span><strong id="lg-fee-total">$40</strong><small id="lg-fee-breakdown">$20 processing + $20 for 1 document</small></div>
        <div class="lg-grid">
          <label>Number of documents<select id="lg-hire-n"><option value="1">1 document</option><option value="2">2 documents</option><option value="3">3 documents</option><option value="4">4 documents</option><option value="5">5 documents</option></select></label>
          <label>Best way to reach you<input id="lg-hire-how" placeholder="Phone, email, or inmate mail address"></label>
          <label class="full">Anything else Meechie should know?<textarea id="lg-hire-note" rows="2" placeholder="Deadlines, court dates, what you've already filed..."></textarea></label>
        </div>
        <div class="lg-fee-setup"><b>Secure checkout setup required</b><span>The two payment stages will be enabled after Meechies World connects and tests its payment processor. This form does not collect payment.</span></div>
        <p style="margin:10px 0 0;font-size:13px;color:var(--muted)">If you submit this request, the case information you include is sent privately to Meechie in Messages so he can review the request. Only include information needed for the document.</p>
        <div class="acts"><button class="btn" type="button" id="lg-hire-go">📨 Submit case for review</button><a class="btn ghost pay-btn" data-pay="legal-processing" href="#" hidden>💳 Pay $20 processing fee</a><a class="btn ghost pay-btn" data-pay="legal-delivery" href="#" hidden>📄 Pay $20 document fee</a><span class="lg-msg" id="lg-hire-msg"></span></div>
      </div>

      <div class="lg-card">
        <h3>❓ Ask a legal question</h3>
        <p>How does bail work? What's a 2255? How do I serve the other side? The AI explains in plain words and looks up real cases.</p>
        <textarea id="lg-ask" rows="3" placeholder="Type your question"></textarea>
        <div class="acts"><button class="btn sm" type="button" id="lg-ask-go">Ask Meechie's AI</button><span class="lg-msg" id="lg-ask-msg"></span></div>
        <div class="lg-out" id="lg-ask-out" hidden></div>
      </div>

      <div class="lg-card">
        <h3>⏰ Common deadlines (federal court)</h3>
        <p>Missing a deadline can end your case. These are the usual federal limits. State courts set their own, so look up your state's rules or ask the clerk. Count calendar days, and check whether your court counts weekends and holidays.</p>
        <div class="lg-dl">
          <div><b>14 days</b><span>Notice of appeal in a criminal case, after the judgment <small>Fed. R. App. P. 4(b)(1)(A)</small></span></div>
          <div><b>30 days</b><span>Notice of appeal in a civil case, after the judgment (60 days if the U.S. is a party) <small>Fed. R. App. P. 4(a)(1)</small></span></div>
          <div><b>21 days</b><span>Answer a federal civil complaint after you're served <small>Fed. R. Civ. P. 12(a)(1)(A)(i)</small></span></div>
          <div><b>28 days</b><span>Motion to alter or amend a civil judgment, or for a new civil trial <small>Fed. R. Civ. P. 59(b), (e)</small></span></div>
          <div><b>14 days</b><span>Motion for a new trial in a criminal case, unless it's based on newly discovered evidence (3 years) <small>Fed. R. Crim. P. 33(b)</small></span></div>
          <div><b>1 year</b><span>Federal prisoner's § 2255 motion, usually counted from when the conviction became final <small>28 U.S.C. § 2255(f)</small></span></div>
          <div><b>1 year</b><span>State prisoner's federal habeas petition, with time paused while a proper state petition is pending <small>28 U.S.C. § 2244(d)</small></span></div>
          <div><b>14 days</b><span>Objections to a magistrate judge's report and recommendation <small>Fed. R. Civ. P. 72(b)(2); 28 U.S.C. § 636(b)(1)</small></span></div>
        </div>
      </div>

      <div class="lg-card">
        <h3>📚 Free legal resources</h3>
        <div class="lg-links">
          <a href="https://www.courtlistener.com/" target="_blank" rel="noopener"><b>CourtListener</b><small>Search millions of real court opinions, free</small></a>
          <a href="https://www.law.cornell.edu/" target="_blank" rel="noopener"><b>Cornell Legal Information Institute</b><small>Federal laws, court rules and plain-English guides</small></a>
          <a href="https://www.uscourts.gov/forms-rules/forms" target="_blank" rel="noopener"><b>U.S. Courts forms</b><small>Official federal forms, including pro se forms</small></a>
          <a href="https://www.uscourts.gov/court-programs/pro-se-litigants" target="_blank" rel="noopener"><b>Federal pro se help</b><small>How to represent yourself in federal court</small></a>
          <a href="https://www.lawhelp.org/" target="_blank" rel="noopener"><b>LawHelp.org</b><small>Find free legal aid in your state</small></a>
          <a href="https://scholar.google.com/" target="_blank" rel="noopener"><b>Google Scholar</b><small>Pick "Case law" to search cases</small></a>
          <a href="#contact" data-go="contact"><b>Meechie's World paralegal services</b><small>Want us to prepare your packet? Book document prep</small></a>
        </div>
      </div>
    </div>
  </div>`;
