// js/cj-shop.js — renders the cheap CJ deals in the Shop view and buys them
// through Meechie's own Stripe checkout. On payment the server auto-creates
// the CJ order and pays it from his CJ balance, so CJ ships it direct.
(function () {
  function money(cents) { return "$" + (cents / 100).toFixed(2); }
  function tok() { try { return (window.MW && MW.session && MW.session().access_token) || ""; } catch (e) { return ""; } }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  async function load() {
    var grid = document.querySelector("#cj-grid");
    if (!grid) return;
    var r;
    try { r = await fetch("/api/coins/cj-products"); } catch (e) { return; }
    if (!r || !r.ok) return;
    var j = await r.json().catch(function () { return {}; });
    var list = (j && j.products) || [];
    if (!list.length) { grid.innerHTML = '<p class="muted">Cheap deals are coming soon.</p>'; return; }
    grid.innerHTML = list.map(function (p) {
      return '<div class="prod"><div class="prod-a"><b>' + esc(p.name) + '</b>' +
        '<span class="pr">' + money(p.cents) + '</span>' +
        '<span class="buy">Buy now →</span></div>' +
        '<button type="button" class="btn cj-buy" data-cj="' + esc(p.id) + '">Buy with Stripe · ' + money(p.cents) + '</button></div>';
    }).join("");
    grid.addEventListener("click", async function (e) {
      var btn = e.target.closest(".cj-buy");
      if (!btn) return;
      btn.disabled = true; btn.textContent = "Opening checkout…";
      try {
        var res = await fetch("/api/coins/cj-checkout", {
          method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok() },
          body: JSON.stringify({ product: btn.getAttribute("data-cj") }),
        });
        var out = await res.json().catch(function () { return {}; });
        if (out && out.url) { location.href = out.url; return; }
        btn.disabled = false; btn.textContent = "Try again";
        alert((out && out.error) || "Could not open checkout. Sign in and try again.");
      } catch (err) {
        btn.disabled = false; btn.textContent = "Try again";
        alert("Could not open checkout. Sign in and try again.");
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
