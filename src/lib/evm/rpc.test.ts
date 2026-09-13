import test from "node:test";
import assert from "node:assert/strict";
import { __resetRpc, rpcBatch, rpcCooling, rpcSend } from "./rpc.ts";

// A REFUSAL IS NOT A FAILED CALL. The public Robinhood node answered 429 to a
// whole batch on the box, and the "batch unsupported → one call at a time"
// fallback then fired every call singly into a host that had just said no —
// pushing the shared IP further past the limit the site, the bot, the trade
// bot and the diagnostic all share. These drive the client against a fake
// node that COUNTS what it was asked, because "does not hammer" is a
// request-count property no source scan can see.

type Handler = (url: string, body: unknown) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const refuse = (status = 429, retryAfter?: string) =>
  new Response("rate limited", { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });

function withNode(handler: Handler): { asked: { url: string; calls: number }[]; restore: () => void } {
  const orig = globalThis.fetch;
  const asked: { url: string; calls: number }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "null"));
    asked.push({ url: String(url), calls: Array.isArray(body) ? body.length : 1 });
    return handler(String(url), body);
  }) as typeof fetch;
  return { asked, restore: () => void (globalThis.fetch = orig) };
}

const A = "https://a.example/rpc";
const B = "https://b.example/rpc";
const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ method: "eth_call", params: [{ to: "0x1", data: `0x0${i}` }, "latest"] }));
const answerAll = (body: unknown) =>
  json((Array.isArray(body) ? body : [body]).map((e: { id?: number }) => ({ jsonrpc: "2.0", id: e.id ?? 1, result: "0x01" })));

test.beforeEach(() => __resetRpc());

test("a host that refuses the batch is asked ONCE — never one call at a time", async () => {
  const node = withNode(() => refuse(429));
  try {
    const out = await rpcBatch(A, calls(9), 1000);
    assert.equal(node.asked.length, 1, `the refusing host was asked ${node.asked.length} time(s)`);
    assert.equal(out.length, 9);
    for (const o of out) {
      assert.equal(o.ok, false);
      assert.match((o as { error: string }).error, /rpc 429/, "every call carries the refusal, named");
    }
    assert.match(String(rpcCooling(A)), /rpc 429.*cooling down/, "…and the host is parked");
  } finally {
    node.restore();
  }
});

test("…while it is parked, nothing is sent to it at all", async () => {
  const node = withNode(() => refuse(429, "1"));
  try {
    await rpcBatch(A, calls(2), 1000);
    const before = node.asked.length;
    const out = await rpcBatch(A, calls(2), 1000);
    assert.equal(node.asked.length, before, "a benched host costs no request");
    assert.match((out[0] as { error: string }).error, /cooling down/);
  } finally {
    node.restore();
  }
});

test("a rate limit is a fact about THAT host: the same calls go to the next one", async () => {
  const node = withNode((url, body) => (url === A ? refuse(429) : answerAll(body)));
  try {
    const out = await rpcBatch([A, B], calls(3), 1000);
    assert.deepEqual(node.asked.map((a) => a.url), [A, B]);
    assert.ok(out.every((o) => o.ok), "every call answered by the second host");
    assert.equal(rpcCooling(B), null, "the host that answered is not parked");
  } finally {
    node.restore();
  }
});

test("Retry-After is honoured, CLAMPED — one eccentric header cannot bench a node for an hour", async () => {
  const long = withNode(() => refuse(429, "600"));
  try {
    await rpcBatch(A, calls(1), 1000);
    assert.match(String(rpcCooling(A)), /cooling down for 10s/);
  } finally {
    long.restore();
  }
  __resetRpc();
  const none = withNode(() => refuse(429));
  try {
    await rpcBatch(A, calls(1), 1000);
    assert.match(String(rpcCooling(A)), /cooling down for 2s/, "no header → the default");
  } finally {
    none.restore();
  }
});

test("an ITEM saying 'rate limit' inside a 200 array is the host refusing — carried to the next host, not re-asked singly", async () => {
  const node = withNode((url, body) => {
    if (url === A) {
      return json([
        { jsonrpc: "2.0", id: 0, result: "0xaa" },
        { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } },
      ]);
    }
    return answerAll(body);
  });
  try {
    const out = await rpcBatch([A, B], calls(2), 1000);
    assert.deepEqual(out[0], { ok: true, value: "0xaa" }, "what A answered is final");
    assert.deepEqual(out[1], { ok: true, value: "0x01" }, "what A refused, B answered");
    assert.deepEqual(node.asked, [{ url: A, calls: 2 }, { url: B, calls: 1 }], "A once; B only the carried call");
  } finally {
    node.restore();
  }
});

