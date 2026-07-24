/* Forex tab UI: renders the pair grid + MTF signal card into #forexRoot and
 * wires the key bar, pair selection, refresh and "scan all" controls. */
CP.forexUI = (function () {
  var U = CP.util;
  var F = CP.forex;

  function el(id) { return document.getElementById(id); }
  function sigClass(s) { return s === "BUY" ? "bull" : s === "SELL" ? "bear" : "neutral"; }

  var NAMES = {
    EURUSD: "Euro / US Dollar", GBPUSD: "Pound / US Dollar", USDJPY: "US Dollar / Yen",
    USDCAD: "US Dollar / Canadian", AUDUSD: "Aussie / US Dollar", USDCHF: "US Dollar / Franc",
    NZDUSD: "Kiwi / US Dollar", EURGBP: "Euro / Pound", EURJPY: "Euro / Yen",
    GBPJPY: "Pound / Yen", XAUUSD: "Gold / US Dollar",
  };

  function shell() {
    var root = el("forexRoot");
    if (!root || root._built) return;
    root._built = true;
    root.innerHTML =
      '<section class="card">' +
        '<div class="card-head"><h2>Forex Signals · 3-Tier MTF Engine</h2>' +
          '<span id="fxStatus" class="card-sub">Loading live feed…</span></div>' +
        '<p class="card-note">Top-down analysis: <strong>D1</strong> anchor trend → <strong>H1</strong> structure → <strong>M15/M5</strong> trigger. ' +
          'Every pair gets a <strong>BUY or SELL</strong> with entry, Stop-Loss and two Take-Profit targets (stops use 1.5× ATR). ' +
          'Confidence (1–5) shows how well the tiers align. <strong>Auto-refreshes every 5 minutes · live prices for all 11 pairs, no API key needed.</strong></p>' +
        '<details class="fx-adv"><summary>Advanced · use your own data key (optional)</summary>' +
          '<div class="fx-keybar">' +
            '<input id="fxKey" type="password" placeholder="Twelve Data API key (optional)" value="' + U.escapeHtml(F.getKey()) + '" />' +
            '<button id="fxKeySave" class="btn btn-sm btn-primary">Save</button>' +
            '<a href="https://twelvedata.com/pricing" target="_blank" rel="noopener" class="fx-keylink">Twelve Data →</a>' +
          "</div>" +
          '<p class="card-note" style="margin:8px 0 0">Only if you want a dedicated feed — the dashboard works fully without it.</p>' +
        "</details>" +
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
      var sub = r ? ((r._live ? "" : "demo · ") + (r.signal === "NO_SIGNAL" ? "no setup" : "conf " + r.confidence_score + "/5 · " + r.risk_reward_ratio + "R"))
        : "tap to analyze";
      var sel = p.id === F.state.selected ? " sel" : "";
      var nm = NAMES[p.id] || "";
      return '<button class="fx-card' + sel + '" data-pair="' + p.id + '">' +
        '<span class="fx-sym">' + p.sym + "</span>" +
        (nm ? '<span class="fx-name">' + nm + "</span>" : "") + badge +
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

    var warn = r._live ? "" :
      '<div class="fx-demo-warn">⚠ Sample data — the live feed for ' + F.symOf(id) +
      ' is temporarily unavailable, so this price is illustrative, <strong>not the real market price</strong>. Press <strong>Analyze</strong> to retry live.</div>';

    var color = r.signal === "BUY" ? "var(--bull)" : r.signal === "SELL" ? "var(--bear)" : "var(--neutral)";
    var head =
      '<div class="fx-signal-head" style="border-color:' + color + '">' +
        '<div class="fx-signal-verb" style="color:' + color + '">' + r.signal + "</div>" +
        '<div class="fx-signal-meta">' + F.symOf(id) + " · " + r.execution_timeframe +
          (r.signal !== "NO_SIGNAL" ? " · confidence " + r.confidence_score + "/5" : "") + "</div></div>";

    var levels = "";
    if (r.signal !== "NO_SIGNAL") {
      var L = r._levels || {};
      levels = '<div class="fx-levels">' +
        lvl("Entry", r.entry_range, "var(--text)") +
        lvl("Stop loss", F.fmt(id, r.stop_loss) + pipTag(L.slPips), "var(--bear)") +
        lvl("Take profit 1", F.fmt(id, r.take_profit) + pipTag(L.tp1Pips), "var(--bull)") +
        lvl("Take profit 2", F.fmt(id, r.take_profit_2) + pipTag(L.tp2Pips), "var(--bull)") +
        lvl("Reward : Risk", r.risk_reward_ratio + " : 1", "var(--accent)") +
      "</div>";
    }

    el("fxDetail").innerHTML =
      warn + head + levels +
      '<div class="fx-tiers">' + t1 + t2 + t3 + "</div>" +
      dataReadout(id, r._data) +
      '<div class="fx-reason">' + U.escapeHtml(r.reasoning) + "</div>";
  }
  function t1ok(bias) { return bias === "NEUTRAL" ? null : true; }
  function lvl(k, v, c) { return '<div class="fx-lvl"><span>' + k + '</span><strong style="color:' + c + '">' + v + "</strong></div>"; }
  function pipTag(n) { return n == null ? "" : ' <span class="fx-pip">' + Math.round(n) + "p</span>"; }

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
    // Show an instant result so a signal is never blank, then upgrade to live.
    if (!F.state.results[id]) F.state.results[id] = F.demoResult(id);
    renderGrid(); renderDetail(id);
    el("fxDetailCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
    F.analyze(id, { force: force }).then(function () {
      renderGrid(); renderDetail(id); setStatus();
    }).catch(function (e) {
      if (e && e.rate) CP.render && CP.render.toast && CP.render.toast("Twelve Data rate limit (8/min) — showing cached/demo.", "bear");
      renderDetail(id); setStatus();
    });
  }

  // Reflect the actual data source based on the results we have.
  function setStatus() {
    var st = el("fxStatus"); if (!st) return;
    var res = F.state.results, ids = Object.keys(res);
    var live = ids.filter(function (k) { return res[k]._live; }).length;
    if (!ids.length) { st.textContent = "Loading live feed…"; return; }
    if (live === 0) st.textContent = "Sample data · live feed unreachable — press Scan all to retry";
    else if (live === ids.length) st.textContent = F.getKey() ? "Live · Twelve Data" : "Live · free market feed";
    else st.textContent = "Live · " + live + "/" + ids.length + " pairs";
  }

  // Sequential scan with spacing so we don't hammer the data source.
  function scanAll() {
    if (F.state.scanning) return;
    F.state.scanning = true;
    var keyed = !!F.getKey();
    var delay = keyed ? 8000 : 900;                // TD free = 8/min; keyless Yahoo proxy is gentler
    var status = el("fxStatus"), pairs = F.PAIRS.slice(), i = 0;
    // Fill the whole grid instantly with demo results, then upgrade each to live.
    pairs.forEach(function (p) { if (!F.state.results[p.id]) F.state.results[p.id] = F.demoResult(p.id); });
    renderGrid();
    function next() {
      if (i >= pairs.length) { F.state.scanning = false; setStatus(); renderGrid(); return; }
      var p = pairs[i++];
      status.textContent = "Loading live · " + p.sym + " (" + i + "/" + pairs.length + ")…";
      F.analyze(p.id).then(function () { renderGrid(); if (p.id === F.state.selected) renderDetail(p.id); })
        .catch(function () {})
        .then(function () { setTimeout(next, delay); });
    }
    next();
  }

  function wire() {
    el("fxKeySave").addEventListener("click", function () {
      F.setKey(el("fxKey").value);
      el("fxStatus").textContent = "Reloading…";
      F.state.cache = {};
      CP.render && CP.render.toast && CP.render.toast(F.getKey() ? "Data key saved." : "Using the free market feed.", "bull");
      scanAll();
      if (F.state.selected) selectPair(F.state.selected, true);
    });
    el("fxGrid").addEventListener("click", function (e) {
      var b = e.target.closest(".fx-card"); if (b) selectPair(b.getAttribute("data-pair"));
    });
    el("fxRefresh").addEventListener("click", function () { if (F.state.selected) selectPair(F.state.selected, true); });
    el("fxScan").addEventListener("click", scanAll);
  }

  // Re-pull live data + re-signal every 5 minutes (only while the tab is open).
  function refreshLive() {
    var panel = el("tab-forex");
    if (!panel || !panel.classList.contains("active") || F.state.scanning) return;
    F.state.cache = {};
    scanAll();
    if (F.state.selected) selectPair(F.state.selected, true);
  }

  return {
    init: function () {
      shell();
      if (!CP.forexUI._timer) CP.forexUI._timer = setInterval(refreshLive, 5 * 60 * 1000);
    },
    onOpen: function () {
      shell();
      if (F.state.results[F.state.selected]) return; // already populated
      // Show the selected pair immediately, then load every pair live in the
      // background (keyless Yahoo feed, or Twelve Data if a key is set).
      selectPair(F.state.selected);
      scanAll();
    },
  };
})();
