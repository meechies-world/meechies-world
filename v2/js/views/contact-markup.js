/* contact view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="section-head">
      <div><p class="eyebrow">Contact</p><h2>Message Meechie</h2></div>
      <p class="muted">DM us on TikTok or Snapchat for the fastest reply, or ask our AI assistant right now.</p>
    </div>
    <div class="card" id="ai-card" style="margin-bottom:24px">
      <h3 style="font-size:22px;display:flex;align-items:center;gap:12px"><img src="/img/meechie-ai-104.webp" alt="" width="52" height="52" decoding="async" style="width:52px;height:52px;border-radius:50%;object-fit:cover;border:2px solid var(--gold-hi)">Ask Meechie (AI assistant)</h3>
      <p class="muted" style="margin:6px 0 14px">Ask about services, pricing, ads, or how the platform works. It answers 24/7 and points you to the right next step.</p>
      <div class="msgs" id="ai-log" style="max-height:340px;padding:0 0 12px"></div>
      <form class="reply-form" id="ai-form"><input type="text" id="ai-q" aria-label="Ask Meechie" maxlength="500" placeholder="e.g. How much to record a song and shoot a video?" autocomplete="off"><button class="btn" type="submit">Ask</button></form>
    </div>
    <div class="card paybox" style="margin-bottom:24px" data-paybox hidden>
      <h3 style="font-size:22px">Pay Meechie's World</h3>
      <p class="muted" style="margin:6px 0 14px">Pay securely by card, Apple Pay, Google Pay, or Cash App Pay. Checkout is handled by Stripe. We never see your card number.</p>
      <div class="pay-row"><a class="btn pay-btn" data-pay="deposit" href="#" hidden>Pay $50 deposit</a><a class="btn ghost pay-btn" data-pay="custom" href="#" hidden>Pay an invoice or quote</a></div>
    </div>
    <div class="card support" style="margin-bottom:24px" data-paybox hidden>
      <svg class="sqc-ico" aria-hidden="true" style="width:44px;height:44px"><use href="#sqc"/></svg>
      <h3>Support Meechie's World</h3>
      <p class="muted">Love the community, the radio, and the free features? Chip in any amount to help keep it all running and growing.</p>
      <div class="pay-row"><a class="btn pay-btn" data-pay="donate" href="#" hidden>Donate</a></div>
      <small class="muted">Meechie's World is a business, not a charity, so contributions are not tax-deductible. Thank you for the love.</small>
    </div>
    <div class="socials">
      <a class="social" href="https://www.tiktok.com/@meechiesworldinc" target="_blank" rel="noopener"><span class="ico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 3c.4 2.2 1.8 3.7 4 3.9v3.1a7.5 7.5 0 0 1-4-1.2v6.4a6 6 0 1 1-6-6h.6v3.2a2.8 2.8 0 1 0 2.2 2.8V3h3.2Z"/></svg></span><div><b>TikTok</b><span>@meechiesworldinc</span></div></a>
      <a class="social" href="https://www.snapchat.com/add/elpesidentay" target="_blank" rel="noopener"><span class="ico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5c3 0 5.3 2.3 5.3 5.4v2.5c.5.2 1.1 0 1.6-.2.6-.2 1.1.5.6 1-.6.5-1.5.8-2 1.1.5 1.8 2 3.3 3.7 3.8.5.1.5.8 0 1-.8.3-1.7.4-2 .7-.2.4-.1 1-.6 1.1-.7.1-1.6-.2-2.6.1-1.1.4-1.9 1.7-4 1.7s-2.9-1.3-4-1.7c-1-.3-1.9 0-2.6-.1-.5-.1-.4-.7-.6-1.1-.3-.3-1.2-.4-2-.7-.5-.2-.5-.9 0-1 1.7-.5 3.2-2 3.7-3.8-.5-.3-1.4-.6-2-1.1-.5-.5 0-1.2.6-1 .5.2 1.1.4 1.6.2V7.9C6.7 4.8 9 2.5 12 2.5Z"/></svg></span><div><b>Snapchat</b><span>elpesidentay</span></div></a>
      <div class="social"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></span><div><b>Email</b><span>meechiesworldinc@aol.com</span></div><button class="btn ghost sm copy" type="button" data-copy="meechiesworldinc@aol.com">Copy</button></div>
      <div class="social"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg></span><div><b>Phone</b><span>(724) 970-6015</span></div><button class="btn ghost sm copy" type="button" data-copy="+17249706015">Copy</button></div>
    </div>
  </div>`;
