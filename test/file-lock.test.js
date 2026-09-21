import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withFileLock } from "../utils/file-lock.js";

test("withFileLock serializes concurrent writers", async (t) => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const testRoot = path.join(projectRoot, "tmp-test");
  const directory = await mkdtemp(path.join(testRoot, "lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const target = path.join(directory, "status.json");
  const order = [];

  await Promise.all([
    withFileLock(target, async () => {
      order.push("first:start");
      await new Promise(resolve => setTimeout(resolve, 40));
      order.push("first:end");
    }),
    withFileLock(target, async () => {
      order.push("second:start");
      order.push("second:end");
    }),
  ]);

  assert.ok([
    "first:start,first:end,second:start,second:end",
    "second:start,second:end,first:start,first:end",
  ].includes(order.join(",")));
});
