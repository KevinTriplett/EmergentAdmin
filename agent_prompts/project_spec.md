# MN Host Automator — Project Spec

## What This Is
A local-only Node.js webapp that automates host tasks inside a Mighty Networks
community via headless Puppeteer browser automation. Single-user, localhost,
never deployed publicly.

## System Prompt

Read `agent_prompts/system_prompt.md` at the beginning of each session.

## Stage 1 Scope: removeSpaceMembers task -- DONE
- Login + session handling
- Remove all non-admin members from a selected space
- Frontend with live log streaming, abort, and dry-run toggle

## Stage 2 Scope: deploy to server -- DONE
- prepare project for server deployment
- generate server setup instructions

## Stage 3 Scope: addSpaceMember task -- DONE
- Modify frontend to add one member to all spaces
- Frontend with live log streaming, abort and headless toggles (no dry-run)

## Stage 4 Scope: Agreements Watcher -- MOSTLY DONE
Architecture plan: `.cursor/plans/agreements_watcher_*.plan.md`.
Five sub-stages (4a Foundation, 4b DM moderation, 4c Reconciliation cron,
4d Admin UI, 4e Change of heart).

### Stage 4a: Foundation -- DONE
- `src/config/agreements.ts` - `AGREEMENT_ARTICLES` (currently a single
  entry; collapse/expand the array to change the threshold), `AGREE_PATTERN`
  strict matcher, lookup helpers, and shared `postUrl`/`commentUrl` builders.
- `src/state/agreementsStore.ts` - SQLite-backed store (better-sqlite3)
  with atomic `claimAddForMember` dedup guardrail; `processed_emails`
  table for IMAP replay safety. Auto-creates `./data/ec-admin.db` (override
  via `EC_ADMIN_DB_PATH`).
- `src/ingestion/emailParser.ts` - RFC-822 -> structured notification
  parser. Three isolated regexes at the top are the only tuning knobs
  when MN's email shape shifts.
- `src/ingestion/imapPoller.ts` - IMAP polling loop + real imapflow-backed
  `openImapConnection`. Interval from `IMAP_POLL_INTERVAL_MS` (default 5 min).
  Opt-in via (`IMAP_USER` || `MN_EMAIL`) + `IMAP_HOST` + `IMAP_PASSWORD`.
  `IMAP_USER` is optional and defaults to `MN_EMAIL`; set it explicitly
  when MN_EMAIL is a forwarding alias whose mailbox is hosted elsewhere.
- `src/scheduler/taskScheduler.ts` - factored out of `server.ts`:
  `runNow` (HTTP, throws `TaskConflictError` on lock conflict - caller
  returns 409) + `enqueueBackground` (FIFO, for poller/cron). Shared
  log capture + fire-and-forget `sendRunLogEmail`.
- Optional `agreementsStore` passed into `createApp`; IMAP wiring lives in the
  entrypoint (`createAppWithScheduler`), shares one scheduler with cron reconcile.
- 8-email end-to-end integration test proves: 8 valid agreements ->
  exactly one add-all-spaces job; replays never double-fire.
- Docs: `.env.example`, `deploy.md §5.2`, `.gitignore` (`data/`).

### Stage 4b: DM moderation (malformed comments) -- DO NOT IMPLEMENT YET
Poller already calls `enqueueMalformedDm` when wired. Need:
`src/tasks/dmMember.ts` using the `chats/new?user_id=` shortcut URL,
`dms_sent` dedup table (schema already in place), rate-limit.

*(Stage 4b DM moderation deliberately skipped.)*

### Stage 4c: Reconciliation -- DONE

SQLite-backed **eligible member** list drives repair: anyone at or above
`REQUIRED_AGREEMENT_COUNT` gets one background `add-to-all-spaces` job via the
same `TaskScheduler` as IMAP. Optional `RECONCILE_COMMONS_CRON`; manual
`POST /run/reconcile-commons-membership`. Idempotent on already-added spaces.
`public/index.html` exposes **Enqueue reconcile** (calls the same POST; 404 hint if the agreements store is off).

**Stage 4f overlay (verified-added flag):**
- `members.commons_added_at INTEGER NULL` — set by `addToAllSpacesJob`
  itself when every configured space is Phase-1-verified present (see
  Stage 4g). Independent of the `members.added_at` dedup gate, which
  still guards the IMAP poller's one-shot enqueue.
- Dashboard list **"Eligible, not yet added to Commons"** uses
  `eligibleNotYetAddedMembers` from the overview; counter
  **"Members verified added to all Commons spaces"** uses
  `commonsAddedMemberCount` (counts `commons_added_at IS NOT NULL`,
  not the old dedup-gate semantic).

