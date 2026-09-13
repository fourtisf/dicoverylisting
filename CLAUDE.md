# Dexvra — working notes

## Repo layout

| Path | What it is | Runs as |
| --- | --- | --- |
| `src/`, root `package.json` | Next.js 14 web app (dexvra.io) | PM2 `dexvra`, port 3005 |
| `bot/` | Telegram bot — listings, trending, banners, group buy bot, raids | PM2 `dexvra-bot` **and** `dexvra-adminbot` |
| `tradebot/` | The trade bot, a separate process in the same repo | its own PM2 process |

Production server: the repo is checked out at **`/opt/dexvra`**. Never write
`/path/to/dexvra` in an instruction — it has been pasted literally into a live
shell before.

**The same is true of every placeholder, not just paths.** `REPORT_CHANNEL_ID=-100xxxxxxxxxx`
was offered as an example and appended to a live `.env` verbatim, where it
overrode a working default and silently stopped every ops report — `post()`
swallows its own failures by design, so nothing anywhere said why. A command
an operator can paste must contain only real values, or it must not be a
command: describe where the value comes from and let them fill it in, and make
the code reject a value that cannot possibly be right (`report.js`
`_looksLikeChatId`).

⚠️ **AND IT HAPPENED A THIRD TIME, in a script written to diagnose something
else.** `abi:check`'s own usage line read `node scripts/abi-check.js
0x<contract>`, an operator pasted `0xTOKEN_YANG_ANDA_BELI` exactly as it was
offered, and the tool reported its own usage screen back at them. The
angle-bracket spelling is the worse of the two: **bash reads `<` and `>` as
redirects**, so the command dies with `syntax error near unexpected token`
BEFORE the script runs — which reads as a broken tool rather than an unfilled
blank, and is what the Pons `--tx 0x<your own buy>` instruction already cost.

- **The fix is never to reword the placeholder.** It is to print a REAL value —
  `abi:check` with no address now asks the CHAIN for the launches that actually
  happened and prints one complete, pasteable line per token; `group-ca.js`
  uses a chatId from the row it just listed — or to describe the argument in
  prose and print no command at all, which is what `buybot:check` does because
  it can know neither of its two arguments.
- **A non-address argument is DIAGNOSED, not bounced to usage.** ⚠️ And the
  `0x` prefix is not the test: `0xTOKEN_YANG_ANDA_BELI` starts with `0x`, so
  "40 hex characters, that one has 20" is true, useless, and points at the
  wrong problem. Whether the rest is HEX is what separates a placeholder from
  a truncated address.
- **`tradebot/pasteableCommands.test.js` scans every `scripts/` directory in
  the repo** — one guard, not one per package, because three copies of a rule
  eventually disagree. ⚠️ Its first cut anchored the match to the start of the
  line and therefore **passed on the exact revision it exists to catch** (the
  line was `usage: node …` — a label, then the command); the vacuity test
  beside it is what said so. Mutation-tested against the three real pre-fix
  sources.
- The `.env` reference table `launchpads:check` prints (`LAUNCHPAD_<PAD>_API`)
  is deliberately **out of scope** and the guard says so: it is framed as
  variable names to edit by hand, it explains `<PAD>` on the next line, and
  there is no real value to substitute for a base URL. A judgement, recorded so
  it is not rediscovered as an oversight.

```bash
cd tradebot && node --test pasteableCommands.test.js   # 3 tests, no network
```

## Release flow — `main` is what the server runs

**Every change ends up on `main`, and the server only ever deploys `main`.**
Feature branches exist to build and review on; they are never the thing a
server checks out.

1. Build on a branch (`claude/<topic>`), commit there.
2. Run the full suite for whatever you touched — **it must be green before the
   merge, not after**:
   ```bash
   cd bot && npm test          # bot/       (~930 tests)
   npm test                    # web app, from the repo root
   cd tradebot && npm test     # tradebot/
   ```
3. Merge into `main` and push `main`.
4. Deploy on the server **from `main`** — see [`bot/DEPLOY.md`](bot/DEPLOY.md).
5. **Verify what is running before believing anything about it.** Every process
   prints its commit at boot.

A branch left unmerged after it is deployed is the failure mode this rule
exists to prevent: the server sits on a branch, the next change is cut from
`main`, and the two silently diverge.

If a pull request for a branch has already been merged, do not add commits to
that branch — restart it from the current `main` and open a new one.

### The whole deploy is ONE command

```bash
cd /opt/dexvra && npm run deploy
```

`scripts/deploy.sh` is the only line to type on the server. It derives the repo
root from its own location (no path to fill in — this file's first rule),
refuses a dirty tree, fast-forwards only, and then **decides from the DIFF what
to rebuild and restart**:

| changed | what runs |
| --- | --- |
| `bot/**` | `pm2 restart ecosystem.config.js` — **both** bots |
| `tradebot/**` | `pm2 restart dexvra-tradebot` |
| `shared/**` | all three — `shared/launchpads/` is required by every package |
| anything else | `npm run build` + `pm2 restart dexvra` |

- `npm run deploy:all` — rebuild and restart everything, for a box whose state
  is in doubt. `--with-bots` still forces the bot suite on.
- **With nothing new to pull it verifies and restarts nothing**, so a second run
  is a report rather than another rebuild — which makes it the "what is actually
  running?" command too.

⚠️ **THE SCOPE WAS A THING AN OPERATOR HAD TO REMEMBER, AND `--with-bots` WAS
OPT-IN.** Forgetting it deployed the web app and left BOTH bots on the old code
— which fails silently and reads as a missing feature rather than a stale
process, the exact defect `bot/DEPLOY.md` and the section below are written
about. The script has `BEFORE` and `AFTER` in hand, so it computes the answer
instead of asking for it. Equally, a `tradebot/`-only change no longer pays for
a Next build it does not need.

The four commands above are still what it runs, and they are still correct by
hand — but by hand is where the forgetting happens.

```bash
cd /opt/dexvra && node --test --experimental-strip-types src/lib/deployScript.test.ts   # 17 tests, no network
```

### Step 5 is not optional — and `npm run deploy` now does it

```bash
pm2 logs dexvra-bot      --lines 50 --nostream | grep '\[boot\] build'
pm2 logs dexvra-tradebot --lines 50 --nostream | grep '\[boot\]'
```

The sha printed must equal `git rev-parse --short HEAD`. A `+dirty` suffix means
the checkout has uncommitted changes and is **not** what `main` says it is.

This exists because a pull that never reached the server and a change that did
not work are indistinguishable from Telegram, and an evening was spent debugging
the first while assuming the second. Do not report a fix as deployed, and do not
start diagnosing why one "did not work", until the sha matches.

⚠️ **AND THE SCRIPT ONLY EVER CHECKED THE WEB APP.** The bot suite is where most
of this repo's features live and where every one of those evenings was lost, and
its three processes print `[boot] build <sha>` for exactly this reason — nothing
read them back. All four are verified now, and the web app's stamp is read from
`/api/tokens` rather than scraped out of the HTML, because `NEXT_PUBLIC_BUILD`
is inlined into a bundle whose spelling the minifier owns.

- ⚠️ **THE TEST IS A DIFF, NOT AN EQUALITY, and a driven test is what said so.**
  The first cut compared every process to HEAD — and on a `tradebot/`-only
  deploy the bot suite sitting on an older commit is CORRECT, so that rule
  leaves the command permanently red on a healthy box: the state
  `chart:preview` sat in for weeks, which teaches its reader to ignore the red.
  A process is behind only when a file in **its own** paths changed since the
  commit it is running. A process that was just RESTARTED is the strict case.
- ⚠️ **A STALE LOG LINE MAY NOT BE READ AS THIS BOOT.** `pm2 logs --nostream`
  reads the log FILE, which still holds every earlier boot, so `grep | tail -1`
  reports a stamp from three days ago as current. The boot lines are COUNTED
  before the restart and the read waits for that count to go up.
- **An unresolvable sha is not a verdict.** A commit this checkout does not have
  (history rewritten, a tarball deploy) is reported and never counted — "could
  not establish" and "stale" are different facts.

⚠️ **`bash -n` proves syntax and every defect this repo has had in a script was a
runtime shape**, so `deployScript.test.ts` DRIVES the script against a real temp
git repo with `npm`, `pm2` and `curl` stubbed — and the pm2 stub delays its boot
line, because otherwise a test cannot tell "read the end of the log" from "wait
for a line this restart produced".

Fourteen guarantees are MUTATION-TESTED rather than argued: the scope ignored,
the bots forced on regardless, `shared/` treated as web-only, the bot suite
restarted by name, the bots never verified, a stale log line read as this boot,
a restarted process allowed to be older, every process compared to HEAD, a
`+dirty` stamp passing, a missing boot stamp passing, nothing-to-pull rebuilding
anyway, `npm ci` run for every package, `--with-bots` ignored, and a dirty
working tree deployed over. Each fails between one and six tests. ⚠️ Four of
them SURVIVED the first run — all four were test gaps, not code defects, and
the tests they demanded are the `+dirty`, no-stamp, real-older-commit and
delayed-boot cases.

## A third party will move, and it must not cost a user money

Three outages in two days, all one shape: Jupiter retired
`quote-api.jup.ag/v6` and every Solana buy died with the word `fetch failed`,
five wallets at a time, under a green ✅ receipt. pump.fun moved to
`frontend-api-v3` and snipe discovery went blind while `/health` printed 🟢.
Then `/swap` began failing on a base whose `/quote` answered fine.

Each was found by a human typing `npm run preflight:solana` **after** a user
complained. So the rules below are not style — every one of them is an outage
that already happened.

- **Never one hardcoded host.** A base LIST, current first, legacy kept so a
  rollover in either direction needs no deploy. `<THING>_API` env pins one host
  and skips discovery — an override *and* a skip, the contract
  `<CHAIN>_V4_POOLMANAGER` already has. `solana.js` `JUP_BASES` / `_overBases`
  is the reference; copy it, do not write a fourth private idea of failure.
- **Fail over on a TRANSPORT error only.** An HTTP status means the host is
  there and answered; the same request gets the same status everywhere else, so
  retrying it just doubles the latency of a request that was always going to
  fail.
- **Never discard the reason.** undici's `fetch failed` puts the syscall code in
  `err.cause`; an HTTP error puts the explanation in the response body. Both were
  being thrown away, and both cost a round of guessing —
  `Jupiter swap-build failed (500)` was true, useless, and hiding
  *"Token account … is owned by … instead of the user"*. `netErr()` and
  `jupWhy()` exist for this.
- **"It answered with nothing" and "it did not answer" are different facts.**
  `pumpfunNew` returned `[]` for both, so a 403, a 429, a dead host and a quiet
  launchpad were indistinguishable. Return `{ items, ok, why }` — `pumpfunNewX`
  and `core.dsPairsX` are the shape.
- **A loop that RAN is not a loop that WORKS.** The Solana snipe's early
  `return` on an empty feed counted as a successful tick, so a feed dead for days
  rendered a green tick — the state that looks most like a healthy one.
  `lastFeedOkAt` (the feed answered) and `lastLaunchAt` (it had something) are
  both needed; one alone lies.
- **Moving a base is not moving an API.** The host failover was right and still
  left `prioritizationFeeLamports: 'auto'` — v6's spelling — going to a v1
  endpoint. The query path happened to be identical; the POST body was not.
- **Probe with a fresh address, never a shared one.** The preflight built its
  swap for the address derived from the standard BIP39 test mnemonic; a stranger
  had created a token account under a foreign owner, Jupiter rightly refused, and
  the operator was told not to trade. `Keypair.generate()` has no history.

### The watchdog is the point

`upstreams.js` holds the probe list, and **both** the preflight script and the
running bot use it — two copies of "is Jupiter up" would eventually disagree,
which is exactly what two pump.fun hosts in two processes already cost.

It sweeps every `UPSTREAM_CHECK_MS` (default 10 min) and posts to the ops
channel **on the transition only** — a broken upstream posting every sweep is a
channel nobody reads by the second hour. **A recovery is an alert too**, or the
operator cannot tell a fixed outage from a forgotten one. A bot that boots
*into* an outage reports it on the first sweep, because the transition it would
otherwise wait for already happened while it was down.

`UPSTREAM_CHECK=0` disables it; the floor on the interval is 60s.

When adding a probe: say what the USER loses (`costs`), not which host is down.
"lite-api.jup.ag ENOTFOUND" does not tell an operator whether to stop the bot or
finish dinner. Mark `critical` only when users cannot trade — an alert where
everything is critical has no priority in it.

```bash
cd tradebot && npm run preflight:solana    # the same probes, on demand
```

### Config a fix depends on

A code change that needs a new `.env` value is not finished when it is merged —
it is finished when the value is set. Say so explicitly, with the exact variable
name, and expect the behaviour to be unchanged until then. `data/`, `.env` and
`.keys/` live only on the server, so nothing here can set them.

Uniswap v4 used to be the standing example of this and no longer is. It needed
`<CHAIN>_V4_POOLMANAGER` to price and `<CHAIN>_V4_UNIVERSAL_ROUTER` +
`<CHAIN>_V4_PERMIT2` to trade, and until an operator pasted all three a live
pool read as "Dexvra can't route through that yet". `tradebot/v4.js` now
observes all of it from the chain's own logs — the PoolManager from the pool's
Initialize log, the router from the senders of that manager's Swap logs, Permit2
from its deterministic address (verified by `getCode`) — and caches it per
chain. The env vars still exist and still win when set; they are an override and
a discovery skip, not a prerequisite. `<CHAIN>_V4_AUTODISCOVER=0` pins a chain
to env alone.

## Before a token migrates, only its launchpad knows it

DexScreener and GeckoTerminal index **pools**. A token on a bonding curve has no
pool, so for its entire pre-migration life — minutes to days, and the window in
which people actually ask about it — both processes were blind in the same way:

- the trade card said **"❌ Couldn't price it"** and offered a chain picker,
  about a token trading perfectly well on its launchpad;
- worse, `tokenSnapshot`'s Solana branch hardcoded `graduated: true,
  progressPct: 100` for **every** mint, so even a token DexScreener *did* index
  was badged `◆ DEX` while it sat at 12% of a curve;
- the listing form autofilled nothing — no name, ticker, logo, socials or
  overview — for a project whose whole profile is public on its pad.

`shared/launchpads/` is the fix, and it is **one module both processes require**.
That is not tidiness: `tradebot/solana.js` and `bot/src/marketdata.js` each
carried their own idea of which pump.fun host was current, they drifted, one was
left on the retired host, and Solana snipe discovery was blind for days behind a
green `/health`. `bot/src/launchpads.js` and `tradebot/launchpads.js` are thin
shims that reshape the output; neither names a host, and a test asserts they
never grow one again.

- **`pads.js` is a TABLE, and every entry is env-overridable.** These request
  shapes are not published contracts. `LAUNCHPADS=0` kills the registry;
  `LAUNCHPAD_<PAD>=0` kills one (blank ≠ false, same rule as
  `raid/sourceFlag.js`); `LAUNCHPAD_<PAD>_API` pins one host **and** skips the
  base list; `LAUNCHPAD_<PAD>_TOKEN_PATH` / `_FEED_PATH` rewrite the paths. A
  pad whose guessed path is wrong costs a line in `.env`, not a deploy — which
  is why adding a pad whose shape we cannot verify is safe. `verified: false`
  marks those, and the check script prints it.
- **`PUMPFUN_API` is honoured as an alias.** An operator's existing override
  must not be silently outvoted by a second env var with a longer name.
- **Display metadata only.** Nothing here prices, routes or authorises a swap —
  same contract as `poolstrade.js`, and it matters more here because these pads
  quote a price. `curveSnapshot()` returns `routable: false` *always*; `core.js`
  upgrades it only after Jupiter has actually quoted the mint (`_solRoutable`).
  Knowing a price and being able to fill a swap are different capabilities —
  the line `v4.js` draws between `price()` and `canSwapLive()`.
- **A dead pad must cost nothing.** Pads are asked concurrently and the caller
  waits for all of them, so one unreachable host adds its full timeout to every
  card render and every autofill. Three consecutive **transport** failures bench
  a pad for `LAUNCHPAD_BREAKER_MS`; an HTTP status never benches it (the host
  answered). A benched pad is reported in `tried`, never silently skipped.
- **Curve state is taken WHOLE from one pad.** Facts outrank readings: a
  migration pool beats a stale percentage. Taking `graduated` from one source
  and `42%` from another is a card contradicting itself in two places — exactly
  what the buy card's two ideas of "whale" already cost.
- **`onCurve` is three-valued.** `true` / `false` / `null` for "no pad said".
  Rendering the null as either one invents a fact.
- ⚠️ **`Number('')` is `0`.** The first cut of the env reader used it, so every
  default was silently replaced by zero — no caching at all, and a breaker that
  tripped after 0 failures for 0ms. Nothing errored and nothing logged.
- **The snipe keeps ONE CURSOR PER PAD.** A shared cursor lets one pad's bad
  timestamp advance past every real launch on every other pad, and the snipe
  goes quiet forever — which looks exactly like a slow day. `normalize.toMs()`
  also refuses a future timestamp; that is the first line, and first lines have
  been wrong before.

```bash
cd bot      && npm run launchpads:check            # which pads answer, and what a listing would autofill
cd tradebot && npm run launchpads:check <mint>     # the same registry, pad by pad, for one token
```

Whether a launchpad answers is a property of the server's egress today, not of
the code — these hosts block datacenter ranges — so it has to be measured on the
box. `upstreams.js` picks up the pad probes automatically (none `critical`: a
dead pad costs pre-migration data, not the ability to trade).

**Config a fix depends on:** nothing. Every pad ships on, and blank means on.
The one thing an operator has to do is hit **♻️ Reset default** on the
`review_card` template if they have ever edited it, or the "🚀 Still bonding"
line will not appear on the listing review card.

### "bot listing masih tidak baca api dari pons v2 maupun v1"

Reported with a screenshot: a Pons contract pasted into the listing flow, and
the bot answering **"Token Name — What is your project called?"** — the autofill
having produced nothing at all, about a token whose own contract publishes its
name, ticker, logo, description and five socials.

**Nothing was broken, and the pad was not the gap.** The autofill has exactly
three sources and NONE of them reads the chain: `dexscreener` and
`marketdata.fetchMarket` index POOLS, and a token on a bonding curve has none;
the launchpad registry asks Pons over HTTP on a host and a path this repo has
never verified (`verified: false`, and the operator's own `launchpads:check`
reported the earlier guess unreachable). So the one source that cannot be
unreachable — the token contract itself — was the one nobody asked.

- **`bot/src/ponsChain.js` asks the WEB APP, and that is the point.** The
  reader already exists in `src/lib/providers/pons` and is the one owner of
  what the Pons factory says about a token; this package is CommonJS on Node 18
  and cannot import a `.ts` module, so a local copy would be a SECOND reader —
  the exact shape that left `tradebot/solana.js` and `bot/src/marketdata.js`
  disagreeing about pump.fun's host until Solana discovery went blind for days.
  Both processes are on the same box, so it is a localhost request.
- **LAST in `discovery.fetchTokenInfoX`'s extras**, and that is the whole
  safety of it: `mergeInfo` only ever fills holes, so the chain answers exactly
  what no indexer and no pad did — for a fresh curve token that is everything,
  and for anything else it is nothing. Zero behaviour change wherever the
  existing sources already answer.
- ⚠️ **A POSITIVE test, because a wiring that does nothing refuses
  beautifully.** `ponsDiscovery.test.js` drives the real merge with both HTTP
  sources answering null and asserts the form got filled — the `curveBuyPath`
  scar, one package over. Mutation-tested: removing the wiring fails both.
- ⚠️ **`ipfs://` IS REAL ARTWORK AND AN UNUSABLE URL.** `adminValidate`'s
  `LOGO_RE` takes https or an upload and nothing else, so passing a mint's own
  logo through verbatim would have failed the WHOLE listing over its picture —
  the rule the launchpad socials already carry ("losing a link beats losing the
  listing and the link with it"). Rewritten to a gateway the site's image proxy
  allows, `PONS_IPFS_GATEWAY` if that one ever needs moving.
- **`liq`, `vol24` and `pairCreatedAt` stay 0.** They are the fields the
  auto-lister's gates read by name and 0 is how this repo spells "no data" on
  them; a curve publishes none of them, and `ok` still follows the INDEXER — a
  chain record does not make a refusal into an answer.
- **"Pons never launched this token" (404) and "we could not ask" are different
  facts**, and only the first is recorded against the address. A transport
  failure parks the reader for `PONS_CHAIN_COOLDOWN_MS` instead of costing one
  attempt per paste — the `benched` rule, for the fifth time in this repo.
- The socials and the description are read from the token in ONE batch and
  deliberately **only on the single-token path**: the launch feed reads twenty
  at a time and would pay for it on every one of them.

```bash
cd bot && node scripts/run-tests.js test/ponsChain.test.js test/ponsDiscovery.test.js   # 10 tests, no network
cd /opt/dexvra && npm run pons:check    # which of the three layers answers, on the box
```

**Config a fix depends on:** nothing. `DEXVRA_API_BASE` already points the bot
at the site and defaults to `http://127.0.0.1:3005`. ⚠️ But the web app must be
running and on a build that carries `/api/pons` — this is a `bot/` change AND a
`src/` change, so the deploy is the full one.

#### "ini sudah ada tapi mengapa bot tidak otomatis menambahkan logo projectnya punya logo"

The wiring above landed and worked: the review card for a fresh Pons launch came
back with the name, the ticker and the X handle filled in — from the chain,
which is the whole point. **And `Logo: not set`**, about a token whose artwork is
on its own pad page, whose contract publishes it, and whose `pons:check` on the
same box printed it:

```
✓ token.logo() → ipfs://bafkreif3og7rosylkz34ho7mbgzdkyscslhnastl3qszh6qykfwzg6lk3m
```

**Nothing in the bot was wrong.** `ponsChain.httpsLogo` rewrites `ipfs://` to a
gateway and has a test that says so; `mergeInfo` fills holes, and the name and
the ticker prove it ran. The logo never reached it: `readCurvesAndMeta` kept a
logo only if it matched `/^https?:\/\//`, so **every logo Pons has ever
published was nulled at the source** — a launchpad pins its artwork on IPFS,
which is the one scheme that filter refuses.

- **`tokenLogo()` is the ONE owner of what the provider may publish**, pure and
  in its own module for the reason `logoWrite.ts` and `relist.ts` are: a rule
  about what may be published is something a source scan cannot tell from a
  comment about one, so it is tested by being CALLED.
- **It is still an ALLOWLIST.** `logo()` is free text written by whoever
  deployed the token, and anyone can launch on a permissionless pad. What it
  allows is exactly what the two consumers can RENDER — `logoSrc` → `/api/logo`
  rewrites `ipfs://` to a gateway with failover, and the bot does the same for
  the form. Publishing a scheme neither can draw turns "no logo" into a broken
  image, which is worse than the monogram: the monogram at least looks
  deliberate.
- ⚠️ **`ar://` is deliberately refused, and that is a judgement.**
  `arweave.net` is already on the proxy's host allowlist, so an
  `https://arweave.net/<txid>` logo works today; what does not exist is an
  `ar://` → gateway rewrite in either consumer. If a Pons token ever ships one,
  the fix is that rewrite — not a wider test in the provider. Recorded so it is
  not rediscovered as an oversight.
- **An on-chain string is unbounded** and this one lands in a JSON payload, a
  Telegram form and a listing row.

⚠️ **AND `pons:check` PRINTED A GREEN TICK OVER IT FOR THE WHOLE DEPLOY.**
Sections 1–5 read the CONTRACT; the bot and the site read the APP, and those are
different stacks — so the check was honest about the chain and silent about the
only thing the listing form depends on. That is `fonts:check`'s nine green ticks
over a banner publishing boxes, on a different feature: **a guard is only honest
while it measures the stack the caller actually uses.**

- **Section 6 asks `/api/pons` for the very fields the form autofills** and
  names any the app dropped, with the value the contract publishes beside it.
- **"The creator filled nothing in" and "the app dropped it" are different
  facts**, and only the second is a red mark — a check that reddened on the
  first would be permanently red on any pad where most creators skip the
  artwork, which is the state `chart:preview` sat in for weeks.
- **One fault, one alert**: a `logo()` that REVERTS is already red in section 4,
  and blaming the app for it would send the operator to the wrong layer.
- ⚠️ **It is DRIVEN, not read.** `node --check` proves syntax and the defect
  here is a runtime shape, so `ponsCheck.test.js` stands up a stub Robinhood
  node and a stub dexvra server and runs the real script against both — red when
  the app drops a logo the chain published, green when it serves it.
- ⚠️ **A guard a mutation run cannot kill is not a guard.** The first cut had
  `chain === undefined` above `!chain`; the second covers both, the first is
  dead, and the comment says so rather than carrying a line that claims cover it
  does not provide.

Mutation-tested: restoring the https-only filter, dropping the allowlist
entirely, dropping the length bound, the reader bypassing the one owner, the
check reporting every field as fine, a blank field counting as dropped, and the
check not asking the app at all each fail between one and three tests.

```bash
npm test                                # pons/logo (8) + pons/ponsCheck (4)
cd /opt/dexvra && npm run pons:check    # §6 is the one that measures the app
```

**Config a fix depends on:** nothing. `PONS_IPFS_GATEWAY` moves the gateway the
bot rewrites to; `IPFS_GATEWAYS` is the site proxy's own list, and it already
fails over.

## The banner drew "$???" to 12,607 subscribers

A token listed as **牛来 ($牛来)** went out on the listing card as `$???` and again
on the pump alert as `??`. Nothing failed and nothing logged: **a font that lacks
a glyph does not throw** — it draws a box, or a question mark, and ships.

Every brand face in this repo is Latin-only — Sora, Space Grotesk, JetBrains
Mono, Liberation Sans — so every Chinese, Japanese, Korean, Thai or Arabic ticker
the bot has ever drawn came out the same way, silently, since the fonts were
added.

- **A FALLBACK CHAIN, not a second font for Chinese.** Canvas resolves a
  comma-separated family list **per glyph**, so `牛来 Finance` keeps the brand
  face for the Latin word and reaches the coverage face only for the Han
  characters. Swapping the whole face on a mixed name puts brand type on one half
  of a title and a system face on the other. Verified by measurement: with the
  chain, `牛来` measures exactly what the CJK face alone measures and `AB`
  measures exactly what Sora alone measures.
- **The chain is appended to EVERY entry in `F`**, so no renderer opts in. One
  that had to would forget on the card that needed it — and one that draws with
  families of its own is not covered at all, which is exactly what the animated
  overlay turned out to be doing (see below).
- **Discovered across a candidate LIST**, repo `assets/fonts/` first, then the
  system paths — same contract as the launchpad hosts. The faces are BUNDLED, so
  a deploy carries them; a font package is a second source, and an operator's own
  file in `assets/` outranks both.
- **BOLD before Regular, per script.** These faces sit beside the 700/800 display
  weights; a regular-weight Thai word next to a heavy Latin one reads as two
  titles — the mixed-face defect one level down.
- **Emoji goes LAST in the chain.** A colour-emoji face claims some text
  codepoints, and a ticker's letters must not resolve to it ahead of a real text
  font.
- ⚠️ **The boot warning names EVERY uncovered script, not just CJK.** The first
  cut warned about Chinese alone, which would have let the next Thai ticker reach
  the channel as boxes in the same silence. A warning that covers one instance of
  a general failure is how the general failure survives being fixed.
- **Shaping is the shaper's job.** Canvas runs HarfBuzz, so Arabic joins and runs
  right-to-left and Thai stacks its marks with no code here — all the font list
  has to get right is handing it a face that HAS the glyphs. Verified by
  rendering real listing cards: `$牛来`, `$ไทยบาท` (`เพื่อญาติ Finance`, stacked
  vowels intact) and `$عملة` (`عملة رقمية Token`, bidi correct).
- Thai ascends ~25% higher than Latin at the same size (54px vs 43px at 52px
  type) because of its stacked vowel marks. The card has headroom above `symY`
  and does not clip — but a tighter layout would, and `fitText` only shrinks for
  WIDTH.
- ⚠️ **`reg()` assigns unconditionally, and the two Liberation "fallback" calls
  ran after their Sora counterparts** — so Liberation Sans silently won `x` (the
  800 display weight, i.e. the big token title on every card) and `m`. The
  artwork has been off-brand on its most prominent line for as long as the brand
  fonts have existed. `regFb()` is the guard the comment always implied.

### So it cannot happen again quietly

The chain fixes the cause. What stops the NEXT one is that a banner can no
longer ship boxes unnoticed:

- **`unrenderable(text)` asks about the STRING, not about a list of scripts.** A
  Private Use codepoint is in no font, so its advance width IS this face's notdef
  box; any character measuring the same has fallen to the same box. That caught
  Armenian, Bengali, Tamil and Georgian on a box where `coverage()` reported all
  nine sampled scripts green — the same silence as `$???`, one script family over.
  A heuristic (a real glyph could share that advance), so it drives a WARNING and
  never a rendering decision. Cached per codepoint, ASCII skipped.
- **`warnBoxes()` lives in `canvasKit`, and every renderer entry calls it** — the
  listing/trending card, the rank-up card, and `bannerTemplate.compose()`, which
  is the one function every overlay goes through, the pump alert included. A
  guard each renderer had to remember is one the fifth renderer will not have;
  `bannerFonts.test.js` fails if an entry stops calling it or grows its own copy.
- **It warns and renders anyway.** A banner with two boxes still beats no banner
  — the project is owed its listing, and a render that refused would turn a
  blemish into an outage. What must not happen again is it going out unseen.
- It posts through `log.alert`, which de-duplicates: one token drawn on the card,
  the pump alert and a rank-up is one line in the ops channel, not three.

```bash
cd bot && npm run fonts:check     # which scripts THIS box can draw, plus a sample PNG
```

Whether a glyph renders is a property of the fonts on the server, not of the
code — same as `raid:check` and `launchpads:check` — so it has to be measured on
the box.

**Config a fix depends on:** emoji, and nothing else — every TEXT face is
bundled now, see the next section. `fonts-noto-color-emoji` is still worth
installing (🚀 in a ticker is routine), and **it is its own package that neither
`fonts-noto-cjk` nor `fonts-noto-core` pulls in**: an install line written from
memory left it out, the operator ran exactly what was asked, and the box came
back with every text script green and `✗ Emoji`.

So the mapping is in code (`PKG_FOR` / `packagesFor()`), and both the boot
warning and `fonts:check` print the exact `apt-get` line for whatever is actually
missing. "1 script(s) uncovered" is a diagnostic; a package name is an
instruction, and it cannot be recalled wrongly if it is computed.

### It shipped as an INSTRUCTION, and the instruction never ran

Six days later, a listing went out on X as `$??` over `??` — the same token
class (`老昊`), the same boxes, this time on the **animated banner**, which is
the artwork most of the channel actually sees. Everything above was deployed.
Two causes, and the second is the one that matters.

**1. `apt-get install` is not a fix, it is a request.** The chain looked in
`assets/fonts/` first and then at the system paths, and the box had neither: the
package was never installed, and nothing about that is visible from Telegram —
the boot warning goes to pm2's log, and a banner with boxes in it renders
successfully. So the six coverage faces are **bundled and git-tracked** now
(`BUNDLED` in `canvasKit.js`, ~17MB, SIL OFL). The server deploys with
`git pull`; a tracked file is the only kind of fix that cannot be skipped. The
system paths stay, and an operator's own file in `assets/` still outranks both.
- **Noto Sans SC has no hangul** — measured, not assumed — so Korean is a second
  file, registered AFTER the Han face. Ahead of it, a Chinese token would be
  drawn in Korean glyph shapes.
- **Emoji is deliberately NOT bundled**: a ~10MB colour-bitmap face for the one
  script whose package is reliably present. It stays the `apt-get` line above.
- A missing bundled face and a missing package are **different instructions**.
  The warning and `fonts:check` now say *"this checkout is incomplete, run git
  pull"* for the first, because sending an operator to apt for a file `git pull`
  restores is how twenty minutes go missing.

**2. ⚠️ The overlay renderer was OUTSIDE the chain, not last in it.**
`bannerTemplate.js` — the one function every animated overlay goes through,
the pump alert included — registered Sora-800/600/500 under three private
families of its own (`TplBold` / `TplSemi` / `TplReg`) and drew with
`TplBold, sans-serif`. Latin-only. **So even with the font installed, the GIF
would still have shipped boxes**, which is exactly what the first version of
this fix would have delivered: measured, with a CJK face registered
process-wide, `老昊` is 150px in `TplBold` (notdef boxes) and 200px in `F.x`.

And it was SILENT, which is the general lesson: `warnBoxes()`/`unrenderable()`
measure against `F.r`, so **the guard was asking about a font stack that
renderer did not use** and answered "no missing glyphs" over a card that was
drawing them. A guard is only honest while every renderer draws through the
stack the guard measures. One registration, in `canvasKit`; `compose()` draws
with `F.x` / `F.s` / `F.m`, and the Latin output is byte-identical across all
four kinds (verified by hashing the PNGs before and after).

- `bannerFonts.test.js` gained the guard that would have caught it, and it
  **runs the renderers** rather than reading them: it wraps the 2D context's
  `font` setter, calls `compose()` and `renderListingBanner()`, and asserts every
  font string they actually set carries every coverage family. A source scan
  passed on the broken revision — the two new renderer tests fail on it, and the
  two bundling tests fail if the fonts are moved out of `assets/`.
- Verified by LOOKING at the output, not only by measuring: the real GIF→MP4
  path (`composeOntoClip` + ffmpeg) renders `$老昊` / `老昊 Finance` on the real
  artwork, and the still cards render `$한글토큰` and `$ไทยบาท` (stacked vowels
  intact, no clipping).
- `tradebot/pnlImage.js` needed nothing: it draws through this same module,
  which is the whole reason that rule exists.

```bash
cd bot && npm run fonts:check                                    # now green on a bare box
cd bot && node scripts/run-tests.js test/bannerFonts.test.js     # 28 tests
```

**Config a fix depends on:** nothing. `git pull` + restart carries the glyphs.

### "bagaimana agar masalah ini tidak terjadi lgi" — a green check that was not

Asked with a screenshot of the production box: nine green ticks, *"Every script
sampled here renders."* The same terminal, on a server whose animated banner had
been publishing `$老昊` as `$□□`.

**Read that output again, because it says what went wrong.** The chain it
printed resolved to `/usr/share/fonts/...` — the SYSTEM paths — and carried no
`Korean` line at all. Both are only possible on code that predates this fix: the
bundled faces are tried FIRST, so a checkout carrying them can never resolve to
`/usr/share`, and `DexCover Korean` does not exist in the old file. The deploy
ran `git pull` on `main`, and the fix was on a branch. So the green was the apt
packages the operator had just installed — cause 1, fixed by hand — sitting over
cause 2, still live.

That is the shape to design against, and it is the third time this feature has
produced it: **the reassuring reading is available, and it is wrong.**

- **`coverage()` answers "does this BOX have the glyphs?"** That question stopped
  being the one that mattered the moment a renderer could be outside the chain.
  It reported ✓ for all nine scripts while the overlay drew boxes, and both
  statements were true.
- **So `fonts:check` now RUNS every surface** — `src/bannerSurfaces.js` is the
  list, and `kit.recordFonts()` wraps the 2D context's `font` setter and reads
  back what each renderer actually set. Per surface, per script, measured. The
  broken revision reports:

      ✗ animated GIF/MP4 overlay — listing clip, pump alert
        bannerTemplate.js drew with: 800 96px TplBold, sans-serif

  and **exits non-zero**, so green means "the banners are safe" rather than "the
  box has fonts". The font string is printed because it is the diagnosis: a stack
  with no `DexCover` family in it is a CODE fix, not an apt one.
- **The list is the guard.** A renderer nobody probes is exactly how this got six
  days; `bannerFonts.test.js` fails the build if a module calling `warnBoxes()` is
  missing from `SURFACES`, and if a listed module does not exist.
- **A surface that throws, or that draws no text at all, is an ERROR — never a
  quiet ✓.** An empty recording measured nothing, and reporting that as a pass is
  this whole section's defect in miniature.
- **The check prints the build stamp** (`build ad43311+dirty`). Every round of
  this has begun with someone reading a check as a statement about the fix they
  just deployed. One line settles it, and it is the same `+dirty` rule as step 5.
- `tradebot/pnlImage.js` is deliberately NOT probed: its input is a computed PnL
  snapshot, not a coin, and the card refuses to draw when anything is unknown —
  so a fabricated one renders nothing and would report a false red on a healthy
  renderer. It is covered by the hardcoded-family scan and by `pnlCard.test.js`.

So the three layers, and each one closes a hole the others cannot:

| layer | stops |
| --- | --- |
| the faces are git-tracked | a deploy that carries the code but not the glyphs |
| `bannerFonts.test.js` runs the renderers | a renderer drifting back outside the chain |
| `fonts:check` probes the surfaces + prints the sha | a green check over a broken banner, and a check read off a stale checkout |

```bash
cd bot && npm run fonts:check     # per BOX and per SURFACE; non-zero if any banner would ship boxes
```

⚠️ **And the deploy itself is the remaining hole, because it is not code.** The
server only ever pulls `main` (see the release flow at the top), so a fix sitting
on a `claude/*` branch is not deployed however many times `git pull` runs — and
from Telegram that is indistinguishable from a fix that did not work. `npm run
fonts:check` printing the sha is the cheapest tell; `git log --oneline -1` on the
box against the branch is the direct one.

## "Sudah di set tapi bot tidak memakai emoji premium terbaru"

Reported with a screenshot of the 🔥 Trending board panel: ranks 1–9 all showing
💎, `🟢 account connected`, `18/33 slots premium` — and a channel board that had
not changed. Nothing in the store or the render path was wrong (`load()` reads
`trendingBoard.json` on every call, both processes share `DATA_DIR`, and
`pe.promote()` returns an already-premium fragment untouched, so a saved id is
never overwritten by the built-in one). **Two things were missing, and both are
the same defect: the panel could not answer the question it exists to answer.**

- ⚠️ **💎 meant "this slot is premium", not "this is YOURS".** `tbMark` was
  `premium ? 💎 : custom ? ✅ : ▫️`, and ranks 1–9 plus the major chains ship
  premium BUILT IN — so a panel on which nothing had ever been saved looked
  exactly like one where every slot was set. The screenshot proves nothing
  either way, which is why it was sent. There are four states now: 💎 yours and
  premium · 🔹 built-in premium · ✅ your plain emoji · ▫️ built-in default. A
  test asserts the two premium marks can never collapse back into one.
- **The board republishes on a 5-minute interval and nothing could hurry it.**
  So "saved" and "live" were separated by up to five minutes of silence, and a
  setting that never took, a slow interval and a premium account Telegram was
  refusing were indistinguishable for that whole window. **🔄 Refresh board now**
  publishes immediately — and REPORTS, in the chat:
  - `✅ Published with your premium emoji — 14 custom emoji went out animated`
  - `⚠️ Published, but PLAIN — the premium account is not connected` (or the
    verbatim `EMOJI_INVALID` Telegram answered with), plus *"your saved emoji
    are fine; the problem is the transport"* and a tap to 💎 Premium status.
  A plain publish must never render as a ✅: in the channel the two are
  identical to anyone without Telegram Premium, which is most people looking.
- **It is a JOB, not a post.** Only the main process owns the board message and
  the GramJS session, so the refresh rides the existing `forcepost/store` +
  `forcePostRunner` channel (`board_refresh`, `noRow`). It is **hidden from the
  Force-post menu**, whose every other entry publishes something new — a confirm
  screen reading *"Real, public post — subscribers will see it"* would be false
  for an edit of the board that is already pinned.
- `trendingPoster.runOnce()` returns `{how, transport, mode, premium, why}`
  rather than nothing. The log line already said this; a value nobody can read
  from Telegram is the same as no line at all.

```bash
cd bot && node scripts/run-tests.js test/adminBoard.test.js test/trendingPremium.test.js test/forcePost.test.js   # 35 tests
```

**Config a fix depends on:** nothing in this repo — but the emoji only ANIMATE
through the GramJS premium account (`node scripts/gramjs-login.js`, and that
account must actually have Telegram Premium). 💎 Premium status names which of
those is missing.

## The per-chain trending target is a RANGE, rolled

"min 5 max 8 harus random per chain". One fixed `perChain: 5` made every chain
publish exactly the same count for ever — five rows, five rows, five rows —
which reads as a generated list rather than a board.

- **The FLOOR triggers a top-up; the TARGET for that top-up is rolled** in
  [`perChainMin`, `perChainMax`]. A chain at or above the floor is left alone.
- ⚠️ **Re-rolling on every cycle regardless would converge on the maximum.**
  Nothing ever takes a slot away — only expiry lowers a count — so a chain would
  ratchet up to the highest number it ever rolled and stay there, and the
  randomness would be gone within a day. Leaving a chain alone above the floor
  is what keeps two chains on one board sitting at different counts.
- **A stored `perChain` becomes the FLOOR**, never dropped: a stored value beats
  a shipped default, and an operator who set 3 deliberately must not wake up to
  8. The ceiling then defaults to the shipped 8, or to the floor if that is
  higher.
- ⚠️ **`Number(null)` is 0, and 0 is FINITE**, so `clampInt(null, 0, 20, 5)`
  answers 0 rather than 5 — a fresh install came out with a per-chain floor of
  zero, i.e. a board that never fills itself, and nothing errored. The absent
  case is `undefined`. Third time this repo has been bitten by a falsy-but-valid
  number (`Number('')` in the launchpad env reader, `NaN` in `clampNum`).
- **An inverted range (max < min) resolves to the floor**, because the floor is
  the number set to keep the board from looking empty.
- **Every count on the panel is printed against the RANGE** (`7/5–8`), or a
  chain sitting at 7 reads as over target; a pinned range (min = max) prints as
  one number.
- ⚠️ **The MINIMUM outranks `minGainPct`.** With `min +5% 24h` on a flat market,
  Ethereum published 3 rows and Base 2 against a floor of 5: every spare listing
  on those chains was down a percent or two, so nothing was promoted and the
  board just stayed short. The tell was that ⚡ Run now filled it instantly —
  that path ignores the floor. So the gain floor now governs the DISCRETIONARY
  part only (minimum → rolled target); up to the minimum the best available go
  on regardless. `ranked` is sorted by 24h change, so "regardless" still means
  the least-bad ones.
- **…but not at any price.** `FLOOR_FILL_MAX_DROP` (15%) keeps the incident that
  produced the gain floor impossible — the board once carried a token at
  −99.94% on a $1,648 cap. Filling a slot with something in free-fall is worse
  than a short board, which is the one direction this trade-off does not go.
  Unpriced tokens stay exempt, or Robinhood would never fill at all.

```bash
cd bot && node scripts/run-tests.js test/autoTrend.test.js test/autoTrendPanel.test.js   # 53 tests
```

## A board that could only ever be as full as the chain was listed

`ETHEREUM - Trending` published three rows and `BASE - Trending` two, against a
per-chain target of five, reported as *"trending base dan ethereum sangat sedikit
tidak sesuai minimum yang di set"*.

**Nothing was broken.** Auto-trend promotes what is LISTED on a chain, and those
two chains had three and two listings in total. It even said so, every cycle:

```
[autotrend] board below target on ethereum (needs 2, none eligible), base (needs 3, none eligible)
            — list more tokens on those chains, or lower the per-chain target
```

…to an operator who cannot list a token from Telegram. **A diagnosis with no
hands attached is a bug report the code files against its owner**, and it had
been doing it for weeks.

- **`trendFill.fillChain(chain, need)` is the bridge**, and it runs only where
  the promotion pass gave up: the shortfall is now DATA (`gaps`), not only a
  sentence inside `short`. It lists exactly the gap, capped at
  `fillMaxPerCycle` (3) per chain per cycle.
- **`bigCoins.topByMcap()` is the source, and it is deliberately not the
  auto-lister's feed.** That one hunts projects crossing ~$1M for the first time
  and refuses anything over `maxMcapHard` — by design it can never surface PEPE
  or BRETT. Filling a board asks the opposite question, so this ranks the
  chain's biggest tokens instead. Same GT client as everything else
  (`group/gtPairs`, background priority, one shared 429 cooldown): a second
  client would have its own idea of the quota and the buy bot would pay for it.
- ⚠️ **The deepest pool on a chain is usually the MONEY, not a project.** GT
  ranks pools, so the top of any chain is WETH, USDC, wstETH, cbBTC. A board
  whose Ethereum section reads `WETH · USDC · USDT` is worse than one with three
  rows, so `NOT_A_PROJECT` filters them by symbol plus a name prefix for the
  wrapper families (`Wrapped…`, `Staked…`). No substring match on "USD" — that
  would eat every stablecoin-themed memecoin there is.
- **One token, many pools → judged by its DEEPEST.** A real token seen through a
  thin pool reads as illiquid and gets filtered out.
- **`ok:false` and an empty list are different facts.** A 429 must not read as
  "this chain has no big tokens", or the board stays short and the log says
  nothing — the `pumpfunNewX` rule, one service over. `fillChain` reports which
  it was, and "every big token here is already listed" is a third answer again.
- **`autoLister.createFromInfo()` is the one owner of "turn a priced token into
  a listing".** The scan loop owns the discovery BUDGET (per-run, per-day, the
  package rotation, the cooldown memo); the filler has a completely different
  reason to list something and must not grow a second idea of what an auto
  listing is. Both write `everListed`, so a token listed once and deleted never
  comes back free through either door.
- **It lists with the `trending` package**, so the chain that was short is full
  on the same pass — anything else leaves the board short for another cycle, up
  to two hours, which is the state being fixed.
- ⚠️ **`fillMaxPerCycle` is a SPEED, not a cap on the board**, and the very first
  question it drew was *"jadi maksud anda max 3 project per chain?"* — because
  the button read `🧲 max 3/chain`. The board holds `perChain` (🎯); this is only
  how fast a gap closes. The label carries the unit now (`🧲 3/chain/cycle`) and
  the panel does the arithmetic out loud — *"a chain that is 5 short reaches it
  in 2 cycles, about 20–240 min"* — rather than leaving the reader to work out
  which of the two numbers governs what.
- 🧲 **Fill from market is a visible toggle on the Auto Trending panel**, with
  the big-coin floor (`fillMinMcap`, $5M) and the per-cycle rate beside it.
  Turning it OFF is a `show_alert`, because it means a chain with no spare
  listings goes back to publishing a short board silently.
- ⚠️ **A boolean that `set()` does not persist is a toggle that reverts.**
  `fillFromMarket` reached `get()`'s normaliser but not the write list at first,
  so the panel reported ON and the loop kept the old value — caught by the panel
  test, and the same shape as every other setting-that-never-arrived in this
  file.
- ⚠️ **A persisted setting LEAKS BETWEEN TESTS.** One test turning the toggle
  off left every later test reading a panel that said "cannot be filled", which
  looks exactly like a regression in the code under test. The panel helper now
  states it explicitly instead of inheriting it.
- ⚠️ **ONLY a listing shortage may ask for a fill — never the gain floor.** The
  board goes short for two unrelated reasons: the chain has nothing left to
  promote (→ list something), or it has plenty and they are all DOWN (→ the
  `minGainPct` floor working as designed). The first cut fed both to the filler,
  so with `min +5% 24h` set, every chain looks short on any red day and the bot
  would list `fillMaxPerCycle` fresh tokens per chain per cycle, all day, while
  the tokens already listed there sat unused for being down 2%. The gain floor
  and the filler would be fighting each other — and the filler wins, because its
  listings book their slot directly. Found by reading the operator's settings
  screenshot, not by a failing test; `trendFill.test.js` pins it now.

```bash
cd bot && node scripts/run-tests.js test/trendFill.test.js test/autoTrendPanel.test.js   # 25 tests, no network
```

**Config a fix depends on:** nothing — but the filler only runs on chains
GeckoTerminal has a network id for, and it publishes real listings on the site,
so an operator who wants the old behaviour turns 🧲 Fill from market off.

## "Bagaimana agar masalah ini tidak terjadi lagi? Trending minimal harus 5"

Asked after the third report of one symptom — a chain publishing fewer rows than
the operator's minimum — with a different cause underneath each time:

| round | cause | fix |
| --- | --- | --- |
| 1 | the chain had no listings left to promote | the market filler |
| 2 | the filler fired on a red day and would have listed dozens | gate it on listing scarcity |
| 3 | `min +5% 24h` refused every spare, so the board sat under the floor | the minimum outranks the gain floor |

Three fixes, and in all three **the operator was the detector**: they counted
rows in the channel and asked. Nothing in the bot ever said *"Ethereum has been
under 5 for two hours"* — the closest thing was one advisory line at noise level
aimed at somebody reading pm2 logs.

So a fourth cause will turn up, and what is watched now is the **SYMPTOM**, not
the causes: the promise the operator set is that every configured chain carries
at least `perChainMin`.

- **`trendingWatch.js` is the state machine** and it is PURE — the cycle hands it
  a per-chain snapshot, it returns the alerts to send. A test can walk a board
  through days of cycles in milliseconds.
- **Alert on the TRANSITION, after a grace period** (`TREND_SHORT_GRACE_MS`,
  45 min). A chain short for one cycle while a slot rolls over is not an
  incident, and an alert every cycle is a channel nobody reads by the second
  hour — `upstreams.js` had to learn the same thing.
- **A RECOVERY is an alert too**, or a fixed board and a forgotten one look
  identical. A chain that recovers before anyone was told says nothing at all.
- **It repeats** (`TREND_SHORT_REPEAT_MS`, 12h) while the chain stays short: one
  message on day one is scrolled past by day three.
- **The message names WHICH of the causes it is** — spare listings that cannot be
  promoted, a fill that failed with the filler's own reason, or no listings at
  all with the switch that fixes it. "Short" alone sends the reader back into the
  same three-round investigation.
- **`trending:check` asks the same question on demand**, per chain, and exits
  non-zero — because "wait up to two hours for the next cycle and read pm2" is
  not an answer to somebody looking at a short board right now. It prints the
  build stamp for the same reason `fonts:check` does.

```bash
cd bot && npm run trending:check    # per chain: featured / minimum / spares / why
```

**Config a fix depends on:** nothing. `TREND_SHORT_GRACE_MS` and
`TREND_SHORT_REPEAT_MS` exist for an operator who finds 45 min too twitchy.

### The sixth cause: a market read that FAILED read as a token with no market

"free trending tidak begitu bekerja, tidak sesuai dengan minimum yang sudah di
set" (2026-08-28), with the panel showing `Solana 3/5–8 · BSC 1/5–8 ·
Ethereum 1 · Base 1 · Robinhood 1 · Tron 3/5–8` and the pinned board matching
it row for row. Every configured chain under the floor — and the board carrying
$WIF, $FLOKI, $PEPE, $TOSHI, $BTT, which is the market filler's own work. So
nothing was idle; everything was simply stopping at one or three.

**It was one `catch {}` in `byGain`.** A market read that FAILED — a shared 429
from GeckoTerminal, a timeout, a `fetchMarket` that answers `null` because
neither reader could be reached — left `_change`, `_mcap` and `_vol24` null,
which is byte-identical to an indexer ANSWERING that the token has no data.
Three rules downstream then act on that null:

- `hasReading` refuses the row — right, a blank row may not be published, but
  for a reason that is not about the token;
- `rowRefusal` reads the null cap as failing the free-trending floors, because
  a floor is a CLAIM and a token with no cap cannot be shown to satisfy it;
- so the chain's shortfall is attributed to the FLOORS, and the INFO line
  accuses the operator's own listings of being too small.

**The board therefore publishes only as many rows as the read happened to
answer for.** GT's free tier is ~30 req/min counted PER IP and this box shares
it with the website's charts, so a cycle losing most of its reads is ordinary
here — which is the whole distance between a board that fills and one stuck at
1. And it is the same collapse the free-listing feed had just been fixed for
(`fetchTokenInfoX`), one service over, on the pass that decides what goes on a
public board.

- **`_unread` is the fact, and `looked()` is the one reader.** A row we could
  not price is still REFUSED — publishing it is how a blank reaches the board —
  but it is no longer COUNTED as having failed a floor nobody could read it
  against. The unprobed tail past `PROBE_CAP` already had this distinction
  (`_change === undefined`); a read that was attempted and failed did not.
- **Its own counter, its own sentence, its own log line at INFO.** "GT is rate
  limited" sends an operator to a key; "below the floors" sends them to a
  setting. Until now the first was reported as the second.
- ⚠️ **The watch branch is NARROW: only where the read failed for EVERY spare**
  is the upstream the answer. Two unread out of twelve is a quota blip, and the
  chain's real problem is whatever refused the other ten — the same narrowness
  `hasMarket` and `hasReading` already state about their own exemptions.
- ⚠️ **`log.debug` on a fill that could not happen.** The line above it —
  a fill that SUCCEEDED — is INFO, so a working filler logged and a failing one
  did not. Production does not print debug, so the one line explaining a
  permanently short board went to nobody. This file has now had to fix that
  exact asymmetry in three services.
- `trending:check --floors` prints `N could not be priced` beside the floor
  count, measured with the bot's own annotation rather than a second copy of
  the question.

Mutation-tested: restoring the old `looked()`, dropping `_unread`, and removing
the watch branch each fail between one and three tests.

```bash
cd bot && node scripts/run-tests.js test/trendUnpriced.test.js   # 8 tests, no network
cd bot && npm run trending:check -- --floors                     # per chain: refused vs unreadable
```

#### "kenapa tidak pakai dexscreener??" — because this pass never asked it

The right question, asked straight after. A PRICE has two free sources and only
a CANDLE has one, and the trending promoter was spending the scarce one on the
plentiful question: `byGain` priced up to `PROBE_CAP` candidates on EVERY
configured chain, every cycle — six chains is up to 150 reads — **GT-first**,
into a ~30 req/min ceiling counted per IP that this box already shares with the
website's charts. Every read it lost was a row that did not reach the board.

- **`fetchMarket` takes a `need` list now.** The cheap path used to return the
  moment DexScreener had a price and a cap — correct for `fetchPrice`, whose
  callers read exactly those two and throw the rest away. ⚠️ **Turning the
  promoter cheap without this would have made the board SHORTER, not cheaper**:
  it would have received records with no `change24h`, which that pass reads as
  "this token has no reading" and refuses — the fix producing a worse version of
  the bug it fixes. The caller names its fields; DexScreener answers only with
  all of them, otherwise this falls through to GT exactly as before and the
  DexScreener answer is reused rather than re-asked.
- ⚠️ **0 IS A READING for a volume or a 24h change** and is not one for a price
  or a cap, so the two groups are tested differently. One truthiness check would
  send every quiet pool to GT — the exact quota the change exists to save.
- **The market filler gained the same second source.** `bigCoins.topByMcap`
  (GeckoTerminal) falls back to `dsBigCoins.topByMcap`, which asks DexScreener
  the same question and already returned the same `{ok, why, items}` shape. GT
  stays FIRST — it ranks by pool depth across a whole network, the better answer
  when it is available — and DexScreener is asked only when GT **could not be**,
  never when GT answered with nothing: that is a fact about the chain, not about
  us. Both reasons are kept, or "GT was rate-limited" would be replaced by
  whatever the fallback then said.
- Mutation-tested: dropping `need`, restoring the GT-first promoter, and
  removing the filler's fallback each fail a test.

**Config a fix depends on:** nothing in this repo — but ⚠️ **`GECKOTERMINAL_API_KEY`
in `bot/.env` is the only thing that raises the shared ceiling rather than
dividing it**, and this is the seventh place in this file that sentence appears.
What changed is that the board now says so instead of blaming the operator's
tokens, and that the trending pass no longer spends that ceiling on a question
DexScreener answers for free. The key is still what buys headroom — candles
(`/api/ohlcv`) have no second source at all.

### A row with a market cap and no percentage

"ADA BEBERAPA TOKEN TIDAK ADA PERSENAN TOKENYA WHY?" — on the pinned board,
`$MOONCOIN | 9,265,672$` with no percentage, and `$BINGBONG` with neither.

Blank is deliberate and stays: **an unreadable change is not a 0%**, and a fake
zero on a board 10,593 people read is a claim nobody measured. What was wrong is
that the reading was given up on too early, in two places:

- **The change came from the DEEPEST pool and nowhere else.** GT sends
  `price_change_percentage.h24: null` for a pool that has not traded in the
  window — a different fact from the pool not existing — so a token whose main
  pool was quiet lost its percentage even when a sibling pool of the same token
  had a good one. `changeFromPools()` borrows it from the deepest sibling that
  HAS one, above `CHANGE_POOL_MIN_SHARE` (a tenth of the deepest pool's
  liquidity). Price, cap and liquidity still come from the deepest pool alone —
  only the CHANGE falls back, and never to a dust pool, because a four-figure
  percentage off a $20k pool is the thing `deepestPool` exists to refuse.
- **`fetchMarket` skipped DexScreener whenever GT had price+cap+liquidity**, and
  `change24h` was not part of that test — so a GT answer with no reading ended
  the lookup even where a second source had one. It counts as part of
  "everything" now. It costs nothing where it cannot help: DexScreener does not
  index the GT-primary chains, so `fetchDS` returns before making a request.

**And the check's first run named a third state, which was a real defect.**
`$BINGBONG` and `$BISKIT` came back *"no market anywhere"* — no GT pool, no DS
pair — so they were on a pinned public board as bare tickers with no percentage
AND no market cap. Nothing could ever have printed there.

- **"No 24h reading" and "no market at all" are different facts**, and the board
  renders them identically. `byGain` records `_priced` alongside `_change` so
  the promoter can tell them apart.
- ⚠️ **The unpriced exemption is narrower than it looks.** Its stated reason is
  that a chain no indexer covers would never fill — so it belongs to a token
  whose READING is missing, not to one with no market. A token with no price is
  now only promoted where **nothing else on that chain is priced either**, which
  is exactly the case the exemption was written for. Both doors honour it: the
  gain-floor pass and the floor fill.
- A priced token down 8% still beats an unpriced one: a real market at a bad
  number is a trending row, and a bare ticker is decoration.

**The board may not explain itself** — an operator diagnostic on a public
channel post is chrome. So the answer is a flag on the check, and it is
MEASURED with the very call the board makes rather than reasoned about:

```bash
cd bot && npm run trending:check -- --rows
```

It separates the facts the board renders identically: *no market anywhere* (no
GT pool, no DS pair) versus *a cap with no 24h reading*. ⚠️ And the second one
does not GUESS between its two causes — the first cut of that line offered the
operator *"its pools have not traded, or the reading was absurd and refused"*,
which are different problems the code knows the difference between.
`changeWhy` records which, including the percentage it refused. It is behind a
flag because it prices every featured row at GT's politeness pace — most of a
minute for a full board.

### …and it was reported again, so the blank itself was the defect

Same screenshot, one round later: `$MOONCOIN | 12,220,809$`, `$RLUSD |
53,093,333$` and a bare `$BISKIT` — *"beberapa token di trending channel mengapa
tidak ada kenaikan atau penurunan %, trending token harus memilikinya"*.

The rule above still holds and is not weakened anywhere below: **an unreadable
change is not a 0%**, and nothing here prints one. What was wrong is that
*honest* and *invisible* are different things — dropping the segment left a row
that reads as broken to 10,593 people, and the recovery had stopped one source
short of where it could go. Four layers, and each closes a hole the others
cannot:

| layer | stops |
| --- | --- |
| `changeFromCandles` in `marketdata.js` | a readable market publishing nothing |
| `hasReading` in `autoTrend.js` | the bot booking a slot for a token with no reading |
| the same rule in `trendFill.js` | the filler *listing* one into that slot |
| `NO_READING` in `trendingPoster.js` | a row that says nothing at all |

- **The change is MEASURED from the pool's own candles when nothing publishes
  one.** A 24h change *is* "the price now against the price 24 hours ago", and
  two real closes from GT's OHLCV is that number taken the long way — a
  measurement, not the fabricated zero this board has always refused. It is the
  last resort: only a token that would otherwise publish a blank pays for the
  request.
- **Most of the leftovers were ROBINHOOD, and that is the whole tell.**
  DexScreener does not index it (`GT_PRIMARY` in `group/gtPairs`), so GT's `h24`
  is the *only* reading in the entire fallback chain — sibling pools and the
  DexScreener pass, the two fixes from the round above, have nothing to work
  with there. A fallback chain reads more reassuring than it is; that lesson is
  already in this file under the raid's two keyless sources.
- **The two closes are picked by TIMESTAMP, never by position.** A sparse pool's
  candles do not line up on 24 neat hours. ⚠️ And a pool that has not traded at
  all in the window resolves BOTH ends to the same candle and measures
  **0.00%** — which is the truth about it, *arrived at* rather than assumed.
  That is the entire difference between this and the printed zero the rule
  forbids.
- ⚠️ **The candles are asked for OUR token, not the pool's base side.** GT's
  OHLCV defaults to `base`, which is our token only by luck — in a
  WETH/OURTOKEN pool it is WETH, and the board would have published Ethereum's
  24h change under a memecoin's ticker. That is a *wrong* number rather than a
  missing one, which is the worse of the two. The token address is named.
- ⚠️ **A pool younger than a day stays unmeasurable.** Measuring from its
  opening tick is exactly where `+521366%` came from, so no candle before the
  boundary means no reading — the sanity bound applies to a computed change as
  it does to a published one.
- ⚠️ **Only a DEFINITIVE answer is cached.** "GT is rate limited" is not a fact
  about the pool, and caching it would let a two-minute backoff blank the board
  for ten. A miss that *is* about the pool (under 24h of history) is cached, or
  every unreadable token buys a request on every cycle of nine background
  pipelines.
- **A slot the bot books ITSELF must carry a reading**, through both doors —
  the promoter's gain-floor pass and its floor fill, and the market filler,
  which books its slot directly and would otherwise make the rule decorative
  (the free-fall bound learnt this one field over). The exemption is the one
  `hasMarket` already makes and is exactly as narrow: only where **nothing** on
  the chain has a reading do the unreadable go on, or a chain no indexer covers
  would never fill.
- **The percentage column is never left EMPTY.** It carries `—` with a legend,
  printed only when a row needs it — the same conditional as the 🌩 mark beside
  it. Everything above exists so that the only row which can still reach it is a
  slot somebody **paid** for, which is never dropped: a customer who bought
  trending gets their row.
- ⚠️ **`trendingPoster` destructured `fetchMarket`**, so no test could pin what
  the board renders for a missing reading — the exact defect being fixed. It
  imports the module now, the rule `autoTrend.js` already states at its own
  require.

#### "bagaimana agar masalah ini tidak terjadi" — the operator was the detector, again

Asked straight after the fix landed, and it is the right question: this is the
**third** time a row on this board has been reported for having no percentage,
and all three times it was reported by a person reading the pinned channel and
counting. Nothing in the bot has ever said *"three rows went out as — this
cycle"*. That is the same shape, on the same surface, as the three-round
"trending minimal harus 5" saga one section up — and the answer there is the
answer here: **watch the SYMPTOM, because the causes keep changing.**

The promise is "every row on the board carries a percentage", and it is now
watched by the same machinery that watches "every chain carries `perChainMin`":

- **`trendingWatch.evaluateRows()` sits beside `evaluate()`, in the SAME
  module.** Two copies of "is the board healthy" would eventually disagree,
  which is what two pump.fun hosts in two processes already cost. It is PURE —
  the poster hands it the render, it returns the alerts — so a test walks the
  board through days of cycles in milliseconds.
- **The poster MEASURES what it drew**, at the moment it draws it. `noReadCount`
  was computed in `buildText` and thrown away; `lastRender()` is
  `{at, rows, blank:[{chain,sym,why}]}` now. A value nobody can read is the same
  as no value — the gainers banner measured its candidate `pool`, returned it,
  printed it nowhere, and a collapsed ranking looked entirely normal.
- ⚠️ **The watch runs BEFORE the `unchanged` early return.** The board is edited
  in place and skipped when the text has not changed, which is exactly the state
  a persistently blank board sits in — folding the watch in after that return
  would freeze it on the boards that stay broken longest. A stuck symptom
  reading as no symptom is the state that looks most like a healthy one, and
  this file has paid for that one twice (`lastFeedOkAt`, `lastCheckedAt`).
- **Transition only, after `TREND_SHORT_GRACE_MS`; a RECOVERY is an alert too;
  it repeats.** A row can go blank for one cycle while a pool rolls over, and an
  alert every cycle is a channel nobody reads by the second hour. The rules are
  `upstreams.js`'s, borrowed a third time.
- **The alert names the TOKENS and the recorded reason**, capped at six. "Some
  rows have no percentage" sends the reader back into the same investigation;
  `changeWhy` already knows whether the pool is quiet, is younger than a day, or
  does not exist — three different answers.
- ⚠️ **`trending:check --rows` now DRIVES `buildText()`** and reads
  `lastRender()`, instead of calling `fetchMarket` itself. That second copy of
  the board's question is precisely how `fonts:check` printed nine green ticks
  over a banner publishing boxes: a guard is only honest while it measures the
  stack the renderer actually uses. It **exits non-zero** on a board of dashes,
  so green means "the board is safe" and not "the counts add up" — and a render
  that produces NO rows is an error, never a quiet ✓.

So the layers, each closing a hole the others cannot:

| layer | stops |
| --- | --- |
| the candle recovery + the two promotion gates | a readable market publishing nothing |
| `NO_READING` in the poster | a blank that is honest and *invisible* |
| `boardPercent.test.js` drives the real renderers | the column drifting back to a dropped segment |
| `evaluateRows` in the running bot | the operator being the detector |
| `trending:check --rows` + the build stamp | a green check over a board full of dashes |

```bash
cd bot && node scripts/run-tests.js test/boardPercent.test.js test/trendFill.test.js   # 50 tests, no network
cd bot && npm run trending:check -- --rows                                             # which rows show — and why
```

**Config a fix depends on:** nothing. `GECKOTERMINAL_API_KEY` raises the shared
GT quota the candle read draws on, as it does for everything else in this repo;
`TREND_SHORT_GRACE_MS` / `TREND_SHORT_REPEAT_MS` govern this watch too.

### ⚡ Run now "not work" — the answer expires, the panel does not

"di klik fiturnya not work". The button spun and nothing came back, on a panel
where every other button responds instantly.

Nothing was wrong with the promotion. `byGain` prices up to **25 candidates
serially**, with a 250 ms gap and an 8 s timeout each — that is ~6 s of sleeping
before a single lookup, and on a chain with dozens of spares (Robinhood had 44)
it runs well past Telegram's **~15 s callback deadline**. `answerCbQuery` then
fails with *"query is too old"*, the `.catch` swallows it, and the operator is
told nothing at all — while the promotion may well have succeeded.

- **A callback answer is the one channel with a DEADLINE.** So it carries the
  acknowledgement, which is bounded, and the RESULT goes on the panel, which is
  a message edit and has none. `alscan` two handlers down already did exactly
  this; `atrun` was the one that did not.
- ⚠️ **A previous round deleted the early "working…" toast** on the rule that
  only the FIRST `answerCbQuery` counts. The rule is true and the conclusion was
  backwards: the fix is to move the RESULT off the answer, not to move the
  acknowledgement later. Both bugs report identically from Telegram — "the
  button does nothing" — which is how the second one was shipped as a fix for
  the first.
- **A slow button invites a second tap**, which would book two slots for one
  request. `atRunBusy` answers the second with "a run is already going".
- **`atref` had the same shape**, one `getListings()` deep. Answered first now.
- The tests DRIVE the registered handler through real Telegraf updates and pin
  the ORDER — that the tap is answered while the work is still running. A source
  scan sees both calls and reads as fine; all four fail on the old handler.

```bash
cd bot && node scripts/run-tests.js test/autoTrendRunNow.test.js
```

### The fourth cause: a spare in FREE-FALL is not a spare

Predicted in the table above ("a fourth cause will turn up") and it turned up on
the first clean run of the check, 19 Aug: `Base 4/5 · 2 spare listing(s)`, and it
would have stayed there for ever.

Both spares were below −15%, so the floor fill skipped them — correct, that is
`FLOOR_FILL_MAX_DROP` doing its job. But `gap()` was gated on the chain having no
spare listings AT ALL, so the market filler was never asked either. Nothing in
the loop could move it: the promoter refuses those two on every cycle for the
same reason, and **a refusal is not a state that resolves itself**.

- **The gate is "can this chain fill the minimum from its OWN listings?"** — and
  a token this pass may never promote cannot. `gap()` is now also raised when
  the floor fill comes up short, for the FLOOR shortfall only. Above the minimum
  `minGainPct` still decides, which is what keeps the red-day listing spree
  (round 2) impossible.
- ⚠️ **The free-fall bound governs BOTH DOORS onto the board.** The filler had no
  such bound, so it would have listed a big-cap down 40% into the slot the
  promoter had just refused a token down 20% for — the rule made decorative by
  the code meant to help it. `autoTrend.FLOOR_FILL_MAX_DROP` is the one owner and
  is passed into `fillChain`; a chain where every big-cap is falling now says so
  rather than reading as "already listed".
- **An unreadable 24h change is not a fall**, on either door. Robinhood has no
  indexer, and judging it by a number nobody can read means never filling it.
- **The filler's own reason outranks the spare COUNT in `diagnose()`.** A chain
  can have both — unusable spares and a fill that then failed — and answering
  "2 spare listings here" over the top of "GT is rate-limited" sends the operator
  off to list tokens by hand for something that clears itself in ten minutes.

### …and its first live run accused the server of its own bug

```
✗ could not read the listings API: INTERNAL_API_TOKEN is not set
```

On a box where it IS set — the bot was listing and trending normally at the
time. `main.js` loads the env before requiring anything, and a standalone script
gets none of that: `config/constants.js` freezes every value at require time, so
the script read an empty environment and reported it as a fact about the server.
**A diagnostic that reads a different configuration from the bot's is a
diagnostic about nothing**, and the failure it invents points the operator at
their own `.env`.

- **`src/config/loadEnv.js` is the one owner**, and it already existed. Nine
  scripts carried four different spellings of the same intent —
  `require("dotenv").config()`, `{ path: bot/.env }`, `{ override: true }`, and
  one `require(".../loadEnv")` with **no call**, which loads nothing and reads
  exactly like it does. So which `.env` counted depended on which script you
  ran, and three of the four never looked at the repo root at all. All of them
  go through `loadEnv()` now.
- ⚠️ **ORDER is the rule, not presence** — and the first cut of the guard test
  got this wrong in the way that matters: it matched `loadEnv()` anywhere in the
  file, and `trending-check.js` has a second, lazy call inside its error path.
  Deleting the real call at the top left the guard GREEN. The assertion compares
  the call's position against the first repo `require`.
- **The failure names the files it READ.** "not set" over a list containing
  `bot/.env` is a missing line in that file; "not set" over an empty list is a
  script that read no `.env` at all. One line separates the two, and it is the
  whole diagnosis.
- `smoke.js` is the one exemption and it is ASSERTED, not declared: it
  fabricates its own tokens so `npm run check` behaves identically on a laptop
  and on the server, and `loadEnv`'s `override:true` would undo that. The test
  fails if it stops setting them.

```bash
cd bot && node scripts/run-tests.js test/loadEnv.test.js
```

### The fifth cause was the opposite one: the board was full of nothing

"untuk free trending mohon di filter agar high mc dan vol yang rame yang
ditrendingkan, bukan kaya vol bahkan ga ada $10 di trendingin", with a screenshot
of the board:

```
$MRNA   +465.0%   MCAP $157.7K   VOL $0.05   10 txns
$GOOGL  +164.0%   MCAP  $66.4K   VOL $0.04    8 txns
```

Every round above was the board being SHORT. This one is the board being full of
tokens that traded five cents in a day, promoted for free over real markets —
and **ranking could never have prevented it**. `byGain` sorts by 24h change, and
a percentage off an empty book is the biggest one there is: the same defect
`minGainPct` was written for at the other end of the scale (a token down 99.94%
on a $1,648 cap), and with five slots and five junk candidates sorting still
promotes junk.

- **`autoTrend.floorRefusal` is the ONE owner** of "is this big enough and busy
  enough for a free slot", and it takes plain `{mcap, vol24}` rather than a row —
  the promoter annotates `_mcap`/`_vol24` onto a LISTING and the filler reads
  `mcap`/`vol24` off a MARKET candidate, and a predicate that knew one shape
  would have forced the other door to write its own.
- **They are QUALITY floors, not discretionary ones.** `minGainPct` deliberately
  governs only the target ABOVE `perChainMin`, because a short board is worse
  than a flat token. These bind every free slot the bot books: the gain-floor
  pass, the FLOOR FILL (the pass whose whole job is to overrule a floor, and
  therefore exactly the pass that would delete these silently on the chains that
  are short — the free-fall bound has this scar), `trendFill` (whose listings
  book their slot at CREATION), and the query itself.
- ⚠️ **⚡ Run now is bound TOO, and that is the one place this differs from
  every other rule here.** A forced run bypasses the gain floor and the
  free-fall bound on purpose — those govern how DISCRETIONARY the bot is being,
  and the operator has decided. These are the standing answer to what may go on
  the board at all, and a button that quietly published `VOL $0.05` would
  reproduce the report from the one path an operator uses *while they are
  watching*. The refusal names both floors and the tokens.
- ⚠️ **NO "nothing on this chain qualifies" EXEMPTION**, unlike `hasMarket` and
  `hasReading`. Those fall open because a chain no indexer covers would never
  fill. These must not: the market filler exists for a chain that cannot fill
  from its own listings, so refusing ROUTES rather than strands — and an
  exemption would put the reported board straight back on a chain of dead
  tokens, which is the chain that produces one. The floor shortfall raises
  `gap()`, so the filler is asked.
- **An UNREADABLE value is refused; a measured ZERO is refused for a different
  reason.** A floor is a CLAIM ("cap ≥ $100K"), and a token whose cap nobody
  publishes cannot be shown to satisfy it — the gainers `minMcapUsd` rule. A
  volume of exactly 0 is a READING, and it is the one being filtered.
- ⚠️ **`fetchMarket` carried no volume at all.** Both readers had
  `volume_usd.h24` / `volume.h24` in scope and discarded them. `vnum` publishes
  it from the DEEPEST pool — never summed across pools, which would inflate the
  one number the floor judges a token by — and it needed its own reader because
  `num()` answers null for 0.
- **`trendingWatch` gained a `below_floors` cause.** `spares_unusable` asserts
  "they are below −15%", and with the floors on that is now usually the wrong
  sentence — it sends the operator to look at a percentage when the answer is a
  $0.05 volume. The filler's `why` ladder reports the DOMINANT counter, not the
  first one written down: every branch says "every", and with three mutually
  exclusive counters that is only true of the one accounting for all of them.
- **The panel rows are TYPED, not stepped.** A cap floor moves in millions and a
  volume floor in thousands, so one step size fits neither: at ±$1M a $10K
  volume floor is unreachable, and at ±$10K a $5M cap floor is five hundred
  taps. `0` reads as **OFF** everywhere — `$0` on a row labelled "min cap" says
  the opposite of what it means.
- **The legacy tests state `minMcapUsd: 0, minVol24hUsd: 0` out loud** rather
  than inheriting it — the rule the pace tests had to learn.

**And the SITE had the same defect with its own cause.** The home board opens
sorted by 24h % and the only bound was `SANE_CHANGE_PCT`, so +465% on five cents
was a legal reading and led the board. `changeRank` = `changeReading` plus
`tradedEnough`.

- **It DEMOTES, it never hides.** These boards carry paying customers; a listing
  that vanished because its pool was quiet today is a refund conversation. The
  row keeps its real percentage in its own column.
- ⚠️ **…but `movers` EXCLUDES instead**, because `-Infinity` is less than zero
  and a demoted row fed to a "Top Losers" filter would be CROWNED by it — the
  fix producing a worse version of the bug it fixes, on the surface next door.
- ⚠️ **AND AN UNRANKABLE ROW HAS TO SINK IN BOTH DIRECTIONS.** One tap on the
  24H % header flips the sort ascending, and `-Infinity` leads it — the same bug
  again, on the full board, reachable with one click. It was already true of an
  unreadable change before any of this; the volume floor only widened the set
  that hits it. The comparator pushes an unrankable value last whichever way the
  board is sorted.
- **An unreadable VOLUME is not a small one** — that exemption fails OPEN here,
  because this is a ranking rule with no operator behind it, while the bot's
  floors fail CLOSED because an operator set them.

```bash
cd bot && node scripts/run-tests.js test/trendQuality.test.js   # 19 tests, no network
cd bot && npm run trending:check                                # the floors are on the config line
cd bot && npm run trending:check -- --floors                    # …and how many spares they refuse
npm test                                                        # home / TokenBoard, site side
```

The four promotion guarantees are MUTATION-TESTED rather than argued: reaching
around the floors in the floor fill, dropping them from the promotion pass,
bypassing them on a forced run, and dropping the filler's refusal each fail
between one and four tests.

**Config a fix depends on:** nothing — but ⚠️ **the floors ship ON and that
CHANGES an existing board on deploy**, deliberately, the way the gainers
`minMcapUsd` did. Either is one tap to `0` on ⚙️ Auto-Trend.

### The sixth cause: the promoter could only ever see the same 25 listings

"saya set di admin bot auto trending min 5 max 8 tpi yang di baca channel cmn
1/2, tidak sesuai" — with the panel reading `🎯 min 5/chain · max 8/chain` and
the pinned board publishing **SOLANA 3 · BSC 1 · ROBINHOOD 2 · ETHEREUM 2 ·
BASE 2 · TRON 2**. Sixth round of one symptom, and the first where the counts
rule out every earlier cause on their own: the last `market:check` run recorded
in these notes counted **192 Solana listings** (`solana 162/192 priced`), and
Solana published three rows. A chain with that many spares is not a chain that
ran out of things to promote.

**`byGain` priced `rows.slice(0, PROBE_CAP)` — the first 25 of the eligible
list, in store order.** `addListing` PREPENDS, so that is the 25 newest spares,
and it is the SAME 25 on every cycle for ever. On a chain with five listings
that is every listing and nobody noticed for a year. On a chain with 190 it is
a 13% sample chosen by nothing at all, and if those particular rows happen to
be dead — old memecoins under the cap floor, a pool nobody traded all day — the
chain can never reach its minimum from its own listings again, however good the
tokens at position 26 are. **Measured before a line was changed**: 25 dead rows
in front of 175 excellent ones promotes ZERO, on every cycle, for ever.

- **The probe order is LEAST-RECENTLY-OPENED FIRST** (never opened = first of
  all), stamped per chain+address in `autoTrendState.json`. That is one cursor
  per chain in the only form that survives the list changing underneath it — an
  index would drift by one on every new listing, because the store prepends —
  and it buys the guarantee a prefix never could: **every listing on a chain is
  opened within `ceil(n / PROBE_CAP)` passes**, and a chain that is short keeps
  sweeping until it finds something.
- ⚠️ **The stamp is `now + i`, not a flat `now`.** Two passes inside the same
  millisecond would stamp identically, the stable sort would fall back to store
  order, and the second pass would re-open the first pass's window — the very
  prefix this replaced, reintroduced by the fix for it.
- ⚠️ **AND IT LIED ABOUT WHAT IT HAD SEEN, which is why five earlier rounds each
  had to be diagnosed from scratch.** The log line, the ops alert, the watch and
  ⚡ Run now all said *"every spare is below the free-trending floors"* — about
  200 spares of which 160 had never been opened. `rowRefusal` answers "market
  cap could not be read" for an unopened row exactly as it does for a $1K token,
  so **⚡ Run now reported `all 200 spare listing(s) on solana are below the
  free-trending floors`**: a failure rendered as a fact, on the one screen an
  operator watches while they tap, sending them to lower a floor that had
  refused nothing of the sort. Every surface now counts only rows it OPENED and
  says how many are still queued.
- **`opened` sits beside `looked`, and they are different questions.** `looked`
  is about the ANSWER (and so excludes a row the upstream refused us — the round
  above); this is about the WINDOW, and the window is what every "every spare
  is…" sentence was wrong about.
- ⚠️ **`unread >= eligible` MADE THE UPSTREAM BRANCH UNREACHABLE on exactly the
  chains it was written for.** `unread` is counted among the rows a pass opened
  and was compared against every spare on the chain: 40 opened, all 40
  unreadable, 200 spares → `40 >= 200` is false, so a total GeckoTerminal
  failure was reported as *"your tokens are below the floors"* — the round above
  undone by the window it did not know about. It compares against the WINDOW
  now.
- **`considered` reaches `trendingWatch` beside `eligible` and `unread`**, and
  it is `null` when the caller did not measure it — a chain no cycle has priced
  has no window to report, and inventing one would put "N not opened yet" on a
  line nobody measured. Same rule as `floorRefused` one field over.
- **The budget went 25 → 40, and that is a matter of SPEED, not of reach.** It
  is only safe because the read one round above is already DexScreener-first:
  a wider window paid at GeckoTerminal's price would be *"…and the bot was the
  one spending it"* reintroduced by the fix for this.
- ⚠️ **`trending:check --floors` reads the bot's window and does NOT advance
  it.** `byGain` mutates the stamps and the CALLER persists, so the check
  measures the slice the bot is about to judge rather than a prefix of its own
  — and a diagnostic that moved the rotation on would change the thing it is
  measuring, showing the operator one window while the bot opened the next.
- ⚠️ **Both fixtures that cover the tail are SIZED FROM `PROBE_CAP`, never a
  literal.** `trendQuality`'s "a token nobody PRICED is not counted" was 30 dead
  rows against a hardcoded 25 — the day the budget was raised its tail would
  have vanished and the test gone on passing while covering nothing, which is
  the vacuity it names in its own second comment. The cap is exported for that.
- **The rotation stamps LEAK BETWEEN TESTS** — they are persisted and the suite
  shares one `DATA_DIR`, so a test that leaves them behind reorders the next
  test's window. `_test.forgetProbes()` states it rather than inheriting it, the
  scar the auto-trend panel helper already carries.

The two guarantees are MUTATION-TESTED rather than argued: restoring the fixed
prefix fails the rotation test, and dropping the `looked` gate in ⚡ Run now
fails the honesty test — the latter only after its first cut was found matching
on the OLD sentence and therefore passing over the mutation it exists to catch.

#### The audit round — four of these were in the FIX

Asked straight after it landed ("kapan selesai audit anda?"), and the answer was
that four things were wrong, all of them this file's own recurring shapes:

- ⚠️ **`resetAnnounceState()` DELETED THE ROTATION AND THE WATCH CLOCK.** It
  writes a whole fresh object, so every field not named in it is dropped — and
  the operator's "start fresh" for *announcement cooldowns* was silently
  restarting the probe window at the front of every chain and resetting "how
  long has this chain been short", which serves the grace period out again and
  the alert never lands. Two fields, neither of them anything to do with
  announcing. (The probe map itself is safe under the other loss path this file
  documents — `loadJSONSync` collapsing "no file" with "unreadable file", which
  is destructive for `everListed` — because a stamp is a CACHE, not a ledger:
  losing one costs a re-read.)
- ⚠️ **`trending:check` grew its own copy of "did we open this row"**
  (`r._change !== undefined`), two lines below the comment explaining what the
  last copy of a predicate cost this exact script. `countOpened` is exported and
  is the one owner, the way `countFloorRefusals` already is.
- **Three comments still said "up to 25 candidates", one of them load-bearing.**
  The ⚡ Run now handler's note reasons from that number to "~6s of sleeping,
  well past Telegram's ~15s deadline" — the argument for answering the callback
  first — and the budget is 40 now. A literal that the code no longer produces
  is how the next reader is talked out of a rule that is still right.
- **The section above claimed `market:check` "reports" 192 Solana listings.**
  It is a reading recorded earlier in these notes, not one taken on the day —
  and presenting a stored measurement as a current one is the thing the build
  stamp on every check script exists to prevent.
- ⚠️ **AND THE GUARD WRITTEN FOR THE SECOND FINDING FAILED ON ITS OWN COMMENT.**
  The scan for a copied predicate matched the raw file, and the comment beside
  the fix QUOTES the predicate it forbids — this repo's own rule for a source
  scan, caught by the scan catching itself. It strips comments now, and asserts
  that the stripping is what makes it pass: a comment-blind scan here would be
  vacuous rather than merely noisy.

Each is pinned, and the two behavioural ones are MUTATION-TESTED: putting the
bare `saveJSON` back in `resetAnnounceState` fails the rotation-survives test,
and giving the check its own predicate back fails the one-owner test.

#### …and the FIRST LIVE RUN printed a cause nobody had measured

`npm run trending:check` on the box, straight after the deploy (`build
ca975ca`), reported Robinhood `3/5 · 63 spare listing(s)` under

> 63 spare listing(s) here, and none went on — they are below −15%, the one
> thing never auto-promoted.

…and the same sentence for a chain with 75. **The check had priced nothing.**
Without `--floors` it opens no rows at all, so it hands `diagnose`
`floorRefused: 0, unread: 0` — which mean *"we looked and found none"* to that
function and *"we never looked"* from that caller — and the branch left standing
is the one that asserts a specific cause for all of them. Six rounds of this
symptom have turned on telling causes apart, and the diagnostic was inventing
one.

- **`considered == null` is "not measured", and it now has its own answer.**
  `unmeasured` names the count it does know (63 spares, board short) and the
  flag that answers the rest, instead of picking the last branch standing. The
  bot always measures, so this can never reach the ops channel — asserted by
  driving `runOnce` and reading the snapshot it hands the watch, because an
  early `continue` added above `byGain` one day is exactly how it would.
- ⚠️ **`--floors` is no longer gated on a floor being ON.** It measures three
  things now — rows opened, rows refused, rows unreadable — and only the middle
  one is about the floors, so with both at `0` it priced nothing and every short
  chain answered *"this run did not price them"* naming the flag the operator
  had just used.
- ⚠️ **And the window may never print MORE spares than the chain has left.**
  `considered` is measured before the pass promotes anything and `eligible` is
  counted after, so a chain that filled part of its gap has the window as the
  larger number — `Math.min`, or the sentence claims spares that are on the
  board.

Both are mutation-tested: deleting the `unmeasured` branch, and letting the
window overstate the spares, each fail it.

#### …and the cause it named did not ACCOUNT for the shortfall

The `--floors` run that followed, on the same box:

```
✗ Ethereum  4/5 · 18 spare listing(s) · 10 of 18 opened are below the floors
✗ Base      3/5 · 14 spare listing(s) ·  6 of 14 opened are below the floors
✗ Tron      4/5 ·  7 spare listing(s) ·  6 of  7 opened are below the floors
```

…each under *"they are below the free-trending floors, and none went on"*. Do
the arithmetic: on Ethereum **eight** of the eighteen CLEARED the floors, on
Base **eight** of fourteen — and the board still did not fill. The named cause
could not explain the shortfall, and it is the cause an operator acts on, which
is how two rounds of this went to the wrong setting. Ethereum had also gone
5/5 → 4/5 and Robinhood 3/5 → 2/5 in ninety minutes: the board was DECAYING.

- ⚠️ **A BOOKING THE SITE REFUSED WAS LOGGED AT `debug` — AND THE SUCCESS BESIDE
  IT AT `info`.** So a promotion that worked printed a line and one that failed
  printed nothing production ever shows, on the one path that puts a row on the
  board. A site refusing every booking therefore decays the board in total
  silence: the chain reads as short, every surface blames the floors, and the
  operator is sent to change a setting that refused nothing. **This file's notes
  already say that exact asymmetry has had to be fixed in three services** — the
  promoter was the fourth, and it was found by arithmetic on a live check rather
  than by reading. It is a WARN naming the site's own reason now, it is counted,
  and it reaches the watch as its own cause: no floor fixes a site that says no,
  so it outranks the whole refusal ladder.
- ⚠️ **THE PROMOTER NEVER HAD THE REFUSAL LADDER THE FILLER ALREADY HAS.**
  `trendFill` reports the DOMINANT counter and says whether it accounts for all
  of them, precisely because "every one is in free-fall" and "every one is below
  the floors" send an operator to different places. `diagnose` returned
  `below_floors` the moment `floorRefused` was non-zero, so the first counter
  written down won. It now ranks {floors, free-fall, no-reading} — counted over
  the rows that CLEARED the floors, so they partition — and prints
  `10 of the 18` rather than claiming all of them.
- **The check prints the same breakdown**, measured with the bot's own
  predicates (`opened`, `floorRefusal`), because a check with its own idea of
  the question is how this investigation lost two rounds.

Both are mutation-tested: restoring the `debug` line, and taking the first
counter instead of the dominant one, each fail their test.

#### …and the loop had simply STOPPED, which nothing could say

The log settled it, and it was none of the above:

```
04:47:12 promoted robinhood/0x39dBED… ($PONS) for 8h
04:47:14 tron: promoting 1 below the +5% floor to reach the minimum of 5 ($SUN −0.1%)
04:47:20 board topped up from the market → solana: PEPE · tron: WIN
09:01:56 promoted tron/TXL6rJbv… ($SUNDOG) for 16h
```

…and then **nothing for nine hours**, across three restarts, while the board
decayed 5/5 → 4/5 → 2/5. When the cycle runs it works exactly as designed —
it promotes, it overrules the gain floor to reach the minimum, it fills from
the market, it announces. It had stopped running, and slots expiring need no
loop at all.

**Every failure path in this loop logged at `debug` and every success at
`info`, so the loop was only ever VISIBLE WHILE IT WORKED.** `getListings()`
throwing returns 0 from the top of `runOnce` — the whole cycle, every chain —
under one debug line; a throw out of `runOnce` was swallowed by the tick's
catch the same way. Production prints neither. So *"the loop is not running"*,
*"it ran and had nothing to do"* and *"it threw on every pass"* were one
observation: **none**. `trending:check` keeps working throughout, because it is
a different process with its own env — which is what makes the silence read as
a healthy quiet board.

- **A cycle that COMPLETES says so**, once, at info (`cycle done in 412ms — 2
  promoted`). Silence now means the loop is dead, which is the only thing an
  operator can act on. At most three lines an hour on the shipped 20–120 min
  band.
- **The heartbeat is in the scheduled `tick`, not in `runOnce`** — `runOnce`
  has three early returns and the disabled one is among the silences this
  exists to break. A guard written inside the thing it guards cannot see the
  thing not being called; the test asserts it sits in `tick`.
- **A DISABLED service says so hourly**, not every 10-minute tick: 144 lines a
  day would be noise, and no line at all would put the ambiguity straight back.
- **The aborted cycle names the API**, because a site the bot cannot read and a
  market with nothing in it produce the same empty board.

Mutation-tested: restoring the debug line on the aborted cycle, and deleting
the heartbeat, each fail their test.

⚠️ **What this does NOT do is explain why the loop stopped at 09:01.** Nothing
recorded it, which is the whole defect; the next cycle after this deploys is
the first one that can say. If the heartbeat is absent while ⚙️ Auto-Trend
reads 🟢 ON, the service is not starting and `[monitoring]` is the next place
to look.

```bash
cd bot && node scripts/run-tests.js test/autoTrend.test.js test/trendQuality.test.js test/trendingWatch.test.js
cd bot && npm run trending:check -- --floors    # N of M opened, and how many are not opened yet
```

**Config a fix depends on:** nothing. `AUTOTREND_PROBE_CAP` widens the window
per chain per pass for an operator with thousands of listings; the rotation is
what makes the size a matter of speed rather than of reach.

### The channel and the website were two answers to one question

"di website gambar ke 3 kan sudah ada trending di website nah itu aja yang d
ambil haerus sinkron … jadi channel trending token trending harus sesuai di
websitenya" — a project opens dexvra.io and `@dexvratrending` side by side and
sees two different sets of tokens. They were not out of sync by accident: they
ranked from different places.

| | what it shows |
| --- | --- |
| dexvra.io *Trending Listings* | every listing on the chain, ordered by 24h % (`byChange`) |
| `@dexvratrending` | whoever holds a BOOKED slot (paid + auto-promoted) |

- **The board is a TOP-UP, never a mirror, and that was the operator's call.**
  Asked directly, with the trade-off stated: a straight mirror would drop a
  trending slot somebody PAID for on the day their token is down — every other
  ranking surface in this repo demotes rather than hides for exactly that
  reason. So booked slots are pinned, and the site's ranking fills what is left
  up to `perChainMin`. Everything nobody bought matches the website exactly, and
  a purchase still gets its row.
- ⚠️ **THE ORDER IS READ, NEVER RECOMPUTED.** `/api/internal/board-rank` serves
  the site's own `byChange` output per chain. A copy of that rule inside the bot
  would be the FOURTH private answer to "which change may rank this" in this
  repo — and the first three are what put `$MRNA +465%` on five cents of volume
  at the top of a public board. A source scan fails the build if the poster
  grows `changeRank`/`tradedEnough` of its own.
- **The readings travel with it** (`changeReading`, `figureReading`), so a row
  the site supplied is never re-priced. Asking again would spend the shared
  GeckoTerminal ceiling to re-derive a number we were just handed — and would
  let the two surfaces print different percentages for the same token, which is
  the desync being fixed.
- ⚠️ **`live:false` NEVER REACHES THE CHANNEL.** That flag is the site saying
  these are captured-at-listing numbers rather than readings; publishing a board
  built from them is the fabricated figure this board already refuses to render,
  arrived at one layer earlier. Booked slots still publish.
- **A row with no 24h reading is never CHOSEN by us** — the rule the promoter
  and the market filler already honour. A paid slot keeps its space and renders
  `—`; a row the board picked for itself has no such claim on it.
- **A site that cannot be reached still publishes the booked slots.** A board
  that vanished is worse than one that is short, and those rows are real.
- ⚠️ **THE ROW COUNT IS ROLLED IN `[min, max]`, not pinned to the minimum.**
  "mengapa semua chain 5 5 doang kan random min 5 max 8" — the first cut filled
  every chain to `perChainMin`, so all six published exactly five rows for ever.
  That is the very defect the RANGE was added to end, reintroduced by the
  mirror: *"one fixed `perChain: 5` made every chain publish the same count for
  ever, which reads as a generated list rather than a board."*
  ⚠️ And it may NOT be re-rolled on every publish — the board is edited in place
  every few minutes, so a fresh roll each time would flicker the count
  5 → 8 → 6 under a reader. The roll is DETERMINISTIC in the chain and a time
  bucket (`TREND_TARGET_BUCKET_HOURS`, 3h): chains differ from each other at any
  moment, each holds its count for hours, and it moves on by itself. No stored
  state — the poster and the panel are different processes, and there is nothing
  to reset or to leak between them. The promoter's own `rollTarget()` is
  untouched and answers a different question: how many slots to BOOK.
- **`perChainMin` is read from ⚙️ Auto-Trend**, its one owner. A second number
  in the poster is how the panel and the channel would come to disagree about
  what the minimum is, which is the shape of all six rounds of this report.
- ⚠️ **AND THE CHAIN LIST IS A TAP NOW, not a deploy.** "saya tidak ingin chain
  ini ada di channel trending dan liat di admin bot harusnya bisa aktivkan dan
  nonaktifkan" — `cfg.chains` has always governed the board and could only be
  changed by a code default or `npm run trending:chains`, so taking POLYGON off
  a channel of 10,543 people needed a deploy. ⚙️ Auto-Trend carries a 🟢/⚪️ row
  per chain. A chain that is OFF gets **no section at all**, booked or not —
  gating only the top-up left every unwanted heading standing, because those
  rows were booked by the bot itself. ⚠️ The LAST chain cannot be switched off:
  `set()` reads an empty list as a mistake and restores the shipped six, so the
  tap would appear to work and then silently undo everything the operator had
  just removed — the toggle-that-reverts defect `fillFromMarket` already has a
  scar for.
- ⚠️ **…EXCEPT A ROW SOMEBODY BOUGHT.** A real paid tier on a switched-off chain
  publishes anyway and the ops channel is told once. A purchase disappearing
  unannounced is how a refund conversation starts, and this repo demotes rather
  than hides everywhere else. That chain is still never TOPPED UP — the
  exception lets a purchase through, it does not put the network back on the
  board with four free rows under it, which is the fix producing a worse version
  of the bug it fixes.
- ⚠️ **THE TOP-UP ONLY EVER TOUCHES THE OPERATOR'S OWN CHAINS.** `cfg.chains` is
  "the networks auto-trending keeps alive", and its comment has always finished
  the sentence: *"Everything else is PAID-ONLY"*. The first cut of the mirror
  filled every chain in `CHAIN_ORDER`, so the board grew **POLYGON, OPTIMISM,
  BERACHAIN and HYPEREVM** sections overnight — four networks the operator had
  never put on it, each topped up to five rows, reported the next morning as
  "hapus polygon hyper optimis". A rule stated in a comment one module over is
  not a rule the new caller inherits. A BOOKED slot on any chain still
  publishes: somebody paid for that row, and this list governs what the bot adds
  by itself, never what a purchase may buy.
- ⚠️ **AND EVERY PUBLISH SAYS WHAT THE TOP-UP DID.** The first cut warned on
  failure and said nothing on success — so *"the site was unreachable"*, *"the
  site is on demo data"*, *"there was nothing readable to add"* and *"it
  worked"* were ONE observation from the channel: a board that is still short.
  That is this session's own recurring defect (three fixes in `autoTrend`),
  reintroduced by the code written to end it, and it left the very next round
  with nothing to read. One line at info per publish —
  `[trending] board: solana 4+1 · bsc 3+2 (booked+from-site, minimum 5/chain)`
  — and the REASON appended whenever nothing was mirrored.

### Every free listing reports to the visitor channel

"setiap free listing harus ada kirim laporan di channel dexvra visitor, bawah
free listing yang jelas". A free listing left no trace an operator could read:
`announce()` fires only when 📣 Post to channel is ON **and** the package is the
one that reaches @dexvraio, so `free` and `xpress` auto listings — the great
majority — went live with nothing but a pm2 line, and the operator learned about
them by looking at the site.

- **`log.report` is the transport, and it already existed** — the visitor
  channel (`LOG_CHANNEL`) is where this repo already sends business events (a
  `/start`, a purchase). Deliberately NOT de-duplicated: two listings that look
  alike are two real listings, and collapsing them would hide the feed.
- **Neither gate applies.** This is a report to the OPERATOR, not a public post,
  so it is sent with 📣 Post to channel OFF and on every package. An operator who
  switched the public post off did not ask to stop being told what their own bot
  listed.
- **Readable without opening the site**: ticker, name, chain, package and tier,
  cap/liquidity/24h volume at the moment it was listed, the contract, the day's
  count against the cap, and a link.
- ⚠️ **A channel that is down never costs the listing.** The report runs after
  the row is already live, and a throw there would turn a successful listing
  into a failed scan.

```bash
cd bot && node scripts/run-tests.js test/boardSync.test.js test/freeListingReport.test.js   # 10 tests, no network
npm test                                                                                    # site: board-rank route
```

#### "bagaimana agar masalah ini tidak terjadi lgi" — the rules did not move house

Three regressions in three commits, all mine, all one cause: the board's row
SELECTION moved from `autoTrend` (the promoter) into `trendingPoster` (the
website mirror), and the rules that governed it stayed behind. Every one of
them was already written down — `cfg.chains` … *"Everything else is
PAID-ONLY"*; the per-chain target is a ROLLED RANGE; a failure path is as loud
as the success path — and being written down is exactly what did not help. **A
comment in module A is not a guard on new code in module B, and this file is
prose, not a test.**

So `boardContract.test.js` asserts the properties of what the CHANNEL
PUBLISHES, driven through the real `buildText()`, over randomised worlds with a
seeded PRNG. It says nothing about which module chose the rows: a future change
that moves the selection somewhere else again has to keep them true.

| the contract | the incident it is made of |
| --- | --- |
| no section for an unconfigured chain, unless it holds a PAID row | POLYGON/OPTIMISM/BERACHAIN/HYPEREVM grew headings |
| a chain surviving on a purchase is never topped up | the exception re-creating the section |
| the per-chain count is a rolled range **as rendered** | every chain published exactly 5 for ever |
| a row the BOT chose carries a reading; a purchase may render `—` | the blank-percentage saga |
| a purchase is never displaced | the refund conversation this repo keeps avoiding |
| demo data never publishes; booked slots still do | `live:false` reaching the channel |
| exactly ONE report line per publish, naming the reason | four states reading as one short board |

- ⚠️ **THE FIRST CUT PASSED HAVING CHECKED NOTHING.** Its section parser
  anchored on `^\*\*`, and the header renders as
  `[🔶](emoji/…) **BSC - Trending**` — so it returned `{}` for every board and
  three assertions iterated an empty object. `expectRows()` is the guard: a
  parse that finds no board is an ERROR, never a quiet pass.
- ⚠️ **AND THE ROLLED-RANGE ASSERTION DID NOT COVER THE RENDERER.** Pinning the
  board's target back to `perChainMin` left `_rolledTarget` correct and every
  test green — the `fonts:check` rule, one module over. It measures the SECTION
  SIZES the board actually drew now.
- ⚠️ **Writing it found a real defect.** `buildText` bailed out on
  `!featured.length`, so a board with no BOOKED slot published nothing at all —
  meaning a promoter that stalls and lets every slot expire takes the whole
  board down with it, which is precisely the nine-hour outage above. The mirror
  can fill a board on its own; "nothing to publish" is measured from the rows
  actually drawn now.
- Mutation-tested against all four of the session's regressions: filling every
  chain, pinning the target, deleting the report, and choosing a row with no
  reading each fail between one and two of these.

```bash
cd bot && node scripts/run-tests.js test/boardContract.test.js test/boardSync.test.js   # 23 tests, no network
```

**Config a fix depends on:** `LOG_CHANNEL` in `bot/.env` — the visitor channel.
It is optional and already used for `/start` and purchase reports; unset, the
free-listing report goes to pm2 only and nothing else changes.

## The gap between two free listings was never a setting

"fitur free listing itu buat berapa jam sekali baru free listing di range misal
range 2 sampai 3 jam" (2026-08-25). Auto-Listing had `minGapMin`/`maxGapMin`
(25–90 min) on the panel labelled *scans every…*, and it was read as the answer
to this. **It is not, and the difference is the whole section.**

That band is the SCAN cadence, and a scan that finds nothing lists nothing — so
it was never a statement about the feed. Behind it sat `maxPerRun: 3`, which
means the site could take three listings inside one minute and three more half
an hour later. `maxPerDay: 12` was supposed to bound that and does not: twelve a
day arriving in four bursts is still four bursts, and a burst is exactly what
the per-token trigger band exists to stop the feed looking like.

- **`pace()` is the one owner of "may a listing go out right now"**, and it is
  PURE — the scan gates on it, the panel prints from it, the tests call it. A
  screen that computes its own version of a rule eventually disagrees with the
  rule; that is how the buy card ended up with two ideas of "whale".
- ⚠️ **The wait is rolled ONCE, at the listing — never by the scans that wait
  it out.** A fresh roll every scan converges on the FLOOR: with a scan every
  25–90 min, the first roll that happens to land under the elapsed time opens
  the gate, so the spacing collapses to the minimum of however many rolls fit in
  the window, and the band is decorative while every number on the panel still
  reads correct. Same defect as the per-chain trending target re-rolling every
  cycle, which ratcheted the other way and pinned every chain to its maximum.
  Rolling at the listing is the same fix as hashing a token's trigger off its
  address: the number has to be genuinely reached, and it does not move while
  you wait.
- **The roll is stored as a FRACTION of the band, not as an absolute "next at".**
  So editing the band in the panel applies to the wait already in progress. A
  stored timestamp would go on honouring a range the operator has since changed,
  and from the panel that is indistinguishable from a clock that has stopped.
- **The clock is on disk.** A restart that reset it would let a redeploy publish
  back to back, and this service is redeployed far more often than it is paced.
- ⚠️ **A stamp in the FUTURE is treated as SPENT, not as caution.** Clock skew
  or a restored backup, and there is no way to learn how long ago the real
  listing was. The first cut clamped `lastAt` to `now`, which reads as the
  careful choice and is the exact opposite: `nextAt` then recedes with every
  tick and the service never lists again, silently, with the panel still reading
  🟢 ON. Found by a test asserting the wrong behaviour and passing — the
  reassuring reading, for the fourth time in this file.
- **The gate sits AFTER discovery and the site read, BEFORE the first price
  lookup.** Those two calls are the only things that prove the service can still
  see the market and reach the site — `BLOCKED_ALERTS_AT` is built on them — so
  gating above them would cut the watchdog from every 25–90 min to once per
  rolled wait. Everything past the gate costs a DexScreener lookup per
  candidate, and a scan that may not list has no use for one.
- **A paced scan logs at INFO.** With a 2–3h pace this is what most scans do,
  and "why has nothing been listed" has to be answerable from pm2 alone; a scan
  that logged nothing would look exactly like a dead loop. The report carries the
  candidate count for the same reason — a long paced stretch must not read as a
  service that has gone blind.
- **While the pace is on, `maxPerRun` is not in play** and the panel stops
  printing it. A per-scan number that can no longer happen is a row the engine
  ignores, and this file already names what those cost.
- **The pace belongs to the SCAN, and only to the scan.** `trendFill.fillChain`
  and `chainSeed` list through the same `createFromInfo` and are untouched:
  pacing the filler would put the "board stays short" saga straight back, and
  the seeder is an operator-triggered bulk inventory fill, not a feed event. The
  panel says so under the pace line, because three listings appearing at once
  while it reads 2h–3h is otherwise a bug report.
- **The panel does the arithmetic out loud** — `≈ 8–12 a day, inside your 12/day
  cap`. Two numbers governing one feed with nothing saying which binds is the
  🧲 `max 3/chain` label again, whose very first question was which of the two
  it was.
- **An inverted band resolves to the FLOOR**, and a refused value names WHICH
  refusal it was: "1h is outside the limits" is false about a 1h ceiling under a
  2h30m floor, and a diagnosis pointing at the wrong cause sends the operator to
  change the wrong setting.
- ⚠️ **The legacy tests were made to say `paceListings: false` out loud.** With
  the pace on its shipped default a scan lists at most one, so four burst tests
  failed — and one dedupe assertion would have gone on passing for a NEW reason,
  which is worse. Stated, never inherited: the same rule the auto-trend panel
  helper had to learn.

### The audit round — and the panel was contradicting itself in four places

Run against the finished feature by four independent lenses, and every defect
found is one of this file's own recurring shapes, reintroduced by the code
written to stop it. **The engine was right in all of them; the SCREEN was not.**

- ⚠️ **🔎 Test scan could not see the pace, so the panel said the opposite of
  itself four lines apart** — `next one due in 2h30m`, and under it
  *"2 would be listed right now"*. `dryRun` never called `pace()`, and it is the
  button whose documented job is answering "why has nothing been listed?" — with
  the pace shipped ON, the pace is now the commonest answer and the test scan
  was the one surface that could not give it. It carries `report.pace` now
  (its own field, never `report.paced`: flipping `scanLine` into the paced
  branch would hide the market verdicts, and reporting the market is what a test
  scan is FOR), and the verdict says *"2 qualify, but the pace holds the next
  listing for 2h30m"* — or, with the pace open, that a real scan lists **the
  first one**, because `perRun` is 1 and promising two is a number the engine
  cannot produce.
- ⚠️ **`≈ up to 0 a day`, for a feed listing every other day.** Both ends of the
  rate are `Math.floor(1440 / gap)`, so both go to zero the moment a band passes
  24h — which the rails allow up to a week. A printed zero is a claim nobody
  measured, the trending board's defect one screen over; a band slower than a
  day now says so in words, and says the daily cap cannot be what stops it.
- ⚠️ **`fmtGap` rounds, so a wait of 20 seconds printed as `0 min`** — on the
  one line whose whole job is saying why nothing was listed. "under a minute",
  and never a bare `<`.
- ⚠️ **The ready line asserted "due now" over the two gates that run BEFORE the
  pace.** `pace()` knows only its own clock; `runOnce` checks `enabled` and the
  daily cap first and returns without ever reaching it. So a service switched
  OFF, and a day already full, both printed *"the next scan may list one"*. The
  auto-raid panel had to learn to DROP its ready line rather than reword it, and
  this is the same fix: `held — the service is 🔴 OFF`, `held — today's 12/12
  cap is reached`.
- ⚠️ **"nothing listed yet" is a claim about the FEED and the clock is a new
  field**, so every install that upgrades prints it directly above its own
  *"Listed so far: 84"*. It is a statement about the CLOCK now.
- ⚠️ **A pinned band (min = max) IS a fixed heartbeat**, and the line beside it
  said *"never a fixed heartbeat"* — two ➕ taps from the shipped default, denying
  exactly what it was doing.
- **"the N/day cap is the only bound" was false** on a zero floor: pacing forces
  one listing per scan and scans are their own band. It names both now.
- **A negative ask on the ceiling row was answered as a floor conflict.** Both
  refusals were reachable and the wrong one won, which sends the operator to
  change the wrong setting.

And four in the TESTS, which matter more, because a test that passes for the
wrong reason is how the next round starts:

- ⚠️ **The pace gate was answering for the paying-customer dedupe test.** The
  test above it lists at the same synthetic `now`, so `known.has(key)` could
  have been deleted outright and the suite stayed green. This shape was caught
  and fixed one test higher and not applied to the next one down. It asserts
  `lastScan().known === 1` and `lastScan().paced === null` now — which rule
  stopped the scan, not merely that it stopped.
- **"the clock survives a restart" did not test persistence.** It read `pace()`
  off the live module; a clock held in a module-level variable passes that. It
  re-requires the module, the move the package-rotation test already makes.
- ⚠️ **Nothing drove `start()`** — the three cadence tests all called the helper,
  and `start()` is its only production caller, so it could go back to rolling its
  own gap with every one of them green. That is the repo's own rule about a guard
  measuring the stack that actually runs, and it needed the REAL clock: under the
  suite's synthetic `now` every stored stamp reads as skewed and the pace never
  engages at all.
- **"a zero band cannot spin the loop" was vacuous** — `HARD.gapMin`'s floor of
  5 min made the assertion true whatever the branch did. It is asserted against a
  one-second wait now, which is the case that reaches it. The `Math.max(30_000)`
  it was aimed at is unreachable belt-and-braces and says so, rather than
  carrying a test that claims to cover it.

The four guarantees were then MUTATION-TESTED rather than argued: `start()`
rolling its own gap, the wait re-rolled every scan, the clock in memory, and the
gate moved above discovery. Each fails between one and five tests.

```bash
cd bot && node scripts/run-tests.js test/autoListerPace.test.js test/autoListerPacePanel.test.js   # 35 tests, no network
```

**Config a fix depends on:** nothing — but ⚠️ **it ships ON at the operator's own
2h–3h and that CHANGES an existing install's behaviour on deploy**, deliberately,
the way `minMcapUsd` did. The old behaviour is one tap: ⏳ Pace → OFF on the
🆓 Auto Listing panel.

### "pas pilih arm malah tidak mau respon" — it answered, off screen

Reported with the 🎛 Snipe Setup panel filled in and ⚡ ARM SNIPE doing
nothing. The tap was acked, the handler ran, and `armSnipeDraft` refused with
a real reason (*already sniping that dev on this chain* — the operator had
armed it, tweaked a row, and tapped again). **The reason was rendered into the
panel, near the TOP of a twenty-line message**, and the reader is at the
BOTTOM, because that is where the buttons are. An in-place edit notifies
nobody and, once scrolled, happens off screen — so the button reads as dead.

This file already names that lesson, on this very handler: the SUCCESS path
sends the confirmation as a NEW message *("dmn ada teks snipe atau confirm??"
— it was there, written into the panel message in place)*. **The failure path
beside it kept editing.** A lesson applied to one branch of an if/else is a
lesson half-learnt.

- **A refusal is SENT as well as edited in.** The panel keeps the reason (the
  row to fix is one tap away — the original comment's reasoning stands), and
  the reason also lands at the bottom of the chat, where the tap was made,
  naming what was refused and stating that **nothing was spent**.
- ⚠️ **A refused panel DROPS its ready line.** Its last line still read
  *"✅ Ready. Nothing is armed yet — tap ⚡ ARM SNIPE below to start
  watching"* — directly above the button that had just refused, with the
  reassuring line LAST. So the reader taps again, gets the same silence, and
  reports a dead button. The auto-raid panel had to learn to DROP its ready
  line rather than reword it; this is the same rule on the panel that spends
  money. A panel with no refusal still says its ready line — pinned, because
  deleting it is what started *"dmn ada teks confirm??"* in the first place.
- **The tests DRIVE the registered handler** through a real callback update
  and assert a `sendMessage` carrying the reason, not merely that the code
  calls `snipeSetupScreen`. A source scan passed on the broken revision.

#### …and the refusal was right — the PANEL that produced it was not

With the reason finally visible (*already sniping that dev on this chain*),
the next question was "mengapa seperti ini". Because the panel that offered
the tap showed **every row ✅ and a live ⚡ ARM SNIPE button for a developer
the store was already watching** — indistinguishable from a panel that has
never been armed, which is exactly how it gets tapped. **A screen that offers
an action which cannot succeed will be reported as broken, and it was.**

- **`core.armedTargetFor(chatId, {kind, chain, ca})` is the ONE owner of "is
  this a duplicate".** Two already existed — `addSnipeTarget` and
  `addCopyTarget` each refuse one at arm time — and the panel knew about
  neither. It is the same fact, read one screen earlier, where it can still be
  acted on.
- **The ⚡ row is REPLACED, not relabelled**: an already-watching target's row
  becomes the list it is already on (👥 Copy & Snipe for a dev, 🎯 Sniper for
  a CA). A button whose only outcome is a refusal is not a button.
- **The status line says it too**, where the 🎯 Target row that fixes it is one
  tap away — change the target, or go remove the existing one.
- ⚠️ **Kind and chain are part of the identity.** A dev target and a CA target
  live in different stores and the same address on another chain is a
  different target; reading one for the other would refuse to arm something
  perfectly arm-able. EVM comparison is case-insensitive (a pasted checksum
  spelling must not read as a second, un-armed target) and Solana's is not.

#### "set 0.01 eth 5 wallet tpi laporanya hanya 1 wallet" — and there was no way to change it

Both halves of the next report are one design hole. `newSnipeDraft` defaults
its wallet row to the **ACTIVE wallet**, so a target armed before that row is
touched watches with one — correct as a default, and invisible as a decision.
Change the row afterwards, tap ⚡, and it was **refused as a duplicate**: the
only route to the settings the user wanted was knowing they had to REMOVE the
target first, which nothing on any screen said.

- **⚡ on an already-watching target UPDATES it.** Tapping arm on a panel
  showing this target with new settings has exactly one possible meaning —
  "watch it with THESE" — and refusing is the least useful reading of an
  unambiguous request. The button says `⚡ UPDATE` when it will re-term rather
  than arm, because those are different events to a reader.
- ⚠️ **An edit rewrites the TERMS and never the HISTORY.** `spentEth`,
  `bought`, `holding`, `copySell`, the id and the cursor all survive: a budget
  that reset itself on an edit would let one target spend its cap twice, and a
  cleared `bought` map would re-buy a launch it already holds.
- **The budget floor is re-read against the NEW wallet count.** Five wallets at
  0.01 costs 0.05 a launch; a 0.03 budget on that selection is a watch that can
  never fire, and it is refused with the number.
- **A budget BELOW what is already spent is allowed, and SAID.** It is the one
  edit that halts a watch without removing it — refusing it would deny that,
  and applying it silently would be a watch that never buys again with nothing
  saying why.
- ⚠️ **"Budget itu untuk apa saya tidak mengerti."** `💰 Budget: 0.15 ETH` says
  nothing about what it authorises, which is the entire question. The row does
  the division out loud now — *"the total this watch may EVER spend — 3
  launch(es) at 0.05 ETH each, then it stops buying"* — the same fix the 🧲
  fill-rate label needed when its very first question was which of two numbers
  governed what.
- **Three tests changed premise, not rule.** "A refused arm keeps the draft"
  and "a refusal reaches the user" were both written against the duplicate,
  which is no longer a refusal; they use refusals that still exist. ⚠️ And one
  of those attempts revealed the panel's own guard working: a budget under one
  launch is refused at its ROW by `updateSnipeDraft`, so the panel can never
  display a setting the arm would then reject.

#### "hapus fitur budget" — a cap removed on the owner's call

Asked, and confirmed with the trade-off stated in as many words. **The dev
snipe now has no spending cap at all**: it buys every launch that developer
makes, on every wallet in its selection, until the master switch goes off, the
target is removed, or the wallets run dry.

- **It is a real removal, not a hidden default.** No row, no draft field, no
  `maxEth` on a 'launches' target — and `ensureUser` DELETES a stale one, or
  every screen would go on rendering `used 0.02/0.1` over a watch with no
  limit at all. A field that looks meaningful and binds nothing is the row the
  engine ignores, one level down.
- **What replaces the cap is VISIBILITY.** This repo's rule is that nothing
  spends money silently, not that everything must be bounded: the panel, the
  arming confirmation and the Copy & Snipe row each say the watch is uncapped
  and what the only stop is, and `spentEth` is still accumulated because it is
  the only number that says what an uncapped watch has actually spent.
- ⚠️ **COPY TRADES KEPT ITS CAP.** It was not what was asked about — the
  question was the per-LAUNCH budget on the snipe panel — and silently
  uncapping a second feature on the strength of a request about the first is
  how a removal turns into an incident.
- **The old one-line grammar still parses.** A third word used to be the
  budget; it is IGNORED rather than refused, because an operator with the old
  line in muscle memory must not have their target rejected over a dead
  setting.

### "TOKEN SUDAH LAUNCH SNIPE ON TPI PAS TOKEN LAUNCH BOT MALA DIAM"

A watched dev launched `$TEST` on Pons and the bot did nothing — no buy, no
message. **The bot was neither broken nor idle, and its own token card said so
in a sentence nobody thought to connect:** *"This token's liquidity is on Pons
v2, which Dexvra can't route through yet — so there's nothing to quote and no
swap to sign."* The launch was on a bonding curve this engine has no route
through: `canTradeNow` said no, `_notYetTradeable` deliberately excludes "can't
route through" from the retry ring (retrying an unroutable venue is two minutes
of RPC for an answer that will not change), and the chain ended in silence.
**Every step was individually correct and the sum of them was a sniper that
watched a launch go by without a word.**

- **An armed follower whose dev launched something is TOLD, always.**
  `_devLaunchMissed` names the token, the dev and the REASON — an unroutable
  venue, a DANGER flag, a dead wallet — because "minimal kalo gagal harus ada
  pesanya" is the floor, not a feature request. One notice per launch per five
  minutes: a warning per tick is a warning nobody reads.
- **A honeypot skip is the gate WORKING and is still said**, or the one case
  where staying out was the right call looks identical to being broken.
- ⚠️ **An unroutable launch is HANDED TO THE CA SNIPE, not dropped.** A
  bonding curve becomes buyable when it graduates into a pool this engine can
  route (Pons v2 graduates into a Uniswap v4 pool, which `v4.js` already
  autodiscovers). The CA snipe already polls `canTradeNow` for its whole TTL
  and fires on the first tick it can fill — so "never bought" becomes "bought
  at graduation" using only paths that already work, with no new money-path
  guesses. It carries the target's own wallet selection, slippage and TP/SL,
  and a failure to queue it is REPORTED: a follow-up the user believes exists
  is worse than none.
- **The ring's expiry is the last moment anyone can be told.** Past it there is
  no event left to hang a word on, so that is where the notice goes for a
  launch nobody managed to buy.
- ⚠️ **TWO Pons factories, not one.** Pons kept its V1 deployment live for
  tokens launched before the V2 upgrade, and a scan watching one address is
  blind to the other — `eth_getLogs` answers an unmatched address with an empty
  array, so that blindness reads as a quiet launchpad. A LIST now (current
  first, legacy kept), all live ones scanned on one cursor, and ONE live
  factory is enough — a dead legacy address must not condemn the current one.
- ⚠️ **The pad's HOST was a guess and the guess was wrong.** `pons.fun` was
  invented from the pad's name; the launchpad is served from
  **`ponsfamily.com/launchpad/<token>`**, which an operator's screenshot
  settled after the first check reported "can't reach api.pons.fun". The real
  host leads the base list and the invented ones cost nothing behind it —
  which is the whole reason a base list exists.

⚠️ **What this does NOT do: trade the Pons curve.** Buying pre-graduation needs
a route through Pons's own curve contract, and writing one against an interface
that cannot be verified from here would be a guessed address on a money path —
the one thing this repo refuses outright. Until that is verified on the box, an
armed dev snipe on a Pons launch buys **at graduation**, and says so at the
moment it cannot buy sooner.

```bash
cd tradebot && node --test snipePanel.test.js padSnipe.test.js   # 92 tests, no network
```

**Config a fix depends on:** nothing. `PONS_FACTORY` takes a comma list if
either deployment moves, and `LAUNCHPAD_PONS_API` pins the host if
`ponsfamily.com` is not where its API answers from.

#### "masih sama ajaa" — and the preflight was reporting the wrong-factory state as a quiet one

The next run: 4p green (`factory has code · 24353 bytes`), **`no Pons activity
in this window`** — and a token the operator had launched on Pons forty minutes
earlier, well inside the 5000-block window. Those two facts cannot both be true
of a correct factory address. **A factory that is live-but-WRONG reports zero
events, which is byte-identical to a quiet pad**, and that ambiguity is the
whole reason a researched-but-unverified integration can read green while every
real launch goes by unseen.

- **`--token <ca>` (section 4t) settles it from the operator's own data.** It
  scans recent blocks for any log MENTIONING that token and prints which
  contract announced it, with the topic0 — then prints the `PONS_FACTORY=` line
  to paste. The launchpad cannot hide from the token it launched.
- ⚠️ **Topics AND data.** A launchpad that packs the token into the data rather
  than indexing it is invisible to a topic-only filter, and that is half the
  ABIs in the wild.
- **4p probes EVERY configured factory** now, not just the first, and a dead
  legacy address prints as an ordinary note instead of failing the section —
  a retired deployment is expected to have no code and must not condemn the
  live one.
- **The "quiet pad" note stopped guessing.** It used to advise a wider window;
  it now names the probe that answers the question instead, because "rerun with
  more blocks" is the wrong advice for the state it usually means.

#### Why a Pons token cannot be bought, stated once and for all

Established by elimination, not by assumption, after three rounds of "masih
sama aja":

1. **The card is right.** `tokenSnapshot` tries `v4.price()` BEFORE it falls
   through to the indexer, and `v4.js` scans up to 4,000,000 blocks (trying
   `fromBlock: 0` first) for an Initialize log naming the token, reading the
   whole PoolKey including `hooks`. A hooked v4 pool would be found. It found
   none.
2. **So no v4 pool exists for that token yet** — which is exactly what the pad's
   own page says: *"At the threshold the curve closes and liquidity moves to a
   Uniswap v4 pool."* Pre-threshold there is a Pons CURVE contract and nothing
   else.
3. **This engine has no route to that curve.** Not a bug, not a missing
   config: no code here knows the Pons curve's interface, and the honest
   consequence is that a Pons token is unbuyable by this bot until it
   graduates.

**What unblocks it is one transaction the operator has already made.** A buy on
the pad's own website names the contract and the 4-byte selector a Pons buy
goes through, and `--tx` now decodes exactly that — `to`, `value`, the
selector, and every argument word with the addresses among them labelled. A
launchpad integration that cannot be read out of a real trade is one built on
guesses, and this repo does not put guessed addresses on a money path.

⚠️ **AND THE INSTRUCTION THAT ASKED FOR IT WAS ITSELF THE DEFECT.** It was
written as `--tx 0x<your own buy on the pad>` — a command with a placeholder in
angle brackets, pasted straight into a live shell, where bash reads `<` and `>`
as redirects and dies with `syntax error near unexpected token 'newline'`
before the script ever runs. **This file's own first rule, broken in the act of
diagnosing something else:** a command an operator can paste must contain only
real values, or it must not be a command.

So the hash is no longer asked for at all. **Section 4x finds the trade
itself**, from the token address the operator already has: every buy on a curve
moves the token OUT of the curve contract, which emits a `Transfer` — and a
Transfer log carries its transaction hash, from which the CALL is one read
away. It prints the contract, the selector, the value and the labelled argument
words, and RANKS the call that carried value first, because that one is the
buy and a sell or a plain send is not.

⚠️ **AND THE FIRST CUT OF THAT PROBE HUNG.** It matched the token by substring
against every log, walked in 200-block steps, and over a 50,000-block window
that is 250 requests each pulling the WHOLE chain's logs — the operator watched
a probe sit there. **A probe that hangs is worse than one that says it cannot
answer.** An indexed argument IS a topic, so 4t is three topic-filtered
requests over the whole range; the DATA-packed case it can no longer see is
DELEGATED to 4x (address-filtered on the token's own Transfer logs, cheaper
still) and the warning says so, or "not found" reads as "never launched". 4x
runs FIRST because it is the cheapest and answers the question actually being
asked. The stepped fallback carries a request budget.

⚠️ **And syntax-checking the file proved nothing** — the hang was a runtime
shape. Both probes are now driven against a STUB chain that counts requests:
they complete, they print the contract and the selector, and they cost **four**
`getLogs` calls, not two hundred and fifty.

```bash
cd tradebot && npm run preflight:robinhood -- --token 0xTHE_TOKEN_YOU_LAUNCHED
```

⚠️ **And the token card was RIGHT all along.** *"This token's liquidity is on
Pons v2, which Dexvra can't route through yet"* is not a bug: Pons v2 tokens
trade on a bonding curve until the threshold, and only then does liquidity move
into a Uniswap v4 pool. `tokenSnapshot` already tries `v4.price()` first —
`v4.js` reads whole PoolKeys off Initialize logs, hooks included, so a
graduated Pons pool routes today. What does not exist is a route to the CURVE
itself, and that is the honest boundary: **an armed dev snipe on a Pons launch
buys at graduation, and says so at the moment it cannot buy sooner.**

### "angkanya bisa di ketik biar cpt" — twenty-two taps for one number

The trigger ceiling steps in ±$100,000, so moving it from $1M to $3.2M is
twenty-two taps, and the pace band steps in 30 min. The label button beside each
➖/➕ pair was an `alnop` — a button that did nothing at all — so the fix cost no
new row on a keyboard that is already fourteen deep: **the label IS the input**.

- **`AL_TYPED` is one table**, and `kind` picks the parser. A row added later
  cannot grow its own idea of what a valid value is — the shape `pads.js` and
  `MOODS` already use in this repo.
- **The money parser is `parseCap`, IMPORTED**, not a second copy. It already
  exists for the gainers settings and it already carries the scar: `500k` →
  `Number()` → NaN → `clampNum` swapped in the default → *"✅ Minimum market cap
  → $1.00M"*, a number nobody asked for under a tick.
- **`parseGap` lives beside `fmtGap` as its inverse**, the contract `parseCap`
  states one module over, and returns `null` on anything it cannot read.
- ⚠️ **A BARE NUMBER IS REFUSED on a duration row, and that is deliberate.**
  `3` is three minutes to the store and three hours to the label printing
  "Every 3h" — and being wrong by 20× on *this* setting is the firehose the pace
  exists to prevent. The refusal names BOTH readings rather than guessing. Every
  other spelling is generous: `2h30m`, `90m`, `2.5h`, and the `3jam` /
  `90 menit` an Indonesian operator actually types.
- **A clamped value says it was clamped**, and the two pace rows report the whole
  BAND rather than the end that was typed — raising the floor past the ceiling
  moves the ceiling too, and naming one number while the other moved sends the
  operator to change the wrong setting.
- ⚠️ **`$1,000,000` rendered as `From $1,000,0…`** — the one row whose job is
  showing a value showed everything but its last digits. The labels are `fmtCap`
  now (`$1.00M`), which is what the rest of the repo already spells money as.
- ⚠️ **A fake Telegram update must be faithful WHERE THE FRAMEWORK LOOKS.**
  Telegraf's `bot.command()` matches the `bot_command` ENTITY, not the text, so
  a `/cancel` sent without one arrives as ordinary text and the handler never
  fires. The first cut of the `/cancel` test therefore reported a wait surviving
  a cancel that was never delivered — a test measuring its own fake.

```bash
cd bot && node scripts/run-tests.js test/autoListerTyped.test.js   # 13 tests, no network
```

## "auto listing aktiv tapi hari ni listing 0 dari kmrin listing 0" — the band top was a jitter wearing a size limit's label

Reported 2026-08-28 with every panel light green: Status 🟢 ON, pace *"due
now"*, 105 listed lifetime — today 0, yesterday 0. Nothing was down and no scan
was blocked. The operator had set the trigger band to **$1M–$100M** (with
Ignore-above at $100M — plainly *"list anything from $1M to $100M"*), and
`triggerMcap` drew every token's trigger UNIFORMLY across the whole band.
Measured, not argued: mean trigger **$50M**, and **0.4%** of tokens drew one
under $1.5M. The discovery feeds carry $1–5M projects, so ~97% of every scan
was refused "below its trigger", the refusals cooled for 12h, and a feed that
had listed 105 tokens went to zero **by arithmetic** — the quiet-market look,
with the operator as the detector again.

- **The two readings of "Trigger band" coincide on a narrow band and diverge
  catastrophically apart.** The band was designed as the anti-round-number
  smear (listings at $1.08M / $1.42M, the shipped $1M–$1.5M), where "how much
  jitter" and "up to what size may a token list" are the same answer. Widened,
  they are opposite answers, and the engine had the one no operator means —
  the `🧲 max 3/chain` label defect, with two days of dead feed attached.
- **The jitter is bounded by the FLOOR now** (`triggerJitterSpan`: at most half
  the floor above the floor — the designed smear exactly). The band top past
  that governs nothing; eligibility's ceiling is `maxMcapHard`, which is its
  own row. On the shipped band the draw is **bit-for-bit what it always was**
  (span 500k either way, pinned by a test), so no install's triggers move
  unless its band was wide — where the old triggers were the defect.
- **The panel does the arithmetic out loud** when the stored band is wider
  than the draw: *"triggers land in $1.00M–$1.50M — a token past its trigger
  lists at any size up to the $100,000,000 ceiling."* The number that actually
  governs is the one on screen, which is what stops the next widened band
  being read as a dead feature.
- Mutation-tested: restoring the unbounded draw fails the wide-band test (a
  $5M token must qualify under a $1M–$100M band).

```bash
cd bot && node scripts/run-tests.js test/autoLister.test.js   # includes the two band tests
```

**Config a fix depends on:** nothing. The operator's stored band keeps its
stored values; only the draw is bounded. If listings are still 0 after this
deploys, 🔎 Test scan names the next gate in line — it is no longer this one.

### …and the same day, "free listing di admin bot tidak bekerja sebelumnya bekerja"

The band-top defect above is why that operator's feed went to zero. This is the
audit that followed it, and its subject is not a fifth cause — it is that **all
five looked identical from every surface an operator has.** The panel read 🟢 ON
and the scan line under it read

```
🔍 Last scan (4 min ago): 40 candidates · 40 priced · 0 listed
```

**That sentence is what a healthy scan in a quiet market looks like, it is what
the band-top defect looked like for two days, and it is what every one of the
following looks like** — a site refusing every create, a pricing host refusing
the box, one whole chain that can never be resolved, and an operator's own
↩️ Reset tap. Five different faults, one rendering, `blocker` null in all of
them, and the blocked-scan watchdog silent because it only ever fired when a
scan could not RUN.

The service was in fact the best-instrumented one in this repo — `scanReport`,
`BLOCKED_ALERTS_AT`, the panel's "the scanner has gone quiet" line — and every
hole below is somewhere those instruments do not reach.

- ⚠️ **A CREATE THE SITE REFUSED WAS A `continue`.** One `log.warn` and nothing
  else: no counter, no reason on the panel, no blocker. A rotated
  `INTERNAL_API_TOKEN`, a payload the site's validator rejects and a 500 all
  rendered as `0 listed` with an EMPTY reason tally — which reads as "the market
  had nothing", the opposite of what happened. `report.refused` / `refusals`
  carries the site's verbatim sentence now, `scanLine` leads with it, and a scan
  in which **not one** create landed is a BLOCKER: those tokens cleared every
  gate the operator set, so that scan had something to list and could not, which
  is the definition `fileReport` already used. One that listed something and
  refused one token is not — paging for a per-token problem is how a monitor
  gets muted.
- ⚠️ **"WE COULD NOT ASK" WAS BEING FILED AS A FACT ABOUT THE TOKEN, AND THE
  TOKEN PAID FOR IT FOR TWELVE HOURS.** `dexscreener.fetchTokenInfo` returned a
  bare `null` for a 403, a 429, a dead socket AND a token with genuinely no
  pair; `rejectReason` renders a null as `"no market data"`, and `coolUntil`
  benches that for **12h**. So a DexScreener refusing this box produced
  `40 priced · 0 listed — no market data ×40` and then kept the feed dead for
  half a day after the outage ended. `fetchTokenInfoX` returns
  `{info, ok, why}` — `pumpfunNewX`'s shape, for the fourth time in this repo —
  `ok:false` is its own counter and its own sentence, and it writes **no cool
  entry at all**.
- **The host is BENCHED on a refusal, and the feeds share the bench.** 401/403/
  429/451 only: a 5xx or a timeout is a per-request failure and says nothing
  about the quota, and a 404 is an answer about the token. Discovery and pricing
  are the same host, so two benches would let the half still asking keep the
  refusal alive for the half that stopped — `gt.ts`'s contract, verbatim.
- ⚠️ **↩️ RESET SWITCHED THE SERVICE OFF, and the panel then blamed the loop.**
  `DEFAULTS.enabled` is false — right for a fresh install, which publishes in
  public — so resetting the THRESHOLDS stopped a running feed, announced as a
  bare "↩️ Reset". And an off service filed no scan report, so `alScanLine` went
  on to print *"⚠️ The scanner has gone quiet — the loop has stopped. Check the
  [monitoring] lines in pm2 logs"*, sending the operator to hunt a dead process
  that was running perfectly. **Two taps from the reported symptom, with nothing
  on any screen naming the cause.** The switch is carried across a reset now, the
  button says which state it left the service in, and an OFF scan FILES its
  report — a stale report is supposed to mean the loop stopped, and it can only
  mean that if every other reason files one.
- ⚠️ **TWO OWNERS FOR THE DEXSCREENER SLUG, disagreeing about one chain.**
  `config/chains.js` has `DEXSCREENER_SLUG` (`sei: "seiv2"`); `dexscreener.js`
  built its own identity map from an `OVERRIDES` table nobody ever filled in. So
  every Sei token answered "no market data" and every Sei feed entry was dropped
  before it was counted — one whole network invisible to free listings,
  silently, while the panel said it watches "every supported chain". One owner;
  identity stays the FALLBACK so adding a chain still makes it discoverable.
- ⚠️ **AND THE GUARD TEST FOR THAT COULD NOT FAIL.** It asserted the map had one
  entry per chain and no duplicate slugs — both true of the broken map. It
  asserts equality with `DEXSCREENER_SLUG` now, and `dexscreener.test.js` drives
  a real captured payload through the parser: **that module had no test at
  all**, so a renamed DexScreener field would have made every candidate on every
  chain read as "no market data" with 1,700 tests green.
- **Robinhood pricing OVERRODE the indexer, and that rule expired.** `discovery`
  returned the pools.trade record and never asked DexScreener — correct while
  pools.trade was the only source for the chain, and wrong from the day
  DexScreener added it (July 2026). The gates read `liq`/`vol24`/
  `pairCreatedAt`; a bonding-curve envelope coerces what it does not publish to
  0, so the whole chain read as `thin liquidity ($0)`, including graduated
  tokens with real depth. It is a MERGE now — the indexer's live numbers win,
  the pad fills the socials, logo and curve state. The test that pinned the
  override now states why it expired.
- ⚠️ **A LAUNCHPAD RECORD MAY NOT DRESS A REFUSAL AS AN ANSWER.** With the merge
  in place, a DexScreener that could not be asked plus a pad record would have
  produced a full-looking row with `liq: 0` — reported as `thin liquidity`,
  which sends the operator to change `minLiq` over an upstream outage, and
  shortens the cool from 12h to 1h. `ok` follows the INDEXER; the pad is display
  data.
- **An optional social may not cost the whole listing.** `adminValidate` refuses
  the ENTIRE row over a `website`/`twitter`/`telegram` that is not a full URL,
  and the pads publish bare handles. `siteUrl()` mirrors the site's own rule and
  DROPS what it cannot vouch for — losing a link beats losing the listing and
  the link with it.
- **A refusal is memoed only when it is about the ROW.** 400/404/409/422 will not
  change on the next scan, so the token is cooled; 401/403/429 are the site
  refusing US and apply to every token equally — memoing those would bench the
  entire candidate list over a credentials problem. Caught by a test, not by
  reading.
- **The permanent ledger records what was LISTED.** `rememberListed` folded the
  site's ENTIRE roster, so anyone posting a contract to the public form
  (unauthenticated, `pending`) locked that token out of free listing for ever,
  as did every submission an admin rejected. Approved rows only; `known` still
  skips everything for the current cycle, which is a different rule.
- ⚠️ **AN UNREADABLE STATE FILE IS NOT A FIRST RUN.** `loadJSONSync` answers
  `def` to both, and `everListed` is the append-only ledger that stops a
  previously PAID listing being handed back free — so a truncated write read as
  `{}` and the next save made the loss permanent, mirrored to Mongo. The scan
  now REFUSES to run and pages once; `readJSONSync` is what tells the two apart.
- **`fileReport` merges the ledger instead of writing its snapshot back.**
  `fulfillment.js` calls `rememberListed` the moment a paid listing goes live,
  which can land in the middle of a forty-lookup scan.

#### So it cannot go quiet unnoticed again

The causes will keep changing — that is the lesson this repo has already paid
for three times on the trending board. What is watched is the PROMISE the
operator set when they switched it on: **free listings actually go out.**

| layer | stops |
| --- | --- |
| `report.refused` / `unpriced` / `unsupported` + the blocker ladder | a fault rendered as a quiet market |
| `listingWatch.js` in the running bot | the operator being the detector |
| `api.canCreate()` on 🔎 Test scan | the panel promising a listing the site would refuse |
| `npm run listing:check` + the build stamp | "which of the six is it?", on the box |
| `dexscreener.test.js` | a parser drift that reads as an empty market |
| `servicesLoad.test.js` | a service module that cannot be required at all |

- **`listingWatch.evaluate()` is PURE** and the caller owns persistence, so a
  test walks the service through days of scans in milliseconds. Transition only,
  after `LISTING_QUIET_GRACE_MS` (12h — the shipped pace is one listing every
  2–3h, and a market that hands us nothing for an afternoon is ordinary); a
  RECOVERY is an alert too; it repeats every `LISTING_QUIET_REPEAT_MS` (24h).
- **It says when nothing is wrong.** A quiet market is reported as
  `ℹ️ … the service is running correctly — this is what it found`, with the
  dominant rejection reason; only a real fault gets ⚠️. A monitor that cries
  wolf at a quiet market is one that gets muted, which is why the trade bot's
  "possible rug" alert had to be deleted rather than tuned.
- **A blocked scan is left to the blocked-scan watchdog** — one fault, one
  alert. The clock keeps running so the recovery still fires.
- ⚠️ **`listing:check` exits ZERO on a quiet market**, and non-zero only when
  free listings CANNOT happen. A check that is always red trains the reader to
  ignore the red, which is the state `chart:preview` sat in for weeks.
- **§5 probes the WRITE path** with a payload the site's validator refuses
  outright (`{}` → 400), so it can never create anything — and a 400 back is the
  proof: authorised, reachable, validator working. `api.canCreate()` is the one
  owner, shared with 🔎 Test scan, because a check that asked its own way is how
  `fonts:check` printed nine green ticks over a banner publishing boxes.
- ⚠️ **`servicesLoad.test.js` exists because this fix nearly shipped broken.**
  `autoLister` requires the new `listingWatch`, and a commit taking the modified
  file without the new one would have produced `[monitoring] service
  "autoLister" failed to start` — with the panel reading 🟢 ON and "the scanner
  has gone quiet", i.e. **the exact symptom being fixed**. It requires every
  module in `src/services/` and every path `attach.js` names, and it is
  mutation-tested against that hazard. Its source scan strips comments first:
  attach.js's header quotes `require("./x")`, the very line it was written
  about.

```bash
cd bot && npm run listing:check                                     # per box: which of the six it is
cd bot && node scripts/run-tests.js test/listingBlocked.test.js \
    test/dexscreener.test.js test/servicesLoad.test.js              # 51 tests, no network
```

**Config a fix depends on:** nothing. `LISTING_QUIET_GRACE_MS` /
`LISTING_QUIET_REPEAT_MS` exist for an operator who finds 12h too twitchy, and
`DEXSCREENER_BENCH_MS` widens the back-off. ⚠️ **But whether DexScreener answers
this box at all is a property of the server's egress today** — it answers 403
from the sandbox this was written in — so `npm run listing:check` on the box is
the only thing that can say which of these the operator is actually hitting.
⚠️ And an install whose ledger was already poisoned by public submissions keeps
those entries: the fix stops new ones, and 🧹 Clear history is still the only
eraser, which re-opens everything at once.

#### The audit round — nine of these were in the FIX

Run against the finished change by seven independent lenses, and every defect
found is one of this file's own recurring shapes, reintroduced by the code
written to stop it.

- ⚠️ **THE HALT WAS INVISIBLE TO EVERYTHING THAT NEEDED TO READ IT.** Both new
  refusals decline to WRITE — that is what makes them halts — so `lastScan()`
  goes stale, and a stale report is exactly what `alScanLine` and
  `listing:check` read as *"the loop has stopped"*. The fix would have accused a
  perfectly healthy loop and sent the operator to pm2 to hunt a process that was
  running fine. Worse, the first cut put the halt in a MODULE-LEVEL VARIABLE —
  and the loop runs in `dexvra-bot` while the panel runs in `dexvra-adminbot`
  and the check is a third process again, so it was invisible to both anyway.
  Its own two-field file, written and AWAITED (a fire-and-forget write races the
  readers it exists for), cleared by the first scan that files a report — with a
  recovery alert, because a fixed halt and a forgotten one look identical.
- ⚠️ **AN UNREADABLE CONFIG READ AS "the operator switched it OFF".**
  `DEFAULTS.enabled` is false, so a corrupt or root-owned `autoLister.json` —
  DATA_DIR is shared by both PM2 processes, one `sudo node scripts/…` is enough
  — took the new OFF branch, and the panel and the check then both told the
  operator to tap **▶️ Enable**, which calls `set()`, which writes `{...get()}`
  and so overwrites every tuned threshold with the shipped defaults. A read
  failure laundered into a settings wipe, by the very code written to diagnose
  it. `configOk()` is its own question (never a field on the config — that
  object is compared against DEFAULTS field-for-field and is what `set()` writes
  back), the scan halts instead, and `set()` refuses.
- ⚠️ **THE LEDGER MERGE UNDID 🧹 Clear history.** The merge that stops a paid
  listing's entry being dropped mid-scan unions fresh into stale — so a clear
  landing inside the scan window (up to forty serial lookups, minutes wide when
  DexScreener is slow, which is exactly when somebody taps it) restored every
  entry just deleted. The panel would report the history cleared and the tokens
  would go on being refused for ever. `clearedAt` is stamped by the clear, and a
  snapshot older than it loses its token bookkeeping and keeps only its report.
- ⚠️ **`rememberListed` HAD THE GUARD ONLY AT ONE CALL SITE.** `fulfillment.js`
  calls it the moment a PAID listing goes live, outside any scan — so an
  unreadable state file at that moment still wiped the ledger, the pace clock
  and the day count. The guard belongs in the writer: *a caller can be wrong
  about what it is holding, and the store cannot.*
- ⚠️ **🧹 Clear history WIPED THE SCAN REPORT**, so the panel instantly printed
  *"the scanner has never reported … it is NOT running"* over a healthy loop,
  from the operator's own tap. The report is an observation about the LOOP, not
  knowledge about tokens; it survives, and so does `blocked`.
- ⚠️ **`log.attach()` RAN AFTER `setupMonitoring()`**, so the
  `🚨 N background service(s) did not start` page — the ONE alarm for a dead
  auto-lister loop — went to a logger with no bot attached and was dropped into
  pm2's stdout. That is the two-day incident `attach.js`'s own header was
  written about, with its fix undone by boot order. Pinned by a source scan that
  strips comments first.
- **↩️ Reset resets every setting but the switch**, and the toast said only what
  it did NOT change — silent about the pace going back ON, the packages falling
  back to Free and the chain scope reopening. It names what moved now, in an
  alert rather than a toast when anything did.
- ⚠️ **The Test scan verdict promised a listing over the two gates that run
  BEFORE the pace** (the service switched off, and the daily cap), and its
  4096-char trim shortened only the PANEL half — so a blocker that now names
  each failing source could build a message Telegram rejects outright, losing
  the verdict entirely and leaving the button reading as dead precisely when it
  had an answer. Bounded at source, capped at eight qualified rows.
- **The ready line printed over a loop the panel had already worked out was
  dead.** Dropped, never reworded — and ordered by CERTAINTY: a switch and a cap
  the operator set are known facts, "the scanner has not reported" is an
  inference.
- **A refused admin tap was never answered**, so every button on every admin
  panel spins for ever for a non-admin — indistinguishable from a handler that
  does not exist. `guard()` answers now, which is the one-owner fix: a guard the
  fortieth handler has to remember is one it forgets.
- **Every state write was `.catch(() => {})` and the loop's own exception handler
  was `log.debug`** — both produce nothing at any level production prints, and
  both look exactly like a dead loop.
- ⚠️ **…AND `reset()` NEVER GOT THE GUARD ITS SIBLING JUST GOT**, which is the
  worse of the two to miss. `get()` answers DEFAULTS for an unreadable config,
  so `wasEnabled` read FALSE, and ↩️ Reset would write the shipped defaults over
  a file it could not read **and switch the live feed off** — every threshold
  destroyed, from the one button whose whole contract is that it never touches
  the switch. A fix applied to one of two siblings is a fix half-made; the pace
  panel's success-path-only lesson, one function over.
- ⚠️ **AND THE GUARD THEN PRODUCED THE SYMPTOM IT WAS WRITTEN TO END.** `set()`
  and `reset()` THROW over an unreadable config — right, because writing over it
  wipes the settings — and a throw inside a `bot.action` is swallowed by
  `bot.catch`. So the operator taps ▶️ Enable, the button spins, the panel does
  not change, nothing reaches them, and free listings stay stopped: "tidak
  bekerja", manufactured by the guard. `alWrite()` is the one owner — fourteen
  try/catches is a guard the fifteenth handler forgets.
- ⚠️ **AND THE THIRTEENTH WRITE WAS LEFT BARE — the one channel `alWrite` cannot
  serve.** The ✏️ typed-value path is a `bot.on("text")` handler, so it has no
  callback to answer; the helper wrapped twelve call sites and this one stayed
  uncovered. A throw there is swallowed by `bot.catch`, so the operator taps a
  row, types `2h30m`, and the bot says **nothing at all** — no ✅, no ⚠️, no
  panel edit. That is the WORSE half of the pair: a spinning button at least
  spins. Found by the audit's own synthesis, after a fix that wrapped twelve of
  thirteen. So the rule is COUNTED now, not trusted: a test scans
  `adminBot.js` for every `autoLister.set|reset|togglePkg` and fails on any that
  is neither inside `alWrite` nor inside a `try` — a fourteenth handler added
  later forgets in exactly the same way, and its symptom is this whole section.
- **Three things were asserted in comments and nowhere in a test**, and each is
  invisible in the reassuring direction: `api/dexvra.js` had NO test at all (a
  POST that really created the row but whose envelope we stopped reading makes
  the bot page the operator about a site that is working); "a launchpad record
  does not make a refusal into an answer"; and "REFUSALS ONLY, never a 5xx" on
  the bench, where arming it would take pricing AND all three feeds down from
  one slow response. Eleven panel buttons — ▶️ Enable among them — could be made
  completely inert with 1789/1789 green.

#### The first live run was GREEN — and it named the one source still collapsing

`npm run listing:check` on the box, straight after the deploy:

```
2 · The scan loop
  ✓ last scan 2 min ago: 76 candidates seen · paced — next free listing due in 1h25m
    today: 1/5 · listed all-time 106 · never-relist ledger 509 contracts
3 · Discovery
  ✓ token-profiles/latest/v1 → 29 · token-boosts/top/v1 → 30 · token-boosts/latest/v1 → 29
  ⚠ poolstrade → 0 candidate(s)
  ✓ 76 merged — solana 53 · robinhood 17 · bsc 4 · ethereum 1 · base 1
4 ✓ /api/internal/listings → 411      5 ✓ write path reachable and authorised (400)
6 ⚠ 15 priced (a sample) · 0 would be listed — below its trigger ×14 · low 24h volume ×1
Free listings can go out: the loop is alive, the market is visible, and the site takes writes.
```

The feed is publishing (`today: 1/5`, all-time 105 → 106), and **17 Robinhood
candidates arrived through DexScreener** — the `DEXSCREENER_SLUG` flip and the
merge-not-override fix, both paying off on the one chain that used to read
`thin liquidity ($0)` for everything.

⚠️ **But `poolstrade → 0` was the same collapse this whole section is about,
one source over — and a comment in `discovery.js` asserted it could not be.**
That entry wrapped a plain `fetchDiscovery()` as `ok: true` on the stated
reasoning that *"a throw is the only failure it reports"*. Untrue:
`fetchLaunches` catches its own page failures and returns `[]` at debug level.
So a retired host, `POOLS_TRADE_ENABLED=0` and a genuinely quiet launchpad were
one line on the check, and the fix's own prose was the reassuring reading
written down. **A comment asserting a contract the module does not keep is
worse than no comment.** `fetchDiscoveryX` reports it now — first-page failure
only, because losing page three is a shorter list and not an outage — and the
check prints *"answered, 0 candidate(s)"* for a quiet pad rather than the same
⚠ a dead one gets.

⚠️ **And the next run named it: `✗ poolstrade → HTTP 409`** — the same line that
had been printing `0 candidate(s)` since the feature existed. Two things that
answer needed:

- **The reason was thrown away.** `fetchPage` raised a bare
  `Error("HTTP " + status)`, so the gateway's own sentence — Uniswap's is a
  private Connect-RPC endpoint, and its refusals name the header or field they
  wanted — never reached anyone. That is this file's own rule ("an HTTP error
  puts the explanation in the response body") broken on the one source whose
  request shape is a guess. The body travels now, flattened and bounded.
- ⚠️ **RED, BUT NOT FATAL — AND THE CHECK HAS TO SAY WHY.** A ✗ printed above a
  green *"Free listings can go out"* is a mixed signal the reader has to decode,
  which is how a check stops being read. pools.trade supplies PRE-MIGRATION
  launches: a bonding-curve token has no pool, so it fails `minLiq`, `minVol24`
  and `minAgeHours` **by definition** — `discovery.js`'s own header says exactly
  this about launchpads. What a dead pad costs is visibility of launches before
  they graduate, not listings. The check names that cost in place, and points at
  `poolstrade:check` rather than leaving a red mark with no verdict attached.

**And "below its trigger ×14" is the market, not a fault** — the check says so
in as many words, and the layer that decides is `TRIGGER_JITTER_OF_FLOOR`, one
section up. Lower 🎯 From to widen it. With `max 5/day` under a 2h–4h pace
(≈ 6–12/day) it is the CAP that binds, which is what the panel's own arithmetic
line prints.

⚠️ **One thing deliberately NOT changed.** The age gate fails OPEN on an unknown
`pairCreatedAt` (`if (info.pairCreatedAt && …)`), which is the inverse of this
file's rule that a floor is a CLAIM an unknown value cannot satisfy. Closing it
would refuse every token from a source that does not publish the field — and
making a gate stricter inside a change whose whole purpose is to get listings
flowing is the wrong direction to be wrong in. Recorded so it is not
rediscovered as an oversight.

## A Top 3 that was not the top of the Top 5

Two banners, one minute apart, from the same admin panel:

```
Top 5 (14:25)  BEHEMOTH +3981% · PATE +1538% · 牛来 +118% · SESTRI +35.3% · BOYZ +31.1%
Top 3 (14:26)  PATE +1538% · NYAN +25.3% · DOOM +18.7%
```

A Top 3 must be the first three of a Top 5. This one shared **one** token with
it, and the two it added rank *below* two the Top 5 already had.

**It was not the market moving.** PATE carried the identical `+1538%` on both, so
both readings are from the same moment. What changed is the **POOL**: the board
filter is `t.source === "live"` — whatever the website had a fresh price for at
that instant — and `sendPreview` re-sampled it on every template switch, at
`limit: countOf(id)`. Four tokens went stale between the two calls and left the
ranking without a word.

- **One sample per sitting, sliced per template.** Taken at `MAX_SLOTS` so it
  serves any layout the admin clicks next; any two previews are then prefixes of
  each other *by construction*, which no amount of re-fetching can give you.
  `SAMPLE_TTL_MS` (3 min) stops a 14:25 sample being posted at 15:40.
- ⚠️ **The session must keep the WHOLE sample, not the slice just rendered.** The
  old tail wrote `coins: stripLogos(coins)`, so a Top 3 preview left a
  three-token session and no wider layout could reuse it — that alone would have
  made the fix inert, and silently: every preview would simply have gone on
  re-sampling.
- **🔄 Refresh needed its own action.** It shared the template-pick callback,
  which now reuses the sample — so the button would have stopped refreshing while
  still saying it did. That is a worse bug than the one being fixed, because it
  is invisible.
- **`pool` was measured, returned, and never printed.** When the live rows
  collapsed, the card showed three tokens and looked entirely normal. It is on
  the preview now with the sample age, plus a warning when the pool is barely
  wider than the layout — a "top 5" drawn from six live tokens is a list, not a
  ranking.
- Posting already published `sess.coins` rather than a fresh reading, so the
  channel got the card the admin approved. That half was right and a test now
  pins it.

### And the podium was ranking noise

Same board: `$PATE` took #2 with **+1562%** on a market cap of **$52.6K**, above a
token up 126% on $40.89M. At that size one $500 buy is a four-figure percentage.
The sort was correct and the statement was false — a gain is only interesting next
to something worth gaining on.

There were two floors (gain, liquidity) and no market-cap floor at all.
`minMcapUsd` is the third, and **it ships ON at $1M** — unlike `minLiqUsd`,
because zero is what produced that banner. An existing install has no stored
value, so the default applies and **the daily post changes**: that is intended,
not a migration accident.

- **A token whose cap could not be read is left OFF.** The filter is a claim
  ("cap ≥ $1M"); a token with no cap cannot be shown to satisfy it. Same rule as
  an unreadable 24h change, same `|| 0` shape as the liquidity filter beside it.
- **Fewer real gainers beats padding.** Two tokens clearing $1M render as two, and
  the card says "Only N passed the filters" — it never reaches back down for the
  $52K one.
- **Applied before the slice**, or a "top 3" is three of whatever survived out of
  the first three rather than the best three that qualify.
- ⚠️ **The DAILY POSTER passes it too.** Wiring only the preview would show the
  admin a filtered board and publish an unfiltered one, which is worse than no
  filter. A test counts the call sites.
- Editable from ⚙️ Settings → 🏦 Min market cap, shown on the settings screen and
  in the home screen's filter summary, so an admin can see why a token they
  expected is missing.

⚠️ **`500k` set it to $1M, and the bot said ✅.** `Number("500k")` is NaN, and
`clampNum()` answers a non-finite value with the **default** — so the value asked
for was never stored, the setting was silently reset, and the reply reported
success. A ✅ carrying a number nobody asked for is worse than an error, because
nothing prompts a second look. The same two lines governed Min gain % and Min
liquidity.

- **`parseCap()` lives beside `fmtCap()` as its inverse** and returns `null`, never
  a number, on anything it cannot read. A parser that cannot fail is a parser that
  lies for its caller. Accepts `500k`, `1.5M`, `2b`, `1,000,000`, `$500k`.
- **One branch serves all three settings**, so a fourth cannot inherit the old
  shape, and an unreadable value throws — *"Nothing was changed."*
- **A clamped value is reported as clamped.** The bounds are real (a ten-trillion
  floor would empty the board for good), but storing something other than what was
  asked for and calling it ✅ is the NaN defect moved to the edges.

### Top 2 Duel

The layout ladder ran 1 · 3 · 4 · 5 · 8 · 10 — the head-to-head shape a
two-token day needs was the one missing. `duel2` fills it: winner gold and
slightly taller, runner-up silver, identity row horizontal because two columns
are wide enough to read that way. It inherits the identity rule below from day
one (one ticker size, figure scales ≥1.4×), and a test pins the ladder order —
the admin menu is built from `TEMPLATE_IDS`.

### Top 10 Spotlight

"saya ingin banner variasi baru lebih premium elegan dari top 1 sampai 10"
(2026-08-21). `grid10` answers *"show me all ten"* with two symmetric compact
panels; `spot10` answers *"crown the winner AND show me all ten"* — the
champion as a full hero card on the left (the podium/duel card grammar: gold
ring, radial seat, the move as the headline figure, sparkline strip,
hairline-split stats) and ranks 2–10 as ONE board panel beside it. The
composition every exchange's weekly-winners poster uses, which is why it reads
premium rather than tabular.

- **The identity rule, scoped the way the podium scoped it.** Every ROW ticker
  is one size (a test pins the call-site count at one); the champion's bigger
  name is not a ranking signal inside that set — it is a different component
  class four rows tall, the relationship `list5`'s title has to its rows.
- **A thin day renders on the layout DESIGNED for that count**: one coin
  delegates to `hero1`'s layout, two to the duel, three to the podium. A
  champion card beside a board carrying a single floating row reads as a
  rendering fault, not a short day — and the ladder already owns the right
  shape for each of those counts. Spotlight proper starts at four, and the
  pack's rows are CAPPED (128) rather than stretched into billboards.
- **The ladder test now pins `[1,2,3,4,5,8,10,10]`** — `spot10` sits last, so
  the menu still reads as a ladder. The admin menu, the random rotation and the
  preview script pick it up from `TEMPLATE_IDS` with no wiring of their own.
- Judged by LOOKING at the renders (n=10, 5, 2, 1), the `drawGem` rule — the
  n=2 delegation exists because the first render of that case was measured
  fine and looked hollow.

### The ladder is COMPLETE, and every banner has its own backdrop

"buatkan versi berbeda top 1 sampai top 10 jadi 10 banner dan backgroundnya
juga beda-beda" (2026-08-21). Two gaps, one promise:

**Counts 6, 7 and 9 had no template**, so the ladder jumped 5 → 8 → 10. Three
new layouts fill it, each a composition of the grammars already in the file
rather than a fourth private idea of a card:

| id | shape |
| --- | --- |
| `tier6` 🏛 | the podium as three crowned mini-cards ABOVE, ranks 4–6 as a board BENEATH — prize-winners over a leaderboard, not six equal cells |
| `crown7` 👑 | the champion as a full-width BAND across the top (the hero card turned landscape), ranks 2–7 as two boards of three |
| `mosaic9` 🧩 | nine compact tiles 3×3 — the cards4 card compressed; a short last row is CENTRED so seven coins read as a finished mosaic |

- **`rankedPanel` is the one owner of "a board that shares its banner"** —
  tier6's lower tier, crown7's two boards and spot10's pack all draw through
  it, so a row-grammar change lands everywhere at once. One row-ticker size,
  pinned by a test against the shared function (which covers all three layouts
  in one assertion).
- **Thin days delegate** exactly as `spot10` does: 1 → hero, 2 → duel, 3 →
  podium; the mixed layouts start at four and their rows are capped, never
  stretched.

**Every template used to sit on the identical aurora**, so a channel posting a
different layout each day still read as the same poster recoloured. `MOODS` is
the fix: each template names a bloom mood — geometry and palette per banner
(`dawn`, `clash`, `stage`, `quad`, `boardroom`, `strata`, `regal`, `beams`,
`nebula`, `terminal`, `laurel`). The scrim, dot grid, vignette, frame and
keyline stay shared, because those ARE the design system and varying them
would make eleven banners from eleven brands. Every colour is a SITE token.

- ⚠️ **Bloom positions alone were re-read as "the same background"** ("saya
  ingin semua banner backgroundnya berbeda-beda tidak sama", one day after the
  moods shipped) — light placement is mood, not identity. So every mood also
  carries a **PATTERN**: visible geometry of its own — sunburst rays (dawn),
  opposing diagonal beams (clash), stage cones (stage), 45° stripes (quad), a
  mint horizon (boardroom), strata bands, a gold halo (regal), vertical beams,
  a deterministic starfield (nebula), CRT scanlines (terminal), concentric
  rings (laurel). Deterministic — no `Math.random`, a re-render must be
  byte-stable — and painted UNDER the vignette so it recedes like everything
  else. ⚠️ The dawn rays' apex sits ABOVE the frame: on-canvas, nine wedges
  stack into one hot spike behind the keyline.
- ⚠️ **Uniqueness is pinned, not trusted**: a test fails if two templates share
  a mood or a pattern, if one has neither, or if a mood/pattern NAME has no
  entry in its table — a typo would silently fall back to the shared default,
  which is precisely the state this exists to end.

### Two calls off the first LIVE renders

- **No chain text on the artwork.** "chain ini hapus aja tidak ada teks chain"
  — the chips and the Chain stats left every banner surface. The caption under
  the post already names the chain and links the token; on the artwork the tag
  was noise beside the name. Footers that led with Chain lead with Price now,
  so no column goes empty. The caption's chain label lives in `gainers.js` and
  is untouched; a note in `gainersBanner.js` marks the removal so the next
  person doesn't quietly add a chip back.
- **The footer tagline joins the microlabel voice.** "Find the next Moonshot"
  was 16px mixed-case display on a `middle` baseline beside a 12px tracked
  uppercase microlabel on an `alphabetic` one — different size, case, face and
  vertical line in a chrome strip whose whole job is uniformity. Both halves
  are one microLabel call each now: same baseline, same size, same tracking,
  split by tone (brand faint, tagline muted).

### Every layout is tellable apart at a glance — the 2026-08-21 rebuild

"saya ingin banner lama berbeda semua dengan banner baru" — the moods pass had
changed only the BACKDROPS, and the seven original layouts still shared one
card grammar between them. Every one was rebuilt so no two banners in the
ladder share a silhouette:

| id | was | is now |
| --- | --- | --- |
| `hero1` | editorial split (text left, avatar at 0.70w) | the MONUMENT — symmetric about the centreline, ghost numerals flanking |
| `duel2` | two equal cards | ASYMMETRIC 57/43 split with a VS medallion on the seam |
| `podium` | three cards, winner taller | the cards STAND ON stepped PLINTHS carrying metal rank numerals |
| `cards4` | 2×2 landscape grid | four PORTRAIT trading-cards in one row, centred columns |
| `list5` | table with sparkline+price columns | GAIN-BAR leaderboard — bar length ∝ the real pct against the day's best |
| `rail8` | two panels of four rows | a film RAIL: two strips of four portrait mini-frames |
| `grid10` | two panels of five | one dense TERMINAL board, ten single-line rows |

- **The lessons survived the rebuild, and the tests moved with the shapes.**
  The podium still carries every rank signal (now seven — the plinth joined
  the list), one ticker size per component set everywhere, figures scale
  ≥1.4×, and the duel's pinned type sizes are unchanged inside the new
  geometry.
- ⚠️ **The podium's sparkline strip became an UNDERLAY** (alpha 0.3, behind
  the figure) — the cards are 70px shorter since the plinths took that height,
  and at strip weight the curve sliced straight through the side cards'
  figures. Found by LOOKING at the render, the `drawGem` rule, again.
- **The plinths are FULL card width** — the first cut inset them 14px and they
  read as buttons under the cards, not pedestals under statues. Same rule, next
  render.
- **`list5`'s bar is HONEST**: length ∝ `pct / max(pct)`, never eased, and the
  widest bar always belongs to rank 1 because gainers.js sorts by the same
  number. A drawn value follows the same rule as a printed one.

### The winner's NAME is not a ranking signal

`$巨兽BEHEMOTH` was drawn at 44px against 31px for the two cards beside it, and a
project asked why. The comment defending the scale-up says *"≥1.4× on the
**figure**"* — and the code applied it to the ticker too. All three columns are
the same width (`colW` is one value); only the height differs. So a bigger name
buys no legibility and costs the card set its typographic consistency.

`tickSize` is one value now. `pctSize` keeps the 68/44 split, because that part of
the reasoning stands. Rank is still carried six ways — elevation, the
`#1 · Top gainer` chip, the gold ring, the medal, the larger avatar, and the
figure. A name is an IDENTITY; three identities at three sizes reads as three
different designs.

### The board lost the X handle the bot already had

The caption read `#巨兽BEHEMOTH +4336%` with nothing to click. `boardCoin` reads
`t.links.twitter` (the website's row) while `listingCoins` reads `row.twitter`
(what the project typed on its listing form) — **not equivalent**, and the board
is preferred, so a token the site has no link for lost its credit entirely.

- **`enrichHandles()` fills only what is MISSING**, from the listing store, after
  the ranking has cut the pool to ≤ `MAX_SLOTS`. The board's own value always
  wins; this must never rewrite an attribution the site is asserting.
- **One request, and only when it can change something.** A failing lookup loses
  the handle, never the banner.
- ⚠️ **It REPORTS what it did.** The first cut swallowed the outcome in a
  `log.debug`, so when the caption still came back with no handles the only thing
  anyone could say was *"it did not work"* — three tokens with no X on file, a
  failed listing lookup, and a chain key that did not match all look identical
  from Telegram. `{ filled, noHandle, notListed, failed }` reaches the preview
  card and an INFO log line. A level nobody prints is the same as no line at all,
  and an outage on our side must never be reported as "the project gave no X".
- **A bare handle is a handle.** The listing form is free text, so `xHandle` now
  accepts `@velvet_capital` and `velvet_capital`, not just a URL — while still
  rejecting the words a form collects instead of a blank (`none`, `TBA`, `n/a`).
  Widening that parser must not put `@TBA` on a public post.
- ⚠️ **A bare `@handle` in Telegram is a TELEGRAM username** — tapping it opens
  Telegram's user search, not X. The caption builds an explicit
  `[@handle](https://x.com/handle)`. `sanitizeVar` deliberately leaves `_` alone;
  escaping it would 404 every handle ending in one.
- The **tweet** text keeps a plain `@handle`: X has no link labels, and
  `[@x](url)` would publish its brackets verbatim.

```bash
cd bot && node scripts/run-tests.js test/gainersSample.test.js test/gainersFilters.test.js test/gainersIdentity.test.js   # 45 tests, no network
```

**Config a fix depends on:** nothing — but `minMcapUsd` is a live setting, so an
operator who wants the old unfiltered board sets it to `0`.

### "presentase kenaikan bisa di on ofin" — one switch, three surfaces

Asked with a screenshot of the Top Gainers post: the banner carrying
`+2163%` and the caption repeating it under every ticker. The operator wants
to be able to publish the RANKING without the FIGURES — and the caption
builders already took a `showPct` that nothing wired (`listMarkup` and
`listText` both defaulted it to `true` and no caller ever passed it), which is
how a half-feature sits in a codebase for a year: it looks done from inside
the module.

- **ONE boolean, `showPct`, in `gainersConfig`** — read by the daily poster in
  the main bot and by the preview/post/tweet in the admin bot, and handed to
  the artwork, the Telegram caption and the tweet together. Three switches
  would eventually disagree, and a banner shouting +2163% under a caption that
  says nothing leaves the reader deciding which one is true.
- **The artwork decides it ONCE.** Every layout draws the figure off
  `c.pctLabel`, and `bigPct`/`pctChip` draw nothing for `""`, so the switch is
  applied where the label is made rather than in seventeen call sites — a
  layout added later cannot forget it. ⚠️ **It rides a COPY of the spec**: the
  shipped spec objects are shared by every render, and stamping the flag onto
  one would let the preview and the daily post, rendering at once, read each
  other's setting. Pinned by a test that runs two renders concurrently.
- **The list5 gain BAR goes with the figure.** It is the percentage drawn as
  LENGTH, and keeping it while hiding the number would publish the figure by
  another route. Its heading goes too, and so does every board's `24h`
  column heading — grid10 shipped with an empty column under a `24H` heading
  on the first cut, found by LOOKING at the render — and the market cap takes
  the edge so the table reads as two columns rather than two with a hole.
- **The sparklines STAY.** They are normalised to their own span and carry
  direction only, never the number.
- **The space is left, not re-composed.** A card designed around a 102px
  figure has a quieter middle with it gone; re-flowing eleven layouts for an
  optional figure is a design pass judged by looking, and what was asked for
  is on/off. Recorded so it is not rediscovered as an oversight.
- **The panel says so twice**: a `📈 % gain on banner + caption` toggle under
  ⚙️ Settings, and `% hidden` in the home screen's filter line — the preview a
  tap away renders without a single figure, and an admin who inherited the
  setting would read that as the numbers having gone missing.
- ⚠️ **A HEADING IS NOT ONE `fillText`.** `microLabel` tracks its letters by
  hand — one draw PER GLYPH — so the first guard, a predicate on whole strings,
  matched nothing and passed vacuously over grid10's stray heading. The test
  re-joins single-glyph draws into runs and counts `24H` mentions against
  hero1's (the layout with no board) rather than against zero, because the
  header strip legitimately says `LIVE · 24H` on every template. A guard that
  cannot see what the renderer does is `fonts:check`'s nine green ticks again.

#### "masih blm ada setingnanya" — the setting was two screens from the decision

Reported with a screenshot of the PREVIEW card — `👀 Preview — 🔟 Top 10 Grid`,
the caption above it carrying `+279% · +192% · +139%`, and the buttons `Post ·
Swap · Refresh · Another layout · Cancel`. The switch had shipped under
⚙️ Settings, which is Back → Settings from there: two screens away from the
one place an admin is looking at the figures and deciding whether to publish
them. **A setting that is not where the decision is made is a setting the
operator reports as missing**, and they did — the same distance that put the
snipe panel's refusal off screen, on a different panel.

- **The card carries the switch** — `📈 % gain: ON → hide` / `OFF → show` —
  and the label states the CURRENT state and the tap's effect, because a
  bare toggle on a card reads as a question about what it is currently doing.
  One store behind both buttons (`gn_pvpct` and ⚙️'s `gn_pct` both write
  `showPct`), or the card and the settings screen would come to disagree.
- ⚠️ **The tap re-renders the SAME SAMPLE.** A re-sample here would make
  "with %" and "without %" two different rankings — the Top-3-not-a-prefix-
  of-Top-5 defect this preview was rebuilt to end, reintroduced by a
  presentation toggle. `fresh: false`, the swap's rule. ⚠️ And the first
  mutant written for it SURVIVED: `fresh: true` on a live session also reuses
  the sample — only `"force"` re-samples — so that mutant was behaviour-
  neutral. The two real mutants are `"force"` (re-sample every tap) and
  `false` always (a tap with no sample renders *"Nothing to post"*, which
  reads as the switch having broken the feature); each has its own driven
  test and each is killed.
- **The card says when the figure is hidden**, above the buttons, because the
  caption over it carries no percentages and the artwork none — an admin who
  inherited the setting would read that as the numbers having gone missing.

```bash
cd bot && node scripts/run-tests.js test/gainersMenuWiring.test.js   # 16 tests — the card's switch is driven, not scanned
```

Ten guarantees are MUTATION-TESTED rather than argued: the label ignoring the
switch, the bar drawn regardless, a heading left ungated, the spec shared
instead of copied, the poster's caption and the panel's preview each forgetting
the switch, the caption builder ignoring it, `set()` not persisting it, the
button wired to nothing, and the switch defaulting to hidden. Each fails
between one and two tests.

```bash
cd bot && node scripts/run-tests.js test/gainersPct.test.js test/gainersMenuWiring.test.js   # 22 tests, no network
cd bot && node scripts/gainers-preview.js --no-pct                                            # every layout as the OFF setting publishes it
```

**Config a fix depends on:** nothing — it ships ON, which is what every install
publishes today. This touches `bot/` only, so the deploy is the ecosystem
restart and no web rebuild.

## "Beberapa token tidak punya logo" — and a guess that outranked the answer

Reported with a screenshot of the board: `$BTCB`, `$SHIB`, `$TRUMP` drawing the
site's `BT` / `SH` / `TP` monograms — the right fallback, and the wrong thing to
have to draw for projects whose artwork sits on four public indexes.

**The monogram was not the bug; the ladder above it was.** `rowToBoardToken`
fills every row's `logoUrl` with `fallbackLogoUrl()` — the DexScreener CDN
CONVENTION, a path we construct and that 404s for anything that CDN has never
seen — and the board then merged live market data with
`logoUrl: t.logoUrl ?? m.logoUrl`. On any chain with a DexScreener id that guess
is never null, so **the `??` could never reach its second operand**: a made-up
path permanently outranked the real `image_url` both GeckoTerminal and
DexScreener were already handing us, and the row rendered a monogram with a good
logo sitting one field away.

- **`pickLogo()` is the one owner of "which logo does this row render".** Four
  rungs, and the order is what the whole section is about: **stored** (an admin
  set it, or the project uploaded it) → **live** (a market provider asserted it
  this cycle) → **resolved** (our own resolver verified it) → **convention**
  (the CDN path, unverified, LAST). A guess must always lose to an answer.
- **`kind` is not decoration.** `"convention"` and `"none"` are how the pipeline
  knows a row is still effectively logo-less and belongs in the resolver's
  queue; without it "has a logoUrl" is true of every row and nothing can ever be
  queued.
- **A live logo is REMEMBERED even though it cost nothing.** GT drops
  `image_url` on the odd cycle, and without that memory the row flickers back to
  a monogram whenever it does.

### The resolver, and why the site has one when the bot already does

`bot/src/services/tokenLogo.js` is the richer resolver (seven sources — it can
reach the launchpads and Trust Wallet) and it is **not** duplicated here in
spirit: the site's is the same idea with the sources the site can reach. What
the site adds is that it runs BY ITSELF. The bot's runs from
`npm run listings:fix`, a script an operator has to remember — and this repo has
already paid for that shape: *"apt-get install is not a fix, it is a request"*
cost six days of banners publishing boxes. A row listed today gets its logo
today, or the monogram comes back with the next listing.

- **Four sources, ordered by how much each KNOWS about the token**: DexScreener
  pair info → GeckoTerminal token → CoinGecko by contract (curated: a human has
  looked at this one) → the DexScreener CDN convention.
- ⚠️ **EVERY CANDIDATE IS FETCHED BEFORE IT IS BELIEVED.** The convention can
  always be constructed and is very often a 404; storing one unverified turns
  "no logo" into "broken image", which is worse — the monogram at least looks
  deliberate. `isImage()` tries HEAD then GET (some CDNs answer HEAD with 405
  while serving the file perfectly well) and refuses a 200 carrying HTML, which
  is what a CDN returns when it does not want to admit a miss.
- ⚠️ **`ok:true, url:null` and `ok:false` are DIFFERENT ANSWERS.** The first is
  "every source answered and this project has no artwork" — the only state in
  which the sweep may remember a miss. The second is "an upstream could not be
  asked", and caching that as "no logo" is how one rate-limited minute leaves a
  token monogrammed for good. `logoFill.ts` keeps them apart: a miss is
  remembered for 12h, an undecided for 30 min — and the 30 min is a RATE LIMIT
  ON US, not a claim about the token, or one dead upstream would eat every
  sweep's budget for ever.
- **CoinGecko is PACED** — one call at a time, 2.5s apart, `Retry-After` honoured
  once. Its free tier is per IP and the bot suite is on the same box; the bot's
  own resolver learnt this when a 429 on row one reported eighty-two rows as
  undecided.
- **The sweep is FIRE-AND-FORGET and bounded** (8 tokens per pass, one pass at a
  time). A board render must never wait on three rate-limited APIs plus a
  verification fetch; logos appear on the next refresh, a minute later.
- **What it finds is PERSISTED** (`setResolvedLogo` → the listing store, mirrored
  to Mongo), so a row is fixed for good rather than for one process's lifetime —
  and the bot's board and channel posts get it too, since they read the same
  store. ⚠️ It can only ever turn nothing into something: an admin-set logo is a
  decision somebody made, and that asymmetry is what makes the write safe from a
  background sweep nobody is watching. The rule is a PURE function
  (`lib/logoWrite.ts`) because "never overwrites" is a mutation property and a
  source scan cannot tell a guard from a comment about one.
- **`coingecko` joined the chain registry.** Nothing outside `config/chains.ts`
  may hardcode a chain id, and a new chain now has to decide rather than inherit
  `undefined`. A wrong platform id costs one source (a 404) and never a failure.

### …and the proxy was refusing logos we already had

`/api/logo` exists because CDNs hotlink-block, and its allowlist is therefore
part of "every token has a logo", not only of security: **a host missing from it
is a real, working logo url rendered as a monogram** — refused by us, silently,
with nothing in the UI to say so.

- **`ipfs://` was handed to the browser verbatim.** No `<img>` anywhere loads
  that scheme, so a token whose artwork we HAD still drew a monogram. `logoSrc`
  now routes every non-relative scheme to the proxy, which rewrites `ipfs://` to
  a gateway.
- The allowlist carries where token artwork actually lives: the two indexes, the
  curated ones, the wallets' asset repos, and the IPFS/Arweave gateways every
  launchpad mints through (pump.fun's own is `pump.mypinata.cloud`).
- ⚠️ **Redirects are followed BY HAND, and every hop is re-checked.**
  `redirect: "follow"` hands the guard's whole job to the upstream: an allowed
  host answering `302 http://169.254.169.254/…` would have this server fetch its
  own cloud metadata and serve the bytes back.
- An SVG is a DOCUMENT when opened directly and can carry script. Refusing SVGs
  would drop real logos, so they are served inert instead (`nosniff` + a CSP
  that lets the file reference nothing).

```bash
npm test    # tokenLogo / logoFill / logoWrite / logoPipeline — 56 tests, no network
```

**Config a fix depends on:** nothing. `CG_MIN_GAP_MS` widens the CoinGecko gap
if that box ever needs it.

## "Token harus punya chart candle bar" — the chart was a hash of the ticker

The token page had two chart states and both had to go.

With a pool address it embedded **GeckoTerminal in an iframe**: charts fine, and
it is someone else's page inside ours — another brand's type and colours, its own
spinner, and no way to read one number out of it for anything else on the page.

Without one it drew `syntheticTrend(symbol, chg24h)` — **a curve generated from
the ticker's hash** — full width, under the words "Price trend". On a 34px
sparkline that is decoration. At 640×120 on the page a person opens to decide
whether to buy, it is a claim about a market that nobody measured, and this repo
refuses a printed `0.00%` for an unreadable change. A drawn price history is the
same lie with more pixels.

`/api/ohlcv` + `components/CandleChart.tsx` replace both: real candles, volume,
five timeframes, a crosshair readout, in the site's own type and colour.

- ⚠️ **The candles are asked for OUR TOKEN, not the pool's base side.** GT's
  OHLCV defaults to `base`, which is our token only by luck — in a WETH/OURTOKEN
  pool it is WETH, and the page would draw Ethereum's chart under a memecoin's
  ticker. That is a WRONG number rather than a missing one, which is the worse
  of the two. The bot's `changeFromCandles` names the address for the same
  reason.
- **A 404 is an answer about the pool; a 429 or a dead socket is not.** Only the
  first is cached — caching the second would let a two-minute backoff blank every
  chart on the site for the TTL.
- **A caller's pool address is a HINT.** The token page passes the pool GT named,
  but a preview built from DexScreener carries a PAIR address GT has never
  indexed, so a 404 on the hint sends us to resolve the pool GT does know.
- **`topPoolAddress` is the ONE owner of "which pool do we chart?"** — `/api/pool`
  and `/api/ohlcv` both need it, and two copies would drift into two
  plausible-looking pool addresses with nothing to say which is right. It picks
  the DEEPEST pool, never whichever the upstream listed first: a token seen
  through a thin pool reads as a different asset.
- **"No pool indexed yet" and "we could not read it" stay different sentences.**
  An empty grid gives the reader the same reaction to both.
- **A poll that fails never blanks a chart that is already drawn.** The pool did
  not stop existing because one request did not land.
- **`normalizeCandles` is pure and sorts by timestamp**, drops zero/negative
  prices (one zeroed close flattens every real candle beside it), keeps a zero
  VOLUME (a quiet 5 minutes is a fact), refuses a future stamp, and widens a wick
  to contain its own body rather than clamping the body — every reported number
  stays visible.
- **Every drawn number is measured over the window that is DRAWN.** The visible
  window narrows to what fits (160 candles across a phone's 330px plot is a 1.6px
  body — a smear), so the percentage is computed over the same candles, and it is
  labelled `over 40h`: the page header carries a 24h figure directly above it.

### "Kalo token belum listing hapus chartnya"

The unlisted token page — what `/token/<chain>/<ca>` shows for a contract nobody
has listed — charted too. It was added for a good reason (every buy-bot alert
links there, the buy bot is free and runs on ANY contract, so for most arrivals
that IS the token page) and removed for a better one, on the owner's call.

**The page is reachable by pasting any contract at all.** So every visit polled
`/api/ohlcv` for a token that is not on the site, out of the ~15 req/min
GeckoTerminal share the web app splits with the bot suite on this box — a listed
customer's chart competing for the ceiling with an unlisted stranger's. Charting
is what a listing buys.

- **The price and market cap STAY**, and the difference is what they cost: they
  ride ONE cached `/api/token-preview` request the page already makes, where a
  chart is a fresh poll per visit. They are why a visitor off a buy alert reads
  the page as a product rather than a 404, which is the whole reason the dead
  end ("Only paid listings appear here" plus a Back button) was replaced.
- ⚠️ **Two removals, two reasons, and collapsing them is how one comes back.**
  The third-party **EMBED** was banned separately, because it sat on "Loading
  chart settings…" for seconds and then planted a competitor's logo and wordmark
  across a Dexvra page. That ban is not what was relaxed, and the test asserts
  both independently — plus the CandleChart component's own no-iframe guard,
  which moved to `chartRoute.test.ts` now that this page no longer mounts it.
- **A deleted feature leaves a note where it was.** With no trace, the next
  person to notice this page has no chart simply adds one back — and the quota
  it spends is invisible from the page itself. A test pins the note.

```bash
npm test    # unlisted / chartRoute — 311 tests, no network
```

**Config a fix depends on:** nothing.

### It is judged by LOOKING at it, so there is a script that renders it

Three defects got through the unit tests and a source scan, and all three were
found in a PNG: a price label sitting under the last-price tag, a phone window
smeared into unreadable bodies, and — the one worth remembering — a time stamp
clipped to a **wrong time**, `3:46` for `23:46`.

⚠️ **A CSS declaration beats an SVG presentation attribute.** The renderer sets
`textAnchor` per label so the first and last stamps stay inside the plot;
`.ck-axis-x{text-anchor:middle}` in the stylesheet silently overrode it. The
stylesheet no longer states an anchor, and a test fails if one comes back.

```bash
npm run build && npm start &
npm run chart:preview     # every chart state, rendered and checked; non-zero on failure
```

It stubs the upstreams IN THE BROWSER, so it runs on a box with no egress —
including the empty and unreadable states, which are the two nobody remembers to
look at. ⚠️ The context must block service workers: a SW-served request never
reaches the stub, and the second page load would quietly chart whatever the real
server said.

**Config a fix depends on:** nothing. `GECKOTERMINAL_API_KEY` is not read by the
web app; the chart shares the same free quota as the rest of the site, which is
why each timeframe caches for its own interval and the client polls no faster.

### The IP was the ceiling, and the web app had SIX doors onto it

The first live request after deploying the chart answered
`(GeckoTerminal 429)`, and a bare `curl` to GT from the same box answered 429
too. So this was never a chart bug: **GT's free tier is ~30 requests a minute
counted PER IP**, the bot suite lives on that same box, and the web app had
just started asking for candles on top of it.

What the web app was doing to itself is the shape `bot/src/group/gtPairs.js`
warns about in its own header — *"Two modules with their own fetch and their own
backoff means one of them keeps hammering through a 429 that the other has
already noticed"* — except it had **six**: the market pipeline, the pool
resolver, the candles route, the trades feed (polled every ~12s by every open
token page), the token preview and the logo resolver. Each with its own base,
its own headers, its own idea of failure, and no key support at all.

`src/lib/providers/gt.ts` is the one client now, and it is the bot's rules
transplanted:

- **A 429 from ANY caller silences ALL of them** for `GT_COOLDOWN_MS` (120s,
  the bot's number, so there is one figure to reason about across two processes
  on one IP). While it holds, `gtGet` answers *"rate limited — cooling down for
  Ns"* **without making a request**, and every caller treats that as "could not
  ask" — never as "nothing there". That last part is what stops a rate limit
  being written permanently into the listing store as "this project has no
  logo".
- **A 5xx or a timeout does NOT arm it.** Those are per-request failures and say
  nothing about the quota; arming a process-wide cooldown for one slow pool
  would take every chart on the site down for two minutes.
- ⚠️ **The cooldown is re-checked AFTER the pacing gap.** A request that waited
  its turn may have been overtaken by a 429 armed by whatever went out ahead of
  it, and firing it anyway is how a cooldown gets extended.
- ⚠️ **A 429 now ends the market cycle's remaining chunks**, where before it
  skipped one chunk and carried on. The old behaviour only ever "worked" in a
  mock: a 429 means the IP is over its ceiling, so the next chunk is another 429
  that extends the window. The tokens that miss out do not go blank —
  DexScreener prices the leftovers and `fillFromLastGood` covers the rest.
- **The chain's error is the FIRST failure, not the last.** Once a 429 arms the
  cooldown every later chunk fails with "cooling down", and reporting that would
  hide the 429 that caused it.
- **`GECKOTERMINAL_API_KEY` is read by the web app now**, exactly as the bot
  reads it: the key switches the base to the Pro one and sends
  `x-cg-pro-api-key`. It is the only real way past the ceiling.
- **The boot line says which tier is in use** and never the key
  (`[gt] PUBLIC free tier (~30 req/min per IP…)`), because "the chart is empty"
  looks identical from outside whether the ceiling is 30/min or the Pro tier's.
  Same reason the trade bot prints `rpc PUBLIC default (rate-limited)`.

```bash
npm test    # gt / geckoterminal — the cooldown, the key, the chunk rules
pm2 logs dexvra --lines 50 --nostream | grep '\[gt\]'   # which tier this box is on
```

**Config a fix depends on:** `GECKOTERMINAL_API_KEY` in the **repo-root** `.env`
(`/opt/dexvra/.env` — the web app does not read `bot/.env`). Until it is set the
site stays on the shared free tier and a busy minute still ends in a cooldown;
everything degrades honestly, but the ceiling is the ceiling.

### …and the bot was the one spending it — "chartnya mana"

The web app was cut back six ways and the charts still came back
`(GeckoTerminal 429)`. Everything above is about the web app's SHARE of the
ceiling, and the web app was never the one eating it: the bot suite on the same
box was, and it had no idea the website existed.

**The ceiling is per IP, so the two processes' budgets have to ADD UP TO IT.**
`GT_MAX_RPM` defaulted to 25 against a ~30/min ceiling — "comfortably under",
and true for as long as the bot was the only thing on the box. It has not been
for a while. Three changes, and the first two are the same rule in two modules:

| where | was | is |
| --- | --- | --- |
| `pumpChecker` | `fetchMarket` — GT-first, every approved listing, every 3 min | `fetchPrice` — DexScreener first |
| `gtPairs.fetchPool` | GT first, DexScreener as fallback | DexScreener first where it indexes the chain |
| `GT_MAX_RPM` default | 25 (a solo ceiling) | 15 (half of 30 — a SPLIT) |

- **A PRICE has two free sources; a CANDLE has one.** That asymmetry is the
  whole argument. GeckoTerminal is the only free OHLCV for arbitrary DEX
  tokens, so a request spent there on a number DexScreener also publishes is a
  chart that does not draw. `fetchPrice` is for callers that read `priceUsd`
  and `mcap` and throw the rest away; `fetchMarket` stays GT-first and is still
  right for anything publishing a 24h change, liquidity, a pool address or a
  logo — GT is the better source for all of those, and on Robinhood/Plasma the
  only one.
- **It is one ORDER, not a second client.** `fetchMarket(chain, addr,
  { cheap })` reuses the same two readers and the same merge; a third private
  answer to "is GeckoTerminal up" is what this repo keeps paying for.
  ⚠️ And the cheap pass must REUSE a DexScreener *miss* rather than re-ask —
  `dsFirst || await fetchDS(…)` re-asks on every miss, because a miss is null,
  which doubles the load on the source the change exists to prefer.
- ⚠️ **A stored pump baseline is now compared against the other source — and
  that is not new.** `fetchMarket` has always fallen through to DexScreener
  while GT was cooled down, so a GT-recorded baseline has been measured against
  DexScreener readings intermittently, flipping poll to poll. Reading one
  source consistently is steadier than alternating, and the ladder's floor is
  +100%: a source disagreement large enough to fabricate a step is the poisoned
  pool `pickTrusted` already catches.
- **The buy bot's interval was NOT lengthened, and the measurement is why.**
  That was the plan — and `BUYBOT_POOL_MIN_MS` turns out not to be a GT knob
  any more. Detection comes off the chain (`group/chainTrades.js` reads the
  pool's own Swap events on every EVM and Solana chain), and the metadata read
  is capped by `META_TTL_MS` at one a minute per pool however fast the loop
  runs. So lengthening it would have bought alert latency for almost no quota.
  What the buy bot actually spends GT on is that metadata read — hence the
  source order, which costs nothing at all.
- **A `[gt]` boot line in the bot too**, beside the build sha, because the two
  lines together are the only way to see how the one allowance is being split.
  The KEY is never printed; it would land in pm2's log.
- **`buybot:check` names the neighbour.** It used to advise checking "whether
  you are sharing an IP with something else hitting GT's ~30 req/min" — which
  sent an operator hunting for a stranger. It is the website, on this box, and
  a diagnostic that knows the answer should say it.

```bash
cd bot && node scripts/run-tests.js test/gtQuota.test.js   # 11 tests, no network
pm2 logs dexvra-bot --lines 50 --nostream | grep -F '[gt]'  # the bot's half
pm2 logs dexvra     --lines 50 --nostream | grep -F '[gt]'  # the site's half
```

⚠️ **This touches `bot/`, so the deploy is the ecosystem restart, not just
`pm2 restart dexvra`** — see "Two bot processes, one config".

**Config a fix depends on:** nothing. `GECKOTERMINAL_API_KEY` is still the only
thing that raises the real ceiling rather than dividing it; until it is set,
30/min is 30/min and this only decides who gets which share.

### "apakah anda yakin, coba audit" — six of these were in the FIX

Asked straight after the two features above landed, and the answer was no.
Every defect found is one of this file's own recurring shapes, reintroduced by
the code written to stop it.

- ⚠️ **A 429 FROM COINGECKO COST ONE CALL PER ROW, AND THE BOT PAYS THE SAME
  BILL.** The sweep paced its calls and then, on a rate-limited minute, spent
  every remaining row proving the same refusal — sixteen requests into a service
  that had already said no, every one of them landing as "undecided" anyway. A
  429 now arms a PROCESS-WIDE cooldown and the rest of the sweep is not asked at
  all. `bot/src/services/tokenLogo.js` states the identical rule about
  GeckoTerminal's cooldown and names what ignoring it cost: *"one rate limit
  deleted eighty-three rows' worth of evidence."*
- **CoinGecko was asked even when DexScreener had already answered.** It is the
  paced, per-IP, shared-with-the-bot one; a call made when the artwork is
  already in hand is a call the next row does not get. Two waves now: the two
  indexes together, then CoinGecko only if they came up empty.
- ⚠️ **`status: "ok"` WITH NO GEOMETRY DREW NOTHING AT ALL** — no chart, no
  message, no error. `box` starts at `{0,0}` and only a ResizeObserver callback
  filled it, so a context without one rendered a blank panel for ever, which
  reads exactly like a chart still loading. It measures immediately now, and
  "we have candles and cannot draw them here" is its own sentence. The live dot
  was showing over that blank panel too: the reassuring reading of a state that
  was not.
- ⚠️ **The cache key was built from an UNVALIDATED chain.** `/api/ohlcv` checked
  the chain inside its loader, i.e. after `ohlcv:<chain>:…` had been handed to a
  cache with no bound and no eviction — a memory leak anybody could drive from a
  query string, for answers nobody could use. The chain is checked first now,
  **and `lib/cache.ts` is bounded** (1200 entries, evicted by last-write order,
  never by expiry — an expired entry is still the stale copy that keeps a
  provider outage from emptying the board).
- **An EMPTY candle list from a hinted pool ended the lookup.** A DexScreener
  pair address can be a real-but-thin GT pool that has never traded on that
  timeframe; reporting "no candles" for it hid the deep pool with a year of
  them. An empty answer now re-resolves, and a worse answer from the deeper pool
  never replaces candles the hint already gave us.
- ⚠️ **A comment described a ranking that did not exist.** "the board hands them
  over ranked" — it handed them over in whatever order the store held. The sweep
  looks up eight rows a pass and a board can be eighty short, so the order is a
  decision: featured rows first, then by 24h volume.
- **`//host/logo.png` was treated as same-origin.** It starts with a slash and
  loads from a stranger's server — the one url shape that looks local and is
  not. It goes through the proxy now.
- **Bodies nobody was going to read were left open.** `isImage`'s GET, the
  proxy's redirect hops and its wrong-content-type path all abandoned a response
  body, which keeps the socket busy until the GC gets round to it on a server
  doing this per token. All three release now, and an image declaring more than
  3MB is refused before it is downloaded rather than after.
- **`cloudfront.net` came off the proxy allowlist.** It would have made us an
  image CDN for every AWS customer alive — somebody else's bandwidth and
  somebody else's content, served from our domain.
- Two of the new guard tests were asserting on CHARACTER DISTANCE between two
  lines, so adding a comment between them failed the build. A test about
  formatting is not a test about behaviour; both compare positions in the
  comment-stripped source now.

**One consequence worth knowing about:** an admin who CLEARS a listing's logo
will see the site resolve one again, because an empty `logoUrl` is exactly the
state the sweep exists to fill. To pin a different image, set it — a stored
logo always wins. There is deliberately no "this token has no logo" flag: the
monogram is what a row with no artwork draws, and it is drawn from the ticker.

### "tambahkan logo project nya" — the only tool that filled them also deleted rows

Reported with a screenshot of the home board, `$TRUMP` drawing its `TP`
monogram (2026-08-26). The resolver was not the gap: `listings:fix` already
reaches **seven** sources. What was missing is that the same run **removes every
row it could not find artwork for**, and `--logos-only` does not change that —
it skips the dedupe pass, not the deletions. So an operator who wanted logos
filled had no way to run it without also losing tokens.

- **`--keep` is the opt-out, and the delete stays the DEFAULT.** It answers an
  earlier request in this script's own header (*"jika tidak ada logo hapus aja
  tokenya"*), and quietly reversing that would surprise whoever relies on it.
- ⚠️ **`--keep` is TOTAL.** A flag that spared the logo pass and still dropped
  duplicates would be the reassuring reading of its own name — this file's most
  expensive recurring shape. Mutation-tested: reinstating that one delete fails
  the test.
- **The rows that finish with no artwork are NAMED, with their address.** A
  count sends the operator back to the board to work out which — a diagnosis
  with no hands attached is a bug report the code files against its owner.
- **The header says which mode the run is in before it does anything**, in the
  dry run too.
- ⚠️ **Nothing here can be verified from a sandbox.** DexScreener, CoinGecko and
  GeckoTerminal are unreachable from the dev environment, so whether a logo
  exists is a property of the SERVER's egress today — the rule `raid:check`,
  `launchpads:check` and `fonts:check` already state. The script prints the
  build stamp twice for the same reason.

```bash
cd bot && npm run listings:fix -- --logos-only --keep            # dry run: what would be filled
cd bot && npm run listings:fix -- --logos-only --keep --apply    # fill them; delete nothing
cd bot && node scripts/run-tests.js test/fixListingsKeep.test.js # 6 tests, no network
```

### "jangan ambil dari gecko terminal" — the cleanup was starving the buy bot

Sent while the operator watched their own production stop, over and over, in
the middle of the logo run:

```
WARN [buybot] GeckoTerminal backing off for 120s — HTTP 429 (rate limited).
Buy alerts are paused process-wide until it lifts.
```

`resolveLogo` asked all five sources **concurrently, for every row**. So a token
whose artwork DexScreener already had still spent a GeckoTerminal request —
and 463 listings is 463 requests into a ~30/min **per-IP** ceiling shared with
the running bot. The cleanup was not slow; it was eating the thing it shares.

- **Two waves. The free sources first.** DexScreener (no tight limit), the
  launchpad (pump.fun and friends, artwork from the token's first minute),
  pools.trade, and Trust Wallet's constructed GitHub path. Most rows are
  answered here and **never reach the metered ones at all**.
- ⚠️ **GeckoTerminal is DEFERRED, never dropped.** On ROBINHOOD it is one of
  only two places the artwork can be — DexScreener does not index that chain
  and CoinGecko has no platform id for it — so never asking it would turn "we
  did not look" into a permanent `undecided` for a whole chain. Asking it last
  is the fix; not asking it is a different bug.
- **The site's resolver has always done this** (`src/lib/providers/tokenLogo.ts`
  states the rule in its own header: GT "is only asked when 1 and 2 came up
  empty"). The bot's never learnt it — two resolvers, one lesson, learnt once.
- **The CONVENTION stays last of all.** `dexscreener-cdn` is a path we build,
  not an answer anybody gave: a guess must always lose to an answer.
- Mutation-tested — restoring the single concurrent wave fails four tests, two
  of them tests that predate this change.

```bash
cd bot && node scripts/run-tests.js test/tokenLogo.test.js   # 28 tests, no network
```

**Config a fix depends on:** nothing — but `GECKOTERMINAL_API_KEY` in
`bot/.env` is still the only thing that raises the real ceiling rather than
dividing it, and a cleanup over hundreds of rows is exactly when that shows.

### "punya logo pas listing, skrg sudah ilang" — two ways a row loses artwork it HAD

Reported with a screenshot of `$BREAKING`'s token page (2026-08-26): a paid
Solana listing, five days old, drawing the site's `BR` monogram. Every section
above is about a row that never had a logo. **This one had one, and lost it**,
which is a different failure and needed a different answer — and the two causes
found are both the same shape, a value deleted by something that was not asked
to delete anything.

#### 1. A RE-LIST ERASED IT

`addListing` treats a chain+address it already holds as the same listing and
keeps its id — and then wrote the incoming row over the stored one **whole**:

```js
created = { ...rec, id: rows[dupIdx].id, … };   // rec, not a merge
rows[dupIdx] = created;
```

`buildRow` renders an absent optional field as `undefined`
(`logoUrl: input.logoUrl ? … : undefined`). So every re-POST of a token the
site already carried **deleted whatever it did not re-supply**: the logo the
project uploaded on the listing form, their socials, the overview — and
`trendingRank` / `trendStart` / `trendExp`, i.e. a trending window somebody had
paid for, ended mid-flight.

There are four callers that re-POST an existing token in the ordinary course of
business — a second purchase through `fulfillListing`, `autoLister`, the board
filler through `createFromInfo`, a project re-submitting the public form — and
none of them carries a logo it was never given.

- **`src/lib/relist.ts` is the rule, and it is "ABSENT MUST NOT ERASE", not
  "never change".** A re-list that carries a value still wins: an operator
  re-listing with new artwork gets the new artwork. What it may no longer do is
  turn something into nothing by saying nothing — the same asymmetry
  `applyResolvedLogo` is built on, pointing the other way.
- **Clearing a field is the PATCH path's job.** `sanitizePatch` reads `""` as
  "clear this" precisely because an edit can mean it; a create that arrives
  without a field is not a statement about that field. A blank string counts as
  absent here for the same reason — it is what an untouched form field becomes.
- **The guard lives at the STORE, not at the caller.** `deleteListing`'s own
  header already says why: *"a caller can be wrong about what it is holding,
  and the store cannot."* The DELETE path has refused to touch a paid listing
  for months; the CREATE path was destroying the same rows.
- Pure and mutation-tested — reinstating the wholesale overwrite fails
  `logoPipeline.test.ts`.

#### 2. THE UPLOADED FILE IS GONE, AND TWO CORRECT GUARDS HELD THE DEAD URL IN PLACE

An uploaded logo is `/api/media/<24hex>.png`, written to `data/uploads/`.
`data/listings.json` is mirrored to Mongo and restored from it — store.ts says
so at the restore path, *"fresh container after a VPS reset"* — and
**`data/uploads/` is not mirrored at all.** So a box that loses its disk comes
back with every listing intact, every one still asserting its `/api/media/…`,
and not one of those files on disk.

⚠️ **And the row is then monogrammed FOR EVER**, by two rules that are each
right on their own:

| rule | why it is right | what it does here |
| --- | --- | --- |
| `pickLogo` ranks `stored` first | somebody CHOSE that image | the row reads as "has a logo", so the resolver never queues it — the queue is `convention \|\| none` |
| `applyResolvedLogo` never overwrites a `logoUrl` | it is what makes a background sweep safe | even a logo resolved in memory could never be persisted |

- **A stored upload with no file is not a stored logo** — it is a 404 wearing
  the shape of a decision, and it loses to every rung below it.
- **ONE directory listing per board rebuild**, not one stat per row: the board
  reprices ~200 rows every 60s.
- ⚠️ **"The directory could not be READ" is not "the files are gone."** An
  unmounted volume, a permissions change and a container mid-restore all answer
  identically, and reading that as a deletion would strip the artwork off every
  paid listing on the site in one sweep. `lostUploads` reports **nothing**
  missing when it cannot look. A missing directory is empty (nothing was ever
  uploaded on this box); an unreadable one is unknown.
- **It can only ever clear an UPLOAD.** A CDN blip, a hotlink block or a rate
  limit are not facts about the token and none is knowable from this server;
  clearing an external logo would delete a project's artwork over a bad minute.
  An upload is on our own disk, so its absence is a local fact.
- **The row is cleared in the STORE too**, or the resolver's answer has nowhere
  to land — and it is said out loud once, because artwork disappearing off a
  paid listing is a fact an operator is owed even when the site heals it.
- **`UPLOADS_DIR` is one owner now.** Three files declared
  `path.join(process.cwd(), "data", "uploads")`, and it matters more once the
  board asks whether an upload is still there: a reader pointed at the wrong
  directory reports every paid listing's logo as lost. ⚠️ It deliberately does
  **not** honour `DATA_DIR` — `store.ts` does, so on a box that sets it the
  listings and the uploads already live apart, and teaching this path about it
  would move where the app LOOKS without moving the files.

#### …and the operator was the detector, so there is a check

Three things produce that monogram and the board renders all three identically:
the row lost its logo, the file is gone, or **our own proxy refuses a working
url** because its host is missing from `/api/logo`'s allowlist. They need three
different fixes.

```bash
npm run logos:check                       # every listed token
npm run logos:check -- solana VJdpSDD…    # the one somebody is asking about
npm run logos:check -- --bad              # only the rows that fail
```

- **It drives the RUNNING SERVER and pulls every logo through `/api/logo`** —
  the same url `logoSrc` hands the browser. Whether a CDN answers is a property
  of this box's egress today (the rule `raid:check`, `launchpads:check`,
  `fonts:check` and `chart:check` all state), and a check that reasoned about
  the url instead of loading it would print green over exactly the rows that
  draw monograms. It also cannot import `src/**/*.ts` — production runs Node 18,
  where that throws.
- **With `INTERNAL_API_TOKEN` set it also reads the STORED row**, which is what
  separates "this row lost its logo" from "this logo will not load". ⚠️ Without
  it the answer is genuinely ambiguous for a CDN-shaped url — the seed listings
  STORE that exact string — and it says so rather than guessing: the first cut
  reported *"nobody has given this token artwork"* over rows that had one.
- **`/api/tokens` carries the build stamp now**, for the reason `fonts:check`
  prints one: every round of this begins with somebody reading a check as a
  statement about the fix they just deployed.
- Non-zero when any row would draw a monogram, so green means "the board's
  artwork is safe" and not "the server answered".

```bash
npm test    # relist / mediaFile / logoWrite / logoPipeline
```

⚠️ **What could NOT be verified here.** The merge and both takeover locks are
proved end to end against a running server: a re-list with no optional fields
leaves the logo, the socials, the overview and a live trending window untouched
and one carrying a new logo still wins; a public submission for a live listing
answers 409 and changes nothing. The lost-upload healing is proved by its unit
rules and its wiring only: it runs inside `loadListedTokens`, which needs at least one
market provider to answer, and this sandbox has no egress — on a box where
every provider is down the board falls back to `rowsToBoardTokens` and the
ladder does not run at all. `npm run logos:check` on the server is how that one
gets measured.

**Config a fix depends on:** nothing. `INTERNAL_API_TOKEN` only makes the check
more specific. ⚠️ And the durability hole is still open by design:
`data/uploads/` is not in the Mongo mirror, so a lost disk still loses the
uploaded FILES — what changed is that the site now notices and re-resolves
instead of drawing a monogram for ever.

#### …and the first live run named a cause nobody had considered

`npm run logos:check -- solana VJdpSDD…` on the box, the moment it was
deployed:

```
· $BREAKING  solana  external  ipfs.io/ipfs/bafkrei…  HTTP 404
```

**404, not 400** — so the host passed the allowlist, our proxy reached it, and
the gateway simply did not have the CID. The row never lost its logo and the
url was never wrong. `/api/logo` held **one hardcoded IPFS gateway**:

```js
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
```

⚠️ **"Never one hardcoded host" is this file's own first rule**, written when
Jupiter retired `quote-api.jup.ag/v6` and every Solana buy died — and the logo
proxy had been breaking it since the day `ipfs://` support was added. A launchpad
pins its artwork wherever it pins it; asking one public gateway and giving up is
a coin toss per token.

- **`IPFS_GATEWAYS` is a LIST**, env-overridable (`IPFS_GATEWAYS=`), so a gateway
  going dark costs a line in `.env` rather than a deploy — the `pads.js`
  contract. Every entry is asserted to pass the allowlist, or the failover would
  build urls the guard then refuses: a fallback that cannot fire, which reads
  exactly like one that never helps.
- ⚠️ **IT FAILS OVER ON AN HTTP STATUS, WHICH THE STANDING RULE FORBIDS** — and
  that is deliberate, not an oversight. The rule says transport-only because
  *"an HTTP status means the host is there and answered, and the same request
  gets the same status everywhere else."* **That is not true of a
  content-addressed fetch.** A CID is the hash of the bytes, so another gateway
  serving that CID serves byte-identical content: a 404 is a fact about the
  GATEWAY, not about the token. A DexScreener CDN 404 still ends the lookup, and
  `candidates()` is the one place that distinction lives.
- **The gateway the caller named is tried FIRST.** A working gateway must not be
  demoted by a fallback list.
- **Bounded in tries and in TIME.** Without a deadline the worst case is every
  gateway's full timeout end to end, per token, on a board asking for two
  hundred.
- ⚠️ **A redirect somewhere we do not allow ends the whole request** rather than
  falling through to the next gateway: that failure is about US being pointed at
  something, not about the content being unavailable, and retrying elsewhere
  would bury it.
- ⚠️ **`logos:check` TRUNCATED THE URL ON THE ROWS THAT FAILED.** The column is
  elided to keep the table readable, and it elided the one line whose whole job
  is showing the url that broke — `ipfs.io/ipfs/bafkrei…` cut at exactly 46
  characters, which reads as a malformed CID rather than a clipped one. An
  operator cannot copy it, paste it, or tell the two apart. Same defect as
  `From $1,000,0…` on the row that exists to show a value. The full url now
  prints under any row that did not load.

**Config a fix depends on:** nothing — but ⚠️ **whether a given gateway serves a
given CID is a property of the server's egress and of what that gateway has
pinned today**, which is precisely why the list is env-overridable and why
`logos:check` measures it on the box rather than reasoning about it here.

#### "apakah anda yakin coba audit lgi" — and the worst one was not the logo

Asked straight after the above landed. The answer was no, and the largest thing
found is in the same function and is not about artwork at all.

⚠️ **ANYONE COULD UNPUBLISH A PAYING CUSTOMER BY TYPING THEIR CONTRACT INTO THE
PUBLIC FORM.** `/api/submit` is unauthenticated and calls
`addListing(row, { status: "pending" })`. On a duplicate, `addListing` keeps the
existing row's id — so the submission never created anything, it **took that row
over**: the status went back to `pending`, `approvedRows()` filters on
`approved`, and the listing left the site. Five times per IP per ten minutes.
Measured, with the route guard removed and only the store lock in place: the
row came back reading `$STOLEN`. It also replaced the name, and — because a
public submitter may pick a package tier — handed out whatever tier they asked
for.

**Two locks, because each one leaves the other's half open.**

- **The route refuses a duplicate outright**, 409, naming which state it is in
  ("already listed" and "already in the review queue" are different things to
  the person typing, and neither is their fault). One token, one listing — the
  rule the bot's own flow states *before* it will take a form
  (`listed.blockIfListed`). Refusing is the only answer that cannot be turned
  into an edit of somebody else's row.
- **`keepStatus` at the store: a create may PROMOTE a row, never demote one.**
  Demotion is still perfectly possible through `setStatus`, which is what an
  admin rejecting a listing calls. What may not happen is a row losing its
  standing as a *side effect* of somebody creating something. It is at the
  store for the reason `deleteListing`'s guard is: *a caller can be wrong about
  what it is holding, and the store cannot.*
- ⚠️ **And the form reported the refusal as a success.** `pay()` fired the
  request and forgot it (`void fetch(…).catch(() => {})`), wrote the local "My
  listings" record and went straight to *"Submission received!"* — so a 400, a
  429, a dead network and now this 409 all showed a project a green tick over a
  queue entry that does not exist. It awaits the answer now, shows the server's
  own sentence, and writes the local record only after the server takes it.

And four more, all this file's own recurring shapes:

- ⚠️ **`lostUploads` keyed its answer by trimmed URL and the caller asked with
  the raw store value.** `lost.has(row.logoUrl)` was therefore false for exactly
  the rows the module exists to find — and the test written for it **asserted
  the mismatch and passed**. Two normalisers for one lookup key; `mediaName` is
  the only one now, and `isLostUpload` is the only way to ask.
- ⚠️ **`logos:check` would have been RED FOR EVER.** It failed on any row
  drawing a monogram — but a board always carries rows nobody has made artwork
  for, and the resolver's backlog is not a fault. A check that is always red is
  worse than no check: it trains the reader to ignore the red, which is the
  state `chart:preview` sat in for weeks. It now separates **broken** (a stored
  logo that will not load, an upload whose file is gone, a url our own proxy
  refuses) from **nothing to draw yet**, and only the first turns the exit code.
- **The `needLogo.sort` comment had been orphaned** by the block inserted above
  it — left describing the wrong line, which is the "a comment describing
  nothing" this file names one section over.
- **`logos:check` carries a port of `logoSrc`** (it cannot import `src/**/*.ts`
  — production runs Node 18), and a port is a second owner. A guard pins the
  four branches in both files, because a check that fetched the raw url would
  print green over every logo `/api/logo` refuses — one of the three causes it
  exists to name.

```bash
npm test    # relist / mediaFile / logoWrite / logoPipeline — the two locks included
```

### "token morty tidak ada logonya padahal di dexscrener ada" — the guard was not asking the renderer's question

Reported with a screenshot of DexScreener showing `$MORTY`'s artwork beside our
board drawing its monogram. Every source in the ladder was working: DexScreener
handed us the url. **`isImage` threw it away**, and it threw it away for a
reason that had nothing to do with the file.

`isImage` probes `["HEAD", "GET"]` — but only a **405/501** ever reached the
GET. Every other HEAD outcome returned: a non-2xx status, a non-image
content-type, an exception. So a CDN answering HEAD with 403 (or 404, or an
HTML error page, or by hanging up) was written off — while `/api/logo/route.ts`,
which issues a **plain GET, exactly like the browser**, could fetch that file
the whole time.

- ⚠️ **A GUARD IS ONLY HONEST WHILE IT MEASURES THE STACK THE RENDERER USES.**
  This is the `fonts:check` lesson — nine green ticks over a banner publishing
  boxes, because `warnBoxes()` measured a font stack that renderer did not draw
  with — one module over and pointing the same way. Any HEAD outcome short of
  "yes, an image" is retried as GET now, and only GET's answer is final.
- **This is NOT "fail over on a TRANSPORT error only" being broken.** That
  rule's stated reason is that an HTTP status means the host answered and *the
  same request gets the same status everywhere else* — and **HEAD and GET are
  different requests** to the same host, which is the one case the reason does
  not cover. Same shape as the IPFS gateway list failing over on a 404: there,
  a CID is the hash of the bytes, so the status is a fact about the gateway; here
  it is a fact about the method.
- The cost is one extra request per REJECTED candidate, against unmetered image
  CDNs, and the sweep is capped at eight rows.

**And a verification we could not COMPLETE was being written down as an
answer.** `pick()` read `if (await verify(url))`, so a url we were handed and
then failed to open — a timeout, a 5xx, a CDN refusing this box — fell through
to `ok: unreachable.length === 0`, which stayed **true**. `sweepLogos` wrote
that as `kind: "miss"`, would not look again for **twelve hours**, and the log
line said *"N with no artwork anywhere"* about tokens whose artwork we had in
hand. That is the module's own headline contract inverted: `ok: true, url: null`
is supposed to mean *every source answered and this project has no artwork*.

- **`checkImage` returns three verdicts**, because two of them are not the same
  fact: `image` · `not-image` (it ANSWERED and is not one — a 404, an HTML error
  page) · `unreachable` (no decision — DNS, a timeout, a 5xx, a refusal). A
  refusal or a 5xx is a fact about the HOST; only a non-refusal 4xx is a fact
  about the file.
- **An unverifiable candidate is an unreachable SOURCE**, so `ok` goes false and
  the sweep records `undecided` — retried in 30 minutes rather than 12 hours —
  and the url that could not be checked is NAMED.
- **A real `not-image` stays a decided miss.** Downgrading it would re-ask every
  30 minutes for ever, which is the other half of the same line.
- ⚠️ **The test fixture could not reach the branch it was written for.** Node
  stamps `content-type: text/plain` on a `Response` built from a STRING, so
  `reply(200, null)` still arrived carrying a type and the "no content-type at
  all" case had never been exercised. Bytes get no default type. A test
  measuring its own fake, for the second time in this file.
- Mutation-tested: HEAD's verdict being final again, the unverifiable candidate
  reading as "not artwork", and a 5xx reading as an answer each fail between one
  and three tests.

```bash
npm test    # tokenLogo (37) + logoFill (15)
```

### …and the site had never taken its half of the split

The bot's client was cut to `GT_MAX_RPM=15` — *"the ceiling is per IP, so the
two processes' budgets have to ADD UP TO IT"* — and **the web app never got the
other half.** Its only pacing was a 120 ms floor between requests, which is
~500 req/min: no budget at all. So the bot held politely to fifteen while the
site took whatever it liked, and both of them ate the 429 the split existed to
prevent. **A split one side observes is not a split.**

- **It is a PACE, not a refusal.** Over budget a request WAITS for a slot, up to
  `GT_BUDGET_WAIT_MS` (3s) — a chart that draws a second late beats one that
  does not draw. Only then does it give up.
- **It gives up the way the cooldown does** — `status: 0` — which every caller
  already reads as "could not ask" rather than "nothing there".
- ⚠️ **And it names itself, not GeckoTerminal.** Reporting our own pacing as
  `GeckoTerminal 429` sends an operator to check a service that is perfectly
  healthy, and reads as a fact about the quota rather than about us. The
  sentence names the two knobs that lift it.
- **A ROLLING window, never a per-minute bucket** — a bucket lets 15 requests go
  at :59 and 15 more at :00, which is exactly the burst the ceiling punishes.
- **The slot is counted when it is TAKEN, not when the response lands.** A
  request then skipped by the cooldown re-check has still reserved its place;
  over-counting spends a little under the allowance, under-counting spends over
  it, and over it is the 429.
- **The boot line PRINTS the budget** (`· budget 15/min from THIS process`),
  because a budget nobody can read is how this one stayed missing while the
  file it belongs to argued for it in prose.

```bash
pm2 logs dexvra     --lines 50 --nostream | grep -F '[gt]'   # the site's half
pm2 logs dexvra-bot --lines 50 --nostream | grep -F '[gt]'   # the bot's half
```

**Config a fix depends on:** nothing — `GT_MAX_RPM` in the **repo-root** `.env`
raises the site's share and `0` turns it off, and `GECKOTERMINAL_API_KEY` is
still the only thing that raises the real ceiling rather than dividing it.


## "bot tidak merespon untuk paket listing setelah di minta drop ca" — the form was queued behind every timer job

Reported 2026-08-28: the listing flow's CA prompt standing in the chat, a
pump.fun mint pasted under it, and nothing ever coming back — the bot alive
(it had just sent the prompt) and silent. **Nothing had crashed.** The contract
step awaited `fetchMarket` and `fetchTokenDescription`, and both wait on
`gtTurn()` → `gtSlot(PRIO_BACKGROUND)` — the shared GeckoTerminal queue, which
has **no deadline of its own**: one release per `GT_MIN_GAP_MS`, capped at 200
entries. The day before, the keyless budget was halved to 5/min (a 12-SECOND
gap per slot), so behind a normal day of timer pipelines — the trending
poster, autoTrend, the pump checker, the candle reads — a **user-prompted**
paste sat in the background tier for minutes. From Telegram that is a dead
bot, and it was reported as one. It "previously worked" because the budget was
15/min until the split was enforced.

- **The autofill is BOUNDED at the caller** (`LISTING_AUTOFILL_MS`, 8s per
  source). Autofill is an ENRICHMENT — every field it fills, the form lets the
  user edit — so a slow source contributes nothing and the form goes on: the
  registry's own dead-pad rule, applied to the form that reads through it. The
  background pipelines keep their queue semantics untouched; only the form
  stops waiting on them. The abandoned lookup still lands in its cache.
- **The paste is ANSWERED before the indexers are asked** — a "🔎 Reading your
  token's profile…" card goes out immediately, and the review card (or the
  next prompt) replaces it. A prompted input followed by seconds of nothing is
  "the button does nothing", the atrun lesson on a text prompt.
- ⚠️ **`bounded`'s timer is NOT unref'd** — the `gtDrain` rule one module
  over, relearnt by watching all four tests get "cancelledByParent": a user is
  waiting on that timer, and an unref'd one does not hold the event loop open,
  so a process with nothing else pending exits with the form hung forever.
- ⚠️ **A flow handler that throws now ANSWERS.** `textRouter`'s catch logged a
  warn and said nothing, so ANY error inside a form step left the prompt
  standing over silence — the refusal-off-screen defect, on text input. Both
  routers reply "That didn't go through — please send it again."
- Mutation-tested: unbounding the lookups and re-silencing the catch each fail
  their tests.

```bash
cd bot && node scripts/run-tests.js test/listingAutofill.test.js   # 4 tests, no network
```

**Config a fix depends on:** nothing. `LISTING_AUTOFILL_MS` widens the wait for
an operator with a GT key and an empty queue; `GECKOTERMINAL_API_KEY` is still
what makes the queue itself short.

## "robinhood chain price dll tidak ada datanya" — a chain of $0 rows, and no line anywhere saying why

Reported with a screenshot of the home board: seven Robinhood listings —
$GME, $INDEX, $PONS, $AAPL, $VEX, $WALL3, $WOJAK — every one rendering
`$0` price · `—` change · `$0` MCAP · `$0` VOL · `0` txns. Three different
failures render EXACTLY like that, and they need three different fixes:
GeckoTerminal has no data for those tokens (nothing to configure — a fresh
launchpad token has no indexed pool), GT is refusing/limiting the box (quota),
or GT answers fine and the site's own pipeline is broken. Nothing on the board,
in the store or in the logs could say which.

- ⚠️ **A chain whose every provider fails, failed SILENTLY.** `loadListedTokens`
  ran the per-chain fetches under `Promise.allSettled` and never looked at the
  rejections — a chain could throw on every cycle for a week and the only
  symptom was its rows sitting on their captured-at-listing zeros. One
  greppable `[market] <chain>: every provider failed this cycle — <why>` line
  per chain per cycle now.
- ⚠️ **The zeros themselves were CLAIMS.** Those `$0`s were the store's
  captured-at-listing defaults on rows no provider had priced — printed on a
  public board as three measurements per row that nobody made. `figureReading`
  is `changeReading`'s money-column twin, in the same module for the same
  reason: a zero from a row whose source never measured anything is a dash; a
  LIVE zero keeps its zero (a measured quiet day is a fact); a captured nonzero
  still prints (the demo board is built from those). Every money cell on BOTH
  row components goes through it — the 24h column already drew its dash while
  PRICE beside it claimed `$0`, two cells one inch apart disagreeing about what
  unknown looks like — and a source-scan test refuses any cell reading the raw
  field again.
- **`npm run market:check` says WHICH of the three it is, on the box.** It
  drives the RUNNING server's `/api/tokens` (what the board actually serves,
  build stamp included) and then GeckoTerminal DIRECTLY with the site's own
  request shape, per token: `GT prices it right now` → the fault is the site's
  half, read `pm2 logs dexvra | grep -F '[market]'` then `'[gt]'`; `GT has no
  record` → the token genuinely has no indexed pool and the board is honest
  about it; a 404/429 names the config/quota. ⚠️ The script carries a PORT of
  `chains.ts`' `geckoNetwork` map (production runs Node 18 — a check script
  cannot import `src/**/*.ts`, the `logos:check` rule), and a guard test pins
  the port equal to the real map — the first run of that guard caught the port
  missing thirteen chains, which is the guard doing its job on its author.

```bash
npm run market:check                # every chain, the worst one probed against GT
npm run market:check -- robinhood   # one chain, per token, with the next step named
```

**Config a fix depends on:** nothing for the code. Whether Robinhood rows can
price at all is a fact about GT's coverage of those tokens, measured on the
box — and `GECKOTERMINAL_API_KEY` in the repo-root `.env` is still the only
thing that raises the shared ceiling rather than dividing it.

### …and the first live run of the check named it: the budget race Robinhood always loses

`npm run market:check -- robinhood` on the box: every other chain mostly
priced (solana 162/192, bsc 75/78, base 17/17), **robinhood 0/66 — every row
blank** — and the direct GT probe answered **429**. That is not bad luck, it
is arithmetic: the site's own demand (~19 GT chunks per 60s cycle across all
chains) exceeds its 15/min budget, every chain fires CONCURRENTLY, and
whichever chunks queue last lose. A chain DexScreener also covers falls back
and prices anyway; **Robinhood is `dexscreener: null` — the ONE chain with no
second source — so it lost the race every cycle, deterministically**, while
the chains that could afford to lose were spending the budget it needed.

- **GT-only chains draw from the budget FIRST**, awaited before the covered
  chains start. `partitionByFallback` lives in `dexscreener.ts` beside the
  coverage map it reads (a second list of "which chains DS covers" would
  drift), and the priority is pinned by a source test — a priority group is
  only a priority while it is AWAITED first; launched concurrently it is just
  a longer list.
- ⚠️ **The first cut of this edit never landed** — the patch script failed on
  a later assertion AFTER the body edits and BEFORE the write, so `tsc`
  passed on an unused import over the unchanged concurrent block. The source
  test caught it; a green typecheck is not a landed change.
- **One good cycle now buys three hours of board**: `lastGood` serves the
  last real observation for `LAST_GOOD_TTL_MS`, so once Robinhood prices
  once, a later lost race degrades to slightly stale instead of `—`.
- **The ceiling itself is still the ceiling.** Priority decides who wins the
  site's share; it cannot make ~19 chunks fit in 15. `GECKOTERMINAL_API_KEY`
  in the repo-root `.env` (sixth time in this file) is the only thing that
  raises it — and with 66 robinhood listings and the bot suite on the same
  IP, this box has outgrown the free tier.

### "mengapa tidak pakai sumber dari dexscreener.com?" — because a fact had expired

The right question, and the answer used to be "DexScreener does not index
Robinhood Chain" — stated in five places across three packages, each with the
same justification, all written when the chain launched. **DexScreener added
Robinhood around July 2026** (`dexscreener.com/new-pairs/robinhood`), and from
that day every one of those entries meant the opposite of its own comment:
every robinhood read paid the shared ~30/min GT quota for a number DexScreener
now also publishes — on the chain with the most listings on the box.

- **The flip is one row in each package's own map**: `dexscreener: "robinhood"`
  in `src/config/chains.ts`, `DEXSCREENER_SLUG` in `bot/src/config/chains.js`
  (which also gives robinhood buy alerts a real chart button — the "known
  exception" list in `buyCta.test.js` is empty now), `GT_PRIMARY` in
  `bot/src/group/gtPairs.js` shrinks to `plasma` (robinhood pool reads go
  DS-first), and `DS_CHAIN_KEY` in `tradebot/core.js`.
- **Every consumer already knew what to do with a covered chain** — DS-first
  pricing, the market fallback, the CDN logo convention, the chart links —
  because none of them ever hardcoded "robinhood is special"; they all read
  their registry. The whole change is data.
- ⚠️ **The stale fact lived in TESTS as much as in code.** Seven tests across
  the three packages asserted "DexScreener does not carry Robinhood" as a
  permanent truth; each now tests the same RULE against a chain id that has no
  registry entry at all (`no-such-chain`), so the rule outlives the roster —
  a test pinned to a third party's current coverage is a test that expires
  without notice.
- **Whether DS actually answers for a given robinhood token is measured on the
  box** (`npm run market:check -- robinhood`, `buybot:check`), never assumed —
  the change is fail-open everywhere: an empty DS answer costs nothing, GT
  stays primary for the full market read.
- **This is the real quota relief.** The priority fix decided who WINS the
  site's GT share; this shrinks what everyone needs from it: robinhood board
  chunks gain a fallback, the buy-bot's robinhood metadata reads leave GT, and
  `GECKOTERMINAL_API_KEY` moves from "urgent" back to "headroom" — it is still
  the only thing that raises the ceiling, and GT is still the only free OHLCV
  (candles) source, so the sentence stays true; it just stops being the only
  path to a priced board.

#### ⚠️ …and the flip made it WORSE for one deploy: 62/66 → 0/66

The next `market:check` on the box read `robinhood 0/66 priced` on build
`87dca08`. The deploy was correct; the change was not. **"No consumer
hardcoded robinhood is special" — stated in that very commit message — was
false in exactly one place**, and it is the place that decides this chain's
market:

`fetchChainMarket` branches for the pools.trade chain to ADD the launchpad,
and it did that by replacing the indexed path wholesale: `fetchListedMarket`
(GT alone) + the launchpad, never `fetchIndexedMarket` (GT **then DexScreener
for the leftovers**). So robinhood was the one chain that never had the
gap-fill — invisible while DS did not carry the chain, and the moment the
registry said it did, the slug took away robinhood's GT-ONLY PRIORITY (it
"has a fallback" now) over a code path that still could not reach one. Both
halves were individually defensible; together they were strictly worse than
either.

- **A registry saying a source exists, over a code path that cannot reach it,
  is worse than not having the source.** The priority scheduler and the
  coverage map now agree because they read the same fact and the same
  function does the asking.
- ⚠️ **The regression shipped because no test drove that branch** — the
  indexed-merge tests all target `fetchIndexedMarket`, which robinhood never
  called. The guard is a source scan (the branch lives behind an `"@/"`-alias
  import this runner cannot resolve) and it is MUTATION-TESTED: putting
  `fetchListedMarket` back fails it.
- **`market:check` is what caught it, twice, in a minute** — the board's own
  `0/66` next to `162/192`. That is the check earning its keep: the first run
  named the budget race, this one named a regression I introduced.

#### …and then the CHECK was the thing that was wrong

Next run: `robinhood 58/66 priced` — recovered — under a red
`GT answered 429 … GECKOTERMINAL_API_KEY is the only thing that raises the
ceiling`, and a non-zero exit. **A working board reported as a failure.** Three
defects, all mine, all this file's own recurring shapes:

- ⚠️ **It probed ONE source and hung its whole verdict on it.** The site gained
  a DexScreener fallback for these chains; the check never learned. A GT 429
  says nothing about whether the board can price — DS may be answering, which
  is precisely why the board read 58/66 while the check called it broken.
  Both sources are probed now, with the site's own request shapes, and the
  per-token line says WHICH one has the price.
- ⚠️ **"Could not ask" was being reported as "the board is broken."** The
  distinction this repo keeps everywhere else, missing from the one script
  whose job is diagnosing. Neither source reachable now prints *"this run says
  nothing about the board"*, points at the board's own live count as the
  answer, and only fails if that count is zero.
- ⚠️ **It was on its way to being PERMANENTLY red**, which is the state
  `chart:preview` sat in for weeks — and a check that is always red trains the
  reader to ignore the red. Exit codes follow the BOARD now: red only when a
  blank row is priced by a source RIGHT NOW (the site's fault); a token no
  source has is the board being honest and exits **zero**; one probe's rate
  limit never turns the code on its own.
- **Both ported chain maps are guarded** (GT and DS), because a stale slug in
  either makes the check report "no record" for a token the site prices — a
  check lying in the reassuring direction.

## "vol 0 padahal ada transaksi buy and sale"

Reported with a screenshot of the home board, where one row asserted both
halves of a contradiction:

```
$MRNA   +185.0%   MCAP $157.7K   VOL $0   TXNS 13 · 6 buys / 7 sells
```

**Nothing in the data layer invented that zero**, and the first instinct — that
`?? 0` in the two market readers had turned a missing volume into a fact — was
wrong. Measured against the live API before writing a line:

```
MRNA  vol24h = 0.06   txns 6/7        AMZN  vol24h = 0.31   txns 0/1
GOOGL vol24h = 0.04   txns 4/4        AMZN  vol24h = 0      txns 0/0
```

The volumes were real. `fmtCap` ended in `Math.round(n)`, so **every genuine
figure under half a dollar rendered as `$0`** — and the board printed that
beside its own transaction count, asserting no trading happened over data
proving it had. The row with a true zero had 0 buys and 0 sells, which is the
one state in which `$0` is a fact.

- **A printed zero is a claim.** This repo already refuses the same shape for an
  unreadable 24h change on the trending board; it had never been applied to
  money. Below a dollar `fmtCap` now keeps exactly enough decimals that a real
  number cannot render as zero — `$0.06`, `$0.31`, `$0.004` — and no more.
- **A TRUE zero still prints `$0`, and `null` still prints `—`.** Three states,
  three spellings: *is zero* · *is small* · *not known*. Collapsing any pair is
  the defect.
- ⚠️ **No branch may emit a bare `<`.** `<$0.01` is the obvious spelling and is
  unavailable: `bot/src/helpers/format.js` carries a 1:1 port of this function
  and its output reaches Telegram with `parse_mode: HTML`, where one `<` makes
  it reject the whole message — a 400, which `queuedSend` does not retry, so
  the post simply vanishes. The trade bot's `&lt;0.01%` paid for that lesson.
- **Both copies were fixed together and a test asserts they agree exactly**, or
  a figure reads one way on the site and another in a channel post.
- **The measurement came first.** Three causes produce `$0` — the upstream
  omitting the field, the upstream reporting zero, and this rounding — and they
  need different fixes. One `curl` against the running site separated them in
  ten seconds; guessing would have bought a nullable-volume refactor rippling
  through the types, the sort and the score, for a bug that was one line.

```bash
npm test                                                      # src/lib/format.test.ts
cd bot && node scripts/run-tests.js test/fmtCapZero.test.js
```

### "Chart unavailable right now" — and four files owning one number

The token page answered `Couldn't read the chart just now (rate limited —
cooling down for 88s)`, and the ask was "semua token chartnya tersedia".

⚠️ **That ask cannot be fully met on the free tier, and saying otherwise would
be the reassuring reading.** A PRICE has two free sources; a CANDLE has one.
GeckoTerminal is the only free OHLCV for an arbitrary DEX token, its ceiling is
~30 requests a minute counted PER IP, and this box splits that between the bot
suite and the web app. One 429 anywhere arms a process-wide cooldown that
blanks EVERY chart on the site until it lifts. `GECKOTERMINAL_API_KEY` is the
only thing that raises that ceiling rather than dividing it; everything else
reduces how often it is hit.

What was worth fixing is that the app was paying for the same answer repeatedly:

- ⚠️ **`POOL_TTL = 10 * 60_000` was declared in FOUR files** — `providers/index.ts`,
  `/api/pool`, `/api/ohlcv`, `/api/trades` — and all four built the SAME cache
  key by hand. Four copies of one number sharing one key means whichever writes
  last sets the expiry, and raising one of them looks like it works while three
  others quietly disagree. `poolCache.ts` is the one owner now, beside
  `topPoolAddress`, which was already the one owner of *which* pool.
- **A token's deepest pool is not a per-minute fact**, so the TTL is an hour
  rather than ten minutes. Resolving a pool is a GT request, and every chart for
  a token whose pool has expired pays it again before it can even ask for
  candles.
- **`forgetPool` exists so a longer TTL cannot backfire.** A pool that dies
  mid-window would otherwise be handed back for the rest of the hour — the exact
  cost the longer TTL is meant to buy.
- ⚠️ **The guard test that broke was asserting a LITERAL.** It matched
  `cache.set(\`pool:…\`, m.poolAddress, POOL_CACHE_TTL)` — so it passed happily
  on the four-way duplication it was meant to describe, and failed on the fix.
  It asserts the property now: no file may declare its own pool TTL or build the
  key by hand.

```bash
npm test    # gtBudget — the one-owner guard, and the rest of the GT budget
```

**Config a fix depends on:** `GECKOTERMINAL_API_KEY` in the repo-root `.env`
for the site, and `bot/.env` for the bot. Until one is set, 30/min is 30/min and
a busy minute still ends in a cooldown — this only makes the minute go further.

### "Mending tambahkan api dari dexscreener" — the ceiling was never going to move

Reported a fourth time, with the token page reading `Chart unavailable right
now · Couldn't read the chart just now (GeckoTerminal 429 (rate limited))`.
Every round above cut what we SPEND — six GT doors down to one client, an
hour-long pool cache, DexScreener-first pricing in the bot — and every round
made the minute go further without ever removing the minute. The operator's own
answer is the only one that does:

    A PRICE HAS TWO FREE SOURCES; A CANDLE HAS ONE.

`src/lib/providers/dsChart.ts` is the second one, and two of its rules would
each have shipped a source that answers perfectly and draws nothing:

- ⚠️ **DexScreener sends MILLISECONDS; everything downstream is SECONDS.**
  `Candle.t` is GeckoTerminal's unit, `CandleChart` multiplies by 1000, and
  `normalizeCandles` refuses a stamp more than six hours ahead — so a
  millisecond feed is not merely wrong, every candle is silently DROPPED as
  "the future" and the panel reports "no candles on this timeframe" about a
  source that answered. `normalize.toMs`, pointing the other way. Converted by
  MAGNITUDE, because both spellings are plausible from an undocumented feed and
  guessing one costs the whole chart.
- ⚠️ **A DS PAIR ADDRESS IS NOT A GT POOL ID** — the rule this repo already
  states in seven places. `/api/pool` and `/api/trades` read the `pool:` cache
  and hand its value to GeckoTerminal, and the panel built a
  `geckoterminal.com/<network>/pools/<pool>` link out of it. The pair gets its
  own field and its own namespace; `pool` still only ever carries a GT pool, and
  the "open at the source" link is built by whoever knows which source answered.

⚠️ **AND THE REQUEST SHAPE IS A GUESS.** DexScreener publishes **no** documented
OHLCV endpoint — its own chart is a TradingView chart on an internal datafeed,
and nothing in this repo had ever called one. That is exactly the state
`pads.js` marks `verified: false` and was designed for, so it ships under the
same contract: a base LIST with `DS_CHART_API` pinning one **and** skipping it,
a PATH template list, `DS_CHART_BARS_KEY` for the envelope, `DS_CHART=0` to kill
it. **A renamed segment costs a line in `.env`, not a deploy** — which is the
whole licence for shipping a shape nobody here has exercised. And it can never
be the only source: **a guess must lose to an answer**, so GeckoTerminal stays
first whenever it can answer.

- **TWO FAILOVER RULES, AND MIXING THEM IS THE BUG.** Across BASES: transport
  only — `JUP_BASES`' rule, because a status means the host answered and the
  same request gets it everywhere else. Across PATHS: a 404 only, because that
  is a DIFFERENT RESOURCE on the same host and "that spelling is not here" is
  exactly when the other spelling is worth trying. A 429 says nothing about
  which path is right, so it retries neither.
- **A 429 arms its own process-wide cooldown.** A client that hammers through
  its own 429 is precisely the defect `gt.ts` was written to end, and adding a
  second upstream without one would reintroduce it a host over.
- **GT is not ASKED while its cooldown holds.** `gtGet` would answer without a
  request, so skipping costs nothing upstream — and answering during exactly
  that window is the entire reason a second source exists. That is the state the
  screenshot was taken in.
- **Both reasons travel** when neither answered, and the sentence keeps the words
  *couldn't read*: the panel classifies error-vs-answer on that substring, and
  only an error gets the fast retry that lets a chart appear the moment a
  cooldown lifts.
- ⚠️ **The no-candles branch carries the SPECIFIC reason.** It used to assert
  *"This pool has no candles on this timeframe yet"* for every way a source can
  answer with nothing — so a token NEITHER index has a pair for was told its
  pool was empty, which claims a pool that does not exist.
- **The panel SAYS when it drew from the fallback** (`via DexScreener`). Without
  it, a chart from the second source and one from GT are the same picture, and
  *"the fallback works"* and *"the fallback never fires"* are the reassuring
  reading this repo keeps paying for.

```bash
npm run build && npm start &
npm run chart:check                       # per source, on the box; non-zero if neither draws
npm run chart:check -- bsc 0x8b7a…7777    # one token you are looking at
```

⚠️ **The check drives the RUNNING SERVER, not the provider module.** Importing
`src/**/*.ts` needs node's type stripping and **production runs 18.19**, where
that import simply throws — a check that cannot run on the box is "apt-get
install is not a fix, it is a request", one feature over. It asks each source
separately (`?source=`), because with GeckoTerminal healthy the DexScreener path
never runs and a check that only asked normally would report a green chart while
saying nothing about the fallback.

⚠️ **`chart:preview` had been permanently red and therefore useless as a gate.**
It still asserted *"an unlisted token gets the chart too"* — written before that
chart was deliberately removed ("Kalo token belum listing hapus chartnya"). So it
had exited non-zero on every run since, and a check that asserts a deleted
feature is worse than no check: it trains the reader to ignore the red. It
asserts the DECISION now, and gained the fallback state — judged by LOOKING at
the render, 21/21.

⚠️ **The chart-route build-stamp guard matched `{ ok: true, `** — the one-line
spelling — so an UNSTAMPED multi-line response would have passed it, which is the
one shape it exists to catch. It counts the property now.

**Config a fix depends on:** nothing; every knob has a working default. But
whether the guessed shape answers is a property of the server's egress, so
`npm run chart:check` on the box is the only way to learn it — and
`GECKOTERMINAL_API_KEY` is still the only thing that raises the real ceiling
rather than dividing it.

#### The audit round — the fix cached the very thing it was written for

Run against both features by five independent lenses, and every defect found is
one of this file's own recurring shapes, reintroduced by the code written to
stop it.

- ⚠️ **A GECKOTERMINAL RATE LIMIT WAS BEING CACHED AS THE CHART'S ANSWER**, for
  the timeframe's TTL — up to FIFTEEN MINUTES on 1d, longer than the 120s
  cooldown it was reporting. `load()` IS the cached loader, and the rule stated
  at `Unreadable`'s own definition is that only an ANSWER may be cached. It used
  to reach the route's catch by THROWING out of `fetchCandles`; wrapping
  GeckoTerminal in a try/catch so DexScreener could be tried afterwards quietly
  turned that throw into a RETURN. Proved by measurement rather than by reading:
  three identical requests against a stub produce six upstream hits.
- ⚠️ **ONE SOURCE ANSWERING IS NOT EVERY SOURCE ANSWERING.** With GT cooling
  down and DexScreener replying *"no pair for this token"*, the route published
  *"No candles yet"* about a token GT indexes perfectly well — on the panel state
  that never fast-retries, so it stayed wrong until the reader reloaded.
- ⚠️ **THE VOLUME FLOOR BOUND ONE BOARD OUT OF FOUR.** `/trending` — the page
  whose entire heading is *Top Gainers* — sorted `b.chg[frame] - a.chg[frame]`,
  the RAW field, through neither gate, so even a five-million-percent reading
  could take its 🥇 medal. The **Ticker** crowned, on every page, the token the
  board directly underneath ranked tenth. `/watchlist` and the home **wire
  headline** did the same. `byChange` is the one owner for a whole list;
  `tradedEnough` is the filter for a curated few; a test pins every ranking
  surface so a fifth cannot be missed.
- ⚠️ **`trending:check --floors` HAD ITS OWN COPY OF THE REFUSAL COUNT**, missing
  the "we actually looked" half — 44 refusals where the bot reports 25. A check
  that measures its own copy of the question proves nothing.
- ⚠️ **A TOKEN NOBODY PRICED IS NOT A TOKEN THAT FAILED THE FLOORS.** `byGain`
  prices at most 25 a chain; counting the tail as refused told an operator with
  100 listings that 75 of their tokens were too small, about tokens the pass
  never opened. And **the test for it was vacuous** — the log buffer it read was
  module-level, so `.find()` returned an earlier test's line and the assertion
  passed whatever the code did.
- ⚠️ **THE PANEL PROMISED A FILLER THAT WAS SWITCHED OFF**, four paragraphs above
  saying a chain with no spares "stays short until somebody lists tokens on it".
- ⚠️ **`fmtCap` printed `$NaN` on the site where the bot's 1:1 port prints `—`** —
  two copies the repo requires to agree exactly, drifting on the one input the
  agreement test never tried.
- **The base-failover rule was true in the comment and false in the code**, and
  the test for it was vacuous because the shipped base list has ONE entry: a test
  driving it cannot tell a correct loop from a broken one. `dsCandles` takes a
  documented `bases` seam now.
- ⚠️ **"Nothing is up on this timeframe" became a FALSE claim** the moment
  `movers` started excluding quiet tokens — the board above the card reads
  +58.2% while the card says nothing is up.
- **`chart:preview` had been permanently red**, asserting a chart on the unlisted
  page that was deliberately deleted. A check that asserts a removed feature is
  worse than no check: it trains the reader to ignore the red.

Every guarantee is MUTATION-TESTED rather than argued — reaching around the
floors in the floor fill, dropping them from the promotion pass, bypassing them
on a forced run, dropping the filler's refusal, letting the base rule leak,
skipping the millisecond conversion, taking the quote-side pair, and each of the
above — and each fails between one and four tests.

### "chartnya bisa di set kaya di atas ke bawah" — the vertical belongs to the reader

Reported with the same `$BREAKING` screenshot (2026-08-26). The token had gone
from **$0.000803 to $0.0281 in two days** and the chart of it was a flat line
along the floor of the panel with one spike at the right-hand edge. Every
number on it was correct. The picture was useless — **on a LINEAR axis a 35×
move spends 96% of the height on the last 4% of the story** — and there was
nothing the reader could do about it: the y-axis was computed from the window
and that was the end of it.

Two answers, and they are one transform, so they are one module
(`src/lib/chartScale.ts`):

- **LIN / LOG**, in the header. On a log axis a doubling is the same distance
  wherever it happens, so the early history is as readable as the spike. That
  is the answer to *this* picture.
- **A MANUAL ADJUST.** Drag the price gutter to stretch or squash, drag the
  chart to move it up and down, double-click (or ⤢ Auto) for the automatic
  range back. TradingView's grammar, because it is the one people already know.

- **The adjust is `{zoom, shift}`, NOT a stored `{lo, hi}`.** A stored pair
  would go on describing a price range the market has since left, so a chart
  left alone for an hour would drift off its own candles while the reader
  watched. Two dimensionless numbers describe a relationship to whatever the
  auto range is *now*, which survives new candles arriving underneath it.
- **`shift` is measured in AUTO spans and the drag against the VISIBLE one**,
  so `panByDrag` divides by the zoom. Without that, panning a chart stretched
  10× flings it off screen in a few pixels; the same drag has to travel the
  same distance on the panel at every zoom.
- **A stretch keeps the middle of the view where it was.** Zooming that also
  slid the chart up the axis is a control nobody can aim — you lose the candle
  you were looking at.
- ⚠️ **A LINEAR PRICE AXIS MAY NOT GO BELOW ZERO.** Squash far enough and the
  padded range walks past the origin and the gutter starts labelling negative
  dollars, on the panel somebody is reading to decide whether to buy. Log space
  has no such floor (10⁻⁹ is a price), so the clamp only binds where it means
  something.
- ⚠️ **A log axis must never be handed a non-positive price.** `Math.log10(0)`
  is `-Infinity` and one of those turns the whole axis into NaN, which renders
  as an empty panel that reads exactly like a chart still loading — the state
  this repo has already paid for twice.
- **The grid ticks are evenly spaced in the AXIS's space, not in dollars**, or
  a log chart's five lines bunch at one end.
- ⚠️ **A stretched chart is CLIPPED.** Unclipped, the wicks run straight
  through the volume histogram and the time stamps. …but **the last-price tag
  is PINNED, not clipped**: it is the number the reader came for, and a scale
  they dragged must not be able to take it off screen. It rides the edge, which
  is why the grid label still gives way to it.
- ⚠️ **A phone can still scroll the page.** A vertical touch drag across the
  plot is how a phone scrolls, so only a MOUSE pans the chart body;
  `touch-action:none` is taken on the narrow gutter alone, which is the one
  place that trade is worth making.
- ⚠️ **`useId()` returns `:r0:`** — legal in an id, and a colon inside a
  `url(#…)` reference is one browser quirk away from a clip that silently does
  nothing, on somebody else's browser and nowhere near a test. Stripped to word
  characters.
- **The MODE survives a timeframe switch and the ADJUST does not.** Somebody
  who wants a log axis wants it on every tab; a stretch aimed at two days of
  15m candles is meaningless over six months of daily ones, and inheriting it
  opens the new tab on an axis with no candles in it.
- ⚠️ **AND THE PANEL SAYS WHEN THE READER HAS MOVED IT.** A log chart and a
  linear one of the same token are different pictures, and so are an auto range
  and a stretched one; anybody comparing two screenshots is owed the
  difference. Two buttons rather than one toggle, so the mode is readable OFF
  the picture, and `⤢ Auto` exists only while the axis is not the data's own —
  the escape hatch and the tell at once. Same rule as the `via DexScreener`
  chip one feature over.

#### ⚠️ The gutter is INSIDE the plot, and pointer events bubble

Every pointer event over the price axis ran BOTH handlers and the two fought
over one drag. **Measured, not reasoned about**: with the three
`stopPropagation` calls removed, a 60px pan moved the chart **210px**, and the
same axis drag produced a different zoom. Which handler wins in which order is
not worth working out — a drag belongs to the element it started on.

It still "worked": the chart did stretch and did move. So the preview's check
had to change too — `> 20px` passed happily on the broken build, and
`|moved − 60| < 8` is what catches it. **A control that responds is not a
control that obeys.**

#### It is judged by LOOKING at it

`chart:preview` renders the reported shape (`ramp()`, a 35× climb) and measures
where **half the move** sits — the price at which the token had done half its
multiple belongs somewhere near the middle of a chart of that move:

```
LIN: half the move sits 16% up the price area     ← the reported picture
LOG: half the move sits 50% up the price area
```

- **Against the PRICE AREA, not the whole svg.** The volume band and the time
  axis are not part of the scale, and counting them flatters a linear chart by
  a fifth — the first cut measured that way and read 26%.
- ⚠️ **The clip is MUTATION-TESTED in the page**: the attribute is pulled off,
  the same points are probed again, and it is put back. Two cheaper checks were
  tried first and both were worthless — `getBoundingClientRect` on clipped SVG
  comes back collapsed or stale, and a run where nothing overflows makes any
  "nothing spilled" assertion true of a chart with no clip at all. This one
  fails if the clip stops working AND fails if the probe stops being able to
  see a spill.

#### 403 → 400: the host started talking, and the guess is what it refuses now

The first `chart:check` after the browser headers deployed:

```
USDC (Solana)   ✓ GeckoTerminal 26 candle(s)    ✗ DexScreener io.dexscreener.com 400
WBNB (BSC)      ✓ GeckoTerminal 384 candle(s)   ✗ DexScreener io.dexscreener.com 400
WETH (Ethereum) ✗ GeckoTerminal 429             ✗ DexScreener io.dexscreener.com 400
```

**The number changed, and that IS the result.** 403 is "I refuse you"; 400 is "I am
talking to you and your request is wrong". The headers got past the bot filter,
and what is left is the part this file always said was a guess. Three things,
and two of them are our own rules broken:

- ⚠️ **WE WERE DISCARDING THE REASON — on the one status that carries it.** This
  file's own rule is *"an HTTP error puts the explanation in the response
  body"*, and `getJson` cancelled the body and returned a bare
  `io.dexscreener.com 400`. That says the guessed shape is wrong and nothing
  about WHICH part, which is the difference between a one-line `.env` fix and
  another round of guessing. `bodyHint()` carries it now — flattened (an HTML
  error page is not a message for a reader) and bounded to a phrase.
- ⚠️ **THE QUERY STRING WAS THE ONE PART OF THE REQUEST THAT WAS NOT
  OVERRIDABLE.** The whole licence for shipping an unverified shape is that
  every part of it costs a line in `.env` rather than a deploy — and the query
  is the half most likely to be wrong, which the 400 then proved.
  `DS_CHART_QUERY` takes `{from} {to} {res} {limit}`.
- **A 400 now tries the OTHER path spelling, a 403 still does not.** 404 ("not
  here") and 400 ("not with these parameters") are both about THIS spelling, and
  v2 and v3 of an API routinely take different params — which is the whole
  reason two templates are listed. A refusal says nothing about which path is
  right.
- ⚠️ **The attempted URL travels, but ONLY under the `?source=` pin.** An
  operator cannot fix a request shape they cannot see — the `logos:check`
  truncation defect, one feature over — and a visitor must never see a raw
  upstream URL in the chart panel. The pin is the check script's seam and
  nothing else sets it.
- **The check says how to FIND the real shape**, because the endpoint is the one
  DexScreener's own chart calls: DevTools → Network → filter "bars", then paste
  the query into `DS_CHART_QUERY` and the path into `DS_CHART_PATH`. A status
  alone is not actionable; naming the browser as the authoritative source is
  the difference between a diagnosis and a shrug.

⚠️ **What is still unknown, and cannot be learned here:** the correct shape. This
sandbox has no egress, and the endpoint is undocumented — so the last step
genuinely belongs to somebody with a browser and the box. Everything above
exists so that step is a line in `.env`.

#### "saya ingin pakai api dexscreener aja untuk chart" — an ORDER, not a deletion

The DexScreener source already existed (the same operator asked for it, and it
shipped). What did not exist is a way to make it PRIMARY, and on that box
`io.dexscreener.com` was answering **403**. Two things:

- ⚠️ **THE 403 WAS PROBABLY OUR OWN REQUEST SHAPE.** `io.` is not a public API —
  it is the internal datafeed behind DexScreener's own TradingView chart, and it
  sits behind Cloudflare. We were sending nothing but `accept:
  application/json` from a datacenter IP, which is exactly the shape a bot
  filter refuses. It now sends what a browser sends (user-agent, referer,
  origin, accept-language) — the same compromise `/api/logo` already makes one
  CDN over. The DOCUMENTED `api.` host does not get them: it answered 200 from
  the box with none, so they are sent only where they might help.
  `DS_CHART_HEADERS` REPLACES the set (`Name: value` pairs separated by `|`),
  because whether a header combination gets past a bot filter is a property of
  the box's IP reputation today, not of this code.
- **`CHART_SOURCE` is the order**: `auto` (GT first, the shipped default),
  `dexscreener` (DS first, GT behind it), `geckoterminal` (GT only). Blank is
  `auto` — an unset var resolves to what shipped, never to a guess.

⚠️ **IT IS AN ORDER AND NEVER A DELETION, and that is not overruling the ask.**
DexScreener publishes no documented OHLCV endpoint, so `dsChart.ts` is a GUESS
about somebody else's private API. Making a guess primary is a legitimate trade
— it costs nothing while it works, and it leaves the whole ~30 req/min GT
allowance for the board, the pools and the trades feed. Making it the ONLY
source means the day DexScreener renames a path, every chart on the site goes
dark with no way back. `askGt` may therefore only be switched off by the
`?source=` PIN (the check script's seam), never by the preference — and that is
mutation-tested: letting `PREF` silence GeckoTerminal fails the guard.

- ⚠️ **The boot line prints the order**, for the reason the `[gt]` tier line
  exists: a setting that never arrived and a setting that did not help are
  indistinguishable from a browser, and this repo has lost evenings to an
  `.env` written to the wrong file.
- ⚠️ **A type PREDICATE narrows the FALSE branch too.** `(x): x is DsCandles`
  left `ds` as `null` after the ordering blocks, so every use below read as
  `never` and the "which kind of nothing" logic stopped type-checking while
  still compiling — the guard rail off, silently. A plain boolean does not.
- ⚠️ **The build-stamp guard was counting a code sample inside a COMMENT.** The
  repo's own rule — a scan for a line has to read the code, because comments
  quote the defect they guard against — had not been applied to that one test.

```bash
pm2 logs dexvra --lines 20 --nostream | grep -F '[chart]'   # which order is live
npm run chart:check                                          # per source, on the box
```

**Config a fix depends on:** nothing — `CHART_SOURCE` is optional and blank is
the shipped behaviour. But ⚠️ **whether the guessed shape answers at all is a
property of the server's egress**, so `chart:check` on the box is the only way
to learn it, and `GECKOTERMINAL_API_KEY` is still the only thing that raises the
real ceiling rather than dividing it.

#### "Chart unavailable right now" again — and one retry that was hammering a refusal

```
Couldn't read the chart just now (GeckoTerminal is rate limited —
cooling down for 92s; io.dexscreener.com 403).
```

**Both sources at once, and the panel said so correctly** — that message is the
feature working: it names each host and each reason, which is why the cause was
readable at a glance instead of being another round of investigation. There is
no code fix for the ceiling itself; ⚠️ **`GECKOTERMINAL_API_KEY` in the
repo-root `.env` is the only thing that raises it rather than dividing it**, and
that sentence is now in this file five times.

But the retry underneath it was wrong:

- ⚠️ **A 403 IS A REFUSAL BY THE HOST, AND RETRYING IT EVERY FIVE SECONDS IS THE
  429 DEFECT ONE STATUS OVER.** The panel fast-retries a transient chart failure
  every 5s (up to 8 times) so a chart draws itself the moment a GeckoTerminal
  cooldown lifts — and that is free upstream, because `gtGet` answers a
  cooled-down request WITHOUT making one. DexScreener had no such guard for a
  403: with GT cooling down and `io.dexscreener.com` refusing this box, **every
  chart view spent eight requests proving the same refusal**. Exactly the shape
  this file already names for CoinGecko — *"a 429 now arms a process-wide
  cooldown and the rest of the sweep is not asked at all"*. 401/451 join it.
- **404 is deliberately NOT in that set.** It is an ANSWER about the pair
  ("DexScreener has no pair for this token"), not a refusal of us, and caching
  it as an outage would blind the fallback for every other token. The same line
  `logoFill` draws between "nothing there" and "could not ask", and the same one
  the IPFS gateway list draws in the other direction.
- Mutation-tested: putting the 429-only guard back fails the test.

⚠️ **And the rebuilds themselves cost quota.** The OHLCV cache is per PROCESS,
so every `pm2 restart dexvra` empties it and the next view of every open chart
re-fetches. Half a dozen deploys in a row on a box already sharing ~30 req/min
with the bot suite is enough to sit in a cooldown for a while, with nothing
wrong anywhere. Worth knowing before diagnosing a chart that is only cold.

#### The logo came back — and the same rule was missing a third time

`$BREAKING` drew its real artwork the moment the gateway list deployed, which
settles that one. Two things the same screenshot showed, and both are the same
sentence written for a third source.

- ⚠️ **THE COOLDOWN WAS REPORTING A REFUSAL AS A RATE LIMIT.** The panel read
  `io.dexscreener.com 403` on one request and `rate limited — cooling down for
  55s` on the next, about the same host and the same refusal. Every cooldown
  message hardcoded "rate limited" because only a 429 could arm one — the moment
  a 403 could too, that line became a lie, and the two need different reactions:
  a rate limit passes by itself, a host refusing this server does not. The
  cooldown carries its REASON now and the panel prints that. "Never discard the
  reason", one module over.
- ⚠️ **A SOURCE THAT REFUSES US MUST BE BENCHED — FOR EVERY SOURCE.** CoinGecko
  learnt this when a 429 on row one cost a request per row for the rest of the
  sweep. DexScreener never did, and it is the source that matters MOST for the
  logos: pump.fun artwork lives there and `resolveLogo` asks it FIRST. On a box
  whose IP DexScreener refuses, every sweep spent eight requests proving the
  same 403 — for ever — and every one of those rows came back `undecided` and
  was requeued 30 minutes later. `benched` is ONE table now rather than a
  variable per source, because this is the third time the rule has been written
  in this repo (`gt.ts`, `dsChart.ts`, here) and a fourth private copy is how
  two of them end up disagreeing. `REFUSAL` is 401/403/429/451; a 404 benches
  nothing, because that is an ANSWER about the token.

⚠️ **And a token with no logo on OUR board that has one on DexScreener is now a
measurement, not a guess** — if DexScreener refuses this box, our best logo
source is unavailable there and it will say so:

```bash
curl -s -o /dev/null -w "api.dexscreener.com → %{http_code}\n" \
  https://api.dexscreener.com/tokens/v1/solana/<mint>
```

A 200 means the source is reachable and the row is simply still in the
resolver's queue; a 403 means DexScreener is refusing this server, and no amount
of sweeping will change that — the logos then have to come from GeckoTerminal,
CoinGecko or the launchpad.

#### "bisa di geser ke kanan ke kiri chartnya" — the other axis

The vertical landed and the very next thing asked for was the horizontal, with
the reference named: *"kaya trading view … atau dexscreener"*. Fair — **a chart
you cannot move through time is a picture**, and the two tools everybody arrives
from both do it: drag sideways to travel, wheel to zoom, and the candle under
the cursor stays under the cursor.

- **The state is `{count, endOffset}`, NOT `{startIndex, endIndex}`** — the same
  decision the price scale makes storing `{zoom, shift}` rather than `{lo, hi}`,
  and for the same reason one axis over. New candles arrive at the RIGHT every
  poll, so a pair of absolute indices would slide one candle further into the
  past on every refresh while the reader watched. `endOffset` is measured from
  the newest candle: a reader parked at the live edge stays there, and one who
  scrolled back stays exactly where they scrolled to. Pinned by a test that adds
  candles under a scrolled window.
- **ONE GESTURE, TWO AXES.** A body drag travels sideways and moves the price
  scale vertically at once, which is the grammar both references use. The gutter
  stays price-only.
- ⚠️ **The phone GAINS the horizontal and still never loses the vertical page
  scroll.** `touch-action: pan-y` hands the browser the vertical and leaves us
  the horizontal — which is exactly the half worth having on a phone. The
  earlier rule ("only a mouse may pan the body") was right when the body drag
  meant only the price axis; it would now cost a phone the one gesture it most
  wants.
- ⚠️ **THE WHEEL NEEDS A NATIVE, NON-PASSIVE LISTENER.** React attaches
  `onWheel` passively, and a passive listener **cannot** `preventDefault` — so
  the handler would zoom the chart and let the page scroll away underneath it at
  the same time. Bound with `addEventListener(…, { passive: false })`, and
  because it is bound ONCE it reads the geometry through a ref: a stale `geo`
  in that closure would zoom against a window that no longer exists.
- ⚠️ **The live dot does not claim "live" over candles from two days ago.**
  Scrolled back, the chart is still refreshing but what the reader is looking at
  is not the present; the pulsing dot would be the reassuring reading of a state
  that is not. A `HISTORY` chip takes its place, in the same microlabel voice as
  `via DexScreener`.
- **Every gesture is CLAMPED to the data** — a reader cannot scroll past the
  newest candle or before the oldest, so no drag can empty the panel. The
  horizontal version of the price axis refusing to walk below zero.
- **A slow drag accumulates.** Rounding each event to zero candles is a chart
  that responds without obeying — the same defect the double-applied zoom had,
  pointing the other way.
- ⚠️ **`limit` IS A QUERY PARAM, NOT A REQUEST COUNT.** The timeframes fetched
  180–200 candles, barely more than one screen fits, so there was nothing to
  scroll back INTO. Raising them (288 / 384 / 336 / 360 / 365 — a day of 5m
  through a year of daily) costs payload and **nothing else**: one request per
  timeframe either way, and the shared ~30/min GeckoTerminal ceiling is
  untouched.

⚠️ **And the preview's first pan check was measuring the wrong thing** — it
compared an axis stamp taken BEFORE the zoom, and the window had been clamped
back to the same first candle, so it reported the drag as broken while the drag
was fine. A check that fails on working code is as expensive as one that passes
on broken code. It zooms in hard first (with the whole history on screen there
is nowhere to travel TO) and compares against the state immediately before the
drag.

#### …and `logos:check` failed on its own happy path

`pm2 restart dexvra && npm run logos:check` is the order an operator actually
types after a deploy, and Next takes a few seconds to bind — so the check
reported *"the server did not answer"* for the one sequence it was written to be
used in. It retries the first connection now, bounded, and SAYS it is waiting.
A check that fails on its own happy path teaches the reader to ignore it, which
is the state `chart:preview` sat in for weeks.

```bash
npm test                                     # chartScale (29) + the panel guards
npm run build && npm start &
npm run chart:preview                        # 43 checks, both axes, and a phone
```

#### The audit round — the new module had dropped half of the six lines it replaced

- ⚠️ **THE LINEAR PADDING FLOOR WENT MISSING, ON THE VERY CHART THIS EXISTS
  FOR.** The code `priceScale` grew out of was
  `lo = Math.max(range.lo - pad, range.lo * 0.5)` — pad by 6%, but **never more
  than one halving below the lowest price**. The first cut kept the padding and
  dropped the floor. On a 35× move, 6% of the *range* is far bigger than the
  whole bottom of it, so `lo - pad` goes negative and the axis bottomed out at
  **$0**: a third of the panel handed to prices that never existed, squashing
  the early history that much further onto the floor. A fix making its own
  symptom worse. It is a LINEAR rule — log padding is symmetric in ratio and
  behaves by itself — and it is mutation-tested.
- ⚠️ **The `dragging` cursor came off a REF, so it never cleared.** A ref does
  not re-render: the class arrived on the first move and then stayed after the
  drag ended, until something else happened to re-render. `:active` needs no
  state and cannot get stuck.
- **`releasePointerCapture` was called on an element that may never have
  captured.** On touch the body drag is deliberately not started, so every
  touch-scroll across the chart arrives at `endDrag` with nothing to release.
  Chromium treats that as a no-op — **measured**, the phone check in
  `chart:preview` taps the chart and scrolls past it — but the spec allows a
  `NotFoundError` and this is the path every phone reader takes. Guarded with
  `hasPointerCapture`.
- ⚠️ **`chart:preview`'s phone context had no `hasTouch`**, so the "phone"
  checks were driving the DESKTOP pointer path and reporting it as the phone's —
  a guard measuring a stack the reader does not use, one surface over.
- ⚠️ **The clip probe went stale the moment the floor was restored** — the
  narrower auto range stopped pushing any candle past the price area, so there
  was nothing to clip and the check had nothing to prove. **The vacuity guard
  said so instead of passing quietly**, which is the entire reason it is there.
  Worth knowing why the fix was fiddly: the zone where the clip matters is only
  ~120px tall, between the floor of the price area and the bottom of the svg,
  which clips everything past it by itself. A 260px shove sails straight out of
  the zone and looks exactly like a chart that never overflowed.
- The header said **30x** where the token did **35x** — the number the whole
  section argues from.

```bash
npm test                                     # chartScale (18) + the panel guards
npm run build && npm start &
npm run chart:preview                        # 35 checks, incl. LIN/LOG, every drag, and a phone
```



**Config a fix depends on:** nothing.

## "Mengapa masih tidak bisa buy token yang masih bonding curve?"

Because the four modules that read a curve were on `main` and **wired to
nothing**. `abi:check` could describe a curve perfectly and no button could
spend through one. This wires it — and the wiring is the small half.

⚠️ **A NAIVE WIRING WOULD HAVE SHIPPED INERT, and passed every test.**
`curveRoute.sane()` is the last gate and it refuses without an independent
price. The obvious source is `marketOf`, which asks DexScreener and
GeckoTerminal — and **both index POOLS**. A token still on a bonding curve has
no pool; that is the entire premise of the feature. So the gate would have
refused 100% of its own target set, at the last stage, after a dozen RPC reads
— wired, green, and never once firing. From Telegram that is indistinguishable
from a broken bot, which this repo already treats as costing what a wrong fill
costs.

An adversarial audit (six independent lenses over the buy path, the sell path,
the pricing sources, the tests, the messaging, and one whose only job was to
find how the design loses money) found eleven more. Each is fixed below, and
the four that could move money are MUTATION-TESTED rather than argued.

### `curvePrice.js` — the number that authorises the trade

Three tiers, ranked by how independent they actually are, and the weakest says
so out loud:

| # | source | independent of the curve? | of the slots? | tol |
| --- | --- | --- | --- | --- |
| 1 | the launchpad's USD price × Coinbase spot | ✅ two third parties | ✅ | 35% |
| 2 | the pad's market cap ÷ on-chain `totalSupply()` | ✅ | ✅ | 35% |
| 3 | the rate recent fills actually PAID | ❌ same transactions | ✅ different FIELD | 60%, `weak` |
| — | nothing | | | **refuse, naming WHICH nothing** |

- **Tier 3 is why it is not inert on the operator's own box.** Their
  `launchpads:check` says `✗ pons — can't reach api.pons.fun`, so tiers 1–2 may
  never answer there. What the contract PAID OUT is a different field from the
  argument `ratioE18` is read from — a trader's chosen bound versus the
  contract's actual payout — so it genuinely catches a slot that is not
  denominated in the output token. It catches nothing about staleness, curve
  movement, or a history somebody wrote on purpose, which is exactly why it
  carries a wider band and a `weak` flag, and why **a weak price may check the
  interface but may never become the on-chain floor**.
- ⚠️ **NOTHING HERE MAY BE ANSWERED BY THE CURVE.** That is the thing under
  test. `curveQuote()` exists and is deliberately kept apart: it is the curve
  quoting itself, right for a minimum-out floor and disqualified from `sane()`.
  A source scan pins that `priceWeiPerToken` never touches `chain.call`.
- ⚠️ **`tokenDecimals` ANSWERS 18 FOR A READ THAT FAILED**, and this is the one
  number that scales the answer by a power of ten. On a 6-decimal token that
  guess is off by 10¹², `sane()` refuses, and the refusal reads as *"the curve
  disagrees with the market"* — a confident wrong diagnosis pointing at the
  token instead of at our own throttled RPC. `tokenDecimalsOrNull` is the EVM
  twin of `solana.splDecimalsOrNull`, which exists for the same reason.
- **"Could not ask" and "nothing there" stay different refusals.** One is a line
  in `.env`; the other is a statement about the token.

### The money-loss paths the audit found, and what closed them

- ⚠️ **A CONSTANT ADDRESS SLOT WOULD HAVE PAID SOMEBODY ELSE.** The token and
  the sender are classified above it, so an address identical across every
  sample is a STRANGER'S — a recipient, a referrer, a router, and nothing can
  tell which. Replayed verbatim it is invisible to every gate downstream:
  `estimateGas` succeeds (the call is valid) and the price check succeeds (the
  AMOUNT is right — it is the destination that is wrong), so the buy lands with
  the tokens minted elsewhere and the only thing that notices is a balance read
  after the money is gone. It is UNKNOWN now, which is a refusal. **The zero
  address is exempt**: it is the same 32 bytes as the number 0, and sending to
  nobody is not sending to a stranger.
- ⚠️ **AN UNLIMITED APPROVAL TO A LOG-SCORED ADDRESS WAS THE ONLY UNBOUNDED
  LOSS.** Every other risk here is capped by one trade; that one is capped by
  the whole bag, for ever, and it outlives the trade. `approveExact` grants
  `amountRaw` and nothing more — the line `v4.js` already draws for a discovered
  router. And it **re-reads** the allowance rather than assuming: a token whose
  `approve` returns false leaves it short with nothing thrown.
- ⚠️ **AND THE ALLOWANCE GATE RAN FIRST**, above build, above the price check,
  so a `stage:'approve'` refusal said nothing about whether the call was even
  buildable. The caller granted, re-called, and could still be refused — with
  the approval standing for a sell that never happened. Everything that can
  refuse for free now refuses for free; only `simulate` genuinely cannot be
  pre-run without an allowance.
- ⚠️ **`sane()` IS SIZE-INVARIANT AND CANNOT SEE CURVATURE.** Both sides of its
  comparison are linear in size, so `size` cancels and the verdict is identical
  for a 0.001 and a 100 ETH buy. A bonding curve is convex, so a stranger's
  bound stretched to our size is either an always-revert or no bound at all.
  `SIZE_BAND` (4× either way) refuses outside a narrow band — and is LIFTED
  when the caller supplies its own independently-priced floor, because that
  bound is ours and correctly sized by construction.
- ⚠️ **TWO SLOTS THAT BOTH SCALE IS A REFUSAL.** `expected` is one variable,
  reassigned by each, so with two the LAST one becomes what `sane()` checks —
  on a `sell(tokensIn, minEthOut)` that compares tokens against wei. Worse, the
  slippage cut landed in BOTH: a 100% sell that hands over 95% and still books
  the position closed.
- ⚠️ **eth_call IS THE GATE, NOT eth_estimateGas.** `core.js` says twice that
  the Robinhood node strips revert data and returns a non-standard error
  envelope on `eth_estimateGas` — which is why `v3SwapGas` swallows a failed
  estimate and why the existing curve branch quotes with a `staticCall` and
  sends a flat limit. Robinhood is where Pons lives, i.e. the chain this whole
  feature is for: gating on the estimate there turns a node quirk into a
  permanent refusal, reported to the user as the CURVE rejecting them, with the
  reason stripped. The estimate is now best-effort, for the limit only.
- ⚠️ **A CALL WE ONLY HALF-READ IS REFUSED.** `argsOf` stops at eight words and
  the builder emits exactly the classified slots, so a wider call was silently
  TRUNCATED into malformed calldata — usually caught by the decoder reverting,
  i.e. by luck rather than by rule.
- ⚠️ **ONE SAMPLE PER TRANSACTION, NEVER PER LOG.** A curve that emits a FEE
  transfer alongside the trade produced two samples for one trade — identical
  calldata, and one of them carrying the fee as its `amount`. That silently
  satisfied `minSamples: 2` from a single trade, and let the observed rate price
  a buy at its own fee. Samples now carry `to` and an `exact` flag, and a payout
  that did not reach the trader is never a fill rate.
- ⚠️ **`ok` MEANT "a BUY was observed", AND `prepareSell` GATED ON IT** — so a
  curve whose recent trades are all sells could not be SOLD, which is exactly
  the market in which somebody wants out. A decoded sell leg is a complete
  answer to the sell question; the buy refuses on its own, where the sentence
  can name the fix.
- ⚠️ **A CONFIRMED BUY THAT RECEIVED NOTHING WAS BOOKED AS A SUCCESS.** The
  pending guard needs BOTH a missing receipt and no balance gain, so
  `status === 1` with zero tokens fell straight through: full cost added to the
  position, `gotTokens: 0`, green tick. On v2/v3/v4 a positive minimum-out makes
  that unreachable; a discovered curve makes it reachable.
- ⚠️ **A CURVE THAT REJECTS OUR CALL IS FORGOTTEN.** The cache held the
  discovered address for half an hour, so a pad that redeployed left every buy
  in that window aimed at an abandoned contract with no path back except
  waiting — a stuck state indistinguishable from a broken feature.
- ⚠️ **DISCOVERY RUNS INSIDE `withWalletLock`**, so it has a ceiling
  (`CURVE_DISCOVER_MS`, 12s). Ethers' own request timeout is 300s, and every
  queued operation for that wallet — a triggered stop-loss, an auto-protect
  rescue, a copy-exit leg — waits behind it.
- ⚠️ **`canTradeNow` GAINED A CURVE LEG, or every automated path stays inert
  while the manual button works.** The dev snipe, the CA snipe, `_fireLaunch`'s
  gate and the launch retry ring all poll it. It reads the CACHE only: this is
  polled on a timer, and a dozen RPC reads per probe would cost the launch the
  snipe exists to catch. A cached yes is a cheap yes; the absence of one is "we
  have not looked", never "this token cannot be traded".
- **Every amount is normalised at the boundary.** `core.js` prices in Numbers
  and these modules are BigInt: an un-normalised float reached `hi - lo` and
  threw `Cannot mix BigInt` out of `core.buy`, which the router renders as
  "Something glitched handling that" — the gate CRASHING instead of refusing,
  with the user never learning a refusal happened.
- **`err.curve_refused`, in both languages.** "the curve rejected this call
  (execution reverted…)" matched the `reverted` in the slippage rule and came
  out as *"the price moved"* — a false diagnosis about a call the chain
  declined. And a refusal that matched nothing fell to `err.generic`, i.e. "try
  again in a moment". It deliberately does NOT say *"retrying won't change it"*:
  most of these are fixed by one more trade on the pad. Separately,
  `can't route through yet` now maps to `err.no_route`, where it always
  belonged.
- **The receipt NAMES the discovered route** and says which price checked it. A
  gate nobody can read is the same as no gate, and a strong check and a weak one
  are different assurances — the `via DexScreener` rule, one process over.

### ⚠️ …and the CARD would still have had no Buy button

`core.buy` filling a curve changes nothing if the only surface a user can press
it from never offers the tap. On EVM, `tokenSnapshot` ended at
`if (!m) return null` — no pool, no indexer, so **"❌ Couldn't price it"** and no
buttons, about a token trading perfectly well on its pad. Every gate above
would have been reachable only from a snipe.

- **The Solana branch has had a launchpad leg since it was written**; the EVM
  branch never got one — `launchpads.*` appears only inside `isSvm`. It has one
  now.
- ⚠️ **And the pad alone is not enough**, because the operator's own box reports
  `✗ pons — can't reach api.pons.fun`: a launchpad-only leg is null exactly
  where it is needed. So the last source is the token's **own trades**, on the
  chain we are already talking to — no third party at all, and the one source
  that cannot be unreachable.
- **`routable` is MEASURED.** `curveSnapshot` returns `routable: false` always
  and says why in its own header; this overrides it with whether an interface
  was actually read, the same way the Solana branch overrides it with
  `_solRoutable`. Reading a price is still not being able to fill.
- **`liquidityUsd` is `null`, never `0`.** A curve has no pool depth to report,
  and `0` on a card reads as a rug — the rule `launchpads.js` already states for
  this exact field.

### "walaupun token launch di launchpad manapun" — the two things that were narrow

Nothing here was ever pad-SPECIFIC: the interface is read off real trades, so
the pad is data. But two constraints made it work on a Pons-shaped launch and
not on the rest.

- ⚠️ **THE WINDOW WAS FIXED AT 5000 BLOCKS** — under three hours on a
  two-second chain. A pad whose tokens trade a few times a day reads as "no
  trades found" there, which is a statement about the WINDOW reported as a fact
  about the TOKEN. `ifaceFor` escalates (`CURVE_WINDOWS`, 5000 → 60k → 400k),
  and **only on that one answer**: widening the first look instead would make
  every lookup pay for the slowest pad, on a call that sits inside the wallet
  lock, and a dead node asked three times is three times the same silence.
- ⚠️ **A PAD PRICED IN ITS OWN ERC-20 WAS REFUSED.** Robinhood's pads take the
  native coin; Virtuals-class pads take their own token. That buy pays no
  `msg.value`, so **which** token it takes is in neither the calldata nor this
  token's own logs — it is in the transaction's OTHER Transfer logs, where the
  trader paid the curve. One extra read, and only for the pads that need it.
  - **ONE quote token, or none.** Samples that disagree are two pads behind one
    selector, or a router in the middle; picking the commonest would put a
    guessed token address on a money path.
  - **Two legs, using the EXISTING router** — the same V2/V3 swap `buy()`
    already makes, aimed at the quote token, then an exact approval, then the
    curve. Not a new money path.
  - ⚠️ **A failure BETWEEN the legs leaves the user holding the quote token**,
    and every such error says so. The v4 wrapping path set that precedent with
    *"Your ETH is safe as WETH in the wallet"*.
  - ⚠️ **`size` is decided where the DIRECTION is known**, not derived later. A
    buy's size is what was PAID (native, or the quote); a sell's is what was
    handed over. Three places had to learn it and two of them were caught by a
    test rather than by reading: `observedRate` divided by `value`, so the
    whole fallback tier was **dead on exactly the pads whose HTTP host is most
    likely unreachable**; and the size band compared the tokens a trade
    RECEIVED against the quote we were about to PAY — two currencies — refusing
    every such buy as "a very different size", which reads as a rule working
    when it is a unit bug.
  - ⚠️ **A quote pad may not be priceable until after leg one**, because the
    observed rate is per unit of what the pad CHARGES. Whether that rate
    EXISTS is knowable from the samples alone, so the refusal still happens
    **before any money moves**.
  - **The independently-priced floor is DROPPED for the second leg.** It was
    computed for native we no longer hold in full — leg one spent its own
    slippage — so carrying it over would set a bound above what the curve can
    now pay and revert our own buy.
  - **The sell swaps the proceeds back**, best-effort: the tokens are already in
    the wallet, so a failed swap-back is a nuisance and never a loss, and
    refusing the whole sell over it would be worse.

### The insertion point, and why there is only one

`resolveCurve` resolves the **pools.trade** factory only, so a Pons token
answers `''`, which is then read as "graduated" and routed to the DEX. One
insertion inside `pick.kind === 'v2' && !_v2Fillable(pick)`, after the v4 probe
returns null, closes both dead ends — and ⚠️ **the second is the one the target
tokens actually hit**: the `can't route through yet` throw is guarded on the
token being INDEXED, and a pre-migration token is not, so control used to fall
through to the V2 router and die at `getAmountsOut`.

⚠️ **AND THE FIRST ARGUMENT IS THE PROVIDER, NOT `chain`.** The local `chain` is
the config record from `chainOf` and has no `getLogs`. Passing it does not
throw — it answers *"could not read the chain head"* and the buy falls back to
the old sentence, so the feature ships inert with no error anywhere. That is why
`curveBuyPath.test.js` asserts a **POSITIVE**: a refusal-only suite passes on
the broken wiring, and mutation-testing that exact substitution fails four tests.

```bash
cd tradebot && node --test curveIface.test.js curveRoute.test.js curveTrade.test.js curvePrice.test.js curveBuyPath.test.js curveSellPath.test.js
cd tradebot && npm run abi:check              # what THIS box can read off a curve
```

**Config a fix depends on:** nothing — but ⚠️ **it ships ON and that CHANGES an
existing install on deploy**, deliberately, the way the trending floors did.
`CURVE_ROUTE=0` is the kill switch and restores the old behaviour EXACTLY (the
old sentence, not a new one about a feature the operator turned off — pinned by
a test). `CURVE_DISCOVER_MS` bounds the discovery.

⚠️ **What could NOT be verified from here.** Every module is driven against stub
chains because this sandbox has no egress, so what remains unmeasured is
whether a real Pons curve's arguments classify at all, whether that node's
`eth_call` accepts a value-carrying call, and whether any EVM pad in
`shared/launchpads/pads.js` publishes a usable pre-migration price. The first
real buy on the box is the measurement, and `npm run abi:check -- <the token>
--curve` is what predicts it — section **4** now prints what each argument
MEANS, which is the same inference the buy path runs.

### "bot tidak bisa beli token di beberapa launchpad jika masih bonding curve" — INDEXED made it worse

Reported (2026-08-28) with the feature above fully deployed: the same Pons
token, the same card — price, cap, liquidity, volume all filled in, *"This
token's liquidity is on Pons v2, which Dexvra can't route through yet … Price
above is live from the indexer"*, and no Buy button. **That last sentence was
the diagnosis.** DexScreener indexes several pads' bonding curves as ordinary
pairs — Pons on Robinhood among them, since DS added the chain — and
`tokenSnapshot`'s curve leg only ran when `marketOf` answered NULL. An indexed
curve token took the `dexVenue:'ext', routable:false` branch without the curve
reader ever being consulted, `telegram.js` gates every Buy button on exactly
that field, and `core.buy` — whose own curve leg fills this exact shape,
indexed or not — was unreachable from the one surface a user can press Buy on.
**Being indexed made a token LESS buyable than being invisible.**

- **The indexed branch consults `_curveIface` now** and returns a routable
  curve snapshot when the interface reads: the indexer's numbers stay (they are
  facts, and the card the operator screenshotted showed them), the route comes
  from the chain. Bounded (`CURVE_DISCOVER_MS`) and cached (curveTrade: hits
  30 min, misses 90s), and an AMM can never read as a curve — the curve is the
  contract the token itself moves to and from, which a router never is.
- ⚠️ **AND `canTradeNow`'s curve leg now WARMS the cache it reads.** It read
  the cache ONLY, on the stated assumption that "buy() does the discovering,
  and the first buy warms this for every prober after it" — an assumption that
  is false for exactly the tokens the leg exists for: a snipe-watched launch
  never gets a manual first buy. The dev snipe, the CA snipe, `_fireLaunch`'s
  gate and the retry ring all poll `canTradeNow`; nothing ever filled the
  cache; so every automated path still bought at graduation while the manual
  button worked. The probe still answers NOW from the cache (the callers are
  timers, and a dozen serial reads per probe costs the launch) — the discovery
  runs FIRE-AND-FORGET, bounded, paced per token (`CURVE_WARM_MS`, default
  120s), and the next poll reads what it learned. A brand-new curve with no
  trades stays unreadable until somebody trades on the pad; the snipe now
  fires within a poll or two of that first observed trade instead of at
  graduation.
- Both are MUTATION-TESTED as positives, the `curveBuyPath` rule (a wiring
  that does nothing refuses beautifully): restoring the unconditional
  `routable:false` and dropping the warm each fail their tests.
- ⚠️ **And the window ladder was stopping one rung short on a range-capped
  node.** A node that REJECTS the wide `getLogs` (Robinhood's public RPC caps
  ranges — fbf33e2's subject) while serving every step produced a stepped walk
  that cleanly covered the whole span, found nothing — and was reported as
  *"could not read"*, because one `lastErr` variable could not tell the wide
  ask's failure from a hole in the walk. `ifaceFor` escalates to the wider
  windows only on *"no trades found"* and caches only a non-transport verdict,
  so a quiet pad's token was re-walked from scratch on every attempt and never
  once looked in the window its trades were actually in. `stepErrs` separates
  the two: zero step errors is zero holes (the step size always covers the
  span within the budget), so the answer escalates and caches. Mutation-tested
  — collapsing the two errors back into one fails two tests, including the
  ladder-climbs-on-a-capped-node one in `curveTrade.test.js`.

```bash
cd tradebot && node --test curveCardPath.test.js   # 4 tests, no network
```

**Config a fix depends on:** nothing. `CURVE_WARM_MS` paces the background
warm; `CURVE_ROUTE=0` still kills the whole route, card leg included.

#### "masih sama aja" again — the walk was structurally BLIND to a quiet token's trades

The same token, the fix above deployed-or-not, the same card — and this time
the tell was on the card itself: **24h volume frozen at $320.96 across three
renders 90 minutes apart**. The token's last trades were HOURS old, and the
window ladder cannot see a trade that old on this node no matter how often it
retries: Robinhood's public RPC **silently empties** wide `eth_getLogs` (a
50,000-block ask answered `[]` over real trades — the incident that forced the
stepped walk), and the wider windows' steps grow with the span (400,000/24 ≈
16,667 blocks), so past some age EVERY range big enough to reach a trade
within the step budget comes back empty. The walk honestly reports "no trades
found", caches the miss for 90s, and re-reports it for ever — about a token
DexScreener was pricing on the same render.

- **The trades are found by their HASHES, from two seed sources — the chain's
  own first.** The node that empties a wide ADDRESS-filtered ask has answered
  wide TOPIC-filtered asks on this same box (it is how the preflight found the
  real Pons factory), so source 1 is the curve's own Transfer legs, topic-
  filtered by the pool address the indexer names (for an indexed curve token
  the DS pair address IS the curve contract) — no address in the filter, on
  purpose: the address is what re-triggers the cap, and a foreign token's log
  costs nothing because only the HASH travels. Source 2 is GeckoTerminal's
  pool-trades endpoint, where GT carries the pool. `ifaceFor` seeds discovery
  from the hashes when a window comes up empty — after the FIRST window, so a
  fresh launch still resolves without a seed request, and a quiet token skips
  the two wide windows that are usually blind to it anyway.
- ⚠️ **The hashes are POINTERS, never facts.** Everything decoded still comes
  off the chain's own receipts and transactions — the same trust base as
  `getLogs` — so a wrong or fabricated hash yields no receipt or no Transfer
  of OUR token and contributes nothing; classification, `sane()` and
  `simulate` are untouched. An indexer that is down costs the seed and
  nothing else: the ladder still runs, and the seed is also tried once after
  a walk that ended in transport failure (a different transport says nothing
  about this one).
- **The card path finally SAYS why it refused** — `[curve] card <chain>/<ca>
  unroutable: <why>` at info, because "not deployed", "discovery timed out"
  and "genuinely unreadable" were indistinguishable from Telegram, and every
  round of this report has started from zero because of it.
- Mutation-tested: disabling the seed fails the unit test AND the end-to-end
  card test that reproduces the reported state verbatim (every `getLogs`
  silently empty, DS pricing the token, GT naming the trades).

```bash
cd tradebot && node --test curveCardPath.test.js curveTrade.test.js   # incl. the seeded-discovery tests
```

**Config a fix depends on:** nothing. Whether GT serves the trades for a given
pool is a property of the box's egress — `npm run abi:check -- <token> --curve`
on the box is still the measurement when a card stays unroutable, and the
`[curve]` log line now names the stage that refused.

#### "ini token kan belum bonding" — the FIRST buyer could never buy, and that is the launch snipe

The next report was a token the operator had JUST launched: 0% to graduation,
0.002069 ETH raised, no trades. The observed route needs two trades of
different sizes on the token itself, so the first buyer of a fresh launch was
structurally refused — and the first buy is the entire point of sniping a
launch.

**The LEARNED-SHAPE TRANSFER is the answer, and byte-identity is its licence.**
A launchpad deploys the same curve for every token it launches. Every
successful discovery now RECORDS the pad's buy shape (selector + per-slot
roles, constants included; the sibling's ratio deliberately dropped — it is the
sibling's price), keyed by `keccak256(getCode(curve))` and persisted to
`DATA_DIR/curveShapes.json`. A fresh token whose indexer-named pool carries
**byte-identical code** gets the shape transferred: identical deployed code —
immutables live in the code — executes identically, only storage differs, and
the storage question ("is this really MY token's curve?") is answered by
`simulate`, because a curve bound to another token reverts the call.

- **What replaces `sane()` on a transfer** — there is nothing observed on THIS
  token to feed it: the shape was sane()-checkable when it was learned, the
  code identity carries the meaning over, and the on-chain floor is OURS from
  a STRONG price — `buildFromShape` refuses to build without one, refuses a
  shape with no minimum-out slot (gas alone is no gate), refuses two scaling
  slots, and re-refuses a stranger's constant address even out of the stored
  file (a file is not a proof).
- **Tier 2b joined `curvePrice`: the INDEXER's cap ÷ on-chain supply.** On the
  operator's box the pad's HTTP host is unreachable and a fresh launch has no
  fills for tier 3 — so without this there was NO strong price for exactly the
  tokens the transfer exists for. DexScreener publishes a cap for indexed
  curve tokens; same independence class as tiers 1–2.
- **The classify-short case rides the same proof**: a token with ONE observed
  buy (decodable, not classifiable — "only 1 sample") falls back to the
  learned shape when the selector matches what was observed.
- **One taught sibling, ever, is enough** — the registry survives restarts,
  and any traded token on the pad teaches it organically (a card open, a buy,
  the snipe warm). Transfer is native-paid buys only; a transferred SELL is
  deliberately out — a sell's argument semantics cannot be disambiguated
  without observation, and "one sale by anyone teaches it" already stands.
- Mutation-tested: ignoring the bytecode identity fails the different-code
  test; the mandatory-floor, stranger-constant and no-minimum-out refusals
  each carry their own.

#### ⚠️ …and the walk's STEP SCALED WITH THE SPAN, so the ladder never reached anything

Three cards over 22 minutes carried the identical sentence — *"no trades found
for this token in the last 400000 blocks (also walked 24 smaller ranges)"* —
about a token whose launch buy is plainly on chain. **The number in that
sentence was the range we WANTED, and the range we COVERED was nothing at
all.** The stepped walk exists because this node answers a too-wide
`eth_getLogs` with `[]` rather than an error, and its step was
`ceil(span / budget)`: 209 blocks at the 5,000 window, **2,500** at 60,000,
**16,667** at 400,000. Every step of every window past the first was itself
too wide, silently emptied, and the ladder's whole purpose — reaching an older
trade — could not work. Meanwhile the snipe loop reads this same chain in
~60-block ranges all day.

- **The step is FIXED now** (`CURVE_LOG_STEP`, 500), because the range a node
  serves is a property of the NODE, not of how far back we want to look. How
  FAR we reach is the budget's job (`CURVE_LOG_STEPS`, 48).
- **TWO PASSES, coarse then fine.** Coarse keeps the old cheap behaviour for a
  node that serves wide ranges (and is what reaches a trade far back in the
  window); fine re-walks near the head in node-sized asks, and only when
  coarse found nothing. ⚠️ A node where every coarse step ERRORED is not
  re-walked — that is the same silence 48 more times, this file's own dead-node
  rule, which the second pass would otherwise triple the cost of.
- **The refusal quotes the range WALKED, not the range wanted.** "The last
  400000 blocks" described a search that did not happen, and it is why the same
  sentence came back three times while the real reach never changed.
- **`steppedLogs` is the one owner** and the seed, the sibling-curve scan and
  the decoder all read through it — the wide single ask was silently empty in
  every one of them.
- Mutation-tested: dropping the fine pass fails the new silent-cap test (a stub
  node that empties anything wider than it serves, with the trade older than
  the first window).

- ⚠️ **A TOKEN WITH *SOME* HISTORY BUT NOT ENOUGH promised a Buy it could not
  honour.** Two SAME-SIZED buys DECODE — so `ok` is true and the card offers
  Buy — but classify wrongly: with no variation to correlate against, a real
  minimum-out reads as a `constant`, `buildCurveCall` returns ok with
  `expected: null`, and `sane()` refuses every buy. The self-teach ran only for
  a token with NO history, so nothing taught the pad. Now: a shape with no
  amount-tracking slot is never RECORDED (it is keyed on the pad's bytecode, so
  a degenerate reading from one thin token would overwrite the good shape a
  properly-traded sibling taught, for every token on that pad), the teach runs
  on the classify-short case too, and `prepareBuy` falls back to the learned
  shape whenever the observed build cannot produce an expectation.
- ⚠️ **A ROUTED BUY NAMED NOTHING IT WAS PAID IN.** The quote detection
  required the payment Transfer to run TRADER → curve, so a pad whose website
  routes the buy (user → router → curve) pays from the router's address, no leg
  matched, and `quoteOf` — which needs every sample to carry one — went null.
  The live refusal was exactly that: *"this pad's buy is not paid in the native
  coin, and its trades do not show what it IS paid in"*, about a pad that
  plainly charges something. What the curve RECEIVED is the fact; who forwarded
  it is not. `quoteOf` still refuses samples that disagree, which is what keeps
  a router's own fee transfer from being read as the price.
- ⚠️ **AND THE REFUSAL NOW NAMES THE STAGE.** `err.curve_refused` swallowed
  `prep.why` whole, so a price refusal, a classify refusal and a simulate
  refusal all read as the same "a few more trades on the pad" — the "a value
  nobody can read is the same as no value" defect on the money path, and the
  reason four rounds of "masih sama aja" began with nothing to go on. The
  template is ours and carries markup; only the appended stage is escaped.
  (Five call sites also wrapped the whole friendly template in `esc()`, so its
  `<b>` tags reached Telegram as literal text.)
- ⚠️ **A LAUNCH NO INDEXER KNOWS YET had no curve address at all.** The pool
  lookup asked DexScreener and GeckoTerminal only, so a token minutes old that
  neither had indexed fell to *"❌ Couldn't price it"* — the exact state a
  launch snipe exists to act in. The pad's factory names the token AND its pool
  in ONE log, so the announcement that names this token is the binding, and
  every contract that log names becomes a CANDIDATE. They are offered, never
  trusted: the same log names the dex factory and the quote token, and
  `_shapeFor`'s bytecode gate picks — filtering to logs that name our token is
  what keeps a matched candidate OUR launch's curve rather than a sibling's.
  Only walked when the indexers gave nothing, so an indexed token pays nothing.
  Mutation-tested: taking the first candidate instead of the matching one fails
  the unindexed-launch test.

```bash
cd tradebot && node --test curveShape.test.js curveCardPath.test.js curveIface.test.js
```

**Config a fix depends on:** nothing — and the pad teaches ITSELF, see below.

#### …and "teach it by pasting a traded token first" was the same defect again

The transfer shipped needing the pad to be primed once, by hand. The next
report was the same screenshot: a fresh Pons launch, no Buy button — because
from Telegram, a route that needs a manual priming step is a route that does
not work. **"apt-get install is not a fix, it is a request"**, on the feature
that had now been reported four times.

- **`siblings()` is the self-teaching pass.** When nothing has taught the
  pad, the bot finds one of the pad's OTHER tokens, reads its interface, and
  records the shape — which then transfers to ours. Recursion stopped at depth
  1 by `learning`.
- ⚠️ **AND ITS FIRST SOURCE HAD TO BE THE CHAIN.** The first cut asked
  GeckoTerminal for the pad's other pools, and on the one chain this feature
  is for GT need not carry the pad at all: the next card came back *"no trades
  found … nothing to read its interface from yet"* — nothing had taught the
  pad and nothing could — while the bot's own snipe loop had already seen
  **227 Pons launches** from the factory's announcements. Those are read now
  (`padFactory.announcersFor`, shared with `watchers.js` so a factory address
  has ONE owner), address+topic filtered, which is the narrow ask this node
  serves. The event's ABI is unknown, so **bytecode identity does the
  identification**: every address a launch log names is a candidate, and the
  ones whose code hashes equal our curve's are sibling curves by construction.
  A sibling's own Transfer legs then name its token, and carry the hashes the
  decode needs — no indexer at any point. GT's dex list stays as the second
  source.
- ⚠️ **THE BYTECODE GATE HOLDS ON THE TEACHING PATH TOO.** A sibling teaches
  nothing until `_shapeFor` matches OUR curve's code — so a wrong list, a
  different pad, or a hostile answer contributes nothing at all. Pinned by its
  own test and mutation-tested: taking the sibling's own pool as the key
  instead of ours fails it. ⚠️ The code comparison in the CANDIDATE scan is a
  cost filter and says so — mutation-testing proved it changes no outcome,
  because a shape is recorded under the code hash of the curve it was read
  from and `_shapeFor` looks it up under ours. Writing it up as the boundary
  would have been a comment describing a guard that is somewhere else.
- ⚠️ **AND THE REASON MOVED ONTO THE CARD.** The card path already logged why
  it refused, and the operator's `grep '[curve]'` came back EMPTY on a box
  rendering that exact card: the snipe loop writes several lines a second, so
  the one line that mattered had scrolled past `--lines 200`. A diagnostic
  that exists and cannot be retrieved is "a value nobody can read is the same
  as no value" — it cost four rounds. `curveWhy` rides on the snapshot and
  `unroutableCard` prints one short line, only when a reason was recorded.

### "sudah berhasil tpi bot respon lama sekali" — two RPC waves that never needed to be serial

The curve buy landed (a Pons bonding-curve token rendering the full card with
Buy 0.01 / 0.05 / 0.1, Limit buy and DCA), and the next thing the operator
said was that the card takes too long to arrive. Measured against the code
rather than guessed: `tokenCard` awaited `tokeninfo.enrich` — which on a curve
token reads the curve's interface, the slowest read this bot makes — and only
THEN read a `totalSupply` plus two balances per wallet, five wallets deep. Two
waves that know nothing about each other, in series, on the one screen a user
stares at after pasting an address.

- **The balances START before the scan is awaited and are COLLECTED after it.**
  They need one thing, the token's decimals, and `tokenMeta` is already
  fetching it — the same lesson the file's own header states about `tokenMeta`
  itself, one wave further down. ⚠️ `.catch` at CREATION, because every early
  return (no price, an unroutable card) leaves the promise in flight and an
  unhandled rejection for a balance read would take the process down.
- **`gasSnapshot` and `marketStats` moved up beside the snapshot** in `enrich`
  for the same reason: neither reads anything the snapshot produces, and both
  sat in the task list behind it.
- **`[ui] card … total=Xms enrich=Yms rest=Zms` past `CARD_SLOW_MS`** (1.2s).
  "The paste is slow" and "the wallet reads are slow" send an operator to
  different places — a scan timeout versus the RPC — and the existing
  `[ui] slow cb:` line reports only the whole handler. Silent under the
  threshold: a fast card must not write a line per paste into a log the snipe
  loop is already filling.
- ⚠️ **The gas guard was pinned to a LINE, not a property**, so moving the read
  earlier failed a test about gas being real. It asserts the property now — the
  read is made, it lands on `info.gas`, it is collected in the bounded task
  list — and the new overlap guard is mutation-tested: putting the serial
  `await core.tokenAcrossWallets(...)` back fails it.

⚠️ **What this does NOT fix: the RPC itself.** `SOLANA_RPC`-style paid
endpoints are the standing lever on every read here (see "The two biggest
levers are CONFIG, not code"), and on Robinhood the public node is what the
curve walk, the balances and the meta reads all share.

```bash
pm2 logs dexvra-tradebot --nostream --lines 400 | grep -F '[ui] card'
```

### The signature list was the feature's own ceiling

With the stage bound in, the card stopped timing out and said something new —
`interface read, but no BUY leg observed yet`. That is the curve reader
correctly reporting that **this is not a curve**: like `$CD`, `$MACROHARD`
trades through a ROUTER, whose arguments are a dynamic path array that
`curveIface` refuses by design.

`v4Calldata` is the module for that case, and it could not read this one:
`poolKeysFrom` began with `decodeVerified`, so a router whose signature was not
already written down decoded to nothing and its token read as unroutable.
**That is hand-writing an integration per launchpad — the exact thing the module
exists to beat.** One pad was known, the next was not, and the next never would
be.

- **THE POOL IS READ OUT OF THE RAW 32-BYTE WORDS, and no signature is needed.**
  ABI encoding lays everything out in words — a tuple array's contents, a nested
  dynamic tail, all of it — so reading the words is strictly MORE complete than
  decoding, not less. A known signature is still merged on top; it can only add
  candidates.
- **It costs no safety, because the safety was never in the decode.** Proofs 1
  and 2 exist to justify UNDERSTANDING a call, and nothing here understands one:
  exactly one value comes out — a PoolKey — and it survives only if the chain's
  own `poolId` hash of it equals a word the calldata already carried, which no
  misreading can fake. `bestPool` then reads that pool's state, so a proved key
  that does not exist is dropped. ⚠️ Widening what can be READ may never widen
  what is BELIEVED: a call with no matching id still yields nothing, and that has
  its own test.
- ⚠️ **AND THE GENERALISATION MADE THE SEARCH BIG ENOUGH TO BE THE 12s REFUSAL
  IN A THIRD DISGUISE.** Raw words make the candidate sets as large as the
  calldata, and this runs on the card's critical path. Measured rather than
  reasoned about: `AbiCoder.encode` costs **~156µs**, so 20,000 candidate hashes
  is **3.1 seconds**. `poolId` is hand-encoded now — five fixed 32-byte words
  need no coder — at ~23µs, and the search is capped at 20,000.
- **`poolId` stays the ONE owner of the hash.** A second, faster copy inside
  `v4Calldata` is how two modules end up disagreeing about the very thing being
  proved. Its equivalence to `abi.encode` is a TEST, not a comment — on a
  negative tickSpacing and both int24 boundaries, because a hand-rolled encoder
  is exactly the kind of thing that agrees on the easy cases.
- ⚠️ **A guard that a mutation run cannot kill is not a guard.** The explicit
  two's-complement step was deleted and nothing failed: BigInt's `&` and `>>`
  already work in infinite two's complement, so it was a no-op reading as
  load-bearing. It says so now instead of carrying a test that claims to cover
  it.

Mutation-tested: requiring the signature again, and dropping the poolId proof,
each fail between one and two tests.

```bash
cd tradebot && node --test v4Calldata.test.js uniswapV4.test.js   # 37 tests, no network
```

- ⚠️ **AND THE CAP WAS PER-CALL, WHICH IS NOT THE CAP IT CLAIMED TO BE.**
  `tradePoolKeys` reads up to six transactions, so "capped at 20,000" was really
  120,000 — ~2.8s of pure CPU on the card's critical path and on `canTradeNow`,
  which every snipe polls on a timer. The budget is the CALLER'S now and the
  whole scan carries a deadline (`V4_TRADE_SCAN_MS`, 4s): a partial answer beats
  a late one, and whatever was proved is already verified by its own poolId.
  Found by re-reading the fix for the very defect it repeats, one module over.

**Config a fix depends on:** nothing. `V4_ROUTER_SIGS` still adds a signature
(now only to widen the merged candidates), `V4_CALLDATA_MAX_HASHES` bounds the
search and `V4_TRADE_SCAN_MS` bounds the scan.

### ⚠️ The fix for the 12s refusal WAS the 12s refusal — an unbounded stage

Deployed, restarted, sha confirmed `abf13ed` on the box — and the card came back
with the identical sentence. So the stale-checkout reading was wrong, and the
cause was the fix itself.

`decodeCurveIface(… { full: true })` was hoisted in front of the ladder to turn
~75 serial requests into one. **It had no timeout of its own** — ethers' default
is 300s — while `core._curveIface` races the whole discovery against
`CURVE_DISCOVER_MS` (12s). So on a node that merely takes its TIME over
`fromBlock: 0` across ~49M blocks, that single request consumed the entire budget
and **nothing underneath it ever ran**: not the ladder, not the seed, not the
learned shape. Same sentence, opposite cause, which is exactly why three rounds
of it read as "masih sama aja" — and why "check the sha" was the wrong answer the
one time the sha was right.

- **NO SINGLE STAGE MAY CONSUME THE WHOLE BUDGET.** `STAGE_MS`
  (`CURVE_STAGE_MS`, 4s, floor 500ms) bounds the whole-chain look, and a stage
  that overruns its slice is INCONCLUSIVE — never a verdict. That is the same
  fail-safe direction the wide look's empty answer already takes, for the same
  reason: costing requests is recoverable, a false "this token cannot be traded"
  is not.
- ⚠️ **THE SEED IS SPENT BEFORE THE LADDER, NOT AFTER IT.** It used to be tried
  only once a window came back empty — sound while the walk is cheap, and on the
  node this feature exists for the walk is up to ~96 serial `getLogs`. So "seed
  last" meant **seed never**, on exactly the tokens the seed answers in three
  requests. It is a DIFFERENT TRANSPORT, so a slow node cannot hide it, and it is
  started CONCURRENTLY with the whole-chain look — one request either way, no
  latency where that look succeeds.
- ⚠️ **A PINNED WINDOW MAY NOT REACH FOR THE INDEXER.** `opts.blocks` asks about
  that window; receipts fetched by hash come from wherever the trades are, which
  answers a different question — the rule the whole-chain look already states.
- ⚠️ **EVERY OTHER TEST ON THIS PATH USES A NODE THAT ANSWERS INSTANTLY OR
  THROWS, AND BOTH ARE FINE ON THE BROKEN CODE.** SLOWNESS is the shape that
  catches it, and nothing in the suite had it. Two of the three guarantees also
  survived their first mutation run — the seed ordering was pinned by no test at
  all, because a stub whose walk is instantaneous cannot tell first from last.
  A guarantee that is argued rather than measured is not a guarantee.

Mutation-tested: unbounding the whole-chain look, moving the seed back behind
the ladder, and letting a pinned window reach the indexer each fail a test.

```bash
cd tradebot && node --test curveTrade.test.js   # 32 tests, no network
```

**Config a fix depends on:** nothing. `CURVE_STAGE_MS` widens the per-stage slice
for an operator on a slow node with a raised `CURVE_DISCOVER_MS`.

### "masih aja" — the buy refusal was invisible to everything but the person who tapped

Four rounds of this report, and every one of them started from the same place: a
screenshot of a Telegram message reading *"Stage that refused: reading this
curve's interface took longer than 12s — nothing was sent"*, and nothing
anywhere else. The CARD path logs `[curve] card … unroutable: <why>` and has
since it was written; **the TRADE path logged nothing at all**, so from the box
there was no way to separate the three things that produce that one sentence:
the window ladder actually walked (75 serial requests into the bound), the node
was slow, or the checkout was simply older than the fix.

- **`_curveRefused` sits at the CONVERGENCE, not at a stage.** `why` is set by
  the interface read, then possibly replaced by the price gate and again by the
  build — three stages, one throw. ⚠️ The first cut put it inside `_curveIface`
  and covered only the stage that happens to be reported today; the test written
  for it found no line at all, because the refusal it drove reads the interface
  perfectly well and fails at the price. A lesson applied to one branch of an
  if/else is a lesson half-learnt, so the SELL throw has it too.
- **ELAPSED is the discriminator, and it is what the test asserts** rather than
  the wording. ~12000ms is the bound tripping — something walked — and a few
  hundred is a real refusal with a real reason; those send an operator to
  completely different places.
- **Only a REFUSAL is logged.** This path runs on every paste and every warm,
  into a log the snipe loop is already filling — and a line per success is
  exactly how the card path's own line came to be missed under `--lines 200`.
- Mutation-tested: dropping the line, and moving it back to the interface stage,
  each fail the same test.

```bash
pm2 logs dexvra-tradebot --nostream --lines 400 | grep -F '[curve]'
```

**Config a fix depends on:** nothing.

## flap.sh, and four things the curve walk was getting wrong

Reported with four screenshots (2026-08-29): Maestro rendering `$CD` on **Pons**
and `$MACROHARD` on **FlapLaunch** — both Robinhood Chain, both a fraction of a
percent along their curves — beside DexvraTradeBot showing a live price for the
same two contracts and refusing to trade them.

Most of the answer was already here. The indexed branch had just learned to
consult the curve, the walk had just learned to climb, and the card had just
learned to carry `curveWhy`. **What was left is a second launchpad and four
defects underneath the walk**, each of which makes a quiet token — which is what
a token at 0.05% of its curve is — look untradeable.

### The walk handed back the OLDEST trades and called them the newest

`found.reverse()` looked right and could not be right. `steppedLogs` walks newest
RANGE first while `getLogs` returns each range oldest-first, so `found` is
"chunks descending, items within a chunk ascending" — sorted in neither
direction. Reversing that flat array gives "chunks ascending, items descending":
still not sorted. `decodeCurveIface` then takes `slice(-maxTx).reverse()`
believing it holds the newest trades newest-first, and on the walked path it held
the OLDEST trades of the newest chunk, oldest-first.

**Not cosmetic.** `curvePrice.observedRate` is the LAST price tier and the only
one that answers when the pad's own host is unreachable — which is this
operator's box, where `launchpads:check` reports `✗ pons` — and a curve's price
rises as supply sells, so feeding it the cheapest fills overstates
tokens-per-unit on the number that authorises a curve buy.

- ⚠️ **The first test written for it PASSED ON THE BUG.** With one log per range,
  `.reverse()` and a real sort happen to agree; the defect needs two logs in ONE
  range. A test that cannot fail on the defect is a test about nothing, and it
  took a mutation run to notice.
- **`_chrono` sorts on the two fields that define log order**, and reads
  `logIndex` or ethers v6's `index`, either missing sorting as 0 rather than
  throwing.

### `ok: true` did not mean "we can build a call", and it took the long cache

`curveIface` sets `ok` from having decoded a leg; `classifySlots` refuses to
assign meaning to an argument below `minSamples` (2). So a curve with exactly ONE
observed trade is `ok` AND unbuildable — and it was remembered for **thirty
minutes**, while the 90-second miss TTL beside it says in its own words that it
exists for *"not enough trades yet, which the next trade fixes"*. That is exactly
the state of the token this feature is for, and the card now reads this cache
directly, so the wrong TTL is what a user sees.

### One pasted CA was one discovery PER CALLER

The cache stores results, not promises, so nothing is written until a walk
FINISHES and a second caller arriving mid-walk starts its own. The card consults
this on every render of an indexed curve token, so it stops being "a user tapped
twice" and becomes "everyone who pasted this CA" — concurrent bursts of round
trips against a chain deliberately exempt from JSON-RPC batching
(`batchMaxCount: 1`), each making the other slower.

- ⚠️ **The in-flight key carries the CAPABILITY SET, not just the token.** A call
  that can seed from the indexer's trade list or teach from a sibling can succeed
  exactly where a bare one fails — that is why those seams exist — so handing a
  seeded caller the seedless answer would quietly discard the seed on whichever
  caller arrived second, in the quiet-token case the seeding was added for. A
  pinned window and a `learning` recursion are different questions again and are
  never coalesced.
- `forget()` drops the in-flight entry too, or a redeployed curve keeps being
  answered by the walk already running against its old address.

### A 429 bought a whole coarse pass, once per window

The walk exists for a node that serves small spans and rejects big ones. A
429/403/401 is about US and is waiting identically on every step of it — the
shape this file already records for the CoinGecko sweep, on the path that spends
money.

- ⚠️ **AND THE FIRST CUT OF THAT FIX TURNED A REFUSAL INTO A VERDICT.** Guarding
  the whole walk BLOCK also skipped the "could not read this token's transfers"
  return that lives inside it, so a refused node fell through to *"no trades
  found for this token in the last N blocks"* — a claim about the TOKEN produced
  by a host refusing US, which is the precise confusion this file exists to
  prevent. Measured, not spotted by reading. The skip guards the two PASSES only.
- **Anything unrecognised is treated as a RANGE problem**, so the walk still
  happens. That is the fail-safe direction: misreading a refusal as a range error
  costs requests; misreading a range error as a refusal would switch off the walk
  that is the fix for it.

### The second pad

- **`flap` is a new row** (Robinhood, `verified: false`) — added for the reason
  the Pons row exists: the factory scan filters ONE address for ONE signature and
  `eth_getLogs` answers an unknown one with an EMPTY ARRAY, so a launch on a pad
  nothing here knows about reads as a quiet chain, behind a green `/health`. A
  pad with a `feedPath` joins the snipe's discovery and the watchdog with no
  wiring of its own.
- ⚠️ **`ponsfamily.com` WAS ALREADY THERE** and already led the pons base list.
  Reporting "the API has been added" would be the reassuring reading of something
  that already shipped; what has never been measured is whether its PATHS answer.
- ⚠️ **A BASE LIST IS NOT INSURANCE AGAINST A WRONG PATH.** Failover between bases
  is TRANSPORT-only, so if `api.flap.sh` resolves and 404s we stop there and never
  try the others — the list covers only a host that does not resolve. What makes a
  wrong guess cheap is the env overrides, and the comment says so rather than
  letting the list imply a safety it does not provide.
- ⚠️ **A default `feedPath` is load-bearing, not decoration**: the builder applies
  `LAUNCHPAD_<KEY>_FEED_PATH` only to a pad that already has one, so shipping
  without a default would make the override silently do nothing and turning the
  feed on later would need a deploy.
- ⚠️ **`migratedPool` is read from two spellings only.** `curveState` turns ANY
  non-empty value there into `graduated: true`, forcing progressPct to 100,
  outranking every other pad in the merge and making the snipe skip the launch —
  so a pad reporting a `pairAddress` for its own curve would silently reclassify a
  live bonding token as migrated.
- `.sh` joined the probe-`costs` host regex. A guard that covers one instance of a
  general failure is how the general failure survives being fixed.

### ⚠️ …and the placeholder rule was broken AGAIN, in the fix's own handover

The operator was handed `LAUNCHPAD_PONS_TOKEN_PATH=/api/…/{id}` to paste, and
pasted it. **This is the file's first rule, for the fourth time** — but with a
new and worse ending: an angle-bracket placeholder at least dies with a shell
syntax error, and this one did not. `VAR=value` is a legal assignment whatever
the value is, so the shell returned a clean prompt and said nothing. Exported,
it would have made every pons lookup request `/api/%E2%80%A6/0x…` and 404 for
ever — indistinguishable, from `launchpads:check`, from the launchpad having
moved, which is the exact thing the override exists to fix.

**Rewording the placeholder is not the fix, and neither is remembering.** The
fix this file already prescribes is to make the code reject a value that cannot
possibly be right (`report.js` `_looksLikeChatId`). `realValue()` refuses an
override containing `…`, `...`, `<`, `>` or whitespace and falls back to the
built-in — and WARNS, because an operator who set something and is being ignored
must be told, or "the override did not work" and "the override was never read"
are the same observation. `{id}` and `{n}` are the legitimate fillers and are
untouched.

⚠️ The reference table `launchpads:check` prints (`LAUNCHPAD_<PAD>_API=<base>`)
stays out of scope, as recorded above: it is framed as variable NAMES to edit by
hand and explains `<PAD>` on the next line. What was wrong was presenting a line
with a placeholder in it as a value to set.

```bash
cd tradebot && node --test curveIface.test.js curveTrade.test.js launchpads.test.js
cd bot && npm run launchpads:check     # does flap.sh answer FROM THE BOX, and with what shape
```

⚠️ The tradebot copy takes a token address as its argument, and there is
deliberately no pasteable line for it here: this file's own first rule is that a
command an operator can paste must contain only real values, and **bash reads
`<` and `>` as redirects**, so an angle-bracket placeholder dies with a syntax
error before the script runs. Run `npm run launchpads:check` in `tradebot/` with
a contract address from the pad you are checking.

Five guarantees are MUTATION-TESTED rather than argued: the walk's ordering, the
short TTL on a single-sample read, the coalescing key carrying the capability
set, the refusal classification in both directions, and flap's migration guard.

**Config a fix depends on:** nothing — every knob has a working default and it
all ships ON. ⚠️ But whether flap.sh's guessed HOST and PATHS answer is a
property of the server's egress today and **cannot be learned from here** (the
host is unreachable from this sandbox), so `launchpads:check` on the box is the
measurement and a wrong path is `LAUNCHPAD_FLAP_API` / `_TOKEN_PATH` /
`_FEED_PATH` in `bot/.env` — a line, not a deploy.

⚠️ **What this still does NOT do: trade a curve nobody has traded yet.** The
interface is read off REAL trades, so a token with fewer than two of them is
refused. That boundary is deliberate: a guessed ABI on a money path is the one
thing this repo refuses outright.

## "Bisa buy and sale walau masih di bonding curve" — the pool was found, the payment was not

Four screenshots, then the box settled it. `abi:check` on `$CD` (Pons,
Robinhood) printed the selector's registry match and discarded it:

```
swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],
     address,uint256,uint256,uint256)  — discarded: signature takes 14 argument(s);
                                          the trades show 8
```

**That tuple is a Uniswap V4 path hop** — `uint24` fee, `int24` tickSpacing,
`address` hooks, `bytes` hookData, `bytes32` poolId. So the token does not trade
on a bonding curve at all: it trades through a V4-style router, and the pad's own
page says what against — **`Paired NVDA`**, a tokenised asset on that chain.

- ⚠️ **THE CURVE READER'S REFUSAL WAS CORRECT.** `arg[0]=0xa0`, `arg[6]=0x60`,
  `arg[7]=0x1c0` are ABI OFFSETS into dynamic data, not values, and args 3/4/7
  could not be explained. `argsOf` reads flat 32-byte words; rebuilding a
  dynamic-ABI router call from classified words emits malformed calldata, which
  is what the `wide` flag already refuses. Nothing to fix there.
- ⚠️ **The check DISCARDED a correct signature**, comparing ABI parameters plus
  tuple fields (14) against flat words read (8) — different units. Verified:
  `keccak` of that signature is exactly `0x4d819a2a`, and 5 top-level params
  means a 160-byte head = `0xa0`, which is exactly what `arg[0]` holds. Had it
  not been discarded, the first run would have said "this is a V4 router".

### The real gap, and it was three lines

⚠️ **A first reading of `bestPool` said the NVDA pool was never searched — that
was WRONG, and worth recording because it nearly produced the wrong fix.** The
constructed sweep is native/WETH-only, but fifteen lines further `bestPool`
merges in `discoverPoolKeys`, which reads the whole PoolKey off the Initialize
log, takes whichever currency is not ours, and verifies by recomputing the
poolId. **Any pairing is already found.** The defect is entirely on the payment
side:

| where | assumed | on an NVDA-quoted pool |
| --- | --- | --- |
| buy (`core.js`) | `wrapping = payWith !== NATIVE` | wraps ETH into WETH, approves WETH, swaps a token it does not hold |
| sell (`core.js`) | `v4QuoteToken = … ? null : chain.weth` | watches a balance that never moves, books `gained = 0` — a profitable exit as a total loss — then calls `withdraw()` on a contract with no such function |
| card (`v4.price`) | `priceEth` off `sqrtPriceX96` | a price in NVDA printed as native, feeding `mcapEth` and the USD cap |

- **`_acquireQuote` / `_dumpQuote` already existed** for the curve path and are
  reused rather than re-invented: swap into what the venue takes, approve exactly
  that, swap, and on the way out swap the proceeds back. Best-effort on the way
  out by design — the proceeds are in the wallet either way.
- ⚠️ **EVERY ADDRESS COMES FROM THE CHAIN.** The quote is a field of the PoolKey
  whose id was recomputed and matched. No launchpad reaches the money path, so
  the registry's oldest rule is intact — and this is why the fix is the pool key
  rather than the pad's `Paired NVDA` line, which says the same thing and may not
  be trusted to.
- ⚠️ **A foreign-quoted pool does not PRICE the card**, because a wrong number is
  worse than a missing one. The indexer prices it in USD, correctly — but the
  ROUTE the chain proved is carried down to the indexed branch, or the fix would
  take the Buy button away from exactly the tokens it exists to make buyable.
- **The swap is SIZED in what was acquired.** Quoting a foreign-quoted pool with
  the native amount prices the trade in the wrong unit entirely.
- **Every failure after leg one says what the wallet is holding** — the precedent
  the WETH branch set with "Your ETH is safe as WETH in the wallet".

⚠️ **What this does NOT do.** It does not make a token with no pool tradable, and
it does not replay a router call from guessed arguments. It also cannot be proved
from here: whether a given pad's pool is discoverable, and whether a route
ETH↔quote exists for leg one, are facts about the chain and the box. A missing
leg-one route refuses honestly ("this pad charges in a token there is no pool for
on <chain> — nothing was sent") and spends nothing.

```bash
cd tradebot && node --test uniswapV4.test.js robinhoodRouting.test.js
```

Four guarantees are MUTATION-TESTED: the buy's currency choice, the swap being
sized in the acquired amount, the sell's payout tracking, and the card refusing
to price a foreign-quoted pool. Each fails exactly one test.

### ⚠️ …and the 12s refusal was still there, because the fix for it was dropped

The next screenshot, after the deploy, carried the identical sentence: *"reading
this curve's interface took longer than 12s"*. **A one-request whole-history look
had been written for exactly that and then left out of the rebase**, on the
reasoning that the seeding work already on `main` had superseded it. It had not:
seeding is a fallback for a walk that comes back empty, and the walk is what
costs the twelve seconds in the first place.

The arithmetic is the whole story. The ladder is three windows, each paying a
wide `getLogs` plus a coarse AND a fine stepped walk — tens of SERIAL round trips
on a chain deliberately exempt from JSON-RPC batching, against a ceiling that
only ever bought a bounded refusal. A bonding-curve token's history is short and
the filter is narrow (one address, one topic), so `fromBlock: 0` is one request —
and `v4.js:180` already issues exactly that on this very chain.

- ⚠️ **AN EMPTY WIDE ANSWER IS INCONCLUSIVE, NOT A VERDICT.** A first cut read it
  as "this token has never traded" and cached that, reasoning that the whole
  chain cannot be too narrow. Wrong objection: narrowness was never the issue,
  the CAP is — this file's own header records a live box answering `[]` to a
  50,000-block range — and `fromBlock: 0` is the WIDEST range a capping node can
  be handed, so it is the request MOST likely to come back silently empty. Only
  an explicit refusal suppresses the ladder.
- ⚠️ **AND THE FAST PATH MUST NOT SKIP THE BOOKKEEPING.** The first cut returned
  straight out of the wide look, which skipped `_recordShape`, the sibling teach
  and the cache write below it — so a SUCCESSFUL one-request discovery stopped
  teaching the pad, and the next fresh launch on it (the case the shape registry
  exists for) lost its route. Four tests said so. It feeds `res` now and falls
  through the tail. A fast path that also skips the tail is not the same path.
- **The existing range-cap test could not see any of this**: it calls
  `decodeCurveIface` directly and never passes `full`. The new one drives
  `ifaceFor`, the door the bot uses.

**Config a fix depends on:** nothing.

## "Sama seperti Maestro agar bisa baca" — the pool is IN the router's calldata

Maestro trades a Pons/Flap token because it hand-writes an integration per
launchpad and therefore knows the router's ABI. This repo refuses a guessed ABI
on a money path, so the same token was unbuyable — and `abi:check` showed why in
one line: `arg[0]=0xa0`, `arg[6]=0x60`, `arg[7]=0x1c0` are ABI OFFSETS into
dynamic data, not values. `curveIface` classifies flat 32-byte words, which is
right for `buy(token, minOut)` and cannot work for a path array. Its refusal was
correct and is unchanged.

**`v4Calldata.js` does better than a hand-written integration, and needs no
per-pad code at all: it reads the POOL out of a real trade, and PROVES it.**

- ⚠️ **NOTHING FROM THAT CALLDATA IS EVER REPLAYED.** One thing comes out — the
  PoolKey — and it goes to `v4.bestPool`, which reads the pool's own state and
  builds OUR swap through the router it already discovers and simulates. A
  stranger's calldata never reaches a signer, so a hostile trade can at worst
  name a pool that does not exist, which the state read then drops.

Three proofs, and none is an inference:

| # | proof | what it rules out |
| --- | --- | --- |
| 1 | `keccak(signature) === selector` observed in real trades | a guessed ABI. `abi:check` found `0x4d819a2a` in six real trades on the box, and the shipped signature hashes to exactly that — a hash match is a fact, not a guess |
| 2 | decode, RE-ENCODE, require byte-identical | a signature that collides on four bytes while describing a different layout. This is what turns "the name matches" into "the layout matches" |
| 3 | recompute `poolId` and require it to equal a `bytes32` the tuple already carries | reading the tuple BY POSITION. v4 defines `poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`, so a wrong assignment needs a keccak collision |

Proof 3 is the one that matters most. The tuple is `(uint8, address, address,
address, uint24, int24, address, bytes, address, bytes32)` and **nothing
published says which address is a currency, which is the hooks contract and
which is a recipient**. Reading them by position is exactly the plausible-looking
mistake that puts a wrong address on a money path, so every assignment is hashed
and only a match survives.

- **The candidate pair is always (our token, some other address)** — structural,
  not a filter. A router path names every hop, and a pool without our token
  would price and trade a stranger's pair under our ticker. ⚠️ The
  `addrs.has(token)` early return is an OPTIMISATION and changes no outcome; the
  first cut of the test credited it with the guarantee, and a mutation run said
  otherwise.
- **The signature list is env-overridable** (`V4_ROUTER_SIGS`, `|`-separated,
  operator entries first) — the `pads.js` contract. Being on the list buys a
  candidate NOTHING: it still has to pass all three proofs, so a wrong entry is
  inert rather than dangerous, which is what makes adding one cheap.
- **It is the THIRD source and is asked LAST.** The sweep is four hashes and no
  request; `discoverPoolKeys` is one `eth_getLogs`. This costs a log scan plus a
  few `getTransaction`, and it is the only one that can find a pool whose
  Initialize log a range-capped node hides, or whose pairing nobody would have
  guessed.
- ⚠️ **A negative `tickSpacing` has two spellings.** ethers decodes `int24` to a
  real negative BigInt; a raw calldata word would be two's-complement near 2^256.
  Offering only the unsigned reading silently failed to prove an ordinary hooked
  pool.
- ⚠️ **The round-trip test had to use TRAILING GARBAGE, not truncation.** A
  truncated call makes `decodeFunctionData` THROW, so the try/catch catches it
  and the re-encode is never exercised — the first version asserted the guard and
  proved the catch. Extra bytes decode cleanly and only the re-encode notices.

```bash
cd tradebot && node --test v4Calldata.test.js uniswapV4.test.js
```

Four guarantees are MUTATION-TESTED: the trade source being merged into
`bestPool`, the round-trip proof, the poolId proof, and the pairing always
containing our token. Each fails between one and four tests.

**Config a fix depends on:** nothing. `V4_ROUTER_SIGS` adds a router signature
without a deploy; `V4_TRADE_SCAN_TX` bounds how many trades are read.

## "Can't route through yet" is THREE different venues, and the card says one thing

A token can be indexed, priced, and unroutable — and the card says only
*"liquidity is on <X>, which Dexvra can't route through yet"*. Three completely
different markets produce that one sentence:

| what it actually is | what unblocks it |
| --- | --- |
| a bonding curve whose interface could not be read | more trades on the pad, or the learned shape |
| a Uniswap-v4-style router | `v4Calldata` reads the PoolKey out of its own calldata |
| an AMM whose factory we do not know | nothing yet — this is the real gap |

`abi:check --curve` answers a NEIGHBOURING question by scanning up to 200,000
blocks for the token's own transfers, which on the node this matters for is slow
enough to be abandoned — and it was, twice, mid-run. **`venue:check` asks the
shorter question in about five requests**, because the indexer already knows the
pair address and a pair contract will say what it is if you ask it: `token0()`,
`token1()`, `getReserves()`, `factory()`, `fee()`, then the `to` and selector of
a real recent trade taken from the PAIR's own logs (address-filtered and narrow,
never a scan).

- **It reads and it prints — nothing here is a routing decision.** Every address
  it reports came from the chain or the indexer, and the bot still proves a venue
  for itself before it signs. Same contract `poolstrade.js` and the launchpad
  registry state.
- ⚠️ **It carries a PORT of `core.js`'s `DS_CHAIN_KEY`**, because that map is a
  private const and requiring core from a script boots the whole trade bot.
  `venueCheck.test.js` reads core's SOURCE and asserts the copy is equal — a
  stale slug makes the check report *"no pair for this token"* about a token the
  bot prices perfectly well, which is a diagnostic lying in the reassuring
  direction. Mutation-tested.
- **No pasteable command with a placeholder**, this file's first rule for the
  fifth time: only the operator knows which token they mean, so the argument is
  described in prose and no command is printed at all.

### …and its first run answered the WRONG WAY on the one line that mattered

`no logs from the pair in the last 20000 blocks`, about a pair doing **$6,069 of
volume a day**. Those cannot both be true, and the check was the thing that was
wrong: it asked ONE wide `eth_getLogs`, and this node **silently answers `[]`**
to a range that wide — the defect `steppedLogs` exists for, documented at its own
definition, broken in the script written to diagnose something else. A busy pair
reported as a dead one is a diagnostic lying in the reassuring direction, which
is the failure this file keeps paying for.

- **It drives the bot's OWN walk** (`curveIface.steppedLogs`), not a second idea
  of how to read logs on this chain.
- ⚠️ **The budget has to follow the span, or `--blocks` is decoration.**
  `steppedLogs` defaults to 48 steps of 500, so it reaches 24,000 blocks whatever
  span it is handed: a run asking for 40,000 quietly searched 24,000 and then
  quoted 40,000 in its refusal — the range it never walked. It prints what it
  actually reached.
- ⚠️ **THE `to` OF A TRADE IS A CANDIDATE, NOT A ROUTER.** It can be an
  aggregator, a multicall, or somebody's own contract, and reporting it as the
  router is how a guessed address reaches a money path. What PROVES it is
  `getAmountsOut(1e18, [quote, token])` — a view function on every V2 router, and
  a non-zero answer means that router's own factory resolves to THIS pair. It is
  read off the chain, and it is the same probe the buy path would have to make
  before it could sign anything.
- ⚠️ **`node --check` PROVED NOTHING** — the defect was a runtime shape, the
  lesson `curveTrade` had just learnt about an unbounded stage one file over. The
  test stands up an RPC that is faithful in the way that matters: it SERVES
  narrow ranges and silently EMPTIES wide ones, so a version that goes back to
  one wide ask finds nothing in the test exactly as it found nothing on the box.

#### The router was in the pair's BIRTH, not in its trades

The next run walked correctly — 80 steps, 39,999 blocks — and found **zero
logs**: that pair genuinely had not traded in ~22 hours. So a probe that reads
the router out of recent TRADES gives up on exactly the tokens most likely to
need it, and the answer was in the wrong place entirely.

**A `PairCreated` log is emitted BY THE FACTORY, and its two tokens are
INDEXED.** So one topic-filtered whole-chain query names the factory — the log's
own `address` — with no scan at all. This node empties a wide ADDRESS-filtered
ask and answers wide TOPIC-filtered ones, which is the rule `curveTrade`'s seed
already relies on, and it is exactly the shape of this query.

- **The factory is PROVED, not assumed**: `getPair(token0, token1)` has to
  resolve back to this exact pair.
- **The transaction that emitted it is the one that CREATED the pair**, and its
  `to` is whatever added the first liquidity — a router candidate that cannot go
  stale, still proved by `getAmountsOut`.
- ⚠️ **The router probe now runs whether or not the pair traded lately.** It sat
  inside `if (logs.length)`, so a silent pair produced no candidates at all.
- ⚠️ **AND THE TEST FOR THAT PASSED ON THE BROKEN CODE** — the stub's pair had a
  log, so the silence was never real and the mutation survived. A precondition
  assertion (`no logs from the pair`) is what makes it mean anything now.

Mutation-tested: the single wide `getLogs`, the missing `getAmountsOut` proof,
the missing factory discovery, and the trade-gated router probe each fail
between one and two tests.

```bash
cd tradebot && node --test venueCheck.test.js   # 6 tests, no network
```

**Config a fix depends on:** nothing — but what it reports is a property of the
box's egress and of the chain today, which is the whole reason it is a script and
not a test.
## "Mengapa gagal beli token" — five wallets spent one wallet's allowance

A live buy card, 2026-09-01: `$E5iD…pump` on Solana, wallets 2, 4 and 5, all
stamped **23:03**, every one of them reading

> ❌ Buy failed · Wallet 4
> Couldn't read live pricing for this token right now. Please try again in a moment.

**Not one word of that sentence is true of what happened, and the retry it
invites makes it worse.** Established by ELIMINATION, not by guessing: on the
Solana buy path exactly one thing produces `err.no_price`, and it is a non-2xx
HTTP status from Jupiter's `/quote` — every other failure there already has its
own key (`insufficient`, `diverged`, `unconfirmed`, `build_failed`, `no_route`).
`getQuote` threw `Jupiter quote failed (<status>)`, and i18n's `/quote/` rule —
written for a **pool read** that failed — matched the word and rendered our own
spent request budget as a fact about the token.

- ⚠️ **A FAN-OUT IS A BURST, AND `lite-api.jup.ag` IS METERED PER SOURCE
  ADDRESS.** One five-wallet buy fired, in the same millisecond: five `/quote`
  GETs, five `/tokens` reads for the same mint, and five `/swap` builds. Fifteen
  requests into a bucket sized for roughly one a second. This repo already knows
  this shape — *"five wallets were throttling each other"* is the section that
  batched `getSignatureStatuses`, and *"the ceiling is per IP, so the two
  processes' budgets have to ADD UP TO IT"* is the same lesson at
  GeckoTerminal. The Jupiter path had learnt neither.
- **FIVE WALLETS ASK ONE QUESTION.** `quotePath` is built from the two mints,
  the amount and the slippage — nothing about WHO is buying — so those five
  quotes were byte-identical and four of them bought nothing but a step towards
  the limit. A caller arriving while an identical request is still in the air
  joins it. ⚠️ **It is NOT a cache**, and that is the whole safety argument:
  only a request that has not yet ANSWERED is shared, and the entry is dropped
  the instant it settles. A remembered quote is a stale price authorising a
  trade, and a quote is the only executable price on this path.
- **The burst is PACED per HOST** (`JUP_MIN_GAP_MS`, 90ms). Keying it on the
  host is what makes the quote, the swap-build and the token registry share one
  budget without any caller having to know that they do — they are all
  `lite-api.jup.ag`. It costs a single-wallet buy nothing: by the time the swap
  build is issued, the quote's own round trip has already outlasted the gap.
- **A 429 IS WAITED OUT ONCE, NOT PAID N TIMES.** `Retry-After` is honoured and
  recorded process-wide, so the four requests queued behind the one that hit the
  limit wait for it rather than each spending their own 429 to discover it. That
  is the `benched` rule (`gt.ts`, `dsChart.ts`, `logoFill`), adapted: for a
  USER'S TRADE the answer is a **pace, never a refusal** — a fill a second late
  beats a red cross.
- ⚠️ **…but the wait is bounded by what a TRADE can afford**, not by the retry
  budget. The first cut let the deadline grow per attempt, so a `Retry-After:
  30` was **obeyed**: a buy sat for thirty seconds and then filled at a
  half-minute-old price, which is worse than the red cross it replaced. Past
  `JUP_MAX_WAIT_MS` (8s) the answer is the rate limit, named — with the hold
  still recorded, so nothing else pays for it.
- ⚠️ **RETRYING IS NOT THE BASE-FAILOVER RULE BEING WEAKENED.** *"Fail over on a
  TRANSPORT error only, because a status means the host answered and the same
  request gets the same status everywhere else"* still holds, and is exactly why
  a **400 is never retried at all**. 429 is the one status that explicitly means
  "ask me again later" and a 5xx is not deterministic; those two are re-asked on
  the SAME base, which is a different rule from moving to another host. Safe
  here and nowhere near the chain: `/quote` is a GET and `/swap` returns an
  UNSIGNED transaction, so a second attempt cannot double-spend. The broadcast
  is not on this path and is retried by nothing.
- ⚠️ **THE REPORTED REASON IS THE FIRST ONE, NOT THE LAST.** A hold still lets
  the other bases be tried — a different host is a different bucket, which is
  the whole point of a keyed base above the lite one — but the legacy fallback
  is retired, so it fails at the transport and its `can't reach
  quote-api.jup.ag` would have overwritten the rate limit that actually stopped
  the trade. An operator sent to check their egress for a problem in our own
  budget is the misdiagnosis this section exists to end.
- ⚠️ **`Number('')` IS 0, AND 0 IS FINITE.** A bare `JUP_MIN_GAP_MS=` in `.env`
  would have meant no pacing at all and `JUP_RETRIES=` never retry — the exact
  state being fixed, arrived at silently. Blank is ABSENT; an explicit `0` is
  still a real, honoured 0. Fourth time this repo has been bitten by a
  falsy-but-valid number.

### Three facts had one sentence

`Jupiter quote failed (429)`, `(400)` and `(503)` are our budget, the token, and
Jupiter — and all three came out as *"Couldn't read live pricing … try again in
a moment"*, under a 🔄 Try again button.

| status | is | says now |
| --- | --- | --- |
| 429 | our per-IP budget, spent by the other four wallets | `err.rate_limited` — nothing was spent; fewer wallets, or a key |
| 400 `COULD_NOT_FIND_ANY_ROUTE` | a fact about the token | `err.no_route` — retrying won't change it |
| 5xx | Jupiter | `err.upstream_down` — theirs, clears in a minute |

- ⚠️ **The 400 case is a defect this file already describes, through a door
  nobody shut.** The `err.no_route` comment names it for the parsed-empty-quote
  path — *"a user whose token simply has no tradable pool was told to keep
  retrying, and did"* — and the identical fact arriving as an HTTP STATUS went
  on falling into `err.no_price`. A lesson applied to one branch is a lesson
  half-learnt, which is the shape the snipe panel's refusal path already cost.
- **A swap-build 5xx KEEPS `err.build_failed`.** That key exists for exactly
  that status on exactly that endpoint (the v6-vs-v1 body spelling produced it
  as a 500), and it says the more useful thing — *"try a smaller amount"* — than
  "their side is down". The specific fact must not be swallowed by the rule
  written for the general one, so it is checked first.
- **The rate-limit sentence says `nothing was spent`.** After five red crosses
  that is the first question, and both new keys are in EN and ID like every
  other error here.
- ⚠️ **`tokenMeta` had the same stampede one layer up.** Five wallets call it at
  the same instant and the cache is still empty for four of them until the first
  ANSWERS — five `getTokenSupply` RPC reads and five Jupiter registry requests
  for one mint, a quarter of the burst. In-flight coalescing there too; it is
  not a second cache (`_metaCache` still owns remembering), so it changes how
  many requests are made and nothing about what is returned.

### `JUP_API_KEY` is the only thing that RAISES the ceiling rather than dividing it

The `GECKOTERMINAL_API_KEY` rule, one API over. It moves the bases to
`api.jup.ag` and sends `x-api-key`; unset is the shipped behaviour and stays
fully supported — this is headroom, never a prerequisite. The key is issued at
**`portal.jup.ag`** (the newer Developer Platform front door is
`developers.jup.ag`); the keyless tier Jupiter documents is **0.5 requests per
second — 30 a minute**, which is the whole arithmetic of this section: a
five-wallet buy asks fifteen in one millisecond, i.e. half a minute's allowance
instantly.

- ⚠️ **THE KEYED HOSTNAME IS A LIST, AND THAT IS NOT TIDINESS.** Jupiter's own
  documentation names the paid host as BOTH `api.jup.ag` (current, and what the
  portal's setup page gives) and `pro-api.jup.ag`. A key sent to the wrong one
  answers **401 — which is not a transport error and therefore does not fail
  over** on the standing rule, so a wrong default would make SETTING THE KEY
  break every buy: the fix for the rate limit becoming a worse outage than the
  rate limit. Current first, the alternative behind it, and **the free tier
  LAST**, so a refused key degrades to the keyless ceiling rather than to
  nothing.
- ⚠️ **"You are not allowed here" is the SECOND exception to the failover
  rule**, and for the 429's reason: 401/403 is a fact about the host+credential
  pairing, never about the request — the same key answers 401 on one host and
  200 next door. **404 is deliberately not in that set**: on the token registry
  it is a real answer about a mint nobody has listed, and treating it as a host
  fault would spend a second request on every unknown token, which is the budget
  this whole section protects.
- ⚠️ **…and a refused key may not be SILENT.** Falling back is fail-safe, and
  fail-safe is exactly how "the key works" and "the key is being ignored" become
  one observation — this file's most expensive recurring shape. Warned once,
  naming the variable, and saying the buys are still filling so it does not read
  as an outage.

- **The header is applied by HOST**, anchored (`/(^|\.)jup\.ag$/`), so an
  operator's key is never posted to a base it does not belong to and a lookalike
  domain cannot harvest it. It is in no log line and no error message, for the
  reason the RPC url is not: those go to pm2's log.
- **The boot line prints the tier and the pacing.** A budget nobody can read is
  how this one stayed invisible while it was failing trades — the same line that
  already had to exist for `prio=` and for `[gt]`.

```
[boot] jupiter: keyless lite tier (metered per IP — set JUP_API_KEY to raise it) · pacing 90ms between requests · 2 retry(ies) on 429/5xx
```

### "bagaimana agar masalah ini tidak terjadi lgi" — the answer was in a line that had already scrolled away

The key was set correctly (`OK, baris JUP_API_KEY sekarang berjumlah: 1`), the
deploy landed, the process restarted — and the verification step came back
**empty**:

```
pm2 logs dexvra-tradebot --lines 40 --nostream | grep -F '[jup'
```

Nothing. On a box where the boot line was certainly printed. ⚠️ **The snipe loop
writes several lines a second**, so a line printed at boot is past forty within
seconds — and this file already records that exact failure one feature over:
the `[curve]` refusal line cost four rounds of investigation because an
operator's `grep` came back empty on a box producing it. **A fact that lives
only in a log line is not retrievable**, and handing somebody `--lines 40` is
handing them a flashlight with the batteries out.

- **`jup:check` asks it on demand**, and asks the harder half too: a key that is
  set and REFUSED reads identically from the configuration, because the fallback
  is deliberately fail-safe. So it makes one real request and reports **which
  base answered** — a keyed box that answers from `lite-api` is a rejected key,
  and nothing else can tell you that.
- ⚠️ **It requires `core` BEFORE `solana`, and a test compares the POSITIONS.**
  `core.js` loads `tradebot/.env` and `solana.js` reads `JUP_API_KEY` at
  module-eval time, so the other order reports a correctly-set key as missing —
  a diagnostic about nothing. The same ORDER-not-presence rule `loadEnv.test.js`
  had to learn after its first cut matched the call anywhere in the file and
  stayed green over the deletion.
- ⚠️ **It never prints the key, not even a fragment.** This output is read off a
  terminal that gets screenshotted — the operator has sent three. Its length and
  its 4-character scheme prefix answer the question; a test pins that no wider
  slice can reach the screen, and that guard is mutation-tested.
- **It names the FILE it read.** "not set" over a path that exists is a missing
  line in that file; over one that does not, it is an `.env` written to
  `/opt/dexvra/.env` instead of `/opt/dexvra/tradebot/.env` — a mistake this
  file already records being made.
- ⚠️ **It does NOT print the counters.** They live in the RUNNING BOT's process
  and this is a different one, whose own are all zero. Printing them would be a
  diagnostic reporting its own state as the server's, which is the defect
  `trending:check` was caught by. It points at `/health` instead.

⚠️ **AND `/health` WAS RENDERING THE COUNTERS AS A LOOP.** `out.jupiter` was
added to the same flat map `/health` iterates as background loops, so it drew a
meaningless `🟢 jupiter — ran never` row and showed **none of the numbers it
exists for** — "a value nobody can read is the same as no value", committed by
the change written to end it. It is its own block now, and `refused` (a trade
lost) is rendered apart from `absorbed` (a 429 the retry got past), because
collapsing them makes a healthy budget read as a broken one.

```bash
cd /opt/dexvra/tradebot && npm run jup:check    # is the key live, and is it ACCEPTED?
```

### Which of the three it was is MEASURED on the box

⚠️ Whether Jupiter answers this server today is a property of this box's egress
and of Jupiter's current limits — the rule `raid:check`, `launchpads:check` and
`fonts:check` all state — so it cannot be settled from a sandbox with no egress.
The preflight takes a mint and answers it:

```bash
cd tradebot && npm run preflight:solana -- E5iDD4kt9gDxTaAeoCNeN3CcZAWB7FvbPXwqJuuHpump
```

- **It quotes the mint ONCE, and then fires the real fan-out.** One quote
  passing while the concurrent one fails IS the diagnosis: the budget, not the
  token. ⚠️ The burst uses DISTINCT amounts, or the in-flight coalescing would
  mask the very load the check exists to size — a check measuring the
  optimisation instead of the budget prints green over the failure it was
  written for.
- **It reads the two lines out loud**, because a status alone is not actionable:
  both ✅ / single ✅ + concurrent ❌ / 400 / 5xx / `can't reach` are five
  different next steps.
- **No usage line offering a bracketed blank.** A non-address argument is
  DIAGNOSED (`base58 has no 0, O, I or l`), never bounced to a usage screen —
  this repo has had a placeholder pasted into a live shell three times, and bash
  reads `<` as a redirect.

```bash
cd tradebot && SKIP_DOTENV=1 node --test jupiterQuota.test.js jupiterHost.test.js i18n.test.js   # 57 tests, no network
```

Ten guarantees are MUTATION-TESTED rather than argued — dropping the coalescing,
turning it into a cache, removing the retry, retrying a deterministic 400,
forgetting the 429, reporting the last failure instead of the first, letting the
429 fall back into `err.no_price`, reading a blank env as a real 0, shipping the
pacer off by default, and sending the key to every host. Each fails between one
and five tests.

### "bagaimana agar masalah ini tidak terjadi lgi" — the watchdog was probing the wrong question

Asked the moment the fix landed, and it is the right question, because
**everything above fixes the cause we found and nothing above would have TOLD
anybody.** The five red crosses were detected by a person reading Telegram and
counting. Nothing in this bot has ever said *"Jupiter refused us fourteen times
today"* — the same shape as the three-round "trending minimal harus 5" saga and
the three-round blank-percentage one, and the answer is the same: **watch the
SYMPTOM, because the causes keep changing.**

⚠️ **AND `upstreams.js` WAS ALREADY GREEN THROUGH THIS OUTAGE.** `jupiter.quote`
asks ONE question; the buy that failed asked fifteen. A single probe request is
exactly what a spent per-IP budget still has room for — so the watchdog would
have gone on printing 🟢 while every multi-wallet buy came back a red cross.
That is `fonts:check`'s nine green ticks over a banner publishing boxes, one API
over: **a guard is only honest while it measures the thing that actually runs.**

- **`jupiter.budget` is the probe, and it makes NO REQUEST.** ⚠️ The obvious fix
  — probe harder, fire five concurrent quotes a sweep — is the monitor causing
  the outage it monitors. It reads counters taken from the REAL traffic instead,
  which costs nothing and measures the users' requests rather than its own.
- ⚠️ **`absorbed` and `refused` are different facts and must never be one
  number.** A 429 the retry got past cost LATENCY; one that reached the caller
  cost a TRADE. Alerting on the first is a channel nobody reads by the second
  hour; not alerting on the second is how this went unseen in the first place.
  Only `refused` turns the probe red — which is also the bar that earns it
  `critical`, and `upstreams.test.js` pins the critical set so a fourth cannot
  be handed one quietly.
- **A request held on one base and SERVED by the next was never a refusal.** It
  is counted where the failure leaves the transport, once, or the alert fires on
  a budget that is working.
- **It rides the existing watchdog**, so it inherits every rule that machinery
  already paid for: transition only, a RECOVERY is an alert too, the boot sweep
  reports an outage it woke up into, and the ops channel gets it.
- **`/health` carries the same counters**, because the sweep is every ten
  minutes and an operator looking at a failing buy right now should not have to
  wait for one.

### ⚠️ A 429 IS THE ONE STATUS THE FAILOVER RULE DOES NOT COVER

Found by the audit round on this very fix. *"Fail over on a TRANSPORT error
only — an HTTP status means the host answered, and the same request gets the
same status everywhere else"* has a stated REASON, and that reason is **false of
a rate limit**: a 429 is a fact about the bucket on THAT HOST, and `api.jup.ag`
(keyed) and `lite-api.jup.ag` (keyless) have genuinely different ones. Exactly
the exception the IPFS gateway list already carries for a 404 — a CID is the
hash of the bytes, so the status is about the gateway and not about the content.

The first cut returned the 429 without ever trying the second base, throwing
away the one fallback that could still have filled the trade. A 400 still ends
the lookup outright, which is what the rule was written for.

- ⚠️ **AND THE TEST FOR IT PASSED ON THE BROKEN VERSION.** Two branches reach
  the next base — "the retries ran out" and "the wait is longer than a trade can
  afford" — and the test only ever drove the second, because a `Retry-After:
  600` leaves through it. Deleting the failover from the first broke nothing any
  test could see. **The mutation is what said so**, not review: a 429 with no
  `Retry-After` is the case that retries until it runs out, and it is now driven
  explicitly. A test that passes for the wrong reason is how the next round
  starts.

```bash
cd tradebot && SKIP_DOTENV=1 node --test jupiterQuota.test.js upstreams.test.js   # 40 tests, no network
pm2 logs dexvra-tradebot --lines 50 --nostream | grep -F '[upstream]'              # is the watch armed, and what did it find
```

Seventeen guarantees are MUTATION-TESTED rather than argued — the ten above plus
the failover on 429, collapsing `absorbed` into `refused`, not counting a
refused trade at all, a probe that spends the budget it monitors, the probe
losing `critical`, a refused key breaking the buy, that refusal being silent,
and dropping the second documented paid host. Each fails between one and four
tests.

**Config a fix depends on:** nothing — every knob has a working default and the
fix ships on. ⚠️ But `JUP_API_KEY` in **`tradebot/.env`** (`/opt/dexvra/tradebot/.env`
— the trade bot reads its OWN `.env`, and that mistake has been made) is the only
thing that raises the real ceiling rather than dividing it, and a box trading
five wallets at a time has outgrown the keyless tier. ⚠️ And if the preflight
says `400 / COULD_NOT_FIND_ANY_ROUTE`, **no configuration will help**: a token
still on a pump.fun curve becomes buyable when Jupiter can route it, and the
honest answer is the one the card now gives.

### "coba audit apakah ada bug saat pembayaran pakai chain eth eth robinhood"

Asked over the finished network picker. Five defects, and the two that matter
most are the two ETH rails being indistinguishable from each other — once on the
button that picks them, once in the wei the sweep holds back.

⚠️ **THE BANNER PICKER RENDERED TWO BYTE-IDENTICAL `0.0500 ETH` BUTTONS.** Banner
ads are USD-priced and quoted per chain, so THAT list is this flow's network
picker — and `payChain` pins whatever is tapped, so those buttons decide the
settlement network outright. Adding Robinhood put a second row under the first
with no way to tell them apart, on the one screen whose whole job is choosing
where to send money; the mistake it invites is mainnet ETH sent to a Robinhood
address, which nothing can credit. The file's own comment said the two rows
"show the same amount on purpose: a choice of rail, not of price" and then did
not name the rail. Every row carries `networkLabel(chain)` now — the SAME owner
pay.js's picker reads, so two screens cannot come to spell one network
differently. Measured by driving the picker, not by reading it.

⚠️ **AND THE SWEEP DID NOT RESERVE WHAT AN OP-STACK NODE CHARGES.** op-geth's
balance pre-check is `value + gas × gasFeeCap + l1Cost`, and this adapter only
ever reserved the first two: `value = bal − gasLimit × priceCap` leaves EXACTLY
ZERO slack, so any non-zero L1 fee rejects the sweep — deterministically, not on
a bad afternoon. Base is a payable chain and is now one of three ETH rails a Base
token is offered, so every Base sweep bounces with *"insufficient funds for gas *
price + value"*: a message naming the two terms that WERE covered and not the one
that was not. **The trade bot's withdraw path already paid for this exact lesson**
(`_l1DataFee`); the payment sweep never learnt it. Same shape here — the
predeploy is DISCOVERED rather than listed, a read that FAILED is never cached as
"this chain has no oracle", and an L1 fee we could not read stands in at the L2
cost rather than at zero, because too little is unrecoverable and too much is
dust that comes back as unused gas.

⚠️ **The estimate-failure fallback of 21,000 is wrong on Robinhood.** Nitro/Orbit
chains charge the L1 poster cost in GAS UNITS, which is why this repo's own
`nativeTransferGas` falls back to 120,000 with the note *"covers Orbit L1 gas"* —
and Robinhood's node is already documented here as answering `eth_estimateGas`
with a non-standard envelope, which is precisely the input that reaches this
branch. Signing 21,000 there does not fail cheaply: the transfer runs OUT OF GAS,
the gas is consumed, and the sweep never lands — then sweepRetry comes back and
burns it again. `UNMEASURED_GAS` is the generous answer, and the asymmetry is the
whole argument.

- ⚠️ **`ensureNetwork`'s "already there" test was a bare MENTION of the name.**
  An operator card saying *"we accept Ethereum, Solana and BNB"* names no network
  for THIS order and suppressed the enforced line completely. It tests the
  rendered phrase `Network: <name>` now — what the template emits, and the only
  thing that proves the line is on the card. The old test pinned the loose
  behaviour, so its RULE changed: a duplicate line costs a reader two seconds, a
  missing one costs an uncreditable transfer.
- ⚠️ **A caller with no `prices` table rendered `🔗 Network:  — send on this
  network only.`** — a blank where the network goes, on the message that takes
  the money. The label comes from the chain being ARMED now, never only from a
  picked option. Every flow passes a table today (a scan says so); the sixth one
  added later is what this is for.
- **`checking_payment` said `ROBINHOOD` where the pay card said `Robinhood
  Chain`** — two spellings of the settlement network on two consecutive
  messages, and the bare one is the broker-vs-chain ambiguity `NETWORK_LABEL`
  exists to prevent. One owner.

**Checked and found sound, so the next round does not re-check them:** every call
site's default option equals its `humanAmount` exactly, across every tier, every
trending duration, both renewal tables and Mass DM (driven, not reasoned about);
`netPick`'s `payPick = null` really does stop a double-tap, because the read, the
`optionFor` check and the clear are all synchronous after the one `await`;
`fulfillOrder` reads the TOKEN's chain off the payload and never `order.chain`,
so overwriting the order's chain with the pay chain cannot mis-list a token; and
the banner flow pins `payChain`, so its buyer is never asked twice.

```bash
cd bot && node scripts/run-tests.js test/payNetwork.test.js test/evmSweep.test.js test/confirmDetached.test.js
```

Nine guarantees are MUTATION-TESTED rather than argued: the banner rows losing
their labels, `ensureNetwork` back to a bare mention, the blank network line, the
toast back to the bare chain id, the gas fallback back to 21,000, the L1 term
dropped from the reserve, an unread L1 fee standing in at zero, a failed probe
cached as "no oracle", and the oracle called where there is none. Each fails
between one and two tests.

⚠️ **What could NOT be verified from here.** This sandbox has no RPC egress —
`rpc.mainnet.chain.robinhood.com` and every public node answer 403 through the
proxy — so the L1-fee arithmetic is proved against a stub node and against
op-geth's documented balance check, never against a live chain. The first real
Base or Robinhood sweep after this deploys is the measurement, and
`[sweepretry] … still stuck` in the ops channel is what says it is still wrong.

**Config a fix depends on:** nothing. ⚠️ Robinhood has ONE published RPC and no
second opinion, and it is now an option on every order rather than only on
Robinhood-token ones — so `RPC_ROBINHOOD_URLS` in `bot/.env` is the line that
buys a fallback, and `npm run rpc:check` on the box is what says whether it is
needed.

### "pastikan yang book listing or trending chain robinhood bisa bayar pake eth dan eth robinhood"

Asked as a check on the round above, and this time the answer is measured from
the FLOWS rather than from the option table: `payNetwork.test.js` drives
`listing.approve` (Xpress), `listing.tierPick` (every ranked tier) and
`trending.durationPick` (every duration on the ETH table) for a real Robinhood
listing and reads the picker a Robinhood buyer is actually shown — `0.06 ETH ·
Robinhood Chain` first, `0.06 ETH · Ethereum` beside it, one price. A table that
is right and a flow that never hands it over look identical from the table's
tests, which is the `curveBuyPath` scar, so the guard is the handler.

- ⚠️ **THE PAY CHAIN MOVES; THE TOKEN'S CHAIN MUST NOT.** A Robinhood project
  that settles on mainnet is still a Robinhood LISTING: `fulfillOrder` reads the
  token's chain off the payload and never `order.chain`, and the test pins that
  a Diamond order picked onto `ethereum` still carries
  `listingInput.chain === "robinhood"`. An order whose payload followed the
  rail would list the token on the wrong network.
- ⚠️ **Mass DM was the one package with its OWN idea of the pay chain.** A
  private three-way map — solana → SOL, ethereum/base → ETH, everything else →
  BNB on BSC — written before Robinhood was a chain here, so a Robinhood project
  buying Mass DM saw *"💳 Pay 0.15 BNB"* and a picker with BSC first, while the
  listing it had just bought was billed in ETH on its own chain: two packages,
  two answers to one question. `payChainOf`/`payNativeOf` are the one owner
  now; a coin the Mass DM table does not price (TRX, TON) still settles in BNB
  on BSC, which is what those buyers have always been offered, and the picker
  adds the ETH rails beside it.

Mutation-tested: mainnet dropped from the rails, the listing flow and the
trending flow each withholding their price table, and the private Mass DM map
restored — each fails between two and nine tests.

#### "bukan bukan seperti ini — kalo solana ya solana, eth ya eth, khusus chain robinhood aja"

Deployed, and the first screenshot back was a **Solana** project buying Xpress
and being shown a three-button picker — `1 SOL · Solana` · `0.06 ETH ·
Ethereum` · `0.06 ETH · Robinhood Chain` — where it used to see one pay card.
That was never the ask. The ask was about ONE chain: a Robinhood project may
settle its ETH on Robinhood Chain or on Ethereum mainnet, because those are the
same coin on two networks and an exchange withdrawal lands on mainnet. Every
other chain pays in its own coin on its own network, full stop.

- **`CHOICE_CHAIN = "robinhood"` gates the rails in `payOptionsFor`.** A
  Robinhood order reads `[robinhood, ethereum]`; every other order reads
  exactly its own chain, so `startPayment` arms it on the first call with no
  picker — byte-for-byte the flow that existed before the picker did. An
  Ethereum project is NOT offered Robinhood: the choice belongs to the chain
  whose buyers were asking for it, not to the coin.
- ⚠️ **The test file's default order was a SOLANA one**, so every picker test
  had been driving the exact case the operator did not want and calling it the
  feature. It is a Robinhood order now, and a Solana order has its own test:
  armed straight away, in SOL, `payPick` never stashed, no network button ever
  rendered, and the card still names `Network: Solana`.
- Mass DM follows the same gate through the same function: a Robinhood project
  gets the two rails, everyone else their own coin.

Mutation-tested: offering the rails to every chain again fails two tests.

**"add broadcast" — what exists and what does not.** A broadcast is sold here as
**Mass DM** (📣 on the main menu; `MASS_DM_PRICE` SOL 1 · BNB 0.15 · ETH 0.05;
CA → compose → pay → admin review in @dexvraadminbot → delivered to every
`/start` user), and the admin bot has its own free Broadcast Manager. What does
NOT exist is an **add-on offered inside the Xpress / Listing & Trending
purchase** — "➕ Add Broadcast" on the tier or pay step, bundled into one order.
⚠️ It was asked for "samakan kaya fourtis", with the fourtis bot file to follow,
and that file is not in the repo: the price per currency, where the option sits
in the flow, what the DM carries (the listing card, or text the buyer composes)
and whether it is reviewed are all facts about THAT bot. A paid add-on built on
a guess is a wrong number on a public bot the moment it deploys, so it is
deliberately not built until the reference is in hand — recorded so it is not
mistaken for an oversight.

```bash
cd bot && node scripts/run-tests.js test/payNetwork.test.js   # 30 tests — the Robinhood flows are driven, not read
```

## Two bot processes, one config

`bot/` runs **two** PM2 processes: `dexvra-bot` (`main.js`) and
`dexvra-adminbot` (`adminbot.js`). Always restart via the ecosystem file:

```bash
cd /opt/dexvra/bot && pm2 restart ecosystem.config.js --update-env && pm2 ls
```

`pm2 restart dexvra-bot` leaves the admin bot on the old code. It fails
silently and confusingly — the main bot shows a new feature working while
@dexvraadminbot has no menu entry for it, which reads as "the feature is
missing" rather than "that process is stale". Confirm both are `online`.

## Admin-editable templates beat code defaults

`bot/src/templates.js` holds a built-in default for every message; anything an
admin saved in @dexvraadminbot lives in `data/templates.json` and **wins**.
So changing a default in code does nothing on a box where that template was
edited. Say so when shipping copy changes: the operator has to hit
**♻️ Reset default** on that template to pick the new copy up.

The same applies to `data/` generally — it is gitignored, lives only on the
server, and survives `git pull`. So do `.env` and `.keys/`.

## What does not need a web rebuild

If a change touches only `bot/`, there is no `npm run build` and no
`pm2 restart dexvra`. Check before telling anyone to rebuild:

```bash
git diff --name-only <base>..HEAD | grep -v '^bot/'
```

Empty output means bot-only.

## The raid reads X by default — and an explicit `0` still wins

"bisa baca like rt komen dan updated realtime" (2026-08-12). The reading code
was already complete — `bot/src/raid/` has the paid API, the guest GraphQL
source and the embed source, tried in that order. **Nothing was missing and
nothing needed cloning.** What was wrong is that all three shipped OFF:
`X_BEARER_TOKEN` blank, `RAID_FREE_METRICS=0`, `RAID_GUEST_METRICS=0`. So
`xMetrics.anySource()` was false on a stock box, every raid launched crew-only,
and the like/reply/repost numbers could never move. From inside Telegram that
is indistinguishable from a broken feature: the goals are on the card and the
counts sit still.

- **`bot/src/raid/sourceFlag.js` is the single owner** of "is this keyless
  source on?". Absent or blank → ON. `RAID_FREE_METRICS=0` / `=false` / `=off`
  → OFF, and that must stay expressible: both modules carry real warnings (X
  blocks datacenter IPs hardest; the embed source's reply count is the whole
  CONVERSATION, so it can disagree with the number X prints on the post).
- **Blank ≠ false here**, deliberately, unlike `bool()` in
  `src/config/constants.js`. A `.env` carrying a bare `RAID_GUEST_METRICS=` is
  "never decided", not "refused".
- ⚠️ **A server whose `.env` was copied from the old template still says `=0`,
  and that wins.** The default change alone does nothing there — set both to
  `1` (or delete the lines) and restart with `--update-env`. This is the
  "config a fix depends on" rule above, and it is the single most likely reason
  the counts still look frozen after a deploy.
- **The two keyless sources are NOT independent fallbacks.** Both are gated by
  X's IP reputation, so a datacenter block takes them out together. Only the
  paid token (metered per app, not per IP) and the 🤝 Crew goal (zero X
  requests) are genuinely independent. The fallback chain reads more reassuring
  than it is.

**Realtime is `RAID_MOVE_BUMP_SEC`, now 0** (floor 0, was 60 with a floor of
20). When a like/reply/repost/crew join lands, the card is re-posted on the
NEXT poll instead of being edited in place — **an in-place edit notifies
nobody**, so from anywhere in the chat except directly on the card, a raid
that is progressing looked exactly like one that had stalled. Zero is safe
because the flood bound is `RAID_POLL_SEC`: a bump can only happen inside a
tick, and a tick that saw nothing move sends nothing. Chatter is a different
event and keeps its full `RAID_BUMP_MINUTES`.

**X rotates its GraphQL hash, so the seed is expected to be stale.**
`xGuest.js` resolves the operation id in three tiers — `X_GUEST_QUERY_ID` →
one discovered from x.com's own JS bundle → the built-in seed — and discovery
runs only after a 404 has proved the current id stale, at most once per six
hours. A rotation therefore publishes its own fix instead of silently costing
every group its repost count. Do **not** "fix" a 404 by editing the seed. A
pinned `X_GUEST_QUERY_ID` is never overruled (it is the escape hatch), so clear
it once a rotation passes or it becomes the stale one.

```bash
cd bot && npm run raid:check     # which source answers from THIS box, and why not
```

Whether X answers is a property of the server's egress today, not of the code,
so it has to be measured on the box.

## Auto-raid — the project posts, the raid starts itself

Ported to match FourtisRaid's panel (2026-08-13). 👤 X account names the
project's account, 🤖 toggles the watching, 🗑 Remove clears the target and
❓ How it works explains the three things this feature keeps being asked.

**There are TWO ways in, and the cheap one is the one that always works.** The
watcher polls each watched handle (`AUTORAID_POLL_SEC`, 60s) and raids a new
original post. A PASTED LINK does the same with **zero X requests** — the bot
already reads every group message for crew enrolment, so an admin pasting the
project's post IS the signal, and it works on an account X hides.

**X serves logged-out timelines SELECTIVELY, per account.** Two public accounts
read from one IP can give different answers, and no free source gets past that
— it is an authorization decision about the ACCOUNT, not about the box. Only
`X_BEARER_TOKEN` reads any account. Measure before concluding:

```bash
cd bot && npm run raid:timeline -- @yourproject   # probes a CONTROL account too
```

The control read is what separates "X is unreachable from this server" from
"X won't serve THIS account" — they need different answers and used to get one
shrug.

Rules that are load-bearing, each one a way a raid fires on the wrong post:

- **The first look only SEEDS.** Empty cursor = never looked; the first read
  records the newest post WITHOUT raiding it. Switching accounts resets it —
  snowflakes are one global sequence, so a stale cursor would instantly
  "detect" half the new account's history.
- **The cursor advances BEFORE the raid starts.** A missed auto-raid is a
  shrug; a double raid is the group spammed. A cursor that cannot be SAVED does
  not raid at all.
- **`auto(g)` mutates in place and returns the same object.** The spread form
  replaced `g.autoRaid` on every call, so a reference taken at the top of a
  function stopped pointing at the record the moment a nested call re-derived
  it — the cursor was written to a discarded object and the next tick raided the
  same post again. Caught by a test, not by reading.
- **The clear-words are matched BEFORE `parseHandle`.** `none`, `off`, `clear`,
  `stop`, `remove` are all VALID X handles, so parsing first starts watching
  `@none` — with the account being deleted replaced by a stranger's.
- **`lastCheckedAt` and `lastOkAt` are both needed.** The first is written on
  every tick whether or not X answered (so a stale value means the BOT stopped);
  only the second says X actually answered. With one, a bot blind for hours
  still rendered a green tick — the state that looks most like a healthy one.
- **A blind or stalled panel DROPS the ready line**, never rewords it. "The next
  post starts a raid" under "the bot can't see X" is two lines contradicting
  each other, and the false one is the reassuring one.
- **`settings.postUrl` has ONE writer** — the 🔗 Target post step.
  `startRaid(…, { tweetUrl })` lets auto-raid and a pasted link raid THEIR post
  without touching what the admin configured. A field the bot writes on an
  admin's behalf is one they cannot explain or remove.
- **The link route checks cheap → expensive**: regex on text already in memory →
  the group's config → is it the watched account? → is the sender an admin,
  LAST. That last one is a network round trip and this runs on every group
  message. A member's paste is ignored SILENTLY.
- **`xBundle.js` owns the queryId sweep** for both GraphQL callers. A bundle is
  megabytes; two sweeps would download the same bytes twice and get the host
  blocked twice as fast.

```bash
cd bot && node scripts/run-tests.js test/raidAuto.test.js   # 25 tests, no network
```

## The buy card had TWO ideas of "whale" and only one reached the artwork

A live card, 2026-08-13: header **MEGA BUY**, eight ordinary Dexvra icons under
it, the ordinary "New Buy" GIF, and
`Position: 23,507,098.11 $Plumber · $14,922 (+6913050524503.39%)`. Three
complaints, two causes.

**The label and the artwork answered different questions.** `tierFor(buy.usd)`
gives the headline from what was SPENT (`whale` ≥ $1,000, `mega` ≥ $5,000),
while the icon, the clip and the pin all keyed off `whaleCheck()` — whether the
BUYER is a whale by HOLDINGS (≥ $50,000). A $14,922 buy from a wallet holding
$14,922 is a mega buy by one measure and an ordinary buyer by the other, so the
card contradicted its own headline in two places at once.

- **`tierKey(usd)` is the single owner of the size thresholds** — `"buy"` |
  `"whale"` | `"mega"` — and the label, the icon (`buyIconFor`) and the clip
  kind all read it. **Never key artwork off `tierFor()`**: that returns the
  ADMIN-EDITABLE label, so an operator renaming or translating "MEGA BUY" would
  silently take the whale icon and the whale GIF away with it.
- **Pinning deliberately did NOT move with them.** A pin writes to somebody
  else's group; widening it to every mega buy would start pinning in every
  existing customer's chat without them asking. It stays on the whale-by-WALLET
  verdict. Same reasoning as `autoPinWhale` shipping off.
- The whale card itself is still the wallet verdict. Only the ARTWORK follows
  size — that is what "a big buy should look big" means.

**The Position percentage was two different sources subtracted.** `held` is an
on-chain balance read; `tokenAmount` is parsed out of the swap. Both land in a
float64 and agree to ~11 significant digits, so a first-ever buy does **not**
subtract to exactly zero — it leaves a residue (~0.0003 on a 23.5M bag, i.e.
1.4e-11 of it), and `bought / residue` is a thirteen-digit percentage. The tell
was on the card: the 💎 row and the Position row printed the **same** token
amount, so there was no previous position at all.

`POSITION_NOISE_FLOOR` (1e-6 of the holding) reads anything below it as that
residue and renders `new position`. It is a **precision floor, not a cap**: a
genuinely tiny prior position still prints its real, huge percentage, because
extreme-but-true is a different thing from fabricated. If you ever compare two
quantities from different feeds, assume the low digits disagree.

**And the balance behind it is read `{ fresh: true }`.** `holdingOf` caches a
success for two minutes, justified by "a wallet's holding barely moves between
two buys seconds apart" — true of every wallet except the ONE that just traded,
whose balance moved by exactly the amount the row is reporting. The cache was
pure harm on this path: `buyerPosition` is already resolved once per BUY (outside
the group loop), so a cached hit could only ever be a second buy by the same
wallet inside the window — printing the previous balance under the new buy, and
disagreeing with any explorer the group checked. A cached MISS still
short-circuits, because that one exists so a dead RPC costs one six-second
timeout rather than one per buy.

**Position is ONE token at the pool price, never a portfolio.** Solscan's "Total
Value" sums SOL plus every token in the wallet, so the two legitimately differ
and comparing them proves nothing. `walletHoldings.js` says so at the top and it
is worth repeating here: the comparable number on an explorer is the tracked
token's own balance line.

```bash
cd bot && node scripts/run-tests.js test/whaleAlert.test.js test/buyMonitor.test.js
```

## "Buy ngasal" — auto-snipe fired from a switch armed weeks of screens away

A user turned the COPY-TRADING master switch ON — no wallets followed, no CA
targets — and the bot bought two fresh launches at 0.0495 SOL each. What fired
was **Auto-Snipe** (`u.snipe.chains.solana` + `ethAmount 0.05` — the default is
0.01, so it had been armed through /snipe at some point and forgotten). The copy
switch is a different feature and touches none of it; `autoSnipeConsent.test.js`
pins those boundaries.

The report still named a real defect, in three parts, all fixed:

- **Arming is ANNOUNCED — and it is not a toggle any more.** The /snipe chain
  tap used to flip a feature that buys every new launch on the chain with real
  money, silently, reusing an amount set weeks earlier on another screen. The
  flow is chain FIRST now ("intinya pertama disuruh pilih chain dulu"): tapping
  an OFF chain opens Step 2, the amount screen, and only picking an amount arms
  — `armAutoSnipe()` is the ONE arming site, and the warning states the blast
  radius and the spend it was JUST given. OFF stays a one-tap stop (it is the
  🛑 button on every purchase message) and stays silent — a warning on OFF
  would teach users the message is furniture. A toggle also meant a second tap
  on an old 🛑 button silently re-armed; now it opens the amount step instead.
- **A message that spends money names its trigger.** All three auto-snipe
  purchase sites say "Auto-Snipe bought" plus "buys EVERY new launch on this
  chain while armed — this was not a CA or dev-wallet target"; the CA-target
  fill says "This was YOUR armed target". Three snipe features must be
  distinguishable from the message alone, or an unexpected buy cannot be traced
  to its switch.
- **The off switch is ON the purchase message** (`_autoSnipeKb` → the same
  `sntog` callback as the settings screen, so the button and the screen cannot
  disagree about what "off" means). The user should never have to hunt for the
  right screen while the bot keeps buying.

```bash
cd tradebot && node --test autoSnipeConsent.test.js   # 7 tests, no network
```

**Config a fix depends on:** nothing — but if the bot "buys by itself", check
/snipe first: an armed chain there is the only thing that buys without a target.

## Trade speed — the code paid round trips it did not owe

Three real serialisations on the Solana buy path, all found by reading the code
after "saya ingin buat bot lebih cepat lgi respn dan eksekusi":

- **The quote waited on chain reads it does not depend on.** `getQuote` needs two
  mints, an amount and a slippage — none of it from the chain — yet it was issued
  inside `solana.swap()`, i.e. only after `solBalance` + `splBalance` +
  `tokenMeta` had all come back. `_buySol` starts it as `quoteP` now and hands
  the promise in; `swap()` behaves exactly as before when it is absent. A buy
  that fails its balance check wastes one quote, which is the whole cost.
- **The divergence guard held a live quote for a display value** — the rule the
  guard itself was written under. "The reference runs concurrently so it costs no
  fill time" is true only while DexScreener is faster than Jupiter; when it is
  not, that unbounded `await refP` sat between pricing and signature for up to
  its own 5s timeout. Bounded by `SOL_GUARD_REF_WAIT_MS` (1200ms). Not a
  weakening: *"no reference is not a reason to block a trade"* was already the
  position two lines further down.
- **The bot's own fee sat between the fill and the receipt.** Deferring its
  *confirmation* was the first half; the *broadcast* was still awaited, and that
  is `getLatestBlockhash` plus a send the RPC **simulates first** — the fee
  transfer runs with preflight ON, unlike the swap. `feeHash` has exactly one
  reader (`feeCollected` in the ops report), so the report waits and the receipt
  does not; `res.feeHash` is filled in by the continuation so the flag stays
  truthful rather than optimistic. Both buy and sell.

**Every buy logs where its time went, phase by phase**, because every speed
change on this path had been argued from reading the code — which is how the
reference await survived being called free for as long as it did:

```
[buy] sol Ge87Etsj reads=160ms quote=8ms guard=2ms build=210ms send=170ms confirm=150ms prio=0
```

A phase that never ran is omitted, never printed as `0ms` — a zero meaning "did
not happen" reads as a finding. The line is printed on the FAILURE path too: a
buy that gave up waiting is the one whose confirm time most needs reading.

### Five wallets were throttling each other

The first thing the timings showed, five wallets into one token on one block:

```
swap=541ms  swap=527ms  swap=522ms  swap=1297ms  swap=2289ms
```

Same route, same quote, same slot — a 4.4× spread that is not the trade.
`confirmSignature` polls every 200ms, and the "~5 status reads per trade" it is
documented as costing is per **trade**: five concurrent confirmations is ~25
requests a second, arriving alongside five sends and fifteen balance reads, at an
endpoint that serves one IP far less than that. The throttling lands on the
confirmations because they are what is still running.

`getSignatureStatuses` takes an **array**, and always did. `signatureStatus()`
coalesces the polls that fall in one `SOL_STATUS_BATCH_MS` window (25ms) into a
single request, so the fifth wallet stops paying for the other four.

- **Each waiter gets ITS OWN index** out of the response. Getting that wrong
  reports four trades on one trade's outcome.
- **An RPC failure RESOLVES NULL, never rejects.** `confirmSignature` treats a
  transient failure as "keep polling"; a batch that rejected would turn one blip
  into every in-flight trade reporting "not confirmed".
- **The pending map is swapped out before the request goes**, so a signature that
  starts waiting mid-flight lands in the next batch rather than being answered by
  a read that predates it.
- `SOL_STATUS_BATCH_MS=0` restores one-call-per-signature.

### The two biggest levers are CONFIG, not code

Both dwarf everything above, and neither can be set from this repo — `.env` lives
only on the server.

⚠️ **The trade bot reads `tradebot/.env`, not the repo root's.** `core.js` loads
`path.join(__dirname, '.env')`, so on the box that is **`/opt/dexvra/tradebot/.env`**.
A value written to `/opt/dexvra/.env` is read by the web app and by nothing else:
the bot boots clean, trades fine, and stays slow, with no signal anywhere that
the setting never arrived. That mistake has been made. **Both knobs are on the
boot line now** precisely so it cannot be made silently again:

```
[boot] solana: rpc PUBLIC default (rate-limited) · priority fee OFF — transactions queue behind every paying one
```

The RPC **URL** is never printed — a paid endpoint carries its API key in the
path, and this line goes to pm2's log. Whether one is set is the fact worth
reporting; which one it is, is a secret.

- **`SOLANA_RPC`** — unset, the bot uses Solana's public endpoint, which is
  aggressively rate-limited and throttles the websocket hard enough that
  `confirmSignature` had to be rewritten to poll HTTP. A paid RPC changes `reads=`
  and the confirm poll more than any code change here.
- **`SOL_PRIORITY_LAMPORTS`** — defaults to **0**, and at 0 the field is omitted
  from Jupiter's `/swap` body entirely. On a congested Solana this is the
  difference between landing in the next slot and landing in ten, or being
  dropped. It is printed as `prio=` on every buy line above so it cannot stay
  invisible.

## The "Possible rug / dump" alert is REMOVED — do not add it back

Five wallets bought $Ge87…pump — 0.01312 SOL each, entry $0.00724, MC $7.25M —
and one minute later the bot said this **four times**:

> ⚠️ Possible rug / dump: value fell to ≈ **0.0131 SOL** from a peak of ≈ 0.1004.

Nothing had dumped. `0.0131` is one wallet's brand-new bag at the price it was
just bought at; `0.1004` was a holding in the *same* wallet that had already
been sold. **A position record survives being sold to zero** — it is what carries
the lifetime `ethIn`/`ethOut` — and `peakValueEth` rode along with it. With
`POS_RUG_DROP` at 0.15, `0.0131 ≤ 0.1004 × 0.15` exactly: arithmetically
certain, not unlucky, for anyone buying back into a token they once held bigger.

**A PEAK IS NOT A FACT ABOUT THE TOKEN** — it is the highest number this bot
happened to observe. That made the alert wrong in both directions: it fired on a
token that had merely retraced from a spike, it fired on a fresh bag whenever a
peak outlived a previous holding, and it stayed silent on a token that rugged
before it ever had a peak worth measuring. A warning that cries wolf trains the
reader to swipe the next one away, so the owner's call was to delete it rather
than tune it. `peakValueEth` and `POS_RUG_DROP` went with it; a value written to
the store every cycle for nobody is disk churn plus a field the next person has
to work out is dead.

- **🛡 Auto-protect is untouched, and is the guard that matters.** It *sells*, it
  measures against **your entry** and never against a high-water mark, and its DM
  is never muted by the 🔔 toggle. `RUG_MIN_PEAK` survives the deletion because
  auto-protect uses it as a dust floor — the env var keeps the misleading name
  because an operator may already have set it.
- **`_resetRiskIfFresh(p)` survives for the auto-protect cooldown.** A stale
  `protectAt` *suppresses* a real rescue on the new position — the same defect as
  the false alarm, with the loss reversed and far more expensive. It existed in
  `buy()` only; `_buySol` never had it, which is why the alarm was Solana-only.
  One function now, called by both, and a test names both call sites.
- **It must run BEFORE `p.tokens` is written**, or it inspects the bag it was
  meant to test. Adding to a LIVE bag keeps its history.
- **A deleted feature leaves a note where it was.** With no trace it reads as an
  oversight, and the next person to notice positions have no dump warning simply
  adds one back. `stalePeak.test.js` asserts both the removal and the note.

## A buy surfaces the monitor — reversed on purpose

*"harusnya ada monitor lgsung"*. `startMonitor` reused the pinned card in place
after a buy, on the reasoning that "churning the pinned message on every fill
would be worse than leaving it". That was wrong in the one case it mattered:
**receipts are always posted AFTER the fill** — a five-wallet buy pushes five
messages on top of the card — so after a buy the card is always buried, and the
moment a person most wants to see what they hold is the moment the numbers just
changed. What they got was five receipts each with a 📍 button and a live card
somewhere above the scroll. It is one surface per BUY (not per wallet) and the
pin is silent, so the churn this guarded against is the same frequency as the
receipt itself.

```bash
cd tradebot && node --test stalePeak.test.js   # 9 tests, no network
```

**Config a fix depends on:** nothing.

## "Something glitched handling that" was `tg()` retrying the wrong failure

The server log, asked what was behind that message, had three lines to say:
`handleUpdate fetch failed`. Two words — not which host, not which syscall, not
what the user had done.

**`tg()` honoured Telegram's 429 and let a transport error out.** A 429 is an
*answer*, from a host that is plainly there and talking; a `fetch failed` is the
one thing worth retrying, and it was the one thing that was not. It unwound
through `send()`/`edit()`/`answer()`, out of `onMessage`/`onCallback`, and landed
in `handleUpdate`'s catch, which turns any error at all into that one sentence.
So a momentary blip on the way to `api.telegram.org` cost the user their action
and told the operator nothing.

- **Retried ONLY on codes that prove the request never left** (`TG_NEVER_SENT`).
  A connection that was established and then broke may already have delivered
  the message, and a duplicate receipt is its own bug — worse than a missing one
  on a buy confirmation.
- **`netErr()` does the wording**, not a fourth private idea of failure. It is
  the module that already knows undici hides the syscall in `err.cause`.
- ⚠️ **`API` ends in the bot token, and `netErr()` falls back to the whole URL
  when it cannot parse one.** Hand it `TG_HOST`, never `${API}/...`, or the
  token lands in an Error message, in pm2's log, and very nearly in a chat.
- ⚠️ **Never identify the failing path from message TEXT.** The import-wallet
  step takes a private key as a plain chat message, so even a truncated
  `up.message.text` puts key material in the log. The bot's own `pending.action`
  names the step better and carries nothing the user typed; callback data is
  bot-generated and safe.
- **"Something glitched" is a claim about the BOT.** On an upstream outage it is
  the wrong claim and it invites an instant retry into the same dead host —
  `err.glitch` / `err.glitch_net`, and both are translated now; the original was
  one hardcoded English string on a bot that ships EN/ID everywhere else.
- **A poll that THREW is not a poll that worked.** The `getUpdates` loop slept
  two seconds and said nothing, so a bot unable to reach Telegram for an hour
  looked exactly like a quiet hour. Logged on the transition, recovery included
  — same rule as `upstreams.js`.

```bash
cd tradebot && node --test routerError.test.js   # 9 tests, no network
```

**Config a fix depends on:** nothing.

## "Entry" was the price on the card, not the price anyone paid

A live buy, 2026-08-16: `Spent 0.099 SOL ($7.46)` · `Got 129.16K ($6.77)` ·
`Entry $0.0000524`, and the Monitor that opens straight after it read
`Price $0.0000523 · P/L −9.48%` on a token that had not moved. Reported as
*"ini baru beli lgsung minus 10%"*.

**Every number was individually correct.** 0.099 SOL bought a bag worth 0.0896
SOL at mid; the whole −9.48% was the cost of opening the position. What was
wrong is that the receipt printed the *card* price under the label **Entry**.
The fill was 0.099 ÷ 129,160 = $0.0000578, 10.4% higher — so the two messages
the bot sends back to back asserted "you entered at 0.0000524" and "price is
0.0000523, you are −9.48%", which cannot both hold. From inside Telegram that is
a bot that cannot count, not a trade that cost 10% to open.

- **`receipt.fillStats()` is the single owner** of realised-vs-shown. The
  multi-wallet path had divided `totSpent / totTok` since the per-wallet
  rewrite; the SINGLE-wallet path — much the commonest — never did, so the shape
  most users see was the one shape that hid the gap. Both call it now and a test
  asserts no path re-derives it.
- **`offBy` is computed in NATIVE units** and is dimensionless, so the warning
  survives a dead USD feed. `realPx`/`refPx` are `null`, never `0`, without a
  rate — a confident $0 beside a real trade is worse than a blank.
- **"10.4% above" and "opens at −9.4%" are DIFFERENT numbers** (`1−1/offBy`, not
  `offBy−1`). Printing one as the other is the same contradiction one level down.
- **The bot's cut is on the receipt now.** It is carved out *before* the swap, so
  a 0.1 SOL action reached the pool as 0.099 and every screen showed the 0.099 —
  real money leaving a wallet with nothing anywhere to account for it.
- **The Monitor prints the entry beside the price.** `cost / pricedTokens`, the
  same two figures the P/L line is already built from, so its percentage is
  checkable on the card that states it. Costed tokens only — dividing a basis by
  a bag that includes airdropped tokens invents an entry nobody paid.
- **Jupiter returns a price impact on every quote** and nothing read it. It is a
  FRACTION there and a PERCENT on `res.impactPct`; the conversion lives in
  `core.js` once. It is what separates "the pool is thin" from "our price feed
  disagrees with the router" — two problems with different answers that used to
  get one shrug. `shortfall` (quote promised vs wallet received) was likewise
  `console.warn`'d where no user could see it.

```bash
cd tradebot && node --test entryPrice.test.js   # 13 tests, no network
```

**Config a fix depends on:** nothing.

## One wallet, one receipt

A multi-wallet trade used to produce a SINGLE message, built only after
`Promise.allSettled` had resolved **every** wallet, with the wallets reduced to
bullet points inside it. Two complaints, both right:

1. **Nothing arrives until the slowest wallet settles.** Four fills in two
   seconds and a fifth that takes twenty is twenty seconds of empty chat and
   then the whole batch at once. The trades were always parallel; only the
   telling was serial, so a bot that is genuinely fast read as one that had hung.
2. **A bullet is not a receipt.** It cannot carry the token, the amount in token
   units, the market cap and a transaction button — and checking ONE wallet is
   the first thing anyone does after a trade.

`tradebot/receipt.js` is the renderer (pure, no I/O, no `core`), and each wallet
is now posted the moment its own promise settles. `receiptStyle` in ⚙️ Settings
switches back to `combined`; **per-wallet is the default**.

- **The tap reports, `allSettled` still aggregates.** `raw.map((p, i) => p.then(
  post, post))` — the summary is computed from exactly the same results as
  before. What the summary keeps is only what no single receipt can say: the
  totals, the average realised fill, and the "every wallet failed the same way"
  collapse. The bullet list is gone in per-wallet mode; the same information
  twice is noise.
- **Receipts go through `queuedSend`, one at a time per chat.** Five concurrent
  sends is exactly what provokes Telegram's flood limit, and `tg()` used to
  return the 429 to callers that do not check `ok` — i.e. the receipt was simply
  gone. `tg()` now honours `parameters.retry_after`, bounded. A trade the user
  cannot see is worse than a slow one.
- **The header claims the queue first.** `progressP` is enqueued before any tap
  can be, or a wallet that fills before Telegram answers has its receipt appear
  ABOVE the "Buying on 4 wallets…" line for its own batch.
- **The identity and market reads are raced, never awaited.** Both start with
  the fan-out; a receipt waits at most `RECEIPT_MC_WAIT_MS` (600ms) for them.
  Without that wait the FIRST receipt prints `$PONS` with no market cap while
  the other four say `Pons Finance ($PONS) … Entry MC $27.20M` — one trade,
  reported two ways, which reads as a bug in the numbers rather than a race.
- **🟢 means SUCCEEDED, on a buy and a sell alike.** It answers "did it go
  through", not "which direction". An empty wallet gets ⚪️, never ❌ — it did
  exactly the right thing when asked to sell nothing, and a red cross sends
  people hunting for a fault.
- **No transaction, no transaction button.** A link on a receipt for something
  that did not happen is worse than no link.
- **`qty()` groups, it does not compress.** `fmt()` gives "10.28M", which is
  right for a market cap and wrong for "Sell of 10,279,471.93 $RUIN" — that is
  the number in the wallet, in the units the user thinks in. Both sell paths
  now return `soldTokens`; neither did before, so no receipt could ever state it.
- **`receipt.js` adds no escaping**, same contract as `i18n.js`. Callers pass
  pre-escaped values; escaping twice renders `<b>` as literal markup.

```bash
cd tradebot && node --test walletReceipt.test.js   # 19 tests, no network
```

⚠️ **Tests that drive `doBuy` must stop the monitors they open.** A buy starts a
live monitor, the monitor is a self-rescheduling `setTimeout` chain, and
`node --test` then never exits — the failure looks like a hang with no output at
all. `walletReceipt.test.js` clears `_monitors` in its `finally`, and drains
`_sendQ` rather than sleeping a guessed number of milliseconds (a fixed sleep
let one trade's receipts land inside the next trade's captured output).

## Three snipes, and the two that were missing

The bot had two: **Auto-Snipe** buys every new launch on a chain, **dev snipe**
buys whatever a followed wallet launches. Neither could express the most common
request there is — *"I have the contract, buy it the second the pool opens"* —
and dev snipe was refused on every EVM chain.

**Snipe by CA** (`caSnipeCycle`) polls armed contracts and buys on the first
tick they are tradeable. **`core.canTradeNow()` is the single owner** of that
question, because three callers were about to grow three answers to it. "There
is a price" is a different question — the line `v4.js` draws between `price()`
and `canSwapLive()`. A pair that exists with a **zero reserve is not tradeable**:
it is a contract waiting for liquidity, and buying into it fills at an arbitrary
price.

- **A target is CLAIMED before the buy, persisted synchronously.** The poll runs
  every few seconds, so a target left `armed` while its buy is in flight is
  bought again by the next tick. A missed snipe is a shrug; spending twice is
  not. Same rule as the auto-raid cursor.
- **A BROADCAST buy is never re-armed** — it may still land. Anything that
  clearly did not spend goes back on the shelf, because a launch that reverted
  in its first block is exactly the one worth retrying a second later. An empty
  wallet disarms instead of retrying forever.
- **A restart never resurrects a `firing` target.** `ensureUser` marks it failed:
  the buy may have been broadcast before the process died and nothing here can
  tell.
- **Every target carries its own amount and slippage.** `slipBps` **replaces**
  the user's setting; `slipAddBps` (the retry escalation) still **adds** on top.
  Folding them together would let an escalated snipe authorise more than the
  user set. Both capped at 50%.
- **The ring is bounded** (`CA_SNIPE_MAX_PROBES`, round-robin) so target 25 is
  not starved by 1–24 and the RPC the *buy* needs is not spent probing.
- **Targets expire** (`SNIPE_TARGET_TTL_MS`, 48h). An armed address with no
  expiry polls forever.

**Dev snipe now works on every enabled chain.** The old refusal said EVM has no
cheap deployer signal — true of the *deployer*, false of the signal that matters.
The DEX scan already reads `PairCreated`; the **sender of that transaction is the
wallet that opened the pool**, one `getTransaction` away, and it is only resolved
when somebody is actually following a dev on that chain. It is the pool-opener,
not the deployer, and the UI says so — for a memecoin launch they are one key.
The EVM path calls the **same `_followerBuy`** as Robinhood and Solana, so three
chains cannot drift into three ideas of what a dev snipe does.

⚠️ `devFollowers` must **not** be gated on `armed.length`. Following one
developer is not the same as wanting every launch on the chain, and that early
return is what kept dev snipe off EVM even after the chain check was relaxed.

**TP/SL and expiry ride ON the CA target** ("setingan sama kaya sol trading
bot"): `<ca> <amount> [slip%] [tp/sl] [expiry h]`, one line. The exits become
real orders only at the FILL, priced off the realised entry (spent ÷ received)
— never the card price, because a snipe exists precisely where those differ. An
SL ≥ 100% is refused at arm time (it can never fire), and if the buy lands but
the order cap blocks the exits, the receipt SAYS so — a stop-loss the user
believes exists is worse than none.

**Arming asks WHICH CHAIN first** — the panel this mirrors starts at
"Exchange". The old flow bound the target to whatever chain happened to be
active, so a Solana mint pasted while Ethereum was active bounced as "not a
valid contract address" with the fix two screens away on 🌐; the owner's report
was "snipenya dari awal salah aturan, disuruh pilih chain mana dulu". The
picked chain rides the pending step (`p.chain`), the prompt's example address
is chain-shaped (a user copies the shape they are shown), and dev snipe offers
ONLY the launchpad chains — which also deleted its "switch chain with 🌐, then
try again" dead end. The word "snipe" answers to three features on two screens,
so the Copy screen carries a 📍 cross-link to the CA snipe: a user sent by that
word to the wrong screen reported the whole feature as missing while it was
deployed and working.

### The 🎛 Snipe Setup panel — the Sol-Trading-Bot panel, over the same store

"saya ingin fitur snipe sama seperti sol trading bot ada setingan lengkap buat
semudah mugkin" (2026-08-17). The one-line arm stayed; what was missing was the
tap-driven panel the reference bot has: every setting as a label+value button
row — chain, target CA, wallet, amount, slippage, TP/SL, expiry — with the
reference's ✅/⏳ STATUS column inline and ⚡ ARM at the bottom. `/sniper` (and
the 📍 home screen) opens it; the panel is the first button, ⌨️ one-line second.

- **The draft is persisted per user** (`u.snipeDraft`), so a half-configured
  panel survives a restart the way the reference's "Waiting for setup" does.
  It NEVER arms by itself — only ⚡ does, and it goes THROUGH `addSnipeTarget`
  (`armSnipeDraft` is the one caller), so the panel and the one-line arm cannot
  drift into two ideas of a valid target. The one-line grammar itself lives in
  `parseSnipeLine`, shared by both ways in — pasting a full
  `<ca> <amount> [slip%] [tp/sl] [h]` line into the panel's Target step fills
  every row at once.
- **The amount has NO default** — the "buy ngasal" rule again: a draft with a
  default amount is an amount set by nobody, reused silently at arm time.
- **A refused arm keeps the draft** ("already armed", cap reached), so the user
  fixes one row instead of retyping seven. A chain switch DROPS a target
  address that cannot exist on the new chain, with a note saying so — keeping
  it would be the wrong-chain bounce one screen later; and a draft whose chain
  was disabled under it is refused at ⚡, never silently swapped to the active
  chain (`addSnipeTarget`'s fallback is right for a typed line only).
- **A pasted address that does not fit the panel's chain switches it** when the
  shape is unambiguous (a base58 mint under an EVM row), says so, and asks
  instead when several enabled chains fit.
- **Only settings the engine honours get a row.** No Anti-MEV, no Max block:
  a row the backend ignores would be the stop-loss-the-user-believes-exists,
  as a whole screen.
- ⏳ is the "not set yet" marker, so no row may use it as its icon — Expiry's
  is 🕒, or a fully configured panel still reads as waiting.
- **🎯 Snipe and /snipe open the sniper HOME** (panel first, armed targets
  listed), not the mass-mode screen. The panel shipped behind /sniper first,
  the menu's 🎯 Snipe still led to mass mode, and the owner — hunting for the
  panel there — armed a 0.1 SOL buy-every-launch believing it was the sniper
  ("masih sama aja, setinganya bukan yang saya inginkan"). Mass mode is a
  labelled 🌊 choice whose button carries its live armed state, and the home
  prints a ⚠️ line whenever it is on — a feature that spends on every launch
  must be visible from the sniper's front door.
- **One question per message, flowing FORWARD.** "aturan hapus aja, jadiin 1
  aja, jangan pisah2": the dev snipe used to demand `<wallet> <perBuy>
  <budget>` in one typed line — it is a three-step wizard now (wallet → amount
  → budget, quick-picks at each step, the old full line still lands in one
  go), and the panel's Target step asks for the amount immediately after a
  bare address instead of dropping the user back at the panel. A dev snipe
  armed while the copy/dev master switch is OFF says so on the armed message
  with a one-tap 🟢 fix — an inert watch reading as live is the
  stop-loss-the-user-believes-exists.
- **The panel's 🎯 Target is a CHOICE of two kinds** ("dmn target dev
  walletnya"): 📍 token contract, or 🧑‍💻 dev wallet. A wallet and a CA share
  the same address shape on every chain, so no paste can be auto-classified
  into one or the other; the user says which they mean. The dev kind lives ON
  the panel (`draft.kind`); switching kinds clears the address (shape-valid
  both ways, semantically wrong both ways), and ⚡ arms a dev target through
  `addCopyTarget` ('launches'), discriminated by `mode === 'launches'` on the
  return.
- **The dev rows are honoured BEFORE they are shown.** "berapa banyak wallet
  serta slippage … auto sale tp dimana fiturnya" — `_followerBuy` honours the
  per-target wallet selection, per-target slippage (replaces the user's
  normal bound, same contract as the CA snipe) and TP/SL that become real
  orders at each fill, at the realised entry, on the buying wallet — so the
  dev panel carries Wallet · Slippage · TP/SL rows. Expiry stays hidden (a
  copy target does not expire).
- **The wallet row is a MULTI-SELECT, the buy/sell picker's model** ("bisa
  pilih multi wallet, all on atau all off, sama kaya beli"): toggles per
  wallet, ✅ All on ('*', resolved at fire time), ⬜ All off. The draft and
  the targets carry `walletIds` ('*' | array; one id collapses to the plain
  `walletId`); the amount is PER wallet and the panel + armed message state
  the multiplied total. A multi-wallet DEV fill records one exit-mirror LEG
  per wallet (`holding[token].legs = [{wid, own}]`) and `copyExitCycle` sells
  every leg from the wallet that bought it, from ONE balances sweep — selling
  one bag and stranding the rest would be the stop-loss-the-user-believes-
  exists, per wallet. The fan-out is budgeted WHOLE (N × buyEth claimed
  before the buys; fit whole or skip whole) and only clear failures are
  rolled back — a broadcast leg stays committed and its leg records `own: ''`
  so the mirror refuses to guess with it.
- ⚠️ **The dev budget is priced per LAUNCH, not per wallet.** `_followerBuy`
  fits the whole fan-out or skips it, so a budget that covers one wallet but
  not the selection armed cleanly and then skipped every launch **silently,
  for ever** — the inert-watch failure, arrived at by arithmetic. The floor
  (`addCopyTarget`, `updateSnipeDraft`) and the ten-buys default are both
  multiplied by `copyFanOut()`, and the panel's budget quick-picks are
  multiples of one LAUNCH. A budget row and a wallet row that disagree is a
  target that can never fire.
- **A multi-leg exit leaves the ledger one leg at a time.** Dropping the whole
  record before the first sell is right for ONE leg (a crash mid-sell must not
  let the next cycle sell it twice) and strands the rest, whose sells never
  started: `copyHoldingSet()` rewrites the record with the untouched legs
  before each sell. A leg whose sell was **broadcast** is never retried — the
  buy path's rule, for the same reason — and says so.
- **"Nothing was sold" may not follow a sale.** The never-recorded notice is
  emitted per POSITION from a per-LEG loop, so on a mixed record (one leg
  filled, one only broadcast) it landed one message after a real exit. It
  names the wallet instead when siblings sold.
- **The armed sentence's cadence belongs to the FEATURE, not to the
  selection.** A CA snipe fires once (`snipe.panel.armed_wallets`, "in
  total"); a dev snipe fires on every launch (`dev.armed_wallets`, "per
  launch"). Keyed on `'*'`-vs-subset instead, the one-shot wording landed on
  the recurring watch. `walletScopeLine()` is the one renderer.
- **Every standing screen carries the multiplier.** `caSnipeScreen`'s armed
  rows and `copyScreen`'s target rows print `× N`, or a 3-wallet target reads
  as spending a third of what it does on the screens where a user audits it.
- **The dev budget is a CAP with a default, not a question** ("fitur yang tadi
  hapus aja"): unset, `addCopyTarget` defaults it to 10× the per-launch amount
  — an uncapped auto-buyer is the "buy ngasal" hazard class, so the cap
  survives the question's removal, and the panel row + armed message state the
  concrete number. The dev flow is two questions total (wallet → amount), and
  a re-pasted dev wallet re-asks the amount even when a stale one is set — the
  spend is confirmed per target.
- **👥 All wallets** ("harus ada fitur all wallet"): the wallet row accepts
  `walletId: '*'`, resolved at FIRE time so a wallet added after arming still
  snipes. The amount is PER WALLET — the picker row and the armed confirmation
  both state the multiplied total. `_fireCaSnipe` buys the wallets in
  parallel, probes the contract ONCE, and aggregates: any fill → done (TP/SL
  placed per filled wallet at ITS OWN realised entry, orders bound to that
  wallet); any broadcast → done (never re-arm, it may still land); EVERY
  wallet empty → disarmed; anything else → re-armed for the next tick. One
  broke wallet must never stop the others, and a partial fill says `k/N
  wallets` on the message.
- **A wallet toggle must not pay for a market scan.** "pilih wallet tidak
  working... harus cpt": the card's multi-wallet picker redrew the WHOLE card
  per tap — the price/liquidity/safety scan, a meta read and a balance PAIR per
  wallet, ~22 network calls to change one bit, seconds each on ten wallets. A
  toggle changes which wallets are lit and nothing a network read would tell
  us, so it redraws from `_cardReuse` (the last FULL render, `CARD_REUSE_MS`,
  20s, `0` disables). ONLY the toggle path passes `reuse` — a fresh open, a
  chain switch and 🔄 Refresh always read live, a stale price being acceptable
  only when the user did not ask to look again — and only a live pass seeds the
  cache, so reuse cannot chain off reuse. A trade drops the entry
  (`invalidateCard` in `doBuy`/`doSell` and at `startMonitor`): the bag is the
  one number checked right after a fill.
- ⚠️ **The poll loop does not await `handleUpdate`, so a run of taps is
  CONCURRENT.** Both pickers redraw one message, and whichever render finished
  last painted it — not necessarily the newest tap, so the wallet just lit went
  dark a second later. That is indistinguishable from a toggle that does not
  work, and is how it was reported. `redrawTicket(chatId, mid)` gives each tap a
  ticket and a stale render is DROPPED rather than painted. Any handler that
  redraws one message from concurrent taps needs it.
- **"respon sangat lambat" is measured, not argued.** `handleUpdate` logs
  `[ui] slow cb:… handle=…ms age=…s` for any update that took >1.5s to handle
  or was already >5s old on arrival — high `age` means the delay happened
  BEFORE the bot (long-poll gap, restart backlog, Telegram); high `handle`
  with low age is ours. The path label comes from callback data or the pending
  action, NEVER from message text — the import-wallet step is a private key in
  a plain message. The first thing the measurement's reasoning found: the
  WALLET dashboard (the screen `/start` ends on) awaited wallets × chains
  balance reads at 6s-per-read against public RPCs, and THEN priced the token
  bags — a single throttled endpoint held the screen for its full timeout,
  twice over. The reads now cap at 2.5s (the ≤10-min last-known cache absorbs
  the misses — that is what it is for) and the two waves run concurrently.
  The header also answers the two questions it was asked ("harus ada jumlah
  solananya brp dan total itu dalam token apa aja"): the On-<chain> line
  carries the native amount beside the USD, and a `Coins:` line decomposes the
  Total by symbol; the token share keeps its `incl. … in tokens` line.

```bash
cd tradebot && node --test snipeTarget.test.js   # 29 tests, no RPC
cd tradebot && node --test snipePanel.test.js    # 20 tests, no network
```

**Config a fix depends on:** nothing. Every knob has a working default.

## The snipe watched one launchpad per chain, and a dev snipe that arrived first could never fill

"add api pons untuk snipe trading ga hanya robinhood chain atau pons launchpad
tpi beberapa launchpad dan make sure sniper trading snipe dev wallet is working
bneran beli" (2026-08-27). Two defects, and the second is the one that made the
first invisible.

**Discovery was one launchpad per chain.** The Robinhood snipe filters ONE
factory address for ONE `TokenCreated` signature; the EVM chains scan
`PairCreated`; Solana polls pump.fun. A token born anywhere else — Pons on
Robinhood, LetsBonk or Moonshot on Solana, four.meme on BNB, Virtuals on Base —
was invisible until it migrated to a DEX, hours after the window anybody snipes
in. And `eth_getLogs` answers an unknown topic with an EMPTY ARRAY, so a second
launchpad appearing on a chain does not read as a missing feature: it reads as a
quiet chain, behind a green /health — the exact shape of the pump.fun outage.

- **`padSnipeCycle` polls the shared registry's feeds, for every chain any pad
  covers.** Adding a launchpad to the snipe is now a row in
  `shared/launchpads/pads.js` and nothing else — every pad in the table gained a
  `feedPath`, and Pons is a row like any other (`LAUNCHPAD_PONS_API` pins its
  host, `LAUNCHPAD_PONS=0` kills it, same as every pad). It is a SECOND way in
  beside the event scans, not a replacement: a log read from our own node is
  faster than a third-party HTTP poll and needs no third party.
- **`_fireLaunch` is the one fire path** — the follower match, the dedup, the
  safety gate, the affordability check, the buy and the purchase message. Four
  discovery sources each carried their own copy and three had already drifted
  (only one recorded launches while nobody was armed; only the EVM ones told a
  user their wallet was short; the Solana one skipped an empty wallet silently
  — the inert-watch failure, on the money path). `autoSnipeConsent.test.js` now
  pins the purchase-site count at exactly ONE.
- **One cursor per pad per chain, first look seeds only** — the rules the Solana
  extra-pad helper already had, now for every chain. pump.fun keeps its own
  poller and its own cursor; the pad loop explicitly skips it, or two pollers
  share one feed and that is "one repo, two answers" again.
- **A feed that 404s is backed off HERE, not in the registry's breaker.** The
  breaker deliberately benches only transport failures because for a TOKEN
  lookup an HTTP status is an answer. For a FEED a 404 is a fact about the
  path: it will 404 next tick too, for ever, and this loop asks every few
  seconds. `_padSnipeStats.pads` keeps the reason per pad, in /health.
- ⚠️ **`_snipeMark` lowercased every address, and base58 is case-SENSITIVE.**
  Fine while each chain's seen-set only ever saw its own scan; the moment two
  feeds can name the same Solana mint, two different mints can fold onto one
  key and the second launch is silently dropped as "already sniped".
  `_addrKey` — the registry's rule — per chain.

**And a launch seen too early was a launch dropped for ever.** Every discovery
source sees a token at the earliest possible moment, which is precisely the
moment there is usually nothing to trade against: a pump.fun mint is not on
Jupiter for the first seconds, a pad feed names a token that has no pool at
all, and a dev's token exists before the dev opens its pool. The buy failed
with "no route" — and the cursor had already advanced, the seen-set had already
marked it, so nothing could ever offer it again. The Solana path's comment said
"retried while it's fresh" over code that could not. **That is why the
dev-wallet snipe "worked" and never bought**: seeing the launch before the pool
opens is the entire value of following a dev, and it was the one case
guaranteed to fail.

- **The retry ring** (`_launchRetry`, `LAUNCH_RETRY_MS` 3 min, `=0` disables)
  holds a launch whose ONLY problem is timing and re-offers it until
  `core.canTradeNow` — the single owner of "can a swap be filled right now" —
  flips, or the clock runs out. Probes are bounded and round-robin, with the
  same tighter Solana budget as the CA snipe, for the same reason: a Solana
  probe is an aggregator quote against the host every real buy needs.
- **`_notYetTradeable` separates "no market YET" from every real failure.**
  "No route / no liquidity / zero quote / no pool" goes in the ring and is NOT
  a failure DM — a warning per launch that fills twenty seconds later teaches
  the user to swipe past the warnings that matter. A revert, a short balance, a
  429, and "liquidity is on a venue Dexvra can't route through" stay failures;
  the last one is deliberately excluded from the retry ring because it will not
  change.
- **The ring remembers who already bought** (`done`), because re-offering a
  launch to a user whose buy held is a double spend — strictly worse than the
  miss it exists to fix. A dev target's own `bought` map is the second line.
- **Pad-discovered launches are GATED on `canTradeNow` before the first buy**;
  the event scans are not. A `PairCreated` log means the pool exists in the
  block just read — spending a round trip to confirm what the log said is how a
  sniper arrives late. There the failure is the signal, and it lands in the
  ring.
- ⚠️ **The short-balance notice printed lamports through `formatEther`.** It
  was EVM-only before `_canAfford` unified the check; on Solana it would have
  said "Need 0.000000002" for two SOL — a number that reads as a bug in the bot,
  on the one message whose job is to say what to top up. `formatUnits(v, 9)` on
  the SVM branch.
- **`tradebot/launchpads.js` no longer keeps its own chain list.** `chainFor`
  was a hand-written map of three chains, so a pad added to the table for a
  fourth chain (Pons/Robinhood, here) was dropped RIGHT THERE: `covers()` said
  no and the pad was never asked anything — nothing threw, nothing logged. It
  derives from `lp.padsFor()` now; a `RENAMES` map (empty) is the only local
  fact left.

### "apakah anda yakin??" — the audit found nine more, and the worst was the feature disabling itself

Asked straight after the above landed. A five-lens adversarial audit (every
finding attacked by two independent refuters; 20 raw claims, 13 survived, plus
three found by re-reading before the audit ran) — and the worst finding is this
file's oldest shape: **the reassuring reading was available, and it was wrong.**

- ⚠️ **The pad loop's mark was silently disabling the graduation snipe.** The
  pad feed marks a curve token at MINT, minutes-to-days before anything can
  fill it; the retry ring gave up after its three-minute window and the mark
  stayed. When the token graduated into the PairCreated log — the one place
  these tokens were ALWAYS bought before this feature existed — the dedup
  skipped everyone, dev followers included. A launchpad integration built to
  widen discovery had quietly turned the working path off, on every pad-covered
  EVM chain, for any launch that takes longer than three minutes to graduate —
  which is nearly all of them. `_snipeUnmark`: a launch NOBODY was served (no
  fill, no broadcast) is unmarked on every terminal ring outcome — expiry, cap
  eviction, audience-gone, ring-disabled — so its graduation event can offer
  it; a launch somebody HOLDS stays marked, because for them the graduation
  buy is the double spend. And a re-sighted token is emptied of its snipe-all
  audience, never `continue`d whole — snipeCycle's shape, now on all three
  event scans, so dev followers (idempotent via their own `bought` map) still
  fill at graduation.
- ⚠️ **The dev budget's check-then-claim spanned a network await.** The safety
  gate sits between "does it fit" and "claim it", and the ring now fires
  concurrently with the discovery loops — two launches by one dev could both
  read a stale `spentEth` inside that await, both pass, both claim: real money
  past the user's cap by a full fan-out. Both the dedup and the cap are
  re-checked AFTER the await, synchronously with the claim.
- ⚠️ **A re-scan's requeue forgot who was already served.** The emptied
  snipe-all audience now rides as `skip`, so a launch parked during a re-scan
  carries the first pass's fills in `done` — without it the ring re-bought for
  a user whose fill happened before the requeue existed.
- **The ring retro-sniped for users who armed after the launch.** The audience
  is FROZEN at queue time (`eligible`) — arming is forward-looking, the
  audit-#2 rule, and the ring re-reading `_armedOn` at fire time was a window
  around it.
- **solSnipeCycle still dropped over-budget launches** — the exact shape just
  fixed in padSnipeCycle, one loop up. Overflow queues there too.
- **A registry-breaker SKIP was counted as a feed failure** — "we never asked"
  recorded as "it did not answer", and the two benches fed each other's
  counters. A skip updates the visible `why` and nothing else.
- **A feed whose items carry no readable `createdAt` seeded forever** and read
  green: the cursor could never advance, so no launch there could ever fire,
  while every stat said the pad was healthy. It records exactly that, as a
  parse problem (`_FEED_PATH`/field fix), never a bench.
- ⚠️ **`health()` assigned over the ring loop's own heartbeat**, so a stuck or
  disabled ring rendered green because its counters still existed. Merged, with
  `enabled` stated; `padSnipe.err` carries its age, or Tuesday's error reads as
  now's.
- ⚠️ **`_canAfford` read a dead RPC as an empty wallet** — `ethBalance` answers
  0n for both, so a funded Solana user would have been told "wallet has
  0.00000" and the told-once flag latched on a balance nobody read.
  `ethBalanceOrNull`, the same fix the removal guard needed one section up.

Refuted and NOT acted on, for the record: the `LAUNCH_RETRY_MS=0` "pad snipe
can't buy" claim (the gate still fires tradeable launches inline), and the
pons-probe boot alert (by design — `verified:false` pads are supposed to be
loud until checked on the box).

```bash
cd tradebot && node --test padSnipe.test.js         # 34 tests now — every finding above is pinned
```

### "pons launchpad tidak anda add??" — it WAS added, and the ✗ proved it; the fix is on-chain

The first `launchpads:check` on the box: `✗ pons — can't reach api.pons.fun`,
read as "pons was never added". The row existing is what proves it was — what
failed is the GUESSED HTTP hosts, which answer neither from the server
(timeout) nor from anywhere this repo is developed (egress-blocked). The same
run also measured `moonshot` (DNS dead — host retired) and `four.meme`
(403 — the datacenter-IP block the launchpads section already predicts).

So Pons discovery is **on-chain now** (`_ponsScan` in `tradebot/watchers.js`),
and that is the better design, not a fallback: Pons launches straight into a
Uniswap v3 (V1) / v4-hook (V2) pool on Robinhood Chain, announced by its own
factory's `TokenLaunched` event — a **different contract and signature** from
the `TokenCreated` the primary scan filters, i.e. exactly the second-launchpad
blind spot this feature exists to close, on the bot's own chain. The chain is
the one source the box already reads for every trade; no third party, no
egress. The event's `deployer` is the actual dev wallet, so the dev snipe
matches with zero extra reads. The HTTP pad stays for display metadata only.

- **The factory address and event signature are researched guesses** —
  cross-checked against Pons's public integration docs and the chain explorer,
  but NOT verifiable against a live RPC from the sandbox this was written in.
  So both are env-overridable (`PONS_FACTORY`, `PONS_EVENT`), the kill switch
  is shared with the HTTP pad (`LAUNCHPAD_PONS=0` — one feature, one switch),
  and every way the guess can be wrong is DIAGNOSED, never silent:
  a factory with no code → `ponsErr` names the address; a factory that emits
  logs the filter never matches → `ponsErr` says the SIGNATURE is stale (the
  raw-vs-decoded probe, rate-limited to one per 10 min); nothing emitted →
  `ponsSeen` stays 0 in /health beside a null error, a quiet pad.
- **Its own cursor, its own failure surface.** A Pons outage or a stale Pons
  ABI costs Pons launches, never the pools.trade scan sharing the loop.
- **The code verdict is cached per FACTORY** — a verdict about one address
  must not answer for another, or a corrected `.env` stays condemned.
- **Nothing from the event reaches the money path.** The buy is priced,
  routed and gated by `core.buy`/`canTradeNow` like every discovery source;
  Pons V1 pools are plain v3 and V2 pools are the v4 hooks `v4.js` already
  autodiscovers, which is why no routing code was needed.
- **`npm run preflight:robinhood` now probes it** (section 4p): code, recent
  `TokenLaunched` count with the latest launches decoded, and the computed
  stale-signature diagnosis with the factory's real topic0 list as the lead.
  That command, on the box, is what turns this integration from "researched"
  to "verified".

```bash
cd tradebot && node --test padSnipe.test.js          # includes the 5 Pons-scan tests
cd tradebot && npm run preflight:robinhood           # 4p verifies the factory against the live chain
```

**Config a fix depends on:** nothing to turn on. If 4p says the factory or
signature is wrong, the fix is `PONS_FACTORY=` / `PONS_EVENT=` in
`/opt/dexvra/tradebot/.env` (the trade bot reads its OWN `.env` — the rule
above) and a `--update-env` restart.

#### The probe answered, and BOTH researched guesses were wrong

The section above ships a factory address and an event signature taken from
Pons's public docs, and says in as many words that only the box can settle
them. It did, and the answer was **no on both counts**:

- **Neither address had contract code.** `getCode` on the box came back `0x`
  for `0xA5aA…` and `0x0c37…`, so the scan was condemned before it ever
  filtered a log — and it said so, correctly, in `/health`.
- ⚠️ **And the signature could never have matched either.** The documented
  `TokenLaunched(address,address,address,address,address,uint256,…)` hashes to
  `0xdb51ea…`; the launchpad that really announces a Pons launch emits
  `0x8d4aad…`. So even with the right address the filter would have returned an
  empty array for ever — **the exact shape this whole feature exists to close**,
  reproduced by the fix for it. Two guesses, and each one alone was enough to
  make the scan inert.

Both defaults are now what `preflight:robinhood` READ OFF THE CHAIN
(`0x7ed598bc…` and `0xe33e9e47…`, which both announced the same launch at block
47496254; `PONS_TOPIC0_DEFAULT` is the measured topic). What could NOT be read
is the ABI behind that topic — **1050 candidate `name(argtypes)` spellings were
hashed against it and none matched** — and that is the interesting half.

- ⚠️ **A TOPIC0 IS NOT AN ABI, AND THIS SCAN AIMS A BUY.** Knowing which log
  announces a launch says nothing about which of its words is the token, and a
  launch log NAMES the pool and the quote token too. Reading the wrong word
  buys a stranger's contract with somebody's money — so `_ponsResolve` guesses
  **nothing**: the token is the address the log NAMES *and* that the same
  transaction MINTED (an ERC-20 `Transfer` out of the zero address). Two
  independent facts, and their intersection is decided by the chain rather than
  by an assumed argument position.
- **It REFUSES rather than picks.** Anything but exactly one survivor fires
  nothing and says why. The cost of refusing is a missed snipe — a shrug, the
  rule this file has stated since the CA snipe; the cost of picking is the
  wrong token.
- **The one predictable ambiguity is ELIMINATED by asking the chain, never by
  position:** a v2-style launch mints its LP token too, and the pair is named
  by the log as the pool — so a second candidate is dropped when it answers
  `token0()`. An eliminator, never a selector; two survivors still refuse.
- **`Transfer` is matched on THREE topics, not four.** A Uniswap v3 position
  NFT is minted from the zero address in exactly these transactions, and ERC-721
  carries its id as a third indexed topic.
- **The deployer is the transaction's SENDER** — the inference the
  `PairCreated` scan already documents. It only ever decides whether a dev
  follower matches, never what gets bought, so being wrong costs a miss.
- **`PONS_EVENT` takes EITHER spelling, decided by shape**: a full
  `event Foo(...)` signature, or the bare 32-byte topic0 an explorer shows. The
  old instruction — *"PONS_EVENT must be the signature whose keccak matches that
  topic0"* — is a research task, not an instruction, and 1050 hashes say an
  operator has no better chance than this session had. `PONS_KNOWN_SIGS` is the
  bridge: a pasted topic0 whose spelling we DO know lights the named decode back
  up by itself, with no receipt read at all.
- ⚠️ **MATCHING A LOG IS HALF THE TRIGGER, so 4p no longer calls a topic match
  "alive".** It resolves every launch it finds **through the bot's own
  `_ponsResolve`** and goes RED when none resolves — a probe green on the log
  count alone would print a tick over a scan that names no token and therefore
  buys nothing. That is `fonts:check`'s nine green ticks over a banner
  publishing boxes, one feature over: a guard is only honest while it measures
  the stack the thing it guards actually runs.
- **4t prints both `.env` lines COMPLETE** — `PONS_FACTORY=` and now
  `PONS_EVENT=` with the topic it just found. This file's first rule, and the
  one this very round already cost an operator a broken shell over.
- ⚠️ **The raw-mismatch probe is rate-limited to one look per 10 min**, which is
  right in production and is inherited state in a suite: one test consuming it
  leaves the next reading a null `ponsErr`, which looks exactly like the
  diagnosis being broken. `reset()` states it (`_ponsResetProbe`) rather than
  letting test order decide. The CURSOR is deliberately NOT reset — a test that
  seeds it is testing the seeding rule.
- Four guarantees are MUTATION-TESTED rather than argued: picking instead of
  refusing on ambiguity, dropping the minted-in-its-own-transaction half of the
  proof, dropping the `token0()` eliminator, and restoring the documented
  topic0. Each fails between one and seven tests.

```bash
cd tradebot && node --test padSnipe.test.js          # 48 tests, no network
cd tradebot && npm run preflight:robinhood           # 4p: resolves each launch, RED if none does
```

⚠️ **Still not verified from here, and it cannot be:** whether that topic0 is
the launch event on every Pons deployment, and whether a real Pons launch
transaction mints exactly one address the log also names. Both are properties of
the chain, so 4p on the box is the measurement — and if it goes red, the whole
fix is the two lines 4t prints.


#### …and a Pons token still could not be BOUGHT, because V3 was off

The scan above finds the launch. Filling it is a separate question, and the
answer was no: **`chains.js` shipped Robinhood's Uniswap V3
`factory`/`router`/`quoter` blank**, `v3Cfg()` needs factory AND router, so the
V3 leg was disabled outright — and a Pons V1 launch goes *straight into a
Uniswap V3 pool*. So every Pons V1 token reached `bestDexVenue` with no V2 pair
and no V3 config, and the card said *"This token's liquidity is on Pons v2,
which Dexvra can't route through yet"* about an ordinary Uniswap pool it was
simply not configured to look in. `preflight:robinhood` has been printing the
instruction the whole time — *"they are untradeable until these are set"*.

- **The addresses are a CITATION, not a guess.** The old comment sent the next
  person to "Uniswap's deployments page"; this is that page, quoted:
  `github.com/Uniswap/contracts` → `deployments/json/4663.json`.
- **AND IT CROSS-CHECKS**, which is what separates it from the two researched
  Pons values that were both wrong one section up. That same file's
  `UniswapV2Router02` is byte-for-byte the `DEX_ROUTER` this repo has been
  trading through since it was written — so the record and this file describe
  the same deployment, and a record that ever stops matching is a record of some
  other chain. `robinhoodRouting.test.js` pins that equality for that reason.
- ⚠️ **A citation is still not a measurement**, and this feature has just been
  taught that twice in one round. A wrong value here FAILS SAFE — a factory with
  no code makes `getPool` throw and `v3BestPool` answer null; a wrong router
  cannot pass the `estimateGas` the V3 buy does before it signs — but "fails
  safe" is not "is correct", so **`preflight:robinhood` now `getCode`s both**
  and says whether it is looking at the shipped default or an operator's own
  value. Red there is a real answer; the fix is `scripts/v3-discover.js`.
- **The QUOTER is never read** — V3 pricing is off the pool's own `slot0`, which
  is why a canonical quoter copied from another chain could sit here wrong for
  so long without being noticed. It is carried so the record is complete.
- **Blank env means UNSET, not "set to nothing".** A `.env` carrying a bare
  `ROBINHOOD_V3_ROUTER=` must not switch the leg back off; a test pins it.

Whether a pad's guessed feed path is right is measured on the box, not assumed
— every new feed is `verified: false` until `launchpads:check` proves it, and a
wrong path costs a `.env` line (`LAUNCHPAD_<PAD>_FEED_PATH`), not a deploy.

**Config a fix depends on:** nothing. Every pad ships on, blank means on, and
the retry ring has a working default. `PAD_SNIPE_POLL_MS`, `LAUNCH_RETRY_MS`,
`LAUNCHPAD_FEED_BACKOFF_MS` exist for an operator who wants different pacing —
and pons.fun's real API shape has NOT been verified from inside this sandbox
(its host blocks this egress), so the first `launchpads:check` on the server is
the moment `LAUNCHPAD_PONS_API` / `_FEED_PATH` / `_TOKEN_PATH` may need a line.

## "Did I make money on this one?" — the question /portfolio cannot answer

A position record survives being sold to zero (it carries the lifetime
`ethIn`/`ethOut`), but every screen that could read it dropped closed rows:
/portfolio lists what you are EXPOSED to, so the moment a trade ended well it
left the bot's memory as far as the user could see. `/pnl` is the other
question — what a token MADE — and it answers it for a bag still held, one
already sold, and the half-of-each in between.

- **`core.tokenPnl(chatId, ca, chain)` is the one reader**, across every wallet,
  on the chain the ADDRESS says — a pasted mint answered against the active EVM
  chain would report "no trades on file", a false statement about the user's own
  money and the same wrong-chain bounce the snipe flow had to be rescued from.
- **The money view is the headline**: `back − in`, where back is proceeds plus
  what is still held. It needs no basis accounting to be true and is checkable
  against the wallet. `realizedEth` and `unrealizedEth` sit under it as the
  breakdown — a half-sold bag makes the two views differ, and hiding that is how
  a card prints "3.99x" directly above "PnL +0.0000".
- ⚠️ **A BALANCE we could not read is not a balance of ZERO.** The first cut
  used `.catch(() => 0n)`, so one RPC blip rendered a bag the user still fully
  holds as **🏁 CLOSED, −100%** — the /portfolio price lesson one field over, and
  worse here because this is the card people screenshot. `tokenBalanceOrNull`
  (the function that stopped the monitor unpinning live bags) is the read, one
  unreadable wallet marks the whole answer unknown, and the card names WHICH
  read failed: "couldn't read your balance" and "couldn't price it" send the user
  to different places.
- **Three states, and the middle one is why this exists**: HOLDING · PARTLY SOLD
  · CLOSED. Calling a partly-sold bag either of the other two misstates the
  exposure.
- **A token never traded here gets "no trades on file"**, not a zero trade — and
  if the wallet holds some anyway (sent in, or bought elsewhere), it says so and
  says there is no cost basis to measure against.
- **The book leaves an unpriced row OUT of the total** and says how many it left
  out; summing an unknown as zero is the same lie one level up. Bounded by
  `PNL_BOOK_MAX` (24) and read CONCURRENTLY — a book of thirty tokens read
  serially is the wallet-dashboard mistake over again.
- `pnl.js` is a PURE renderer (no I/O, no `core`), the `receipt.js` contract, so
  the tests call the arithmetic instead of reading telegram.js with a regex.
  That is what caught `−-0.75000` (the sign printed twice) before it shipped.

Ways in: `/pnl` (the book) · `/pnl <ca>` · 📊 PnL on the token card — so a
pasted contract is one tap from its own card — · 🔎 Paste a contract from the
book · 📊 PnL on the main menu.

### "terlalu spam", and the share of supply (2026-08-18)

The first live card came back with two notes. **The template read as spam** —
ten body lines, one emoji each — so the body carries no emoji now (the verdict
dot and the status glyph are the colour), status and trade tally share a line,
invested and taken-out share a line, and the name subtitle only prints when it
differs from the ticker (an unnamed launch has both set to the short CA, and
printing it twice was the first line of the report). ⚠️ **Removing the emoji
removed the only thing separating the lines**, and the next report was the
opposite complaint — "harus ada spasinya tulisan" about five dense lines. The
body is GROUPED with blank lines now: what the position is, what it cost and
holds, then the detail. Density is a layout problem, and stripping ornament
without replacing the structure it was accidentally providing just moves it. **And a holding must say
what share of the token it is** ("harus ada berapa % dari supply"):

- **`core.tokenSupplyUi(ca, chainKey, dec)`** is the one reader — cached 10
  min, `null` (never 0) when unreadable, and on an EVM chain with unknown
  decimals it answers null rather than guessing 18, which would state a share
  off by orders of magnitude.
- **`pnl.share()` is the one formatter** — pnl card, monitor and receipts all
  import it, so three surfaces cannot drift into three formats. Below display
  precision it says so rather than rounding a real position to nothing.
- ⚠️ **That "below precision" string was `<0.01%`, and a bare `<` is not a
  tag.** With `parse_mode: HTML` Telegram rejects the WHOLE message — 400
  "can't parse entities" — and a 400 is an ANSWER, so `queuedSend` does not
  retry it. The receipt, the monitor card and the PnL card would each have
  simply vanished for any ordinary buy on a large-supply token (0.01% of 1B is
  100k tokens), and the one owner meant it shipped to all three at once. It is
  `&lt;0.01%` now. The "callers pass pre-escaped values" contract covers
  caller-supplied text (`sym`, `name`); a literal this module GENERATES is this
  module's to make safe, and a test strips every real tag and fails on anything
  `<` left behind.
- It rides the PnL holding line (`supplyPct` on `tokenPnl`), the monitor's
  "You hold" line, and the per-wallet receipt's ok line (through i18n —
  "of supply" has an Indonesian spelling too). Every read is bounded so the
  share can never hold a receipt or a card.

### The card is a PICTURE, and it draws through canvasKit

A PnL card is a thing traders SHARE, and nobody posts a screenshot of a wall of
numbers. `pnlImage.js` renders the same figures — from the same `pnlStats()` —
as a 1200×675 PNG: the token's coin on the left, the PROFIT/LOSS word and the
percent huge (it is what a trader says out loud), INVESTED / PAYOUT in a glass
panel, and the brand strip with the referral QR along the foot.

- **The layout is the one traders share**: the token's own artwork on the left
  in a glowing ring, `$TICKER` with a `4.25X ↑` badge, "Held for", the percent
  at 138px, INVESTED / PAYOUT, and a brand strip with the referral QR.
- **NO LOGO IS THE DESIGN, not a degraded card.** A token this bot snipes at
  launch has no art at any index yet, so the fallback — the DEXVRA MARK itself
  (drawBrandMark, alone and centred; the owner's calls: "kalo project ga punya
  logo pake logo dexvra sendiri", then "name ticker di logo hapus aja") — has
  to look deliberate, because it is what most cards will be. The token's
  identity lives in the $TICKER headline, not on the coin. `core.tokenLogoUrl` asks the two indexes this repo already asks
  (DexScreener's `info.imageUrl`, GeckoTerminal's `image_url`) and caches the
  MISSES too; the logo and the QR are fetched together, bounded, and either may
  fail without touching the card.
- **It draws through `bot/src/helpers/canvasKit`** — the module that already
  owns the brand palette, the primitives, the FONT FALLBACK CHAIN and
  `warnBoxes()`. A second copy of the font logic in `tradebot/` would be the
  `$???` outage waiting on a second process. The card imports the colours; it
  does not retype the hex.
- ⚠️ **`drawGem`'s (x,y) is the TOP-LEFT of a 48-unit box, not the centre.**
  Passing the centre puts the gem half a diameter down and right — through the
  monogram it was drawn beside. Caught by looking at the render, not by a test.
- ⚠️ **Never zero-pad a native amount.** To an Indonesian reader — much of this
  bot's audience — `1.200 SOL` IS 1,200 SOL: the dot is their thousands
  separator, so `toFixed(3)` put a three-orders-of-magnitude misreading on the
  card's headline surface. `short()` trims, and the panel's two rows share ONE
  decimal count (`0.80 / 4.10`) and ONE USD voice (`$240 / $1,020`, or both
  abbreviated) — two formats in one column reads as two data sources.
- **Everything that can grow is FITTED.** The meta line crossed the frame
  stroke on the one status long enough to reach it ("Still holding"); the
  medallion cut `BEHEMOTH99` to a mid-word `BEHE`; the 44px badge outweighed a
  ticker `fitText` had shrunk to 33px. The line is fitted, the medallion
  shrinks the whole ticker (and drops to one letter below the floor, never a
  cut), and the badge scales with the ticker's FITTED size, read back off
  `ctx.font`.
- **The QR is fetched at the size it is drawn, and drawn 1:1** with smoothing
  off — resampling is what blurs a QR's modules into an unscannable smudge.
- These came from a three-lens review of the actual renders (typography,
  composition, premium) — the card is judged by LOOKING at PNGs, the rule the
  drawGem bug already taught. Render fixtures before shipping a layout change.
- **The picture is an UPGRADE and failure is free.** The native binary lives in
  `bot/node_modules`; if it is missing, or a draw throws, or the upload fails,
  `render()` returns null and the caller sends the text card it already had. A
  picture may never be why a user cannot see their PnL.
- **An image cannot say "we could not read it just now".** A branded card is a
  CLAIM, so anything unknown — an unreadable balance, a never-traded token,
  nothing invested — refuses to draw and falls back to the words.
- **A tile's label may not contradict its sign.** It reads LOSS on a loss, not
  PROFIT showing −1.58 — the buy card's two ideas of "whale", in miniature —
  and `· OPEN` while the bag is still held, because that money is not banked.
- Bytes need MULTIPART: `sendPhoto` posts JSON and can only carry a URL or a
  file_id, so `sendPhotoBuffer` uploads the PNG the way the store backup does.
  A photo cannot be edited into a text message either — the 📊 button SENDS.

```bash
cd tradebot && node --test pnlCard.test.js   # 19 tests, no network
```

**Config a fix depends on:** nothing for the text card. The PICTURE needs
`@napi-rs/canvas` present in `bot/node_modules` (it is, wherever the banner bot
runs) — `cd /opt/dexvra/bot && npm install` if a box ever lacks it. Until then
`/pnl` answers in text, which is the designed fallback and not a failure.

## "Delete wallet EVM tidak bisa karena ada saldo Solana" — and the withdraw it sent you to do could never work

Two screenshots, one report (2026-08-21). The first:

```
❌ this wallet still holds 2.15713 SOL on Solana — withdraw it (or export the key) first.
```

…from someone trying to delete what they thought of as an EVM wallet. The
second, from following that instruction:

```
❌ Simulation failed.
Message: Transaction simulation failed: Transaction results in an account (0)
         with insufficient funds for rent.
```

**They are the same defect from both ends.** The guard sent the user to withdraw,
and withdrawing did not work, so there was no sequence of taps that removed that
wallet. The user's own reading — *"privatekey kan beda2"* — is right about the
keys and was never anywhere on screen.

### `max` on Solana had never worked, and the arithmetic says so

Solana refuses to leave an account holding **more than nothing and less than the
rent-exempt minimum** (~890,880 lamports). `_withdrawSol` kept a `feeReserve` of
**10,000 lamports** behind, of which the fee spends 5,000 — so every sweep this
bot has ever offered landed on ~5,000 lamports, i.e. squarely inside the one band
the runtime rejects. Arithmetically certain, not unlucky, exactly like the
`POS_RUG_DROP` false alarm one section up.

- **A sweep lands on the balance EXACTLY.** Zero is a legal place to leave an
  account (it is purged and reappears on the next deposit); a dust remainder is
  not. So `max` is `bal − fee`, and the fee is **measured** against the message
  that gets signed (`getFeeForMessage`), not assumed from a per-signature
  constant. A guessed reserve is what produced this.
- **The floor is READ from the chain** (`getMinimumBalanceForRentExemption(0)`),
  cached per connection. It is a cluster parameter, not a constant in this repo.
- **A partial amount can walk into the same band from the other side**, so the
  remainder is checked and refused **with the two amounts that would work** —
  `max`, or the largest amount that keeps the wallet rent-exempt. The old code
  sent it and let the simulator do the explaining, and what it explained was
  "insufficient funds for rent".
- **A rent-paying account may still be swept clean** (shrinking one is allowed),
  or someone sent 0.0005 SOL would be locked out of their own dust.
- ⚠️ **A swept Solana wallet cannot pay the fee to move an SPL bag afterwards.**
  Said on the confirm screen, before the tap. EVM keeps its gas reserve behind,
  so this is Solana-only.

### The EVM reserve was computed from a different fee than the one signed

`withdraw()` reserved `getFeeData().gasPrice × gasLimit × 2` while `rawSend` went
on to sign `gasOverrides().maxFeePerGas` = `base×2 + a per-chain tip FLOOR`. The
read that produced the reserve — `gas.gasPrice` — **is undefined on every 1559
chain**, i.e. everything but Robinhood. On Ethereum the 2× multiplier hid the gap;
on Base, where a 0.005 gwei tip floor dwarfs the base fee, the reserve came out
several times too small and the node refused the transaction outright.

- **One fee object, reserved against and signed with.** `opts.fee` has existed on
  `rawSend` for exactly this — *"the fee quoted during preflight is the fee
  actually signed"* — and the withdraw path was the one write that did not use it.
- ⚠️ **The L1 data fee is a THIRD term in an OP-stack node's balance check**
  (`value + gas × price + l1Cost`) and nothing here accounted for it, so a sweep
  that left exactly the L2 cost behind was short by the L1 fee. `_l1DataFee`
  prices it off the GasPriceOracle predeploy and **discovers** whether a chain has
  one (`getCode`) rather than carrying a list — the rule `v4.js` follows for the
  PoolManager. Arbitrum and Robinhood need nothing: Nitro folds L1 into the gas
  UNITS, which `nativeTransferGas` already estimates.
- **Round toward reserving too much.** Over-reserving sends slightly less than
  everything; under-reserving does not send at all.
- `solWithdrawPlan` / `evmWithdrawPlan` are **pure** — bigints in, a decision out
  — the `pnl.js` contract, so the rule that broke every sweep is tested without a
  validator or an RPC.

### A wallet ROW is two keypairs, and the UI never said so

`enc` is an EVM key and `solEnc` a Solana key, under one label. Removing "the EVM
wallet" removes the Solana one with it — which is why a SOL balance blocks it, and
which nothing on any screen stated.

- **`core.walletFunds()` is the one survey**, read by the guard *and* by the
  screen, so a refusal and the screen it lands on can never disagree about what is
  in there. Read CONCURRENTLY: the old guard was a serial `for` loop, so a
  throttled public RPC cost one full six-second timeout per chain before anything
  could be said.
- **The refusal carries `err.holdings`, and the screen puts hands on it** — one
  📤 button per chain that actually holds something. The old refusal named
  whichever chain the loop tripped on first and offered nothing to tap; withdraw
  was active-wallet-and-active-chain only, so acting on the sentence meant
  switching wallet, switching chain, and finding the button again. *A diagnosis
  with no hands attached is a bug report the code files against its owner*, and
  this one had been filing it since the guard was written.
- **`opts.force` exists, and is reached only from a second confirmation that
  names every amount** — then hands over both keys BEFORE removing, so the funds
  stay reachable. A failed export must not be followed by a removal.
- ⚠️ **`exportKeyMsg` used to export whichever half matched the ACTIVE chain**
  and print a note telling the user to switch 🌐 and come back for the other.
  Anyone following the removal advice from an EVM screen got the EVM key, deleted
  the wallet, and had nothing for the SOL on the other side of the same row. **A
  note is not a safeguard when the next tap is destructive.** Both keys, always.
- **`ok:false` is not a zero.** An unreadable chain does not block removal (the
  key is archived, and a flaky public RPC must not trap an otherwise-empty
  wallet), but it is REPORTED rather than rendered as an empty balance.
- **A withdrawal spends the wallet and chain it was OPENED on.** `walletId` and
  `chain` ride the pending step; re-deriving them from the active chain at each
  step is how a Solana withdrawal opened from an EVM screen bounced as "not a
  valid Ethereum address" — the same wrong-chain dead end the snipe flow had to be
  rescued from. 📤 is now on the per-wallet deposit screen too: emptying Wallet 9
  used to mean switching to it first, with the switch on the same screen as the
  button that needed it.
- **A swept wallet's receipt says it is empty.** That is the errand the sweep is
  usually part of, not a footnote.

### The audit round — four of these were in the FIX

Asked "apakah anda yakin?? coba audit kode" straight after the above landed, and
the answer was no. Every one of the defects found is this file's own recurring
shape — **a failure rendered as a fact** — reintroduced by the code written to
stop it.

- ⚠️ **`getCode(ORACLE).catch(() => '0x')` cached a failed read as "this chain
  has no L1 fee".** One transient 403 or timeout on the first EVM withdrawal
  disabled L1 accounting on Base for the life of the process, silently, on the
  exact path where being short by the L1 fee means the withdrawal does not send.
  Only a read that ANSWERED is cached now, and `_l1DataFee` returns
  `{fee, ok, oracle}` — a read that failed reserves the L2 cost as a stand-in,
  never zero.
- ⚠️ **A survey that did not happen rendered as an empty wallet.** The removal
  screen swallowed a thrown `walletFunds` into `funds = []`, which took the
  "empty of native on every chain I could read" branch and offered a one-tap
  ✅ Remove. `surveyed` is now its own state with its own copy and its own
  button.
- ⚠️ **…and fixing that created a BOUNCE LOOP.** The unsurveyed screen's only
  forward button is `rmwf`, and `rmwf` sent anything with no holdings back to
  the screen — so an unreadable wallet ping-ponged between the two for ever and
  could never be removed. Three states, not two: *held*, *surveyed and empty*,
  *not surveyed*.
- **`Promise.all` rejects on the first throw**, and resolving a Solana address
  derives a keypair — so one wallet the derivation could not handle turned the
  per-chain `ok:false` this function promises into an exception out of the whole
  survey.
- **A callback could name a DISABLED chain.** `chainOf` answers from the whole
  table; `core.setChain` throws on `isEnabled`, and this path now checks it too.
- **The keys-then-remove gate needed the reason, once.** A thrown `exportKeyMsg`
  sent its own ❌ and then a second generic one on top of it.

And one coupling that is not a bug yet, guarded so it cannot become one quietly:
the sweep lands on the balance exactly, so `transferFee` and `sendSol` must price
and sign **the same message**. They do because both build a bare
`SystemProgram.transfer`; a test fails if either grows a second instruction,
because a priority fee on one side alone puts `max` straight back into the
rent-paying band.

```bash
cd tradebot && node --test walletWithdraw.test.js   # 36 tests, no network
```

⚠️ **The OP-stack L1 fee read is the one thing not verified against a live
node** — the sandbox this was written in cannot reach a Base RPC. The code fails
safe (a read that does not answer reserves the L2 cost rather than zero), but
the first real sweep on Base is worth watching, and `getL1Fee`'s answer is worth
printing once.

**Config a fix depends on:** nothing. Note that `ENABLED_CHAINS` does not ship
with `solana` in it — the two-keypair half of all of this only exists where an
operator has added it.

## "Kirimnya harus seed phrase bukan hanya privatekey"

Asked after the removal screen shipped, looking at a card offering two private
keys for one wallet. It is the right question, and the answer was a real gap.

**Every wallet this bot generates is born from a mnemonic** —
`ethers.Wallet.createRandom()` has one, and it is what derives the Solana key on
Phantom's own `m/44'/501'/0'/0'` — and `_newWallet` **computed it, used it, and
threw it away**, persisting only `encrypt(w.privateKey)`. So the bot handed out
two unrelated-looking keys for a wallet that had a single phrase behind it, and a
private key cannot be run backwards into the mnemonic it came from.

- **`mnemEnc` is stored for every new wallet — generated AND imported.** That is
  the owner's explicit call, taken with the trade-off stated: ⚠️ a phrase is
  strictly more dangerous to hold than a key. A key controls one address; a phrase
  derives an unbounded number across many chains, so for an IMPORTED phrase this
  stores something that may also control wallets this bot has never seen. Both
  confirm screens say so, and nothing prints a phrase without one.
- ⚠️ **It cannot be applied retroactively, and the copy must not imply it can.**
  Every wallet made before this has no phrase and never will. Neither does one
  imported from a bare private key. `exportMnemonic` answers **null** for both —
  the ordinary case, never an error — and the export SAYS *"this wallet has no
  seed phrase"* rather than leaving a blank, because a blank reads as a bot that
  forgot to print it and sends people hunting for something that does not exist.
- **The phrase leads, the two keys stay.** One import restores both sides; not
  every app takes a phrase, so the keys remain underneath with a line saying they
  are one wallet, one side each — the misreading the whole report was built on.
- **`mnemEnc` is archived on removal** with `enc`/`solEnc`. Archiving the keys
  and dropping the phrase would make "export before you delete" quietly hand back
  less than the wallet had.
- **The claim on the card is PROVEN, not asserted.** `walletWithdraw.test.js`
  derives Phantom's `m/44'/501'/0'/0'` and MetaMask's BIP44 account 0 from the
  exported phrase and compares them against the bot's own two addresses. A
  wallet whose Solana side came from the EVM-key path
  (`sha512('robinfun:solana:v1' + key)`) has no phrase precisely because that
  derivation is not reproducible by any standard wallet — which is why the two
  cases must never share a message.

```bash
cd tradebot && node --test walletWithdraw.test.js   # 42 tests, no network
```

**Config a fix depends on:** nothing.

## "Bisa withdraw semua wallet tapi dipilih dulu chainnya apa"

📤 Withdraw (active) only ever spent the ACTIVE wallet on the ACTIVE chain, so
emptying ten wallets was twenty screen switches. `withdrawMany` is the same
withdrawal over a SELECTION: **chain → wallets → address → amount → confirm.**

- **Chain FIRST.** The rule the snipe panel had to be rescued into — a flow bound
  to whatever chain happened to be active is how a Solana address pasted on an
  EVM screen bounces as "not a valid address" with the fix two screens away.
- ⚠️ **The rate limit is charged ONCE for the whole sweep.** `MAX_WD_PER_HOUR`
  defaults to 10 and a full account is 10 wallets, so charging per wallet would
  let one sweep spend the entire hour's budget and then stop halfway with "rate
  limit reached" — funds out of some wallets and not others, from a confirmation
  the user gave once. A half-done irreversible action is worse than a refused
  one. The limit bounds how fast a compromised session can move money to a NEW
  destination; this is one destination, confirmed once. `withdraw(…, false)` is
  the un-guarded worker and `withdrawMany` is its only caller.
- **The destination is validated before ANY wallet moves**, so a typo or a locked
  vault costs nothing and moves nothing — and the failure says *"Nothing was
  sent."*
- ⚠️ **The amount is PER WALLET and the confirmation does the arithmetic out
  loud** — `0.1` across ten wallets is one ETH. Same rule as the dev-snipe fan-out
  budget, and the same way to get it wrong.
- **An empty wallet is ⚪️, never ❌.** Asked to sweep a wallet holding nothing,
  doing nothing is the right answer; a red cross beside eight untouched wallets
  sends the reader hunting for a fault. `empty` is set only by a SWEEP — asking
  for a fixed amount a wallet does not have is a real failure worth seeing.
- ⚠️ **The selection lives in the PENDING STEP, never in `core.tradeSelection`.**
  That one is persisted and drives which wallets every future Buy and Sell act
  on; a withdraw picker writing to it would silently re-aim the user's trading as
  a side effect of emptying a wallet.
- **One progress message, edited with the result** — ten wallets is ten
  notifications for one action, and the user is looking at the screen already.
  The `redrawTicket` rule applies to the picker: the poll loop does not await
  `handleUpdate`, so a run of taps is concurrent and the last render wins, not
  the last tap.

### "Harus ada opsi pilih chain dlu dan harus ada command pakai /"

`/withdraw` jumped STRAIGHT to "paste the 0x address" on whatever chain happened
to be active. A user who wanted to move SOL got a Robinhood prompt for a 0x
address and no way to say otherwise without backing out and hunting for 🌐 — the
wrong-chain dead end the snipe flow had to be rescued from, on a different
screen, three sections later. The flow that DID ask was reachable only by button.

- **Every entry asks the chain now**, `/withdraw` and 📤 alike, through the one
  `wdSweepChainScreen`. Two shapes exist and there is no third: a button that
  already knows the wallet AND the chain (the per-wallet 📤 on the deposit and
  removal screens) skips both pickers because it has nothing to ask; everything
  else asks. What must not come back is an entry that silently borrows the active
  chain.
- ⚠️ **…and then there were TWO of them, which was worse.** The first cut shipped
  `/withdraw` and `/withdrawall` differing ONLY in which wallets started ticked —
  landing on the same screen, the one that already carries ✅ Select all and
  ⬜ Clear. The second command bought exactly one tap and cost a second entry in
  the "/" menu with its own description: *"2 command ini beda … padahal fungsinya
  sama ini malah bikin bingung"*. **A second way in that does not do a second
  thing is a question the user has to answer before they can start.** One command,
  one button, one menu entry; the ACTIVE wallet is ticked (what a withdraw has
  always meant) and everything else is one tap on this same screen. `/withdrawall`
  and the `wdall` callback still ANSWER — they were live for a build and are in
  somebody's scrollback — but they open the same screen rather than a second
  feature.
- ⚠️ **`/withdraw` was never registered in the blue "/" menu at all.** The
  operator typed `/wi` and got no autocomplete, which is its own reason to think
  the command does not exist — and it is how the uppercase bug above got found in
  the first place. Both are in `registerCommands` now.
- The label stopped claiming a chain it no longer picks: `📤 Withdraw (active)`
  → `📤 Withdraw`.
- ⚠️ **And it was not only `/withdraw`.** Auditing the list found 40 commands
  handled and 22 registered. Four more user-facing ones were undiscoverable the
  same way — `/settings`, `/export`, `/language`, `/menu` — and are registered
  now. `guardTestPaths`-style, a test compares HANDLED against REGISTERED and
  fails on any new gap, with two explicit exemptions: **aliases** whose primary
  is listed (`/positions`, `/bags`, `/track`, `/refer`, `/lang`, `/bahasa` — the
  menu is a list people scroll, not an index), and **admin** commands, because
  `setMyCommands` is GLOBAL and `/userkey` prints somebody else's private key.
  The test asserts each admin command is gated inside its handler rather than
  taking "admin-only" on trust.

### "Mengapa ada bacaan paste base 88 ini kan sol wallet"

The withdraw prompt said *"Paste the base58 address"*, and it was read back as
**"base 88"**. `base58` is the name of an ENCODING — not a thing anybody sees,
and no help whatsoever in deciding whether what you just pasted is the right
thing. "0x address" works on EVM for the exact opposite reason: the user can
literally see the `0x`.

- **`destHint(chainKey)` is the one owner**, because five prompts spelled this
  out independently — the sweep, the per-wallet 📤, the token send, the
  whitelist, and the key export. Solana gets the CHAIN'S NAME plus where the
  address comes from ("the one Phantom, Solflare or your exchange shows"); EVM
  keeps `0x address`, where the prefix is the hint.
- ⚠️ **No example address, ever, on a withdraw prompt.** This repo has already
  paid for a placeholder pasted verbatim into a live shell; here the same mistake
  is an irreversible transfer to a stranger. The shape is described in WORDS.
- A test strips comments and fails on `base58` anywhere in user-facing text —
  in a comment it is a useful fact for whoever edits the file next, and on a
  screen it is noise.

### ⚠️ `solBalance` answered 0 for a dead RPC, and the removal guard believed it

Found while building the picker, and it is a defect in the shipped removal
screen, not in the new one. `solana.solBalance` catches its own errors and
returns `0n`, so on Solana **an unreadable balance and an empty wallet were the
same value**. `_balanceResilient`'s retry loop could therefore only ever detect
the 6-second TIMEOUT there: a node answering with a 429 or a 403 came back
`{ok: true, bal: 0n}`, `walletFunds` reported the chain as empty, and the removal
screen offered a one-tap ✅ Remove over a wallet holding 2.15 SOL.

- **`solBalanceOrNull` is the fix**, the shape `splBalanceOrNull` beside it
  already had, and `core.ethBalanceOrNull` is what every screen reads.
- ⚠️ **The screens read it through CORE.** The first cut had `readNative` reach
  into the `solana` module directly — a layering break, and the tell was
  immediate: `walletRender.test.js` stubs `core`, so the read went around its own
  stub and four render tests failed for a reason that had nothing to do with
  what they cover.
- **The sweep picker prints `?`, and does not total what it could not read.**
  Summing unread balances into "holding 0 SOL" would put the lie back one line
  above the `?` that exists to avoid it.

```bash
cd tradebot && node --test walletWithdraw.test.js   # 51 tests, no network
```

**Config a fix depends on:** nothing. `MAX_WD_PER_HOUR` still bounds sweeps —
one sweep, one slot.

## "/WITHDRAW" — 33 commands were one shift key from not existing

> 🤔 I didn't recognise that.

Reported with a screenshot of `/WITHDRAW` typed into a bot that had just shipped
the withdraw work. Nothing was wrong with the feature: every command in
`telegram.js` is matched with `===` against a lowercase literal, and **Telegram
does not lowercase what the user typed**. A phone keyboard capitalises the first
letter of a message by default, so `/Withdraw` — the thing most people actually
send — never matched either, and neither did any of the other 32.

- **In a group it is worse and invisible.** Telegram appends the bot's own
  username when several bots are present (`/withdraw@DexvraTradeBot`), which
  failed identically. Nothing in the file had ever stripped it.
- **`normalizeCommand` runs ONCE, at the entry point.** A fix applied
  command-by-command is one the 34th command forgets; a test pins the call-site
  count at one.
- ⚠️ **Only the FIRST WORD, and only when it starts with `/`.** Lowercasing the
  whole message would be a far worse bug than the one being fixed: this same
  string is what a contract address is pasted into, and a **base58 Solana mint
  and a checksummed EVM address are both case-SENSITIVE**. Everything after the
  first space is passed through verbatim for the same reason — the `/start`
  deep-link payload (`ca_solana_<mint>`), a referral code, `/send`'s two
  addresses.
- The tests DRIVE `onMessage` for `/WITHDRAW`, `/Withdraw` and
  `/withdraw@Bot` and assert the reply is the withdraw screen and not the
  fallback. A source scan of the normaliser would pass on a version that is
  never called.

**Config a fix depends on:** nothing.

## "Websitenya loadingnya terlalu lama" — the cache blocked on the one thing it was there to cover

Reported with a screenshot of dexvra.io: the Trending Listings board as unfilled
skeleton rows, and nothing under it. The page is a client component driven by
one `fetch("/api/tokens")`, so until that request answers there is nothing on
screen at all — and that request was sitting behind the board's whole market
refresh.

**`cached()` served the stale copy only when the loader THREW, never when it was
merely SLOW.** `cache.get()` answers `undefined` the moment an entry expires, so
control fell straight through to `await loader()`; `getStale` was reached from
the `catch` and nowhere else. The board's TTL is 60s and its loader is ~19
GeckoTerminal chunks paced against a per-process budget, each able to wait 3s
for a slot and then time out after 9s. **So once every sixty seconds one visitor
paid for the entire refresh with the page held blank, over a perfectly good
board that was sixty-one seconds old** — and the payload's own HTTP header
(`stale-while-revalidate=30`) had been promising every CDN in front of it the
opposite behaviour since the route was written.

- **An expired entry is served NOW and refreshed behind it**, deduped through
  the same in-flight map, so a burst of readers still costs one load. It is in
  `cached()` and therefore true of every caller — the pool cache, the candles,
  the trades feed, the token preview, the logo sweep — because every one of them
  is a flaky-free-tier read where a slightly stale answer beats a spinner.
- ⚠️ **THERE IS DELIBERATELY NO UPPER BOUND ON HOW STALE A SERVED VALUE MAY
  BE.** The alternative to serving it is blocking and then serving the very same
  value out of the `catch` — the same data behind a spinner. What a long outage
  owes the reader is the AGE, not a wait.
- ⚠️ **…so `updatedAt` had to stop being `Date.now()`.** The payload stamped the
  time the RESPONSE was built, and `freshness()` prints that stamp under the
  board — an hour-old reading rendered as "3s ago". `cache.storedAt(key)` dates
  the WRITE. Fear & Greed needed the same: `updatedMinutesAgo` is
  alternative.me's own reading age measured when we fetched it, so a value
  served from the cache now carries the time it has since spent sitting there.
- ⚠️ **A background refresh has nobody awaiting it, and an unhandled rejection
  ends the process in Node 18** — a provider outage would have stopped the whole
  site rather than leaving it stale. `refresh()` resolves to the stale copy
  rather than rejecting whenever there is one, and the fire-and-forget call
  catches on top of that.
- ⚠️ **AND THE OLDEST TEST IN THE FILE WENT VACUOUS THE MOMENT THIS LANDED.**
  "an expired entry is still the stale copy served when a provider is down" now
  takes the stale-while-revalidate branch and returns before the loader is ever
  consulted — so deleting the loader-failed→stale fallback outright kept it
  green. Found by mutation testing, not by reading. The shape that still reaches
  that fallback is a COLD key with TWO writers, which is exactly `poolCache`: a
  token page resolves `pool:<net>:<addr>` from GeckoTerminal while the board's
  own refresh plants the same key from the market read it already paid for.

### A cold start is the one case a stale copy cannot cover

`cached()` covers every visitor but the first one after a restart, and this box
is redeployed constantly. `within(p, COLD_WAIT_MS)` bounds that wait at 8s and
**leaves the load RUNNING**, so its result still lands in the cache for the next
30s poll; past the deadline the captured-at-listing board goes out under its own
`demo data` pill. Generous on purpose — a healthy cold load is a few seconds,
and tripping this on a good box would trade a short skeleton for a demo pill
nobody needed.

- ⚠️ **The deadline timer is NOT `unref`'d.** A REQUEST is waiting on it, and an
  unref'd timer does not hold the event loop open — a process with nothing else
  pending exits with the caller hung for ever. The trade bot's `bounded()` has
  this exact scar, and the first cut of this reintroduced it; three tests said
  so within a minute of being written.
- `{ok: false}` covers slow AND failed, deliberately: the caller's answer to
  both is its fallback, and absorbing the rejection here is what keeps it from
  surfacing once nobody is awaiting the load.

### …and then the measurement named a second cause the reasoning had not

Built and timed on a box with the upstreams unreachable, which is the
pathological case: `/api/tokens` took **8s, 8s, 1.1s, 8s** — every request
hitting the cold deadline — and the boot line said why.

```
[gt] PUBLIC free tier (~10 req/min per IP …) · budget 5/min from THIS process
```

**Five a minute against ~19 chunks a cycle. The board's demand cannot fit in its
own budget, and it never could.** `slot()` is serialised process-wide, so the
3s each over-budget chunk waits is not paid by that chunk — it is paid by
everything behind it: the next chain's chunks, and the chart request of whoever
just opened a token page. ~14 chunks × 3s is **forty seconds of the site's whole
GeckoTerminal pipeline, burnt every cycle, waiting for slots that were never
coming.**

- **A caller that HAS a second source takes a free slot and never queues for
  one.** It goes to DexScreener instead — which is where those tokens were going
  three seconds later anyway. `gtGet(path, params, { waitMs: 0 })`.
- ⚠️ **A GT-ONLY CHAIN STILL WAITS**, because for it the wait is the difference
  between a priced row and a dash. It is the same fact `partitionByFallback`
  already orders the cycle on, read from the same `dsCovers` map rather than
  from a second list of chains that would drift.
- ⚠️ **An omitted `waitMs` may not silently mean 0.** That is the mutant that
  turns a politeness knob into a permanent refusal for exactly the chains the
  scheduler exists to protect, and it has its own test.

Measured again on the same box, same build, upstreams equally dead:

| | before | after |
| --- | --- | --- |
| `/api/tokens`, four requests | 8s · 8s · 1.1s · 8s | 0.60s · 0.46s · 0.47s · 0.47s |
| `/api/ohlcv` behind a board refresh | 7.0s | 3.1s |

```bash
npm test                                       # cache (12) · gt (18) · gtBudget (10)
npm run build && npx next start -p 3055 &      # and time it, rather than reasoning about it
curl -s -o /dev/null -w "%{time_total}\n" localhost:3055/api/tokens
pm2 logs dexvra --lines 50 --nostream | grep -F '[gt]'   # the budget in force
```

Every guarantee is MUTATION-TESTED rather than argued — restoring the blocking
read, leaving the background rejection unhandled, unref'ing the deadline,
dropping the loader-failed→stale fallback, stamping the payload from the clock,
spelling the board's cache key twice, unbounding the cold start, ignoring
`waitMs`, defaulting it to 0, and taking the no-queue slot on GT-only chains
too. Each fails between one and two tests.

**Config a fix depends on:** nothing. ⚠️ But the arithmetic underneath is
unchanged: **~19 chunks do not fit in 5/min**, so the board is now fast and
mostly DexScreener-priced rather than slow and mostly unpriced.
`GECKOTERMINAL_API_KEY` in the **repo-root** `.env` is still the only thing that
raises the ceiling rather than dividing it — and this is the eighth place in
this file that sentence appears.

### "masih lama juga" — and the browser named two causes the server could not

The cache fix made `/api/tokens` fast and the page was still slow, because
**nothing above had touched the reason the reader waits.** Measured this time in
a real browser (Chromium is on the box; `PLAYWRIGHT_BROWSERS_PATH` points at
it), timing the thing that actually matters — *when does a real board row exist
in the DOM*:

```
BEFORE   first real board row: 13470ms      JS OFF: never
AFTER    first real board row:   467ms      JS OFF:  478ms
```

⚠️ **`JS OFF: never` is the whole first cause.** Every page under `(site)` is a
client component reading `data` from `AppState`, and `data` started as `null` —
so the HTML held skeleton rows and the real board was three SERIAL steps away:
download the bundle, hydrate, then make a round trip of its own. The server
already knew the answer.

- **`SiteLayout` is a server component, so it hands the payload over as a
  prop.** `AppProvider` seeds its two `useState`s from it and the first render
  on both sides has the board in it. The polling effect is untouched and still
  fetches on mount, which is what keeps this a pure head start rather than a
  trade against freshness.
- ⚠️ **…so the segment has to be `force-dynamic`.** These pages were prerendered
  at build time, which is only fast the way a photograph of a board is fast.
  Left static WITH a data fetch in it, the board would instead be frozen at
  whatever the market looked like when somebody last ran `npm run build` —
  worse than either. Measured: `/community` (same layout, near-empty page) has
  the same TTFB as `/`, so server-rendering the whole board costs nothing
  detectable; the TTFB is the data call, and that is a cache read.
- **`within(…, SSR_WAIT_MS)` bounds both payloads at 1.2s and failure is free.**
  Once anything is warm these are microsecond map reads; on a cold process the
  honest answer is to ship the shell and let the client fetch, which is exactly
  what the page did before. **Seeding may make the first paint earlier; it must
  never make the response slower than the static shell it replaced.**
- ⚠️ **A RELATIVE TIME MAY NOT BE SERVER-RENDERED.** `freshness(updatedAt)` in
  the Market Movers header is the one string whose value depends on WHEN it is
  rendered, not on what: the server computes it against its clock and the
  browser against its own a second later, which is a hydration mismatch React
  patches over in silence. It waits for mount. Audited the rest — every other
  time on the page (`listedMinutesAgo`, the signal ages, the Fear & Greed age)
  is a NUMBER computed into the payload server-side, so it is identical on both
  sides, and the `Math.random` in `TokenBoard` is inside an effect.

#### ⚠️ The second cause was one line of CSS, and it was the biggest

The request trace said it outright — `/api/tokens` **was not requested until
t=13056ms**, and the thing in front of it was `fonts.googleapis.com`:

```
   12466ms  start@  430  FAIL https://fonts.googleapis.com/css2?family=Archivo…
     407ms  start@   13  /
     375ms  start@13056  /api/tokens
```

`globals.css` opened with `@import url('https://fonts.googleapis.com/…')`, which
is the slowest way there is to load a font. The browser must download and parse
`globals.css` *before it can even discover the rule*, then open a fresh
connection to a third-party origin (DNS + TCP + TLS) for the CSS, then a third
to `fonts.gstatic.com` for the `.woff2` files — **three round trips in series,
all render-blocking. And a pending stylesheet blocks SCRIPT EXECUTION**, so
React could not hydrate and the board's own request could not be made until
Google had answered. This box cannot reach Google Fonts, so it paid the full
12.5s; a reader on a slow phone pays a smaller version of the same bill on every
load, and it is in front of everything.

- **The link moved to `layout.tsx` and is NON-BLOCKING.** `media="print"` does
  not match a screen, so the browser fetches it at low priority and never blocks
  on it; a five-line inline script promotes it to `media="all"` once it has
  arrived. Both origins are preconnected, `fonts.gstatic.com` with `crossorigin`
  because font files are a CORS fetch and a preconnect without it warms the
  wrong connection.
- ⚠️ **`l.sheet ? go() : l.addEventListener('load', go)`.** A cached stylesheet
  can be ready before the script runs, and an `onload` that has already fired
  never fires again — the fallback-that-never-fires shape, on the path that
  decides whether the site has any brand type at all.
- **`<noscript>` carries a plain link.** With no JS nothing can promote it, and
  a reader with no JS has no hydration to block anyway.
- `display=swap` was already in the URL, so text has always been readable in the
  fallback stack while the faces arrive — which is what makes this safe.
- ⚠️ **NOT `next/font/google`, and the reason is the deploy.** It is the better
  answer — Next downloads the faces at BUILD time and self-hosts them, so there
  is no third-party hop at all — and it makes `npm run build` require egress to
  Google. This sandbox has none, so it could not have been built or verified
  here, and **shipping a build step that cannot be run is how a deploy breaks at
  the worst moment.** Worth doing on the box, where it can be measured.
- **Noted, deliberately not changed:** `--fd` is `'Sora','Space Grotesk',…` and
  **Sora is not in that URL** — the brand display face has never been loaded on
  the site, so every heading falls back. Adding it is a visual change and
  another font download; it is the operator's call, not a side effect of a
  performance fix.

```bash
npm run build && node node_modules/next/dist/bin/next start -p 3055 &
curl -s http://127.0.0.1:3055/ | grep -c 'class="row'      # the board is IN the html
node --test --experimental-strip-types src/lib/firstPaint.test.ts
```

Nine guarantees MUTATION-TESTED rather than argued — the `@import` returning,
the stylesheet going render-blocking, the promoter missing a cached file, the
preconnect losing its CORS flag, the layout dropping the seed, the segment going
back to prerendered, SSR waiting unbounded, `AppProvider` ignoring the seed, and
the relative time being server-rendered again. Each fails exactly one test.

**Config a fix depends on:** nothing.

#### …and the one-liner I handed the operator printed `0`

`curl -s https://dexvra.io/ | grep -c 'class="row'` → **0**, run in the seconds
after `pm2 restart dexvra`. It read as a broken deploy and it was the system
working: a process that has just booted has an empty cache, `SiteLayout` is
BOUNDED, so it drops the board from the HTML rather than hang. **A check that
fails on its own happy path teaches the reader to ignore it** — the state
`chart:preview` sat in for weeks — and this one was mine, handed over in a
message.

- **`npm run firstpaint:check` RETRIES**, says *"the process looks cold, waiting
  for the market read…"*, and reports how much warm-up it needed. It prints the
  build stamp for the reason `fonts:check` does, and it exits non-zero only when
  the board is genuinely absent from a warm server.
- **It defaults to the LOCAL server and says why that matters.** Green locally
  and red on `https://dexvra.io` is one specific answer — something in front of
  the app is serving cached HTML — and pointing the same script at the public
  origin is how to tell.
- ⚠️ **The cold window is now mostly closed at the source.** `instrumentation.ts`
  starts the board load at BOOT, so the cache is filling before the first
  visitor arrives (`[boot] board warm in 455ms · 14 token(s) · live false`).
  Fire-and-forget: `register()` blocks the server from accepting connections,
  and waiting on a market read before serving anything is the stall this exists
  to avoid.
- ⚠️ **AND IT MUST LIVE IN ITS OWN FILE.** `instrumentation.ts` is compiled for
  the EDGE runtime too, and an early `return` is not something a bundler can act
  on: written inline, webpack pulled `providers → store → mongo` into the edge
  bundle and the build failed outright on `Can't resolve 'net'`. A dynamic
  import of a separate module inside a positive
  `process.env.NEXT_RUNTIME === "nodejs"` branch is the shape Next eliminates.

⚠️ **And the check's own first two cuts each carried a defect of exactly the kind
it exists to catch**, which is why its predicates are exported and unit-tested
rather than trusted:

- **It reported the `<noscript>` fallback as render-blocking.** That link is
  supposed to have no `media="print"` — nothing can promote it without JS — so
  the check was red on correct code, which is the failure it was written about.
- **It printed ✓ over a stylesheet it could not read.** The CSS fetches never
  looked at the status; against a server whose build had been replaced under it
  every request came back a 400 HTML page with no `@import` in it, and *"no
  stylesheet @imports over the network"* was reported about an error page.
  "Could not ask" and "nothing there" are different facts — the rule this repo
  is built on, broken in the script written to enforce it.
- **And the `@import` regex matched only the source spelling.** A minifier
  rewrites `@import url('x')` as `@import"x"`, which is what the build actually
  emits — so it would have passed on the very revision it exists to catch.

```bash
cd /opt/dexvra && npm run firstpaint:check          # against the local server
cd /opt/dexvra && npm run firstpaint:check -- https://dexvra.io   # …and the public one
pm2 logs dexvra --lines 30 --nostream | grep -F '[boot]'
```

##### …and the fix's own diagnostic broke this file's first rule, in the guard that exists to stop it

`firstpaint:check` answered a wrong port with

```
npm run firstpaint:check -- http://127.0.0.1:<port>
```

— **CLAUDE.md's opening rule, for the fourth time**, and this time inside the
tool written to diagnose something else. Bash reads `<` and `>` as redirects, so
that line dies with `syntax error near unexpected token` before the script runs.

The fix is the one this file already states: **do not ask for the value, ask the
box.** `findLocal()` probes the plausible local ports for a response carrying a
`build` field — that is OUR app, not merely something listening — and measures
it, printing the complete real line to use next time. Only when no origin was
given: an argument is a decision, and quietly measuring somewhere else would
answer a question nobody asked.

⚠️ **AND `pasteableCommands.test.js` PASSED ON IT.** The guard scanned
`console.log(...)` calls and nothing else, so a script with a printer of its own
(`note()`, `fail()`, `ok()`) walked straight through — the bracketed placeholder
reached the operator and the suite stayed green. That is the second time this
guard has been blind to the revision it exists to catch, and the second time a
MUTANT is what said so rather than a reading.

- **Widening it to every STRING LITERAL was the obvious next cut and was still
  wrong.** A regex containing a quote — `/rel="stylesheet"/`, `/href="([^"]+)"/`
  — desynchronises a naive literal scanner, and the offending line was silently
  skipped. The mutant survived twice.
- **So the question is asked of the LINE**, over the comment-stripped source. A
  printer cannot be recognised by NAME (the next one will be called something
  else, which is how this hole was dug), and `COMMAND_LINE` + `BRACKETED`
  together are narrow enough that a line which is not an instruction almost
  never matches: it must carry a shell verb AND an angle-bracketed token. A
  template literal spanning real newlines is covered for free, which is what the
  previous cut needed a special case for.

**The widened guard immediately found four real offences it had been hiding**,
all of them usage lines printed through `console.error`:

| script | printed |
| --- | --- |
| `tradebot/scripts/v3-diagnose.js` | `usage: node scripts/v3-diagnose.js <tokenCA> [chainKey]` |
| `tradebot/scripts/v3-discover.js` | `Usage: node scripts/v3-discover.js <v3-pool-address> [chainKey]` |
| `tradebot/scripts/v4-discover.js` | `usage: node scripts/v4-discover.js <token-address> …` |
| `scripts/gen-admin-secrets.mjs` | `Usage: node scripts/gen-admin-secrets.mjs <username> <password>` |

None can know a real value — only the operator knows which token they mean —
so all four DESCRIBE the argument in prose and print no command at all, which is
the other half of the rule. ⚠️ The last one mattered twice over: a pasteable
line carrying a password puts that password in the shell history of whoever runs
it.

```bash
cd tradebot && node --test pasteableCommands.test.js   # 3 tests, no network
```

## "hapus stable coin" — the site never had the rule the bot has always had

Reported with the Top Coins board open on **`$WTRX Wrapped TRX`** at rank 1 and
carrying **`$USDG Global Dollar`** at rank 7, beside `$BTCB`, `$SHIB`, `$PUMP`.

**The bot has answered this since its market filler was written.** GeckoTerminal
ranks POOLS, so the top of any chain is WETH, USDC, wstETH, cbBTC, and
`bigCoins.notAProject()` refuses to LIST them — a board whose Ethereum section
reads `WETH · USDC · USDT` is worse than one with three rows. **The site never
had the rule at all**, so it happily ranked the ones listed before that rule
existed. `WTRX` was in the bot's set the whole time and was simply listed
first; `USDG` and `BTCB` were never in it.

- **`src/lib/notAProject.ts` is a PORT, and a port is a second owner.** The bot
  is a separate CommonJS package this build cannot import, so
  `notAProject.test.ts` reads `bigCoins.js` and asserts the two lists are
  EQUAL — and the issuer regex too. Same guard `market:check`'s ported chain map
  carries, for the same reason: **a rule that drifts between two copies is worse
  than a rule in one place only, because both look right.** Mutation-tested in
  both directions — dropping an entry from EITHER side fails it.
- ⚠️ **ONLY AN AUTO-LISTING IS HIDDEN, and that is the whole safety of it.**
  `FREE` is the tier the filler books itself and is deliberately absent from the
  pricing UI, so it can never be bought. Everything else on that board is
  somebody's money, and a paid listing that vanished from the site is a refund
  conversation — the rule this repo already states about demoting rather than
  hiding a quiet pool, applied to a category instead of to a bad afternoon. A
  project that pays to list a stablecoin gets exactly what it paid for.
- **Filtered ONCE, in the payload.** Patching it into each component is how the
  board and the ticker end up disagreeing about what is on the board; one filter
  in `getTokensPayload` makes it true of the trending board, Top Coins, the
  movers, the heat map, the wire, the chain counts and the tracked-volume figure
  at the same instant. It runs BEFORE `buildSignals`, or the wire headline can
  still crown a stablecoin. A test refuses any component that grows its own copy.
- **It says how many it kept off.** A row that disappears with nothing anywhere
  naming a cause is the shape this repo keeps having to diagnose from a
  screenshot.
- ⚠️ **NO SUBSTRING MATCH ON "USD"** — that would eat every stablecoin-themed
  memecoin there is, and the bot's comment has said so since it was written.
- ⚠️ **AND THE SUFFIX TRIM IS BOUNDED.** `USDC.e` folds to `USDCE` and must be
  refused, so a trailing `E`/`B`/digit is trimmed before re-checking; trimming
  ANY trailing character instead would delete `$SOLD` (base SOL), `$DAIS` (DAI),
  `$POLY` (POL) and `$BTCX` (BTC). ⚠️ **The first test written for that rule was
  VACUOUS** — it used `USDX`, which folds to `USD`, a string in neither set, so
  the mutant that unbounds the trim survived it untouched. Found by mutation
  testing, not by reading.
- **The glyph scar came across verbatim**: `USD₮0` is U+20AE, not a T, and the
  bot's first cut STRIPPED it (folding to `USD0`, still not refused) rather than
  transliterating. `$USDT` reached a public board at $185B that way.

**What this does NOT do: delete anything.** The rows are still listings and
their token pages still work — they are kept off the site's rankings, and the
bot will not list new ones. Removing them for good is 🗑 in the admin panel, and
that is deliberately a human's call.

```bash
npm test                                     # notAProject — 9 tests, no network
cd bot && npm test                           # bigCoins is unchanged in behaviour
```

**Config a fix depends on:** nothing. ⚠️ It ships ON and CHANGES an existing
board on deploy, deliberately, the way the trending floors did.

### ⚠️ …and it shipped with the symbol rule INERT, reading as 2 rows filtered

The first live run said

```
[market] 2 auto-listed stablecoin/wrapper row(s) kept off the board
```

Three rows were reported and two were filtered, which reads like a working
filter with one gap. It was not: **every symbol rule was dead, and the two that
went were caught by the NAME rules alone.** "Wrapped TRX" matched
`WRAPPER_NAME`, "Global Dollar" matched `MONEY_NAME` — and `$BTCB` ("BTCB
Token") matches no name rule, so it reached the board.

**`BoardToken.symbol` is the DISPLAY form and it carries a `$`.** `fold`
transliterates currency glyphs rather than stripping them — `₮` IS a T, and `$`
is an S — which is right for a ticker a brand writes in a glyph and
catastrophic for a `$` this app prepends itself: `"$WTRX"` folds to `"SWTRX"`,
which is in no set.

That is **the exact scar this module inherited**, reintroduced one field over.
`bigCoins.js` states it in its own header: *"The symbol we JUDGED and the symbol
we PUBLISHED were different strings, which is why nothing looked wrong at either
end."*

- **The prefix comes off at `hideFromBoard`**, the one boundary that knows the
  convention, so `fold` stays byte-identical to the bot's and the equality guard
  keeps meaning what it says.
- ⚠️ **AND THE TESTS COULD NOT HAVE CAUGHT IT**, because every one of them
  passed a RAW ticker — the shape the BOT sees — while the site passes the
  display form. A test measuring its own fake, for the third time in this file.
  `$BTCB` is now the assertion that matters: it matches no name rule, so it is
  caught by the symbol or not at all.

### The same run buried everything under a line that was not a fault

Six lines a minute of

```
[market] solana: served last-known reading for 24 token(s) the providers missed this cycle
```

at WARN, one per chain per cycle, for ever — and **that is the ORDINARY state of
this box**: the site's GeckoTerminal budget is 5/min against ~19 chunks a cycle,
so some chunks always lose and `fillFromLastGood` is what keeps their rows
priced. It is the system working, reported as a fault, and it buried the one
line that said a stablecoin had been filtered.

"An alert every cycle is a channel nobody reads by the second hour" —
`upstreams.js`, borrowed for the fourth time. `shouldReport()` is PURE and lives
beside the memory it describes, so a test walks a chain through days of cycles
in milliseconds:

- **The transition only.** A count drifting 24 → 23 → 24 is one incident, not
  thirty; re-triggering on each change is the flood again with an extra
  condition on it.
- **A RECOVERY is an alert too**, at INFO — a chain that healed and one nobody
  noticed look identical otherwise — and it is not announced for a chain that
  was never degraded.
- **It repeats** while the state holds, so a long outage does not scroll away.
- **Chains are tracked apart**, or one noisy chain silences the rest.

```bash
npm test    # notAProject (10) · lastGood (10)
```

Mutation-tested: judging the `$` as part of the ticker, announcing a recovery
that never happened, reporting every cycle, never repeating, and sharing one
report slot between chains each fail between one and three tests.

### "jangan pernah listing stable coin … hapus smua yang listing" — the rule was on one door of three

Two halves, and the first is why the first half kept being needed.

**`bigCoins.topByMcap` has filtered these out since the market filler was
written**, so the rule LOOKED covered. It is one door of three. The auto-lister
SCAN lists from the DISCOVERY feeds — DexScreener profiles and boosts,
pools.trade — which are not ranked by pool depth and had **no such filter at
all**; `chainSeed` is a third; and the fourth is whatever gets added next.

- **`createFromInfo` is the documented ONE OWNER of "turn a priced token into a
  listing", so the gate goes there** and every door is covered at once. A rule
  the second caller has to remember is one the third forgets — which is exactly
  how the discovery feeds ended up with none.
- ⚠️ **It refuses BEFORE the site is called.** A gate that let the create through
  and undid it would put the row on a public site for however long the second
  call takes, and would write `everListed` for a token we never want back.
  Pinned by a test that asserts the ledger is untouched.
- **It is a refusal with a REASON, not a silent skip.** `null` is what both
  callers already read as "the site did not create it", and the line names the
  token — a feed full of stablecoins must not read as a quiet market.
- A test pins `notAProject` to exactly ONE call site in `autoLister.js` and
  refuses `trendFill.js` growing its own copy.

**And no gate reaches backwards.** `npm run listings:nostables` removes the rows
listed before it existed — dry run by default, `--apply` to delete, the
`listings:fix` contract, and it matters more here because a listing is gone for
good and the site is public.

- ⚠️ **It prints the TIER, and a PAID row is flagged above the table.** `FREE`
  is the tier the bot books itself and nobody can buy; anything else was bought.
  The instruction was "all", so `--apply` removes all of them — but a paid row
  can never leave without being named on screen first, because that one is a
  refund conversation rather than a tidy-up.
- **`{deleted:false}` is not a deletion.** The route answers that for an id it
  does not hold, and counting it is how a report says "removed 7" over a board
  that still has seven.
- It reads BOTH `sym` and `symbol` — the bot writes one and an older row may
  carry the other, and reading one only is how half a roster reads as clean.

#### ⚠️ …and the filter's own log line was the flood it was printed next to

```
[market] 2 auto-listed stablecoin/wrapper row(s) kept off the board   ×11
```

Added in the very change that taught the line BESIDE it to report on the
transition only. A lesson applied to one line and not to the one being written —
the trade bot's refusal path learnt this about its own if/else.

- **Reported when the SET CHANGES, never on a cadence.** This is a fact about
  the roster, not about the cycle, so it is silent for as long as the roster
  holds — and an emptied roster is said once, because a board that healed and
  one nobody noticed look identical otherwise.
- ⚠️ **It NAMES them.** "2" over three visible offenders is precisely the
  ambiguity that hid a dead symbol rule for a whole deploy: a number cannot say
  WHICH two.
- ⚠️ **THE BOOT STATE AND THE TEST SEAM ARE ONE CONSTANT.** Written as two
  literals, `_resetHiddenReport()` set the state the test wanted rather than the
  state the process boots into — so mutating the INITIALISER was invisible to
  every test, the reset seam quietly answering for the thing under test. A clean
  board announcing itself on every restart would have shipped. Found by mutation
  testing, not by reading.

```bash
cd bot && npm run listings:nostables              # what would go, with tiers
cd bot && npm run listings:nostables -- --apply   # remove them
cd bot && node scripts/run-tests.js test/noStables.test.js
npm test                                          # notAProject — 15 tests
```

**Config a fix depends on:** nothing for the gate. The cleanup script needs
`INTERNAL_API_TOKEN` and `SITE_URL`, which live only on the server — it says so
rather than reporting an empty roster.

### "beberapa token presentasi 0%" — the 0% was true; the CAP was the claim

Reported with the Top Coins board opening on `$AI Barking Puppy $2.41B`, two
copies of `$BONK`, and `$TRUMP OFFER TRUTH $1.84B`, several rows reading
`+0.00%`. The token page for that $TRUMP settles it:

```
PRICE $9.17   24H +0.0%   MCAP $1.84B   LIQUIDITY $8.28M
VOL·24H $5    TXNS·24H 2  HOLDERS 0
```

**The percentage is not a dummy — it is a measurement.** Five dollars of volume
and two transactions in a day is a pool that did not move, and `+0.00%` is the
truth about it. Refusing to print it would be the fabricated blank this repo
already refuses to fabricate in the other direction.

**The CAP is the unearned number.** A market cap is price × supply, and on a
token nobody trades the price is whatever the last five dollars said — so the
figure is arbitrarily large, completely unbacked, and it was ranking the board.

This is the `$MRNA +465% on $0.05 of volume` defect exactly, **one column
over**. `changeRank` grew `tradedEnough` for the percentage ranking and stopped
there, on the stated reasoning that *"idle tokens are deliberately not excluded
from the VOLUME or SCORE rankings, which is right, because on those an idle
token sinks by itself"*. True of those two — and market cap is a THIRD ranking,
where an idle token floats for exactly the same reason a change ranking does.
The comment argued the general case and then enumerated two of three.

- **`topCoins` sorted by cap now demotes anything under `RANK_MIN_VOL_USD`** —
  the same predicate, not a second copy of the idea.
- ⚠️ **IT DEMOTES, IT NEVER HIDES.** `changeRank`'s rule and the same reason:
  these boards carry paying customers, and a listing that vanished because its
  pool was quiet today is a refund conversation. The row keeps its real cap in
  its own column; it just cannot lead a board it has not earned.
- ⚠️ **`-Infinity - -Infinity` is NaN, and a NaN comparator neither orders nor
  ties** — control falls through to whatever comes next. The demoted rows are
  separated by a boolean first and only then compared on their real value, so
  they stay ordered by cap among themselves.
- **The floor binds the MCAP ranking ONLY.** On volume and score an idle token
  sinks by itself, and demoting it there would be a second rule doing the first
  one's job.
- **An UNREADABLE volume is not a small one** — `tradedEnough`'s own exemption,
  and it still fails open here.

⚠️ **AND THE FIRST FIXTURE FOR THE NaN RULE COULD NOT SEE IT.** Its cap order
happened to BE its alphabetical order, so the mutant that drops the guard fell
through to the name tiebreak and produced the identical list. The three rows
disagree on purpose now — by cap `ZED → MID → ALPHA`, by name the reverse.

Mutation-tested: dropping the floor, leaking it onto the volume and score
rankings, and removing the NaN guard each fail exactly one test.

```bash
npm test    # home — 61 tests, no network
```

**Config a fix depends on:** nothing. `RANK_MIN_VOL_USD` ($1,000) is shared with
the change ranking — deliberately far below anything a reader would call busy,
because it is a ranking floor and not an eligibility one.

### "ganti dexscreener gpp ada watermark" — the apology was worse than the watermark

`ds:probe` on the box, and it found the half that matters:

```
✓ resolve pair HSKxCANK…AUWdbX  dex=raydium  liq=$8,276,316
· discover https://dexscreener.com 403 (candidates fall back to the built-in guesses)
  · /dex/chart/amm/v3/{dex}/bars/{chain}/{pair} ?from&to&res&cb
      400 — RIGHT PATH, wrong parameters
  ✗ /dex/chart/amm/v2/…   403 — the host refuses THIS SERVER, not this path
```

**The PATH is confirmed** — a 400 is the host saying "this resource exists and
your query is wrong", which is a completely different fact from the 404 that
started this. What is still unknown is the parameter vocabulary, and the one
step that could answer it outright — reading DexScreener's own JS bundle — is
**403 from this box**: Cloudflare refuses the datacenter IP for the HTML page,
so the script cannot see the code that builds those URLs. The deep grid (480
shapes: unit × resKey × resVal × countback × extra) is what is left, and it may
simply not contain the right one.

So the native DexScreener chart stays a guess with an open question, and the
operator's call is the pragmatic one: **DexScreener's own chart, embedded, with
its watermark.**

- ⚠️ **THE BAN WAS ON THE EMBED AS THE DEFAULT, AND THAT BAN STANDS.** A
  third-party iframe on every token page sat on "Loading chart settings…" for
  seconds and then planted a competitor's logo and wordmark across a Dexvra
  page. The native chart is still what a reader gets whenever either source can
  draw one — our colours, our type, our LIN/LOG and drag controls. What changed
  is only the ALTERNATIVE: an apology over an empty panel is strictly worse than
  a working chart with somebody else's mark in the corner.
- ⚠️ **`status === "none"` DELIBERATELY DOES NOT GET IT.** That state is a fact
  about the TOKEN — nothing has traded yet — and their chart would be just as
  empty while implying the failure was ours.
- ⚠️ **NULL FOR A CHAIN DEXSCREENER DOES NOT INDEX.** A constructed URL for a
  chain it has never heard of frames DexScreener's own "not found" inside our
  panel, which reads as OUR page being broken. The registry is the one owner —
  the same field `dsCovers` orders the market cycle on.
- **It says it is not ours**, and carries why our own could not be read — the
  `via DexScreener` rule, and what stops the next round of diagnosis.
- **A TOKEN address is embedded, not a pair.** dexscreener.com resolves it to
  the token's top pair itself, so this costs no request of ours and cannot go
  stale the way a cached pair address can.

⚠️ **THE THIRD IFRAME GUARD WAS IN A FILE I HAD NOT FOUND** — `dsChart.test.ts`
holds one about the PROVIDER ("this is DexScreener's DATA, never its widget"),
which is a different and still-live rule: adding a second data source must not
turn into embedding the source's page. It is unchanged; only the component's
boundary moved, and it is pinned where it belongs.

⚠️ **And the test for the label was VACUOUS.** `assert.match(CHART, /via
DexScreener/)` is true of a build where the embed says nothing at all, because
the native DexScreener SOURCE already prints a chip with that text. It asserts
inside the embed's own `<p className="ck-embed-note">` now — found by mutation
testing, not by reading.

```bash
npm test                                        # dsEmbed (5) · chartRoute (29) · dsChart
cd /opt/dexvra && npm run ds:probe -- solana 5m8k6jHhYFZkiL8FVLFtiu1EEki6HiTbQvLADoUbTJAA
```

**Config a fix depends on:** nothing — the embed needs no key and no path guess.
`DS_CHART_PATH` / `DS_CHART_QUERY` still take the native shape the moment
`ds:probe` lands one, and the native chart wins the instant it can draw.

### "bagaimana dengan logonya?" — and the line meant to answer it could not

Three things produce a monogram and the board renders all three identically:
the row lost its logo, the file is gone, or **our own proxy refuses a working
url**. `logos:check` names which — that has existed since the `$BREAKING`
round. What did not exist is an answer to the question actually being asked,
which is not "which row is broken" but **"is this broken at all, or is it just
not done yet?"**

The sweep already logged every pass. It could not say how much was LEFT:

```
[logos] looked up 8: 6 found (6 dexscreener), 1 with no artwork anywhere,
        1 undecided (an upstream could not be asked), 6 written to the listing store
```

Eight rows a rebuild against a backlog nobody could see. **"The resolver is
failing" and "the resolver is working through 214 rows at 8 a minute" rendered
as the same line** — and the second is not a fault, it is under half an hour.
`queued` makes it arithmetic:

```
        · 206 still queued (~26 more rebuild(s))
```

- ⚠️ **An absent `queued` reports NO backlog rather than guessing one.** A
  caller that does not know the queue length must not make the line invent a
  number — a fabricated backlog is the same class of claim as a fabricated 0%,
  on the one line an operator reads to decide whether to go hunting.
- **A queue that fits in one pass says nothing.** A finished queue is not news,
  and this line is already the noisiest thing the board prints.

**What was checked and found sound**, so the next round does not re-check it:
`backfillLogos` is wired with both `persist` and `log` (a sweep whose writes all
fail says so in as many words — *"NONE of them could be written"*); the market
filler does carry `image_url` through to the listing (`bigCoins.js`), so a
filled row arrives with artwork whenever GeckoTerminal published any; and the
proxy allowlist covers the two indexes, the curated sets, the wallet asset
repos and the IPFS gateways the launchpads mint through.

```bash
pm2 logs dexvra --lines 300 --nostream | grep -F '[logos]'   # is it working, and how much is left
npm run logos:check -- --bad                                  # …and WHICH rows are broken
```

## "mengapa mc dan price TBA" — the post's market read was queued behind every timer job

An **Xpress Listing** went out to 12,528 subscribers reading

```
📊 Market cap: TBA ·  Price: TBA
```

…about a token dexvra.io was pricing at **$0.001004 on a $950.2K cap** in the
same minute, with $131.2K of liquidity and 1.3K transactions that day. Nothing
was down, and nothing about the token was missing.

**`fulfillment.js` called `fetchMarket` with no opts, which is GT-FIRST.**
`fetchGT` waits on `gtSlot(PRIO_BACKGROUND)` — the shared GeckoTerminal queue,
which has **no deadline of its own** and releases at the keyless budget behind
every timer job on the box — and the `MARKET_BUDGET_MS` bound (8s) then fired
**with DexScreener never asked at all**. So the one figure a paying customer
screenshots was decided by a queue that had nothing to do with their token.

- **The post renders exactly three market figures** — price, market cap and
  liquidity (`coinVars` in `channels/format.js`) — and DexScreener publishes all
  three for free, off a budget nothing else here competes for. `POST_MARKET` is
  `{ cheap: true, need: ["priceUsd", "mcap", "liq"] }`.
- **It is an ORDER, never a second reader.** Same two sources, same merge, one
  different sequence — the rule `fetchMarket`'s own header states. A DexScreener
  answer missing any of the three still falls through to GeckoTerminal exactly
  as before, with its answer REUSED rather than re-asked.
- **Both call sites**, listing and trending: they render the same three fields
  through the same `coinFrom`/`bannerCoinOf` pair, and a fix applied to one of
  two siblings is a fix half-made — this file's own scar, three features over.
- ⚠️ **This is the listing form's defect on a different surface.** *"bot tidak
  merespon untuk paket listing setelah di minta drop ca"* was the same queue,
  the same tier, and the same conclusion: a **user-prompted** read may not sit
  in the background lane. The form was bounded and this was not.

```bash
cd bot && node scripts/run-tests.js test/postMarket.test.js   # 4 tests, no network
```

Mutation-tested: restoring the GT-first read fails the source guard, and the
behavioural test asserts GeckoTerminal is not asked **at all** when DexScreener
has all three.

**Config a fix depends on:** nothing. `GECKOTERMINAL_API_KEY` in `bot/.env`
still raises the real ceiling rather than dividing it — this only stops a post
spending it on a question DexScreener answers for free.

### …and it went out TBA again, because a curve has no pool to be cheap about

"mengapa ketika listing price mc tba pdahal sudah ada price dan mc" (2026-09-09),
with the Xpress card for **Wallet Route ($WROTE)** on Robinhood reading
`Market cap: TBA · Price: TBA`, and beside it the operator's browser on
ponsfamily.com showing `$0.000004` on a `$4,494.71` cap in the same minute.

The round above is deployed and is not the cause. **$WROTE is 1% along a PONS
BONDING CURVE**, so it has no pool at all — and every source the post's read
could reach was either structurally blind to that or a guess:

| source | on a curve token |
| --- | --- |
| DexScreener (now first, and cheap) | indexes POOLS — nothing |
| GeckoTerminal | indexes POOLS — nothing |
| `fillFromLaunchpad` | asks Pons over HTTP on a host and path this repo has never verified (`verified: false`), which the operator's own `launchpads:check` reports unreachable |
| **the curve contract** | **has the price, and was never asked** |

**This file already wrote the answer down, one feature over, and then wired it
to one caller.** *"The one source that cannot be unreachable — the token
contract itself — was the one nobody asked."* `ponsChain` went into
`discovery.fetchTokenInfoX` for the LISTING FORM and nowhere else, so the form
autofilled a name, a ticker and an X handle off the chain and **the paid post
announcing that very token printed TBA on both figures.** A source wired to one
surface is not a source the next surface has.

- ⚠️ **AND THE OBVIOUS WIRING SHIPS INERT.** Precedence decides which ANSWER
  wins; it must not decide who gets to ASK. Read in the natural place — after
  the pads, where the hole-filling rule puts it — the contract is FOURTH inside
  the post's 8s ceiling: DexScreener misses, GeckoTerminal waits on
  `gtSlot(PRIO_BACKGROUND)` which has no deadline of its own, the launchpad
  spends 6s discovering its guessed host is unreachable, and the chain read
  starts with about two seconds left against its own 5s timeout. It would have
  passed every test and printed TBA on the box. The request is STARTED with the
  indexers and merged in at the end, so ordering and scheduling stay separate
  questions. `.catch` at CREATION — nothing awaits it on the path where the
  indexers answered, and an unhandled rejection ends the process on Node 18.
- **The MEMO is what makes that affordable.** `fetchPonsLaunch` resolves a launch
  BY ADDRESS off the factory rather than scanning a window, so *"Pons never
  launched this"* is permanent — remembered, bounded, evicted oldest-first, and
  every graduated Robinhood token then costs one localhost request ever instead
  of one per poll across nine background pipelines.
- ⚠️ **ONLY A 404 IS MEMOED.** Writing a transport failure down would mark a
  live curve as "never launched" for the life of the process — this section's
  own TBA, made permanent and immune to the park expiring, because the memo is
  checked above it. A failure parks the reader instead.
- **Order is the SAME as discovery's** (pads, then chain) rather than a second
  private precedence for the same two sources: two orders is how the form and
  the post come to disagree about one token's price.
- ⚠️ **The "a live pool reading still wins" test was VACUOUS.** Its fixture gave
  GeckoTerminal a complete record, which closes the `!priceUsd || !mcap` gate —
  so the chain leg never ran and inverting the merge's precedence left it green.
  It was asserting the GATE while claiming to assert the RULE. A partial indexer
  answer is the only shape that reaches the merge with a reading already in hand.
- ⚠️ **So was the fail-safe test.** It drove a transport failure, called
  `_reset()`, and looked at the next request — and `_reset()` clears the memo,
  i.e. exactly the thing under test, so memoing a failure survived the mutation
  run untouched. A park and a memo both suppress the second request; only
  `{ok, why}` tells them apart, and that distinction IS the rule.

### "lalu lgo juga bermasalah" — the banner drew through a stack the site had already fixed

The same card, drawing the **Dexvra diamond** where $WROTE's artwork belongs —
for a token whose picture is on its own pad page and whose contract publishes it.

Nothing upstream was broken. `tokenLogo` had already been fixed to publish the
`ipfs://<cid>` the contract carries, and `ponsChain.httpsLogo` rewrites that to
one gateway. Then `fetchLogoUrl` fetched that url **RAW**: ipfs.io had not
pinned the CID, `!r.ok` returned null, the fallback shipped to 12,523
subscribers — and the `catch` said nothing at all.

**"Never one hardcoded host" and "a guard is only honest while it measures the
stack the caller actually uses", in the same three lines.** The SITE has had
gateway failover since the `$BREAKING` round; the banners went around
`/api/logo` entirely, so fixing the website's gateway list bought the channel
nothing — the site could draw a logo the channel could not.

- **`/api/logo` is the ONE owner of "can this url be rendered"** and it already
  does all of it: extracts the CID and fails over across `IPFS_GATEWAYS` (a CID
  is the hash of the bytes, so a 404 is a fact about the GATEWAY), re-checks
  every redirect hop, refuses a 200 carrying HTML, carries the hotlink
  allowlist. Asked over `DEXVRA_API_BASE` — same box, no public round trip.
- ⚠️ **A REFUSAL by the proxy is an ANSWER and is not retried raw.** Falling back
  on a refusal would defeat the allowlist and put a picture in the channel that
  the token's own page cannot draw. Only the proxy being UNREACHABLE falls
  through — a web app mid-deploy must not cost every listing its artwork.
- ⚠️ **`photoSource` proxies too, over the PUBLIC origin**, because TELEGRAM
  fetches that one and `127.0.0.1:3005` is not a place Telegram can reach. It is
  the same defect on the one path whose fallback is no picture at all.
- ⚠️ **The reachability verdict travels WITH the bytes.** The first cut kept it
  in a module-level flag, and a listing and its trending slot are fetched
  concurrently here — whichever call looked second would read somebody else's
  write. Pinned by a test that refuses one url and kills the proxy for the other.
- **It is never silent again.** "The project gave us no logo" and "we could not
  fetch the one they gave us" are different facts and the banner renders them
  identically, as the Dexvra mark.

### "add api pons v2 …/launchpad/0xfCd4…" — the link we generated was a 404

The operator sent the canonical URL, and their address bar settled a third
defect nobody had measured: `ponsTokenUrl` built **`/token/<address>`** and Pons
serves **`/launchpad/<address>`**. The path was assumed from the shape of
`ponsExplorerUrl` directly beside it — which really is `/token/` — and that is
exactly what made the guess look right.

A dead link is the quiet kind of wrong: it reaches the listing review card and
the "🚀 Still bonding" line as ordinary blue text, so a reader who taps it
concludes the launchpad is broken rather than that we built the url.
`PONS_TOKEN_PATH` makes the next move a line in `.env`, the contract every
guessed launchpad path in this repo carries.

```bash
cd bot && node scripts/run-tests.js test/curvePost.test.js test/bannerLogo.test.js   # 15 tests, no network
npm test                                                                             # site: pons/ponsUrl
```

Ten guarantees are MUTATION-TESTED rather than argued: dropping the chain
leg, inverting the merge's precedence, reading the chain serially, memoing a
transport failure, dropping the memo, fetching the logo raw, retrying a refusal
raw, leaving `photoSource` unproxied, proxying over the public origin from the
bot, and restoring the `/token/` path. Each fails between one and five tests.

**Config a fix depends on:** nothing — `DEXVRA_API_BASE` already points the bot
at the site and defaults to `http://127.0.0.1:3005`. ⚠️ **But the web app must be
running and on a build that carries `/api/pons` and `/api/logo`, so this is a
`bot/` change AND a `src/` change and the deploy is the full one.**
`PONS_IPFS_GATEWAY` moves the gateway the bot rewrites to; `IPFS_GATEWAYS` is
the site proxy's own list and already fails over.

#### "bagaimana agar masalah ini tidak terjadi lgi" — the watch covered half a promise

Asked straight after, and it is the right question for the fourth time: two
rounds of TBA and one of the artwork, **every one of them detected by a person
opening the channel and screenshotting it.**

⚠️ **AND A WATCH FOR EXACTLY THIS ALREADY EXISTED.** `postFigures` was built one
round earlier, on this very promise, and it would have caught the TBA. It
watched the FIGURES and stopped there — so the next paid post published TBA on
both figures *and* the Dexvra mark where $WROTE's own logo belongs, and only the
second half reached nobody. **A watch on half a promise is how the other half
keeps being found by screenshot**, and it is this file's own "a lesson applied
to one branch of an if/else is a lesson half-learnt", one module over.

- ⚠️ **A LOST LOGO IS INVISIBLE BY DESIGN, which is why it needs the watch MORE
  than the figures do.** `TBA` at least looks wrong; the banner renders a missing
  logo as the Dexvra mark, which is the DESIGN for a logoless token and looks
  entirely deliberate. Nothing about a lost one is distinguishable from a project
  that uploaded nothing.
- ⚠️ **So "the project gave us no logo" and "we could not fetch the one they gave
  us" had to become different facts.** Only the second is a red mark — paging on
  the first would be permanently red on every listing whose owner uploaded
  nothing, the state `chart:preview` sat in for weeks. It is the line
  `pons:check` §6 already draws between a creator who filled nothing in and an
  app that dropped it.
- **`got` is read from the BUFFER the renderer was handed**, never re-derived by
  fetching the url again — a watch that re-asked would be answering a different
  question from the one the banner asked, and could report success over a post
  that drew the mark.
- **ONE post is ONE alert**, naming both halves and BOTH scripts: a logo that
  will not load and an indexer that will not answer are different layers, and
  `market:check` and `logos:check` send the operator to different places. The
  market sentence is dropped entirely when the only hole was the picture — a
  `Why: neither DexScreener nor GeckoTerminal returned anything` printed over a
  post that published a price and a cap sends them to the wrong one.
- ⚠️ **The trending path fetched its logo BELOW its own watch**, so that sibling
  could not have reported artwork it had not seen yet. Moved above it — the
  half-made-fix shape this whole section is about, found while wiring it.

**And a watch fires after a customer has already paid.** So `post:check` is the
half that runs BEFORE, on the box, where the causes can actually be told apart:

```bash
cd bot && npm run post:check                      # the newest listings, assembled as a post assembles them
cd bot && npm run post:check -- robinhood 0xfCd4CdEabe055315b1036A189eA54ca627Df390a
```

- ⚠️ **IT DRIVES THE POST'S OWN FUNCTIONS** — `_readPostMarket` (bounded,
  DexScreener-first, budget included) and `_fetchLogoUrl` (through `/api/logo`,
  gateway failover included), with `missingFigures` as the verdict. A check with
  a second copy of the question is precisely how `fonts:check` printed nine green
  ticks over a banner publishing boxes and how `trending:check` reported 44
  refusals where the bot reported 25. A test refuses it growing its own market
  read, its own indexer call, or its own proxy url.
- ⚠️ **THREE VERDICTS, and the middle one is what keeps it readable.** `ok` ·
  `honest` (nothing anywhere knows this token — the post telling the truth) ·
  `fault` (a hole this box could have filled). Only `fault` turns the exit code,
  so green means "the next post is safe" rather than "the script ran". A LOST
  LOGO outranks `honest`, or the artwork half would hide behind the figures half
  exactly as it did in production.
- **No argument means ASK THE SITE for real listings.** This file's oldest rule,
  broken four times: a command an operator can paste must contain only real
  values, and bash reads `<` and `>` as redirects. A test scans the script for a
  bracketed blank on any line carrying a shell verb.
- **It prints the build stamp**, because every round of this has begun with
  somebody reading a check as a statement about the fix they just deployed.

So the layers, each closing a hole the others cannot:

| layer | stops |
| --- | --- |
| the curve read, started with the indexers | a token with no pool publishing TBA |
| the logo fetched through `/api/logo` | one dead gateway costing the artwork |
| `postFigures` watching figures AND artwork | the operator being the detector |
| `post:check` + the build stamp | "is the next listing going to be fine?", and a check read off a stale checkout |

⚠️ **The remaining hole is the deploy, because it is not code.** The server only
ever runs `main`, and this touches `bot/` AND `src/` — the bot's fix depends on
the web app carrying `/api/pons` and `/api/logo`, so a `pm2 restart dexvra-bot`
without the rebuild leaves the curve unpriceable and the logo unfetchable while
the bot's own sha looks correct. `npm run post:check` printing the stamp is the
cheapest tell.

Four guarantees are MUTATION-TESTED rather than argued: the watch ignoring the
artwork, a logoless listing paging anyway, the market sentence printed over an
artwork-only hole, and the trending sibling losing its report — plus five on the
check: an honest silence reported as a fault, the lost logo no longer
outranking it, a lost logo alone ceasing to be a fault, the check growing its
own market read, and a half-named token silently answered with other tokens.

##### …and the first live run found the fix's own budget was too small

`post:check` on the box, straight after the deploy (`build 5b518ce`), read
4 of 5 clean — `$MUCHWOW`, `$ZZZ` (Robinhood, priced), `$USEFUL`, `$LMEOW` all
with `price · mcap · artwork loads` — and one red:

```
✗ $GG — Green God  solana/BzAtM6svp…damascpump
  the row HAS a logo and it did not load — the banner would draw the Dexvra mark
  https://ipfs.io/ipfs/bafybeibk74wtpsgccfehq4zatxgorv5pwfmtpy7qo7hj6kbvko5nmvokba
```

That row is the check earning its keep: before this it would have shipped the
Dexvra mark in silence. **But reading the two timeouts against each other turned
up a defect in the fix itself, and it is mine.**

| | budget |
| --- | --- |
| `/api/logo` | 3 IPFS gateways × `IPFS_TRY_MS` 5s, redirects followed INSIDE each — and its `deadline` only ever gated STARTING another gateway, never a fetch already running → **15s+ in the ordinary slow case** |
| the bot's `fetchLogoUrl` | `AbortSignal.timeout(12000)` |

⚠️ **So a proxy doing exactly what it was written to do outlasted its caller.**
The fetch recorded `reached: false`, and the "only an UNREACHABLE proxy falls
through" branch then went and fetched the RAW single-gateway url — the one thing
routing through the proxy exists to replace, reinstated by a mismatch between
two numbers nobody had compared. It also cost another 12s on the path between a
buyer's payment and their post.

**A budget smaller than the work it waits on turns a fix into a no-op** — the
same shape as the curve read sitting fourth inside an 8s ceiling, one feature
over, found the same way: by doing the arithmetic rather than reading the code.

- **Every fetch is now capped by what is LEFT of the total**, redirect hops
  included, so `TOTAL_MS` is a real ceiling instead of a gate on starting.
- **`TOTAL_MS` is a CONTRACT WITH THE CALLER**, not a local politeness knob, and
  it says so at its own definition: `logoProxy.test.js` reads it out of the
  route's source and fails if `LOGO_PROXY_MS` is not the larger of the two.
- ⚠️ **AND THE WARN WAS ONE SENTENCE FOR TWO FACTS**, which is this repo's most
  repeated rule broken in the line written to end the silence. "No gateway
  served it as an image" is about the artwork; "/api/logo did not answer" is
  about the web app, and sending an operator to hunt a dead logo for a stopped
  site is the wrong-layer diagnosis. Two sentences now, chosen by whether the
  host answered.

⚠️ **What this does NOT settle is whether `$GG`'s CID is actually gone.** Whether
a gateway serves a given CID is a property of the box's egress and of what is
pinned today — it cannot be measured from here, which is why `logos:check` is
what the check points at. What changed is that the next run can no longer report
a TIMEOUT as "no gateway has it": under the old budget those two were the same
line, so the red mark above is not yet proof of either.

```bash
cd bot && node scripts/run-tests.js test/logoProxy.test.js   # 4 tests, no network
```

- ⚠️ **AND `logos:check` WOULD HAVE SAID `HTTP 404` AND NOTHING ELSE.** That is
  our own proxy's answer once every gateway has refused, and it cannot tell an
  operator which refusal it was: a CID nothing has pinned is artwork that is
  GONE, while every gateway serving `text/html` is a dag-pb CID resolving to a
  DIRECTORY — deterministic, unrelated to pinning, and fixable. Two different
  answers, one shrug. The route carries the per-gateway outcome on an
  `x-logo-why` HEADER (a browser `<img>` reads only the status, so it costs the
  page nothing) and the check prints it.

Mutation-tested: the client budget no longer exceeding the route's, the route's
fetch unbounded by the remaining total again, and one sentence for both
failures — each fails a test.

##### …and the next run proved the logo was a TIMEOUT, then found the leg above it

`post:check` on `build e4ac4ca`: `$GG`'s artwork **loads**, and the red mark
moved to the market read.

```
✗ $GG — Green God  solana/BzAtM6svp…damascpump
  would publish: price · market cap · liquidity as TBA
  the read did not finish: the market read passed 8000ms — the shared GeckoTerminal queue
```

So the previous run's *"the row HAS a logo and it did not load"* was the budget
mismatch above, not a missing CID — which is exactly why that section refused to
call it either. **A red mark under an ambiguous diagnostic is not evidence of
the thing it names**, and one round of arithmetic was cheaper than a round of
hunting for artwork that was never gone.

⚠️ **AND THE NEW FAILURE IS THE SAME DEFECT ONE LINE UP.** `$GG` is a pump.fun
token; pump.fun is `verified: true` and answers from this box:

| stage | |
| --- | --- |
| `fetchDS` | miss — a bonding curve has no pair |
| `fetchGT` | **awaited, queued on `gtSlot(PRIO_BACKGROUND)` with no deadline of its own, and an 8s fetch timeout on top** → spends the caller's entire budget |
| `fillFromLaunchpad` | pump.fun. **HAS this token's price. Never reached.** |
| `fillFromChain` | concurrent since last round — and Robinhood-only anyway |

The chain leg was made concurrent *because being last in a serial queue made it
inert*. The pad leg directly above it was left serial. **A lesson applied to one
branch is a lesson half-learnt**, written in this file by the commit that
half-learnt it.

- **The fix is a SLICE, not concurrency, and the difference is cost.** Starting
  the pad up front would fire an HTTP request for every indexed token on every
  poll of nine background pipelines; GT answers in milliseconds when it answers
  at all, so bounding it costs a healthy read nothing and only ever takes time
  away from a queue. `GT_STAGE_SHARE` (0.55) leaves the remainder for the pad
  and the contract. It is the rule `curveTrade`'s `STAGE_MS` already states:
  **no single stage may consume the whole budget**, and a stage that overruns is
  INCONCLUSIVE, never a verdict.
- ⚠️ **It binds ONLY a caller that SAYS it is on a clock** (`opts.budgetMs`,
  passed by `POST_MARKET`). The background pipelines pass nothing and wait
  exactly as they always have — a slice imposed on them would throw away a
  slow-but-fine GT answer and re-ask the pads on every poll of every listing.
- ⚠️ **ALL THREE MUTANTS SURVIVED THE FIRST CUT OF THE TESTS.** They called
  `fetchMarket` directly and asserted only that the pad was EVENTUALLY asked —
  true of the broken code too, because `fetchGT` has its own 8s timeout and the
  pad is reached after it, just far too late for the post. What the post cares
  about is whether a price arrives INSIDE the budget, so the test drives
  `_readPostMarket` — the real caller, with the real bound.
- ⚠️ **And the fixture used `"GGmint"`**, which the launchpad registry refuses
  before making any request, so it reported the pad as never asked while the
  code worked perfectly. A test measuring its own fake, for the third time in
  this file; it uses the address off the operator's own screenshot now.

```bash
cd bot && node scripts/run-tests.js test/curvePost.test.js   # 10 tests, no network
```

Mutation-tested: GT unbounded again, the slice forced on callers that never
asked for one, and the post no longer declaring its budget — each fails a test.

##### …and the green run's one ⚠️ was a sentence claiming a source we do not have

`post:check` on `build c528bcc` is **green** — `Every post assembled here would
publish its figures and its artwork`. `$GG` prices (`0.00001338 · mcap
13382.9`) off pump.fun, which is the slice above working, and correctly notes
its liquidity prints as `—` because a bonding curve has no pool depth.

The one mark left is `$JOVI` on **Tron**, and reading its sentence is the point:

```
⚠ $JOVI — JOVI  tron/TSCs1xL6rCxt477W9hdoGK2kqD6u2Mc94r
  no indexer and no launchpad returned anything for this token
  nothing to fix here — this is the post being honest
```

⚠️ **`padsFor('tron')` IS EMPTY.** No launchpad returned anything because none
was ASKED — there is no Tron pad in the registry at all. That is *"we could not
ask"* dressed as *"nothing is there"*, this repo's most repeated rule, in the
one sentence whose whole job is explaining a silence. And the line under it then
closed the question: *nothing to fix here.*

- **It stays ⚠️, never a fault**, and that is deliberate: this box genuinely
  cannot fill that hole today, and reddening would be permanently red on every
  chain with no pre-migration source — the `chart:preview` state.
- **What changes is that the two are now distinguishable.** A token nobody has
  ever heard of and a CHAIN this repo has no launchpad for are different
  problems, and only the second is ours. The sentence names the chain and says a
  pre-migration token there has no source at all.
- ⚠️ **NO PAD WAS ADDED ON THE STRENGTH OF ONE TOKEN.** Tron's launchpad is
  SunPump, and adding it is the documented cheap move (`verified: false`,
  env-overridable, measured by `launchpads:check` on the box) — but nothing here
  establishes that `$JOVI` is a bonding-curve token rather than one no indexer
  covers, and guessing a host, a path AND a field shape off an assumption about
  the symptom is building on two guesses instead of one. The check now says what
  is missing; adding it is a decision with a measurement behind it.

Mutation-tested: the sentence claiming a pad was asked again, and "nothing to
fix here" printed over a chain with no pad — each fails a test.

##### "mengapa selalu seperti ini" — the same CID flipped ✓/✗ on identical code, and it uncovered a month-old regression

Run 4 (`build ac3502a`): `$GG`'s artwork failed AGAIN — *"no gateway served it
as an image"* — after loading on runs 2 and 3. `git diff c528bcc..ac3502a`
touches CLAUDE.md, a check-script sentence and its test: **zero lines on the
logo path**. The operator's question was the right one: why is it ALWAYS like
this.

Three independent diagnostic lenses were run against it (a code-defect
skeptic, an upstream advocate told to refute itself, and one covering the
store/caches/breakers), and they converged:

- **The path is stateless and the answer flipped, so the INPUT flipped** — the
  gateways' cache state for a lightly-pinned pump.fun CID.
- ⚠️ **`pump.mypinata.cloud` — pump.fun's OWN pin — was on the allowlist (with a
  comment naming it) and NOT in `IPFS_GATEWAYS`.** And `IPFS_MAX_TRIES=3`
  counted the caller's own url as try one, so a stored `ipfs.io` url left room
  for exactly two fallbacks (`dweb.link`, `gateway.pinata.cloud`) — the last
  two entries of the list were dead code, and the one gateway guaranteed to
  hold a pump.fun CID was never asked. Whether the artwork loaded depended on
  what a public gateway happened to have cached that minute. It is second in
  the ladder now and `IPFS_MAX_TRIES` is 4, so three real fallbacks sit behind
  the caller's url; `logoGateways.test.ts` pins the pin's position and the
  count.
- ⚠️ **The bot's `readImage` threw away `x-logo-why`.** The route carries the
  per-gateway outcome on that header precisely so the caller can say WHICH
  refusal it was — and every non-200 printed the same sentence. It travels to
  the warn now, and a refusal with no header names the status.

**And driving the fetch by hand found a regression older than this session.**
`api.uploadImage` returns `${DEXVRA_API_BASE}${json.url}` — an ABSOLUTE
`http://127.0.0.1:3005/api/media/<hex>.png` — while its call site's comment
reads *"relative /api/media/..."*. The site's `LOGO_RE` accepts `http://`, so
that localhost url was stored on public listings since 2026-08-29:

| consumer | what it did with `http://127.0.0.1:3005/api/media/…` |
| --- | --- |
| site `logoSrc` | saw a scheme → proxied it → `/api/logo` refused a non-https localhost host → **monogram** over a file on this disk |
| site `mediaName` / `isLostUpload` | did not match → the dead url was never healed and `pickLogo` went on ranking it "stored" |
| bot `fetchLogoUrl` (after `d0a2194`) | proxied it → 400 → **not retried raw** (a refusal is an answer) → the trending post lost its artwork and blamed "no gateway" |
| bot `photoSource` | handed Telegram `https://dexvra.io/api/logo?u=http://127.0.0.1…` → 400 |

It never showed in `post:check` because the five newest rows all carry
EXTERNAL logos — the check measured what was in front of it.

- **The producer is fixed** — `uploadImage` returns the relative url, and the
  comment beside its caller is finally true.
- **ONE OWNER PER SIDE for "is this url one of our own uploads"**: `mediaPath`
  in `src/lib/mediaFile.ts` (which `mediaName` now reads through) and its
  mirror `bot/src/helpers/mediaUrl.js`. Both accept the relative form AND an
  absolute on our own hosts (`127.0.0.1`, `localhost`, the brand domain, the
  configured origins), ports ignored.
- ⚠️ **A FOREIGN HOST WITH OUR PATH IS NOT AN UPLOAD.** `https://evil.example/
  api/media/<hex>.png` must keep going through the proxy and its allowlist —
  recognising the path alone would let anyone hand the site a "same-origin"
  url that is nothing of the kind. Pinned on both sides and mutation-tested.
- **Rows already stored the old way are HEALED ON READ** (`healUploadUrls`,
  pure, in `logoWrite.ts` beside `applyResolvedLogo`), called beside
  `healSeedLogos` at BOTH load sites — a source scan fails if it is wired to
  one of them.
- ⚠️ **The heal could not live in `store.ts`**: that module imports `./listings`
  with no extension and cannot be loaded by the test runner — which is exactly
  why this repo keeps store rules PURE one module over. A mutation rule a test
  cannot CALL is a comment about one.
- **The bot reads its own uploads over `DEXVRA_API_BASE`** (localhost) rather
  than `SITE_URL`: a public round trip for a file on this disk was the old
  relative branch's cost, and it sat on the buyer's critical path.

Ten guarantees are MUTATION-TESTED — on the site: a foreign host accepted as an
upload, `logoSrc` proxying our own upload, the heal doing nothing, the pin
dropped from the ladder, `IPFS_MAX_TRIES` back to 3; in the bot: `fetchLogoUrl`
proxying our own upload, a foreign host accepted, `uploadImage` absolute again,
the reason discarded again, `photoSource` proxying our own upload. Each fails
between one and two tests.

```bash
npm test                                                                   # mediaFile · logo · uploadUrlHeal · logoGateways
cd bot && node scripts/run-tests.js test/bannerLogo.test.js test/dexvraApi.test.js test/logoProxy.test.js
```

⚠️ **What this does NOT settle: whether `$GG`'s CID loads on the NEXT run.** The
first load of a cold CID still depends on a gateway answering inside 12s; what
changed is that the gateway guaranteed to hold it is now asked, and that the
next failure will say which gateway said what. Making a logo that has loaded
ONCE never depend on a gateway again is a separate change (pin the bytes to
`/api/media` at fulfilment) and is recorded below if and when it lands.

##### "mengaoa selalalu seperti ini whats wrong?" — a logo that has loaded ONCE never asks a gateway again

Build `ac3502a`, the same `$GG` CID red again, and **zero lines changed on that
path between the green run and this one.** That is the answer to "why is it
always like this": the path was STATELESS over a STATEFUL third party. Whether
a public IPFS gateway holds a CID that minute is a fact about the gateway's
cache, and nothing in this repo remembered artwork it had already held in its
own memory — every paid post re-rolled the same dice on a file that, being
content-addressed, **cannot ever change**. Four rounds of gateway tuning (the
pin's host, the ladder order, the reasons, the budgets) each raised the odds
and none of them could take the roll away.

**The post PINS what it fetched.** The bytes the post just rendered from are
uploaded to `/api/media` — the same route the listing form's own upload goes
through — and the row's `logoUrl` is moved onto it. From then on the artwork is
a file on this disk, the `mediaPath` branch every reader already serves in
microseconds, and no gateway is ever asked again for that token.

- **`applyPinnedLogo` is a COMPARE-AND-SET, and every clause is a way a
  background write could do harm.** `toUrl` must be OUR upload (a stranger's
  url written as "pinned" is the regression this exists to end); `fromUrl` must
  be an external http(s) url (an upload is already pinned; a blank is a
  decision — `applyResolvedLogo`'s asymmetry, pointing the same way); and the
  row must STILL hold `fromUrl` at the moment of the write. An admin who set a
  different logo between the read and the write wins, silently, which is what
  makes a write nobody is watching safe. Pure, in `logoWrite.ts` beside the
  other two rules about what may touch a `logoUrl`, because "never overwrites"
  is a mutation property a source scan cannot tell from a comment.
- **`store.pinLogo` runs it inside `mutate`** and the internal route
  (`POST /api/internal/listings/pin-logo`) does nothing but call it — deliberately
  NOT a PATCH on the general listings route, which is an unconditional write.
- **On the bot it is BEST-EFFORT and BOUNDED** (`PIN_LOGO_MS`, 4s): an upload
  the site declines (an SVG, an unsniffable file), a CAS that says the row moved
  on, a dead site and a hang all return the ORIGINAL url — exactly what the
  post rendered from before this existed — and a late pin still lands for the
  next post. A pin may never cost the announcement it exists to protect.
- **Skipped where there is nothing to pin**: a buyer who uploaded a file
  (`p.logoFileId`) is already ours; a url `mediaPath` recognises in either
  spelling is already ours; a fetch that failed has no bytes, and its REASON
  goes to the alert instead.
- **Both siblings**, listing and trending — a fix applied to one of two
  siblings is a fix half-made, this file's own scar three sections up.

**The alert and the check now say WHICH kind of failure it was, and the
remedy carries real values.** `artFailure` reads `/api/logo`'s own
`x-logo-why` into five classes — `web-app` (the proxy did not answer: a
deploy, not artwork) · `not-an-image` (a gateway served HTML — a directory CID;
a pin cannot help, the stored url needs a different logo) · `gateway-refusing`
(401/403/429 — refusing THIS SERVER, not missing content) · `refused-by-us`
(400 with no reason — our own allowlist or redirect guard, deterministic) ·
`no-gateway-had-it` (flips with cache state and is NOT a regression) — and
`artRemedy` prints the `post:check … --pin` line with the order's own chain
and address filled in for the two flaky classes, and the `logos:check` line for
the deterministic ones — real values, never a bracketed blank. A sentence that sends an operator to pin a directory CID
is the wrong-setting misdiagnosis this file keeps paying for.

- **`post:check` prints the `--pin` line under every green external row**,
  because the moment to pin is while it loads. ⚠️ **`--pin` is the ONE write
  the check may make, and it is refused without a named token**: a diagnostic
  that writes to every paid row it can see is not a diagnostic.
- **The header prints BOTH build stamps** — this checkout's and the one the
  web app reports on `/api/tokens` — and a mismatch is red: a run mid-deploy is
  about the deploy, not the artwork, and this session read three of them as
  artwork.
- **Every gateway outcome carries its elapsed ms** and a 200 names its server
  (`x-logo-via: pump.mypinata.cloud 1834ms`), so "no gateway had it" separates
  from "the first three spent the budget and the fourth was never reached".
  ⚠️ The guard for that scans per LINE: the first `why.push` nests a template
  literal, and a backtick-delimited scan stops at the inner one and goes red on
  the code it exists to approve.

Considered and refused, with the reason, so it is not re-proposed: racing two
gateways per render (doubles the load on the source that is flaking), memoing
the bytes in-process (dies at restart, and this box is redeployed constantly),
retry-once (another 12s on the buyer's critical path), and pinning only from
the check (the check is not the path that runs). Sixteen guarantees are
MUTATION-TESTED rather than argued — eight on the bot's pin path, seven on the
site's CAS and route, and the per-line elapsed-ms guard — and each fails
between one and three tests.

```bash
cd bot && node scripts/run-tests.js test/logoPin.test.js test/postCheck.test.js test/postFigures.test.js
npm test                                                 # logoWrite · pinLogoRoute · logoGateways
cd /opt/dexvra/bot && npm run post:check                 # every green external row prints its own --pin line
```

⚠️ **This touches `bot/` AND `src/`**, so the deploy is the full one
(`bash /opt/dexvra/scripts/deploy.sh --with-bots`), and a post-check run
between the two restarts prints the mismatch line rather than a verdict.

**Config a fix depends on:** nothing. A row listed before this keeps its
gateway url until its next paid post or an operator's `--pin`; a buyer's own
upload was never on a gateway. Whether a given gateway serves a given CID
today is still measured on the box, which is why `IPFS_GATEWAYS` stays
env-overridable.

### "bagaimana kalo token listing di pons v2 dan … price dan marketcap masih tba dan tidak ada logo" — the USD figure hung on the scarcest source, and the artwork on one gateway

Asked as a hypothetical (2026-09-09), and the answer was that it was not one:
walk a Pons v2 curve token through the code the paid post runs, and BOTH holes
were still reachable on a busy minute, after every round above. Three causes,
none of them the chain.

**1. THE CURVE'S PRICE WAS MULTIPLIED BY AN ETH/USD REFERENCE FROM GECKOTERMINAL
AND NOWHERE ELSE.** `readLaunchSnapshots` reads the curve's spot price off the
contract perfectly well, in ETH. To print it in dollars the app asked GT for
WETH's price — the one metered source on the box, sharing a ~30 req/min per-IP
ceiling with the bot suite, budgeted at 5/min for the site and armed with a
process-wide 120s cooldown on any 429. `describe()` then nulled `priceUsd`,
`mcapUsd` AND `priceQuote` whenever that read failed, and `fetchPonsMarket`
parked the whole board fallback for five minutes on the same throw. So on a
busy minute every curve token on the site — and every paid post the bot builds
through `/api/pons` — read TBA over a price the chain had just answered. This
file's own oldest rule, one number over: *a PRICE has two free sources; a
CANDLE has one* — and the ETH/USD reference had been treated as a candle.

- **`providers/pons/quoteUsd.ts` is a LADDER**: Coinbase spot (keyless; the
  trade bot has priced every card through it since it was written) →
  DexScreener's own WETH pair on Ethereum (the site's existing reader) →
  GeckoTerminal LAST, because it is the only rung that costs a chart. Every
  rung is bounded (`STEP_MS`, 3s) because this sits inside `/api/pons`, which
  the bot reads on a 5s clock of its own; a rung that FAILS says why, and
  `marketWhy` carries all three refusals to the record, the bot's read, the
  post's alert and `post:check` — "no USD reference for ETH — coinbase: 503;
  dexscreener: 403; geckoterminal: rate limited" is a diagnosis, a bare null
  is another round of guessing.
- ⚠️ **THE CHAIN'S OWN ANSWER IS A FACT AND IS NEVER NULLED WITH THE USD
  FIGURE.** `priceQuote` (in ETH) survives a ladder with no rung standing; only
  the dollar figures go, and the record says why. Losing the reference used to
  cost the reading it was meant to convert.
- **`nativeUsdX()` never throws and caches only an ANSWER** — `cached()`
  rethrows a cold miss, so a null is never served stale for the life of the
  process, and once a number is in, the stale-while-revalidate copy carries
  every later outage.
- **The SIDE READS are bounded too** (`SIDE_MS`, 3s): the curve histories
  feed the period stats and the profile feeds the socials, neither is the
  PRICE, and a public RPC taking its time over six log chunks used to hold
  the whole record past the bot's deadline — a TBA by a longer road. Past the
  bound the read is left RUNNING (its result lands in its own cache) and the
  record goes out without that half. Measured in `test:pons` with a node that
  never answers a log walk: the record still comes out, priced, in 3006ms.

**2. THE ROW WAS BORN BLANK, AND NOTHING AFTER BIRTH COULD FILL IT.** The bot's
market read already carried the contract's logo (`mergeCurve`) — and
`fulfillListing` read the market AFTER its logo step and never looked at
`live.logoUrl`; the site's resolver sweep had no Pons source at all. So a curve
token's artwork was in hand on the post's own read and reached nobody.

- **The market read STARTS beside the Telegram download and is AWAITED
  BEFORE `api.createListing`**, and `adoptChainLogo` fills a BLANK only,
  https only — a logo the buyer uploaded or typed is their decision, and an
  `ipfs://` would fail the site's `LOGO_RE` and cost the whole listing over its
  picture. The trending sibling adopts it the same way, above its own watch.
- ⚠️ **AND A RECORD DEXSCREENER PRICED IN FULL STILL TAKES THE CONTRACT'S
  LOGO.** DS indexes some pads' curves as ordinary pairs (Pons on Robinhood
  among them) and has no picture for a token minutes old, so the merge — which
  only runs when a figure is MISSING — was never reached on exactly the path
  that looked healthiest, and the chain read that carried the logo was "one
  localhost request whose answer is thrown away". `logoFromChain` sits on
  EVERY exit of `fetchMarket` (a priced answer leaves by three doors, and a
  rule on one of them is a rule the other two do not have — the first cut sat
  after the last door only), and it binds ONLY a caller on a clock
  (`opts.budgetMs`, the paid post): the nine background pipelines must not wait
  on a chain read for a field they do not render, and the read they started
  stays fire-and-forget exactly as before. An indexer's own logo is an ANSWER
  and is never replaced.
- **The site's resolver gained a Pons rung**, FIRST and only on a
  `launchpad === "pons-v2"` chain, injected as a dep from `providers/index.ts`
  (this module is alias-free so `npm test` can drive it; the contract reader
  is not). Every candidate is still FETCHED before it is believed — and
  verified across the gateway LADDER, because a CID is the hash of the bytes,
  so one gateway's 404 is a fact about the gateway: all four missing is
  `unreachable` (retried in 30 min), never a twelve-hour "no artwork" miss.
- **`lib/ipfsGateways.ts` is the ONE owner of the ladder**, moved out of
  `/api/logo` the moment a second consumer needed it — the $GG round was two
  copies of this list disagreeing about whether pump.fun's own pin was on it.
  The route imports it; a guard fails if the route grows a list of its own.

**3. ⚠️ `pons:check` §7 PROBED GECKOTERMINAL ALONE**, and would have printed
*"every USD figure on the feed is null while this is refused"* over a 429 —
true while GT was the only source, and a check lying in the ALARMING direction
from the day the ladder shipped: an operator sent to buy a GT key for a feed
Coinbase was pricing perfectly well. The verdict is the app's own record now
(`/api/pons` names the rung that priced ETH, or every rung that refused); the
three direct probes are notes about THIS box's egress and may never turn the
exit code — pinned by a comment-stripped scan of the probe loop.

```bash
npm run test:pons                                                     # 79 checks: the ladder, priceQuote surviving it, the bounded side reads
npm test                                                              # quoteUsd (5) · ipfsGateways (4) · logoGateways (6) · tokenLogo (38) · ponsCheck (8) · logoPipeline (23)
cd bot && node scripts/run-tests.js test/curvePost.test.js test/postFigures.test.js   # 20 + the repinned watch guard
cd /opt/dexvra && npm run pons:check                                  # §7: which rung prices ETH FROM THE BOX
cd /opt/dexvra/bot && npm run post:check                              # the newest listings, assembled as a post assembles them
```

Twenty guarantees are MUTATION-TESTED rather than argued — the ladder order,
`priceQuote` nulled with the USD figure, `marketWhy` dropped, a side read
unbounded, the Pons rung removed, an all-gateways miss recorded as "no
artwork", the sweep not wired, the listing's adoption removed (⚠️ the first
guard for that was a source scan and went green on `if (false && adopt…)` —
the create is intercepted and DRIVEN now), the trending adoption removed, the
bot's `toInfo` dropping the reason, the merge carrying the refusal beside a
real price (⚠️ behaviour-neutral on every priced-chain fixture; the fixture
that kills it prices from the OTHER source), the adoption overwriting a
buyer's logo, `logoFromChain` a no-op, one door bypassing it, background
callers waiting too, the route growing its own ladder, the pin dropped, and
in the check: a direct probe turning the verdict, `marketWhy` ignored, and a
green mark over a null price. Each fails between one and five tests.

⚠️ **This touches `bot/` AND `src/`**, so the deploy is the full one
(`bash /opt/dexvra/scripts/deploy.sh --with-bots`): the bot's read depends on
a web app serving `quoteUsdSource`/`marketWhy` on `/api/pons`, and a
`pm2 restart dexvra-bot` alone leaves the ladder undeployed while the bot's
own sha looks correct.

**Config a fix depends on:** nothing — every rung is keyless and ships on.
⚠️ Whether Coinbase and DexScreener serve THIS box is a property of its
egress today (the sandbox this was written in answers 403 for all three), which
is exactly what `pons:check` §7 measures. `GECKOTERMINAL_API_KEY` in the
repo-root `.env` raises the LAST rung's ceiling and nothing else here;
`IPFS_GATEWAYS` still moves the ladder without a deploy.

#### The audit round — the pad leg could spend the budget the chain's answer needed

A diagnose pass over the finished change (every claim attacked by two
independent refuters) found four things worth acting on, and the first is the
recurring shape of this whole saga: a source that had ANSWERED, un-consulted
behind a source that hangs.

- ⚠️ **THE PAD LEG SAT BETWEEN THE GT SLICE AND THE CHAIN, UNBOUNDED.** With
  the post's 8s budget, DexScreener misses (a curve has no pair), the GT slice
  spends 4.4s, and `fillFromLaunchpad` then asks a host `launchpads:check`
  reports unreachable — `LAUNCHPAD_TIMEOUT_MS` (6s) per read until its breaker
  benches it. That is a pad leg ending at t≈10.4s, past the post's bound, with
  the chain read that had answered at t≈0 sitting one line below, never
  reached. Reproduced through the real caller, not argued. The pad leg is a
  SLICE now — what is left of a budgeted caller's clock, less a reserve for
  the chain merge — the `STAGE_MS` rule for the third source in this function.
  Precedence is unchanged: a pad that answers in time still wins; one that
  overruns is inconclusive. Unbudgeted callers wait exactly as before.
  ⚠️ **And the test for it needed the pad's breaker RESET**: three transport
  failures earlier in the file had benched it, a benched pad is skipped, and
  the test passed on the unsliced code while claiming to cover the wait — the
  leaked-state scar, on the launchpad registry this time.
- ⚠️ **THE CHAIN READ'S OWN FAILURE HAD NO SURFACE.** Every `ok:false` out of
  `ponsChain` — the site answered 503, the socket refused, the reader parked —
  ended at `log.debug` in `fillFromChain`, so a post publishing TBA over a
  parked reader was reported as *"neither indexer returned anything"*: a
  failure of ours rendered as a fact about the token, on the one line the
  alert exists for. `ponsChain.lastWhy()` is the surface (per address,
  bounded; the park reason process-wide, because the park is), the post's read
  consults it, and the park is logged at WARN — once per cooldown, which is a
  transition, not a poll. An ANSWER of either kind clears it.
- ⚠️ **`post:check` READ THE ROW'S LOGO; THE POST ADOPTS THE CONTRACT'S.** A
  blank row takes the chain's artwork at creation, and the check printed *"no
  logo on file"* over a post that draws it — a guard measuring a stack the
  renderer does not use, the `$MORTY` shape one field over. It drives
  `_adoptChainLogo` — the post's own rule, never a copy — and says when the
  artwork it measured is the contract's.
- **The alert's remedy names the check that can SEE the chain.**
  `market:check` probes the two indexers and reports a Pons curve token as
  "honest"; on a chain the Pons reader covers the remedy names `pons:check`
  beside it.
- **"ONLY A 404 IS MEMOED" was proved for a THROW and never for a status**, and
  the test seam cleared the memo it existed to prove. `_unpark()` lifts the
  park alone, so a 503 is now shown to be re-asked once the park lifts —
  where a memoed one would answer "not a Pons launch" with no fetch, for the
  life of the process, about a live curve.

Refuted and NOT acted on, for the record: `PONS_CHAIN_MS` (5s) against
`/api/pons`'s cold path — with the side reads bounded at 3s the cold record is
~3.6–4.6s on a public RPC and exceeds 5s only on a stalled batch, which is an
egress fact for the box (`PONS_CHAIN_MS` in `bot/.env` if it ever measures
that way); parking on ONE localhost timeout rather than the registry
breaker's three is the module's stated design, kept; the stored gateway url
being one host is moot once the post PINS the bytes.

Six more guarantees are MUTATION-TESTED: the pad slice removed, `lastWhy`
not consulted, the check reading the row's logo, the remedy dropping
`pons:check`, an answer keeping a stale failure, and a 503 written into the
memo. Each fails between one and two tests.

```bash
cd bot && node scripts/run-tests.js test/curvePost.test.js test/ponsChain.test.js test/postCheck.test.js test/postFigures.test.js   # 22 + 10 + 19 + 19
```

#### …and the diagnose pass's one CONFIRMED finding had two halves still open

Seventeen agents, eighteen raw claims, seven attacked by two refuters each,
ONE survived — the defect above (the USD reference on the scarcest source,
`priceQuote` nulled with it), which the ladder had already closed. Its refuters
were precise about what the ladder had NOT closed, and both halves are the
same shape: a failure of ours, served or parked as a fact about the chain.

- ⚠️ **`/api/pons` CACHED A RECORD THE LADDER COULD NOT PRICE FOR THE FULL
  TTL.** `cached()` stores whatever the loader returns, so a launch read during
  the ladder's worst minute — `priceUsd: null` over a `priceQuote` the curve
  had just answered — was served to every reader for twenty seconds and then
  stale-while-revalidate after that, the bot on its 5s clock included: a paid
  post read TBA off a CACHE after the ladder had recovered. `unpricedByUs()` is
  the predicate — decided from the record's own fields, never from a sentence:
  a native-quoted launch with an ETH price and no USD price is OURS, an
  ERC-20-quoted launch publishing no USD figure is the token's — and the route
  re-keys such a record under `UNPRICED_TTL` (3s). Short, not zero: every
  reader re-running a three-rung ladder that is genuinely down is the stampede
  the cache exists to stop.
- ⚠️ **THE BOARD'S FALLBACK PARKED THE CHAIN READER FOR FIVE MINUTES OVER A
  USD REFERENCE.** `fetchPonsMarket` awaited `nativeUsd()` UNCAUGHT, so a
  ladder with no rung standing THREW, and `pons/index.ts` reads a throw as
  "this box cannot reach the chain" — parking the whole on-chain reader over
  snapshots it had just read perfectly well. The park exists for a dead RPC.
  With no dollar figure there is no row to publish, so it answers an EMPTY
  map with the reason logged, and the next cycle asks again.
- **The refuters' two cautions were followed, not the proposal's spelling.**
  `buildMarket(…, quoteUsd ?? 1, …)` would have put ETH-denominated numbers
  into `LiveMarket.priceUsd` under a USD label — a wrong number, worse than a
  missing one — and multiplying `priceQuote` by the bot's own CoinGecko reader
  would make a SECOND owner of the ETH/USD reference, so dexvra.io and the
  channel would print different prices for one token. The site's ladder stays
  the one owner; the bot reads `priceUsd` from it.

Four guarantees are MUTATION-TESTED: the fallback throwing again, an
ERC-20-quoted launch counted as ours, the route keeping the full TTL, and the
unpriced TTL no shorter than the launch TTL. Each fails between one and two
checks.

```bash
npm run test:pons                                                    # 86 checks: the ladder, the fallback that does not park, the predicate
node --test --experimental-strip-types src/lib/providers/pons/ponsRoute.test.ts
```

#### "liat ini" — the check's red was the NODE, and four sections rendered it as facts about the token

Three screenshots off the box on `9d5b1ce`. `post:check` for the WROTE curve
token: **✓ priced 0.000004255 · mcap 4255.64 · artwork via
gateway.pinata.cloud, adopted from the contract** — the feature this round
exists for, working. And `pons:check`, red:

```
4 · 0xfCd4…   ✗ getLaunchedToken failed — HTTP 429
6 · …         the form would autofill: (nothing — the creator filled nothing in)
7 · …         ✗ no USD price — the curve and the pool answered no price
              every USD figure on the feed is null while EVERY rung refuses …
                coinbase → $2492.4   dexscreener → $2491.9   geckoterminal → $2492.1
Verdict       ✓ every contract read answered individually — the chain layer is healthy
              ✗ Something is broken
```

Read that again: three ladder rungs answering, under a sentence saying every
rung refuses; a creator accused of filling nothing in, about a token whose
contract the same run could not read; a chain layer called healthy two lines
above "something is broken". **The whole screen is one fact — the public
Robinhood RPC was rate-limiting this box — rendered four different ways as
facts about the token, the creator and the ladder.** The site, the bot, the
trade bot and the check all share that node, and the check had just added
nine serial reads per token of its own.

- ⚠️ **A REFUSED BATCH WAS RETRIED ONE CALL AT A TIME.** `rpc.ts` degraded to
  sequential calls when "the endpoint did not honour the batch" — and a 429 to
  the whole payload took that branch, so twenty-seven serial requests went
  into a host that had just said no, each refused in turn, each pushing every
  process on the box further past the limit. That is the CoinGecko sweep's
  defect, the DexScreener 403 retry's and `gt.ts`'s, one transport over. A
  refusal now (401/403/429, or a JSON-RPC ITEM saying "rate limit" — some
  nodes answer 200 with `-32005` per call) PARKS the host (Retry-After
  honoured, clamped 1–10s) and the same calls go to the NEXT host; a
  sequential run that meets a refusal stops there; with no host left every
  call fails with the refusal NAMED. A transport error, a 5xx and an
  un-honoured batch still degrade one call at a time, exactly as before —
  those say nothing about a quota.
- ⚠️ **AND THERE WAS NO NEXT HOST.** "Never one hardcoded host" is this file's
  first rule about upstreams, and `PONS_RPC_URL` was one url. It is a
  comma-separated LIST now (`rpcUrls`; `rpcUrl` stays the first entry for the
  places that print it), every chain read is handed the list, and
  `ponsRpcHosts.test.ts` scans the provider for a read handed the first host
  alone — a single such site works on a healthy node and never fails over,
  which is the reassuring reading.
- ⚠️ **THE REASON WAS DISCARDED AT THE FIRST DECODE.** `ok()` turned every
  failed outcome into `null`, so a curve and a token the node REFUSED to read
  became `curve: null, meta: null` — byte-identical to a curve that answered
  nothing and a creator who typed nothing. `describe()` then wrote "the curve
  and the pool answered no price", the form autofilled nothing, and the check
  reported both as facts. `readWhy` rides every snapshot (the first of the
  token's nine reads the node did not answer), `marketWhy` says *could not
  read the curve — rpc 429*, and the all-fail throw on the record read carries
  the reason it never used to ("Pons RPC unavailable" was the whole sentence;
  a 429 and a dead socket were one line).
- ⚠️ **A REFUSED-READ RECORD WAS CACHED FOR THE FULL TTL**, and the bot read it
  on its 5s clock — the round above closed this hole for the ladder and left
  it open for the node. `unpricedByUs()` counts `readWhy` now, so such a record
  is re-keyed under `UNPRICED_TTL` like a ladder failure; `ponsChain.toInfo`
  carries it, so the bot's `lastWhy`, the post alert and the remedy name the
  node rather than the token.
- ⚠️ **THE CHECK KEPT READING INTO THE LIMIT, THEN REPLAYED THE BATCH INTO IT.**
  One 429 printed a per-token ✗, the loop went on to the next nine reads, and
  section 5 then sent the app's own batch into the same bucket — a diagnostic
  spending the quota it was diagnosing, and printing the limit it caused as
  nine separate contract failures. It stops at the FIRST 429 now: one
  `4 · The node` block, section 5 skipped and saying why, sections 6 and 7
  reading `readWhy` off the app's record ("the app's own read failed: rpc 429"
  is about the node, never the creator; "no ETH price to convert — the curve
  could not be read" is about the node, never the ladder), and a verdict that
  names the node once instead of "healthy" over "broken".
- **`=== null`, not `== null`, on the record's `priceQuote`.** The app
  serialises it on every record — a number, or an explicit null when the curve
  answered no price. A record with NO such field is a build older than the
  ladder, and claiming "the curve answered no price" about a record that never
  carried the field is a claim nobody measured; the driven test for that
  branch is what caught the first cut.
- ⚠️ **AND "THE NODE ANSWERED WITH AN ERROR" IS NOT "THE NODE DID NOT ANSWER".**
  The first cut of `readWhy` took the first FAILED outcome of a token's nine
  reads as the node's refusal — and a `logo()` that REVERTS (no such function,
  an older token) is the contract answering "no logo". That record would have
  carried `readWhy: execution reverted`, been re-keyed under the 3s TTL for
  ever by `unpricedByUs` (the bot's 5s clock behind it), and sent the check to
  blame the node for a token's own answer. The other direction was open too:
  name, symbol and logo can be refused per ITEM while decimals and totalSupply
  answer, and gating `readWhy` on curve/meta failing to decode left that
  record with no reason, `name: ""` and the full TTL — "the creator filled
  nothing in", cached, over a node saying no. So the OUTCOME says which it
  was: `RpcOutcome` carries `unanswered` for a failure that is ours or the
  transport's (a refusal, a dead socket, a timeout, no host left, an item
  missing from the array), never for the node's own error, and `readWhy` is
  the first UNANSWERED read of the nine whether or not the rest decoded. A
  text match on "reverted" at the caller would have been a fourth private
  idea of failure. ⚠️ Two of the flag's four sites were DEAD — every refused
  outcome is carried to `batchSlice`'s final fill, which flags it again — and
  the mutation run said so (removing them changed nothing), so the flag has
  one owner per path now and the comment says which.
- **Recorded for accuracy:** the single-address record read has ALWAYS thrown
  when it failed (the all-fail check), so `fetchPonsLaunch` never answered
  null → 404 → the bot's "never launched" memo over a refusal. What was
  missing there was the reason in the throw, and a refused item inside a
  healthy multi-address batch being dropped with nothing saying which. The
  doc comments say that rather than describing a defect that did not exist.

Twenty-seven guarantees are MUTATION-TESTED rather than argued — on the
client: a refusal retried singly, not parked, Retry-After unclamped, a refusal
not carried to the next host, an item-level limit re-asked, a sequential run
not stopping, a benched host still asked, a 5xx parking the host, a refusal
not flagged unanswered, a dead socket not flagged, a missing item not flagged,
a revert flagged; on the provider: the first FAILED read taken as the refusal,
`readWhy` gated on the decode again, `marketWhy` ignoring it, `unpricedByUs`
ignoring it, the throw carrying no reason, the record dropping it, a read
handed one host; on the check: a per-token ✗ over one 429, the creator blamed,
the ladder blamed, "healthy" over a rate limit, an absent field read as null,
section 5 replaying into the limit; and the bot dropping `readWhy`. Each fails
between one and four tests; two more written for the flag's redundant sites
SURVIVED, and that is what removed the sites.

```bash
node --test --experimental-strip-types src/lib/evm/rpc.test.ts                       # 10: the bench, the failover, no hammering, answered vs unanswered
node --test --experimental-strip-types src/lib/providers/pons/ponsCheck.test.ts      # 10: the check, driven against a node that answers 429
node --test --experimental-strip-types src/lib/providers/pons/ponsRpcHosts.test.ts   # every read takes the host list
npm run test:pons                                                                    # 102: a refused read carries its reason, a revert does not, neither is cached long
cd bot && node scripts/run-tests.js test/ponsChain.test.js
cd /opt/dexvra && npm run pons:check                                                 # after the deploy — one block about the node, or none
```

**Config a fix depends on:** nothing to turn on. ⚠️ But whether the public node
rate-limits this box is a property of the box's own traffic today, and the
only thing that RAISES that ceiling rather than dividing it is a second node:
`PONS_RPC_URL` in the **repo-root** `.env` takes a comma-separated list, the
public host first and a paid or private Robinhood Chain RPC after it — a host
that refuses is parked and the next takes the same calls, so it is a line, not
a deploy. This touches `bot/` AND `src/`, so the deploy is the full one.

##### The audit round — the host list could not fail over on the commonest failure

Run against the fix above by five lenses (two of them died on a session limit,
so their claims were judged here rather than by refuters). Thirteen survived
reading, and the first is the fix defeating itself.

- ⚠️ **A HOST THAT IS DOWN NEVER FAILED OVER.** The carry to the next host was
  gated on `isRefusalText`, so a first entry with a dead socket was degraded to
  one call at a time on ITSELF, failed all forty, and the second host was never
  asked — **"never one hardcoded host" defeated by the list that implements
  it**, on the way a host usually breaks. Every outcome the node did not
  ANSWER is carried now, and `sequential` stops after three transport failures
  rather than proving the same silence forty times at a full timeout each
  (measured: 41 requests to a dead host, now ≤10, bounded by the worker pool
  rather than by the call count).
- ⚠️ **…AND THE FLAG THAT GATES IT WAS THE ONE A MUTATION RUN HAD JUST
  REMOVED.** `unanswered` was set only on the final fill, on the reasoning that
  everything reaches it anyway — true while the carry matched on the refusal's
  TEXT, and false the moment the flag became the gate: three tests went red
  immediately, saying a refused batch was no longer carried at all. It is set
  at every site again and mutation-tested at each. **A mutant that proves a
  line dead proves it dead against TODAY's code**, and the comment recording
  that now says which change would revive it.
- **The reported reason is the LAST host's, never an earlier one's.** Host A
  rate-limits us and host B merely drops an item from its array: reporting "rpc
  429" for that call sends an operator to a quota that had nothing to do with
  it. Survived its first mutation run — no test distinguished the two — and has
  one now.
- ⚠️ **A GRADUATED LAUNCH PRICES OFF ITS POOL, and the pool read had no
  reason.** `readCurvesAndMeta` learnt to carry `readWhy` and `readPoolStates`
  did not, so a refused `extsload` on the PoolManager was still the sentence
  this whole round exists to end — *"the curve and the pool answered no
  price"*, `readWhy` null, cached for the full TTL. The pool read carries its
  reason per token, and a wiring read that failed carries one too: no wiring is
  a pool state we could not ASK for, not a chain with no pools.
- ⚠️ **OUR OWN BENCH BECAME A FIVE-MINUTE OUTAGE.** The client parks a refusing
  host for one to ten seconds; that throw reaching the board's Pons fallback
  parked the whole on-chain reader for **five minutes** — a rate limit
  escalated into an outage by the code that noticed it, which is the ETH/USD
  ladder's own scar one transport down. `rpcSelfLimited()` is the one owner of
  "this failure is our pacing" (a refusal, or a host this client benched); the
  park still fires for a chain the box genuinely cannot reach, and a live
  connection-refused still parks.
- ⚠️ **THE 503 THREW THE REASON AWAY AT THE LAST HOP.** `/api/pons` answered a
  bare `upstream unavailable`, so the bot parked on *"site answered 503"* and
  an operator went to look at a web app that was working perfectly. The
  reason travels — and **anything URL-shaped is stripped first**, because a
  paid RPC keeps its key in the path and this is a public response and a pm2
  line. The bot reads the body, bounded, and falls back to the status alone.
- ⚠️ **`decimalsCache` REMEMBERED A REFUSAL FOREVER.** It is cached "because it
  never changes" — true of a token's decimals, false of a read the node
  refused, and 18 stored for a 6-decimal token is every price off by a million
  for the life of the process. Only an ANSWER is written; measured by whether
  the chain is asked a second time, because the fixture's real answer is also
  18 and a value assertion could not tell the two apart.
- **`blockSeconds` had the same shape** — one refused header read pinned the
  shipped default for the process, dating every trade in every history from a
  number nobody measured. The fallback answers that call and the next one asks
  again.
- **The launch feed's all-fail throw and the board's multi-address read were
  the last two silences.** The feed threw `Pons RPC unavailable` with no
  reason; `fetchPonsMarket` dropped every address it could not read without a
  word, so a node refusing half a cycle looked exactly like half the chain
  being quiet. Both name the node now.
- **A refused LIQUIDITY slot keeps the price and marks the record.** Half a
  pool read answering renders a depth of ZERO — a fabricated figure on a
  public card, the shape `launchpads.js` names one field over — so the reason
  is recorded even though the price is fine, which is what keeps it off the
  full TTL and points `pons:check` at the node. Publishing the price anyway is
  deliberate: a real number with a hole beside it beats no row.
- **`readLaunchRecords` was deleted.** Nothing called the non-X wrapper once
  the reasons started travelling, and a function that binds nothing is the row
  the engine ignores.
- **Recorded, deliberately NOT changed:** a refused `readTokenProfile` still
  reads as a creator who filled no socials in. Folding it into `readWhy` would
  re-key a fully priced record under the 3s TTL over a couple of links, i.e.
  a stampede on `/api/pons` for the one field nothing prices — and the
  "creator filled nothing in" sentence cannot be produced by it, because
  symbol, name and logo come from the batch that DOES carry a reason.

⚠️ **And the suite that ran alongside the mutation run reported a failure that
was the MUTATION RUN's**, not the code's: `mutate.py` rewrites the source in
place, so a background `npm test` sharing the checkout reads whichever mutant
is applied at that instant. Re-run clean, both suites are green. A test result
measured while something else is editing the tree is not a measurement.

Twelve more guarantees are MUTATION-TESTED: a dead host not carried, a dead
host asked once per call, a refused batch unflagged, an item-level limit
unflagged, an earlier host's reason reported for a later host's drop, the pool
reason dropped, the pool refusal not recorded, the decimals cache written on a
refusal, the bench parking the reader, and the bot dropping the 503's reason.
Each fails between one and three tests.

```bash
node --test --experimental-strip-types src/lib/evm/rpc.test.ts                  # 13: the bench, the failover, the dead host, the reason
npm run test:pons                                                              # 110: a refused POOL read, the park that must not fire, the decimals cache
cd bot && node scripts/run-tests.js test/ponsChain.test.js                      # the 503's reason reaches the park sentence
```

### "project ini ada logonya tapi pas listing di dexvra tidak ada, add api pons"

`$ORCHFLOWS` (orchflows, Pons v2, Robinhood, 3% along its curve) went out as an
Xpress Listing to **12,514 subscribers** drawing the **Dexvra mark**, beside a
screenshot of ponsfamily.com rendering the project's own artwork in the same
minute. The banner's figures were RIGHT — `MC $4.7K · $0.00000474` against the
pad's `$4,741.81` — which is the tell: the market read worked and the artwork
did not, so this is not the TBA saga one section up. Three causes, and every one
of them is this file's own recurring shape.

⚠️ **AND THE WATCH BUILT FOR EXACTLY THIS SAID NOTHING.** `postFigures` learnt
the artwork half one round earlier and pages only when `wanted && !got` — the
row HAS a logo and it would not load. A row born BLANK is `wanted:false`, which
is deliberate and correct for a creator who uploaded nothing… and identical, on
the banner and in this watch, to a source that refused us. So the operator was
the detector for a third time on the same promise.

#### 1. The artwork had ONE source on the door that looked healthiest

DexScreener indexes Pons curves on Robinhood as ordinary pairs, so it priced
this token in full and `fetchMarket` left by its FIRST door. `logoFromChain` was
added to those doors precisely because `fillFromLaunchpad` sits below them and
is unreachable once an indexer answers everything — and it asked the **chain and
nothing else**. The pad leg never got the same fix: *a lesson applied to one
branch is a lesson half-learnt*, one source over, in the code written to end it.

- **`logoFromCurve` asks the chain, then the PAD.** Chain first because it is
  already in flight (free) and it is the authority; the pad only when the
  contract had no artwork, at most ONE request per paid post, never on the door
  where `fillFromLaunchpad` already asked, and never for a background caller —
  nine pipelines poll every listing on timers and must not grow a launchpad
  round trip each for a field they do not render.

#### 2. ⚠️ EVERY LAUNCHPAD LOGO PINNED ON IPFS WAS NULLED AT THE REGISTRY

`shared/launchpads` built its record with `rec.logoUrl = safeUrl(...)`, and
`safeUrl` allows http/https and nothing else. **A launchpad pins its artwork on
IPFS.** So the pad has never been able to publish a logo for any token minted
that way, in either process, since the registry existed — and pump.fun happens
to serve an https pinata url, which is why nothing ever looked wrong.

It is the IDENTICAL defect this file already records one layer up
(*"`readCurvesAndMeta` kept a logo only if it matched `/^https?:\/\//`, so every
logo Pons has ever published was nulled at the source"*), fixed in the site's
Pons reader and never here. **So "add api pons" would have shipped inert for the
artwork even with the right path.**

- **`normalize.logoUri` is the allowlist**, beside `safeUrl` rather than
  widening it: an `ipfs://` website or Telegram link is meaningless, and only
  the LOGO has consumers that rewrite it. `ar://` stays out for the reason the
  site's `tokenLogo` states — no consumer has that rewrite, so publishing it
  turns "no logo" into a broken image.
- **`bot/src/helpers/httpsLogo.js` is the ONE owner of the gateway rewrite.** It
  lived inside `ponsChain` while the chain was the only producer of an `ipfs://`
  URI; the registry is a second producer now, and two copies of a rewrite is two
  gateways — the shape two pump.fun hosts in two processes already cost.
  `ponsChain.httpsLogo` re-exports it. The bot's shim rewrites ONCE for every
  consumer, so nothing downstream sees a scheme `adminValidate`'s `LOGO_RE`
  refuses — which would fail the WHOLE listing over its picture.

#### 3. ⚠️ A BASE LIST IS NOT INSURANCE AGAINST A WRONG PATH

The pad's host was settled by an operator's screenshot (`ponsfamily.com`); its
API SHAPE is still a guess, and this session cannot settle it — the host refuses
this sandbox's egress outright (`connect_rejected`, policy denial), which is the
same wall `launchpads:check` is the answer to. What the base list gave that
guess was nothing: **failover between bases is TRANSPORT-only**, on the stated
reason that a status means the host answered and the same request gets the same
status everywhere else. True of a HOST, false of a PATH — a 404 says *"that
spelling is not here"*, which is exactly when another spelling on the same host
is worth trying. The `dsChart.ts` distinction, one upstream over.

- **`tokenPaths` is a LIST tried on a 404 ONLY.** Every other status stops where
  it always did: a 429 or a 500 says nothing about which spelling is right, and
  three more requests would prove the same refusal three more times — the
  CoinGecko-sweep defect, one transport down. Bounded, cached once every
  spelling has 404'd, and a pad whose first path is right pays nothing.
- ⚠️ **`LAUNCHPAD_PONS_TOKEN_PATH` REPLACES the list, never leads it.** A pin
  followed by four guesses means a WRONG pin answers from a spelling the
  operator did not choose — so a wrong pin would read as a working one, which is
  the one thing a pin exists to make visible. ⚠️ The first test for that
  asserted only the pin ANSWERING, where the mutant is invisible; the case that
  sees it is a pin that 404s.

#### …and a blank the sources could not be ASKED for is now a fault

- **`logoWhy` rides the market record**, set ONLY where the CHAIN could not
  answer — it is refused, parked, threw, or answered with its own `readWhy` (the
  node refused some of the nine reads). A benched PAD sets nothing, or the alert
  would be permanently red on every Robinhood listing whose owner published no
  artwork, which is the state `chart:preview` sat in for weeks. ⚠️ And an
  `ok:true` with no record ("not a Pons launch") is a real ANSWER: the artwork
  question is then not ours to answer at all.
- **The alert names the LAYER**, and its remedy is `pons:check` rather than
  `logos:check`: the latter pulls the ROW's own logo through `/api/logo`, and
  the row has none — it would report *"nobody has given this token artwork"*,
  which is the very claim in question.
- **Both siblings**, listing and trending. A trending slot is a purchase too.
- **`post:check` carries the same third state**, through `postFigures`'s own
  predicate rather than a copy — a check with its own idea of the question is
  how `fonts:check` printed nine green ticks over a banner publishing boxes —
  and its `ok` line no longer says *"no logo on file"* without saying that every
  source ANSWERED. ⚠️ A blank we could not fill outranks the honest-silence
  reading, exactly as a lost logo does; written without that assertion the
  mutant reached `fault` by fallthrough and SURVIVED.

⚠️ **The door guard broke, and it was the guard that was wrong.** *"Every exit of
fetchMarket goes through logoFromChain"* matched `if (…) return …;` on ONE LINE,
so wrapping a long call went red over code that keeps the rule perfectly — this
repo's own recurring defect (the four-way pool TTL, the `{ ok: true,` build
stamp). It joins the continuation before counting the doors.

```bash
cd bot      && node scripts/run-tests.js test/curvePost.test.js test/postFigures.test.js test/postCheck.test.js
cd tradebot && node --test launchpads.test.js          # the path list, the pin, the ipfs logo
cd bot      && npm run launchpads:check                # WHICH pons spelling answers, FROM THE BOX
cd bot      && npm run post:check                      # the newest listings, assembled as a post assembles them
```

Nineteen guarantees are MUTATION-TESTED rather than argued: the pad leg removed,
the pad asked ahead of the contract, the pad asked by background callers, the
pad's `ipfs://` left unrewritten, the registry nulling it again, `logoWhy`
dropped, a creator's own choice reported as a fault, the path list not walked,
any status advancing it, the pin merely leading the list, `artworkUnread` never
firing, the page gate ignoring it, a blank with no reason paging anyway, the
remedy naming the wrong layer, each sibling dropping the reason, and
`post:check` ignoring it in either branch. Each fails between one and three
tests; three survived their first run and are what rewrote the tests.

**Config a fix depends on:** nothing — every path ships on and the built-in
spellings are tried in order. ⚠️ But **whether any of them is the real one is a
property of the box's egress and of the pad's API today**, and it cannot be
learned from here: `npm run launchpads:check` in `bot/` is the measurement, and
whichever spelling answers is pinned with `LAUNCHPAD_PONS_TOKEN_PATH` in
`bot/.env` — a line, not a deploy. The artwork does not wait on it: the CONTRACT
is still the first source and the one that cannot be unreachable.

#### "bagaimana agar masalah ini tidak terjadi lgi" — asked over a GREEN check

The deploy landed and `post:check` on the box answered for the reported token:

```
✓ $$ORCHFLOWS — orchflows   robinhood/0x36B44a8034Fe0eEddb8819dA82128bD6959161A6
  price 0.000004751170008685582 · mcap 4751.170008685582 · artwork loads via gateway.pinata.cloud 3972ms
  — from a public gateway; pin it so no post ever asks one again: npm run post:check -- robinhood 0x36B4… --pin
Every post assembled here would publish its figures and its artwork.
```

Green, and it names its own two remaining defects in the same six lines.

⚠️ **`$$ORCHFLOWS`.** The listing store spells `sym` as `$BONK`, and both
operator surfaces wrote `` `$${sym}` `` over it — the check's head AND the paid-post
alert. That is `From $1,000,0…` and the truncated `logos:check` url, on the one
line whose whole job is naming the token. `format.ticker()` is the owner. Six
other places in this repo already write `$` + `replace(/^\$/, "")` by hand;
those are correct and deliberately untouched — what may not happen again is a
SEVENTH surface spelling it out and getting it wrong.

⚠️ **"pin it so no post ever asks one again" IS A REQUEST, NOT A FIX**, and this
file has a name for that: *apt-get install is not a fix*, which cost six days of
banners publishing boxes. The paid post learnt to pin the bytes it drew from
(`a2425aa`). The **RESOLVER** — which is what actually fills most rows, in the
background, on a board rebuild, where nobody is watching — did not, so a healed
row kept a gateway url for ever and the only remedy was an operator remembering
a flag. That is the last dice roll in this chain: `$GG`'s CID flipped ✓/✗ across
**four deploys with zero lines changed on that path**, because whether a public
gateway holds a CID this minute is a fact about that gateway's cache.

- **`logoPin.pinResolvedLogo` copies the artwork onto our own disk** and moves
  the row onto `/api/media/…`. AFTER the persist, never instead of it: the CAS
  requires the row to still hold the url it is moving off.
- **BEST-EFFORT AND SILENT.** The row already holds a url that loaded a moment
  ago, so every failure here leaves exactly the behaviour that shipped before
  the pin existed. A throw would let one refusing gateway take a whole sweep
  down.
- ⚠️ **THE CAS DECIDES, and that is what makes a write nobody is watching safe.**
  `applyPinnedLogo` requires the destination to be one of OUR uploads and the
  source to still be the exact external url the row holds; an admin who set a
  different logo in between wins silently, and the file we wrote is orphaned —
  which costs bytes and never a wrong picture.
- **The in-process copy moves too**, or this render keeps handing out a gateway
  url the store no longer holds.
- **One extra request per newly-resolved row, once ever.** A pinned row is
  neither `convention` nor `none`, so `pickLogo` never queues it again.
- ⚠️ **`data/uploads/` IS STILL NOT IN THE MONGO MIRROR** — the durability hole
  this file already records. A lost disk loses the files, `lostUploads` clears
  those rows and the resolver re-resolves them. It degrades correctly, and it is
  worth knowing before reading a monogram as a regression.

⚠️ **AND IT NEEDED A THIRD COPY OF THE MEDIA WRITE, WHICH IS WHAT MADE IT ONE.**
The magic-byte sniff, the 3 MB bound, the random name and the `writeFile` were
BYTE-IDENTICAL in `/api/admin/upload` and `/api/internal/upload`, each with a
comment saying it matched the other. `lib/mediaStore.ts` is the owner now.
Three copies of *"what this server will store and hand back as an image"* is how
one of them ends up accepting an SVG — a document that can carry script when
opened directly, which `/api/logo` serves inert instead because there the trade
is the other way round.

⚠️ **The `UPLOADS_DIR` guard broke, and it was the guard that was wrong.** It
required every listed file to mention `UPLOADS_DIR` by name, so the day the two
routes stopped touching the directory at all it went red over code that keeps
the rule perfectly — the same shape as the door guard one section up. It asserts
that no file declares its own copy of the path.

So the layers on this promise, each closing a hole the others cannot:

| layer | stops |
| --- | --- |
| `tokenLogo` / `normalize.logoUri` allowlists | a real `ipfs://` logo nulled at the source |
| `adoptChainLogo` + `logoFromCurve` (chain, then pad) | the row born blank when a source had artwork |
| `IPFS_GATEWAYS` + the post's pin + **the resolver's pin** | a CID that flips with one gateway's cache |
| `logoWhy` → `postFigures` | a blank we could not fill reading as a creator's choice |
| `post:check` / `logos:check` + the build stamp | "is the next post safe?", on the box |

```bash
npm test                                   # mediaStore · logoPin · logoFill · logoPipeline
cd bot && node scripts/run-tests.js test/postFigures.test.js test/postCheck.test.js
pm2 logs dexvra --lines 300 --nostream | grep -F '[logos]'   # …N pinned to our own disk
```

Eleven more guarantees are MUTATION-TESTED: the sweep never pinning, a failed
pin costing the write, the in-process copy left on the gateway, our own upload
re-pinned every sweep, a refused CAS reported as a pin, non-image bytes written
onto the row, an SVG stored, the pipeline unwired, an upload route writing the
file itself, and each operator surface printing two dollar signs.

**Config a fix depends on:** nothing. `LOGO_PIN_MS` bounds the pin's own fetch.

##### "liat ini mengapa seperti ini" — a wall of `N undecided` that named no upstream

A screenshot of `pm2 logs`, the same line over and over down the whole terminal:

```
[logos] looked up 1: 0 found, 0 with no artwork anywhere, 1 undecided (an upstream could not be asked), 0 written to the listing store
[logos] looked up 8: 0 found, 0 with no artwork anywhere, 8 undecided (an upstream could not be asked), 0 written to the listing store
[logos] looked up 4: 0 found, 0 with no artwork anywhere, 4 undecided (an upstream could not be asked), 0 written to the listing store · 1 still queued (~1 more rebuild(s))
```

**Nothing was broken and every word of it was true.** `undecided` is the state
this module exists to keep apart from a miss — *an upstream could not be
asked*, retried in 30 min rather than written down as "no artwork" for twelve
hours — and a box whose logo sources are refusing it is supposed to produce
exactly this. Two things made it unreadable, and both are this file's own
rules broken in the one line that reports them.

- ⚠️ **THE REASON WAS THROWN AWAY AT THE COUNTER.** `resolveLogo` returns
  `unreachable: string[]` — `dexscreener: DexScreener 403 — refusing this
  server, benched for 900s`, `coingecko: CoinGecko 429 — benched for …`,
  `<source>: could not verify <url>` — and `sweepLogos` did `report.undecided++`
  and dropped every one of them. *"Never discard the reason"* is the first rule
  in this file about upstreams, and it had been broken since the counter was
  written: **"DexScreener is refusing this server" sends an operator to their
  egress and "CoinGecko 429" sends them to a pace**, and the line rendered both
  as the same number. `whyUnreachable` is keyed by SOURCE and keeps the FIRST
  message — the rest carry a per-row url and a per-second countdown, so a tally
  of the raw strings is another wall rather than an answer — bounded at 90
  characters, and the clause names at most three (`+N more` past that).
- ⚠️ **AND AN ALL-UNDECIDED PASS IS THE SAME OBSERVATION AS THE ONE BEFORE
  IT.** The board rebuilds on a 60s cache and every rebuild fires a sweep, so
  on a box whose sources are refusing it that line is identical, for ever —
  which is the wall in the screenshot and is what buries the one line that
  says a stablecoin was filtered or a logo was pinned. Reported on the
  TRANSITION only: `upstreams.js`'s rule, borrowed for the sixth time in this
  repo, on the one state that repeats with nothing new in it.
- **Anything the sweep actually DID always prints, and re-arms the memo.** A
  logo found, a miss DECIDED, a row written, a row pinned — a sweep working
  through a queue at 8 rows a rebuild is progress, not silence, and collapsing
  it would hide the recovery. So a quiet stretch can only ever mean *the
  sources are still refusing us*, which is the one thing an operator can act
  on.
- **The KEY is the set of upstreams, so losing a second source says so.**
  DexScreener alone going quiet and DexScreener plus CoinGecko are different
  facts; the empty key is a real state too (undecided with no reason given),
  not an absent one.
- ⚠️ **AND THE SILENCE IS ANNOUNCED** — `(repeats are silent until this
  changes)`. A wall that stops reads as the sweep having stopped, which is
  precisely the state this line exists to report, and this file has already
  paid twice for a stuck symptom rendering as no symptom.
- ⚠️ **`_resetLogoMemory()` clears the memo**, because it is module state and
  the suite shares one process: a test that leaves it behind silences the next
  test's line, which looks exactly like the logging being broken. Stated,
  never inherited — the scar the auto-trend panel helper and the rotation
  stamps already carry.
- ⚠️ **`report.undecided > 0` was DELIBERATELY LEFT OUT of the key.** Every
  `looked++` lands in exactly one of found/missing/undecided, so a pass that
  did nothing with `looked > 0` is undecided by arithmetic — a mutation run
  confirmed the term changed no outcome, and a line that claims cover it does
  not provide is the `unanswered`-flag scar one module over. The comment says
  which change would make it load-bearing again.

⚠️ **What this does NOT do is make the artwork resolve.** Whether DexScreener,
CoinGecko or GeckoTerminal answers THIS box is a property of its egress and of
those services' limits today — the rule `raid:check`, `launchpads:check` and
`fonts:check` all state. What changed is that the log now says which of them is
refusing us and why, instead of printing a count five hundred times.

```bash
pm2 logs dexvra --lines 300 --nostream | grep -F '[logos]'   # …— could not ask: dexscreener (403 …)
npm test                                                      # logoFill — 27 tests, no network
```

Nine guarantees are MUTATION-TESTED rather than argued: the reason never
recorded, the line dropping the upstream, the reason unbounded, every repeat
printed, a productive pass collapsible, the key ignoring which upstream, the
memo leaking between tests, a decided miss counting as doing nothing, and the
silence going unannounced. Each fails between one and three tests.

**Config a fix depends on:** nothing.

## "perbaiki tampilan chartnya di mobile" — two rows of timeframe buttons, one of them dead

The same screenshot, one panel down: our chart header — `$HACHIKO`, `LIN LOG`,
`5m 15m 1h 4h 1d` — sitting **directly above DexScreener's own** `1s 1m 5m 15m
1h 4h D` toolbar inside the embed, on a 390px phone, over a chart squeezed into
what was left of a 360px panel with the last time label clipped mid-digit.

**Every control in our header is INERT while the embed is on screen.** LIN/LOG,
the timeframes and ⤢ Auto all drive the native renderer; over a third-party
iframe they do nothing at all. "A row the engine ignores" is this repo's own
name for it, and it costs the most exactly where there is least room.

- **Dropped, never disabled.** A greyed-out row still costs the height, and the
  reader is looking at a chart that already has controls.
- **ONE owner.** `embedSrc = status === "error" ? embedUrl : null` and
  `showEmbed = embedSrc !== null` — the class, the controls and the iframe's
  `src` all read the same value, so they cannot disagree, and TypeScript
  narrows the `src` rather than needing a second condition.
- **The panel grows, and only for the embed.** Their widget stacks a toolbar,
  the TradingView plot, a volume pane, a time axis and a "Tracked by
  DEXSCREENER" strip; ours draws one compact axis. `:has(.ck--embed)` rather
  than a prop threaded into the page — whether the embed is on screen is state
  inside `CandleChart`, and a second copy of that decision in the page component
  is how the two come to disagree. ⚠️ A browser without `:has()` keeps today's
  height, which is the behaviour being replaced: it degrades to the bug, never
  past it.
- **The embed is still never the DEFAULT.** That ban stands and is pinned in
  two files; only the alternative to an apology moved.

Measured in a real browser at 390×844, both fallback states forced:

| | before | after |
| --- | --- | --- |
| chart panel | 360px | **480px** |
| our header | 46px, two rows, controls inert | **31px**, ticker only |
| the embed itself | ~290px | **447px** |

⚠️ **Two existing guards broke, and they were the ones that were wrong.** Both
`chartRoute.test.ts` and `dsChart.test.ts` pinned the LITERAL
`status === "error" && embedUrl ? (` rather than the property, so they went red
over code that keeps the rule perfectly. That is this file's own recurring
defect (the four-way pool-TTL guard, the `{ ok: true,` build stamp); both assert
the property now, and both still fail when the embed is made unconditional.

## "perbaiki transaksinya, ambil aja semua dari dexscreener kalo gecko terminal delay"

The third panel: `Couldn't read recent trades just now — live data is busy`,
over a token doing **1.3K transactions a day**.

⚠️ **THE HONEST HALF FIRST: A TRADE LIST HAS EXACTLY ONE FREE SOURCE.**
GeckoTerminal publishes `/pools/{pool}/trades`. DexScreener publishes **no**
per-trade endpoint on any documented host — `latest/dex/tokens`,
`latest/dex/pairs`, `token-pairs/v1`, `search`, none of them returns individual
fills — and its own site reads them off `io.dexscreener.com`, which answers this
box **403**. A second source for the ROWS does not exist to be wired, and
shipping a guess that cannot fire reads exactly like one that never helps.

**What DexScreener DOES publish is already in hand.** `t.txns` and `t.vol` ride
the board payload the panel is handed, so the fallback costs **not one
request**: where the table can only apologise, it now also states the pool's own
activity.

```
Couldn't read recent trades just now — live data is busy…
1,247 buys · 812 sells · $34.2K volume
IN THE LAST 24H · VIA DEXSCREENER
```

- ⚠️ **ONLY FROM A LIVE ROW.** `figureReading` is the one owner of "is this
  figure a measurement or a captured-at-listing default", and a seed row's zeros
  are numbers nobody took. Rendering those as activity is the fabricated reading
  this repo refuses everywhere else, one panel over.
- ⚠️ **GROUPED, NEVER ABBREVIATED.** `fmtNum` gives `1.2K`, which is right for a
  market cap and wrong for a COUNT: 1,247 and 1,299 both render `1.2K`, and how
  many trades there were is the number the reader came for. The trade bot's
  `qty()` carries this rule for the same reason.
- **Zero trades in a day is a READING** and a real answer — but it is the same
  answer the empty table already gives, so it adds nothing and is not printed.

**And the panel was asking a busy upstream HARDER, not less.** `/api/trades` is
one of the app's biggest GT consumers — every open token page polls it every
~12s — against a budget of a handful of requests a minute for the whole box,
shared with the board, the pools and the candles. So the reported state is one
in which this panel alone can spend five requests a minute proving the same
refusal, per open tab, for ever. That is the CoinGecko sweep's defect and
`dsChart`'s 403 retry, on a third caller.

- **A failure backs off** (doubling to `MAX_POLL_MS`, 96s) **and a success
  resets it** — one blip must not slow the panel for the rest of the session.
- **A hidden tab is not polled at all.** Nobody is reading it, and the first
  poll after it comes forward is immediate.
- Neither costs a visitor anything: the panel keeps the rows it has.

```bash
npm test    # tokenTrades (9) — the panel guards, comment-stripped
```

Mutation-tested: the back-off never reaching the scheduler, a seed row rendering
activity, the inert chart controls returning, and the phone panel staying sized
for our own chart each fail exactly one test.

**Config a fix depends on:** nothing — but ⚠️ **`GECKOTERMINAL_API_KEY` in the
repo-root `.env` is still the only thing that raises the ceiling rather than
dividing it**, and the trade list is the one thing on this page with no second
source at all. This makes the minute go further; it does not add a source that
does not exist.

### "bagaimana agar masalah ini tidak terjadi lgi" — all three were found in a screenshot

Asked over a clean deploy (`✓ serving 17a95ee`, four processes online), so the
question is not the deploy. It is that **every one of those three defects was
detected by a person opening the channel or the token page and counting.**
Nothing in the bot said *"that post went out with no price"*; nothing in the
site said *"the panel a busy GeckoTerminal produces has two toolbars on it"*.
That is the same shape as the six-round trending saga and the three-round blank
percentage, and the answer is the one this file keeps arriving at: **watch the
PROMISE, because the causes keep changing.**

Two holes, and each is somebody's own rule broken one surface over.

#### 1. A paid post that publishes a hole now says so

The promise an order buys is that its announcement carries its real market
figures. `bot/src/postFigures.js` watches exactly that, at the moment the post
is built.

- **It measures with the RENDERER's own predicate.** `channels/format.js` prints
  `TBA` for `!(p > 0)`, so that is the test — a watch with its own idea of
  "missing" eventually disagrees with the post it is watching, which is
  `fonts:check`'s nine green ticks over a banner publishing boxes.
- ⚠️ **THE THREE SILENCES GET THREE SENTENCES.** `fetchMarket` collapses "both
  indexers refused this box" and "this token has no pool" into one `null`, and
  the `MARKET_BUDGET_MS` bound above it collapses "the queue was long" into the
  same one again — so the reason is captured AT THE READ (`readPostMarket`) or
  it cannot be recovered later. *The read timed out* is ours; *an indexer
  answered and publishes no price* is the token's; *neither returned anything*
  is the one the box has to settle, and the alert names `market:check` rather
  than leaving the operator to guess.
- ⚠️ **A MISSING LIQUIDITY ALONE IS NOT AN ALERT, and that is a judgement.** A
  token on a bonding curve has no pool depth — `launchpads.js` returns
  `liquidityUsd: null` deliberately, because a 0 there reads as a rug — so
  paging on it would be permanently red on every pre-migration listing, which is
  the state `chart:preview` sat in for weeks. It is still NAMED whenever price
  or cap fires: three holes and one hole are different pictures.
- **A healthy post pages nobody**, and the alert is never de-duplicated: each of
  these is a separate paying customer, and collapsing two would hide one.
- **One read, one alert, both siblings.** The listing's and the trending slot's
  market reads were two copies of one thing, which is how a rule gets fixed on
  one of them; they are `readPostMarket` now, and the watch runs on both.
- ⚠️ **THE POST IS ALREADY OUT WHEN THIS RUNS**, so a throw here would turn a
  degraded announcement into a FAILED ORDER — the free-listing report's rule.
  The name and ticker are whatever the buyer typed and this is sent with
  `parse_mode: HTML`, where one stray `<` makes Telegram reject the whole
  message with a 400 that is never retried: an alert that vanishes is the
  silence being fixed.

#### 2. ⚠️ `chart:preview` HAD NO PROBE FOR THE PANEL THAT WAS REPORTED — and the fix for it turned the whole script red

The mobile defect lived on the DexScreener embed, which is what a reader gets
whenever neither source can draw. `chart:preview` renders eleven states and that
was not one of them, so the surface most likely to be seen on a bad minute was
the only one nobody had looked at. *"The list is the guard"* — a renderer nobody
probes is exactly how a banner shipped boxes for six days.

⚠️ **And it was worse than a gap.** The `error` state used to render an apology
and the script waited for `.ck-empty`; the moment that state began rendering the
embed instead, the wait THREW — so the harness caught it, printed one
`FAIL harness` line, and **never ran the native-fallback chip, the unlisted page
or the entire phone context.** 31 checks of 50, silenced by one changed panel,
on the very run that would have shown the defect. That is the stale-assertion
failure the script's own header is written about, reintroduced by me in the
commit that fixed the panel.

- **A state section FAILS, it does not ABORT.** `section()` wraps each one; a
  throw is one red line and the run continues. Only the state sections get it —
  the interactive sequence above them shares one page and one accumulated chart
  state, where a throw part-way through a drag genuinely does invalidate what
  follows.
- **The embed is probed on a desktop AND on a phone**, and the phone context is
  no longer pinned to the healthy chart (`stub(m, () => "ok")` meant the one
  viewport that mattered could only ever be shown the state that was fine).
- **Measured against the native panel, never a magic number**, so a design
  change moves both and the rule survives it. The reported picture is now a
  printed line: `360px → 480px`, `447px of 480px`.
- **The iframe is STUBBED**, so this measures OUR panel — is the embed there,
  are the inert controls gone, is there room for it — and says nothing about
  whether their widget draws. Their chart is not ours to test, and the script's
  contract is that it runs on a box with no egress.
- ⚠️ **Two `npm test` guards pinned a SPELLING and went red over code that keeps
  their rule** — `bounded(market.fetchMarket` counted twice, and
  `fetchMarket` call sites counted twice — the moment the two identical reads
  became one owner. Both assert the property now: no fulfilment market read is
  unbounded, every one carries `POST_MARKET`, and both posts reach the market
  through the one bounded read.

```bash
cd bot && node scripts/run-tests.js test/postFigures.test.js test/postMarket.test.js test/fulfilBounded.test.js
npm run build && npm start &
npm run chart:preview     # 50 checks — the embed, on a desktop and on a phone
```

Eleven guarantees are MUTATION-TESTED rather than argued: liquidity paging on
its own, the read reason discarded, the alert unescaped, a rendered 0 counting
as a figure, the trending sibling losing the watch, the market read unbounded,
trending bypassing the one owner, the read going back to GT-first, the embed
selector removed, the phone pinned to the healthy chart, and a section aborting
the run again. Each fails between one and two tests.

**Config a fix depends on:** nothing. The alert goes to the ops channel the
health monitor already uses; unset, it is a pm2 line like everything else.

## "mengapa bot tidak bisa merespon lagi" — ONE tap made the whole bot deaf

Reported 2026-09-11 with a screenshot: an Xpress Listing pay card, the buyer's
tap on **✅ I've Paid — Confirm**, the bot's own *"🌀 Verifying your payment… —
on-chain confirmation usually takes 30–60 seconds. We'll confirm here
automatically"* at 18:38 — and then **three `/start` messages that were never
answered at all.** Not a slow reply. No reply.

**Nothing had crashed, and nothing was down.** `confirmPayHandler` awaited
`verify.verifyPayment`, whose poll runs for `PAYMENT_TIMEOUT_MS` — **five
minutes** by default. And Telegraf's long-polling loop is, verbatim
(`telegraf@4.16.3`, `lib/core/network/polling.js`):

```js
for await (const updates of this)
  await Promise.all(updates.map(handleUpdate));
```

⚠️ **IT DOES NOT ASK TELEGRAM FOR THE NEXT BATCH OF UPDATES UNTIL EVERY HANDLER
IN THE CURRENT ONE HAS SETTLED.** So a handler that waits is not slow for the
person who tapped — **it is the whole bot going deaf, for every user in every
chat**, and those three `/start` messages were sitting unfetched on Telegram's
server the entire time. At 120s `handlerTimeout` (p-timeout) rejected, so the
buyer got *"something went wrong"* instead of a verdict; it does not CANCEL the
promise, so `pollBalance`'s `setInterval` kept hitting the RPC for three minutes
more. Tap Confirm a second early and the bot is unreachable for two minutes.

- **The tap gets ONE balance read, bounded by `PAYMENT_CONFIRM_MS` (5s).** The
  common case is that the buyer tapped BECAUSE they had already paid, and one
  read answers that — unchanged from today, including clearing the spent pay card
  from the session inside the handler where the middleware chain still owns it.
- **Everything past it is `watchPayment()`, detached.** This is the atrun lesson
  and it was **already written in this very function** for the FULFILMENT half
  (*"a callback answer is the one channel with a DEADLINE, so it carries the
  ACKNOWLEDGEMENT and the RESULT arrives as a message"*). The VERIFICATION half,
  thirty lines above it in the same `try`, still awaited. **A lesson applied to
  one branch of one function is a lesson half-learnt** — this file already says
  so about the snipe panel's refusal path and about `reset()` missing the guard
  its sibling got.
- **The copy was already right.** `checking_payment` has always promised *"We'll
  confirm here automatically"* — true of the intent and false of the
  implementation, because the waiting happened where it froze the bot. It is now
  what actually runs, so no new message was needed on the miss path.
- ⚠️ **THE POLL WAS ALSO REDUNDANT.** `services/recovery.js` already re-checks
  every pending order every **10 minutes for a day** — it exists in its own words
  for *"anyone who simply pays after the 5-minute window closes, which is
  common"*. So the handler was freezing the bot to do a job a timer already did
  safely. The watcher only decides how fast the buyer hears; it is not what
  decides whether they are served.
- ⚠️ **THE t=0 READ IS BOUNDED TOO.** `wallets.getBalance` is an RPC call with no
  deadline of its own, so on a public node that stops answering an unbounded read
  on this path is the same outage by a different route. `balanceNow` reports a
  read it could not finish as `null`, never as a zero balance: "we could not ask"
  and "the money is not there" are different facts, and only the second is about
  the buyer.
- ⚠️ **`ctx.session._verifying` CANNOT GUARD THIS ANY MORE** — it is cleared when
  the handler returns, which is now BEFORE verification finishes, so a second tap
  would start a second watcher. A module-level `verifying` Set does it, held
  until the fulfilment it triggers has finished too. Same guard, same reason, as
  the `fulfilling` Set six lines down.
- ⚠️ **AND THE WATCHER CANNOT CLEAR THE PAY CARD.** Telegraf writes the session
  back when the middleware chain exhausts, so a buyer whose late payment the
  watcher credited still holds a live card — and tapping it would re-read a
  wallet that has since been **SWEPT** and answer *"payment not detected"* about
  an order already paid for and delivered. The durable order status is checked
  first (`payment_already_credited`); the order file knows better than the
  session does.
- ⚠️ **`fulfilDetached.test.js` COULD NEVER HAVE CAUGHT THIS.** It proves the
  same rule for the fulfilment half — and every order it drives is
  `adminFree: true`, which is the one kind that **skips `verifyPayment`
  entirely**. The paid path had no test at all, which is why a five-minute await
  sat on the money path behind a green suite.

### So it cannot go deaf unnoticed again

⚠️ **THE DETECTOR WAS THERE AND COULD NOT DETECT.** `bot.js` has had a
slow-handler warning since the last round of "bot lelet merespon" — and it logged
from the `finally`, so it said **nothing at all** until the handler finished, and
the one shape worth catching is precisely the one that does not. Through this
entire outage pm2 carried not one line about it. A stuck symptom reading as no
symptom is the state that looks most like a healthy one, and this file has now
paid for that three times (`lastFeedOkAt`, `lastCheckedAt`, here).

- **It fires on a TIMER, while the handler is still stuck**, at
  `SLOW_HANDLER_MS` (8s), and a stall that ended is SIZED on the way out — or
  nobody can tell how long the bot was unreachable.
- **The wording is the diagnosis.** "one tap is slow" sends the reader to that
  handler; the truth is that nobody is being answered at all, so the line says
  so: *"Telegraf fetches no further updates until it returns, so the bot is not
  answering ANY chat right now."*
- **`timingMiddleware` is exported and registered by reference**, for the reason
  `onHandlerError` is: `applyMiddleware` boots every background service and its
  timers, so a test that called it would never let the process exit.

⚠️ **AND THE EXISTING GUARD FOR IT PINNED THE DEFECT.** `slowTap.test.js`
asserted the literal `[ui] slow ${ctx.updateType} tap=` and
`if (ms >= SLOW_HANDLER_MS)` — i.e. the `finally` computation itself — so it
would have passed on the revision that logged nothing through a two-minute
outage, and it went RED over the fix. That is this repo's own recurring defect
(the four-way pool-TTL guard, the `{ ok: true,` build stamp): **a guard that
pins a SPELLING fails on the code that keeps its rule and passes on the code
that breaks it.** It asserts the rules now — a threshold, the tap named, the
timer armed before the `await` and cleared after — and the BEHAVIOUR moved to
`pollingStall.test.js`, which drives the middleware, because a source scan
cannot tell a warning that fires from one that is merely written down.

⚠️ **One unrelated test was flaky and the heavier suite found it.**
`listingBlocked.test.js`'s two mid-scan tests waited `one setImmediate` and then
assumed the scan had reached its first lookup — and therefore taken its ledger
snapshot. That is not a synchronisation point: under load (`node --test` runs
files in parallel) the scan is still in discovery, the operator's 🧹 Clear
history lands BEFORE the snapshot, and the assertion inverts. Green on a quiet
machine, red on a full one, which is exactly what it did. The stub signals when
it is genuinely mid-flight. Verified not to have weakened it: the same mutation
survives both the old and the new version.

| layer | stops |
| --- | --- |
| the tap gets one bounded read | a Confirm tap parking the polling loop |
| `watchPayment` + `recovery.js` | a detached verify meaning a dropped order |
| `confirmDetached.test.js` drives the real handler | the await creeping back onto the tap |
| the in-flight stall warning | the next one of these being invisible for two minutes |

```bash
cd bot && node scripts/run-tests.js test/confirmDetached.test.js test/pollingStall.test.js   # 11 tests, no network
pm2 logs dexvra-bot --lines 200 --nostream | grep -F '[ui]'                                  # was the loop ever stalled
```

Seven guarantees are MUTATION-TESTED rather than argued: the handler awaiting the
full poll again, the watcher never started, the first read unbounded, the durable
already-credited guard dropped, the in-flight guard dropped, the stall warning
back in the `finally`, and its timer never cleared. Each fails between one and
three tests.

**Config a fix depends on:** nothing — `PAYMENT_CONFIRM_MS` (1–15s, default 5s)
bounds the tap and `PAYMENT_TIMEOUT_MS` still bounds the watch. ⚠️ This is a
`bot/` change, so the deploy is the **ecosystem restart**, not `pm2 restart
dexvra` — see "Two bot processes, one config".

## "bisa bayar pake ethereum eth dan eth robinhood" — a choice of RAIL, not of price

Asked after establishing that a Robinhood listing bills in **ETH on Robinhood
Chain** (`native: "ETH"`, no `payVia`, its own RPC), and the request was to make
ETH payable on **every** package: listing, trending, Mass DM, banner.

**Most of it already existed and was unreachable.** Every package here is priced
by CURRENCY, never by chain — `price: { BNB: 1.5, SOL: 5, ETH: 0.26, TON: 250,
TRX: 5000 }` — and `tierPrice(key, chain)` resolves the currency FROM the chain.
So an ETH price has been sitting in every table since the catalogue was written,
and the only thing standing between a buyer and it was that the pay chain was
locked to the chain their TOKEN lives on:

```js
chain: payChainOf(f.chain), native: payNativeOf(f.chain)   // handlers/listing.js
```

⚠️ **THE TWO ETH NETWORKS COST THE SAME, AND THAT IS NOT A COINCIDENCE TO
RESTATE ANYWHERE.** `payNativeOf("ethereum") === "ETH" === payNativeOf("robinhood")`,
so both read ONE row of ONE table. This adds a choice of rail; a second price
for the same package would be a feature nobody asked for and two numbers to keep
in sync with `src/lib/packages.ts`.

- **`config/payOptions.js` is the one owner** of which networks may settle an
  order: the order's own chain FIRST (an existing buyer's flow must not move
  under them, and a purchase in SOL is still a purchase), then ETH on Ethereum
  and ETH on Robinhood Chain. Deduped, so a token already on an ETH chain is not
  offered twice.
- ⚠️ **A NETWORK IS OFFERED ONLY IF THE PACKAGE HAS A PRICE IN ITS CURRENCY**,
  and trending is why that is a rule rather than an assumption: the durations
  differ per currency — the ETH table has no 3H row and the BNB table no 16H —
  so a network offered for a duration it cannot price would arm an order for
  `undefined`. `trendingPrices(duration, discountPct)` builds the map and skips
  what it cannot price; the renewal discount is applied to every currency alike,
  or a slot that was 20% off in BNB comes back at full price in ETH.
- **`prices` is what turns the choice on, and a caller that omits it behaves
  exactly as it did before.** That is the whole backward-compatibility story:
  `payOptionsFor` returns `[]` with no table, and `startPayment` arms the order
  as supplied.
- ⚠️ **THE AMOUNT COMES FROM THE TABLE, NEVER FROM THE TAP.** `paynet_<chain>`
  is callback data a user can craft, so the option is re-derived server-side and
  the amount re-read from the package's own map. Carrying `humanAmount` through
  the pick would let a tap decide what an order costs.
- ⚠️ **THE CRAFTED-CHAIN REFUSAL IS ON BOTH PATHS, AND EACH HAS ITS OWN
  OBSERVABLE PROPERTY** — because a mutation run said neither was individually
  killable while they shared one. The ARMING guard is what makes a crafted chain
  unspendable and covers every caller that pins `payChain` (the banner flow
  does, from its own callback data); the PICKER guard refuses *before the stash
  is spent*, which is what makes a stray tap on an older picker card cost the
  buyer nothing. Two guards, two reasons, two tests.
- ⚠️ **AND THE payVia CHECK WAS DEAD, so it is a comment now.** `payChainOf()`
  has already resolved Sui to BSC by the time anything is added, and both ETH
  networks are payable by definition — the mutation run proved no caller can
  reach `add()` with an unresolved id. A line that claims cover it does not
  provide is worse than the comment explaining what actually keeps it true.
- **The banner flow needed one word.** It has had a USD-quoted network picker
  since it was written (`PAY_CHAINS`) and Robinhood was simply absent from the
  list; its quoted amount is still armed as the STRING it quoted, byte-identical
  to before, and the map it now passes exists only so the card can name the
  network.

### ⚠️ Two ETH networks share one `0x` address shape, so the card must name one

The pay card has never named the network — `"👜 Send {native} to this wallet"`
and nothing else — and the only thing that made that survivable was that a buyer
had no choice to get wrong. With Ethereum and Robinhood Chain both offering
"Send ETH" to a `0x…`, an exchange withdrawal on mainnet against a Robinhood
order is credited by nobody: `verifyPayment` reads that chain's RPC alone,
`recovery.js` re-checks the same one for a day, and the sweep only ever touches
orders marked `paid` — so the funds sit in a temp wallet with nothing anywhere
saying why.

- **`{network}` is on the template AND enforced at the call site.** Same reason
  the address and the amount are — *"enforced here rather than trusted to the
  template's backticks, which a re-saved card loses"*. `data/templates.json`
  wins over the code default for ever, so an operator who edited `pay_card`
  before this shipped renders no network at all, on the one line whose absence
  costs a buyer their money. `ensureNetwork()` appends it when the render does
  not already carry it.
- **Appended at the END, which is what makes it safe.** Telegram entity offsets
  are UTF-16 code units counted from the start, so nothing already in the
  payload moves; the `html` shape is handled separately because entities do not
  apply to it.
- ⚠️ **AND THE WIRING WAS UNPROVED UNTIL A MUTATION RUN SAID SO.** The shipped
  template already carries `{network}`, so `ensureNetwork` is a no-op on it and
  deleting the call from `startPayment` left every assertion green — a unit test
  of the rule beside a call that need not exist. The test drives the real
  handler over a stubbed operator-saved card instead.
- ⚠️ **`Robinhood` ALONE IS AMBIGUOUS on the one line a buyer acts on**: it is
  also a broker most of them have an account with, and sending mainnet ETH from
  an exchange is the exact mistake this label exists to prevent. `Robinhood
  Chain` here; the chain's own label is right everywhere else in the bot.

### The flows had to be told, and a scan is what says they were

⚠️ **THE FIRST CUT OF THE TESTS BUILT ITS ORDERS BY HAND**, so it proved the
machinery and said nothing about whether any real flow used it — deleting
`prices:` from the listing flow left all of them green, and the buyer would
simply never be offered ETH again, silently, with a full suite behind it. That
is the `curveBuyPath` scar: *a wiring that does nothing refuses beautifully.*
A comment-stripped scan walks every `startPayment(ctx, { … })` literal in
`src/handlers/` and fails on any that omits its price table — with a vacuity
assertion, because a brace walker that mis-indexes matches zero call sites and
passes for the wrong reason. `pay.js` is excluded and says why: it OWNS
`startPayment` and re-enters it with the pick already spread in.

```bash
cd bot && node scripts/run-tests.js test/payNetwork.test.js   # 20 tests, no network
```

Sixteen guarantees are MUTATION-TESTED rather than argued: the amount taken from
the tap, each crafted-chain guard alone and both together, the picker never
asking, the stash never spent, the ETH networks dropped, a currency with no
price offered anyway, the buyer's own chain no longer first, the dedupe dropped,
the trending duration filter dropped, the `ensureNetwork` wiring removed, the
bold entity landing off the words, each of the four flows dropping its price
table, and the scan matching nothing. Each fails between one and ten tests.

**Config a fix depends on:** nothing — every package already carried its ETH
price, and both ETH networks are payable chains with adapters and a treasury
(`TREASURY_EVM` covers ethereum/bsc/base/robinhood alike). ⚠️ This is a `bot/`
change only, so the deploy is the **ecosystem restart** and there is no web
rebuild. ⚠️ And an operator who has ever edited the **Payment card** template in
@dexvraadminbot should hit **♻️ Reset default** on it to pick up the `{network}`
line — the enforced fallback covers them either way, but the template's own line
reads better than an appended one.

## "Di bawahnya ada fitur add broadcast dengan fee tambahan"

A project buying a listing can now attach a **Mass DM** to the same order
instead of buying it separately: `➕ Add Broadcast to all users (+2 SOL)` sits
on the **PAY CARD, beside Confirm Payment** — "harusnya ada fitur add broadcast
setelah dpt address kaya fourtisbot", which is also where the bot this was
compared against puts it. Compose, and the fee joins the amount already on the
card.

⚠️ **WHICH MAKES THE DEPOSIT ADDRESS THE WHOLE DESIGN CONSTRAINT.**
`generateWallet()` mints a fresh keypair on every call, so re-arming the order
to add the fee would hand the buyer a SECOND address — and a buyer who had
already sent to the first would have paid into a wallet this order no longer
verifies against. The order is **edited in place**: same address, higher total,
`amountSmallest` re-derived, and `verifyPayment` compares the BALANCE there
against the new amount — so whatever was already sent still counts toward it. A
test mints a different address on any re-arm and fails if the card's address
moves.

- **It was on the review card first, and was MOVED, not duplicated.** Two
  surfaces for one add-on is the `/withdraw` vs `/withdrawall` lesson — "a
  second way in that does not do a second thing is a question the user has to
  answer before they can start".
- ⚠️ **The fee is read from `order.native`, not from the token's chain.** By the
  pay card a Robinhood buyer may have PICKED a rail (ETH on Robinhood Chain or
  ETH on Ethereum), so the only currency that can be charged is the one this
  order actually settles in. `addonPriceForNative()` is that question;
  `addonPrice(tokenChain)` is the wrapper for anything asking earlier.
- ⚠️ **The compose step is routed ABOVE every flow dispatch**, and above
  `textRouter`'s `!s.type` early return. The pay card is shared by listing,
  trending, banner and Mass DM, so an armed order has no `session.type` of its
  own — caught inside any one flow it would work from that flow only. A test
  drives the router with no type set at all.
- **An admin test order stays FREE.** Re-deriving `amountSmallest` from the new
  total would put a real price behind a card that says "no payment needed", and
  `confirmPayHandler` would then verify against it.

**Nothing new sends anything.** The message goes through the EXISTING paid Mass
DM machinery — composed by the buyer, queued `pending_review` by fulfilment,
approved by an admin with `/reviewmassdm`, delivered by the main bot's sender.
`queueBroadcast()` is the one door both products go through; `fulfillMassDm()`
is the standalone product wrapped around it. Two enqueues would be two ideas of
what a paid broadcast is, and the first thing to drift would be whether an admin
ever sees it.

- **The fee is `MASS_DM_PRICE` ITSELF, not a second table.** The ask was "ikuti
  price mass dm", so the add-on charges exactly what the standalone product
  charges, read from the same constant — which is already env-overridable
  (`MASS_DM_PRICE_SOL` / `_BNB` / `_ETH`). A private copy would be a second price
  for one product, and the day an operator changed one of them the buyer would be
  quoted one number and charged the other. A test scans for it, because "reads
  the same constant" is a property no value comparison can prove once the two
  numbers happen to coincide.
- ⚠️ **THE 50% LAUNCH DISCOUNT IS WITHDRAWN** — "skrg tidak ada diskon skrg
  harus 100%". `MASS_DM_PRICE` ships at the full **2 SOL / 0.3 BNB / 0.1 ETH**
  (it was 1 / 0.15 / 0.05). One table, two products, so this DOUBLES the
  standalone `/massdm` price as well as the add-on fee — deliberately, and the
  same shape as the trending floors shipping on. A test pins the shipped default
  by reading the SOURCE rather than the resolved constant, because an operator's
  `.env` beats the code and asserting the resolved value would go red on their
  box for a reason that has nothing to do with the code.
- ⚠️ **A test pinned to a PRICE expires the moment the price moves**, silently.
  Withdrawing the discount turned eight assertions red across two files, every
  one of them retyping a number whose SUBJECT was something else — the chain
  mapping, the two ETH rails, the fee reaching the button. They read
  `MASS_DM_PRICE` now, and the price itself is pinned in exactly two places: the
  shipped-default scan and the one "add it up by hand" test.
- **It is billed in the ORDER'S OWN coin**, one order, one amount, one address,
  one network — the rule the whole payment path now enforces. That is also why
  availability is computed rather than assumed: `MASS_DM_PRICE` prices SOL, BNB
  and ETH only, so ⚠️ **a Tron or TON listing is offered NO button at all**
  rather than a disabled one. A button whose only outcome is a refusal is the
  "row the engine ignores" this file already names.
- ⚠️ **A CURRENCY THE ADD-ON CANNOT PRICE IS DROPPED FROM THE RAILS, never
  carried at its bare base price.** `payOptionsFor()` turns the price table into
  the networks an order may settle on, so leaving TRX in it would sell a Tron
  rail that charges for the listing and throws the broadcast in for free.
- ⚠️ **`1.15 + 0.15` IS `1.2999999999999998`.** Both operands are ordinary
  decimal literals out of `config/packages.js`, so a Platinum listing on BSC with
  the add-on put `Amount: 1.2999999999999998 BNB` on the one screen that takes
  the money. Measured before the fix existed, not feared — and note that
  `0.06 + 0.05` comes out clean, which is exactly the shape that survives a
  casual test. `addAmount()` lives beside `toSmallest()` because that is the only
  other place in the bot where a money amount is COMPUTED rather than read.
- ⚠️ **The composed text is stored RAW, never the trimmed copy.** Telegram entity
  offsets are counted from the start of the message, so trimming one leading
  space shifts every bold run and every custom emoji a character left. `/cancel`
  is matched on the trimmed copy, which is the only thing trimming is safe for.
- **The fee is printed ON the button**, not in the card text: `pay_card` is an
  admin-editable template, and putting it there would show no price at all to
  every operator who has ever saved that template until they hit ♻️ Reset
  default.
- **The tap is re-checked, not trusted to the card that offered it.** A pay card
  left open in the chat outlives a restart that switched `MASS_DM_ENABLED` off
  under it, or an add-on already attached from another tap — and the button is
  GONE once one is attached, so nothing can be charged for twice.
- ⚠️ **The add-on is queued LAST and can never fail the listing.** By then the
  row is live, the channel posts are out and the funds were swept before
  fulfilment even started — so a queue that will not take the message is a thing
  to TELL the buyer about, never a reason to report a delivered listing as
  failed. `queueBroadcast` returns `{ok, ref, why}` rather than throwing, and the
  two callers owe the buyer different sentences.
- **`listing.js` imports the pay MODULE, not a destructured `startPayment`.** A
  destructured import is bound at require time, so no test could pin what this
  flow hands the payment path — the total, the coin, the attached message. The
  rule `autoTrend.js` and `trendingPoster.js` already state at their own
  requires.

⚠️ **AND THE FIRST MUTATION RUN LEFT A SURVIVOR, on the worst path of the lot.**
The call site was pinned by a SOURCE SCAN asserting `p.broadcast` and
`queueBroadcast(` appear in `fulfillListing` — and `if (false) {` leaves every
one of those strings exactly where it was, so a buyer could be charged for a
broadcast that was never queued with the suite green. **A guard a mutation run
cannot kill is not a guard.** `fulfillListing` is DRIVEN now, with the site API,
the channel posts, the banner build and the tweet stubbed, and the assertion is
that a job really reaches the queue — plus its negative, that a listing without
an add-on queues nothing. The curveBuyPath scar, one package over.

Twelve guarantees are MUTATION-TESTED rather than argued: a re-arm minting a
second address, a stale `amountSmallest`, the fee never added, the button on
every currency, the button surviving attachment, the tap not re-checked,
cancelling attaching anyway, the composed text trimmed, the compose step routed
below the flow dispatch, an unpriceable currency falling back to BNB, a paid
broadcast sent without review, and fulfilment never queueing it. Each fails
between one and two tests.

⚠️ **And one of them survived its first run**: the raw-text guard drove
`broadcastCapture` directly, so it never crossed the ROUTER where the trim
happens — and the router test's own message had no leading whitespace, so
trimming it changed nothing. A test that cannot reach the defect is a test about
nothing; it carries two leading spaces and a bold run over them now.

```bash
cd bot && node scripts/run-tests.js test/listingBroadcast.test.js   # 28 tests, no network
```

**Config a fix depends on:** nothing to ADD — but ⚠️ **a box that already set
`MASS_DM_PRICE_SOL` / `_BNB` / `_ETH` in `bot/.env` keeps its own values and
stays on the old discount after this deploys, silently.** That is the "config a
fix depends on" rule landing on a price: `grep MASS_DM_PRICE /opt/dexvra/bot/.env`
is the check, and unsetting those lines is what picks the full price up.
`MASS_DM_ENABLED=0` removes the button everywhere. ⚠️ Scoped to the LISTING
flow deliberately: trending and banner orders do not offer it, and adding them
is the same three lines in their own `goPay` if that is wanted.

### "no need approve … kalo listing ya template listing itu"

Reported with a screenshot of our own compose prompt — *"Your message is DM'd to
every Dexvra bot user, **after an admin approves it**. Send it now — text, or a
photo with a caption"* — beside fourtis's card, where the same tap simply
answers `✅ Broadcast added (+2 SOL) — tap to remove` and the amount goes from
`1.0` to `3.0 SOL`. **No compose step, no review, and the thing that goes out is
the listing.** Three changes, and the first is the one that deletes the other
two's problems.

- **ONE TAP, and there is nothing to write.** The compose step asked the buyer
  for a message the bot already had: *the listing card it is about to post to
  the channel*. `listingBroadcast(coin, media)` renders it from
  `fmt.listingPost(coin)` — the same admin-editable template the channel post
  uses, so a broadcast can never drift from the post above it — and the whole
  text path goes with it: the RAW-vs-trimmed entity offsets, a step that had to
  run above every flow router because the pay card has no `session.type` of its
  own, a `/cancel` with no card to return to.
- ⚠️ **SO IT IS A TOGGLE, because the card has no other way back.** A one-way
  add would leave a buyer who changed their mind with nothing to tap and an
  order that cannot be re-armed (see the address rule above).
  ⚠️ **And `1.3 − 0.15` is `1.1500000000000001`** — a number in no price table,
  on the card that takes the money. `subAmount` is `addAmount`'s exact inverse
  on the same integer scale; the toggle lands back on the package's own listed
  price to the digit, `amountSmallest` included.
- **`autoSend` is the boundary, and it is narrow.** It says *the bot wrote
  this*: the add-on DMs the card `@dexvraio` is already showing, so there is
  nothing for an admin to read that is not public. The standalone `/massdm`
  product — free text a stranger typed, at 12,000 inboxes — still waits for a
  human, which is what the store's own anti-spam header is about. A test drives
  `fulfillMassDm` and asserts it.
  ⚠️ `autoSend` is NOT `test`: an admin test run skips the receipt and is
  labelled a test in the report, and a paid broadcast is neither.
- ⚠️ **A CLIP SENT THROUGH `sendPhoto` IS AN ERROR, NOT A STILL.** The broadcast
  carries the same artwork the channel post does, and on a box with an admin
  banner clip configured that is a GIF/MP4 — so `mediaType` travels with the
  media and the sender picks `sendPhoto`/`sendAnimation`/`sendVideo` the way
  `channels/post.sendMedia` already does. Without it the DM would have arrived
  as text with no artwork at all, which is the half of the listing card that
  makes it worth sending.
- ⚠️ **The caption is trimmed by `post.fitCaption`, the ONE owner of that cut.**
  Telegram caps a media caption at 1024 UTF-16 units and THROWS past it, so an
  untrimmed listing card would drop the whole DM rather than the picture. A
  text-only broadcast keeps the full 4096. (`fitCaption` lost its `_` prefix
  while doing this: it had two production callers already, and an underscore
  saying "test only" about a function two features depend on is a comment that
  is simply false.)
- **The card SAYS the broadcast is in the price**, enforced at the call site
  exactly as `{network}` is and for the same reason — `pay_card` is editable in
  @dexvraadminbot and an operator's saved copy wins for ever. It cannot be a
  placeholder either way: whether the add-on is attached is a fact about the
  ORDER, not about the card, so appending is the mechanism rather than a
  fallback. The buyer is about to send a number they did not pick off a price
  list.
- ⚠️ **An order armed BEFORE this deploy still carries the buyer's own composed
  message, and it keeps the review it was sold under.** `recovery.js` re-checks
  pending orders for a day, so one paid across the deploy is a real case rather
  than a hypothetical: `p.broadcast` carrying text takes the old path, `true`
  takes the listing card.
- **Three dead helpers were DELETED, not left "in case".** `canAddBroadcast`,
  `pricesWithAddon` and `totalWithAddon` folded the fee into the price table the
  NETWORK PICKER is built from — right while the button lived on the review
  card, and wrong now the add-on is attached after a rail is chosen. A function
  that binds nothing is the row the engine ignores; `pricesWithAddon` binds the
  wrong thing, which is worse.
- ⚠️ **`tpl.meta()` SYNTHESISES `{group:"Other"}` for any key at all**, so the
  "these templates are editable in the admin bot" assertion this section shipped
  with was vacuous in BOTH directions — it could not have failed for a template
  that does not exist. `tpl.keys()` is what the editor lists.

```bash
cd bot && node scripts/run-tests.js test/listingBroadcast.test.js   # 28 tests, no network
pm2 logs dexvra-bot --lines 200 --nostream | grep -F '[massdm]'     # running … , auto, animation
```

Eighteen guarantees are MUTATION-TESTED rather than argued: the add-on not
auto-sending, the standalone product auto-sending, the store ignoring
`autoSend`, an auto job marked as an admin test, the content not being the
listing card, the caption untrimmed, the media type dropped, the sender ignoring
it, the removal subtracting in float, the toggle only ever adding, the removal
leaving the marker or the smallest unit behind, the card never naming the
add-on, its bold landing off the words, the fee not re-checked at the tap, the
button never offering the way back, a listing with no add-on queueing one, and
an old composed order overwritten by the listing card. Each fails between one
and two tests.

**Config a fix depends on:** nothing new. ⚠️ `MASS_DM_REVIEW_CHAT_ID` now also
receives a *notice* (`📣 Listing broadcast going out now — ref …, N recipients`)
rather than only a review request, because a paid DM reaching the whole audience
with nothing anywhere recording it is the silence this repo keeps paying for.

#### "harus pakai emoji premium kaya fourtis" — and it already did

Asked about the broadcast's premium emoji, and the first answer given was
**wrong**: that they cannot animate in a DM because only GramJS animates them.
That sentence came from `premium.js`'s own header, and the header had
generalised a CHANNEL restriction to every send. Telegram's published rule is
that a bot may use custom-emoji entities if it holds a Fragment username, **or
"in the messages directly sent by the bot to private, group and supergroup
chats if the OWNER of the bot has a Telegram Premium subscription"**.

| surface | chat type | animates when |
| --- | --- | --- |
| `@dexvraio` / the board | CHANNEL — in neither list | only through the GramJS premium USER account (💎 Premium status) |
| every bot card, and this broadcast | **PRIVATE** | the BotFather **owner** has Telegram Premium — plain Bot API, nothing to wire |

**So no code was needed for the emoji**, and measuring said so before anything
was changed: the listing card's 8 `custom_emoji` entities reach
`listingBroadcast` intact and go on the wire with **no `parse_mode`**, which is
the one thing that would have destroyed them. ⚠️ **A comment asserting a
contract outliving the contract** is this file's own recurring shape — the
"DexScreener does not index Robinhood" entry sat in five files the same way —
and it is why both headers now name the chat type rather than the transport.

What WAS missing is everything around it:

- ⚠️ **"IT WORKED" AND "IT WAS SILENTLY DOWNGRADED" WERE ONE OBSERVATION.** To
  anyone without Telegram Premium — most readers — a stripped send and an
  animated one are identical, which is exactly what 🔄 Refresh board was built
  to end one surface over (*"a plain publish must never render as a ✅"*).
  Telegram ECHOES the entities it accepted on the Message it returns, so one
  missing from the echo is one it stripped: `notePremium` reads that off the
  FIRST send (it is a property of the BOT, so 12,000 readings are one reading)
  and the delivery report carries `✅ 2 accepted` or `⚠️ PLAIN — the bot's OWNER
  needs Telegram Premium`. ⚠️ It can never claim a RECIPIENT saw them animated:
  that is their own Premium, client-side, and asserting it would be a figure
  nobody measured.
- ⚠️ **A REFUSAL WOULD HAVE COST THE WHOLE BROADCAST.** If Telegram rejects the
  entities rather than stripping them, all 12,000 sends fail identically and a
  broadcast somebody paid 2 SOL for reaches nobody. `stripCustomEmoji` drops
  them **job-wide** on the first refusal and resends plain — the animation is
  lost and the message arrives, which is the trade this repo makes everywhere
  else (*"losing a link beats losing the listing and the link with it"*). Only
  the custom emoji go: the bold runs and the links are not collateral. Job-wide
  because `job` is shared by reference, so at most one batch (`BROADCAST_
  CONCURRENCY`) pays a wasted attempt and every batch after it costs nothing.
- ⚠️ **THE TEST HELPER TOOK AN OVERRIDE AND DROPPED IT.** `job(over)` never
  spread `over`, so every customised fixture asserted against the DEFAULT job —
  and the emoji-free case reported a premium verdict it could not have
  produced. A test measuring its own fake, for the fourth time in this file, and
  the two failures it caused are what exposed it.
- ⚠️ **AND `primeMedia`'s OWN CALL SURVIVED ITS FIRST MUTATION RUN.** It sends
  the first recipient and the loop starts at the cursor it left, so on any wider
  job `sendOne` records the verdict anyway. The fixture that makes it
  load-bearing is a **single-recipient media job** — which is what an admin test
  run is — and the test says so rather than carrying a line that claims cover it
  does not provide.

```bash
cd bot && node scripts/run-tests.js test/massdmPremium.test.js   # 6 tests, no network
pm2 logs dexvra-bot --lines 200 --nostream | grep -F '[massdm]'   # REFUSED, if it ever is
```

Ten guarantees are MUTATION-TESTED rather than argued: the entities re-parsed
as HTML instead of sent as entities, a refusal never recovered from, the strip
taking every entity, the strip made per-send, a stripped send reported as a ✅,
the report saying nothing either way, the verdict never recorded, the media
path never recording it, a later send overwriting the first verdict, and a job
with no emoji given a verdict anyway. Each fails between one and four tests.

**Config a fix depends on:** ⚠️ **nothing in this repo — the switch is the
BotFather OWNER account having Telegram Premium.** Until it does, the broadcast
still goes out and the delivery report says `⚠️ PLAIN` rather than leaving the
operator to compare screenshots. `MASS_DM_REVIEW_CHAT_ID` is where that line
lands.

##### "laporanya seperti fourtis aja" — the shape is copied, every line is measured

Sent with a screenshot of the reference report: the ref, what paid for it,
`📬 Sent to all users`, `🚫 Couldn't reach (blocked/inactive): 418`. Ours read
`Reached: 12523  Failed: 5  Audience: 12528` — three bare numbers that make the
reader do the arithmetic and still answer nothing about the only question that
matters, **which is whether those failures are ordinary**.

- **A broadcast to a whole `/start` audience ALWAYS has failures**, and nearly
  all of them are somebody who blocked the bot or deleted their account. That is
  not a fault, and `Failed: 418` with no cause is exactly the shape that sends an
  operator hunting for one — the asymmetry this file has now had to fix in five
  services. Telegram says which in its own error text and we were discarding it.
- ⚠️ **SO IT IS COUNTED, NEVER ASSUMED.** Printing every failure as
  "blocked/inactive" because the reference does would be a cause nobody
  measured. `UNREACHABLE` is the ordinary family (blocked · deactivated · chat
  not found · `PEER_ID_INVALID`); anything outside it is counted APART and
  NAMED, because that half is the only one an operator can act on —
  `428 — 418 blocked/inactive, 10 for another reason (Bad Request: message
  caption is too long)`.
- ⚠️ **`Sent to all users` IS A CLAIM, and copying it verbatim would print a
  falsehood in two states.** It is grotesque over a run that reached NOBODY
  (`📭 Delivered to nobody`) and false of one that stopped short
  (`Sent to 40 of 12528 — the run did not finish`), so it is printed only when
  `sent + failed` really covers the audience. The tick-over-a-broken-thing rule,
  on the line the reference states unconditionally.
- **`Paid:` tells the three products apart** — `included with listing package` ·
  the standalone order's own `2 SOL` · `free admin test`. They land in ONE
  channel, and the add-on's order total is the listing *plus* the fee, so
  quoting that total would misreport what the broadcast cost.
- ⚠️ **Telegram's own error text is ESCAPED before it goes back to Telegram.**
  The report is `parse_mode: HTML`; one stray `<` in an upstream message makes
  Telegram reject the whole thing with a 400 — so the one line that explains a
  failure would be the line that vanishes.
- **A clean run prints no `🚫` line at all.** A line saying 0 is noise.
- ⚠️ **AND NOTHING DROVE THE CLASSIFIER.** Every report test built its job by
  hand, so deleting `noteFailure` from `sendOne` outright left all of them green
  and the report would have quietly gone back to a bare count. A mutation run
  said so — the *"a wiring that does nothing refuses beautifully"* scar, on the
  one line an operator reads to decide whether to worry. Two driven tests run
  the real sender against a Telegram that blocks every recipient, and against
  one that fails for a reason the audience did not cause.

```bash
cd bot && node scripts/run-tests.js test/massdmPremium.test.js   # 16 tests, no network
```

Twelve more guarantees are MUTATION-TESTED: `Sent to all users` printed
unconditionally, printed over a run that reached nobody, printed over a short
run, every failure laundered as blocked/inactive, the other-reason text never
named, a clean run printing a failure line, the upstream error left unescaped,
everything counted as unreachable, nothing counted as unreachable, a later
failure overwriting the first reason, an admin test reading as a paid
broadcast, and failures never classified at all. Each fails between one and
three tests.

###### "hapus teks premium emoji" — a fact that never changes is not a report line

Asked over the report above, and it is the right call: whether this bot may use
custom emoji is a property of the **bot**, not of the run, so
`✨ Premium emoji: 2 went out animated` printed the same settled sentence on
every broadcast for ever. That is the flood rule `upstreams.js` states — *"an
alert every cycle is a channel nobody reads by the second hour"* — landing on a
line that is not even an alert.

- ⚠️ **THE VERDICT DID NOT GO WITH THE TEXT.** Removing the line would have left
  `notePremium` recording `premiumOut` for nobody, which is this file's own
  *"a value nobody can read is the same as no value"* committed by the change
  that removed it — and a plain send and an animated one are **identical** to
  anyone without Telegram Premium, so with no reader at all a downgrade becomes
  invisible again. It is a **pm2 WARN** now, and only on the NEGATIVE: the
  ordinary state is not worth a line per broadcast, which is what was asked to
  go.
- **`stripCustomEmoji` is untouched.** It is the fail-safe that keeps a refused
  entity from failing all 12,000 sends — it changes DELIVERY, not reporting —
  and it already warned. What changed is only where the verdict is read.
- ⚠️ **"dexvra bot sudah pakai emoji premium di konekan ke userbot yang punya
  premium" IS TRUE OF THE CHANNEL AND NOT OF THIS.** `src/gramjs.js` exposes
  `sendToChannel` and nothing else, because a user account may not DM twelve
  thousand strangers who `/start`-ed a **bot**. So the userbot's Premium is what
  animates @dexvraio and the **BotFather owner's** Premium is what animates
  these DMs — two different accounts to check, and the warn names which.
- **A removal has to be PINNED**, or it comes back the first time somebody
  reaches for the verdict the job still carries: one test asserts the report
  mentions the emoji in NONE of the three states, and the driven tests read the
  rule off pm2 instead.

```bash
cd bot && node scripts/run-tests.js test/massdmPremium.test.js   # 17 tests, no network
pm2 logs dexvra-bot --lines 200 --nostream | grep -F 'STRIPPED the custom emoji'
```

Five guarantees are MUTATION-TESTED: the report line coming back, the downgrade
recorded and told to nobody, the ordinary state logged too, the refusal fallback
firing silently, and the fallback removed entirely. Each fails between one and
four tests.

## "@dexvraceo tambahkan username ini untuk admin agar pembayaran semuanya 0"

`isAdminUser` is the one switch — `armPayment` reads it and arms the order at
`0n` while every flow still runs end to end — and it matches a numeric id OR a
case-insensitive `@username`. The ids have been baked into the code since they
were added, for the reason stated there: **`.env` lives only on the server, so a
name in the code is the only kind of fix a `git pull` carries.** The usernames
had no such list, so `BUILTIN_ADMIN_USERNAMES` is that list and `dexvraceo` is
its first entry.

- ⚠️ **THIS IS NOT ONLY A PRICE.** `isAdminUser` also opens **@dexvraadminbot in
  full** (`adminBot.js`'s guard), the free Mass DM test send and the raid panel.
  One predicate, four doors — right, because they are all "is this Dexvra
  staff", and worth saying out loud because the ask named payments only.
- ⚠️ **A USERNAME IS NOT AS SAFE AS AN ID, and that is a trade-off rather than
  an oversight.** A numeric id is permanent; a @username can be released — or
  just changed — and claimed by a stranger, who would then pay 0 for every
  package this bot sells and hold the admin bot. The id list stays the primary
  route; when this account's numeric id is known it belongs in
  `BUILTIN_ADMIN_IDS` and the username entry can go.
- **`normAdminUsernames` is the ONE normaliser and it covers every source.**
  `isAdminUser` compares against a trimmed, `@`-stripped, lowercased name, so a
  built-in written as `@DexvraCEO` — the spelling this name was GIVEN in, and
  the spelling an operator pastes — would match nobody, silently, and read
  exactly like a name that was never added.
- ⚠️ **AND IT IS TESTED BY BEING CALLED, because a mutation run said an
  assertion could not do it.** Every entry shipped today is already spelled
  correctly, so normalising one source and not the other changes no stored
  value: the mutant survived an assertion on `ADMIN_USERNAMES` and dies only
  against hostile spellings driven through the function. A guard a mutation run
  cannot kill is not a guard — `logoWrite.ts`'s rule, one package over.
- **The PRICE is untouched; only the charge is waived.** `humanAmount` still
  carries the package's real figure, so the receipt, the ops report and the
  wallet label say what the listing is worth. Zeroing it would make every one of
  them claim the package is free.

```bash
cd bot && node scripts/run-tests.js test/adminFree.test.js   # 8 tests, no network
```

Ten guarantees are MUTATION-TESTED rather than argued: the name never added, the
normaliser skipping the built-ins, the `@` not stripped, a pasted line's spaces
kept, a blank entry surviving, the username leg of `isAdminUser` dropped, the
incoming name not lowercased, the payment path not asking at all, and
`adminFree` zeroing the price as well as the charge. Each fails between one and
four tests. ⚠️ Two mutants SURVIVE and that is the feature: writing the built-in
as `@dexvraceo` or `DexvraCEO` is behaviour-neutral, which is exactly what the
normaliser is for.

**Config a fix depends on:** nothing — the name is in the code, so `git pull` +
the ecosystem restart carries it. `ADMIN_USERNAMES` in `bot/.env` still merges
on top for anyone else. ⚠️ This is a `bot/` change, so the deploy is the
**ecosystem restart** (both processes share `isAdminUser`), not `pm2 restart
dexvra` — and the account must have `@dexvraceo` set as its **public Telegram
username**, because that is the only thing an update carries.

### "aturan walaupun 0 juga ada fitur add broadcast"

Reported with a screenshot of an `🧪 Admin Test Order — FREE` pay card for
`Xpress Listing — $HOLYFROG on Solana` carrying `✅ I've Paid — Confirm` and
`🏠 Home` and nothing else. `renderPayCard`'s `if (adminFree)` branch **returned
early**, above the line where the add-on row is built — so an order armed at 0
was the one card in this bot offering FEWER features than the card it stands in
for, and the operator's own account was the only one that could not exercise it.

- ⚠️ **AN ADMIN ORDER IS NOT A DRY RUN**, which is the whole reason this
  matters. The same `fulfillListing` creates the real site row, posts to the
  real @dexvraio and sends the real tweet; `armPayment` waives the CHARGE and
  nothing else (`amountSmallest = 0n`, `humanAmount` untouched — a waived
  charge, not a free package). So a feature missing from that card is a feature
  that cannot be exercised end to end, which is the one thing that card is for.
- **The GATE is unchanged and SHARED.** `addonFee(order)` is still the only
  thing that decides whether the row exists, so `MASS_DM_ENABLED=0` and a
  currency the add-on cannot price (TRX, TON) remove the button on the free card
  exactly as they do on a paid one. A second idea of "can this order take the
  add-on" for the free path is how the two come to disagree.
- ⚠️ **THE FEE IS NAMED ONLY WHERE THERE IS ONE TO PAY.** The admin card quotes
  no price anywhere — `pay_card_admin` renders "No payment needed" and never
  prints `humanAmount` — so `(+2 SOL)` on a button under that line is a label
  contradicting its own sign, the buy card's two ideas of "whale" in miniature.
- ⚠️ **…SO THE LINE HAS TO NAME THE AUDIENCE INSTEAD.** On a paid card the fee
  IS the warning: a buyer sending 2 SOL knows this is a real product. With no
  fee on the button, nothing else would say that this DM **really goes out to
  every `/start` user, with `autoSend` and no review** — it is not the
  🧪 Test send, which targets `ADMIN_IDS` alone — and "Admin Test Order"
  directly above it invites exactly the wrong reading. Nothing here spends
  silently, and 12,000 inboxes is the loudest thing this bot does.
- **`ensureBroadcastLine` now takes the SENTENCE, not the fee.** It owns the
  APPENDING — the entity offsets, the `html` shape, the "already there" test —
  and the wording is computed once by its single caller, because the two cards
  carry different facts.
- **`broadcastToggle` needed nothing**: `if (!pp.adminFree)` already guarded the
  smallest-unit re-derivation, so only the RENDERING half had excluded the free
  card. The toggle is still exact in both directions (`addAmount`/`subAmount`),
  and an admin order lands back on the package's listed price with
  `amountSmallest` still `"0"`.
- ⚠️ **The delivery report was about to call it a purchase.** `queueBroadcast`'s
  `paid:` had an `order.adminFree` branch reachable only from the standalone
  product, so an admin add-on would have reported `included with listing
  package` on an order that paid nothing — the one line an operator reads to
  know what a DM to 12,000 inboxes cost.

⚠️ **AND THE TEST HARNESS'S ADMIN PATH WAS INERT.** `arm(o, {admin:true})`
existed already and set `process.env.ADMIN_IDS = "9"` — but `ADMIN_IDS` is
resolved at REQUIRE time, so an "admin" order armed that way is an ordinary one
and every assertion about the free card would have been measuring the paid card.
No test had ever used it, which is why nobody noticed. The identity is what
makes the order free now (a BUILT-IN owner id, driven through the real
`isAdminUser`), and the first assertion of every free-card test is
`adminFree === true` — a vacuity guard, because a mutation run showed the
harness losing that identity fails six tests rather than none.

⚠️ **A SOURCE SCAN COULD NOT SEE THE REPORT RULE.** The first guard sliced the
`paid:` expression and matched `/adminFree/` — which the mutant still satisfies,
because the OTHER branch mentions it. It SURVIVED. `queueBroadcast` is driven
instead, and the same test measures what the card now claims: an admin order's
add-on really carries `targets: audience()` and `test: false`.

```bash
cd bot && node scripts/run-tests.js test/listingBroadcast.test.js   # 35 tests, no network
```

Eight guarantees are MUTATION-TESTED rather than argued: the admin branch
returning early again, the fee printed on the free card, the `addonFee` gate
bypassed, the free card no longer naming the audience, the toggle charging an
admin order, the harness unable to arm an admin order at all, an admin add-on
reading as a purchase, and an admin add-on quietly becoming a test send. Each
fails between one and six tests.

**Config a fix depends on:** nothing. `MASS_DM_ENABLED=0` still removes the
button everywhere, free card included. ⚠️ This is a `bot/` change, so the deploy
is the **ecosystem restart** and there is no web rebuild.

#### "jgn sebut number, blg aja to all user dexvra dan berapa banyak yang gagal"

Sent with our receipt beside the reference bot's. Ours read

```
✅ Your Dexvra broadcast is delivered.
Ref MD-Y2ZAHL · reached 263 users. Thanks for using Dexvra.
```

— a raw count the buyer never asked for, and one that answers nothing about
whether the run was healthy. **That is the same defect the ops report was fixed
for one round earlier** (*"three bare numbers make the reader do the arithmetic
and still say nothing about the only question that matters"*), left standing on
the other surface: a lesson applied to one of two messages.

- **`reachLine` / `failLine` are the ONE OWNER, for BOTH surfaces.** The report
  and the receipt make the same claim to two audiences, and a second copy is how
  one of them ends up congratulating a buyer whose broadcast reached nobody. The
  CALLER supplies the only two things that differ: the noun (`Dexvra users` /
  `users`) and the **emphasis**, because the report is `parse_mode: HTML` while
  the receipt is the markup the template system parses — one shared bold wrapper
  would have sent the buyer a literal `<b>`.
- **The CLAIM rule comes with it.** "Sent to all Dexvra users" is grotesque over
  a run that reached nobody and false of one that stopped short, so those two
  states keep their own sentence — and their numbers, because *"the run did not
  finish"* with no scale is unactionable. The count that was asked to go is the
  one on the healthy path.
- ⚠️ **The upstream error text is OPS-ONLY.** It is the one value on these lines
  that is not a number, so it is the one needing escaping — and the two surfaces
  escape differently. It is also not the buyer's question: which upstream call
  failed is an operator's.
- ⚠️ **`reached` IS STILL PASSED, and that is the point of it.**
  `data/templates.json` wins over the code default for ever, and `substitute()`
  renders an unknown placeholder as **EMPTY** — so dropping the var would turn
  an operator's saved `reached **{reached}** users` into `reached **** users`,
  which is worse than the number this is about. Pinned by a test that stubs a
  saved copy and asserts its number still lands.
- **The harness gained a BUYER chat**, captured apart from the audience: a job
  whose every recipient is blocked must still deliver the receipt, so it cannot
  share the path that throws.
- ⚠️ **AND `templatePreview.test.js` CAUGHT THE HALF I HAD FORGOTTEN**, which is
  the guard doing its job on its author: every placeholder a template offers
  needs a sample in `SAMPLE_VARS`, or an admin opening 📝 Templates previews the
  card with blanks exactly where the two new lines go — and edits it believing
  that is what a buyer sees. Sampled as the HEALTHY run, because the other two
  states are cards nobody is trying to write.

```bash
cd bot && node scripts/run-tests.js test/massdmPremium.test.js   # 24 tests, no network
```

Eight guarantees are MUTATION-TESTED rather than argued: the reached count
coming back, the receipt growing its own "all users" line, the failure count
dropped, the HTML bold handed to the markup surface, the upstream error leaking
to the buyer, each of the two non-claim states collapsing into the claim, and
`reached` dropped from the vars. Each fails between one and four tests.

**Config a fix depends on:** nothing — ⚠️ **but an operator who has ever edited
the `Mass DM: delivered receipt` template in @dexvraadminbot keeps their own
copy and will still see `reached N users`.** ♻️ Reset default on that template is
what picks the new shape up; this is the standing rule for every copy change
here, and it is the one thing a `git pull` cannot do.

### "semua template … bisa di edit pakai emoji premium" — it already could, and nothing said so

Asked over the pay card's network picker and the broadcast receipt. **Measured
before a line was changed**: every template already takes premium emoji, two
ways — paste a message carrying them (the editor stores it verbatim as
`{text, entities}` when `hasAuthoredFormatting` is true) or 😀 Swap emoji on the
template itself. Driven end to end for `pay_pick`, `pay_card` and `massdm_done`:
the `custom_emoji` entity survives `substituteEntities`, lands on the right
glyph after every placeholder has grown, and goes on the wire as entities with
no `parse_mode`. All 94 template call sites go through `payloadArgs`, so there
is no surface that silently drops them.

**So the gap was what the screens SAY**, and it is two things:

- ⚠️ **The 🎨 bulk screen read as a verdict on the rest.** *"Hanya dua kartu ini
  yang tersentuh. Struk, prompt dan pesan lain tidak ikut berubah"* is true of
  THAT SCREEN and reads as "those cannot be styled at all" — which is what
  produced the question. It still states its scope (that sentence is load-
  bearing) and now names the route for everything else, by the button an
  operator taps.
- ⚠️ **The swap prompt's caveat was a PREFIX TEST**, `isGroupPosted(key)` over
  `group_`/`buybot_`. Right while the picker only pointed at those; silent the
  moment it could reach a pay card or a broadcast receipt — where the SAME
  owner-Premium rule applies, and an operator pasting one there was told
  nothing — and **wrong** the moment it could reach a tweet.

`premiumSurface` / `premiumNoteFor` are the one owner of "which caveat is true
of this template", and the three surfaces are genuinely different settings:

| surface | what lights a 💎 up |
| --- | --- |
| private DM, group, supergroup (the bot's own sends) | the **BotFather OWNER** account having Telegram Premium |
| a CHANNEL post | the **GramJS premium account** — channels are in neither half of Telegram's rule |
| an **X post** | ⚠️ **nothing.** X has no custom emoji; a swap there publishes the fallback character to a public tweet and can never animate |

- ⚠️ **AND THE PATH THE SCREEN NAMES HAS TO EXIST.** Its first cut said
  *"📝 Templates → pilih templatenya"* and there is no such button — the groups
  are on the main menu itself. An instruction pointing at a screen nobody can
  find is this file's placeholder rule one surface over, so it names the real
  groups (**Bot Messages** for the pay card, **Mass DM** for the broadcast
  receipt) and a test asserts both are groups `groupNames()` really returns.
- **A slot spanning two surfaces carries BOTH caveats**, rather than the first
  one winning — one icon can live on a DM card and a channel post at once.
- ⚠️ **THE BULK SCREEN'S SCOPE IS DELIBERATELY UNCHANGED**, and the first cut of
  this change widened it before `allEmojiScreen.test.js` said why not: *"khusus
  buy alert dan raid, yang lainnya ga usah, jangan diubah apapun"* is an
  operator instruction on the record, pinned as *"a swap aimed at a buy alert
  must not drag a receipt or a prompt along with it"*. That screen dedupes by
  GLYPH, so folding 156 templates in would make one ✅ swap repaint a receipt, a
  prompt and a buy card together — unaimable, and the exact harm the instruction
  names. Per template a swap stays aimable, which is why that is the route the
  screen now points at.
- ⚠️ **A CAVEAT NOBODY IS SHOWN IS NO CAVEAT.** Four screens prompt for an
  emoji, and deleting the call from any ONE of them was invisible to every
  assertion — a mutation run said so, not a reading. The rule is COUNTED now
  (one definition + four prompts, over the comment-stripped source).
- ⚠️ **AND THE OLD GUARD FOR IT PINNED THE SPELLING.** `buyMonitor.test.js`
  matched `isGroupPosted(key) ? GROUP_PREMIUM_NOTE` and counted it twice — so it
  went RED over code that keeps its rule on MORE screens through one owner, and
  would have passed on a `premiumNoteFor()` that always returned `""`. This
  repo's own recurring defect (the four-way pool TTL, the `{ ok: true,` build
  stamp, the in-flight stall warning). It CALLS the owner now.
- ⚠️ **`premiumSurface`'s try/catch is DEAD and says so.** `tpl.meta()`
  synthesises `{group:"Other"}` for any string, so an unknown key resolves
  through the FALLTHROUGH — the direction that shows a caveat rather than
  hiding one — and a mutant in the catch changes nothing. A line that claims
  cover it does not provide is worse than the comment explaining what actually
  keeps it true.

```bash
cd bot && node scripts/run-tests.js test/premiumAnywhere.test.js test/allEmojiScreen.test.js   # 9 + 30 tests, no network
```

Ten guarantees are MUTATION-TESTED rather than argued: an X template treated as
an ordinary bot message, a channel post sent to @BotFather, only the first
surface's caveat surviving, each of the four prompts dropping it, the bulk
screen swallowing every group again, and the screen no longer naming the route
for the rest. Each fails between one and three tests.

**Config a fix depends on:** ⚠️ **nothing in this repo — the switch is an
account.** A 💎 in a DM or a group card needs the **BotFather owner** on
Telegram Premium (@BotFather → Bot Settings → Transfer Ownership); a channel
post needs the GramJS account connected (💎 Premium status). Until then a swap
is saved and shows its fallback character, which is exactly what these notes now
say on the screen where it is pasted.

## "bot merespon yg msih diskon" — the price moved and the sentence beside it did not

Reported with the Mass DM card on a box whose `[boot] build` matched `main` to
the character. **Every figure on it was right** — `◎ 2 SOL · 🟡 0.3 BNB ·
⧫ 0.1 ETH` is the full price, and the launch discount really is withdrawn. What
was wrong is the line above them:

```
**Flat price — 50% off** (charged in your token's chain)
{sol}  ·  {bnb}  ·  {eth}
```

The three figures are PLACEHOLDERS fed from `MASS_DM_PRICE`, so they moved with
the code. The words were typed into the template, so they did not — and the
card advertised a discount over the full price, which reads from Telegram as a
bot quoting one number and charging another.

- ⚠️ **THE PRICE WAS GUARDED AND THE SENTENCE ABOUT THE PRICE WAS NOT.**
  `listingBroadcast.test.js` has pinned the shipped default (`|| 2`, `|| 0.3`,
  `|| 0.1`) since the discount was withdrawn, and it passed for the whole
  deploy. A discount is a CLAIM about a number, and this repo already refuses a
  printed `0.00%` and a captured-at-listing `$0` for exactly that reason; it had
  never been applied to a claim in COPY.
- **So a discount must ride a placeholder, never the copy**, and a scan of every
  template DEFAULT enforces it — the values, not the source, so the comment in
  `constants.js` recording the withdrawn discount is not caught.
- ⚠️ **AND THE FIRST CUT OF THAT SCAN FLAGGED THE ONE CORRECT CASE.**
  `upsell_expiry` says *"a **{discount}% renewal discount** is already applied"*
  — computed, and therefore exactly what the rule ASKS for. Matching the WORD
  would have taught the next reader that a computed discount is the thing being
  forbidden. It matches a LITERAL percentage beside a discount word, in either
  order, and asserts both directions: it sees `50% off` and leaves
  `{discount}%` alone.

## "detect token onchain not works" — five serial chain probes with no deadline

Same session, same card, one step later: the buyer pasted
`0x92e4…bd8d7`, the bot replied **"🔍 Detecting your token's chain…"** — and
said nothing else, for minutes, on a box whose four processes were all online.

**Nothing had crashed.** `group/setup.js` `resolveToken` is SERIAL, and an
`0x…` address has **five** candidate chains: up to five `gt.fetchPool` calls,
each queued on `gtSlot(PRIO_BACKGROUND)` — **which has no deadline of its
own** — and then up to five `chainPools` log sweeps behind them. On the keyless
budget, behind nine background pipelines, a user-prompted paste sits in the
background tier for minutes.

⚠️ **This file already documents that defect and its fix** — *"bot tidak
merespon untuk paket listing setelah di minta drop ca"*, bounded at
`LISTING_AUTOFILL_MS` — **in the flow that got it.** Mass DM and `/settoken`
paste a CA into the same discovery and neither was ever bounded: a lesson
applied to one flow is a lesson half-learnt, which is this repo's most repeated
shape.

- **`resolveTokenSoon` is the ONE OWNER of the deadline** (`CA_RESOLVE_MS`, 8s,
  floor 1s), and it lives beside `resolveToken` rather than at each caller — a
  rule the second caller has to remember is one the third forgets. The
  BACKGROUND callers keep their queue semantics untouched; only the people who
  are waiting stop waiting on them.
- ⚠️ **IT RETURNS WHICH SILENCE IT WAS.** `{res, timedOut}` — *"we could not ask
  in time"* and *"no live pool exists on any chain we support"* are different
  facts, and the two flows owe the user different sentences. `/settoken` had a
  null branch already, so without this a hang would have been reported as
  **"❌ No live pool on that CA"**: a failure of ours rendered as a fact about
  somebody's contract, sending an admin off to check an address that is fine.
- ⚠️ **AND A GUESSED CHAIN MAY NOT BE ANNOUNCED AS A DETECTED ONE.** On no
  answer the Mass DM flow falls back to `candidateChains(ca)[0]`, which for any
  `0x…` is simply *ethereum* — and the chain decides which CURRENCY the buyer
  pays in (ETH vs BNB). `massdm_chain_unconfirmed` is its own template so the
  card says it is going by the address shape and offers a way out; the
  confident *"✅ Token detected on X"* is kept for a chain we really resolved.
  Its own key, not a placeholder on the existing card, so an operator who has
  saved that card is unaffected.
- ⚠️ **The deadline timer is NOT `unref`'d** — somebody is awaiting it — and is
  therefore CLEARED on the winning path, or an 8s budget holds the loop open 8s
  past a 200ms answer. Third time this scar has been written in this repo
  (`helpers/bounded.js`, tradebot's own `bounded()`); measured here rather than
  argued, with `process.getActiveResourcesInfo()`.
- **The tests DRIVE the real bound** — `gt.fetchPool` is made to hang and
  `handleText` / `settoken` are called the way a paste calls them. A unit test
  of `resolveTokenSoon` alone passes on a `captureCa` that never calls it, which
  is the `curveBuyPath` scar.

⚠️ **AND THE MUTATION HARNESS REPORTED THE REPORTED BUG AS SURVIVING.** The
hang mutant makes five tests fail — and node ends such a file with *"Promise
resolution is still pending but the event loop has already resolved"* and
leaves its own `# fail` tally at **0**, which is the line the harness was
reading. The mutant was killed the whole time and the instrument could not see
it. Two fixes, because either alone is a half-fix: the harness counts
`not ok`, and the driven tests race their own named deadline so a hang fails
with *"still nothing after Nms — this is the reported hang"* rather than with
node's internal sentence.

```bash
cd bot && node scripts/run-tests.js test/caResolveBound.test.js test/listingBroadcast.test.js   # 48 tests, no network
```

Seven guarantees are MUTATION-TESTED rather than argued: the bound removed
entirely (the reported hang), the timeout claiming a detection, the deadline
timer never cleared, a timeout reported as a fact about the token, `/settoken`
calling a real "no pool" a timeout, the frozen discount claim restored, and the
scan blind to a computed discount. Each fails between one and three tests.

**Config a fix depends on:** nothing. `CA_RESOLVE_MS` widens the wait for an
operator with a GeckoTerminal key and an empty queue. ⚠️ This is a `bot/` change,
so the deploy is the **ecosystem restart** and there is no web rebuild — and an
operator who has ever edited **Mass DM: intro + price** in @dexvraadminbot keeps
their own copy and will still see *"50% off"* until they hit ♻️ Reset default.

### "masih tidak mau detect ini chain robinhood" — the bound made it answer; the map made it answer WRONG

The deploy above landed and the bot ANSWERED — which is that fix working — and
the answer was wrong. The same `0x92e4…bd8d7` came back

```
⚠️ We couldn't confirm this token's chain just now.
Going by the address, it looks like Ethereum — so you'd pay 0.1 ETH.
```

about a **Robinhood** token. Two causes, and neither one is the deadline.

⚠️ **1. A THIRD PRIVATE COPY OF THE DEXSCREENER CHAIN MAP, WITH NO ROBINHOOD.**
`gtPairs.js` carried `DS_CHAIN` — seven entries, hand-written — and
`fetchDsPool("robinhood", …)` therefore returned `null` **without making a
request**. DexScreener was never asked about the chain with the most listings on
the box, so GeckoTerminal was the only source left, and GT queues.

**This file already records that exact defect and its fix** — *"TWO OWNERS FOR
THE DEXSCREENER SLUG, disagreeing about one chain … every Sei token answered
'no market data' … One owner"* — applied to `dexscreener.js` and left standing
here. A lesson applied to one of two modules. The July 2026 Robinhood flip put
`robinhood` into `config/chains.js`'s `DEXSCREENER_SLUG` and this copy never got
it, along with fifteen other chains — and `sei → seiv2` is the reminder that the
slug is not always the chain key, which is precisely what a hand-written copy
gets wrong.

⚠️ **2. FIVE IDENTICAL REQUESTS, FOUR FIFTHS OF EACH DISCARDED.**
`fetchDsPool` calls `latest/dex/tokens/{address}` — **which answers for EVERY
chain at once** — and then filters to the one chain the caller named. So
`resolveToken`'s five-candidate loop made five identical requests to one URL and
threw away most of each answer, each able to fall through to the GT queue. The
answer was in the first response.

- **`dsResolveAcross(address, candidates)` is ONE request, no GT, no queue**,
  and `resolveToken` asks it FIRST. The serial per-chain loop stays as the
  fallback for tokens that endpoint does not carry.
- ⚠️ **THE CHAIN IS CHOSEN BY POOL DEPTH, NEVER BY THE CANDIDATE LIST'S ORDER.**
  `0x…` resolves to `[ethereum, bsc, base, robinhood, plasma]` — robinhood
  FOURTH — so a positional pick answers "ethereum" for any EVM token with so
  much as a dust pair there. On the Mass DM flow that decides **which currency
  the buyer is charged**. It is the `deepestPool` / `topPoolAddress` rule, on the
  one read that picks a network.
- **A pair on a chain the paste has no candidate for is ignored**, or the same
  `0x` address on a network we were not asked about could name the rail.
- ⚠️ **The bound alone could never have fixed this**, which is why it was
  reported twice. Under `CA_RESOLVE_MS` the loop never reached candidate four
  whatever DexScreener knew — so the timeout fix made the bot *answer*, and only
  the map and the single request make it answer *correctly*. A fix that removes
  the silence is not a fix that removes the wrong number.

```bash
cd bot && node scripts/run-tests.js test/caResolveBound.test.js   # 18 tests, no network
```

Four more guarantees are MUTATION-TESTED rather than argued: the private map
restored (no robinhood), the single request dropped from `resolveToken`, the
chain picked by candidate order again, and a chain outside the candidates
allowed to answer. Each fails between one and four tests.

⚠️ **FOUND AND DELIBERATELY NOT FIXED: `data/templates.json` has a cross-process
lost update.** `setTemplate` is read → modify → **await write** on one shared
file, and `node --test` runs each test FILE in its own process, concurrently —
so two files that save a template can clobber each other, which is what makes
`buyEmojiScreen`'s "each button says what its icon is for" flaky (green on a
re-run, red under load). ⚠️ **It is not only a test problem**: `dexvra-bot` and
`dexvra-adminbot` are two PM2 processes sharing `DATA_DIR`, so an admin saving a
template while the other process writes one is the same lost update. An
in-process mutex does NOT fix it — this needs a file lock or a per-file
`DATA_DIR` in the runner, which is its own change with its own design, so it is
recorded here rather than half-patched.

**Config a fix depends on:** nothing. ⚠️ This is a `bot/` change, so the deploy
is the **ecosystem restart** and there is no web rebuild.

### "aturan bisa set media juga kalo mau skip juga bisa dn kasih tau"

Sent with a screenshot of the standalone `/massdm` flow: a CA pasted, the word
`test` sent as plain text, and the preview card offering `💳 Pay 0.1 ETH ·
✏️ Recompose · 🏠 Home`. **The flow was ONE-SHOT.** Whatever the buyer's first
message happened to carry was the whole broadcast for ever — send text and
there was no way to attach a photo afterwards; the only route was ✏️ Recompose,
which is `ad_massdm`, which `freshSession`s and asks for the CA again, throwing
away the chain resolution that had just been paid for in latency.

And the card said nothing either way. **"A photo is attached" and "this is
text-only" rendered identically on the screen the buyer taps Pay from** — the
💎-means-premium-not-yours defect, one product over.

- **`showPreview` is the ONE renderer**, and both doors go through it. Two
  copies of "draw the preview" is how the compose path and the attach path come
  to disagree about what is on the broadcast.
- **`{media}` says which of the three states it is in** — none · attached ·
  attached-but-Telegram-would-not-show-it-back. ⚠️ **The third exists because
  the preview send is best-effort**: `catch {}` over a failed `replyWithPhoto`
  leaves *"👆 This is your broadcast"* pointing at nothing at all, which is a
  claim over a broken thing.
- ⚠️ **AND IT IS ENFORCED AT THE CALL SITE** (`ensureMediaLine`), because
  `data/templates.json` wins over the shipped default for ever: an operator who
  saved `massdm_preview` before `{media}` existed would render no attachment
  state at all. The `{network}` rule on the pay card, one product over —
  appended at the END so the payload's own entity offsets do not move, and only
  the appended block's shift. ⚠️ Both paths are pinned separately, because
  either alone is behaviour-neutral: the placeholder puts the row where the
  OPERATOR put it (above the price), the enforcement is what gets it onto a card
  that has no placeholder, and a mutation run kills each only against its own
  fixture.
- **The SKIP is a button, not an inference.** `⏭ Keep it text-only` on the photo
  step and `🗑 Remove photo` on the preview — and ⚠️ the remove button exists
  only while there is something to remove, because a button whose only outcome
  is a no-op is the row the engine ignores.
- ⚠️ **A CARD CARRIES THE BUTTON ITS OWN SENTENCE NAMES.** The too-long refusal
  says *"tap ✏️ Recompose"*, and the photo step's keyboard does not have one —
  an instruction pointing at a button that is not on the screen is the
  *"📝 Templates → pilih templatenya"* defect, on the one card whose whole job is
  handing the buyer something they can act on.
- ⚠️ **A PHOTO DROPPED ON THE PREVIEW ATTACHES.** It used to `return` silently
  (`awaitingField !== "massdm_compose"`), and a buyer who drops a photo onto the
  card they are about to pay from means to attach it: answering that with
  nothing is "the button does nothing", on a money screen.
- ⚠️ **A CAPTION SENT WITH THE PHOTO REPLACES THE TEXT — AND WE SAY WHICH.**
  Which of the two readings holds (a deliberate rewrite, or a line typed out of
  habit over the paragraph they already wrote) cannot be inferred from the
  message, and taking either silently destroys the other. Both outcomes are
  named in the notice, and the preview re-renders so they see the result.
- ⚠️ **TEXT ARRIVING AT THE PHOTO STEP NAMES BOTH READINGS and changes
  nothing** — a new caption, or a buyer who forgot to attach. The `3` vs `3h`
  refusal on the pace row, one flow over.
- ⚠️ **AN OVER-LONG CAPTION IS REFUSED, NEVER TRIMMED.** Telegram caps a media
  caption at 1024 UTF-16 units and **throws** past it, so attaching a photo to
  text longer than that would fail **every one of 12,000 sends** of a broadcast
  somebody paid for — and trimming instead would silently delete most of what
  they wrote. The refusal carries both numbers and says nothing was changed.
  `CAPTION_LIMIT` is exported from `channels/post.js`, the one owner of that
  number, rather than retyped here.
- **A document is REFUSED, naming the fix.** Telegram will not take a document
  `file_id` in `sendPhoto`, so accepting one queues a paid broadcast that fails
  for every recipient — and the buyer fixes it by re-sending from the gallery.

⚠️ **AND THE TYPE HAD NEVER TRAVELLED, which is a live defect on the money
path.** `getMediaFileId` answers for animations and videos too, and this flow
hardcoded `"photo"` all the way down — the preview through `replyWithPhoto`, the
`.jpg` the test-send writes, and `queueBroadcast`'s
`{ mediaPath: massFile(id, "jpg", buf), mediaType: "photo" }`. So a GIF broadcast
previewed as nothing (the bare `catch`) and then failed on **every** `sendPhoto`
call. **This file already records that exact lesson for the listing add-on** —
*"⚠️ A CLIP SENT THROUGH `sendPhoto` IS AN ERROR, NOT A STILL"* — and it was
never applied to the standalone product: a lesson applied to one of two
siblings, for the eighth time here. `mediaType` now rides the session, the
preview method, the payload, the job and the file extension.

- ⚠️ **`massdm.js` IMPORTS THE PAY MODULE, NOT A DESTRUCTURED `startPayment`.**
  A destructured import is bound at require time, so **no test could pin what
  this flow hands the payment path** — the amount, the coin, or the media type
  that decides whether 12,000 sends go out as `sendPhoto` or `sendAnimation`.
  The rule `listing.js` already states at its own require; found by writing the
  test, which could not stub it.

```bash
cd bot && node scripts/run-tests.js test/massdmMedia.test.js   # 21 tests, no network
```

Twenty guarantees are MUTATION-TESTED rather than argued: a photo dropped on the
preview ignored again, text at the photo step silently taking one reading, a
document accepted as a photo, a GIF filed as a photo, the type never reaching
the payload, an over-long caption attached anyway, a caption discarded,
attaching wiping the composed text, the removal saying nothing, the skip off
screen, the too-long card naming a button it does not offer, the preview
offering no way to set media, the card ignoring `{media}`, the shipped card
losing its `{media}` row, the row always claiming no photo, the appended line's
bold landing off the words, the enforced line doubling up, the test-send writing
a clip as `.jpg`, a clip previewed through `sendPhoto`, and a paid GIF queued as
a photo. Each fails between one and two tests.

**Config a fix depends on:** nothing. ⚠️ This is a `bot/` change, so the deploy
is the **ecosystem restart** and there is no web rebuild — and an operator who
has ever edited **Mass DM: preview / pay** or either compose prompt in
@dexvraadminbot keeps their own copy: the attachment row is enforced onto the
card either way, but the *"a photo is optional, you can add one later"* line on
the compose prompt only appears after ♻️ Reset default.

#### "recompase ganti edit dan semua template bot message harus bisa edit pakai emoji premium"

Two asks, and the second named a defect **introduced by the section above**.

**✏️ Recompose pointed at `ad_massdm`** — `entryMassDm`, which `freshSession`s
and asks for the contract address again. So a buyer who wanted to change one
word paid the chain detection over again (five candidate chains, bounded at
`CA_RESOLVE_MS`), could land on a different answer, and lost any photo they had
just attached. Renaming that button to **Edit** without moving the action would
have made the label lie *harder*, which is this file's own
label-contradicting-its-action shape — so `md_edit` re-opens the compose step
with the token, the chain, the price and the media INTACT.

- ⚠️ **A NEW MESSAGE CARRYING NO MEDIA NOW KEEPS WHAT IS ATTACHED.** On the
  first compose there is nothing to keep, so it is a no-op there; on an edit it
  is the difference between changing a word and silently deleting the photo
  attached two taps ago — the same destruction the caption rule refuses one
  step over. Removing it is 🗑 Remove photo, which says so, and the edit prompt
  states the rule before they type.
- **`ad_massdm` still exists** as the 📣 menu entry, which is the one place
  "start over at the CA" is what the tap means.

⚠️ **AND THE `{media}` PLACEHOLDER COULD NOT CARRY A PREMIUM EMOJI.** The
attachment row was substituted into the preview card as MARKUP, read from
`tpl.getRaw().text` — and an operator who PASTES a row is stored as
`{text, entities}`, whose `custom_emoji` entities a markup substitution cannot
carry. So a 💎 pasted into `massdm_media_on` flattened to its fallback glyph, on
exactly the surface this file had just promised keeps it. The row is **rendered
whole and appended** now (`ensureMediaLine`, one path), which is an ordinary
template render, so the entities travel. A `{media}` typed into a saved card
renders empty and the row is still appended — it degrades rather than losing
the state it reports.

- **The promise is measured for EVERY key now, not for the three an operator
  named.** `premiumAnywhere` pastes a premium emoji into all 168 templates in
  turn and asserts the `custom_emoji` survives the render. A shortlist is what
  let a caller flatten one without any test noticing.
- ⚠️ **THE REACHABILITY GUARD WRITTEN BESIDE IT COULD NOT FAIL, and a mutation
  run said so.** It walked `tpl.groups()` for a template in no group — and
  `tpl.meta()` SYNTHESISES `{group:"Other", label:key}` for any string at all,
  so an orphan is impossible by construction. **This file records being caught
  by that exact synthesis once before**, and the second cut repeated it. What
  the synthesis cannot hide is the LABEL: `label === key` means no META entry,
  which is a template filed under "Other" reading `flow_step_failed` on the one
  screen an operator edits copy from. Two were — `listing_lookup_wait` and
  `flow_step_failed`, both added by earlier fixes in this file — and they have
  human labels now. The assertion carries its own vacuity check: it fails if the
  synthesis it is written against ever goes away.

```bash
cd bot && node scripts/run-tests.js test/massdmMedia.test.js test/premiumAnywhere.test.js   # 24 + 11 tests, no network
```

Nine guarantees are MUTATION-TESTED rather than argued: an edit dropping the
photo, Edit restarting at the CA, the preview reverting to ✏️ Recompose, the
too-long card naming a button it does not offer, the attachment row dropped from
the card, a pasted template rendering without its entities, a template shown as
its raw key, the Edit prompt losing its META entry, and the reachability guard's
own vacuity. Each fails between one and eight tests.

**Config a fix depends on:** nothing. ⚠️ `bot/` only, so the **ecosystem
restart** — and an operator who saved **Mass DM: preview / pay** yesterday keeps
their copy: the attachment row is appended onto it either way, but the word
"recompose" in their own text stays until ♻️ Reset default.

#### "saya tidak bot message tentang broadcast" — the one broadcast line that was not a template

Reported with a screenshot of 📝 Templates, straight after the round above
promised that every bot message is editable with premium emoji. **The Mass DM
group has 23 broadcast templates and the line the operator was looking for is in
none of them**, because it is not a template at all: the pay card's

```
📣 Includes a Mass DM Broadcast to all users (+2 SOL).
```

was a STRING inside `pay.js`. So the one buyer-facing broadcast message on the
card that takes the money could be neither found, nor edited, nor given a 💎 —
and the promise made one round earlier was true of 168 templates and false of
the sentence the operator had in front of them.

- **`pay_card_broadcast` / `pay_card_broadcast_admin` are templates now**, in
  **Bot Messages** beside `pay_card`, labelled so they read as belonging to it.
- ⚠️ **TWO KEYS, BECAUSE THE TWO CARDS CARRY DIFFERENT FACTS.** A paid card
  names the FEE — that is what explains a number bigger than the tier the buyer
  picked. An admin card quotes no price anywhere ("No payment needed"), so with
  no fee to name, nothing at all would say the DM is REAL: it queues against the
  whole `/start` audience with `autoSend` and no review, and it is not the
  🧪 Test send. One key with a `{fee}` that renders empty would put that whole
  distinction on an operator remembering why.
- ⚠️ **IT STILL APPENDS, and that is not a fallback.** Whether the add-on is
  attached is a fact about the ORDER, not about the card, and an operator who
  saved `pay_card` before the add-on existed keeps their copy for ever — so a
  `{broadcast}` placeholder would render nothing on exactly the cards that need
  the line most.
- ⚠️ **THE LINE IS RENDERED WHOLE AND APPENDED WHOLE.** A `custom_emoji` lives
  in the ENTITIES and a string carries none, so appending a SENTENCE flattens a
  pasted 💎 to its fallback glyph — silently, on the money screen. This is the
  `{media}` hole from the round above, one handler over: *"render the row whole
  and append it, and the entities travel."*
- **`premium.appendBlock` is the ONE appender.** There were three — the network
  line, the broadcast line, the Mass DM attachment row — and each lost the
  entities its own way; a fourth private copy is how one of them flattens a 💎
  again. A comment-stripped scan fails on any handler that shifts
  `e.offset + …` itself.
- ⚠️ **`seen` IS A SEAM AND IT IS LOAD-BEARING.** The network line tests the
  PHRASE `Network: <name>` because that is what the template emits and the whole
  line is not; the other two test the block's own text, which is right for a row
  an operator cannot have typed. Folding them together either re-appends the
  network line onto a card that carries it or lets a bare mention suppress it —
  and this file already records what the second one cost ("we accept Ethereum,
  Solana and BNB" names no network for THIS order).
  ⚠️ **The first test written for that seam could not reach it**: the SHIPPED
  `pay_card` renders a line byte-identical to the block, so the default `seen`
  suppresses it too and the mutant survived. An operator's own wording
  (*"Kirim di Network: Robinhood Chain saja ya"*) is the fixture that sees it.
- **The BUTTON labels stay hardcoded, and that is not the same gap.** An inline
  keyboard button carries no entities at all, so a premium emoji is unavailable
  there whatever we do — a template behind it would promise something Telegram
  cannot render.

```bash
cd bot && node scripts/run-tests.js test/listingBroadcast.test.js test/premiumAnywhere.test.js   # 40 + 15 tests, no network
```

Eight guarantees are MUTATION-TESTED rather than argued: the line back to a
string, the templates existing but the card ignoring them, `appendBlock`
dropping the block's entities, forgetting to shift them, ignoring the `seen`
seam, losing the already-there test, the templates filed away from the pay card,
and a handler growing its own appender back. Each fails between one and seven
tests.

**Config a fix depends on:** nothing. ⚠️ `bot/` only, so the **ecosystem
restart** and no web rebuild — and the two new lines are NEW keys, so no
operator has a saved copy of them and ♻️ Reset default is not needed anywhere.

## "mengapa tidak baca saldo solana" — five wallets asked five times and were refused

Reported with a `/wallet` screenshot: `Couldn't reach Solana — those are not
counted above` on the active wallet and `⚠️ 1 chain(s) unread` on all four
others, while **every EVM chain answered on every wallet**. A chain that fails
on five wallets at once while five other chains succeed is not flakiness. It is
arithmetic, and three of this file's own rules were broken to produce it.

**1. ⚠️ FIVE WALLETS ASKED FIVE SEPARATE QUESTIONS, IN THE SAME MILLISECOND.**
The dashboard reads wallets × chains concurrently, and `readNative` is a
per-CELL read — so five `getBalance` calls landed on
`api.mainnet-beta.solana.com` together, the endpoint these notes already call
*"aggressively rate-limited"*. **And this exact lesson is written down one
method over**: `getSignatureStatuses` takes an ARRAY and was batched for this
very reason — *"five wallets were throttling each other"* — while
`getMultipleAccounts` takes one too and the balance read never learnt it. A
lesson applied to one of two siblings, for the ninth time in this file.

**2. ⚠️ AND WEB3.JS SPENDS 7.5 SECONDS ON A 429 BEFORE IT ANSWERS AT ALL.**
Measured in `node_modules`, not assumed: its RPC client retries a 429 five
times at 500ms → 1s → 2s → 4s. The wallet screen waits **2500ms**. So one 429
means that read can NEVER finish inside the window — deterministic, which is
why all five cells missed rather than some — and the retries keep hitting the
endpoint for five seconds after the screen has given up. *"A client that
hammers through its own 429"*, this repo's own defect, inside a dependency.

**3. ⚠️ AND THE REASON WAS DISCARDED AT THREE LAYERS.** `solBalanceOrNull`'s
`catch (_) { return null; }`, `_balanceResilient`'s bare `catch`, and the
screen's `.catch(() => null)`. So a 429, a host refusing this box, DNS and our
own 2.5s bound were ONE sentence — which is why this had to be reported from a
screenshot instead of read off the screen that was already showing it.

- **`solBalancesX` reads every wallet in ONE `getMultipleAccounts`**, and
  `core.nativeBalances(chain, addrs)` is the one owner of a per-chain COLUMN —
  the shape both screens that list wallets actually want. `readNativeColumn`
  serves the dashboard matrix and the sweep picker; EVM is unchanged, because
  those endpoints are not the ones refusing us and ethers already batches where
  `batchMaxCount` allows.
- ⚠️ **THE TIMEOUT IS PER COLUMN NOW, and that is not a regression**: the five
  Solana cells were always one concurrent wave sharing one wall clock. What
  changed is that they share one REQUEST, which is the thing the endpoint counts.
- ⚠️ **A NULL ACCOUNT IS A REAL ZERO.** Solana answers `null` for an address
  nobody has funded — which is what a fresh wallet is — so reading that as "could
  not ask" would park every new wallet in the unread column for ever.
- **The READ connections set `disableRetryOnRateLimit`; the SIGNING one does
  not.** A refusal comes straight back so our own failover and reason can act on
  it; a confirmation that waits out a 429 is doing its job. ⚠️ They must be
  **separate objects** — alias the caches and the option is decided by whichever
  call constructed the url first, which no source scan can see and which is
  therefore driven.
- **`SOLANA_RPC` is a LIST** — *"never one hardcoded host"*, finally applied to
  the one upstream in this repo that never had it. ⚠️ There is deliberately **no
  invented second default**: a guessed endpoint on the chain that signs trades is
  what this repo refuses outright, so the failover is inert until an operator
  adds a host — a comma in `.env`, not a deploy. It fails over on a REFUSAL as
  well as a transport error, which the standing base rule forbids and which is
  the 429's documented exception: a rate limit is a fact about the bucket on THAT
  host. The reported reason is the FIRST host's — a later host's dead socket must
  not bury the rate limit that started it.
- **`ethBalanceOrNull` and the removal survey go through the same door.** Two
  private reads is how the dashboard and the removal guard came to disagree about
  a wallet holding 2.15 SOL in the first place.
- **The screen SAYS which silence it was**, de-duplicated (five chains behind one
  dead host is one sentence), and the boot line prints the HOST COUNT — never the
  urls, for the reason the RPC url is never printed. `1 host (no failover)` beside
  `Couldn't reach Solana` is the whole diagnosis: nowhere else to ask.

⚠️ **AND THE OLD GUARD FOR THIS PINNED A SPELLING.** `walletWithdraw.test.js`
matched the literal `solana.solBalanceOrNull(providerFor(chainKey), addr)`, so it
went RED over code that keeps its rule on MORE screens through one owner — and
would have passed on a reader that answered `0n`. This repo's own recurring
defect (the four-way pool TTL, the `{ ok: true,` build stamp, the in-flight stall
warning). It asserts the RULE now.

⚠️ **And one source assertion could not see its own mutant.** *"The screen says
why"* was a scan for `chainWhy[` — which `if (false) chainBlock += ''` leaves
in place. A source scan cannot tell a line that fires from one that is merely
written down; `walletRender.test.js` DRIVES the render with Solana refusing and
asserts the sentence reaches the reader.

```bash
cd tradebot && node --test solBalanceBatch.test.js walletRender.test.js walletWithdraw.test.js   # 14 + 30 + 63 tests, no network
pm2 logs dexvra-tradebot --lines 50 --nostream | grep -F '[boot] solana'
```

Nineteen guarantees are MUTATION-TESTED rather than argued: the batch back to
one `getBalance` per wallet, a null account read as unread, the reason
discarded, the LAST host's reason winning, no failover, an unparseable address
marking the whole column unread, `SOLANA_RPC` no longer a list, a blank override
leaving no host, core no longer batching, each of the two screens back to a
per-wallet read, the screen not saying why, the reason not de-duplicated, the
reason never captured, web3.js's retry back on the read path, the read cache
aliased to the signing one, and each of the two core doors growing its own read
back. Each fails between one and eight tests.

**Config a fix depends on:** nothing — the batch, the retry-off and the reason
all ship on and need no `.env`. ⚠️ But the CEILING is still the ceiling: one
public endpoint shared by every wallet, the snipe loop and the confirmations.
`SOLANA_RPC` in **`tradebot/.env`** (`/opt/dexvra/tradebot/.env` — the trade bot
reads its OWN `.env`, and that mistake has been made) is the only thing that
raises it rather than dividing it, and it now takes a **comma-separated list**
so a refused host is parked and the next takes the same calls. ⚠️ This is a
`tradebot/` change, so the deploy is `pm2 restart dexvra-tradebot --update-env`
— not the ecosystem file, and no web rebuild.

### "masih 1 chain unread ini chain solana yang tidak bisa di read"

The batch shipped and the screen still said it — but read the two screenshots
together and they name three different things, only one of which is the RPC.

**1. ⚠️ THE FIX'S OWN HANDOVER BROKE THIS FILE'S FIRST RULE, FOR THE FIFTH
TIME.** The operator was handed `SOLANA_RPC=https://endpoint-berbayar-anda,…`
— *"your paid endpoint"* — as a line to paste, and pasted it, **at a shell
prompt**. `VAR=value` is a legal assignment whatever the value is, so the shell
returned a clean prompt and said nothing; pm2 never saw it, and had it reached
`.env` every Solana read would have gone to a host that resolves nowhere and
reported `could not reach the Solana RPC (ENOTFOUND)` — which reads as a network
fault rather than an unfilled blank. **That is the `LAUNCHPAD_PONS_TOKEN_PATH`
incident verbatim**, in the handover for the fix, on the one lever that was
supposed to end the outage. So the operator's config change did nothing, and
nothing anywhere said so.

- **The fix is never to reword the placeholder** — it is to make the code refuse
  a value that cannot possibly be right (`report.js` `_looksLikeChatId`,
  `pads.js` `realValue`). `rpcUsable` refuses it, `rpcUrls` drops it, and the
  survivors are what the bot uses.
- ⚠️ **THE DOT IS THE TEST, and a scheme check is not.**
  `https://endpoint-berbayar-anda` parses as a URL perfectly well — protocol
  fine, hostname fine — and its host has no TLD, which no reachable public
  endpoint lacks. `localhost` and `127.0.0.1` are the legitimate dotless hosts
  and are allowed by name; a keyed url (`…helius-rpc.com/?api-key=…`) passes
  untouched.
- **A refused entry is WARNED about, once per value**, naming the variable —
  "the override did not work" and "the override was never read" are otherwise
  the same observation, which is exactly what happened. ⚠️ The warning prints
  the **host and never the path**: a rejected value is a placeholder, but a paid
  endpoint carries its key in the path and this line goes to pm2's log.
- **A list of nothing but placeholders falls back to the built-in default**, so
  a bad paste degrades to today's behaviour rather than to an outage.
- ⚠️ **AND `rpcIsCustom` ASKS WHAT SURVIVED, NEVER WHAT WAS TYPED.** The boot
  line read `process.env.SOLANA_RPC ? 'custom' : …`, so a list of refused
  placeholders would have printed **custom** on the one line an operator checks
  after setting it — telling them their override is live while every read went
  exactly where it always did. One owner, beside the list it reads, tested by
  being CALLED.

**2. ⚠️ THE PER-WALLET ROW NAMED NEITHER THE CHAIN NOR THE REASON.** The
reported screen said `the Solana RPC is rate-limiting this server (429)` on the
active wallet and `⚠️ 1 chain(s) unread` on the four rows underneath — the same
fact, rendered once with an answer and four times without one. **A lesson
applied to one of two surfaces, for the tenth time in this file**, and it is why
this needed a screenshot instead of being read off the screen that was already
showing it. A count cannot say WHICH, and at n=1 it says nothing at all.

- **The row names the chain** (`⚠️ Solana unread`), the way its other segments
  already name what the wallet holds.
- ⚠️ **THE REASON HAS ONE OWNER FOR THE WHOLE SCREEN**, because it is a fact
  about the CHAIN and not about a wallet. Printing it in both places would be
  two owners of one sentence — and the active wallet is not even reliably one of
  them: the ≤10-min last-known cache can carry ITS cell while another wallet's
  stays null, so the block that held the reason renders no unread line to hang
  it on. That hole is now a driven test.
- **Grouped by REASON, not by chain**, so two chains behind one dead host are
  one line, and the line NAMES them (`Solana — the Solana RPC is rate-limiting
  this server (429)`) so it stands alone wherever it sits.

**3. A HOST THAT JUST REFUSED US IS NOT ASKED AGAIN.** *"A client that hammers
through its own 429"* is this repo's own defect — fixed for CoinGecko,
DexScreener, GeckoTerminal and Jupiter, and never for the chain this bot signs
on. Every `/wallet` render is one `getMultipleAccounts`, so a box the endpoint
is refusing spends one request per tap proving the same refusal, for ever, while
the screen shows the same sentence either way. `SOL_RPC_PARK_MS` (15s, clamped
1s–120s) parks it and the reason is kept, so the screen says the same true thing
without making the request.

- ⚠️ **A REFUSAL PARKS; A TIMEOUT DOES NOT.** 429/401/403 is a fact about the
  bucket; a dead socket or a slow answer says nothing about a quota, and parking
  one would bench a host that is merely having a bad second. The line `gt.ts`
  and `logoFill` already draw.
- ⚠️ **READ PATH ONLY.** `getConnection` is untouched: a confirmation waiting on
  a signed transaction must go out, and parking it would strand a trade that has
  already spent money.
- **A parked host never stops the next one**, and a host that answers is
  unparked.

⚠️ **AND TWO EXISTING GUARDS WENT RED OVER CODE THAT KEEPS THEIR RULE** — this
repo's own recurring defect (the four-way pool TTL, the `{ ok: true,` build
stamp, the in-flight stall warning), twice in one round. `statusBatch` pinned
the boot line's ternary *verbatim*, so it failed the day "custom" started being
asked of the hosts that survived — **and would have passed on a line claiming
custom over a list of placeholders**. `walletScreen` pinned `unread++` and
`{ n: unread }`, so it failed the day the row started naming the chain, which is
the one thing the count could never do. Both assert their property now, and the
third — the reason's placement — was rewritten from *"it is inside the active
block"* to *"one write, one read"*.

```bash
cd tradebot && node --test solBalanceBatch.test.js walletRender.test.js   # 23 + 33 tests, no network
pm2 logs dexvra-tradebot --lines 50 --nostream | grep -F '[solana]'        # was an entry ignored?
```

Fourteen guarantees are MUTATION-TESTED rather than argued: `rpcUsable` always
true, the dot test dropped, no fallback when every entry is refused, the refusal
gone silent, the warning printing the path, "custom" asked of what was typed,
the boot line inlining the env check, no park on a refusal, a timeout parking
too, the row collecting a count instead of a name, the row's template back to
`{n}`, the reason never printed, the reason not naming its chain, and a reason
per chain instead of per host. Each fails between one and six tests.

⚠️ **A fifteenth SURVIVED, and that is what the comment in `solBalancesX` now
says.** The park has a guard at both ends — a normalised `url` on the read and
`url &&` on the write — and dropping the read-side one changes no outcome while
the write guard stands. So the WRITE is the boundary, the read-side
normalisation is belt-and-braces, and the code says which rather than carrying a
test that claims cover it does not provide.

⚠️ **What this does NOT do is make Solana answer.** One public endpoint shared
by every wallet, the snipe loop and every confirmation is still one public
endpoint, and a box it is refusing stays refused however few requests we make.
**The only thing that RAISES that ceiling rather than dividing it is a second
host**, and `SOLANA_RPC` in `/opt/dexvra/tradebot/.env` takes a comma list for
exactly that — which is what the placeholder above was supposed to deliver and
did not.

**Config a fix depends on:** nothing for the code. ⚠️ `SOLANA_RPC` lives in
**`tradebot/.env`** (the trade bot reads its OWN), it is a FILE and not a shell
variable, and every entry must be a real host — the boot line now says `custom`
only when one survived, and `[solana] SOLANA_RPC entry ignored` names any that
did not. ⚠️ `tradebot/` only, so the deploy is `pm2 restart dexvra-tradebot
--update-env` — not the ecosystem file, and no web rebuild.


#### "kita sudah pakai helius dan limit" — the trade bot was never the spender

Asked one round after the Solana balance fix, and the answer is that the
previous round's arithmetic **measured the wrong process**. It counted
`tradebot/` and concluded ~1,500 requests a day — true, and irrelevant, because
the two packages have SEPARATE Solana endpoints and the other one is three
orders of magnitude larger:

| | reads Solana from | cost |
| --- | --- | --- |
| `tradebot/` | `SOLANA_RPC` in **`tradebot/.env`** | 1 request per `/wallet`, ~10 per trade |
| `bot/` (the buy bot) | `RPC_SOLANA_URLS` / `RPC_SOLANA` in **`bot/.env`** | **1 + `MAX_TX` per pool per `BUYBOT_POOL_MIN_MS`** |

Measured off the code rather than guessed: `chainTrades.js` reads a Solana pool
with one `getSignaturesForAddress` and then up to **40** `getTransaction`, every
**25 seconds**, **per tracked pool**. That is up to 41 requests per pool per
poll — **~142,000 a day for ONE pool**, on `getTransaction`, which is among the
heaviest methods a provider meters. Six busy pools is a sustained ~10 req/s.

- **So "we are on a paid key and still hit the limit" is answered in `bot/`, not
  in `tradebot/`.** The trade bot's entire Solana appetite is a rounding error
  against a single tracked pool, and pointing a key at only one of the two
  `.env` files leaves the other on the public endpoint — which is the third time
  this repo has been bitten by two owners of one upstream.
- ⚠️ **AND THE BUDGETS MUST ADD UP TO THE CEILING**, the rule `GT_MAX_RPM`
  already states for GeckoTerminal across these same two processes. One key
  shared by a bulk poller and a latency-critical money path means the bulk one
  starves the money one — and the money one is the one whose failure a user
  sees as `Couldn't reach Solana` on their own balance.
- **`BUYBOT_MAX_TX` is a knob now** (clamped 4–200, default 40, blank is
  ABSENT). It is the single biggest number in this bot's Solana bill and it was
  a hardcoded constant, so the only lever an operator had was
  `BUYBOT_POOL_MIN_MS`. ⚠️ Lowering it costs COVERAGE, not correctness: the
  window is sorted newest-first before the slice, so a smaller cap drops the
  OLDEST buys of a busy poll — an alert that was already going to be minutes
  stale. That trade-off belongs to whoever pays the bill.

⚠️ **THE REAL ANSWER IS THAT POLLING IS THE WRONG SHAPE, and nothing here is
subscribed to anything.** A grep for `onLogs`, `logsSubscribe` or `wss://`
across this repo returns NOTHING: every Solana read in both processes is a
poll. `logsSubscribe` over a WebSocket pushes a pool's trades down one
persistent connection instead of ~142,000 requests a day, and every provider's
free tier includes it. That is a real change to `chainTrades.js` with a real
failure mode of its own (a dropped socket is a pool that goes silent, which is
this file's own `lastFeedOkAt` scar), so it is recorded here as the next move
rather than done quietly.

Mutation-tested: the knob removed, the clamp dropped, and a blank read as zero
each fail a test.

```bash
cd bot && node scripts/run-tests.js test/chainTrades.test.js   # 21 tests, no network
grep -c SOLANA_RPC /opt/dexvra/tradebot/.env                   # which process is actually on the key
grep -c RPC_SOLANA /opt/dexvra/bot/.env
```

**Config a fix depends on:** ⚠️ **TWO files, and setting one is not setting the
other.** `SOLANA_RPC` in `tradebot/.env`; `RPC_SOLANA_URLS` (a comma list, wins
outright) or `RPC_SOLANA` (one endpoint, defaults follow) in `bot/.env`.
`BUYBOT_MAX_TX` and `BUYBOT_POOL_MIN_MS` are the two knobs that change the bill
without changing a provider.


##### "masih sama aja solana unread" — the sentence stopped one word short

The rendering fix landed and the screenshot proves it: `⚠️ Solana unread` on
every row, and ONE `Solana — the Solana RPC is rate-limiting this server (429)`
for the screen. So the chain is named, the reason is named, and it is still not
a diagnosis — **because it does not name the HOST.**

With a failover list those are two completely different problems wearing one
sentence:

| what happened | where the fix is |
| --- | --- |
| a paid endpoint IS configured and IS refusing us | the provider |
| the paid endpoint never arrived; this is the public one | the `.env` |

Three rounds of this went to the second reading while the screen was read as
the first. And the fact that settles it — the host list — lives on the boot
line, which an operator's `pm2 logs | grep` came back EMPTY for on a box
producing it, because the snipe loop writes several lines a second. **That is
the `[curve]` and `[jup]` scar for the third time: a fact that lives only in a
log line is not retrievable.**

- **`npm run sol:check` asks it on demand**, and asks the half a config dump
  cannot: it DRIVES `solBalancesX` — the exact call the dashboard makes — once
  per configured host and reports which answered, with latency. A check that
  asked its own way is how `fonts:check` printed nine green ticks over a banner
  publishing boxes.
- ⚠️ **IT PRINTS A HOSTNAME AND NEVER A URL.** A paid endpoint carries its API
  key in the path or the query, and this output is read off a terminal that
  gets screenshotted — three have been sent in this investigation alone. Driven,
  because it is the one property no source scan can prove: the test runs the
  script with a keyed url and asserts the key appears in neither stream.
- **A refused placeholder entry is NAMED in the report**, not merely dropped —
  "a fix that changed nothing at all" is exactly what
  `https://endpoint-berbayar-anda` cost.
- **It names the OTHER process and does not measure it.** `bot/` has its own
  Solana endpoint and is the heavy one; reporting another process's
  configuration as this one's is the defect `trending:check` was caught by.
- ⚠️ **The wallet screen deliberately keeps the plain sentence.** It is
  user-facing, and a hostname there tells every user which provider the
  operator pays. The host belongs in the operator's own tool.
- ⚠️ **AND THE CHECK MAY NOT INFLATE ITS OWN TALLY.** The first cut counted one
  dead endpoint twice — once per host, once in the verdict — and printed
  `✗ 3 problem(s)` for two. A number a reader learns to discount is worse than
  no number.

⚠️ **The first cut of its own test measured the WRONG STREAM.** `rpcUrls` warns
on stderr about a refused entry in wording close to the check's own, so the
assertion passed while the check printed nothing at all — a mutation run said
so, not a reading. `run()` returns stdout and the concatenation separately now:
the REPORT is stdout, and only the key question spans both, because a key
leaked to stderr is still leaked.

```bash
cd /opt/dexvra/tradebot && npm run sol:check    # which host, and does it answer FROM THIS BOX
cd tradebot && SKIP_DOTENV=1 node --test solCheck.test.js   # 5 tests, the script is RUN
```

Six guarantees are MUTATION-TESTED rather than argued: the url printed whole in
the host list, the url printed in the per-host verdict, a refused entry dropped
silently, solana required before core, the probe never run, and the verdict
section deleted. Each fails between one and two tests.


###### "solana masih unread" — the failover shipped INERT

Fourth report of one symptom, and this time the screenshot rules out the
rendering: `⚠️ Solana unread` on every row, one `Solana — the Solana RPC is
rate-limiting this server (429)` for the screen. Both of those are the last two
rounds working. **What was wrong is that there was nowhere to fail over TO.**

`SOL_DEFAULT_RPC` is ONE host. So on a box nobody has configured, `rpcUrls`
returns a single entry, the walk built last round has one stop, and the comma
list is a feature that cannot fire — *"a fallback that cannot fire reads exactly
like one that never helps"*, this file's own name for it, on the fix written to
end this exact outage. Every round since has told the operator to set
`SOLANA_RPC`, which is a request, not a fix: **"apt-get install is not a fix"**,
for the second time in this investigation.

- **`SOL_READ_FALLBACKS` — and they are NOT invented, which is the whole licence
  for them.** `bot/src/config/rpc.js` has shipped `solana-rpc.publicnode.com`
  and `solana.drpc.org` as Solana defaults on this same box since it was
  written, and `cd bot && npm run rpc:check` measures them. So the trade bot
  had one host while the sibling package beside it had three: **two owners of
  one upstream, disagreeing**, which is the shape that left `tradebot/solana.js`
  and `bot/src/marketdata.js` on different pump.fun hosts.
- ⚠️ **READS ONLY, and an operator's own host always LEADS.** The standing rule
  refuses a guessed endpoint *"on the chain that signs trades"*, and
  `getConnection` takes `rpcUrls(rpc)[0]` — the CONFIGURED first entry — so
  nothing here moves signing, broadcasting or confirming. `rpcIsCustom` asks
  `rpcUrls` too, or every default box would print **custom** on the one line an
  operator checks after setting the override.
- ⚠️ **What actually guards signing is the APPEND ORDER, not that spelling.**
  `readUrls` appends and `rpcUrls` never returns empty, so `readUrls[0]` and
  `rpcUrls[0]` are the same host for every input — swapping them in
  `getConnection` is behaviour-neutral and a mutation run says so. The rule is
  enforced by the tests that fail when a fallback LEADS, and the comment says
  which rather than carrying a test that claims cover it does not provide.
- `SOL_READ_FALLBACK=0` removes them; **blank is ON** (`raid/sourceFlag.js`).

⚠️ **AND WITHOUT A PER-HOST SLICE THE FALLBACK IS DEFEATED BY THE FAILURE IT IS
FOR.** The wallet column is bounded at 2500ms TOTAL, so one host that **hangs**
— as opposed to refusing, which comes straight back now that
`disableRetryOnRateLimit` is on — eats the whole window and hosts 2 and 3 are
never asked, on every render, for ever. `SOL_HOST_MS` (1200ms) is
`curveTrade`'s STAGE_MS rule on the read the screen waits for: a slice that runs
out is INCONCLUSIVE, never a verdict — it does not park the host (a timeout is
no fact about a quota) and it does not stop the walk. ⚠️ Its timer is **not**
unref'd (a read is being awaited) and IS cleared, measured with
`getActiveResourcesInfo` rather than reasoned about — third time that scar is
written here.

- ⚠️ **The boot line counts the READ walk, not the configured list.** Counting
  `rpcUrls` would print *"1 host (no failover)"* on a box that has three, which
  sends an operator to add hosts it already has.
- ⚠️ **AND `sol:check` WOULD HAVE GONE PERMANENTLY RED.** A host that refuses
  while another answers is the failover WORKING; marking it ✗ leaves the check
  red on a box whose `/wallet` is fine, which is the state `chart:preview` sat
  in for weeks and which teaches its reader to ignore the red. The exit code
  follows the SCREEN (`market:check`'s rule): every host refusing is a fault,
  one of three refusing is a ⚠ and a note. It lists the fallbacks as such, and
  names the one host that does **not** fail over — that is where money moves.
- `hostOf` prints `.host`, not `.hostname`: a PORT is not a secret and is the
  only thing telling two endpoints on one hostname apart, while a key lives in
  the path or the query on every provider there is.
- ⚠️ The sol:check tests stand up **local stub nodes** (one answering, one
  429-ing), because *"does the exit code follow the screen"* cannot be asked of
  a sandbox with no egress, where every host refuses and the two branches are
  indistinguishable. ⚠️ `execFileSync` BLOCKS this process's event loop, so a
  stub server living beside it could never answer the child — those tests need
  the async form.

```bash
cd tradebot && SKIP_DOTENV=1 node --test solBalanceBatch.test.js solCheck.test.js   # 34 + 8 tests, no network
cd /opt/dexvra/tradebot && npm run sol:check                                        # which hosts, and which answer
pm2 logs dexvra-tradebot --lines 50 --nostream | grep -F '[boot] solana'
```

Twelve guarantees are MUTATION-TESTED rather than argued: no fallbacks at all,
the fallbacks leading instead of trailing, a named fallback asked twice, blank
read as OFF, `rpcIsCustom` asking the read list, `readConnections` walking the
configured list, no per-host slice, the slice timer never cleared, a slice
that ran out parking the host, the boot line counting the configured list,
`sol:check` listing only the configured hosts, and `sol:check` going red when
the failover works. Each fails between two and eight tests.

⚠️ **What this does NOT do is raise the ceiling.** Three public endpoints are
three public endpoints, and a box all of them refuse stays refused. What changed
is that one of them refusing is no longer the whole outage. `SOLANA_RPC` in
**`tradebot/.env`** is still the only thing that raises it rather than dividing
it — and `bot/.env`'s `RPC_SOLANA_URLS` is a **different file** for the process
that actually spends.

**Config a fix depends on:** nothing — the fallbacks ship on and need no `.env`.
`SOL_READ_FALLBACK=0` restores the single-host behaviour and `SOL_HOST_MS`
widens the per-host slice. ⚠️ `tradebot/` only, so the deploy is
`pm2 restart dexvra-tradebot --update-env` — not the ecosystem file, and no web
rebuild.


## Conventions

- Tests live beside the code they cover, in `bot/test/`, `tradebot/*.test.js`
  and `src/**/*.test.ts`. A behaviour change without a test that would have
  caught the old behaviour is not finished.
- Comments explain **why**, and name the failure the code is shaped around.
  Match the density of the file you are editing.
- Operator-facing strings in @dexvraadminbot are **Indonesian**; user-facing
  bot copy and channel posts are English.
