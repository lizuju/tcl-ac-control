import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = process.env.AC_ENV_FILE || path.join(here, ".env");

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

try {
  const body = fs.readFileSync(envPath, "utf8");
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(trimmed.slice(index + 1));
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}; copy .env.example to .env`);
  return value;
}
