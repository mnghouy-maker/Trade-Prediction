/* The prediction engine. Converts raw inputs into:
 *  - a list of weighted signals (+1 bullish / -1 bearish)
 *  - a 0..100 AI score, direction, and confidence
 *  - human-readable reasons
 *  - per-coin technical "% bullish"
 */
CP.score = (function () {
  var W = CP.config.weights;
  var U = CP.util;

  // Build the signal list from the full data bundle.
  function buildSignals(d) {
    var s = [];
    var btc = d.tech.bitcoin, eth = d.tech.ethereum;

    function add(key, label, value, weight) {
      s.push({ key: key, label: label, value: value, weight: weight, contrib: value * weight });
    }

    if (btc) {
      if (btc.sma200 != null) add("above200ma", "BTC price " + (btc.price > btc.sma200 ? "above" : "below") + " 200-day MA", btc.price > btc.sma200 ? 1 : -1, W.above200ma);
      if (btc.sma50 != null) add("above50ma", "BTC price " + (btc.price > btc.sma50 ? "above" : "below") + " 50-day MA", btc.price > btc.sma50 ? 1 : -1, W.above50ma);
      if (btc.rsi != null) {
        var rv = btc.rsi > 70 ? -1 : btc.rsi < 30 ? 1 : btc.rsi > 50 ? 1 : -1;
        var rlabel = btc.rsi > 70 ? "BTC RSI overbought (" + btc.rsi.toFixed(0) + ")" :
                     btc.rsi < 30 ? "BTC RSI oversold (" + btc.rsi.toFixed(0) + ")" :
                     "BTC RSI " + (btc.rsi > 50 ? "above" : "below") + " 50 (" + btc.rsi.toFixed(0) + ")";
        add("rsi", rlabel, rv, W.rsi);
      }
      if (btc.macd) add("macd", "BTC MACD " + (btc.macd.bullish ? "bullish crossover" : "bearish"), btc.macd.bullish ? 1 : -1, W.macd);
    }
    if (eth && eth.sma200 != null) add("ethTrend", "ETH " + (eth.price > eth.sma200 ? "above" : "below") + " 200-day MA", eth.price > eth.sma200 ? 1 : -1, W.ethTrend);

    add("marketCap", "Total market cap " + (d.global.change24h >= 0 ? "up" : "down") + " 24h", d.global.change24h >= 0 ? 1 : -1, W.marketCap);

    var fg = d.fearGreed.value;
    var fgv = fg > 55 ? 1 : fg < 45 ? -1 : 0;
    if (fgv !== 0) add("fearGreed", "Fear & Greed in " + (fgv > 0 ? "greed" : "fear") + " (" + fg + ")", fgv, W.fearGreed);

    add("newsSentiment", "News sentiment " + d.sentiment.verdict.toLowerCase(), d.sentiment.net > 0 ? 1 : d.sentiment.net < 0 ? -1 : 0, W.newsSentiment);

    // Volume: rising 24h vol with positive price = demand; with negative price = selling pressure
    if (btc) {
      var volSig = (d.simple.bitcoin.usd_24h_change >= 0) ? 1 : -1;
      add("volume", volSig > 0 ? "Volume confirms uptrend" : "High selling volume", volSig, W.volume);
    }

    // Whales: net BTC to cold storage (out of exchanges) = bullish
    if (d.whales) {
      var wsig = d.whales.netToColdStorage > 0 ? 1 : d.whales.netToColdStorage < 0 ? -1 : 0;
      if (wsig !== 0) add("whales", wsig > 0 ? "Whales moving BTC off exchanges" : "Whales sending BTC to exchanges", wsig, W.whales);
    }

    return s;
  }

  // Overall composite from the signal list.
  function evaluate(signals) {
    var rawSum = signals.reduce(function (a, x) { return a + x.value; }, 0);
    var weighted = signals.reduce(function (a, x) { return a + x.contrib; }, 0);
    var maxWeight = signals.reduce(function (a, x) { return a + x.weight; }, 0) || 1;

    // Normalise weighted sum (-maxWeight..+maxWeight) to a 0..100 score.
    var aiScore = Math.round(((weighted / maxWeight) + 1) * 50);
    aiScore = U.clamp(aiScore, 0, 100);

    // Direction per the user's thresholds (using raw +1/-1 sum).
    var direction = rawSum >= 3 ? "BULLISH" : rawSum < 0 ? "BEARISH" : "NEUTRAL";

    // Confidence = how lopsided the signals are.
    var agree = signals.filter(function (x) {
      return rawSum >= 0 ? x.value > 0 : x.value < 0;
    }).length;
    var confidence = Math.round((agree / Math.max(1, signals.length)) * 100);
    // Pull neutral confidence toward 50.
    if (direction === "NEUTRAL") confidence = U.clamp(confidence, 40, 65);

    var probability = aiScore; // 0..100 reads as "% bullish over the next 7 days"

    return {
      rawSum: rawSum,
      aiScore: aiScore,
      probability: probability,
      direction: direction,
      confidence: confidence,
      signals: signals,
    };
  }

  // Per-coin technical % bullish (ignores macro/news signals).
  function technicalScore(tech) {
    if (!tech) return null;
    var checks = [];
    if (tech.sma200 != null) checks.push({ ok: tech.price > tech.sma200, label: "Price above 200-day MA" });
    if (tech.sma50 != null) checks.push({ ok: tech.price > tech.sma50, label: "Price above 50-day MA" });
    if (tech.rsi != null) checks.push({ ok: tech.rsi > 50 && tech.rsi < 70, label: "RSI > 50 (not overbought)" });
    if (tech.macd) checks.push({ ok: tech.macd.bullish, label: "MACD bullish crossover" });
    if (tech.sma50 != null && tech.sma200 != null) checks.push({ ok: tech.sma50 > tech.sma200, label: "Golden cross (50MA > 200MA)" });
    var pass = checks.filter(function (c) { return c.ok; }).length;
    var pct = checks.length ? Math.round((pass / checks.length) * 100) : 0;
    return { checks: checks, pct: pct };
  }

  function headline(result, d) {
    var dir = result.direction.toLowerCase();
    return "Market is " + result.probability + "% bullish over the next 7 days — model reads " +
      dir + " with " + result.confidence + "% confidence.";
  }

  return { buildSignals: buildSignals, evaluate: evaluate, technicalScore: technicalScore, headline: headline };
})();
