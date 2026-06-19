/* Data layer. Every fetch degrades gracefully to clearly-labelled sample data
 * so the dashboard always renders something useful even if an endpoint is down
 * or rate-limited. `live` flags let the UI show a "DEMO" badge when needed. */
CP.api = (function () {
  var cfg = CP.config;
  var U = CP.util;

  // Optional backend (server/index.js). When the app is served by that backend,
  // these same-origin routes return key-enriched data (CryptoPanic news, Whale
  // Alert flows, LLM sentiment). On GitHub Pages / file:// they 404 fast and we
  // transparently fall back to the public-API / sample paths below.
  function tryBackend(path, timeout) {
    if (cfg.backend && cfg.backend.disabled) return Promise.reject(new Error("disabled"));
    var base = (cfg.backend && cfg.backend.base) || "";
    return U.fetchJSON(base + path, timeout || 6000);
  }

  var BINANCE = cfg.api.binance;

  // Map a CoinGecko coin id -> Binance USDT trading pair (so prices match Binance).
  var SYMAP = { bitcoin: "BTC", ethereum: "ETH" };
  function baseSymbol(coinId) {
    if (SYMAP[coinId]) return SYMAP[coinId];
    var m = window.CP.state && CP.state.marketsById && CP.state.marketsById[coinId];
    return m ? m.symbol : null;
  }
  function binanceSymbol(coinId) {
    var b = baseSymbol(coinId);
    return b ? b + "USDT" : null;
  }

  // Light, fast price lookup for the 1-second live refresh.
  function getBinancePrices(symbols) {
    var url = BINANCE + "/ticker/price?symbols=" + encodeURIComponent(JSON.stringify(symbols));
    return U.fetchJSON(url, 5000).then(function (arr) {
      var map = {};
      arr.forEach(function (t) { map[t.symbol] = +t.price; });
      return map;
    }).catch(function () { return null; });
  }

  // All Binance USDT tickers (price + 24h change + volume), keyed by base symbol.
  function getBinance24hAll() {
    return U.fetchJSON(BINANCE + "/ticker/24hr", 20000).then(function (arr) {
      var map = {};
      arr.forEach(function (t) {
        var s = t.symbol;
        if (s.length > 4 && s.slice(-4) === "USDT") {
          map[s.slice(0, -4)] = { price: +t.lastPrice, change24h: +t.priceChangePercent, volume: +t.quoteVolume };
        }
      });
      return map;
    }).catch(function () { return null; });
  }

  // ---- Live: BTC & ETH price/24h from Binance (CoinGecko fallback) ----
  function getSimple() {
    var url = BINANCE + '/ticker/24hr?symbols=' + encodeURIComponent('["BTCUSDT","ETHUSDT"]');
    return U.fetchJSON(url).then(function (arr) {
      var by = {};
      arr.forEach(function (t) { by[t.symbol] = t; });
      function pack(s) {
        var t = by[s] || {};
        return { usd: +t.lastPrice, usd_24h_change: +t.priceChangePercent, usd_24h_vol: +t.quoteVolume };
      }
      if (!by.BTCUSDT || !by.ETHUSDT) throw new Error("missing");
      return { live: true, data: { bitcoin: pack("BTCUSDT"), ethereum: pack("ETHUSDT") } };
    }).catch(function () { return coingeckoSimple(); });
  }

  function coingeckoSimple() {
    var ids = cfg.coins.map(function (c) { return c.id; }).join(",");
    var url = cfg.api.coingecko + "/simple/price?ids=" + ids +
      "&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true";
    return U.fetchJSON(url).then(function (d) {
      return { live: true, data: d };
    }).catch(function () {
      return { live: false, data: {
        bitcoin: { usd: 64250, usd_24h_change: 1.8, usd_24h_vol: 31e9 },
        ethereum: { usd: 3380, usd_24h_change: 2.4, usd_24h_vol: 15e9 },
      } };
    });
  }

  // ---- Live: global market cap ----
  function getGlobal() {
    return U.fetchJSON(cfg.api.coingecko + "/global").then(function (d) {
      var g = d.data;
      return { live: true, marketCap: g.total_market_cap.usd, change24h: g.market_cap_change_percentage_24h_usd };
    }).catch(function () {
      return { live: false, marketCap: 2.35e12, change24h: 1.1 };
    });
  }

  // ---- Live: Fear & Greed index ----
  function getFearGreed() {
    return U.fetchJSON(cfg.api.fearGreed).then(function (d) {
      var now = d.data[0], prev = d.data[1] || d.data[0];
      return { live: true, value: +now.value, label: now.value_classification, prev: +prev.value };
    }).catch(function () {
      return { live: false, value: 58, label: "Greed", prev: 52 };
    });
  }

  // ---- Live: daily closes for indicators / backtest (Binance klines) ----
  function getMarketChart(coinId, days) {
    var sym = binanceSymbol(coinId);
    if (sym) {
      var lim = Math.min(1000, (days | 0) + 5); // Binance caps daily klines at 1000
      var url = BINANCE + "/klines?symbol=" + sym + "&interval=1d&limit=" + lim;
      return U.fetchJSON(url, 15000).then(function (k) {
        if (!k || !k.length) throw new Error("empty");
        return {
          live: true,
          closes: k.map(function (c) { return +c[4]; }),
          volumes: k.map(function (c) { return +c[7]; }),
          times: k.map(function (c) { return c[0]; }),
        };
      }).catch(function () { return coingeckoChart(coinId, days); });
    }
    return coingeckoChart(coinId, days);
  }

  function coingeckoChart(coinId, days) {
    var url = cfg.api.coingecko + "/coins/" + coinId + "/market_chart?vs_currency=usd&days=" + days;
    return U.fetchJSON(url, 15000).then(function (d) {
      return {
        live: true,
        closes: d.prices.map(function (p) { return p[1]; }),
        volumes: (d.total_volumes || []).map(function (v) { return v[1]; }),
        times: d.prices.map(function (p) { return p[0]; }),
      };
    }).catch(function () { return synthChart(coinId, days); });
  }

  // Deterministic synthetic series for offline/demo fallback.
  function synthChart(coinId, days) {
    var base = coinId === "ethereum" ? 3000 : 60000;
    var closes = [], vols = [], times = [];
    var price = base * 0.7;
    var seed = coinId === "ethereum" ? 7 : 3;
    var now = Date.now();
    for (var i = days; i >= 0; i--) {
      seed = (seed * 9301 + 49297) % 233280;
      var rnd = seed / 233280 - 0.48;
      price = Math.max(base * 0.4, price * (1 + rnd * 0.04 + 0.0008));
      closes.push(price);
      vols.push(base * 5e5 * (0.6 + (seed / 233280)));
      times.push(now - i * 86400000);
    }
    return { live: false, closes: closes, volumes: vols, times: times };
  }

  // ---- Live: news headlines (backend → CryptoCompare → sample) ----
  function getNews() {
    return tryBackend("/api/news").then(function (d) {
      if (!d || !d.items || !d.items.length) throw new Error("empty");
      return { live: true, items: d.items, enriched: !!d.enriched };
    }).catch(function () {
      return U.fetchJSON(cfg.api.news).then(function (d) {
        var items = (d.Data || []).slice(0, 18).map(function (n) {
          return { title: n.title, url: n.url, source: n.source_info ? n.source_info.name : n.source,
            ts: n.published_on * 1000, categories: n.categories };
        });
        return { live: true, items: items };
      });
    }).catch(function () {
      return { live: false, items: sampleNews() };
    });
  }

  function sampleNews() {
    var now = Date.now();
    return [
      { title: "Spot Bitcoin ETF inflows hit a new record as institutions pile in", url: "#", source: "Sample", ts: now - 12 * 60000, categories: "BTC|ETF" },
      { title: "Ethereum network upgrade boosts staking rewards and adoption", url: "#", source: "Sample", ts: now - 48 * 60000, categories: "ETH" },
      { title: "Major exchange reports security breach, withdrawals paused", url: "#", source: "Sample", ts: now - 90 * 60000, categories: "Exchange|Hack" },
      { title: "Fed signals potential rate cut, risk assets rally", url: "#", source: "Sample", ts: now - 140 * 60000, categories: "Regulation|Market" },
      { title: "Analysts warn of short-term correction after parabolic rally", url: "#", source: "Sample", ts: now - 200 * 60000, categories: "Market" },
      { title: "Whales accumulate as BTC leaves exchanges at record pace", url: "#", source: "Sample", ts: now - 260 * 60000, categories: "BTC|Whale" },
    ];
  }

  // ---- Macro extras (backend only): economic calendar w/ forecast+actual,
  //      FRED trend, optional LLM macro read. Null when there's no backend
  //      (GitHub Pages / file://) — the app then uses the browser-only macro. ----
  function getMacro() {
    return tryBackend("/api/macro", 12000).then(function (d) {
      if (!d) return null;
      var has = (d.calendar && d.calendar.length) || d.fred || d.llm;
      return has ? d : null;
    }).catch(function () { return null; });
  }

  // ---- Whale transfers (backend Whale Alert if keyed, else sample) ----
  function getWhales(btcPrice) {
    return tryBackend("/api/whales").then(function (d) {
      if (!d || !d.items) throw new Error("empty");
      return { live: true, items: d.items, netToColdStorage: d.netToColdStorage };
    }).catch(function () {
      return sampleWhales(btcPrice);
    });
  }

  // Deterministic sample whale feed (no key required).
  function sampleWhales(btcPrice) {
    var seed = Math.floor(Date.now() / 3600000); // changes hourly
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var dirs = ["exchange_outflow", "exchange_inflow", "wallet_to_wallet"];
    var items = [];
    for (var i = 0; i < 6; i++) {
      var amtBtc = Math.round((200 + rnd() * 2500));
      var dir = dirs[Math.floor(rnd() * dirs.length)];
      items.push({
        amountBtc: amtBtc,
        usd: amtBtc * (btcPrice || 64000),
        dir: dir,
        from: dir === "exchange_outflow" ? "Binance" : (dir === "exchange_inflow" ? "Unknown wallet" : "Wallet A"),
        to: dir === "exchange_outflow" ? "Unknown wallet" : (dir === "exchange_inflow" ? "Coinbase" : "Wallet B"),
        minsAgo: Math.floor(rnd() * 180),
      });
    }
    items.sort(function (a, b) { return a.minsAgo - b.minsAgo; });
    var net = items.reduce(function (s, x) {
      return s + (x.dir === "exchange_outflow" ? x.amountBtc : x.dir === "exchange_inflow" ? -x.amountBtc : 0);
    }, 0);
    return { live: false, items: items, netToColdStorage: net };
  }

  return {
    getSimple: getSimple, getGlobal: getGlobal, getFearGreed: getFearGreed,
    getMarketChart: getMarketChart, getNews: getNews, getWhales: getWhales, getMacro: getMacro,
    getBinancePrices: getBinancePrices, getBinance24hAll: getBinance24hAll, binanceSymbol: binanceSymbol,
  };
})();
