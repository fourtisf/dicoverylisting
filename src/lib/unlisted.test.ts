// The token page's not-yet-listed state, and the route that feeds it.
//
// This is not an edge case: every buy-bot alert links to /token/<chain>/<ca>,
// the buy bot is free and runs on ANY contract, so for most arrivals this IS
// the token page. It used to be "Only paid listings appear here" and a Back
// button — a dead end on the one link that is supposed to sell a listing.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAINS } from "../config/chains.ts";

const SAMPLE_EVM = "0x0510101Ec6c49D24ED911F0011E22A0D697Ee776";
const SAMPLE_SOL = "A13oRB9FFaiUjfi6LdCg6p9ka1u8SfGkUFs4SKvPpump";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const PAGE = read("src/app/(site)/token/[chain]/[address]/page.tsx");
const COMPONENT = read("src/components/UnlistedToken.tsx");
const ROUTE = read("src/app/api/token-preview/route.ts");
const CSS = read("src/app/globals.css");

test("the token page routes an unknown contract to the unlisted view, not a dead end", () => {
  assert.match(PAGE, /if \(!t\) return <UnlistedToken chain=\{chain\} address=\{address\} \/>;/);
  assert.ok(!/Only paid listings appear here/.test(PAGE), "the dead end is gone");
});

test("the unlisted view answers the three questions a visitor arrives with", () => {
  // What is this · is it real · how do I get it listed.
  assert.match(COMPONENT, /Token Not Yet Listed/, "it says what state this is");
  assert.match(COMPONENT, /Contract address/i, "the CA, copyable");
  assert.match(COMPONENT, /Network/i, "the chain");
  assert.match(COMPONENT, /BOT_URL/, "and a way to list it");
  assert.match(COMPONENT, /Browse listed tokens/, "plus somewhere else to go");
});

test("it shows the live price and market cap it can get for an UNLISTED token", () => {
  // Fourtis shows $0.0115 / MC $11.04M on a token it has never listed, and it
  // is the reason the page reads as a product rather than a 404: the visitor
  // came from a buy alert and wants the number.
  //
  // These SURVIVED the chart removal below, and the difference is what it
  // costs: they ride one cached /api/token-preview request this page already
  // makes, where a chart is a fresh poll per visit against a shared ceiling.
  // Charting is what a listing buys; a price is not.
  assert.match(COMPONENT, /\/api\/token-preview\?chain=/);
  assert.match(COMPONENT, /fmtPrice\(tok\.priceUsd\)/);
  assert.match(COMPONENT, /fmtCap\(tok\.mcap\)/);
});

