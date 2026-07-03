/*
 * Golden Spin — casino server
 * Standalone Express app. Serves the casino front-end and a JSON API.
 * All game outcomes are decided here on the server, never in the browser.
 *
 * Run:  npm run casino   (from the repo root)
 * Port: 8090 by default (CASINO_PORT env var to change)
 *
 * Data lives in casino/data/db.json (created on first run, gitignored).
 * First run also creates the admin account — credentials are printed
 * to the console once.
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.CASINO_PORT || 8090;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const COOKIE_NAME = "casino_session";
const SESSION_DAYS = 7;
const MAX_SPIN_LOG = 5000;

/* ---------------------------------------------------------------- *
 *  Database (simple JSON file — fine for a small customer base)
 * ---------------------------------------------------------------- */

let db = null;

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return;
  }
  // first run — create empty db + admin account
  const adminPass = process.env.CASINO_ADMIN_PASSWORD || "ChangeMe123";
  db = {
    secret: crypto.randomBytes(32).toString("hex"),
    nextId: 2,
    users: [
      {
        id: 1,
        username: "admin",
        name: "Admin",
        role: "admin",
        passHash: hashPassword(adminPass),
        balance: 10000,
        active: true,
        tokenVersion: 1,
        createdAt: Date.now(),
        lastLoginAt: null,
        totalWagered: 0,
        totalWon: 0,
      },
    ],
    spins: [],
  };
  saveDb();
  console.log("--------------------------------------------------");
  console.log("First run: admin account created");
  console.log("  username: admin");
  console.log("  password: " + adminPass);
  console.log("Change it after logging in (Admin > My account).");
  console.log("--------------------------------------------------");
}

function saveDb() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------------------------------------------------------------- *
 *  Passwords + session tokens (no extra dependencies)
 * ---------------------------------------------------------------- */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return salt + ":" + hash;
}

function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(test, "hex"), Buffer.from(hash, "hex"));
}

function signToken(user) {
  const payload = Buffer.from(
    JSON.stringify({
      uid: user.id,
      tv: user.tokenVersion,
      exp: Date.now() + SESSION_DAYS * 24 * 3600 * 1000,
    })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", db.secret).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verifyToken(token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [payload, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", db.secret).update(payload).digest("base64url");
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!data.uid || data.exp < Date.now()) return null;
  const user = db.users.find((u) => u.id === data.uid);
  if (!user || !user.active || user.tokenVersion !== data.tv) return null;
  return user;
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 3600;
  res.setHeader(
    "Set-Cookie",
    COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

/* ---------------------------------------------------------------- *
 *  Slot engine — 3 reels, 1 payline, weighted symbols
 *  RTP works out to about 92% (house edge ~8%), hit rate ~36%.
 * ---------------------------------------------------------------- */

const SYMBOLS = [
  { key: "cherry", weight: 5 },
  { key: "lemon", weight: 5 },
  { key: "bell", weight: 4 },
  { key: "star", weight: 3 },
  { key: "seven", weight: 2 },
  { key: "diamond", weight: 1 },
];
const TOTAL_WEIGHT = SYMBOLS.reduce((s, x) => s + x.weight, 0);

// multiplier applied to the bet
const PAY_TRIPLE = { cherry: 5, lemon: 5, bell: 10, star: 20, seven: 50, diamond: 200 };
const PAY_PAIR = { cherry: 2, bell: 1, star: 1, seven: 4 };

const ALLOWED_BETS = [1, 5, 10, 25, 50, 100];

function randomSymbol() {
  // crypto RNG, rejection-sampled so it's unbiased
  let r;
  do {
    r = crypto.randomBytes(1)[0];
  } while (r >= 256 - (256 % TOTAL_WEIGHT));
  r = r % TOTAL_WEIGHT;
  for (const s of SYMBOLS) {
    if (r < s.weight) return s.key;
    r -= s.weight;
  }
  return SYMBOLS[0].key; // unreachable
}

function evaluate(reels, bet) {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    return { multiplier: PAY_TRIPLE[a] || 0, kind: "triple", symbol: a };
  }
  // exactly two matching
  let pairSym = null;
  if (a === b || a === c) pairSym = a;
  else if (b === c) pairSym = b;
  if (pairSym && PAY_PAIR[pairSym]) {
    return { multiplier: PAY_PAIR[pairSym], kind: "pair", symbol: pairSym };
  }
  return { multiplier: 0, kind: "none", symbol: null };
}

/* ---------------------------------------------------------------- *
 *  App + middleware
 * ---------------------------------------------------------------- */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  const user = verifyToken(getCookie(req, COOKIE_NAME));
  if (!user) return res.status(401).json({ error: "Not logged in" });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, function () {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admins only" });
    next();
  });
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    balance: u.balance,
    active: u.active,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    totalWagered: u.totalWagered,
    totalWon: u.totalWon,
  };
}

/* ----------------------------- auth ----------------------------- */

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.users.find(
    (u) => u.username.toLowerCase() === String(username || "").toLowerCase().trim()
  );
  if (!user || !checkPassword(password || "", user.passHash)) {
    return res.status(401).json({ error: "Wrong username or password" });
  }
  if (!user.active) {
    return res.status(403).json({ error: "This account is disabled. Contact support." });
  }
  user.lastLoginAt = Date.now();
  saveDb();
  setSessionCookie(res, signToken(user));
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post("/api/change-password", requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(current || "", req.user.passHash)) {
    return res.status(400).json({ error: "Current password is wrong" });
  }
  if (!next || String(next).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  req.user.passHash = hashPassword(next);
  req.user.tokenVersion += 1;
  saveDb();
  setSessionCookie(res, signToken(req.user));
  res.json({ ok: true });
});

