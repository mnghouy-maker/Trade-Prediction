/* Price / metric alerts with browser notifications, persisted in localStorage. */
CP.alerts = (function () {
  var U = CP.util;
  var KEY = CP.config.storage.alerts;
  var BKEY = CP.config.storage.bearishNews;
  var list = load();

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(list)); }

  function add(metric, op, value) {
    list.push({ id: Date.now(), metric: metric, op: op, value: +value, triggered: false });
    save();
  }
  function remove(id) { list = list.filter(function (a) { return a.id !== id; }); save(); }
  function all() { return list; }

  function metricLabel(m) {
    return { btc_price: "BTC price", eth_price: "ETH price", btc_rsi: "BTC RSI", fng: "Fear & Greed", score: "AI score" }[m] || m;
  }

  function currentValue(m, snapshot) {
    switch (m) {
      case "btc_price": return snapshot.simple.bitcoin.usd;
      case "eth_price": return snapshot.simple.ethereum.usd;
      case "btc_rsi": return snapshot.tech.bitcoin ? snapshot.tech.bitcoin.rsi : null;
      case "fng": return snapshot.fearGreed.value;
      case "score": return snapshot.result.aiScore;
    }
    return null;
  }

  // Evaluate all alerts against a fresh snapshot; fire notifications on new triggers.
  function evaluate(snapshot) {
    list.forEach(function (a) {
      var v = currentValue(a.metric, snapshot);
      if (v == null) return;
      var hit = a.op === "gt" ? v > a.value : v < a.value;
      if (hit && !a.triggered) {
        a.triggered = true;
        fire(metricLabel(a.metric) + " " + (a.op === "gt" ? ">" : "<") + " " + a.value,
          "Now: " + (a.metric.indexOf("price") !== -1 ? U.fmtUSD(v) : Math.round(v)), "bull");
      } else if (!hit && a.triggered) {
        a.triggered = false; // re-arm
      }
    });
    save();

    // Bearish-news alert
    if (getBearishNews() && snapshot.sentiment.hasHighImpactBearish) {
      if (!CP.alerts._bearFired) {
        CP.alerts._bearFired = true;
        fire("Major bearish news detected", "High-impact negative headline in the feed.", "bear");
      }
    } else {
      CP.alerts._bearFired = false;
    }
  }

  function fire(title, body, kind) {
    CP.render.toast(title + " — " + body, kind);
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification(title, { body: body }); } catch (e) {}
    }
  }

  function requestPermission() {
    if (!("Notification" in window)) { CP.render.toast("This browser does not support notifications.", "bear"); return; }
    Notification.requestPermission().then(function (p) {
      CP.render.toast(p === "granted" ? "Notifications enabled ✅" : "Notifications blocked.", p === "granted" ? "bull" : "bear");
    });
  }

  function getBearishNews() { return localStorage.getItem(BKEY) === "1"; }
  function setBearishNews(on) { localStorage.setItem(BKEY, on ? "1" : "0"); }

  return { add: add, remove: remove, all: all, evaluate: evaluate, requestPermission: requestPermission,
    metricLabel: metricLabel, getBearishNews: getBearishNews, setBearishNews: setBearishNews };
})();
