import fs from "node:fs/promises";
import path from "node:path";
import { here } from "./launchd.mjs";

const statePath = process.env.AC_RUNTIME_STATE_FILE || path.join(here, "runtime-state.json");
const maxHistory = 50;

async function readState() {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { history: [], lastByAction: {} };
  }
}

export async function readRuntimeState() {
  return readState();
}

export async function recordRun({ action, source, ok, skipped = false, detail = "", error = "" }) {
  const state = await readState();
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    action,
    source,
    ok,
    skipped,
    detail,
    error,
  };

  state.last = entry;
  state.lastByAction = { ...(state.lastByAction || {}), [action]: entry };
  state.history = [entry, ...(state.history || [])].slice(0, maxHistory);

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return entry;
}
