/**
 * Checkers – per-service ping logic (http, tcp, udp, ping, dns, keyword)
 * Extracted from detector.js for reuse in server.js (config testing)
 * without starting the detector loop.
 */

import net from "net";
import dns from "dns/promises";
import dgram from "dgram";
import http from "http";
import https from "https";
import { exec } from "child_process";
import { setTimeout as sleep } from "timers/promises";

export const TIMEOUT_MS = 10_000;

// Transient local/upstream DNS resolver failures — retried before being
// treated as a real outage, since they often self-heal within seconds.
export const DNS_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA"]);
const DNS_RETRY_ATTEMPTS      = 2;     // extra attempts after the first failure
const DNS_RETRY_BASE_DELAY_MS = 1_200; // backoff: 1.2s, then 2.4s

export function isDnsErrorResult(result) {
  if (!result || result.status !== "down") return false;
  const cause = result.debug?.cause;
  return !!cause && DNS_ERROR_CODES.has(cause);
}

/* ═══════════════════════════════════════════
   DNS resolution — public resolver fallback + IP cache
   Once a hostname resolves, its IP is kept in memory and reused directly
   (no further DNS lookups) until the process restarts — see
   POST /admin/api/detector/restart if a domain's IP ever changes.
═══════════════════════════════════════════ */

const dnsCache = new Map(); // hostname -> ip

const FALLBACK_DNS_SERVERS = [
  ["1.1.1.1", "1.0.0.1"],               // Cloudflare
  ["8.8.8.8", "8.8.4.4"],               // Google
  ["9.9.9.9", "149.112.112.112"],       // Quad9
  ["208.67.222.222", "208.67.220.220"], // OpenDNS
];

export function getDnsCacheSnapshot() { return Object.fromEntries(dnsCache); }
export function clearDnsCache() { dnsCache.clear(); }

// Tries the system resolver + all fallback resolvers concurrently and takes
// whichever answers first. Only fails if every single one fails — used both
// for real resolution and for the cycle-level health probe below.
async function resolveHostFresh(hostname, { timeoutMs = 3000 } = {}) {
  const attempts = [
    dns.lookup(hostname, { family: 4 }).then(r => r.address),
    ...FALLBACK_DNS_SERVERS.map(async (servers) => {
      const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
      resolver.setServers(servers);
      const addrs = await resolver.resolve4(hostname);
      if (!addrs?.length) throw new Error("empty_answer");
      return addrs[0];
    }),
  ];
  try {
    return await Promise.any(attempts);
  } catch {
    throw Object.assign(
      new Error(`DNS resolution failed for ${hostname} (system + Cloudflare/Google/Quad9/OpenDNS)`),
      { code: "ENOTFOUND" },
    );
  }
}

async function resolveHost(hostname) {
  if (net.isIP(hostname)) return hostname;
  const cached = dnsCache.get(hostname);
  if (cached) return cached;
  const ip = await resolveHostFresh(hostname);
  dnsCache.set(hostname, ip);
  return ip;
}

// Cycle-level preflight: is DNS/network reachable at all right now? Bypasses
// the cache on purpose (always tests live). Used to tell "this one target is
// down" apart from "this box currently has no working DNS/network path" —
// the latter must never be allowed to open incidents for everything at once.
export async function checkDnsHealth(canaryHost = "cloudflare.com") {
  try {
    await resolveHostFresh(canaryHost, { timeoutMs: 2500 });
    return true;
  } catch {
    return false;
  }
}

const CLOUDFLARE_INDICATORS = [
  "cloudflare", "cf-ray", "attention required", "one moment", "just a moment",
  "checking your browser", "ddos protection", "security check",
];

function matchesKeyword(responseBody, keyword, mode = "contains") {
  if (!keyword || !responseBody) return false;
  const bodyStr = String(responseBody).trim();

  switch (mode) {
    case "exact":
      return bodyStr === keyword;
    case "regex":
      try {
        return new RegExp(keyword, "i").test(bodyStr);
      } catch {
        return false;
      }
    case "json":
      try {
        const json = JSON.parse(bodyStr);
        return JSON.stringify(json).includes(keyword);
      } catch {
        return bodyStr.toLowerCase().includes(keyword.toLowerCase());
      }
    case "contains":
    default:
      return bodyStr.toLowerCase().includes(keyword.toLowerCase());
  }
}

