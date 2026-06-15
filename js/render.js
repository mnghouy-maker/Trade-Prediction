/* All DOM rendering lives here. Pure-ish: takes data, paints the UI. */
CP.render = (function () {
  var U = CP.util;
  var GAUGE_LEN = Math.PI * 90; // semicircle arc length

  function dirClass(dir) {
    var d = (dir || "").toUpperCase();
    return d === "BULLISH" ? "bullish" : d === "BEARISH" ? "bearish" : "neutral";
  }
  function dirColor(dir) {
    var d = (dir || "").toUpperCase();
    return d === "BULLISH" ? "var(--bull)" : d === "BEARISH" ? "var(--bear)" : "var(--neutral)";
  }

  // ---------- status + toast ----------
  function setStatus(allLive, time) {
    var dot = U.el("liveDot");
    dot.className = "live-dot " + (allLive ? "live" : "demo");
    dot.title = allLive ? "Live data" : "Some sources using sample data";
    U.el("lastUpdated").textContent = (allLive ? "Live · " : "Demo · ") + "updated " + time.toLocaleTimeString();
  }

  function toast(msg, kind) {
    var box = U.el("toasts");
    var t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; t.style.transition = "opacity .4s"; }, 5000);
    setTimeout(function () { t.remove(); }, 5600);
  }

  // ---------- hero gauge ----------
  function renderHero(result, d) {
    U.el("heroScore").textContent = result.aiScore;
    var dir = U.el("heroDirection");
    dir.textContent = result.direction;
    dir.className = "hero-direction " + dirClass(result.direction);
    U.el("heroHeadline").textContent = CP.score.headline(result, d);
    U.el("confValue").textContent = result.confidence + "%";
    U.el("confFill").style.width = result.confidence + "%";

    // gauge fill + needle
    var fill = U.el("gaugeFill");
    var frac = result.aiScore / 100;
    fill.style.strokeDasharray = (frac * GAUGE_LEN) + " " + GAUGE_LEN;
    fill.style.stroke = dirColor(result.direction);
    var deg = frac * 180 - 90;
    U.el("gaugeNeedle").style.transform = "rotate(" + deg + "deg)";

    // top reasons (largest absolute contributions)
    var reasons = result.signals.slice().sort(function (a, b) {
      return Math.abs(b.contrib) - Math.abs(a.contrib);
    }).slice(0, 5);
    U.el("heroReasons").innerHTML = reasons.map(function (r) {
      var cls = r.value > 0 ? "pos" : r.value < 0 ? "neg" : "";
      var icon = r.value > 0 ? "▲" : r.value < 0 ? "▼" : "•";
      return '<li class="' + cls + '">' + icon + " " + U.escapeHtml(r.label) + "</li>";
    }).join("");
  }

  // ---------- 1. overview ----------
  function renderOverview(d, result) {
    function trendCell(label, change) {
      var bull = change >= 0;
      return cell(label, '<span class="' + (bull ? "up" : "down") + '">' + (bull ? "Bullish ▲" : "Bearish ▼") + "</span>",
        U.fmtPct(change, true), bull ? "var(--bull-dim)" : "var(--bear-dim)");
    }
    function cell(label, value, meta, border) {
      return '<div class="ov-cell signal" style="border-color:' + (border || "var(--border)") + '">' +
        '<div class="ov-label">' + label + '</div>' +
        '<div class="ov-value">' + value + '</div>' +
        '<div class="ov-meta">' + (meta || "") + '</div></div>';
    }
    var fg = d.fearGreed;
    var fgColor = fg.value > 55 ? "var(--bull-dim)" : fg.value < 45 ? "var(--bear-dim)" : "var(--border)";
    var overall = result.direction;
    var ovColor = overall === "BULLISH" ? "var(--bull)" : overall === "BEARISH" ? "var(--bear)" : "var(--neutral)";

    U.el("overviewGrid").innerHTML =
      trendCell("Bitcoin Trend", d.simple.bitcoin.usd_24h_change) +
      trendCell("Ethereum Trend", d.simple.ethereum.usd_24h_change) +
      trendCell("Total Market Cap", d.global.change24h) +
      cell("Fear &amp; Greed", fg.value, fg.label + (fg.value > fg.prev ? " ▲" : " ▼"), fgColor) +
      cell("Overall Signal", '<span style="color:' + ovColor + '">' + overall + "</span>",
        "score " + (result.rawSum > 0 ? "+" : "") + result.rawSum.toFixed(1) + " · " + result.confidence + "% conf", ovColor);
  }

  // ---------- 3. technical ----------
  function renderTechnical(coinId, d) {
    var tech = d.tech[coinId];
    var sym = coinId === "ethereum" ? "ETH" : "BTC";
    var simple = d.simple[coinId];
    if (!tech) { U.el("technicalBody").innerHTML = '<div class="skeleton">No data.</div>'; return; }
    var ts = CP.score.technicalScore(tech);
    var change = simple.usd_24h_change;

    var metrics = [
      ["Price", U.fmtUSD(tech.price)],
      ["24h", '<span class="' + U.pctClass(change) + '">' + U.fmtPct(change, true) + "</span>"],
      ["Volume", U.fmtCompact(simple.usd_24h_vol)],
      ["RSI (14)", tech.rsi != null ? tech.rsi.toFixed(1) : "—"],
      ["50-day MA", U.fmtUSD(tech.sma50)],
      ["200-day MA", U.fmtUSD(tech.sma200)],
    ];

    var signalsHtml = ts.checks.map(function (c) {
      return "<li>" + (c.ok ? "✅" : "❌") + " " + c.label + "</li>";
    }).join("");
    var macdLine = tech.macd ? "<li>" + (tech.macd.bullish ? "✅" : "❌") +
      " MACD " + tech.macd.macd.toFixed(1) + " / signal " + tech.macd.signal.toFixed(1) + "</li>" : "";

    var barColor = ts.pct >= 60 ? "var(--bull)" : ts.pct <= 40 ? "var(--bear)" : "var(--neutral)";

    U.el("technicalBody").innerHTML =
      '<div class="ta-price-row"><span class="ta-price">' + U.fmtUSD(tech.price) + "</span>" +
        '<span class="ta-change ' + U.pctClass(change) + '">' + U.fmtPct(change, true) + " (24h)</span></div>" +
      '<div class="ta-metrics">' + metrics.map(function (m) {
        return '<div class="ta-metric"><div class="k">' + m[0] + '</div><div class="v">' + m[1] + "</div></div>";
      }).join("") + "</div>" +
      '<ul class="ta-signals">' + signalsHtml + macdLine + "</ul>" +
      '<div class="ta-result"><span class="ta-result-pct" style="color:' + barColor + '">' + ts.pct + "% Bullish</span>" +
        '<div class="ta-result-bar"><div class="ta-result-fill" style="width:' + ts.pct + "%;background:" + barColor + '"></div></div></div>';
  }

  // ---------- 7. AI engine ----------
  function renderAI(result, d) {
    var color = dirColor(result.direction);
    var reasons = result.signals.slice().sort(function (a, b) {
      return Math.abs(b.contrib) - Math.abs(a.contrib);
    }).slice(0, 6);
    U.el("aiBody").innerHTML =
      '<div class="ai-score-big" style="color:' + color + '">' + result.aiScore + '<span style="font-size:22px;color:var(--text-faint)">/100</span></div>' +
      '<div class="ai-direction" style="color:' + color + '">' + result.direction + "</div>" +
      '<div style="font-size:13px;color:var(--text-dim)">Confidence ' + result.confidence + "% · " +
        result.probability + "% bullish over 7 days</div>" +
      '<ul class="ai-reasons">' + reasons.map(function (r) {
        var cls = r.value > 0 ? "pos" : r.value < 0 ? "neg" : "";
        var icon = r.value > 0 ? "🟢" : r.value < 0 ? "🔴" : "⚪";
        return '<li class="' + cls + '">' + icon + " " + U.escapeHtml(r.label) + "</li>";
      }).join("") + "</ul>";
  }

  // ---------- 2. news ----------
  function renderNews(sent) {
    if (!sent.items.length) { U.el("newsBody").innerHTML = '<div class="skeleton">No headlines.</div>'; return; }
    U.el("newsBody").innerHTML = sent.items.map(function (n) {
      var pillCls = n.label === "Bullish" ? "bull" : n.label === "Bearish" ? "bear" : "neutral";
      var emoji = n.label === "Bullish" ? "🟢" : n.label === "Bearish" ? "🔴" : "⚪";
      var impCls = n.impact.toLowerCase();
      var titleHtml = n.url && n.url !== "#"
        ? '<a href="' + U.escapeHtml(n.url) + '" target="_blank" rel="noopener">' + U.escapeHtml(n.title) + "</a>"
        : U.escapeHtml(n.title);
      return '<div class="news-item"><div class="news-item-top">' +
        '<span class="news-title">' + titleHtml + "</span>" +
        '<span class="news-tags"><span class="pill ' + impCls + '">' + n.impact + "</span>" +
        '<span class="pill ' + pillCls + '">' + emoji + " " + n.label + "</span></span></div>" +
        '<div class="news-meta"><span>' + U.escapeHtml(n.source || "") + "</span><span>·</span><span>" + U.timeAgo(n.ts) + "</span></div></div>";
    }).join("");
  }

  // ---------- 4. sentiment ----------
  function renderSentiment(sent, trending) {
    var p = sent.pct;
    var vColor = sent.verdict === "Bullish" ? "var(--bull)" : sent.verdict === "Bearish" ? "var(--bear)" : "var(--neutral)";
    var trendHtml = trending.length
      ? '<div><div class="card-sub" style="margin-bottom:6px">Trending</div><div class="trending">' +
        trending.map(function (t) { return "<span>#" + U.escapeHtml(t) + "</span>"; }).join("") + "</div></div>"
      : "";
    U.el("sentimentBody").innerHTML =
      '<div class="sent-bars">' +
        sentRow("Positive", p.pos, "var(--bull)") +
        sentRow("Negative", p.neg, "var(--bear)") +
        sentRow("Neutral", p.neu, "var(--text-dim)") +
      "</div>" +
      '<div class="sent-verdict" style="color:' + vColor + '">Sentiment = ' + sent.verdict + "</div>" +
      trendHtml +
      '<div class="card-sub">Derived from ' + (sent.items.length) + " live headlines (news-based proxy for social).</div>";
  }
  function sentRow(label, pct, color) {
    return '<div class="sent-row"><span class="lbl">' + label + '</span><div class="sent-track">' +
      '<div style="width:' + pct + "%;background:" + color + '"></div></div><span class="num">' + pct + "%</span></div>";
  }

  // ---------- 5. whales ----------
  function renderWhales(w) {
    var net = w.netToColdStorage;
    var bullish = net > 0;
    U.el("whaleBody").innerHTML =
      '<div class="whale-net">Net flow: <strong style="color:' + (bullish ? "var(--bull)" : "var(--bear)") + '">' +
        (bullish ? "+" : "") + net.toLocaleString() + " BTC " + (bullish ? "off exchanges (bullish)" : "to exchanges (bearish)") + "</strong></div>" +
      w.items.map(function (i) {
        var isOut = i.dir === "exchange_outflow";
        var isIn = i.dir === "exchange_inflow";
        var color = isOut ? "var(--bull)" : isIn ? "var(--bear)" : "var(--text-dim)";
        var label = isOut ? "↗ Off exchange" : isIn ? "↘ To exchange" : "↔ Wallet";
        return '<div class="whale-item"><span class="whale-amt">' + i.amountBtc.toLocaleString() + " BTC " +
          '<span style="color:var(--text-faint);font-weight:400">(' + U.fmtCompact(i.usd) + ")</span></span>" +
          '<span class="whale-dir" style="color:' + color + '">' + label + " · " + i.minsAgo + "m ago</span></div>";
      }).join("");
  }

  // ---------- 6. calendar ----------
  function renderCalendar(events) {
    U.el("calendarBody").innerHTML = events.map(function (e) {
      var impCls = e.impact.toLowerCase();
      return '<div class="cal-item"><div class="cal-left"><div class="cal-name">' + U.escapeHtml(e.name) + " " +
        '<span class="pill ' + impCls + '">' + e.impact + "</span></div>" +
        '<div class="cal-date">' + e.dateStr + "</div></div>" +
        '<div class="cal-count">' + e.countdown + "</div></div>";
    }).join("");
  }

  // ---------- 8. alerts ----------
  function renderAlerts() {
    var rows = CP.alerts.all();
    U.el("alertList").innerHTML = rows.length ? rows.map(function (a) {
      return '<li class="' + (a.triggered ? "triggered" : "") + '" data-id="' + a.id + '">' +
        "<span>" + CP.alerts.metricLabel(a.metric) + " " + (a.op === "gt" ? ">" : "<") + " " + a.value +
        (a.triggered ? ' <span class="pill bull">triggered</span>' : "") + "</span>" +
        '<button class="alert-del" data-id="' + a.id + '" title="Remove">×</button></li>';
    }).join("") : '<li style="border:none;color:var(--text-faint)">No alerts set.</li>';
  }

  // ---------- 10. history ----------
  function renderHistory() {
    var rows = CP.history.all();
    var acc = CP.history.accuracy();
    U.el("historyAccuracy").textContent = acc ? acc.pct + "% accuracy (" + acc.correct + "/" + acc.total + ")" : "—";
    if (!rows.length) { U.el("historyBody").innerHTML = '<div class="skeleton">No predictions recorded yet.</div>'; return; }
    U.el("historyBody").innerHTML = '<table class="data"><thead><tr><th>Date</th><th>Prediction</th><th>BTC</th><th>Result</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var rc = r.result === "Correct" ? "up" : r.result === "Wrong" ? "down" : "";
        var dc = r.direction === "BULLISH" ? "bull" : r.direction === "BEARISH" ? "bear" : "neutral";
        return "<tr><td>" + r.date + '</td><td><span class="pill ' + dc + '">' + r.direction + "</span></td>" +
          "<td>" + U.fmtUSD(r.btcPrice) + '</td><td class="' + rc + '">' + r.result +
          (r.move != null ? " (" + U.fmtPct(r.move, true) + ")" : "") + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  // ---------- 9. backtest ----------
  function renderBacktest(stats, coinName, days) {
    function stat(v, k) { return '<div class="bt-stat"><div class="v">' + v + '</div><div class="k">' + k + "</div></div>"; }
    var pf = stats.profitFactor === Infinity ? "∞" : stats.profitFactor;
    var recent = stats.recent.map(function (r) {
      var dc = r.dir === "BULLISH" ? "bull" : "bear";
      return '<tr><td><span class="pill ' + dc + '">' + r.dir + "</span></td><td class=\"" + (r.ret >= 0 ? "up" : "down") +
        '">' + U.fmtPct(r.ret, true) + '</td><td class="' + (r.correct ? "up" : "down") + '">' +
        (r.correct ? "Correct" : "Wrong") + "</td></tr>";
    }).join("");
    U.el("backtestBody").innerHTML =
      '<div class="backtest-stats">' +
        stat(stats.accuracy + "%", "Direction accuracy") +
        stat(stats.winRate + "%", "Win rate") +
        stat(pf, "Profit factor") +
        stat(stats.predictions, "Predictions") +
      "</div>" +
      '<div class="card-sub" style="margin-bottom:10px">' + coinName + " · last " + Math.round(days / 365 * 10) / 10 +
        " yr · bullish calls " + stats.bull.correct + "/" + stats.bull.total + " correct, bearish " +
        stats.bear.correct + "/" + stats.bear.total + " correct.</div>" +
      '<table class="data"><thead><tr><th>Signal</th><th>Next-day move</th><th>Outcome</th></tr></thead><tbody>' +
        recent + "</tbody></table>";
  }

  return {
    setStatus: setStatus, toast: toast, renderHero: renderHero, renderOverview: renderOverview,
    renderTechnical: renderTechnical, renderAI: renderAI, renderNews: renderNews,
    renderSentiment: renderSentiment, renderWhales: renderWhales, renderCalendar: renderCalendar,
    renderAlerts: renderAlerts, renderHistory: renderHistory, renderBacktest: renderBacktest,
  };
})();
