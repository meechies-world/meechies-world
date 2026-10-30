/* ============================================================================
   v2 MARKETS VIEW (Phase 5) — the live js/markets.js, ported: live
   stock + crypto prices, charts and headlines from TradingView's
   free embeds. Each tab's widgets load only when the tab opens,
   exactly as live. The shell hash "#crypto" deep-link is honored
   the same way (Router arg "crypto" lands on the crypto tab).
   ============================================================================ */

import { MARKUP } from "./markets-markup.js";

export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const view = root;
  const TV = "https://s3.tradingview.com/external-embedding/embed-widget-";
  const base = { colorTheme: "dark", isTransparent: true, locale: "en" };
  function widget(el, name, cfg) {
    if (!el) return;
    el.innerHTML = "";
    const box = document.createElement("div"); box.className = "tradingview-widget-container"; box.style.height = "100%";
    const inner = document.createElement("div"); inner.className = "tradingview-widget-container__widget"; inner.style.height = "100%";
    const s = document.createElement("script"); s.src = TV + name + ".js"; s.async = true; s.textContent = JSON.stringify({ ...base, ...cfg });
    box.append(inner, s); el.appendChild(box);
  }
  const STOCKS = [["S&P 500", "FOREXCOM:SPXUSD"], ["Nasdaq", "FOREXCOM:NSXUSD"], ["Dow", "FOREXCOM:DJI"], ["Apple", "NASDAQ:AAPL"], ["Tesla", "NASDAQ:TSLA"], ["Nvidia", "NASDAQ:NVDA"], ["Amazon", "NASDAQ:AMZN"]];
  const COINS = [["Bitcoin", "BITSTAMP:BTCUSD"], ["Ethereum", "BITSTAMP:ETHUSD"], ["Solana", "COINBASE:SOLUSD"], ["XRP", "BITSTAMP:XRPUSD"], ["Dogecoin", "BINANCE:DOGEUSDT"]];
  const loaded = {};
  function chart(el, sym) { widget(el, "advanced-chart", { autosize: true, symbol: sym, interval: "D", timezone: "America/New_York", style: "1", allow_symbol_change: true, hide_side_toolbar: false, calendar: false, support_host: "https://www.tradingview.com" }); }
  function symButtons(holder, list, chartEl) {
    if (!holder) return;
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
    news() { widget(view.querySelector("#mk-news"), "timeline", { feedMode: "all_symbols", displayMode: "regular", width: "100%", height: "100%" }); },
  };
  function show(tab) {
    view.querySelectorAll(".mk-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    view.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (!loaded[tab]) { loaded[tab] = true; LOAD[tab](); }
  }
  const tabs = view.querySelector(".mk-tabs");
  if (tabs) tabs.addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) show(b.dataset.tab); });
  widget(view.querySelector("#mk-tape"), "ticker-tape", { symbols: [...STOCKS, ...COINS].map(([title, proName]) => ({ proName, title })), showSymbolLogo: true, displayMode: "adaptive" });
  show(ctx.view.arg === "crypto" ? "crypto" : "stocks");
}
export function destroy() {}
