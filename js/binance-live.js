/* Live Binance market view for the Trade tab.
 *
 * Chart: TradingView Lightweight Charts (free) for a real Binance-style chart
 * with wheel/drag zoom, pan and crosshair, with the Trade Signal's entry/stop/
 * take-profit drawn as price lines. The library loads from a CDN with several
 * fallbacks; if every CDN is blocked it degrades to a self-contained <canvas>
 * renderer so candles still show.
 *
 * Data: Binance first (klines REST history + @kline live stream + order book +
 * trades + ticker). If Binance is unreachable, candles fall back to CoinGecko so
 * the chart still works on networks that block Binance (order book + trades are
 * Binance-only and show a notice there). No API keys. */
CP.live = (function () {
  var U = CP.util;
  var WS_BASE = "wss://stream.binance.com:9443/stream?streams=";
  var BREST = (CP.config && CP.config.api && CP.config.api.binance) || "https://api.binance.com/api/v3";
  var CG = (CP.config && CP.config.api && CP.config.api.coingecko) || "https://api.coingecko.com/api/v3";
  var CG_DAYS = { "1m": 1, "5m": 1, "15m": 1, "1h": 7, "4h": 14, "1d": 90 };
  var BUCKET = { "1m": 300, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  var LIBS = [
    "https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js",
    "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js",
    "https://cdnjs.cloudflare.com/ajax/libs/lightweight-charts/4.1.3/lightweight-charts.standalone.production.js",
  ];

  var st = {
    active: false, coinId: null, binSym: null, meta: null, interval: "15m",
    ws: null, gen: 0, poll: null, backup: false,
    mode: null, chart: null, series: null, priceLines: [], maSeries: {}, volSeries: null, canvas: null, ctx: null,
    candles: [], levels: [], resizeWired: false, building: false,
    book: null, trades: [], bookDirty: false, tradesDirty: false, rafPending: false,
    failCount: 0,
  };

  function el(id) { return U.el(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = v; }
  function baseOf(sym) { return (sym || "").replace("USDT", ""); }
  function noteFor() {
    var s = st.meta && st.meta.symbol ? st.meta.symbol : (st.coinId || "this coin");
    return s + " isn’t a Binance USDT pair — no live chart/order book for it. The Trade Signal still works.";
  }

  // ---------- lifecycle ----------
  function activate() {
    st.active = true;
    wireIntervalButtons();
    ensureChart(function () { if (st.binSym) loadKlines(); resizeChart(); });
    if (st.binSym) openSocket(); else showNote(noteFor());
  }
  function deactivate() { st.active = false; closeSocket(); stopBackupPoll(); }

  function setSymbol(coinId, meta) {
    var prevSym = st.binSym, sameCoin = coinId === st.coinId;
    st.coinId = coinId; st.meta = meta || null;
    st.binSym = CP.api.binanceSymbol(coinId);
    paintHeaderStatic();
    setText("bxChartSym", (st.binSym || "—") + " · " + st.interval);
    if (sameCoin && st.binSym && st.binSym === prevSym) {
      CP.paper.setContext(st.binSym, baseOf(st.binSym), meta ? meta.price : 0);
      return;
    }
    clearLevels();
    if (st.binSym) {
      hideNote();
      CP.paper.setContext(st.binSym, baseOf(st.binSym), meta ? meta.price : 0);
      if (st.mode) loadKlines();
      if (st.active) openSocket();
    } else {
      CP.paper.setContext(null, "", 0);
      stopBackupPoll();
      renderCandles([], true);
      showNote(noteFor());
      degradeFeed();
    }
  }

  // ---------- chart engine: Lightweight Charts (preferred) or canvas fallback ----------
  function ensureChart(cb) {
    if (st.mode) { if (cb) cb(); return; }
    if (st.building) return;
    var host = el("bxChart"); if (!host) return;
    st.building = true;
    loadLib(function (ok) {
      st.building = false;
      if (st.mode) { if (cb) cb(); return; }
      if (ok && window.LightweightCharts) buildLibChart(host); else buildCanvas(host);
      if (!st.resizeWired) { window.addEventListener("resize", resizeChart); st.resizeWired = true; }
      if (cb) cb();
    });
  }
  function loadLib(cb) {
    if (window.LightweightCharts) { cb(true); return; }
    var i = 0;
    (function tryNext() {
      if (window.LightweightCharts) { cb(true); return; }
      if (i >= LIBS.length) { cb(false); return; }
      var s = document.createElement("script");
      s.async = true; s.src = LIBS[i++];
      s.onload = function () { if (window.LightweightCharts) cb(true); else tryNext(); };
      s.onerror = tryNext;
      document.head.appendChild(s);
    })();
  }
  function buildLibChart(host) {
    host.innerHTML = "";
    var LC = window.LightweightCharts;
    st.chart = LC.createChart(host, {
      width: host.clientWidth || 600, height: 460,
      layout: { background: { type: "solid", color: "#0d111c" }, textColor: "#8b9bb0" },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "rgba(255,255,255,0.10)" },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.10)", scaleMargins: { top: 0.06, bottom: 0.26 } },
      crosshair: { mode: LC.CrosshairMode ? LC.CrosshairMode.Normal : 0 },
    });
    st.series = st.chart.addCandlestickSeries({
      upColor: "#16c784", downColor: "#f03542", borderVisible: false,
      wickUpColor: "#16c784", wickDownColor: "#f03542",
    });
    // Moving averages (like Binance: MA7 gold, MA25 pink, MA99 purple).
    function ma(color) { return st.chart.addLineSeries({ color: color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); }
    st.maSeries = { ma7: ma("#f0b90b"), ma25: ma("#e542a3"), ma99: ma("#8a7df7") };
    // Volume histogram in a band at the bottom.
    st.volSeries = st.chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    st.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    st.chart.subscribeCrosshairMove(function (param) { updateLegend(param); });
    st.mode = "lib";
  }
  function buildCanvas(host) {
    host.innerHTML = "";
    var c = document.createElement("canvas");
    c.style.width = "100%"; c.style.height = "460px"; c.style.display = "block";
    host.appendChild(c); st.canvas = c; st.ctx = c.getContext("2d"); st.mode = "canvas";
  }
  function resizeChart() {
    if (st.mode === "lib" && st.chart) {
      var h = el("bxChart"); if (h && h.clientWidth) { try { st.chart.resize(h.clientWidth, 460); } catch (e) {} }
    } else draw();
  }

  // ---------- candle data → render (mode-aware) ----------
  function renderCandles(data, refit) {
    st.candles = data || [];
    if (st.mode === "lib" && st.series) {
      try { st.series.setData(st.candles); if (refit && st.candles.length) st.chart.timeScale().fitContent(); } catch (e) {}
      setOverlays();
    } else draw();
    if (st.candles.length) { hideNote(); if (st.backup) setHiLoFromCandles(); }
    updateLegend(null);
    setLevels(CP.state && CP.state.currentPlan);
  }
  function updateLastCandle(c) {
    var last = st.candles[st.candles.length - 1];
    if (last && c.time === last.time) st.candles[st.candles.length - 1] = c;
    else if (!last || c.time > last.time) { st.candles.push(c); if (st.candles.length > 500) st.candles.shift(); }
    else return;
    if (st.mode === "lib" && st.series) { try { st.series.update(c); } catch (e) {} updateOverlaysLast(); } else draw();
    updateLegend(null);
  }

  // ---- moving averages + volume + legend (TradingView-style) ----
  function smaData(period) {
    var cs = st.candles, out = [];
    for (var i = period - 1; i < cs.length; i++) {
      var sum = 0; for (var j = i - period + 1; j <= i; j++) sum += cs[j].close;
      out.push({ time: cs[i].time, value: sum / period });
    }
    return out;
  }
  function maAt(period, idx) {
    if (idx < period - 1) return null;
    var sum = 0; for (var j = idx - period + 1; j <= idx; j++) sum += st.candles[j].close;
    return sum / period;
  }
  function volColor(k) { return k.close >= k.open ? "rgba(22,199,132,0.45)" : "rgba(240,53,66,0.45)"; }
  function setOverlays() {
    if (st.mode !== "lib") return;
    if (st.maSeries.ma7) st.maSeries.ma7.setData(smaData(7));
    if (st.maSeries.ma25) st.maSeries.ma25.setData(smaData(25));
    if (st.maSeries.ma99) st.maSeries.ma99.setData(smaData(99));
    if (st.volSeries) {
      var cs = st.candles, hasVol = cs.length && cs[cs.length - 1].volume != null;
      st.volSeries.setData(hasVol ? cs.map(function (k) { return { time: k.time, value: k.volume || 0, color: volColor(k) }; }) : []);
    }
  }
  function updateOverlaysLast() {
    if (st.mode !== "lib") return;
    var i = st.candles.length - 1; if (i < 0) return;
    var t = st.candles[i].time;
    if (st.maSeries.ma7 && i >= 6) st.maSeries.ma7.update({ time: t, value: maAt(7, i) });
    if (st.maSeries.ma25 && i >= 24) st.maSeries.ma25.update({ time: t, value: maAt(25, i) });
    if (st.maSeries.ma99 && i >= 98) st.maSeries.ma99.update({ time: t, value: maAt(99, i) });
    if (st.volSeries && st.candles[i].volume != null) st.volSeries.update({ time: t, value: st.candles[i].volume || 0, color: volColor(st.candles[i]) });
  }
  function legNum(v) { return v == null ? "–" : (v < 1 ? (+v.toPrecision(5)).toString() : (+v.toFixed(2)).toString()); }
  function updateLegend(param) {
    var lg = el("bxLegend"); if (!lg || !st.candles.length) return;
    var idx = st.candles.length - 1;
    if (param && param.time != null) {
      for (var i = st.candles.length - 1; i >= 0; i--) { if (st.candles[i].time === param.time) { idx = i; break; } }
    }
    var k = st.candles[idx]; if (!k) return;
    lg.innerHTML =
      '<span class="lg-ohlc ' + (k.close >= k.open ? "up" : "down") + '">O ' + legNum(k.open) + " H " + legNum(k.high) + " L " + legNum(k.low) + " C " + legNum(k.close) + "</span>" +
      '<span style="color:#f0b90b">MA7 ' + legNum(maAt(7, idx)) + "</span>" +
      '<span style="color:#e542a3">MA25 ' + legNum(maAt(25, idx)) + "</span>" +
      '<span style="color:#8a7df7">MA99 ' + legNum(maAt(99, idx)) + "</span>";
  }

  // ---------- data: Binance first, CoinGecko fallback ----------
  function loadKlines() {
    if (!st.mode || !st.binSym) return;
    stopBackupPoll();
    var sym = st.binSym, iv = st.interval;
    U.fetchJSON(BREST + "/klines?symbol=" + sym + "&interval=" + iv + "&limit=300", 8000).then(function (k) {
      if (sym !== st.binSym || iv !== st.interval) return;
      if (!k || !k.length) throw new Error("empty");
      st.backup = false;
      renderCandles(k.map(function (c) { return { time: Math.floor(c[0] / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }; }), true);
    }).catch(function () {
      if (sym === st.binSym && iv === st.interval) loadBackupChart(sym, iv);
    });
  }
  function loadBackupChart(sym, iv) {
    st.backup = true;
    drawFromCache();
    fetchCGmarket().then(function (d) {
      if (sym === st.binSym && iv === st.interval && d.length) renderCandles(d, true);
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
    renderCandles(data, true);
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
          updateLastCandle({ time: last.time, open: last.open, high: Math.max(last.high, p), low: Math.min(last.low, p), close: p });
        }
      }).catch(function () {});
    }, 15000);
  }
  function stopBackupPoll() { if (st.poll) { clearInterval(st.poll); st.poll = null; } }

  // ---------- signal levels ----------
  function clearLevels() {
    st.levels = [];
    if (st.mode === "lib" && st.series) {
      st.priceLines.forEach(function (l) { try { st.series.removePriceLine(l); } catch (e) {} });
      st.priceLines = [];
    }
  }
  function setLevels(plan) {
    var lv = [];
    if (plan && plan.entry) {
      lv.push({ price: plan.entry, color: "#e8edf2", title: plan.side === "long" ? "LONG entry" : "SHORT entry" });
      if (plan.stop > 0) lv.push({ price: plan.stop, color: "#f03542", title: "Stop" });
      (plan.targets || []).forEach(function (tp, i) { if (tp > 0) lv.push({ price: tp, color: "#16c784", title: "TP" + (i + 1) }); });
    }
    st.levels = lv;
    if (st.mode === "lib" && st.series) {
      st.priceLines.forEach(function (l) { try { st.series.removePriceLine(l); } catch (e) {} });
      st.priceLines = [];
      var LS = window.LightweightCharts && window.LightweightCharts.LineStyle;
      lv.forEach(function (l) {
        try {
          st.priceLines.push(st.series.createPriceLine({
            price: l.price, color: l.color, lineWidth: 2, lineStyle: LS ? LS.Dashed : 2, axisLabelVisible: true, title: l.title,
          }));
        } catch (e) {}
      });
    } else draw();
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
      if (st.active && st.binSym) openSocket();
    });
  }

  // ---------- canvas fallback renderer (only used if no library could load) ----------
  function fmtP(p) { return p >= 1 ? p.toFixed(2) : (+p.toPrecision(4)).toString(); }
  function fmtT(sec) { var d = new Date(sec * 1000); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function draw() {
    var c = st.canvas, ctx = st.ctx; if (!c || !ctx) return;
    var ratio = window.devicePixelRatio || 1, W = c.clientWidth || 600, H = 460;
    c.width = W * ratio; c.height = H * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, W, H);
    var candles = st.candles || []; if (!candles.length) return;
    var padL = 8, padR = 70, padT = 10, padB = 22, plotW = W - padL - padR, plotH = H - padT - padB;
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
  function onKline(k) {
    if (!st.mode || !k || st.backup) return;
    updateLastCandle({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
  }
  function onTrade(d) {
    st.trades.unshift({ p: +d.p, q: +d.q, m: d.m, t: d.T });
    if (st.trades.length > 10) st.trades.length = 10;
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
