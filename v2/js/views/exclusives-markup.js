/* exclusives view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<style>
    #v-exclusives .exclusive-hero{position:relative;overflow:hidden;border:1px solid rgba(218,177,78,.42);border-radius:22px;padding:clamp(24px,5vw,52px);background:radial-gradient(ellipse at 85% 5%,rgba(194,150,45,.22),transparent 42%),linear-gradient(135deg,#17140e,#080808 70%);box-shadow:0 18px 55px rgba(0,0,0,.28)}
    #v-exclusives .exclusive-hero h2{font-family:Cinzel,serif;font-size:clamp(34px,6vw,60px);line-height:1.05;max-width:760px;margin:8px 0 16px;color:#f2d17b}
    #v-exclusives .exclusive-hero p{max-width:700px;line-height:1.7}
    #v-exclusives .exclusive-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:22px 0}
    #v-exclusives .exclusive-card{border:1px solid rgba(218,177,78,.25);border-radius:18px;padding:22px;background:linear-gradient(160deg,rgba(255,255,255,.045),rgba(255,255,255,.015));min-width:0}
    #v-exclusives .exclusive-icon{width:52px;height:52px;display:grid;place-items:center;border-radius:15px;background:rgba(218,177,78,.12);border:1px solid rgba(218,177,78,.28);font-size:25px;margin-bottom:15px}
    #v-exclusives .exclusive-card h3{font-family:Cinzel,serif;color:#f2d17b;margin:0 0 9px;font-size:18px}
    #v-exclusives .exclusive-card p{line-height:1.6}
    #v-exclusives .exclusive-note{border-left:3px solid #cba64b;padding:12px 16px;background:rgba(203,166,75,.07);border-radius:0 10px 10px 0}
    @media(max-width:760px){#v-exclusives .exclusive-grid{grid-template-columns:1fr}#v-exclusives .exclusive-hero{padding:22px}}
  </style>
  <div class="wrap">
    <div class="exclusive-hero">
      <p class="eyebrow">Premium creator community</p>
      <h2>MEECHIES<br>EXCLUSIVES</h2>
      <p class="muted">Get closer to the creators you follow. Discover member-only updates, behind-the-scenes posts, creator fan clubs, virtual gifts, and live moments—all in Meechies World's signature black-and-gold style.</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:22px">
        <a class="btn" href="#creators" data-go="creators">Explore Creators</a>
        <a class="btn ghost" href="#live" data-go="live">Watch Live &amp; Battles</a>
      </div>
    </div>
    <div class="exclusive-grid">
      <article class="exclusive-card"><div class="exclusive-icon" aria-hidden="true">⭐</div><h3>Creator Fan Clubs</h3><p class="muted">Follow your favorite personalities and discover their community, updates, and premium offerings.</p><a class="btn ghost sm" href="#creators" data-go="creators">Meet Creators →</a></article>
      <article class="exclusive-card"><div class="exclusive-icon" aria-hidden="true">🔒</div><h3>Exclusive Posts</h3><p class="muted">A dedicated home for subscriber-only photos, videos, and behind-the-scenes content.</p><a class="btn ghost sm" href="#clips" data-go="clips">Explore Clips →</a></article>
      <article class="exclusive-card"><div class="exclusive-icon" aria-hidden="true">🎁</div><h3>Gifts &amp; Live Battles</h3><p class="muted">Celebrate creators with virtual gifts and bring the energy to head-to-head live battles.</p><a class="btn ghost sm" href="#live" data-go="live">Visit Live →</a></article>
    </div>
    <div class="exclusive-note muted"><strong style="color:#f2d17b">For creators:</strong> Meechies Exclusives is designed to support fan communities, premium content, and creator earnings. Paid subscriptions, gift checkout, and payouts need secure payment and creator-payout setup before transactions can go live.</div>
  </div>`;
