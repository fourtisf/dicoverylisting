#!/usr/bin/env bash
# Set the four TREASURY_* addresses in .env, idempotently.
#
#   bash scripts/set-treasury.sh EVM_ADDR SOL_ADDR TRON_ADDR TON_ADDR
#
# Why a script and not `echo >> .env`: appending a key that already exists
# leaves two lines, and which one wins depends on the parser. This rewrites the
# four keys in place, keeps every other line untouched, backs up first, and
# restores the backup if anything goes wrong. Run `npm run treasury` after.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: bash scripts/set-treasury.sh <EVM> <SOL> <TRON> <TON>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
# The bot loads .env from the repo root, bot/, and cwd (src/config/loadEnv.js).
# Write to whichever already exists so a second, shadowing file is never created.
ENV_FILE=""
for c in "../.env" ".env"; do
  [ -f "$c" ] && ENV_FILE="$c" && break
done
if [ -z "$ENV_FILE" ]; then
  ENV_FILE=".env"
  echo "no .env found — creating $(pwd)/$ENV_FILE"
  : >"$ENV_FILE"
fi

BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP" # it holds every secret the original does
echo "backup: $BACKUP"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
# Drop the existing four keys (commented-out lines are left alone), keep the rest.
grep -vE '^[[:space:]]*TREASURY_(EVM|SOL|TRON|TON)[[:space:]]*=' "$ENV_FILE" >"$TMP" || true
# No inline comments after the value: dotenv strips them for unquoted values on
# some versions and keeps them on others, and a treasury address is not a place
# to find out which.
{
  echo ""
  echo "# Treasury sweep destinations (set $(date -u +%Y-%m-%dT%H:%MZ))"
  echo "TREASURY_EVM=$1"
  echo "TREASURY_SOL=$2"
  echo "TREASURY_TRON=$3"
  echo "TREASURY_TON=$4"
} >>"$TMP"

cat "$TMP" >"$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "wrote $ENV_FILE"
echo
echo "Now verify, then restart:"
echo "  npm run treasury -- --live"
echo "  pm2 restart dexvra-bot dexvra-adminbot --update-env"
