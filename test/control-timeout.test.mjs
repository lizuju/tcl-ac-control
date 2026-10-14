import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import vm from "node:vm";
import { retryAsync } from "../retry.mjs";

test("the overall budget aborts a Niagara request before its individual timeout", async (t) => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const source = await fs.readFile(new URL("../ac-control.mjs", import.meta.url), "utf8");
  const requestFunction = source.slice(source.indexOf("async function request("), source.indexOf("function scramName("));
  const context = vm.createContext({ URL, Headers, AbortSignal, fetch,
    baseUrl: `http://127.0.0.1:${server.address().port}`, jar: new Map(), requestTimeoutMs: 5000,
    cookieHeader: () => "", updateCookies() {},
  });
  vm.runInContext(requestFunction, context);
  let calls = 0;
  const started = Date.now();
  await assert.rejects(retryAsync(async (_, signal) => {
    calls += 1;
    context.operationSignal = signal;
    await vm.runInContext('request("/box/")', context);
    throw new Error("The cancelled request must not finish");
  }, { attempts: 3, delayMs: 0, budgetMs: 100 }), { name: "TimeoutError" });
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 2000);
});
