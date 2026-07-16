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
      return check("看门狗", task.exists, task.exists ? "Windows 任务已创建，每 30 分钟检查一次" : "Windows 看门狗任务不存在");
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
      return check("面板任务", task.exists, task.exists ? "Windows 登录任务已创建" : "Windows 面板任务不存在");
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

async function recentLogSummary() {
  const files = ["panel.detail.log", "panel.err.log", "watchdog.err.log", "on.err.log", "off.err.log"];
  const result = [];
  for (const file of files) {
    try {
      const lines = (await fs.readFile(path.join(logsDir, file), "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-20)
        .map(clean);
      if (lines.length) result.push({ file, lines });
    } catch (error) {
      if (error.code !== "ENOENT") result.push({ file, lines: [clean(error.message)] });
    }
  }
  return result;
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
    check("日志保留", true, "看门狗会清理 7 天前的日志文件"),
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
