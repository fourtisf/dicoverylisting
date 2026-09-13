# Keys, tokens and endpoints — what the bot actually needs

An audit of every credential this bot reads, what breaks without it, and — the
part that is easy to get wrong — what breaks **silently**.

Everything is set in `bot/.env` (see `.env.example`). About 120 named variables
exist, plus the `RPC_*` family; almost all of them are tuning knobs with working
defaults. The list below is only the ones that are a *credential* or that decide
whether a feature exists at all.

---

## The headline

**Two values make the bot work. Everything else is optional.**

| | | Without it |
|---|---|---|
| `BOT_TOKEN` | @BotFather | **The process refuses to start.** `src/bot.js` throws. |
| `INTERNAL_API_TOKEN` | must equal the web app's own value | The bot boots and answers messages, but **every listing write fails**. Nothing is published. |

`INTERNAL_API_TOKEN` is the one to double-check, because its failure mode is not
a crash. The bot starts, the menus work, a customer completes a paid flow — and
only then does the write to the web app throw. **`npm run check` will not catch
it**: the smoke test substitutes a placeholder so it can boot offline. The thing
that does catch it is the free admin test order (put your id in `ADMIN_IDS`,
listing costs 0) — it exercises listing → publish end to end without spending.

**No paid market-data API key is needed anywhere.** Worth stating plainly
because it is the first thing people go shopping for: every price, pool, chart,
trending and buy-feed call in this repo is keyless.

- GeckoTerminal — pools, trades, market data (`src/marketdata.js`, `src/group/gtPairs.js`, `src/group/gtTrades.js`)
- DexScreener — pairs, boosts, profiles (`src/dexscreener.js`)
- CoinGecko — native coin prices (`src/nativeprice.js`)

There is no Helius, Birdeye, Moralis, DexTools, BitQuery or GoPlus key in this
codebase. What you pay for instead is **rate limit**: those endpoints are shared
with the whole internet and throttle by IP. That is a capacity problem, not a
credentials problem, and the same is true of the RPC endpoints below.

---

## To take money

Payments work without these — the bot will quote an address and detect the
payment — but the funds then **stay in the per-order temp wallet**.

| | Without it |
|---|---|
| `TREASURY_EVM` / `TREASURY_SOL` / `TREASURY_TRON` / `TREASURY_TON` | The sweep for that family is **skipped**, with one warn line. Money accumulates in temp wallets. |
| `WALLET_ENC_KEY` (64 hex chars) | Temp-wallet private keys are stored **in plaintext** on disk. The bot warns loudly and keeps going. |

```bash
npm run treasury          # which are set, which are missing, and what that costs
npm run treasury -- --live   # …plus what is still sitting in temp wallets
```

An unset treasury is not a crash and not an error — it is a warning you will
scroll past. Check it before going live, not after.

---

## RPC endpoints

Every chain ships with a **list** of keyless public endpoints
(`src/config/rpc.js`). Two override forms:

```bash
RPC_BSC=https://my-node.example              # leads; public defaults stay as backup
RPC_SOLANA_URLS=https://a.example,https://b.example   # REPLACES the list entirely
```

`RPC_<CHAIN>_URLS` replaces rather than appends on purpose: an operator who
names their endpoints does not want a public node quietly carrying their traffic
as a fourth choice.

**A read walks the list until one node answers. A send never falls back.** A
broadcast that failed at the transport layer may still have reached the network,
so re-sending the same signed transfer to a second node risks paying twice.
Instead each sweep takes the endpoint that answered its *opening balance read*
and stays on it for every attempt — reading from a healthy backup while
broadcasting to a dead primary only moves where it fails. Nothing is signed
until a node has already answered, so choosing at that point cannot
double-spend.

The consequence for `RPC_<CHAIN>_URLS`: **every url you list is a node a sweep
may broadcast from**, not merely read from. It is not a "backup for reads only"
list. List nodes you trust to send.

Why a list at all: a dead RPC does not report an error, it reports the **wrong
answer**. An unreadable balance during payment polling is indistinguishable from
"the customer has not paid yet", and an unreadable token balance makes every
whale look like a minnow. Neither logs anything alarming.

```bash
npm run rpc:check              # every chain, every endpoint, from THIS server
npm run rpc:check -- bsc solana
```

The public defaults are rate-limited and shared. If your groups are busy or you
take real payments, a paid endpoint in `RPC_<CHAIN>` is the highest-value line in
`.env` after `BOT_TOKEN`.

---

## Features that turn themselves off

Each of these is optional, on by default, and **degrades quietly** — which is
the reason for the third column.

| | Unlocks | Without it |
|---|---|---|
| `ADMIN_BOT_TOKEN` | @dexvraadminbot — templates, banners, buy/whale GIFs | The admin bot never starts. The main bot is unaffected and uses built-in copy. |
| `API_ID` + `API_HASH` (+ `session.txt`) | Premium **animated** emoji in channel posts, via a Premium user account | Posts fall back to the Bot API. Premium emoji are **stripped by Telegram with no error** — the post looks fine, just plain. Run `node scripts/gramjs-login.js` once. |
| `X_API_KEY` / `X_API_KEY_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | Auto-posting listings, trending, pumps, rank-ups to X | `X_ENABLED` computes to false and nothing is tweeted. All four or none — `npm run x:check`. |
| `X_O_*` (4 more) | A second X account, used only by banner-ad fulfilment | That one surface does not post. |
| `X_BEARER_TOKEN` | Live like/reply/repost counts on raid cards | Raids still run — in **squad-only** mode, counting `⚡ I'm in` taps. The card says why the X numbers are missing. Reads are ~$0.005 each, deduplicated per post per 24h UTC, so a 60-minute raid costs about half a cent. |
| `MONGO_URI` | Durable mirror of the JSON stores across container resets | Fail-open: everything works, but state lives only on local disk. `npm run mongo:check` (can I connect?) / `npm run backup:check` (did my state get there?). |
| `TON_API_KEY` | Higher toncenter rate limits | TON calls are throttled harder. |
| `LOG_CHANNEL` / `ERROR_CHANNEL` / `PK_CHANNEL` | Event feed, crash feed, temp-key backup | No feed. Nothing else changes. |

Feature switches (all default **on**): `GROUP_BUYBOT_ENABLED`, `RAID_ENABLED`,
`BUYBOT_WHALE_WALLET_ENABLED`, `BUYBOT_PIN_WHALES`, `PUMP_ENABLED`,
`POST_BANNERS`, `MASS_DM_ENABLED`, `GRAMJS_ENABLED`.

Optional and default **off**, deliberately: `RAID_FREE_METRICS` and
`RAID_GUEST_METRICS` read X without a key. They are not independent fallbacks —
both are gated by X's IP reputation, so a datacenter block takes them out
together. See the raid section of the README before enabling either.

---

## Verify, don't assume

```bash
npm run check         # boot everything without connecting to Telegram
npm run rpc:check     # which RPC endpoints answer from this server
npm run treasury      # payout addresses + key storage
npm run x:check       # X credentials and exactly what will post
npm run buybot:check  # is the buy feed real, or degraded to estimates?
npm run raid:check    # can raid metrics be read at all?
npm run mongo:check    # durable mirror reachable?
npm run backup:check   # …and is every store actually in it?
npm test              # 893 tests
```

Every one of these answers a question you cannot answer by watching the chat.
The buy bot in particular does not go silent when its feed dies — it falls back
to volume estimates that look almost identical in the group.
