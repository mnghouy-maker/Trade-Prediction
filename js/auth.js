/* Login gate.
 *
 * IMPORTANT — this is a SOFT gate, not real security.
 * CryptoPulse is a public, static site, so this check runs entirely in the
 * visitor's browser. Anyone who opens dev tools can read this file and bypass
 * it. It only keeps casual visitors out. For genuine protection the app would
 * need to be served behind a backend that authenticates server-side
 * (see server/index.js). The password is stored only as a salted, key-stretched
 * hash — never in plaintext — so dev tools / "view source" reveal no usable
 * password. That raises the bar against snooping but is still obfuscation, not
 * real security: the gate itself can still be bypassed client-side.
 *
 * The app (js/app.js) does not boot until login succeeds, so no market data is
 * fetched before sign-in. Login is remembered for the browser session only
 * (sessionStorage) — closing the tab requires signing in again.
 */
CP.auth = (function () {
  var USERNAME  = "admin";
  // Salted, key-stretched hash of the password — NOT the password itself, and
  // NOT a plain hash a lookup site can reverse. Recovering the password would
  // mean brute-forcing every candidate through ITER rounds of the salted hash.
  var SALT = "cp:8e21a9f4d7";
  var ITER = 2000;
  var PASS_HASH = "683254a7b47ab81f9c91475610eb3f06d45ca7a506fb28d722076b5a0d7f8946";
  var SESSION_KEY = "cp_auth_v1";

  // --- compact synchronous SHA-256 (geraintluff, public domain) ---
  // Used instead of crypto.subtle so the gate also works from file:// where
  // the Web Crypto API is unavailable.
  function sha256(ascii) {
    function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
    var mathPow = Math.pow, maxWord = mathPow(2, 32), i, j, result = "";
    var words = [];
    var asciiBitLength = ascii.length * 8;
    var hash = sha256.h = sha256.h || [];
    var k = sha256.k = sha256.k || [];
    var primeCounter = k.length;
    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) { isComposite[i] = candidate; }
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += "\x80";
    while (ascii.length % 64 - 56) ascii += "\x00";
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return ""; // non-ASCII input — treat as no match
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16);
      var oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? w[i] : (
              w[i - 16]
              + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
              + w[i - 7]
              + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
            ) | 0);
        var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) { hash[i] = (hash[i] + oldHash[i]) | 0; }
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? 0 : "") + b.toString(16);
      }
    }
    return result;
  }

  // Key-stretching: salt + ITER rounds of SHA-256. Slows brute-forcing of the
  // small password keyspace and makes the stored hash useless to rainbow tables.
  function hashPassword(pass) {
    var h = sha256(SALT + pass);
    for (var i = 0; i < ITER; i++) h = sha256(h);
    return h;
  }

  function isAuthed() {
    try { return sessionStorage.getItem(SESSION_KEY) === "1"; } catch (e) { return false; }
  }
  function setAuthed() { try { sessionStorage.setItem(SESSION_KEY, "1"); } catch (e) {} }
  function clearAuthed() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

  function unlock() {
    var screen = document.getElementById("loginScreen");
    if (screen) screen.classList.add("login-hidden");
    document.body.classList.remove("locked");
    var logout = document.getElementById("logoutBtn");
    if (logout) logout.classList.remove("hidden");
  }

  function showError(msg) {
    var err = document.getElementById("loginError");
    if (err) { err.textContent = msg; err.classList.add("show"); }
    var card = document.getElementById("loginCard");
    if (card) { card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake"); }
  }

  function attempt() {
    var userEl = document.getElementById("loginUser");
    var passEl = document.getElementById("loginPass");
    var user = (userEl && userEl.value || "").trim().toLowerCase();
    var pass = (passEl && passEl.value) || "";
    if (user === USERNAME && hashPassword(pass) === PASS_HASH) {
      setAuthed();
      unlock();
      if (CP.boot) CP.boot();
    } else {
      showError("Incorrect username or password.");
      if (passEl) { passEl.value = ""; passEl.focus(); }
    }
  }

  function logout() {
    clearAuthed();
    // When served by the backend, also drop the server session, then go to its
    // login page. On the static build /api/logout doesn't exist, so fall back
    // to a reload (which re-shows this client-side gate).
    fetch("/api/logout", { method: "POST" })
      .then(function (r) { if (r.ok) location.href = "/login"; else location.reload(); })
      .catch(function () { location.reload(); });
  }

  function init() {
    var form = document.getElementById("loginForm");
    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); attempt(); });
    var logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", logout);

    // CP_SERVER_AUTH is injected by the backend (server/index.js) — it only
    // serves the dashboard to an authenticated session, so the client gate is
    // unnecessary there and we boot straight in. Otherwise this is the static
    // build and the client gate applies.
    if (window.CP_SERVER_AUTH || isAuthed()) {
      unlock();
      if (CP.boot) CP.boot();
    } else {
      document.body.classList.add("locked");
      var userEl = document.getElementById("loginUser");
      if (userEl) userEl.focus();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  return { isAuthed: isAuthed, logout: logout };
})();
