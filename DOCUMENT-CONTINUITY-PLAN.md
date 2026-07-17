# Document continuity + in-app review — plan

Two rounds of planning that led to the current review-flow build. Kept here
for reference since neither round has a natural home elsewhere in the repo.

## Round 1 — "our flow only controls from new docs"

Problem identified: all three client documents (ROF, Supplement Protocol,
Appointment Flow Sheet) were being built purely from the current session's
extracted note, not the client's accumulated history. Two concrete symptoms:

- A supplement mentioned in session 1 but not repeated in session 2's
  transcript would silently disappear from the Supplement Protocol, even
  though it's still part of the client's active plan.
- When Nicole is reviewing a draft, she has no way to see the *previous*
  approved document for that client to compare against — no sense of "what
  changed."

Proposed fix (status: **built**, see Round 2):

1. Give the Supplement Protocol its own source of truth — the `supplements`
   table (accumulated/active rows), not `note.supplements` (this session's
   mentions only). Render from the accumulated table, merged with this
   session's changes.
2. Let Review Queue / Review Detail look up the client's last *approved*
   sheet and protocol for side-by-side comparison.
3. (Not yet done) Populate the unused `documents` table on every publish, so
   each client has a discoverable history of Drive links over time — a
   "folder of stuff already done." This was proposed but superseded by the
   more concrete Round 2 ask before it was built; **still open**.

## Round 2 — recreate Flow Sheet / Supplement Protocol as in-app review UI

Refinement: rather than just linking out to Drive/Sheets, recreate the two
continuously-updated documents (Flow Sheet, Supplement Protocol) as an
editable/approvable view *inside the desktop app*, used before anything is
written to Drive. Requirements:

- AI must correctly map symptoms / Foundation / Body Scan from the
  transcript, and clearly mark a field blank when the transcript doesn't
  state it — never guess.
- Show both the new (this-session) version and the previous session's
  version side by side.
- Layout simple enough to be easy to understand, but familiar enough to
  match the paper/Excel template Nicole already reads.

Agreed 4-step implementation order (approved, all **built**):

1. **Thread `client_id`** from Review Queue rows through to Review Detail,
   so client-scoped lookups (prior sheet/protocol, supplement plan) are
   possible from the modal.
2. **Flow Sheet panel** — read-only, template-shaped (DATE / SYMPTOMS /
   FOUNDATION / BODY SCAN / PROTOCOL / lifestyle log), this session next to
   the previous approved session. Also surfaced the previously-invisible NRT
   findings (Pulse 0, Priority #1, K-27, Stressors, Foundation, Body Scan)
   and Lifestyle log (BM/Sleep/Water/Cycle/Exercise/Diet) as editable fields
   in the Edit tab — blank/unstated fields get a distinct "Not stated in
   transcript" / "Not mentioned" placeholder rather than looking broken.
3. **Supplement Protocol panel + continuity fix** — shows what will actually
   be written (full accumulated plan), this session's changes, the prior
   plan baseline, and the previous session's changes. Backed by the
   continuity fix from Round 1: `toSupplementData` / `renderClientTemplates`
   / `publishClientTemplates` now source the grid from the `supplements`
   table via `fetchCurrentSupplements` (real accumulated state) and
   `previewSupplementMerge` (pure preview of what approving would do,
   mirroring `syncClientSupplements`'s rules without writing).
4. **Previous-session comparison** — new `GET /review/{sheets,protocols}/:id/context`
   endpoint returns the client's last *approved* sheet/protocol (never a
   draft) plus `{ current, merged }` supplement plan; wired into both panels.

### Verification done

- `server`: `tsc --noEmit` clean; `templateData.test.ts` /
  `publishTemplates.test.ts` / `publishTemplates.email.test.ts` (13/13) pass.
- `desktop`: `npm run typecheck` clean (both tsconfig.node.json and
  tsconfig.web.json).
- Live `curl` against `GET /review/protocols/:id/context` for a real seeded
  client returned the expected shape: `prior: null` for a client's first
  session, `merged` correctly reflecting this session's new supplements
  against an empty `current` baseline.
- Full server vitest suite has 7 unrelated pre-existing failures, all in
  `*.int.test.ts` files (PB booking, Outlook inbox poller, lead intake,
  maintenance) — confirmed via direct DB connectivity check and grep that
  none touch the files changed here.

### Open / not part of this round

- **`documents` table population** (Round 1, item 3) — still not built.
  Would give each client a queryable history of published Drive files
  instead of only the latest one being discoverable.
- **Google Sheets API disabled** on the Google Cloud project — external
  Cloud Console setting, blocks real (non-demo) Flow Sheet writes only.
  Not fixable from code; someone with Console access needs to enable the
  Sheets API for the project.
- **`dangerouslySetInnerHTML`** in `ReviewDetail.tsx`'s Preview tab renders
  markdown-derived HTML unsanitized. Pre-existing, flagged but not in scope
  here.
