/* tv view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<style id="mv-styles">
#mv-grid .mv-skel{border:1px solid var(--gold-lo);border-radius:12px;padding:8px;background:#0d0b08}
#mv-grid .mv-skel .sk-img{aspect-ratio:4/3;border-radius:8px;background:linear-gradient(100deg,#171208 40%,#241b0d 50%,#171208 60%);background-size:200% 100%;animation:mvSk 1.2s linear infinite}
#mv-grid .mv-skel .sk-line{height:12px;border-radius:6px;margin-top:8px;background:linear-gradient(100deg,#171208 40%,#241b0d 50%,#171208 60%);background-size:200% 100%;animation:mvSk 1.2s linear infinite}
@keyframes mvSk{to{background-position:-200% 0}}
#mv-grid .mv-note{grid-column:1/-1;text-align:center;padding:18px 10px;color:var(--muted)}
#mv-grid .mv-note b{display:block;color:#e9e2cf;font-size:15px;margin-bottom:6px}
  </style>
  <div class="wrap">
    <div class="section-head">
      <div><p class="eyebrow">Meechie's World TV</p><h2>📺 TV — Free Movies</h2></div>
      <p class="muted">Thousands of free public-domain classics from the Internet Archive, playing right here — famous films, silent-era gems, sci-fi &amp; horror, vintage cartoons and the Prelinger vault. Free forever, no sign-up, and you never have to leave.</p>
    </div>
    <div class="card" style="padding:16px;margin-bottom:16px">
      <p class="eyebrow" style="margin:0">Meechie's World Cinema</p>
      <h3 style="margin:4px 0 6px">🍿 Free Movies — watch right here</h3>
      <div id="mv-stage" hidden>
        <div id="mv-frame"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px"><b id="mv-title"></b><button class="btn ghost sm" type="button" id="mv-close">✕ Close</button></div>
      </div>
      <form class="dj-search" id="mv-form" style="margin-top:10px"><input type="search" id="mv-q" placeholder="Search thousands of free movies..." aria-label="Search free movies"><button class="btn sm" type="submit">Search</button></form>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px" id="mv-shelves">
        <button class="btn sm mv-shelf" type="button" data-shelf="fame">⭐ Hall of Fame</button>
        <button class="btn ghost sm mv-shelf" type="button" data-shelf="halloween">🎃 Halloween</button>
        <button class="btn ghost sm mv-shelf" type="button" data-shelf="thanksgiving">🦃 Thanksgiving</button>
        <button class="btn ghost sm mv-shelf" type="button" data-shelf="christmas">🎄 Christmas</button>
        <button class="btn ghost sm mv-shelf" type="button" data-shelf="classics">🎞️ Silent-Era Classics</button>
        <button class="btn ghost sm mv-shelf" type="button" data-shelf="scifi">👽 Sci-Fi &amp; Horror</button>
        <button class="btn ghost sm mv-shelf" type="button" data-shelf="prelinger">📼 Prelinger Vault</button>
        <button class="btn ghost sm mv-shelf" type="button" data-shelf="cartoons">🐰 Classic Cartoons</button>
      </div>
    </div>
    <div id="mv-count" class="muted" style="font-size:13px;margin-bottom:8px">Loading the shelves…</div>
    <div id="mv-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px"><div class="mv-note"><b>🍿 Loading the shelves…</b>Free movies are on the way — this only takes a moment.</div><div class="mv-skel" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line" style="width:55%"></div></div><div class="mv-skel" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line" style="width:55%"></div></div><div class="mv-skel" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line" style="width:55%"></div></div><div class="mv-skel" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line" style="width:55%"></div></div><div class="mv-skel" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line" style="width:55%"></div></div><div class="mv-skel" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line" style="width:55%"></div></div><div class="mv-skel" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line" style="width:55%"></div></div><div class="mv-skel" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line" style="width:55%"></div></div></div>
    <div style="text-align:center;margin-top:16px"><button class="btn ghost" type="button" id="mv-more" hidden>Load more movies</button></div>
  </div>`;
