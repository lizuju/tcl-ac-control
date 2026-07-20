import fs from "node:fs/promises";
import path from "node:path";
import {
  execFileAsync,
  formatTime,
  here,
  jobs,
  logsDir,
  nodePath,
  parseTime,
} from "./launchd.mjs";

const taskDir = path.join(here, "out", "windows-tasks");
const controlScriptPath = path.join(here, "ac-control.mjs");
const panelScriptPath = path.join(here, "ac-panel.mjs");
const watchdogScriptPath = path.join(here, "watchdog.mjs");
const taskNames = {
  on: "TCLAC-On",
  off: "TCLAC-Off",
  panel: "TCLAC-Panel",
  watchdog: "TCLAC-Watchdog",
};

function ensureWindows() {
  if (process.platform !== "win32") throw new Error("Windows Task Scheduler is only available on Windows");
}

function cmdQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function taskRunPath(name) {
  return path.join(taskDir, `${name}.cmd`);
}

async function runSchtasks(args) {
  ensureWindows();
  return execFileAsync("schtasks.exe", args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

async function writeTaskScript(name, scriptPath, args, env = {}) {
  await fs.mkdir(taskDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  const stdout = path.join(logsDir, `${name}.log`);
  const stderr = path.join(logsDir, `${name}.err.log`);
  const body = [
    "@echo off",
    `cd /d ${cmdQuote(here)}`,
    ...Object.entries(env).map(([key, value]) => `set "${key}=${value}"`),
    `${cmdQuote(nodePath)} ${cmdQuote(scriptPath)} ${args.join(" ")} >> ${cmdQuote(stdout)} 2>> ${cmdQuote(stderr)}`,
    "",
  ].join("\r\n");
  const runPath = taskRunPath(name);
  await fs.writeFile(runPath, body);
  return runPath;
}

function quotedTaskPath(name) {
  return cmdQuote(taskRunPath(name));
}

async function queryTaskXml(name) {
  try {
    const { stdout } = await runSchtasks(["/Query", "/TN", name, "/XML"]);
    return stdout;
  } catch {
    return "";
  }
}

export async function readWindowsTask(name) {
  return { exists: Boolean(await queryTaskXml(name)) };
}

function readXmlTag(xml, tag) {
  return new RegExp(`<${tag}>([^<]+)</${tag}>`, "i").exec(xml)?.[1] || "";
}

async function readWindowsJob(action) {
  const xml = await queryTaskXml(taskNames[action]);
  const start = readXmlTag(xml, "StartBoundary");
  const enabledText = readXmlTag(xml, "Enabled");
  const time = /^.+T(\d{2}):(\d{2})/.exec(start);
  return {
    exists: Boolean(xml),
    enabled: Boolean(xml) && enabledText.toLowerCase() !== "false",
    time: time ? formatTime(Number(time[1]), Number(time[2])) : jobs[action].defaultTime,
  };
}

export async function writeWindowsScheduleJob(action, time) {
  const { value } = parseTime(time);
  await writeTaskScript(action, controlScriptPath, [action], { AC_RUN_SOURCE: "schedule" });
  await runSchtasks([
    "/Create",
    "/TN",
    taskNames[action],
    "/SC",
    "DAILY",
    "/ST",
    value,
    "/TR",
    quotedTaskPath(action),
    "/F",
  ]);
}

export async function readWindowsSchedule() {
  const on = await readWindowsJob("on");
  const off = await readWindowsJob("off");
  const enabled = on.exists && off.exists && on.enabled && off.enabled;
  const disabled = (!on.exists || !on.enabled) && (!off.exists || !off.enabled);
  return {
    on: on.time,
    off: off.time,
    enabled,
    state: enabled ? "running" : disabled ? "disabled" : "error",
    jobs: {
      on: { enabled: on.enabled, loaded: on.exists },
      off: { enabled: off.enabled, loaded: off.exists },
    },
  };
}

export async function setWindowsScheduleEnabled(enabled) {
  const schedule = await readWindowsSchedule();
  if (enabled) {
    if (!schedule.jobs.on.loaded) await writeWindowsScheduleJob("on", schedule.on);
    if (!schedule.jobs.off.loaded) await writeWindowsScheduleJob("off", schedule.off);
  }
  for (const action of Object.keys(jobs)) {
    const current = await readWindowsJob(action);
    if (!current.exists && !enabled) continue;
    await runSchtasks(["/Change", "/TN", taskNames[action], enabled ? "/ENABLE" : "/DISABLE"]);
  }
  return readWindowsSchedule();
}

export async function writeWindowsSchedule(on, off) {
  parseTime(on);
  parseTime(off);
  const enabled = (await readWindowsSchedule()).enabled;
  await writeWindowsScheduleJob("on", on);
  await writeWindowsScheduleJob("off", off);
  await setWindowsScheduleEnabled(enabled);
  return readWindowsSchedule();
}

export async function installWindowsPanelTask() {
  await writeTaskScript("panel", panelScriptPath, []);
  await runSchtasks([
    "/Create",
    "/TN",
    taskNames.panel,
    "/SC",
    "ONLOGON",
    "/TR",
    quotedTaskPath("panel"),
    "/F",
  ]);
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$task = Get-ScheduledTask -TaskName '${taskNames.panel}'; $task.Settings.ExecutionTimeLimit = 'PT0S'; Set-ScheduledTask -InputObject $task | Out-Null`,
  ], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

export async function runWindowsPanelTask() {
  await runSchtasks(["/Run", "/TN", taskNames.panel]);
}

export async function installWindowsWatchdogTask() {
  await writeTaskScript("watchdog", watchdogScriptPath, []);
  await runSchtasks([
    "/Create",
    "/TN",
    taskNames.watchdog,
    "/SC",
    "MINUTE",
    "/MO",
    "30",
    "/TR",
    quotedTaskPath("watchdog"),
    "/F",
  ]);
}

export { taskNames };
