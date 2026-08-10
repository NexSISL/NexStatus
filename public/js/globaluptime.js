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

function isoWeekFromLocalDate(localDate) {
  const tmp = new Date(localDate.getTime());
  tmp.setHours(0, 0, 0, 0);
  const day = (tmp.getDay() + 6) % 7; // lunes=0
  tmp.setDate(tmp.getDate() - day + 3); // jueves de la semana
  const firstThursday = new Date(Date.UTC(tmp.getFullYear(), 0, 4));
  firstThursday.setUTCHours(0, 0, 0, 0);
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const weekNum = 1 + Math.floor((tmp - firstThursday) / (7 * 24 * 3600_000));
  return { year: tmp.getFullYear(), week: weekNum };
}

function getLocalThursdayOfIsoWeek(year, week) {
  const jan4 = new Date(year, 0, 4, 0, 0, 0, 0);
  const jan4Day = (jan4.getDay() + 6) % 7;
  const week1Monday = new Date(jan4.getTime() - jan4Day * 24 * 3600_000);
  const monday = new Date(week1Monday.getTime() + (week - 1) * 7 * 24 * 3600_000);
  return new Date(monday.getTime() + 3 * 24 * 3600_000);
}

function filterIncidentsForPeriod(incidents, period, key) {
  if (!Array.isArray(incidents)) return [];
  return incidents.filter(inc => {
    const created = new Date(inc.createdAt);
    const local = new Date(created.getTime() + created.getTimezoneOffset() * 60_000 + dataTimezone * 3_600_000);
    const y = local.getFullYear();
    const m = local.getMonth() + 1;
    const d = local.getDate();
    if (period === "daily") {
      const dateKey = `${y}-${pad(m)}-${pad(d)}`;
      return dateKey === key;
    }
    if (period === "weekly") {
      const [ky, kw] = key.split("-W").map(Number);
      const { year, week } = isoWeekFromLocalDate(local);
      return year === ky && week === kw;
    }
    if (period === "monthly") {
      const [ky, km] = key.split("-").map(Number);
      return y === ky && m === km;
    }
    return false;
  });
}

function openIncidentModal(periodKey, incidents, period, texts) {
  closeIncidentModal();
  const list = filterIncidentsForPeriod(incidents, period, periodKey);

  const overlay = document.createElement("div");
  overlay.className = "global-uptime-modal-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeIncidentModal();
  });

  const modal = document.createElement("div");
  modal.className = "global-uptime-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const header = document.createElement("div");
  header.className = "global-uptime-modal-header";

  const title = document.createElement("div");
  title.className = "global-uptime-modal-title";
  title.textContent = `${texts["global-uptime-incidents"] || "Incidentes"} · ${periodKey}`;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "global-uptime-modal-close";
  closeBtn.setAttribute("aria-label", texts["global-uptime-back"] || "Cerrar");
  closeBtn.innerHTML = "<i class=\"fa-solid fa-xmark\" aria-hidden=\"true\"></i>";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeIncidentModal();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = document.createElement("div");
  body.className = "global-uptime-modal-body";

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "global-uptime-modal-empty";
    empty.textContent = "Sin incidentes para este período";
    body.appendChild(empty);
  } else {
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    list.forEach(inc => body.appendChild(renderIncidentCard(inc, false)));
  }

  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Forzar reflow y activar transición de entrada
  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add("visible"));
  });

  const onKey = (e) => { if (e.key === "Escape") closeIncidentModal(); };
  document.addEventListener("keydown", onKey);
  overlay._keydownHandler = onKey;

  document.body.style.overflow = "hidden";
}

