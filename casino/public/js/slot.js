/* Golden Spin — slot game front-end.
 * The server decides every outcome; this file only animates and displays. */

(function () {
  let me = null;
  let config = null;
  let currentBet = 10;
  let spinning = false;
  let currentReels = ["cherry", "bell", "seven"]; // what's showing right now

  const $ = (id) => document.getElementById(id);

  /* ------------------------------ api ------------------------------ */

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    }, opts));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  /* ----------------------------- screens --------------------------- */

  function show(screen) {
    $("login-screen").classList.toggle("hidden", screen !== "login");
    $("game-screen").classList.toggle("hidden", screen !== "game");
  }

  async function boot() {
    try {
      const data = await api("/api/me");
      me = data.user;
      enterGame();
    } catch (e) {
      show("login");
    }
  }

  async function enterGame() {
    config = await api("/api/config");
    $("hello").textContent = me.name;
    $("admin-link").classList.toggle("hidden", me.role !== "admin");
    setBalance(me.balance);
    buildBetButtons();
    buildPaytable();
    fillReelsInitial();
    loadHistory();
    show("game");
  }

  /* ------------------------------ login ----------------------------- */

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").textContent = "";
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("login-username").value,
          password: $("login-password").value,
        }),
      });
      me = data.user;
      if (me.role === "admin") {
        window.location.href = "/admin";
      } else {
        enterGame();
      }
    } catch (err) {
      $("login-error").textContent = err.message;
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    window.location.reload();
  });

  /* ---------------------------- balance ----------------------------- */

  function setBalance(v) {
    me.balance = v;
    $("balance").textContent = v.toLocaleString();
  }

  /* --------------------------- bet buttons -------------------------- */

  function buildBetButtons() {
    const box = $("bet-buttons");
    box.innerHTML = "";
    config.bets.forEach((b) => {
      const btn = document.createElement("button");
      btn.className = "bet-btn" + (b === currentBet ? " selected" : "");
      btn.textContent = b;
      btn.addEventListener("click", () => {
        if (spinning) return;
        currentBet = b;
        box.querySelectorAll(".bet-btn").forEach((x) => x.classList.remove("selected"));
        btn.classList.add("selected");
      });
      box.appendChild(btn);
    });
  }

  /* ---------------------------- paytable ---------------------------- */

  function comboCell(sym, count) {
    let html = '<div class="combo">';
    for (let i = 0; i < count; i++) html += SYMBOL_SVG[sym];
    html += "</div>";
    return html;
  }

  function buildPaytable() {
    const rows = [];
    const tripleOrder = Object.entries(config.payTriple).sort((a, b) => b[1] - a[1]);
    tripleOrder.forEach(([sym, pay]) => {
      rows.push("<tr><td>" + comboCell(sym, 3) + '</td><td class="pays">x' + pay + "</td></tr>");
    });
    const pairOrder = Object.entries(config.payPair).sort((a, b) => b[1] - a[1]);
    pairOrder.forEach(([sym, pay]) => {
      rows.push("<tr><td>" + comboCell(sym, 2) + '</td><td class="pays">x' + pay + "</td></tr>");
    });
    $("paytable-body").innerHTML = rows.join("");
  }

  /* ------------------------------ reels ----------------------------- */

  function cellHtml(sym) {
    return '<div class="cell">' + SYMBOL_SVG[sym] + "</div>";
  }

  function fillReelsInitial() {
    currentReels.forEach((sym, i) => {
      const strip = document.querySelector("#reel-" + i + " .strip");
      strip.style.transition = "none";
      strip.style.transform = "translateY(0)";
      strip.innerHTML = cellHtml(sym);
    });
  }

  function randomFiller() {
    const keys = config.symbols;
    return keys[Math.floor(Math.random() * keys.length)];
  }

  // Animate one reel to land on `finalSym`. Resolves when the animation ends.
  function animateReel(i, finalSym, duration) {
    return new Promise((resolve) => {
      const reel = $("reel-" + i);
      const strip = reel.querySelector(".strip");
      const cellH = reel.clientHeight;

      const fillerCount = 14 + i * 5;
      let html = cellHtml(currentReels[i]);
      for (let k = 0; k < fillerCount; k++) html += cellHtml(randomFiller());
      html += cellHtml(finalSym);
      strip.innerHTML = html;

      strip.style.transition = "none";
      strip.style.transform = "translateY(0)";
      strip.getBoundingClientRect(); // force reflow so the transition applies

      strip.style.transition = "transform " + duration + "ms cubic-bezier(0.15, 0.6, 0.25, 1)";
      strip.style.transform = "translateY(-" + (fillerCount + 1) * cellH + "px)";

      const done = () => {
        strip.removeEventListener("transitionend", done);
        // collapse the strip back to a single cell so the DOM stays small
        strip.style.transition = "none";
        strip.style.transform = "translateY(0)";
        strip.innerHTML = cellHtml(finalSym);
        resolve();
      };
      strip.addEventListener("transitionend", done);
      // safety net in case transitionend doesn't fire (tab in background)
      setTimeout(done, duration + 400);
    });
  }

  /* ------------------------------ spin ------------------------------ */

  $("spin-btn").addEventListener("click", async () => {
    if (spinning) return;
    const line = $("result-line");

    if (me.balance < currentBet) {
      line.className = "result-line lose";
      line.textContent = "Not enough balance — ask us to top you up.";
      return;
    }

    spinning = true;
    $("spin-btn").disabled = true;
    line.className = "result-line";
    line.innerHTML = "&nbsp;";
    document.querySelectorAll(".reel").forEach((r) => r.classList.remove("win-flash"));

    let result;
    try {
      result = await api("/api/spin", {
        method: "POST",
        body: JSON.stringify({ bet: currentBet }),
      });
    } catch (err) {
      line.className = "result-line lose";
      line.textContent = err.message;
      spinning = false;
      $("spin-btn").disabled = false;
      return;
    }

    // show the bet leaving the balance while the reels spin
    setBalance(me.balance - currentBet);

    await Promise.all([
      animateReel(0, result.reels[0], 900),
      animateReel(1, result.reels[1], 1400),
      animateReel(2, result.reels[2], 1900),
    ]);

    currentReels = result.reels.slice();
    setBalance(result.balance);

    if (result.win > 0) {
      line.className = "result-line win";
      const what = result.kind === "triple" ? "Three " : "Two ";
      line.textContent = what + SYMBOL_NAME[result.symbol] + "s! You win " + result.win.toLocaleString() + " (x" + result.multiplier + ")";
      document.querySelectorAll(".reel").forEach((r) => r.classList.add("win-flash"));
    } else {
      line.className = "result-line lose";
      line.textContent = "No luck this time.";
    }

    loadHistory();
    spinning = false;
    $("spin-btn").disabled = false;
  });

  /* ----------------------------- history ---------------------------- */

  async function loadHistory() {
    try {
      const data = await api("/api/history");
      const list = $("history-list");
      if (!data.spins.length) {
        list.innerHTML = '<li><span>No spins yet</span></li>';
        return;
      }
      list.innerHTML = data.spins.map((s) => {
        const t = new Date(s.at);
        const time = t.getHours().toString().padStart(2, "0") + ":" + t.getMinutes().toString().padStart(2, "0");
        const net = s.win - s.bet;
        const cls = net >= 0 && s.win > 0 ? "win" : "lose";
        const amt = (net > 0 ? "+" : "") + net.toLocaleString();
        return "<li><span>" + time + " · bet " + s.bet + "</span><span class=\"amt " + cls + "\">" + amt + "</span></li>";
      }).join("");
    } catch (e) { /* not fatal */ }
  }

  boot();
})();
