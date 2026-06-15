# 📈 CryptoPulse — Real-Time Bull / Bear Prediction Dashboard

Combine **news, technical indicators, sentiment, market data, whale activity and macro events** into one dashboard that turns hundreds of signals into a single clear probability:

> **“Market is 74% bullish over the next 7 days.”**

It is a **zero-build, zero-API-key** static web app. All live data is fetched in the
browser from free, CORS-enabled public APIs, and every indicator, score and backtest
is computed client-side. There is nothing to install — just open it.

---

## ✨ What's inside (all 10 sections)

| # | Section | Source |
|---|---------|--------|
| 0 | **Hero probability gauge** — one bull/bear meter, score 0–100, confidence, reasons | computed |
| 1 | **Market Overview** — BTC/ETH trend, market cap, Fear & Greed, overall signal | CoinGecko + Alternative.me |
| 2 | **Live News Feed** — headlines with impact level + AI sentiment | CryptoCompare |
| 3 | **Technical Analysis** — price, 24h, volume, RSI, MACD, 50/200-day MA, % bullish | CoinGecko (computed) |
| 4 | **Sentiment Analysis** — positive/negative/neutral %, trending coins | news-derived |
| 5 | **Whale Activity** — large transfers, exchange in/out flow *(sample data)* | sample* |
| 6 | **Economic Calendar** — FOMC / CPI / NFP / GDP with countdowns | built-in seed |
| 7 | **AI Prediction Engine** — weighted score, direction, confidence, reasons | computed |
| 8 | **Price Alerts** — BTC/ETH price, RSI, F&G, AI score, bearish-news + browser notifications | local |
| 9 | **Backtesting** — replay the model over 1–3 years, win rate / profit factor / accuracy | CoinGecko (computed) |
| 10 | **Prediction History** — every daily call graded against the real move | localStorage |

\* Whale flows and true social-media (X/Reddit/Telegram) sentiment require paid API
keys, so they ship as clearly-labelled **SAMPLE** data. See *Going further* below.

---

## 🧮 How the score works

Each signal contributes **+1 (bullish)** or **−1 (bearish)**, weighted by importance:

```
BTC above 200-day MA   = +1      Total market cap up    = +1
BTC above 50-day MA    = +1      Fear & Greed > 55      = +1
RSI > 50 (not >70)     = +1      Positive news          = +1
MACD bullish crossover = +1      Whales leaving exchange= +1
ETH above 200-day MA   = +1      High selling volume    = -1
```

- **Raw signal sum** → direction: `≥ 3 = Bullish`, `0–2 = Neutral`, `< 0 = Bearish`.
- **Weighted sum** is normalised to a **0–100 AI score** (read as *% bullish over 7 days*).
- **Confidence** = how lopsided the signals are (agreement %).

Indicator math (SMA, EMA, **Wilder's RSI(14)**, **MACD 12/26/9**) lives in
[`js/indicators.js`](js/indicators.js); the engine is in [`js/score.js`](js/score.js).

---

## 🚀 Run it

**Option A — just open the file (fully standalone, no install)**

```bash
open index.html        # macOS   (or double-click it)
```

**Option B — static server**

```bash
npm run static         # -> python3 -m http.server 8080
```

or any static server: `npx serve`, VS Code Live Server, etc.

**Option C — with the optional backend (real keys for news/whales/LLM)**

```bash
npm install            # express (+ optional dotenv)
cp .env.example .env   # add any keys you have (all optional)
npm start              # -> http://localhost:8080
```

The backend serves the same dashboard and, when keys are present, upgrades the
news, whale and sentiment data. The frontend auto-detects it: served by the
backend it uses the keyed routes; on GitHub Pages / `file://` it falls straight
back to the free public APIs and sample data. **It always works either way.**

---

## 🔌 Optional backend & live keys

[`server/index.js`](server/index.js) is a small Express app. All keys are
**optional** — set only what you have in `.env` (see [`.env.example`](.env.example)):

| Env var | Upgrades | Without it |
|---------|----------|------------|
| `CRYPTOPANIC_TOKEN` | Real news feed ([CryptoPanic](https://cryptopanic.com/developers/api/)) | Free CryptoCompare feed |
| `WHALE_ALERT_KEY` | Live exchange flows ([Whale Alert](https://docs.whale-alert.io/)) | Clearly-labelled SAMPLE whales |
| `ANTHROPIC_API_KEY` | LLM headline sentiment (Claude) | Built-in keyword classifier |

Keys stay server-side — they are never shipped to the browser. The data layer is
isolated in [`js/api.js`](js/api.js) (`tryBackend` → public API → sample), so you
can point `CP.config.backend.base` at a separately-hosted API if you split the
frontend and backend.

Further extensions: aggregate X / Reddit / Telegram social sentiment server-side,
and swap the built-in macro seed in `js/config.js` for a live economic-calendar API.

---

## ☁️ Deploy

- **Static (no backend):** GitHub Pages, Netlify, Vercel, Cloudflare Pages — drop-in.
  - GitHub Pages workflow included: [`.github/workflows/pages.yml`](.github/workflows/pages.yml) (auto-deploys `main`).
  - [`netlify.toml`](netlify.toml) and [`vercel.json`](vercel.json) included.
- **With backend:** host `server/index.js` on any Node platform (Render, Railway,
  Fly.io), set the env vars there, and `npm start`.

---

## 📁 Structure

```
index.html          markup for all sections
css/styles.css      dark dashboard theme
js/config.js        endpoints, weights, calendar seed
js/util.js          formatting + fetch helpers
js/indicators.js    SMA / EMA / RSI / MACD
js/api.js           data fetching with graceful sample fallback
js/sentiment.js     keyword news-sentiment classifier
js/score.js         signal builder + 0–100 engine
js/alerts.js        price alerts + notifications
js/history.js       prediction history + grading
js/backtest.js      historical replay
js/render.js        all DOM rendering
js/app.js           orchestration + refresh loop
server/index.js     optional Express backend (keyed news/whales/LLM)
.env.example        backend key template (all optional)
```

---

## ⚠️ Disclaimer

For **education and research only**. Crypto markets are volatile; this is **not
financial advice**. Sample-labelled sections are illustrative, not real-time.
