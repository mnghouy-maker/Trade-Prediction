/* Actionable trade engine:
 *   - buildPlan(): combines the global macro/news read with the technical trend
 *     into a directional call (always LONG or SHORT) with entry, stop, a
 *     take-profit ladder, risk:reward, confidence and linked reasons.
 *   - calcPnl(): Binance-style futures PnL / ROE / liquidation math.
 */
CP.trade = (function () {
  var U = CP.util;

  function stdev(arr) {
    if (arr.length < 2) return 0;
    var m = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
    var v = arr.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (arr.length - 1);
    return Math.sqrt(v);
  }

  // closes: oldest→newest daily closes; tech: CP.indicators.compute(closes)
  // macro:  output of CP.macro.evaluate() (optional) — the global news/macro read.
  //
  // Always returns a directional call (LONG or SHORT, never WAIT): the macro/news
  // bias leads the direction, the technical trend confirms it, and the price
  // levels (entry/stop/targets) come from recent volatility + support/resistance.
  function buildPlan(tech, closes, macro) {
    var price = tech.price;
    var recent = closes.slice(-30);
    var support = Math.min.apply(null, recent);
    var resistance = Math.max.apply(null, recent);

    // Daily-return volatility → ATR-like absolute move.
    var rets = [];
    for (var i = closes.length - 14; i < closes.length; i++) {
      if (i > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    var volPct = stdev(rets);
    var atr = Math.max(price * volPct, price * 0.005);

    var rsi = tech.rsi == null ? 50 : tech.rsi;
    var macdBull = tech.macd ? tech.macd.bullish : price > (tech.sma50 || price);
    var aboveLong = tech.sma200 == null || price > tech.sma200;
    var aboveShort = tech.sma50 == null || price > tech.sma50;

    // Technical bias from trend + momentum (0..4 bullish points).
    var bullPts = (aboveLong ? 1 : 0) + (aboveShort ? 1 : 0) + (rsi > 50 ? 1 : 0) + (macdBull ? 1 : 0);
    var techDir = bullPts >= 3 ? 1 : bullPts <= 1 ? -1 : 0;

    // Macro/news bias leads; fall back to technicals, then momentum, so we
    // always commit to a side.
    var macroDir = macro && macro.bias === "Long" ? 1 : macro && macro.bias === "Short" ? -1 : 0;
    var sideSign;
    if (macroDir !== 0) sideSign = macroDir;
    else if (techDir !== 0) sideSign = techDir;
    else sideSign = (rsi >= 50 || aboveShort) ? 1 : -1;

    var side = sideSign > 0 ? "long" : "short";
    var action = sideSign > 0 ? "LONG" : "SHORT";

    var entry = price, stop, targets, rr;
    if (side === "long") {
      stop = Math.min(price - 1.5 * atr, support * 0.999);
      var risk = entry - stop;
      targets = [entry + risk * 1.5, entry + risk * 3, Math.max(entry + risk * 5, resistance)];
      rr = (targets[0] - entry) / risk;
    } else {
      stop = Math.max(price + 1.5 * atr, resistance * 1.001);
      var riskS = stop - entry;
      targets = [entry - riskS * 1.5, entry - riskS * 3, Math.min(entry - riskS * 5, support)];
      rr = (entry - targets[0]) / riskS;
    }

    // Confidence: agreement between macro and technicals, weighted by strength.
    var techAgree = techDir !== 0 && techDir * sideSign > 0;
    var techConflict = techDir !== 0 && techDir * sideSign < 0;
    var macroAgree = macroDir !== 0 && macroDir * sideSign > 0;
    var macroConf = macro ? macro.confidence : 0;
    var techStrength = Math.round((Math.abs(bullPts - 2) / 2) * 100); // 0 mixed → 100 aligned

    var confidence = 45;
    if (macroAgree) confidence += Math.round(macroConf * 0.35);
    else if (macroDir !== 0) confidence -= Math.round(macroConf * 0.25);
    if (techAgree) confidence += Math.round(techStrength * 0.22);
    else if (techConflict) confidence -= Math.round(techStrength * 0.18);
    confidence = Math.max(10, Math.min(96, confidence));

    // Reasons: macro/news drivers (with source links) first, then a technical summary.
    var reasons = [];
    if (macro && macro.topDrivers) {
      macro.topDrivers.forEach(function (d) {
        reasons.push({ dir: d.dir, category: d.category, text: d.title, url: d.url, source: d.source });
      });
    }
    var techBits = [
      (aboveLong ? "above" : "below") + " 200-day MA",
      (aboveShort ? "above" : "below") + " 50-day MA",
      "RSI " + rsi.toFixed(0),
      "MACD " + (macdBull ? "bullish" : "bearish"),
    ];
    reasons.push({ dir: techDir, category: "Technical trend", text: "Price " + techBits.join(", ") + ".", url: null, source: "Technicals" });

    var biasLabel = macro ? macro.bias : "Neutral";

    return {
      action: action, side: side, bias: biasLabel, entry: entry, stop: stop, targets: targets,
      support: support, resistance: resistance, rr: rr, atr: atr, volPct: volPct,
      rsi: rsi, confidence: confidence, reasons: reasons,
      macroBias: biasLabel, macroConfidence: macroConf, techDir: techDir, macroDir: macroDir,
      cautions: (macro && macro.cautions) || [],
      notes: reasons.map(function (r) { return r.text; }),
    };
  }

  // Binance-style isolated-margin futures calc.
  // direction: 'long'|'short'; feeRate as fraction per side (e.g. 0.0005).
  function calcPnl(direction, entry, exit, qty, leverage, feeRate) {
    leverage = Math.max(1, leverage || 1);
    feeRate = feeRate || 0;
    var notional = entry * qty;
    var margin = notional / leverage;
    var gross = (direction === "long" ? (exit - entry) : (entry - exit)) * qty;
    var fees = (entry * qty + exit * qty) * feeRate;
    var net = gross - fees;
    var roe = margin ? (net / margin) * 100 : 0;       // return on margin (Binance ROE%)
    var roiNotional = notional ? (net / notional) * 100 : 0;
    // Liquidation price estimate (isolated, excludes maintenance margin):
    var liq = direction === "long" ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);
    return {
      notional: notional, margin: margin, gross: gross, fees: fees, net: net,
      roe: roe, roiNotional: roiNotional, liq: liq,
    };
  }

  return { buildPlan: buildPlan, calcPnl: calcPnl };
})();
