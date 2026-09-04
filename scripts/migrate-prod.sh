#!/usr/bin/env bash
# Apply pending migrations to the production (Render) database, with a
# before/after row census so you can see what the migration actually did.
#
# Render normally runs migrations itself via the blueprint's preDeployCommand
# (`npm run migrate:prod`), so this is for out-of-band runs: a restore, a
# hotfix, or verifying state after a failed deploy.
#
# Reads the connection string from .env.prod (gitignored) — the Render
# dashboard's "External Database URL". Only migrations run here; this never
# boots the app, so no scheduler job can fire from it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env.prod ]]; then
  echo "error: .env.prod not found — see scripts/prod-db.sh for its shape." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.prod
set +a

host=$(printf '%s' "${DATABASE_URL:-}" | sed -E 's#.*@([^/:]+).*#\1#')
if [[ "$host" != *.* ]]; then
  echo "error: DATABASE_URL points at Render's internal host ($host), which does" >&2
  echo "not resolve from here. Use the External Database URL." >&2
  exit 1
fi
echo "→ prod db: ${host}" >&2

census() {
  psql "$DATABASE_URL" -tAc "SELECT 'migrations=' || coalesce(max(filename),'(none)') FROM schema_migrations;"
  psql "$DATABASE_URL" -tAc "SELECT 'clients=' || count(*) FROM clients;"
  psql "$DATABASE_URL" -tAc "SELECT 'protocols=' || count(*) FROM protocols;"
}

echo "=== before ==="
census

echo "=== applying ==="
npx tsx src/db/migrate.ts

echo "=== after ==="
census
psql "$DATABASE_URL" -tAc "SELECT 'distinct_pb_protocols=' || count(DISTINCT pb_id) FROM protocols WHERE pb_id IS NOT NULL;"
psql "$DATABASE_URL" -tAc "SELECT 'approved_kept=' || count(*) FROM protocols WHERE status <> 'draft';"
