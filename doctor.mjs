import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import "./env.mjs";
import {
  here,
  jobs,
  panelLabel,
  readAgentEnabled,
  readAgentLoaded,
  readJobTime,
  watchdogLabel,
} from "./launchd.mjs";
import {
  readWindowsSchedule,
  readWindowsTask,
  taskNames,
} from "./windows-scheduler.mjs";
import { panelListenUrl, panelLocalUrl } from "./panel-config.mjs";
import { readRuntimeState } from "./runtime-state.mjs";
import { logRetentionMs } from "./log-retention.mjs";

const execFileAsync = promisify(execFile);
const holidayApi = process.env.AC_HOLIDAY_API || "https://api.jiejiariapi.com/v1/holidays";
const holidayCacheDir = process.env.AC_HOLIDAY_CACHE_DIR || path.join(here, "holiday-cache");
const logsDir = path.join(here, "logs");
const requiredKeys = [
  "AC_BASE_URL",
  "AC_USERNAME",
  "AC_MODE_ORD",
  "AC_TEMP_ORD",
  "AC_VAV_BASE_ORD",
  "AC_VAVS",
];

function check(name, ok, detail) {
  return { name, ok, detail };
}

export function windowsTaskHealthy(task, requiredState) {
  if (!task.exists || !task.enabled) return false;
  const state = String(task.state || "").toLowerCase();
  if (requiredState && state !== requiredState.toLowerCase()) return false;
  return state === "running" || task.lastResult === 0;
}

function windowsTaskDetail(task) {
  if (!task.exists) return "任务不存在";
  const enabled = task.enabled ? "已启用" : "已禁用";
  const result = task.lastResult ?? "未知";
  const lastRun = task.lastRun ? `，上次运行 ${task.lastRun}` : "";
  return `${enabled}，状态 ${task.state}，上次结果 ${result}${lastRun}`;
}

function clean(value) {
  return String(value || "")
    .replaceAll(here, "<project>")
    .replaceAll(process.env.AC_PASSWORD || "\u0000", "[redacted]");
}

async function panelHealthy() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(panelLocalUrl, { method: "HEAD", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function keychainPasswordPresent() {
  if (!process.env.AC_USERNAME) return false;
  try {
    await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      process.env.AC_KEYCHAIN_SERVICE || "company-ac",
      "-a",
      process.env.AC_USERNAME,
      "-w",
    ]);
    return true;
  } catch {
    return false;
  }
}

async function readMacSchedule() {
  const onEnabled = await readAgentEnabled(jobs.on.label);
  const offEnabled = await readAgentEnabled(jobs.off.label);
  const onLoaded = await readAgentLoaded(jobs.on.label);
  const offLoaded = await readAgentLoaded(jobs.off.label);
  return {
    on: await readJobTime("on"),
    off: await readJobTime("off"),
    enabled: onEnabled && offEnabled && onLoaded && offLoaded,
    jobs: {
      on: { enabled: onEnabled, loaded: onLoaded },
      off: { enabled: offEnabled, loaded: offLoaded },
    },
  };
}

async function scheduleCheck() {
  try {
    const schedule = process.platform === "win32" ? await readWindowsSchedule() : await readMacSchedule();
    return check(
      "定时任务",
      schedule.enabled,
      schedule.enabled ? `运行中，打开 ${schedule.on}，关闭 ${schedule.off}` : `未完整启用，打开 ${schedule.on}，关闭 ${schedule.off}`,
    );
  } catch (error) {
    return check("定时任务", false, clean(error.message));
  }
}

async function watchdogCheck() {
  try {
    if (process.platform === "win32") {
      const task = await readWindowsTask(taskNames.watchdog);
      return check("看门狗", windowsTaskHealthy(task), `${windowsTaskDetail(task)}，每 30 分钟检查一次`);
    }
    const loaded = await readAgentLoaded(watchdogLabel);
    const enabled = await readAgentEnabled(watchdogLabel);
    return check("看门狗", loaded && enabled, loaded && enabled ? "macOS LaunchAgent 已加载" : "macOS 看门狗未完整启用");
  } catch (error) {
    return check("看门狗", false, clean(error.message));
  }
}

