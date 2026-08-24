# Session handoff — 2026-08-24

Paste this into a new Claude Code session in `/home/val/Projects/Punch/bishopAI/server`
to pick up where this one left off.

**State: all work complete and verified. 673/673 tests pass, `tsc --noEmit` clean,
migrations 0035 + 0036 applied.** Three open decisions are listed at the bottom —
nothing is half-finished.

---

## The arc of this session

It started as a token-budget problem and turned into a clinical-safety one.

1. A client's extraction kept coming back with a truncated `narrative` stage. The
   proposed fix was to raise `LLM_MAX_TOKENS_CEILING` and re-run by hand.
2. That diagnosis was **wrong** — the ceiling was never the limiter — and the
   real fix was structural (below).
3. Re-running produced a *much bigger* note, which looked like success.
4. Then: **that recording contained three different clients.** The bigger note was
   worse, not better. Everything after that is about why one recording gets filed
   under one client when it holds several.

---

## Part 1 — Narrative extraction (token budgets)

### The wrong diagnosis, corrected

`LLM_MAX_TOKENS_CEILING` was already 96,000 by default for OpenRouter. Raising it
would have done nothing. The actual limiter was in `callStage`:

```ts
if (!canGrow || attempt >= 1) throw err;   // one doubling, then give up
```

Narrative started at 20,000 (8,000 budget + 12,000 reasoning headroom), doubled
once to 40,000, truncated again, threw — with 56,000 tokens of allowed budget
never requested.

### What was changed

**`src/session/extract.ts`**

- **Narrative now reads in windows** (`alwaysWindow: true`). This is the fix that
  ends the chore. The stage's output *grew with the session* — every concern,
  goal, follow-up and lifestyle slot in a full hour, each with a verbatim quote,
  in one response — so it failed on whichever session was longest rather than on
  anything tested. Windowing bounds output by the window, which is a constant.
  Same change `assessments` already had (measured 67%→78% recall).
  Escape hatch: `EXTRACTION_WINDOW_NARRATIVE=false`.
- **New `windowTurns` selector on `Stage`.** Narrative's windows are cut from the
  boilerplate-stripped turns so scheduling chatter doesn't eat window budget;
  clinical stages read every turn. Window plans are built per stage and memoised
  on the selector.
- **Truncation ladder got its own counter.** It used to test `attempt >= 1`, and
  `attempt` incremented on the rate-limit path too — so a stage that waited out a
  single 429 arrived at its first truncation with the growth allowance already
  spent. Now `growthRetries` is separate and climbs up to
  `LLM_TRUNCATION_RETRIES` (default 3).
- **Windows are checked before the chunk-fallback bookkeeping**, so a windowed
  stage no longer marks the note `partial` — windows are its reading, not a
  degradation.

**`src/llm/config.ts`** — added `truncationRetries`.

**`src/session/extractStages.test.ts` (NEW, 5 tests)** — the first tests in the
repo that drive a stage through a mocked provider. Covers: narrative windows a
long session; findings union across windows; a short session still runs as one
call; the ladder climbs `8000→16000→32000→64000`; a 429 doesn't spend the
truncation budget.

> ⚠️ This file imports `extract.ts` **statically and never resets the module
> registry**. `vi.resetModules()` hands `extract.ts` a second copy of
> `../llm/errors`, and the retry ladder dispatches on `instanceof
> TruncatedOutputError` — with a different class object every check fails and the
> bug under test hides behind the harness. Don't "fix" this.

### Also fixed
Two type errors left over from earlier correlation work (`tsc` was failing even
though tests passed): `ingest.ts` reconstructed a `matched` result without
`overlapSeconds`, and `poller.test.ts`'s mock had the same gap.

### Tradeoff to be aware of
Windowing narrative turns 1 request into ~4 per session. With `assessments`
already at 4, a session goes from ~10 requests to ~13. On a request-metered free
tier that's real. `EXTRACTION_WINDOW_TOKENS` (default 2500) tunes it.

---

## Part 2 — Multi-client recordings (the real problem)

### What's actually wrong

**Nicole records back-to-back clients continuously, so one recording routinely
holds several consultations.** Time-overlap correlation cannot solve this — a
recording spanning three sessions has no single correct appointment — and it
fails *confidently*. Every downstream check agrees: the note parses, the evidence
quotes verify against the transcript, coverage reads 99.7%.

