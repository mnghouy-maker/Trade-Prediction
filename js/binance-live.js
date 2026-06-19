/* Live market view for the Trade tab.
 *
 * Chart data is sourced from CryptoCompare (CORS-friendly, works where Binance
 * is blocked) with CoinGecko OHLC as a fallback — so the candlesticks always
 * show. The Trade Signal's entry/stop/take-profit levels are drawn on the chart.
 *
 * The order book + recent trades come from Binance's public WebSocket (the only
 * free real-time source for those). If Binance is blocked/unreachable, those two
 * panels show a clear notice while the chart, price and signal keep working from
 * the backup source. No API keys anywhere. */
CP.live = (function () {
  var U = CP.util;
  var WS_BASE = "wss://stream.binance.com:9443/stream?streams=";
  var CC = "https://min-api.cryptocompare.com/data";
  var CG = (CP.config && CP.config.api && CP.config.api.coingecko) || "https://api.coingecko.com/api/v3";
  var LIB = "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js";

  var st = {
    active: false, coinId: null, binSym: null, meta: null, interval: "15m",
    ws: null, gen: 0, poll: null,
    chart: null, series: null, priceLines: [], resizeWired: false,
    book: null, trades: [], bookDirty: false, tradesDirty: false, rafPending: false,
    failCount: 0, lastTickerTs: 0, lastKlineTs: 0,
  };

  // CryptoCompare candle endpoint + aggregation for each interval button.
  var IV = {
    "1m": ["histominute", 1], "5m": ["histominute", 5], "15m": ["histominute", 15],
    "1h": ["histohour", 1], "4h": ["histohour", 4], "1d": ["histoday", 1],
  };

  function el(id) { return U.el(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = v; }
  function ccBase() {
    var s = (st.meta && st.meta.symbol) ? st.meta.symbol : (st.binSym || "").replace("USDT", "");
    return (s || "").toUpperCase();
  }

  // ---------- lifecycle ----------
  function activate() {
    st.active = true;
    ensureChart(function () { if (st.coinId) loadKlines(); });
    if (st.binSym) openSocket();
    startPoll();
    resizeChart();
  }
  function deactivate() { st.active = false; closeSocket(); stopPoll(); }

  function setSymbol(coinId, meta) {
    var sameCoin = coinId === st.coinId;
    st.coinId = coinId;
    st.meta = meta || null;
    st.binSym = CP.api.binanceSymbol(coinId); // BASE+"USDT" (or null)
    paintHeaderStatic();
    setText("bxChartSym", (st.binSym || ccBase() + "USDT") + " · " + st.interval);
    var paperSym = st.binSym || (ccBase() + "USDT");
    if (sameCoin) { CP.paper.setContext(paperSym, ccBase(), meta ? meta.price : 0); return; }
    clearLevels();
    CP.paper.setContext(paperSym, ccBase(), meta ? meta.price : 0);
    if (st.chart) loadKlines();              // chart works regardless of Binance
    if (st.active) {
      if (st.binSym) openSocket(); else degradeFeed();
      startPoll();
    }
  }

  // ---------- candlestick chart (Lightweight Charts) ----------
  function ensureChart(cb) {
    if (st.chart) { if (cb) cb(); return; }
    var host = el("bxChart"); if (!host) return;
    loadLib(function () {
      if (st.chart || !window.LightweightCharts) { if (cb) cb(); return; }
      var LC = window.LightweightCharts;
      st.chart = LC.createChart(host, {
        width: host.clientWidth || 600, height: 460,
        layout: { background: { type: "solid", color: "#0d111c" }, textColor: "#8b9bb0" },
        grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: "rgba(255,255,255,0.10)" },
        rightPriceScale: { borderColor: "rgba(255,255,255,0.10)" },
        crosshair: { mode: 0 },
      });
      st.series = st.chart.addCandlestickSeries({
        upColor: "#16c784", downColor: "#f03542", borderVisible: false,
        wickUpColor: "#16c784", wickDownColor: "#f03542",
      });
      wireIntervalButtons();
      if (!st.resizeWired) { window.addEventListener("resize", resizeChart); st.resizeWired = true; }
      if (cb) cb();
    });
  }
  function loadLib(cb) {
    if (window.LightweightCharts) { cb(); return; }
    if (document.getElementById("lwc-lib")) { waitLib(cb, 0); return; }
    var s = document.createElement("script");
    s.id = "lwc-lib"; s.src = LIB; s.async = true;
    s.onload = function () { waitLib(cb, 0); };
    s.onerror = function () { showNote("Couldn’t load the chart library (network blocked?). The signal still works."); };
    document.head.appendChild(s);
  }
  function waitLib(cb, n) {
    if (window.LightweightCharts) { cb(); return; }
    if (n > 40) return;
    setTimeout(function () { waitLib(cb, n + 1); }, 150);
  }
  function resizeChart() {
    if (!st.chart) return;
    var host = el("bxChart");
    if (host && host.clientWidth) { try { st.chart.resize(host.clientWidth, 460); } catch (e) {} }
  }

  // History: CryptoCompare (USDT → USD) then CoinGecko OHLC. None of these is Binance.
  function ccCandleUrl(quote, limit) {
    var m = IV[st.interval] || IV["15m"];
    return CC + "/v2/" + m[0] + "?fsym=" + ccBase() + "&tsym=" + quote + "&aggregate=" + m[1] + "&limit=" + (limit || 300);
  }
  function ccParse(r) {
    var arr = (r && r.Data && r.Data.Data) ? r.Data.Data : [];
    return arr.map(function (c) { return { time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close }; })
      .filter(function (c) { return c.time && c.close > 0; });
  }
  function cgOHLC() {
    var daysMap = { "1m": 1, "5m": 1, "15m": 1, "1h": 7, "4h": 14, "1d": 90 };
    var url = CG + "/coins/" + st.coinId + "/ohlc?vs_currency=usd&days=" + (daysMap[st.interval] || 1);
    return U.fetchJSON(url, 12000).then(function (a) {
      return (a || []).map(function (c) { return { time: Math.floor(c[0] / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4] }; });
    });
  }
  function loadKlines() {
    if (!st.series || !st.coinId) return;
    var coinId = st.coinId, iv = st.interval;
    U.fetchJSON(ccCandleUrl("USDT", 300), 12000).then(ccParse)
      .then(function (d) { return d.length ? d : U.fetchJSON(ccCandleUrl("USD", 300), 12000).then(ccParse); })
      .then(function (d) { return (d && d.length) ? d : cgOHLC(); })
      .then(function (data) {
        if (coinId !== st.coinId || iv !== st.interval) return; // coin/interval changed mid-fetch
        if (!data || !data.length) { showNote("Couldn’t load chart data for this coin."); return; }
        st.series.setData(data);
        st.chart.timeScale().fitContent();
        hideNote();
        setLevels(CP.state && CP.state.currentPlan);
        var last = data[data.length - 1];
        if (last && !st.lastTickerTs) fillHeader(last.close, null, 0, 0, 0, 0);
      })
      .catch(function () { showNote("Couldn’t load chart data (network?). The signal still works."); });
  }

  // ---------- signal levels on the chart ----------
  function clearLevels() {
    if (st.series) st.priceLines.forEach(function (l) { try { st.series.removePriceLine(l); } catch (e) {} });
    st.priceLines = [];
  }
  function setLevels(plan) {
    if (!st.series) return;
    clearLevels();
    if (!plan || !plan.entry) return;
    addLine(plan.entry, "#e8edf2", (plan.side === "long" ? "LONG entry" : "SHORT entry"));
    addLine(plan.stop, "#f03542", "Stop loss");
    (plan.targets || []).forEach(function (t, i) { addLine(t, "#16c784", "TP" + (i + 1)); });
  }
  function addLine(price, color, title) {
    if (!(price > 0) || !st.series) return;
    try {
      st.priceLines.push(st.series.createPriceLine({
        price: price, color: color, lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: title,
      }));
    } catch (e) {}
  }

  function wireIntervalButtons() {
    var bar = document.querySelector(".bx-iv-group");
    if (!bar || bar._wired) return;
    bar._wired = true;
    bar.addEventListener("click", function (e) {
      var b = e.target.closest(".bx-iv");
      if (!b) return;
      var iv = b.getAttribute("data-iv");
      if (iv === st.interval) return;
      st.interval = iv;
      document.querySelectorAll(".bx-iv").forEach(function (x) { x.classList.toggle("active", x === b); });
      setText("bxChartSym", (st.binSym || ccBase() + "USDT") + " · " + iv);
      st.lastKlineTs = 0;
      loadKlines();
      if (st.active && st.binSym) openSocket(); // re-subscribe kline stream at new interval
    });
  }

  // ---------- live polling (CryptoCompare) — chart + header without Binance ----------
  function startPoll() {
    stopPoll();
    pollLive();
    st.poll = setInterval(pollLive, 12000);
  }
  function stopPoll() { if (st.poll) { clearInterval(st.poll); st.poll = null; } }
  function pollLive() {
    if (!st.active || !st.coinId) return;
    // Update the forming candle, unless Binance's kline stream is doing it.
    if (Date.now() - st.lastKlineTs > 10000 && st.series) {
      U.fetchJSON(ccCandleUrl("USDT", 2), 8000).then(ccParse).then(function (d) {
        if (!d.length) return U.fetchJSON(ccCandleUrl("USD", 2), 8000).then(ccParse);
        return d;
      }).then(function (d) {
        if (st.series && d && d.length) d.forEach(function (c) { try { st.series.update(c); } catch (e) {} });
      }).catch(function () {});
    }
    // Header 24h stats, unless Binance's ticker is delivering.
    if (Date.now() - st.lastTickerTs > 9000) {
      U.fetchJSON(CC + "/pricemultifull?fsyms=" + ccBase() + "&tsyms=USDT", 8000).then(function (r) {
        var raw = r && r.RAW && r.RAW[ccBase()] && r.RAW[ccBase()].USDT;
        if (!raw) return;
        fillHeader(+raw.PRICE, +raw.CHANGEPCT24HOUR, +raw.HIGH24HOUR, +raw.LOW24HOUR, +raw.VOLUME24HOUR, +raw.VOLUME24HOURTO);
      }).catch(function () {});
    }
  }

  // ---------- Binance WebSocket: order book + trades (+ fast ticker/kline) ----------
  function openSocket() {
    closeSocket();
    if (!st.binSym) return;
    var gen = ++st.gen;
    var l = st.binSym.toLowerCase();
    var url = WS_BASE + l + "@depth20@100ms/" + l + "@aggTrade/" + l + "@ticker/" + l + "@kline_" + st.interval;
    var ws;
    try { ws = new WebSocket(url); } catch (e) { degradeFeed(); return; }
    st.ws = ws; st.trades = [];
    if (el("bxBook")) el("bxBook").innerHTML = '<div class="skeleton">Connecting to Binance…</div>';
    if (el("bxTrades")) el("bxTrades").innerHTML = '<div class="skeleton">Connecting…</div>';
    ws.onmessage = function (ev) {
      if (gen !== st.gen) return;
      st.failCount = 0;
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      var stream = msg.stream || "", d = msg.data || {};
      if (stream.indexOf("@depth") !== -1) { st.book = d; st.bookDirty = true; schedulePaint(); }
      else if (stream.indexOf("@aggTrade") !== -1) onTrade(d);
      else if (stream.indexOf("@ticker") !== -1) onTicker(d);
      else if (stream.indexOf("@kline") !== -1) { st.lastKlineTs = Date.now(); onKline(d.k); }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () {
      if (gen !== st.gen || !st.active) return;
      st.failCount++;
      if (st.failCount <= 4) setTimeout(function () { if (gen === st.gen && st.active) openSocket(); }, 2000);
      else degradeFeed(); // Binance unreachable — chart/price keep working from the backup source
    };
  }
  function closeSocket() {
    st.gen++;
    if (st.ws) { try { st.ws.onclose = null; st.ws.onerror = null; st.ws.close(); } catch (e) {} st.ws = null; }
  }
  function degradeFeed() {
    if (el("bxBook")) el("bxBook").innerHTML =
      '<div class="bx-unavail">Live order book comes from Binance, which looks blocked on this network. The chart, price and signal are using a backup source.</div>';
    if (el("bxTrades")) el("bxTrades").innerHTML =
      '<div class="bx-unavail">Recent trades need Binance (unreachable here).</div>';
  }

  function onKline(k) {
    if (!st.series || !k) return;
    st.series.update({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c });
  }
  function onTrade(d) {
    st.trades.unshift({ p: +d.p, q: +d.q, m: d.m, t: d.T });
    if (st.trades.length > 10) st.trades.length = 10; // locked at 10
    st.tradesDirty = true; schedulePaint();
  }
  function onTicker(d) {
    st.lastTickerTs = Date.now();
    fillHeader(+d.c, +d.P, +d.h, +d.l, +d.v, +d.q);
  }

  // Header writer shared by the Binance ticker and the CryptoCompare poll.
  function fillHeader(price, chgPct, high, low, volBase, volQuote) {
    var dp = price < 1 ? 4 : 2;
    if (price > 0) {
      setText("bxPrice", U.fmtUSD(price, dp));
      var pr = el("bxPrice"); if (pr && typeof chgPct === "number") pr.className = "bx-price " + (chgPct >= 0 ? "up" : "down");
    }
    if (typeof chgPct === "number" && !isNaN(chgPct)) {
      setText("bxChange", U.fmtPct(chgPct, true) + " (24h)");
      var ch = el("bxChange"); if (ch) ch.className = "bx-change " + (chgPct >= 0 ? "up" : "down");
    }
    if (high > 0) setText("bxHigh", U.fmtUSD(high, dp));
    if (low > 0) setText("bxLow", U.fmtUSD(low, dp));
    if (volBase > 0) setText("bxVolBase", U.fmtCompact(volBase).replace("$", ""));
    if (volQuote > 0) setText("bxVolQuote", U.fmtCompact(volQuote));
    if (price > 0) {
      CP.paper.mark(st.binSym || (ccBase() + "USDT"), price);
      var pp = el("paperPrice"); if (pp && !pp.value) pp.value = +price.toFixed(price < 1 ? 6 : 2);
    }
  }

  // ---------- render book + trades (throttled to one animation frame) ----------
  function schedulePaint() {
    if (st.rafPending) return;
    st.rafPending = true;
    (window.requestAnimationFrame || function (f) { return setTimeout(f, 60); })(function () {
      st.rafPending = false;
      if (st.bookDirty) { st.bookDirty = false; renderBook(); }
      if (st.tradesDirty) { st.tradesDirty = false; renderTrades(); }
    });
  }
  function numRow(a) { return { p: +a[0], q: +a[1] }; }
  function renderBook() {
    var box = el("bxBook"); if (!box || !st.book) return;
    var asks = (st.book.asks || []).slice(0, 12).map(numRow);
    var bids = (st.book.bids || []).slice(0, 12).map(numRow);
    if (!asks.length && !bids.length) return;
    var maxQ = 1;
    asks.concat(bids).forEach(function (r) { if (r.q > maxQ) maxQ = r.q; });
    var spread = (asks.length && bids.length) ? (asks[0].p - bids[0].p) : 0;
    var mid = (asks.length && bids.length) ? (asks[0].p + bids[0].p) / 2 : (asks[0] ? asks[0].p : bids[0].p);
    var dp = mid < 1 ? 5 : 2;
    var asksHtml = asks.slice().reverse().map(function (r) { return bookRow(r, "ask", maxQ, dp); }).join("");
    var bidsHtml = bids.map(function (r) { return bookRow(r, "bid", maxQ, dp); }).join("");
    box.innerHTML =
      '<div class="bx-book-head"><span>Price (USDT)</span><span>Size</span></div>' +
      '<div class="bx-book-asks">' + asksHtml + "</div>" +
      '<div class="bx-book-mid"><span class="bx-book-last">' + U.fmtUSD(mid, dp) + "</span>" +
        '<span class="bx-book-spread">spread ' + U.fmtUSD(spread, dp) + "</span></div>" +
      '<div class="bx-book-bids">' + bidsHtml + "</div>";
  }
  function bookRow(r, kind, maxQ, dp) {
    var pct = Math.max(2, Math.min(100, (r.q / maxQ) * 100));
    return '<div class="bx-row ' + kind + '"><span class="bx-depth" style="width:' + pct.toFixed(1) + '%"></span>' +
      '<span class="bx-rp">' + U.fmtUSD(r.p, dp) + "</span>" +
      '<span class="bx-rq">' + trim(r.q) + "</span></div>";
  }
  function renderTrades() {
    var box = el("bxTrades"); if (!box) return;
    box.innerHTML = '<div class="bx-trades-head"><span>Price</span><span>Amount</span><span>Time</span></div>' +
      st.trades.slice(0, 10).map(function (t) {
        var cls = t.m ? "down" : "up"; // m=true: buyer is maker -> sell aggressor (red)
        var dp = t.p < 1 ? 5 : 2;
        return '<div class="bx-trade ' + cls + '"><span>' + U.fmtUSD(t.p, dp) + "</span>" +
          "<span>" + trim(t.q) + "</span><span>" + new Date(t.t).toLocaleTimeString() + "</span></div>";
      }).join("");
  }
  function trim(n) { return n >= 1 ? (+n.toFixed(3)).toString() : (+n.toPrecision(3)).toString(); }

  function paintHeaderStatic() {
    var m = st.meta || {};
    setText("bxSymbol", st.binSym || (ccBase() + "USDT"));
    setText("bxCoinFull", m.name || "");
    var ic = el("bxCoinIcon");
    if (ic) ic.innerHTML = m.image ? '<img src="' + U.escapeHtml(m.image) + '" width="26" height="26" style="border-radius:50%" />' : "";
    if (m.price) { setText("bxPrice", U.fmtUSD(m.price, m.price < 1 ? 4 : 2)); }
    if (typeof m.change24h === "number") {
      setText("bxChange", U.fmtPct(m.change24h, true) + " (24h)");
      var ch = el("bxChange"); if (ch) ch.className = "bx-change " + (m.change24h >= 0 ? "up" : "down");
    }
  }
  function showNote(msg) {
    var n = el("bxChartNote");
    if (n) { n.textContent = msg || "Live market data unavailable."; n.classList.remove("hidden"); }
  }
  function hideNote() { var n = el("bxChartNote"); if (n) n.classList.add("hidden"); }

  return { activate: activate, deactivate: deactivate, setSymbol: setSymbol, setLevels: setLevels };
})();
