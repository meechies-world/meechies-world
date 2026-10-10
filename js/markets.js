/* Markets page: live stock market and crypto prices, charts and headlines.
 * Free embeds from TradingView. Each tab only loads when someone opens it. */
(function () {
  const view = document.getElementById("v-markets"); if (!view) return;
  const TV = "https://s3.tradingview.com/external-embedding/embed-widget-";
  const base = { colorTheme: "dark", isTransparent: true, locale: "en" };

  function widget(el, name, cfg) {
    el.innerHTML = "";
    const box = document.createElement("div"); box.className = "tradingview-widget-container"; box.style.height = "100%";
    const inner = document.createElement("div"); inner.className = "tradingview-widget-container__widget"; inner.style.height = "100%";
    const s = document.createElement("script"); s.src = TV + name + ".js"; s.async = true; s.textContent = JSON.stringify({ ...base, ...cfg });
    box.append(inner, s); el.appendChild(box);
  }

  const css = document.createElement("style");
  css.textContent = `
.mk-tape{min-height:46px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel)}
.mk-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 14px}
.mk-tabs button{font:700 14px var(--body);padding:9px 16px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer}
.mk-tabs button.on{background:var(--gold);color:var(--ink);border-color:var(--gold)}
.mk-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:14px}
.mk-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;overflow:hidden}
.mk-card h3{font-size:15px;margin:4px 6px 10px;letter-spacing:.5px}
.mk-chart{height:520px}.mk-side{height:520px}.mk-wide{height:560px;margin-top:14px}
.mk-sym{display:flex;gap:6px;flex-wrap:wrap;margin:0 6px 10px}
.mk-sym button{font:600 13px var(--body);padding:6px 11px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}
.mk-sym button.on{border-color:var(--gold);color:var(--gold-hi)}
.mk-note{display:block;margin-top:14px;color:var(--muted);font-size:13px}
.mk-trade{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:14px;padding:16px;border:1px solid var(--gold-lo,#8c6d26);border-radius:14px;background:linear-gradient(135deg,rgba(212,168,67,.12),transparent)}
.mk-trade b{display:block;font-size:17px}
@media (max-width:820px){.mk-grid{grid-template-columns:1fr}.mk-chart{height:420px}.mk-side{height:460px}.mk-wide{height:520px}}`;
  document.head.appendChild(css);

  const STOCKS = [["S&P 500", "FOREXCOM:SPXUSD"], ["Nasdaq", "FOREXCOM:NSXUSD"], ["Dow", "FOREXCOM:DJI"], ["Apple", "NASDAQ:AAPL"], ["Tesla", "NASDAQ:TSLA"], ["Nvidia", "NASDAQ:NVDA"], ["Amazon", "NASDAQ:AMZN"]];
  const COINS = [["Bitcoin", "BITSTAMP:BTCUSD"], ["Ethereum", "BITSTAMP:ETHUSD"], ["Solana", "COINBASE:SOLUSD"], ["XRP", "BITSTAMP:XRPUSD"], ["Dogecoin", "BINANCE:DOGEUSDT"]];
  const loaded = {};

  function chart(el, sym) {
    widget(el, "advanced-chart", { autosize: true, symbol: sym, interval: "D", timezone: "America/New_York", style: "1", allow_symbol_change: true, hide_side_toolbar: false, calendar: false, support_host: "https://www.tradingview.com" });
  }
  function symButtons(holder, list, chartEl) {
    holder.innerHTML = list.map(([n, s], i) => `<button type="button" data-s="${s}" class="${i ? "" : "on"}">${n}</button>`).join("");
    holder.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; holder.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); chart(chartEl, b.dataset.s); });
    chart(chartEl, list[0][1]);
  }

  const LOAD = {
    stocks() {
      symButtons(view.querySelector("#mk-ssym"), STOCKS, view.querySelector("#mk-schart"));
      widget(view.querySelector("#mk-movers"), "hotlists", { exchange: "US", dateRange: "1D", showChart: true, width: "100%", height: "100%", largeChartUrl: "" });
      widget(view.querySelector("#mk-heat"), "stock-heatmap", { exchanges: [], dataSource: "SPX500", grouping: "sector", blockSize: "market_cap_basic", blockColor: "change", hasTopBar: true, isDataSetEnabled: false, isZoomEnabled: true, hasSymbolTooltip: true, width: "100%", height: "100%" });
    },
    crypto() {
      symButtons(view.querySelector("#mk-csym"), COINS, view.querySelector("#mk-cchart"));
      widget(view.querySelector("#mk-cover"), "market-overview", { dateRange: "1D", showChart: true, width: "100%", height: "100%", showSymbolLogo: true, tabs: [{ title: "Crypto", symbols: COINS.map(([d, s]) => ({ s, d })) }] });
      widget(view.querySelector("#mk-cscreen"), "screener", { width: "100%", height: "100%", defaultColumn: "overview", screener_type: "crypto_mkt", displayCurrency: "USD" });
    },
    news() {
      widget(view.querySelector("#mk-news"), "timeline", { feedMode: "all_symbols", displayMode: "regular", width: "100%", height: "100%" });
    },
  };
  function show(tab) {
    view.querySelectorAll(".mk-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    view.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (!loaded[tab]) { loaded[tab] = true; LOAD[tab](); }
  }
  view.querySelector(".mk-tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) show(b.dataset.tab); });

  let started = false;
  function start() {
    if (started) return; started = true;
    widget(view.querySelector("#mk-tape"), "ticker-tape", { symbols: [...STOCKS, ...COINS].map(([title, proName]) => ({ proName, title })), showSymbolLogo: true, displayMode: "adaptive" });
    show(location.hash === "#crypto" ? "crypto" : "stocks");
  }
  window.MW_MARKETS = { show(tab) { start(); show(tab); } };
  new MutationObserver(() => { if (!view.hidden) start(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  if (!view.hidden) start();
})();
