# Deploying the backend (Render)

The backend is a plain Node/Express app: `npm run build` → `dist/`, `npm start` →
`node dist/server.js`. It needs **one Postgres database** and a handful of env
vars. It listens on `$PORT`, which the platform sets for you.

This directory is its own git repo (`punchagency/bishopai-server`), so there is
no monorepo subtree to deal with — `render.yaml` sits at its root and needs no
`rootDir`. The live branch is `pocket-integration`, not `main`.

## What the platform runs

- **Build:** `npm install` → `npm run build` (compiles TS → `dist/`).
- **Release / migrate:** `npm run migrate:prod` (`node dist/db/migrate.js`) —
  applies `migrations/*.sql` in order, idempotently. On Render this is the
  blueprint's `preDeployCommand`; on Heroku, the `Procfile` `release:` phase.
  Both run automatically before the new instance takes traffic.
- **Web:** `npm start`.

## Postgres

Attach a managed Postgres and the platform injects **`DATABASE_URL`**. TLS is
handled automatically: `src/db/pool.ts` turns SSL on for any non-localhost URL
(self-signed accepted — the standard for managed Postgres). Render's private
host (`dpg-…`) is non-local, so this needs no help; if that connection ever
rejects TLS, set `DATABASE_SSL=false`.

## Heroku (alternative)

```bash
heroku create innerlume-api
heroku addons:create heroku-postgresql:essential-0     # sets DATABASE_URL
heroku config:set \
  POCKET_API_KEY=pk_... POCKET_WEBHOOK_SECRET=<from Pocket> PB_WEBHOOK_SECRET=<random> \
  SCHEDULER_ENABLED=true
git push heroku pocket-integration:main   # build + `release: migrate:prod` + boot
```

## Render  ← current host

Railway died on 2026-09-04, taking the production Postgres with it. Render is
the replacement. `render.yaml` at the repo root describes both services.

1. Render dashboard → **New → Blueprint** → pick `punchagency/bishopai-server`.
   It reads `render.yaml` and proposes the web service + Postgres together.
2. Render prompts for every `sync: false` secret **during creation only** — it
   ignores them on later blueprint updates. Fill them all in there, or set the
   stragglers by hand in the service's Environment tab afterwards.
3. First deploy runs `npm ci && npm run build`, then `npm run migrate:prod` as
   the **pre-deploy** step (Render's analogue of Heroku's `release:` phase),
   then `npm start`. The 42 migrations are idempotent and build the schema from
   nothing, so a fresh database needs no manual bootstrap.
4. Confirm the real service URL. Render appends a suffix if `innerlume-api` is
   taken globally. If it differs, fix `PUBLIC_BASE_URL` — the Outlook redirect
   URI derives from it — and the two client defaults (see "Clients" below).

### Restoring data

The Railway Postgres was not recoverable (its TCP proxy still accepts
connections but drops them — nothing behind it), so the local Docker database
was the best surviving copy. To load a dump into Render:

```bash
echo 'DATABASE_URL=<External Database URL from Render>' > .env.prod   # gitignored
./scripts/restore-prod.sh ../bishopai-local-YYYYMMDD-HHMM.dump
```

`restore-prod.sh` refuses to run against a database that already holds clients
unless `RESTORE_OVER_DATA=yes` is set, so overwriting real data stays a
deliberate act. `scripts/prod-db.sh` and `scripts/migrate-prod.sh` read the same
`.env.prod`.

Whatever the restore doesn't cover is largely re-derivable from systems that are
still live: clients and appointments from Practice Better, recordings from
Pocket, documents from Drive, payments from QuickBooks. What is *not*
re-derivable is the app's own derived state — approvals, extraction outputs,
`audit_log`, checkout state, the outbound email queue.

### Post-deploy checklist

The hostname changed, so anything that points at the old one must be updated:

- **Entra (Outlook):** register `https://<host>/auth/outlook/callback` as a
  redirect URI, then reconnect Outlook from the dashboard.
- **Practice Better:** re-register webhooks against the new host —
  `npm run pb-webhook`. `PB_WEBHOOK_SECRET` is yours to choose; generate a new
  one and set it on both sides.
- **Pocket:** point the webhook destination at `https://<host>/webhooks/pocket`
  and set the `POCKET_WEBHOOK_SECRET` it shows you (shown once).
- **Google / QuickBooks:** `GOOGLE_REFRESH_TOKEN` and `QB_REFRESH_TOKEN` survive
  a host change and need no re-auth. Only add the new redirect URI if you plan
  to re-run the auth scripts.
- **Clients:** `desktop/innerlume.config.json` (`backendUrl`) and
  `desktop/src/renderer/src/lib/platform.ts` (`WEB_DEFAULT_BACKEND`) both hold
  the backend URL. Nicole's desktop app needs a rebuild and a fresh installer.

### Strongly recommended: a custom domain

Put `api.innerlumehealing.com` in front of the Render service and point the
desktop config at that instead of `*.onrender.com`. The next time a host dies
this becomes a DNS change rather than another round of webhook re-registration
and a new installer in Nicole's hands.

### A note on the instance plan

`render.yaml` puts the web service on `starter`, not `free`, deliberately. The
WF3/WF4 crons, the nightly refill projection and the 7am prep digest all run
in-process via node-cron, and only fire while the instance is awake. Render's
free tier spins down after ~15 minutes idle, so on `free` those jobs would
silently stop running.

## Env vars to set (see `.env.example` for the full list)

| Var | Why |
| --- | --- |
| `DATABASE_URL` | injected by the PG addon |
| `POCKET_API_KEY` | `pk_…` from the Pocket app — powers the polling backstop |
| `POCKET_WEBHOOK_SECRET` | shown once when you create the Pocket webhook destination; point it at `https://<host>/webhooks/pocket` |
| `PB_WEBHOOK_SECRET`, `PB_SIGNING_SECRET` | Practice Better webhooks |
| `SCHEDULER_ENABLED=true` | run the WF3/WF4 cron jobs on the server |
| integration keys | all optional — each stays **dry-run** until set (Google Drive, PB REST, Outlook, Fullscript, QuickBooks, LLM) |

Once deployed, put the app's public URL into the desktop build's
`desktop/innerlume.config.json` (`backendUrl`) so Nicole's app points at it.
`npm run seed` can be run once against the deployed DB to populate a demo.
```
