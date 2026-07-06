import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requiredEnv } from "./env.mjs";

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const username = requiredEnv("AC_USERNAME");
const keychainService = process.env.AC_KEYCHAIN_SERVICE || "company-ac";
const nodePath = await fs.access("/opt/homebrew/bin/node").then(
  () => "/opt/homebrew/bin/node",
  () => process.execPath,
);
const controlScriptPath = path.join(here, "ac-control.mjs");
const panelScriptPath = path.join(here, "ac-panel.mjs");
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const logsDir = path.join(here, "logs");
const domain = `gui/${process.getuid()}`;
const jobs = {
  on: { label: "com.company-ac.on", defaultTime: "09:30" },
  off: { label: "com.company-ac.off", defaultTime: "17:50" },
};
const panelLabel = "com.company-ac.panel";

function askHidden(question) {
  return new Promise((resolve) => {
    let value = "";
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();

    function onData(buffer) {
      for (const char of buffer.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve(value);
        } else if (char === "\u0003") {
          process.exit(130);
        } else if (char === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    }

    process.stdin.on("data", onData);
  });
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sh(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || "");
  if (!match) throw new Error("Time must be HH:MM");
  return { hour: Number(match[1]), minute: Number(match[2]), value };
}

function formatTime(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function keychainPassword() {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      keychainService,
      "-a",
      username,
      "-w",
    ]);
    return stdout.trimEnd();
  } catch {
    return "";
  }
}

async function readJobTime(action) {
  const job = jobs[action];
  const plistPath = path.join(launchAgentsDir, `${job.label}.plist`);
  try {
    const body = await fs.readFile(plistPath, "utf8");
    const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(body)?.[1];
    const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(body)?.[1];
    if (hour !== undefined && minute !== undefined) return formatTime(Number(hour), Number(minute));
  } catch {}
  return job.defaultTime;
}

function schedulePlist(label, action, hour, minute) {
  const command = [
    `cd ${sh(here)}`,
    `AC_PASSWORD="$(/usr/bin/security find-generic-password -s ${sh(keychainService)} -a ${sh(username)} -w)"`,
    `${sh(nodePath)} ${sh(controlScriptPath)} ${action}`,
  ].join(" && ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xml(command)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logsDir, `${action}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logsDir, `${action}.err.log`))}</string>
</dict>
</plist>
`;
}

function panelPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(panelLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(panelScriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(here)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logsDir, "panel.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logsDir, "panel.err.log"))}</string>
</dict>
</plist>
`;
}

async function writeScheduleJob(action, time) {
  const job = jobs[action];
  const { hour, minute } = parseTime(time);
  const plistPath = path.join(launchAgentsDir, `${job.label}.plist`);
  await fs.writeFile(plistPath, schedulePlist(job.label, action, hour, minute));
  return plistPath;
}

async function writePanelJob() {
  const plistPath = path.join(launchAgentsDir, `${panelLabel}.plist`);
  await fs.writeFile(plistPath, panelPlist());
  return plistPath;
}

async function loadAgent(label, plistPath, enabled = true) {
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

const password = process.env.AC_PASSWORD || await keychainPassword() || await askHidden("AC password for Keychain: ");
if (!password) throw new Error("Missing password");

await fs.mkdir(launchAgentsDir, { recursive: true });
await fs.mkdir(logsDir, { recursive: true });
await execFileAsync("/usr/bin/security", [
  "add-generic-password",
  "-U",
  "-s",
  keychainService,
  "-a",
  username,
  "-w",
  password,
]);

const onTime = await readJobTime("on");
const offTime = await readJobTime("off");
const onPath = await writeScheduleJob("on", onTime);
const offPath = await writeScheduleJob("off", offTime);
const panelPath = await writePanelJob();

await loadAgent(jobs.on.label, onPath);
await loadAgent(jobs.off.label, offPath);
await loadAgent(panelLabel, panelPath);

console.log(`Installed ${onPath} at ${onTime}`);
console.log(`Installed ${offPath} at ${offTime}`);
console.log(`Installed ${panelPath}`);
console.log("Panel URL: http://127.0.0.1:3033/");