function isCloudflareBlock(bodyText, headers) {
  const cfRay = headers?.get?.("cf-ray");
  if (cfRay) return true;
  const server = headers?.get?.("server") ?? "";
  if (server.toLowerCase().includes("cloudflare")) return true;
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return CLOUDFLARE_INDICATORS.some(kw => lower.includes(kw));
}

// http(s) request that resolves the hostname once (via resolveHost's cache
// + fallback resolvers) and connects straight to that IP, bypassing the
// system resolver entirely on cache hits. Host header / TLS SNI still use
// the original hostname, so virtual hosting and certificate checks work.
async function httpRequestDirect(urlStr, { method, headers, timeoutMs, redirects = 5 }) {
  const u  = new URL(urlStr);
  const ip = await resolveHost(u.hostname);
  const mod = u.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method,
      headers,
      timeout: timeoutMs,
      lookup: (_hostname, _opts, cb) => cb(null, [{ address: ip, family: net.isIP(ip) }]),
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume(); // discard body, follow redirect
        const nextMethod = res.statusCode === 303 ? "GET" : method;
        const nextUrl = new URL(res.headers.location, u).toString();
        resolve(httpRequestDirect(nextUrl, { method: nextMethod, headers, timeoutMs, redirects: redirects - 1 }));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (name) => res.headers[name.toLowerCase()] ?? null },
        text: async () => Buffer.concat(chunks).toString("utf8"),
      }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function runCheck(service) {
  const checkType = service.checkType ?? "http";

  if (checkType === "tcp") {
    const urlPart = service.url.replace(/^tcp:\/\//, "");
    const [host, port] = urlPart.split(":");
    if (!host || !port) return { status: "down", code: 0, latency: null, error: "invalid_address" };
    return tcpPing(host, Number(port));
  }

  if (checkType === "udp") {
    const urlPart = service.url.replace(/^udp:\/\//, "");
    const [host, port] = urlPart.split(":");
    if (!host || !port) return { status: "down", code: 0, latency: null, error: "invalid_address" };
    return udpPing(host, Number(port));
  }

  if (checkType === "ping") {
    const host = service.url.replace(/^ping:\/\//, "");
    return icmpPing(host);
  }

  if (checkType === "dns") {
    const host = service.url.replace(/^dns:\/\//, "");
    return dnsPing(host, service.dnsRecordType ?? "A", service.dnsServer ?? null);
  }

  if (service.url.startsWith("http://") || service.url.startsWith("https://")) {
    const timeoutMs = service.timeout ?? TIMEOUT_MS;
    const start     = Date.now();
    try {
      const method = checkType === "keyword" ? "GET" : (service.method ?? "HEAD");
      const res = await httpRequestDirect(service.url, {
        method,
        headers: service.headers ?? {},
        timeoutMs,
      });
      const latency = Date.now() - start;

      if (checkType === "keyword" && service.keyword) {
        const body = await res.text();
        const mode = service.keywordMode ?? "contains";
        const match = matchesKeyword(body, service.keyword, mode);
        return {
          status: match ? "up" : "down", code: res.status, latency,
          error: match ? null : "keyword_not_found",
          debug: {
            mode,
            keyword: service.keyword,
            httpStatus: res.status,
            bodyLength: body.length,
            bodySnippet: body.slice(0, 300),
          },
        };
      }

      if (!res.ok) {
        if (method === "GET") {
          try {
            const body = await res.text();
            if (isCloudflareBlock(body, res.headers)) {
              return { status: "up", code: res.status, latency, error: "cloudflare_bypass" };
            }
          } catch {}
        } else if (method === "HEAD") {
          if (isCloudflareBlock(null, res.headers)) {
            return { status: "up", code: res.status, latency, error: "cloudflare_bypass" };
          }
        }
        return { status: "down", code: res.status, latency, error: "http_status", debug: { httpStatus: res.status } };
      }

      if (method === "GET") {
        const body = await res.text();
        if (isCloudflareBlock(body, res.headers)) {
          return { status: "up", code: res.status, latency, error: "cloudflare_bypass" };
        }
      }

      return { status: "up", code: res.status, latency };
    } catch (err) {
      const reason = err.message === "timeout" ? "timeout" : "network";
      const causeCode = err.code ?? err.cause?.code ?? null;
      return { status: "down", code: 0, latency: null, error: reason, debug: { exception: err.message, cause: causeCode } };
    }
  }

  const [host, port] = service.url.split(":");
  if (!host || !port) return { status: "down", code: 0, latency: null, error: "invalid_address" };
  return tcpPing(host, Number(port));
}

/**
 * Entry point used by the rest of the app. Wraps runCheck() with a short
 * retry+backoff specifically for DNS resolution failures (ENOTFOUND, EAI_AGAIN,
 * ENODATA) — these are frequently transient local/upstream resolver hiccups,
 * not the target actually being down, and were causing false "down" reports.
 */
export async function pingService(service) {
  let result = await runCheck(service);
  let retries = 0;
  while (isDnsErrorResult(result) && retries < DNS_RETRY_ATTEMPTS) {
    retries++;
    await sleep(DNS_RETRY_BASE_DELAY_MS * retries);
    result = await runCheck(service);
  }
  if (retries > 0) {
    result.debug = { ...(result.debug ?? {}), dnsRetries: retries };
  }
  return result;
}

export function tcpPing(host, port) {
  return new Promise(async resolve => {
    const start = Date.now();
    let ip;
    try {
      ip = await resolveHost(host);
    } catch (err) {
      return resolve({ status: "down", code: 0, latency: null, error: "connection", debug: { exception: err.message, cause: err.code ?? null } });
    }
    const socket = new net.Socket();
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => { socket.destroy(); resolve({ status: "up",   code: 1, latency: Date.now() - start }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ status: "down", code: 0, latency: null, error: "timeout" }); });
    socket.once("error",   (err) => { socket.destroy(); resolve({ status: "down", code: 0, latency: null, error: "connection", debug: { exception: err.message, cause: err.code ?? null } }); });
    socket.connect(port, ip);
  });
}

// UDP: there is no real "connect"; it is considered up if the socket can send without immediate ECONNREFUSED/error.
function udpPing(host, port) {
  return new Promise(async resolve => {
    const start = Date.now();
    let ip;
    try {
      ip = await resolveHost(host);
    } catch (err) {
      return resolve({ status: "down", code: 0, latency: null, error: "network", debug: { exception: err.message, cause: err.code ?? null } });
    }
    const socket = dgram.createSocket("udp4");
    const timer  = setTimeout(() => { socket.close(); resolve({ status: "down", code: 0, latency: null, error: "timeout" }); }, TIMEOUT_MS);

    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.close();
      resolve({ status: "down", code: 0, latency: null, error: err.code === "ECONNREFUSED" ? "refused" : "network", debug: { exception: err.message, cause: err.code ?? null } });
    });

    socket.send(Buffer.from("ping"), port, ip, (err) => {
      if (err) return; // handled by "error"
      clearTimeout(timer);
      socket.close();
      resolve({ status: "up", code: 1, latency: Date.now() - start });
    });
  });
}

