import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requiredEnv } from "./env.mjs";

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = requiredEnv("AC_BASE_URL");
const username = requiredEnv("AC_USERNAME");
const keychainService = process.env.AC_KEYCHAIN_SERVICE || "company-ac";
const holidayApi = process.env.AC_HOLIDAY_API || "https://api.jiejiariapi.com/v1/holidays";
const holidayCacheDir = process.env.AC_HOLIDAY_CACHE_DIR || path.join(here, "holiday-cache");
const lockDir = path.join(here, ".ac-control.lock");
const verifyTimeoutMs = Number(process.env.AC_VERIFY_TIMEOUT_MS || 60000);
const verifyIntervalMs = Number(process.env.AC_VERIFY_INTERVAL_MS || 10000);
const modeOrd = requiredEnv("AC_MODE_ORD");
const tempOrd = requiredEnv("AC_TEMP_ORD");
const vavBaseOrd = requiredEnv("AC_VAV_BASE_ORD").replace(/\/+$/, "");
const vavNames = requiredEnv("AC_VAVS").split(",").map((name) => name.trim()).filter(Boolean);
if (!vavNames.length) throw new Error("Missing AC_VAVS");
const vavs = vavNames.map((name) => ({
  name,
  ord: `${vavBaseOrd}/${name}`,
}));
const forceReleasePoints = ["CfgNetSptOvd", "niNetOccOvd", "AV_occupiedCool"];
const vavModePoint = "niNetOccOvd";
const vavTempPoint = "AV_occupiedCool";
const range = "{$u5360$u7528=1,$u975e$u5360$u7528=2}";
const values = {
  on: { ordinal: 1, display: "占用" },
  off: { ordinal: 2, display: "非占用" },
};

const jar = new Map();
let requestId = 0;
let frameId = 0;
let serverSessionId = null;
let jsonOutput = false;

function log(message) {
  if (!jsonOutput) console.log(message);
}

function chinaToday() {
  const source = process.env.AC_DATE
    ? new Date(`${process.env.AC_DATE}T12:00:00+08:00`)
    : new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(source).map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    year: Number(parts.year),
    day: new Date(`${date}T12:00:00+08:00`).getUTCDay(),
  };
}

