/* Macro / news signal engine.
 * Reads the classified news feed + Fear & Greed + the economic calendar and
 * turns global, market-moving events into a directional crypto bias
 * (Long / Short / Neutral) with human-readable reasons and source links.
 *
 * The rule set follows the trader cheat-sheet:
 *   lower inflation / rate cuts / more liquidity / dovish Fed / ETF approvals
 *     = bullish for crypto
 *   higher inflation / rate hikes / less liquidity / hawkish Fed / crackdowns /
 *   war escalation / financial stress = bearish for crypto
 * International events (China/ECB/BoJ stimulus, geopolitics, sovereign BTC buys)
 * feed in too.
 *
 * Browser-only honesty note: with no forecast feed we read the DIRECTION a
 * headline reports (e.g. "CPI cools", "Fed hikes"), not the surprise vs the
 * consensus. The "higher/lower than expected" logic arrives with the backend. */
CP.macro = (function () {

  // Each rule: a topic (`any`) plus the words that make it bullish or bearish
  // for crypto. Ordered most-impactful first; one topic is counted per headline.
  var RULES = [
    {
      name: "Inflation (CPI/PCE)", weight: 3,
      any: ["cpi", "inflation", "core pce", "pce", "price index", "cost of living", "disinflation"],
      bull: ["cool", "cools", "cooler", "cooled", "fall", "falls", "fell", "lower", "below", "soft", "softer", "ease", "eases", "easing", "slow", "slows", "slowed", "decline", "declines", "drop", "drops", "miss", "misses", "downside", "disinflation"],
      bear: ["hot", "hotter", "rise", "rises", "rose", "higher", "above", "surge", "surges", "surged", "accelerate", "accelerates", "jump", "jumps", "beat", "beats", "upside", "sticky", "reaccelerat"],
    },
    {
      name: "Fed / interest rates", weight: 3,
      any: ["fomc", "interest rate", "rate cut", "rate hike", "rate decision", "rate path", "rate hold", "powell", "monetary policy", "central bank", "the fed ", "fed ", "fed's", "rate-cut", "rate-hike"],
      bull: ["cut", "cuts", "cutting", "dovish", "pause", "pauses", "paused", "hold", "ease", "eases", "easing", "pivot", "lower", "stimulus"],
      bear: ["hike", "hikes", "hiking", "hiked", "hawkish", "higher for longer", "raise", "raises", "tighten", "tightening", "restrictive"],
    },
    {
      name: "Jobs / NFP", weight: 2,
      any: ["nonfarm", "non-farm", "nfp", "payroll", "payrolls", "jobless", "unemployment", "jobs report", "labor market", "labour market", "initial claims"],
      // Weak jobs -> more easing odds -> bullish for crypto; strong jobs -> bearish.
      bull: ["weak", "weaker", "miss", "misses", "missed", "below", "cool", "cools", "cooling", "slowdown", "slows", "fewer", "rise", "rises", "rose", "disappoint", "soft", "softer"],
      bear: ["strong", "stronger", "beat", "beats", "above", "robust", "hot", "blowout", "solid", "surprise", "tight", "tighter"],
    },
    {
      name: "Growth / recession", weight: 1.5,
      any: ["gdp", "growth", "recession", "economic", "economy"],
      bull: ["rebound", "expansion", "expands", "beats", "strong", "stimulus", "soft landing"],
      bear: ["recession", "contraction", "contracts", "shrinks", "slowdown", "downgrade", "stagnation", "hard landing", "crisis"],
    },
    {
      name: "ETF / adoption", weight: 2.5,
      any: ["etf", "spot bitcoin", "spot ether", "spot ethereum", "adoption", "blackrock", "fidelity", "custody", "institutional", "mainstream", "treasury"],
      bull: ["approve", "approves", "approved", "approval", "inflow", "inflows", "launch", "launches", "adopt", "adoption", "green light", "greenlight", "record", "buy", "buys", "adds", "accumulate", "accumulates", "allocation"],
      bear: ["reject", "rejected", "rejection", "outflow", "outflows", "delay", "delays", "delayed", "denied", "sell", "sells", "dumps"],
    },
    {
      name: "Regulation", weight: 2.5,
      any: ["sec", "regulat", "lawsuit", "sue", "sues", "sued", "ban", "banned", "crackdown", "charges", "subpoena", "doj", "cftc", "compliance", "illegal", "court", "ruling"],
      bull: ["clarity", "approve", "approves", "approval", "win", "wins", "won", "victory", "dismiss", "dismissed", "settle", "settlement", "legalize", "legalise", "favorable", "favourable", "cleared", "legal"],
      bear: ["crackdown", "ban", "banned", "sue", "sues", "sued", "lawsuit", "charges", "fraud", "illegal", "restrict", "restricts", "enforcement", "subpoena", "fine", "fined", "penalty", "halt"],
    },
    {
      name: "Liquidity", weight: 2,
      any: ["liquidity", "stimulus", "quantitative", "money supply", "balance sheet", "repo ", "injection", "qe", "qt"],
      bull: ["injection", "inject", "stimulus", "boost", "expand", "expands", "easing", "qe", "add", "adds", "surge"],
      bear: ["drain", "drains", "tightening", "qt", "shrink", "shrinks", "withdraw", "contract", "contracts"],
    },
    {
      name: "Geopolitics", weight: 2,
      any: ["war", "invasion", "conflict", "missile", "strike", "attack", "military", "sanction", "sanctions", "geopolitical", "tension", "nuclear", "ceasefire"],
      bull: ["ceasefire", "peace", "de-escalation", "deescalation", "truce", "resolution", "ends", "ended"],
      bear: ["war", "invasion", "invades", "conflict", "missile", "strike", "strikes", "attack", "attacks", "escalat", "sanction", "sanctions", "nuclear", "threat"],
    },
    {
      name: "Banking / financial stress", weight: 2,
      any: ["bank ", "banking", "credit", "default", "contagion", "bailout", "financial crisis", "lender"],
      bull: ["bailout", "rescue", "backstop", "stabilize", "stabilise", "stabilizes", "support"],
      bear: ["bank run", "bank failure", "fails", "collapse", "collapses", "insolvent", "insolvency", "default", "defaults", "contagion", "crisis", "downgrade", "frozen", "freeze"],
    },
    {
      name: "China / global central banks", weight: 1.5,
      any: ["china", "pboc", "ecb", "boj", "bank of japan", "eurozone", "europe", "beijing"],
      bull: ["stimulus", "cut", "cuts", "easing", "injection", "boost", "support", "spending"],
      bear: ["hike", "hikes", "tightening", "crackdown", "ban", "slowdown", "crisis", "property crisis"],
    },
  ];

  function hasAny(text, words) {
    for (var i = 0; i < words.length; i++) {
      if (text.indexOf(words[i]) !== -1) return true;
    }
    return false;
  }

  // Classify a single (already sentiment-enriched) headline into at most one
  // macro driver. `item` carries .title/.url/.source plus .score from
  // CP.sentiment.classify(). Returns null if no macro topic applies.
  function driverFor(item) {
    var t = (item.title || "").toLowerCase();
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (!hasAny(t, r.any)) continue;
      var dir = 0;
      if (hasAny(t, r.bull)) dir += 1;
      if (hasAny(t, r.bear)) dir -= 1;
      // Topic matched but no polarity word — lean on the headline's own
      // bullish/bearish wording (from CP.sentiment.classify).
      if (dir === 0) dir = item.score > 0 ? 1 : item.score < 0 ? -1 : 0;
      if (dir === 0) continue;
      return {
        category: r.name, dir: dir, weight: r.weight,
        title: item.title, url: item.url, source: item.source, ts: item.ts,
      };
    }
    return null;
  }

  // sentiment: output of CP.sentiment.analyze (has .items enriched, .fearLevel)
  // fearGreed: { value, label, prev }
  // events:   computed economic-calendar events ({ name, impact, countdown, sortT })
  // extra:    optional backend payload from /api/macro
  //           ({ calendar:[{name,impact,dateMs,forecast,actual,dir}], fred, llm })
  function evaluate(sentiment, fearGreed, events, extra) {
    var drivers = [];
    var items = (sentiment && sentiment.items) || [];
    items.forEach(function (n) {
      var d = driverFor(n);
      if (d) drivers.push(d);
    });

    // Fear & Greed as a momentum driver (consistent with the rest of the app).
    if (fearGreed && typeof fearGreed.value === "number") {
      if (fearGreed.value >= 60) {
        drivers.push({ category: "Fear & Greed", dir: 1, weight: 1.2,
          title: "Fear & Greed at " + fearGreed.value + " (" + (fearGreed.label || "Greed") + ")",
          url: null, source: "Alternative.me" });
      } else if (fearGreed.value <= 40) {
        drivers.push({ category: "Fear & Greed", dir: -1, weight: 1.2,
          title: "Fear & Greed at " + fearGreed.value + " (" + (fearGreed.label || "Fear") + ")",
          url: null, source: "Alternative.me" });
      }
    }

    // Panic level from the fear detector — strong near-term bearish pressure.
    if (sentiment && sentiment.fearLevel >= 40) {
      var fh = (sentiment.fearHeadlines && sentiment.fearHeadlines[0]) || "panic-inducing headlines detected";
      drivers.push({ category: "Market fear", dir: -1, weight: 2.5,
        title: "Elevated market fear (" + sentiment.fearLevel + "/100): " + fh,
        url: null, source: "News scan" });
    }

    // ---- Backend extras (only present when /api/macro is reachable) ----
    var llmSummary = null;
    if (extra) {
      // Economic-calendar surprises (actual vs forecast) — the strongest,
      // most objective drivers right after a release prints.
      (extra.calendar || []).forEach(function (c) {
        if (c.actual && c.dir) {
          drivers.push({ category: "Data surprise", dir: c.dir, weight: 3.5,
            title: c.name + ": " + c.actual + " vs " + (c.forecast || "?") + " expected",
            url: null, source: "Economic calendar", surprise: true });
        }
      });
      // Real macro trend from the Fed (FRED).
      if (extra.fred) {
        var f = extra.fred;
        if (f.cpiYoY) {
          var dc = f.cpiYoY.trend === "falling" ? 1 : f.cpiYoY.trend === "rising" ? -1 : 0;
          if (dc) drivers.push({ category: "Inflation trend", dir: dc, weight: 2,
            title: "CPI " + f.cpiYoY.latest + "% YoY and " + f.cpiYoY.trend, url: null, source: "FRED" });
        }
        if (f.rate) {
          var dr = f.rate.trend === "falling" ? 1 : f.rate.trend === "rising" ? -1 : 0;
          if (dr) drivers.push({ category: "Fed funds rate", dir: dr, weight: 2,
            title: "Fed funds " + f.rate.latest + "% and " + f.rate.trend, url: null, source: "FRED" });
        }
        if (f.unemployment) {
          var du = f.unemployment.trend === "rising" ? 1 : f.unemployment.trend === "falling" ? -1 : 0;
          if (du) drivers.push({ category: "Labor market", dir: du, weight: 1.5,
            title: "Unemployment " + f.unemployment.latest + "% and " + f.unemployment.trend, url: null, source: "FRED" });
        }
      }
      if (extra.llm && extra.llm.summary) llmSummary = extra.llm.summary;
    }

    var score = drivers.reduce(function (a, d) { return a + d.dir * d.weight; }, 0);
    var totalW = drivers.reduce(function (a, d) { return a + d.weight; }, 0) || 1;
    var agreement = Math.abs(score) / totalW; // 0..1, how lopsided the picture is

    var bias = score > 1 ? "Long" : score < -1 ? "Short" : "Neutral";

    // Confidence: strong + lopsided macro picture scores high; thin news low.
    var confidence = Math.round(agreement * 100);
    if (drivers.length < 2) confidence = Math.min(confidence, 45);
    if (bias === "Neutral") confidence = Math.min(confidence, 50);
    confidence = Math.max(10, Math.min(95, confidence));

    // Strongest drivers first for display.
    var ranked = drivers.slice().sort(function (a, b) {
      return Math.abs(b.dir * b.weight) - Math.abs(a.dir * a.weight);
    });

    // Upcoming high-impact events as a heads-up (outcome unknown -> no direction).
    var cautions = [];
    var soon = 3 * 86400000;
    // Prefer backend calendar (it has forecasts) for the upcoming heads-up.
    if (extra && extra.calendar) {
      extra.calendar.forEach(function (c) {
        if (!c.actual && c.impact === "High" && c.dateMs && c.dateMs > Date.now() &&
            (c.dateMs - Date.now()) <= soon && cautions.length < 3) {
          cautions.push(c.name + (c.forecast ? " (forecast " + c.forecast + ")" : ""));
        }
      });
    }
    (events || []).forEach(function (e) {
      if (e.impact === "High" && e.sortT && (e.sortT - Date.now()) <= soon && cautions.length < 3) {
        cautions.push(e.name + " in " + e.countdown);
      }
    });

    return {
      bias: bias, score: score, confidence: confidence,
      drivers: ranked, topDrivers: ranked.slice(0, 6),
      bullCount: drivers.filter(function (d) { return d.dir > 0; }).length,
      bearCount: drivers.filter(function (d) { return d.dir < 0; }).length,
      newsCount: items.length, cautions: cautions,
      llmSummary: llmSummary, backed: !!extra,
    };
  }

  return { evaluate: evaluate, driverFor: driverFor };
})();
