import fs from "node:fs/promises";
import path from "node:path";
import {
  execFileAsync,
  here,
} from "./launchd.mjs";
import { taskNames } from "./windows-scheduler.mjs";

if (process.platform !== "win32") {
  throw new Error("uninstall-windows.mjs is Windows only; use uninstall-launchd.mjs on macOS");
}

for (const name of Object.values(taskNames)) {
  await execFileAsync("schtasks.exe", ["/Delete", "/TN", name, "/F"], { windowsHide: true }).catch(() => {});
  console.log(`Uninstalled Windows task ${name}`);
}

await fs.rm(path.join(here, "out", "windows-tasks"), { recursive: true, force: true });
console.log("Local .env was not removed.");
