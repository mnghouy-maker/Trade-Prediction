/* Backtesting engine. Replays the model over historical daily closes and measures
 * how often the bullish/bearish call matched the next day's move. */
CP.backtest = (function () {
  var I = CP.indicators;

  // Strategy: bullish when price > SMA200 and RSI(14) > 50.
  function run(closes) {
    var preds = [];
    var wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
    var bullCorrect = 0, bullTotal = 0, bearCorrect = 0, bearTotal = 0;

    for (var i = 200; i < closes.length - 1; i++) {
      var window = closes.slice(0, i + 1);
      var sma200 = I.sma(window, 200);
      var rsi = I.rsi(window.slice(-60), 14); // last 60 days is plenty for RSI
      if (sma200 == null || rsi == null) continue;

      var bullish = closes[i] > sma200 && rsi > 50;
      var nextRet = (closes[i + 1] - closes[i]) / closes[i];
      var correct = bullish ? nextRet > 0 : nextRet < 0;

      if (bullish) { bullTotal++; if (correct) bullCorrect++; }
      else { bearTotal++; if (correct) bearCorrect++; }

      // PnL: take a long when bullish, flat/short when bearish (educational).
      var pnl = bullish ? nextRet : -nextRet;
      if (pnl >= 0) { wins++; grossWin += pnl; } else { losses++; grossLoss += -pnl; }

      preds.push({ idx: i, dir: bullish ? "BULLISH" : "BEARISH", ret: +(nextRet * 100).toFixed(2), correct: correct });
    }

    var total = wins + losses;
    return {
      predictions: preds.length,
      winRate: total ? Math.round((wins / total) * 100) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? Infinity : 0,
      accuracy: preds.length ? Math.round(((bullCorrect + bearCorrect) / preds.length) * 100) : 0,
      bull: { correct: bullCorrect, total: bullTotal },
      bear: { correct: bearCorrect, total: bearTotal },
      recent: preds.slice(-12).reverse(),
    };
  }

  return { run: run };
})();
