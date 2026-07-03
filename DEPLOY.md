# Deploying the backend (Heroku / Railway)

The backend is a plain Node/Express app: `npm run build` → `dist/`, `npm start` →
`node dist/server.js`. It needs **one Postgres database** and a handful of env
vars. It listens on `$PORT` (both platforms set this for you).

## What the platform runs

- **Build:** `npm install` → `npm run build` (compiles TS → `dist/`).
- **Release / migrate:** `npm run migrate:prod` (`node dist/db/migrate.js`) —
  applies `migrations/*.sql` in order, idempotently. On Heroku this is the
  `Procfile` `release:` phase (runs automatically before the new web starts). On
  Railway, run it once after the DB is attached (a deploy command or one-off).
- **Web:** `npm start`.

## Postgres

Attach a managed Postgres and the platform injects **`DATABASE_URL`**. TLS is
handled automatically: `src/db/pool.ts` turns SSL on for any non-localhost URL
(self-signed accepted — the standard for Heroku/Railway). No extra config needed.

## Heroku

```bash
# from the repo, with the app rooted at server/ (see "monorepo" note below)
heroku create innerlume-api
heroku addons:create heroku-postgresql:essential-0     # sets DATABASE_URL
heroku config:set \
  BEE_WEBHOOK_SECRET=<random> PB_WEBHOOK_SECRET=<random> \
  SCHEDULER_ENABLED=true
git push heroku main            # build + `release: migrate:prod` + boot
```

**Monorepo:** this app lives in `server/`. Either deploy that subtree
(`git subtree push --prefix server heroku main`) or use the monorepo buildpack
(`heroku buildpacks:add https://github.com/lstoll/heroku-buildpack-monorepo` +
`heroku config:set APP_BASE=server`).

## Railway

1. New Project → Deploy from repo → set **Root Directory = `server`**.
2. Add the **Postgres** plugin (injects `DATABASE_URL`).
3. Railway auto-detects `build` + `start`. Run migrations once:
   `railway run npm run migrate:prod` (or add it as a deploy command).
4. Set the env vars (below) in the service Variables tab.

## Env vars to set (see `.env.example` for the full list)

| Var | Why |
| --- | --- |
| `DATABASE_URL` | injected by the PG addon |
| `BEE_WEBHOOK_SECRET` | must match the desktop app's `innerlume.config.json` |
| `PB_WEBHOOK_SECRET`, `PB_SIGNING_SECRET` | Practice Better webhooks |
| `SCHEDULER_ENABLED=true` | run the WF3/WF4 cron jobs on the server |
| integration keys | all optional — each stays **dry-run** until set (Google Drive, PB REST, Outlook, Fullscript, QuickBooks, LLM) |

Once deployed, put the app's public URL into the desktop build's
`desktop/innerlume.config.json` (`backendUrl`) so Nicole's app points at it.
`npm run seed` can be run once against the deployed DB to populate a demo.
```