Two recordings on 2026-08-20, both misfiled, neither able to self-correct
(the sweep only re-examined `unmatched` rows; both said `matched`):

| | REC‑A `e60ffcfd` | REC‑B `aa2cb392` |
|---|---|---|
| window | 19:27:32–20:08:49 | 20:36:27–21:36:57 |
| diarized speakers | **4** | **3** |
| names in transcript | Steve / Steven / Broderick | *none* |
| overlap math | Steve 148s (needs 450 → **rejected**); Jodi 2329s | Carissa 1800s **and** Jodi 1413s — both pass |

Read that carefully: **the overlap guard added earlier does not fix REC‑A — it
produces the original bug.** Time overlap is the wrong instrument.

The prior assignments came from `src/db/remediateJodiSession.ts`, which
hard-codes both IDs. That script is itself the "doing this every day in prod"
problem.

### What was built

**`src/correlation/multiSession.ts` (NEW)** — a *safety gate*, not a segmenter.
Three cheap deterministic signals, no LLM on the ingest path:

1. **≥4 diarized speakers.** Three is routine — the diarizer opens a new label
   when the client moves to the treatment table and mic distance changes. **Do
   not tighten this to 3.**
2. **>1 booked appointment with ≥5 min overlap.**
3. **A nearby client's first name spoken in the transcript.** Allows up to two
   trailing letters (Steve→Steven, Dan→Danny) but not Stevenson; surnames ≥4
   chars match exactly.

Any signal → `correlation_status = 'needs_review'`, nothing extracted.
**A veto never reassigns.** It parks the recording and names what looked wrong;
whose words are whose is Nicole's clinical judgement.

All three signals were validated against the real transcripts before wiring in,
including the counterfactual of REC‑A as originally filed:

```
REC-A under Jodi Hess -> HOLD
  - 4 distinct speakers in the audio
  - transcript names another client booked nearby: Steve Broderick (filing under Jodi Hess)
```

**`migrations/0036_correlation_hold.sql` (NEW)** — adds `needs_review` to the
`correlation_status` check constraint, plus a `correlation_hold_reason` column
and a partial index. It's a third terminal state deliberately: `unmatched` is a
queue the sweep keeps retrying, and retrying is exactly wrong here — it would
eventually find one overlapping appointment and file three people's content under
whoever it picked.

**`src/correlation/correlate.ts`** — new `listOverlapCandidates()`. Deliberately
*not* filtered by `NOT EXISTS (... cv.appointment_id = a.id)` the way the matcher
is: the matcher skips a taken appointment because it can't assign to it, but the
gate needs to know the appointment is *there*.

**`src/conversations/ingest.ts`** — the gate runs after the matcher and can veto
it. On replay, a hold can **demote** an existing match (the transcript often
arrives after the audio, so a recording that matched cleanly while wordless must
be re-judged once the words land) — but only an *auto* `matched` row, never
`manual` or `walk_in`.

**`src/scheduler/jobs/correlationSweep.ts`** — three changes:
- The re-match path gets the same veto (otherwise the sweep is a second, slower
  door to the identical bug).
- `processConversation` is now **awaited**, not fire-and-forget.
- **New audit pass over already-`matched` rows** — the half the incident actually
  needed. A match is made against the calendar as it stood at that instant, and
  PB syncs late: Steve's 19:00 appointment landed two minutes *after* his
  recording was filed. Demote-only, and only while every derived document is
  still `draft`. **Demotion also deletes the derived draft sheet + protocol** in
  the same transaction — detaching alone left the contaminated note in the chart
  with no source behind it.

**`src/routes/review.ts`** — two things:
- **Fixed a dead endpoint.** `handleSplitConversation` selected *and* inserted
  `bee_id`, a column that doesn't exist (it's `source_id`). Both
  `/review/unmatched/:id/split` and `/review/conversations/:id/split` threw on
  the first query. **The only mechanism that could separate a multi-client
  recording had never worked.**
- `correlation_hold_reason` now returned by the unmatched queue + detail view, so
  "split this" is distinguishable from "tag this".

**`src/session/process.ts`** — explicit `correlation_status <> 'needs_review'`
guard in the claim.

**`src/correlation/multiSession.test.ts` (NEW, 12 tests)** — every threshold
anchored to one of the two real recordings.

