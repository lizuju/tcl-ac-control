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
    :root{color-scheme:light;--ink:#1d3431;--muted:#687b77;--line:#dce5e1;--paper:#fff;--canvas:#f1f5f2;--green:#14745e;--soft:#eaf3ee;font-family:"PingFang SC","Microsoft YaHei",-apple-system,sans-serif;font-synthesis:none}
    *{box-sizing:border-box}
    html{scroll-behavior:smooth;scroll-padding-top:24px}
    body{margin:0;background:var(--canvas);color:var(--ink);font-size:14px;line-height:1.5}
    button,input,select{font:inherit}
    button,a,input,select{-webkit-tap-highlight-color:transparent}
    button{cursor:pointer}
    button:disabled{cursor:default;opacity:.45}
    button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #62a992;outline-offset:4px}
    a{color:inherit;text-decoration:none}
    svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
    .svg-library{position:absolute;width:0;height:0;overflow:hidden}
    .shell{width:min(1180px,calc(100% - 64px));margin:0 auto;padding:40px 0 24px}
    .masthead{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}
    .identity{display:flex;align-items:center;gap:14px}
    .brand{width:48px;height:48px;border-radius:13px;background:var(--ink);color:white;display:grid;place-items:center}
    .brand svg{width:27px;height:27px}
    .eyebrow{color:var(--muted);font-size:12px;letter-spacing:1.8px;margin-bottom:3px}
    h1{margin:0;font-size:26px;letter-spacing:-.6px;font-weight:650}
    h2{font-size:17px;line-height:1.4;margin:0;font-weight:650}
    h3{margin:0;font-size:15px;font-weight:600}
    .header-right{display:flex;align-items:center;gap:18px}
    .connection{font-size:12px;color:var(--muted)}
    .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#25825b;vertical-align:middle;margin-right:7px}
    .quiet-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font-size:13px}
    .quiet-button:hover{background:#f7faf8}
    .mobile-nav{display:none}
    .overview{display:grid;grid-template-columns:1.3fr 1fr 1.1fr;border:1px solid var(--line);border-radius:16px;background:var(--paper);padding:23px 26px;margin-bottom:28px;gap:24px}
    .overview>div+div{border-left:1px solid var(--line);padding-left:28px}
    .overline{font-size:12px;color:var(--muted);margin-bottom:9px}
    .overview-value{font-size:26px;font-weight:550;letter-spacing:-.8px;display:flex;align-items:baseline;gap:8px}
    .overview-value small{font-size:13px;color:var(--muted);font-weight:400;letter-spacing:0}
    .overview-note{font-size:12px;color:var(--muted);margin-top:5px}
    .numeric{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;letter-spacing:-1.5px;font-weight:500}
    .overview-state{font-size:22px;letter-spacing:-.4px}
    .overview-state svg{align-self:center;width:21px;height:21px;color:var(--muted);margin-right:2px}
    .workspace{display:grid;grid-template-columns:minmax(0,1fr) 332px;gap:28px;align-items:start}
    .section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;min-height:28px}
    .section-head span{font-size:12px;color:var(--muted)}
    .unitGrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
    .unitColumn{display:grid;gap:12px}
    .unit{border:1px solid var(--line);border-radius:13px;background:white;overflow:hidden}
    .unit summary{list-style:none;display:flex;gap:12px;align-items:center;padding:18px;cursor:pointer;min-height:102px}
    .unit summary::-webkit-details-marker{display:none}
    .unitIcon{width:39px;height:39px;border-radius:11px;background:#eff3f1;display:grid;place-items:center;color:#80918a;flex-shrink:0}
    .unit[data-on=true] .unitIcon{background:var(--soft);color:var(--green)}
    .unitInfo{min-width:0;flex:1}
    .unitCode{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--muted);margin-top:3px;letter-spacing:0}
    .unitMeta{font-size:11px;color:var(--muted);margin-top:4px}
    .unit[data-on=true] .unitMeta{color:var(--green)}
    .unitBadge{text-align:right;flex-shrink:0}
    .unitBadge strong{font-size:22px;letter-spacing:-1px;font-weight:500}
    .unitBadge small{font-size:11px;color:var(--muted);margin-left:2px}
    .chevron{color:#8b9b93;width:15px;height:15px;transition:transform .18s}
    .unit[open] .chevron{transform:rotate(180deg)}
    .unitBody{padding:0 18px 17px;border-top:1px solid #eff3f0}
    .unitBody label{display:block;color:var(--muted);font-size:12px;margin:14px 0 8px}
    .unitActions{display:flex;gap:8px;margin-top:12px}
    .unitActions button{flex:1;font-size:12px;padding:0 9px}
    .unitBody select{width:100%;height:44px;border:1px solid var(--line);border-radius:9px;padding:0 12px;background:white;color:var(--ink)}
    .aside{display:grid;gap:18px}
    .card{border:1px solid var(--line);border-radius:16px;background:white;padding:23px}
    .card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .scope{font-size:12px;color:var(--muted);margin-top:6px}
    .tag{font-size:11px;padding:4px 9px;border-radius:6px;background:var(--soft);color:var(--green);white-space:nowrap}
    .power{margin:20px 0 22px;width:100%;height:48px;display:flex;align-items:center;justify-content:center;gap:9px;border:1px solid var(--green);border-radius:10px;color:white;background:var(--green);font-size:14px;font-weight:550}
    .power:hover{background:#0f6451}
    .power.is-on{background:#fff;color:var(--ink);border-color:var(--line)}
    .power.is-on:hover{background:#f3f7f4}
    .temp-title{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)}
    .temp-title span+span{color:var(--green)}
    .temp-control{display:grid;grid-template-columns:44px 1fr 44px;align-items:center;gap:12px;margin:16px 0}
    .step{width:44px;height:44px;border:1px solid var(--line);background:#f7faf8;border-radius:10px;color:var(--ink);font-size:24px;font-weight:400;display:grid;place-items:center}
    .big-temp{text-align:center;font-size:50px;line-height:1.2;letter-spacing:-3px}
    .big-temp small{font:400 19px -apple-system,sans-serif;letter-spacing:0;color:var(--muted);margin-left:4px}
    .apply{width:100%;min-height:44px;border:1px solid #cfdcd3;border-radius:9px;background:var(--soft);color:var(--green);font-weight:550;font-size:13px}
    .apply:hover:not(:disabled){background:#dcebe1}
    .temp-hint{font-size:11px;color:var(--muted);margin:12px 0 0;line-height:1.6}
    .schedule-times{display:flex;align-items:center;justify-content:space-between;margin:22px 0 16px;gap:8px}
    .schedule-time strong{font-size:25px;letter-spacing:-1px;font-weight:500;display:block;line-height:1.2}
    .schedule-time span{display:block;font-size:11px;color:var(--muted);margin-top:6px}
    .schedule-line{flex:1;height:1px;background:var(--line);margin:0 15px 20px}
    .schedule-rule{font-size:11px;color:var(--muted);line-height:1.75;margin:0}
    .schedule-edit{margin-top:17px;border-top:1px solid var(--line);padding-top:13px}
    .schedule-edit summary{font-size:12px;color:var(--green);cursor:pointer;list-style:none;min-height:32px;display:flex;align-items:center;justify-content:space-between}
    .schedule-edit summary::-webkit-details-marker{display:none}
    .schedule-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:9px 0 12px}
    .schedule-fields label{font-size:11px;color:var(--muted)}
    input[type=time]{width:100%;height:42px;margin-top:6px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);padding:0 7px}
    .schedule-edit .unitActions{margin-top:10px}
    .schedule-edit button{min-height:44px}
    .diagnostics{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:48px;padding:0 6px;border:0;color:var(--muted);background:none;text-align:left;font-size:12px}
    .diagnostics span{display:flex;align-items:center;gap:8px}
    .diagnostics svg{width:18px;height:18px}
    .bottom-note{margin-top:23px;color:var(--muted);font-size:11px;display:flex;align-items:center;gap:6px}
    .bottom-note svg{width:14px;height:14px}
    .footer{display:flex;justify-content:space-between;border-top:1px solid var(--line);margin-top:36px;padding-top:16px;font-size:11px;color:var(--muted)}
    .overview-state svg{display:none}
    .overview-state span{display:inline-flex;align-items:center;gap:8px;padding:6px 11px;border-radius:8px;font-size:20px;line-height:1.35}
    .overview-state span::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
    .overview[data-state=off] .overview-state span{background:#e4edf7;color:#416888}
    .overview[data-state=on] .overview-state span{background:#d9efdf;color:#1a6941}
    .overview[data-state=mixed] .overview-state span{background:#fff0cb;color:#8a5c13}
    .unit{border-left-width:4px}
    .unit[data-on=false]{border-color:#c4d7e7;border-left-color:#7298be;background:#f7fafc}
    .unit[data-on=true]{border-color:#acd5b9;border-left-color:#278355;background:#f4fbf6}
    .unit[data-on=false] .unitIcon{background:#e3edf7;color:#4c7599}
    .unit[data-on=true] .unitIcon{background:#d8efdf;color:#1a6941}
    .unit .unitMeta{display:inline-flex;align-items:center;gap:5px;width:fit-content;font-size:11px;line-height:1.3;padding:3px 6px;border-radius:5px;margin-top:6px}
    .unit .unitMeta::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}
    .unit[data-on=false] .unitMeta{color:#416888;background:#e3edf7}
    .unit[data-on=true] .unitMeta{color:#1a6941;background:#d8efdf}
    .legend{display:flex;gap:12px;align-items:center}
    .legend .legend-item{font-size:11px;display:inline-flex;align-items:center;gap:5px}
    .legend-item::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
    .legend .legend-on{color:#24794d}
    .legend .legend-off{color:#557fa7}
    .position-note{font-size:11px;color:var(--muted);margin:-6px 0 13px}
    .unit .unitActions .unitToggle{background:#fff;border-color:#c3d4d0}
    .unit[data-on=false] .unitToggle{color:#146642;background:#e2f0e7;border-color:#bdd5c5}
    .unit[data-on=true] .unitToggle{color:#426380;background:#edf3f8;border-color:#bed0df}
    @media(min-width:1100px){.workspace{gap:34px}
    .unitGrid{gap:16px}
    .unitColumn{gap:16px}
    .unit summary{padding:20px}
    }
    @media(max-width:900px){.shell{width:calc(100% - 40px)}
    .workspace{grid-template-columns:1fr;gap:24px}
    .aside{grid-template-columns:1fr 1fr}
    .diagnostics{grid-column:1 / -1}
    .overview{padding:20px;gap:16px}
    .overview>div+div{padding-left:16px}
    .overview-value{font-size:23px}
    .overview-state{font-size:19px}
    .card{padding:20px}
    }
    @media(max-width:640px){html{scroll-padding-top:16px}
    .shell{width:calc(100% - 32px);padding-top:22px}
    .masthead{margin-bottom:20px}
    .identity{gap:10px}
    .brand{width:40px;height:40px;border-radius:11px}
    .brand svg{width:24px;height:24px}
    .eyebrow{font-size:10px;letter-spacing:1px}
    h1{font-size:21px;letter-spacing:-.5px}
    .header-right{gap:0}
    .header-right .connection{display:none}
    .header-right .quiet-button{width:44px;padding:0;border:0;background:transparent}
    .header-right .quiet-button span{display:none}
    .overview{grid-template-columns:1.35fr 1fr;gap:16px;padding:18px;margin-bottom:18px;border-radius:13px}
    .overview>div+div{padding-left:16px}
    .overview-value{font-size:25px}
    .overview-state{font-size:18px}
    .overview-state svg{display:none}
    .overview-note{font-size:11px}
    .overview .schedule-overview{display:none}
    .overview .overline{font-size:11px;margin-bottom:6px}
    .mobile-nav{display:flex;gap:6px;padding:4px;border:1px solid var(--line);border-radius:10px;margin-bottom:20px;background:#e7eee8}
    .mobile-nav a{flex:1;display:flex;align-items:center;justify-content:center;min-height:40px;border-radius:7px;font-size:12px;color:#536b5d}
    .workspace{display:flex;flex-direction:column;gap:26px}
    .aside{display:contents}
    .controls{order:-1;width:100%}
    .equipment{width:100%}
    .schedule-card{width:100%}
    .card{padding:20px;border-radius:13px}
    .controls .power{margin:16px 0 17px;height:46px}
    .controls .temp-title{padding-top:14px;border-top:1px solid var(--line)}
    .controls .temp-control{margin:12px 0}
    .controls .big-temp{font-size:43px}
    .controls .temp-hint{margin-top:9px}
    .controls .card-head h2{font-size:16px}
    .scope{font-size:11px}
    .section-head{margin-bottom:12px}
    .section-head h2{font-size:16px}
    .unitGrid{gap:10px;grid-template-columns:1fr}
    .unitColumn{gap:10px}
    .unit summary{min-height:90px;padding:15px;gap:11px}
    .unitIcon{width:35px;height:35px;border-radius:9px}
    .unitInfo h3{font-size:14px}
    .unitCode{font-size:9px}
    .unitMeta{font-size:10px;margin-top:2px}
    .unitBadge strong{font-size:24px}
    .chevron{margin-left:2px}
    .unitBody{padding:0 15px 15px}
    .unitBody select{font-size:16px}
    .unitActions button{font-size:13px}
    .bottom-note{margin-top:16px}
    .diagnostics{width:100%;padding:0 2px;margin-top:-12px}
    .schedule-times{margin-top:20px}
    .footer{margin-top:24px;font-size:10px}
    .footer span:last-child{display:none}
    }
    @media(max-width:640px){.shell{padding-top:16px}
    .masthead{margin-bottom:16px}
    .overview{padding:14px;margin-bottom:12px;align-items:center}
    .overview-value{line-height:1.2}
    .overview .overline{margin-bottom:4px}
    .overview>div:first-child .overline,.overview>div:nth-child(2) .overview-note{display:none}
    .overview-note{line-height:1.4;margin-top:4px}
    .mobile-nav{padding:0;border:0;background:transparent;margin-bottom:14px;gap:0;border-bottom:1px solid var(--line);border-radius:0}
    .mobile-nav a{min-height:38px;border-radius:0}
    .controls{padding:18px}
    .controls .scope{margin-top:4px}
    .controls .power{height:44px;margin:12px 0 13px}
    .controls .temp-title{padding-top:12px}
    .controls .temp-control{margin:10px 0}
    .controls .big-temp{font-size:40px}
    .controls .temp-hint{margin-top:8px}
    }
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}
    .chevron{transition:none}
    }
    h1{font-size:24px;overflow-wrap:anywhere}
    .identity>div:last-child{min-width:0}
    .identity{min-width:0}
    .header-right{flex-shrink:0}
    .big-temp{display:flex;align-items:center;justify-content:center;gap:2px}
    .big-temp select{appearance:none;-webkit-appearance:none;width:78px;min-width:0;padding:0;border:0;border-radius:6px;background:transparent;color:var(--ink);text-align:center;text-align-last:center;font:inherit;letter-spacing:inherit;cursor:pointer}
    .big-temp select:disabled{cursor:default}
    .unitMeta{white-space:nowrap}
    .unitName{overflow-wrap:anywhere}
    .unitBody label select{display:block;margin-top:8px}
    .unitGrid[data-stale=true]{opacity:.55}
    .unit[data-on=unknown]{border-color:#e5d7b6;border-left-color:#bd8b30;background:#fffbf2}
    .unit[data-on=unknown] .unitMeta{color:#8a5c13;background:#fff0cb}
    .overview[data-state=unknown] .overview-state span{background:#fff0cb;color:#8a5c13}
    .overview[data-state=error] .overview-state span{background:#fbe6e4;color:#a43730}
    .overview[data-state=loading] .overview-state span{background:#edf1ef;color:var(--muted)}
    .feedback{position:sticky;top:12px;z-index:3;margin:-8px 0 24px;padding:13px 16px;border:1px solid #b9d7c4;border-radius:10px;background:#e6f3eb;color:#1a6941;font-size:13px;line-height:1.7;overflow-wrap:anywhere}
    .feedback:empty{display:none}
    .feedback[data-kind=error]{border-color:#e7b6b1;background:#fceceb;color:#a43730}
    .feedback[data-kind=busy]{border-color:#e4d29e;background:#fff7df;color:#80601c}
    .feedback[data-kind=busy]::before{content:"";display:inline-block;vertical-align:middle;width:12px;height:12px;margin-right:9px;border:2px solid #d6c18c;border-top-color:#80601c;border-radius:50%;animation:spin 1s linear infinite}
    .tag[data-state=off]{color:#416888;background:#e4edf7}
    .tag[data-state=error],.overview-note[data-state=error]{color:#a43730}
    .tag[data-state=error]{background:#fbe6e4}
    .tag[data-state=loading]{color:var(--muted);background:#edf1ef}
    .overview-note[data-state=on]{color:#1a6941}
    .overview-note[data-state=off]{color:#416888}
    .schedule-detail{color:#a43730;font-size:12px;overflow-wrap:anywhere}
    .schedule-detail:empty{display:none}
    #scheduleTimes{font-size:23px;letter-spacing:-1px}
    .schedule-edit[open] .chevron{transform:rotate(180deg)}
    @keyframes spin{to{transform:rotate(360deg)}
    }
    @media(max-width:1000px) and (min-width:641px){.workspace{grid-template-columns:1fr}
    .aside{grid-template-columns:1fr 1fr}
    .diagnostics{grid-column:1 / -1}
    }
    @media(min-width:641px){.unit{position:relative;overflow:visible}
    .unit[open]{z-index:2}
    .unit[open] summary{border-radius:12px 12px 0 0}
    .unitBody{position:absolute;left:-1px;right:-1px;top:calc(100% - 1px);z-index:2;border:1px solid var(--line);border-top:0;border-radius:0 0 12px 12px;background:white;box-shadow:0 12px 20px #1d34311c}
    }
    @media(max-width:640px){h1{font-size:19px;line-height:1.35}
    .identity>div:last-child{max-width:245px}
    .shell{padding-top:20px}
    .unitGrid{grid-template-columns:1fr}
    .aside{display:contents}
    .unitBody select{font-size:16px}
    .unitActions button{min-height:44px}
    .overview>div:nth-child(2) .overview-note{display:block;font-size:10px;overflow-wrap:anywhere}
    .feedback{margin:0 0 14px;padding:10px 12px;font-size:12px}
    .overview-state span{font-size:16px;padding:5px 8px;gap:6px}
    .overview-state span::before{width:6px;height:6px}
    .overview-value{font-size:24px}
    .temp-title{gap:6px}
    .temp-title span{font-size:11px}
    .unitCode{font-size:10px}
    .unitActions{flex-wrap:wrap}
    .big-temp select{width:65px}
    }
    @media(prefers-reduced-motion:reduce){.feedback[data-kind=busy]::before{animation:none}
    }
  </style>
</head>
<body>
<svg class="svg-library" aria-hidden="true"><defs>
  <symbol id="wind" viewBox="0 0 24 24"><path d="M3 8h12a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h5a3 3 0 1 1-3 3"/></symbol>
  <symbol id="power" viewBox="0 0 24 24"><path d="M12 3v9M6.3 5.7a8 8 0 1 0 11.4 0"/></symbol>
  <symbol id="refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/></symbol>
  <symbol id="down" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></symbol>
  <symbol id="shield" viewBox="0 0 24 24"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/></symbol>
  <symbol id="arrow" viewBox="0 0 24 24"><path d="M4 12h16m-5-5 5 5-5 5"/></symbol>
</defs></svg>
<main class="shell">
  <header class="masthead">
    <div class="identity"><div class="brand"><svg aria-hidden="true"><use href="#wind"/></svg></div><div><div class="eyebrow">空调设备控制</div><h1>${xml(panelTitle)}</h1></div></div>
    <div class="header-right"><span class="connection" id="lastUpdated">等待读取</span><button class="quiet-button" id="refreshStatus" type="button" aria-label="刷新设备状态"><svg aria-hidden="true"><use href="#refresh"/></svg><span>刷新状态</span></button></div>
  </header>
  <section class="overview" id="overview" data-state="loading" aria-label="空调概览">
    <div><div class="overline">当前状态</div><div class="overview-value overview-state"><span id="stateSummary">正在读取</span></div><div class="overview-note" id="stateCount">— / — 台开启</div></div>
    <div><div class="overline">统一设定温度</div><div class="overview-value"><span class="numeric" id="currentTemperature">—</span><small>°C</small></div><div class="overview-note" id="stateHint">正在读取设备状态…</div></div>
    <div class="schedule-overview"><div class="overline">自动定时</div><div class="overview-value"><span class="numeric" id="scheduleTimes">— → —</span></div><div class="overview-note" id="scheduleSummary">正在读取定时…</div></div>
  </section>
  <div id="status" class="feedback" role="status" aria-live="polite"></div>
  <nav class="mobile-nav" aria-label="页面导航"><a href="#control">总控</a><a href="#equipment" id="deviceNav">设备</a><a href="#schedule">定时</a></nav>
  <div class="workspace">
    <section class="equipment" id="equipment">
      <div class="section-head"><h2>单台设备</h2><div class="legend" aria-label="状态颜色说明"><span class="legend-item legend-on">已开启</span><span class="legend-item legend-off">已关闭</span></div></div><div class="position-note">按现有空间位置排列 · 点开设备调节</div>
      <div class="unitGrid" id="unitGrid" aria-label="单台空调位置布局"></div>
      <div class="bottom-note"><svg aria-hidden="true"><use href="#shield"/></svg>温度为设备设定值，不代表室内实测温度</div>
    </section>
    <aside class="aside">
      <section class="card controls" id="control">
        <div class="card-head"><h2>统一控制</h2><span class="tag" id="controlScope">全部设备</span></div><div class="scope">统一开关和温度对全部设备生效</div>
        <button class="power" id="powerToggle" type="button" disabled>等待读取设备状态</button>
        <div class="temp-title"><label for="temperature">设定温度</label><span id="draftState">等待读取</span></div>
        <div class="temp-control"><button class="step" id="tempMinus" type="button" aria-label="降低设定温度" disabled>−</button><div class="big-temp"><select id="temperature" aria-label="全部设备设定温度" disabled><option value="" selected>—</option>${Array.from({ length: 13 }, (_, index) => `<option value="${index + 18}">${index + 18}</option>`).join("")}</select><small>°C</small></div><button class="step" id="tempPlus" type="button" aria-label="提高设定温度" disabled>+</button></div>
        <button class="apply" id="tempSet" type="button" disabled>应用到全部设备</button><p class="temp-hint">调整后点击应用，核实设备状态后显示结果。</p>
      </section>
      <section class="card schedule-card schedule" id="schedule">
        <div class="card-head"><h2>自动定时</h2><span class="tag" id="scheduleStatus" data-state="loading">读取中</span></div>
        <div class="schedule-times"><div class="schedule-time"><strong class="numeric" id="scheduleOnTime">—</strong><span>自动开启</span></div><div class="schedule-line"></div><div class="schedule-time"><strong class="numeric" id="scheduleOffTime">—</strong><span>自动关闭</span></div></div>
        <p class="schedule-rule">开启：仅工作日，周末及法定节假日跳过<br>关闭：每天按时执行</p><p id="scheduleDetail" class="schedule-detail"></p>
        <details class="schedule-edit"><summary>修改定时<svg class="chevron" aria-hidden="true"><use href="#down"/></svg></summary><div class="schedule-fields"><label>开启时间<input id="scheduleOn" type="time" disabled></label><label>关闭时间<input id="scheduleOff" type="time" disabled></label></div><button class="apply" id="scheduleSave" type="button" disabled>保存时间</button><div class="unitActions"><button class="quiet-button" id="scheduleToggle" type="button" disabled>等待读取定时</button></div></details>
      </section>
      <a class="diagnostics" href="/doctor"><span><svg aria-hidden="true"><use href="#shield"/></svg>系统诊断</span><svg aria-hidden="true"><use href="#arrow"/></svg></a>
    </aside>
  </div>
  <footer class="footer"><span>设备状态以最近一次核实结果为准</span><span>开启仅工作日执行 · 关闭每天执行</span></footer>
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
      document.querySelector("#draftState").textContent = !acReady ? "等待读取" : same ? "与设备设定一致"
        : Number.parseFloat(acState.temperature) === target ? "可统一各台温度" : "已调整 · 待应用";
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
      document.querySelector("#stateHint").textContent = "当前模式：" + data.mode;
      document.querySelector("#lastUpdated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
      document.querySelector("#controlScope").textContent = "全部 " + data.totalUnits + " 台";
      document.querySelector("#deviceNav").textContent = "设备 · " + data.totalUnits;
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
          '<summary><div class="unitIcon"><svg aria-hidden="true"><use href="#wind"/></svg></div>' +
          '<div class="unitInfo"><h3 class="unitName">' + escapeHtml(label) + '</h3><div class="unitCode">' + escapeHtml(unit.name) + '</div>' +
          '<div class="unitMeta">' + (unit.off ? "已关闭" : unit.on ? "已开启" : "待确认") + '</div></div>' +
          '<div class="unitBadge"><strong class="numeric">' + (Number.isFinite(numericTemp) ? numericTemp : "—") + '</strong><small>°C</small></div>' +
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
      document.querySelector("#scheduleTimes").textContent = data.on + " → " + data.off;
      document.querySelector("#scheduleOnTime").textContent = data.on;
      document.querySelector("#scheduleOffTime").textContent = data.off;
      const summary = document.querySelector("#scheduleSummary");
      summary.textContent = state === "running" ? "已启用 · 工作日自动开启" : state === "error" ? "定时状态异常" : "已暂停自动定时";
      summary.dataset.state = scheduleStatus.dataset.state;
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
        document.querySelector("#scheduleSummary").textContent = "定时状态读取失败";
        document.querySelector("#scheduleSummary").dataset.state = "error";
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
        document.querySelector("#stateHint").textContent = "正在读取设备状态…";
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
        document.querySelector("#stateHint").textContent = acState ? "以下为上次读取的状态，请刷新确认" : "请刷新重试";
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
