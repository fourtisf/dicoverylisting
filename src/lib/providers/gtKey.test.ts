// A COINGECKO KEY COMES IN TWO TIERS, AND THIS CLIENT KNEW ONLY THE PAID ONE.
//
// The live report: the token page reading `GeckoTerminal is rate limited —
// cooling down for 102s` on a $21M-cap token with $5.9M of daily volume. The
// standing advice for that has always been "set GECKOTERMINAL_API_KEY" — and
// the key an operator will actually obtain first is the FREE CoinGecko Demo
// key, which answers on `api.coingecko.com` with `x-cg-demo-api-key`. Handed to
// the pro branch it is simply refused, so the one line that was supposed to fix
// a rate-limited chart would have looked like it changed nothing at all.
//
// And the Demo key is not a consolation prize here: its allowance is counted
// PER KEY, not per IP. This box's whole problem is that the web app and the bot
// suite split ONE IP's ~30/min — a Demo key gives the website its own.
//
// ⚠️ The env var is set BEFORE the import: gt.ts reads it at module load, and a
// separate file is the only way to drive a keyed client, since node:test gives
// each file its own process.
import test from "node:test";
import assert from "node:assert/strict";

process.env.GECKOTERMINAL_API_KEY = "k3y";
process.env.GT_MIN_GAP_MS = "0";
delete process.env.GECKOTERMINAL_API_TIER;
delete process.env.GECKOTERMINAL_API_BASE;

const { _gtReset, gtGet, gtTier } = await import("./gt.ts");

interface Seen {
  url: string;
  demoHeader?: string;
  proHeader?: string;
}
const seen: Seen[] = [];

const withFetch = async (impl: typeof fetch, fn: () => Promise<void>) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
};

/** Records the URL and which key header went out, then answers `status`. */
const spy =
  (status: (url: string) => number): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    seen.push({ url, demoHeader: h.get("x-cg-demo-api-key") ?? undefined, proHeader: h.get("x-cg-pro-api-key") ?? undefined });
    const s = status(url);
    return new Response(JSON.stringify(s === 200 ? { data: [1] } : { error: "nope" }), {
      status: s,
      headers: { "content-type": "application/json" },
    });
  };

test("a key refused by one tier is tried ONCE on the other, and the answer sticks", async () => {
  _gtReset();
  seen.length = 0;
  // The free Demo key is tried first, because it is the one the advice will
  // actually produce. Here the fixture is a PRO key: demo refuses it, pro takes it.
  await withFetch(
    spy((url) => (url.includes("pro-api.coingecko.com") ? 200 : 401)),
    async () => {
      const res = await gtGet("/networks/bsc/tokens/0xabc");
      assert.equal(res.ok, true, "a good key was reported as a failure");
      assert.deepEqual(res.body, { data: [1] });
    },
  );
  assert.equal(seen.length, 2, "it must try the other tier exactly once");
  assert.match(seen[0].url, /api\.coingecko\.com/);
  assert.equal(seen[0].demoHeader, "k3y", "the demo attempt must send the DEMO header");
  assert.match(seen[1].url, /pro-api\.coingecko\.com/);
  assert.equal(seen[1].proHeader, "k3y", "…and the pro attempt the PRO one");
  assert.equal(seen[1].demoHeader, undefined, "never both headers at once");
  assert.equal(gtTier(), "pro", "the discovered tier must be remembered");

  // ⚠️ AND IT IS NOT RE-DISCOVERED. Retrying the probe on every request would
  // double the cost of the very budget the key was bought to relieve.
  seen.length = 0;
  await withFetch(
    spy(() => 200),
    async () => {
      await gtGet("/networks/bsc/tokens/0xdef");
    },
  );
  assert.equal(seen.length, 1, "the settled tier was probed again");
  assert.match(seen[0].url, /pro-api\.coingecko\.com/);
});

test("a key both tiers refuse says so — never a bare 401", async () => {
  // "GeckoTerminal 401" is indistinguishable from a quota problem on the panel.
  // A key that neither host accepts is a wrong key, and the message has to name
  // the variable that fixes it.
  _gtReset();
  seen.length = 0;
  await withFetch(
    spy(() => 403),
    async () => {
      const res = await gtGet("/networks/bsc/tokens/0xabc");
      assert.equal(res.ok, false);
      assert.match(res.reason!, /GECKOTERMINAL_API_KEY/, "the failure must name the variable to check");
    },
  );
  // The tier settled on the first test, so this is one attempt, not another probe.
  assert.equal(seen.length, 1);
});

test("a 429 still arms the shared cooldown, key or no key", async () => {
  // The key raises the ceiling; it does not remove it. Losing the cooldown here
  // would put back the defect this whole client exists to prevent.
  _gtReset();
  await withFetch(
    spy(() => 429),
    async () => {
      const res = await gtGet("/networks/bsc/tokens/0xabc");
      assert.equal(res.ok, false);
      assert.match(res.reason!, /429/);
    },
  );
  const again = await gtGet("/networks/bsc/tokens/0xabc");
  assert.equal(again.status, 0, "the cooldown must suppress the next call without a request");
  assert.match(again.reason!, /cooling down/);
  _gtReset();
});
