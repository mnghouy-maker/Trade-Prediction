/* Paper-trading engine (futures-style) for the Trade tab.
 * No real money, no API keys: you start with a fake balance, open long/short
 * positions with leverage against the LIVE Binance price, and the panel tracks
 * entry, liquidation, margin and unrealized PnL. State persists in localStorage.
 * One position per symbol (Binance one-way mode); an opposite order reduces,
 * closes, and can flip the position. */
CP.paper = (function () {
  var U = CP.util;
  var KEY = "cp_paper_v1";
  var START_BALANCE = 10000;
  var FEE_RATE = 0.0005; // 0.05% per side, like a Binance taker fill

  var state = load();
  var marks = {};   // symbol -> latest live price
  var ctx = { symbol: null, display: "", lastPrice: 0 };
  var renderPending = false;

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY));
      if (s && typeof s.available === "number" && s.positions) return s;
    } catch (e) {}
    return { available: START_BALANCE, realized: 0, positions: {} };
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  function liqPrice(side, entry, lev) {
    return side === "long" ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev);
  }
  function uPnl(pos, mark) {
    if (!mark) return 0;
    return (pos.side === "long" ? (mark - pos.entry) : (pos.entry - mark)) * pos.size;
  }
  function markFor(sym) { return marks[sym] || (sym === ctx.symbol ? ctx.lastPrice : 0); }

  // Place a market paper order. side: 'long' | 'short'.
  function order(side, qty, price, lev) {
    if (!ctx.symbol) return fail("Pick a coin that trades on Binance first.");
    price = price > 0 ? price : markFor(ctx.symbol);
    if (!(price > 0)) return fail("No live price yet — give it a second and retry.");
    if (!(qty > 0)) return fail("Enter an amount (coin) or a USD size.");
    lev = Math.max(1, Math.min(125, lev || 1));

    var sym = ctx.symbol;
    var notional = qty * price;
    var fee = notional * FEE_RATE;
    var pos = state.positions[sym];

    if (!pos) {
      var margin = notional / lev;
      if (margin + fee > state.available) return fail("Not enough balance for that margin + fees.");
      state.available -= (margin + fee);
      state.positions[sym] = { side: side, size: qty, entry: price, lev: lev, margin: margin };
    } else if (pos.side === side) {
      // add to the position — re-average the entry
      var addMargin = notional / pos.lev;
      if (addMargin + fee > state.available) return fail("Not enough balance to add to the position.");
      state.available -= (addMargin + fee);
      pos.entry = (pos.entry * pos.size + price * qty) / (pos.size + qty);
      pos.size += qty;
      pos.margin += addMargin;
    } else {
      // opposite side — reduce, close, and possibly flip
      if (fee > state.available) return fail("Not enough balance for fees.");
      state.available -= fee;
      var closeQty = Math.min(qty, pos.size);
      var pnl = (pos.side === "long" ? (price - pos.entry) : (pos.entry - price)) * closeQty;
      var relMargin = pos.margin * (closeQty / pos.size);
      state.available += relMargin + pnl;
      state.realized += pnl;
      pos.size -= closeQty;
      pos.margin -= relMargin;
      if (pos.size <= 1e-9) {
        delete state.positions[sym];
        var rem = qty - closeQty;
        if (rem > 1e-9) {
          var m2 = (rem * price) / lev;
          if (m2 <= state.available) {
            state.available -= m2;
            state.positions[sym] = { side: side, size: rem, entry: price, lev: lev, margin: m2 };
          } else {
            save(); scheduleRender();
            return done("Closed position (not enough balance to open the reverse remainder).");
          }
        }
      }
    }
    save(); scheduleRender();
    return done((side === "long" ? "Bought / long " : "Sold / short ") + trimCoin(qty) + " " + ctx.display + " at " + U.fmtUSD(price));
  }

  function closeSymbol(sym) {
    var pos = state.positions[sym];
    if (!pos) return;
    var mark = markFor(sym) || pos.entry;
    var pnl = uPnl(pos, mark);
    state.available += pos.margin + pnl;
    state.realized += pnl;
    delete state.positions[sym];
    save(); scheduleRender();
    CP.render.toast("Closed " + sym + " · PnL " + (pnl >= 0 ? "+" : "") + U.fmtUSD(pnl), pnl >= 0 ? "bull" : "bear");
  }

  function reset() {
    state = { available: START_BALANCE, realized: 0, positions: {} };
    save(); scheduleRender();
    CP.render.toast("Paper account reset to " + U.fmtUSD(START_BALANCE) + ".", "");
  }

  function fail(msg) { CP.render.toast(msg, "bear"); return { ok: false, msg: msg }; }
  function done(msg) { CP.render.toast(msg, "bull"); return { ok: true, msg: msg }; }

  // ---- live marks / current symbol ----
  function mark(sym, price) {
    if (!(price > 0)) return;
    marks[sym] = price;
    if (sym === ctx.symbol) ctx.lastPrice = price;
    if (state.positions[sym]) scheduleRender();
  }
  function setContext(sym, display, price) {
    ctx.symbol = sym; ctx.display = display || sym || "";
    if (price > 0) { ctx.lastPrice = price; if (sym) marks[sym] = price; }
    scheduleRender();
  }

  // ---- rendering (throttled to one frame) ----
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    (window.requestAnimationFrame || function (f) { return setTimeout(f, 60); })(function () {
      renderPending = false; render();
    });
  }
  function equity() {
    var eq = state.available;
    Object.keys(state.positions).forEach(function (s) {
      var p = state.positions[s];
      eq += p.margin + uPnl(p, markFor(s));
    });
    return eq;
  }
  function render() {
    var bal = U.el("paperBalance"); if (!bal) return;
    bal.textContent = U.fmtUSD(state.available);
    var eqEl = U.el("paperEquity"); if (eqEl) eqEl.textContent = U.fmtUSD(equity());
    var rz = U.el("paperRealized");
    if (rz) {
      rz.textContent = "Realized " + (state.realized >= 0 ? "+" : "") + U.fmtUSD(state.realized);
      rz.className = "card-sub " + (state.realized > 0 ? "up" : state.realized < 0 ? "down" : "");
    }
    var box = U.el("paperPositions"); if (!box) return;
    var syms = Object.keys(state.positions);
    if (!syms.length) {
      box.innerHTML = '<div class="skeleton">No open positions. Place a paper Buy or Sell above.</div>';
      return;
    }
    var rows = syms.map(function (s) {
      var p = state.positions[s];
      var mk = markFor(s) || p.entry;
      var pnl = uPnl(p, mk);
      var roe = p.margin ? (pnl / p.margin) * 100 : 0;
      var sideCls = p.side === "long" ? "bull" : "bear";
      var pnlCls = pnl >= 0 ? "up" : "down";
      return "<tr>" +
        "<td><strong>" + U.escapeHtml(s) + "</strong></td>" +
        '<td><span class="pill ' + sideCls + '">' + p.side.toUpperCase() + " " + p.lev + "x</span></td>" +
        "<td>" + trimCoin(p.size) + "</td>" +
        "<td>" + U.fmtUSD(p.entry, p.entry < 1 ? 4 : 2) + "</td>" +
        "<td>" + U.fmtUSD(mk, mk < 1 ? 4 : 2) + "</td>" +
        "<td>" + U.fmtUSD(liqPrice(p.side, p.entry, p.lev), p.entry < 1 ? 4 : 2) + "</td>" +
        "<td>" + U.fmtUSD(p.margin) + "</td>" +
        '<td class="' + pnlCls + '">' + (pnl >= 0 ? "+" : "") + U.fmtUSD(pnl) + " (" + U.fmtPct(roe, true) + ")</td>" +
        '<td><button class="btn btn-sm paper-close" data-sym="' + U.escapeHtml(s) + '">Close</button></td>' +
        "</tr>";
    }).join("");
    box.innerHTML = '<div class="bx-pos-scroll"><table class="data"><thead><tr>' +
      "<th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Liq.</th><th>Margin</th><th>PnL (ROE)</th><th></th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";
  }
  function trimCoin(n) { return n >= 1 ? (+n.toFixed(4)).toString() : (+n.toPrecision(4)).toString(); }

  function init() { render(); }

  return {
    init: init, order: order, closeSymbol: closeSymbol, reset: reset,
    mark: mark, setContext: setContext, render: render,
  };
})();
