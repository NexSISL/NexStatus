/* ═══════════════════════════════════════════
   CONFIGURACIÓN
═══════════════════════════════════════════ */
const API_URL = "/uptime";

/* ═══════════════════════════════════════════
   SPA ROUTER
═══════════════════════════════════════════ */
function navigateToService(svcId) {
  if (!_allStatusData) return;
  const svc = _allStatusData.services?.[svcId];
  if (!svc) return;

  const viewHome    = document.getElementById("view-home");
  const viewService = document.getElementById("view-service");

  renderServiceDetail(viewService, svc, _allStatusData.incidents ?? []);

  viewHome.classList.add("spa-exiting");
  setTimeout(() => {
    viewHome.hidden = true;
    viewHome.classList.remove("spa-exiting");
    viewService.hidden = false;
    void viewService.offsetWidth; // forzar reflow para animación
    viewService.classList.add("spa-entering");
    setTimeout(() => viewService.classList.remove("spa-entering"), 280);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, 160);

  history.pushState({ view: "service", id: svcId }, "", `#/service/${encodeURIComponent(svcId)}`);
}

function navigateGlobalUptime() {
  if (!_allStatusData) return;
  const viewHome    = document.getElementById("view-home");
  const viewGlobal  = document.getElementById("view-global-uptime");

  renderGlobalUptime(viewGlobal, _allStatusData);

  viewHome.classList.add("spa-exiting");
  setTimeout(() => {
    viewHome.hidden = true;
    viewHome.classList.remove("spa-exiting");
    viewGlobal.hidden = false;
    void viewGlobal.offsetWidth;
    viewGlobal.classList.add("spa-entering");
    setTimeout(() => viewGlobal.classList.remove("spa-entering"), 280);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, 160);

  history.pushState({ view: "global-uptime" }, "", "#/uptime");
}

function navigateHome() {
  const viewHome    = document.getElementById("view-home");
  const viewService = document.getElementById("view-service");
  const viewGlobal  = document.getElementById("view-global-uptime");

  [viewService, viewGlobal].forEach(view => {
    if (!view) return;
    view.classList.add("spa-exiting");
  });

  setTimeout(() => {
    if (viewService) {
      viewService.hidden = true;
      viewService.innerHTML = "";
      viewService.classList.remove("spa-exiting");
    }
    if (viewGlobal) {
      viewGlobal.hidden = true;
      viewGlobal.innerHTML = "";
      viewGlobal.classList.remove("spa-exiting");
    }
    viewHome.hidden = false;
    void viewHome.offsetWidth;
    viewHome.classList.add("spa-entering");
    setTimeout(() => viewHome.classList.remove("spa-entering"), 280);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, 160);

  history.pushState({ view: "home" }, "", "#/");
}

function handleRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const m    = hash.match(/^\/service\/(.+)$/);
  if (m) {
    const svcId = decodeURIComponent(m[1]);
    // Si los datos ya están listos, mostrar directo; si no, esperar
    if (_allStatusData) {
      const svc = _allStatusData.services?.[svcId];
      if (svc) {
        const viewHome    = document.getElementById("view-home");
        const viewService = document.getElementById("view-service");
        renderServiceDetail(viewService, svc, _allStatusData.incidents ?? []);
        viewHome.hidden    = true;
        viewService.hidden = false;
      }
    } else {
      // Guardar pending para ejecutar luego del primer fetch
      window._pendingServiceId = svcId;
    }
    return;
  }

  if (hash === "/uptime") {
    if (_allStatusData) {
      const viewHome   = document.getElementById("view-home");
      const viewGlobal = document.getElementById("view-global-uptime");
      renderGlobalUptime(viewGlobal, _allStatusData);
      viewHome.hidden   = true;
      viewGlobal.hidden = false;
    } else {
      window._pendingGlobalUptime = true;
    }
  }
}

window.addEventListener("popstate", (e) => {
  const hash = location.hash.replace(/^#/, "") || "/";
  const m    = hash.match(/^\/service\/(.+)$/);
  if (m) {
    const svcId = decodeURIComponent(m[1]);
    if (_allStatusData?.services?.[svcId]) {
      const viewHome    = document.getElementById("view-home");
      const viewService = document.getElementById("view-service");
      renderServiceDetail(viewService, _allStatusData.services[svcId], _allStatusData.incidents ?? []);
      viewHome.hidden    = true;
      viewService.hidden = false;
      const viewGlobal = document.getElementById("view-global-uptime");
      if (viewGlobal) { viewGlobal.hidden = true; viewGlobal.innerHTML = ""; }
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    return;
  }

  if (hash === "/uptime") {
    if (_allStatusData) {
      const viewHome   = document.getElementById("view-home");
      const viewGlobal = document.getElementById("view-global-uptime");
      renderGlobalUptime(viewGlobal, _allStatusData);
      viewHome.hidden   = true;
      viewGlobal.hidden = false;
      const viewService = document.getElementById("view-service");
      if (viewService) { viewService.hidden = true; viewService.innerHTML = ""; }
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    return;
  }

  const viewHome    = document.getElementById("view-home");
  const viewService = document.getElementById("view-service");
  const viewGlobal  = document.getElementById("view-global-uptime");
  if (viewService) { viewService.hidden = true; viewService.innerHTML = ""; }
  if (viewGlobal)  { viewGlobal.hidden = true; viewGlobal.innerHTML = ""; }
  if (viewHome)    { viewHome.hidden = false; }
  window.scrollTo({ top: 0, behavior: "instant" });
});

/* ═══════════════════════════════════════════
   LOAD STATUS
═══════════════════════════════════════════ */
let _retryDelay = 5_000;

async function loadStatus() {
  try {
    const res = await fetch(API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    _retryDelay = 5_000;
    if (typeof data.timezone === "number") dataTimezone = data.timezone;

    /* ── Hero general ────────────────── */
    const uptimeEl   = document.getElementById("uptime-percent");
    const lastChecked = document.getElementById("last-checked");
    const siteStatusEl = document.getElementById("site-status");
    const statusDotEl  = document.querySelector(".status-dot");
    const texts = window.__STATUS_TEXTS__ || {};

    if (uptimeEl) uptimeEl.textContent = formatPercent(data.totalonline);

    const checkedDate = data.updatedAt ? new Date(data.updatedAt) : null;
    if (lastChecked) {
      lastChecked.textContent = checkedDate ? formatDate(checkedDate) : "—";
      if (checkedDate) lastChecked.setAttribute("datetime", checkedDate.toISOString());
    }

    const services = Object.values(data.services ?? {});
    const total    = services.length;
    const down     = services.filter(s => s?.status === "down").length;
    const active   = (data.incidents ?? []).filter(i => !i.resolvedAt).length;

    if (siteStatusEl && statusDotEl) {
      if (total === 0 || (down === 0 && active === 0)) {
        siteStatusEl.textContent = texts["hero-status-up"] || "Todos los sistemas operativos";
        statusDotEl.className    = "status-dot status-up pulse";
      } else if (down < total) {
        siteStatusEl.textContent = active > 0
          ? `${active} incidente${active > 1 ? "s" : ""} activo${active > 1 ? "s" : ""}`
          : (texts["hero-status-degraded"] || "Algunos servicios están degradados");
        statusDotEl.className = "status-dot status-degraded";
      } else {
        siteStatusEl.textContent = texts["hero-status-down"] || "Todos los servicios caídos";
        statusDotEl.className    = "status-dot status-down";
      }
    }

    _allStatusData = data;

    renderAnnouncements(data.announcements);
    renderIncidents(data.incidents);

    const sections = Array.isArray(data.sections) && data.sections.length > 0
      ? data.sections
      : [{ id: "_all", name: "Servicios" }];

    if (!Array.isArray(data.sections)) {
      services.forEach(s => { s.sectionId = "_all"; });
    }

    const quickViewGrid  = document.getElementById("quick-view-grid");
    const servicesGrid   = document.getElementById("services-grid");
    if (quickViewGrid && servicesGrid) {
      renderBySections(sections, data.services ?? {}, quickViewGrid, servicesGrid);
    }

    /* ── Resolver navegación pendiente (hash en carga inicial) ── */
    if (window._pendingServiceId) {
      const pendingId = window._pendingServiceId;
      delete window._pendingServiceId;
      const svc = data.services?.[pendingId];
      if (svc) {
        const viewHome    = document.getElementById("view-home");
        const viewService = document.getElementById("view-service");
        renderServiceDetail(viewService, svc, data.incidents ?? []);
        viewHome.hidden    = true;
        viewService.hidden = false;
      }
    }

    if (window._pendingGlobalUptime) {
      delete window._pendingGlobalUptime;
      const viewHome   = document.getElementById("view-home");
      const viewGlobal = document.getElementById("view-global-uptime");
      renderGlobalUptime(viewGlobal, data);
      viewHome.hidden   = true;
      viewGlobal.hidden = false;
    }

    /* ── Si la vista de servicio ya está abierta, refrescarla ── */
    const viewService = document.getElementById("view-service");
    if (viewService && !viewService.hidden) {
      const hash = location.hash.replace(/^#/, "");
      const m    = hash.match(/^\/service\/(.+)$/);
      if (m) {
        const svc = data.services?.[decodeURIComponent(m[1])];
        if (svc) renderServiceDetail(viewService, svc, data.incidents ?? []);
      }
    }

    /* ── Si la vista de uptime global está abierta, refrescarla ── */
    const viewGlobal = document.getElementById("view-global-uptime");
    if (viewGlobal && !viewGlobal.hidden) {
      renderGlobalUptime(viewGlobal, data);
    }

  } catch (err) {
    console.error("Status error:", err);
    _retryDelay = Math.min(_retryDelay * 2, 300_000);
  }
}

/* ═══════════════════════════════════════════
   INIT
═══════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  await (window.__appearanceReady || Promise.resolve());

  // Resolver hash inicial antes del fetch
  handleRoute();

  const globalUptimeBtn = document.getElementById("btn-global-uptime");
  if (globalUptimeBtn) {
    globalUptimeBtn.addEventListener("click", navigateGlobalUptime);
  }

  loadStatus();
  setInterval(loadStatus, 60_000);
});