import express  from "express";
import path      from "path";
import { fileURLToPath } from "url";
import fs        from "fs/promises";
import fsSync    from "fs";
import { spawn } from "child_process";
import cors      from "cors";
import crypto    from "crypto";
import dotenv   from "dotenv";
import { pingService } from "./utils/checkers.js";
import { info, success, error, warn } from "./utils/console.js";
import { withFileLock, tempPath } from "./utils/file-lock.js";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3015;
const IS_PROD = process.env.NODE_ENV === "production";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR              = path.join(__dirname, "data");
const STATUS_FILE           = path.join(DATA_DIR, "status.json");
const SERVICES_FILE         = path.join(DATA_DIR, "services.json");
const FORCE_CHECK_FILE      = path.join(DATA_DIR, "force_check");
const FORCE_CONFIG_RELOAD_FILE = path.join(DATA_DIR, "force_config_reload");
const APPEARANCE_FILE       = path.join(DATA_DIR, "appearance.json");
const ENV_FILE              = path.join(__dirname, ".env");

/* ═══════════════════════════════════════════
   CARGA DE .env
═══════════════════════════════════════════ */

async function loadEnv() {
  try {
    const raw = await fs.readFile(ENV_FILE, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
    info("[Server] .env loaded");
  } catch {
    info("[Server] No .env file — using system environment variables");
  }
}

async function writeEnv(updates) {
  let content = "";
  try {
    content = await fs.readFile(ENV_FILE, "utf8");
  } catch { /* doesn't exist yet */ }

  // Parsear .env actual
  const lines = content.split("\n");
  const existing = new Map();
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    existing.set(key, i);
  });

  // Update or add keys
  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined || val === null) continue;
    const safeVal = String(val).includes(" ") ? `"${val}"` : val;
    const newLine = `${key}=${safeVal}`;
    if (existing.has(key)) {
      lines[existing.get(key)] = newLine;
    } else {
      lines.push(newLine);
    }
    // Also update in process
    process.env[key] = String(val);
  }

  const tmp = ENV_FILE + ".tmp";
  await fs.writeFile(tmp, lines.filter((l, i) => i === 0 || l.trim() !== "" || lines[i - 1]?.trim() !== "").join("\n") + "\n");
  await fs.rename(tmp, ENV_FILE);
}

/* ═══════════════════════════════════════════
   ADMIN JWT SESSIONS
═══════════════════════════════════════════ */

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function getJwtSecret() {
  return process.env.JWT_SECRET || null;
}

function signAdminJwt(claims) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", getJwtSecret()).update(input).digest("base64url");
  return `${input}.${signature}`;
}

function issueAdminJwt(req) {
  const now = Math.floor(Date.now() / 1000);
  return signAdminJwt({
    iss: "nexstatus",
    aud: "nexstatus-admin",
    sub: "admin",
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 8 * 60 * 60,
    // A fresh identifier makes every browser login/session unique without
    // binding tokens to an IP that may legitimately change.
    cid: crypto.createHash("sha256").update(`${req.headers["user-agent"] ?? "unknown"}:${crypto.randomUUID()}`).digest("hex").slice(0, 24),
  });
}

