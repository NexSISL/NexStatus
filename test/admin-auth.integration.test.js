import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
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
let currentJwt;
let discordServer;
let discordApiBase;
const discord = {
  inaccessible: false,
  messages: new Map(),
  nextId: 1,
  posts: 0,
  patches: 0,
  gets: 0,
};

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

async function waitForCondition(condition, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error(message);
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

function discordResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startDiscordMock() {
  const port = await reservePort();
  discordApiBase = `http://127.0.0.1:${port}/api/v10`;
  discordServer = http.createServer((req, res) => {
    const pathname = new URL(req.url, discordApiBase).pathname;
    if (req.method === "GET" && pathname === "/api/v10/users/@me") {
      return discordResponse(res, 200, { id: "test-bot", username: "NexStatus Test Bot" });
    }

    const messageMatch = pathname.match(/^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)$/);
    const channelMatch = pathname.match(/^\/api\/v10\/channels\/([^/]+)\/messages$/);
    if (messageMatch) {
      const [, channelId, messageId] = messageMatch;
      const key = `${channelId}:${messageId}`;
      if (req.method === "GET") discord.gets += 1;
      if (req.method === "PATCH") discord.patches += 1;
      if (discord.inaccessible) return discordResponse(res, 403, { code: 50001, message: "Missing Access" });
      if (!discord.messages.has(key)) return discordResponse(res, 404, { code: 10008, message: "Unknown Message" });
      return discordResponse(res, 200, { id: messageId });
    }
    if (channelMatch && req.method === "POST") {
      const channelId = channelMatch[1];
      if (discord.inaccessible) return discordResponse(res, 403, { code: 50001, message: "Missing Access" });
      const id = String(discord.nextId++);
      discord.messages.set(`${channelId}:${id}`, { id });
      discord.posts += 1;
      return discordResponse(res, 200, { id });
    }
    return discordResponse(res, 404, { code: 0, message: "Unknown route" });
  });
  await new Promise((resolve, reject) => {
    discordServer.once("error", reject);
    discordServer.listen(port, "127.0.0.1", resolve);
  });
}

async function startNexStatusServer() {
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
    DISCORD_API_BASE: discordApiBase,
  };
  server = spawn(process.execPath, ["server.js"], { cwd: projectRoot, env });
  server.stdout.on("data", chunk => { serverOutput += chunk; });
  server.stderr.on("data", chunk => { serverOutput += chunk; });
  await waitForServer();
}

async function stopNexStatusServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), sleep(3_500)]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

before(async () => {
  await mkdir(testRoot, { recursive: true });
  testDirectory = await mkdtemp(path.join(testRoot, "run-"));
  await startDiscordMock();
  await startNexStatusServer();
});

after(async () => {
  await stopNexStatusServer();
  if (discordServer?.listening) {
    await new Promise(resolve => discordServer.close(resolve));
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
  currentJwt = result.body.sessionToken;
});

test("Discord status embed uses one durable message and only replaces a confirmed deletion", { concurrency: false }, async () => {
  let result = await request("/admin/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentJwt}` },
    body: JSON.stringify({ discordBotToken: "test-bot-token", discordStatusChannelId: "123456789" }),
  });
  assert.equal(result.response.status, 200);
  await waitForCondition(() => discord.posts === 1, "the initial status embed was not created");

  result = await request("/admin/api/discord/send-status", {
    method: "POST",
    headers: { Authorization: `Bearer ${currentJwt}` },
  });
  assert.equal(result.response.status, 200);
  assert.equal(discord.posts, 1, "updating must not create a second status message");
  assert.ok(discord.patches >= 1);

  let saved = JSON.parse(await readFile(path.join(testDirectory, "data", "discord-status.json"), "utf8"));
  const originalId = saved.messageId;
  assert.equal(saved.channelId, "123456789");
  assert.ok(originalId);

  const patchesBeforeRestart = discord.patches;
  await stopNexStatusServer();
  await startNexStatusServer();
  result = await request("/admin/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "rotated-integration-password-456", code: currentTotp("JBSWY3DPEHPK3PXP") }),
  });
  assert.equal(result.response.status, 200);
  currentJwt = result.body.sessionToken;
  await waitForCondition(() => discord.patches > patchesBeforeRestart, "the restarted server did not update the saved status message");
  assert.equal(discord.posts, 1, "a restart must reuse the persisted status message ID");

  discord.messages.delete(`123456789:${originalId}`);
  result = await request("/admin/api/discord/send-status", {
    method: "POST",
    headers: { Authorization: `Bearer ${currentJwt}` },
  });
  assert.equal(result.response.status, 200);
  assert.equal(discord.posts, 2, "a confirmed Unknown Message response creates one replacement");

  saved = JSON.parse(await readFile(path.join(testDirectory, "data", "discord-status.json"), "utf8"));
  const replacementId = saved.messageId;
  assert.notEqual(replacementId, originalId);

  discord.inaccessible = true;
  result = await request("/admin/api/discord/send-status", {
    method: "POST",
    headers: { Authorization: `Bearer ${currentJwt}` },
  });
  assert.equal(result.response.status, 502);
  assert.equal(result.body.reason, "message_unavailable");
  assert.equal(discord.posts, 2, "a permissions failure must not create a duplicate");
  saved = JSON.parse(await readFile(path.join(testDirectory, "data", "discord-status.json"), "utf8"));
  assert.equal(saved.messageId, replacementId, "a permissions failure retains the tracked message ID");

  discord.inaccessible = false;
  result = await request("/admin/api/discord/send-status", {
    method: "POST",
    headers: { Authorization: `Bearer ${currentJwt}` },
  });
  assert.equal(result.response.status, 200);
  assert.equal(discord.posts, 2, "access recovery edits the existing status message");
  assert.ok(discord.messages.has(`123456789:${replacementId}`));
});
