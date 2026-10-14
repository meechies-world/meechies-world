/* Age and ID check: after a member has been signed in for 3 minutes, they confirm they're 18 or older,
 * then verify their ID through Stripe Identity (when the owner has turned it on).
 * Only "age verified" / "ID verified" are saved on the profile, never the birthday or ID details. */
(function () {
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) { return null; } };
  const tok = () => (window.MW && MW.session && MW.session() && MW.session().access_token) || "";
  const ready = () => typeof db !== "undefined" && db && typeof me !== "undefined" && me && typeof profileMe !== "undefined" && profileMe;
  const owner = () => typeof isOwner !== "undefined" && isOwner;
  const say = (t) => (typeof toast === "function" ? toast(t) : 0);

  const css = document.createElement("style");
  css.textContent = `
#av-box{position:fixed;inset:0;z-index:10030;background:rgba(0,0,0,.78);display:grid;place-items:center;padding:16px}
#av-box .in{width:min(440px,100%);display:grid;gap:12px;background:#12100c;border:1px solid var(--gold);border-radius:18px;padding:22px;max-height:92vh;overflow:auto;text-align:center}
#av-box h3{margin:0;font-size:22px}#av-box p{margin:0;color:var(--muted);font-size:14px}
#av-box .dob{display:grid;grid-template-columns:1.3fr 1fr 1.2fr;gap:8px;text-align:left}
#av-box label{display:grid;gap:5px;font-size:13px;font-weight:600}
#av-box select,#av-box input[type=number]{font:16px var(--body);padding:11px 10px;border-radius:10px;border:1px solid var(--line);background:#0b0a08;color:var(--text);width:100%}
#av-box .ok{display:flex;gap:8px;align-items:flex-start;text-align:left;font-weight:500;font-size:14px}
#av-box .msg{min-height:1.1em;color:var(--gold-hi);font-size:14px}
#av-box .steps{display:flex;justify-content:center;gap:8px;font:700 12px var(--body);color:var(--muted)}#av-box .steps b{color:var(--gold-hi)}
#av-box .later{background:none;border:0;color:var(--muted);text-decoration:underline;cursor:pointer;font:14px var(--body)}`;
  document.head.appendChild(css);

  // coming back from Stripe's ID page
  const params = new URLSearchParams(location.search);
  if (params.get("idv") === "done") { history.replaceState(null, "", location.pathname + location.hash); setTimeout(checkId, 2500); }

  let secs = +(ls("mw_signed_secs") || 0);
  const t = setInterval(() => {
    if (!ready() || owner() || document.hidden || document.documentElement.classList.contains("gated")) return;
    if (profileMe.ageVerified && (profileMe.idVerified || ls("mw_id_later") === today())) { clearInterval(t); return; }
    secs++; if (secs % 10 === 0) ls("mw_signed_secs", String(secs));
    if (secs < 180) return; // 3 minutes signed in
    if (document.querySelector("dialog[open], #ct-box, #av-box")) return; // wait until they're not busy
    clearInterval(t); profileMe.ageVerified ? stepId() : stepAge();
  }, 1000);
  function today() { return new Date().toISOString().slice(0, 10); }

  function box(html) { let b = document.getElementById("av-box"); if (!b) { b = document.createElement("div"); b.id = "av-box"; document.body.appendChild(b); } b.innerHTML = `<div class="in" role="dialog" aria-modal="true" aria-labelledby="av-t">${html}</div>`; return b; }
  function stepAge() {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const b = box(`<div class="steps"><b>1 · Age</b><span>→</span><span>2 · ID</span></div>
      <h3 id="av-t">Quick safety check</h3>
      <p>To keep Meechie's World safe for everyone, members must be 18 or older. Enter your date of birth. We only save that you're old enough, never your birthday.</p>
      <div class="dob"><label>Month<select id="av-m"><option value="">Month</option>${months.map((m, i) => `<option value="${i}">${m}</option>`).join("")}</select></label>
      <label>Day<input type="number" id="av-d" min="1" max="31" inputmode="numeric" placeholder="DD"></label>
      <label>Year<input type="number" id="av-y" min="1900" max="2026" inputmode="numeric" placeholder="YYYY"></label></div>
      <label class="ok"><input type="checkbox" id="av-true" style="width:auto;margin-top:3px">This is my real date of birth.</label>
      <p class="msg" id="av-msg" aria-live="polite"></p>
      <button class="btn" type="button" id="av-go">Continue</button>`);
    b.querySelector("#av-go").addEventListener("click", async () => {
      const m = b.querySelector("#av-m").value, d = +b.querySelector("#av-d").value, y = +b.querySelector("#av-y").value, msg = b.querySelector("#av-msg");
      if (m === "" || !d || !y) { msg.textContent = "Enter your full date of birth."; return; }
      const dob = new Date(y, +m, d); if (dob.getMonth() !== +m || dob.getDate() !== d || y < 1900 || dob > new Date()) { msg.textContent = "That date doesn't look right."; return; }
      if (!b.querySelector("#av-true").checked) { msg.textContent = "Tick the box to confirm it's your real birthday."; return; }
      const now = new Date(); let age = now.getFullYear() - y; if (now.getMonth() < +m || (now.getMonth() === +m && now.getDate() < d)) age--;
      if (age < 18) {
        box(`<h3 id="av-t">Sorry, you must be 18 or older</h3><p>Meechie's World is for adults only. Come back when you're 18. We've signed you out.</p>`);
        try { await db.doc("members/" + me).update({ ageVerified: false, under18: true }); } catch (_) {}
        setTimeout(() => window.MW?.signOut?.(), 3500); return;
      }
      try { await db.doc("members/" + me).update({ ageVerified: true, ageVerifiedAt: Date.now() }); profileMe.ageVerified = true; } catch (_) {}
      stepId();
    });
  }
  async function stepId() {
    const b = box(`<div class="steps"><span>1 · Age ✓</span><span>→</span><b>2 · ID</b></div>
      <h3 id="av-t">Verify your ID</h3>
      <p>Take a photo of your driver's license, state ID or passport, plus a quick selfie. It's done on Stripe's secure page, and Meechie's World never sees or stores your ID, only that you're verified.</p>
      <p class="msg" id="av-msg" aria-live="polite"></p>
      <button class="btn" type="button" id="av-go">🪪 Verify my ID</button>
      <button class="later" type="button" id="av-later">Remind me tomorrow</button>`);
    const msg = b.querySelector("#av-msg");
    b.querySelector("#av-later").addEventListener("click", () => { ls("mw_id_later", today()); b.remove(); });
    b.querySelector("#av-go").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true; msg.textContent = "Opening the secure ID check...";
      try {
        const r = await fetch("/api/idv", { method: "POST", headers: { authorization: "Bearer " + tok() } }); const j = await r.json().catch(() => ({}));
        if (r.status === 501) { msg.textContent = "ID checks aren't switched on yet. You're all set for now. Thanks!"; ls("mw_id_later", today()); setTimeout(() => b.remove(), 2500); return; }
        if (!r.ok || !j.url) throw new Error(j.detail || "Couldn't start the ID check.");
        ls("mw_idv_session", j.id); location.href = j.url;
      } catch (err) { msg.textContent = (err && err.message) || "Couldn't start the ID check. Try again."; e.currentTarget.disabled = false; }
    });
  }
  async function checkId() {
    const id = ls("mw_idv_session"); if (!id || !tok()) return;
    try {
      const j = await fetch("/api/idv?id=" + encodeURIComponent(id), { headers: { authorization: "Bearer " + tok() } }).then((r) => r.json());
      if (j.status === "verified") { say("✅ Your ID is verified. Thank you!"); if (typeof profileMe !== "undefined" && profileMe) profileMe.idVerified = true; }
      else if (j.status === "processing") say("Your ID is being checked. This usually takes a minute.");
      else if (j.status === "requires_input") say("The ID check didn't go through. You can try again later.");
    } catch (_) {}
  }
})();
