/* Golden Spin — admin panel */

(function () {
  const $ = (id) => document.getElementById(id);
  let customers = [];

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    }, opts));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ------------------------------ boot ------------------------------ */

  async function boot() {
    try {
      const data = await api("/api/me");
      if (data.user.role !== "admin") {
        window.location.href = "/";
        return;
      }
    } catch (e) {
      window.location.href = "/";
      return;
    }
    $("admin-screen").classList.remove("hidden");
    refresh();
  }

  async function refresh() {
    const data = await api("/api/admin/overview");
    customers = data.customers;
    renderStats(data.stats);
    renderCustomers();
  }

  /* ------------------------------ stats ----------------------------- */

  function renderStats(s) {
    const profitCls = s.houseProfit >= 0 ? "green" : "red";
    $("stat-grid").innerHTML = `
      <div class="stat"><div class="k">Customers</div><div class="v">${s.customers}</div></div>
      <div class="stat"><div class="k">Active</div><div class="v">${s.active}</div></div>
      <div class="stat"><div class="k">Customer balance</div><div class="v gold">${s.totalBalance.toLocaleString()}</div></div>
      <div class="stat"><div class="k">Total wagered</div><div class="v">${s.totalWagered.toLocaleString()}</div></div>
      <div class="stat"><div class="k">House profit</div><div class="v ${profitCls}">${s.houseProfit.toLocaleString()}</div></div>
      <div class="stat"><div class="k">Spins</div><div class="v">${s.spins.toLocaleString()}</div></div>`;
  }

  /* ---------------------------- customers --------------------------- */

  function fmtDate(ts) {
    if (!ts) return "Never";
    const d = new Date(ts);
    return d.toLocaleDateString() + " " + d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  }

  function renderCustomers() {
    if (!customers.length) {
      $("customer-rows").innerHTML = '<tr><td colspan="7" style="color:var(--muted);">No customers yet — add one on the right.</td></tr>';
      return;
    }
    $("customer-rows").innerHTML = customers.map((c) => `
      <tr>
        <td><strong>${esc(c.name)}</strong><br><span style="color:var(--muted);font-size:12px;">@${esc(c.username)}</span></td>
        <td class="num" style="color:var(--gold-2);font-weight:600;">${c.balance.toLocaleString()}</td>
        <td class="num">${c.totalWagered.toLocaleString()}</td>
        <td class="num">${c.totalWon.toLocaleString()}</td>
        <td><span class="pill ${c.active ? "on" : "off"}">${c.active ? "Active" : "Disabled"}</span></td>
        <td style="color:var(--muted);font-size:12px;">${fmtDate(c.lastLoginAt)}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-sm" data-act="balance" data-id="${c.id}">Balance</button>
            <button class="btn btn-sm" data-act="toggle" data-id="${c.id}">${c.active ? "Disable" : "Enable"}</button>
            <button class="btn btn-sm" data-act="password" data-id="${c.id}">Password</button>
            <button class="btn btn-sm" data-act="history" data-id="${c.id}">History</button>
            <button class="btn btn-sm btn-danger" data-act="delete" data-id="${c.id}">Delete</button>
          </div>
        </td>
      </tr>`).join("");
  }

  $("customer-rows").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const c = customers.find((x) => x.id === Number(btn.dataset.id));
    if (!c) return;
    const act = btn.dataset.act;
    if (act === "balance") openBalanceModal(c);
    else if (act === "toggle") toggleActive(c);
    else if (act === "password") openPasswordModal(c);
    else if (act === "history") openHistoryModal(c);
    else if (act === "delete") openDeleteModal(c);
  });

  /* ------------------------------ modal ------------------------------ */

  function openModal(html) {
    $("modal-body").innerHTML = html;
    $("modal-back").classList.remove("hidden");
  }
  function closeModal() {
    $("modal-back").classList.add("hidden");
  }
  $("modal-back").addEventListener("click", (e) => {
    if (e.target.id === "modal-back") closeModal();
  });

  /* --------------------------- balance edit -------------------------- */

  function openBalanceModal(c) {
    openModal(`
      <h3>Balance — ${esc(c.name)}</h3>
      <div class="sub">Current balance: <strong style="color:var(--gold-2);">${c.balance.toLocaleString()}</strong></div>
      <label>Add or remove credits (use a minus sign to remove)</label>
      <input id="m-adjust" type="number" step="1" placeholder="e.g. 500 or -200">
      <label>Or set the exact balance</label>
      <input id="m-set" type="number" min="0" step="1" placeholder="e.g. 1000">
      <div class="form-error" id="m-error"></div>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">Cancel</button>
        <button class="btn-gold" id="m-save" style="padding:10px 22px;">Save</button>
      </div>`);
    $("m-cancel").addEventListener("click", closeModal);
    $("m-save").addEventListener("click", async () => {
      const adjust = $("m-adjust").value.trim();
      const set = $("m-set").value.trim();
      const body = {};
      if (set !== "") body.balance = Number(set);
      else if (adjust !== "") body.adjust = Number(adjust);
      else { $("m-error").textContent = "Enter an amount in one of the fields."; return; }
      try {
        await api("/api/admin/customers/" + c.id, { method: "PATCH", body: JSON.stringify(body) });
        closeModal();
        refresh();
      } catch (err) {
        $("m-error").textContent = err.message;
      }
    });
  }

  /* --------------------------- enable/disable ------------------------ */

  async function toggleActive(c) {
    try {
      await api("/api/admin/customers/" + c.id, {
        method: "PATCH",
        body: JSON.stringify({ active: !c.active }),
      });
      refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  /* --------------------------- password reset ------------------------ */

  function openPasswordModal(c) {
    openModal(`
      <h3>Reset password — ${esc(c.name)}</h3>
      <div class="sub">They will be logged out everywhere and need the new password.</div>
      <label>New password</label>
      <input id="m-pass" type="text" placeholder="At least 6 characters">
      <div class="form-error" id="m-error"></div>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">Cancel</button>
        <button class="btn-gold" id="m-save" style="padding:10px 22px;">Reset</button>
      </div>`);
    $("m-cancel").addEventListener("click", closeModal);
    $("m-save").addEventListener("click", async () => {
      try {
        await api("/api/admin/customers/" + c.id, {
          method: "PATCH",
          body: JSON.stringify({ password: $("m-pass").value }),
        });
        closeModal();
        refresh();
      } catch (err) {
        $("m-error").textContent = err.message;
      }
    });
  }

  /* ------------------------------ history ---------------------------- */

  async function openHistoryModal(c) {
    let spins = [];
    try {
      const data = await api("/api/admin/customers/" + c.id + "/history");
      spins = data.spins;
    } catch (err) {
      alert(err.message);
      return;
    }
    const rows = spins.length
      ? spins.map((s) => {
          const d = new Date(s.at);
          const net = s.win - s.bet;
          const col = net > 0 ? "var(--green)" : net < 0 ? "var(--red)" : "var(--muted)";
          const reels = s.reels.map((r) => SYMBOL_NAME[r] || r).join(" · ");
          return `<tr>
            <td style="color:var(--muted);font-size:12px;">${d.toLocaleDateString()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}</td>
            <td class="num">${s.bet}</td>
            <td style="font-size:12px;">${reels}</td>
            <td class="num" style="color:${col};font-weight:600;">${net > 0 ? "+" : ""}${net.toLocaleString()}</td>
          </tr>`;
        }).join("")
      : '<tr><td colspan="4" style="color:var(--muted);">No spins yet.</td></tr>';
    openModal(`
      <h3>Spin history — ${esc(c.name)}</h3>
      <div class="sub">Last ${spins.length} spins, newest first.</div>
      <div class="table-scroll">
        <table class="data">
          <thead><tr><th>When</th><th>Bet</th><th>Reels</th><th>Net</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">Close</button>
      </div>`);
    $("m-cancel").addEventListener("click", closeModal);
  }

  /* ------------------------------ delete ----------------------------- */

  function openDeleteModal(c) {
    openModal(`
      <h3>Delete ${esc(c.name)}?</h3>
      <div class="sub">This removes the account and its spin history for good. If you just want to block access, use Disable instead.</div>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">Cancel</button>
        <button class="btn-danger btn" id="m-delete">Delete account</button>
      </div>`);
    $("m-cancel").addEventListener("click", closeModal);
    $("m-delete").addEventListener("click", async () => {
      try {
        await api("/api/admin/customers/" + c.id, { method: "DELETE" });
        closeModal();
        refresh();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  /* --------------------------- create customer ----------------------- */

  $("create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("create-error").textContent = "";
    $("create-ok").classList.add("hidden");
    try {
      const data = await api("/api/admin/customers", {
        method: "POST",
        body: JSON.stringify({
          username: $("c-username").value,
          name: $("c-name").value,
          password: $("c-password").value,
          balance: $("c-balance").value,
        }),
      });
      $("create-ok").textContent = "Created @" + data.user.username + ". Give them the username and password you set.";
      $("create-ok").classList.remove("hidden");
      $("create-form").reset();
      $("c-balance").value = "0";
      refresh();
    } catch (err) {
      $("create-error").textContent = err.message;
    }
  });

  /* ----------------------------- my account -------------------------- */

  $("my-account-btn").addEventListener("click", () => {
    openModal(`
      <h3>Change my password</h3>
      <label>Current password</label>
      <input id="m-current" type="password">
      <label>New password</label>
      <input id="m-next" type="password" placeholder="At least 6 characters">
      <div class="form-error" id="m-error"></div>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">Cancel</button>
        <button class="btn-gold" id="m-save" style="padding:10px 22px;">Change</button>
      </div>`);
    $("m-cancel").addEventListener("click", closeModal);
    $("m-save").addEventListener("click", async () => {
      try {
        await api("/api/change-password", {
          method: "POST",
          body: JSON.stringify({ current: $("m-current").value, next: $("m-next").value }),
        });
        closeModal();
      } catch (err) {
        $("m-error").textContent = err.message;
      }
    });
  });

  $("logout-btn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/";
  });

  boot();
})();
