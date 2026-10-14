import assert from "node:assert/strict";
import test from "node:test";
import { controlRetryConfig, isTransientNetworkError, readIntegerEnv, retryAsync, sleep } from "../retry.mjs";

test("scheduled control defaults to three attempts with the long backoff", () => {
  assert.deepEqual(
    controlRetryConfig({ action: "off", source: "schedule", env: {} }),
    { attempts: 3, delayMs: 60000, retryOnlyTransient: false, budgetMs: 0 },
  );
});

test("panel and manual control retry a transient blip a few times quickly", () => {
  assert.deepEqual(
    controlRetryConfig({ action: "off", source: "manual", env: {} }),
    { attempts: 3, delayMs: 3000, retryOnlyTransient: true, budgetMs: 75000 },
  );
  assert.deepEqual(
    controlRetryConfig({ action: "on", source: "panel", env: {} }),
    { attempts: 3, delayMs: 3000, retryOnlyTransient: true, budgetMs: 75000 },
  );
});

test("status keeps a short retry budget so the panel still answers", () => {
  assert.deepEqual(
    controlRetryConfig({ action: "status", source: "schedule", env: {} }),
    { attempts: 2, delayMs: 2000, retryOnlyTransient: true, budgetMs: 40000 },
  );
  assert.deepEqual(
    controlRetryConfig({ action: "status", source: "panel", env: {} }),
    { attempts: 2, delayMs: 2000, retryOnlyTransient: true, budgetMs: 40000 },
  );
});

test("retry config accepts environment overrides", () => {
  assert.deepEqual(
    controlRetryConfig({
      action: "off",
      source: "schedule",
      env: {
        AC_CONTROL_ATTEMPTS: "5",
        AC_CONTROL_RETRY_DELAY_MS: "250",
      },
    }),
    { attempts: 5, delayMs: 250, retryOnlyTransient: false, budgetMs: 0 },
  );
  assert.deepEqual(
    controlRetryConfig({
      action: "on",
      source: "panel",
      env: {
        AC_INTERACTIVE_ATTEMPTS: "4",
        AC_INTERACTIVE_RETRY_DELAY_MS: "500",
        AC_INTERACTIVE_BUDGET_MS: "10000",
      },
    }),
    { attempts: 4, delayMs: 500, retryOnlyTransient: true, budgetMs: 10000 },
  );
});

test("retry config rejects invalid integers", () => {
  assert.throws(
    () => readIntegerEnv({ AC_CONTROL_ATTEMPTS: "0" }, "AC_CONTROL_ATTEMPTS", 3, { min: 1 }),
    /AC_CONTROL_ATTEMPTS must be an integer >= 1/,
  );
});

test("transient network failures are recognised", () => {
  const aborted = new Error("This operation was aborted");
  aborted.name = "AbortError";
  assert.equal(isTransientNetworkError(aborted), true);

  assert.equal(isTransientNetworkError(new Error("fetch failed")), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
  assert.equal(isTransientNetworkError(new Error("connect ETIMEDOUT 1.2.3.4:8081")), true);

  // A child process killed by the panel's own timeout reports the abort on stderr.
  const childError = new Error("Command failed: node ac-control.mjs status");
  childError.stderr = "DOMException [AbortError]: This operation was aborted";
  assert.equal(isTransientNetworkError(childError), true);
});

test("genuine control failures are not treated as network blips", () => {
  assert.equal(isTransientNetworkError(new Error("close failed after second attempt: mode=占用")), false);
  assert.equal(isTransientNetworkError(new Error("Unknown unit: VAV_99")), false);
  assert.equal(isTransientNetworkError(new Error("Temperature must be a number from 16 to 30")), false);
  assert.equal(isTransientNetworkError(undefined), false);
});

test("retryAsync retries until success", async () => {
  let calls = 0;
  const retries = [];
  const result = await retryAsync(async () => {
    calls += 1;
    if (calls < 3) throw new Error(`fail ${calls}`);
    return "ok";
  }, {
    attempts: 3,
    delayMs: 0,
    onRetry(error, attempt, attempts, delayMs) {
      retries.push({ message: error.message, attempt, attempts, delayMs });
    },
  });

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(retries, [
    { message: "fail 1", attempt: 1, attempts: 3, delayMs: 0 },
    { message: "fail 2", attempt: 2, attempts: 3, delayMs: 0 },
  ]);
});

test("retryAsync stops immediately on an error that is not worth retrying", async () => {
  let calls = 0;
  await assert.rejects(
    retryAsync(async () => {
      calls += 1;
      throw new Error("Unknown unit: VAV_99");
    }, {
      attempts: 3,
      delayMs: 0,
      shouldRetry: isTransientNetworkError,
    }),
    /Unknown unit: VAV_99/,
  );
  assert.equal(calls, 1);
});

test("retryAsync stops retrying once the time budget is spent", async () => {
  let calls = 0;
  await assert.rejects(
    retryAsync(async () => {
      calls += 1;
      const error = new Error("fetch failed");
      error.name = "AbortError";
      throw error;
    }, {
      attempts: 5,
      delayMs: 500,
      shouldRetry: isTransientNetworkError,
      budgetMs: 100,
    }),
    /fetch failed/,
  );
  assert.equal(calls, 1);
});

test("the total budget cancels an in-progress retry before it can continue writing", async () => {
  let calls = 0;
  let writes = 0;
  let signal;
  await assert.rejects(retryAsync(async (_, currentSignal) => {
    signal = currentSignal;
    calls += 1;
    if (calls === 1) throw new Error("fetch failed");
    await sleep(1000, signal);
    writes += 1;
  }, { attempts: 3, delayMs: 0, budgetMs: 50, shouldRetry: isTransientNetworkError }),
  { name: "TimeoutError" });
  assert.equal(calls, 2);
  assert.equal(signal.aborted, true);
  assert.equal(writes, 0);
});

test("the budget also cancels retry backoff and does not start another attempt", async () => {
  let calls = 0;
  await assert.rejects(retryAsync(async () => {
    calls += 1;
    throw new Error("fetch failed");
  }, {
    attempts: 3, delayMs: 20, budgetMs: 50,
    onRetry: async () => { await sleep(40); },
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});