// ICMP requires raw socket privileges → system binary "ping" is used.
function icmpPing(host) {
  return new Promise(resolve => {
    const start   = Date.now();
    const isWin   = process.platform === "win32";
    const cmd     = isWin ? `ping -n 1 -w ${TIMEOUT_MS} ${host}` : `ping -c 1 -W ${Math.ceil(TIMEOUT_MS / 1000)} ${host}`;
    exec(cmd, { timeout: TIMEOUT_MS + 1000 }, (err, stdout, stderr) => {
      if (err) return resolve({ status: "down", code: 0, latency: null, error: "unreachable", debug: { exception: err.message, stderr: stderr?.slice(0, 300) } });
      resolve({ status: "up", code: 1, latency: Date.now() - start });
    });
  });
}

function dnsPing(host, recordType = "A", server = null) {
  return new Promise(async resolve => {
    const start    = Date.now();
    const resolver = new dns.Resolver();
    if (server) resolver.setServers([server]);
    const timer = setTimeout(() => resolve({ status: "down", code: 0, latency: null, error: "timeout" }), TIMEOUT_MS);
    try {
      const records = await resolver.resolve(host, recordType);
      clearTimeout(timer);
      resolve({ status: "up", code: 1, latency: Date.now() - start, debug: { records } });
    } catch (err) {
      clearTimeout(timer);
      resolve({ status: "down", code: 0, latency: null, error: "resolve_failed", debug: { exception: err.message } });
    }
  });
}