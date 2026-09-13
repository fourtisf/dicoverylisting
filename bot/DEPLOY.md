# Deploying Dexvra (web internal API + Telegram bot)

The bot runs as its **own PM2 process** on the **same VPS** as the Dexvra Next.js
app (so it can reach the internal API on `127.0.0.1`). Two things ship together:

1. **Web app** — new `/api/internal/*` routes + trending-expiry + banner store
   (already on the branch). Needs `INTERNAL_API_TOKEN` + a rebuild/restart.
2. **Bot** — the new `bot/` process. Needs its `.env` + `npm install` + PM2.

Everything is on `main` once the working branch is merged. To deploy a feature
branch directly, check out that branch by name — `git branch -r` lists what
actually exists on the remote.

---

## 0. Prereqs (on the server)

- Node.js ≥ 18, `pm2` (`npm i -g pm2`)
- The Dexvra web app already deployed (e.g. PM2 name `dexvra`, port `3005`)
- The bot is an **admin** in `@dexvraio`, `@dexvratrending`, `@dexvralisting`

## 1. Generate the shared internal token (once)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use this **same value** for `INTERNAL_API_TOKEN` in BOTH the web `.env.local`
and the bot `.env`.

## 2. Get the code on the server

**If you merged to `main`** (recommended):
```bash
cd /path/to/dexvra
git fetch origin && git checkout main && git pull
```

**Or deploy a branch directly** (check `git branch -r` for the name):
```bash
cd /path/to/dexvra
git fetch origin && git checkout <branch> && git pull
```

## 3. Web app — enable the internal API

```bash
cd /path/to/dexvra
# add to .env.local (gitignored):
#   INTERNAL_API_TOKEN=<the value from step 1>
npm ci
npm run build
pm2 restart dexvra --update-env       # --update-env picks up the new token
```

**First time on this box** there is no `dexvra` process to restart yet, and
`next start` binds **3000** while the bot polls **3005** (`DEXVRA_API_BASE`).
Nothing in Next reads a port from a config file, so set it on the process:

```bash
PORT=3005 pm2 start npm --name dexvra -- run start
pm2 save && pm2 startup      # pm2 startup makes it survive a reboot
```
Verify (should be 401 without the token, 200 with it):
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3005/api/internal/listings
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" \
  http://127.0.0.1:3005/api/internal/listings
```

## 4. Bot — configure + start

```bash
cd /path/to/dexvra/bot
cp -n .env.example .env   # -n = never clobber: on a box that is already live,
                          # .env holds the only copy of your tokens and it is
                          # gitignored, so a plain `cp` destroys them silently
npm ci
npm run check             # boot-wiring smoke (no network)
npm run rpc:check         # do the chain RPC endpoints answer from THIS server?
npm test                  # unit tests
pm2 start ecosystem.config.js && pm2 save
pm2 logs dexvra-bot       # watch it come up
```

Minimum `.env` values:
```
BOT_TOKEN=<@BotFather token>
INTERNAL_API_TOKEN=<same value as the web app>   # >= 24 chars or the API 401s
BOT_USERNAME=<your bot's @handle, no @>          # NOT derived from BOT_TOKEN
DEXVRA_API_BASE=http://127.0.0.1:3005
SITE_URL=https://dexvra.io
ADMIN_IDS=<your numeric Telegram id>          # admins pay 0 → free end-to-end test
LOG_CHANNEL=<a private channel id>            # without it every failure below is invisible
ANNOUNCE_CHANNEL=@yourchannel                 # the defaults are the ORIGINAL operator's
TRENDING_CHANNEL=@yourtrending                #   channels — your bot is not admin there,
LISTING_CHANNEL=@yourlisting                  #   so posts fail with one WARN and no post
GROUP_CHAT=                                   # EMPTY turns the mirror off (omitting the
                                              #   line entirely gets @dexvragroup)
