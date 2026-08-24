#!/usr/bin/env bash
# Apply pending migrations to the Railway production database.
#
# Exists as a script rather than a one-liner because the inline version wraps in
# a terminal and breaks on the newline. Fetches the password from Railway so
# nothing is pasted or stored.
set -euo pipefail
cd "$(dirname "$0")/.."

PW=$(railway variables --service Postgres --environment production --json \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["PGPASSWORD"])')
export DATABASE_URL="postgresql://postgres:${PW}@gondola.proxy.rlwy.net:21544/railway"

echo "=== before ==="
psql "$DATABASE_URL" -tAc "SELECT 'migrations=' || max(filename) FROM schema_migrations;"
psql "$DATABASE_URL" -tAc "SELECT 'protocols=' || count(*) FROM protocols;"

echo "=== applying ==="
npx tsx src/db/migrate.ts

echo "=== after ==="
psql "$DATABASE_URL" -tAc "SELECT 'migrations=' || max(filename) FROM schema_migrations;"
psql "$DATABASE_URL" -tAc "SELECT 'protocols=' || count(*) FROM protocols;"
psql "$DATABASE_URL" -tAc "SELECT 'distinct_pb_protocols=' || count(DISTINCT pb_id) FROM protocols WHERE pb_id IS NOT NULL;"
psql "$DATABASE_URL" -tAc "SELECT 'approved_kept=' || count(*) FROM protocols WHERE status <> 'draft';"
