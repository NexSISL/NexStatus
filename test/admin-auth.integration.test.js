import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(projectRoot, "tmp-test");
let server;
let testDirectory;
let baseUrl;
let serverOutput = "";

function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/admin/api/setup/status`);
      if (response.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`Test server did not start:\n${serverOutput}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

function currentTotp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  const counter = Math.floor(Date.now() / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", Buffer.from(bytes)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

before(async () => {
  await mkdir(testRoot, { recursive: true });
  testDirectory = await mkdtemp(path.join(testRoot, "run-"));
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH,
    ...(process.platform === "win32" ? {
      SystemRoot: process.env.SystemRoot,
      SYSTEMROOT: process.env.SYSTEMROOT,
      ComSpec: process.env.ComSpec,
    } : {}),
    PORT: String(port),
    NODE_ENV: "test",
    SAVE_LOGS: "false",
    NEXSTATUS_DATA_DIR: path.join(testDirectory, "data"),
    NEXSTATUS_ENV_FILE: path.join(testDirectory, ".env"),
    NEXSTATUS_INDEX_OUTPUT_FILE: path.join(testDirectory, "index.html"),
  };
  server = spawn(process.execPath, ["server.js"], { cwd: projectRoot, env });
  server.stdout.on("data", chunk => { serverOutput += chunk; });
  server.stderr.on("data", chunk => { serverOutput += chunk; });
  await waitForServer();
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), sleep(3_500)]);
    if (!server.killed) server.kill("SIGKILL");
  }
  await rm(testDirectory, { recursive: true, force: true });
});

test("admin APIs require a JWT, revoke on password rotation, and honor TOTP", { concurrency: false }, async () => {
  let result = await request("/admin/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adminToken: "integration-test-password-123" }),
  });
  assert.equal(result.response.status, 200);
  assert.ok(result.body.sessionToken);
  const firstJwt = result.body.sessionToken;

  result = await request("/admin/api/settings", {
    headers: { "X-Admin-Token": "integration-test-password-123" },
  });
  assert.equal(result.response.status, 401, "the password cannot authorize an API request");

  result = await request("/admin/api/settings", {
    headers: { Authorization: `Bearer ${firstJwt}` },
  });
  assert.equal(result.response.status, 200);

  result = await request("/admin/api/test-check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${firstJwt}` },
    body: JSON.stringify({ checkType: "ping", url: "ping://host;injected" }),
  });
  assert.equal(result.response.status, 400);

  result = await request("/admin/api/announcements", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${firstJwt}` },
    body: JSON.stringify({ type: "info", title: "Integration test" }),
  });
  assert.equal(result.response.status, 200);
  const announcementId = result.body.id;

  result = await request("/uptime");
  assert.equal(result.response.status, 200);
  assert.equal(typeof result.body, "object");

  result = await request(`/admin/api/announcements/${announcementId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${firstJwt}` },
  });
  assert.equal(result.response.status, 200);

  result = await request("/admin/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${firstJwt}` },
    body: JSON.stringify({ adminToken: "rotated-integration-password-456" }),
  });
  assert.equal(result.response.status, 200);

  result = await request("/admin/api/settings", {
    headers: { Authorization: `Bearer ${firstJwt}` },
  });
  assert.equal(result.response.status, 401, "password rotation revokes existing JWTs");

  result = await request("/admin/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "rotated-integration-password-456" }),
  });
  assert.equal(result.response.status, 200);
  const secondJwt = result.body.sessionToken;
  assert.ok(secondJwt && secondJwt !== firstJwt);

  const totpSecret = "JBSWY3DPEHPK3PXP";
  result = await request("/admin/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secondJwt}` },
    body: JSON.stringify({ totpSecret }),
  });
  assert.equal(result.response.status, 200);

  result = await request("/admin/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "rotated-integration-password-456" }),
  });
  assert.equal(result.response.status, 401, "TOTP is required once enabled");

  result = await request("/admin/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "rotated-integration-password-456", code: currentTotp(totpSecret) }),
  });
  assert.equal(result.response.status, 200);
  assert.ok(result.body.sessionToken);
});
