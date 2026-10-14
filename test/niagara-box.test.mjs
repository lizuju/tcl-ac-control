import assert from "node:assert/strict";
import test from "node:test";
import { NiagaraBox } from "../niagara-box.mjs";

function mockBox(handler) {
  return new NiagaraBox(async (_, options) => {
    const frame = JSON.parse(options.body);
    return { response: { ok: true }, body: JSON.stringify({ m: await handler(frame) }) };
  });
}

test("batch replies are matched by request ID, not array order", async () => {
  const client = mockBox((frame) => frame.m.map((request) => ({ r: request.r, t: "rp", b: request.b })).reverse());
  assert.deepEqual(await client.send([
    { channel: "ord", key: "resolve", body: "first" },
    { channel: "ord", key: "resolve", body: "second" },
  ]), ["first", "second"]);
});

test("missing, unexpected and error responses cannot be accepted as successful writes", async () => {
  for (const reply of [null, { t: "unknown" }, { t: "e", et: "PermissionException", b: "Denied" }]) {
    const client = mockBox((frame) => reply ? [{ r: frame.m[0].r, ...reply }] : []);
    await assert.rejects(client.call("invokeAction", { h: "point", a: "set" }));
  }
});

test("batch writes send every point and surface a failure even after an earlier success", async () => {
  const client = mockBox((frame) => {
    assert.equal(frame.m.length, 2);
    assert.deepEqual(frame.m.map((request) => request.b.scarg), [
      { h: "one", a: "set", b: { t: "baja:Double", v: "24.0" } },
      { h: "two", a: "emergencyAuto" },
    ]);
    return [{ r: frame.m[0].r, t: "rp", b: null },
      { r: frame.m[1].r, t: "e", et: "PermissionException", b: "Denied" }];
  });
  await assert.rejects(client.invoke([
    { handle: "one", name: "set", param: { t: "baja:Double", v: "24.0" } },
    { handle: "two", name: "emergencyAuto" },
  ]), /Denied/);
});

test("point subscriptions wait for the live proxy instead of returning stale out values", async () => {
  let reads = 0;
  let subscribed = false;
  const client = mockBox((frame) => frame.m.map((request) => {
    let body;
    if (request.k === "resolve") {
      reads += 1;
      body = { o: { h: "point", s: [{ n: "proxyExt", s: [
        { n: "subscriptionStatus", v: subscribed && reads >= 3 ? "Subscribed" : "Unsubscribed" },
      ] }] } };
    } else {
      assert.equal(request.b.sck, "sub");
      assert.deepEqual(request.b.scarg, ["h:point"]);
      subscribed = true;
      body = { h: ["point"] };
    }
    return { r: request.r, t: "rp", b: body };
  }));
  await client.subscribe(["station:|slot:/example"], { intervalMs: 0 });
  assert.equal(reads, 3);
});

test("a proxy that never becomes subscribed fails instead of reporting stale success", async () => {
  const client = mockBox((frame) => frame.m.map((request) => ({
    r: request.r, t: "rp", b: request.k === "resolve"
      ? { o: { h: "point", s: [{ n: "proxyExt", s: [{ n: "subscriptionStatus", v: "Unsubscribed" }] }] } }
      : { h: ["point"] },
  })));
  await assert.rejects(client.subscribe(["station:|slot:/example"], { timeoutMs: 0 }), /subscription timed out/);
});

test("the BOX session is explicitly deleted when finished", async () => {
  const keys = [];
  const client = mockBox((frame) => frame.m.map((request) => {
    keys.push(request.k);
    if (request.k === "del") assert.equal(request.b.id, "session");
    return { r: request.r, t: "rp", b: request.k === "make" ? "session" : null };
  }));
  await client.start();
  await client.close();
  assert.deepEqual(keys, ["make", "makessc", "del"]);
  assert.equal(client.sessionId, null);
});
