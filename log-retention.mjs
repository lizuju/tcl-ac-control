import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logsDir } from "./launchd.mjs";

export const logRetentionMs = 7 * 24 * 60 * 60 * 1000;

function logDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isArchivedLog(name) {
  return /\.\d{4}-\d{2}-\d{2}-\d+\.log$/.test(name);
}

function isLocked(error) {
  return error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES";
}

export async function maintainLogs(directory, now = Date.now(), forcePrefixes = []) {
  const today = logDate(now);
  const cutoff = now - logRetentionMs;
  let rotated = 0;
  let removed = 0;
  let skipped = 0;

  await fs.mkdir(directory, { recursive: true });
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log") || isArchivedLog(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath);
    const date = logDate(stat.mtimeMs);
    const forced = forcePrefixes.some((prefix) => entry.name === `${prefix}.log` || entry.name === `${prefix}.err.log`);
    if (!forced && date >= today) continue;
    if (stat.size === 0) {
      try {
        await fs.unlink(filePath);
        removed += 1;
      } catch (error) {
        if (!isLocked(error) && error.code !== "ENOENT") throw error;
        skipped += 1;
      }
      continue;
    }
    const archive = path.join(directory, `${entry.name.slice(0, -4)}.${date}-${Math.trunc(stat.mtimeMs)}.log`);
    try {
      await fs.rename(filePath, archive);
      rotated += 1;
    } catch (error) {
      if (!isLocked(error) && error.code !== "ENOENT") throw error;
      skipped += 1;
    }
  }

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs >= cutoff) continue;
    try {
      await fs.unlink(filePath);
      removed += 1;
    } catch (error) {
      if (!isLocked(error) && error.code !== "ENOENT") throw error;
      skipped += 1;
    }
  }

  return { rotated, removed, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const forcePrefixes = process.argv
    .filter((argument) => argument.startsWith("--rotate="))
    .map((argument) => argument.slice("--rotate=".length));
  await maintainLogs(logsDir, Date.now(), forcePrefixes);
}
