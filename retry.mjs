import { setTimeout as delay } from "node:timers/promises";

export function sleep(ms, signal) {
  return delay(ms, undefined, { signal });
}

export function readIntegerEnv(env, name, fallback, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

// Signals that mean "the network or the remote station hiccuped", as opposed to a real
// control failure. Only these are safe to retry automatically: retrying a genuine
// failure (a point that will not switch, a validation error) just wastes the caller's
// time budget.
const transientNetworkSignals = [
  "AbortError",
  "TimeoutError",
  "This operation was aborted",
  "fetch failed",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "UND_ERR_",
  "socket hang up",
  "other side closed",
  "premature close",
];

export function isTransientNetworkError(error) {
  if (!error) return false;
  const text = [
    error.name,
    error.message,
    error.code,
    error.cause?.code,
    error.cause?.message,
    error.stderr,
  ].filter(Boolean).join("\n");
  return transientNetworkSignals.some((signal) => text.includes(signal));
}

export function controlRetryConfig({ action, source, env = process.env } = {}) {
  const scheduledControl = source === "schedule" && action !== "status";

  if (scheduledControl) {
    return {
      attempts: readIntegerEnv(env, "AC_CONTROL_ATTEMPTS", 3, { min: 1 }),
      delayMs: readIntegerEnv(env, "AC_CONTROL_RETRY_DELAY_MS", 60000, { min: 0 }),
      retryOnlyTransient: false,
      budgetMs: 0,
    };
  }

  if (action === "status") {
    // A status read has to answer inside the panel's own request budget, so it gets a
    // single quick retry and never the long scheduled backoff.
    return {
      attempts: readIntegerEnv(env, "AC_STATUS_ATTEMPTS", 2, { min: 1 }),
      delayMs: readIntegerEnv(env, "AC_STATUS_RETRY_DELAY_MS", 2000, { min: 0 }),
      retryOnlyTransient: true,
      budgetMs: readIntegerEnv(env, "AC_STATUS_BUDGET_MS", 40000, { min: 0 }),
    };
  }

  // Interactive control (web panel or command line). A short burst of retries hides a
  // transient WAN blip, while the budget keeps the caller from blocking for minutes.
  return {
    attempts: readIntegerEnv(env, "AC_INTERACTIVE_ATTEMPTS", 3, { min: 1 }),
    delayMs: readIntegerEnv(env, "AC_INTERACTIVE_RETRY_DELAY_MS", 3000, { min: 0 }),
    retryOnlyTransient: true,
    budgetMs: readIntegerEnv(env, "AC_INTERACTIVE_BUDGET_MS", 75000, { min: 0 }),
  };
}

export async function retryAsync(operation, {
  attempts,
  delayMs,
  shouldRetry = () => true,
  budgetMs = 0,
  onRetry = () => {},
}) {
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;
  const controller = new AbortController();
  const timer = budgetMs > 0 ? setTimeout(() => controller.abort(
    new DOMException(`AC operation exceeded ${budgetMs} ms`, "TimeoutError"),
  ), budgetMs) : null;
  const { signal } = controller;
  let lastError;

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      signal.throwIfAborted();
      try {
        const result = await operation(attempt, signal);
        signal.throwIfAborted();
        return result;
      } catch (error) {
        signal.throwIfAborted();
        lastError = error;
        if (attempt >= attempts) throw error;
        if (!shouldRetry(error)) throw error;
        if (deadline && Date.now() + delayMs >= deadline) throw error;
        await onRetry(error, attempt, attempts, delayMs);
        if (delayMs > 0) await sleep(delayMs, signal);
      }
    }
    throw lastError;
  } finally {
    clearTimeout(timer);
  }
}
