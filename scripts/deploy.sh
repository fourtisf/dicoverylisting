#!/usr/bin/env bash
#
# THE deploy command. Run it ON the server, from anywhere:
#
#   npm run deploy            # from /opt/dexvra
#   bash /opt/dexvra/scripts/deploy.sh
#
# There is no path to fill in and no host to name: the repo root is derived
# from this file's own location, so the script cannot be pointed at the wrong
# tree by a typo — this file's own first rule about pasteable commands.
#
# WHAT IT RESTARTS IS DECIDED FROM THE DIFF, NEVER FROM MEMORY.
# CLAUDE.md states the rule twice ("If a change touches only bot/, there is no
# npm run build and no pm2 restart dexvra") and it was still a thing an operator
# had to remember — and `--with-bots` was OPT-IN, so forgetting it deployed the
# web app and left BOTH bots on the old code. That fails silently: the main bot
# shows a feature working while @dexvraadminbot has no menu entry for it, which
# reads as a missing feature rather than a stale process. The script has BEFORE
# and AFTER in hand, so it computes the answer instead of asking for it.
#
#   --with-bots   force the bot suite on, whatever the diff says
#   --all         force everything on (use when the box's state is in doubt)
#
# WITH NOTHING NEW TO PULL IT VERIFIES AND RESTARTS NOTHING. That makes it the
# "what is actually running?" command too, and keeps it idempotent: a second run
# is a report, not another rebuild.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FORCE_BOTS=0
FORCE_ALL=0
for arg in "$@"; do
  case "$arg" in
    --with-bots) FORCE_BOTS=1 ;;
    --all)       FORCE_ALL=1 ;;
    *) echo "unknown option: $arg (--with-bots and --all are the only ones)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. Refuse to deploy on top of uncommitted work ────────────────────────
# A deploy that stashes or clobbers an operator's edit is how a hotfix made on
# the box disappears without anyone noticing it is gone.
step "Checking the working tree"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "the working tree has changes — commit, stash or discard them first"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE="$(git rev-parse --short HEAD)"
echo "on $BRANCH at $BEFORE"

# ── 2. Fast-forward only ──────────────────────────────────────────────────
step "Fetching origin/$BRANCH"
git fetch origin "$BRANCH"
git merge --ff-only "origin/$BRANCH" || die "cannot fast-forward — the box has commits origin does not; resolve by hand"
AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "already at $AFTER — nothing new to pull"
else
  echo "$BEFORE → $AFTER"
  git --no-pager log --oneline "$BEFORE..$AFTER" | head -20
fi

# ── 2b. What actually changed ─────────────────────────────────────────────
# CLAUDE.md's own test, automated: "git diff --name-only <base>..HEAD |
# grep -v '^bot/' — empty output means bot-only." A web rebuild is minutes, and
# restarting the wrong process is the silent-stale failure this file documents
# over and over, so the diff decides both.
#
# ⚠️ shared/ COUNTS AS EVERYTHING. `shared/launchpads/` is required by src/,
# bot/src/ and tradebot/ alike — it exists precisely so those three cannot hold
# three ideas of one launchpad — so a change there restarts all of them.
#
# ⚠️ AND "NOTHING CHANGED" MAY NOT MEAN "RESTART NOTHING" SILENTLY. With no new
# commits the script verifies and restarts nothing, which is what makes a second
# run a report rather than another rebuild — but a stale process is then found
# by the verify and named, and --all is what fixes it.
DO_WEB=0; DO_BOTS=0; DO_TRADE=0
if [ "$BEFORE" = "$AFTER" ]; then
  CHANGED=""
else
  CHANGED="$(git diff --name-only "$BEFORE" "$AFTER")"
