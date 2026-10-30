/* creators view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="section-head">
      <div><p class="eyebrow">Build with us</p><h2>Creators</h2></div>
      <p class="muted">Design clothes for avatars and for our real clothing line, and join the team that builds Meechie's World.</p>
    </div>

    <h3 class="sub-h">The Wardrobe</h3>
    <p class="muted center-p">Outfits members designed for their avatars. Tap Try on to wear one, then style your own in the Virtual World and share it here.</p>
    <div class="wardrobe" id="wardrobe"><div class="empty">No outfits yet. Design one in the <a href="#world" data-go="world">Virtual World</a> and tap Share this outfit.</div></div>

    <h3 class="sub-h" style="margin-top:56px">What Meechie's World Apparel offers</h3>
    <p class="muted center-p">Design it here, get it voted on, and have it made. Everything below is how it works.</p>
    <div class="offer">
      <div><b>Design in your browser</b><span>T-shirts, long sleeves, hoodies, sweatshirts, and tanks in any color. Add text, symbols, and your own art, drag to place it, and design the front and back.</span></div>
      <div><b>Upload your finished art</b><span>Already have the artwork? Upload it, place it on the garment, and submit. A transparent PNG, 3000 pixels or bigger, prints best.</span></div>
      <div><b>Community vote</b><span>Members vote with 🔥 on every design. The designs we pick get added to the <a href="#shop" data-go="shop">Meechie's World store</a>.</span></div>
      <div><b>Made on demand</b><span>Printing is print-on-demand, so there is no stock to buy up front. Orders are printed and shipped as they come in.</span></div>
      <div><b>Your share, in writing</b><span>If your design is picked, we agree your share of each sale in writing before anything goes on sale. Nothing is guaranteed.</span></div>
      <div><b>Want your own clothing line?</b><span>We set up your designs, your store, and your printing. Services start at $50 and are quoted per job. <a href="#contact" data-go="contact">Ask us</a></span></div>
      <div><b>Avatar clothes are free</b><span>Dress your character in the Virtual World, then share the outfit to the Wardrobe above.</span></div>
      <div><b>Your art stays yours</b><span>By submitting you confirm the artwork is yours. We only use it if we contact you and you agree.</span></div>
    </div>

    <h3 class="sub-h" style="margin-top:56px">Clothing Design Studio</h3>
    <p class="muted center-p">Design your piece, or just upload your art. Tap anything on the shirt to edit it.</p>
    <div class="studio2">
      <div class="st-left">
        <div class="studio-canvas"><canvas id="st-canvas" aria-label="Your clothing design. Drag items to move them."></canvas></div>
        <div class="st-bar"><div id="st-viewbtns" class="filters"></div><button class="btn ghost sm" type="button" id="st-dl">Download picture</button></div>
      </div>
      <form class="card st-panel" id="st-form">
        <div class="st-sec"><b>1 · Garment</b><div id="st-garments" class="filters"></div>
          <div class="st-r"><label>Color</label><div id="st-colors" class="st-colors"></div></div>
          <div class="st-r"><label>Fabric</label><select id="st-tex"><option value="none">Smooth</option><option value="heather">Heather</option></select></div></div>
        <div class="st-sec"><b>2 · Add to your design</b>
          <div class="st-add">
            <label class="btn sm file-btn">⬆ Upload my art<input type="file" id="st-up-art" accept="image/*"></label>
            <button class="btn ghost sm" type="button" id="st-add-text">+ Text</button>
            <select id="st-add-sym" aria-label="Add a symbol"><option value="">+ Symbol</option><option value="emblem">All-seeing eye</option><option value="compass">Square &amp; compass</option><option value="star">Star</option><option value="crown">Crown</option><option value="flame">Flame</option><option value="bolt">Bolt</option></select>
            <label class="btn ghost sm file-btn">+ Picture<input type="file" id="st-up-img" accept="image/*"></label>
          </div></div>
        <div class="st-sec"><b>3 · Edit</b><div id="st-layers" class="st-layers"></div><div id="st-props" class="st-props"></div></div>
        <div class="st-sec"><b>4 · Submit</b>
          <div class="field"><label for="st-title">Design name</label><input type="text" id="st-title" maxlength="50" placeholder="e.g. Gold Eye Classic Tee" required></div>
          <div class="field"><label for="st-note">Notes for us (optional)</label><input type="text" id="st-note" maxlength="300" placeholder="Sizes, colors, ideas, or how to reach you"></div>
          <button class="btn" type="submit" id="st-submit">Submit design</button>
          <p class="muted" style="font-size:13px;margin:0">Your mockup and your main art file are saved for review. By submitting you confirm the artwork is yours.</p></div>
      </form>
    </div>
    <div class="filters" id="dg-sort" style="justify-content:center;margin-top:28px"><button class="chip" type="button" data-sort="top" aria-pressed="true">Top voted</button><button class="chip" type="button" data-sort="new">Newest</button></div>
    <div class="designs" id="designs"><div class="empty">Submitted designs show here for the community to vote on.</div></div>

    <div class="team">
      <div class="team-head">
        <svg class="sqc-ico" aria-hidden="true"><use href="#sqc"/></svg>
        <h3>Join the Team</h3>
        <p>Know how to make this platform better? We're looking for builders. Help grow Meechie's World and earn a share of what you help create.</p>
      </div>
      <div class="roles">
        <div><b>Designers</b><span>Clothing, avatar outfits, graphics, and the look of the app</span></div>
        <div><b>Developers</b><span>Web, apps, video, payments, and security</span></div>
        <div><b>Creators</b><span>Music, video, radio shows, and content</span></div>
        <div><b>Promoters</b><span>Grow the community and bring in advertisers</span></div>
        <div><b>Moderators</b><span>Keep the community safe and real</span></div>
      </div>
      <ol class="path">
        <li><b>Apply</b><span>Tell us what you do</span></li>
        <li><b>Talk</b><span>We meet and plan your part</span></li>
        <li><b>Agree</b><span>Your share is put in writing</span></li>
        <li><b>Earn</b><span>Ongoing income from what you build</span></li>
      </ol>
      <form class="card" id="team-form">
        <div class="req">
          <div class="field"><label for="tm-name">Your name or handle</label><input type="text" id="tm-name" maxlength="60" required></div>
          <div class="field"><label for="tm-role">Role</label><select id="tm-role"><option>Designer</option><option>Developer</option><option>Creator</option><option>Promoter</option><option>Moderator</option><option>Other</option></select></div>
          <div class="field"><label for="tm-contact">How we reach you</label><input type="text" id="tm-contact" maxlength="120" required></div>
          <div class="field"><label for="tm-link">Portfolio or work link (optional)</label><input type="url" id="tm-link" maxlength="300" placeholder="https://"></div>
          <div class="field full"><label for="tm-idea">How would you make Meechie's World better?</label><textarea id="tm-idea" maxlength="1200" required></textarea></div>
        </div>
        <button class="btn" type="submit">Create my application</button>
        <p class="muted" style="font-size:13px;margin:0">Income depends on the results of what you build and is set in a written agreement before work starts. Nothing is guaranteed.</p>
      </form>
      <div class="card" id="team-ready" hidden>
        <h3 style="font-size:18px">Your application is ready</h3>
        <p class="muted" style="margin:6px 0 10px">It's copied. Send it as a DM to <b>@meechiesworldinc</b> on TikTok, <b>elpesidentay</b> on Snapchat, or email <b>meechiesworldinc@aol.com</b>.</p>
        <pre class="item" id="team-msg" style="white-space:pre-wrap;margin:0;font:inherit;background:var(--panel-2);border-radius:10px;padding:12px 14px"></pre>
      </div>
    </div>
  </div>`;
