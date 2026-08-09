/* ═══════════════════════════════════════════
   GLOBAL UPTIME HISTORY VIEW (Calendar)
═══════════════════════════════════════════ */

const PERIODS = ["daily", "weekly", "monthly"];

function getUptimeClassGlobal(pct) {
  if (typeof pct !== "number" || Number.isNaN(pct)) return "nm";
  let v = pct;
  if (v >= 0 && v <= 1) v *= 100;
  if (v >= 98) return "excellent";
  if (v >= 95) return "good";
  return "poor";
}

function periodTitle(period, texts) {
  const map = {
    daily: texts["global-uptime-period-day"] || "Día",
    weekly: texts["global-uptime-period-week"] || "Semana",
    monthly: texts["global-uptime-period-month"] || "Mes",
  };
  return map[period] || period;
}

function filterIncidentsForPeriod(incidents, period, key) {
  if (!Array.isArray(incidents)) return [];
  return incidents.filter(inc => {
    const created = new Date(inc.createdAt);
    // Usar hora local del servidor (UTC-6)
    const local = new Date(created.getTime() + created.getTimezoneOffset() * 60_000 + dataTimezone * 3_600_000);
    const y = local.getFullYear();
    const m = local.getMonth() + 1;
    const d = local.getDate();
    if (period === "daily") {
      const dateKey = `${y}-${pad(m)}-${pad(d)}`;
      return dateKey === key;
    }
    if (period === "weekly") {
      // key = "YYYY-WNN"
      const [ky, kw] = key.split("-W").map(Number);
      const tmp = new Date(created.getTime() + created.getTimezoneOffset() * 60_000 + dataTimezone * 3_600_000);
      tmp.setHours(0, 0, 0, 0);
      const day = (tmp.getDay() + 6) % 7;
      tmp.setDate(tmp.getDate() - day + 3);
      const firstThursday = new Date(Date.UTC(tmp.getFullYear(), 0, 4));
      firstThursday.setUTCHours(0, 0, 0, 0);
      const firstDay = (firstThursday.getUTCDay() + 6) % 7;
      firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
      const weekNum = 1 + Math.floor((tmp - firstThursday) / (7 * 24 * 3600_000));
      return tmp.getFullYear() === ky && weekNum === kw;
    }
    if (period === "monthly") {
      // key = "YYYY-MM"
      const [ky, km] = key.split("-").map(Number);
      return y === ky && m === km;
    }
    return false;
  });
}

function renderGlobalUptime(container, data) {
  const texts = window.__STATUS_TEXTS__ || {};
  const ap = window.__APPEARANCE__ || {};
  const globalUptime = data?.globalUptime || { daily: [], weekly: [], monthly: [], yearly: [] };
  const incidents = data?.incidents || [];

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
  const calendarWrap = document.createElement("div");
  calendarWrap.className = "global-uptime-calendar-wrap";

  const incidentsWrap = document.createElement("div");
  incidentsWrap.className = "global-uptime-incidents";
  incidentsWrap.hidden = true;

  let activePeriod = "daily";
  let selectedKey = null;

  function showIncidentsFor(key) {
    selectedKey = key;
    const list = filterIncidentsForPeriod(incidents, activePeriod, key);
    incidentsWrap.innerHTML = "";
    if (list.length === 0) {
      incidentsWrap.hidden = true;
      return;
    }
    incidentsWrap.hidden = false;
    const title = document.createElement("div");
    title.className = "global-uptime-incidents-title";
    title.textContent = `${texts["global-uptime-incidents"] || "Incidentes"} · ${key}`;
    incidentsWrap.appendChild(title);
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    list.forEach(inc => incidentsWrap.appendChild(renderIncidentCard(inc, false)));
  }

  function renderCalendar() {
    calendarWrap.innerHTML = "";
    incidentsWrap.hidden = true;
    selectedKey = null;

    if (activePeriod === "daily") {
      renderDailyCalendar(calendarWrap, globalUptime.daily || [], showIncidentsFor);
    } else if (activePeriod === "weekly") {
      renderWeeklyCalendar(calendarWrap, globalUptime.weekly || [], showIncidentsFor, texts, ap);
    } else {
      renderMonthlyCalendar(calendarWrap, globalUptime.monthly || [], showIncidentsFor, texts, ap);
    }
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
      renderCalendar();
    });
    tabButtons.push(btn);
    tabsWrap.appendChild(btn);
  }

  container.appendChild(tabsWrap);
  container.appendChild(calendarWrap);
  container.appendChild(incidentsWrap);

  renderCalendar();

  /* ── Footer ───────────────────────────── */
  const footer = document.createElement("footer");
  footer.className = "svc-footer";
  footer.textContent = `© ${new Date().getFullYear()} ${ap.footerText || texts["footer-default"] || "Status Monitor"}`;
  container.appendChild(footer);
}