fi

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    bot/*)      DO_BOTS=1 ;;
    tradebot/*) DO_TRADE=1 ;;
    shared/*)   DO_WEB=1; DO_BOTS=1; DO_TRADE=1 ;;
    *)          DO_WEB=1 ;;
  esac
done <<< "$CHANGED"

[ "$FORCE_BOTS" = "1" ] && DO_BOTS=1
if [ "$FORCE_ALL" = "1" ]; then DO_WEB=1; DO_BOTS=1; DO_TRADE=1; fi

step "Scope"
if [ -z "$CHANGED" ] && [ "$FORCE_ALL" = "0" ] && [ "$FORCE_BOTS" = "0" ]; then
  echo "nothing new to pull — verifying what is running, restarting nothing"
  echo "(pass --all to rebuild and restart anyway)"
else
  printf 'web app  %s\nbot suite %s\ntradebot  %s\n' \
    "$([ "$DO_WEB" = 1 ] && echo 'rebuild + restart' || echo 'untouched')" \
    "$([ "$DO_BOTS" = 1 ] && echo 'restart (dexvra-bot + dexvra-adminbot)' || echo 'untouched')" \
    "$([ "$DO_TRADE" = 1 ] && echo 'restart' || echo 'untouched')"
fi

# ── 3. Dependencies ───────────────────────────────────────────────────────
# `npm ci` from the lockfile, never `npm install`: a deploy must install the
# versions that were tested, not resolve new ones on the box.
#
# WITH devDependencies, deliberately. `--omit=dev` looks right for a server and
# is wrong here: the build happens ON this box, and next build needs typescript
# and the @types packages to compile at all. Omitting them fails the build with
# a message about TypeScript not being installed, several minutes in.
#
# Only for the packages this deploy touches: `npm ci` DELETES node_modules and
# reinstalls, so running it for an untouched package is minutes spent to arrive
# at the bytes already on disk.
step "Installing dependencies"
if [ "$DO_WEB" = "1" ]; then
  echo "· root (web app)"
  npm ci --no-audit --no-fund
fi
[ "$DO_BOTS" = "1" ]  && { echo "· bot";      (cd bot && npm ci --no-audit --no-fund); }
[ "$DO_TRADE" = "1" ] && { echo "· tradebot"; (cd tradebot && npm ci --no-audit --no-fund); }
[ "$DO_WEB$DO_BOTS$DO_TRADE" = "000" ] && echo "nothing to install"
true

# ── 4. Tests before build ─────────────────────────────────────────────────
# Both suites are offline, so a box with egress blocked still runs them, and a
# red test stops the deploy here while the old build is still the one serving.
#
# ⚠️ BOTH NEED NODE 22, AND PRODUCTION RUNS 18. They are `node --test` over
# `.ts` files, which needs --experimental-strip-types (22.6+). Running them
# unconditionally makes the script abort on the one box it is written for — a
# deploy tool that cannot run on the server is "apt-get install is not a fix,
# it is a request", one feature over. So the box's Node decides, and a skip is
# LOUD: a silent one would read as a suite that passed.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
if [ "$DO_WEB" = "0" ]; then
  step "Skipping the test suites"
  echo "no web file changed — these two are the WEB app's suites."
  echo "bot/ and tradebot/ have their own; they are the merge gate, not this."
elif [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 6 ]; }; then
  step "Running the test suites"
  npm test
  npm run test:pons
else
  step "Skipping the test suites"
  printf 'node %s cannot strip types — both suites need 22.6+.\n' "$(node -v)"
  printf 'They are the MERGE gate, not the deploy gate: run them where you develop.\n'
fi

# ── 5. Build ──────────────────────────────────────────────────────────────
# `npm run build` stamps NEXT_PUBLIC_BUILD from HEAD; step 7 reads it back out
# of the running server, which is the only way to tell a deployed build from a
# stale one.
if [ "$DO_WEB" = "1" ]; then
  step "Building"
  npm run build
fi

# ── 6. Restart ────────────────────────────────────────────────────────────
command -v pm2 >/dev/null || die "pm2 is not on PATH"

# Which bot processes exist on THIS box. The tradebot's name differs between
# boxes, so an absent one is skipped rather than failing the deploy.
BOT_PROCS=""
for proc in dexvra-bot dexvra-adminbot dexvra-tradebot dexvra-trade; do
  pm2 describe "$proc" >/dev/null 2>&1 && BOT_PROCS="$BOT_PROCS $proc"
done

# How many times each has ever printed its boot stamp. Step 7 waits for this to
# GO UP before believing a line it reads.
#
# ⚠️ `pm2 logs --nostream` reads the log FILE, which still holds every earlier
# boot — so `grep | tail -1` on its own would read a stamp from three days ago
# as though it were this restart, which is the reassuring reading this whole
# verification step exists to refuse.
bootcount() { pm2 logs "$1" --lines 2000 --nostream 2>/dev/null | grep -c '\[boot\] build' || true; }
declare -A BOOTS_BEFORE=()
for proc in $BOT_PROCS; do BOOTS_BEFORE[$proc]="$(bootcount "$proc")"; done

RESTARTED=""
step "Restarting"
if [ "$DO_WEB" = "1" ]; then
  echo "· dexvra (web app)"
  pm2 restart dexvra --update-env
fi
if [ "$DO_BOTS" = "1" ]; then
  # ⚠️ THE ECOSYSTEM FILE, NOT THE TWO NAMES. CLAUDE.md: bot/ runs BOTH
  # dexvra-bot and dexvra-adminbot, and restarting one by name leaves the other
  # on the old code — which fails silently and reads as a missing feature
  # rather than a stale process.
  if [ -f bot/ecosystem.config.js ]; then
    echo "· bot/ (dexvra-bot + dexvra-adminbot)"
    (cd bot && pm2 restart ecosystem.config.js --update-env)
    for proc in dexvra-bot dexvra-adminbot; do
      pm2 describe "$proc" >/dev/null 2>&1 && RESTARTED="$RESTARTED $proc"
    done
  fi
fi
if [ "$DO_TRADE" = "1" ]; then
  for proc in dexvra-tradebot dexvra-trade; do
    if pm2 describe "$proc" >/dev/null 2>&1; then
      echo "· $proc"
      pm2 restart "$proc" --update-env
      RESTARTED="$RESTARTED $proc"
    fi
  done
fi
[ "$DO_WEB$DO_BOTS$DO_TRADE" = "000" ] && echo "nothing restarted"
true

# ── 7. Verify EVERY process is on the commit it should be ─────────────────
# CLAUDE.md: "Step 5 is not optional … a pull that never reached the server and
# a change that did not work are indistinguishable from Telegram, and an evening
# was spent debugging the first while assuming the second."
#
# ⚠️ AND IT ONLY EVER CHECKED THE WEB APP. The bot suite is where most of this
# repo's features live and where every one of those evenings was lost, and its
# three processes print `[boot] build <sha>` for exactly this reason — nothing
# read them back. So all four are checked here, by ONE rule.
step "Verifying"
EXPECTED="$(git rev-parse --short HEAD)"
STALE=0

# THE RULE, and it is a DIFF rather than an equality.
#
# ⚠️ The first cut compared every process to HEAD, and a driven test said no: on
# a tradebot-only deploy the bot suite sitting on an older commit is CORRECT,
# and calling it red leaves this command permanently red on a healthy box — the
# state `chart:preview` sat in for weeks, which teaches its reader to ignore the
# red. A process is behind only when a file in ITS OWN paths has changed since
# the commit it is running.
#
# Restarted is the strict case: we just pointed it at HEAD, so anything else
# means the restart did not take.
#
# An unresolvable sha (history rewritten, a tarball deploy) is NOT a verdict —
# it is a fact we cannot establish, so it is reported and never counted.
# `+dirty` means the checkout has uncommitted changes and is not what `main`
# says it is; step 1 refuses that, so it can only be somebody editing the box.
verdict() {                       # verdict <label> <sha> <restarted 0|1> <paths-regex>
  local label="$1" sha="$2" restarted="$3" mine="$4" bare="${2%+dirty}"
  if [ -z "$sha" ]; then
    printf '· %-16s \033[31mno build stamp — did it start?\033[0m\n' "$label"; STALE=1; return
  fi
  case "$sha" in *+dirty)
    printf '· %-16s \033[31m%s — the checkout has uncommitted changes\033[0m\n' "$label" "$sha"; STALE=1; return ;;
  esac
  if [ "$sha" = "$EXPECTED" ]; then
    printf '· %-16s \033[32m%s\033[0m\n' "$label" "$sha"; return
  fi
  if [ "$restarted" = "1" ]; then
    printf '· %-16s \033[31m%s — the restart did not take\033[0m\n' "$label" "$sha"; STALE=1; return
  fi
  if ! git cat-file -e "${bare}^{commit}" 2>/dev/null; then
    printf '· %-16s %s (not a commit in this checkout — cannot tell)\n' "$label" "$sha"; return
  fi
  if [ -z "$(git diff --name-only "$bare" "$EXPECTED" | grep -E "$mine" || true)" ]; then
    printf '· %-16s %s (older, and nothing of its own changed since — fine)\n' "$label" "$sha"
  else
    printf '· %-16s \033[31m%s — behind on its own files; re-run with --all\033[0m\n' "$label" "$sha"
    STALE=1
  fi
}

WEB_PATHS='^(?!bot/|tradebot/)'          # documented below; grep -E cannot do it
WEB_PATHS_E='^(bot|tradebot)/'           # so the web test is an INVERTED match
BOT_PATHS='^(bot|shared)/'
TRADE_PATHS='^(tradebot|shared)/'

# ── the web app ───────────────────────────────────────────────────────────
# ⚠️ READ IT FROM /api/tokens, NOT FROM THE HTML. `NEXT_PUBLIC_BUILD` is
# inlined into a bundle whose spelling the minifier owns, so scraping the page
# degraded to "it answers, but the stamp was not readable" — which is exactly
# the reassuring non-answer this step exists to refuse. The API returns it as a
# field, deliberately, and the page is only the fallback.
SERVED=""
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  SERVED="$(curl -fsS --max-time 8 http://127.0.0.1:3005/api/tokens 2>/dev/null \
    | grep -o '"build" *: *"[^"]*"' | grep -o '[0-9a-f]\{7,\}' | head -1 || true)"
  [ -n "$SERVED" ] && break
  SERVED="$(curl -fsS --max-time 5 http://127.0.0.1:3005/ 2>/dev/null | grep -o '[0-9a-f]\{7,40\}' | head -1 || true)"
  [ -n "$SERVED" ] && break
  sleep 2
done

if [ -z "$SERVED" ]; then
  echo "· dexvra           stamp unreadable — checking it answers at all"
  curl -fsS --max-time 5 -o /dev/null -w '                   HTTP %{http_code}\n' http://127.0.0.1:3005/ \
    || die "the app is not answering on port 3005 — pm2 logs dexvra"
  echo "                   it answers; confirm with: pm2 logs dexvra --lines 40"
elif [ "$SERVED" = "$EXPECTED" ] || [ "$DO_WEB" = "1" ]; then
  verdict dexvra "$SERVED" "$DO_WEB" 'NEVER-MATCHES'
else
  # The web app's "own files" are everything that is not a bot package, so its
  # test is the one inversion: behind when the diff has a NON-bot path in it.
  if [ -z "$(git cat-file -e "${SERVED}^{commit}" 2>/dev/null && git diff --name-only "$SERVED" "$EXPECTED" | grep -Ev "$WEB_PATHS_E" || true)" ]; then
    if git cat-file -e "${SERVED}^{commit}" 2>/dev/null; then
      printf '· %-16s %s (older, and no web file changed since — fine)\n' dexvra "$SERVED"
    else
      printf '· %-16s %s (not a commit in this checkout — cannot tell)\n' dexvra "$SERVED"
    fi
  else
    printf '· %-16s \033[31m%s — behind on WEB files; re-run with --all\033[0m\n' dexvra "$SERVED"
    STALE=1
  fi
fi

# ── the bots ──────────────────────────────────────────────────────────────
# A restarted process is given time to print a NEW boot line; an untouched one
# is read as it stands.
for proc in $BOT_PROCS; do
  want_new=0
  case " $RESTARTED " in *" $proc "*) want_new=1 ;; esac
  line=""
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    n="$(bootcount "$proc")"
    if [ "$want_new" = "0" ] || [ "$n" -gt "${BOOTS_BEFORE[$proc]:-0}" ]; then
      line="$(pm2 logs "$proc" --lines 2000 --nostream 2>/dev/null | grep '\[boot\] build' | tail -1 || true)"
      [ -n "$line" ] && break
    fi
    sleep 2
  done
  sha="$(printf '%s' "$line" | grep -o '[0-9a-f]\{7,40\}\(+dirty\)\?' | tail -1 || true)"
  case "$proc" in
    dexvra-trade*) verdict "$proc" "$sha" "$want_new" "$TRADE_PATHS" ;;
    *)             verdict "$proc" "$sha" "$want_new" "$BOT_PATHS" ;;
  esac
done

if [ "$STALE" = "1" ]; then
  printf '\n\033[31m✗ %s is checked out, but not everything is running it.\033[0m\n' "$EXPECTED"
  echo "Re-run with --all, then read the line above that is still red."
  exit 1
fi

printf '\n\033[32m✓ every process is on the commit it should be (HEAD %s)\033[0m\n' "$EXPECTED"
echo "logs: pm2 logs dexvra --lines 40"
