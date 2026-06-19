/* CryptoPulse optional backend.
 *
 * Serves the static dashboard AND provides key-enriched API routes that the
 * frontend prefers when present (see js/api.js -> tryBackend). Every route
 * degrades gracefully: with no API keys configured it falls back to the same
 * free public data / deterministic sample the static app uses, so the server
 * is always runnable.
 *
 * Configure keys via environment variables (see .env.example):
 *   CRYPTOPANIC_TOKEN   real news feed
 *   WHALE_ALERT_KEY     real large-transfer flows
 *   ANTHROPIC_API_KEY   LLM headline sentiment + macro read (claude-haiku-4-5-20251001)
 *   FRED_API_KEY        real macro trend (CPI / rates / unemployment) for /api/macro
 *
 * /api/macro adds the "higher/lower than expected" logic: a US economic
 * calendar with forecast + actual (free, no key) plus the optional FRED trend
 * and a short LLM macro read. The frontend folds it into the Trade Signal.
 *
 * Run:  npm install && npm run server   (default http://localhost:8080)
 */
"use strict";

const path = require("path");
// Load .env if present (dotenv optional — server runs fine without it).
try { require("dotenv").config(); } catch (e) { /* dotenv not installed; that's fine */ }
const express = require("express");

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, "..");

const CRYPTOPANIC_TOKEN = process.env.CRYPTOPANIC_TOKEN || "";
const WHALE_ALERT_KEY = process.env.WHALE_ALERT_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const FRED_API_KEY = process.env.FRED_API_KEY || "";

