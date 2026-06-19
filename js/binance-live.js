/* Live Binance market view for the Trade tab:
 *   - candlestick chart (TradingView Lightweight Charts) fed by Binance klines
 *     (REST history + live kline stream), with the Trade Signal's entry / stop /
 *     take-profit levels drawn right on the chart so you can see where to act
 *   - real-time order book (partial depth) and recent trades (locked to 10)
 *   - live 24h header stats
 * Public Binance WebSocket + REST — no API key. Spot market. Sockets/chart run
 * only while the Trade tab is open. */
CP.live = (function () {
  var U = CP.util;
  var WS_BASE = "wss://stream.binance.com:9443/stream?streams=";
  var REST = (CP.config && CP.config.api && CP.config.api.binance) || "https://api.binance.com/api/v3";
  var LIB = "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js";

  var st = {
    active: false, coinId: null, binSym: null, meta: null, interval: "15m",
    ws: null, gen: 0,
    chart: null, series: null, priceLines: [], resizeWired: false,
    book: null, trades: [], bookDirty: false, tradesDirty: false, rafPending: false,
    failCount: 0,
  };

  function el(id) { return U.el(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = v; }

  // ---------- lifecycle ----------
  function activate() {
    st.active = true;
    ensureChart(function () { if (st.binSym) loadKlines(); });
    if (st.binSym) openSocket(); else if (st.coinId) showNote(noteFor());
    resizeChart();
  }
  function deactivate() { st.active = false; closeSocket(); }

  function setSymbol(coinId, meta) {
    var prevSym = st.binSym, sameCoin = coinId === st.coinId;
    st.coinId = coinId;
    st.meta = meta || null;
    st.binSym = CP.api.binanceSymbol(coinId); // "BTCUSDT" or null
    paintHeaderStatic();
    setText("bxChartSym", (st.binSym || "—") + " · " + st.interval);
    // Same symbol already set — just refresh the header/paper price; don't tear
    // down and reconnect the socket (that would flicker the book/trades).
    if (sameCoin && st.binSym && st.binSym === prevSym) {
      CP.paper.setContext(st.binSym, meta ? meta.symbol : st.binSym, meta ? meta.price : 0);
      return;
    }
    clearLevels();
    if (st.binSym) {
      hideNote();
      CP.paper.setContext(st.binSym, meta ? meta.symbol : st.binSym, meta ? meta.price : 0);
      if (st.chart) loadKlines();
      if (st.active) openSocket();
    } else {
      CP.paper.setContext(null, "", 0);
      clearBookTrades();
      closeSocket();
      if (st.series) { try { st.series.setData([]); } catch (e) {} }
      showNote(noteFor());
    }
  }
  function noteFor() {
    var s = st.meta && st.meta.symbol ? st.meta.symbol : (st.coinId || "this coin");
    return s + " isn’t listed as a USDT pair on Binance, so the live chart, order book and trades aren’t available for it. The Trade Signal above still works.";
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
    s.onerror = function () { showNote("Couldn’t load the chart library (network blocked?). Order book, trades and the signal still work."); };
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

  function loadKlines() {
    if (!st.series || !st.binSym) return;
    var sym = st.binSym, iv = st.interval;
    var url = REST + "/klines?symbol=" + sym + "&interval=" + iv + "&limit=300";
    U.fetchJSON(url, 12000).then(function (k) {
      if (!k || !k.length || sym !== st.binSym || iv !== st.interval) return;
      st.series.setData(k.map(function (c) {
        return { time: Math.floor(c[0] / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4] };
      }));
      st.chart.timeScale().fitContent();
      setLevels(CP.state && CP.state.currentPlan);
    }).catch(function () {
      showNote("Couldn’t load chart history from Binance (network?). The order book and signal still work.");
    });
  }
  function onKline(k) {
    if (!st.series || !k) return;
    st.series.update({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c });
  }

  // Draw the Trade Signal's entry / stop / take-profit levels on the chart.
  function clearLevels() {
    if (st.series) st.priceLines.forEach(function (l) { try { st.series.removePriceLine(l); } catch (e) {} });
    st.priceLines = [];
  }
  function setLevels(plan) {
    if (!st.series) return;
    clearLevels();
    if (!plan || !plan.entry) return;
    var isLong = plan.side === "long";
    addLine(plan.entry, "#e8edf2", (isLong ? "LONG entry" : "SHORT entry"));
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
      setText("bxChartSym", (st.binSym || "—") + " · " + iv);
      loadKlines();
      if (st.active) openSocket(); // re-subscribe the kline stream at the new interval
    });
  }

  // ---------- WebSocket: depth + aggTrade + ticker + kline (combined) ----------
  function openSocket() {
    closeSocket();
    if (!st.binSym) return;
    var gen = ++st.gen;
    var l = st.binSym.toLowerCase();
    var url = WS_BASE + l + "@depth20@100ms/" + l + "@aggTrade/" + l + "@ticker/" + l + "@kline_" + st.interval;
    var ws;
    try { ws = new WebSocket(url); } catch (e) { showNote("Live feed unavailable on this network."); return; }
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
      else if (stream.indexOf("@kline") !== -1) onKline(d.k);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () {
      if (gen !== st.gen || !st.active) return;
      st.failCount++;
      if (st.failCount <= 5) setTimeout(function () { if (gen === st.gen && st.active) openSocket(); }, 2000);
      else showNote("Live feed dropped — Binance may be blocked on this network. The chart and signal still work.");
    };
  }
  function closeSocket() {
    st.gen++;
    if (st.ws) { try { st.ws.onclose = null; st.ws.onerror = null; st.ws.close(); } catch (e) {} st.ws = null; }
  }

  function onTrade(d) {
    st.trades.unshift({ p: +d.p, q: +d.q, m: d.m, t: d.T });
    if (st.trades.length > 10) st.trades.length = 10; // locked at 10
    st.tradesDirty = true; schedulePaint();
  }
  function onTicker(d) {
    var last = +d.c, chg = +d.P, dp = last < 1 ? 4 : 2;
    setText("bxPrice", U.fmtUSD(last, dp));
    var pr = el("bxPrice"); if (pr) pr.className = "bx-price " + (chg >= 0 ? "up" : "down");
    setText("bxChange", U.fmtPct(chg, true) + " (24h)");
    var ch = el("bxChange"); if (ch) ch.className = "bx-change " + (chg >= 0 ? "up" : "down");
    setText("bxHigh", U.fmtUSD(+d.h, dp));
    setText("bxLow", U.fmtUSD(+d.l, dp));
    setText("bxVolBase", U.fmtCompact(+d.v).replace("$", ""));
    setText("bxVolQuote", U.fmtCompact(+d.q));
    CP.paper.mark(st.binSym, last);
    var pp = el("paperPrice"); if (pp && !pp.value) pp.value = +last.toFixed(last < 1 ? 6 : 2);
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

  function clearBookTrades() {
    if (el("bxBook")) el("bxBook").innerHTML = "";
    if (el("bxTrades")) el("bxTrades").innerHTML = "";
  }
  function paintHeaderStatic() {
    var m = st.meta || {};
    setText("bxSymbol", st.binSym || (m.symbol ? m.symbol + "USDT" : (st.coinId || "").toUpperCase()));
    setText("bxCoinFull", m.name || "");
    var ic = el("bxCoinIcon");
    if (ic) ic.innerHTML = m.image
      ? '<img src="' + U.escapeHtml(m.image) + '" width="26" height="26" style="border-radius:50%" />' : "";
    if (m.price) setText("bxPrice", U.fmtUSD(m.price, m.price < 1 ? 4 : 2));
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
