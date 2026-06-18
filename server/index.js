/* CryptoPulse backend — with real, server-side login.
 *
 * Serves the dashboard AND key-enriched API routes, but now behind a session
 * gate: the password is checked on the server and never reaches the browser, and
 * the dashboard files/data are only served to a logged-in session. This is the
 * only setup that genuinely keeps people out (unlike the static client-side
 * gate, which anyone can bypass in dev tools).
 *
 * CREDENTIALS LIVE IN ENV VARS — never in the repo or the browser:
 *   AUTH_USER        username (default "admin")
 *   AUTH_PASS        password (plaintext, set on the host only)   — or —
 *   AUTH_PASS_HASH   scrypt hash "saltHex:hashHex" (see .env.example to generate)
 *   SESSION_SECRET   random string used to sign session cookies (set one!)
 * If neither AUTH_PASS nor AUTH_PASS_HASH is set, login is disabled (fail closed).
 *
 * Optional data keys (unchanged, all optional):
 *   CRYPTOPANIC_TOKEN, WHALE_ALERT_KEY, ANTHROPIC_API_KEY
 *
 * Run:  npm install && AUTH_PASS=yourpassword npm start   (default http://localhost:8080)
 */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
// Load .env if present (dotenv optional — server runs fine without it).
try { require("dotenv").config(); } catch (e) { /* dotenv not installed; that's fine */ }
const express = require("express");

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, "..");

const CRYPTOPANIC_TOKEN = process.env.CRYPTOPANIC_TOKEN || "";
const WHALE_ALERT_KEY = process.env.WHALE_ALERT_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

/* ===================== AUTH ===================== */
const AUTH_USER = (process.env.AUTH_USER || "admin").trim().toLowerCase();
const AUTH_PASS = process.env.AUTH_PASS || "";
const AUTH_PASS_HASH = process.env.AUTH_PASS_HASH || ""; // "saltHex:hashHex" (scrypt)
const AUTH_ENABLED = !!(AUTH_PASS || AUTH_PASS_HASH);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE = "cp_session";

function verifyPassword(input) {
  input = String(input || "");
  if (AUTH_PASS_HASH) {
    const parts = AUTH_PASS_HASH.split(":");
    if (parts.length !== 2) return false;
    let derived;
    try { derived = crypto.scryptSync(input, Buffer.from(parts[0], "hex"), 32); }
    catch (e) { return false; }
    const expected = Buffer.from(parts[1], "hex");
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  }
  if (AUTH_PASS) {
    const a = Buffer.from(input);
    const b = Buffer.from(AUTH_PASS);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false;
}

function sign(data) { return crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url"); }
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ u: AUTH_USER, exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return payload + "." + sign(payload);
}
function validToken(token) {
  if (!token || token.indexOf(".") < 0) return false;
  const i = token.lastIndexOf(".");
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  const good = sign(payload);
  if (good.length !== sig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return false;
  let exp;
  try { exp = JSON.parse(Buffer.from(payload, "base64url").toString()).exp; } catch (e) { return false; }
  return !!exp && Date.now() < exp;
}
function readCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function isAuthed(req) { return validToken(readCookies(req)[COOKIE]); }
function setSession(req, res) {
  const https = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie",
    COOKIE + "=" + makeToken() + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" +
    Math.floor(SESSION_TTL_MS / 1000) + (https ? "; Secure" : ""));
}
function clearSession(res) {
  res.setHeader("Set-Cookie", COOKIE + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

// Login page (self-contained) + dashboard HTML with a flag so the client-side
// gate is skipped (the server has already authenticated this request).
const LOGIN_PAGE = (function () {
  try { return fs.readFileSync(path.join(__dirname, "login.html"), "utf8"); }
  catch (e) { return "<!doctype html><meta charset=utf-8><title>Log in</title><p>Login page missing.</p>"; }
})();
const INDEX_HTML = (function () {
  try {
    return fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
      .replace("<head>", '<head>\n  <script>window.CP_SERVER_AUTH=true;</script>\n  <style>#loginScreen{display:none!important}</style>');
  } catch (e) { return ""; }
})();

/* -------- shared fetch helper -------- */
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

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* -------- public routes (no session required) -------- */
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    auth: AUTH_ENABLED,
    keys: { cryptopanic: !!CRYPTOPANIC_TOKEN, whaleAlert: !!WHALE_ALERT_KEY, llm: !!ANTHROPIC_API_KEY },
  })
);

app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/");
  res.type("html").send(LOGIN_PAGE);
});

app.post("/api/login", (req, res) => {
  if (!AUTH_ENABLED) return res.status(503).json({ ok: false, error: "Login is not configured on the server." });
  const user = String((req.body && req.body.user) || "").trim().toLowerCase();
  const pass = (req.body && req.body.pass) || "";
  if (user === AUTH_USER && verifyPassword(pass)) {
    setSession(req, res);
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false });
});

app.post("/api/logout", (req, res) => { clearSession(res); res.json({ ok: true }); });

/* -------- auth gate: everything below requires a valid session -------- */
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.method === "GET" && (req.headers.accept || "").indexOf("text/html") > -1) {
    return res.redirect(302, "/login");
  }
  return res.status(401).json({ error: "auth required" });
});

/* -------- protected: dashboard HTML (client gate skipped via injected flag) -------- */
app.get(["/", "/index.html"], (req, res, next) => {
  if (!INDEX_HTML) return next(); // fall back to static if read failed
  res.type("html").send(INDEX_HTML);
});

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

/* -------- protected static assets (js, css, etc.) -------- */
app.use(express.static(ROOT, { dotfiles: "ignore" }));

app.listen(PORT, () => {
  console.log("CryptoPulse running on http://localhost:" + PORT);
  console.log("  auth:   " + (AUTH_ENABLED
    ? "ENABLED (user '" + AUTH_USER + "')"
    : "DISABLED — set AUTH_PASS (or AUTH_PASS_HASH) to allow login"));
  if (!process.env.SESSION_SECRET) {
    console.log("  note:   SESSION_SECRET not set — using a random one (sessions drop on restart)");
  }
  console.log("  news:   " + (CRYPTOPANIC_TOKEN ? "CryptoPanic (keyed)" : "CryptoCompare (free)"));
  console.log("  whales: " + (WHALE_ALERT_KEY ? "Whale Alert (keyed)" : "sample (client)"));
  console.log("  llm:    " + (ANTHROPIC_API_KEY ? "Claude sentiment (keyed)" : "keyword classifier"));
});
