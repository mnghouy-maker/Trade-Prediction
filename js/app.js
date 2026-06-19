/* Orchestration: fetch → compute → render, plus all UI wiring & the refresh loop. */
(function () {
  var U = CP.util;
  CP.state = {
    data: null, result: null, currentCoin: "bitcoin", selectedCoin: "bitcoin", timer: null,
    markets: [], marketsById: {}, coinCache: {}, currentPlan: null,
    search: "", sort: "market_cap", calcSide: "long", calcPrimed: false,
    live: false, lastUpdate: 0, chartCache: {},
  };

  // 365-day charts barely move intraday — cache them so the fast 30s refresh
  // only re-pulls light price/market data (keeps us "live" without rate limits).
  function getChartCached(id) {
    var c = CP.state.chartCache[id];
    if (c && Date.now() - c.time < CP.config.chartTTL) return Promise.resolve(c.chart);
    return CP.api.getMarketChart(id, 365).then(function (chart) {
      if (chart.live) CP.state.chartCache[id] = { time: Date.now(), chart: chart };
      return chart;
    });
  }

  function loadAll() {
    return Promise.all([
      CP.api.getSimple(),
      CP.api.getGlobal(),
      CP.api.getFearGreed(),
      getChartCached("bitcoin"),
      getChartCached("ethereum"),
      CP.api.getNews(),
    ]).then(function (res) {
      var simple = res[0], global = res[1], fg = res[2], btcChart = res[3], ethChart = res[4], news = res[5];

      var sent = CP.sentiment.analyze(news.items);

      return CP.api.getWhales(simple.data.bitcoin.usd).then(function (whales) {
        return finish(simple, global, fg, btcChart, ethChart, news, sent, whales);
      });
    }).catch(function (e) {
      console.error(e);
      CP.render.toast("Failed to load data — retrying next cycle.", "bear");
    });
  }

  function finish(simple, global, fg, btcChart, ethChart, news, sent, whales) {
      var d = {
        simple: simple.data,
        global: { marketCap: global.marketCap, change24h: global.change24h },
        fearGreed: fg,
        tech: {
          bitcoin: CP.indicators.compute(btcChart.closes),
          ethereum: CP.indicators.compute(ethChart.closes),
        },
        charts: { bitcoin: btcChart, ethereum: ethChart },
        sentiment: sent,
        whales: whales,
        trending: CP.sentiment.trending(news.items),
      };

      var signals = CP.score.buildSignals(d);
      var result = CP.score.evaluate(signals);
      d.result = result;

      CP.state.data = d;
      CP.state.result = result;

      // Global macro/news read — drives the Long/Short direction in the Trade tab.
      d.macro = CP.macro.evaluate(d.sentiment, d.fearGreed, computeEvents());
      CP.state.macro = d.macro;

      // Keep BTC/ETH technicals in the per-coin cache so the selected-coin view
      // shares one code path with screener-selected altcoins.
      CP.state.coinCache.bitcoin = { tech: d.tech.bitcoin, chart: d.charts.bitcoin };
      CP.state.coinCache.ethereum = { tech: d.tech.ethereum, chart: d.charts.ethereum };

      paint(d, result);
      selectCoin(CP.state.selectedCoin, true);

      // alerts + history use a flat snapshot
      CP.alerts.evaluate({ simple: d.simple, tech: d.tech, fearGreed: d.fearGreed, result: result, sentiment: d.sentiment });
      CP.render.renderAlerts();
      CP.history.record(result.direction, d.simple.bitcoin.usd);
      CP.render.renderHistory();

      // "Live" = real market prices + at least one real price chart. News / F&G
      // / global falling back to cache shouldn't downgrade the whole dashboard.
      CP.state.live = !!(simple.live && (btcChart.live || ethChart.live));
      CP.state.lastUpdate = Date.now();
      tickStatus();
  }

  // Ticks every second so the clock is always live and "updated Xs ago" counts up.
  function tickStatus() {
    var dot = U.el("liveDot");
    if (!dot) return;
    var live = CP.state.live;
    dot.className = "live-dot " + (live ? "live" : "demo");
    dot.title = live ? "Live market data" : "Connecting to live data…";
    var now = new Date();
    var label;
    if (!CP.state.lastUpdate) {
      label = "Connecting…";
    } else {
      var ago = Math.max(0, Math.round((Date.now() - CP.state.lastUpdate) / 1000));
      label = (live ? "Live" : "Reconnecting") + " · " + now.toLocaleTimeString() + " · updated " + ago + "s ago";
    }
    U.el("lastUpdated").textContent = label;
  }

  // 1-second live price refresh straight from Binance — keeps displayed prices
  // matching Binance without re-running the whole heavy pipeline.
  function priceTick() {
    if (!CP.state.data) return;
    var syms = ["BTCUSDT", "ETHUSDT"];
    var selSym = CP.api.binanceSymbol(CP.state.selectedCoin);
    if (selSym && syms.indexOf(selSym) === -1) syms.push(selSym);
    CP.api.getBinancePrices(syms).then(function (map) {
      if (!map) return;
      applyLivePrice("bitcoin", "BTCUSDT", map);
      applyLivePrice("ethereum", "ETHUSDT", map);
      applyLivePrice(CP.state.selectedCoin, selSym, map);
      CP.state.live = true;
      CP.state.lastUpdate = Date.now();
      refreshPriceUI();
      tickStatus();
    });
  }

  function applyLivePrice(id, sym, map) {
    if (!id || !sym || map[sym] == null) return;
    var p = map[sym];
    if (CP.state.data && CP.state.data.simple[id]) CP.state.data.simple[id].usd = p;
    if (CP.state.marketsById[id]) CP.state.marketsById[id].price = p;
    var c = CP.state.coinCache[id];
    if (c && c.tech) c.tech.price = p;
  }

  // Repaint just the price-sensitive parts (cheap) on each live tick.
  function refreshPriceUI() {
    var id = CP.state.selectedCoin;
    var meta = metaFor(id);
    var entry = CP.state.coinCache[id];
    if (entry && entry.tech) {
      CP.render.renderTechnical({ symbol: meta.symbol, tech: entry.tech, change24h: meta.change24h, volume: meta.volume });
    }
    // Also refresh the price strip on the dashboard
    if (CP.state.data) CP.render.renderPriceStrip(CP.state.data);
  }

  function paint(d, result) {
    CP.render.renderHero(result, d);
    CP.render.renderPriceStrip(d);
    CP.render.renderOverview(d, result);
    CP.render.renderFearBanner(d.sentiment);
    CP.render.renderAI(result, d);
    CP.render.renderNews(d.sentiment);
    CP.render.renderSentiment(d.sentiment, d.trending);
    CP.render.renderWhales(d.whales);
    CP.render.renderCalendar(computeEvents());
  }

  // ---- Selected-coin: technical + trade plan + calculator priming ----
  function metaFor(id) {
    var m = CP.state.marketsById[id];
    if (m) return { symbol: m.symbol, name: m.name, price: m.price, change24h: m.change24h, volume: m.volume, image: m.image || null };
    var d = CP.state.data;
    if (d && d.simple[id]) {
      var sym = id === "ethereum" ? "ETH" : id === "bitcoin" ? "BTC" : id.toUpperCase();
      return { symbol: sym, name: sym, price: d.simple[id].usd, change24h: d.simple[id].usd_24h_change, volume: d.simple[id].usd_24h_vol, image: null };
    }
    return { symbol: id.toUpperCase(), name: id, price: null, change24h: 0, volume: 0, image: null };
  }

  function techFor(id) {
    if (CP.state.coinCache[id]) return Promise.resolve(CP.state.coinCache[id]);
    return CP.api.getMarketChart(id, 365).then(function (chart) {
      var entry = { tech: CP.indicators.compute(chart.closes), chart: chart };
      CP.state.coinCache[id] = entry;
      return entry;
    });
  }

  function selectCoin(id, isRefresh) {
    CP.state.selectedCoin = id;
    CP.state.currentCoin = id;
    var meta = metaFor(id);

    // Update the BTC/ETH switcher buttons — if the coin is one of them mark it active,
    // otherwise clear both so neither appears selected (altcoin mode).
    document.querySelectorAll(".coin-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-coin") === id);
    });

    // Show the selected coin's logo + symbol in the switcher area if it's an altcoin
    var switchEl = U.el("coinSwitch");
    var existing = switchEl ? switchEl.querySelector(".coin-btn-selected") : null;
    if (switchEl) {
      if (id !== "bitcoin" && id !== "ethereum") {
        if (!existing) {
          var altBtn = document.createElement("span");
          altBtn.className = "coin-btn-selected";
          switchEl.appendChild(altBtn);
        }
        var logoHtml = meta.image
          ? '<img src="' + U.escapeHtml(meta.image) + '" width="14" height="14" style="border-radius:50%;vertical-align:middle;margin-right:4px" />'
          : "";
        switchEl.querySelector(".coin-btn-selected").innerHTML = logoHtml + U.escapeHtml(meta.symbol);
      } else {
        if (existing) existing.remove();
      }
    }

    // Update trade label with logo if available
    var tradeLbl = U.el("tradeCoinLabel");
    if (tradeLbl) {
      var tlogoHtml = meta.image
        ? '<img src="' + U.escapeHtml(meta.image) + '" width="16" height="16" style="border-radius:50%;vertical-align:middle;margin-right:5px" />'
        : "";
      tradeLbl.innerHTML = tlogoHtml + U.escapeHtml(meta.symbol);
    }

    if (!isRefresh) {
      CP.render.renderTechnical({ tech: null, symbol: meta.symbol });
      U.el("tradeBody").innerHTML = '<div class="skeleton">Building trade plan for ' + U.escapeHtml(meta.symbol) + "…</div>";
    }

    // Show the coin in the Tools detail panel immediately with screener data
    var screenerCoin = CP.state.marketsById[id] || null;
    CP.render.renderCoinDetail(screenerCoin, null);

    techFor(id).then(function (entry) {
      CP.render.renderTechnical({ symbol: meta.symbol, tech: entry.tech, change24h: meta.change24h, volume: meta.volume });
      var plan = CP.trade.buildPlan(entry.tech, entry.chart.closes, CP.state.macro);
      CP.state.currentPlan = plan;
      renderTradeFromState();
      primeCalculator(entry.tech.price, plan);
      if (CP.state.markets.length) CP.render.renderScreener(filteredSortedMarkets(), id);
      // Update detail panel with full tech data once loaded
      CP.render.renderCoinDetail(screenerCoin, entry.tech);
    });
  }

  // Re-render the Trade Signal from the current plan, reading the position-size
  // box so the $ profit/loss at each level updates live as it's typed.
  function renderTradeFromState() {
    var plan = CP.state.currentPlan;
    if (!plan) return;
    var meta = metaFor(CP.state.selectedCoin);
    var posEl = U.el("tradePosSize");
    var pos = posEl ? parseFloat(posEl.value) : 1000;
    if (isNaN(pos) || pos < 0) pos = 0;
    CP.render.renderTrade(plan, meta.symbol, plan.entry, pos);
  }

  // ---- Profit calculator ----
  function readNum(id) { var v = parseFloat(U.el(id).value); return isNaN(v) ? 0 : v; }

  function primeCalculator(price, plan) {
    if (!CP.state.calcPrimed && plan && plan.side === "short") setCalcSide("short");
    if (!U.el("calcEntry").value && price) U.el("calcEntry").value = trimNum(price);
    if (!U.el("calcExit").value) {
      if (plan && plan.targets) U.el("calcExit").value = trimNum(plan.targets[0]);
      else if (price) U.el("calcExit").value = trimNum(price * 1.05);
    }
    if (!U.el("calcQty").value && price) U.el("calcQty").value = trimNum(1000 / price); // ~$1,000 position
    CP.state.calcPrimed = true;
    calcUpdate();
  }
  function trimNum(n) { return n >= 1 ? (+n.toFixed(2)).toString() : (+n.toPrecision(5)).toString(); }

  function setCalcSide(side) {
    CP.state.calcSide = side;
    document.querySelectorAll(".calc-side").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-side") === side);
    });
    calcUpdate();
  }

  function calcUpdate() {
    var entry = readNum("calcEntry"), exit = readNum("calcExit");
    var lev = readNum("calcLev") || 1, fee = (readNum("calcFee") || 0) / 100;
    var qty = readNum("calcQty"), notion = readNum("calcNotional");
    if (notion > 0 && qty <= 0 && entry > 0) qty = notion / entry;
    if (entry <= 0 || exit <= 0 || qty <= 0) {
      U.el("calcResults").innerHTML = '<div class="skeleton">Enter entry, exit and quantity (or position size).</div>';
      return;
    }
    CP.render.renderCalc(CP.trade.calcPnl(CP.state.calcSide, entry, exit, qty, lev, fee));
  }

  // ---- Screener ----
  function loadMarkets(count) {
    var n = count || +U.el("screenerCount").value;
    var msg = n > 100
      ? 'Loading ' + n + ' coins (fetching multiple pages — may take a few seconds)…'
      : 'Loading coins…';
    U.el("screenerBody").innerHTML = '<div class="skeleton">' + msg + '</div>';
    return CP.markets.getMarkets(n).then(function (res) {
      CP.state.markets = res.coins;
      CP.state.marketsById = {};
      res.coins.forEach(function (c) { CP.state.marketsById[c.id] = c; });
      CP.render.renderScreener(filteredSortedMarkets(), CP.state.selectedCoin);
    });
  }

  function filteredSortedMarkets() {
    var q = (CP.state.search || "").toLowerCase().trim();
    var arr = CP.state.markets.filter(function (c) {
      return !q || c.name.toLowerCase().indexOf(q) !== -1 || c.symbol.toLowerCase().indexOf(q) !== -1;
    });
    var s = CP.state.sort;
    return arr.slice().sort(function (a, b) {
      if (s === "score") return b.score - a.score;
      if (s === "change24h") return (b.change24h || 0) - (a.change24h || 0);
      if (s === "volume") return (b.volume || 0) - (a.volume || 0);
      return (a.rank || 9999) - (b.rank || 9999);
    });
  }

  // ---- Economic calendar: roll each anchor forward to its next occurrence ----
  function computeEvents() {
    var now = Date.now();
    return CP.economicEvents.map(function (e) {
      var t = new Date(e.anchor + "T13:30:00Z").getTime();
      var period = e.periodDays * 86400000;
      while (t < now) t += period;
      var diff = t - now;
      var days = Math.floor(diff / 86400000);
      var hours = Math.floor((diff % 86400000) / 3600000);
      var dt = new Date(t);
      return {
        name: e.name, impact: e.impact,
        dateStr: dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
        countdown: days > 0 ? days + "d " + hours + "h" : hours + "h",
        sortT: t,
      };
    }).sort(function (a, b) { return a.sortT - b.sortT; });
  }

  // ---- Backtesting ----
  function runBacktest() {
    var coin = U.el("backtestCoin").value;
    var days = +U.el("backtestDays").value;
    var coinName = coin === "ethereum" ? "Ethereum" : "Bitcoin";
    U.el("backtestBody").innerHTML = '<div class="skeleton">Fetching ' + days + " days of history & replaying model…</div>";
    CP.api.getMarketChart(coin, days).then(function (chart) {
      if (chart.closes.length < 220) {
        U.el("backtestBody").innerHTML = '<div class="skeleton">Not enough history returned to backtest.</div>';
        return;
      }
      var stats = CP.backtest.run(chart.closes);
      CP.render.renderBacktest(stats, coinName + (chart.live ? "" : " (sample data)"), days);
    });
  }

  // ---- Tab navigation ----
  function switchTab(name) {
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".tab-panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "tab-" + name);
    });
  }

  function wireTabNav() {
    var nav = U.el("tabNav");
    if (!nav) return;
    nav.addEventListener("click", function (e) {
      var btn = e.target.closest(".tab-btn");
      if (!btn) return;
      switchTab(btn.getAttribute("data-tab"));
    });
    var fc = U.el("fearClose");
    if (fc) fc.addEventListener("click", function () { U.el("fearBanner").classList.add("hidden"); });
  }

  // ---- Wiring ----
  function wire() {
    wireTabNav();
    U.el("refreshBtn").addEventListener("click", function () { loadAll(); });

    U.el("coinSwitch").addEventListener("click", function (e) {
      var btn = e.target.closest(".coin-btn");
      if (!btn) return;
      selectCoin(btn.getAttribute("data-coin"));
    });

    // Screener: search, sort, count, row selection
    U.el("coinSearch").addEventListener("input", function (e) {
      CP.state.search = e.target.value;
      CP.render.renderScreener(filteredSortedMarkets(), CP.state.selectedCoin);
    });
    U.el("screenerSort").addEventListener("change", function (e) {
      CP.state.sort = e.target.value;
      CP.render.renderScreener(filteredSortedMarkets(), CP.state.selectedCoin);
    });
    U.el("screenerCount").addEventListener("change", function () { loadMarkets(); });
    U.el("screenerBody").addEventListener("click", function (e) {
      var row = e.target.closest(".screener-row");
      if (!row) return;
      CP.state.calcPrimed = false;
      ["calcEntry", "calcExit", "calcQty"].forEach(function (id) { U.el(id).value = ""; });
      selectCoin(row.getAttribute("data-coin"));
      switchTab("trade");
    });

    // Trade tab coin search
    var tradeSearchEl = U.el("tradeCoinSearch");
    var tradeSuggestEl = U.el("tradeCoinSuggest");
    if (tradeSearchEl) {
      tradeSearchEl.addEventListener("input", function (e) {
        var q = (e.target.value || "").toLowerCase().trim();
        if (!q || !CP.state.markets.length) { tradeSuggestEl.innerHTML = ""; return; }
        var matches = CP.state.markets.filter(function (c) {
          return c.name.toLowerCase().indexOf(q) !== -1 || c.symbol.toLowerCase().indexOf(q) !== -1;
        }).slice(0, 6);
        if (!matches.length) { tradeSuggestEl.innerHTML = '<div class="coin-suggest-none">No coins found.</div>'; return; }
        tradeSuggestEl.innerHTML = matches.map(function (c) {
          var img = c.image ? '<img src="' + U.escapeHtml(c.image) + '" width="20" height="20" style="border-radius:50%;margin-right:7px;vertical-align:middle" />' : "";
          return '<div class="coin-suggest-item" data-coin="' + U.escapeHtml(c.id) + '">' +
            img + '<strong>' + U.escapeHtml(c.symbol) + '</strong> <span>' + U.escapeHtml(c.name) + '</span></div>';
        }).join("");
      });
      tradeSuggestEl.addEventListener("click", function (e) {
        var item = e.target.closest(".coin-suggest-item");
        if (!item) return;
        tradeSearchEl.value = "";
        tradeSuggestEl.innerHTML = "";
        CP.state.calcPrimed = false;
        ["calcEntry", "calcExit", "calcQty"].forEach(function (id) { U.el(id).value = ""; });
        selectCoin(item.getAttribute("data-coin"));
      });
      document.addEventListener("click", function (e) {
        if (!tradeSearchEl.contains(e.target) && !tradeSuggestEl.contains(e.target)) {
          tradeSuggestEl.innerHTML = "";
        }
      });
    }

    // Trade Signal: position-size box re-computes the $ profit/loss at each level
    var posEl = U.el("tradePosSize");
    if (posEl) posEl.addEventListener("input", renderTradeFromState);

    // Calculator: live recompute + side toggle + presets
    ["calcEntry", "calcExit", "calcQty", "calcLev", "calcFee", "calcNotional"].forEach(function (id) {
      U.el(id).addEventListener("input", calcUpdate);
    });
    document.querySelectorAll(".calc-side").forEach(function (b) {
      b.addEventListener("click", function () { setCalcSide(b.getAttribute("data-side")); });
    });
    U.el("calcUseLive").addEventListener("click", function () {
      var m = metaFor(CP.state.selectedCoin); if (m.price) { U.el("calcEntry").value = trimNum(m.price); calcUpdate(); }
    });
    U.el("calcUseTP").addEventListener("click", function () {
      var p = CP.state.currentPlan; if (p && p.targets) { U.el("calcExit").value = trimNum(p.targets[0]); calcUpdate(); }
    });
    U.el("calcUseStop").addEventListener("click", function () {
      var p = CP.state.currentPlan; if (p && p.stop) { U.el("calcExit").value = trimNum(p.stop); calcUpdate(); }
    });

    U.el("addAlertBtn").addEventListener("click", function () {
      var m = U.el("alertMetric").value, op = U.el("alertOp").value, v = U.el("alertValue").value;
      if (v === "" || isNaN(+v)) { CP.render.toast("Enter a numeric alert value.", "bear"); return; }
      CP.alerts.add(m, op, v);
      U.el("alertValue").value = "";
      CP.render.renderAlerts();
      if (CP.state.data) {
        CP.alerts.evaluate({ simple: CP.state.data.simple, tech: CP.state.data.tech, fearGreed: CP.state.data.fearGreed, result: CP.state.result, sentiment: CP.state.data.sentiment });
        CP.render.renderAlerts();
      }
    });

    U.el("alertList").addEventListener("click", function (e) {
      var btn = e.target.closest(".alert-del");
      if (!btn) return;
      CP.alerts.remove(+btn.getAttribute("data-id"));
      CP.render.renderAlerts();
    });

    U.el("notifyBtn").addEventListener("click", function () { CP.alerts.requestPermission(); });

    var bn = U.el("alertBearishNews");
    bn.checked = CP.alerts.getBearishNews();
    bn.addEventListener("change", function () { CP.alerts.setBearishNews(bn.checked); });

    U.el("runBacktest").addEventListener("click", runBacktest);
  }

  // ---- Boot ----
  // Triggered by the login gate (js/auth.js) after a successful sign-in, so no
  // market data is fetched before authentication. Guarded against a repeat call
  // so it can never spin up duplicate refresh intervals.
  function start() {
    if (start._booted) return;
    start._booted = true;
    wire();
    tickStatus();                       // show "Connecting…" immediately
    setInterval(tickStatus, 1000);      // live clock — set FIRST so it always ticks
    setInterval(priceTick, 1000);       // live Binance prices every second
    loadAll();
    loadMarkets();
    CP.state.timer = setInterval(loadAll, CP.config.refreshInterval);
    setInterval(function () { loadMarkets(); }, 2 * CP.config.refreshInterval); // refresh screener prices
    // keep calendar countdowns ticking even between data refreshes
    setInterval(function () { CP.render.renderCalendar(computeEvents()); }, 60000);
  }

  // Expose the boot entry point; the login gate calls this after sign-in.
  CP.boot = start;
})();
