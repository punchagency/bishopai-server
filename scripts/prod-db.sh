#!/usr/bin/env bash
# Run a command against the Railway (production) Postgres.
#
# Reads the connection string from .env.railway (gitignored) and exports it as
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

if [[ ! -f .env.railway ]]; then
  echo "error: .env.railway not found." >&2
  echo "Create it with the Railway Postgres PUBLIC url:" >&2
  echo "  DATABASE_URL=postgres://postgres:PASSWORD@HOST.proxy.rlwy.net:PORT/railway" >&2
  echo "Use DATABASE_PUBLIC_URL from the Railway dashboard, not DATABASE_URL —" >&2
  echo "the latter is *.railway.internal and only resolves inside Railway." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.railway
set +a

if [[ "${DATABASE_URL:-}" == *"railway.internal"* ]]; then
  echo "error: DATABASE_URL points at *.railway.internal, which does not resolve" >&2
  echo "outside Railway's network. Use DATABASE_PUBLIC_URL instead." >&2
  exit 1
fi

export SCHEDULER_ENABLED="${SCHEDULER_ENABLED:-false}"

host=$(printf '%s' "$DATABASE_URL" | sed -E 's#.*@([^/]+)/.*#\1#')
echo "→ prod db: ${host}  (scheduler=${SCHEDULER_ENABLED})" >&2

exec "$@"
