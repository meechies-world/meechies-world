/* services view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="lux-banner"><img src="/img/lux/eight-ways.webp" alt="Meechie's World Inc: 8 ways to diversify revenue. Music and studio, media and AI, promotion and artist development, websites code and AI, document preparation, apparel and merch, books and digital products, community and platform." loading="lazy" width="1100" height="1100"></div>
    <div class="section-head">
      <div><p class="eyebrow">Services</p><h2>What we do</h2></div>
      <p class="muted">Every service starts at $50. Message us on TikTok or Snapchat, or email, with what you need and we'll quote it.</p>
    </div>
    <div class="divisions">
      <a class="div" href="#studio" data-go="studio"><span class="code">DIV. 01 · STUDIO</span><h3>Music &amp; Studio</h3><ul><li>Music production and beats</li><li>Recording rap and singing artists</li><li>Sound engineering, mixing</li><li>Music video creation</li></ul><span class="go">Open the Studio →</span></a>
      <a class="div" href="#clips" data-go="clips"><span class="code">DIV. 02 · MEDIA</span><h3>Media &amp; Commercials</h3><ul><li>Commercial production</li><li>AI video and characters</li><li>TikTok content and series</li><li>Book-to-video and audiobooks</li></ul><span class="go">Watch our Clips →</span></a>
      <a class="div" href="#promote" data-go="promote"><span class="code">DIV. 03 · PROMOTION</span><h3>Promotion &amp; Artist Development</h3><ul><li>Artist development and branding</li><li>Concert and event promotion</li><li>Sales and distribution</li><li>Paid campaigns on this platform</li></ul><span class="go">Promote with us →</span></a>
      <a class="div" href="/websites" target="_blank" rel="noopener"><span class="code">DIV. 04 · DIGITAL</span><h3>Websites, Code &amp; AI</h3><ul><li>Website building</li><li>Coding and programming</li><li>AI prompting and automation</li><li>Documents, decks, spreadsheets, research</li></ul><span class="go">Ask Meechie's AI →</span></a>
      <a class="div" href="#contact" data-go="contact"><span class="code">DIV. 05 · LEGAL</span><h3>Legal Document Preparation</h3><ul><li>Paralegal services</li><li>Motions and packet preparation</li><li>Filing-ready PDF formatting</li><li>Document preparation only, not legal advice</li></ul><span class="go">Get a quote →</span></a>
      <a class="div" href="#messages" data-go="messages"><span class="code">DIV. 06 · INSIDE CONNECT</span><h3>Incarcerated Loved Ones</h3><ul><li>Helping families stay in touch</li><li>Help with approved money transfers</li><li>Grievance writing: food, conditions, rights</li><li>Reach us by DM</li></ul><span class="go">Message us →</span></a>
      <a class="div" href="#shop" data-go="shop"><span class="code">DIV. 07 · APPAREL</span><h3>Clothing &amp; Print</h3><ul><li>Meechie's World clothing line</li><li>On-demand printing setup for brands</li><li>Merch for artists and events</li></ul><span class="go">Shop the line →</span></a>
      <a class="div" href="#contact" data-go="contact"><span class="code">DIV. 08 · PROPERTY</span><h3>Home &amp; Property</h3><ul><li>House remodeling</li><li>Deep cleaning and cleanup</li><li>Landscaping</li></ul><span class="go">Get a quote →</span></a>
      <a class="div" href="#contact" data-go="contact"><span class="code">DIV. 09 · SECURITY</span><h3>Security</h3><ul><li>Event security</li><li>Personal security</li></ul><span class="go">Book security →</span></a>
    </div>
    <p class="note">Legal Document Preparation provides document preparation and paralegal support only. Meechie's World Inc is not a law firm and does not give legal advice.</p>

    <div style="margin-top:28px"><div class="card paybox" data-paybox hidden>
      <h3 style="font-size:22px">Pay Meechie's World</h3>
      <p class="muted" style="margin:6px 0 14px">Pay securely by card, Apple Pay, Google Pay, or Cash App Pay. Checkout is handled by Stripe. We never see your card number.</p>
      <div class="pay-row"><a class="btn pay-btn" data-pay="deposit" href="#" hidden>Pay $50 deposit</a><a class="btn ghost pay-btn" data-pay="custom" href="#" hidden>Pay an invoice or quote</a></div>
    </div>
    </div>
    <div class="section-head" style="margin-top:56px"><div><p class="eyebrow">Publishing</p><h2>Meechie's World Books</h2></div></div>
    <div class="books">
      <a class="book" href="/books/pyramids-of-egypt" aria-label="The Pyramids of Egypt — out now, free PDF" style="justify-content:flex-end;gap:6px;background:linear-gradient(180deg,transparent 0%,transparent 72%,rgba(8,7,5,.94) 88%),url('img/books/pyramids-cover.jpg') center/cover"><h3 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">The Pyramids of Egypt</h3><span class="eyebrow">Out now · Free PDF</span><span class="go" style="margin-top:0;padding-top:0">Read or download →</span></a>
      <a class="book" href="/paper-trail"><span class="eyebrow">Out now · Volume One, Part A</span><h3>Paper Trail</h3><p>Read it free, listen to the audiobook, or watch it one chapter at a time.</p><span class="go">Read · Listen · Watch →</span></a>
      <a class="book" href="https://meechiesworldinc.myshopify.com/cart/67736541167801:1" target="_blank" rel="noopener" aria-label="From Harlem to Fort Dix — out now, $10 eBook" style="justify-content:flex-end;gap:6px;background:linear-gradient(180deg,transparent 0%,transparent 72%,rgba(8,7,5,.94) 88%),url('img/books/harlem-fort-dix-cover.jpg') center/cover"><h3 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">From Harlem to Fort Dix</h3><span class="eyebrow">Out now · 342-page eBook · $10</span><span class="go" style="margin-top:0;padding-top:0">Buy &amp; download →</span></a>
      <a class="book" href="#books" data-go="books" aria-label="Donald J. Trump: An Investigative Biography — out now, read it free" style="justify-content:flex-end;gap:6px;background:linear-gradient(180deg,transparent 0%,transparent 72%,rgba(8,7,5,.94) 88%),url('img/books/trump-cover.jpg') center/cover"><h3 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Donald J. Trump: An Investigative Biography</h3><span class="eyebrow">Out now · Free for members</span><span class="go" style="margin-top:0;padding-top:0">Read the whole book →</span></a>
    </div>
  </div>`;
