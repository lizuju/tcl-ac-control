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
  readAgentEnabled,
  readAgentLoaded,
  readJobTime,
  sh,
  xml,
} from "./launchd.mjs";
import {
  installWindowsPanelTask,
  readWindowsSchedule,
  readWindowsTask,
  runWindowsPanelTask,
  taskNames,
  writeWindowsScheduleJob,
} from "./windows-scheduler.mjs";
import { notify } from "./notify.mjs";
import { panelLocalUrl as panelUrl } from "./panel-config.mjs";

const username = requiredEnv("AC_USERNAME");
const keychainService = process.env.AC_KEYCHAIN_SERVICE || "company-ac";
const controlScriptPath = path.join(here, "ac-control.mjs");
const panelScriptPath = path.join(here, "ac-panel.mjs");
const logRetentionMs = 7 * 24 * 60 * 60 * 1000;

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

async function cleanupLogs() {
  let removed = 0;
  const cutoff = Date.now() - logRetentionMs;
  try {
    const entries = await fs.readdir(logsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(logsDir, entry.name);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs >= cutoff) continue;
      try {
        await fs.unlink(filePath);
        removed += 1;
      } catch (error) {
        if (error.code === "EBUSY" || error.code === "EPERM") {
          log(`skipped locked old log ${entry.name}`);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (removed) log(`removed ${removed} log files older than 7 days`);
}

async function panelHealthy() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(panelUrl, { method: "HEAD", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function macSchedulePlist(label, action, hour, minute) {
  const command = [
    `cd ${sh(here)}`,
    `AC_PASSWORD="$(/usr/bin/security find-generic-password -s ${sh(keychainService)} -a ${sh(username)} -w)" AC_RUN_SOURCE=schedule ${sh(nodePath)} ${sh(controlScriptPath)} ${action}`,
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

function macPanelPlist() {
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

async function ensureMacPanel() {
  if (await panelHealthy()) return;
  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(plistPathFor(panelLabel), macPanelPlist());
  await loadAgent(panelLabel, plistPathFor(panelLabel), true);
  log("restarted macOS panel");
  await notify("AC panel restarted", { platform: "macOS", panelUrl });
}

async function ensureMacScheduleJob(action) {
  const job = jobs[action];
  const enabled = await readAgentEnabled(job.label);
  if (!enabled) return;
  if (await readAgentLoaded(job.label)) return;

  const { hour, minute } = parseTime(await readJobTime(action));
  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(plistPathFor(job.label), macSchedulePlist(job.label, action, hour, minute));
  await loadAgent(job.label, plistPathFor(job.label), true);
  log(`reloaded macOS ${action} schedule`);
}

async function macWatchdog() {
  await ensureMacPanel();
  for (const action of Object.keys(jobs)) await ensureMacScheduleJob(action);
}

async function windowsWatchdog() {
  if (!await panelHealthy()) {
    if (!(await readWindowsTask(taskNames.panel)).exists) await installWindowsPanelTask();
    try {
      await runWindowsPanelTask();
    } catch {
      await installWindowsPanelTask();
      await runWindowsPanelTask();
    }
    log("started Windows panel task");
    await notify("AC panel restarted", { platform: "Windows", panelUrl });
  }

  const schedule = await readWindowsSchedule();
  const bothMissing = !schedule.jobs.on.loaded && !schedule.jobs.off.loaded;
  const shouldRestore = schedule.enabled || schedule.state === "error" || bothMissing;
  if (!shouldRestore) return;

  if (!schedule.jobs.on.loaded) await writeWindowsScheduleJob("on", schedule.on);
  if (!schedule.jobs.off.loaded) await writeWindowsScheduleJob("off", schedule.off);
  if (schedule.jobs.on.enabled || schedule.jobs.off.enabled || bothMissing) {
    await execFileAsync("schtasks.exe", ["/Change", "/TN", taskNames.on, "/ENABLE"], { windowsHide: true }).catch(() => {});
    await execFileAsync("schtasks.exe", ["/Change", "/TN", taskNames.off, "/ENABLE"], { windowsHide: true }).catch(() => {});
  }
  log("verified Windows schedule tasks");
}

try {
  await cleanupLogs();

  if (process.platform === "darwin") {
    await macWatchdog();
  } else if (process.platform === "win32") {
    await windowsWatchdog();
  } else {
    throw new Error("Watchdog supports macOS and Windows only");
  }
} catch (error) {
  await notify("AC watchdog failed", { error: error.stack || error.message });
  throw error;
}