test("an unlisted token gets NO chart — and the embed ban stands separately", () => {
  // Two removals, two different reasons, and collapsing them is how one comes
  // back. The EMBED was banned because a third-party iframe sat on "Loading
  // chart settings…" and then planted a competitor's logo across a Dexvra
  // page. Our OWN chart was removed later, by the owner's call, for QUOTA:
  // this page is reachable by pasting any contract — every buy-bot alert links
  // here — so each visit polled /api/ohlcv for a token nobody listed, out of
  // the ~15 req/min GeckoTerminal share the site splits with the bot suite.
  assert.ok(!/<CandleChart/.test(COMPONENT), "no chart on a token nobody has listed");
  assert.ok(!/CandleChart/.test(COMPONENT), "and the import went with it");
  assert.ok(!/<iframe/.test(COMPONENT), "the embed ban is not what was relaxed");
  assert.ok(!/embed=1|light_chart|grayscale=/.test(COMPONENT), "and no embed URL left behind");
  assert.ok(!/\.unlisted-chart\{/.test(CSS), "the styles went too, not just the markup");
});

test("the removal left a note, so it does not read as an oversight", () => {
  // With no trace, the next person to notice this page has no chart simply adds
  // one back — and the quota it spends is invisible from the page itself.
  assert.match(COMPONENT, /NO CHART HERE, DELIBERATELY/);
});

test("a contract the feed has never seen still renders the page", () => {
  // The skeleton is keyed off a `done` flag, not off the data. Keying it off
  // the data would spin forever on exactly the tokens this page exists for.
  assert.match(COMPONENT, /finally\(\(\) => live && setDone\(true\)\)/);
  assert.match(ROUTE, /if \(res\.status === 404\) return null;/, "404 is an answer, not an error");
});

test("the preview route bounds the address it puts into an upstream URL", () => {
  // It is interpolated into a GeckoTerminal path, so it is checked rather than
  // trusted — the same guard /api/pool uses.
  assert.match(ROUTE, /address\.length > 90 \|\| \/\[\^A-Za-z0-9:_-\]\/\.test\(address\)/);
  assert.match(ROUTE, /if \(!CHAINS\[chain\]\) return NextResponse\.json/, "and only serves chains the app supports");
});

test("a feed outage degrades to the useful half, never to an error screen", () => {
  const handler = ROUTE.slice(ROUTE.indexOf("export async function GET"));
  assert.match(handler, /catch \{[\s\S]*?NextResponse\.json\(\{ token: null, chain: null \}\)/, "still 200 with a null token");
});

test("the preview is cached — a shared alert must not hammer the upstream", () => {
  assert.match(ROUTE, /cached\(`preview:\$\{network\}:\$\{address\}`, TTL/);
});

test("the view is styled, and readable on a phone", () => {
  assert.match(CSS, /\.unlisted\{/);
  assert.match(CSS, /@media \(max-width:640px\)\{[\s\S]*?\.unlisted-h/, "the heading scales down");
});

// ── Search · pasting a contract nobody has listed ────────────────────────────

const TOPBAR = read("src/components/Topbar.tsx");

test("a pasted CA that matches nothing locally is looked up, not refused", () => {
  // "No token matches 0xc111…" was both wrong — the token exists — and a dead
  // end, on the box people paste a CA into precisely because they saw it in a
  // buy alert.
  assert.match(TOPBAR, /\/api\/token-preview\?address=/);
  assert.match(TOPBAR, /Not Yet Listed/, "and it says which state the token is in");
});

test("the lookup only fires on a WHOLE address with no local match", () => {
  // It reaches the network. Firing it per keystroke of a ticker search that is
  // about to match locally is a request per character for nothing.
  assert.match(TOPBAR, /if \(!isCa \|\| matches\.length > 0\)/);
  assert.match(TOPBAR, /setTimeout\(\(\) => \{[\s\S]{0,400}?token-preview/, "debounced");
});

test("the row leads somewhere — the token page, on the chain that was found", () => {
  assert.match(TOPBAR, /router\.push\(to\)/);
  assert.match(TOPBAR, /`\/token\/\$\{probe\.chain\}\/\$\{encodeURIComponent\(homeQuery\.trim\(\)\)\}`/);
});

test("one address shape spans eight EVM chains, so they are probed in parallel", () => {
  // Sequentially this is eight round trips before the box can say anything.
  assert.match(ROUTE, /await Promise\.all\(\s*candidateChains\(address\)\.map/);
  assert.match(ROUTE, /hits\.sort\(\(a, b\) => \(b\.token\.mcap \?\? 0\) - \(a\.token\.mcap \?\? 0\)\)/, "ties break on market cap, not on a race");
});

test("a pasted EVM address probes EVERY EVM chain the app supports", () => {
  // The first cut hand-listed eight of fifteen, so a token on Berachain, Sonic,
  // HyperEVM, Abstract, ApeChain, Blast, Sei, Unichain or Robinhood answered
  // "not on any network we index" — about a network we index. Derived from each
  // chain's own addressPattern now, so adding a chain joins the probe by itself.
  const EVM_SHAPE = "^0x[a-fA-F0-9]{40}$";
  const evm = Object.values(CHAINS).filter((c) => c.geckoNetwork && c.addressPattern.source === EVM_SHAPE);
  assert.ok(evm.length >= 15, `expected the full EVM set, counted ${evm.length}`);
  const probed = Object.values(CHAINS).filter((c) => c.geckoNetwork && c.addressPattern.test(SAMPLE_EVM));
  for (const c of evm) assert.ok(probed.some((p) => p.id === c.id), `${c.id} is probed`);
  assert.match(ROUTE, /c\.geckoNetwork && c\.addressPattern\.test\(address\)/, "and nothing lists chains by hand");
});

test("a non-EVM address never probes an EVM chain, and vice versa", () => {
  const probe = (a: string) => Object.values(CHAINS).filter((c) => c.geckoNetwork && c.addressPattern.test(a)).map((c) => c.id);
  assert.deepStrictEqual(probe(SAMPLE_SOL), ["solana"], "a Solana mint is base58 and matches nothing else");
  assert.ok(!probe(SAMPLE_EVM).includes("solana"), "0x is not base58 — it contains a 0");
  assert.ok(probe(SAMPLE_EVM).includes("ethereum") && probe(SAMPLE_EVM).includes("berachain"));
});

test("a chain with no GeckoTerminal network is never probed", () => {
  assert.match(ROUTE, /c\.geckoNetwork && c\.addressPattern\.test\(address\)/);
});

test("EVM addresses are lowercased for the upstream, base58 ones are not", () => {
  // GeckoTerminal stores EVM lowercased and a pasted address is usually EIP-55
  // checksummed. Solana / Tron / TON are base58 or base64 — case is MEANINGFUL
  // there, and folding one turns a valid address into a 404.
  assert.match(ROUTE, /const forQuery = \(address: string\): string =>\s*\/\^0x\[a-fA-F0-9\]\{40\}\$\/\.test\(address\) \? address\.toLowerCase\(\) : address;/);
});

test("the chain lookup is ONE request across every network, not one per chain", () => {
  // Fifteen requests per search against a 30-a-minute budget shared with the
  // listing and trending pipelines: one person typing would starve the site.
  // The endpoint, not the URL text: the query string is built by the shared GT
  // client now (providers/gt owns the base, the API key and the 429 cooldown),
  // so pinning `?query=` was pinning where the "?" is typed.
  assert.match(ROUTE, /`\/search\/pools`, \{ query: forQuery\(address\), page: 1 \}/);
  const fn = ROUTE.slice(ROUTE.indexOf("async function findAnyChain"));
  assert.ok(fn.indexOf("searchNetwork(address)") < fn.indexOf("Promise.all"), "search first, fan-out only as fallback");
});

test("the search result is matched on the BASE token before the quote token", () => {
  // A search for a token also returns pools where it is the QUOTE side. Naming
  // those after the other token would show a completely different coin.
  const fn = ROUTE.slice(ROUTE.indexOf("async function searchNetwork"), ROUTE.indexOf("async function findAnyChain"));
  assert.match(fn, /\[pool\.relationships\?\.base_token, pool\.relationships\?\.quote_token\]/);
  assert.match(fn, /token\.toLowerCase\(\) !== want/, "and only when the address actually matches");
});

test("the not-listed mark is a warning, not a broken-image tile", () => {
  assert.match(COMPONENT, /unlisted-mark/);
  assert.ok(!/\?"\)\.slice\(0, 2\)/.test(COMPONENT), "the '?' placeholder is gone");
  assert.match(CSS, /\.unlisted-mark\{[^}]*#F5B841/, "same amber as the search badge");
});

test("the not-yet-listed badge reads as an invitation, not a failure", () => {
  assert.match(CSS, /\.sdd-unlisted\{/);
  assert.ok(!/\.sdd-unlisted\{[^}]*#F76A85/.test(CSS), "not the error red used elsewhere");
});

// ── A second, independent market source ──────────────────────────────────────

test("DexScreener is asked FIRST, because GeckoTerminal misses new launches", () => {
  // A pump.fun mint trading at a $250K cap answered "not on any network we
  // index": GeckoTerminal indexes DEX pools, so a token that has not graduated
  // to one is invisible to it. No amount of tuning the GT probe fixes that —
  // it needed a second source.
  assert.match(ROUTE, /api\.dexscreener\.com\/latest\/dex\/tokens\//);
  const fn = ROUTE.slice(ROUTE.indexOf("async function findAnyChain"));
  assert.ok(fn.indexOf("fromDexScreener(address)") < fn.indexOf("searchNetwork(address)"), "DexScreener before GT");
});

test("the token page asks in the same order, scoped to the chain in its URL", () => {
  // Unscoped, a copycat deployed at the same address on another chain could
  // answer for the token the URL actually names.
  const handler = ROUTE.slice(ROUTE.indexOf("export async function GET"));
  assert.match(handler, /fromDexScreener\(address, chain\)/);
});

test("the DEEPEST pair wins, not whichever the upstream listed first", () => {
  // A token has pairs on several DEXes and sometimes several chains. Liquidity
  // is an honest tie-break; array order is not a decision.
  assert.match(ROUTE, /\.sort\(\(a, b\) => \(b\.liquidity\?\.usd \?\? 0\) - \(a\.liquidity\?\.usd \?\? 0\)\)/);
  assert.match(ROUTE, /\(p\.baseToken\?\.address \?\? ""\)\.toLowerCase\(\) === want/, "and only pairs where it IS the base token");
});

test("every chain declares a DexScreener id, or explicitly declares it has none", () => {
  for (const c of Object.values(CHAINS)) {
    assert.ok("dexscreener" in c, `${c.id} must declare a dexscreener id (null if unsupported)`);
  }
  assert.strictEqual(CHAINS.robinhood.dexscreener, "robinhood", "DexScreener added Robinhood Chain (~July 2026) — null here re-blinds the one chain that lost the GT budget race for lack of a second source");
  assert.strictEqual(CHAINS.sei.dexscreener, "seiv2", "its id differs from ours");
});

test("the API still reports WHICH source answered", () => {
  // The page no longer draws a chart, but provenance is what makes a wrong
  // price diagnosable — and ?debug=1 prints it.
  assert.match(ROUTE, /source: "dexscreener"/);
  assert.match(ROUTE, /source: "geckoterminal"/);
});

test("a failed lookup can be diagnosed instead of guessed at", () => {
  // "No token matches" and "the upstream 404'd" look identical from outside,
  // and guessing between them cost two deploys.
  assert.match(ROUTE, /searchParams\.get\("debug"\) === "1"/);
  const dbg = ROUTE.slice(ROUTE.indexOf('debug") === "1"'), );
  assert.match(dbg.slice(0, 700), /tried\.dexscreener/);
  assert.match(dbg.slice(0, 700), /tried\.gtSearch/);
});

test("the debug view names the build that answered it", () => {
  // A debug endpoint that replies in an OLD response shape means the server was
  // never rebuilt, and working that out cost a round trip. The build stamp makes
  // "is it deployed?" answerable from the response itself.
  assert.match(ROUTE, /tried\.build = process\.env\.NEXT_PUBLIC_BUILD/);
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.build, /NEXT_PUBLIC_BUILD=\$\(git rev-parse --short HEAD/);
  assert.match(pkg.scripts.build, /\|\| echo unknown/, "a checkout with no .git still builds");
});
