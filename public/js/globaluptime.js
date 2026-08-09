/* ═══════════════════════════════════════════
   GLOBAL UPTIME HISTORY VIEW
═══════════════════════════════════════════ */

const PERIODS = ["daily", "weekly", "monthly", "yearly"];

function formatPeriodLabel(period, entry, ap) {
  const locale = ap?.language === "en" ? "en-US" : "es-ES";
  if (period === "daily") {
    try {
      return new Date(entry.date + "T12:00:00").toLocaleDateString(locale, {
        day: "numeric", month: "short", year: "numeric",
      });
    } catch { return entry.date; }
  }
  if (period === "weekly") {
    return `${entry.year} · W${String(entry.week).padStart(2, "0")}`;
  }
  if (period === "monthly") {
    try {
      return new Date(entry.year, entry.month - 1, 1).toLocaleDateString(locale, {
        month: "long", year: "numeric",
      });
    } catch { return `${entry.year}-${String(entry.month).padStart(2, "0")}`; }
  }
  return String(entry.year);
}

function periodTitle(period, texts) {
  const map = {
    daily: texts["global-uptime-period-day"] || "Día",
    weekly: texts["global-uptime-period-week"] || "Semana",
    monthly: texts["global-uptime-period-month"] || "Mes",
    yearly: texts["global-uptime-period-year"] || "Año",
  };
  return map[period] || period;
}

function renderGlobalUptime(container, data) {
  const texts = window.__STATUS_TEXTS__ || {};
  const ap = window.__APPEARANCE__ || {};
  const globalUptime = data?.globalUptime || { daily: [], weekly: [], monthly: [], yearly: [] };

  container.innerHTML = "";

  /* ── Nav ──────────────────────────────── */
  const nav = document.createElement("div");
  nav.className = "svc-nav";

  const backBtn = document.createElement("button");
  backBtn.className = "svc-back-btn";
  backBtn.setAttribute("aria-label", "Back to home");
  const backIcon = document.createElement("i");
  backIcon.className = "fa-solid fa-arrow-left";
  backIcon.setAttribute("aria-hidden", "true");
  backBtn.appendChild(backIcon);
  backBtn.appendChild(document.createTextNode(` ${texts["global-uptime-back"] || "Volver"}`));
  backBtn.addEventListener("click", navigateHome);
  nav.appendChild(backBtn);

  const navBrand = document.createElement("div");
  navBrand.className = "svc-nav-brand";
  if (ap.logoUrl) {
    const navLogo = document.createElement("img");
    navLogo.src = ap.logoUrl;
    navLogo.alt = ap.siteTitle || "Status";
    navLogo.width = 22; navLogo.height = 22;
    navBrand.appendChild(navLogo);
  }
  navBrand.appendChild(document.createTextNode(ap.siteTitle || texts["footer-default"] || "Status"));
  nav.appendChild(navBrand);
  container.appendChild(nav);

  /* ── Title ────────────────────────────── */
  container.appendChild(el("h1", texts["global-uptime-title"] || "Disponibilidad global", "global-uptime-title"));

  /* ── Period tabs ──────────────────────── */
  const tabsWrap = document.createElement("div");
  tabsWrap.className = "period-tabs";
  const tableWrap = document.createElement("div");
  tableWrap.className = "uptime-table-wrap";

  let activePeriod = "daily";

  function renderTable() {
    tableWrap.innerHTML = "";
    const entries = globalUptime[activePeriod] || [];

    if (entries.length === 0) {
      const noData = document.createElement("div");
      noData.className = "svc-no-data";
      const icon = document.createElement("i");
      icon.className = "fa-solid fa-chart-line";
      icon.setAttribute("aria-hidden", "true");
      noData.appendChild(icon);
      noData.appendChild(document.createTextNode(` ${texts["global-uptime-no-data"] || "Sin datos disponibles"}`));
      tableWrap.appendChild(noData);
      return;
    }

    const table = document.createElement("table");
    table.className = "uptime-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const thPeriod = document.createElement("th");
    thPeriod.textContent = texts["global-uptime-date"] || "Periodo";
    const thValue = document.createElement("th");
    thValue.textContent = texts["global-uptime-availability"] || "Disponibilidad";
    headRow.appendChild(thPeriod);
    headRow.appendChild(thValue);
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    // Mostrar del más reciente al más antiguo
    const reversed = [...entries].reverse();
    for (const entry of reversed) {
      const row = document.createElement("tr");
      row.className = "uptime-row";

      const tdPeriod = document.createElement("td");
      tdPeriod.className = "uptime-cell uptime-period";
      tdPeriod.textContent = formatPeriodLabel(activePeriod, entry, ap);

      const tdValue = document.createElement("td");
      tdValue.className = "uptime-cell uptime-value";
      const pct = typeof entry.onlineper === "number" ? entry.onlineper : null;
      const span = document.createElement("span");
      span.className = `uptime-pill ${getUptimeClass(pct)}`;
      span.textContent = formatPercent(pct);
      tdValue.appendChild(span);

      row.appendChild(tdPeriod);
      row.appendChild(tdValue);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  const tabButtons = [];
  for (const period of PERIODS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `period-tab ${period === activePeriod ? "active" : ""}`;
    btn.textContent = periodTitle(period, texts);
    btn.addEventListener("click", () => {
      activePeriod = period;
      tabButtons.forEach(b => b.classList.toggle("active", b === btn));
      renderTable();
    });
    tabButtons.push(btn);
    tabsWrap.appendChild(btn);
  }

  container.appendChild(tabsWrap);
  container.appendChild(tableWrap);

  renderTable();

  /* ── Footer ───────────────────────────── */
  const footer = document.createElement("footer");
  footer.className = "svc-footer";
  footer.textContent = `© ${new Date().getFullYear()} ${ap.footerText || texts["footer-default"] || "Status Monitor"}`;
  container.appendChild(footer);
}
