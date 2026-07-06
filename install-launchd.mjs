import fs from "node:fs/promises";
import path from "node:path";
import { requiredEnv } from "./env.mjs";
import {
  execFileAsync,
  here,
  jobs,
  launchAgentsDir,
  loadAgent,
  logsDir,
  nodePath,
  panelLabel,
  parseTime,
  plistPathFor,
  readJobTime,
  sh,
  watchdogLabel,
  xml,
} from "./launchd.mjs";

const username = requiredEnv("AC_USERNAME");
const keychainService = process.env.AC_KEYCHAIN_SERVICE || "company-ac";
const controlScriptPath = path.join(here, "ac-control.mjs");
const panelScriptPath = path.join(here, "ac-panel.mjs");
const watchdogScriptPath = path.join(here, "watchdog.mjs");

if (process.platform !== "darwin") {
  throw new Error("install-launchd.mjs is macOS only; use install-windows.mjs on Windows");
}

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

function watchdogPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(watchdogLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(watchdogScriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(here)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logsDir, "watchdog.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logsDir, "watchdog.err.log"))}</string>
</dict>
</plist>
`;
}

async function writeScheduleJob(action, time) {
  const job = jobs[action];
  const { hour, minute } = parseTime(time);
  const plistPath = plistPathFor(job.label);
  await fs.writeFile(plistPath, schedulePlist(job.label, action, hour, minute));
  return plistPath;
}

async function writePanelJob() {
  const plistPath = plistPathFor(panelLabel);
  await fs.writeFile(plistPath, panelPlist());
  return plistPath;
}

async function writeWatchdogJob() {
  const plistPath = plistPathFor(watchdogLabel);
  await fs.writeFile(plistPath, watchdogPlist());
  return plistPath;
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
const watchdogPath = await writeWatchdogJob();

await loadAgent(jobs.on.label, onPath);
await loadAgent(jobs.off.label, offPath);
await loadAgent(panelLabel, panelPath);
await loadAgent(watchdogLabel, watchdogPath);

console.log(`Installed ${onPath} at ${onTime}`);
console.log(`Installed ${offPath} at ${offTime}`);
console.log(`Installed ${panelPath}`);
console.log(`Installed ${watchdogPath} every 5 minutes`);
console.log("Panel URL: http://127.0.0.1:3033/");