async function readHolidayCache(year) {
  try {
    return JSON.parse(await fs.readFile(path.join(holidayCacheDir, `${year}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function fetchHolidayTable(year) {
  const cached = process.env.AC_REFRESH_HOLIDAYS === "1" ? null : await readHolidayCache(year);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${holidayApi}/${year}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`holiday API ${response.status}`);
    const table = await response.json();
    await fs.mkdir(holidayCacheDir, { recursive: true });
    await fs.writeFile(path.join(holidayCacheDir, `${year}.json`), JSON.stringify(table, null, 2));
    return table;
  } finally {
    clearTimeout(timeout);
  }
}

async function skipOpeningReason() {
  const today = chinaToday();
  if (today.day === 0 || today.day === 6) return `${today.date} is weekend`;

  try {
    const holiday = (await fetchHolidayTable(today.year))[today.date];
    if (holiday?.isOffDay === true) return `${today.date} is ${holiday.name || "holiday"}`;
    return "";
  } catch (error) {
    const cached = await readHolidayCache(today.year);
    const holiday = cached?.[today.date];
    if (holiday?.isOffDay === true) return `${today.date} is ${holiday.name || "holiday"} (cached)`;
    if (cached) return "";
    return `cannot verify ${today.year} China holiday calendar: ${error.message}`;
  }
}

function updateCookies(headers) {
  for (const cookie of headers.getSetCookie?.() || []) {
    const [pair] = cookie.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

function cookieHeader() {
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function request(target, options = {}) {
  const url = target.startsWith("http") ? target : new URL(target, baseUrl).toString();
  const headers = new Headers(options.headers || {});
  if (jar.size) headers.set("Cookie", cookieHeader());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const response = await fetch(url, {
      redirect: options.redirect || "manual",
      ...options,
      headers,
      signal: controller.signal,
    });
    updateCookies(response.headers);
    return { response, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

function scramName(value) {
  return value.replaceAll("=", "=3D").replaceAll(",", "=2C");
}

function parseScramMessage(value) {
  return Object.fromEntries(value.split(",").map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index), part.slice(index + 1)];
  }));
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function xor(left, right) {
  return Buffer.from(left.map((value, index) => value ^ right[index]));
}

function clientFinal(password, clientFirstBare, serverFirst) {
  const parsed = parseScramMessage(serverFirst);
  const clientFinalWithoutProof = `c=biws,r=${parsed.r}`;
  const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
  const saltedPassword = crypto.pbkdf2Sync(
    password,
    Buffer.from(parsed.s, "base64"),
    Number(parsed.i),
    32,
    "sha256",
  );
  const clientKey = hmac(saltedPassword, "Client Key");
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();
  const clientSignature = hmac(storedKey, authMessage);

  return {
    message: `${clientFinalWithoutProof},p=${xor(clientKey, clientSignature).toString("base64")}`,
    saltedPassword,
    authMessage,
  };
}

function verifyServerFinal(serverFinal, saltedPassword, authMessage) {
  const parsed = parseScramMessage(serverFinal);
  const serverKey = hmac(saltedPassword, "Server Key");
  const signature = hmac(serverKey, authMessage).toString("base64");
  if (parsed.v !== signature) throw new Error("Server SCRAM signature mismatch");
}

async function login(password) {
  await request("/prelogin", {
    method: "POST",
    body: new URLSearchParams({ j_username: username }),
  });

  const nonce = crypto.randomBytes(18).toString("base64");
  const clientFirstBare = `n=${scramName(username)},r=${nonce}`;
  const first = await request("/j_security_check/", {
    method: "POST",
    headers: { "Content-Type": "application/x-niagara-login-support" },
    body: `action=sendClientFirstMessage&clientFirstMessage=n,,${clientFirstBare}`,
  });
  if (!first.response.ok) throw new Error(`SCRAM first step failed: ${first.response.status}`);

  const final = clientFinal(password, clientFirstBare, first.body);
  const second = await request("/j_security_check/", {
    method: "POST",
    headers: { "Content-Type": "application/x-niagara-login-support" },
    body: `action=sendClientFinalMessage&clientFinalMessage=${final.message}`,
  });
  if (!second.response.ok) throw new Error(`SCRAM final step failed: ${second.response.status}`);
  verifyServerFinal(second.body, final.saltedPassword, final.authMessage);

  await request("/j_security_check/");
}

async function box(requests) {
  const frame = {
    p: "box",
    v: "2.1",
    m: requests.map((item) => ({
      r: ++requestId,
      t: "rt",
      c: item.channel,
      k: item.key,
      b: item.body,
    })),
    n: ++frameId,
  };
  if (serverSessionId) frame.id = serverSessionId;

  const item = await request("/box/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(frame),
  });
  if (!item.response.ok) throw new Error(`/box/ failed: ${item.response.status}`);

  const response = JSON.parse(item.body);
  const message = response.m?.[0];
  if (message?.t === "e") throw new Error(message.b?.m || "BOX request failed");
  return message?.b;
}

async function startBoxSession() {
  serverSessionId = await box([{ channel: "ssession", key: "make", body: {} }]);
  await box([{
    channel: "ssession",
    key: "makessc",
    body: {
      id: serverSessionId,
      scid: "station:",
      scts: "box:ComponentSpaceSessionHandler",
      scarg: "station:",
    },
  }]);
}

async function resolveMode() {
  return resolveOrd(modeOrd);
}

async function resolveTemp() {
  return resolveOrd(tempOrd);
}

async function resolveOrd(ord) {
  return box([{
    channel: "ord",
    key: "resolve",
    body: { o: ord, bo: "station:|slot:/" },
  }]);
}

function slot(component, name) {
  return component.s?.find((item) => item.n === name);
}

function currentDisplay(component) {
  const out = slot(component, "out");
  return slot(out, "value")?.d || out?.d || component.d;
}

function outStatus(component) {
  return slot(slot(component, "out"), "status");
}

function activeLevel(component) {
  const raw = outStatus(component)?.v || "";
  const match = /activeLevel=e:(\d+)@control:PriorityLevel/.exec(raw);
  return match ? Number(match[1]) : null;
}

function isOverridden(component) {
  const raw = outStatus(component)?.v || "";
  const bits = Number.parseInt(raw.split(";")[0] || "0", 16);
  return (bits & 0x20) !== 0;
}

function isForced(component) {
  const level = activeLevel(component);
  return isOverridden(component) || (level !== null && level !== 17);
}

function hasAction(component, name) {
  return component.s?.some((item) => item.n === name && item.t?.endsWith("Action"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireControlLock() {
  const timeoutAt = Date.now() + 120000;

  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(path.join(lockDir, "pid"), `${process.pid}\n${new Date().toISOString()}\n`);
      return () => fs.rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    try {
      const stat = await fs.stat(lockDir);
      if (Date.now() - stat.mtimeMs > 180000) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    if (Date.now() > timeoutAt) throw new Error("Another AC control action is still running");
    await sleep(500);
  }
}

function encodeModeValue(action) {
  const value = values[action];
  return {
    nm: "p",
    t: "baja:DynamicEnum",
    d: value.display,
    v: `${value.ordinal}@${range}`,
  };
}

async function setMode(action, handle) {
  return invokeAction(handle, "set", encodeModeValue(action));
}

async function invokeAction(handle, name, param) {
  const scarg = { h: handle, a: name };
  if (param) scarg.b = param;
  return box([{
    channel: "ssession",
    key: "callssc",
    body: {
      id: serverSessionId,
      scid: "station:",
      sck: "invokeAction",
      scarg,
    },
  }]);
}

function encodeTempValue(value) {
  return {
    nm: "p",
    t: "baja:Double",
    d: value.toFixed(2),
    v: value.toFixed(1),
  };
}

async function setTemp(value, handle) {
  return invokeAction(handle, "set", encodeTempValue(value));
}

async function releaseForcedSettings() {
  const released = [];

  for (const vav of vavs) {
    for (const point of forceReleasePoints) {
      const component = (await resolveOrd(`${vav.ord}/${point}`)).o;
      if (!isForced(component)) continue;
      if (!hasAction(component, "emergencyAuto")) {
        throw new Error(`${vav.name}/${point} is forced but has no emergencyAuto action`);
      }
      await invokeAction(component.h, "emergencyAuto");
      released.push(`${vav.name}/${point}`);
    }
  }

  log(`Checked individual overrides: ${vavs.length} units, ${vavs.length * forceReleasePoints.length} points`);
  if (released.length) log(`Released forced settings: ${released.join(", ")}`);
}

async function setAllVavModes(action) {
  for (const vav of vavs) {
    const component = (await resolveOrd(`${vav.ord}/${vavModePoint}`)).o;
    await setMode(action, component.h);
  }
  log(`Set individual modes: ${vavs.length} units -> ${values[action].display}`);
}

async function setAllVavTemps(value) {
  for (const vav of vavs) {
    const component = (await resolveOrd(`${vav.ord}/${vavTempPoint}`)).o;
    await setTemp(value, component.h);
  }
  log(`Set individual temperatures: ${vavs.length} units -> ${value.toFixed(1)} °C`);
}

async function readVavStatus(vav) {
  const mode = (await resolveOrd(`${vav.ord}/${vavModePoint}`)).o;
  const temperature = (await resolveOrd(`${vav.ord}/${vavTempPoint}`)).o;
  const modeDisplay = currentDisplay(mode);
  return {
    name: vav.name,
    mode: modeDisplay,
    temperature: currentDisplay(temperature),
    on: modeDisplay === values.on.display,
    off: modeDisplay === values.off.display,
  };
}

async function readSystemStatus() {
  const mode = (await resolveMode()).o;
  const temperature = (await resolveTemp()).o;
  const units = [];
  for (const vav of vavs) units.push(await readVavStatus(vav));
  const modeDisplay = currentDisplay(mode);
  const activeUnits = units.filter((unit) => unit.on).length;
  const closed = modeDisplay === values.off.display && units.every((unit) => unit.off);
  return {
    mode: modeDisplay,
    temperature: currentDisplay(temperature),
    activeUnits,
    totalUnits: units.length,
    closed,
    units,
  };
}

function allUnitsInMode(status, action) {
  return status.mode === values[action].display && status.units.every((unit) => unit[action]);
}

function temperatureMatches(display, value) {
  const current = Number.parseFloat(display);
  return Number.isFinite(current) && Math.abs(current - value) < 0.05;
}

function allTemperaturesMatch(status, value) {
  return temperatureMatches(status.temperature, value)
    && status.units.every((unit) => temperatureMatches(unit.temperature, value));
}

function summarizeStatus(status) {
  const units = status.units.map((unit) => `${unit.name}:${unit.mode}/${unit.temperature}`).join(", ");
  return `mode=${status.mode}, temperature=${status.temperature}, occupied=${status.activeUnits}/${status.totalUnits}, units=[${units}]`;
}

async function waitForStatus(predicate, label) {
  const timeoutAt = Date.now() + verifyTimeoutMs;
  let status = await readSystemStatus();

  while (!predicate(status) && Date.now() < timeoutAt) {
    await sleep(verifyIntervalMs);
    status = await readSystemStatus();
  }

  log(`${label}: ${summarizeStatus(status)}`);
  return status;
}

async function applyMode(action) {
  const before = (await resolveMode()).o;
  log(`Mode before: ${currentDisplay(before)}`);
  await releaseForcedSettings();
  await setMode(action, before.h);
  await setAllVavModes(action);
  await sleep(1000);
  const after = (await resolveMode()).o;
  log(`Mode after: ${currentDisplay(after)}`);
}

async function closeWithVerification() {
  await applyMode("off");
  let status = await waitForStatus((item) => item.closed, "Close verification check");
  if (!status.closed) {
    log(`Close verification failed: ${status.activeUnits}/${status.totalUnits} units still occupied, retrying once`);
    await applyMode("off");
    status = await waitForStatus((item) => item.closed, "Close verification retry check");
  }
  log(`Close verification: ${status.closed ? "success" : "failed"}`);
  if (!status.closed) throw new Error(`close failed after second attempt: ${summarizeStatus(status)}`);
}

async function openWithVerification() {
  await applyMode("on");
  let status = await waitForStatus((item) => allUnitsInMode(item, "on"), "Open verification check");
  if (!allUnitsInMode(status, "on")) {
    log(`Open verification failed: ${status.activeUnits}/${status.totalUnits} units occupied, retrying once`);
    await applyMode("on");
    status = await waitForStatus((item) => allUnitsInMode(item, "on"), "Open verification retry check");
  }
  const success = allUnitsInMode(status, "on");
  log(`Open verification: ${success ? "success" : "failed"}`);
  if (!success) throw new Error(`open failed after second attempt: ${summarizeStatus(status)}`);
}

async function applyTemperature(value) {
  const before = (await resolveMode()).o;
  log(`Mode before: ${currentDisplay(before)}`);
  await releaseForcedSettings();
  const tempBefore = (await resolveTemp()).o;
  log(`Temperature before: ${currentDisplay(tempBefore)}`);
  await setTemp(value, tempBefore.h);
  await setAllVavTemps(value);
  await sleep(1000);
  const tempAfter = (await resolveTemp()).o;
  log(`Temperature after: ${currentDisplay(tempAfter)}`);
}

async function setTemperatureWithVerification(value) {
  await applyTemperature(value);
  let status = await waitForStatus((item) => allTemperaturesMatch(item, value), "Temperature verification check");
  if (!allTemperaturesMatch(status, value)) {
    const mismatched = status.units
      .filter((unit) => !temperatureMatches(unit.temperature, value))
      .map((unit) => `${unit.name} ${unit.temperature}`);
    log(`Temperature verification failed: ${mismatched.join(", ") || `global ${status.temperature}`}, retrying once`);
    await applyTemperature(value);
    status = await waitForStatus((item) => allTemperaturesMatch(item, value), "Temperature verification retry check");
  }
  const success = allTemperaturesMatch(status, value);
  log(`Temperature verification: ${success ? "success" : "failed"}`);
  if (!success) throw new Error(`temperature is not ${value.toFixed(1)} °C after second set: ${summarizeStatus(status)}`);
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

async function password() {
  if (process.env.AC_PASSWORD) return process.env.AC_PASSWORD;
  const saved = await keychainPassword();
  if (saved) return saved;
  if (process.stdin.isTTY) return askHidden("AC password: ");
  throw new Error("Missing AC_PASSWORD and no keychain password found");
}

const action = process.argv[2] || "status";
const force = process.argv.includes("--force") || process.env.AC_FORCE === "1";
jsonOutput = process.argv.includes("--json");
if (!["status", "on", "off", "temp"].includes(action)) {
  throw new Error("Usage: node ac-control.mjs status|on|off|temp [value] [--force] [--json]");
}

const tempValue = Number(process.argv[3]);
if (action === "temp" && (!Number.isFinite(tempValue) || tempValue < 16 || tempValue > 30)) {
  throw new Error("Temperature must be a number from 16 to 30");
}

if (action === "on" && !force) {
  const reason = await skipOpeningReason();
  if (reason) {
    log(`Skip opening: ${reason}`);
    process.exit(0);
  }
}

const unlock = action === "status" ? null : await acquireControlLock();
try {
  await login(await password());
  await startBoxSession();

  if (action === "status") {
    const status = await readSystemStatus();
    if (jsonOutput) {
      console.log(JSON.stringify(status));
    } else {
      log(`Mode: ${status.mode}`);
      log(`Temperature: ${status.temperature}`);
      log(`Units occupied: ${status.activeUnits}/${status.totalUnits}`);
    }
  } else if (action === "temp") {
    await setTemperatureWithVerification(tempValue);
  } else if (action === "off") {
    await closeWithVerification();
  } else {
    await openWithVerification();
  }
} finally {
  await unlock?.();
}