function openIncidentModalForList(titleKey, incidentList, texts) {
  closeIncidentModal();

  const overlay = document.createElement("div");
  overlay.className = "global-uptime-modal-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeIncidentModal();
  });

  const modal = document.createElement("div");
  modal.className = "global-uptime-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const header = document.createElement("div");
  header.className = "global-uptime-modal-header";

  const title = document.createElement("div");
  title.className = "global-uptime-modal-title";
  title.textContent = `${texts["global-uptime-incidents"] || "Incidentes"} · ${titleKey}`;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "global-uptime-modal-close";
  closeBtn.setAttribute("aria-label", texts["global-uptime-back"] || "Cerrar");
  closeBtn.innerHTML = "<i class=\"fa-solid fa-xmark\" aria-hidden=\"true\"></i>";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeIncidentModal();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = document.createElement("div");
  body.className = "global-uptime-modal-body";

  if (incidentList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "global-uptime-modal-empty";
    empty.textContent = "Sin incidentes para este período";
    body.appendChild(empty);
  } else {
    incidentList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    incidentList.forEach(inc => body.appendChild(renderIncidentCard(inc, false)));
  }

  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add("visible"));
  });

  const onKey = (e) => { if (e.key === "Escape") closeIncidentModal(); };
  document.addEventListener("keydown", onKey);
  overlay._keydownHandler = onKey;

  document.body.style.overflow = "hidden";
}

function closeIncidentModal() {
  const overlay = document.querySelector(".global-uptime-modal-overlay");
  if (!overlay) return;
  if (overlay.classList.contains("closing")) return;
  document.removeEventListener("keydown", overlay._keydownHandler);
  overlay.classList.remove("visible");
  overlay.classList.add("closing");
  setTimeout(() => {
    overlay.remove();
    document.body.style.overflow = "";
  }, 220);
}

