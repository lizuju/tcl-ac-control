import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logRetentionMs, maintainLogs } from "../log-retention.mjs";

async function writeLog(directory, name, timestamp) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, name);
  const date = new Date(timestamp);
  await fs.utimes(filePath, date, date);
}

test("maintainLogs rotates daily logs and removes files older than seven days", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "company-ac-logs-"));
  const now = Date.parse("2026-07-21T08:00:00.000Z");
  await writeLog(directory, "watchdog.log", now - 24 * 60 * 60 * 1000);
  await writeLog(directory, "on.log", now);
  await writeLog(directory, "off.log", now - logRetentionMs - 1000);
  await writeLog(directory, "panel.2026-07-12-1.log", now - logRetentionMs - 1000);

  const result = await maintainLogs(directory, now);
  const files = await fs.readdir(directory);

  assert.equal(result.rotated, 2);
  assert.equal(result.removed, 2);
  assert.equal(result.skipped, 0);
  assert.ok(files.includes("on.log"));
  assert.ok(files.some((name) => name.startsWith("watchdog.2026-07-20-")));
  assert.ok(!files.includes("off.log"));
  assert.ok(!files.includes("panel.2026-07-12-1.log"));
});

test("maintainLogs rotates a forced task log from the current day", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "company-ac-logs-"));
  const now = Date.parse("2026-07-21T08:00:00.000Z");
  await writeLog(directory, "panel.err.log", now);

  const result = await maintainLogs(directory, now, ["panel"]);
  const files = await fs.readdir(directory);

  assert.equal(result.rotated, 1);
  assert.ok(files.some((name) => name.startsWith("panel.err.2026-07-21-")));
  assert.ok(!files.includes("panel.err.log"));
});