/* ── DÍA: calendario del mes actual (L-D) ── */
function renderDailyCalendar(container, dailyEntries, onSelect) {
  const serverNow = getServerNow();
  const year = serverNow.getFullYear();
  const month = serverNow.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWd = (firstDay.getDay() + 6) % 7; // lunes=0
  const daysInMonth = lastDay.getDate();

  const entriesByDate = {};
  for (const e of dailyEntries) { if (e?.date) entriesByDate[e.date] = e; }

  const todayKey = `${year}-${pad(month + 1)}-${pad(serverNow.getDate())}`;

  const header = document.createElement("div");
  header.className = "cal-header";
  ["L", "M", "X", "J", "V", "S", "D"].forEach(d => {
    const cell = document.createElement("div");
    cell.className = "cal-day-label";
    cell.textContent = d;
    header.appendChild(cell);
  });
  container.appendChild(header);

  const title = document.createElement("div");
  title.className = "global-calendar-month-title";
  title.textContent = firstDay.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
  container.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "cal-grid";

  // Celdas vacías antes del día 1
  for (let i = 0; i < startWd; i++) {
    const cell = document.createElement("div");
    cell.className = "cal-cell empty";
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${pad(month + 1)}-${pad(d)}`;
    const cell = document.createElement("div");
    cell.className = "cal-cell";

    const dayNum = document.createElement("span");
    dayNum.className = "cal-day-num";
    dayNum.textContent = d;
    cell.appendChild(dayNum);

    const entry = entriesByDate[dateKey];
    if (entry && typeof entry.onlineper === "number") {
      let v = entry.onlineper;
      if (v >= 0 && v <= 1) v *= 100;
      const cls = getUptimeClassGlobal(v);
      cell.classList.add(cls);
      const pctStr = truncate3(v).toFixed(3) + "%";
      cell.dataset.time = dateKey;
      cell.dataset.percent = pctStr;
      cell.dataset.monitored = "true";
      cell.dataset.isToday = dateKey === todayKey ? "true" : "false";
      cell.setAttribute("aria-label", `${formatDateOnly(dateKey)}: ${pctStr} uptime`);
      cell.addEventListener("click", () => onSelect(dateKey));
    } else {
      cell.classList.add("nm");
      cell.dataset.time = dateKey;
      cell.dataset.monitored = "false";
      cell.dataset.isToday = "false";
      cell.setAttribute("aria-label", `${formatDateOnly(dateKey)}: sin datos`);
    }

    if (dateKey === todayKey) cell.classList.add("today");

    cell.addEventListener("mouseenter", e => showTooltip(e, cell));
    cell.addEventListener("mousemove", moveTooltip);
    cell.addEventListener("mouseleave", hideTooltip);
    grid.appendChild(cell);
  }

  container.appendChild(grid);
  renderLegend(container, "global");
}

/* ── SEMANA: grid vertical de semanas ISO ── */
function renderWeeklyCalendar(container, weeklyEntries, onSelect, texts, ap) {
  const locale = ap?.language === "en" ? "en-US" : "es-ES";
  const serverNow = getServerNow();
  const currentYear = serverNow.getFullYear();
  const tmp = new Date(serverNow);
  tmp.setHours(0, 0, 0, 0);
  const day = (tmp.getDay() + 6) % 7;
  tmp.setDate(tmp.getDate() - day + 3);
  const firstThursday = new Date(Date.UTC(tmp.getFullYear(), 0, 4));
  firstThursday.setUTCHours(0, 0, 0, 0);
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const currentWeek = 1 + Math.floor((tmp - firstThursday) / (7 * 24 * 3600_000));

  if (weeklyEntries.length === 0) {
    container.appendChild(el("div", texts?.["global-uptime-no-data"] || "Sin datos disponibles", "svc-no-data"));
    return;
  }

  const title = document.createElement("div");
  title.className = "global-calendar-month-title";
  title.textContent = texts?.["global-uptime-period-week"] || "Semanas";
  container.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "global-uptime-week-grid";

  const reversed = [...weeklyEntries].reverse();
  for (const entry of reversed) {
    const key = `${entry.year}-W${String(entry.week).padStart(2, "0")}`;
    const isCurrent = entry.year === currentYear && entry.week === currentWeek;

    const cell = document.createElement("div");
    cell.className = `global-uptime-period-cell ${getUptimeClassGlobal(entry.onlineper)} ${isCurrent ? "current" : ""}`;

    const label = document.createElement("div");
    label.className = "period-cell-label";
    label.textContent = key;

    const value = document.createElement("div");
    value.className = "period-cell-value";
    value.textContent = formatPercent(entry.onlineper);

    cell.appendChild(label);
    cell.appendChild(value);
    cell.addEventListener("click", () => onSelect(key));
    grid.appendChild(cell);
  }
  container.appendChild(grid);
  renderLegend(container, "global");
}

/* ── MES: grid de meses ── */
function renderMonthlyCalendar(container, monthlyEntries, onSelect, texts, ap) {
  const locale = ap?.language === "en" ? "en-US" : "es-ES";
  const serverNow = getServerNow();
  const currentYear = serverNow.getFullYear();
  const currentMonth = serverNow.getMonth() + 1;

  if (monthlyEntries.length === 0) {
    container.appendChild(el("div", texts?.["global-uptime-no-data"] || "Sin datos disponibles", "svc-no-data"));
    return;
  }

  const title = document.createElement("div");
  title.className = "global-calendar-month-title";
  title.textContent = texts?.["global-uptime-period-month"] || "Meses";
  container.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "global-uptime-month-grid";

  const reversed = [...monthlyEntries].reverse();
  for (const entry of reversed) {
    const key = `${entry.year}-${String(entry.month).padStart(2, "0")}`;
    const isCurrent = entry.year === currentYear && entry.month === currentMonth;

    const cell = document.createElement("div");
    cell.className = `global-uptime-period-cell ${getUptimeClassGlobal(entry.onlineper)} ${isCurrent ? "current" : ""}`;

    const label = document.createElement("div");
    label.className = "period-cell-label";
    try {
      label.textContent = new Date(entry.year, entry.month - 1, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });
    } catch {
      label.textContent = key;
    }

    const value = document.createElement("div");
    value.className = "period-cell-value";
    value.textContent = formatPercent(entry.onlineper);

    cell.appendChild(label);
    cell.appendChild(value);
    cell.addEventListener("click", () => onSelect(key));
    grid.appendChild(cell);
  }
  container.appendChild(grid);
  renderLegend(container, "global");
}

/* ── Leyenda global ── */
function renderLegend(container, variant) {
  const texts = window.__STATUS_TEXTS__ || {};
  const legend = document.createElement("div");
  legend.className = "cal-legend";
  const items = [
    ["excellent", texts["service-detail-legend-excellent"] || "≥ 98%"],
    ["good", texts["service-detail-legend-good"] || "95–98%"],
    ["poor", texts["service-detail-legend-poor"] || "< 95%"],
    ["nm", texts["service-detail-legend-nodata"] || "Sin datos"],
  ];
  items.forEach(([cls, label]) => {
    const item = document.createElement("div");
    item.className = "cal-legend-item";
    const dot = document.createElement("span");
    dot.className = `cal-legend-dot ${cls}`;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  });
  container.appendChild(legend);
}
