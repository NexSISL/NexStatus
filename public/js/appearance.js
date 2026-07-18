/* ═══════════════════════════════════════════
   APARIENCIA — aplica config dinámica y textos localizados
═══════════════════════════════════════════ */

const SUPPORTED_LANGS = ["es", "en"];

async function fetchLang(lang) {
  const l = SUPPORTED_LANGS.includes(lang) ? lang : "en";
  try {
    const res = await fetch(`/lang/${l}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return {};
  }
}

function getActiveTexts(base = {}, cfg = {}) {
  const custom = cfg.texts && typeof cfg.texts === "object" ? cfg.texts : {};
  return Object.fromEntries(
    Object.entries(base).map(([key, fallback]) => [key, custom[key] || fallback])
  );
}

function applyTextOverrides(texts = {}, cfg = {}) {
  document.documentElement.lang = cfg.language === "es" ? "es" : "en";
  document.querySelectorAll("[data-text-key]").forEach(el => {
    const key = el.getAttribute("data-text-key");
    if (key && texts[key]) el.textContent = texts[key];
  });
  const titleEl = document.getElementById("brand-title");
  if (titleEl && cfg.siteTitle) titleEl.textContent = cfg.siteTitle;
  const subtitleEl = document.getElementById("brand-subtitle");
  if (subtitleEl && texts["brand-subtitle"]) subtitleEl.textContent = texts["brand-subtitle"];
  const footerTextEl = document.getElementById("footer-text-content");
  if (footerTextEl) footerTextEl.textContent = cfg.footerText || texts["footer-default"] || "";
  const siteStatusEl = document.getElementById("site-status");
  if (siteStatusEl && !siteStatusEl.dataset.customText) siteStatusEl.textContent = texts["hero-status-loading"] || "";
  return texts;
}

window.__appearanceReady = (async function applyAppearance() {
  const loadingShell = document.getElementById("app-loading-shell");
  let cfg = {};
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cfg = await res.json();
  } catch {
    cfg = {};
  }

  const lang = cfg.language === "es" ? "es" : "en";
  const base = await fetchLang(lang);
  const texts = getActiveTexts(base, cfg);
  applyTextOverrides(texts, cfg);

  const root = document.documentElement.style;
  const appearance = cfg || {};

  if (appearance.fontFamily) {
    root.setProperty("--font-family", `${appearance.fontFamily}, system-ui, sans-serif`);
    if (appearance.fontFamily !== "Inter" && !document.querySelector(`link[data-font="${appearance.fontFamily}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.dataset.font = appearance.fontFamily;
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(appearance.fontFamily).replace(/%20/g, "+")}:wght@400;500;600;700;800&display=swap`;
      document.head.appendChild(link);
    }
  }
  if (appearance.accentColor) {
    const hex = appearance.accentColor.replace("#", "");
    const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(" ");
    root.setProperty("--accent", rgb);
  }
  const COLOR_VAR_MAP = {
    accentStrongColor: "--accent-strong",
    bgColor1:           "--bg-1",
    bgColor2:           "--bg-2",
    cardColor:          "--card-bg",
    mutedColor:         "--muted",
    successColor:       "--success",
    dangerColor:        "--danger",
    warningColor:       "--warning",
    infoColor:          "--info",
  };
  for (const [key, cssVar] of Object.entries(COLOR_VAR_MAP)) {
    const hex = appearance[key];
    if (!hex) continue;
    const h = hex.replace("#", "");
    const rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(" ");
    root.setProperty(cssVar, rgb);
  }
  if (appearance.backgroundType === "solid" && appearance.backgroundSolidColor) {
    root.setProperty("--page-bg-image", "none");
    root.setProperty("--page-bg-solid", appearance.backgroundSolidColor);
  } else if (appearance.backgroundType === "image" && appearance.backgroundImageUrl) {
    root.setProperty("--page-bg-image", `url(${appearance.backgroundImageUrl})`);
  }

  if (appearance.siteTitle) {
    document.title = appearance.siteTitle;
    const titleEl = document.getElementById("brand-title");
    if (titleEl) titleEl.textContent = appearance.siteTitle;
  }
  if (appearance.logoUrl) {
    const logoEl = document.getElementById("brand-logo");
    if (logoEl) logoEl.src = appearance.logoUrl;
  }
  if (appearance.faviconUrl) {
    document.querySelectorAll("link[rel='icon']").forEach(el => { el.href = appearance.faviconUrl; });
  }
  if (appearance.footerText) {
    const footerTextEl = document.getElementById("footer-text-content");
    if (footerTextEl) footerTextEl.textContent = appearance.footerText;
  }

  const viewHome = document.getElementById("view-home");
  if (loadingShell) loadingShell.remove();
  if (viewHome) viewHome.hidden = false;
  window.__STATUS_TEXTS__ = texts;
  window.__STATUS_LANG__ = lang;
  window.__APPEARANCE__ = appearance;
})();