**Stage 4g overlay (consent gate: "added once, never again"):**
- New table `member_space_attempts(member_id, space_name, outcome,
  attempted_at, last_error)` with `outcome IN ('present','failed')`.
- `'present'` is written ONLY when `addSpaceMember` returns
  `success: true, error: ALREADY_A_MEMBER` — i.e. its Phase-1 search
  found the member's row in the space's filtered member list. Phase-2
  successes (the "Add to spaces" toast appeared, but no independent
  search ran) write nothing; the next reconcile pass Phase-1-verifies
  and records on that pass instead.
- `addToAllSpacesJob` consults the ledger before each iteration and
  skips spaces whose row is `'present'`. That's the consent guarantee:
  once we've added a member to a space, we never add them again, even
  if they later leave it. `commons_added_at` flips when every space is
  Phase-1-verified (skipped pre-loop OR `ALREADY_A_MEMBER` this run).
- `'failed'` rows are informational; reconcile retries them on the
  next pass. They never overwrite a `'present'` row, and they age out
  after 30 days (see `pruneFailedSpaceAttempts`, called at the start
  of every reconcile run with a 30-day cutoff — no separate cron).
- Reconcile scope is fixed to `commons_added_at IS NULL` (the old
  `RECONCILE_COMMONS_SCOPE` env var was removed; there's only one
  correct behavior under the consent guarantee).
- Manual `/run/add-space-member-all-spaces` accepts `force: true` in
  the body to bypass the pre-loop skip — the operator override path
  for "the member explicitly asked to be re-added to a space they
  left". Default `false` so a casual click never violates the gate.

**Stage 4g overlay (ineligibility list):**
- `src/config/ineligibleMembers.ts` exports `INELIGIBLE_MEMBERS`, a
  static array of `{ memberId, fullName, reason }` plus
  `isMemberIneligible` / `getIneligibilityReason` helpers. Edits are
  developer-only — the list is version-controlled and a redeploy is
  required for changes to take effect (no HTTP/UI management
  surface; auditability comes from git history).
- The gate fires in three places: the IMAP poller (records the
  agreement and claims the dedup, but skips the enqueue with a log
  line), `enqueueCommonsMembershipRepairJobs` (excludes ineligibles
  from the repair pass and logs the skipped count), and both manual
  add endpoints (`/run/add-space-member` and
  `/run/add-space-member-all-spaces` return HTTP 403 with the
  reason). `force: true` does NOT bypass ineligibility — `force` is
  the Stage 4g per-(member, space) override, which presupposes the
  member is eligible.
- `GET /status/agreements` filters ineligibles out of
  `eligibleNotYetAddedMembers`, decrements `eligibleNotYetAddedCount`
  accordingly, preserves the raw value as
  `eligibleNotYetAddedTotalIncludingIneligible` for diagnostics, and
  exposes `ineligibleMembers` at the top level so the dashboard can
  render a read-only panel.

### Stage 4d: Admin UI -- DONE

- **`GET /status/agreements`** — JSON rollup: SQLite `AgreementsOverview` + configured `AGREEMENT_ARTICLES`
  + optional IMAP watcher snapshot (`pollIntervalMs`, last manual poll + `PollResult`).
- **`POST /run/poll-agreements-mailbox`** — one-shot `ImapPoller.pollOnce` when the runtime wires the hook;
  responds with Stage 4a poll counters (`fetched`, `newAgreements`, …) or HTTP 404.
- **`public/index.html`** unified **Agreements & commons membership** card: live dashboard (refresh on load /
  Refresh), inbox poll button when IMAP telemetry is present, **Copy status JSON** (last successful dashboard payload),
  reconcile disabled when the agreements store is not mounted (**Enqueue reconcile** / Stage 4c).

### Stage 4e: Change of heart -- DONE

A daily change-of-heart audit walks every agreement post, expands all
"Previous Comments" loaders, scrapes the live comment list, and classifies
each member who already has a row in `agreements`:

- `'deleted'` — no current comment from this member (case 1, anomaly)
- `'edited'` — exactly one current comment, no longer matches the agree regex (case 2, anomaly)
- `'mixed'` — multiple current comments, at least one fails to match (case 3, anomaly)
- `'multi_agreement'` — multiple current comments, all match (case 4, *not* an anomaly)
- `'happy'` — exactly one current comment that matches (silent default)

Anomalous rows (`'deleted'`/`'edited'`/`'mixed'`) are excluded from the
member's effective agreement count via audit-aware `WHERE` clauses on every
counting query, so a member who hits "change of heart" automatically falls
below threshold and stops being eligible until they re-record. The first
three cases populate the names listed in the admin email; the fourth case
does not (matching the spec).

