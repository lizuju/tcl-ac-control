import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("recordRun stores last result and bounded history", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "company-ac-state-"));
  process.env.AC_RUNTIME_STATE_FILE = path.join(dir, "state.json");
  const runtime = await import(`../runtime-state.mjs?state=${Date.now()}`);

  const first = await runtime.recordRun({ action: "on", source: "schedule", ok: true, skipped: true, detail: "weekend" });
  const second = await runtime.recordRun({ action: "off", source: "panel", ok: false, error: "failed" });
  const state = await runtime.readRuntimeState();

  assert.equal(state.last.id, second.id);
  assert.equal(state.lastByAction.on.id, first.id);
  assert.equal(state.lastByAction.off.id, second.id);
  assert.equal(state.history.length, 2);
  assert.equal(state.history[0].ok, false);
});