test("an item that REVERTED is still retried one at a time on the same host — a revert says nothing about a quota", async () => {
  let singles = 0;
  const node = withNode((_url, body) => {
    if (Array.isArray(body)) {
      return json([
        { jsonrpc: "2.0", id: 0, result: "0xaa" },
        { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } },
      ]);
    }
    singles++;
    return json({ jsonrpc: "2.0", id: 1, result: "0xbb" });
  });
  try {
    const out = await rpcBatch(A, calls(2), 1000);
    assert.equal(singles, 1);
    assert.deepEqual(out[1], { ok: true, value: "0xbb" });
  } finally {
    node.restore();
  }
});

test("the one-at-a-time fallback STOPS at a refusal: calls still queued are answered without a request", async () => {
  // Batch unsupported (a non-array), then every single call refused. The six
  // in flight when the first refusal lands are the most that can be spent;
  // the four behind them must cost nothing.
  const node = withNode((_url, body) => (Array.isArray(body) ? json({ error: "batch not supported" }) : refuse(429)));
  try {
    const out = await rpcBatch(A, calls(10), 1000);
    const singles = node.asked.filter((a) => a.calls === 1).length;
    assert.ok(singles <= 6, `${singles} single requests — the run did not stop`);
    assert.ok(out.every((o) => !o.ok && /rpc 429/.test((o as { error: string }).error)));
  } finally {
    node.restore();
  }
});

test("a 5xx or a transport failure still degrades to one call at a time, on the same host", async () => {
  const node = withNode((_url, body) => (Array.isArray(body) ? new Response("boom", { status: 502 }) : json({ jsonrpc: "2.0", id: 1, result: "0x01" })));
  try {
    const out = await rpcBatch(A, calls(3), 1000);
    assert.ok(out.every((o) => o.ok));
    assert.equal(node.asked.filter((a) => a.calls === 1).length, 3);
    assert.equal(rpcCooling(A), null, "a 5xx is not a refusal and parks nothing");
  } finally {
    node.restore();
  }
});

test("rpcSend fails over the same way and throws the refusal when no host is left", async () => {
  const node = withNode((url, body) => (url === A ? refuse(403) : answerAll(body)));
  try {
    const v = await rpcSend<string>([A, B], calls(1)[0], 1000);
    assert.equal(v, "0x01");
    __resetRpc();
    await assert.rejects(rpcSend([A], calls(1)[0], 1000), /rpc 403/);
  } finally {
    node.restore();
  }
});

