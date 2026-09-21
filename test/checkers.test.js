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