/* ----------------------------- game ----------------------------- */

app.get("/api/config", (req, res) => {
  res.json({
    symbols: SYMBOLS.map((s) => s.key),
    bets: ALLOWED_BETS,
    payTriple: PAY_TRIPLE,
    payPair: PAY_PAIR,
  });
});

app.post("/api/spin", requireAuth, (req, res) => {
  const bet = Number(req.body && req.body.bet);
  if (!ALLOWED_BETS.includes(bet)) {
    return res.status(400).json({ error: "Invalid bet amount" });
  }
  if (req.user.balance < bet) {
    return res.status(400).json({ error: "Not enough balance" });
  }

  const reels = [randomSymbol(), randomSymbol(), randomSymbol()];
  const result = evaluate(reels, bet);
  const win = bet * result.multiplier;

  req.user.balance = req.user.balance - bet + win;
  req.user.totalWagered += bet;
  req.user.totalWon += win;

  db.spins.push({
    userId: req.user.id,
    bet,
    reels,
    win,
    balanceAfter: req.user.balance,
    at: Date.now(),
  });
  if (db.spins.length > MAX_SPIN_LOG) db.spins = db.spins.slice(-MAX_SPIN_LOG);
  saveDb();

  res.json({
    reels,
    win,
    multiplier: result.multiplier,
    kind: result.kind,
    symbol: result.symbol,
    balance: req.user.balance,
  });
});

app.get("/api/history", requireAuth, (req, res) => {
  const mine = db.spins
    .filter((s) => s.userId === req.user.id)
    .slice(-50)
    .reverse();
  res.json({ spins: mine });
});

/* ----------------------------- admin ---------------------------- */

app.get("/api/admin/overview", requireAdmin, (req, res) => {
  const customers = db.users.filter((u) => u.role === "customer");
  const totalWagered = customers.reduce((s, u) => s + u.totalWagered, 0);
  const totalWon = customers.reduce((s, u) => s + u.totalWon, 0);
  res.json({
    stats: {
      customers: customers.length,
      active: customers.filter((u) => u.active).length,
      totalBalance: customers.reduce((s, u) => s + u.balance, 0),
      totalWagered,
      totalWon,
      houseProfit: totalWagered - totalWon,
      spins: db.spins.filter((s) => customers.some((c) => c.id === s.userId)).length,
    },
    customers: customers.map(publicUser),
  });
});

app.post("/api/admin/customers", requireAdmin, (req, res) => {
  const { username, name, password, balance } = req.body || {};
  const uname = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,20}$/.test(uname)) {
    return res.status(400).json({ error: "Username: 3-20 chars, letters/numbers/._- only" });
  }
  if (db.users.some((u) => u.username.toLowerCase() === uname)) {
    return res.status(400).json({ error: "That username is taken" });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const startBalance = Math.max(0, Math.floor(Number(balance) || 0));
  const user = {
    id: db.nextId++,
    username: uname,
    name: String(name || uname).trim().slice(0, 40),
    role: "customer",
    passHash: hashPassword(password),
    balance: startBalance,
    active: true,
    tokenVersion: 1,
    createdAt: Date.now(),
    lastLoginAt: null,
    totalWagered: 0,
    totalWon: 0,
  };
  db.users.push(user);
  saveDb();
  res.json({ user: publicUser(user) });
});

app.patch("/api/admin/customers/:id", requireAdmin, (req, res) => {
  const user = db.users.find((u) => u.id === Number(req.params.id) && u.role === "customer");
  if (!user) return res.status(404).json({ error: "Customer not found" });
  const body = req.body || {};

  if (body.balance !== undefined) {
    const v = Math.floor(Number(body.balance));
    if (isNaN(v) || v < 0) return res.status(400).json({ error: "Balance must be 0 or more" });
    user.balance = v;
  }
  if (body.adjust !== undefined) {
    const v = Math.floor(Number(body.adjust));
    if (isNaN(v)) return res.status(400).json({ error: "Adjust must be a number" });
    user.balance = Math.max(0, user.balance + v);
  }
  if (body.active !== undefined) {
    user.active = !!body.active;
    if (!user.active) user.tokenVersion += 1; // kick them out immediately
  }
  if (body.password !== undefined) {
    if (String(body.password).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    user.passHash = hashPassword(body.password);
    user.tokenVersion += 1;
  }
  if (body.name !== undefined) {
    user.name = String(body.name).trim().slice(0, 40) || user.name;
  }
  saveDb();
  res.json({ user: publicUser(user) });
});

app.get("/api/admin/customers/:id/history", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const spins = db.spins.filter((s) => s.userId === id).slice(-100).reverse();
  res.json({ spins });
});

app.delete("/api/admin/customers/:id", requireAdmin, (req, res) => {
  const idx = db.users.findIndex((u) => u.id === Number(req.params.id) && u.role === "customer");
  if (idx < 0) return res.status(404).json({ error: "Customer not found" });
  const removed = db.users.splice(idx, 1)[0];
  db.spins = db.spins.filter((s) => s.userId !== removed.id);
  saveDb();
  res.json({ ok: true });
});

/* ----------------------------- pages ---------------------------- */

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* ----------------------------------------------------------------- */

loadDb();
app.listen(PORT, () => {
  console.log("Golden Spin casino running on http://localhost:" + PORT);
  console.log("Admin panel: http://localhost:" + PORT + "/admin");
});
