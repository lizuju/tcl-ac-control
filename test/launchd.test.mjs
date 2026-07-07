import test from "node:test";
import assert from "node:assert/strict";
import { formatTime, parseTime } from "../launchd.mjs";

test("parseTime accepts HH:MM", () => {
  assert.deepEqual(parseTime("09:30"), { hour: 9, minute: 30, value: "09:30" });
  assert.deepEqual(parseTime("17:50"), { hour: 17, minute: 50, value: "17:50" });
});

test("parseTime rejects invalid time", () => {
  assert.throws(() => parseTime("9:30"), /HH:MM/);
  assert.throws(() => parseTime("24:00"), /HH:MM/);
});

test("formatTime pads hour and minute", () => {
  assert.equal(formatTime(9, 5), "09:05");
});
