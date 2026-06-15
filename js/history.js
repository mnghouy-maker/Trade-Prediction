/* Prediction history. Records one prediction per day and later grades it against
 * the realised BTC move, so users can see real track record. localStorage-backed. */
CP.history = (function () {
  var KEY = CP.config.storage.history;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function save(rows) { localStorage.setItem(KEY, JSON.stringify(rows)); }

  function todayKey() { return new Date().toISOString().slice(0, 10); }

  // Record today's prediction (idempotent per day) and grade past unresolved ones.
  function record(direction, btcPrice) {
    var rows = load();
    var today = todayKey();

    // Grade older, ungraded predictions now that we know newer prices.
    rows.forEach(function (r) {
      if (r.result === "Pending" && r.date !== today && btcPrice) {
        var move = (btcPrice - r.btcPrice) / r.btcPrice;
        var actual = move > 0.005 ? "BULLISH" : move < -0.005 ? "BEARISH" : "NEUTRAL";
        if (r.direction === "NEUTRAL") r.result = Math.abs(move) < 0.01 ? "Correct" : "Wrong";
        else r.result = (r.direction === actual) ? "Correct" : "Wrong";
        r.move = +(move * 100).toFixed(2);
      }
    });

    var existing = rows.find(function (r) { return r.date === today; });
    if (existing) { existing.direction = direction; existing.btcPrice = btcPrice; }
    else rows.unshift({ date: today, direction: direction, btcPrice: btcPrice, result: "Pending", move: null });

    rows = rows.slice(0, 90);
    save(rows);
    return rows;
  }

  function all() { return load(); }

  function accuracy() {
    var rows = load().filter(function (r) { return r.result === "Correct" || r.result === "Wrong"; });
    if (!rows.length) return null;
    var correct = rows.filter(function (r) { return r.result === "Correct"; }).length;
    return { correct: correct, total: rows.length, pct: Math.round((correct / rows.length) * 100) };
  }

  return { record: record, all: all, accuracy: accuracy };
})();
