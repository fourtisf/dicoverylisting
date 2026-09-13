# Dexvra Telegram Bot

The Dexvra sales bot — sells and fulfils **Xpress Listing**, **Listing &
Trending** (Diamond → Bronze), **Trending** (3H–48H), and **Banner Ad**
packages. It verifies on-chain payment with a temp-wallet-per-order poll, writes
the resulting paid listing/booking into the Dexvra website (via its internal
API), and auto-posts to the Dexvra channels + X.

Runs as its **own process** (own `package.json`) alongside the Next.js web app.

## Architecture

```
Telegram user ──▶ bot (Telegraf, long-polling)
                    │  multi-step form → chain → PAYMENT (temp wallet + poll + sweep)
                    │
                    ├─▶ dexvra web app  POST /api/internal/listings   (approved listing)
                    │                   POST /api/internal/trending    (time-boxed slot)
                    │                   POST /api/internal/banners      (banner booking)
                    │                   POST /api/internal/upload       (logo/creative)
                    │      (Bearer INTERNAL_API_TOKEN — the web app stays the sole
                    │       writer of data/listings.json, no cross-process races)
                    │
                    ├─▶ @dexvralisting / @dexvraio / @dexvratrending   (Bot API posts)
                    └─▶ X @listingdexvra    every listing (paid + free auto),
                                            banner ads, and pump alerts quoting
                                            their listing tweet  (4 keys — see
                                            X-AUTOPOST.md; off until they're set)
```

Payment model (matches fourtisbot): the bot generates a **fresh receiving
wallet per order**, shows the address + amount, and on **Confirm** polls the
chain (~3s, up to 5 min) until the balance arrives, then **sweeps** to your
treasury and activates the purchase. Supported chains: Solana, BSC, Ethereum,
Base, Robinhood, Tron, TON.

> Security note: unlike the reference bot, temp-wallet private keys are stored
> **only** on disk under `.keys/` (AES-256-GCM encrypted when `WALLET_ENC_KEY`
> is set) — never dumped to a Telegram channel. Set treasury addresses so funds
> don't accumulate in temp wallets.

## Run

```bash
cd bot
cp -n .env.example .env   # -n so a live box's existing .env is never clobbered
npm install
npm run check             # boot-wiring smoke test (no network)
npm run rpc:check         # do the chain RPC endpoints answer from this server?
npm run x:check           # is X auto-posting configured + do the keys work?
npm start                 # node main.js (long-polling)
```

`INTERNAL_API_TOKEN` must equal the web app's value (see the root `README.md`).
The bot must be an **admin** in all three channels.

**[`KEYS.md`](KEYS.md)** is the full audit of every credential: what is
required, what each optional key unlocks, and — the part that costs time — what
degrades *silently* without it. Short version: only `BOT_TOKEN` and
`INTERNAL_API_TOKEN` are needed, and **no paid market-data API key is used
anywhere** (GeckoTerminal, DexScreener and CoinGecko are all called keyless).

### Production (PM2, same VPS as the web app)

```bash
cd /path/to/dexvra/bot
pm2 start ecosystem.config.js && pm2 save
pm2 startup      # survive a reboot
```

`ecosystem.config.js` starts **both** processes — `dexvra-bot` and
`dexvra-adminbot`. Starting `main.js` by hand runs only the first, so the
template/banner editor is silently absent.

## Layout

| Path | Role |
|---|---|
| `main.js` | entry — dotenv, process guards, boot |
| `src/bot.js` | middleware chain, session, rate-limit, launch |
| `src/config/` | `chains.js` (registry), `constants.js` (env), `packages.js` (pricing mirror) |
| `src/api/dexvra.js` | internal-API client |
| `src/discovery.js` | every discovery source behind one seam — DexScreener + pools.trade |
| `src/dexscreener.js` | DexScreener feeds + token info (every chain but Robinhood) |
| `src/poolstrade.js` | pools.trade launchpad — Robinhood Chain, which DexScreener does not index |
| `src/handlers/` | `start`, `listing`, `trending`, `banner`, `text`, `menu`, `registry` |
| `src/group/` | group buy bot — pool resolver, per-transaction trades feed, delivery latch |
| `src/raid/` | Dexvra Raid — X metrics resolver, card, chat lock, runner, `/raid` panel |
| `src/payments/` | temp-wallet gen, balance poll, sweep, confirm handler (per-chain adapters) |
| `src/channels/` | Bot-API channel posting + post formatters |
| `src/twitter.js` | X posting — every post type (disabled unless keys present) |
| `src/services/` | trending poster, trending sweeper, pump checker |

