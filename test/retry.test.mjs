import assert from "node:assert/strict";
import test from "node:test";
import { controlRetryConfig, readIntegerEnv, retryAsync } from "../retry.mjs";

test("scheduled control defaults to three attempts", () => {
  assert.deepEqual(
    controlRetryConfig({ action: "off", source: "schedule", env: {} }),
    { attempts: 3, delayMs: 60000 },
  );
});

test("manual control defaults to one attempt", () => {
  assert.deepEqual(
    controlRetryConfig({ action: "off", source: "manual", env: {} }),
    { attempts: 1, delayMs: 60000 },
  );
});

test("status does not retry even from schedule source", () => {
  assert.deepEqual(
    controlRetryConfig({ action: "status", source: "schedule", env: {} }),
    { attempts: 1, delayMs: 60000 },
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
    { attempts: 5, delayMs: 250 },
  );
});

test("retry config rejects invalid integers", () => {
  assert.throws(
    () => readIntegerEnv({ AC_CONTROL_ATTEMPTS: "0" }, "AC_CONTROL_ATTEMPTS", 3, { min: 1 }),
    /AC_CONTROL_ATTEMPTS must be an integer >= 1/,
  );
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
