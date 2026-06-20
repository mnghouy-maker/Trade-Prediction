/* Live Binance market view for the Trade tab.
 *
 * Candles come from Binance (klines REST history + @kline live stream), drawn on
 * a self-contained <canvas> (no external charting library), with the Trade
 * Signal's entry/stop/take-profit levels drawn on the chart. Order book + recent
 * trades + 24h header come from Binance's public WebSocket. No API keys.
 *
 * Everything here needs Binance to be reachable; if it isn't (e.g. blocked on a
 * network) the panels show a clear notice. Streams/chart run only while the
 * Trade tab is open. */
CP.live = (function () {
  var U = CP.util;
  var WS_BASE = "wss://stream.binance.com:9443/stream?streams=";
  var BREST = (CP.config && CP.config.api && CP.config.api.binance) || "https://api.binance.com/api/v3";
  var CG = (CP.config && CP.config.api && CP.config.api.coingecko) || "https://api.coingecko.com/api/v3";
  var CG_DAYS = { "1m": 1, "5m": 1, "15m": 1, "1h": 7, "4h": 14, "1d": 90 };
  var BUCKET = { "1m": 300, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

  var st = {
    active: false, coinId: null, binSym: null, meta: null, interval: "15m",
    ws: null, gen: 0, poll: null, backup: false,
    canvas: null, ctx: null, candles: [], levels: [], resizeWired: false,
    book: null, trades: [], bookDirty: false, tradesDirty: false, rafPending: false,
    failCount: 0,
  };

  function el(id) { return U.el(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = v; }

  // ---------- lifecycle ----------
  function activate() {
    st.active = true;
    ensureChart();
    wireIntervalButtons();
    if (st.binSym) { loadKlines(); openSocket(); }
    else showNote(noteFor());
    draw();
  }
  function deactivate() { st.active = false; closeSocket(); stopBackupPoll(); }

  function setSymbol(coinId, meta) {
    var prevSym = st.binSym, sameCoin = coinId === st.coinId;
    st.coinId = coinId;
    st.meta = meta || null;
    st.binSym = CP.api.binanceSymbol(coinId);
    paintHeaderStatic();
    setText("bxChartSym", (st.binSym || "—") + " · " + st.interval);
    if (sameCoin && st.binSym && st.binSym === prevSym) {
      CP.paper.setContext(st.binSym, baseOf(st.binSym), meta ? meta.price : 0);
      return;
    }
    st.levels = [];
    if (st.binSym) {
      hideNote();
      CP.paper.setContext(st.binSym, baseOf(st.binSym), meta ? meta.price : 0);
      if (st.canvas) loadKlines();
      if (st.active) openSocket();
    } else {
      CP.paper.setContext(null, "", 0);
      stopBackupPoll();
      if (st.canvas) { st.candles = []; draw(); }
      showNote(noteFor());
      degradeFeed();
    }
  }
  function baseOf(sym) { return (sym || "").replace("USDT", ""); }
  function noteFor() {
    var s = st.meta && st.meta.symbol ? st.meta.symbol : (st.coinId || "this coin");
    return s + " isn’t a Binance USDT pair — no live chart/order book for it. The Trade Signal still works.";
  }

  // ---------- canvas candlestick chart (no external library) ----------
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
    var ratio = window.devicePixelRatio || 1, W = c.clientWidth || 600, H = 460;
    c.width = W * ratio; c.height = H * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var candles = st.candles || [];
    if (!candles.length) return;
    var padL = 8, padR = 70, padT = 10, padB = 22, plotW = W - padL - padR, plotH = H - padT - padB;
    // Scale the y-axis to the CANDLES only (like Binance). Signal levels that
    // fall outside this range get pinned to the top/bottom edge below, so a
    // far-away stop/target can't squash the candles into a flat line.
    var lo = Infinity, hi = -Infinity;
    candles.forEach(function (k) { if (k.low < lo) lo = k.low; if (k.high > hi) hi = k.high; });
    if (!(hi > lo)) { hi = lo * 1.01 || 1; lo = lo * 0.99 || 0; }
    var pad = (hi - lo) * 0.08; hi += pad; lo -= pad;
    function y(p) { return padT + (1 - (p - lo) / (hi - lo)) * plotH; }
    var n = candles.length, step = plotW / n, bw = Math.max(1, Math.min(step * 0.7, 14));
    ctx.font = "10px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
    for (var i = 0; i <= 5; i++) {
      var p = lo + (hi - lo) * i / 5, yy = y(p);
      ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
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
      ctx.fillStyle = l.color; ctx.textAlign = "right";
      if (l.price <= hi && l.price >= lo) {
        var yy = y(l.price);
        ctx.strokeStyle = l.color; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillText(l.title + " " + fmtP(l.price), padL + plotW, yy - 6);
      } else {
        // off-screen level — pin it to the top/bottom edge with an arrow.
        var atTop = l.price > hi;
        ctx.fillText((atTop ? "▲ " : "▼ ") + l.title + " " + fmtP(l.price), padL + plotW, atTop ? padT + 7 : padT + plotH - 5);
      }
    });
    ctx.fillStyle = "#5b6b80"; ctx.textAlign = "center";
    var labelN = Math.min(6, n);
    for (var t = 0; t < labelN; t++) {
      var idx2 = labelN > 1 ? Math.floor(t * (n - 1) / (labelN - 1)) : 0;
      var k2 = candles[idx2]; if (!k2) continue;
      ctx.fillText(fmtT(k2.time), padL + idx2 * step + step / 2, H - 8);
    }
  }

  // ---------- data: Binance klines ----------
  // Binance first (real candles + live stream). If Binance is unreachable, fall
  // back to CoinGecko so the chart still shows on networks that block Binance.
  function loadKlines() {
    if (!st.canvas || !st.binSym) return;
    stopBackupPoll();
    var sym = st.binSym, iv = st.interval;
    U.fetchJSON(BREST + "/klines?symbol=" + sym + "&interval=" + iv + "&limit=300", 8000).then(function (k) {
      if (sym !== st.binSym || iv !== st.interval) return;
      if (!k || !k.length) throw new Error("empty");
      st.backup = false;
      st.candles = k.map(function (c) { return { time: Math.floor(c[0] / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4] }; });
      hideNote(); draw(); setLevels(CP.state && CP.state.currentPlan);
    }).catch(function () {
      if (sym === st.binSym && iv === st.interval) loadBackupChart(sym, iv);
    });
  }

  // ---- backup chart (CoinGecko) for when Binance is blocked ----
  function loadBackupChart(sym, iv) {
    st.backup = true;
    drawFromCache(); // instant: build candles from price history the app already has
    fetchCGmarket().then(function (d) {
      if (sym === st.binSym && iv === st.interval && d.length) {
        st.candles = d; hideNote(); setHiLoFromCandles(); draw(); setLevels(CP.state && CP.state.currentPlan);
      }
    }).catch(function () {
      if (!st.candles.length) showNote("Couldn’t load chart data on this network. The signal still works.");
    });
    startBackupPoll();
  }
  function drawFromCache() {
    var e = CP.state && CP.state.coinCache && CP.state.coinCache[st.coinId];
    var ch = e && e.chart;
    if (!ch || !ch.closes || ch.closes.length < 2) return false;
    var closes = ch.closes, times = ch.times || [], data = [];
    for (var i = Math.max(1, closes.length - 180); i < closes.length; i++) {
      var o = closes[i - 1], c = closes[i];
      data.push({ time: times[i] ? Math.floor(times[i] / 1000) : i, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c });
    }
    if (!data.length) return false;
    st.candles = data; hideNote(); setHiLoFromCandles(); draw(); setLevels(CP.state && CP.state.currentPlan);
    return true;
  }
  function fetchCGmarket() {
    var url = CG + "/coins/" + st.coinId + "/market_chart?vs_currency=usd&days=" + (CG_DAYS[st.interval] || 1);
    return U.fetchJSON(url, 9000).then(function (d) { return aggregateToCandles(d && d.prices, st.interval); });
  }
  function aggregateToCandles(prices, iv) {
    var sec = BUCKET[iv] || 900, out = [], cur = null, bucket = null;
    (prices || []).forEach(function (p) {
      var t = Math.floor(p[0] / 1000), v = +p[1];
      if (!(v > 0)) return;
      var b = Math.floor(t / sec) * sec;
      if (b !== bucket) { if (cur) out.push(cur); bucket = b; cur = { time: b, open: v, high: v, low: v, close: v }; }
      else { if (v > cur.high) cur.high = v; if (v < cur.low) cur.low = v; cur.close = v; }
    });
    if (cur) out.push(cur);
    return out;
  }
  function setHiLoFromCandles() {
    if (!st.candles.length) return;
    var cutoff = Math.floor(Date.now() / 1000) - 86400, hi = -Infinity, lo = Infinity;
    st.candles.forEach(function (k) { if (k.time >= cutoff) { if (k.high > hi) hi = k.high; if (k.low < lo) lo = k.low; } });
    if (!(hi > 0)) st.candles.forEach(function (k) { if (k.high > hi) hi = k.high; if (k.low < lo) lo = k.low; });
    var dp = hi < 1 ? 4 : 2;
    if (hi > 0) setText("bxHigh", U.fmtUSD(hi, dp));
    if (lo < Infinity) setText("bxLow", U.fmtUSD(lo, dp));
  }
  function startBackupPoll() {
    stopBackupPoll();
    st.poll = setInterval(function () {
      if (!st.active || !st.backup || !st.coinId) return;
      U.fetchJSON(CG + "/simple/price?ids=" + st.coinId + "&vs_currencies=usd", 6000).then(function (r) {
        var p = r && r[st.coinId] && r[st.coinId].usd;
        if (!(p > 0)) return;
        setText("bxPrice", U.fmtUSD(p, p < 1 ? 4 : 2));
        CP.paper.mark(st.binSym, p);
        if (st.candles.length) {
          var last = st.candles[st.candles.length - 1];
          last.close = p; if (p > last.high) last.high = p; if (p < last.low) last.low = p; draw();
        }
      }).catch(function () {});
    }, 15000);
  }
  function stopBackupPoll() { if (st.poll) { clearInterval(st.poll); st.poll = null; } }
  function onKline(k) {
    if (!st.canvas || !k || st.backup) return;
    var t = Math.floor(k.t / 1000), c = { time: t, open: +k.o, high: +k.h, low: +k.l, close: +k.c };
    var last = st.candles[st.candles.length - 1];
    if (last && t === last.time) st.candles[st.candles.length - 1] = c;
    else if (!last || t > last.time) { st.candles.push(c); if (st.candles.length > 400) st.candles.shift(); }
    draw();
  }

  // ---------- signal levels ----------
  function setLevels(plan) {
    st.levels = [];
    if (plan && plan.entry) {
      st.levels.push({ price: plan.entry, color: "#e8edf2", title: plan.side === "long" ? "LONG entry" : "SHORT entry" });
      if (plan.stop > 0) st.levels.push({ price: plan.stop, color: "#f03542", title: "Stop" });
      (plan.targets || []).forEach(function (tp, i) { if (tp > 0) st.levels.push({ price: tp, color: "#16c784", title: "TP" + (i + 1) }); });
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
      setText("bxChartSym", (st.binSym || "—") + " · " + iv);
      loadKlines();
      if (st.active && st.binSym) openSocket(); // re-subscribe kline stream at the new interval
    });
  }

  // ---------- Binance WebSocket: depth + aggTrade + ticker + kline ----------
  function openSocket() {
    closeSocket();
    if (!st.binSym) return;
    var gen = ++st.gen, l = st.binSym.toLowerCase();
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
      else if (stream.indexOf("@kline") !== -1) onKline(d.k);
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
    if (el("bxBook")) el("bxBook").innerHTML = '<div class="bx-unavail">Live order book is unavailable — Binance looks unreachable on this network.</div>';
    if (el("bxTrades")) el("bxTrades").innerHTML = '<div class="bx-unavail">Recent trades unavailable — Binance unreachable here.</div>';
  }

  function onTrade(d) {
    st.trades.unshift({ p: +d.p, q: +d.q, m: d.m, t: d.T });
    if (st.trades.length > 10) st.trades.length = 10; // locked at 10
    st.tradesDirty = true; schedulePaint();
  }
  function onTicker(d) {
    var price = +d.c, chg = +d.P, dp = price < 1 ? 4 : 2;
    setText("bxPrice", U.fmtUSD(price, dp));
    var pr = el("bxPrice"); if (pr) pr.className = "bx-price " + (chg >= 0 ? "up" : "down");
    setText("bxChange", U.fmtPct(chg, true) + " (24h)");
    var ch = el("bxChange"); if (ch) ch.className = "bx-change " + (chg >= 0 ? "up" : "down");
    setText("bxHigh", U.fmtUSD(+d.h, dp));
    setText("bxLow", U.fmtUSD(+d.l, dp));
    setText("bxVolBase", U.fmtCompact(+d.v).replace("$", ""));
    setText("bxVolQuote", U.fmtCompact(+d.q));
    CP.paper.mark(st.binSym, price);
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
    setText("bxSymbol", st.binSym || (m.symbol ? m.symbol + "USDT" : (st.coinId || "").toUpperCase()));
    setText("bxCoinFull", m.name || "");
    var ic = el("bxCoinIcon");
    if (ic) ic.innerHTML = m.image ? '<img src="' + U.escapeHtml(m.image) + '" width="26" height="26" style="border-radius:50%" />' : "";
    if (m.price) setText("bxPrice", U.fmtUSD(m.price, m.price < 1 ? 4 : 2));
    if (typeof m.change24h === "number") {
      setText("bxChange", U.fmtPct(m.change24h, true) + " (24h)");
      var ch = el("bxChange"); if (ch) ch.className = "bx-change " + (m.change24h >= 0 ? "up" : "down");
    }
  }
  function showNote(msg) { var n = el("bxChartNote"); if (n) { n.textContent = msg || "Live market data unavailable."; n.classList.remove("hidden"); } }
  function hideNote() { var n = el("bxChartNote"); if (n) n.classList.add("hidden"); }

  if (document.addEventListener) document.addEventListener("DOMContentLoaded", wireIntervalButtons);

  return { activate: activate, deactivate: deactivate, setSymbol: setSymbol, setLevels: setLevels };
})();
