# Deploying the backend (Firebase)

The backend runs as a **Cloud Function v2** fronted by **Firebase Hosting**, with
**Cloud Firestore** for data. `npm run build` compiles TS → `dist/`;
`firebase.json`'s `functions.predeploy` runs it for you, and the hosting rewrite
sends every path to the `api` function.

There is no database server to attach and no `DATABASE_URL`. Firestore is
addressed by project, and on Functions the project and credentials are ambient.

## One-time setup

The repo is scaffolded against a placeholder project. Two things must be decided
before the first real deploy, and one of them is permanent:

1. **Project id** — replace `PLACEHOLDER-PROJECT-ID` in `.firebaserc`.
2. **Region** — pick a US region (Nicole is US-based) and co-locate Firestore
   and Functions in it. **Firestore's location cannot be changed once set**, so
   choose deliberately rather than accepting a default.

```bash
firebase login
firebase use --add                      # bind the real project
firebase firestore:databases:create --location=<region>   # permanent
```

## What gets deployed

```bash
npm run deploy                 # hosting + functions + rules + indexes
```

- **Functions** — `src/index.ts` wraps `createApp()` in `onRequest`, plus the
  `onSchedule` triggers derived from the job list (the WF3/WF4 cadences, the
  refill projection, the reconciliation drain). There is no in-process cron.
- **Hosting** — serves `public/` and rewrites `**` to the `api` function.
- **Firestore rules** — deny-all. Only the Admin SDK touches data; no client SDK
  should ever reach it. This is correct and must stay correct.
- **Storage rules** — deny-all, for the same reason.
- **Indexes** — `firestore.indexes.json`. Every composite query in the adapter
  has a declared index; a query added without one fails in production, so add
  the index in the same change as the query.

## Secrets

Secrets live in Firebase, not a `.env`. Set each one you actually use:

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set PB_WEBHOOK_SECRET
firebase functions:secrets:set PB_SIGNING_SECRET
firebase functions:secrets:set BEE_WEBHOOK_SECRET
# … MS Graph, QuickBooks, Google service account, as needed
```

Every integration stays in **dry-run** until its keys are set, so a partial
configuration is safe — it just does less.

| Secret | Why |
| --- | --- |
| `BEE_WEBHOOK_SECRET` | must match the desktop app's `innerlume.config.json` |
| `PB_WEBHOOK_SECRET`, `PB_SIGNING_SECRET` | Practice Better webhooks |
| integration keys | Google Drive, PB REST, Outlook, Fullscript, QuickBooks, LLM |

`SCHEDULER_ENABLED` is gone: the schedule is the deployed `onSchedule` triggers,
not a flag the process reads.

## Data migrations

Firestore needs no DDL, so there is no release-phase migration step and the
`Procfile` no longer has one. `migrations/*.sql` stay in the repo as the schema's
historical record.

What still needs ordering is **data** work — a backfill, a reshaped document.
Those go in `src/db/migrate.ts`'s `MIGRATIONS` list and run with `npm run
migrate`; the ledger lives in `integration_state` so a completed one never
re-runs. Each step must be idempotent on its own terms, because the ledger is
written after the step, not with it.

## Local development

Everything below Phase 8 is developed against the emulator, never the live
project:

```bash
npm run firestore:emulator     # firebase-tools@13, works on JDK 17
npm run firebase:emulators     # all emulators; needs JDK 21+
npm test                       # the suite runs against the Firestore emulator
npm run seed                    # populates a full offline cockpit, no credentials
```

The test suites skip rather than fail when no emulator is running, so a
contributor without one still gets a green, honest run.

## After deploying

Put the Hosting URL into the desktop build's `desktop/innerlume.config.json`
(`backendUrl`) so Nicole's app points at it.
