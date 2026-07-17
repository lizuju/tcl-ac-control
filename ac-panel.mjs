import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requiredEnv } from "./env.mjs";
import { readDiagnostics } from "./doctor.mjs";
import { panelHost as host, panelListenUrl, panelLocalUrl, panelPort as port } from "./panel-config.mjs";
import {
  domain,
  execFileAsync as launchdExecFileAsync,
  here,
  jobs,
  launchAgentsDir,
  loadAgent,
  logsDir,
  nodePath,
  parseTime,
  plistPathFor,
  readAgentEnabled,
  readAgentLoaded,
  readJobTime,
  sh,
  xml,
} from "./launchd.mjs";
import {
  readWindowsSchedule,
  setWindowsScheduleEnabled,
  writeWindowsSchedule,
} from "./windows-scheduler.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(here, "ac-control.mjs");
const panelTitle = process.env.AC_PANEL_TITLE || "AC Control";
const panelDetailLog = "panel.detail.log";
const unitColumns = (process.env.AC_PANEL_UNIT_COLUMNS || "")
  .split("|")
  .map((column) => column.split(",").map((name) => name.trim()).filter(Boolean))
  .filter((column) => column.length);
const username = requiredEnv("AC_USERNAME");
const keychainService = process.env.AC_KEYCHAIN_SERVICE || "company-ac";
let scheduleQueue = Promise.resolve();
let controlQueue = Promise.resolve();

function redact(value) {
  return String(value || "").replaceAll(process.env.AC_PASSWORD || "\u0000", "[redacted]");
}

function detailedError(error) {
  return [
    error.stack || error.message,
    error.stdout && `stdout:\n${error.stdout}`,
    error.stderr && `stderr:\n${error.stderr}`,
  ].filter(Boolean).map(redact).join("\n");
}

async function recordError(scope, error) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const body = `[${new Date().toISOString()}] ${id} ${scope}\n${detailedError(error)}\n\n`;
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(path.join(logsDir, panelDetailLog), body);
  console.error(body.trimEnd());
  return id;
}

