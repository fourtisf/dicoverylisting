# Dexvra Admin Panel — setup

The admin panel is served **only** on `dexvra.fun`, under a secret path, and is
protected by a username + password. It is invisible on the public site
(`dexvra.io`).

## 1. Generate secrets (on the VPS, in the app folder)

```bash
node scripts/gen-admin-secrets.mjs <username> '<password>'
```

Copy the printed block into `.env.local` (this file is gitignored):

```
ADMIN_USER=youradmin
ADMIN_PASS_HASH=scrypt:<32 hex>:<64 hex>
ADMIN_SESSION_SECRET=<64 hex chars>
ADMIN_PATH=admin-<32 hex chars>
ADMIN_HOSTS=dexvra.fun,www.dexvra.fun
```

The script prints your admin URL, e.g. `https://dexvra.fun/admin-<hash>`.
Keep `ADMIN_PATH` and the password private — the URL is the first line of
defense, the login is the second.

## 2. Point dexvra.fun at the app

Both `dexvra.io` (public) and `dexvra.fun` (admin) proxy to the same Next.js
app on port 3005. In your nginx server block for `dexvra.fun`:

```nginx
server {
    server_name dexvra.fun www.dexvra.fun;
    location / {
        proxy_pass http://127.0.0.1:3005;
        proxy_set_header Host $host;                 # required — the app checks the host
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    # (certbot adds the listen 443 / ssl_certificate lines)
}
```

Then issue a certificate:

```bash
sudo certbot --nginx -d dexvra.fun -d www.dexvra.fun
```

`proxy_set_header Host $host` is essential — the app decides admin-vs-public by
the `Host` header. `proxy_set_header X-Real-IP $remote_addr` is also required —
the login/submit rate limiters key on it (they deliberately ignore the
client-forgeable leftmost `X-Forwarded-For` hop).

## 3. Restart

```bash
pm2 restart dexvra --update-env    # --update-env picks up the new .env.local
```

Open `https://dexvra.fun/<ADMIN_PATH>` → log in.

## What the panel does

- **Pending submissions** — tokens submitted via the public "List Token" form
  land here; Approve puts them live, Reject hides them.
- **All listings** — change a token's tier (Diamond…Bronze/Xpress), toggle its
  Trending feature, unlist, or delete.
- **Pons launches · Robinhood** — tokens the Pons v2 factory has just launched,
  read straight off chain. Nothing here is listed yet; pick a tier and press
  **List it** to promote one, and the row is filled in from on-chain data
  (ticker, name, logo, price, market cap, creator tax). Dexvra stays
  paid-listing only — this only removes the copy-paste.
- **Add listing** — add a token directly (goes live immediately). Live market
  data (price, chart, trades) is fetched by contract address automatically.

Listings persist in `data/listings.json` (gitignored, survives restarts and
`git pull`). Public changes propagate within ~30s (the market cache TTL).

## Announcing Pons launches (optional, off by default)

**`bot/` already discovers and posts launches.** This section is only for a
deployment that wants the *web app* to post them instead — if the bot suite is
running, you almost certainly want to skip it.

It reads its own credentials, never the bot's, so turning it on cannot make a
box that runs both post everything twice. Add to `.env.local`:

```
PONS_ANNOUNCE_BOT_TOKEN=
PONS_ANNOUNCE_CHAT_ID=
CRON_SECRET=
```

Fill them in from three places, in this order:

1. `PONS_ANNOUNCE_BOT_TOKEN` — talk to **@BotFather** on Telegram, `/newbot`,
   and copy the token it replies with. Use a *different* bot from the one in
   `TELEGRAM_BOT_TOKEN`, so the two announcers stay separable.
2. `PONS_ANNOUNCE_CHAT_ID` — the channel's public @name, or the numeric id for
   a private one. Add the bot to that channel **as an administrator**; Telegram
   refuses posts from a plain member.
3. `CRON_SECRET` — generate one and paste the output. Write it **unquoted**:
   it is hex, it needs no quotes, and the cron line below reads the file with
   `cut` rather than a shell parser.

```bash
openssl rand -hex 32
```

Then restart and add the heartbeat. This line is complete as written — it
reads the secret out of the env file rather than expecting cron to know it,
because cron does not load `.env.local`:

```bash
pm2 restart dexvra --update-env
crontab -e
```

```
*/10 * * * * curl -fsS -H "Authorization: Bearer $(grep -m1 '^CRON_SECRET=' /opt/dexvra/.env.local | cut -d= -f2-)" https://dexvra.io/api/cron/pons >/dev/null
```

Check it by hand from the box:

```bash
curl -fsS -H "Authorization: Bearer $(grep -m1 '^CRON_SECRET=' /opt/dexvra/.env.local | cut -d= -f2-)" https://dexvra.io/api/cron/pons
```

The first run answers `{"ok":true,"posted":0,"initialized":true,...}` and posts
nothing — it adopts the current head so that switching this on never dumps the
backlog into the channel. Later runs answer `{"ok":true,"posted":N,...}`. After
that it posts at most `PONS_BOT_MAX_POSTS` (default 8) per run, oldest first,
and never repeats one: the markers live in `data/notify.json`.

Leave any of the three variables unset and every post is a silent no-op —
`/api/cron/pons` answers 503 without `CRON_SECRET` and 401 without a matching
one, so it is never callable anonymously.

## Deploying

The repo carries its own deploy script. Run it on the server — it derives the
repo root from its own location, so there is nothing to fill in:

```bash
bash /opt/dexvra/scripts/deploy.sh
```

Add `--with-bots` to restart `dexvra-bot`, `dexvra-adminbot` and
`dexvra-tradebot` as well as the web app.

It refuses to run on a dirty working tree, fast-forwards only, installs from
the lockfiles with `npm ci`, runs **both** offline test suites *before*
building — a red test stops the deploy while the old build is still the one
serving — and then restarts and verifies that the running server reports the
commit it just built. That last step is the point: a stale process answers
`200` perfectly well, so `200` is not the check.

## Notes on security

- Session is an HttpOnly, SameSite=Strict, Secure (in prod) signed cookie
  (HMAC-SHA256, 8h expiry). No session = no access.
- Login is rate-limited (6 tries / 15 min per IP).
- `/panel` and `/api/admin/*` return 404 on the public domain, and 404 if the
  secret path isn't used on the admin domain.
- `/api/cron/pons` returns 503 until `CRON_SECRET` is set, and 401 without it —
  it is never callable anonymously.
- Never commit `.env.local` or `data/`.
