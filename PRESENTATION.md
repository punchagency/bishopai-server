# Presentation runbook — Nicole's filled templates

Two ways to show the templates getting filled. **Path A** is the bulletproof
fallback (no database, no internet). **Path B** is the live click-through in the
dashboard. Do a dry run of whichever you'll present ~30 min before.

All commands run from `server/` unless noted.

---

## Path A — One command, tangible files (most reliable)

```bash
npm run demo:templates
```

Produces filled documents under `server/demo-output/Leeza Woodbury/`:

- `ROF/ROF.docx` — Report of Findings (created once at intake)
- `SupplementProtocol/Supplement Protocol 6_15_26.xlsx` and `… 7_9_26.xlsx` — a new dated version per session
- `AppointmentFlowSheet/Leeza Woodbury Appointment Flow Sheet.xlsx` — one appointment block appended per session (two blocks after this run)

Open them to show Nicole her real templates, filled. No DB, no Google, no internet.

---

## Path B — Live click-through in the dashboard

Nicole watches the queue, clicks **Approve** on a Protocol, and the three docs
appear in a folder.

### Start-up (once)

```bash
# 1. Postgres
docker compose up -d

# 2. Schema (includes the new flow_sheet_id column)
npm run migrate

# 3. Sample data — clients, appointments, draft Protocols in the review queue
npm run seed

# 4. Backend in PRESENTATION MODE (writes filled files locally on approval)
npm run demo:server
```

Then launch the dashboard (from `desktop/`):

```bash
cd ../desktop && npm run dev
```

### The click path

1. Open **Review Queue**.
2. Click a draft **Protocol** to open it.
3. Click **Approve**.
4. Within ~2 seconds, three files appear under
   `server/demo-output/<Client>/` — ROF, Supplement Protocol, Appointment Flow
   Sheet. Have that folder open in a file browser to show them landing.

**Approve two clients, in this order — the contrast is the whole point:**

- **Seed Maya Chen** — a full session. Every NRT finding (Pulse 0 `78, thready`,
  Priority #1, K-27, stressors, foundation, body scan) and the whole lifestyle log
  come out filled.
- **Seed Lena Petrov** — a short session where Nicole ran out of time. Her ROF has
  Pulse 0 and stressors but **Priority #1, K-27 and the body scan are blank**, and
  the Flow Sheet's BM / CYCLE / EXERCISE labels are empty — because none of it was
  said aloud. Nothing was guessed.

That second document is the trust argument: the system fills what it heard and
leaves the rest for her, rather than inventing a plausible clinical value.

### Then show the prep brief — this is the payoff

Approving a note isn't the end of it. Go to **Schedule**, click **Lena's return
visit** (tomorrow), and hit **Prep brief**. It gives her back:

- her open follow-up ("Recheck in 8 weeks", dated from the *session*, not from today);
- what happened last visit;
- her current plan, with which supplements have run out and were never reordered;
- and **"Not covered last time: Priority #1, K-27, Body scan, Bowel movements,
  Cycle, Exercise."**

That last line is the one to sit on. The system knows what Nicole *didn't* get to,
and it only knows that because it refused to guess. The blanks from the Lena
document just became her checklist for the next appointment. Nothing else in her
current stack can do that.

**Seed David Osei** already has an approved session, so his brief is populated
without approving anything — use him if you want to show a brief cold, before the
review-queue demo.

### Reset between run-throughs

Approval fires the templates **once** per protocol (re-approving is a no-op by
design). To present again with fresh drafts:

```bash
npm run seed        # restores draft Protocols
rm -rf demo-output  # optional: clear previous output
```

---

## Talking points

- **Three docs, three update models:** ROF is created once at intake; the
  Supplement Protocol is re-versioned by date each session; the Flow Sheet
  appends one block per appointment into the *same* sheet.
- **Her exact templates** — the ROF keeps all her branded boilerplate (NRT
  program copy, diet list, payment plan); the Supplement grid keeps her terracotta
  borders; the Flow Sheet uses her pre-formatted blocks. We only drop values in.
- **What auto-fills:** symptoms/concerns and goals, the supplement plan (with
  start/stop/continue), follow-ups, the **NRT findings** (Pulse 0, Priority #1,
  K-27, stressors, foundation + body-scan muscle testing), and the **lifestyle log**
  (BM / sleep / water / cycle / exercise / diet).
- **Anything not said in the session stays blank.** The extractor is instructed
  never to infer a clinical value — a blank cell is correct, a fabricated one is a
  clinical error. In the demo, the follow-up session's `CYCLE:` label is empty
  because the client didn't mention it. Worth pointing at: it shows the system
  knows what it doesn't know. Still frame the docs as **review drafts** she signs
  off, not final records.
- **The Flow Sheet grows.** Her template has 7 pre-formatted blocks; past that we
  manufacture new ones with the same borders/merges, so a long-term client never
  hits a wall.
- **Follow-ups stop evaporating.** "Recheck her B12 in four weeks" used to be a line
  of text in a note nobody re-read. It's now a dated task on the Overview, and it
  resurfaces in the prep brief for that client's next visit. A due date is set only
  when she actually said a timeframe — no invented intervals.
- **The prep brief.** Before each client: open follow-ups, last session, current
  plan (including what ran out and was never reordered), outstanding billing, and
  what wasn't covered last time. Optionally emailed to her at 7am as one digest of
  the day — to *her*, never to a client. Set `PRACTITIONER_EMAIL` to switch it on.
- **Emailing the client is built but switched off.** We can attach the filled
  Supplement Protocol (and the ROF at intake) straight to the client. It stays off
  until Nicole says so — approving a protocol is her internal review, not consent to
  mail clinical documents out. Flip `EMAIL_PROTOCOL_TO_CLIENT=true` when she's ready.
  Good question to ask her in the room.

## Going to REAL Google Drive instead of local files

Presentation mode (`npm run demo:server`) always writes locally. To write to
Nicole's actual Google Drive, run the normal `npm run dev` with valid Google
creds in `.env` — **and first re-run `npm run google-auth`**, because the Flow
Sheet needs the `spreadsheets` scope that older refresh tokens don't have.