// ⚠️ "THE NODE ANSWERED WITH AN ERROR" AND "THE NODE DID NOT ANSWER" ARE
// DIFFERENT FACTS, and every caller that groups reads needs them apart: the
// Pons provider reads a reverted `logo()` as a token that publishes no logo,
// and a refused one as a read that never happened — the second is OUR reason
// (readWhy), the first is the contract's. A flag the client sets is the only
// place that distinction can be made honestly; text-matching "reverted" at
// the caller is a fourth private idea of failure.
test("a failure carries `unanswered` only when the node did not answer — a revert is an answer", async () => {
  const { unanswered } = await import("./rpc.ts");
  // Refused whole: unanswered.
  const refusing = withNode(() => refuse(429));
  try {
    const out = await rpcBatch(A, calls(2), 1000);
    assert.ok(out.every((o) => unanswered(o)), "a refused batch is unanswered");
  } finally {
    refusing.restore();
  }
  __resetRpc();
  // Answered with a revert, then a transport failure on the single retry:
  // the revert (the batch's own reason) is kept and is NOT unanswered.
  const reverting = withNode((_url, body) => {
    if (Array.isArray(body)) {
      return json([
        { jsonrpc: "2.0", id: 0, result: "0xaa" },
        { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } },
      ]);
    }
    return json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
  });
  try {
    const out = await rpcBatch(A, calls(2), 1000);
    assert.equal(out[0].ok, true);
    assert.equal(out[1].ok, false);
    assert.equal(unanswered(out[1]), false, "a revert is the node answering");
    assert.match((out[1] as { error: string }).error, /execution reverted/);
  } finally {
    reverting.restore();
  }
  __resetRpc();
  // An item-level rate limit inside a 200 array: those items are unanswered,
  // the item that answered is not.
  const limiting = withNode((_url, body) =>
    json((body as { id: number }[]).map((e) => (e.id === 0 ? { jsonrpc: "2.0", id: 0, result: "0xaa" } : { jsonrpc: "2.0", id: e.id, error: { code: -32005, message: "rate limit exceeded" } }))),
  );
  try {
    const out = await rpcBatch(A, calls(3), 1000);
    assert.equal(out[0].ok, true);
    assert.ok(unanswered(out[1]) && unanswered(out[2]), "refused items are unanswered");
    assert.equal(limiting.asked.length, 1, "…and were not re-asked singly");
  } finally {
    limiting.restore();
  }
  __resetRpc();
  // A transport failure on the single retries (the batch got a 502, then the
  // socket died): unanswered, and NOT carried anywhere — this is the flag's
  // only owner for that path.
  const dying = withNode((_url, body) => {
    if (Array.isArray(body)) return new Response("boom", { status: 502 });
    throw new TypeError("fetch failed");
  });
  try {
    const out = await rpcBatch(A, calls(2), 1000);
    assert.ok(out.every((o) => unanswered(o)), `a dead socket is unanswered: ${JSON.stringify(out)}`);
    assert.equal(rpcCooling(A), null, "…and parks nothing");
  } finally {
    dying.restore();
  }
  __resetRpc();
  // A missing item in the array: unanswered ("no response").
  const dropping = withNode(() => json([{ jsonrpc: "2.0", id: 0, result: "0xaa" }]));
  try {
    const out = await rpcBatch(A, calls(2), 1000);
    // The single retry answers the same one-item array, so the second call
    // stays "no response" — the node never spoke to it.
    assert.ok(unanswered(out[1]), `${JSON.stringify(out[1])}`);
  } finally {
    dropping.restore();
  }
});

// ⚠️ A HOST THAT IS DOWN IS THE COMMONEST WAY A HOST BREAKS, and the first cut
// of the list carried only REFUSALS: a dead first entry was degraded to one
// call at a time on ITSELF, failed every one, and the second host was never
// asked — the host list defeated on the case it exists for. And a node that
// drops three single calls must not be asked thirty-seven more times, each at
// a full timeout.
test("a host that is DOWN fails over — and is not asked forty times to prove it", async () => {
  let aCalls = 0;
  const node = withNode((url, body) => {
    if (url === A) {
      aCalls++;
      throw new TypeError("fetch failed");
    }
    return answerAll(body);
  });
  try {
    const out = await rpcBatch([A, B], calls(40), 1000);
    assert.ok(out.every((o) => o.ok), `the second host answered every call: ${JSON.stringify(out[0])}`);
    // One batch, plus the singles already in flight when the third failure
    // lands (the pool is six wide). The property is that it is bounded by the
    // pool and not by the number of calls: 41 requests would be one per call.
    assert.ok(aCalls <= 10, `the dead host was asked ${aCalls} times`);
    assert.equal(rpcCooling(A), null, "a dead socket is not a refusal and parks nothing");
  } finally {
    node.restore();
  }
});

test("…and with no host left, the calls carry the transport reason, not 'no response'", async () => {
  const node = withNode(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const out = await rpcBatch(A, calls(8), 1000);
    assert.ok(out.every((o) => !o.ok && /fetch failed/.test((o as { error: string }).error)), JSON.stringify(out));
  } finally {
    node.restore();
  }
});

// ⚠️ THE REASON REPORTED IS THE LAST HOST'S, NEVER AN EARLIER ONE'S. Host A
// rate-limits us and host B simply drops an item from its array: reporting
// "rpc 429" for that call sends an operator to a quota that had nothing to do
// with it, which is this whole file's subject pointing at our own diagnosis.
test("a call the last host merely dropped is not reported with an earlier host's refusal", async () => {
  const node = withNode((url, body) => {
    if (url === A) return refuse(429);
    // B answers the first call and omits the second entirely.
    return json([{ jsonrpc: "2.0", id: 0, result: "0xaa" }]);
  });
  try {
    const out = await rpcBatch([A, B], calls(2), 1000);
    assert.equal(out[0].ok, true, "B's answer stands");
    assert.equal(out[1].ok, false);
    const why = (out[1] as { error: string }).error;
    assert.doesNotMatch(why, /429/, `the 429 was host A's: ${why}`);
    assert.match(why, /no response/);
  } finally {
    node.restore();
  }
});
