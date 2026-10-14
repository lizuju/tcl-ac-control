import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireControlLock } from "../control-lock.mjs";
import { retryAsync } from "../retry.mjs";

test("a live owner remains exclusive even when its lock is older than three minutes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ac-lock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, "lock");
  const unlock = await acquireControlLock(lock, { timeoutMs: 50 });
  const old = new Date(Date.now() - 240000);
  await fs.utimes(lock, old, old);
  await assert.rejects(acquireControlLock(lock, { timeoutMs: 50 }), /still running/);
  unlock();
  const nextUnlock = await acquireControlLock(lock, { timeoutMs: 50 });
  nextUnlock();
});

test("a killed child owner is recovered immediately without waiting for lock expiry", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ac-lock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, "lock");
  const moduleUrl = new URL("../control-lock.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { acquireControlLock } from ${JSON.stringify(moduleUrl)};
     await acquireControlLock(${JSON.stringify(lock)}, { timeoutMs: 50 });
     console.log('locked'); setInterval(() => {}, 1000);`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const unlock = await acquireControlLock(lock, { timeoutMs: 50 });
  assert.equal(Number((await fs.readdir(lock))[0].split("-", 1)[0]), process.pid);
  unlock();
});

test("release cannot remove a lock that belongs to a different owner", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ac-lock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, "lock");
  const unlock = await acquireControlLock(lock, { timeoutMs: 50 });
  await fs.rm(lock, { recursive: true });
  await fs.mkdir(lock);
  const replacement = `${process.pid}-00000000-0000-0000-0000-000000000000.owner`;
  await fs.writeFile(path.join(lock, replacement), "");
  unlock();
  assert.deepEqual(await fs.readdir(lock), [replacement]);
});

test("an orphan created before writing its PID can be recovered", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ac-lock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, "lock");
  await fs.mkdir(lock);
  const old = new Date(Date.now() - 2000);
  await fs.utimes(lock, old, old);
  const unlock = await acquireControlLock(lock, { timeoutMs: 50 });
  unlock();
});

test("waiting for a lock is cancelled by the overall operation budget", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ac-lock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, "lock");
  const unlock = await acquireControlLock(lock, { timeoutMs: 50 });
  await assert.rejects(retryAsync(async (_, signal) => {
    await acquireControlLock(lock, { timeoutMs: 5000, signal });
  }, { attempts: 1, delayMs: 0, budgetMs: 50 }), { name: "TimeoutError" });
  assert.equal((await fs.readdir(lock))[0].split("-", 1)[0], String(process.pid));
  unlock();
});

test("concurrent stale-lock recovery and repeated acquisition remain exclusive", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ac-lock-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, "lock");
  const marker = path.join(directory, "executing");
  await fs.mkdir(lock);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  await fs.writeFile(path.join(lock, `${child.pid}-00000000-0000-0000-0000-000000000000.owner`), "");
  const moduleUrl = new URL("../control-lock.mjs", import.meta.url).href;
  const script = `import fs from 'node:fs'; import { acquireControlLock } from ${JSON.stringify(moduleUrl)};
    for (let i = 0; i < 3; i++) {
      const release = await acquireControlLock(${JSON.stringify(lock)}, { timeoutMs: 5000 });
      const fd = fs.openSync(${JSON.stringify(marker)}, 'wx');
      await new Promise(resolve => setTimeout(resolve, 15));
      fs.closeSync(fd); fs.unlinkSync(${JSON.stringify(marker)}); release();
    }`;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    const contender = spawn(process.execPath, ["--input-type=module", "-e", script]);
    let stderr = "";
    contender.stderr.on("data", (data) => { stderr += data; });
    contender.on("exit", (code) => resolve({ code, stderr }));
  })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
});
