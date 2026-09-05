import assert from "node:assert/strict";
import test from "node:test";
import { encodeModeValue, encodeTemperatureValue } from "../niagara-values.mjs";

test("Niagara action values match the native Hx payload", () => {
  assert.deepEqual(encodeTemperatureValue(25), {
    nm: "p",
    t: "baja:Double",
    d: "25.00",
    v: "25.0",
  });
  assert.deepEqual(encodeModeValue(1, "{occupied=1,unoccupied=2}", "occupied"), {
    nm: "p",
    t: "baja:DynamicEnum",
    d: "occupied",
    v: "1@{occupied=1,unoccupied=2}",
  });
});