function renderGlobalUptime(container, data, initialState) {
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

  let activePeriod = initialState?.period || "daily";
  if (!PERIODS.includes(activePeriod)) activePeriod = "daily";
  let selectedYear = initialState?.year ?? getServerNow().getFullYear();

  function showIncidentsFor(key) {
    openIncidentModal(key, incidents, activePeriod, texts);
  }

  function showIncidentsForMonth(monthKey) {
    openIncidentModal(monthKey, incidents, "monthly", texts);
  }

  function showIncidentsForYear(year) {
    const yearIncidents = incidents.filter(inc => {
      const created = new Date(inc.createdAt);
      const local = new Date(created.getTime() + created.getTimezoneOffset() * 60_000 + dataTimezone * 3_600_000);
      return local.getFullYear() === year;
    });
    openIncidentModalForList(`${year}`, yearIncidents, texts);
  }

  function renderCalendar() {
    calendarWrap.innerHTML = "";

    if (activePeriod === "daily") {
      renderDailyCalendar(calendarWrap, globalUptime.daily || [], showIncidentsFor, showIncidentsForMonth, showIncidentsForYear, selectedYear, initialState?.month, texts);
    } else if (activePeriod === "weekly") {
      renderWeeklyCalendar(calendarWrap, globalUptime.weekly || [], showIncidentsFor, showIncidentsForMonth, showIncidentsForYear, selectedYear, texts, ap);
    } else {
      renderMonthlyCalendar(calendarWrap, globalUptime.monthly || [], globalUptime.daily || [], showIncidentsFor, showIncidentsForMonth, showIncidentsForYear, selectedYear, texts, ap);
    }
  }

  const tabButtons = [];
  for (const period of PERIODS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `period-tab ${period === activePeriod ? "active" : ""}`;
    btn.dataset.period = period;
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

  renderCalendar();

  /* ── Footer ───────────────────────────── */
  const footer = document.createElement("footer");
  footer.className = "svc-footer";
  footer.textContent = `© ${new Date().getFullYear()} ${ap.footerText || texts["footer-default"] || "Status Monitor"}`;
  container.appendChild(footer);
}

/* ── DÍA: calendario mensual con selector de año/mes ── */
function renderDailyCalendar(container, dailyEntries, onSelect, onSelectMonth, onSelectYear, selectedYear, initialMonth, texts) {
  const locale = "es-ES";
  const serverNow = getServerNow();
  const currentYear = serverNow.getFullYear();
  const currentMonth = serverNow.getMonth();
  const currentDay = serverNow.getDate();

  // Determinar mes a mostrar: preferir estado previo, luego el mes actual si es el año actual, sino enero
  let viewYear = selectedYear;
  let viewMonth = initialMonth != null
    ? initialMonth
    : (selectedYear === currentYear ? currentMonth : 0);

  const entriesByDate = {};
  for (const e of dailyEntries) { if (e?.date) entriesByDate[e.date] = e; }

  const wrap = document.createElement("div");

  // Selector de año/mes
  const controls = document.createElement("div");
  controls.className = "global-calendar-controls";

  const monthSelect = document.createElement("select");
  monthSelect.className = "global-calendar-select";
  for (let m = 0; m < 12; m++) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = new Date(viewYear, m, 1).toLocaleDateString(locale, { month: "long" });
    if (m === viewMonth) opt.selected = true;
    monthSelect.appendChild(opt);
  }
  monthSelect.addEventListener("change", () => {
    viewMonth = Number(monthSelect.value);
    rerender();
  });

  const prevYear = document.createElement("button");
  prevYear.type = "button";
  prevYear.className = "global-calendar-arrow";
  prevYear.innerHTML = "<i class=\"fa-solid fa-chevron-left\" aria-hidden=\"true\"></i>";
  prevYear.addEventListener("click", () => { viewYear--; rerender(); });

  const yearLabel = document.createElement("div");
  yearLabel.className = "global-calendar-year";
  yearLabel.textContent = viewYear;

  const nextYear = document.createElement("button");
  nextYear.type = "button";
  nextYear.className = "global-calendar-arrow";
  nextYear.innerHTML = "<i class=\"fa-solid fa-chevron-right\" aria-hidden=\"true\"></i>";
  nextYear.addEventListener("click", () => { viewYear++; rerender(); });

  const viewMonthBtn = document.createElement("button");
  viewMonthBtn.type = "button";
  viewMonthBtn.className = "global-calendar-view-period-btn";
  viewMonthBtn.title = texts["global-uptime-view-month"] || "Ver incidentes del mes";
  viewMonthBtn.innerHTML = "<i class=\"fa-solid fa-list\" aria-hidden=\"true\"></i>";
  viewMonthBtn.addEventListener("click", () => onSelectMonth(`${viewYear}-${String(viewMonth + 1).padStart(2, "0")}`));

  const viewYearBtn = document.createElement("button");
  viewYearBtn.type = "button";
  viewYearBtn.className = "global-calendar-view-period-btn";
  viewYearBtn.title = texts["global-uptime-view-year"] || "Ver incidentes del año";
  viewYearBtn.innerHTML = "<i class=\"fa-solid fa-calendar\" aria-hidden=\"true\"></i>";
  viewYearBtn.addEventListener("click", () => onSelectYear(viewYear));

  controls.appendChild(prevYear);
  controls.appendChild(yearLabel);
  controls.appendChild(nextYear);
  controls.appendChild(monthSelect);
  controls.appendChild(viewMonthBtn);
  controls.appendChild(viewYearBtn);
  wrap.appendChild(controls);

  const calendarBody = document.createElement("div");
  wrap.appendChild(calendarBody);
  container.appendChild(wrap);

  function rerender() {
    calendarBody.innerHTML = "";
    renderDailyMonth(calendarBody, viewYear, viewMonth, entriesByDate, onSelect, currentYear, currentMonth, currentDay);
    yearLabel.textContent = viewYear;
    monthSelect.value = viewMonth;
  }
  rerender();
}

