#!/usr/bin/env bash
# Run a command against the production (Render) Postgres.
#
# Reads the connection string from .env.prod (gitignored) and exports it as
# DATABASE_URL for the child process only. Shell-set vars take precedence over
# dotenv, so this overrides .env without editing it — `npm run dev` on its own
# still points at the local Docker Postgres.
#
# The scheduler is forced OFF. With SCHEDULER_ENABLED=true, correlationSweepJob
# runs every 15 minutes against whatever DATABASE_URL points at: it demotes
# existing matches and DELETES the derived draft sheet + protocol. Other jobs
# ingest from Pocket and dispatch outbound email. None of that should fire from
# a developer laptop against live clinical data.
#
#   ./scripts/prod-db.sh psql "$DATABASE_URL" -c 'select 1'
#   ./scripts/prod-db.sh npx tsx scripts/hold-multisession-recordings.mts
#   ./scripts/prod-db.sh npm run dev
#
# To deliberately run a scheduler job against prod, set SCHEDULER_ENABLED=true
# in the invoking shell — it survives, so it stays an explicit act.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env.prod ]]; then
  echo "error: .env.prod not found." >&2
  echo "Create it with the Render Postgres EXTERNAL url:" >&2
  echo "  DATABASE_URL=postgresql://bishop:PASSWORD@dpg-XXXX-a.oregon-postgres.render.com/bishopai" >&2
  echo "Use the 'External Database URL' from the Render dashboard, not the" >&2
  echo "internal one — the internal host (dpg-XXXX-a, no domain) only resolves" >&2
  echo "inside Render's private network." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.prod
set +a

# Render's internal host has no dot in it (dpg-xxxx-a); the external one is a
# fully-qualified *.render.com name. Only the latter resolves from here.
host=$(printf '%s' "${DATABASE_URL:-}" | sed -E 's#.*@([^/:]+).*#\1#')
if [[ "$host" != *.* ]]; then
  echo "error: DATABASE_URL points at Render's internal host ($host), which does" >&2
  echo "not resolve outside Render's network. Use the External Database URL." >&2
  exit 1
fi

export SCHEDULER_ENABLED="${SCHEDULER_ENABLED:-false}"

echo "→ prod db: ${host}  (scheduler=${SCHEDULER_ENABLED})" >&2

exec "$@"
