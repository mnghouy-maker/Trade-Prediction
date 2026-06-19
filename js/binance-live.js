/* Live market view for the Trade tab.
 *
 * The candlestick chart is drawn on a plain <canvas> — no external charting
 * library or CDN — and its data comes from CoinGecko (always reachable here;
 * the price strip and coin list already use it) with CryptoCompare preferred
 * when reachable for finer 1m/5m/15m candles. So the chart works even on
 * networks that block Binance and/or CDNs. The Trade Signal's entry/stop/take-
 * profit levels are drawn right on the chart.
 *
 * The order book + recent trades use Binance's public WebSocket (the only free
 * real-time source). If Binance is unreachable those two panels show a clear
 * notice; everything else keeps working. No API keys anywhere. */
CP.live = (function () {
  var U = CP.util;
  var WS_BASE = "wss://stream.binance.com:9443/stream?streams=";
  var CC = "https://min-api.cryptocompare.com/data";
  var CG = (CP.config && CP.config.api && CP.config.api.coingecko) || "https://api.coingecko.com/api/v3";

  var st = {
    active: false, coinId: null, binSym: null, meta: null, interval: "15m",
    ws: null, gen: 0, poll: null,
    canvas: null, ctx: null, candles: [], levels: [], ccLoaded: false, resizeWired: false,
    book: null, trades: [], bookDirty: false, tradesDirty: false, rafPending: false,
    failCount: 0, lastTickerTs: 0,
  };

  // CryptoCompare candle endpoint + aggregation per interval button.
  var IV = {
    "1m": ["histominute", 1], "5m": ["histominute", 5], "15m": ["histominute", 15],
    "1h": ["histohour", 1], "4h": ["histohour", 4], "1d": ["histoday", 1],
  };
  // CoinGecko OHLC granularity is tied to the day range (free tier).
  var CG_DAYS = { "1m": 1, "5m": 1, "15m": 1, "1h": 7, "4h": 14, "1d": 90 };

  function el(id) { return U.el(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = v; }
  function ccBase() {
    var s = (st.meta && st.meta.symbol) ? st.meta.symbol : (st.binSym || "").replace("USDT", "");
    return (s || "").toUpperCase();
  }
  function paperSym() { return st.binSym || (ccBase() + "USDT"); }

  // ---------- lifecycle ----------
  function activate() {
    st.active = true;
    ensureChart();
    wireIntervalButtons();
    if (st.coinId) loadKlines();
    if (st.binSym) openSocket();
    startPoll();
  }
  function deactivate() { st.active = false; closeSocket(); stopPoll(); }

  function setSymbol(coinId, meta) {
    var sameCoin = coinId === st.coinId;
    st.coinId = coinId;
    st.meta = meta || null;
    st.binSym = CP.api.binanceSymbol(coinId);
    paintHeaderStatic();
    setText("bxChartSym", paperSym() + " · " + st.interval);
    if (sameCoin) { CP.paper.setContext(paperSym(), ccBase(), meta ? meta.price : 0); return; }
    st.levels = [];
    CP.paper.setContext(paperSym(), ccBase(), meta ? meta.price : 0);
    if (st.canvas) loadKlines();
    if (st.active) {
      if (st.binSym) openSocket(); else degradeFeed();
      startPoll();
    }
  }

  // ---------- canvas candlestick chart (self-contained, no library) ----------
  function ensureChart() {
    if (st.canvas) return;
    var host = el("bxChart"); if (!host) return;
    host.innerHTML = "";
    var c = document.createElement("canvas");
    c.style.width = "100%"; c.style.height = "460px"; c.style.display = "block";
    host.appendChild(c);
    st.canvas = c; st.ctx = c.getContext("2d");
    if (!st.resizeWired) { window.addEventListener("resize", function () { draw(); }); st.resizeWired = true; }
  }

  function fmtP(p) { return p >= 1 ? p.toFixed(2) : (+p.toPrecision(4)).toString(); }
  function fmtT(sec) { var d = new Date(sec * 1000); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }

  function draw() {
    var c = st.canvas, ctx = st.ctx; if (!c || !ctx) return;
    var ratio = window.devicePixelRatio || 1;
    var W = c.clientWidth || 600, H = 460;
    c.width = W * ratio; c.height = H * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var candles = st.candles || [];
    if (!candles.length) return;

    var padL = 8, padR = 70, padT = 10, padB = 22;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var lo = Infinity, hi = -Infinity;
    candles.forEach(function (k) { if (k.low < lo) lo = k.low; if (k.high > hi) hi = k.high; });
    (st.levels || []).forEach(function (l) { if (l.price < lo) lo = l.price; if (l.price > hi) hi = l.price; });
    if (!(hi > lo)) { hi = lo * 1.01 || 1; lo = lo * 0.99 || 0; }
    var pad = (hi - lo) * 0.08; hi += pad; lo -= pad;
    function y(p) { return padT + (1 - (p - lo) / (hi - lo)) * plotH; }

    var n = candles.length, step = plotW / n, bw = Math.max(1, Math.min(step * 0.7, 14));

    ctx.font = "10px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
    for (var i = 0; i <= 5; i++) {
      var p = lo + (hi - lo) * i / 5, yy = y(p);
      ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.beginPath();
      ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillStyle = "#8b9bb0"; ctx.textAlign = "left"; ctx.fillText(fmtP(p), padL + plotW + 6, yy);
    }
    candles.forEach(function (k, idx) {
      var x = padL + idx * step + step / 2, up = k.close >= k.open;
      ctx.strokeStyle = up ? "#16c784" : "#f03542"; ctx.fillStyle = up ? "#16c784" : "#f03542";
      ctx.beginPath(); ctx.moveTo(x, y(k.high)); ctx.lineTo(x, y(k.low)); ctx.stroke();
      var yo = y(k.open), yc = y(k.close), top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(x - bw / 2, top, bw, bh);
    });
    (st.levels || []).forEach(function (l) {
      var yy = y(l.price);
      ctx.strokeStyle = l.color; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = l.color; ctx.textAlign = "right";
      ctx.fillText(l.title + " " + fmtP(l.price), padL + plotW, yy - 6);
    });
    ctx.fillStyle = "#5b6b80"; ctx.textAlign = "center";
    var labelN = Math.min(6, n);
    for (var t = 0; t < labelN; t++) {
      var idx2 = labelN > 1 ? Math.floor(t * (n - 1) / (labelN - 1)) : 0;
      var k2 = candles[idx2]; if (!k2) continue;
      ctx.fillText(fmtT(k2.time), padL + idx2 * step + step / 2, H - 8);
    }
  }

  // ---------- data: CoinGecko (reliable) + CryptoCompare (finer when reachable) ----------
  function ccCandleUrl(quote, limit) {
    var m = IV[st.interval] || IV["15m"];
    return CC + "/v2/" + m[0] + "?fsym=" + ccBase() + "&tsym=" + quote + "&aggregate=" + m[1] + "&limit=" + (limit || 300);
  }
  function ccParse(r) {
    var arr = (r && r.Data && r.Data.Data) ? r.Data.Data : [];
    return arr.map(function (c) { return { time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close }; })
      .filter(function (c) { return c.time && c.close > 0; });
  }
  function fetchCC(limit, timeout) {
    return U.fetchJSON(ccCandleUrl("USDT", limit), timeout || 6000).then(ccParse).then(function (d) {
      return d.length ? d : U.fetchJSON(ccCandleUrl("USD", limit), timeout || 6000).then(ccParse);
    });
  }
  function fetchCG() {
    var url = CG + "/coins/" + st.coinId + "/ohlc?vs_currency=usd&days=" + (CG_DAYS[st.interval] || 1);
    return U.fetchJSON(url, 9000).then(function (a) {
      return (a || []).map(function (c) { return { time: Math.floor(c[0] / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4] }; })
        .filter(function (c) { return c.close > 0; });
    });
  }
  function loadKlines() {
    if (!st.canvas || !st.coinId) return;
    var coinId = st.coinId, iv = st.interval;
    st.ccLoaded = false; var got = { v: false };
    // CoinGecko first (known-reachable) so candles show fast…
    fetchCG().then(function (d) {
      if (coinId === st.coinId && iv === st.interval && d.length && !st.ccLoaded) { got.v = true; applyCandles(d); }
    }).catch(function () {});
    // …and upgrade to CryptoCompare's finer candles if it's reachable.
    fetchCC(300).then(function (d) {
      if (coinId === st.coinId && iv === st.interval && d.length) { st.ccLoaded = true; got.v = true; applyCandles(d); }
    }).catch(function () {});
    setTimeout(function () {
      if (!got.v && coinId === st.coinId && iv === st.interval) showNote("Couldn’t load chart data on this network. The signal still works.");
    }, 13000);
  }
  function applyCandles(d) {
    st.candles = d;
    hideNote();
    computeHiLo();
    draw();
    setLevels(CP.state && CP.state.currentPlan);
    var last = d[d.length - 1];
    if (last && Date.now() - st.lastTickerTs > 9000) updatePrice(last.close);
  }
  function computeHiLo() {
    var cutoff = Math.floor(Date.now() / 1000) - 86400, hi = -Infinity, lo = Infinity;
    st.candles.forEach(function (k) { if (k.time >= cutoff) { if (k.high > hi) hi = k.high; if (k.low < lo) lo = k.low; } });
    if (!(hi > 0)) { st.candles.forEach(function (k) { if (k.high > hi) hi = k.high; if (k.low < lo) lo = k.low; }); }
    var dp = hi < 1 ? 4 : 2;
    if (hi > 0) setText("bxHigh", U.fmtUSD(hi, dp));
    if (lo < Infinity) setText("bxLow", U.fmtUSD(lo, dp));
    var m = st.meta || {};
    if (m.volume > 0) {
      setText("bxVolQuote", U.fmtCompact(m.volume));
      var price = m.price || (st.candles.length ? st.candles[st.candles.length - 1].close : 0);
      if (price > 0) setText("bxVolBase", U.fmtCompact(m.volume / price).replace("$", ""));
    }
  }
  function updatePrice(p) {
    if (!(p > 0)) return;
    setText("bxPrice", U.fmtUSD(p, p < 1 ? 4 : 2));
    CP.paper.mark(paperSym(), p);
    var pp = el("paperPrice"); if (pp && !pp.value) pp.value = +p.toFixed(p < 1 ? 6 : 2);
  }

  // ---------- signal levels ----------
  function setLevels(plan) {
    st.levels = [];
    if (plan && plan.entry) {
      st.levels.push({ price: plan.entry, color: "#e8edf2", title: plan.side === "long" ? "LONG entry" : "SHORT entry" });
      if (plan.stop > 0) st.levels.push({ price: plan.stop, color: "#f03542", title: "Stop" });
      (plan.targets || []).forEach(function (t, i) { if (t > 0) st.levels.push({ price: t, color: "#16c784", title: "TP" + (i + 1) }); });
    }
    draw();
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
      setText("bxChartSym", paperSym() + " · " + iv);
      loadKlines();
    });
  }

  // ---------- live polling (chart + price without Binance) ----------
  function startPoll() { stopPoll(); pollLive(); st.poll = setInterval(pollLive, 15000); }
  function stopPoll() { if (st.poll) { clearInterval(st.poll); st.poll = null; } }
  function pollLive() {
    if (!st.active || !st.coinId) return;
    fetchCC(3, 5000).then(function (d) {
      if (!d.length || !st.candles.length) return;
      mergeCandles(d); draw();
      if (Date.now() - st.lastTickerTs > 9000) updatePrice(d[d.length - 1].close);
    }).catch(function () {
      // CryptoCompare unreachable — keep the price moving via CoinGecko.
      if (Date.now() - st.lastTickerTs > 9000) {
        U.fetchJSON(CG + "/simple/price?ids=" + st.coinId + "&vs_currencies=usd", 6000).then(function (r) {
          var p = r && r[st.coinId] && r[st.coinId].usd;
          if (p > 0) { updatePrice(p); if (st.candles.length) { st.candles[st.candles.length - 1].close = p; draw(); } }
        }).catch(function () {});
      }
    });
  }
  function mergeCandles(recent) {
    recent.forEach(function (c) {
      var last = st.candles[st.candles.length - 1];
      if (last && c.time === last.time) st.candles[st.candles.length - 1] = c;
      else if (!last || c.time > last.time) { st.candles.push(c); if (st.candles.length > 400) st.candles.shift(); }
    });
  }

  // ---------- Binance WebSocket: order book + trades (+ fast ticker) ----------
  function openSocket() {
    closeSocket();
    if (!st.binSym) return;
    var gen = ++st.gen, l = st.binSym.toLowerCase();
    var url = WS_BASE + l + "@depth20@100ms/" + l + "@aggTrade/" + l + "@ticker";
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
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () {
      if (gen !== st.gen || !st.active) return;
      st.failCount++;
      if (st.failCount <= 4) setTimeout(function () { if (gen === st.gen && st.active) openSocket(); }, 2000);
      else degradeFeed();
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

  function onTrade(d) {
    st.trades.unshift({ p: +d.p, q: +d.q, m: d.m, t: d.T });
    if (st.trades.length > 10) st.trades.length = 10; // locked at 10
    st.tradesDirty = true; schedulePaint();
  }
  function onTicker(d) {
    st.lastTickerTs = Date.now();
    var price = +d.c, chg = +d.P, dp = price < 1 ? 4 : 2;
    setText("bxPrice", U.fmtUSD(price, dp));
    var pr = el("bxPrice"); if (pr) pr.className = "bx-price " + (chg >= 0 ? "up" : "down");
    setText("bxChange", U.fmtPct(chg, true) + " (24h)");
    var ch = el("bxChange"); if (ch) ch.className = "bx-change " + (chg >= 0 ? "up" : "down");
    setText("bxHigh", U.fmtUSD(+d.h, dp));
    setText("bxLow", U.fmtUSD(+d.l, dp));
    setText("bxVolBase", U.fmtCompact(+d.v).replace("$", ""));
    setText("bxVolQuote", U.fmtCompact(+d.q));
    CP.paper.mark(paperSym(), price);
    var pp = el("paperPrice"); if (pp && !pp.value) pp.value = +price.toFixed(price < 1 ? 6 : 2);
  }

  // ---------- render book + trades ----------
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
    var maxQ = 1; asks.concat(bids).forEach(function (r) { if (r.q > maxQ) maxQ = r.q; });
    var spread = (asks.length && bids.length) ? (asks[0].p - bids[0].p) : 0;
    var mid = (asks.length && bids.length) ? (asks[0].p + bids[0].p) / 2 : (asks[0] ? asks[0].p : bids[0].p);
    var dp = mid < 1 ? 5 : 2;
    box.innerHTML =
      '<div class="bx-book-head"><span>Price (USDT)</span><span>Size</span></div>' +
      '<div class="bx-book-asks">' + asks.slice().reverse().map(function (r) { return bookRow(r, "ask", maxQ, dp); }).join("") + "</div>" +
      '<div class="bx-book-mid"><span class="bx-book-last">' + U.fmtUSD(mid, dp) + "</span>" +
        '<span class="bx-book-spread">spread ' + U.fmtUSD(spread, dp) + "</span></div>" +
      '<div class="bx-book-bids">' + bids.map(function (r) { return bookRow(r, "bid", maxQ, dp); }).join("") + "</div>";
  }
  function bookRow(r, kind, maxQ, dp) {
    var pct = Math.max(2, Math.min(100, (r.q / maxQ) * 100));
    return '<div class="bx-row ' + kind + '"><span class="bx-depth" style="width:' + pct.toFixed(1) + '%"></span>' +
      '<span class="bx-rp">' + U.fmtUSD(r.p, dp) + "</span><span class=\"bx-rq\">" + trim(r.q) + "</span></div>";
  }
  function renderTrades() {
    var box = el("bxTrades"); if (!box) return;
    box.innerHTML = '<div class="bx-trades-head"><span>Price</span><span>Amount</span><span>Time</span></div>' +
      st.trades.slice(0, 10).map(function (t) {
        var cls = t.m ? "down" : "up", dp = t.p < 1 ? 5 : 2;
        return '<div class="bx-trade ' + cls + '"><span>' + U.fmtUSD(t.p, dp) + "</span><span>" + trim(t.q) +
          "</span><span>" + new Date(t.t).toLocaleTimeString() + "</span></div>";
      }).join("");
  }
  function trim(n) { return n >= 1 ? (+n.toFixed(3)).toString() : (+n.toPrecision(3)).toString(); }

  function paintHeaderStatic() {
    var m = st.meta || {};
    setText("bxSymbol", paperSym());
    setText("bxCoinFull", m.name || "");
    var ic = el("bxCoinIcon");
    if (ic) ic.innerHTML = m.image ? '<img src="' + U.escapeHtml(m.image) + '" width="26" height="26" style="border-radius:50%" />' : "";
    if (m.price) setText("bxPrice", U.fmtUSD(m.price, m.price < 1 ? 4 : 2));
    if (typeof m.change24h === "number") {
      setText("bxChange", U.fmtPct(m.change24h, true) + " (24h)");
      var ch = el("bxChange"); if (ch) ch.className = "bx-change " + (m.change24h >= 0 ? "up" : "down");
    }
    if (m.volume > 0) {
      setText("bxVolQuote", U.fmtCompact(m.volume));
      if (m.price > 0) setText("bxVolBase", U.fmtCompact(m.volume / m.price).replace("$", ""));
    }
  }
  function showNote(msg) { var n = el("bxChartNote"); if (n) { n.textContent = msg || "Live market data unavailable."; n.classList.remove("hidden"); } }
  function hideNote() { var n = el("bxChartNote"); if (n) n.classList.add("hidden"); }

  // Wire interval buttons once the DOM is ready (chart created on first activate).
  if (document.addEventListener) document.addEventListener("DOMContentLoaded", wireIntervalButtons);

  return { activate: activate, deactivate: deactivate, setSymbol: setSymbol, setLevels: setLevels };
})();
