/* ads view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="section-head">
      <div><p class="eyebrow">Free for members</p><h2>Community Ad Board</h2></div>
      <button class="btn" id="new-ad" type="button">Post a free ad</button>
    </div>
    <h3 style="font-size:20px">Member Shops</h3>
    <p class="muted" style="margin:6px 0 0">Members link their Printify, Shopify, Etsy, or any store from their profile. Shop each other.</p>
    <div class="shops" id="shops"><p class="muted" style="margin:0">Linked stores show up here. Add yours under Community → Edit profile &amp; shops.</p></div>
    <div class="filters" id="ad-filters">
      <button class="chip" type="button" data-cat="all" aria-pressed="true">All</button>
      <button class="chip" type="button" data-cat="Business">Business</button>
      <button class="chip" type="button" data-cat="Event">Events</button>
      <button class="chip" type="button" data-cat="Service">Services</button>
      <button class="chip" type="button" data-cat="For Sale">For Sale</button>
      <button class="chip" type="button" data-cat="Hiring">Hiring</button>
    </div>
    <div class="ads" id="ads"></div>
    <div class="empty" id="ads-empty" style="margin-top:24px"><h3>No ads yet</h3><p>Post your business, event, or service here for free. Promoted ads show at the top.</p></div>
  </div>`;
