import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requiredEnv } from "./env.mjs";
import { readDiagnostics } from "./doctor.mjs";
import { isTransientNetworkError } from "./retry.mjs";
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
let controlRunning = false;

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

function isControlBusyError(error) {
  return `${error.message || ""}\n${error.stderr || ""}`.includes("Another AC control action is still running");
}

async function recordError(scope, error) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const body = `[${new Date().toISOString()}] ${id} ${scope}\n${detailedError(error)}\n\n`;
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(path.join(logsDir, panelDetailLog), body);
  return id;
}

async function sendError(res, scope, error) {
  if (isControlBusyError(error)) {
    error.statusCode = 409;
    error.message = "定时任务或其他空调操作正在执行，请稍后再试";
  }
  if (error.statusCode === 409) {
    res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
    res.end(error.message);
    return;
  }
  let id = "unknown";
  try {
    id = await recordError(scope, error);
  } catch (logError) {
    console.error(logError);
  }
  const detail = `详细信息已写入本机 logs/${panelDetailLog}。`;
  const message = isTransientNetworkError(error)
    ? `操作失败，错误编号 ${id}。暂时连不上空调服务器（网络超时或中断），请稍后重试。${detail}`
    : `操作失败，错误编号 ${id}。${detail}`;
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
    :root{color-scheme:light;--ink:#263238;--muted:#6a757d;--line:#e1e5e8;--canvas:#f6f7f8;--green:#24734a;--off:#55738d;font-family:"PingFang SC","Microsoft YaHei",-apple-system,sans-serif;font-synthesis:none}
    *{box-sizing:border-box}
    body{margin:0;background:var(--canvas);color:var(--ink);font-size:14px;line-height:1.5}
    button,input,select{font:inherit}
    button,a,input,select{-webkit-tap-highlight-color:transparent}
    button{cursor:pointer}
    button:disabled{cursor:default}
    button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #6a9f82;outline-offset:3px}
    a{color:inherit;text-decoration:none}
    svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
    .svg-library{position:absolute;width:0;height:0;overflow:hidden}
    .shell{width:min(1120px,calc(100% - 64px));margin:0 auto;padding:32px 0}
    .masthead{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:22px}
    h1{margin:0;font-size:24px;font-weight:600;overflow-wrap:anywhere}
    h2{margin:0;font-size:16px;font-weight:600}
    h3{margin:0;font-size:15px;font-weight:500}
    .header-right{display:flex;align-items:center;gap:16px;flex-shrink:0}
    .connection{font-size:12px;color:var(--muted)}
    .quiet-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:0 14px;border:1px solid #bed0e8;border-radius:7px;background:#eaf2fe;color:#275b99}
    .quiet-button:hover:not(:disabled){background:#dce9fb}
    .overview{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 22px;margin-bottom:28px;background:#fff;border:1px solid var(--line);border-radius:8px}
    .overview-status{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
    .overview-state{display:flex;align-items:center;gap:9px;font-size:18px;font-weight:600;color:var(--muted)}
    .overview-state::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;flex-shrink:0}
    .overview[data-state=on] .overview-state{color:var(--green)}
    .overview[data-state=off] .overview-state{color:var(--off)}
    .overview[data-state=mixed] .overview-state,.overview[data-state=unknown] .overview-state{color:#946116}
    .overview[data-state=error] .overview-state{color:#af3b35}
    .state-count{color:var(--muted);font-size:13px}
    .overview-temperature{display:flex;align-items:baseline;gap:8px;white-space:nowrap}
    .overview-temperature label{font-size:13px;color:var(--muted)}
    .overview-temperature strong{font-size:25px;font-weight:500}
    .overview-temperature small{font-size:13px}
    .numeric{font-variant-numeric:tabular-nums}
    .workspace{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:28px;align-items:start}
    .section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
    .unitGrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
    .unitColumn{display:grid;gap:14px}
    .unit{position:relative;border:1px solid var(--line);border-left:3px solid var(--off);border-radius:8px;background:#fff}
    .unit[data-on=true]{border-left-color:var(--green)}
    .unit[data-on=unknown]{border-left-color:#b88628}
    .unit summary{list-style:none;display:flex;align-items:center;gap:12px;padding:16px;min-height:92px;cursor:pointer}
    .unit summary:hover,.unit[open] summary{background:#f4f8fd}
    .unit summary .chevron{width:26px;height:26px;padding:5px;border-radius:6px;background:#eaf2fe;color:#275b99}
    .unit summary::-webkit-details-marker,.schedule-edit summary::-webkit-details-marker{display:none}
    .unitInfo{min-width:0;flex:1}
    .unitName{overflow-wrap:anywhere}
    .unitMeta{font-size:13px;margin-top:5px;color:var(--off)}
    .unit[data-on=true] .unitMeta{color:var(--green)}
    .unit[data-on=unknown] .unitMeta{color:#946116}
    .unitBadge{white-space:nowrap;font-size:13px}
    .unitBadge strong{font-size:24px;font-weight:500}
    .chevron{width:15px;height:15px;color:#8a949a}
    .unit[open] .chevron,.schedule-edit[open] .chevron{transform:rotate(180deg)}
    .unit[open]{z-index:2}
    .unitBody{padding:0 16px 16px;border-top:1px solid var(--line);background:#fff}
    .unitBody label{display:block;font-size:13px;margin-top:14px;color:var(--muted)}
    .unitBody select{display:block;width:100%;height:44px;margin-top:8px;padding:0 10px;border:1px solid #bed0e8;border-radius:6px;background:#eaf2fe;color:#275b99}
    .unitActions{display:flex;gap:8px;margin-top:12px}
    .unitActions button{flex:1;padding:0 8px;font-size:13px}
    .unitToggle[data-action=on]{background:#e7f2eb;border-color:#b6d1c0;color:var(--green)}
    .unitToggle[data-action=off]{background:#fbece9;border-color:#e0beb8;color:#a34439}
    .unitGrid[data-stale=true]{opacity:.5}
    .aside{display:grid;gap:18px}
    .card{border:1px solid var(--line);border-radius:8px;background:#fff;padding:20px}
    .card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .power{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:44px;margin:18px 0 20px;border:1px solid var(--green);border-radius:6px;background:var(--green);color:#fff;font-weight:500}
    .power:hover{background:#1c603c}
    .power.is-on{background:#a9473f;color:#fff;border-color:#a9473f}
    .power.is-on:hover:not(:disabled){background:#913d36}
    .temp-title{font-size:13px;color:var(--muted)}
    .temp-control{display:grid;grid-template-columns:44px 1fr 44px;align-items:center;gap:8px;margin:10px 0 14px}
    .step{width:44px;height:44px;display:grid;place-items:center;border:1px solid #bed0e8;border-radius:6px;background:#eaf2fe;color:#275b99;font-size:24px}
    .step:hover:not(:disabled){background:#dce9fb}
    .big-temp{display:flex;align-items:center;justify-content:center;gap:3px;font-size:40px;line-height:1.2}
    .big-temp select{width:85px;min-width:0;padding:0 4px;border:1px solid #bed0e8;border-radius:6px;background:#eaf2fe;color:#275b99;text-align:center;text-align-last:center;font:inherit;cursor:pointer}
    .big-temp small{font-size:17px;font-weight:400}
    .apply{width:100%;min-height:44px;border:1px solid #2e65aa;border-radius:6px;background:#2e65aa;color:#fff;font-weight:500}
    .apply:hover:not(:disabled){background:#24538e}
    .tag{font-size:13px;color:var(--green);white-space:nowrap}
    .tag[data-state=off]{color:var(--muted)}
    .tag[data-state=error]{color:#af3b35}
    .tag[data-state=loading]{color:var(--muted)}
    .schedule-times{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:20px 0}
    .schedule-time strong{display:block;font-size:26px;font-weight:500}
    .schedule-time span{display:block;font-size:12px;color:var(--muted);margin-top:2px}
    .schedule-edit{border-top:1px solid var(--line);padding-top:4px}
    .schedule-edit summary{display:flex;align-items:center;justify-content:space-between;min-height:44px;margin-top:10px;padding:0 12px;border:1px solid #bed0e8;border-radius:6px;background:#eaf2fe;color:#275b99;list-style:none;cursor:pointer;font-size:13px}
    .schedule-edit summary:hover{background:#dce9fb}
    .schedule-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:8px 0 14px}
    .schedule-fields label{min-width:0;font-size:13px;color:var(--muted)}
    input[type=time]{display:block;width:100%;min-width:0;max-width:100%;height:44px;margin-top:6px;padding:0 7px;border:1px solid #bed0e8;border-radius:6px;background:#eaf2fe;color:#275b99}
    .shell :is(button,select,input):disabled{background:#eef0f2;border-color:#dfe3e7;color:#8a949d;cursor:default;opacity:1}
    .schedule-detail{color:#af3b35;font-size:13px;overflow-wrap:anywhere}
    .schedule-detail:empty{display:none}
    .diagnostics{justify-self:end;display:flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;border:1px solid #bed0e8;border-radius:6px;background:#eaf2fe;color:#275b99;font-size:13px}
    .diagnostics:hover{background:#dce9fb}
    .diagnostics svg{width:16px;height:16px}
    .feedback{position:sticky;top:12px;z-index:3;margin:-12px 0 20px;padding:12px 16px;border:1px solid #bdd4c4;border-radius:6px;background:#edf6ef;color:#24633e;font-size:13px;line-height:1.7;overflow-wrap:anywhere}
    .feedback:empty{display:none}
    .feedback[data-kind=error]{border-color:#e3b6b2;background:#fff0ef;color:#af3b35}
    .feedback[data-kind=busy]{border-color:#e3d0a4;background:#fff8e9;color:#886118}
    @media(min-width:641px){.unitBody{position:absolute;left:-3px;right:-1px;top:calc(100% - 1px);border:1px solid var(--line);border-radius:0 0 8px 8px;box-shadow:0 8px 14px #26323814}}
    @media(max-width:1000px) and (min-width:641px){.workspace{grid-template-columns:1fr}.aside{grid-template-columns:1fr 1fr}.diagnostics{grid-column:1 / -1}}
    @media(max-width:640px){
      .shell{width:calc(100% - 32px);padding:20px 0}
      .masthead{gap:12px;margin-bottom:18px}
      h1{font-size:19px;line-height:1.4}
      .header-right .connection,.header-right button span{display:none}
      .header-right button{width:44px;padding:0}
      .overview{gap:12px;padding:14px 16px;margin-bottom:20px;align-items:center}
      .overview-status{display:block}
      .overview-state{font-size:16px;gap:7px}
      .state-count{display:block;margin-top:3px;font-size:12px}
      .overview-temperature{gap:5px;flex-wrap:wrap;justify-content:flex-end;max-width:104px}
      .overview-temperature label{width:100%;text-align:right;font-size:12px}
      .overview-temperature strong{font-size:24px;line-height:1.2}
      .workspace{display:flex;flex-direction:column;gap:24px}
      .aside{display:contents}
      .controls{order:-1;width:100%}
      .equipment,.schedule-card{width:100%}
      .card{padding:18px}
      .controls .power{margin:14px 0 16px}
      .unitGrid{grid-template-columns:1fr;gap:10px}
      .unitColumn{gap:10px}
      .unit summary{min-height:80px;padding:13px 16px}
      .unitMeta{margin-top:3px}
      .unitBody select,input[type=time]{font-size:16px}
      .schedule-fields{grid-template-columns:minmax(0,1fr)}
      .feedback{margin:-6px 0 16px;padding:10px 12px}
      .diagnostics{align-self:flex-end;margin-top:-12px}
    }
  </style>
</head>
<body>
<svg class="svg-library" aria-hidden="true"><defs>
  <symbol id="refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/></symbol>
  <symbol id="down" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></symbol>
  <symbol id="arrow" viewBox="0 0 24 24"><path d="M4 12h16m-5-5 5 5-5 5"/></symbol>
</defs></svg>
<main class="shell">
  <header class="masthead">
    <h1>${xml(panelTitle)}</h1>
    <div class="header-right"><span class="connection" id="lastUpdated">等待读取</span><button class="quiet-button" id="refreshStatus" type="button" aria-label="刷新设备状态"><svg aria-hidden="true"><use href="#refresh"/></svg><span>刷新</span></button></div>
  </header>
  <section class="overview" id="overview" data-state="loading" aria-label="空调概览">
    <div class="overview-status"><div class="overview-state" id="stateSummary">正在读取</div><span class="state-count" id="stateCount">— / — 台开启</span></div>
    <div class="overview-temperature"><label>统一设定</label><strong class="numeric" id="currentTemperature">—</strong><small>°C</small></div>
  </section>
  <div id="status" class="feedback" role="status" aria-live="polite"></div>
  <div class="workspace">
    <section class="equipment" id="equipment">
      <div class="section-head"><h2>单台空调</h2></div>
      <div class="unitGrid" id="unitGrid" aria-label="单台空调位置布局"></div>
    </section>
    <aside class="aside">
      <section class="card controls" id="control">
        <h2>全部空调</h2>
        <button class="power" id="powerToggle" type="button" disabled>等待读取设备状态</button>
        <div class="temp-title"><label for="temperature">设定温度</label></div>
        <div class="temp-control"><button class="step" id="tempMinus" type="button" aria-label="降低设定温度" disabled>−</button><div class="big-temp"><select id="temperature" aria-label="全部设备设定温度" disabled><option value="" selected>—</option>${Array.from({ length: 13 }, (_, index) => `<option value="${index + 18}">${index + 18}</option>`).join("")}</select><small>°C</small></div><button class="step" id="tempPlus" type="button" aria-label="提高设定温度" disabled>+</button></div>
        <button class="apply" id="tempSet" type="button" disabled>应用温度</button>
      </section>
      <section class="card schedule-card schedule" id="schedule">
        <div class="card-head"><h2>自动定时</h2><span class="tag" id="scheduleStatus" data-state="loading">读取中</span></div>
        <div class="schedule-times"><div class="schedule-time"><strong class="numeric" id="scheduleOnTime">—</strong><span>工作日开启</span></div><div class="schedule-time"><strong class="numeric" id="scheduleOffTime">—</strong><span>每天关闭</span></div></div>
        <p id="scheduleDetail" class="schedule-detail"></p>
        <details class="schedule-edit"><summary>修改定时<svg class="chevron" aria-hidden="true"><use href="#down"/></svg></summary><div class="schedule-fields"><label>开启时间<input id="scheduleOn" type="time" disabled></label><label>关闭时间<input id="scheduleOff" type="time" disabled></label></div><button class="apply" id="scheduleSave" type="button" disabled>保存时间</button><div class="unitActions"><button class="quiet-button" id="scheduleToggle" type="button" disabled>等待读取定时</button></div></details>
      </section>
      <a class="diagnostics" href="/doctor">系统诊断<svg aria-hidden="true"><use href="#arrow"/></svg></a>
    </aside>
  </div>
</main>
  <script>
    const status = document.querySelector("#status");
    const stateSummary = document.querySelector("#stateSummary");
    const overview = document.querySelector("#overview");
    const unitGrid = document.querySelector("#unitGrid");
    const powerToggle = document.querySelector("#powerToggle");
    const temperatureSelect = document.querySelector("#temperature");
    const scheduleOn = document.querySelector("#scheduleOn");
    const scheduleOff = document.querySelector("#scheduleOff");
    const scheduleToggle = document.querySelector("#scheduleToggle");
    const scheduleStatus = document.querySelector("#scheduleStatus");
    const temps = Array.from({ length: 13 }, (_, index) => String(index + 18));
    const unitColumns = ${JSON.stringify(unitColumns)};
    let controlBusy = false;
    let statusVersion = 0;
    let acState;
    let acReady = false;
    let scheduleState;

    function reportStatus(message, kind = "success") {
      status.textContent = message;
      status.dataset.kind = kind;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[char]);
    }

    function syncControls() {
      document.querySelectorAll("button, select, input").forEach((control) => control.disabled = controlBusy);
      powerToggle.disabled = controlBusy || !acReady;
      temperatureSelect.disabled = controlBusy || !acReady;
      const target = Number.parseFloat(temperatureSelect.value);
      const same = acState && [acState, ...acState.units].every((item) => Number.parseFloat(item.temperature) === target);
      document.querySelector("#tempSet").disabled = controlBusy || !acReady || !Number.isFinite(target) || same;
      document.querySelector("#tempMinus").disabled = controlBusy || !acReady || !Number.isFinite(target) || target <= 18;
      document.querySelector("#tempPlus").disabled = controlBusy || !acReady || !Number.isFinite(target) || target >= 30;
      [scheduleOn, scheduleOff, scheduleToggle, document.querySelector("#scheduleSave")]
        .forEach((control) => control.disabled = controlBusy || !scheduleState);
      unitGrid.querySelectorAll(".unitControls").forEach((controls) => {
        const unit = acState.units.find((item) => item.name === controls.dataset.unit);
        controls.querySelector(".unitToggle").disabled = controlBusy || !acReady || (!unit.on && !unit.off);
        const select = controls.querySelector(".unitTemp");
        select.disabled = controlBusy || !acReady;
        controls.querySelector(".unitTempSet").disabled = controlBusy || !acReady || !select.value
          || Number(select.value) === Number.parseFloat(unit.temperature);
      });
    }

    function setTemperatureValue(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      temperatureSelect.value = String(Math.max(18, Math.min(30, Math.round(numeric))));
      syncControls();
    }

    function renderAcStatus(data) {
      acState = data;
      acReady = true;
      const openUnits = new Set(Array.from(unitGrid.querySelectorAll(".unit[open]"), (unit) => unit.dataset.unit));
      const state = data.closed ? "off" : data.activeUnits === data.totalUnits ? "on" : data.activeUnits > 0 ? "mixed" : "unknown";
      overview.dataset.state = state;
      stateSummary.textContent = state === "off" ? "全部已关闭" : state === "on" ? "全部已开启" : state === "mixed" ? "部分已开启" : "状态待确认";
      document.querySelector("#stateCount").textContent = data.activeUnits + " / " + data.totalUnits + " 台开启";
      document.querySelector("#currentTemperature").textContent = Number.isFinite(Number.parseFloat(data.temperature)) ? String(Number.parseFloat(data.temperature)) : "—";
      document.querySelector("#lastUpdated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
      unitGrid.dataset.stale = "false";
      powerToggle.textContent = data.closed ? "开启全部空调" : "关闭全部空调";
      powerToggle.dataset.action = data.closed ? "on" : "off";
      powerToggle.classList.toggle("is-on", !data.closed);
      const byName = new Map(data.units.map((unit) => [unit.name, unit]));
      const columns = unitColumns.length ? unitColumns : [data.units.map((unit) => unit.name)];
      const orderedUnits = columns.map((column) => column.map((name) => byName.get(name)).filter(Boolean));
      for (const unit of data.units) {
        if (!columns.some((column) => column.includes(unit.name))) orderedUnits[orderedUnits.length - 1].push(unit);
      }
      const renderUnit = (unit) => {
        const unitState = unit.off ? "false" : unit.on ? "true" : "unknown";
        const unitClass = unit.off ? "offUnit" : unit.on ? "onUnit" : "unknownUnit";
        const numericTemp = Number.parseFloat(unit.temperature);
        const temp = Number.isFinite(numericTemp) ? String(Math.round(numericTemp)) : "";
        const shortName = /^VAV_.*_(\\d+)$/.exec(unit.name);
        const label = shortName ? shortName[1] + " 号空调" : unit.name;
        const options = (temp ? "" : '<option value="" selected>未读取</option>') + temps.map((item) => '<option value="' + item + '"' + (item === temp ? " selected" : "") + '>' + item + ' °C</option>').join("");
        return '<details class="unit ' + unitClass + '" data-unit="' + escapeHtml(unit.name) + '" data-on="' + unitState + '"' + (openUnits.has(unit.name) ? " open" : "") + '>' +
          '<summary><div class="unitInfo"><h3 class="unitName">' + escapeHtml(label) + '</h3>' +
          '<div class="unitMeta">' + (unit.off ? "已关闭" : unit.on ? "已开启" : "待确认") + '</div></div>' +
          '<div class="unitBadge" aria-label="设定温度 ' + (Number.isFinite(numericTemp) ? numericTemp + ' °C' : '未读取') + '"><strong class="numeric">' + (Number.isFinite(numericTemp) ? numericTemp : "—") + '</strong> °C</div>' +
          '<svg class="chevron" aria-hidden="true"><use href="#down"/></svg></summary>' +
          '<div class="unitBody unitControls" data-unit="' + escapeHtml(unit.name) + '">' +
          '<label>单台设定温度<select class="unitTemp" aria-label="' + escapeHtml(unit.name) + ' 设定温度">' + options + '</select></label>' +
          '<div class="unitActions"><button class="quiet-button unitToggle" type="button" data-action="' + (unit.on ? "off" : "on") + '">' + (unit.on ? "关闭这台" : "开启这台") + '</button>' +
          '<button class="quiet-button unitTempSet" type="button">应用温度</button></div></div></details>';
      };
      unitGrid.innerHTML = orderedUnits.map((column) => '<div class="unitColumn">' + column.map(renderUnit).join("") + '</div>').join("");
      const target = Number.parseFloat(data.temperature);
      temperatureSelect.value = Number.isFinite(target) ? String(Math.max(18, Math.min(30, Math.round(target)))) : "";
      syncControls();
    }

    function renderSchedule(data) {
      scheduleState = data;
      scheduleOn.value = data.on;
      scheduleOff.value = data.off;
      const state = data.state || (data.enabled ? "running" : "disabled");
      scheduleStatus.textContent = state === "running" ? "已启用" : state === "error" ? "异常" : "已暂停";
      scheduleStatus.dataset.state = state === "running" ? "on" : state === "error" ? "error" : "off";
      document.querySelector("#scheduleOnTime").textContent = data.on;
      document.querySelector("#scheduleOffTime").textContent = data.off;
      scheduleToggle.textContent = data.enabled ? "暂停自动定时" : "启用自动定时";
      scheduleToggle.dataset.enabled = String(state === "running");
      document.querySelector("#scheduleDetail").textContent = state === "error" ? "定时任务状态异常，请打开系统诊断检查。" : "";
      syncControls();
    }

    async function refreshSchedule() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch("/api/schedule", { signal: controller.signal });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        renderSchedule(data);
        return data;
      } catch (error) {
        scheduleState = null;
        scheduleStatus.textContent = "读取失败";
        scheduleStatus.dataset.state = "error";
        reportStatus(error.name === "AbortError" ? "定时读取超时，请刷新重试" : error.message, "error");
        syncControls();
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function refreshAcStatus(background = false) {
      const version = ++statusVersion;
      if (!background) {
        acReady = false;
        overview.dataset.state = "loading";
        stateSummary.textContent = "正在读取";
        document.querySelector("#stateCount").textContent = "正在读取…";
        syncControls();
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        const response = await fetch("/api/status", { signal: controller.signal });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        if (version !== statusVersion) return null;
        renderAcStatus(data);
        return data;
      } catch (error) {
        if (version !== statusVersion) return null;
        acReady = false;
        overview.dataset.state = "error";
        stateSummary.textContent = "读取失败";
        unitGrid.dataset.stale = "true";
        document.querySelector("#stateCount").textContent = acState ? "上次读取：" + acState.activeUnits + " / " + acState.totalUnits + " 台开启" : "请刷新重试";
        reportStatus(error.name === "AbortError" ? "状态读取超时，请刷新重试" : error.message, "error");
        syncControls();
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function refreshAllStatus() {
      await Promise.allSettled([refreshSchedule(), refreshAcStatus()]);
    }

    async function run(action) {
      if (controlBusy || !acReady) return;
      controlBusy = true;
      ++statusVersion;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 95000);
      syncControls();
      reportStatus("正在写入设备并核实实际状态…", "busy");
      try {
        const response = await fetch("/api/" + action, { method: "POST", signal: controller.signal });
        if (response.ok) {
          const result = await response.json();
          ++statusVersion;
          if (result.unit) {
            const units = acState.units.map((unit) => unit.name === result.unit.name ? result.unit : unit);
            renderAcStatus({ ...acState, units, activeUnits: units.filter((unit) => unit.on).length,
              closed: acState.mode === "非占用" && units.every((unit) => unit.off) });
          } else {
            renderAcStatus(result.status);
          }
          reportStatus(result.message);
        } else {
          reportStatus(await response.text(), "error");
          void refreshAcStatus(true);
        }
      } catch (error) {
        reportStatus(error.name === "AbortError" ? "请求超时，请先刷新设备状态" : error.message, "error");
        void refreshAcStatus(true);
      } finally {
        clearTimeout(timeout);
        controlBusy = false;
        syncControls();
      }
    }

    async function runSchedule(url) {
      if (controlBusy || !scheduleState) return;
      controlBusy = true;
      syncControls();
      reportStatus("正在保存定时设置…", "busy");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(url, { method: "POST", signal: controller.signal });
        const message = await response.text();
        if (!response.ok) throw new Error(message);
        if (await refreshSchedule()) reportStatus(message);
      } catch (error) {
        reportStatus(error.name === "AbortError" ? "保存超时，请刷新确认定时设置" : error.message, "error");
      } finally {
        clearTimeout(timeout);
        controlBusy = false;
        syncControls();
      }
    }

    powerToggle.addEventListener("click", () => run(powerToggle.dataset.action));
    document.querySelector("#tempMinus").addEventListener("click", () => setTemperatureValue(Number(temperatureSelect.value) - 1));
    document.querySelector("#tempPlus").addEventListener("click", () => setTemperatureValue(Number(temperatureSelect.value) + 1));
    temperatureSelect.addEventListener("change", () => setTemperatureValue(temperatureSelect.value));
    document.querySelector("#tempSet").addEventListener("click", () => run("temp?value=" + encodeURIComponent(temperatureSelect.value)));
    document.querySelector("#refreshStatus").addEventListener("click", async () => {
      reportStatus("正在刷新设备状态…", "busy");
      await refreshAllStatus();
      if (acReady && scheduleState) reportStatus("设备与定时状态已刷新");
    });
    unitGrid.addEventListener("click", (event) => {
      const controls = event.target.closest(".unitControls");
      if (!controls) return;
      const unit = controls.dataset.unit;
      if (event.target.classList.contains("unitToggle")) {
        run("unit/" + encodeURIComponent(unit) + "/" + event.target.dataset.action);
      } else if (event.target.classList.contains("unitTempSet")) {
        run("unit/" + encodeURIComponent(unit) + "/temp?value=" + encodeURIComponent(controls.querySelector(".unitTemp").value));
      }
    });
    unitGrid.addEventListener("change", syncControls);
    unitGrid.addEventListener("toggle", (event) => {
      if (!event.target.classList.contains("unit") || !event.target.open) return;
      unitGrid.querySelectorAll(".unit[open]").forEach((unit) => { if (unit !== event.target) unit.open = false; });
    }, true);
    document.querySelector("#scheduleSave").addEventListener("click", () => {
      if (!scheduleOn.value || !scheduleOff.value) return;
      runSchedule("/api/schedule?on=" + encodeURIComponent(scheduleOn.value) + "&off=" + encodeURIComponent(scheduleOff.value));
    });
    scheduleToggle.addEventListener("click", () => runSchedule("/api/schedule/enabled?value=" + (scheduleToggle.dataset.enabled === "true" ? "0" : "1")));

    refreshAllStatus();
  </script>
</body>
</html>`;
}

function diagnosticsHtml(data) {
  const rows = data.checks.map((item) => (
    `<article class="check"><div class="checkHeader"><h3>${xml(item.name)}</h3><span class="badge ${item.ok ? "ok" : "error"}">${item.ok ? "正常" : "异常"}</span></div><p>${xml(item.detail)}</p></article>`
  )).join("");
  const last = data.runtime?.last;
  const lastText = last
    ? `${new Date(last.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} ${last.source || "manual"} ${last.action} ${last.ok ? "OK" : "FAIL"}${last.skipped ? " SKIPPED" : ""} ${last.detail || last.error || ""}`
    : "暂无记录";
  const logBlocks = (data.recentLogs || []).map((item) => (
    `<h2>${xml(item.file)}${item.modifiedAt ? ` · ${xml(item.modifiedAt)}` : ""}</h2><pre>${xml(item.lines.join("\n"))}</pre>`
  )).join("") || "<div>暂无错误日志</div>";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${xml(panelTitle)} - 诊断</title>
  <style>
    :root { color-scheme: light; font-family: "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 40px 24px; background: #f1f5f2; color: #1d3431; line-height: 1.6; }
    main { max-width: 1000px; margin: 0 auto; display: grid; gap: 18px; min-width: 0; }
    h1 { margin: 0; font-size: 26px; font-weight: 650; }
    h2 { margin: 8px 0 0; font-size: 18px; }
    h3 { margin: 0; font-size: 14px; font-weight: 600; }
    a { width: fit-content; min-height: 44px; display: flex; align-items: center; color: #14745e; text-decoration: none; font-size: 13px; }
    a:focus-visible { outline: 3px solid #62a992; outline-offset: 4px; }
    .summary, .check, pre { border: 1px solid #dce5e1; border-radius: 12px; background: white; }
    .summary { padding: 22px; }
    .summaryHeader, .checkHeader { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .meta { margin-top: 12px; color: #687b77; font-size: 12px; overflow-wrap: anywhere; }
    .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .check { padding: 18px; min-width: 0; }
    .check p { margin: 12px 0 0; color: #526860; font-size: 12px; overflow-wrap: anywhere; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 6px; font-size: 12px; white-space: nowrap; }
    .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .ok { color: #1a6941; background: #d9efdf; }
    .error { color: #a43730; background: #fbe6e4; }
    pre { margin: 0; min-width: 0; padding: 16px; overflow: auto; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 640px) {
      body { padding: 20px 16px; }
      .checks { grid-template-columns: 1fr; }
      h1 { font-size: 22px; }
      .summary { padding: 18px; }
    }
  </style>
</head>
<body>
  <main>
    <a href="/">返回控制面板</a>
    <section class="summary">
      <div class="summaryHeader"><h1>系统诊断</h1><span class="badge ${data.ok ? "ok" : "error"}">${data.ok ? "运行正常" : "需要检查"}</span></div>
      <div class="meta">生成时间：${xml(new Date(data.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))}<br>面板监听：${xml(data.listenUrl || data.panelUrl)}<br>本机检测：${xml(data.panelUrl)}</div>
    </section>
    <h2>检查项</h2>
    <section class="checks" aria-label="系统检查项">${rows}</section>
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
    timeout: 45000,
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
  args.push("--json");
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: here,
    env: { ...process.env, AC_RUN_SOURCE: "panel" },
    timeout: 90000,
    maxBuffer: 1024 * 1024,
  });
  return {
    message: action === "temp" ? `已核实全部空调温度：${Number(value)} °C`
      : action === "on" ? "已核实全部空调打开" : "已核实全部空调关闭",
    status: JSON.parse(stdout),
  };
}

async function controlUnit(unit, action, value) {
  const command = action === "temp" ? "unit-temp" : `unit-${action}`;
  const args = [scriptPath, command, unit];
  if (action === "temp") {
    const temp = Number(value);
    if (!Number.isFinite(temp) || temp < 16 || temp > 30) throw new Error("温度必须在 16 到 30 °C 之间");
    args.push(String(temp));
  }
  args.push("--json");
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: here,
    env: { ...process.env, AC_RUN_SOURCE: "panel" },
    timeout: 90000,
    maxBuffer: 1024 * 1024,
  });
  return {
    message: action === "temp" ? `已核实单台温度：${Number(value)} °C`
      : action === "on" ? "已核实单台打开" : "已核实单台关闭",
    unit: JSON.parse(stdout),
  };
}

async function updateControl(operation) {
  if (controlRunning) {
    const error = new Error("另一项空调操作正在执行，请稍后再试");
    error.statusCode = 409;
    throw error;
  }
  controlRunning = true;
  try {
    return await operation();
  } finally {
    controlRunning = false;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
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
      const data = await acStatus();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
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
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(output));
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
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(output));
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
