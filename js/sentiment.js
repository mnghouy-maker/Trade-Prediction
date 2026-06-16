/* Sentiment + fear classifier for news headlines.
 * Classifies each headline as Bullish / Bearish / Neutral and assigns a fear
 * score so that macro panic events (war, bans, exchange collapses, etc.) are
 * reflected in the overall bull/bear prediction even if technicals look fine. */
CP.sentiment = (function () {

  var BULL = [
    "surge", "rally", "soar", "gain", "record", "inflow", "adopt", "adoption",
    "approve", "approval", "bullish", "breakout", "all-time high", "ath",
    "accumulate", "rate cut", "cuts rates", "boost", "jump", "rise", "green light",
    "etf", "halving", "leaving exchanges", "outflow from exchange", "upgrade",
    "partnership", "institutional", "listing", "buy", "recovery", "rebound",
    "bottom", "support", "stimulus", "deregulation", "legal clarity", "settlement",
    "acquit", "cleared", "dismissed", "ceasefire", "peace deal", "easing",
  ];

  var BEAR = [
    "crash", "plunge", "dump", "hack", "hacked", "breach", "exploit",
    "lawsuit", "sue", "ban", "bearish", "selloff", "sell-off",
    "liquidation", "liquidated", "fraud", "scam", "drop", "fall", "falls",
    "decline", "warn", "warning", "fear", "correction", "default",
    "bankrupt", "bankruptcy", "investigation", "charges", "delist",
    "inflows to exchange", "rug", "collapse", "seized", "arrest", "arrested",
    "sanctioned", "sanctions", "restrict", "restriction", "frozen", "freeze",
    "insolvent", "insolvency", "contagion", "panic", "exodus",
  ];

  // Fear keywords — geopolitical, macro, and crypto-specific events that
  // historically cause market panic regardless of technical signals.
  var FEAR_HIGH = [
    // Exchange / protocol failures
    "exchange collapse", "exchange hack", "exchange bankrupt", "exchange insolvent",
    "withdrawal halt", "withdrawals suspended", "withdrawals paused",
    "rug pull", "exit scam", "exploit", "drained",
    // Regulatory crackdowns
    "sec charges", "sec sues", "trading ban", "crypto ban", "government ban",
    "seized assets", "asset freeze", "sanctions", "aml violation",
    // Macro fear
    "war declared", "military strike", "nuclear", "invasion",
    "emergency rate hike", "rate hike surprise", "fed hike",
    "recession confirmed", "market crash", "black swan",
    "bank run", "bank collapse", "bank failure", "bank seized",
    // Crypto-specific
    "51% attack", "network halt", "chain halt", "bridge hack",
    "stablecoin depeg", "depeg", "usdt", "usdc freeze",
    "liquidation cascade", "mass liquidation",
  ];

  var FEAR_MEDIUM = [
    "hack", "hacked", "breach", "bankrupt", "arrest", "arrested",
    "investigation", "fraud", "lawsuit", "ban", "warning", "panic",
    "collapse", "plunge", "crash", "seized", "frozen", "restrict",
    "default", "contagion", "correction", "sell-off", "selloff",
    "war", "conflict", "sanctions", "inflation surge", "cpi hot",
  ];

  var HIGH_IMPACT_KEYS = [
    "etf", "fed", "sec", "hack", "breach", "rate", "ban", "lawsuit",
    "record", "halving", "approval", "crash", "bankrupt", "war", "sanctions",
    "arrest", "seized", "collapse", "depeg", "nuclear", "invasion",
  ];

  function classify(title) {
    var t = (title || "").toLowerCase();
    var score = 0;
    var impact = "Low";
    var fearScore = 0;

    BULL.forEach(function (w) { if (t.indexOf(w) !== -1) score += 1; });
    BEAR.forEach(function (w) { if (t.indexOf(w) !== -1) score -= 1; });

    // Fear scoring — high phrases outrank individual words
    FEAR_HIGH.forEach(function (phrase) {
      if (t.indexOf(phrase) !== -1) { fearScore += 3; impact = "High"; }
    });
    FEAR_MEDIUM.forEach(function (word) {
      if (t.indexOf(word) !== -1) fearScore = Math.max(fearScore, 1);
    });

    for (var i = 0; i < HIGH_IMPACT_KEYS.length; i++) {
      if (t.indexOf(HIGH_IMPACT_KEYS[i]) !== -1) { impact = "High"; break; }
    }
    if (impact === "Low" && Math.abs(score) >= 1) impact = "Medium";

    var label = score > 0 ? "Bullish" : score < 0 ? "Bearish" : "Neutral";
    var isFear = fearScore >= 2;

    return { label: label, impact: impact, score: score, fearScore: fearScore, isFear: isFear };
  }

  function analyze(items) {
    var pos = 0, neg = 0, neu = 0, net = 0;
    var hasHighBear = false;
    var totalFear = 0;
    var fearHeadlines = [];

    var enriched = (items || []).map(function (n) {
      var c = classify(n.title);
      if (c.label === "Bullish") pos++;
      else if (c.label === "Bearish") neg++;
      else neu++;
      net += c.score;
      totalFear += c.fearScore;
      if (c.label === "Bearish" && c.impact === "High") hasHighBear = true;
      if (c.isFear) fearHeadlines.push(n.title);
      return Object.assign({}, n, c);
    });

    var total = Math.max(1, enriched.length);

    // Fear level: 0 (calm) → 100 (extreme panic)
    var fearLevel = Math.min(100, Math.round((totalFear / (total * 0.5)) * 100));

    // Verdict: fear headlines can push to Bearish even if net is slightly positive
    var verdict = net > 1 ? "Bullish" : net < -1 ? "Bearish" : "Neutral";
    if (fearLevel >= 40 && verdict !== "Bullish") verdict = "Bearish";

    return {
      items: enriched,
      counts: { pos: pos, neg: neg, neu: neu },
      pct: {
        pos: Math.round((pos / total) * 100),
        neg: Math.round((neg / total) * 100),
        neu: Math.round((neu / total) * 100),
      },
      net: net,
      verdict: verdict,
      fearLevel: fearLevel,
      fearHeadlines: fearHeadlines,
      hasHighImpactBearish: hasHighBear,
    };
  }

  // Trending coin/topic extraction from categories
  function trending(items) {
    var counts = {};
    var known = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "BNB", "ETF", "DEFI", "NFT", "FED", "SEC", "WAR", "MACRO"];
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