WALLET_ENC_KEY=<openssl rand -hex 32>          # encrypt stored temp-wallet keys
TREASURY_EVM=<0x… for eth/bsc/base/robinhood>
TREASURY_SOL=<solana address>
TREASURY_TRON=<tron address>
TREASURY_TON=<ton address>
```

> `BOT_USERNAME` is the one people miss. Nothing calls `getMe`, so the value is
> used verbatim to build the "➕ Add to your group" link and the `{bot}` mention
> in every template and channel post. Leave it at the default with a differently
> named bot and you are advertising somebody else's.
Leave a `TREASURY_*` blank to skip the sweep for that chain (funds then stay in
the per-order temp wallet under `.keys/`, recoverable — set them before real
volume). Leave the four `X_*` keys blank to keep X posting off; fill them in
and every listing is tweeted too — see [`X-AUTOPOST.md`](X-AUTOPOST.md), then
verify on the server with `npm run x:check`.

RPC endpoints are optional — every chain has keyless public defaults and a read
walks them until one answers. One **sweep** uses one node (whichever answered
its opening balance read) and never re-broadcasts to a second, so every url you
list must be a node you trust to *send*. Run `npm run rpc:check` on the server
and put a working (ideally paid) endpoint in `RPC_<CHAIN>`. Full credential
audit: [`KEYS.md`](KEYS.md).

## 5. Smoke-test end to end (free, no spend)

With your id in `ADMIN_IDS`, DM the bot `/start` → ⚡ Xpress Listing → pick a
chain → send a real contract address → Confirm. As an admin the amount is 0, so
it activates immediately: the listing should appear on the site and a post
should land in `@dexvralisting`.

## Update later — the standing release flow

**The server runs `main`, and only `main`.** Work happens on a branch; the
branch is merged to `main` before anything is deployed. A server left sitting
on a feature branch is the failure this rule exists to prevent — the next
change is cut from `main`, the two diverge, and nobody notices until a deploy
quietly reverts a fix.

The repo lives at **`/opt/dexvra`** on the production box. Run one step at a
time and read the output; do not paste the whole block.

**1 · Merge first (on your machine, not the server)**

```bash
git checkout <branch> && cd bot && npm test    # green BEFORE the merge
cd .. && git checkout main && git pull
git merge <branch> && git push origin main
```

**2 · Pull on the server**

```bash
cd /opt/dexvra && git status          # must be clean — stop here if it is not
cd /opt/dexvra && git checkout main && git pull
```

**3 · Verify before restarting anything**

```bash
cd /opt/dexvra/bot && npm test        # ~930 tests, all must pass
cd /opt/dexvra/bot && npm run check   # boot-wiring smoke, no network
```

`npm ci` is only needed when `package.json` changed. It is not free — it wipes
and rebuilds `node_modules`, including the native canvas binding.

**4 · Restart**

Bot-only change (nothing outside `bot/` in the diff):

```bash
cd /opt/dexvra/bot && pm2 restart ecosystem.config.js --update-env && pm2 ls
```

Web app touched as well:

```bash
cd /opt/dexvra && npm ci && npm run build && pm2 restart dexvra --update-env
cd /opt/dexvra/bot && pm2 restart ecosystem.config.js --update-env && pm2 ls
```

Check which you need before you rebuild — a Next build on a live box costs
minutes for nothing when the change never left `bot/`:

```bash
cd /opt/dexvra && git diff --name-only HEAD@{1}..HEAD | grep -v '^bot/'
```

Empty output means bot-only.

**5 · Confirm**

```bash
pm2 ls                                # dexvra-bot AND dexvra-adminbot: online
pm2 logs dexvra-adminbot --lines 40   # Ctrl+C to exit
```

> Restart via **`ecosystem.config.js`**, not `pm2 restart dexvra-bot`. This
> directory runs TWO processes — `dexvra-bot` (main.js) and `dexvra-adminbot`
> (adminbot.js) — and naming only the first leaves the admin bot on the old
> code after every deploy. It fails silently and confusingly: the main bot
> shows a new feature working while @dexvraadminbot has no editor entry for it,
> which reads as "the template is missing" rather than "that process is stale".
> Confirm both came back with `pm2 ls` before you call the deploy done.

> **Shipping new default copy?** A template an admin has edited in
> @dexvraadminbot is stored in `data/templates.json` and **wins over the code
> default**, so the new wording will not appear on this box until someone opens
> that template and taps **♻️ Reset default**. Per template — the
> "♻️ Reset ALL templates" button throws away every other edit too.

## Rollback

```bash
pm2 stop dexvra-bot dexvra-adminbot   # bots only — the site keeps running
# revert web: git checkout <previous main commit> && npm ci && npm run build && pm2 restart dexvra
```

## Notes

- `.env`, `.keys/`, `data/` are gitignored — they live only on the server and
  survive `git pull`. Back up `.keys/` (temp-wallet keys) if any order hasn't
  swept yet.
- Redis is **not** required. MongoDB is optional but strongly recommended — see
  below. Without it the bot runs exactly as it always has, on local JSON files.

## Backup and recovery — `data/` is the only copy

`data/` is gitignored, lives only on the server, and holds things that took real
human effort to create and that nobody remembers well enough to redo:

| File | What is in it |
| --- | --- |
| `templates.json` | every message an admin reworded in @dexvraadminbot — **including the premium emoji they pasted**, stored as text + entities |
| `tokenemoji.json` | the `custom_emoji_id` of the animated pack minted for each paid listing |
| `groups.json`, `orders.json`, … | group buy-bot config, paid orders, dedup latches |

The emoji **packs** live on Telegram's side and survive this VPS. What does not
survive is the mapping — which id belongs to which token, and which emoji sat in
which position in which template. That mapping is these two files.

### Turn the mirror on

Set `MONGO_URI` in `bot/.env` (MongoDB Atlas free tier is enough — the whole
store is well under a megabyte), then restart:

```bash
cd /opt/dexvra/bot && pm2 restart ecosystem.config.js --update-env
```

Turning it on late costs nothing: boot seeds the mirror from whatever is already
on disk. Optional: `MONGO_DB` if the URI has no default database,
`MIRROR_SWEEP_MS` to change how often the bot re-checks that the mirror is
current (default 5 min, `0` disables).

### Check it is really backed up

```bash
cd /opt/dexvra/bot && npm run backup:check
```

It prints every store as **in sync** / **STALE IN MONGO** / **NOT MIRRORED**,
and counts the premium emoji it can see on disk versus in the mirror. Exit code
is non-zero when something is not backed up, so it works in a cron. To push
anything stale immediately instead of waiting for the sweep:

```bash
npm run backup:check -- --fix
```

Worth running once after any session where an admin edited templates.

### Recover onto a new server

Deploy normally, put the **same** `MONGO_URI` in `bot/.env`, and start the bots.
`persist.hydrate()` runs before any handler reads state and writes back every
store that is missing locally — templates, premium emoji, group config, the lot.
`mediaMirror.hydrate()` does the same for the banner clips and the premium
userbot session, so the GramJS login is recovered without a manual re-login.

```bash
cd /opt/dexvra/bot && pm2 restart ecosystem.config.js --update-env
pm2 logs dexvra-bot --lines 50 --nostream | grep '\[persist\] mongo hydrate'
```

The log line says how many stores were found, restored and seeded. `restored 0`
on a fresh box means nothing came back — check `MONGO_URI` before letting an
admin start re-typing templates.

**Hydrate never clobbers a file that is already there.** Disk wins for anything
present, so restoring onto a box that still has its `data/` is a no-op rather
than a rollback. To force a restore of one store, delete the local file and
restart.

`.keys/` (temp-wallet keys) is **not** mirrored — it is key material and stays
off the network. Back it up separately if any order has not swept yet.