### It caught the incident by itself

The running dev server hot-reloaded and its scheduled 08:00 sweep demoted both
recordings unprompted, with correct reasons:

```
warn  existing match demoted — may span more than one client
      was_filed_under: Steve Broderick   reasons: ["4 distinct speakers…"]
warn  existing match demoted — may span more than one client
      was_filed_under: Jodi Hess         reasons: ["recording spans 2 booked appointments…"]
```

That surfaced a bug in the audit pass (drafts survived demotion), which is now
fixed.

---

## Current data state

```
aa2cb392  needs_review  pending   "recording spans 2 booked appointments: Carissa Lauer (30m), Jodi Hess (24m)"
e60ffcfd  needs_review  pending   "4 distinct speakers in the audio — a two-person consultation diarizes to 2…"
```

Both detached, both visible in Nicole's review queue with reasons. Contaminated
drafts deleted — nothing had human edits (`note_revisions` empty), nothing was
approved, nothing was sent to a client.

## Files touched

| File | |
|---|---|
| `src/session/extract.ts` | narrative windowing, `windowTurns`, retry ladder |
| `src/llm/config.ts` | `truncationRetries` |
| `src/session/extractStages.test.ts` | **new** — 5 tests |
| `src/correlation/multiSession.ts` | **new** — the safety gate |
| `src/correlation/multiSession.test.ts` | **new** — 12 tests |
| `src/correlation/correlate.ts` | `listOverlapCandidates()` |
| `src/conversations/ingest.ts` | gate + hold state + type fix |
| `src/scheduler/jobs/correlationSweep.ts` | gate, await, audit pass, draft withdrawal |
| `src/session/process.ts` | `needs_review` guard |
| `src/routes/review.ts` | `bee_id`→`source_id`, hold reason |
| `src/integrations/pocket/poller.test.ts` | mock type fix |
| `migrations/0036_correlation_hold.sql` | **new** |
| `scripts/reextract.mts` | **new** — re-run one conversation |
| `scripts/hold-multisession-recordings.mts` | **new** — dry-run by default |

## Useful commands

```bash
npx vitest run                                          # 673/673
npx tsc --noEmit -p tsconfig.json                       # clean
npx tsx src/db/migrate.ts                               # 0036 applied
npx tsx scripts/reextract.mts "Client Name"             # re-run one extraction
npx tsx scripts/hold-multisession-recordings.mts        # dry run; --apply to act
psql postgres://bishop:bishop@localhost:5433/bishopai
```

The scheduler is gated behind `SCHEDULER_ENABLED=true`; `correlationSweepJob`
runs `*/15 * * * *` with a 7-day window (`CORRELATION_SWEEP_DAYS`).

---

## Open decisions (nothing blocked, all yours to call)

1. **Patricia Carrero is also flagged** — 5 speakers on her 2026‑08‑14 recording
   (`7f2ec007`), still `matched`/`done`. Only the speaker-count signal fires (no
   spanned appointments, no foreign names), so it may be benign diarization drift.
   She wasn't auto-demoted because `CORRELATION_SWEEP_DAYS=7` puts 08‑14 outside
   the window. Needs a look, or a hold.

2. **The 7-day audit window** means any bad match older than that is never
   re-examined. A one-off full-history audit would settle it —
   `scripts/hold-multisession-recordings.mts` does exactly this, dry-run by
   default. Its earlier dry run also flagged several DEMO/seed recordings
   (9 and 10 speakers), which is correct behaviour but would change seeded demo
   state.

3. **`src/db/remediateJodiSession.ts` still exists** and hard-codes the wrong
   assignments. You chose "detach and hold" over the option that deleted it, so
   it was left in place — but re-running it would re-pin both recordings to the
   wrong clients. Recommend removing it.

---

## Two things not to re-learn the hard way

- **`extraction.attribution_coverage` is not a correctness metric.** It measures
  whether a role was *assigned*, not whether it was assigned right. It read
  **99.7%** on a transcript where **31.4% of words** sat in turns the diarizer had
  merged across speakers (a practitioner question and the client's answer in one
  turn, handed wholesale to one role at high confidence). It was cited twice in
  this session as evidence a note was clean. It isn't.

- **"No partial stages" ≠ "right client."** A note that extracts completely from
  the wrong recording passes every check in the pipeline.
