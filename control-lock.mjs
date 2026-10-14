import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sleep } from "./retry.mjs";

export async function acquireControlLock(lockDir, { timeoutMs, signal }) {
  const ownerName = `${process.pid}-${crypto.randomUUID()}.owner`;
  const ownerPath = path.join(lockDir, ownerName);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    signal?.throwIfAborted();
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, "");
      return () => {
        try {
          fs.unlinkSync(ownerPath);
          fs.rmdirSync(lockDir);
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
        }
      };
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error.code !== "EEXIST") throw error;
    }

    try {
      const owners = fs.readdirSync(lockDir);
      for (const name of owners) {
        const match = /^(\d+)-[\da-f-]+\.owner$/.exec(name);
        if (!match) continue;
        try {
          process.kill(Number(match[1]), 0);
        } catch (error) {
          if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
          // Unique owner filenames keep stale cleanup from deleting a replacement lock.
          if (error.code === "ESRCH") fs.unlinkSync(path.join(lockDir, name));
        }
      }
      if (owners.length || Date.now() - fs.statSync(lockDir).mtimeMs > 1000) {
        try {
          fs.rmdirSync(lockDir);
          continue;
        } catch (error) {
          if (error.code !== "ENOTEMPTY") throw error;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (Date.now() >= deadline) throw new Error("Another AC control action is still running");
    await sleep(Math.max(0, Math.min(500, deadline - Date.now())), signal);
  }
}