function verifyAdminJwt(token) {
  if (!getJwtSecret() || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = crypto.createHmac("sha256", getJwtSecret()).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) return null;
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== "HS256" || header.typ !== "JWT" || payload.iss !== "nexstatus" || payload.aud !== "nexstatus-admin" || payload.sub !== "admin" || !payload.jti || !payload.exp || payload.exp <= now) return null;
    return payload;
  } catch { return null; }
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function formatIncidentDowntime(ms) {
  const minutes = Math.max(0, Math.round(Number(ms ?? 0) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/* ═══════════════════════════════════════════
   APPEARANCE CONFIG
═══════════════════════════════════════════ */

const DEFAULT_APPEARANCE = {
  siteTitle:            "System status",
  logoUrl:              "",
  faviconUrl:           "",
  backgroundType:       "image",
  backgroundImageUrl:   "",
  backgroundSolidColor: "#071025",
  footerText:           "",
  fontFamily:           "Inter",
  accentColor:          "#38bdf8",
  accentStrongColor:    "#0ea5e9",
  bgColor1:             "#080e1c",
  bgColor2:             "#040814",
  cardColor:            "#ffffff",
  mutedColor:           "#94a3b8",
  successColor:         "#22c55e",
  dangerColor:          "#ef4444",
  warningColor:         "#f59e0b",
  infoColor:            "#3b82f6",
  language:             "en",
  texts:                {},
};

// Color fields validated/normalized as #rrggbb
const COLOR_FIELDS = [
  "accentColor", "accentStrongColor", "bgColor1", "bgColor2", "cardColor",
  "mutedColor", "successColor", "dangerColor", "warningColor", "infoColor",
];

function hexToRgbTriplet(hex) {
  const h = (hex || "").replace("#", "");
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(" ");
}

function normalizeAppearance(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const texts = raw.texts && typeof raw.texts === "object" ? raw.texts : {};
  const out = {
    ...DEFAULT_APPEARANCE,
    ...raw,
    siteTitle: typeof raw.siteTitle === "string" && raw.siteTitle.trim() ? raw.siteTitle.trim() : DEFAULT_APPEARANCE.siteTitle,
    logoUrl: typeof raw.logoUrl === "string" ? raw.logoUrl.trim() : "",
    faviconUrl: typeof raw.faviconUrl === "string" ? raw.faviconUrl.trim() : "",
    backgroundType: raw.backgroundType === "solid" ? "solid" : "image",
    backgroundImageUrl: typeof raw.backgroundImageUrl === "string" ? raw.backgroundImageUrl.trim() : "",
    backgroundSolidColor: /^#[0-9a-fA-F]{6}$/.test(raw.backgroundSolidColor ?? "") ? raw.backgroundSolidColor : DEFAULT_APPEARANCE.backgroundSolidColor,
    footerText: typeof raw.footerText === "string" ? raw.footerText : "",
    fontFamily: typeof raw.fontFamily === "string" && raw.fontFamily.trim() ? raw.fontFamily.trim() : DEFAULT_APPEARANCE.fontFamily,
    language: raw.language === "en" ? "en" : "es",
    texts,
  };
  for (const f of COLOR_FIELDS) {
    out[f] = /^#[0-9a-fA-F]{6}$/.test(raw[f] ?? "") ? raw[f] : DEFAULT_APPEARANCE[f];
  }
  return out;
}

async function readAppearance() {
  try { return normalizeAppearance(await readJson(APPEARANCE_FILE)); }
  catch { return normalizeAppearance(DEFAULT_APPEARANCE); }
}

/* Embed texts — editable via appearance.texts, brand-free defaults */
const DEFAULT_EMBED_TEXTS = {
  "embed-footer":       "{site} Status",
  "embed-status-title": "📡 Status — {site}",
};

function embedText(appearance, key, vars = {}) {
  const tpl = appearance?.texts?.[key]?.trim() || DEFAULT_EMBED_TEXTS[key] || "";
  const site = appearance?.siteTitle?.trim() || "System";
  return tpl.replace(/\{site\}/g, site).replace(/\{id\}/g, vars.id ?? "");
}

/* ═══════════════════════════════════════════
   INDEX.HTML — regenerated from pristine template (whitelabel, no FOUC)
═══════════════════════════════════════════ */

const INDEX_TEMPLATE_FILE = path.join(__dirname, "templates", "index.template.html");
const INDEX_OUTPUT_FILE   = path.join(__dirname, "public", "index.html");
const DEFAULT_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%2338bdf8'/%3E%3C/svg%3E";

function esc(s) {
  return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function googleFontHref(family) {
  const f = encodeURIComponent(family).replace(/%20/g, "+");
  return `https://fonts.googleapis.com/css2?family=${f}:wght@400;500;600;700;800&display=swap`;
}

async function readLangDefaults(lang) {
  try { return await readJson(path.join(__dirname, "public", "lang", lang === "es" ? "es.json" : "en.json")); }
  catch { return {}; }
}

async function regenerateIndexHtml() {
  try {
    const appearance = await readAppearance();
    const langDefaults = await readLangDefaults(appearance.language);
    const texts = { ...langDefaults, ...(appearance.texts || {}) };

    const siteTitle = appearance.siteTitle;
    const favicon = appearance.faviconUrl || appearance.logoUrl || DEFAULT_FAVICON;
    const themeColor = appearance.backgroundType === "solid" ? appearance.backgroundSolidColor : appearance.accentColor;

    const ogImageBlock = appearance.logoUrl || appearance.faviconUrl
      ? `  <meta property="og:image" content="${esc(appearance.logoUrl || appearance.faviconUrl)}" />`
      : "";

    const preloadLines = [];
    if (appearance.logoUrl) preloadLines.push(`  <link rel="preload" as="image" href="${esc(appearance.logoUrl)}" />`);
    if (appearance.backgroundType === "image" && appearance.backgroundImageUrl) {
      preloadLines.push(`  <link rel="preload" as="image" href="${esc(appearance.backgroundImageUrl)}" fetchpriority="high" />`);
    }

    const logoBlock = appearance.logoUrl
      ? `          <div class="logo" id="brand-logo-wrap">\n            <img id="brand-logo" src="${esc(appearance.logoUrl)}" alt="${esc(siteTitle)} logo" width="36" height="36" loading="eager" decoding="async" />\n          </div>`
      : "";

    const pageBg = appearance.backgroundType === "solid"
      ? `      --page-bg-image: none;\n      --page-bg-solid: ${esc(appearance.backgroundSolidColor)};`
      : appearance.backgroundImageUrl
        ? `      --page-bg-image: url(${appearance.backgroundImageUrl});`
        : `      --page-bg-image: none;\n      --page-bg-solid: ${esc(appearance.backgroundSolidColor)};`;

    const inlineVars = [
      `      --accent: ${hexToRgbTriplet(appearance.accentColor)};`,
      `      --accent-strong: ${hexToRgbTriplet(appearance.accentStrongColor)};`,
      `      --bg-1: ${hexToRgbTriplet(appearance.bgColor1)};`,
      `      --bg-2: ${hexToRgbTriplet(appearance.bgColor2)};`,
      `      --card-bg: ${hexToRgbTriplet(appearance.cardColor)};`,
      `      --muted: ${hexToRgbTriplet(appearance.mutedColor)};`,
      `      --success: ${hexToRgbTriplet(appearance.successColor)};`,
      `      --danger: ${hexToRgbTriplet(appearance.dangerColor)};`,
      `      --warning: ${hexToRgbTriplet(appearance.warningColor)};`,
      `      --info: ${hexToRgbTriplet(appearance.infoColor)};`,
      `      --font-family: ${appearance.fontFamily}, system-ui, sans-serif;`,
      pageBg,
    ].join("\n");

    let html = await fs.readFile(INDEX_TEMPLATE_FILE, "utf8");
    html = html
      .replace(/__TITLE__/g, esc(siteTitle))
      .replace(/__META_DESC__/g, esc(`Real-time status page for ${siteTitle}: services, network, and infrastructure.`))
      .replace(/__THEME_COLOR__/g, esc(themeColor))
      .replace("__OG_IMAGE_BLOCK__", ogImageBlock)
      .replace(/__FAVICON_HREF__/g, esc(favicon))
      .replace("__PRELOAD_BLOCK__", preloadLines.join("\n"))
      .replace(/__FONT_LINK_HREF__/g, googleFontHref(appearance.fontFamily))
      .replace("__INLINE_VARS__", inlineVars)
      .replace("__LOGO_BLOCK__", logoBlock)
      .replace(/__BRAND_TITLE__/g, esc(siteTitle))
      .replace(/__BRAND_SUBTITLE__/g, esc(texts["brand-subtitle"] || ""))
      .replace(/__FOOTER_TEXT__/g, esc(appearance.footerText || texts["footer-default"] || ""));

    const tmp = INDEX_OUTPUT_FILE + ".tmp";
    await fs.writeFile(tmp, html);
    await fs.rename(tmp, INDEX_OUTPUT_FILE);
    info("[Server] index.html regenerated from template");
  } catch (e) {
    error("[Server] Failed to regenerate index.html:", e.message);
  }
}

/* ═══════════════════════════════════════════
   SECURITY HEADERS
═══════════════════════════════════════════ */

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options",  "nosniff");
  res.setHeader("X-Frame-Options",         "SAMEORIGIN");
  res.setHeader("Referrer-Policy",         "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy",      "geolocation=(), microphone=(), camera=()");
  if (IS_PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
    "img-src 'self' https: data: blob:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none';"
  );
  next();
});

/* ═══════════════════════════════════════════
   RATE LIMITING
═══════════════════════════════════════════ */

function makeRateLimiter(maxRequests, windowMs) {
  const clients = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, data] of clients) {
      if (data.resetAt < cutoff) clients.delete(ip);
    }
  }, 60_000).unref();

  return (req, res, next) => {
    const trustProxy = process.env.TRUST_PROXY === "1";
    const ip = (trustProxy && req.headers["x-forwarded-for"])
      ? req.headers["x-forwarded-for"].split(",")[0].trim()
      : req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let data = clients.get(ip);
    if (!data || now > data.resetAt) { data = { count: 0, resetAt: now + windowMs }; clients.set(ip, data); }
    data.count++;
    if (data.count > maxRequests) {
      res.setHeader("Retry-After", Math.ceil((data.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }
    next();
  };
}

const publicLimiter = makeRateLimiter(120, 60_000);
const adminLimiter  = makeRateLimiter(20,  60_000);
const authLimiter   = makeRateLimiter(5,   60_000);

/* ═══════════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════════ */

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : null;

if (IS_PROD && !allowedOrigins) {
  warn("[Server] ⚠ ALLOWED_ORIGINS not set — CORS accepts any origin. Set ALLOWED_ORIGINS in .env for production.");
}

app.use(cors({
  origin: allowedOrigins
    ? (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error("CORS: origin not allowed"));
      }
    : true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "64kb" }));

/* ═══════════════════════════════════════════
   DETECTOR (proceso hijo)
═══════════════════════════════════════════ */

let detector;
let detectorManualStop  = false;
let detectorRestartCount = 0;

function spawnDetector() {
  detector = spawn("node", [path.join(__dirname, "utils", "detector.js")], {
    stdio: "inherit",
    env: { ...process.env },
  });
  detector.on("exit", (code, signal) => {
    info(`[Uptime Detector] Process exited (code=${code}, signal=${signal})`);
    if (detectorManualStop) return;
    detectorRestartCount++;
    const delay = Math.min(30_000, 2_000 * detectorRestartCount);
    warn(`[Uptime Detector] Unexpected exit — restarting in ${delay / 1000}s (attempt ${detectorRestartCount})`);
    setTimeout(spawnDetector, delay).unref();
  });
  // Stable run for 5min → forgive past crashes, backoff resets to normal.
  setTimeout(() => { detectorRestartCount = 0; }, 5 * 60_000).unref();
}

try {
  spawnDetector();
  info("[Uptime Detector] Started in background");
} catch (err) {
  error("[Uptime Detector] Failed to start:", err);
}

/* ═══════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════ */

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJsonUnlocked(file, data) {
  const tmp = tempPath(file);
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function writeJson(file, data) {
  await withFileLock(file, () => writeJsonUnlocked(file, data));
}

async function updateStatus(mutator) {
  return withFileLock(STATUS_FILE, async () => {
    const store = await readJson(STATUS_FILE);
    const result = await mutator(store);
    await writeJsonUnlocked(STATUS_FILE, store);
    return result;
  });
}

function getAdminToken() {
  return process.env.ADMIN_TOKEN ?? null;
}

/* ═══════════════════════════════════════════
   DISCORD — bot status and embed status
═══════════════════════════════════════════ */

const botState = { verified: false, username: null, lastCheck: null };
let _statusMessageId = process.env.DISCORD_STATUS_MESSAGE_ID ?? null;
let _statusWatchDebounce = null;

async function verifyBotToken(token) {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { "Authorization": `Bot ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      botState.verified = true;
      botState.username = data.username;
      botState.lastCheck = new Date().toISOString();
      return { ok: true, username: data.username };
    }
    botState.verified = false;
    return { ok: false, status: res.status };
  } catch (e) {
    botState.verified = false;
    return { ok: false, error: e.message };
  }
}

async function sendStatusEmbed() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_STATUS_CHANNEL_ID;
  if (!token || !channelId || !botState.verified) return;

  try {
    const [statusData, appearance] = await Promise.all([readJson(STATUS_FILE), readAppearance()]);
    const serviceOrderStr = (process.env.DISCORD_STATUS_SERVICES ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const allServicesObj = Object.values(statusData.services ?? {});
    const allServices = serviceOrderStr.length === 0
      ? allServicesObj
      : serviceOrderStr
          .map(svcId => allServicesObj.find(s => s.id === svcId))
          .filter(Boolean);

    const allUp = allServices.length > 0 && allServices.every(s => s.status === "up");
    const someDown = allServices.some(s => s.status === "down");
    const globalUp = statusData.totalonline != null
      ? Number(statusData.totalonline).toFixed(2)
      : (allServices.length > 0
          ? (allServices.reduce((s, v) => s + (v.onlineper ?? 100), 0) / allServices.length).toFixed(2)
          : "100.00");
    const color = someDown ? 0xef4444 : (allUp ? 0x22c55e : 0xf59e0b);
    const statusStr = someDown ? "⚠️ Degraded" : (allUp ? "✅ Operational" : "🔄 Partial");
    const embedTitle = embedText(appearance, "embed-status-title");

    const fields = allServices.map(svc => {
      const icon = svc.status === "up" ? "🟢" : "🔴";
      const uptime = typeof svc.onlineper === "number" ? `${svc.onlineper.toFixed(2)}%` : "—";
      const lat = svc.latency != null ? `${svc.latency}ms` : "—";
      return { name: `${icon} ${svc.name}`, value: `📈 Uptime: \`${uptime}\`\n⚡ Latency: \`${lat}\``, inline: true };
    });

    const chunks = [];
    for (let i = 0; i < fields.length; i += 9) chunks.push(fields.slice(i, i + 9));
    if (chunks.length === 0) chunks.push([]);

    const embeds = chunks.map((chunk, idx) => ({
      title: idx === 0 ? embedTitle : undefined,
      description: idx === 0 ? `**Global Uptime:** \`${globalUp}%\`\n**Status:** ${statusStr}\n**Updated:** <t:${Math.floor(Date.now() / 1000)}:R>` : undefined,
      color,
      timestamp: idx === 0 ? new Date().toISOString() : undefined,
      fields: chunk,
    }));

    if (_statusMessageId) {
      const editRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${_statusMessageId}`, {
        method: "PATCH",
        headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ embeds }),
      });
      if (editRes.ok) {
        info("[discord] 📡 Status embed updated");
        return;
      }
      warn(`[discord] Could not edit message (${editRes.status}), creating new one`);
      _statusMessageId = null;
    }

    const postRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds }),
    });
    if (postRes.ok) {
      const msg = await postRes.json();
      _statusMessageId = msg.id;
      await writeEnv({ DISCORD_STATUS_MESSAGE_ID: msg.id });
      info(`[discord] 📡 Status embed created: ${msg.id}`);
    } else {
      warn(`[discord] ⚠ status embed: ${postRes.status} — ${await postRes.text()}`);
    }
  } catch (e) {
    warn("[discord] Error on sendStatusEmbed:", e.message);
  }
}

function watchStatusFile() {
  fsSync.watchFile(STATUS_FILE, { interval: 5000, persistent: false }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    clearTimeout(_statusWatchDebounce);
    _statusWatchDebounce = setTimeout(() => sendStatusEmbed(), 1500);
  });
  info("[discord] 👁 Watching status.json for auto-embed (polling 5s)");
}

/* ═══════════════════════════════════════════
   DISCORD — editar embed cuando admin comenta
═══════════════════════════════════════════ */

async function editDiscordEmbed(incident, update, serviceName) {
  const token     = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!token || !channelId || !incident.discordMessageId) return;
  const appearance = await readAppearance();

  const statusLabels = {
    investigating: "🔍 Investigating",
    identified:    "🔎 Identified",
    monitoring:    "🟡 Monitoring",
    resolved:      "✅ Resolved",
    maintenance:   "🔧 Maintenance",
  };
  const colors = {
    investigating: 0xef4444,
    identified:    0xf97316,
    monitoring:    0xf59e0b,
    resolved:      0x22c55e,
    maintenance:   0x3b82f6,
  };

  const fields = [
    { name: "Service", value: serviceName ?? incident.serviceName ?? "—", inline: true },
    { name: "Status",   value: statusLabels[update.status] ?? update.status,  inline: true },
  ];

  if (incident.updates?.length > 1) {
    fields.push({ name: "Downtime", value: formatIncidentDowntime(incident.downtimeMs), inline: false });
  }

  const embed = {
    title: `📋 Update — ${incident.title}`,
    description: update.message || "No message.",
    color: colors[update.status] ?? 0x6b7280,
    timestamp: update.at,
    footer: { text: embedText(appearance, "embed-footer", { id: incident.id }) },
    fields,
  };

  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${incident.discordMessageId}`,
      {
        method: "PATCH",
        headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      }
    );
    if (res.ok) {
      info(`[discord] ✏ Embed updated by admin comment — incident: ${incident.id}`);
    } else {
      const err = await res.text();
      warn(`[discord] ⚠ Could not edit embed: ${res.status} — ${err}`);
    }
  } catch (e) {
    warn("[discord] Network error editing embed:", e.message);
  }
}

