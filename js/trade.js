/* Actionable trade engine:
 *   - buildPlan(): turns indicators into BUY / SELL / WAIT with entry, stop,
 *     take-profit ladder, risk:reward and confidence ("when to enter").
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
  function buildPlan(tech, closes) {
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

    // Directional bias from trend + momentum alignment.
    var bullPts = (aboveLong ? 1 : 0) + (aboveShort ? 1 : 0) + (rsi > 50 ? 1 : 0) + (macdBull ? 1 : 0);
    var bias = bullPts >= 3 ? "bullish" : bullPts <= 1 ? "bearish" : "mixed";

    var notes = [];
    var action, side, entry = price, stop, targets, rr;

    if (bias === "bullish" && rsi < 72) {
      action = "BUY"; side = "long";
      stop = Math.min(price - 1.5 * atr, support * 0.999);
      var risk = entry - stop;
      targets = [entry + risk * 1.5, entry + risk * 3, Math.max(entry + risk * 5, resistance)];
      rr = (targets[0] - entry) / risk;
      notes.push("Trend up & momentum positive — buy dips toward entry, invalidate below stop.");
      if (price < tech.sma50) notes.push("Price under 50-day MA: wait for reclaim for a stronger entry.");
    } else if (bias === "bearish" && rsi > 28) {
      action = "SELL"; side = "short";
      stop = Math.max(price + 1.5 * atr, resistance * 1.001);
      var riskS = stop - entry;
      targets = [entry - riskS * 1.5, entry - riskS * 3, Math.min(entry - riskS * 5, support)];
      rr = (entry - targets[0]) / riskS;
      notes.push("Trend down & momentum negative — sell rallies toward entry, invalidate above stop.");
    } else {
      action = "WAIT"; side = "flat";
      stop = null; targets = null; rr = null;
      if (rsi >= 72) notes.push("RSI overbought (" + rsi.toFixed(0) + ") — risk of pullback, wait for cooldown.");
      else if (rsi <= 28) notes.push("RSI oversold (" + rsi.toFixed(0) + ") — possible bounce, wait for confirmation.");
      else notes.push("Signals are mixed — no clean edge. Wait for trend + momentum to align.");
    }

    var confidence = Math.round((Math.abs(bullPts - 2) / 2) * 100); // 0 at mixed, 100 at full alignment
    if (action === "WAIT") confidence = Math.min(confidence, 45);

    return {
      action: action, side: side, bias: bias, entry: entry, stop: stop, targets: targets,
      support: support, resistance: resistance, rr: rr, atr: atr, volPct: volPct,
      rsi: rsi, confidence: confidence, notes: notes,
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
