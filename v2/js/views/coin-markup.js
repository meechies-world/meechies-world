/* coin view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="cn-hero">
      <div id="cn-coin"></div>
      <div>
        <span class="cn-badge" id="cn-badge">COMING SOON</span>
        <h2>Meechie's Coin</h2>
        <p class="muted" id="cn-sym" style="margin:0 0 6px"></p>
        <p id="cn-about"></p>
        <div class="cn-acts"><a class="btn" id="cn-buy" href="#" target="_blank" rel="noopener" hidden>Buy Meechie's Coin</a><button class="btn" type="button" id="cn-notify">🔔 Notify me at launch</button><small class="muted" id="cn-count"></small></div>
      </div>
    </div>
    <div class="cn-chart" id="cn-chart" hidden></div>
    <div class="cn-grid">
      <div class="cn-card"><h3>What it's for</h3><ul id="cn-uses"></ul></div>
      <div class="cn-card cn-warn"><h3>⚠️ Stay safe</h3><p id="cn-warn-text" style="margin:0"></p></div>
      <div class="cn-card" id="cn-addr-card" hidden><h3>Official contract address <small class="muted" id="cn-addr-chain"></small></h3><div class="cn-addr"><code id="cn-addr"></code><button class="btn sm" type="button" id="cn-copy">Copy</button></div></div>
    </div>
    <div class="cn-own" id="cn-owner" hidden>
      <h3 style="margin-top:0">Owner: set up Meechie's Coin <small class="muted">(only you see this)</small></h3>
      <form id="cn-form">
        <label>Status<select name="status"><option value="soon">Coming soon</option><option value="live">Live (on sale)</option></select></label>
        <label>Ticker symbol (example: MEECH)<input name="symbol" maxlength="10" autocomplete="off"></label>
        <label>Blockchain<select name="chain"><option value="">Not picked yet</option><option value="solana">Solana</option><option value="base">Base</option><option value="ethereum">Ethereum</option><option value="bsc">BNB Chain</option><option value="polygon">Polygon</option><option value="arbitrum">Arbitrum</option></select></label>
        <label>Launch date (shows on the badge)<input name="launchDate" maxlength="30" placeholder="Dec 1, 2026"></label>
        <label class="full">Contract address (the coin's official address)<input name="contract" autocomplete="off" spellcheck="false"></label>
        <label class="full">Trading pair address (from DexScreener — shows the live price chart)<input name="pair" autocomplete="off" spellcheck="false"></label>
        <label class="full">Buy link (the swap page where people buy it, starts with https://)<input name="buyUrl" type="url" autocomplete="off"></label>
        <label class="full">About the coin<textarea name="about" rows="3" maxlength="600"></textarea></label>
        <label class="full">What it's for (one per line)<textarea name="uses" rows="4"></textarea></label>
        <div class="full" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="btn" type="submit">Save</button><small class="muted" id="cn-msg"></small></div>
      </form>
      <p class="muted" id="cn-list" style="margin:14px 0 6px"></p>
      <details><summary><b>Launch checklist</b></summary><ol class="cn-steps">
        <li>Talk to a lawyer who handles crypto first. Depending on how the coin is sold and promised, it can count as a security under SEC rules.</li>
        <li>Pick the blockchain (Solana and Base cost the least to launch on).</li>
        <li>Create the coin and set its total supply with a trusted token tool, using your own wallet. Keep the wallet's secret phrase offline and never share it.</li>
        <li>Add it to a trading pool (liquidity) so people can buy and sell it, then lock that liquidity so buyers can trust it.</li>
        <li>Paste the contract address, trading pair, and buy link above, and set Status to Live.</li>
        <li>Announce it with the site banner so the launch list and every member sees it.</li>
      </ol></details>
    </div>
    <small class="muted" style="display:block;margin-top:14px">Crypto is risky and prices can go to zero. Nothing on this page is financial advice.</small>
  </div>`;
