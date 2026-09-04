#!/usr/bin/env bash
# Restore a pg_dump archive into the production (Render) database.
#
# Written for the Railway→Render move (2026-09-04): Railway died with the
# production Postgres, and the local Docker database was the best surviving
# copy. This loads such a dump into a fresh Render instance.
#
#   ./scripts/restore-prod.sh ../bishopai-local-20260904-1958.dump
#
# This is destructive by design — it drops and recreates every object in the
# dump. It therefore refuses to run against a database that already holds
# clinical rows unless RESTORE_OVER_DATA=yes is set in the invoking shell, so
# overwriting real data is always a deliberate act.
set -euo pipefail
cd "$(dirname "$0")/.."

DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "usage: ./scripts/restore-prod.sh <dump-file>" >&2
  exit 1
fi

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
  echo "error: DATABASE_URL points at Render's internal host ($host)." >&2
  exit 1
fi

# Refuse to clobber a database that already has clinical data.
existing=$(psql "$DATABASE_URL" -tAc \
  "SELECT coalesce((SELECT count(*) FROM clients),0)" 2>/dev/null || echo 0)
if [[ "${existing:-0}" -gt 0 && "${RESTORE_OVER_DATA:-}" != "yes" ]]; then
  echo "refusing: ${host} already holds ${existing} clients." >&2
  echo "Re-run with RESTORE_OVER_DATA=yes to overwrite them deliberately." >&2
  exit 1
fi

echo "→ restoring $(basename "$DUMP") into ${host}" >&2
echo "  (${existing} clients currently present)" >&2

# --clean --if-exists so a partial earlier attempt doesn't wedge the restore.
# --no-owner/--no-acl because the Render role differs from the local one.
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error \
  --dbname "$DATABASE_URL" "$DUMP"

echo "=== after ==="
psql "$DATABASE_URL" -tAc "SELECT 'migrations=' || coalesce(max(filename),'(none)') FROM schema_migrations;"
psql "$DATABASE_URL" -tAc "SELECT 'clients=' || count(*) FROM clients;"
psql "$DATABASE_URL" -tAc "SELECT 'appointments=' || count(*) FROM appointments;"
psql "$DATABASE_URL" -tAc "SELECT 'protocols=' || count(*) FROM protocols;"
psql "$DATABASE_URL" -tAc "SELECT 'approvals=' || count(*) FROM approvals;"