async function sendError(res, scope, error) {
  let id = "unknown";
  try {
    id = await recordError(scope, error);
  } catch (logError) {
    console.error(logError);
  }
  const message = `操作失败，错误编号 ${id}。详细信息已写入本机 logs/${panelDetailLog}。`;
  if (res.headersSent) {
    res.end(`\n${message}`);
    return;
  }
  res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function plist(label, action, hour, minute) {
  const command = [
    `cd ${sh(here)}`,
    `AC_PASSWORD="$(/usr/bin/security find-generic-password -s ${sh(keychainService)} -a ${sh(username)} -w)" AC_RUN_SOURCE=schedule ${sh(nodePath)} ${sh(scriptPath)} ${action}`,
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

async function writeJobFile(action, time) {
  const job = jobs[action];
  const { hour, minute } = parseTime(time);
  const plistPath = plistPathFor(job.label);

  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(plistPath, plist(job.label, action, hour, minute));
  return plistPath;
}

async function readJobEnabled(action) {
  return readAgentEnabled(jobs[action].label);
}

async function readJobLoaded(action) {
  return readAgentLoaded(jobs[action].label);
}

async function ensureJobLoaded(action, enabled) {
  if (!await readJobLoaded(action)) await loadAgent(jobs[action].label, plistPathFor(jobs[action].label), enabled);
}

async function setMacScheduleEnabled(enabled) {
  if (enabled) {
    for (const action of Object.keys(jobs)) await ensureJobLoaded(action, true);
  }
  for (const job of Object.values(jobs)) {
    await launchdExecFileAsync("/bin/launchctl", [enabled ? "enable" : "disable", `${domain}/${job.label}`]);
  }
  return readMacSchedule();
}

async function updateSchedule(operation) {
  scheduleQueue = scheduleQueue.then(operation, operation);
  return scheduleQueue;
}

async function readMacSchedule() {
  const onEnabled = await readJobEnabled("on");
  const offEnabled = await readJobEnabled("off");
  const onLoaded = await readJobLoaded("on");
  const offLoaded = await readJobLoaded("off");
  const enabled = onEnabled && offEnabled && onLoaded && offLoaded;
  const disabled = !onEnabled && !offEnabled;
  return {
    on: await readJobTime("on"),
    off: await readJobTime("off"),
    enabled,
    state: enabled ? "running" : disabled ? "disabled" : "error",
    jobs: {
      on: { enabled: onEnabled, loaded: onLoaded },
      off: { enabled: offEnabled, loaded: offLoaded },
    },
  };
}

async function writeMacSchedule(on, off) {
  parseTime(on);
  parseTime(off);
  const enabled = (await readMacSchedule()).enabled;
  await writeJobFile("on", on);
  await writeJobFile("off", off);
  if (enabled) {
    await loadAgent(jobs.on.label, plistPathFor(jobs.on.label), true);
    await loadAgent(jobs.off.label, plistPathFor(jobs.off.label), true);
  } else {
    await setMacScheduleEnabled(false);
  }
  return readMacSchedule();
}

async function setScheduleEnabled(enabled) {
  if (process.platform === "win32") return setWindowsScheduleEnabled(enabled);
  return setMacScheduleEnabled(enabled);
}

async function readSchedule() {
  if (process.platform === "win32") return readWindowsSchedule();
  return readMacSchedule();
}

async function writeSchedule(on, off) {
  if (process.platform === "win32") return writeWindowsSchedule(on, off);
  return writeMacSchedule(on, off);
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${xml(panelTitle)}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 0; background: #f5f7f8; color: #172026; box-sizing: border-box; }
    main { width: min(980px, calc(100vw - 32px)); }
    h1 { margin: 0 0 20px; font-size: 28px; font-weight: 700; letter-spacing: 0; }
    .remote { display: none; }
    .remoteCard { display: grid; gap: 14px; padding: 14px; border: 1px solid #cbd5e1; border-radius: 8px; background: white; }
    .remoteStatusRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .remoteStatusText { display: grid; gap: 8px; min-width: 0; }
    .remoteStatusTitle { font-size: 13px; line-height: 1; font-weight: 700; color: #64748b; }
    .remoteMeta { min-width: 0; color: #344054; font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .remotePower { height: 88px; font-size: 28px; }
    .remotePower.powerToggleOn { background: #b42318; }
    .remotePower.powerToggleOff { background: #177245; }
    .remoteTemperature { display: grid; grid-template-columns: 64px minmax(0, 1fr) 64px; gap: 8px; }
    .remoteStep { height: 56px; background: #334155; font-size: 30px; line-height: 1; }
    .remoteTempValue { display: grid; place-items: center; height: 56px; border: 1px solid #cbd5e1; border-radius: 8px; background: white; color: #172026; font-size: 28px; font-weight: 800; box-sizing: border-box; }
    .remoteTempSave { height: 54px; background: #175cd3; font-size: 18px; }
    .remoteSchedule { display: inline-flex; align-items: center; gap: 8px; min-width: 0; color: #344054; font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .remoteSchedule.runningSchedule { color: #166534; }
    .remoteSchedule.disabledSchedule { color: #991b1b; }
    .remoteSchedule.errorSchedule { color: #92400e; }
    .remoteNavGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .remoteNav { display: grid; place-items: center; height: 44px; padding: 0 6px; border-radius: 8px; background: #e2e8f0; color: #172026; font-size: 14px; font-weight: 700; text-decoration: none; box-sizing: border-box; }
    button.remoteNav { color: #172026; }
    .remoteRefresh { height: 36px; padding: 0 12px; background: #475569; font-size: 14px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(360px, .85fr); gap: 24px; align-items: start; }
    .controls { display: grid; gap: 12px; }
    .panel { display: grid; gap: 12px; }
    .temp { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }
    .state { display: grid; gap: 12px; }
    .stateHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .stateSummary { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-height: 40px; }
    .statePill { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 8px; font-size: 15px; font-weight: 700; background: #e2e8f0; color: #334155; }
    .statePill.onState { background: #dcfce7; color: #166534; }
    .statePill.offState { background: #fee2e2; color: #991b1b; }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: currentColor; }
    .unitGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: start; }
    .unitColumn { display: grid; gap: 10px; }
    .unit { border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; background: white; display: grid; gap: 8px; }
    .unitTop { display: flex; gap: 10px; align-items: center; min-width: 0; }
    .unitInfo { min-width: 0; }
    .unitBadge { display: grid; place-items: center; flex: 0 0 auto; min-width: 82px; height: 36px; padding: 0 6px; border: 1px solid #93c5fd; border-radius: 8px; background: #eff6ff; box-sizing: border-box; }
    .unitTempValue { font-size: 13px; font-weight: 800; color: #0f172a; line-height: 1; text-align: center; white-space: nowrap; }
    .unitName { font-size: 13px; font-weight: 800; color: #172026; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .unitMeta { font-size: 12px; color: #475569; margin-top: 2px; }
    .unitControls { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; align-items: center; }
    .unitTempRow { display: grid; grid-template-columns: minmax(0, 2fr) minmax(104px, 1fr); gap: 6px; grid-column: 1 / -1; }
    .unitControls button, .unitControls select { height: 34px; font-size: 13px; border-radius: 8px; }
    .unitControls select { padding: 0 8px; }
    .unitControls button { padding: 0 6px; white-space: nowrap; }
    .unitToggle { grid-column: 1 / -1; }
    .unitToggleOn { background: #b42318; }
    .unitToggleOff { background: #177245; }
    .unitTempSet { background: #175cd3; }
    .unitTempStepper { display: none; }
    .unit.onUnit { border-color: #86efac; }
    .unit.offUnit { border-color: #fca5a5; }
    .schedule { margin-top: 10px; display: grid; gap: 12px; }
    .scheduleHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .scheduleTitle { display: inline-flex; align-items: center; gap: 8px; }
    h2 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: 0; }
    #scheduleInfo { width: 22px; height: 22px; border-radius: 999px; padding: 0; font-size: 14px; line-height: 22px; background: #e2e8f0; color: #334155; }
    .scheduleGrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; align-items: end; }
    label { display: grid; gap: 6px; font-size: 14px; font-weight: 600; color: #344054; }
    select, input { height: 56px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 0 14px; font-size: 20px; background: white; color: #172026; box-sizing: border-box; min-width: 0; }
    button { height: 64px; border: 0; border-radius: 8px; font-size: 20px; font-weight: 700; cursor: pointer; color: white; }
    button:disabled { opacity: .55; cursor: wait; }
    #powerToggle.powerToggleOn { background: #b42318; }
    #powerToggle.powerToggleOff { background: #177245; }
    #tempSet { height: 56px; background: #175cd3; }
    #scheduleSave { height: 56px; background: #334155; }
    #scheduleStatus { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 8px; font-size: 15px; font-weight: 700; background: #dcfce7; color: #166534; }
    #scheduleStatus.disabledSchedule { background: #fee2e2; color: #991b1b; }
    #scheduleStatus.errorSchedule { background: #fef3c7; color: #92400e; }
    .scheduleDetail { min-height: 20px; font-size: 13px; line-height: 1.35; color: #64748b; }
    #scheduleToggle { height: 56px; background: #b42318; }
    #scheduleToggle.disabledSchedule { background: #177245; }
    .desktopDoctor { display: grid; place-items: center; height: 56px; border-radius: 8px; background: #334155; color: white; font-size: 20px; font-weight: 700; text-decoration: none; box-sizing: border-box; }
    #refreshStatus { height: 40px; padding: 0 14px; font-size: 15px; background: #475569; }
    #status { min-height: 52px; white-space: pre-wrap; font-size: 15px; line-height: 1.45; color: #344054; }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      body { display: block; min-height: 100vh; padding: 24px 0 28px; }
      main { width: min(460px, calc(100vw - 24px)); margin: 0 auto; }
      h1 { margin-bottom: 16px; font-size: 28px; line-height: 1.15; }
      .remote { display: grid; gap: 12px; margin-bottom: 18px; }
      .layout { display: block; }
      .controls { margin-top: 18px; }
      .controls .panel, .controls > .temp { display: none; }
      .desktopDoctor { display: none; }
      .state { gap: 10px; }
      .stateSummary { display: none; }
      .stateHeader h2 { font-size: 17px; }
      #refreshStatus { display: none; }
      .unitGrid { grid-template-columns: 1fr; }
      .unit { padding: 10px; gap: 8px; }
      .unitTop { display: grid; grid-template-columns: 1fr; gap: 6px; }
      .unitBadge { width: fit-content; max-width: 100%; min-width: 0; height: 32px; padding: 0 10px; overflow: hidden; }
      .unitTempValue { font-size: 14px; }
      .unitName { font-size: 15px; }
      .unitMeta { font-size: 14px; }
      .unitControls { gap: 8px; }
      .unitControls .unitToggle { height: 58px; font-size: 20px; }
      .unitTempRow { grid-template-columns: 1fr; gap: 8px; }
      .unitTemp { display: none; }
      .unitTempStepper { display: grid; grid-template-columns: 58px minmax(0, 1fr) 58px; gap: 8px; }
      .unitControls .unitTempStep { height: 48px; background: #334155; font-size: 26px; line-height: 1; }
      .unitTempDisplay { display: grid; place-items: center; height: 48px; border: 1px solid #cbd5e1; border-radius: 8px; background: white; color: #172026; font-size: 22px; font-weight: 800; box-sizing: border-box; }
      .unitControls button, .unitControls select { height: 44px; font-size: 16px; }
      .unitControls button { padding: 0 8px; }
      .unitControls .unitTempSet { height: 48px; font-size: 18px; }
      .schedule { padding: 14px; border: 1px solid #cbd5e1; border-radius: 8px; background: white; }
      .scheduleHeader { align-items: start; }
      .scheduleGrid { grid-template-columns: 1fr 1fr; gap: 10px; }
      .scheduleGrid label { gap: 8px; }
      .scheduleGrid input { height: 64px; padding: 0 8px; font-size: 20px; font-weight: 800; text-align: center; }
      .scheduleGrid input::-webkit-calendar-picker-indicator { margin: 0; padding: 0; }
      #scheduleSave { grid-column: 1 / -1; height: 54px; font-size: 18px; }
      #scheduleToggle { height: 58px; font-size: 19px; }
      .scheduleDetail { min-height: 0; }
      #status { min-height: 32px; }
    }
    @media (max-width: 560px) {
      .unitGrid { grid-template-columns: 1fr; }
      .scheduleGrid { grid-template-columns: 1fr 1fr; }
      #scheduleSave { grid-column: 1 / -1; }
    }
    @media (max-width: 360px) {
      .scheduleGrid input { padding: 0 6px; font-size: 18px; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111418; color: #f3f4f6; }
      label { color: #cbd5e1; }
      #scheduleInfo { background: #334155; color: #f8fafc; }
      select, input { background: #1f2937; color: #f3f4f6; border-color: #475569; }
      .remoteCard { background: #1f2937; border-color: #475569; }
      .remoteStatusTitle, .remoteMeta, .remoteSchedule { color: #cbd5e1; }
      .remoteSchedule.runningSchedule { color: #86efac; }
      .remoteSchedule.disabledSchedule { color: #fca5a5; }
      .remoteSchedule.errorSchedule { color: #fbbf24; }
      .remoteTempValue { background: #1f2937; color: #f8fafc; border-color: #475569; }
      .remoteNav { background: #334155; color: #f8fafc; }
      button.remoteNav { color: #f8fafc; }
      .unitTempDisplay { background: #1f2937; color: #f8fafc; border-color: #475569; }
      .unit { background: #1f2937; border-color: #475569; }
      .unitBadge { background: #172033; border-color: #3b82f6; }
      .unitTempValue { color: #f8fafc; }
      .unitName { color: #f3f4f6; }
      .unitMeta { color: #cbd5e1; }
      .schedule { background: #1f2937; border-color: #475569; }
      .scheduleDetail { color: #cbd5e1; }
      .desktopDoctor { background: #334155; color: #f8fafc; }
      #status { color: #cbd5e1; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${xml(panelTitle)}</h1>
    <section class="remote" aria-label="手机遥控器">
      <div class="remoteCard">
        <div class="remoteStatusRow">
          <div class="remoteStatusText">
            <div class="remoteStatusTitle">当前状态</div>
            <div id="remoteState" class="statePill"><span class="dot"></span>读取中</div>
          </div>
          <button id="remoteRefresh" class="remoteRefresh" type="button">刷新</button>
        </div>
        <div id="remoteMeta" class="remoteMeta">正在读取空调状态...</div>
        <button id="remotePower" class="remotePower powerToggleOn" type="button" data-action="on">打开空调</button>
        <div class="remoteTemperature" aria-label="温度控制">
          <button id="remoteTempMinus" class="remoteStep" type="button">-</button>
          <div id="remoteTempValue" class="remoteTempValue">22 °C</div>
          <button id="remoteTempPlus" class="remoteStep" type="button">+</button>
        </div>
        <button id="remoteTempSave" class="remoteTempSave" type="button">保存温度</button>
        <div id="remoteSchedule" class="remoteSchedule"><span class="dot"></span>定时读取中</div>
        <div class="remoteNavGrid">
          <button class="remoteNav" type="button" data-scroll="#unitGrid">单台空调</button>
          <button class="remoteNav" type="button" data-scroll=".schedule">定时任务</button>
          <a class="remoteNav" href="/doctor">系统诊断</a>
        </div>
      </div>
    </section>
    <div class="layout">
      <section class="state">
        <div class="stateHeader">
          <h2>当前状态</h2>
          <button id="refreshStatus" type="button">刷新</button>
        </div>
        <div id="stateSummary" class="stateSummary">读取中...</div>
        <div id="unitGrid" class="unitGrid"></div>
      </section>
      <section class="controls">
        <div class="panel">
          <h2>空调总开关</h2>
          <button id="powerToggle" class="powerToggleOn" type="button" data-action="on">打开空调</button>
        </div>
        <div class="temp">
          <select id="temperature" aria-label="温度">
            <option value="18">18 °C</option>
            <option value="19">19 °C</option>
            <option value="20">20 °C</option>
            <option value="21">21 °C</option>
            <option value="22" selected>22 °C</option>
            <option value="23">23 °C</option>
            <option value="24">24 °C</option>
            <option value="25">25 °C</option>
            <option value="26">26 °C</option>
            <option value="27">27 °C</option>
            <option value="28">28 °C</option>
            <option value="29">29 °C</option>
            <option value="30">30 °C</option>
          </select>
          <button id="tempSet" type="button">保存温度</button>
        </div>
        <div class="schedule">
          <div class="scheduleHeader">
            <div class="scheduleTitle">
              <h2>定时任务</h2>
              <button id="scheduleInfo" type="button" title="查看定时规则">!</button>
            </div>
            <span id="scheduleStatus"><span class="dot"></span>运行中</span>
          </div>
          <div class="scheduleGrid">
            <label>打开
              <input id="scheduleOn" type="time" value="09:30">
            </label>
            <label>关闭
              <input id="scheduleOff" type="time" value="17:50">
            </label>
            <button id="scheduleSave" type="button">保存定时</button>
          </div>
          <div id="scheduleDetail" class="scheduleDetail"></div>
          <button id="scheduleToggle" type="button">关闭定时任务</button>
        </div>
        <a class="desktopDoctor" href="/doctor">系统诊断</a>
        <div id="status">就绪</div>
      </section>
    </div>
  </main>
  <script>
    const status = document.querySelector("#status");
    const stateSummary = document.querySelector("#stateSummary");
    const unitGrid = document.querySelector("#unitGrid");
    const powerToggle = document.querySelector("#powerToggle");
    const temperatureSelect = document.querySelector("#temperature");
    const remoteState = document.querySelector("#remoteState");
    const remoteMeta = document.querySelector("#remoteMeta");
    const remotePower = document.querySelector("#remotePower");
    const remoteTempValue = document.querySelector("#remoteTempValue");
    const remoteSchedule = document.querySelector("#remoteSchedule");
    const scheduleOn = document.querySelector("#scheduleOn");
    const scheduleOff = document.querySelector("#scheduleOff");
    const scheduleToggle = document.querySelector("#scheduleToggle");
    const scheduleStatus = document.querySelector("#scheduleStatus");
    const scheduleDetail = document.querySelector("#scheduleDetail");
    const scheduleInfo = document.querySelector("#scheduleInfo");
    const temps = Array.from({ length: 13 }, (_, index) => String(index + 18));
    const unitColumns = ${JSON.stringify(unitColumns)};
    let showScheduleInfo = false;
    let selectedTemperature = temperatureSelect.value;

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]);
    }

    function syncPowerButton(button, allOff) {
      const powerAction = allOff ? "on" : "off";
      button.textContent = allOff ? "打开空调" : "关闭空调";
      button.dataset.action = powerAction;
      button.classList.toggle("powerToggleOn", powerAction === "on");
      button.classList.toggle("powerToggleOff", powerAction === "off");
    }

    function setTemperatureValue(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      const next = String(Math.max(18, Math.min(30, Math.round(numeric))));
      selectedTemperature = next;
      temperatureSelect.value = next;
      remoteTempValue.textContent = next + " °C";
    }

    function renderAcStatus(data) {
      const allOff = data.closed;
      const className = allOff ? "offState" : data.activeUnits > 0 ? "onState" : "";
      const label = allOff ? "已关闭" : data.activeUnits > 0 ? "运行中" : "未知";
      stateSummary.innerHTML =
        '<span class="statePill ' + className + '"><span class="dot"></span>' + label + '</span>' +
        '<span>模式 ' + escapeHtml(data.mode) + '</span>' +
        '<span>温度 ' + escapeHtml(data.temperature) + '</span>' +
        '<span>' + data.activeUnits + '/' + data.totalUnits + ' 台占用</span>';
      remoteState.className = "statePill " + className;
      remoteState.innerHTML = '<span class="dot"></span>' + label;
      remoteMeta.textContent = "模式 " + data.mode + " · 温度 " + data.temperature + " · " + data.activeUnits + "/" + data.totalUnits + " 台占用";
      syncPowerButton(powerToggle, allOff);
      syncPowerButton(remotePower, allOff);
      const byName = new Map(data.units.map((unit) => [unit.name, unit]));
      const columns = unitColumns.length ? unitColumns : [data.units.map((unit) => unit.name)];
      const orderedUnits = columns.map((column) => column.map((name) => byName.get(name)).filter(Boolean));
      for (const unit of data.units) {
        if (!columns.some((column) => column.includes(unit.name))) orderedUnits[orderedUnits.length - 1].push(unit);
      }
      const renderUnit = (unit) => {
        const unitClass = unit.off ? "offUnit" : unit.on ? "onUnit" : "";
        const temp = String(Math.round(Number.parseFloat(unit.temperature)));
        const badgeTemperature = unit.temperature.replace(/\s*°C$/, "°C");
        const options = temps.map((item) => '<option value="' + item + '"' + (item === temp ? " selected" : "") + '>' + item + ' °C</option>').join("");
        const toggleAction = unit.on ? "off" : "on";
        const toggleClass = unit.on ? "unitToggleOff" : "unitToggleOn";
        const toggleLabel = unit.on ? "关闭" : "打开";
        return '<div class="unit ' + unitClass + '">' +
          '<div class="unitTop">' +
            '<div class="unitBadge">' +
              '<div class="unitTempValue">' + escapeHtml(badgeTemperature) + '</div>' +
            '</div>' +
            '<div class="unitInfo">' +
              '<div class="unitName">' + escapeHtml(unit.name) + '</div>' +
              '<div class="unitMeta">' + escapeHtml(unit.mode) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="unitControls" data-unit="' + escapeHtml(unit.name) + '">' +
            '<button class="unitToggle ' + toggleClass + '" type="button" data-action="' + toggleAction + '">' + toggleLabel + '</button>' +
            '<div class="unitTempRow">' +
              '<select class="unitTemp" aria-label="' + escapeHtml(unit.name) + ' 温度">' + options + '</select>' +
              '<div class="unitTempStepper" aria-label="' + escapeHtml(unit.name) + ' 温度调节">' +
                '<button class="unitTempStep" type="button" data-step="-1">-</button>' +
                '<div class="unitTempDisplay">' + escapeHtml(temp) + ' °C</div>' +
                '<button class="unitTempStep" type="button" data-step="1">+</button>' +
              '</div>' +
              '<button class="unitTempSet" type="button">保存温度</button>' +
            '</div>' +
          '</div>' +
          '</div>';
      };
      unitGrid.innerHTML = orderedUnits
        .map((column) => '<div class="unitColumn">' + column.map(renderUnit).join("") + '</div>')
        .join("");
      const temp = String(Math.round(Number.parseFloat(data.temperature)));
      if (temperatureSelect.querySelector('option[value="' + temp + '"]')) temperatureSelect.value = temp;
      setTemperatureValue(temp);
    }

    function renderSchedule(data) {
      scheduleOn.value = data.on;
      scheduleOff.value = data.off;
      const state = data.state || (data.enabled ? "running" : "disabled");
      scheduleStatus.innerHTML = '<span class="dot"></span>' + (state === "running" ? "运行中" : state === "error" ? "异常" : "已关闭");
      scheduleStatus.classList.toggle("disabledSchedule", state === "disabled");
      scheduleStatus.classList.toggle("errorSchedule", state === "error");
      remoteSchedule.innerHTML = '<span class="dot"></span>' + (state === "running" ? "定时运行中" : state === "error" ? "定时异常" : "定时已关闭") + " · " + data.on + " / " + data.off;
      remoteSchedule.classList.toggle("runningSchedule", state === "running");
      remoteSchedule.classList.toggle("disabledSchedule", state === "disabled");
      remoteSchedule.classList.toggle("errorSchedule", state === "error");
      scheduleToggle.textContent = data.enabled ? "关闭定时任务" : "开启定时任务";
      scheduleToggle.classList.toggle("disabledSchedule", state === "running");
      scheduleToggle.dataset.enabled = String(state === "running");
      const onJob = data.jobs && data.jobs.on;
      const offJob = data.jobs && data.jobs.off;
      if (state === "error" && onJob && offJob) {
        const label = (job) => (job.enabled ? "已启用" : "已关闭") + " / " + (job.loaded ? "已加载" : "未加载");
        scheduleDetail.textContent = "打开：" + label(onJob) + "；关闭：" + label(offJob);
      } else if (showScheduleInfo) {
        scheduleDetail.textContent = "定时开启只在工作日执行，周末和中国节假日会自动跳过；定时关闭照常执行。";
      } else {
        scheduleDetail.textContent = "";
      }
    }

    async function refreshSchedule() {
      const response = await fetch("/api/schedule");
      if (!response.ok) throw new Error(await response.text());
      renderSchedule(await response.json());
    }

    async function refreshAcStatus() {
      stateSummary.textContent = "读取中...";
      remoteState.innerHTML = '<span class="dot"></span>读取中';
      remoteMeta.textContent = "正在读取空调状态...";
      try {
        const response = await fetch("/api/status");
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        renderAcStatus(data);
      } catch (error) {
        stateSummary.textContent = "状态读取失败：" + error.message;
        remoteState.className = "statePill";
        remoteState.innerHTML = '<span class="dot"></span>读取失败';
        remoteMeta.textContent = error.message;
      }
    }

    async function refreshAllStatus() {
      await Promise.allSettled([refreshSchedule(), refreshAcStatus()]);
    }

    async function run(action) {
      document.querySelectorAll("button").forEach((button) => button.disabled = true);
      status.textContent = "执行中...";
      try {
        const response = await fetch("/api/" + action, { method: "POST" });
        const body = await response.text();
        status.textContent = body || (response.ok ? "完成" : "失败");
      } catch (error) {
        status.textContent = error.message;
      } finally {
        await refreshAcStatus();
        document.querySelectorAll("button").forEach((button) => button.disabled = false);
      }
    }

    powerToggle.addEventListener("click", () => run(powerToggle.dataset.action || "on"));
    remotePower.addEventListener("click", () => run(remotePower.dataset.action || "on"));
    document.querySelector("#remoteRefresh").addEventListener("click", refreshAllStatus);
    document.querySelector("#remoteTempMinus").addEventListener("click", () => setTemperatureValue(Number(selectedTemperature) - 1));
    document.querySelector("#remoteTempPlus").addEventListener("click", () => setTemperatureValue(Number(selectedTemperature) + 1));
    document.querySelector("#remoteTempSave").addEventListener("click", () => {
      run("temp?value=" + encodeURIComponent(selectedTemperature));
    });
    document.querySelectorAll("[data-scroll]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = document.querySelector(button.dataset.scroll);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    temperatureSelect.addEventListener("change", () => setTemperatureValue(temperatureSelect.value));
    document.querySelector("#tempSet").addEventListener("click", () => {
      const value = temperatureSelect.value;
      run("temp?value=" + encodeURIComponent(value));
    });
    document.querySelector("#refreshStatus").addEventListener("click", refreshAllStatus);
    scheduleInfo.addEventListener("click", async () => {
      showScheduleInfo = !showScheduleInfo;
      await refreshSchedule();
    });
    unitGrid.addEventListener("click", (event) => {
      const controls = event.target.closest(".unitControls");
      if (!controls) return;
      const unit = controls.dataset.unit;
      if (event.target.classList.contains("unitToggle")) {
        run("unit/" + encodeURIComponent(unit) + "/" + event.target.dataset.action);
      } else if (event.target.classList.contains("unitTempStep")) {
        const select = controls.querySelector(".unitTemp");
        const next = Math.max(18, Math.min(30, Number(select.value) + Number(event.target.dataset.step)));
        select.value = String(next);
        controls.querySelector(".unitTempDisplay").textContent = next + " °C";
      } else if (event.target.classList.contains("unitTempSet")) {
        const value = controls.querySelector(".unitTemp").value;
        run("unit/" + encodeURIComponent(unit) + "/temp?value=" + encodeURIComponent(value));
      }
    });
    document.querySelector("#scheduleSave").addEventListener("click", async () => {
      document.querySelectorAll("button").forEach((button) => button.disabled = true);
      status.textContent = "保存中...";
      const on = scheduleOn.value;
      const off = scheduleOff.value;
      try {
        const response = await fetch("/api/schedule?on=" + encodeURIComponent(on) + "&off=" + encodeURIComponent(off), { method: "POST" });
        const body = await response.text();
        status.textContent = body || (response.ok ? "完成" : "失败");
        if (response.ok) await refreshSchedule();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        document.querySelectorAll("button").forEach((button) => button.disabled = false);
      }
    });
    scheduleToggle.addEventListener("click", async () => {
      document.querySelectorAll("button").forEach((button) => button.disabled = true);
      const next = scheduleToggle.dataset.enabled !== "true";
      status.textContent = "保存中...";
      try {
        const response = await fetch("/api/schedule/enabled?value=" + (next ? "1" : "0"), { method: "POST" });
        const body = await response.text();
        status.textContent = body || (response.ok ? "完成" : "失败");
        if (response.ok) await refreshSchedule();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        document.querySelectorAll("button").forEach((button) => button.disabled = false);
      }
    });

    refreshAllStatus();
  </script>
</body>
</html>`;
}

function diagnosticsHtml(data) {
  const rows = data.checks.map((item) => (
    `<tr><td>${item.ok ? "OK" : "FAIL"}</td><td>${xml(item.name)}</td><td>${xml(item.detail)}</td></tr>`
  )).join("");
  const last = data.runtime?.last;
  const lastText = last
    ? `${last.at} ${last.source || "manual"} ${last.action} ${last.ok ? "OK" : "FAIL"}${last.skipped ? " SKIPPED" : ""} ${last.detail || last.error || ""}`
    : "暂无记录";
  const logBlocks = (data.recentLogs || []).map((item) => (
    `<h2>${xml(item.file)}</h2><pre>${xml(item.lines.join("\n"))}</pre>`
  )).join("") || "<div>暂无错误日志</div>";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${xml(panelTitle)} - 诊断</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 32px; background: #f5f7f8; color: #172026; }
    main { max-width: 900px; margin: 0 auto; display: grid; gap: 16px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
    a { color: #175cd3; font-weight: 700; text-decoration: none; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; }
    th { color: #475569; font-size: 14px; }
    tr:last-child td { border-bottom: 0; }
    pre { margin: 0; padding: 12px; overflow: auto; background: white; border: 1px solid #cbd5e1; border-radius: 8px; line-height: 1.45; }
    @media (prefers-color-scheme: dark) {
      body { background: #111418; color: #f3f4f6; }
      table { background: #1f2937; border-color: #475569; }
      th, td { border-color: #334155; }
      th { color: #cbd5e1; }
      pre { background: #1f2937; border-color: #475569; }
    }
  </style>
</head>
<body>
  <main>
    <a href="/">返回控制面板</a>
    <h1>系统诊断：${data.ok ? "OK" : "FAIL"}</h1>
    <div>生成时间：${xml(data.generatedAt)}</div>
    <div>面板监听：${xml(data.listenUrl || data.panelUrl)}</div>
    <div>本机检测：${xml(data.panelUrl)}</div>
    <h2>检查项</h2>
    <table>
      <thead><tr><th>状态</th><th>项目</th><th>说明</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h2>上次执行</h2>
    <pre>${xml(lastText)}</pre>
    <h2>最近错误日志</h2>
    ${logBlocks}
  </main>
</body>
</html>`;
}

async function acStatus() {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "status", "--json"], {
    cwd: here,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function control(action, value) {
  const args = [scriptPath, action];
  if (action === "temp") {
    const temp = Number(value);
    if (!Number.isFinite(temp) || temp < 16 || temp > 30) throw new Error("温度必须在 16 到 30 °C 之间");
    args.push(String(temp));
  }
  if (action === "on") args.push("--force");
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: here,
    env: { ...process.env, AC_RUN_SOURCE: "panel" },
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  return (stdout + stderr).trim();
}

async function controlUnit(unit, action, value) {
  const command = action === "temp" ? "unit-temp" : `unit-${action}`;
  const args = [scriptPath, command, unit];
  if (action === "temp") {
    const temp = Number(value);
    if (!Number.isFinite(temp) || temp < 16 || temp > 30) throw new Error("温度必须在 16 到 30 °C 之间");
    args.push(String(temp));
  }
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: here,
    env: { ...process.env, AC_RUN_SOURCE: "panel" },
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  return (stdout + stderr).trim();
}

async function updateControl(operation) {
  controlQueue = controlQueue.then(operation, operation);
  return controlQueue;
}

const server = http.createServer(async (req, res) => {
  if ((req.method === "GET" || req.method === "HEAD") && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? "" : html());
    return;
  }

  const url = new URL(req.url || "/", panelLocalUrl);
  if (req.method === "GET" && url.pathname === "/doctor") {
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(diagnosticsHtml(await readDiagnostics()));
    } catch (error) {
      await sendError(res, "GET /doctor", error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/diagnostics") {
    try {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(await readDiagnostics()));
    } catch (error) {
      await sendError(res, "GET /api/diagnostics", error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    try {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(await acStatus()));
    } catch (error) {
      await sendError(res, "GET /api/status", error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/schedule") {
    try {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(await readSchedule()));
    } catch (error) {
      await sendError(res, "GET /api/schedule", error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/schedule/enabled") {
    try {
      const enabled = url.searchParams.get("value") === "1";
      await updateSchedule(() => setScheduleEnabled(enabled));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(enabled ? "已开启定时任务" : "已关闭定时任务");
    } catch (error) {
      await sendError(res, "POST /api/schedule/enabled", error);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/schedule") {
    try {
      const schedule = await updateSchedule(() => writeSchedule(url.searchParams.get("on"), url.searchParams.get("off")));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(`已保存定时：打开 ${schedule.on}，关闭 ${schedule.off}`);
    } catch (error) {
      await sendError(res, "POST /api/schedule", error);
    }
    return;
  }

  const match = /^\/api\/(on|off|temp)$/.exec(url.pathname);
  if (req.method === "POST" && match) {
    try {
      const output = await updateControl(() => control(match[1], url.searchParams.get("value")));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(output || "完成");
    } catch (error) {
      await sendError(res, `POST /api/${match[1]}`, error);
    }
    return;
  }

  const unitMatch = /^\/api\/unit\/([^/]+)\/(on|off|temp)$/.exec(url.pathname);
  if (req.method === "POST" && unitMatch) {
    try {
      const unit = decodeURIComponent(unitMatch[1]);
      const output = await updateControl(() => controlUnit(unit, unitMatch[2], url.searchParams.get("value")));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(output || "完成");
    } catch (error) {
      await sendError(res, `POST /api/unit/${unitMatch[2]}`, error);
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(port, host, () => {
  console.log(`AC panel: ${panelListenUrl}`);
});
