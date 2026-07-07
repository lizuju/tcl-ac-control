import test from "node:test";
import assert from "node:assert/strict";

test("panel config defaults to localhost", async () => {
  delete process.env.AC_PANEL_HOST;
  delete process.env.AC_PANEL_PORT;
  const config = await import(`../panel-config.mjs?default=${Date.now()}`);
  assert.equal(config.panelHost, "127.0.0.1");
  assert.equal(config.panelPort, 3033);
  assert.equal(config.panelLocalUrl, "http://127.0.0.1:3033/");
});

test("panel config uses localhost health check for any-host listen", async () => {
  process.env.AC_PANEL_HOST = "0.0.0.0";
  process.env.AC_PANEL_PORT = "4040";
  const config = await import(`../panel-config.mjs?any=${Date.now()}`);
  assert.equal(config.panelListenUrl, "http://0.0.0.0:4040/");
  assert.equal(config.panelLocalUrl, "http://127.0.0.1:4040/");
});
