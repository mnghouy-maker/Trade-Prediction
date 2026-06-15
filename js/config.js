/* Global configuration & shared namespace.
 * All modules attach to window.CP to keep things working from file:// (no ES modules). */
window.CP = window.CP || {};

CP.config = {
  // Auto-refresh interval for live data (ms)
  refreshInterval: 60 * 1000,

  // Coins tracked in the technical section
  coins: [
    { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
    { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  ],

  // Free / no-key, CORS-enabled endpoints. These run in the visitor's browser.
  api: {
    coingecko: "https://api.coingecko.com/api/v3",
    fearGreed: "https://api.alternative.me/fng/?limit=2",
    news: "https://min-api.cryptocompare.com/data/v2/news/?lang=EN",
  },

  // Signal weights for the composite AI score (0..100).
  weights: {
    above200ma: 1.4,
    above50ma: 1.0,
    rsi: 1.2,
    macd: 1.1,
    ethTrend: 0.9,
    marketCap: 1.0,
    fearGreed: 1.0,
    newsSentiment: 1.3,
    volume: 0.8,
    whales: 0.9,
  },

  // localStorage keys
  storage: {
    alerts: "cp_alerts_v1",
    history: "cp_history_v1",
    bearishNews: "cp_bearish_news_v1",
  },
};

// Macro / economic calendar seed (recurring, high-impact events).
// Dates are illustrative anchors; the renderer rolls them to the next occurrence.
CP.economicEvents = [
  { name: "FOMC Interest Rate Decision", impact: "High", anchor: "2026-06-17", periodDays: 42 },
  { name: "US CPI Inflation Report", impact: "High", anchor: "2026-06-10", periodDays: 30 },
  { name: "Non-Farm Payrolls (Jobs)", impact: "High", anchor: "2026-06-05", periodDays: 30 },
  { name: "US GDP Release", impact: "Medium", anchor: "2026-06-26", periodDays: 91 },
  { name: "PCE Inflation Index", impact: "Medium", anchor: "2026-06-27", periodDays: 30 },
  { name: "Initial Jobless Claims", impact: "Low", anchor: "2026-06-12", periodDays: 7 },
];
