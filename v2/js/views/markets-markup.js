/* markets view markup — the live section's own inner markup, verbatim (Phase 5). */
export const MARKUP = `
<div class="wrap">
    <div class="section-head">
      <div><p class="eyebrow">Live prices</p><h2>Markets</h2></div>
      <p class="muted">The stock market and crypto, live. Tap a name to see its chart, or search any stock or coin inside the chart.</p>
    </div>
    <div class="mk-tape" id="mk-tape"></div>
    <div class="mk-tabs" role="tablist"><button type="button" data-tab="stocks" class="on">📈 Stocks</button><button type="button" data-tab="crypto">🪙 Crypto</button><button type="button" data-tab="news">📰 Market News</button></div>
    <div data-pane="stocks">
      <div class="mk-grid">
        <div class="mk-card"><div class="mk-sym" id="mk-ssym"></div><div class="mk-chart" id="mk-schart"></div></div>
        <div class="mk-card"><h3>Today's biggest movers</h3><div class="mk-side" id="mk-movers"></div></div>
      </div>
      <div class="mk-card mk-wide"><h3>S&amp;P 500 map: which companies are up and down today</h3><div style="height:calc(100% - 34px)" id="mk-heat"></div></div>
    </div>
    <div data-pane="crypto" hidden>
      <div class="mk-grid">
        <div class="mk-card"><div class="mk-sym" id="mk-csym"></div><div class="mk-chart" id="mk-cchart"></div></div>
        <div class="mk-card"><h3>Top coins today</h3><div class="mk-side" id="mk-cover"></div></div>
      </div>
      <div class="mk-trade"><div><b>🪙 Meechie's Coin is coming</b><small class="muted">Get on the launch list and be first to know when it goes live.</small></div><a class="btn" href="#coin" data-go="coin">See Meechie's Coin</a></div>
      <div class="mk-card mk-wide"><h3>Every coin: price, market cap and volume</h3><div style="height:calc(100% - 34px)" id="mk-cscreen"></div></div>
    </div>
    <div data-pane="news" hidden>
      <div class="mk-card mk-wide" style="margin-top:0"><h3>Latest market headlines</h3><div style="height:calc(100% - 34px)" id="mk-news"></div></div>
    </div>
    <small class="mk-note">Market data and charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a>. Prices may be delayed. For information only — not financial advice.</small>
  </div>`;
