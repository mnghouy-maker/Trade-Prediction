/* Coin universe + per-coin quick signal for the screener.
 * Uses CoinGecko /coins/markets (price, 24h/7d change, sparkline) — all live in
 * the browser. A lightweight score is derived from the 7-day hourly sparkline so
 * the whole table can be ranked bull/bear without a full per-coin fetch. */
CP.markets = (function () {
  var cfg = CP.config;
  var U = CP.util;

  function getMarkets(count) {
    count = count || 100;
    var per = Math.min(250, count);
    var url = cfg.api.coingecko + "/coins/markets?vs_currency=usd&order=market_cap_desc" +
      "&per_page=" + per + "&page=1&sparkline=true&price_change_percentage=1h,24h,7d";
    return U.fetchJSON(url, 15000).then(function (arr) {
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
      return { live: true, coins: coins };
    }).catch(function () {
      return { live: false, coins: sampleMarkets() };
    });
  }

  // Score 0..100 from the 7d hourly sparkline: blend RSI, short vs long trend, momentum.
  function quickSignal(spark, change24h) {
    if (!spark || spark.length < 20) {
      var s = 50 + U.clamp((change24h || 0) * 2, -40, 40);
      return { score: Math.round(s), label: lbl(s), rsi: null };
    }
    var rsi = CP.indicators.rsi(spark, 14) || 50;
    var last = spark[spark.length - 1];
    var maShort = avg(spark.slice(-12));   // ~12h
    var maLong = avg(spark.slice(-48));    // ~48h
    var trend = maLong ? (maShort - maLong) / maLong : 0;          // recent slope
    var pos = (last - Math.min.apply(null, spark)) /
              (Math.max.apply(null, spark) - Math.min.apply(null, spark) + 1e-9); // 0..1 in range
    var score = 0.45 * rsi + 0.30 * U.clamp(50 + trend * 1500, 0, 100) + 0.25 * (pos * 100);
    score = U.clamp(score, 0, 100);
    return { score: Math.round(score), label: lbl(score), rsi: rsi };
  }

  function lbl(s) { return s >= 60 ? "Bullish" : s <= 40 ? "Bearish" : "Neutral"; }
  function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }

  function sampleMarkets() {
    var base = [
      ["bitcoin", "BTC", "Bitcoin", 64250, 1.8, 6.2], ["ethereum", "ETH", "Ethereum", 3380, 2.4, 8.1],
      ["solana", "SOL", "Solana", 148, 4.1, 12.5], ["binancecoin", "BNB", "BNB", 585, 0.9, 3.2],
      ["ripple", "XRP", "XRP", 0.52, -1.2, -4.0], ["cardano", "ADA", "Cardano", 0.45, 2.0, 5.5],
      ["dogecoin", "DOGE", "Dogecoin", 0.16, 3.3, 9.0], ["avalanche-2", "AVAX", "Avalanche", 36, -0.8, 2.1],
      ["chainlink", "LINK", "Chainlink", 17.5, 1.1, 4.4], ["polkadot", "DOT", "Polkadot", 7.2, -2.0, -3.1],
    ];
    return base.map(function (b, i) {
      var sc = U.clamp(50 + b[4] * 4, 5, 95);
      return { id: b[0], symbol: b[1], name: b[2], image: "", price: b[3], change1h: b[4] / 3,
        change24h: b[4], change7d: b[5], marketCap: (10 - i) * 1e10, volume: (10 - i) * 1e9,
        rank: i + 1, spark: [], score: Math.round(sc), signal: lbl(sc), rsi: sc };
    });
  }

  return { getMarkets: getMarkets, quickSignal: quickSignal };
})();
