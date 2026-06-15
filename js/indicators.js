/* Pure technical-indicator math: SMA, EMA, RSI, MACD.
 * Input `closes` is an oldest-to-newest array of closing prices. */
CP.indicators = (function () {
  function sma(values, period) {
    if (!values || values.length < period) return null;
    var sum = 0;
    for (var i = values.length - period; i < values.length; i++) sum += values[i];
    return sum / period;
  }

  function emaSeries(values, period) {
    if (!values || values.length < period) return [];
    var k = 2 / (period + 1);
    var out = [];
    // Seed with SMA of first `period` values
    var seed = 0;
    for (var i = 0; i < period; i++) seed += values[i];
    var prev = seed / period;
    out[period - 1] = prev;
    for (var j = period; j < values.length; j++) {
      prev = values[j] * k + prev * (1 - k);
      out[j] = prev;
    }
    return out;
  }

  // Wilder's RSI
  function rsi(values, period) {
    period = period || 14;
    if (!values || values.length < period + 1) return null;
    var gains = 0, losses = 0;
    for (var i = 1; i <= period; i++) {
      var ch = values[i] - values[i - 1];
      if (ch >= 0) gains += ch; else losses -= ch;
    }
    var avgGain = gains / period, avgLoss = losses / period;
    for (var j = period + 1; j < values.length; j++) {
      var d = values[j] - values[j - 1];
      var g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
    }
    if (avgLoss === 0) return 100;
    var rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  // MACD(12,26,9) -> { macd, signal, hist, bullish }
  function macd(values) {
    if (!values || values.length < 35) return null;
    var ema12 = emaSeries(values, 12);
    var ema26 = emaSeries(values, 26);
    var macdLine = [];
    for (var i = 0; i < values.length; i++) {
      if (ema12[i] != null && ema26[i] != null) macdLine.push(ema12[i] - ema26[i]);
    }
    var signalArr = emaSeries(macdLine, 9);
    var macdVal = macdLine[macdLine.length - 1];
    var signalVal = signalArr[signalArr.length - 1];
    if (macdVal == null || signalVal == null) return null;
    return { macd: macdVal, signal: signalVal, hist: macdVal - signalVal, bullish: macdVal > signalVal };
  }

  // Compute the full indicator set for a closes series.
  function compute(closes) {
    return {
      price: closes[closes.length - 1],
      sma50: sma(closes, 50),
      sma200: sma(closes, 200),
      rsi: rsi(closes, 14),
      macd: macd(closes),
    };
  }

  return { sma: sma, ema: emaSeries, rsi: rsi, macd: macd, compute: compute };
})();
