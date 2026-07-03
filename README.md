# bishopAI — Innerlume backend

Backend for the Innerlume Healing automation pilot: orchestration (PB native
webhooks + an in-process scheduler + direct integration clients) plus the two
hard custom pieces — the **Bee↔PB correlation engine** and the **checkout state
machine** — over a Postgres source of truth, serving Nicole's dashboard.

Stack: TypeScript + Express + `pg` (raw SQL, no ORM) + Postgres.

## Setup

```bash
cp .env.example .env
docker compose up -d db      # local Postgres on :5432
npm install
npm run migrate              # apply migrations/*.sql
npm run dev                  # start on :3000
```

## Layout

```
migrations/            plain .sql files, applied in filename order
src/
  db/pool.ts           pg Pool + query helper
  db/migrate.ts        migration runner (tracks applied files)
  correlation/         the Bee↔PB join (time-window overlap, never auto-guesses)
  conversations/       shared conversation ingest (correlate + idempotent upsert)
  llm/                 Anthropic client + config (model swappable via ANTHROPIC_MODEL)
  session/             transcript -> structured SessionNote (extract) + Markdown renderer (render)
  routes/review.ts     review queue: list/edit/approve + /render (Sheet & Protocol Markdown)
  observability/       logger — writes errors/warns to console AND system_events
  routes/              health, webhooks (PB booking, Bee conversation)
  server.ts            Express entrypoint
```

Errors and operational warnings are persisted to the `system_events` table (not
just stdout) via `observability/logger.ts`, so failures needing manual
follow-up survive restarts and are queryable. DB writes there are best-effort
and never throw.

## Tests

```bash
npm test          # vitest run (unit + integration)
npm run test:watch
```

- **Unit** (no infra): `src/session/render.test.ts` (both renderers + coerce),
  `src/correlation/correlate.test.ts` (match / no-match / ambiguous via a fake db).
- **Integration** (`test/correlation.int.test.ts`): runs the real Postgres
  `tstzrange` overlap + idempotent upsert via `ingestConversation`. Auto-skips
  if the dev DB isn't reachable, so the unit suite runs anywhere.

## Smoke test

If `BEE_WEBHOOK_SECRET` / `PB_WEBHOOK_SECRET` are set, add `-H 'X-Webhook-Secret: <value>'`
to these calls (they're unset in dev, so the calls below work as-is).

```bash
# land an appointment
curl -sX POST localhost:3000/webhooks/pb/booking -H 'content-type: application/json' -d '{
  "pb_appointment_id":"appt-1","pb_client_id":"cli-1","client_name":"Jane Doe",
  "starts_at":"2026-07-01T15:00:00Z","ends_at":"2026-07-01T16:00:00Z"
}'

# a Bee conversation overlapping it -> should correlate as matched
curl -sX POST localhost:3000/webhooks/bee/conversation -H 'content-type: application/json' -d '{
  "bee_id":"bee-1","starts_at":"2026-07-01T15:05:00Z","ends_at":"2026-07-01T15:50:00Z"
}'
```

## LLM model config

The transcript extractor is provider-swappable without code changes via
`LLM_PROVIDER`:

- **`google`** (default) — **`gemini-2.5-flash-lite`**, cheapest per token and
  ample for this schema-constrained extraction. Set `GOOGLE_API_KEY` (or
  `GEMINI_API_KEY`); override the model with `GEMINI_MODEL`.
- **`anthropic`** — `claude-haiku-4-5` (proven zod structured-outputs path). Set
  `ANTHROPIC_API_KEY`; override with `ANTHROPIC_MODEL` / `ANTHROPIC_EFFORT`.

Whichever provider runs, the output is validated against `SessionNoteSchema`
(zod) so the contract is identical. Provider code is `src/llm/providers.ts`;
settings live in `src/llm/config.ts`.

## Session extraction

A matched conversation with a transcript is processed off the request path
(`src/session/process.ts`): it claims the row, runs `extractSessionNote`
(outside any txn), and upserts an `appointment_sheet` + `protocol` (both
`draft`), tracked via `conversations.extraction_status`
(`pending`/`processing`/`done`/`failed`). Failures mark `failed` and log to
`system_events`. Needs `ANTHROPIC_API_KEY` to reach `done`.

## Next

- Drive integration (`src/integrations/drive/`): after approval, fetch
  `/review/*/render` Markdown and write the Sheet + Protocol into the client's
  Drive folder via the Google Drive API (pending Google OAuth).
- PB REST client (`src/integrations/pb/`) + register the webhook subscription.
- Auth: Nicole login (still open). Inbound webhook shared-secret is done
  (`requireWebhookSecret` on both webhooks via `BEE_WEBHOOK_SECRET` /
  `PB_WEBHOOK_SECRET`; unset = accept + warn in dev, enforced when set).
- Checkout state machine (WF2) once PB REST API access + QB Payments are confirmed.
# bishopai-server
