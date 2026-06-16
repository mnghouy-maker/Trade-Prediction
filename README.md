# CryptoPulse — Real-Time Bull / Bear Prediction Dashboard

Combine **news, technical indicators, fear detection, sentiment, whale activity and macro events** into one dashboard that turns hundreds of signals into a single clear prediction:

> **"Market is 74% bullish over the next 7 days — high confidence."**

Zero build, zero required API keys. All live data fetched in the browser from free public APIs. Just open the file.

---

## What's inside

The dashboard is organized into **6 tabs** so you can focus on what matters:

### Dashboard
The first thing you see. Big bull/bear score (0–100), direction with confidence, and the top signals driving the call. Includes a live **Fear Alert banner** that appears when a panic-triggering event is detected in the news — exchange hacks, government bans, military conflict, bank failures, etc.

### Markets
Coin screener for the top 100–250 coins. Each row shows live price, 1h/24h/7d change, a mini 7-day sparkline chart, and a bull/bear signal score. Click any row to load that coin into the Analysis and Trade tabs.

### Analysis
- **Technical Analysis** — price, RSI, MACD, 50-day and 200-day moving averages, % bullish checklist. Switch between BTC, ETH, or any coin selected from the screener.
- **AI Prediction Engine** — the weighted signal breakdown showing exactly why the model is bullish or bearish.
- **Backtesting** — replay the model over 1–3 years of history to see direction accuracy, win rate and profit factor.

### Trade
- **Trade Signal** — BUY / SELL / WAIT with entry price, stop loss, three take-profit targets, and risk:reward ratio for the selected coin.
- **Profit Calculator** — Binance-style futures PnL, ROE and liquidation price. Long or short, leverage, fees, by quantity or by position size. One-click fill from the live price, TP or stop.

### News
- **Live News Feed** — headlines from CryptoCompare, each classified as Bullish / Bearish / Neutral with an impact level. Fear-triggering headlines are flagged with a warning tag.
- **Sentiment Analysis** — positive/negative/neutral breakdown plus a **Fear Level score (0–100)** derived from how many panic-inducing events are in the current news cycle.
- **Whale Activity** — large BTC transfers between wallets and exchanges *(sample data — requires Whale Alert key for live)*.
- **Economic Calendar** — upcoming FOMC / CPI / NFP / GDP events with live countdowns.

### Tools
- **Price Alerts** — set alerts on BTC/ETH price, RSI, Fear & Greed index, or AI score. Fires browser notifications when triggered.
- **Prediction History** — every daily prediction graded against the real next-day BTC move, with running accuracy %.

---

## How the score works

Each signal contributes **+1 (bullish)** or **-1 (bearish)**, weighted by importance:

```
BTC above 200-day MA       x1.4    Total market cap change   x1.0
BTC above 50-day MA        x1.0    Fear & Greed index        x1.0
RSI (not overbought)       x1.2    News sentiment            x1.3
MACD bullish crossover     x1.1    Whale exchange flows      x0.9
ETH above 200-day MA       x0.9    Volume trend              x0.8
```

- **Raw signal sum** → direction: `≥ 3 = Bullish`, `0–2 = Neutral`, `< 0 = Bearish`
- **Weighted sum** normalized to a **0–100 AI score**
- **Confidence** = signal agreement %
- **Fear override** — if the Fear Level hits 40+, the news signal is forced bearish even if headlines are mixed

The fear detector scans for high-impact phrases: exchange collapses, government bans, war declarations, SEC charges, bank failures, stablecoin depegs, liquidation cascades, and more. One major fear event shifts the prediction even if technicals look fine.

---

## Run it

**Option A — open directly (no install)**
```bash
open index.html
```

**Option B — static server**
```bash
npm run static    # python3 -m http.server 8080
```

**Option C — with the optional backend**
```bash
npm install
cp .env.example .env    # add any keys you have
npm start               # http://localhost:8080
```

---

## Optional backend keys

All keys are optional. Set them in `.env` to upgrade specific data sources:

| Key | Upgrades | Without it |
|-----|----------|------------|
| `CRYPTOPANIC_TOKEN` | Real news feed from CryptoPanic | Free CryptoCompare feed |
| `WHALE_ALERT_KEY` | Live on-chain whale transfers | Sample data |
| `ANTHROPIC_API_KEY` | Claude LLM headline sentiment | Built-in keyword classifier |

Keys stay server-side, never sent to the browser.

---

## Deploy

- **Static (no backend):** GitHub Pages, Netlify, Vercel, Cloudflare Pages — drop-in. GitHub Pages workflow is included and auto-deploys on push to `main`.
- **With backend:** host `server/index.js` on Render, Railway, Fly.io, or any Node platform. Set env vars there and `npm start`.

---

## File structure

```
index.html          tabbed layout — Dashboard, Markets, Analysis, Trade, News, Tools
css/styles.css      dark theme with Inter font
js/config.js        API endpoints, signal weights, economic calendar seed
js/util.js          formatting and fetch helpers
js/indicators.js    SMA / EMA / RSI(14) / MACD(12,26,9)
js/api.js           all data fetching — always degrades to sample gracefully
js/sentiment.js     news classifier + fear level detector
js/score.js         signal builder → 0–100 AI score + fear override
js/alerts.js        price alerts and browser notifications
js/history.js       daily prediction recording and grading
js/backtest.js      historical model replay
js/markets.js       coin screener with sparkline signals
js/trade.js         entry/stop/target engine + futures PnL math
js/render.js        all DOM rendering including sparklines and fear banner
js/app.js           orchestration, tab wiring, refresh loop
server/index.js     optional Express backend for keyed data sources
.env.example        backend key template
```

---

## Disclaimer

For education and research only. Crypto markets are highly volatile. This is not financial advice. Sections marked SAMPLE use illustrative data, not live feeds.
