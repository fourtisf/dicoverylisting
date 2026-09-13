#!/usr/bin/env bash
# Off-site backup of the trade bot's user store (data/ = encrypted wallet keys,
# positions, orders, referrals). The rotating snapshots in data/backups/ live on
# the SAME box — they do not survive a dead VPS. This ships a tarball elsewhere.
#
# Run from cron, e.g. every 6 hours:
#   0 */6 * * * /opt/dexvra/tradebot/scripts/backup-offsite.sh >> /var/log/tradebot-backup.log 2>&1
#
# Configure ONE destination via environment (e.g. in the crontab line):
#   RCLONE_REMOTE=remote:bucket/tradebot   → rclone copy (S3 / Drive / Dropbox / B2 …)
#   BACKUP_SSH=user@host:/backups          → scp
#
# The tarball holds ONLY ciphertext keys, but treat it as sensitive anyway.
# WALLET_SECRET is NOT included on purpose — back that up SEPARATELY, offline;
# store + secret together in one place would defeat the encryption.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${DATA_DIR:-$DIR/data}"
[ -d "$DATA" ] || { echo "no data dir at $DATA — nothing to back up"; exit 0; }

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="${TMPDIR:-/tmp}/tradebot-data-$STAMP.tar.gz"
tar -czf "$OUT" -C "$(dirname "$DATA")" "$(basename "$DATA")"
chmod 600 "$OUT"

if [ -n "${RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$OUT" "$RCLONE_REMOTE"
  echo "$(date -u +%FT%TZ) backed up $(basename "$OUT") → $RCLONE_REMOTE"
elif [ -n "${BACKUP_SSH:-}" ]; then
  scp -q "$OUT" "$BACKUP_SSH"
  echo "$(date -u +%FT%TZ) backed up $(basename "$OUT") → $BACKUP_SSH"
else
  echo "no destination set — export RCLONE_REMOTE=remote:path (rclone) or BACKUP_SSH=user@host:/path (scp)."
  echo "tarball left at $OUT for a manual copy."
  exit 0
fi
rm -f "$OUT"
