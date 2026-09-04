import assert from "node:assert/strict";
import test from "node:test";
import { statusIsOverridden } from "../niagara-status.mjs";

test("Niagara overridden status uses the 0x10 bit", () => {
  assert.equal(statusIsOverridden("10"), true);
  assert.equal(statusIsOverridden("10;activeLevel=e:17@control:PriorityLevel"), true);
  assert.equal(statusIsOverridden("0;activeLevel=e:17@control:PriorityLevel"), false);
  assert.equal(statusIsOverridden("20"), false);
});
