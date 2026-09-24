#!/usr/bin/env sh
# Nightly SQLite backup via cron:
#   0 3 * * * GOTYOUBRO_URL=https://your-domain.com GOTYOUBRO_TOKEN=gyb_... /path/backup-sqlite.sh /srv/app/app.db
set -eu

DB="$1"
SNAPSHOT="$(mktemp -d)/$(basename "$DB" .db)-$(date -u +%Y%m%d-%H%M).db.gz"

# Consistent online snapshot, then compress.
sqlite3 "$DB" ".backup '${SNAPSHOT%.gz}'"
gzip "${SNAPSHOT%.gz}"

curl -fsS -X POST "$GOTYOUBRO_URL/api/v1/backups" \
  -H "Authorization: Bearer $GOTYOUBRO_TOKEN" \
  -H "Idempotency-Key: $(basename "$SNAPSHOT")" \
  -F "file=@$SNAPSHOT"

rm -f "$SNAPSHOT"
