/* Small formatting & DOM helpers. */
CP.util = (function () {
  function fmtUSD(n, dp) {
    if (n == null || isNaN(n)) return "—";
    var d = dp == null ? (n >= 1000 ? 0 : 2) : dp;
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  // Decimal places for a coin PRICE: 2 for >= $1, otherwise enough to keep
  // ~5 significant figures and at least 5 decimals (e.g. 0.083375 -> 6).
  function priceDp(n) {
    var p = Math.abs(+n);
    if (!(p > 0)) return 5;
    if (p >= 1) return 2;
    var lead = Math.floor(-Math.log10(p)); // leading zeros after the dot
    return Math.min(8, Math.max(5, lead + 5));
  }
  function fmtPrice(n) {
    if (n == null || isNaN(n)) return "—";
    var d = priceDp(n);
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtCompact(n) {
    if (n == null || isNaN(n)) return "—";
    var abs = Math.abs(n);
    if (abs >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
    if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
    return "$" + n.toFixed(2);
  }

  function fmtPct(n, withSign) {
    if (n == null || isNaN(n)) return "—";
    var s = (withSign && n > 0 ? "+" : "") + n.toFixed(2) + "%";
    return s;
  }

  function pctClass(n) { return n > 0 ? "up" : n < 0 ? "down" : ""; }

  function el(id) { return document.getElementById(id); }

  function timeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Promise with a timeout so a slow endpoint never hangs the dashboard.
  function fetchJSON(url, timeoutMs) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 12000);
    return fetch(url, { signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(t);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  return { fmtUSD: fmtUSD, fmtPrice: fmtPrice, priceDp: priceDp, fmtCompact: fmtCompact, fmtPct: fmtPct, pctClass: pctClass,
    el: el, timeAgo: timeAgo, escapeHtml: escapeHtml, fetchJSON: fetchJSON, clamp: clamp };
})();
