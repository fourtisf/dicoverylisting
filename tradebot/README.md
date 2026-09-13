# Dexvra Trade Bot

A **custodial, Maestro-style, multi-chain Telegram trading bot** for
[Dexvra](https://dexvra.io). Users trade tokens straight from Telegram — no
website, no wallet extension.

**Chains:** Robinhood Chain (launchpad bonding curves), Ethereum, Base, BNB Chain,
Arbitrum, and **Solana**. One EVM key is the **same address on every EVM chain**;
the same custodial secret also derives one fixed **Solana** address (Phantom-path for
seed-phrase wallets) — switch with `/chain`. On Robinhood Chain trades route to the
launchpad curve (then its DEX after graduation); on other EVM chains to that chain's
Uniswap-V2/PancakeSwap DEX; on **Solana** to the **Jupiter** aggregator (any SPL mint,
by base58 address). Solana is **off by default** — enable it by adding `solana` to
`ENABLED_CHAINS` and setting `SOLANA_RPC` (a private RPC is strongly recommended).

## Features

- **Wallets (up to 10 per user)** — hold multiple bot-managed wallets, **generate**
  fresh ones or **import** your own (private key or 12–24-word seed phrase — the
  message holding the secret is deleted immediately), and **switch** the active one
  anytime. Each wallet has its own balance, positions and orders. Private keys are
  encrypted at rest with AES-256-GCM under `WALLET_SECRET` and only decrypted
  transiently to sign a trade the user asked for. Deposit / withdraw / export-key
  built in. Removing a wallet is blocked while it still holds native (no stranding),
  and you always keep at least one.
- **Buy / Sell by CA** — paste a contract address → live card (price, mcap,
  graduation %, your bag & PnL) with one-tap buy/sell. Routes to the bonding curve
  while listed, and to Uniswap V2 once graduated — the same route the
  launchpad site uses.
- **Rich token scan** — paste a CA/mint for a Maestro-style card: price, market cap,
  liquidity/raised, 24h volume, holders, LP status, and safety. **EVM** safety is
  GoPlus (buy/sell tax, honeypot, owner footguns); **Solana** safety is **RugCheck**
  (mint/freeze authority, LP locked/burned, holder concentration, "rugged" flag),
  both surfaced as a HIGH-RISK banner.
- **Portfolio + History** — open positions with live value and unrealized PnL, a
  per-wallet trade log, and realized PnL (SOL-denominated on Solana).
- **Snipe (multi-chain)** — auto-buy every new Robinhood Chain launch, every new
  Uniswap/Pancake pair on ETH/Base/BNB/Arbitrum, and every new **pump.fun** launch on
  Solana (discovery via the pump.fun feed, buy via Jupiter); DANGER-flagged tokens
  skipped. Opt-in per chain. Discovery also polls **every launchpad in the shared
  registry** (`shared/launchpads/pads.js` — Pons on Robinhood, LetsBonk / Moonshot on
  Solana, four.meme on BNB, Virtuals on Base, …), so a token born on a pad the event
  scans cannot see is still sniped, and a launch seen **before** its market opens is
  parked in a retry ring (`LAUNCH_RETRY_MS`, 3 min) and bought the moment a route
  exists rather than dropped — which is also what makes the **dev-wallet snipe**
  actually fill: it sees the dev's mint before the dev opens the pool. **Pons**
  (pons.fun, the second Robinhood Chain launchpad) is discovered **on-chain** —
  its factory's `TokenLaunched` log, `deployer` = the dev wallet — because its
  HTTP API is unreachable from datacenter IPs; `PONS_FACTORY` / `PONS_EVENT`
  override the guesses, `LAUNCHPAD_PONS=0` turns it off, and
  `npm run preflight:robinhood` (section 4p) verifies it against the live chain.
- **Limit / TP / SL + Price alerts** — set a USD target; the bot polls the price
  and executes (orders) or just pings you (alerts, notify-only) when crossed. Works on
  every chain, Solana included (DexScreener pricing).
- **Copy-trading (beta)** — follow a wallet and mirror its BUYS with your active
  wallet. EVM watches the token's WETH-pair swaps; **Solana** polls the target's
  signatures and mirrors a SOL-funded SPL buy. DANGER tokens skipped; total spend per
  target is hard-capped (bounded loss).
- **Referrals** — share a `?start=<code>` link; referrers earn `REF_SHARE_BPS` of
  the bot fee. Auto-paid from `FEE_WALLET` when `FEE_WALLET_KEY` is set (else manual).

## Revenue

A flat `BOT_FEE_BPS` (default **1%**) of each trade's native value is sent to
`FEE_WALLET` (EVM) or `SOL_FEE_WALLET` (Solana — a separate SOL transfer after the
swap; leave empty to waive). Referrers get `REF_SHARE_BPS` (default 30%) of that fee,
accrued per chain in the store for you to settle. EVM referral debt can be auto-paid
when `FEE_WALLET_KEY` is set; Solana referral debt is always settled manually.

## ⚠️ Launchpad support — run the preflight before trusting snipe

**The snipe and bonding-curve paths are hard-wired to one launchpad, and it is not
pools.trade.**

Launch discovery has exactly one source: `watchers.js` filters the factory at
`chains.js` `robinhood.factory` for the 12-field `TokenCreated` event defined in
`core.js` `FACTORY_ABI`. Both were inherited from **robinfun.io**, the launchpad this
bot was originally built against. pools.trade is built on Uniswap's launchpad
contracts (`uniswap-cca` / `uniswap-bonding-curve`), which do not emit that event.

Why this matters more than an ordinary bug: **`eth_getLogs` returns an empty array —
not an error — for a topic nothing emits.** So a snipe pointed at the wrong launchpad
scans every 6 seconds forever, completes cleanly, reports 🟢 on `/health`, shows
"Active" on the user's Snipe screen, and never fires. The same address backs
`resolveCurve()`, so curve buys silently fall through to DEX routing and the token
card says *"no pool/curve found here"*.

```bash
npm run preflight:robinhood                                  # addresses, interface, launch feed
npm run preflight:robinhood -- --token 0x<a pools.trade token>   # probe curveOf()
npm run preflight:robinhood -- --tx 0x<a real launch tx>         # THE decisive check
```

Read-only — it spends nothing and signs nothing. `--tx` is the one that settles it: it
prints the `topic0` of every log a real launch emitted next to the one the bot filters
for, and tells you which of two cases you are in:

| Preflight says | Meaning | Fix |
|---|---|---|
| topic0 matches, address differs | right event, wrong address | **config only** — set `FACTORY_ADDR` and restart |
| topic0 does not match | different launchpad interface | **code change** — `FACTORY_ABI`/`CURVE_ABI` must learn the new event; no env var helps |

Until the preflight passes, treat Robinhood snipe as **unverified**. Everything else
(Ethereum / Base / BNB / Arbitrum / Solana) is unaffected — those chains never used
the launchpad path.

`/health` now reports `launches seen` and warns once it has scanned thousands of
blocks without seeing one; `core.launchpadDiag()` records a failing `curveOf` instead
of letting it read as "this token has no curve".

## Run

```bash
cp -n .env.example .env   # -n = never clobber. On a live box .env holds the only
                          # copy of WALLET_SECRET, and every user's stored wallet
                          # key is encrypted under it — overwrite it and none of
                          # them can be decrypted again.
npm install
npm start                 # long-polls Telegram; no inbound ports needed
```

On the VPS it runs under pm2 as `dexvra-tradebot` (separate from the `bot/`
processes in `bot/ecosystem.config.js`):

```bash
cd tradebot && pm2 start index.js --name dexvra-tradebot --update-env && pm2 save
# updates: git pull && (cd tradebot && npm install) && pm2 restart dexvra-tradebot --update-env
```

## Node version

The bot itself runs on **Node 18+**. The TEST SUITE needs **20.4+**: nineteen
tests drive the live-monitor loop through `mock.timers`, whose `{ apis }` options
object and `Date` support landed in 20.4. On an older Node those tests SKIP with
that reason rather than failing, so `npm test` stays a usable deploy gate — but
they are not verifying anything there.

Worth knowing separately: **Node 18 left security support in April 2025**. This
bot is custodial — it holds users' private keys — so an unpatched runtime is a
real exposure, independent of anything in this repo. Node 20 or 22 LTS fixes
both that and the skipped tests.

## Language

The bot answers in **English or Indonesian**, per user. Switch with `/language`
(also `/lang`, `/bahasa`) or ⚙️ Settings → 🌍 Language; the choice is stored on the
user record and applies to the welcome, both trade flows, receipts and every error
message. Copy lives in `i18n.js`, both languages side by side — `i18n.test.js`
fails the build on a key that exists in one language but not the other, or on a
translation that drops a `{placeholder}` the English line fills.

## Execution speed

Latency is dominated by things that are not the chain, so they are tuned in one
place and documented in `.env.example` under **Execution speed**:

- **Receipt polling.** ethers looks for new blocks every 4000ms by default, which
  is how late `tx.wait()` notices a fill. Now per chain (250ms on Orbit/Arbitrum,
  400ms on Base/BNB, 1000ms on Ethereum) — measured against a mock node at 300ms
  block time, that is **4274ms → 506ms** to see a confirmed transaction.
- **Request batching.** `batchMaxCount:1` made every parallel read its own HTTP
  request; a six-call preflight went from **6 requests to 1**. Robinhood Chain is
  deliberately excluded (its node mis-frames single-call errors already).
- **Parallel preflight.** Balance, curve lookup, gas price and the pre-trade token
  balance are read together instead of one after another, and token metadata is
  prefetched alongside the trade rather than after the fill.
- **The bot fee is off the critical path.** It is broadcast and confirmed in the
  background; the referral share is still credited only once it lands. The fill
  no longer waits on a second confirmation the trader has no stake in.
- **Immutable reads are cached** — token name/symbol/decimals, curve address,
  graduation (one-way), native-transfer gas limits, the USD spot price.
- **Gas priority is real on every chain.** `gasOverrides()` used to return `{}`
  for everything except Robinhood, which silently discarded both the user's
  ⛽ Fast/Turbo setting *and* the sell retry escalation — a sell that failed
  because the gas was too low retried twice more at exactly the same gas.
- **EIP-1559 (type-2) on chains that support it.** Every write used to be signed
  legacy `type: 0` at the node's current `gasPrice`, i.e. with no headroom: a base
  fee that ticked up between signing and inclusion left the trade sitting in the
  mempool. `maxFeePerGas` now carries 2x base-fee headroom (free — you still only
  pay base + tip) while the boost scales `maxPriorityFeePerGas`, the part that
  actually competes for inclusion. Robinhood keeps the type-0 its node accepts.
- **The transaction is shown the moment it is broadcast.** Waiting for a receipt
  before saying anything meant a 12s Ethereum block was 12s of a static
  "Buying…" line. A live explorer link now appears in about half a second and is
  replaced in place by the receipt:

  | chain | user sees the tx | receipt | receipt *before* |
  |---|---|---|---|
  | Robinhood / Arbitrum | 0.5s | 0.9s | 9.9s |
  | Base | 0.5s | 2.5s | 9.9s |
  | BNB Chain | 0.5s | 3.5s | 9.9s |
  | Ethereum | 0.5s | 12.7s | 26.2s |

  Ethereum's remaining 12s is one block — that part is the chain, not the bot.
- **Solana confirmation no longer rides a websocket.** `web3.js`'s
  `confirmTransaction` races a WebSocket `signatureSubscribe` against a ~60s
  blockheight-expiry timer, and makes exactly **one** HTTP status check — issued
  the instant the subscription is set up, before the transaction can possibly have
  landed, so it always finds nothing and is never repeated. The default RPC here
  (`api.mainnet-beta.solana.com`) throttles that socket. When it drops, a swap that
  confirmed on-chain in half a second is not noticed until the blockhash expires,
  and is then reported as *"broadcast but not confirmed"* — a minute late, with the
  user's tokens already bought. `solana.confirmSignature()` polls
  `getSignatureStatuses` over HTTP instead:

  | Solana buy | websocket healthy | websocket throttled |
  |---|---|---|
  | before | 2.6s | **61.3s, then reported as failed** |
  | after | 2.0s | **2.1s, confirmed correctly** |

  An on-chain revert is still a clean failure (callers may roll back budget); a
  timeout is still only *unconfirmed* (they must not).

## Security notes (custodial = high responsibility)

- **`WALLET_SECRET` is the crown jewel.** Set it once to a long random value and
  back it up offline. If it leaks, every user wallet is compromised; if it changes,
  existing wallets can't be decrypted.
- Keys are never logged and never written in plaintext. The store
  (`data/tradebot.json`) holds only ciphertext.
- **Off-site backups:** the rotating snapshots in `data/backups/` die with the
  VPS. Cron `scripts/backup-offsite.sh` (rclone or scp — see its header) every
  few hours, and keep `WALLET_SECRET` backed up separately offline — never in
  the same place as the store.
- Withdrawals require the user to type the destination — nothing leaves a wallet
  without an explicit user action.
- This is beta software holding real funds. Tell users to keep balances small.

## Files

| file | role |
|------|------|
| `core.js` | chain + custody + trading engine (EVM + Solana) + referrals |
| `chains.js` | multi-chain registry (EVM + Solana `kind:'svm'`) |
| `solana.js` | Solana adapter — keypairs, Jupiter swaps, SOL/SPL, DexScreener, pump.fun |
| `watchers.js` | snipe + copy + limit/TP-SL/alert background loops (EVM + Solana) |
| `tokeninfo.js` | rich token scan (price/liquidity/volume/safety aggregation) |
| `poolstrade.js` | pools.trade launchpad record — Robinhood Chain socials/volume/curve state. **Display metadata only**: trades are priced and routed from chain state in `core.js`, never from here. It does **not** make snipe work — see the launchpad preflight section |
| `scripts/robinhood-preflight.js` | read-only check of every launchpad/DEX address and interface on chain 4663 |
| `goplus.js` / `rugcheck.js` | token safety — GoPlus (EVM) / RugCheck (Solana) |
| `safety.js` | chain-aware safety dispatcher |
| `telegram.js` | Telegram UI (commands, inline buttons, flows) |
| `i18n.js` | user-facing copy in English + Indonesian (`/language`) |
| `index.js` | entrypoint |