Triggers:
- `POST /run/audit-agreements` (manual; uses the exclusive scheduler lock).
- `AGREEMENTS_AUDIT_CRON` env var. **Default ON** at `0 3 * * *`. Set to
  `off` / `disabled` / `false` / `no` / `0` (case-insensitive) to disable;
  any other value is treated as a literal cron expression.
- UI: **Audit agreements (change of heart)** button in the
  Agreements & commons membership tab.

Email: every audit run sends a `sendRunLogEmail` whose summary is either
`0 anomalies — all clear (…)` or `N anomaly(ies): Alice (deleted), …`.

Files:
- `src/tasks/auditAgreements.ts` — pure `classifyMemberOnArticle` classifier.
- `src/tasks/changeOfHeartAuditJob.ts` — `SchedulerJob` that scrapes + classifies + writes audit_state.
- `src/state/agreementsStore.ts` — adds `audit_state` / `audit_at` columns
  (idempotent ALTER), `recordAuditOutcome`, `getAuditState`,
  `listMembersForArticle`; `recordAgreement` becomes an upsert that resets
  `audit_state` to NULL on re-record so a fresh "I agree" lifts the row back.
- `src/server.ts` — `POST /run/audit-agreements` + `AGREEMENTS_AUDIT_CRON`
  resolver (`resolveAuditCronExpr`) + cron schedule.
- `public/index.html` — audit button + handler.

## TODO
- index.html after clicking an action button (Remove or Add) replace those action
buttons with the Abort button -- DONE
- email the log generated at the end of a run by removeSpaceMembers or addSpaceMember
tasks in production to admin email addresses hard coded into an array, populated initially
with kt@kevintriplett.com -- DONE (see `src/email.ts`; silently no-ops unless
NODE_ENV=production AND all SMTP_* env vars are set; SMTP_* vars live in `.env.example`)
- debug addSpaceMember error, usually on first and sometimes second space, ERROR: Member search:
selector not found (.filter-bar-search-region div[aria-label='Search Members']) -- DONE
- when reconciling, add code to expand all comments because mighty networks only displays
a subset of comments, not all -- DONE (Stage 4e: audit job clicks
`.load-more-wrapper-previous a` until no more loader appears)
- when reconciling, send email to admin iff one or more members comments do not match
the agree regex -- DONE (Stage 4e always emails: "0 anomalies — all clear" or
"N anomaly(ies): Alice (deleted), …" — Q4 directive to send the happy case too)
- add retry to cron jobs on puppeteer flakiness, it seems to be happening alot. Maybe
explore adding waits during browser events that might trigger this flakiness.

## Stack
- Runtime: Node.js
- Backend: Express
- Browser automation: Puppeteer
- Frontend comms: WebSockets (ws package) for live progress streaming
- Frontend: Single HTML file, vanilla JS, no framework
- Config: dotenv (.env file, already added gitignored)

## Project Structure
```
/mn-host-automator
  /src
    server.ts                         # Express + WebSocket server
    email.ts                          # Admin run-log email (Stage 3 TODO)
    config/
      agreements.ts                   # Stage 4a: 8 article stubs + matcher
    scheduler/
      taskScheduler.ts                # Stage 4a: exclusive browser lock
    state/
      agreementsStore.ts              # Stage 4a: SQLite-backed state
    ingestion/
      emailParser.ts                  # Stage 4a: MN email -> event
      imapPoller.ts                   # Stage 4a: IMAP poll loop
    tasks/
      removeSpaceMembers.ts
      addSpaceMember.ts
    utils/
      browser.ts                      # Puppeteer launch + teardown
  /public
    index.html                        # Single-page UI
  /data                               # SQLite DB lives here, gitignored
  .env                                # Credentials — gitignored
  .env.example                        # Committed template
  .cursorrules                        # Agent behavior rules
  package.json
```

## Browser Lifecycle
- Puppeteer launches a new browser per task invocation.
- Browser is closed in a `finally` block regardless of success or failure.
- `headless` argument (default: true) controls visibility.
- No singleton. No browser reuse across tasks.

## Abort Mechanism
- Frontend sends `{ type: "abort" }` via WebSocket.
- Server sets a shared abort flag.
- Task checks the flag between each iteration of its loop.
- On abort: task stops, closes browser, returns partial result
  with `Aborted by user after ${count} removals`.
- Abort button is always visible and enabled while a task is running.

## Return Types
removeSpaceMembers tasks return: `{ success: boolean, removed?: number, error?: string }`

## Environment Variables
See `.env.example` for required variables. file `.env` has been configured by the user.

## More Detail
See `clarifications.md` for more detail about each task.