import assert from "node:assert/strict";
import test from "node:test";
import { pingService } from "../utils/checkers.js";

test("ICMP checks reject shell metacharacters before launching ping", async () => {
  const result = await pingService({
    checkType: "ping",
    url: "ping://localhost;not-a-command",
  });

  assert.equal(result.status, "down");
  assert.equal(result.error, "invalid_host");
});

async function withServer(handler, fn) {
  const { createServer } = await import("node:http");
  const srv = createServer(handler);
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}/`); }
  finally { await new Promise(r => srv.close(r)); }
}

test("Cloudflare 522 origin error is reported down", async () => {
  await withServer((_q, res) => { res.writeHead(522, { "cf-ray": "abc", server: "cloudflare" }); res.end("origin down"); }, async url => {
    const result = await pingService({ url, method: "GET" });
    assert.equal(result.status, "down");
  });
});

test("Cloudflare challenge page is reported up", async () => {
  await withServer((_q, res) => { res.writeHead(403, { "cf-mitigated": "challenge" }); res.end("Just a moment..."); }, async url => {
    const result = await pingService({ url, method: "GET" });
    assert.equal(result.status, "up");
  });
});
