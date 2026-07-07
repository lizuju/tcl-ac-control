import { here } from "./launchd.mjs";

function clean(value) {
  return String(value || "")
    .replaceAll(here, "<project>")
    .replaceAll(process.env.AC_PASSWORD || "\u0000", "[redacted]");
}

export async function notify(message, details = {}) {
  const webhook = process.env.AC_NOTIFY_WEBHOOK;
  if (!webhook) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        at: new Date().toISOString(),
        details: Object.fromEntries(Object.entries(details).map(([key, value]) => [key, clean(value)])),
      }),
      signal: controller.signal,
    });
    return true;
  } catch (error) {
    console.error(`notify failed: ${error.message}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
