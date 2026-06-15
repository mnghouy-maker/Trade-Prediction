/* Orchestration: fetch → compute → render, plus all UI wiring & the refresh loop. */
(function () {
  var U = CP.util;
  CP.state = { data: null, result: null, currentCoin: "bitcoin", timer: null };

  function loadAll() {
    return Promise.all([
      CP.api.getSimple(),
      CP.api.getGlobal(),
      CP.api.getFearGreed(),
      CP.api.getMarketChart("bitcoin", 365),
      CP.api.getMarketChart("ethereum", 365),
      CP.api.getNews(),
    ]).then(function (res) {
      var simple = res[0], global = res[1], fg = res[2], btcChart = res[3], ethChart = res[4], news = res[5];

      var sent = CP.sentiment.analyze(news.items);

      return CP.api.getWhales(simple.data.bitcoin.usd).then(function (whales) {
        return finish(simple, global, fg, btcChart, ethChart, news, sent, whales);
      });
    }).catch(function (e) {
      console.error(e);
      CP.render.toast("Failed to load data — retrying next cycle.", "bear");
    });
  }

  function finish(simple, global, fg, btcChart, ethChart, news, sent, whales) {
      var d = {
        simple: simple.data,
        global: { marketCap: global.marketCap, change24h: global.change24h },
        fearGreed: fg,
        tech: {
          bitcoin: CP.indicators.compute(btcChart.closes),
          ethereum: CP.indicators.compute(ethChart.closes),
        },
        charts: { bitcoin: btcChart, ethereum: ethChart },
        sentiment: sent,
        whales: whales,
        trending: CP.sentiment.trending(news.items),
      };

      var signals = CP.score.buildSignals(d);
      var result = CP.score.evaluate(signals);
      d.result = result;

      CP.state.data = d;
      CP.state.result = result;

      paint(d, result);

      // alerts + history use a flat snapshot
      CP.alerts.evaluate({ simple: d.simple, tech: d.tech, fearGreed: d.fearGreed, result: result, sentiment: d.sentiment });
      CP.render.renderAlerts();
      CP.history.record(result.direction, d.simple.bitcoin.usd);
      CP.render.renderHistory();

      var allLive = simple.live && global.live && fg.live && btcChart.live && ethChart.live && news.live;
      CP.render.setStatus(allLive, new Date());
  }

  function paint(d, result) {
    CP.render.renderHero(result, d);
    CP.render.renderOverview(d, result);
    CP.render.renderTechnical(CP.state.currentCoin, d);
    CP.render.renderAI(result, d);
    CP.render.renderNews(d.sentiment);
    CP.render.renderSentiment(d.sentiment, d.trending);
    CP.render.renderWhales(d.whales);
    CP.render.renderCalendar(computeEvents());
  }

  // ---- Economic calendar: roll each anchor forward to its next occurrence ----
  function computeEvents() {
    var now = Date.now();
    return CP.economicEvents.map(function (e) {
      var t = new Date(e.anchor + "T13:30:00Z").getTime();
      var period = e.periodDays * 86400000;
      while (t < now) t += period;
      var diff = t - now;
      var days = Math.floor(diff / 86400000);
      var hours = Math.floor((diff % 86400000) / 3600000);
      var dt = new Date(t);
      return {
        name: e.name, impact: e.impact,
        dateStr: dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
        countdown: days > 0 ? days + "d " + hours + "h" : hours + "h",
        sortT: t,
      };
    }).sort(function (a, b) { return a.sortT - b.sortT; });
  }

  // ---- Backtesting ----
  function runBacktest() {
    var coin = U.el("backtestCoin").value;
    var days = +U.el("backtestDays").value;
    var coinName = coin === "ethereum" ? "Ethereum" : "Bitcoin";
    U.el("backtestBody").innerHTML = '<div class="skeleton">Fetching ' + days + " days of history & replaying model…</div>";
    CP.api.getMarketChart(coin, days).then(function (chart) {
      if (chart.closes.length < 220) {
        U.el("backtestBody").innerHTML = '<div class="skeleton">Not enough history returned to backtest.</div>';
        return;
      }
      var stats = CP.backtest.run(chart.closes);
      CP.render.renderBacktest(stats, coinName + (chart.live ? "" : " (sample data)"), days);
    });
  }

  // ---- Wiring ----
  function wire() {
    U.el("refreshBtn").addEventListener("click", function () { loadAll(); });

    U.el("coinSwitch").addEventListener("click", function (e) {
      var btn = e.target.closest(".coin-btn");
      if (!btn) return;
      CP.state.currentCoin = btn.getAttribute("data-coin");
      document.querySelectorAll(".coin-btn").forEach(function (b) { b.classList.toggle("active", b === btn); });
      if (CP.state.data) CP.render.renderTechnical(CP.state.currentCoin, CP.state.data);
    });

    U.el("addAlertBtn").addEventListener("click", function () {
      var m = U.el("alertMetric").value, op = U.el("alertOp").value, v = U.el("alertValue").value;
      if (v === "" || isNaN(+v)) { CP.render.toast("Enter a numeric alert value.", "bear"); return; }
      CP.alerts.add(m, op, v);
      U.el("alertValue").value = "";
      CP.render.renderAlerts();
      if (CP.state.data) {
        CP.alerts.evaluate({ simple: CP.state.data.simple, tech: CP.state.data.tech, fearGreed: CP.state.data.fearGreed, result: CP.state.result, sentiment: CP.state.data.sentiment });
        CP.render.renderAlerts();
      }
    });

    U.el("alertList").addEventListener("click", function (e) {
      var btn = e.target.closest(".alert-del");
      if (!btn) return;
      CP.alerts.remove(+btn.getAttribute("data-id"));
      CP.render.renderAlerts();
    });

    U.el("notifyBtn").addEventListener("click", function () { CP.alerts.requestPermission(); });

    var bn = U.el("alertBearishNews");
    bn.checked = CP.alerts.getBearishNews();
    bn.addEventListener("change", function () { CP.alerts.setBearishNews(bn.checked); });

    U.el("runBacktest").addEventListener("click", runBacktest);
  }

  // ---- Boot ----
  function start() {
    wire();
    loadAll();
    CP.state.timer = setInterval(loadAll, CP.config.refreshInterval);
    // keep calendar countdowns ticking even between data refreshes
    setInterval(function () { CP.render.renderCalendar(computeEvents()); }, 60000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
