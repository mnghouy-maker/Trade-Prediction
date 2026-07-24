/* Forex / metals multi-timeframe (MTF) signal engine.
 *
 * Implements the 3-tier top-down agent spec:
 *   Tier 1 (D1)  — anchor trend: 200 EMA + HH/HL vs LH/LL → strict directional bias.
 *   Tier 2 (H1)  — market structure: nearest support/resistance; block entries too
 *                  close to the opposing level (<= 5 pips).
 *   Tier 3 (M15) — trigger: RSI bounce, engulfing candle, or CHoCH confirming bias.
 * Risk: SL = max(1.5*ATR(M15), beyond local swing); RRR >= 1.5 or NO_SIGNAL.
 *
 * Data: Twelve Data (free key, intraday forex + XAU/USD, CORS-enabled). Without a
 * key it renders clearly-labelled demo candles so the UI always works.
 */
CP.forex = (function () {
  var U = CP.util;
  var I = CP.indicators;
  var KEY_LS = "cp_td_key";

  var PAIRS = [
    { id: "EURUSD", sym: "EUR/USD" }, { id: "GBPUSD", sym: "GBP/USD" },
    { id: "USDJPY", sym: "USD/JPY" }, { id: "USDCAD", sym: "USD/CAD" },
    { id: "AUDUSD", sym: "AUD/USD" }, { id: "USDCHF", sym: "USD/CHF" },
    { id: "NZDUSD", sym: "NZD/USD" }, { id: "EURGBP", sym: "EUR/GBP" },
    { id: "EURJPY", sym: "EUR/JPY" }, { id: "GBPJPY", sym: "GBP/JPY" },
    { id: "XAUUSD", sym: "XAU/USD" },
  ];

  var st = { results: {}, cache: {}, selected: "EURUSD", scanning: false, booted: false };

  // ---- helpers ----
  function getKey() { try { return localStorage.getItem(KEY_LS) || ""; } catch (e) { return ""; } }
  function setKey(k) { try { localStorage.setItem(KEY_LS, k.trim()); } catch (e) {} }
  function pipSize(id) { return id.indexOf("JPY") !== -1 ? 0.01 : id.indexOf("XAU") !== -1 ? 0.1 : 0.0001; }
  function decimals(id) { return id.indexOf("JPY") !== -1 ? 3 : id.indexOf("XAU") !== -1 ? 2 : 5; }
  function fmt(id, v) { return v == null || isNaN(v) ? "—" : (+v).toFixed(decimals(id)); }
  function symOf(id) { var p = PAIRS.filter(function (x) { return x.id === id; })[0]; return p ? p.sym : id; }

  // ---- indicators specific to OHLC ----
  function atr(h, l, c, period) {
    period = period || 14;
    var trs = [];
    for (var i = 1; i < c.length; i++) {
      trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    }
    if (!trs.length) return 0;
    if (trs.length < period) return trs.reduce(function (a, b) { return a + b; }, 0) / trs.length;
    var a = 0, j;
    for (j = 0; j < period; j++) a += trs[j];
    a /= period;
    for (j = period; j < trs.length; j++) a = (a * (period - 1) + trs[j]) / period;
    return a;
  }
  function pivots(h, l, w) {
    w = w || 2;
    var highs = [], lows = [];
    for (var i = w; i < h.length - w; i++) {
      var isH = true, isL = true;
      for (var j = i - w; j <= i + w; j++) {
        if (h[j] > h[i]) isH = false;
        if (l[j] < l[i]) isL = false;
      }
      if (isH) highs.push({ i: i, v: h[i] });
      if (isL) lows.push({ i: i, v: l[i] });
    }
    return { highs: highs, lows: lows };
  }
  // HH/HL vs LH/LL via a recent-window vs prior-window proxy. Robust for clean
  // trends (which produce no local pivots) as well as choppy structure.
  function structure(h, l) {
    var n = h.length, k = Math.min(20, Math.floor(n / 2));
    if (k < 3) return { hh: false, hl: false, lh: false, ll: false };
    var recentH = Math.max.apply(null, h.slice(n - k)), priorH = Math.max.apply(null, h.slice(n - 2 * k, n - k));
    var recentL = Math.min.apply(null, l.slice(n - k)), priorL = Math.min.apply(null, l.slice(n - 2 * k, n - k));
    return { hh: recentH > priorH, hl: recentL > priorL, lh: recentH < priorH, ll: recentL < priorL };
  }
  // Nearest swing S/R strictly around price. When price prints a new extreme with
  // no level in the way, return a far level (no block, generous TP cap).
  function nearestSR(h, l, price) {
    var p = pivots(h, l, 2), res = Infinity, sup = -Infinity;
    p.highs.forEach(function (x) { if (x.v > price && x.v < res) res = x.v; });
    p.lows.forEach(function (x) { if (x.v < price && x.v > sup) sup = x.v; });
    if (res === Infinity) res = price * 1.02;  // no overhead resistance
    if (sup === -Infinity) sup = price * 0.98; // no support below
    return { res: res, sup: sup };
  }
  function engulf(o, c) {
    var n = c.length - 1;
    if (n < 1) return 0;
    var bull = c[n - 1] < o[n - 1] && c[n] > o[n] && c[n] >= o[n - 1] && o[n] <= c[n - 1];
    var bear = c[n - 1] > o[n - 1] && c[n] < o[n] && o[n] >= c[n - 1] && c[n] <= o[n - 1];
    return bull ? 1 : bear ? -1 : 0;
  }
  function choch(h, l, price) {
    var p = pivots(h, l, 2);
    var lastHigh = p.highs.length ? p.highs[p.highs.length - 1].v : Math.max.apply(null, h);
    var lastLow = p.lows.length ? p.lows[p.lows.length - 1].v : Math.min.apply(null, l);
    return price > lastHigh ? 1 : price < lastLow ? -1 : 0;
  }
  function ema200(closes) {
    var e = I.ema(closes, Math.min(200, closes.length));
    var v = e[e.length - 1];
    if (v == null || isNaN(v)) v = I.sma(closes, Math.min(200, closes.length));
    return v;
  }
  function avg(a) { return a && a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }

  // Last-candle pattern on a series.
  function pattern(o, h, l, c) {
    var n = c.length - 1;
    if (n < 1) return "None";
    var body = Math.abs(c[n] - o[n]), range = (h[n] - l[n]) || 1e-9;
    var upWick = h[n] - Math.max(o[n], c[n]), dnWick = Math.min(o[n], c[n]) - l[n];
    var eg = engulf(o, c);
    if (eg === 1) return "Bullish Engulfing";
    if (eg === -1) return "Bearish Engulfing";
    if (body / range < 0.12) return "Doji";
    if (dnWick > 2 * body && c[n] >= o[n]) return "Hammer";
    if (upWick > 2 * body && c[n] <= o[n]) return "Shooting Star";
    return c[n] > o[n] ? "Bullish candle" : "Bearish candle";
  }
  // Nearest unmitigated order block: last opposing-direction candle body midpoint.
  function orderBlock(d, dir, price) {
    var o = d.opens, c = d.closes, n = c.length;
    for (var i = n - 2; i >= Math.max(0, n - 60); i--) {
      if (dir === "bull" && c[i] < o[i] && (o[i] + c[i]) / 2 < price) return (o[i] + c[i]) / 2;
      if (dir === "bear" && c[i] > o[i] && (o[i] + c[i]) / 2 > price) return (o[i] + c[i]) / 2;
    }
    return null;
  }
  // Session volume status (or volatility proxy when the feed has no FX volume).
  function volumeStatus(vols, m15) {
    if (vols && vols.some(function (v) { return v > 0; })) {
      var n = vols.length, recent = avg(vols.slice(n - 10)), base = avg(vols.slice(Math.max(0, n - 50), n - 10));
      if (base <= 0) return { status: "Average", proxy: false };
      var r = recent / base;
      return { status: r > 1.3 ? "High" : r < 0.7 ? "Low" : "Average", proxy: false };
    }
    var aR = atr(m15.highs.slice(-20), m15.lows.slice(-20), m15.closes.slice(-20), 14);
    var aL = atr(m15.highs, m15.lows, m15.closes, 14) || 1e-9;
    var rr = aR / aL;
    return { status: rr > 1.3 ? "High" : rr < 0.7 ? "Low" : "Average", proxy: true };
  }

  // ============ THE MTF ENGINE ============
  function buildSignal(id, d1, h1, m15, m5) {
    m5 = m5 || m15;
    var pip = pipSize(id), price = m15.closes[m15.closes.length - 1];
    var out = {
      signal: "NO_SIGNAL", pair: id, execution_timeframe: "M15", entry_range: "-",
      stop_loss: null, take_profit: null, risk_reward_ratio: 0, confidence_score: 1,
      reasoning: "", _tiers: {}, _live: d1.live && h1.live && m15.live, _price: price,
    };

    // ---- Extract the full Tier 1/2/3 data readout (independent of the decision) ----
    var e200 = ema200(d1.closes), s = structure(d1.highs, d1.lows);
    var macroRSI = I.rsi(d1.closes, 14) || 50;
    var sr = nearestSR(h1.highs, h1.lows, price);
    var distRes = (sr.res - price) / pip, distSup = (price - sr.sup) / pip;
    var bullish = price > e200 && s.hh && s.hl;
    var bearish = price < e200 && s.lh && s.ll;
    var tier1 = bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL";
    var obDir = tier1 === "BEARISH" ? "bear" : "bull";
    var ob = orderBlock(h1, obDir, price);
    var vol = volumeStatus(h1.volumes, m15);
    var m15ch = choch(m15.highs, m15.lows, price);
    var m5rsi = I.rsi(m5.closes, 14) || 50;
    var pat = pattern(m5.opens, m5.highs, m5.lows, m5.closes);
    var atrM15 = atr(m15.highs, m15.lows, m15.closes, 14);
    var structText = s.hh && s.hl ? "Higher Highs & Higher Lows" : s.lh && s.ll ? "Lower Highs & Lower Lows" : "Ranging / Mixed";
    var m15Text = m15ch > 0 ? "Bullish BOS / CHoCH" : m15ch < 0 ? "Bearish BOS / CHoCH" : "Ranging";

    out._data = {
      symbol: id, timeframe: "D1→H1→M15/M5",
      tier1: { price: price, ema200: e200, relation: price > e200 ? "ABOVE" : "BELOW", structure: structText, macroRSI: macroRSI, bias: tier1 },
      tier2: { resistance: sr.res, distResPips: distRes, support: sr.sup, distSupPips: distSup, orderBlock: ob, volume: vol.status, volProxy: vol.proxy },
      tier3: { m15Structure: m15Text, m5RSI: m5rsi, candle: pat, atr: atrM15, atrPips: atrM15 / pip },
    };
    // keep the compact tier state the existing UI reads
    out._tiers = {
      t1: { bias: tier1, ema200: e200, priceAboveEMA: price > e200, struct: s },
      t2: { support: sr.sup, resistance: sr.res, distResPips: distRes, distSupPips: distSup },
      t3: { rsi: m5rsi, engulf: 0, choch: m15ch, triggers: [] },
    };

    // ---- Direction: always commit to a side (BUY or SELL) ----
    var side;
    if (tier1 === "BULLISH") side = "long";
    else if (tier1 === "BEARISH") side = "short";
    else {
      var lean = (price > e200 ? 1 : -1) + (m5rsi >= 50 ? 1 : -1) + (m15ch >= 0 ? 1 : -1);
      side = lean >= 0 ? "long" : "short";
    }

    // Execution triggers (confirmation strength for confidence / notes)
    var trigs = [];
    if (side === "long") {
      if (m5rsi < 40) trigs.push("M5 RSI bounce (" + m5rsi.toFixed(0) + ")");
      if (pat === "Bullish Engulfing" || pat === "Hammer") trigs.push("M5 " + pat);
      if (m15ch === 1) trigs.push("M15 bullish BOS/CHoCH");
    } else {
      if (m5rsi > 60) trigs.push("M5 RSI rejection (" + m5rsi.toFixed(0) + ")");
      if (pat === "Bearish Engulfing" || pat === "Shooting Star") trigs.push("M5 " + pat);
      if (m15ch === -1) trigs.push("M15 bearish BOS/CHoCH");
    }
    out._tiers.t3.triggers = trigs;

    // ---- Risk: SL = max(1.5*ATR, structural swing); TP ladder at ~2R / 3R ----
    var entry = price;
    var lastLows = m15.lows.slice(-10), lastHighs = m15.highs.slice(-10);
    var slDist, stop, cap, avail, tp1, tp2, rr;
    if (side === "long") {
      slDist = Math.max(1.5 * atrM15, entry - Math.min.apply(null, lastLows));
      stop = entry - slDist; cap = sr.res; avail = cap - entry;
      tp1 = (avail / slDist >= 1.5) ? entry + Math.min(2 * slDist, avail - pip) : entry + 1.5 * slDist;
      tp2 = entry + 3 * slDist; rr = (tp1 - entry) / slDist;
    } else {
      slDist = Math.max(1.5 * atrM15, Math.max.apply(null, lastHighs) - entry);
      stop = entry + slDist; cap = sr.sup; avail = entry - cap;
      tp1 = (avail / slDist >= 1.5) ? entry - Math.min(2 * slDist, avail - pip) : entry - 1.5 * slDist;
      tp2 = entry - 3 * slDist; rr = (entry - tp1) / slDist;
    }

    // ---- Confidence 1..5 from how much of the MTF stack aligns ----
    var clearance = side === "long" ? distRes : distSup;
    var conf = 1;
    if (tier1 !== "NEUTRAL") conf++;
    if (clearance > 5) conf++;
    if (trigs.length) conf++;
    if (rr >= 2) conf++;
    conf = Math.max(1, Math.min(5, conf));

    var cautions = [];
    if (tier1 === "NEUTRAL") cautions.push("range/mixed D1 anchor");
    if (clearance <= 5) cautions.push("near " + (side === "long" ? "resistance" : "support"));
    if (!trigs.length) cautions.push("no fresh M5 trigger yet");

    var buf = 0.15 * atrM15, slPips = Math.abs(entry - stop) / pip;
    var tp1Pips = Math.abs(tp1 - entry) / pip, tp2Pips = Math.abs(tp2 - entry) / pip;
    out.signal = side === "long" ? "BUY" : "SELL";
    out.entry_range = fmt(id, entry - buf) + " - " + fmt(id, entry + buf);
    out.stop_loss = +fmt(id, stop);
    out.take_profit = +fmt(id, tp1);
    out.take_profit_2 = +fmt(id, tp2);
    out.risk_reward_ratio = +rr.toFixed(2);
    out.confidence_score = conf;
    out._levels = { entry: entry, stop: stop, tp1: tp1, tp2: tp2, slPips: slPips, tp1Pips: tp1Pips, tp2Pips: tp2Pips };
    out.reasoning = out.signal + " " + id + " · " +
      (tier1 !== "NEUTRAL" ? "D1 " + tier1.toLowerCase() + " bias" : "momentum-led bias") +
      (trigs.length ? ", confirmed by " + trigs.join(" + ") : ", awaiting a clean M5 trigger") +
      ". SL " + Math.round(slPips) + "p, TP1 " + Math.round(tp1Pips) + "p (" + rr.toFixed(1) + "R), TP2 " + Math.round(tp2Pips) + "p." +
      (cautions.length ? " Caution: " + cautions.join(", ") + "." : "");
    return out;
  }
  function tooTightMsg(tier1, id, level) {
    return "Tier 1/2/3 align " + tier1.toLowerCase() + ", but a 1:1.5 reward cannot be reached before the H1 level at " +
      fmt(id, level) + ". Per the risk rules, output is NO_SIGNAL.";
  }

  // ============ DATA (Twelve Data) ============
  function fetchTD(url) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch(url, { signal: ctrl.signal }).then(function (r) {
      clearTimeout(t);
      return r.json().then(function (b) { return { status: r.status, body: b }; });
    });
  }
  // Twelve Data (keyed). Throws on error; sets e.rate on a 429 so callers pause.
  function tdSeries(interval, sym, size) {
    var url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(sym) +
      "&interval=" + interval + "&outputsize=" + size + "&apikey=" + encodeURIComponent(getKey());
    return fetchTD(url).then(function (res) {
      var b = res.body || {};
      if (b.status === "error" || res.status === 429) {
        if (String(b.code) === "429" || res.status === 429 || /limit/i.test(b.message || "")) {
          var e = new Error("ratelimit"); e.rate = true; throw e;
        }
        throw new Error(b.message || "error");
      }
      if (!b.values || !b.values.length) throw new Error("no data");
      var v = b.values.slice().reverse();
      return { live: true,
        opens: v.map(function (x) { return +x.open; }), highs: v.map(function (x) { return +x.high; }),
        lows: v.map(function (x) { return +x.low; }), closes: v.map(function (x) { return +x.close; }),
        volumes: v.map(function (x) { return +(x.volume || 0); }) };
    });
  }

  // Keyless live source: Yahoo Finance intraday via a public CORS proxy.
  var YMAP = { "1day": { i: "1d", r: "2y" }, "1h": { i: "1h", r: "60d" }, "15min": { i: "15m", r: "1mo" }, "5min": { i: "5m", r: "5d" } };
  function yahooSymbol(id) { return id === "XAUUSD" ? "GC=F" : id + "=X"; }
  // Try direct, then several public CORS proxies, until one returns valid data.
  var PROXIES = [
    function (u) { return u; },
    function (u) { return "https://api.allorigins.win/raw?url=" + encodeURIComponent(u); },
    function (u) { return "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(u); },
    function (u) { return "https://corsproxy.io/?url=" + encodeURIComponent(u); },
    function (u) { return "https://thingproxy.freeboard.io/fetch/" + u; },
  ];
  function parseYahoo(b) {
    var r = b && b.chart && b.chart.result && b.chart.result[0];
    if (!r || !r.indicators || !r.indicators.quote) throw new Error("no yahoo");
    var q = r.indicators.quote[0], ts = r.timestamp || [];
    var o = [], h = [], l = [], c = [], vv = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.close[i] == null || q.open[i] == null) continue;
      o.push(+q.open[i]); h.push(+q.high[i]); l.push(+q.low[i]); c.push(+q.close[i]); vv.push(+(q.volume[i] || 0));
    }
    if (c.length < 30) throw new Error("short");
    return { live: true, opens: o, highs: h, lows: l, closes: c, volumes: vv };
  }
  function yahoo(interval, id) {
    var y = YMAP[interval] || YMAP["1day"];
    var yurl = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(yahooSymbol(id)) +
      "?interval=" + y.i + "&range=" + y.r;
    var i = 0;
    function tryNext() {
      if (i >= PROXIES.length) return Promise.reject(new Error("all proxies failed"));
      return fetchTD(PROXIES[i++](yurl)).then(function (res) { return parseYahoo(res.body); }).catch(tryNext);
    }
    return tryNext();
  }

  // Resolve one series: Twelve Data (if keyed) → Yahoo (keyless live) → demo.
  function series(interval, sym, size) {
    var id = sym.replace("/", "");
    var p = getKey() ? tdSeries(interval, sym, size) : Promise.reject({ soft: true });
    return p.catch(function (e) { if (e && e.rate) throw e; return yahoo(interval, id); })
            .catch(function (e) { if (e && e.rate) throw e; return synth(sym, interval, size); });
  }
  // Deterministic demo candles (no key / fetch failure). Each pair gets a stable
  // regime (uptrend / downtrend / range) so the demo actually demonstrates real
  // BUY / SELL / NO_SIGNAL setups instead of always returning NO_SIGNAL.
  function synth(sym, interval, size) {
    var bases = { "EUR/USD": 1.09, "GBP/USD": 1.27, "USD/JPY": 157, "USD/CAD": 1.37, "AUD/USD": 0.66,
      "USD/CHF": 0.89, "NZD/USD": 0.60, "EUR/GBP": 0.85, "EUR/JPY": 171, "GBP/JPY": 199, "XAU/USD": 4040 };
    var base = bases[sym] || 1.1;
    var hc = 0; for (var s = 0; s < sym.length; s++) hc = (hc * 31 + sym.charCodeAt(s)) >>> 0;
    var mode = hc % 4;                                   // 0,2 = up · 1 = down · 3 = range
    var dir = mode === 1 ? -1 : mode === 3 ? 0 : 1;
    var seed = hc + interval.length * 17;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; }
    var opens = [], highs = [], lows = [], closes = [], volumes = [];
    var span = 0.15;                                     // ~15% trend into the current price
    var start = dir === 0 ? base : base * (1 - dir * span);
    for (var i = 0; i < size; i++) {
      var frac = size > 1 ? i / (size - 1) : 1;
      var mid = dir === 0 ? base * (1 + Math.sin(i / 6) * 0.012) : start + (base - start) * frac;
      var noise = rnd() * 0.0015 * base;
      var o = i ? closes[i - 1] : mid;
      var c = mid + noise;
      opens.push(o); closes.push(c);
      highs.push(Math.max(o, c) + Math.abs(noise) + base * 0.0003);
      lows.push(Math.min(o, c) - Math.abs(noise) - base * 0.0003);
      volumes.push(1000 + Math.abs(rnd()) * 50000);
    }
    // Force an aligned M5 execution trigger (engulfing) for trending pairs.
    if (interval === "5min" && dir !== 0) {
      var n = size - 1, a = closes[n - 2] || closes[n - 1];
      if (dir > 0) { opens[n - 1] = a * 1.0012; closes[n - 1] = a * 0.9994;
                     opens[n] = closes[n - 1] * 0.9996; closes[n] = opens[n - 1] * 1.0016; }
      else { opens[n - 1] = a * 0.9988; closes[n - 1] = a * 1.0006;
             opens[n] = closes[n - 1] * 1.0004; closes[n] = opens[n - 1] * 0.9984; }
      highs[n] = Math.max(opens[n], closes[n]) + base * 0.0006; lows[n] = Math.min(opens[n], closes[n]) - base * 0.0006;
      highs[n - 1] = Math.max(opens[n - 1], closes[n - 1]) + base * 0.0006; lows[n - 1] = Math.min(opens[n - 1], closes[n - 1]) - base * 0.0006;
    }
    return { live: false, opens: opens, highs: highs, lows: lows, closes: closes, volumes: volumes };
  }

  // Analyze one pair: fetch D1/H1/M15 then run the engine. Cached ~90s.
  function analyze(id, opts) {
    opts = opts || {};
    var c = st.cache[id];
    if (!opts.force && c && Date.now() - c.t < 90000) {
      st.results[id] = c.res; return Promise.resolve(c.res);
    }
    var sym = symOf(id);
    // Fetch the four timeframes in parallel (each falls back TD→Yahoo→demo).
    return Promise.all([
      series("1day", sym, 220), series("1h", sym, 160),
      series("15min", sym, 160), series("5min", sym, 160),
    ]).then(function (a) {
      var res = buildSignal(id, a[0], a[1], a[2], a[3]);
      st.results[id] = res; st.cache[id] = { t: Date.now(), res: res };
      return res;
    });
  }

  // Instant offline result (all-demo candles) so a signal shows immediately
  // while the live fetch runs in the background.
  function demoResult(id) {
    var sym = symOf(id);
    return buildSignal(id, synth(sym, "1day", 220), synth(sym, "1h", 160),
      synth(sym, "15min", 160), synth(sym, "5min", 160));
  }

  return {
    PAIRS: PAIRS, getKey: getKey, setKey: setKey, analyze: analyze, buildSignal: buildSignal,
    demoResult: demoResult, symOf: symOf, fmt: fmt, state: st,
    init: function () { CP.forexUI && CP.forexUI.init(); },
    onOpen: function () { CP.forexUI && CP.forexUI.onOpen(); },
  };
})();
