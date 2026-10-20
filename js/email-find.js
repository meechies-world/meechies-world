/* Find people by email, without anyone's email being visible.
 * Each member's profile keeps only a scrambled fingerprint (SHA-256) of their email. Typing someone's exact
 * email makes the same fingerprint and finds them; nobody can read or list emails. Members can turn it off. */
(function () {
  "use strict";
  const ME = () => (typeof me !== "undefined" ? me : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  const MEM = () => (typeof members !== "undefined" ? members : {});
  async function hash(email) {
    const e = String(email || "").trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "";
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("meechies-world:" + e));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  const cache = {};
  // returns the member ids whose email is exactly this (usually 0 or 1)
  async function find(email) { const h = cache[email] || (cache[email] = await hash(email)); if (!h) return []; return Object.keys(MEM()).filter((id) => MEM()[id] && MEM()[id].emailHash === h); }
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
  window.MW_emailFind = { find, hash, isEmail };

  // keep my own fingerprint up to date (unless I turned it off)
  let done = false;
  setInterval(async () => {
    if (done || !ME() || !DB() || typeof profileMe === "undefined" || !profileMe) return;
    done = true;
    if (profileMe.emailFind === false) { if (profileMe.emailHash) DB().doc("members/" + ME()).update({ emailHash: "" }).catch(() => {}); return; }
    let em = ""; try { em = MW.session().user.email || ""; } catch (_) {}
    const h = await hash(em); if (h && profileMe.emailHash !== h) DB().doc("members/" + ME()).update({ emailHash: h }).catch(() => {});
  }, 4000);

  // Messenger search box: typing a full email finds that member
  document.addEventListener("input", async (e) => {
    const box = e.target.closest(".dm-search"); if (!box) return;
    const v = box.value.trim(); const list = document.querySelector("#v-messages .dm-list"); if (!list || !isEmail(v)) return;
    const ids = await find(v); if (box.value.trim() !== v) return;
    const H = (id) => String((MEM()[id] || {}).handle || "Member").replace(/[&<>"']/g, "");
    setTimeout(() => { list.innerHTML = ids.length ? ids.map((id) => `<button type="button" class="dm-row" data-open="${id}"><span class="dm-t"><b>${H(id)}</b><small>Found by email · tap to message</small></span></button>`).join("") : `<p class="muted" style="margin:10px 4px">Nobody on Meechie's World has that email (or they turned off "find me by email").</p>`; }, 30);
  });
})();
