/* Forex tab UI: renders the pair grid + MTF signal card into #forexRoot and
 * wires the key bar, pair selection, refresh and "scan all" controls. */
CP.forexUI = (function () {
  var U = CP.util;
  var F = CP.forex;

  function el(id) { return document.getElementById(id); }
  function sigClass(s) { return s === "BUY" ? "bull" : s === "SELL" ? "bear" : "neutral"; }

  function shell() {
    var root = el("forexRoot");
    if (!root || root._built) return;
    root._built = true;
    var hasKey = !!F.getKey();
    root.innerHTML =
      '<section class="card">' +
        '<div class="card-head"><h2>Forex Signals · 3-Tier MTF Engine</h2>' +
          '<span id="fxStatus" class="card-sub">' + (hasKey ? "Live · Twelve Data" : "Demo data — add a free key for live") + "</span></div>" +
        '<p class="card-note">Top-down analysis: <strong>D1</strong> anchor trend → <strong>H1</strong> structure → <strong>M15</strong> trigger. ' +
          'Signals obey strict rules: bias must align across all tiers, entries avoid opposing S/R, stops use 1.5× ATR, and reward:risk must be ≥ 1.5 or it returns NO_SIGNAL.</p>' +
        '<div class="fx-keybar">' +
          '<input id="fxKey" type="password" placeholder="Twelve Data API key (free at twelvedata.com)" value="' + U.escapeHtml(F.getKey()) + '" />' +
          '<button id="fxKeySave" class="btn btn-sm btn-primary">Save key</button>' +
          '<a href="https://twelvedata.com/pricing" target="_blank" rel="noopener" class="fx-keylink">Get a free key →</a>' +
        "</div>" +
      "</section>" +
      '<section class="card">' +
        '<div class="card-head"><h2>Pairs</h2>' +
          '<button id="fxScan" class="btn btn-sm">Scan all</button></div>' +
        '<div id="fxGrid" class="fx-grid"></div>' +
      "</section>" +
      '<section class="card" id="fxDetailCard">' +
        '<div class="card-head"><h2 id="fxDetailTitle">Select a pair</h2>' +
          '<button id="fxRefresh" class="btn btn-sm">Analyze</button></div>' +
        '<div id="fxDetail"><div class="skeleton">Pick a pair above to run the multi-timeframe analysis.</div></div>' +
      "</section>";
    renderGrid();
    wire();
  }

  function renderGrid() {
    el("fxGrid").innerHTML = F.PAIRS.map(function (p) {
      var r = F.state.results[p.id];
      var badge = r ? '<span class="pill ' + sigClass(r.signal) + '">' + r.signal + "</span>" : '<span class="pill neutral">—</span>';
      var sub = r ? (r.signal === "NO_SIGNAL" ? "no setup" : "conf " + r.confidence_score + "/5 · " + r.risk_reward_ratio + "R")
        : "tap to analyze";
      var sel = p.id === F.state.selected ? " sel" : "";
      return '<button class="fx-card' + sel + '" data-pair="' + p.id + '">' +
        '<span class="fx-sym">' + p.sym + "</span>" + badge +
        '<span class="fx-sub">' + sub + "</span></button>";
    }).join("");
  }

  function renderDetail(id) {
    var r = F.state.results[id];
    el("fxDetailTitle").textContent = F.symOf(id) + (r && !r._live ? "  · demo" : "");
    if (!r) { el("fxDetail").innerHTML = '<div class="skeleton">No analysis yet.</div>'; return; }

    var t = r._tiers || {};
    function tierRow(n, label, ok, txt) {
      return '<div class="fx-tier"><span class="fx-tier-n">' + n + "</span>" +
        '<span class="fx-tier-dot ' + (ok === true ? "ok" : ok === false ? "no" : "mid") + '"></span>' +
        "<span class=\"fx-tier-label\">" + label + "</span><span class=\"fx-tier-txt\">" + txt + "</span></div>";
    }
    var t1 = t.t1 ? tierRow("D1", "Anchor trend", t1ok(t.t1.bias), t.t1.bias + " · price " + (t.t1.priceAboveEMA ? "above" : "below") + " 200 EMA") : "";
    var t2 = t.t2 ? tierRow("H1", "Structure", null, "Res " + F.fmt(id, t.t2.resistance) + " (" + Math.round(t.t2.distResPips) + "p) · Sup " + F.fmt(id, t.t2.support) + " (" + Math.round(t.t2.distSupPips) + "p)") : "";
    var t3 = t.t3 ? tierRow("M15", "Trigger", t.t3.triggers.length > 0, t.t3.triggers.length ? t.t3.triggers.join(", ") : "no confirmation · RSI " + t.t3.rsi.toFixed(0)) : "";

    var color = r.signal === "BUY" ? "var(--bull)" : r.signal === "SELL" ? "var(--bear)" : "var(--neutral)";
    var head =
      '<div class="fx-signal-head" style="border-color:' + color + '">' +
        '<div class="fx-signal-verb" style="color:' + color + '">' + r.signal + "</div>" +
        '<div class="fx-signal-meta">' + F.symOf(id) + " · " + r.execution_timeframe +
          (r.signal !== "NO_SIGNAL" ? " · confidence " + r.confidence_score + "/5" : "") + "</div></div>";

    var levels = "";
    if (r.signal !== "NO_SIGNAL") {
      levels = '<div class="fx-levels">' +
        lvl("Entry", r.entry_range, "var(--text)") +
        lvl("Stop loss", F.fmt(id, r.stop_loss), "var(--bear)") +
        lvl("Take profit", F.fmt(id, r.take_profit), "var(--bull)") +
        lvl("Reward : Risk", r.risk_reward_ratio + " : 1", "var(--accent)") +
      "</div>";
    }

    var json = JSON.stringify({
      signal: r.signal, pair: r.pair, execution_timeframe: r.execution_timeframe,
      entry_range: r.entry_range, stop_loss: r.stop_loss, take_profit: r.take_profit,
      risk_reward_ratio: r.risk_reward_ratio, confidence_score: r.confidence_score, reasoning: r.reasoning,
    }, null, 2);

    el("fxDetail").innerHTML =
      head + levels +
      '<div class="fx-tiers">' + t1 + t2 + t3 + "</div>" +
      dataReadout(id, r._data) +
      '<div class="fx-reason">' + U.escapeHtml(r.reasoning) + "</div>" +
      '<details class="fx-json"><summary>Raw JSON signal</summary><pre>' + U.escapeHtml(json) + "</pre></details>";
  }
  function t1ok(bias) { return bias === "NEUTRAL" ? null : true; }
  function lvl(k, v, c) { return '<div class="fx-lvl"><span>' + k + '</span><strong style="color:' + c + '">' + v + "</strong></div>"; }

  // Extracted Tier 1/2/3 data readout (mirrors the analysis input contract).
  function dataReadout(id, D) {
    if (!D) return "";
    function grp(title, rows) { return '<div class="fx-dgrp"><div class="fx-dgrp-h">' + title + "</div>" + rows + "</div>"; }
    function row(k, v) { return '<div class="fx-drow"><span>' + k + "</span><strong>" + v + "</strong></div>"; }
    var pips = function (n) { return Math.round(n) + " pips"; };
    var t1 = grp("Tier 1 · Macro (D1)",
      row("Current price", F.fmt(id, D.tier1.price)) +
      row("200 EMA", F.fmt(id, D.tier1.ema200)) +
      row("Price vs EMA", D.tier1.relation) +
      row("Market structure", D.tier1.structure) +
      row("Macro RSI (14)", D.tier1.macroRSI.toFixed(0)));
    var t2 = grp("Tier 2 · Structure (H1)",
      row("Resistance", F.fmt(id, D.tier2.resistance) + " (" + pips(D.tier2.distResPips) + ")") +
      row("Support", F.fmt(id, D.tier2.support) + " (" + pips(D.tier2.distSupPips) + ")") +
      row("Order block", D.tier2.orderBlock != null ? F.fmt(id, D.tier2.orderBlock) : "—") +
      row(D.tier2.volProxy ? "Volatility" : "Volume", D.tier2.volume));
    var t3 = grp("Tier 3 · Trigger (M15/M5)",
      row("M15 structure", D.tier3.m15Structure) +
      row("M5 RSI (14)", D.tier3.m5RSI.toFixed(0)) +
      row("M5 candle", D.tier3.candle) +
      row("ATR (14)", D.tier3.atrPips.toFixed(1) + " pips"));
    return '<div class="fx-data">' + t1 + t2 + t3 + "</div>";
  }

  function selectPair(id, force) {
    F.state.selected = id;
    renderGrid();
    el("fxDetailCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
    el("fxDetailTitle").textContent = F.symOf(id);
    el("fxDetail").innerHTML = '<div class="skeleton">Running D1 → H1 → M15 analysis…</div>';
    F.analyze(id, { force: force }).then(function () {
      renderGrid(); renderDetail(id);
    }).catch(function (e) {
      if (e && e.rate) {
        el("fxDetail").innerHTML = '<div class="skeleton">Twelve Data rate limit hit (free tier = 8/min). Wait a few seconds and try again.</div>';
      } else {
        el("fxDetail").innerHTML = '<div class="skeleton">Could not load data for ' + F.symOf(id) + ".</div>";
      }
    });
  }

  // Sequential scan with spacing to respect the free-tier rate limit.
  function scanAll() {
    if (F.state.scanning) return;
    F.state.scanning = true;
    var live = !!F.getKey();
    var status = el("fxStatus"), pairs = F.PAIRS.slice(), i = 0;
    function next() {
      if (i >= pairs.length) {
        F.state.scanning = false;
        status.textContent = (live ? "Live · Twelve Data" : "Demo data — add a free key for live");
        renderGrid(); return;
      }
      var p = pairs[i++];
      status.textContent = "Scanning " + p.sym + " (" + i + "/" + pairs.length + ")…";
      F.analyze(p.id).then(function () { renderGrid(); })
        .catch(function () {})
        .then(function () { setTimeout(next, live ? 2600 : 60); }); // throttle only when hitting the live API
    }
    next();
  }

  function wire() {
    el("fxKeySave").addEventListener("click", function () {
      F.setKey(el("fxKey").value);
      el("fxStatus").textContent = F.getKey() ? "Live · Twelve Data" : "Demo data — add a free key for live";
      F.state.cache = {};
      CP.render && CP.render.toast && CP.render.toast(F.getKey() ? "Twelve Data key saved — live forex enabled." : "Key cleared — using demo data.", "bull");
      if (F.state.selected) selectPair(F.state.selected, true);
    });
    el("fxGrid").addEventListener("click", function (e) {
      var b = e.target.closest(".fx-card"); if (b) selectPair(b.getAttribute("data-pair"));
    });
    el("fxRefresh").addEventListener("click", function () { if (F.state.selected) selectPair(F.state.selected, true); });
    el("fxScan").addEventListener("click", scanAll);
  }

  return {
    init: function () { shell(); },
    onOpen: function () {
      shell();
      // Auto-analyze the default pair the first time the tab is opened.
      if (!F.state.results[F.state.selected]) selectPair(F.state.selected);
    },
  };
})();
