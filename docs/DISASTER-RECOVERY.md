# Disaster recovery — Dexvra Trade Bot

> Read this **before** you need it. The one procedure here that cannot be
> improvised is the custodial wallet restore, and the only way to know it works
> is to have already run it.

---

## What is at stake

`@dexvratradebot` is **custodial**: it holds a private key for every user's
wallet. Those keys live in `tradebot/data/tradebot.json`, encrypted with
AES-256-GCM under a key derived from a single environment value:

```
WALLET_SECRET
```

That gives exactly two ways to lose every user's funds, and neither announces
itself:

| Failure | Consequence |
|---|---|
| `WALLET_SECRET` is **lost** | Every wallet is permanently unopenable. The funds exist on-chain and nobody can ever move them. Not recoverable by us, by Telegram, or by anyone. |
| `WALLET_SECRET` is **leaked** | Anyone holding it plus a copy of the store can drain every wallet. The store copy is easy to get — one sits in a Telegram channel. |

The store alone is harmless: it is ciphertext. The secret alone is harmless: it
opens nothing. **Keep them in separate places, and make sure you still have
both.**

There is a third failure that people forget: the secret is not lost, but the one
you *saved* is not the one that *encrypted the store* — rotated, mistyped,
copied with a trailing space, taken from the wrong host. That is
indistinguishable from a lost secret until you try it, which is what the drill
below is for.

---

## Where the secret lives

Fill this in for your deployment and keep it current. It is deliberately not
committed anywhere but here, in words, because a path is not a secret:

| Copy | Location | Who can reach it |
|---|---|---|
| Live | `/opt/dexvra/tradebot/.env` → `WALLET_SECRET` | root on the VPS |
| Offline #1 | _(password manager entry — name it here)_ | _(who)_ |
| Offline #2 | _(second location, different medium/place)_ | _(who)_ |

Rules that follow from the table above:

- **At least two copies, off the VPS.** One copy on the machine that can burn is
  not a backup. The VPS dying must not be an extinction event.
- **Never in git, never in a chat, never in a screenshot.** The store backup
  channel deliberately ships ciphertext *only* — do not "helpfully" put the
  secret there too, or the channel becomes the whole compromise in one place.
- **Never rotate it casually.** Changing `WALLET_SECRET` does not re-encrypt
  existing wallets; it makes them unreadable. There is no rotation procedure that
  is not a full migration, and there is currently no migration tool.

---

## What is backed up, and where

| Artefact | Where | Cadence |
|---|---|---|
| `data/tradebot.json` (ciphertext store) | Rotating local snapshots in `data/backups/` | On write, throttled ≥10 min, newest 72 kept |
| Same, gzipped | Private Telegram channel (`BACKUP_TG_CHANNEL`) | At most once a day |
| `WALLET_SECRET` | **Nowhere automatic — by design.** See the table above. | You, by hand |

The local snapshots protect against a corrupt write or a fat-fingered `rm`. The
Telegram archive protects against losing the box. Neither protects against
losing the secret; nothing can.

---

## Restore procedure

You need **the archive** and **the secret**. If you only have one, stop — the
rest of this page will not help, and guessing makes it worse (see the warning at
the end).

```bash
# 1. Get the archive off Telegram (or from data/backups/ if the box is alive)
#    and put it somewhere scratch.
cd /opt/dexvra/tradebot

# 2. VERIFY IT FIRST — never restore an archive you have not verified.
WALLET_SECRET='…' node scripts/restore-drill.js ~/tradebot-2026-07-26.json.gz

# 3. Only when the drill says ✅: stop the bot, put the file in place, start it.
pm2 stop dexvra-tradebot
gunzip -c ~/tradebot-2026-07-26.json.gz > data/tradebot.json
#    …and make sure WALLET_SECRET in .env is the one the drill just verified.
pm2 start dexvra-tradebot --update-env

# 4. Confirm: the bot should answer /start and show existing wallets with
#    their previous addresses. A wallet whose address CHANGED means the wrong
#    secret — stop immediately and go back to step 2.
```

Step 2 is not optional. Restoring an archive that turns out to be truncated,
after deleting the live one, is how a recoverable incident becomes a permanent
one.

---

## The drill

`scripts/restore-drill.js` answers the only question that matters: **does this
secret, with this archive, actually give back the wallets?**

It does not check that the file parses. It decrypts every stored key through the
bot's own production code path, derives the wallet address from that key, and
compares it to the address recorded beside it. If those match, the secret is
right and the ciphertext is intact — provably, per wallet.

```bash
cd /opt/dexvra/tradebot

# Against the live store (read-only; it works on a copy in a temp dir):
WALLET_SECRET='…' node scripts/restore-drill.js

# Against a downloaded archive — this is the real rehearsal:
WALLET_SECRET='…' node scripts/restore-drill.js ~/tradebot-2026-07-26.json.gz
```

It prints counts and addresses only — never a key, a seed, or the secret — so
the output is safe to paste into a chat. Exit code `0` means every wallet
verified; anything else means do not rely on that pair.

**Run it monthly, and always after you touch `.env`, rotate anything, or move
the bot to a new host.** Put a reminder somewhere you will actually see it. The
drill takes seconds; the thing it protects against is unrecoverable.

Rehearse it the way it will really happen at least once: download the archive
from Telegram to a *different* machine, and run the drill there with the secret
from your offline copy — not the one on the VPS. That is the scenario this whole
page exists for, and it is the only run that tests all three artefacts at once.

---

## If the drill fails

**Every wallet failed** — the secret is not the one that encrypted this store.
Do **not** start the bot with it. A wrong secret destroys nothing by itself, but
a new wallet minted under it can never be opened with the real one, which turns
a recoverable mistake into a permanent one. Find the right secret first: check
your other offline copy, and check the `.env` on the running host if it is still
alive.

**Some wallets failed** — the archive is partially corrupt. Try an older
snapshot; the affected users are the ones whose wallets did not verify, and they
are named in the output.

**The archive will not parse** — it is truncated. Use an older one. This is
exactly why more than one is kept.

---

## Related

- `tradebot/README.md` — day-to-day operation
- `bot/src/services/healthMonitor.js` — the daily 💚 heartbeat. If it stops
  arriving, the bot is down; that is what it is for.
