import assert from "node:assert/strict";
import test from "node:test";
import { activePriorityLevel, isLocalPriorityOverride } from "../niagara-status.mjs";

test("local force detection uses the writable point priority level", () => {
  assert.equal(activePriorityLevel("10"), null);
  assert.equal(activePriorityLevel("10;activeLevel=e:8@control:PriorityLevel"), 8);
  assert.equal(isLocalPriorityOverride("10"), false);
  assert.equal(isLocalPriorityOverride("0;activeLevel=e:17@control:PriorityLevel"), false);
  assert.equal(isLocalPriorityOverride("10;activeLevel=e:8@control:PriorityLevel"), true);
});
