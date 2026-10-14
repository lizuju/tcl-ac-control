import { sleep } from "./retry.mjs";

export class NiagaraBox {
  constructor(request, { signal } = {}) {
    this.request = request;
    this.signal = signal;
    this.requestId = 0;
    this.frameId = 0;
    this.sessionId = null;
  }

  async send(requests) {
    const frame = {
      p: "box",
      v: "2.1",
      m: requests.map(({ channel, key, body }) => ({
        r: ++this.requestId, t: "rt", c: channel, k: key, b: body,
      })),
      n: ++this.frameId,
    };
    if (this.sessionId) frame.id = this.sessionId;
    const { response, body } = await this.request("/box/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(frame),
    });
    if (!response.ok) throw new Error(`/box/ failed: ${response.status}`);
    const replies = JSON.parse(body).m;
    return frame.m.map((request) => {
      const reply = replies?.find((item) => item.r === request.r);
      if (!reply) throw new Error(`BOX response missing for ${request.k}`);
      if (reply.t === "e") {
        throw new Error(`BOX ${reply.et || "error"}: ${typeof reply.b === "string" ? reply.b : JSON.stringify(reply.b)}`);
      }
      if (reply.t !== "rp") throw new Error(`Unexpected BOX response: ${reply.t}`);
      return reply.b;
    });
  }

  async call(key, arg) {
    const [result] = await this.send([{
      channel: "ssession", key: "callssc",
      body: { id: this.sessionId, scid: "station:", sck: key, scarg: arg },
    }]);
    return result;
  }

  async invoke(actions) {
    return this.send(actions.map(({ handle, name, param }) => ({
      channel: "ssession", key: "callssc",
      body: {
        id: this.sessionId, scid: "station:", sck: "invokeAction",
        scarg: { h: handle, a: name, ...(param === undefined ? {} : { b: param }) },
      },
    })));
  }

  async start() {
    [this.sessionId] = await this.send([{ channel: "ssession", key: "make", body: {} }]);
    await this.send([{
      channel: "ssession", key: "makessc",
      body: { id: this.sessionId, scid: "station:", scts: "box:ComponentSpaceSessionHandler", scarg: "station:" },
    }]);
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await this.send([{ channel: "ssession", key: "del", body: { id: this.sessionId } }]);
    } finally {
      this.sessionId = null;
    }
  }

  async resolve(ords) {
    const results = await this.send(ords.map((ord) => ({
      channel: "ord", key: "resolve", body: { o: ord, bo: "station:|slot:/" },
    })));
    return results.map((result, index) => {
      if (!result?.o?.h) throw new Error(`Point did not resolve: ${ords[index]}`);
      return result.o;
    });
  }

  async subscribe(ords, { timeoutMs = 15000, intervalMs = 3000 } = {}) {
    const points = await this.resolve(ords);
    const result = await this.call("sub", points.map((point) => `h:${point.h}`));
    if (points.some((point) => !result?.h?.includes(point.h))) {
      throw new Error("Niagara did not subscribe all requested points");
    }
    // Unsubscribed proxy points retain old out values even after a successful write.
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await this.resolve(ords);
      const pending = current.filter((point) => {
        const proxy = point.s?.find((item) => item.n === "proxyExt");
        return proxy?.s?.find((item) => item.n === "subscriptionStatus")?.v !== "Subscribed";
      });
      if (!pending.length) return;
      if (Date.now() >= deadline) throw new Error(`Live point subscription timed out: ${pending.length} points`);
      await sleep(intervalMs, this.signal);
    }
  }
}