## Admin bot & editable templates

Every user-facing message **and** channel-post layout is an editable template
(`src/templates.js`, built-in defaults). `@dexvraadminbot` (a separate process,
`ADMIN_BOT_TOKEN`) lets admins edit them + upload the `/start` banner image at
runtime — the main bot auto-refreshes within ~30s, **no redeploy**.

- Overrides persist in `data/templates.json` (gitignored); banner in `data/banner`.
- Admins only (`ADMIN_IDS` / `ADMIN_USERNAMES`), private chat.
- Editable: Welcome, all prompts, payment card, success/error messages, and the
  Listing / Trending / Pump / Banner **channel-post layouts** (with
  `{placeholder}` substitution — the editor shows each template's placeholders).
- Run it: `pm2 start ecosystem.config.js` starts both `dexvra-bot` and
  `dexvra-adminbot`. Then DM `@dexvraadminbot` → `/start`.

See [`.env.example`](.env.example) for every setting.

## Premium (custom) emoji on the trending board

The pinned **Dexvra Trending** board renders its rank numbers 1️⃣–9️⃣ and the
Solana / BSC / Ethereum / Base / Tron / Plasma / Sui logos as **Telegram premium
custom emoji** — built in, no admin setup (`src/config/premiumEmoji.js`).

Two things have to be true for them to actually animate in the channel:

1. **A Telegram Premium USER account posts the board.** Regular bots cannot send
   custom emoji — Telegram strips them silently and viewers see only the plain
   fallback char. So the board goes out over GramJS/MTProto:
   `node scripts/gramjs-login.js` once on the server (needs `API_ID`/`API_HASH`
   from [my.telegram.org/apps](https://my.telegram.org/apps)), logged in with an
   account that **has Telegram Premium** and can post in `@dexvratrending`.
   Run it on its own — it asks for phone → code → 2FA one at a time, and the
   code arrives as a Telegram **message**, not an SMS. The script is quiet by
   default (`--verbose` for the full GramJS connection log): Telegram migrates
   the login to the account's home DC right after the code is requested, which
   times out GramJS's keep-alive ping and prints a scary
   `TIMEOUT` / `AUTH_KEY_UNREGISTERED (caused by users.GetUsers)` wall. That is
   harmless — the session simply isn't bound to a user until you enter the code
   — but it used to bury the prompt and made people ctrl-C a working login.
   It ends by telling you whether the account has Premium.
2. **The viewer's own client**: non-Premium viewers always see the fallback
   emoji. That is Telegram's behaviour, not a bug.

**Diagnosing "it's still plain unicode":** DM `@dexvraadminbot` → `/premium`
(or 🔥 Trending board → 💎 Premium status). It names the actual cause —
no session / revoked session / **account isn't Premium** / can't post in the
channel — instead of a generic "not connected".

Behaviour when premium isn't available: the board still publishes, just with the
fallback emoji, and it **upgrades itself** to premium on the next cycle once the
account is fixed (no restart, no duplicate board). If Telegram refuses the emoji
mid-flight the same message is re-sent without them over the same transport, so
the channel never ends up with two boards.

**Customising:** 🔥 Trending board in the admin bot — tap a rank or a chain and
send an emoji. Send a *premium* emoji and that slot becomes premium (it's stored
as `[fallback](emoji/<id>)`). A plain emoji that has a known premium twin is
promoted automatically (`PREMIUM_EMOJI_PROMOTE=0` to disable). Markers:
💎 premium · ✅ your plain emoji · ▫️ built-in default. "↩️ Restore premium
defaults" clears every override.

## Force post (see a post without waiting for the event)

Every channel post normally fires on a real event — a paid order, a rank change,
a pump — so checking a template or a freshly uploaded clip meant waiting for one.
`@dexvraadminbot` → **🚀 Force post to channel** publishes any type on demand:
Xpress listing · Listing + Trending · Trending · Rank-up · Pump · Banner ad.

It runs the production path (same template, same banner/clip, same layout) and
builds the post from your newest **approved** listing, so it carries a real logo,
price and links. It is a **public** post — the confirm screen names the exact
channels, and the result card links each message so you can delete a test.

The admin bot only *queues* the request (`data/forcepost/`); the **main** bot
publishes it within ~3 s. That split is deliberate: `@dexvraadminbot` isn't a
channel admin, and a second GramJS client on the same session would risk
`AUTH_KEY_DUPLICATED` and revoke the premium login. A request the main bot never
picks up **expires after 5 minutes** rather than surprising the channel later.

## Top Gainers banner (`@dexvraadminbot` → 📊 Banner Top Gainers)

Generates a premium banner of the **live 24h top movers** across every Dexvra
listing and posts it to a channel — the fourtis "gainers banner" idea, rebuilt
here with no designed JPGs and no Python: every pixel is drawn by
`src/gainersBanner.js` with `@napi-rs/canvas`.

**They are drawn as dexvra.io, not as a crypto flyer.** The banners use the site's
own design tokens (`helpers/canvasKit.js → SITE`, copied value-for-value from
`globals.css`): the `#090C12` page under its mint and violet blooms, `#101624`
cards with hairline borders, the real logo mark from `components/Logo.tsx`, the
site's two typefaces — **Space Grotesk** for display and **JetBrains Mono** for
every stat and wide-tracked micro-label — and the board's own change pill drawn
to the `.chg.up` spec. No glowing titles, no metallic medallions, no sparkles:
someone who knows the site should recognise the artwork before reading a word.

**Six layouts:**

| id | layout | slots |
|---|---|---|
| `hero1` | 👑 #1 Spotlight — one hero card, the move as the headline | 1 |
| `podium` | 🏆 Top 3 Podium — three tall cards, the winner raised | 3 |
| `cards4` | 🃏 Top 4 Cards — 2×2, identity left / the move right | 4 |
| `list5` | 📋 Top 5 List — the board itself, with real columns (the default) | 5 |
| `rail8` | 🎞 Top 8 Rail — two columns of four | 8 |
| `grid10` | 🔟 Top 10 Grid — two compact columns of five | 10 |

See them without a bot token: `node scripts/gainers-preview.js` writes all six to
`/tmp` from sample data (`--live` uses the real sources, `OUT_DIR=…` to redirect).

**The data is real, or there is no post.** `src/gainers.js` reads the site board
(`/api/tokens` — the exact rows dexvra.io shows) and keeps only rows marked
`source: "live"`, so the site's demo/seed listings (real addresses, frozen
figures) can never reach a channel. If the web process is unreachable it prices
the approved listings itself via `marketdata.fetchMarket`. A token with no live
24h change is **left off**, absurd pool percentages (>5000%) are dropped, and a
day where nothing qualifies posts **nothing** — with the reason shown in the
panel. The layout follows how many real gainers there are (three movers on the
Top-5 layout draws three rows, titled "TOP 3 GAINERS"), so a thin day never
publishes empty slots.

**In the panel:** pick a layout → preview the real artwork *and* the exact
caption → **📤 Post to channel**. Also there:

- **✏️ Swap a token** — replace any slot with a contract address / dexvra.io /
  DexScreener link. Its live 24h change is required, so a hand-picked slot can't
  become a made-up number; the re-render is labelled as no longer purely the live
  ranking.
- **📡 Check live data** — what each source returns and how many rows pass the
  filters, without rendering anything.
- **⚙️ Settings** — target channel, default layout + 🎲 random rotation, daily
  auto-post time & timezone, minimum gain %, minimum liquidity, date line, market
  cap in the caption, pin, and a custom **background artwork** upload.

The **caption is a template** like every other post — edit it under
📢 Channel Posts → *"Post: Top Gainers banner"*. Its `{list}` placeholder is the
ranked block, and each rank badge is the same one the trending board uses, so a
premium emoji set there animates here too.

**Daily auto-post is OFF until you turn it on** (a deploy must never start
posting to a public channel by itself). Once on, `services/gainersPoster.js`
posts once per local day at the configured `HH:MM`; the day is claimed *before*
the send, and released again if nothing was published, so a failure retries and a
success never double-posts.

Same two-process split as force post: the admin bot renders and queues
(`data/gainerspost/`), the **main** bot publishes within ~3 s. A job the main bot
never collects **expires after 10 minutes** — a stale leaderboard posted an hour
late is worse than no post.

## Go-live checklist

1. **Web app**: set `INTERNAL_API_TOKEN` (≥24 chars) in the Next app's `.env.local`
   and restart it (`pm2 restart dexvra --update-env`).
2. **Bot `.env`**: same `INTERNAL_API_TOKEN`; set `BOT_TOKEN`; point
   `DEXVRA_API_BASE` at the Next app (default `http://127.0.0.1:3005`).
3. **Treasuries**: set `TREASURY_EVM` / `TREASURY_SOL` / `TREASURY_TRON` /
   `TREASURY_TON` so funds sweep out of temp wallets. Set `WALLET_ENC_KEY`
   (`openssl rand -hex 32`) to encrypt stored keys at rest.
4. **Channels**: make the bot an **admin** in `@dexvraio`, `@dexvratrending`,
   `@dexvralisting`.
4b. **Premium emoji** (trending board): `node scripts/gramjs-login.js` with a
   **Telegram Premium** account that can post in those channels, then verify with
   `/premium` in `@dexvraadminbot`. Skipping this only costs the animation — the
   board still posts with plain fallback emoji.
5. **Admins**: add your Telegram id to `ADMIN_IDS` (admins pay 0 — use the free
   test order to verify listing → post end-to-end without spending).
6. **X auto-posting**: paste the 4 OAuth 1.0a keys — `X_API_KEY`,
   `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` — from
   console.x.com → your app → *Keys and tokens*, with app permissions set to
   **Read and write before** the access token is generated. Verify with
   `npm run x:check`. Full walkthrough + troubleshooting:
   [`X-AUTOPOST.md`](X-AUTOPOST.md). Leave the four blank to keep X off.
6b. **RPC**: `npm run rpc:check`. Every chain ships with a list of keyless
   public endpoints and a read walks the list until one answers. **One sweep
   uses one node** — whichever answered its opening balance read — and never
   re-broadcasts to a second, so every url you list must be a node you trust to
   *send*, not only to read. The defaults are shared with the whole internet and
   rate-limit by IP; put a paid endpoint in `RPC_<CHAIN>` (or a full list in
   `RPC_<CHAIN>_URLS`) before you take real volume. Details in
   [`KEYS.md`](KEYS.md).
7. `npm run check` → `npm run rpc:check` → `npm test` → `npm start`.
8. **Security**: rotate the bot token in @BotFather if it was ever shared, then
   update `.env`.

## Group tools — Buy Bot & Raid

Both are free, both run inside a project's own Telegram group, and both are
reachable from the main menu (**🤖 Buy Bot & Raid for your group**).

### Buy Bot — a transaction, or nothing

`/settoken <CA>` in the group and every on-chain buy posts an alert carrying the
**actual transaction hash and buyer address**, read from GeckoTerminal's
per-pool trades feed (`src/group/gtTrades.js`).

There is **no estimated fallback**. When the feed cannot be read the bot posts
nothing and logs why. A volume-diff estimator used to cover that gap — "≈ $340
across 11 buys", with a line apologising for having no transaction to link — and
it was removed because it was not covering anything: the cursor only advances on
a poll that worked, so those buys still post individually, each with its hash,
on the first poll that succeeds within `MAX_ALERT_AGE_MS` (30 min). The estimate
was pre-empting good alerts with a worse version of the same news and then
*suppressing* them, since an estimate has no hash for the dedupe latch to work
with. A two-minute rate-limit cooldown was enough to cost a group its verifiable
alerts for good.

What survives from that design is the one distinction that still matters:
`fetchPoolBuys()` resolves `null` when the feed is *unavailable* and `[]` when
the feed *answered and the pool is quiet*. The first means stay silent and try
again; the second means stay silent and advance the cursor.

GeckoTerminal's free tier is ~30 requests/minute for the whole process and a 429
arms a two-minute process-wide cooldown, so a busy deployment can go quiet for
reasons that have nothing to do with the pools. Set `GECKOTERMINAL_API_KEY` to
raise that ceiling; the client switches to the Pro base URL on its own.

Four rules that look like details and are not:

- **Direction comes from the token addresses, never GeckoTerminal's `kind`.**
  `kind` is relative to the pool's *base* token, so on a pool where the tracked
  token is the quote side, `kind:"buy"` means our token was **sold** — a green
  buy alert on every dump.
- **Multi-hop swaps are merged by transaction hash before alerting.** Un-merged,
  a $120 routed buy posts as "$40" and the other legs vanish into the dedupe.
- **The dedupe budget is spent only after Telegram returns a `message_id`**
  (`src/group/alertLatch.js`). A short claim stops two overlapping polls
  double-sending; the hour-long latch is written on success. One 429 must never
  mean the alert never posted *and* can never post again.
- **A dead group latches; a bad moment does not.** Fatal-vs-transient lives in
  exactly one file (`src/group/fatalChatError.js`) so no two pipelines can drift
  into retrying a chat the other already gave up on.

The alert itself:

```
🟢 NEW BUY — The Nietzschean Dog

🟢🟢🟢

💲 Spent: $48.97 (0.6646 SOL)
🪙 Received: 926,311.94 $RUSS
📊 Price: $0.00004823 · 📈 24h: +18.4%
🏦 Market cap: $46.5K · 💧 Liquidity: $183.5K
👤 Buyer: AFqu1M…jcBb · View txn
💼 Position: 1,980,000 $RUSS · $95,523 (+3.82%)

⚡ Trade on Dexvra · 📈 Chart · 🔥 Trending
```

**`💼 Position` is who bought, not just how much.** Under the buyer's address:
how much of the token that wallet holds *after* this trade, what it is worth
at the pool price, and how much this buy grew it — `(new position)` on a
first-ever buy rather than an invented `+100%`. It answers the question the
address alone cannot: is this someone building, or someone passing through.

It is the **same on-chain read the whale check already does**, so it costs no
extra RPC call — the holding is a property of the wallet, looked up once per
buy and shared by every group watching that pool. The row therefore appears
under exactly the conditions that lookup happens: a supported chain, a buy
over `BUYBOT_WHALE_CHECK_MIN_USD`, and whale detection left on. Miss any of
those and `{wallet}` is empty and **the whole row vanishes** — emoji and label
with it, because a dangling `💼 Position:` is not a row, it is a rendering
bug. `/setwhale off` therefore drops this row too: reading the holding is the
cost of both features, so it is one lever, not two.

This is **deliberately not** the layout every copy-trading bot shares. Those
are icon-only rows joined by `|`, with a `<Brand>Trending | Chart` footer —
adopt it and Dexvra reads as one more clone of the same card. The grammar
here is the one the listing post already uses: **Label:** value, joined by
`·`, with a bracketed CTA row, so a reader who knows one Dexvra surface
knows the other.

The header word is the size tier (`NEW BUY` / `WHALE BUY` / `MEGA BUY`,
thresholds in `.env`, wording in `group_buy_tiers`), and the row below it
grows with the buy — one icon per `BUYBOT_EMOJI_STEP_USD`, floored at 3 and
capped at 16 so it never wraps.

It is a ROW and not a fill-meter on purpose. A meter renders the part that
is *missing*, so a real buy comes out as `▰▱▱▱▱▱▱▱▱▱` and reads like
something failed rather than like something good happened — a buy alert
must never look like that. Change the icons with `group_buy_style`
(`buy|whale`, default `🟢|🐋`).

Two figures there are easy to get subtly wrong, so they are worth stating:
the **native amount** is the token the buyer actually spent, read from the
trade — not `usd ÷ nativePrice`, which is invented precision that disagrees
with the transaction linked directly beneath it, and it is omitted entirely
when the counterparty was not the native coin or a routed swap paid in
several. **Price and market cap both come from the pool**, so the card
cannot contradict itself the way an effective trade price beside a pool
market cap does.

### 🐋 Whale wallets

A second alert class, keyed on **who bought**, not on how much they spent:

```
🐋 WHALE WALLET — The Nietzschean Dog

🐋🐋🐋🐋🐋🐋🐋🐋🐋🐋🐋🐋🐋🐋🐋🐋

💲 Spent: $804.72 (10.7568 SOL)
🪙 Received: 51,874.15 $RUSS
💰 Holds: 1,980,000 $RUSS · $95,523
📈 Position: +3.82% · 🎯 Whale bar: $50,000
📊 Price: $0.00004823 · 🏦 Market cap: $15.5M
👤 Buyer: AFqu1M…jcBb · View txn

🐋 A wallet this size adding to its position is conviction, not noise.

⚡ Trade on Dexvra · 📈 Chart · 🔥 Trending
```

A $200 top-up from someone sitting on $80k is news in a way a $200 buy from
a fresh wallet is not — so the bar is the buyer's **holding**, and it
resolves in three layers, most specific first:

| Layer | Where | Scope |
| --- | --- | --- |
| `/setwhale 50000` | in the project's own group | that group |
| ⚙ **Batas whale** | @dexvraadminbot → 🎨 Gambar Banner Channel → 🐋 Whale Alert | every group with no preference |
| `BUYBOT_WHALE_WALLET_USD` | `.env`, default **$50,000** | the shipped fallback |

Each group judges the shared holding against **its own** bar. Two groups on
one pool with different bars used to get one verdict computed for whichever
was listed first; the same buy is now a whale to the group that set $5,000 and
an ordinary buy — with the 💼 Position row — to the one that set $25,000.

The admin-bot layer is read **fresh on every check** — deliberately, because
the admin bot runs as its own process, so a cache in the main bot would
never see the operator's change at all. Move the bar and the very next buy
is judged against it, with no restart. The same screen carries the dust
floor (buys under it never cost an RPC lookup) and an on/off switch for the
whole class. Typed input takes `50000`, `$50,000` or `50k`, and is clamped
to $100–$100M so one stray zero cannot turn every buy into a pinned whale
or silence whales entirely.

`{whaleBar}` on the card prints **the bar that wallet actually cleared** —
the group's own if it set one, otherwise the global. It is a placeholder and
not the literal `$50,000` precisely because either can move, and a card
stating the wrong entry condition is worse than one stating none.

These are **pinned**, each replacing the last, which is the point of
separating them; ordinary buys never are, because a pin per buy is not a
highlight, it is a scrollbar. `/buybot pin off` opts out.

**"Holds" is deliberately not "Wallet Balance".** It is the buyer's balance
of *this token* at the pool price, read on chain. This bot has no portfolio
API, so a label promising a total would be a wrong number presented as a
right one — and the signal a group actually wants (is this a big holder of
*our* token?) is exactly what the figure measures. `Position` is how much
the buy grew that bag; a first-ever buy says `new position` rather than
inventing `+100%`.

Holdings are readable on Solana and every EVM chain in the registry. On
others, whale detection is skipped and buys alert normally — `/setwhale`
says so rather than silently doing nothing. Lookups cost one RPC call,
gated behind `BUYBOT_WHALE_CHECK_MIN_USD` and cached per wallet for two
minutes, with misses cached briefly so a dead RPC cannot cost a timeout per
buy.

**A GIF or video above every alert** — upload it in @dexvraadminbot →
🎨 Gambar Banner Channel. Three slots, used by every group, with the
transaction details as the caption:

| Slot | Plays above |
| --- | --- |
| 🟢 **Buy Bot** | every ordinary buy alert |
| 🐋 **Whale Alert** | every 🐋 WHALE WALLET alert |
| ⭐ **GIF Default** | either of the above whose own slot is **empty** |

⭐ **GIF Default** is the only thing the two share. Want one house clip
everywhere? Upload it there once and you are done. Want a whale to look
different? Upload a whale clip too, and it wins.

What they still **never** do is borrow from *each other*: with a buy clip
set and no whale clip and no default, a whale alert posts as text — it does
not quietly play the buy clip. That is the point of having two slots at all,
since cross-borrowing would give both alerts identical artwork with only the
wording changed. The admin menu states which of the three cases you are in
rather than leaving you to find out in a customer's group.

Clips are resolved per send, so swapping one applies to the next alert with
no restart; leave all three empty and alerts are plain text, exactly as
before. A clip Telegram refuses costs the artwork, never the alert. Each is
stored like every other banner clip (`banner-media-buy.*`,
`banner-media-whale.*`, `banner-media-default.*`), which is what gets it into
the Mongo media mirror and through a container replace alive.

```bash
npm run buybot:check                              # a known-good pool
npm run buybot:check -- solana <token-address>    # your token
```

Grep pm2 logs for `trades feed unreadable` (why a pool is quiet, throttled to
one line per pool per 10 min), `GeckoTerminal backing off` (the process-wide
rate-limit cooldown — the usual reason several groups go quiet at once),
`no buy alerts this hour` (a configured group that has been getting nothing),
and `is unreachable` for a group that removed the bot.

### Raid — rally the chat behind one X post

`/raid` opens an admin panel: set goals (**+15 likes**, **+5 replies**,
**+10 crew**), paste the post, launch. One card is posted and kept updated, and
optionally the chat is locked until the targets are met.

**The X API is optional.** The 🤝 **Crew** goal counts everyone who shows up in
the chat while the raid is live — no key, no plan, no quota — so:

- crew goal only → X is never called at all;
- X goals but X refuses → the raid launches crew-only, and *re-arms itself* if
  X starts answering mid-raid;
- X goals and no crew goal → the launch is refused, with the way out in the
  message.

Worth being precise about the cost, because it is the thing people get wrong: an
X API bill is a toll on **reading X's database**, not rent on your own account —
the post's author is not involved. Since X moved to pay-per-use, reads are
$0.005 each, **deduplicated per post per 24h UTC window**, so a 60-minute raid
polling every 30s bills as roughly **one read (≈ $0.005)**. The binding
constraint is the app-level rate limit, not money; if you hit it, raise
`RAID_POLL_SEC`.

Two keyless sources exist and both ship **off**: `RAID_FREE_METRICS` (X's embed
endpoint — likes and replies, cannot see reposts, and its reply figure is the
whole conversation so it disagrees with the number X prints on the post) and
`RAID_GUEST_METRICS` (X's internal GraphQL with an anonymous guest token — the
only free route to a repost count). **They are not independent fallbacks**: both
are gated by X's IP reputation, so a datacenter block takes them out together.
The genuinely independent paths are the paid token and the Crew goal.

The one part that can hurt a customer is the chat lock, so it is built around
that: the chat's current permissions are snapshotted and **written to disk
before anything is touched**, the deadline (`expiresAt`) is durable so a boot
sweep frees a group whose process was killed mid-raid, `finishRaid()` is the
only exit door because it is the function that unlocks, and a failed unlock
deliberately leaves `locked: true` so the next sweep retries.

```bash
npm run raid:check                       # which X source answers from this server
npm run raid:check -- <post-url>
```

Grep pm2 logs for `[raid]` — `started`, `completed`, `expired`, `locked group`,
`unlocked group`, `UNLOCK FAILED`, `boot recovery`, `X came back`.

All raid and buy-alert copy is admin-editable in `@dexvraadminbot`
(**🤖 Group Buy Bot** and **🚀 Dexvra Raid**), including the bar characters via
`raid_style`.

## Tests

```bash
npm run check     # boot-wiring smoke (no network)
npm test          # unit tests (pricing, units, chains, formatting, cards)
npm run rpc:check # which chain RPC endpoints answer from this server
```

