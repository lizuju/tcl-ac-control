import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export const here = path.dirname(fileURLToPath(import.meta.url));
export const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
export const logsDir = path.join(here, "logs");
export const domain = process.getuid ? `gui/${process.getuid()}` : "";
export const nodePath = await fs.access("/opt/homebrew/bin/node").then(
  () => "/opt/homebrew/bin/node",
  () => process.execPath,
);
export const jobs = {
  on: { label: "com.company-ac.on", defaultTime: "09:30" },
  off: { label: "com.company-ac.off", defaultTime: "17:50" },
};
export const panelLabel = "com.company-ac.panel";

export function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function sh(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || "");
  if (!match) throw new Error("Time must be HH:MM");
  return { hour: Number(match[1]), minute: Number(match[2]), value };
}

export function formatTime(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function plistPathFor(label) {
  return path.join(launchAgentsDir, `${label}.plist`);
}

export async function readJobTime(action) {
  const job = jobs[action];
  try {
    const body = await fs.readFile(plistPathFor(job.label), "utf8");
    const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(body)?.[1];
    const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(body)?.[1];
    if (hour !== undefined && minute !== undefined) return formatTime(Number(hour), Number(minute));
  } catch {}
  return job.defaultTime;
}

export async function loadAgent(label, plistPath, enabled = true) {
  await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
  await execFileAsync("/bin/launchctl", ["bootout", domain, plistPath]).catch(() => {});
  await sleep(500);
  await execFileAsync("/bin/launchctl", [enabled ? "enable" : "disable", `${domain}/${label}`]);

  try {
    await execFileAsync("/bin/launchctl", ["bootstrap", domain, plistPath]);
  } catch {
    await sleep(1500);
    await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
    await execFileAsync("/bin/launchctl", ["bootout", domain, plistPath]).catch(() => {});
    await sleep(500);
    await execFileAsync("/bin/launchctl", [enabled ? "enable" : "disable", `${domain}/${label}`]);
    await execFileAsync("/bin/launchctl", ["bootstrap", domain, plistPath]);
  }
}

export async function readAgentEnabled(label) {
  const { stdout } = await execFileAsync("/bin/launchctl", ["print-disabled", domain]);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escaped}" => (enabled|disabled)`).exec(stdout);
  return match?.[1] !== "disabled";
}

export async function readAgentLoaded(label) {
  try {
    await execFileAsync("/bin/launchctl", ["print", `${domain}/${label}`]);
    return true;
  } catch {
    return false;
  }
}
