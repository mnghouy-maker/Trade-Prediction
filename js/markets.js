/* Coin universe + per-coin quick signal for the screener.
 * Uses CoinGecko /coins/markets (price, 24h/7d change, sparkline) — all live in
 * the browser. A lightweight score is derived from the 7-day hourly sparkline so
 * the whole table can be ranked bull/bear without a full per-coin fetch. */
CP.markets = (function () {
  var cfg = CP.config;
  var U = CP.util;

  // Fetch one page from CoinGecko. Retries once after 10s on rate-limit (429).
  function fetchPage(page, perPage) {
    var url = cfg.api.coingecko + "/coins/markets?vs_currency=usd&order=market_cap_desc" +
      "&per_page=" + perPage + "&page=" + page + "&sparkline=true&price_change_percentage=1h,24h,7d";
    return U.fetchJSON(url, 25000).then(function (data) {
      if (!Array.isArray(data)) throw new Error("non-array response");
      return data;
    }).catch(function (e) {
      var msg = String(e);
      if (msg.indexOf("429") !== -1) {
        return new Promise(function (res) { setTimeout(res, 10000); })
          .then(function () { return U.fetchJSON(url, 25000); })
          .then(function (data) {
            if (!Array.isArray(data)) throw new Error("non-array on retry");
            return data;
          });
      }
      throw e;
    });
  }

  function getMarkets(count) {
    count = count || 100;

    var pages = [];
    if (count <= 100) {
      pages = [{ page: 1, per: 100 }];
    } else if (count <= 200) {
      pages = [{ page: 1, per: 100 }, { page: 2, per: count - 100 }];
    } else {
      pages = [{ page: 1, per: 100 }, { page: 2, per: 100 }, { page: 3, per: count - 200 }];
    }

    function fetchSequential(pageList, accumulated) {
      if (!pageList.length) return Promise.resolve(accumulated);
      var p = pageList[0];
      var rest = pageList.slice(1);
      var isFirst = accumulated.length === 0;
      return fetchPage(p.page, p.per).then(function (arr) {
        var merged = accumulated.concat(arr);
        if (!rest.length) return merged;
        return new Promise(function (res) { setTimeout(res, 1500); })
          .then(function () { return fetchSequential(rest, merged); });
      }).catch(function (e) {
        if (isFirst) throw e;
        return accumulated;
      });
    }

    return fetchSequential(pages, []).then(function (arr) {
      if (!arr || !arr.length) throw new Error("empty");
      var coins = arr.map(function (c) {
        var spark = (c.sparkline_in_7d && c.sparkline_in_7d.price) || [];
        var sig = quickSignal(spark, c.price_change_percentage_24h);
        return {
          id: c.id, symbol: (c.symbol || "").toUpperCase(), name: c.name, image: c.image,
          price: c.current_price, change1h: c.price_change_percentage_1h_in_currency,
          change24h: c.price_change_percentage_24h, change7d: c.price_change_percentage_7d_in_currency,
          marketCap: c.market_cap, volume: c.total_volume, rank: c.market_cap_rank,
          spark: spark, score: sig.score, signal: sig.label, rsi: sig.rsi,
        };
      });
      return CP.api.getBinance24hAll().then(function (bmap) {
        if (bmap) {
          coins.forEach(function (c) {
            var b = bmap[c.symbol];
            if (b) { c.price = b.price; c.change24h = b.change24h; c.volume = b.volume; }
          });
        }
        return { live: true, coins: coins };
      }).catch(function () {
        return { live: true, coins: coins };
      });
    }).catch(function (e) {
      console.warn("[markets] CoinGecko failed, using sample data:", e);
      return { live: false, coins: sampleMarkets() };
    });
  }

  function quickSignal(spark, change24h) {
    if (!spark || spark.length < 20) {
      var s = 50 + U.clamp((change24h || 0) * 2, -40, 40);
      return { score: Math.round(s), label: lbl(s), rsi: null };
    }
    var rsi = CP.indicators.rsi(spark, 14) || 50;
    var last = spark[spark.length - 1];
    var maShort = avg(spark.slice(-12));
    var maLong = avg(spark.slice(-48));
    var trend = maLong ? (maShort - maLong) / maLong : 0;
    var pos = (last - Math.min.apply(null, spark)) /
              (Math.max.apply(null, spark) - Math.min.apply(null, spark) + 1e-9);
    var score = 0.45 * rsi + 0.30 * U.clamp(50 + trend * 1500, 0, 100) + 0.25 * (pos * 100);
    score = U.clamp(score, 0, 100);
    return { score: Math.round(score), label: lbl(score), rsi: rsi };
  }

  function lbl(s) { return s >= 60 ? "Bullish" : s <= 40 ? "Bearish" : "Neutral"; }
  function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }

  function sampleMarkets() {
    var base = [
      ["bitcoin",       "BTC",  "Bitcoin",         64250,   1.8,   6.2],
      ["ethereum",      "ETH",  "Ethereum",          3380,   2.4,   8.1],
      ["tether",        "USDT", "Tether",               1,   0.0,   0.0],
      ["binancecoin",   "BNB",  "BNB",                585,   0.9,   3.2],
      ["solana",        "SOL",  "Solana",             148,   4.1,  12.5],
      ["ripple",        "XRP",  "XRP",               0.52,  -1.2,  -4.0],
      ["usd-coin",      "USDC", "USD Coin",             1,   0.0,   0.0],
      ["cardano",       "ADA",  "Cardano",           0.45,   2.0,   5.5],
      ["dogecoin",      "DOGE", "Dogecoin",          0.16,   3.3,   9.0],
      ["tron",          "TRX",  "TRON",              0.12,   1.5,   4.2],
      ["avalanche-2",   "AVAX", "Avalanche",           36,  -0.8,   2.1],
      ["chainlink",     "LINK", "Chainlink",          17.5,  1.1,   4.4],
      ["polkadot",      "DOT",  "Polkadot",           7.2,  -2.0,  -3.1],
      ["shiba-inu",     "SHIB", "Shiba Inu",       0.000022, 2.5,  7.3],
      ["litecoin",      "LTC",  "Litecoin",           88,   0.6,   1.9],
      ["uniswap",       "UNI",  "Uniswap",            9.8,  1.3,   3.7],
      ["bitcoin-cash",  "BCH",  "Bitcoin Cash",       470,  -0.5,   1.2],
      ["stellar",       "XLM",  "Stellar",           0.13,   0.9,   2.8],
      ["aptos",         "APT",  "Aptos",              11,    2.7,   8.0],
      ["near",          "NEAR", "NEAR Protocol",      6.4,   3.1,   9.5],
      ["internet-computer", "ICP", "Internet Computer", 12, -1.1,  -2.5],
      ["ethereum-classic", "ETC", "Ethereum Classic", 28,   0.4,   1.0],
      ["hedera-hashgraph", "HBAR","Hedera",          0.11,   1.8,   5.1],
      ["cosmos",        "ATOM", "Cosmos",             9.1,  -0.7,  -1.8],
      ["vechain",       "VET",  "VeChain",           0.037,  1.2,   3.3],
      ["filecoin",      "FIL",  "Filecoin",           5.8,  -1.5,  -3.2],
      ["aave",          "AAVE", "Aave",               108,   2.0,   6.1],
      ["maker",         "MKR",  "Maker",             2100,  -0.3,   0.8],
      ["the-graph",     "GRT",  "The Graph",         0.22,   1.6,   4.7],
      ["enjincoin",     "ENJ",  "Enjin Coin",        0.35,   0.8,   2.2],
    ];
    return base.map(function (b, i) {
      var sc = U.clamp(50 + b[4] * 4, 5, 95);
      return {
        id: b[0], symbol: b[1], name: b[2], image: "", price: b[3],
        change1h: b[4] / 3, change24h: b[4], change7d: b[5],
        marketCap: Math.max(1, 30 - i) * 1e10, volume: Math.max(1, 30 - i) * 1e9,
        rank: i + 1, spark: [], score: Math.round(sc), signal: lbl(sc), rsi: sc,
      };
    });
  }

  return { getMarkets: getMarkets, quickSignal: quickSignal };
})();
