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
 *   ANTHROPIC_API_KEY   LLM headline sentiment (model: claude-haiku-4-5-20251001)
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

/* -------- health + static -------- */
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    keys: { cryptopanic: !!CRYPTOPANIC_TOKEN, whaleAlert: !!WHALE_ALERT_KEY, llm: !!ANTHROPIC_API_KEY },
  })
);

app.use(express.static(ROOT));

app.listen(PORT, () => {
  console.log("CryptoPulse running on http://localhost:" + PORT);
  console.log("  news:   " + (CRYPTOPANIC_TOKEN ? "CryptoPanic (keyed)" : "CryptoCompare (free)"));
  console.log("  whales: " + (WHALE_ALERT_KEY ? "Whale Alert (keyed)" : "sample (client)"));
  console.log("  llm:    " + (ANTHROPIC_API_KEY ? "Claude sentiment (keyed)" : "keyword classifier"));
});
