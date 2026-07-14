export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function controlRetryConfig({ action, source, env = process.env } = {}) {
  const scheduledControl = source === "schedule" && action !== "status";
  return {
    attempts: readIntegerEnv(env, "AC_CONTROL_ATTEMPTS", scheduledControl ? 3 : 1, { min: 1 }),
    delayMs: readIntegerEnv(env, "AC_CONTROL_RETRY_DELAY_MS", 60000, { min: 0 }),
  };
}

export async function retryAsync(operation, { attempts, delayMs, onRetry = () => {} }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) throw error;
      await onRetry(error, attempt, attempts, delayMs);
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastError;
}
