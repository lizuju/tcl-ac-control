import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await fs.readFile(new URL("../ac-panel.mjs", import.meta.url), "utf8");
const htmlFunction = source.slice(source.indexOf("function html()"), source.indexOf("function diagnosticsHtml"));
const page = vm.runInNewContext(`${htmlFunction}; html()`, { xml: String, panelTitle: "Test", unitColumns: [] });
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\n    refreshAllStatus\(\);\s*$/, "");

function frontend(fetch) {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {
        value: "24", textContent: "", innerHTML: "", dataset: {}, disabled: false,
        classList: { toggle() {} }, addEventListener() {}, querySelectorAll() { return []; },
      });
      return elements.get(selector);
    },
    querySelectorAll() { return [...elements.values()]; },
  };
  const context = vm.createContext({ document, fetch, AbortController, setTimeout, clearTimeout, URLSearchParams });
  vm.runInContext(script, context);
  return { context, elements, run: (code) => vm.runInContext(code, context) };
}

function state(temperature) {
  return { mode: "占用", temperature: `${temperature} °C`, activeUnits: 1, totalUnits: 1, closed: false,
    units: [{ name: "unit", mode: "占用", temperature: `${temperature} °C`, on: true, off: false }] };
}

test("temperature success waits for verified backend response and then renders actual readback", async () => {
  let finishWrite;
  const calls = [];
  const ui = frontend(async (url) => {
    calls.push(url);
    if (url.startsWith("/api/temp")) return new Promise((resolve) => { finishWrite = resolve; });
    throw new Error("A verified operation must not request status again");
  });
  ui.run("setTemperatureValue(18)");
  const pending = ui.run('run("temp?value=18")');
  assert.deepEqual(calls, ["/api/temp?value=18"]);
  assert.match(ui.elements.get("#status").textContent, /核实实际状态/);
  assert.equal(ui.elements.get("#tempSet").disabled, true);
  await ui.run('run("off")');
  assert.equal(calls.length, 1);
  finishWrite({ ok: true, json: async () => ({ message: "已核实全部空调温度：18 °C", status: state(18) }) });
  await pending;
  assert.deepEqual(calls, ["/api/temp?value=18"]);
  assert.match(ui.elements.get("#remoteMeta").textContent, /18 °C/);
  assert.equal(ui.elements.get("#temperature").value, "18");
  assert.equal(ui.elements.get("#tempSet").disabled, false);
});

test("verified single-unit results update the unit and count without another request", async () => {
  const ui = frontend(async () => ({ ok: true, json: async () => ({
    message: "已核实单台关闭", unit: { name: "unit", mode: "非占用", temperature: "24 °C", on: false, off: true },
  }) }));
  ui.run(`renderAcStatus(${JSON.stringify(state(24))})`);
  await ui.run('run("unit/unit/off")');
  assert.equal(ui.run("acState.activeUnits"), 0);
  assert.equal(ui.run("acState.units[0].off"), true);
  assert.match(ui.elements.get("#unitGrid").innerHTML, /offUnit/);
  assert.equal(ui.elements.get("#status").textContent, "已核实单台关闭");
  assert.equal(ui.elements.get("#tempSet").disabled, false);
});

test("a failed operation releases controls while its status refresh is still pending", async () => {
  let finishStatus;
  const ui = frontend(async (url) => url.startsWith("/api/temp")
    ? { ok: false, text: async () => "操作失败" }
    : new Promise((resolve) => { finishStatus = resolve; }));
  await ui.run('run("temp?value=18")');
  assert.equal(ui.elements.get("#tempSet").disabled, false);
  assert.equal(ui.elements.get("#status").textContent, "操作失败");
  finishStatus({ ok: true, json: async () => state(24) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.elements.get("#temperature").value, "24");
});

test("failed writes restore temperature selection from the device, not the unsaved draft", async () => {
  const ui = frontend(async (url) => url.startsWith("/api/temp")
    ? { ok: false, text: async () => "操作失败" }
    : { ok: true, json: async () => state(24) });
  ui.run("setTemperatureValue(18)");
  await ui.run('run("temp?value=18")');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.elements.get("#temperature").value, "24");
  assert.equal(ui.elements.get("#remoteTempValue").textContent, "24 °C");
  assert.equal(ui.elements.get("#status").textContent, "操作失败");
});

test("an old status response cannot overwrite a newer device readback", async () => {
  const responses = [];
  const ui = frontend(() => new Promise((resolve) => responses.push(resolve)));
  const oldRead = ui.run("refreshAcStatus()");
  const newRead = ui.run("refreshAcStatus()");
  responses[1]({ ok: true, json: async () => state(18) });
  await newRead;
  responses[0]({ ok: true, json: async () => state(24) });
  await oldRead;
  assert.equal(ui.elements.get("#temperature").value, "18");
});

test("panel adapters return the exact verified child-process result as JSON", async () => {
  const backend = source.slice(source.indexOf("async function control(action"), source.indexOf("async function updateControl"));
  const verified = state(18);
  let args;
  const context = vm.createContext({ scriptPath: "control.mjs", here: "/test", process: { execPath: "node", env: {} },
    execFileAsync: async (_, commandArgs) => { args = commandArgs; return { stdout: JSON.stringify(verified) }; },
  });
  vm.runInContext(backend, context);
  const result = await vm.runInContext('control("temp", "18")', context);
  assert.deepEqual(JSON.parse(JSON.stringify(result.status)), verified);
  assert.ok(args.includes("--json"));
  assert.equal(args.includes("--submit-only"), false);
  const unit = verified.units[0];
  context.execFileAsync = async () => ({ stdout: JSON.stringify(unit) });
  const unitResult = await vm.runInContext('controlUnit("unit", "temp", "18")', context);
  assert.deepEqual(JSON.parse(JSON.stringify(unitResult.unit)), unit);
});
