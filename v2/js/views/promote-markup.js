/* promote view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="section-head">
      <div><p class="eyebrow">Ad campaigns</p><h2>Promote with us</h2></div>
      <p class="muted">We put your content in front of the whole community and promote it on all of our social media: pinned in the feed, gold-framed on the Ad Board, and shouted out on our TikTok, Snapchat, and every Meechie's World page.</p>
    </div>
    <div class="tiers">
      <div class="tier"><h3>Spotlight</h3><div class="price">$50 <small>/ 7 days</small></div><ul><li>Gold "Promoted" badge</li><li>Top of the Ad Board</li><li>One pinned feed post</li></ul><button class="btn ghost" type="button" data-tier="Spotlight">Choose Spotlight</button><a class="btn pay-btn" data-pay="spotlight" href="#" hidden>Pay $50 now</a></div>
      <div class="tier feature"><span class="badge">Most popular</span><h3>Featured</h3><div class="price">$150 <small>/ 14 days</small></div><ul><li>Everything in Spotlight</li><li>Pinned in feed all 14 days</li><li>Mention in a TikTok video</li><li>Ad copy written for you</li></ul><button class="btn" type="button" data-tier="Featured">Choose Featured</button><a class="btn pay-btn" data-pay="featured" href="#" hidden>Pay $150 now</a></div>
      <div class="tier"><h3>Takeover</h3><div class="price">$400 <small>/ 30 days</small></div><ul><li>Everything in Featured</li><li>Dedicated TikTok video</li><li>Home page banner</li><li>Custom commercial available</li></ul><button class="btn ghost" type="button" data-tier="Takeover">Choose Takeover</button><a class="btn pay-btn" data-pay="takeover" href="#" hidden>Pay $400 now</a></div>
    </div>

    <div class="card" style="margin-top:28px">
      <h3 style="font-size:22px;margin-bottom:6px">Request a campaign</h3>
      <p class="muted" style="margin:0 0 18px">Paid already, or want to talk first? Fill this in and we'll turn it into a message you can DM us so we can set up your campaign.</p>
      <form id="camp-form" class="req">
        <div class="field"><label for="c-tier">Package</label><select id="c-tier"><option>Spotlight</option><option selected>Featured</option><option>Takeover</option></select></div>
        <div class="field"><label for="c-biz">Business or brand</label><input type="text" id="c-biz" maxlength="80" required></div>
        <div class="field"><label for="c-contact">How we reach you (TikTok, Snap, email, phone)</label><input type="text" id="c-contact" maxlength="120" required></div>
        <div class="field"><label for="c-link">Link to your content (optional)</label><input type="url" id="c-link" maxlength="300" placeholder="https://"></div>
        <div class="field full"><label for="c-goal">What do you want promoted?</label><textarea id="c-goal" maxlength="1000" required></textarea></div>
        <div class="full"><button class="btn" type="submit">Create my request</button></div>
      </form>
    </div>
    <div class="card" id="owner-inbox" style="margin-top:20px" hidden>
      <h3 style="font-size:18px">Your request is ready</h3>
      <p class="muted" style="margin:6px 0 0">Send it as a DM to <b>@meechiesworldinc</b> on TikTok, <b>elpesidentay</b> on Snapchat, or email <b>meechiesworldinc@aol.com</b>. We'll confirm and arrange payment.</p>
      <div class="inbox"><pre class="item" id="inbox" style="white-space:pre-wrap;margin:0;font:inherit"></pre></div>
    </div>
  </div>`;
