import { requiredEnv } from "./env.mjs";
import {
  installWindowsPanelTask,
  installWindowsWatchdogTask,
  readWindowsSchedule,
  runWindowsPanelTask,
  setWindowsScheduleEnabled,
  taskNames,
  writeWindowsSchedule,
} from "./windows-scheduler.mjs";

if (process.platform !== "win32") {
  throw new Error("install-windows.mjs is Windows only; use install-launchd.mjs on macOS");
}

requiredEnv("AC_USERNAME");
requiredEnv("AC_PASSWORD");

const current = await readWindowsSchedule();
const schedule = await writeWindowsSchedule(current.on, current.off);
await setWindowsScheduleEnabled(true);
await installWindowsPanelTask();
await installWindowsWatchdogTask();
await runWindowsPanelTask().catch(() => {});

console.log(`Installed Windows task ${taskNames.on} at ${schedule.on}`);
console.log(`Installed Windows task ${taskNames.off} at ${schedule.off}`);
console.log(`Installed Windows task ${taskNames.panel} at logon`);
console.log(`Installed Windows task ${taskNames.watchdog} every 30 minutes`);
console.log("Panel URL: http://127.0.0.1:3033/");