function renderDailyMonth(container, year, month, entriesByDate, onSelect, currentYear, currentMonth, currentDay) {
  const locale = "es-ES";
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWd = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  const todayKey = `${currentYear}-${pad(currentMonth + 1)}-${pad(currentDay)}`;

  const title = document.createElement("div");
  title.className = "global-calendar-month-title";
  title.textContent = firstDay.toLocaleDateString(locale, { month: "long", year: "numeric" });
  container.appendChild(title);

  const header = document.createElement("div");
  header.className = "cal-header";
  ["L", "M", "X", "J", "V", "S", "D"].forEach(d => {
    const cell = document.createElement("div");
    cell.className = "cal-day-label";
    cell.textContent = d;
    header.appendChild(cell);
  });
  container.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "cal-grid";

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

/* ── SEMANA: grid de semanas del año agrupadas por mes ── */
function renderWeeklyCalendar(container, weeklyEntries, onSelect, onSelectMonth, onSelectYear, selectedYear, texts, ap) {
  const locale = ap?.language === "en" ? "en-US" : "es-ES";
  const serverNow = getServerNow();
  const currentYear = serverNow.getFullYear();
  const currentMonth = serverNow.getMonth() + 1;
  const currentWeek = isoWeekFromLocalDate(serverNow).week;

  let viewYear = selectedYear;

  const entriesByKey = {};
  for (const e of weeklyEntries) {
    if (e?.year != null && e?.week != null) {
      entriesByKey[`${e.year}-W${String(e.week).padStart(2, "0")}`] = e;
    }
  }

  const wrap = document.createElement("div");

  const controls = document.createElement("div");
  controls.className = "global-calendar-controls";

  const prevYear = document.createElement("button");
  prevYear.type = "button";
  prevYear.className = "global-calendar-arrow";
  prevYear.innerHTML = "<i class=\"fa-solid fa-chevron-left\" aria-hidden=\"true\"></i>";
  prevYear.addEventListener("click", () => { viewYear--; rerender(); });

  const yearLabel = document.createElement("div");
  yearLabel.className = "global-calendar-year";
  yearLabel.textContent = viewYear;

  const nextYear = document.createElement("button");
  nextYear.type = "button";
  nextYear.className = "global-calendar-arrow";
  nextYear.innerHTML = "<i class=\"fa-solid fa-chevron-right\" aria-hidden=\"true\"></i>";
  nextYear.addEventListener("click", () => { viewYear++; rerender(); });

  const viewYearBtn = document.createElement("button");
  viewYearBtn.type = "button";
  viewYearBtn.className = "global-calendar-view-period-btn";
  viewYearBtn.title = texts["global-uptime-view-year"] || "Ver incidentes del año";
  viewYearBtn.innerHTML = "<i class=\"fa-solid fa-calendar\" aria-hidden=\"true\"></i>";
  viewYearBtn.addEventListener("click", () => onSelectYear(viewYear));

  controls.appendChild(prevYear);
  controls.appendChild(yearLabel);
  controls.appendChild(nextYear);
  controls.appendChild(viewYearBtn);
  wrap.appendChild(controls);

  const calendarBody = document.createElement("div");
  wrap.appendChild(calendarBody);
  container.appendChild(wrap);

  function rerender() {
    calendarBody.innerHTML = "";
    renderYearWeekGrid(calendarBody, viewYear, entriesByKey, onSelect, onSelectMonth, onSelectYear, currentYear, currentMonth, currentWeek, locale, texts);
    yearLabel.textContent = viewYear;
  }
  rerender();
}

function renderYearWeekGrid(container, year, entriesByKey, onSelect, onSelectMonth, onSelectYear, currentYear, currentMonth, currentWeek, locale, texts) {
  const title = document.createElement("div");
  title.className = "global-calendar-month-title";
  title.textContent = year;
  container.appendChild(title);

  // Agrupar semanas por mes según el jueves de cada semana ISO
  const weeksByMonth = new Map();
  for (let wk = 1; wk <= 53; wk++) {
    const key = `${year}-W${String(wk).padStart(2, "0")}`;
    const thursday = getLocalThursdayOfIsoWeek(year, wk);
    const month = thursday.getMonth() + 1;
    if (!weeksByMonth.has(month)) weeksByMonth.set(month, []);
    weeksByMonth.get(month).push({ key, week: wk, thursday });
  }

  const monthsWrap = document.createElement("div");
  monthsWrap.className = "global-uptime-weeks-by-month";

  for (let m = 1; m <= 12; m++) {
    const monthName = new Date(year, m - 1, 1).toLocaleDateString(locale, { month: "long" });
    const weeks = weeksByMonth.get(m) || [];

    const monthSection = document.createElement("div");
    monthSection.className = "global-uptime-week-month";

    const monthHeader = document.createElement("div");
    monthHeader.className = "global-uptime-week-month-header";

    const monthTitle = document.createElement("div");
    monthTitle.className = "global-uptime-week-month-title";
    monthTitle.textContent = monthName;

    const viewMonthBtn = document.createElement("button");
    viewMonthBtn.type = "button";
    viewMonthBtn.className = "global-year-month-view-btn";
    viewMonthBtn.title = texts["global-uptime-view-month"] || "Ver incidentes del mes";
    viewMonthBtn.innerHTML = "<i class=\"fa-solid fa-list\" aria-hidden=\"true\"></i>";
    const monthKey = `${year}-${String(m).padStart(2, "0")}`;
    viewMonthBtn.addEventListener("click", () => onSelectMonth(monthKey));

    monthHeader.appendChild(monthTitle);
    monthHeader.appendChild(viewMonthBtn);
    monthSection.appendChild(monthHeader);

    const weeksRow = document.createElement("div");
    weeksRow.className = "global-uptime-weeks-row";

    if (weeks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "global-uptime-week-empty";
      empty.textContent = "—";
      weeksRow.appendChild(empty);
    } else {
      for (const { key, week, thursday } of weeks) {
        const entry = entriesByKey[key];
        const isCurrent = year === currentYear && week === currentWeek && m === currentMonth;
        const cell = document.createElement("div");
        cell.className = `global-uptime-week-cell ${entry ? getUptimeClassGlobal(entry.onlineper) : "nm"} ${isCurrent ? "current" : ""}`;

        const label = document.createElement("div");
        label.className = "global-uptime-week-label";
        label.textContent = `W${String(week).padStart(2, "0")}`;

        const value = document.createElement("div");
        value.className = "global-uptime-week-value";
        value.textContent = entry ? formatPercent(entry.onlineper) : "—";

        cell.appendChild(label);
        cell.appendChild(value);
        if (entry) {
          cell.addEventListener("click", () => onSelect(key));
        }
        weeksRow.appendChild(cell);
      }
    }

    monthSection.appendChild(weeksRow);
    monthsWrap.appendChild(monthSection);
  }

  container.appendChild(monthsWrap);
  renderLegend(container, "global");
}

/* ── MES: 12 calendarios mensuales del año ── */
function renderMonthlyCalendar(container, monthlyEntries, dailyEntries, onSelect, onSelectMonth, onSelectYear, selectedYear, texts, ap) {
  const locale = ap?.language === "en" ? "en-US" : "es-ES";
  const serverNow = getServerNow();
  let viewYear = selectedYear;
  const currentYear = serverNow.getFullYear();
  const currentMonth = serverNow.getMonth() + 1;
  const currentDay = serverNow.getDate();

  // El resumen mensual no se usa para pintar; usamos los datos diarios para colorear cada día.

  const wrap = document.createElement("div");

  const controls = document.createElement("div");
  controls.className = "global-calendar-controls";

  const prevYear = document.createElement("button");
  prevYear.type = "button";
  prevYear.className = "global-calendar-arrow";
  prevYear.innerHTML = "<i class=\"fa-solid fa-chevron-left\" aria-hidden=\"true\"></i>";
  prevYear.addEventListener("click", () => { viewYear--; rerender(); });

  const yearLabel = document.createElement("div");
  yearLabel.className = "global-calendar-year";
  yearLabel.textContent = viewYear;

  const nextYear = document.createElement("button");
  nextYear.type = "button";
  nextYear.className = "global-calendar-arrow";
  nextYear.innerHTML = "<i class=\"fa-solid fa-chevron-right\" aria-hidden=\"true\"></i>";
  nextYear.addEventListener("click", () => { viewYear++; rerender(); });

  const viewYearBtn = document.createElement("button");
  viewYearBtn.type = "button";
  viewYearBtn.className = "global-calendar-view-period-btn";
  viewYearBtn.title = texts["global-uptime-view-year"] || "Ver incidentes del año";
  viewYearBtn.innerHTML = "<i class=\"fa-solid fa-calendar\" aria-hidden=\"true\"></i>";
  viewYearBtn.addEventListener("click", () => onSelectYear(viewYear));

  controls.appendChild(prevYear);
  controls.appendChild(yearLabel);
  controls.appendChild(nextYear);
  controls.appendChild(viewYearBtn);
  wrap.appendChild(controls);

  const calendarBody = document.createElement("div");
  wrap.appendChild(calendarBody);
  container.appendChild(wrap);

  function rerender() {
    calendarBody.innerHTML = "";
    renderYearMonthsAsCalendars(calendarBody, viewYear, dailyEntries, onSelect, onSelectMonth, currentYear, currentMonth, currentDay, locale, texts);
    yearLabel.textContent = viewYear;
  }
  rerender();
}

function renderYearMonthsAsCalendars(container, year, dailyEntries, onSelect, onSelectMonth, currentYear, currentMonth, currentDay, locale, texts) {
  const title = document.createElement("div");
  title.className = "global-calendar-month-title";
  title.textContent = year;
  container.appendChild(title);

  const entriesByDate = {};
  for (const e of dailyEntries) {
    if (e?.date) entriesByDate[e.date] = e;
  }

  const grid = document.createElement("div");
  grid.className = "global-year-months-calendar-grid";

  for (let m = 1; m <= 12; m++) {
    const monthKey = `${year}-${String(m).padStart(2, "0")}`;
    const isCurrent = year === currentYear && m === currentMonth;

    const monthWrap = document.createElement("div");
    monthWrap.className = "global-year-month-calendar";

    const monthHeader = document.createElement("div");
    monthHeader.className = "global-year-month-calendar-header";

    const monthTitle = document.createElement("div");
    monthTitle.className = "global-year-month-calendar-title";
    monthTitle.textContent = new Date(year, m - 1, 1).toLocaleDateString(locale, { month: "long" });

    const viewMonthBtn = document.createElement("button");
    viewMonthBtn.type = "button";
    viewMonthBtn.className = "global-year-month-view-btn";
    viewMonthBtn.title = texts["global-uptime-view-month"] || "Ver incidentes del mes";
    viewMonthBtn.innerHTML = "<i class=\"fa-solid fa-list\" aria-hidden=\"true\"></i>";
    viewMonthBtn.addEventListener("click", () => onSelectMonth(monthKey));

    monthHeader.appendChild(monthTitle);
    monthHeader.appendChild(viewMonthBtn);
    monthWrap.appendChild(monthHeader);

    const firstDay = new Date(year, m - 1, 1);
    const startWd = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(year, m, 0).getDate();

    const header = document.createElement("div");
    header.className = "cal-header small";
    ["L", "M", "X", "J", "V", "S", "D"].forEach(d => {
      const cell = document.createElement("div");
      cell.className = "cal-day-label";
      cell.textContent = d;
      header.appendChild(cell);
    });
    monthWrap.appendChild(header);

    const daysGrid = document.createElement("div");
    daysGrid.className = "cal-grid small";

    for (let i = 0; i < startWd; i++) {
      const cell = document.createElement("div");
      cell.className = "cal-cell empty";
      daysGrid.appendChild(cell);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateKey = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const isToday = year === currentYear && m === currentMonth && d === currentDay;
      const entry = entriesByDate[dateKey];
      const cell = document.createElement("div");
      cell.className = "cal-cell";

      const dayNum = document.createElement("span");
      dayNum.className = "cal-day-num";
      dayNum.textContent = d;
      cell.appendChild(dayNum);

      if (entry && typeof entry.onlineper === "number") {
        let v = entry.onlineper;
        if (v >= 0 && v <= 1) v *= 100;
        const cls = getUptimeClassGlobal(v);
        cell.classList.add(cls);
        const pctStr = truncate3(v).toFixed(3) + "%";
        cell.dataset.time = dateKey;
        cell.dataset.percent = pctStr;
        cell.dataset.monitored = "true";
        cell.dataset.isToday = isToday ? "true" : "false";
        cell.setAttribute("aria-label", `${dateKey}: ${pctStr} uptime`);
        cell.addEventListener("click", () => onSelect(dateKey));
      } else {
        cell.classList.add("nm");
        cell.dataset.time = dateKey;
        cell.dataset.monitored = "false";
        cell.dataset.isToday = isToday ? "true" : "false";
        cell.setAttribute("aria-label", `${dateKey}: sin datos`);
      }

      if (isToday) cell.classList.add("today");

      cell.addEventListener("mouseenter", e => showTooltip(e, cell));
      cell.addEventListener("mousemove", moveTooltip);
      cell.addEventListener("mouseleave", hideTooltip);
      daysGrid.appendChild(cell);
    }

    monthWrap.appendChild(daysGrid);
    grid.appendChild(monthWrap);
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
