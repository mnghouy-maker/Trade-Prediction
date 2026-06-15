/* Lightweight, transparent keyword sentiment classifier for news headlines.
 * (A production build would swap this for an LLM call on the backend — see README.)
 * Returns per-article {label, impact} and an aggregate breakdown. */
CP.sentiment = (function () {
  var BULL = ["surge", "rally", "soar", "gain", "record", "inflow", "inflows", "adopt", "adoption",
    "approve", "approval", "bullish", "breakout", "all-time high", "ath", "accumulate", "buy",
    "upgrade", "partnership", "institutional", "rate cut", "cuts rates", "boost", "jump", "rise",
    "soars", "wins", "green light", "etf", "halving", "outflow from exchange", "leaving exchanges"];
  var BEAR = ["crash", "plunge", "dump", "hack", "hacked", "breach", "exploit", "lawsuit", "sue",
    "ban", "bearish", "selloff", "sell-off", "liquidation", "liquidated", "fraud", "scam", "fud",
    "drop", "fall", "falls", "decline", "warn", "warning", "fear", "correction", "default",
    "bankrupt", "investigation", "charges", "delist", "outflow", "inflows to exchange", "rug"];
  var HIGH = ["etf", "fed", "sec", "hack", "breach", "rate", "ban", "lawsuit", "record", "halving",
    "approval", "crash", "bankrupt"];

  function classify(title) {
    var t = (title || "").toLowerCase();
    var score = 0, impact = "Low";
    BULL.forEach(function (w) { if (t.indexOf(w) !== -1) score += 1; });
    BEAR.forEach(function (w) { if (t.indexOf(w) !== -1) score -= 1; });
    for (var i = 0; i < HIGH.length; i++) { if (t.indexOf(HIGH[i]) !== -1) { impact = "High"; break; } }
    if (impact === "Low" && Math.abs(score) >= 1) impact = "Medium";
    var label = score > 0 ? "Bullish" : score < 0 ? "Bearish" : "Neutral";
    return { label: label, impact: impact, score: score };
  }

  function analyze(items) {
    var pos = 0, neg = 0, neu = 0, net = 0;
    var hasHighBear = false;
    var enriched = (items || []).map(function (n) {
      var c = classify(n.title);
      if (c.label === "Bullish") pos++;
      else if (c.label === "Bearish") neg++;
      else neu++;
      net += c.score;
      if (c.label === "Bearish" && c.impact === "High") hasHighBear = true;
      return Object.assign({}, n, c);
    });
    var total = Math.max(1, enriched.length);
    var verdict = net > 1 ? "Bullish" : net < -1 ? "Bearish" : "Neutral";
    return {
      items: enriched,
      counts: { pos: pos, neg: neg, neu: neu },
      pct: { pos: Math.round((pos / total) * 100), neg: Math.round((neg / total) * 100), neu: Math.round((neu / total) * 100) },
      net: net,
      verdict: verdict,
      hasHighImpactBearish: hasHighBear,
    };
  }

  // Derive "trending coins" from news categories (simple frequency count).
  function trending(items) {
    var counts = {};
    var known = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "BNB", "ETF", "DEFI", "NFT"];
    (items || []).forEach(function (n) {
      (n.categories || "").split("|").forEach(function (cat) {
        var c = cat.trim().toUpperCase();
        if (known.indexOf(c) !== -1) counts[c] = (counts[c] || 0) + 1;
      });
    });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 6);
  }

  return { classify: classify, analyze: analyze, trending: trending };
})();
