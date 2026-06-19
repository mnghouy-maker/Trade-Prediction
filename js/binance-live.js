/* Live Binance market view for the Trade tab:
 *   - TradingView candlestick chart (official embed) for BINANCE:<symbol>
 *   - real-time order book (partial depth) and recent trades
 *   - live 24h header stats (price, change, high, low, volume)
 * Data comes straight from Binance's public WebSocket streams — no API key,
 * the same feed the Binance site uses. Spot market (matches the prices used
 * across the rest of the app). Sockets only run while the Trade tab is open. */
CP.live = (function () {
  var U = CP.util;
  var WS_BASE = "wss://stream.binance.com:9443/stream?streams=";

  var st = {
    inited: false, active: false, chartFor: null,
    coinId: null, binSym: null, meta: null,
    ws: null, gen: 0, widget: null,
    book: null, trades: [], bookDirty: false, tradesDirty: false, rafPending: false,
    failCount: 0,
  };

  function el(id) { return U.el(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = v; }

  // ---- lifecycle ----
  function activate() {
    st.active = true;
    ensureChart();
    if (st.binSym) openSocket(); else if (st.coinId) showNote(noteFor());
  }
  function deactivate() { st.active = false; closeSocket(); }

  // Called whenever the selected coin changes (from app.selectCoin).
  function setSymbol(coinId, meta) {
    var prevSym = st.binSym, sameCoin = coinId === st.coinId;
    st.coinId = coinId;
    st.meta = meta || null;
    st.binSym = CP.api.binanceSymbol(coinId); // "BTCUSDT" or null
    paintHeaderStatic();
    // Same symbol already set — just refresh the header/paper price; do NOT tear
    // down and reconnect the socket (that would flicker the book/trades).
    if (sameCoin && st.binSym && st.binSym === prevSym) {
      CP.paper.setContext(st.binSym, meta ? meta.symbol : st.binSym, meta ? meta.price : 0);
      return;
    }
    if (st.binSym) {
      hideNote();
      CP.paper.setContext(st.binSym, meta ? meta.symbol : st.binSym, meta ? meta.price : 0);
      if (st.inited) ensureChartSymbol();
      if (st.active) openSocket();
    } else {
      CP.paper.setContext(null, "", 0);
      clearBookTrades();
      closeSocket();
      showNote(noteFor());
    }
  }
  function noteFor() {
    var s = st.meta && st.meta.symbol ? st.meta.symbol : (st.coinId || "this coin");
    return s + " isn’t listed as a USDT pair on Binance, so the live chart, order book and trades aren’t available for it. The Trade Signal above still works.";
  }

  // ---- TradingView chart ----
  function ensureChart() {
    if (st.inited || !el("bxChart")) return;
    loadTV(function () { st.inited = true; st.chartFor = null; ensureChartSymbol(); });
  }
  function ensureChartSymbol() {
    if (!st.inited || !window.TradingView || !st.binSym) return;
    if (st.chartFor === st.binSym) return;
    st.chartFor = st.binSym;
    var host = el("bxChart");
    if (!host) return;
    host.innerHTML = "";
    try {
      st.widget = new window.TradingView.widget({
        container_id: "bxChart",
        symbol: "BINANCE:" + st.binSym,
        interval: "15",
        theme: "dark",
        style: "1",
        locale: "en",
        timezone: "Etc/UTC",
        autosize: true,
        hide_side_toolbar: true,
        allow_symbol_change: false,
        backgroundColor: "rgba(13,17,28,1)",
        gridColor: "rgba(255,255,255,0.05)",
      });
    } catch (e) { showNote("Couldn’t start the TradingView chart."); }
  }
  function loadTV(cb) {
    if (window.TradingView) { cb(); return; }
    if (document.getElementById("tvjs")) { waitTV(cb, 0); return; }
    var s = document.createElement("script");
    s.id = "tvjs"; s.src = "https://s3.tradingview.com/tv.js"; s.async = true;
    s.onload = function () { waitTV(cb, 0); };
    s.onerror = function () { showNote("Couldn’t load the TradingView chart (network blocked?)."); };
    document.head.appendChild(s);
  }
  function waitTV(cb, tries) {
    if (window.TradingView) { cb(); return; }
    if (tries > 40) return;
    setTimeout(function () { waitTV(cb, tries + 1); }, 150);
  }

  // ---- WebSocket: depth + aggTrade + ticker (one combined stream) ----
  function openSocket() {
    closeSocket();
    if (!st.binSym) return;
    var gen = ++st.gen;
    var lower = st.binSym.toLowerCase();
    var url = WS_BASE + lower + "@depth20@100ms/" + lower + "@aggTrade/" + lower + "@ticker";
    var ws;
    try { ws = new WebSocket(url); } catch (e) { showNote("Live feed unavailable on this network."); return; }
    st.ws = ws;
    st.trades = [];
    if (el("bxBook")) el("bxBook").innerHTML = '<div class="skeleton">Connecting to Binance…</div>';
    if (el("bxTrades")) el("bxTrades").innerHTML = '<div class="skeleton">Connecting…</div>';

    ws.onmessage = function (ev) {
      if (gen !== st.gen) return;
      st.failCount = 0;
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      var stream = msg.stream || "", d = msg.data || {};
      if (stream.indexOf("@depth") !== -1) { st.book = d; st.bookDirty = true; schedulePaint(); }
      else if (stream.indexOf("@aggTrade") !== -1) { onTrade(d); }
      else if (stream.indexOf("@ticker") !== -1) { onTicker(d); }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () {
      if (gen !== st.gen || !st.active) return;
      st.failCount++;
      if (st.failCount <= 5) {
        setTimeout(function () { if (gen === st.gen && st.active) openSocket(); }, 2000);
      } else {
        showNote("Live feed dropped — Binance may be blocked on this network. The chart and signal still work.");
      }
    };
  }
  function closeSocket() {
    st.gen++;
    if (st.ws) { try { st.ws.onclose = null; st.ws.onerror = null; st.ws.close(); } catch (e) {} st.ws = null; }
  }

  function onTrade(d) {
    st.trades.unshift({ p: +d.p, q: +d.q, m: d.m, t: d.T });
    if (st.trades.length > 30) st.trades.length = 30;
    st.tradesDirty = true; schedulePaint();
  }
  function onTicker(d) {
    var last = +d.c, chg = +d.P;
    var dp = last < 1 ? 4 : 2;
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

  // ---- render order book + trades (throttled to one animation frame) ----
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
    var asks = (st.book.asks || []).slice(0, 14).map(numRow); // ascending (best first)
    var bids = (st.book.bids || []).slice(0, 14).map(numRow); // descending (best first)
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
      st.trades.map(function (t) {
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

  // Paint the header from cached coin meta right away (before live data lands).
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

  return { activate: activate, deactivate: deactivate, setSymbol: setSymbol };
})();
