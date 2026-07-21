import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logRetentionMs } from "../log-retention.mjs";
import { recentLogSummary } from "../doctor.mjs";

async function writeLog(directory, name, body, timestamp) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, body);
  const date = new Date(timestamp);
  await fs.utimes(filePath, date, date);
}

test("recentLogSummary excludes expired and archived error logs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "company-ac-doctor-"));
  const now = Date.parse("2026-07-21T08:00:00.000Z");
  await writeLog(directory, "panel.err.log", "current error\n", now);
  await writeLog(directory, "watchdog.err.log", "expired error\n", now - logRetentionMs - 1000);
  await writeLog(directory, "on.err.log", "", now);
  await writeLog(directory, "panel.err.2026-07-20-1.log", "archived error\n", now - 1000);

  const result = await recentLogSummary(directory, now);

  assert.deepEqual(result.map((item) => item.file), ["panel.err.log"]);
  assert.equal(result[0].modifiedAt, new Date(now).toISOString());
  assert.deepEqual(result[0].lines, ["current error"]);
});