async function panelTaskCheck() {
  try {
    if (process.platform === "win32") {
      const task = await readWindowsTask(taskNames.panel);
      return check("面板任务", windowsTaskHealthy(task, "Running"), windowsTaskDetail(task));
    }
    const loaded = await readAgentLoaded(panelLabel);
    const enabled = await readAgentEnabled(panelLabel);
    return check("面板任务", loaded && enabled, loaded && enabled ? "macOS LaunchAgent 已加载" : "macOS 面板任务未完整启用");
  } catch (error) {
    return check("面板任务", false, clean(error.message));
  }
}

async function holidayCheck() {
  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).format(new Date());
  let cached = false;
  try {
    await fs.access(path.join(holidayCacheDir, `${year}.json`));
    cached = true;
  } catch {}

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${holidayApi}/${year}`, { signal: controller.signal });
    return check("节假日数据", response.ok || cached, response.ok ? `${year} 年节假日 API 可访问` : `${year} 年缓存存在，API 返回 ${response.status}`);
  } catch (error) {
    return check("节假日数据", cached, cached ? `${year} 年缓存存在，API 暂不可用` : clean(error.message));
  } finally {
    clearTimeout(timeout);
  }
}

async function passwordCheck() {
  if (process.platform === "darwin") {
    const ok = await keychainPasswordPresent();
    return check("密码配置", ok, ok ? "macOS Keychain 已配置" : "macOS Keychain 未找到密码");
  }
  const ok = Boolean(process.env.AC_PASSWORD);
  return check("密码配置", ok, ok ? "AC_PASSWORD 已配置" : "AC_PASSWORD 未配置");
}

export async function recentLogSummary(directory = logsDir, now = Date.now()) {
  const files = ["panel.detail.log", "panel.err.log", "watchdog.err.log", "on.err.log", "off.err.log"];
  const result = [];
  for (const file of files) {
    try {
      const filePath = path.join(directory, file);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < now - logRetentionMs) continue;
      const lines = (await fs.readFile(filePath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-20)
        .map(clean);
      if (lines.length) result.push({ file, modifiedAt: stat.mtime.toISOString(), lines });
    } catch (error) {
      if (error.code !== "ENOENT") result.push({ file, lines: [clean(error.message)] });
    }
  }
  return result;
}

export async function logRetentionCheck(directory = logsDir, now = Date.now()) {
  const cutoff = now - logRetentionMs;
  const longRunningLogs = new Set(["panel.log", "panel.err.log"]);
  const expired = [];
  try {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".log") || longRunningLogs.has(entry.name)) continue;
      const stat = await fs.stat(path.join(directory, entry.name));
      if (stat.mtimeMs < cutoff) expired.push(entry.name);
    }
  } catch (error) {
    if (error.code !== "ENOENT") return check("日志保留", false, clean(error.message));
  }
  return check(
    "日志保留",
    expired.length === 0,
    expired.length ? `发现超过 7 天的日志：${expired.join(", ")}` : "未发现超过 7 天的日志文件",
  );
}

export async function readDiagnostics() {
  const missing = requiredKeys.filter((key) => !process.env[key]);
  const checks = [
    check("基础配置", missing.length === 0, missing.length ? `缺少 ${missing.join(", ")}` : "必要配置已填写"),
    await passwordCheck(),
    check("本地面板", await panelHealthy(), `${panelLocalUrl}`),
    await panelTaskCheck(),
    await scheduleCheck(),
    await watchdogCheck(),
    await holidayCheck(),
    await logRetentionCheck(),
  ];

  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    panelUrl: panelLocalUrl,
    listenUrl: panelListenUrl,
    ok: checks.every((item) => item.ok),
    checks,
    runtime: await readRuntimeState(),
    recentLogs: await recentLogSummary(),
  };
}

function printDiagnostics(data) {
  console.log(`诊断时间：${data.generatedAt}`);
  console.log(`运行平台：${data.platform}`);
  console.log(`面板地址：${data.listenUrl}`);
  for (const item of data.checks) {
    console.log(`${item.ok ? "OK" : "FAIL"} ${item.name}：${item.detail}`);
  }
  console.log(`总体状态：${data.ok ? "OK" : "FAIL"}`);
  if (data.runtime?.last) {
    const last = data.runtime.last;
    console.log(`上次执行：${last.action} ${last.ok ? "OK" : "FAIL"} ${last.skipped ? "SKIPPED" : ""} ${last.detail || last.error}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await readDiagnostics();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    printDiagnostics(data);
  }
  if (!data.ok) process.exitCode = 1;
}