/* ═══════════════════════════════════════════
   TOTP HELPER — RFC 6238
═══════════════════════════════════════════ */

function base32Decode(str) {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const output = [];
  const clean  = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "")
                    .replace(/0/g, "O")
                    .replace(/1/g, "I")
                    .replace(/8/g, "B");
  for (const c of clean) {
    const idx = CHARS.indexOf(c);
    if (idx === -1) continue;
    val  = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; output.push((val >> bits) & 0xff); }
  }
  return Buffer.from(output);
}

function verifyTotp(secret, userCode, window = 1) {
  if (!secret) return false;
  const timeStep = 30, digits = 6;
  const key      = base32Decode(secret);
  const now      = Math.floor(Date.now() / 1000 / timeStep);
  for (let i = -window; i <= window; i++) {
    const counter = now + i;
    const buf     = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac   = crypto.createHmac("sha1", key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const valid  = ((hmac.readUInt32BE(offset) & 0x7fffffff) % Math.pow(10, digits))
                    .toString().padStart(digits, "0");
    if (safeEqualText(valid, String(userCode).trim().padStart(digits, "0"))) {
      return true;
    }
  }
  return false;
}

/* ═══════════════════════════════════════════
   AUTH MIDDLEWARE
═══════════════════════════════════════════ */

function adminAuth(req, res, next) {
  if (!getAdminToken() || !getJwtSecret()) return res.status(500).json({ error: "Admin authentication is not configured" });
  const header = String(req.headers.authorization ?? "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !verifyAdminJwt(match[1])) return res.status(401).json({ error: "Invalid or expired session" });
  next();
}

/* ═══════════════════════════════════════════
   VALIDACIONES
═══════════════════════════════════════════ */

function isValidId(id) {
  return typeof id === "string" && /^[\w-]{1,64}$/.test(id);
}

function isValidUrl(url) {
  if (typeof url !== "string" || url.length > 512) return false;
  const safeHost = /^[A-Za-z0-9.-]+$/.test(url.replace(/^(?:ping|dns):\/\//, ""));
  if (/^(?:ping|dns):\/\//.test(url)) return safeHost;
  if (/^(?:tcp|udp):\/\//.test(url)) return /^(?:tcp|udp):\/\/[A-Za-z0-9.-]+:\d{1,5}$/.test(url);
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol) && !!u.hostname && !/[<>"'`;$()|&\\\s]/.test(url);
  } catch {
    return /^[\w.-]+:\d{1,5}$/.test(url);
  }
}

function isValidServiceConfig(service) {
  if (!service || typeof service !== "object") return false;
  if (["ping", "dns"].includes(service.checkType)) {
    const host = String(service.url ?? "").replace(/^(?:ping|dns):\/\//, "");
    return /^[A-Za-z0-9.:%-]+$/.test(host) && !/[.]{2}|^[-.]|[-.]$/.test(host);
  }
  return isValidUrl(service.url);
}

/* ═══════════════════════════════════════════
   STATIC FILES
═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   SETUP GUARD — redirect to /setup if unconfigured
═══════════════════════════════════════════ */

app.use((req, res, next) => {
  if (getAdminToken()) return next();
  const p = req.path;
  if (p === "/setup" || p === "/setup/" ||
      p.startsWith("/admin/api/setup") ||
      p === "/api/config") return next();
  if (path.extname(p)) return next(); // static assets
  if (req.method === "GET") return res.redirect("/setup");
  if (p.startsWith("/admin/api") || p.startsWith("/api"))
    return res.status(503).json({ error: "Not configured. Complete /setup." });
  next();
});

app.use(publicLimiter);
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    } else if (/\.[a-f0-9]{8}\.(js|css)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  },
}));

/* ═══════════════════════════════════════════
   PUBLIC ROUTES
═══════════════════════════════════════════ */

/* Setup wizard */
app.get("/setup",  (_req, res) => res.sendFile(path.join(__dirname, "public", "setup.html")));
app.get("/setup/", (_req, res) => res.sendFile(path.join(__dirname, "public", "setup.html")));

/* Public appearance config */
app.get("/api/config", async (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store");
  res.json(await readAppearance());
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.get("/uptime", async (_req, res) => {
  try {
    const json = await readJson(STATUS_FILE);
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.json({ ok: true, ...json });
  } catch (err) {
    error("[/uptime] Error:", err.message);
    res.status(500).json({ ok: false, error: "Could not read status.json" });
  }
});

/* ═══════════════════════════════════════════
   ADMIN – UI
   /admin and /admin/ → redirect to login if no session (client-side)
   Admin HTML is served as-is; session verification is done client-side.
   Login page is login.html (no panel content).
═══════════════════════════════════════════ */

app.get("/login",  (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/login/", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

app.get("/admin",  adminLimiter, (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin/", adminLimiter, (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.post("/admin/api/setup", authLimiter, async (req, res) => {
  if (getAdminToken()) return res.status(403).json({ error: "Already configured" });

  const { adminToken, totpSecret, sections, appearance } = req.body ?? {};

  if (typeof adminToken !== "string" || adminToken.length < 16) {
    return res.status(400).json({ error: "adminToken must be at least 16 characters" });
  }

  const updates = { ADMIN_TOKEN: adminToken, JWT_SECRET: crypto.randomBytes(32).toString("hex") };
  if (totpSecret?.trim()) updates.TOTP_SECRET = totpSecret.trim().toUpperCase();
  if (Array.isArray(sections)) {
    for (const s of sections) {
      if (!isValidId(s.id) || typeof s.name !== "string" || !Array.isArray(s.services)) {
        return res.status(400).json({ error: `Invalid section: ${s.id}` });
      }
      for (const svc of s.services) {
        if (!isValidId(svc.id) || typeof svc.name !== "string" || !isValidServiceConfig(svc)) {
          return res.status(400).json({ error: `Invalid service: ${svc.id}` });
        }
      }
    }
  }

  if (appearance && typeof appearance === "object") {
    const VALID_BG = ["image", "solid"];
    if (appearance.backgroundType && !VALID_BG.includes(appearance.backgroundType)) {
      return res.status(400).json({ error: "Invalid backgroundType" });
    }
    for (const f of ["logoUrl", "faviconUrl", "backgroundImageUrl"]) {
      if (appearance[f] && typeof appearance[f] !== "string") {
        return res.status(400).json({ error: `Invalid ${f}` });
      }
    }
    if (appearance.backgroundSolidColor && !/^#[0-9a-fA-F]{6}$/.test(appearance.backgroundSolidColor)) {
      return res.status(400).json({ error: "Invalid backgroundSolidColor" });
    }
    for (const f of COLOR_FIELDS) {
      if (appearance[f] && !/^#[0-9a-fA-F]{6}$/.test(appearance[f])) {
        return res.status(400).json({ error: `Invalid ${f}` });
      }
    }
    if (appearance.siteTitle && (typeof appearance.siteTitle !== "string" || appearance.siteTitle.length > 128)) {
      return res.status(400).json({ error: "Invalid siteTitle" });
    }
    if (appearance.footerText && (typeof appearance.footerText !== "string" || appearance.footerText.length > 256)) {
      return res.status(400).json({ error: "Invalid footerText" });
    }
    if (appearance.fontFamily && (typeof appearance.fontFamily !== "string" || appearance.fontFamily.length > 64)) {
      return res.status(400).json({ error: "Invalid fontFamily" });
    }
    if (appearance.language && appearance.language !== "es" && appearance.language !== "en") {
      return res.status(400).json({ error: "Invalid language" });
    }
    if (appearance.texts !== undefined && (typeof appearance.texts !== "object" || Array.isArray(appearance.texts))) {
      return res.status(400).json({ error: "Invalid texts" });
    }
  }

  // Commit configuration only after every input has passed validation. This
  // keeps a failed first-run setup retryable instead of leaving a half-setup.
  await writeEnv(updates);
  if (Array.isArray(sections)) {
    await writeJson(SERVICES_FILE, { sections });
    try { await fs.writeFile(FORCE_CHECK_FILE, "1"); } catch {}
  }
  if (appearance && typeof appearance === "object") {
    await writeJson(APPEARANCE_FILE, normalizeAppearance({ ...DEFAULT_APPEARANCE, ...appearance }));
    await regenerateIndexHtml();
  }

  const setupHasTotp = Boolean((updates.TOTP_SECRET ?? process.env.TOTP_SECRET ?? "").trim());
  res.json({ ok: true, sessionToken: setupHasTotp ? null : issueAdminJwt(req), requiresLogin: setupHasTotp });
});

app.get("/admin/api/setup/status", (_req, res) => {
  res.json({ configured: !!getAdminToken() });
});



app.post("/admin/api/auth", authLimiter, async (req, res) => {
  const { token, code } = req.body ?? {};
  const totpSecret  = process.env.TOTP_SECRET ?? null;
  const adminToken  = getAdminToken();

  if (!adminToken) return res.status(500).json({ ok: false, error: "Server not configured correctly" });

  if (totpSecret) {
    const tokenOk = safeEqualText(token, adminToken);
    const totpOk  = code && verifyTotp(totpSecret, String(code).trim());
    if (!tokenOk) return res.status(401).json({ ok: false, error: "Incorrect password" });
    if (!totpOk)  return res.status(401).json({ ok: false, error: "Invalid TOTP code" });
    return res.json({ ok: true, sessionToken: issueAdminJwt(req), expiresIn: 8 * 60 * 60 });
  }

  const tokenOk = safeEqualText(token, adminToken);
  if (tokenOk) return res.json({ ok: true, sessionToken: issueAdminJwt(req), expiresIn: 8 * 60 * 60 });
  res.status(401).json({ ok: false, error: "Incorrect password" });
});

/* ═══════════════════════════════════════════
   ADMIN – STATUS
═══════════════════════════════════════════ */

app.get("/admin/api/status", adminLimiter, adminAuth, async (_req, res) => {
  try { res.json(await readJson(STATUS_FILE)); }
  catch { res.status(500).json({ error: "Could not read status.json" }); }
});

/* ═══════════════════════════════════════════
   ADMIN – FORCE CHECK
═══════════════════════════════════════════ */

app.post("/admin/api/force-check", adminLimiter, adminAuth, async (_req, res) => {
  try {
    await fs.writeFile(FORCE_CHECK_FILE, "1");
    res.json({ ok: true, message: "Force check requested. Will update in seconds." });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Manual detector restart — the already authenticated JWT authorizes this
// action; no password is sent again over the network.
app.post("/admin/api/detector/restart", adminLimiter, adminAuth, async (req, res) => {
  try {
    if (detector && !detector.killed) {
      detectorManualStop = true;
      detector.once("exit", () => {
        detectorManualStop = false;
        detectorRestartCount = 0;
        spawnDetector();
      });
      detector.kill("SIGTERM");
      setTimeout(() => { if (detector && !detector.killed) detector.kill("SIGKILL"); }, 3000).unref();
    } else {
      spawnDetector();
    }
    res.json({ ok: true, message: "Detector restarting." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Resets a service's stats from a given point in time forward — for correcting false positives
// (e.g. a "fetch failed" streak wrongly recorded as downtime).
app.post("/admin/api/services/:id/reset-stats", adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  const { from } = req.body ?? {};
  if (!isValidId(id)) return res.status(400).json({ error: "Invalid service id" });
  const fromDate = from ? new Date(from) : null;
  if (from && isNaN(fromDate?.getTime())) return res.status(400).json({ error: "Invalid 'from' date" });

  try {
    const fromIso  = fromDate ? fromDate.toISOString() : null;
    const fromDate0 = fromDate ? `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, "0")}-${String(fromDate.getDate()).padStart(2, "0")}` : null;
    const found = await updateStatus(store => {
      const svc = store.services?.[id];
      if (!svc) return false;
      if (fromIso) {
        svc.hourlyHistory = (svc.hourlyHistory ?? []).filter(h => h.hour < fromIso);
        svc.dailyHistory  = (svc.dailyHistory  ?? []).filter(d => d.date < fromDate0);
        if (svc.currentHour && svc.currentHour.startedAt >= fromIso) svc.currentHour = null;
        else if (svc.currentHour) svc.currentHour.checks = svc.currentHour.checks.filter(c => c.at < fromIso);
      } else {
        svc.hourlyHistory = [];
        svc.dailyHistory  = [];
        svc.currentHour   = null;
      }
      svc.onlineper = 100;
      svc.history   = svc.dailyHistory.map(d => ({ date: d.date, onlineper: d.onlineper }));
      svc.status    = "up";
      svc.downtimeMs = 0;
      svc.lastCheckAt = null;
      return true;
    });
    if (!found) return res.status(404).json({ error: "Service not found" });
    info(`[Admin] Stats reset for ${id}${fromIso ? ` from ${fromIso}` : " (full reset)"}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Tests a service config without saving it or affecting stats — validates before applying.
app.post("/admin/api/test-check", adminLimiter, adminAuth, async (req, res) => {
  const svc = req.body;
  if (!svc?.url || !isValidServiceConfig(svc)) return res.status(400).json({ error: "Invalid monitor configuration" });
  try {
    const result = await pingService(svc);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: "down", error: "test_failed", detail: err.message });
  }
});

/* ═══════════════════════════════════════════
   ADMIN – ANNOUNCEMENTS
═══════════════════════════════════════════ */

app.get("/admin/api/announcements", adminLimiter, adminAuth, async (_req, res) => {
  const store = await readJson(STATUS_FILE);
  res.json(store.announcements ?? []);
});

app.post("/admin/api/announcements", adminLimiter, adminAuth, async (req, res) => {
  const { type, title, body, endsAt } = req.body;
  if (!type || !title) return res.status(400).json({ error: "type and title are required" });
  const VALID_TYPES = ["maintenance", "incident", "info"];
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: "Invalid type" });
  if (typeof title !== "string" || title.length > 256) return res.status(400).json({ error: "Invalid or too long title" });
  if (endsAt && isNaN(new Date(endsAt).getTime())) return res.status(400).json({ error: "endsAt is not a valid date" });

  const ann = {
    id: `ann-${Date.now()}`, type,
    title: String(title).trim(),
    body:  typeof body === "string" ? body.trim() : "",
    endsAt: endsAt ?? null, createdAt: new Date().toISOString(), manual: true,
  };
  await updateStatus(store => {
    store.announcements ??= [];
    store.announcements.push(ann);
  });
  res.json(ann);
});

app.delete("/admin/api/announcements/:id", adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "Invalid ID" });
  const removed = await updateStatus(store => {
    const before = (store.announcements ?? []).length;
    store.announcements = (store.announcements ?? []).filter(a => a.id !== id);
    return store.announcements.length !== before;
  });
  if (!removed) return res.status(404).json({ error: "Announcement not found" });
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════
   ADMIN – INCIDENTS
═══════════════════════════════════════════ */

app.get("/admin/api/incidents", adminLimiter, adminAuth, async (_req, res) => {
  const store = await readJson(STATUS_FILE);
  res.json(store.incidents ?? []);
});

app.post("/admin/api/incidents", adminLimiter, adminAuth, async (req, res) => {
  const { title, status = "investigating", message, serviceId, serviceName } = req.body;
  if (!title || typeof title !== "string" || title.length > 256) {
    return res.status(400).json({ error: "title is required (max 256 chars)" });
  }
  const VALID_STATUSES = ["investigating", "identified", "monitoring", "resolved", "maintenance"];
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });
  if (serviceId && !isValidId(serviceId)) return res.status(400).json({ error: "Invalid serviceId" });

  const now        = new Date().toISOString();
  const incidentId = `inc-${Date.now()}`;

  const incident = {
    id: incidentId, serviceId: serviceId ?? null,
    serviceName: typeof serviceName === "string" ? serviceName.trim().slice(0, 128) : null,
    title: title.trim(), status, automatic: false, createdAt: now, resolvedAt: null,
    discordMessageId: null,
    downtimeMs: 0,
    updates: [{ at: now, status, message: typeof message === "string" ? message.trim() : "Incident created manually." }],
  };

  await updateStatus(store => {
    store.incidents    ??= [];
    store.announcements ??= [];
    store.incidents.push(incident);
    store.announcements.push({
      id: `ann-${incidentId}`,
      type: status === "maintenance" ? "maintenance" : "incident",
      title: incident.title,
      body: typeof message === "string" ? message.trim() : "",
      incidentId, serviceId: serviceId ?? null, createdAt: now, endsAt: null, manual: true,
    });
  });

  // Try to send initial embed to Discord (manual incident)
  const token     = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (token && channelId) {
    const appearance = await readAppearance();
    const colors = { investigating: 0xef4444, identified: 0xf97316, monitoring: 0xf59e0b, resolved: 0x22c55e, maintenance: 0x3b82f6 };
    const statusLabels = { investigating: "🔍 Investigating", identified: "🔎 Identified", monitoring: "🟡 Monitoring", resolved: "✅ Resolved", maintenance: "🔧 Maintenance" };
    try {
      const dres = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [{
          title: `📋 Incident — ${incident.title}`,
          description: typeof message === "string" ? message.trim() : "Incident created manually.",
          color: colors[status] ?? 0x6b7280,
          timestamp: now,
          footer: { text: embedText(appearance, "embed-footer", { id: incidentId }) },
          fields: [
            { name: "Service", value: incident.serviceName ?? "—",        inline: true },
            { name: "Status",   value: statusLabels[status] ?? status,     inline: true },
          ],
        }] }),
      });
      if (dres.ok) {
        const dmsg = await dres.json();
        if (dmsg?.id) {
          incident.discordMessageId = dmsg.id;
          // Re-save with messageId
          await updateStatus(store => {
            const inc = store.incidents?.find(i => i.id === incidentId);
            if (inc) inc.discordMessageId = dmsg.id;
          });
          info(`[discord] 📨 Embed sent for manual incident ${incidentId} (msg: ${dmsg.id})`);
        }
      }
    } catch (e) {
      warn("[discord] Error sending manual incident embed:", e.message);
    }
  }

  res.json(incident);
});

/* ── Add comment/update to incident ── */
app.post("/admin/api/incidents/:id/updates", adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "Invalid ID" });

  const { status, message } = req.body;
  if (!message || typeof message !== "string" || message.length > 2048) {
    return res.status(400).json({ error: "message is required (max 2048 chars)" });
  }
  const VALID_STATUSES = ["investigating", "identified", "monitoring", "resolved", "maintenance"];
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });

  const now = new Date().toISOString();
  let inc;
  let update;
  const found = await updateStatus(store => {
    inc = (store.incidents ?? []).find(i => i.id === id);
    if (!inc) return false;
    update = { at: now, status: status ?? inc.status, message: message.trim() };
    inc.updates.push(update);
    if (status) inc.status = status;
    if (status === "resolved" && !inc.resolvedAt) {
      inc.resolvedAt = now;
      store.announcements = (store.announcements ?? []).filter(a => a.incidentId !== inc.id);
    }
    const ann = (store.announcements ?? []).find(a => a.incidentId === inc.id);
    if (ann && message) ann.body = message.trim();
    return true;
  });
  if (!found) return res.status(404).json({ error: "Incident not found" });

  // Editar embed de Discord con el nuevo comentario
  await editDiscordEmbed(inc, update, inc.serviceName);

  res.json(inc);
});

app.delete("/admin/api/incidents/:id", adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "Invalid ID" });
  const removed = await updateStatus(store => {
    const before = (store.incidents ?? []).length;
    store.incidents     = (store.incidents     ?? []).filter(i => i.id !== id);
    store.announcements = (store.announcements ?? []).filter(a => a.incidentId !== id);
    return store.incidents.length !== before;
  });
  if (!removed) return res.status(404).json({ error: "Incident not found" });
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════
   ADMIN – SERVICES
═══════════════════════════════════════════ */

app.get("/admin/api/services", adminLimiter, adminAuth, async (_req, res) => {
  try { res.json(await readJson(SERVICES_FILE)); }
  catch { res.json({ sections: [] }); }
});

app.put("/admin/api/services", adminLimiter, adminAuth, async (req, res) => {
  const { sections } = req.body;
  if (!Array.isArray(sections)) return res.status(400).json({ error: "sections must be an array" });
  for (const s of sections) {
    if (!isValidId(s.id) || typeof s.name !== "string" || !Array.isArray(s.services)) {
      return res.status(400).json({ error: `Invalid section: ${s.id}` });
    }
    if (s.name.length > 128) return res.status(400).json({ error: "Section name too long" });
    for (const svc of s.services) {
      if (!isValidId(svc.id) || typeof svc.name !== "string" || !svc.url) {
        return res.status(400).json({ error: `Invalid service in section ${s.id}: ${svc.id}` });
      }
      if (!isValidServiceConfig(svc)) {
        return res.status(400).json({ error: `Invalid URL for service ${svc.id}: ${svc.url}` });
      }
    }
  }
  await writeJson(SERVICES_FILE, { sections });
  try { await fs.writeFile(FORCE_CHECK_FILE, "1"); } catch {}
  res.json({ ok: true, message: "Saved. Starting immediate re-scan..." });
});

/* ═══════════════════════════════════════════
   ADMIN – SETTINGS (reads/writes .env)
═══════════════════════════════════════════ */

app.get("/admin/api/settings", adminLimiter, adminAuth, async (_req, res) => {
  const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
  res.json({
    discordBotToken:        botToken ? `${botToken.slice(0, 8)}…` : "",
    discordChannelId:      process.env.DISCORD_CHANNEL_ID ?? "",
    discordStatusChannelId: process.env.DISCORD_STATUS_CHANNEL_ID ?? "",
    discordStatusServices: process.env.DISCORD_STATUS_SERVICES ?? "",
    hasAdminToken:         !!(process.env.ADMIN_TOKEN),
    hasTotpSecret:         !!(process.env.TOTP_SECRET),
    totpSecretHint:        process.env.TOTP_SECRET ? `${process.env.TOTP_SECRET.slice(0, 4)}…` : "",
    botState,
    appearance:            await readAppearance(),
  });
});

app.put("/admin/api/settings", adminLimiter, adminAuth, async (req, res) => {
  const { discordBotToken, discordChannelId, discordStatusChannelId, discordStatusServices, adminToken, totpSecret } = req.body;

  if (discordChannelId && !/^\d{1,25}$/.test(discordChannelId)) {
    return res.status(400).json({ error: "Invalid discordChannelId" });
  }
  if (discordStatusChannelId && !/^\d{1,25}$/.test(discordStatusChannelId)) {
    return res.status(400).json({ error: "Invalid discordStatusChannelId" });
  }
  if (adminToken && IS_PROD && adminToken.length < 16) {
    return res.status(400).json({ error: "adminToken must be at least 16 characters" });
  }

  const updates = {};
  if (discordChannelId)                              updates.DISCORD_CHANNEL_ID = discordChannelId;
  if (discordStatusChannelId)                        updates.DISCORD_STATUS_CHANNEL_ID = discordStatusChannelId;
  if (discordStatusServices !== undefined)          updates.DISCORD_STATUS_SERVICES = discordStatusServices;
  if (adminToken) {
    updates.ADMIN_TOKEN = adminToken;
    // Password rotation invalidates every issued JWT immediately.
    updates.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  }
  if (discordBotToken && !discordBotToken.includes("…")) updates.DISCORD_BOT_TOKEN = discordBotToken;
  if (totpSecret?.trim())                            updates.TOTP_SECRET = totpSecret.trim().toUpperCase();

  await writeEnv(updates);
  if (discordBotToken && !discordBotToken.includes("…")) {
    await verifyBotToken(discordBotToken);
  }
  res.json({ ok: true });
});

app.post("/admin/api/discord/reload", adminLimiter, adminAuth, async (_req, res) => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(400).json({ error: "No Discord token configured" });
  const result = await verifyBotToken(token);
  if (result.ok) return res.json({ ok: true, username: result.username });
  return res.status(502).json({ error: result.error || `Estado ${result.status}` });
});

app.post("/admin/api/discord/test", adminLimiter, adminAuth, async (_req, res) => {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!token || !channelId) return res.status(400).json({ error: "Missing Discord credentials" });
  const dres = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "🧪 Notification test of NexStatus" }),
  });
  if (!dres.ok) {
    const err = await dres.text();
    return res.status(502).json({ error: err || "Could not send test message" });
  }
  res.json({ ok: true });
});

app.post("/admin/api/discord/send-status", adminLimiter, adminAuth, async (_req, res) => {
  try {
    await sendStatusEmbed();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════
   ADMIN – APPEARANCE
═══════════════════════════════════════════ */

app.put("/admin/api/appearance", adminLimiter, adminAuth, async (req, res) => {
  const body = req.body ?? {};
  const VALID_BG = ["image", "solid"];
  if (body.backgroundType && !VALID_BG.includes(body.backgroundType)) {
    return res.status(400).json({ error: "Invalid backgroundType" });
  }
  for (const f of ["logoUrl", "faviconUrl", "backgroundImageUrl"]) {
    if (body[f] && !isValidUrl(body[f]) && !/^\/[\w./-]+$/.test(body[f])) {
      return res.status(400).json({ error: `Invalid ${f}` });
    }
  }
  if (body.backgroundSolidColor && !/^#[0-9a-fA-F]{6}$/.test(body.backgroundSolidColor)) {
    return res.status(400).json({ error: "Invalid backgroundSolidColor" });
  }
  for (const f of COLOR_FIELDS) {
    if (body[f] && !/^#[0-9a-fA-F]{6}$/.test(body[f])) {
      return res.status(400).json({ error: `Invalid ${f}` });
    }
  }
  if (body.siteTitle && (typeof body.siteTitle !== "string" || body.siteTitle.length > 128)) {
    return res.status(400).json({ error: "Invalid siteTitle" });
  }
  if (body.footerText && (typeof body.footerText !== "string" || body.footerText.length > 256)) {
    return res.status(400).json({ error: "Invalid footerText" });
  }
  if (body.fontFamily && (typeof body.fontFamily !== "string" || body.fontFamily.length > 64)) {
    return res.status(400).json({ error: "Invalid fontFamily" });
  }
  if (body.language && body.language !== "es" && body.language !== "en") {
    return res.status(400).json({ error: "Invalid language" });
  }
  if (body.texts !== undefined && (typeof body.texts !== "object" || Array.isArray(body.texts))) {
    return res.status(400).json({ error: "Invalid texts" });
  }

  const current = await readAppearance();
  const next    = normalizeAppearance({ ...current, ...body });
  await writeJson(APPEARANCE_FILE, next);
  await regenerateIndexHtml();
  res.json({ ok: true, appearance: next });
});

// Rebuilds public/index.html from the pristine base template — use if the
// file was manually edited/corrupted and no longer reflects saved appearance.
app.post("/admin/api/appearance/rebuild-index", adminLimiter, adminAuth, async (_req, res) => {
  await regenerateIndexHtml();
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════
   404
═══════════════════════════════════════════ */

app.use((_req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

/* ═══════════════════════════════════════════
   ERROR HANDLER GLOBAL
═══════════════════════════════════════════ */

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  error("[Server] Error no manejado:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

/* ═══════════════════════════════════════════
   BOOT
═══════════════════════════════════════════ */

(async () => {
  await loadEnv();
  if (process.env.ADMIN_TOKEN && !process.env.JWT_SECRET) {
    await writeEnv({ JWT_SECRET: crypto.randomBytes(32).toString("hex") });
    info("[Auth] Generated JWT_SECRET for existing installation");
  }
  await regenerateIndexHtml();
  if (process.env.DISCORD_BOT_TOKEN) {
    await verifyBotToken(process.env.DISCORD_BOT_TOKEN);
  }
  try {
    if (fsSync.existsSync(STATUS_FILE)) watchStatusFile();
  } catch {}

  app.listen(PORT, () => {
    info(`[Web Server] http://localhost:${PORT}`);
    info(`[Admin Panel] http://localhost:${PORT}/admin`);
    info(`[Login Page] http://localhost:${PORT}/login`);
    if (!IS_PROD) info("[Server] Development mode — extended logs active.");
  });
})();

function shutdown(signal) {
  info(`\n[Server] Shutting down (${signal})...`);
  detectorManualStop = true;
  if (detector && !detector.killed) {
    detector.kill("SIGTERM");
    setTimeout(() => { if (!detector.killed) detector.kill("SIGKILL"); process.exit(0); }, 3000).unref();
    detector.once("exit", () => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", err => { error("[Server] uncaughtException:", err); });
process.on("unhandledRejection", (reason) => { error("[Server] unhandledRejection:", reason); });
