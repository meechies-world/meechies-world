/* ============================================================================
   v2 PLACEHOLDER VIEW MODULE — every view not yet rebuilt renders this:
   its real name (from the MAP §2.1 inventory) in the brand style, an
   honest "under construction" note, and a way back home. A later phase
   replaces the registry entry with the view's real module; core does not
   change. (MAP §5: placeholders are how the shell ships first.)
   ============================================================================ */

export function render(root, ctx) {
  const v = ctx.view || {};
  root.innerHTML = `
  <div class="wrap">
    <section class="card" style="text-align:center;padding:44px 22px;margin-top:28px">
      <svg viewBox="0 0 300 340" style="width:110px;height:125px" role="img" aria-label="Meechie's World crest"><use href="#crest-full"/></svg>
      <div class="eyebrow" style="margin-top:14px">Meechie's World</div>
      <h2 style="margin:6px 0 10px">${esc(v.name || "This room")}</h2>
      <p class="muted" style="max-width:520px;margin:0 auto 8px">${esc(v.blurb || "")}</p>
      <p class="muted" style="max-width:520px;margin:0 auto 20px">This room is under construction in the new build — it opens in a later phase. It is fully live on the main site today.</p>
      <div class="cta-row" style="justify-content:center">
        <a class="btn" href="#home" data-go="home">← Back home</a>
        <a class="btn ghost" href="/">Open it on the live site</a>
      </div>
    </section>
  </div>`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
