import fs from "node:fs/promises";
import {
  domain,
  execFileAsync,
  jobs,
  panelLabel,
  plistPathFor,
  watchdogLabel,
} from "./launchd.mjs";

if (process.platform !== "darwin") {
  throw new Error("uninstall-launchd.mjs is macOS only; use uninstall-windows.mjs on Windows");
}

const labels = [
  jobs.on.label,
  jobs.off.label,
  panelLabel,
  watchdogLabel,
];

for (const label of labels) {
  await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
  await execFileAsync("/bin/launchctl", ["disable", `${domain}/${label}`]).catch(() => {});
  await fs.rm(plistPathFor(label), { force: true });
  console.log(`Uninstalled ${label}`);
}

console.log("Local .env and Keychain password were not removed.");