// Node 18+ has global fetch; provide a tiny timeout wrapper.
async function getJSON(url, opts = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/* -------- LLM headline sentiment (optional) -------- */
async function llmSentiment(titles) {
  if (!ANTHROPIC_API_KEY || !titles.length) return null;
  const prompt =
    "Classify each crypto headline as Bullish, Bearish, or Neutral for the market. " +
    'Reply ONLY with a JSON array of objects {"i":<index>,"label":"Bullish|Bearish|Neutral"}.\n\n' +
    titles.map((t, i) => i + ". " + t).join("\n");
  try {
    const data = await getJSON("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    }, 15000);
    const text = (data.content || []).map((c) => c.text || "").join("");
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : null;
  } catch (e) {
    console.warn("LLM sentiment unavailable:", e.message);
    return null;
  }
}

/* -------- /api/news -------- */
app.get("/api/news", async (req, res) => {
  let items = [];
  try {
    if (CRYPTOPANIC_TOKEN) {
      const d = await getJSON(
        "https://cryptopanic.com/api/v1/posts/?auth_token=" + CRYPTOPANIC_TOKEN + "&kind=news&public=true"
      );
      items = (d.results || []).slice(0, 18).map((n) => ({
        title: n.title,
        url: n.url,
        source: n.source ? n.source.title : "CryptoPanic",
        ts: new Date(n.published_at).getTime(),
        categories: (n.currencies || []).map((c) => c.code).join("|"),
      }));
    } else {
      const d = await getJSON("https://min-api.cryptocompare.com/data/v2/news/?lang=EN");
      items = (d.Data || []).slice(0, 18).map((n) => ({
        title: n.title,
        url: n.url,
        source: n.source_info ? n.source_info.name : n.source,
        ts: n.published_on * 1000,
        categories: n.categories,
      }));
    }
  } catch (e) {
    return res.status(502).json({ error: "news unavailable", items: [] });
  }

  // Optional LLM enrichment of the headline label.
  let enriched = false;
  const labels = await llmSentiment(items.map((i) => i.title));
  if (labels) {
    enriched = true;
    labels.forEach((l) => { if (items[l.i]) items[l.i].label = l.label; });
  }
  res.json({ items, enriched });
});

/* -------- /api/whales -------- */
app.get("/api/whales", async (req, res) => {
  if (!WHALE_ALERT_KEY) return res.status(404).json({ error: "no whale key; client uses sample" });
  try {
    const d = await getJSON(
      "https://api.whale-alert.io/v1/transactions?api_key=" + WHALE_ALERT_KEY +
      "&min_value=1000000&currency=btc&limit=12"
    );
    const items = (d.transactions || []).map((t) => {
      const fromEx = t.from && t.from.owner_type === "exchange";
      const toEx = t.to && t.to.owner_type === "exchange";
      const dir = fromEx && !toEx ? "exchange_outflow" : toEx && !fromEx ? "exchange_inflow" : "wallet_to_wallet";
      return {
        amountBtc: Math.round(t.amount),
        usd: t.amount_usd,
        dir,
        from: t.from ? t.from.owner || "unknown" : "unknown",
        to: t.to ? t.to.owner || "unknown" : "unknown",
        minsAgo: Math.max(0, Math.round((Date.now() - t.timestamp * 1000) / 60000)),
      };
    });
    const net = items.reduce((s, x) =>
      s + (x.dir === "exchange_outflow" ? x.amountBtc : x.dir === "exchange_inflow" ? -x.amountBtc : 0), 0);
    res.json({ items, netToColdStorage: net });
  } catch (e) {
    res.status(502).json({ error: "whale-alert unavailable" });
  }
});

/* -------- /api/macro --------
 * The piece the browser-only build can't do: an economic calendar with FORECAST
 * and ACTUAL values (so "higher/lower than expected" works), an optional real
 * macro trend from the Fed (FRED), and an optional short LLM macro read. The
 * frontend folds these into the Long/Short Trade Signal; without this endpoint
 * it falls back to the headline-direction logic. */

// Parse a calendar number like "2.6%", "200K", "-1.3" -> number (or null).
function num(s) {
  if (s == null || s === "") return null;
  const str = String(s);
  const m = str.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (/k/i.test(str)) v *= 1e3;
  else if (/m/i.test(str)) v *= 1e6;
  else if (/b/i.test(str)) v *= 1e9;
  return v;
}

// Map an actual-vs-forecast surprise to a crypto direction (the cheat-sheet).
function surpriseDir(title, actual, forecast, previous) {
  if (actual == null) return 0;
  const t = (title || "").toLowerCase();
  if (/cpi|inflation|pce|price index/.test(t) && forecast != null)
    return actual < forecast ? 1 : actual > forecast ? -1 : 0;          // cooler inflation = bullish
  if (/payroll|non-?farm|nfp/.test(t) && forecast != null)
    return actual < forecast ? 1 : actual > forecast ? -1 : 0;          // weaker jobs = bullish
  if (/unemployment rate/.test(t) && forecast != null)
    return actual > forecast ? 1 : actual < forecast ? -1 : 0;          // higher unemployment = bullish
  if (/jobless|initial claims/.test(t) && forecast != null)
    return actual > forecast ? 1 : actual < forecast ? -1 : 0;          // more claims = bullish
  if (/rate decision|federal funds|interest rate/.test(t) && previous != null)
    return actual < previous ? 1 : actual > previous ? -1 : 0;          // rate cut = bullish
  return 0;
}

// Free ForexFactory-derived weekly calendar (no key). US high/medium impact.
async function fetchCalendar() {
  try {
    const d = await getJSON("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {}, 9000);
    if (!Array.isArray(d)) return [];
    return d
      .filter((e) => e.country === "USD" && (e.impact === "High" || e.impact === "Medium"))
      .map((e) => {
        const actual = num(e.actual), forecast = num(e.forecast), previous = num(e.previous);
        return {
          name: e.title, impact: e.impact, country: e.country,
          dateMs: Date.parse(e.date) || null,
          actual: e.actual || null, forecast: e.forecast || null, previous: e.previous || null,
          dir: surpriseDir(e.title || "", actual, forecast, previous),
        };
      })
      .slice(0, 16);
  } catch (e) {
    console.warn("calendar unavailable:", e.message);
    return [];
  }
}

// Optional real macro trend from the Federal Reserve (FRED). Needs FRED_API_KEY.
function fredTrend(a, b) { const d = a - b; return Math.abs(d) < 1e-9 ? "flat" : d > 0 ? "rising" : "falling"; }
async function fredSeries(id, limit) {
  const url = "https://api.stlouisfed.org/fred/series/observations?series_id=" + id +
    "&api_key=" + FRED_API_KEY + "&file_type=json&sort_order=desc&limit=" + limit;
  const d = await getJSON(url, {}, 9000);
  return (d.observations || []).map((o) => parseFloat(o.value)).filter((v) => !isNaN(v));
}
async function fetchFred() {
  if (!FRED_API_KEY) return null;
  try {
    const out = {};
    const un = await fredSeries("UNRATE", 4);
    if (un.length >= 2) out.unemployment = { latest: un[0], trend: fredTrend(un[0], un[1]) };
    const ff = await fredSeries("FEDFUNDS", 4);
    if (ff.length >= 2) out.rate = { latest: ff[0], trend: fredTrend(ff[0], ff[1]) };
    const cpi = await fredSeries("CPIAUCSL", 14); // YoY needs ~13 monthly points
    if (cpi.length >= 13) {
      const yoyNow = (cpi[0] / cpi[12] - 1) * 100;
      const yoyPrev = (cpi[1] / cpi[13] - 1) * 100;
      out.cpiYoY = { latest: +yoyNow.toFixed(2), trend: fredTrend(yoyNow, yoyPrev) };
    }
    return Object.keys(out).length ? out : null;
  } catch (e) {
    console.warn("FRED unavailable:", e.message);
    return null;
  }
}

// Optional: a short LLM macro read for crypto from the data above.
async function llmMacroSummary(calendar, fred) {
  if (!ANTHROPIC_API_KEY) return null;
  const recent = calendar.filter((c) => c.actual).slice(0, 8)
    .map((c) => c.name + ": actual " + c.actual + " vs forecast " + (c.forecast || "?") + " (prev " + (c.previous || "?") + ")").join("\n");
  const upcoming = calendar.filter((c) => !c.actual && c.dateMs && c.dateMs > Date.now()).slice(0, 6)
    .map((c) => c.name + " (forecast " + (c.forecast || "?") + ")").join("\n");
  const prompt =
    "You are a crypto macro analyst. Using the US macro data below, give a SHORT read for crypto over the next few days. " +
    "Rules: lower inflation, rate cuts, weaker jobs, more liquidity, dovish Fed = bullish; the opposite = bearish. " +
    'Reply ONLY as JSON {"bias":"Long|Short|Neutral","summary":"<=2 sentences"}.\n\n' +
    "Recent releases (actual vs forecast):\n" + (recent || "none") +
    "\n\nUpcoming:\n" + (upcoming || "none") +
    "\n\nFRED trend: " + (fred ? JSON.stringify(fred) : "n/a");
  try {
    const data = await getJSON("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    }, 15000);
    const text = (data.content || []).map((c) => c.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.warn("LLM macro summary unavailable:", e.message);
    return null;
  }
}

app.get("/api/macro", async (req, res) => {
  const calendar = await fetchCalendar();
  const fred = await fetchFred();
  const llm = await llmMacroSummary(calendar, fred);
  res.json({ calendar, fred, llm, updatedAt: Date.now() });
});

/* -------- health + static -------- */
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    keys: { cryptopanic: !!CRYPTOPANIC_TOKEN, whaleAlert: !!WHALE_ALERT_KEY, llm: !!ANTHROPIC_API_KEY, fred: !!FRED_API_KEY },
  })
);

app.use(express.static(ROOT));

app.listen(PORT, () => {
  console.log("CryptoPulse running on http://localhost:" + PORT);
  console.log("  news:   " + (CRYPTOPANIC_TOKEN ? "CryptoPanic (keyed)" : "CryptoCompare (free)"));
  console.log("  whales: " + (WHALE_ALERT_KEY ? "Whale Alert (keyed)" : "sample (client)"));
  console.log("  llm:    " + (ANTHROPIC_API_KEY ? "Claude sentiment + macro (keyed)" : "keyword classifier"));
  console.log("  macro:  /api/macro — calendar (free) + " + (FRED_API_KEY ? "FRED (keyed)" : "FRED off"));
});
