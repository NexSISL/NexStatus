import fs from "fs/promises";
import crypto from "crypto";
import { setTimeout as sleep } from "timers/promises";

// Cross-process lock used by server.js and the detector. mkdir is atomic on the
// same filesystem, so only one process can own a lock at a time.
export async function withFileLock(file, fn, { timeoutMs = 600_000, staleMs = 900_000 } = {}) {
  const lockDir = `${file}.lock`;
  const started = Date.now();
  let acquired = false;

  while (!acquired) {
    try {
      await fs.mkdir(lockDir);
      acquired = true;
      await fs.writeFile(`${lockDir}/owner`, `${process.pid}\n${new Date().toISOString()}\n`);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = await fs.stat(lockDir);
        if (Date.now() - stat.mtimeMs > staleMs) await fs.rm(lockDir, { recursive: true, force: true });
      } catch {}
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for lock: ${file}`);
      await sleep(50);
    }
  }

  const heartbeat = setInterval(() => {
    fs.utimes(lockDir, new Date(), new Date()).catch(() => {});
  }, 30_000);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function tempPath(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
}
