# Hot-restart shutdown fails closed — re-landed on current `master` (PZUA-349)

Date: 2026-11-23
Status: implemented in `fix/pzua-349-hot-restart-fail-closed`
Supersedes: `doc/plans/2026-11-12-hot-restart-fail-closed.md` (PZUA-270, PR #16)

## Why a re-implementation instead of a rebase

The PZUA-270 fix is still correct, but the code it patched moved:

- `server/src/services/heartbeat.ts` was split; the shutdown preparation verdict
  now lives in `server/src/services/heartbeat/recovery.ts`
  (`prepareHotRestartShutdown`, `reconcileHotRestartAdoption`).
- The coordinator (`server/src/shutdown.ts`) now quiesces the scheduler
  **before** preparation, because a late queue claim between the two would
  create a run absent from both the snapshot and the selective drain set.
- `hot-restart.ts` gained boot-identity/PID-recycle checks and a legacy
  (home-root) marker hand-off. Neither changes this invariant.

Every cherry-pick of the four original commits conflicted, so the guards below
are re-expressed against the current file layout. The **semantics are the
approved ones**; the deltas are listed at the end.

## Invariant

**A pending hot-restart intent (`drainRequired:false`, `previousServerPid` =
this pid) makes the graceful run drain unreachable** — not "unreachable on the
happy path", unreachable regardless of the preparation outcome, because
preparation can fail exactly in the situation the hot restart exists for (a
dying embedded Postgres).

Corollary: the shutdown snapshot is what the next boot adopts from, so it must
exist even when the database is dead. Everything the shutting-down server knows
*without* the database is written first; the run list is an enrichment, never a
precondition.

## Guards (in evaluation order at shutdown)

| # | Guard | Site |
|---|---|---|
| 1 | Pre-DB snapshot write: intent as read, `signal`, pid, `capturedAt`, `activeRuns: []`, `activeRunsCaptured:false` | `server/src/services/heartbeat/recovery.ts:617` |
| 2 | Run-list read isolated (`readRunningRunsForRestart`); a closed connection is logged, recorded as `run_list_unavailable`, and the already-written snapshot is kept | `server/src/services/heartbeat/recovery.ts:517`, `:622` |
| 3 | Enrichment rewrite is skipped when the run list could not be read, so a failed read never truncates the snapshot to "no runs" | `server/src/services/heartbeat/recovery.ts:670` |
| 4 | `appendRunEvent` per run wrapped: failure logs `run_event_append_failed` and continues | `server/src/services/heartbeat/recovery.ts:684` |
| 5 | Once the intent is honored the verdict is always `skipDrain:true` (`mode: hot_restart_degraded` when anything degraded) | `server/src/services/heartbeat/recovery.ts:714`, `:732` |
| 6 | Coordinator fail-closed: a *failure verdict* plus a pending intent ⇒ `failClosed:true`, and the caller never reaches the drain | `server/src/shutdown.ts:390` |
| 7 | Disk-only intent probe, no DB; unreadable intent ⇒ pending | `server/src/services/hot-restart.ts:693` |
| 8 | `skipHeartbeatDrain = shouldSkipHeartbeatRunDrain(heartbeatShutdown)` — one predicate for the drain decision | `server/src/shutdown.ts:421`, `server/src/index.ts:2325` |
| 9 | A *failure verdict* (`preparationFailed`, e.g. `read_error`) is escalated to the probe; a *deliberate* drain verdict (`drain_required`, `pid_mismatch`, `not_requested`, ACP `acp_drain_required`) is not | `server/src/services/heartbeat/recovery.ts:555`, `server/src/shutdown.ts:390` |
| 10 | Unreadable intent on boot is quarantined (`hot-restart-intent.corrupt-<ts>.json`, bytes kept) so it cannot suppress the graceful drain forever | `server/src/services/hot-restart.ts:661`, `server/src/services/heartbeat/recovery.ts:747` |
| 11 | Adoption defers (`mode: deferred`, `deferredReason: "run_table_unreadable"`), keeps the intent and writes no report when the run table is unreadable on the boot that reconciles | `server/src/services/heartbeat/recovery.ts:795`–`833` |

Guards 10 and 11 exist because "fail closed" and "adopt later" are only safe if
the state is recoverable: a corrupt intent must be moved aside, and an
unreadable run table must leave the intent for the next boot (otherwise the
restart reports a clean empty adoption — the false all-clear this change is
about).

Guard 6 is deliberately independent of guard 5: it holds even if preparation
throws for a reason not anticipated here (file system, a future code path), and
it needs no database. It is the only place that decides "drain or not".

## Ordering (D2)

1. write snapshot (`activeRuns: []`, `activeRunsCaptured:false`) — durable, DB-free
2. read the running-run list
   - failure ⇒ stop here, keep step 1's snapshot, mark `run_list_unavailable`
3. rewrite the snapshot with the run list and `activeRunsCaptured:true`
   (also when the list is genuinely empty — that is what makes the emptiness
   meaningful)
4. append one leave-alive run event per run (best effort)

`activeRunsCaptured:false` is the difference between "no runs were running" and
"we could not look". Snapshots written before the flag existed parse as
`activeRunsCaptured:true`, so old intent files keep their exact meaning.

## Adoption (next boot)

`reconcileHotRestartAdoption` treats `activeRunsCaptured:false` — and a snapshot
that is missing altogether — as "unknown": it classifies the rows still marked
`running` instead of trusting the empty list. Those runs are reported `lost`
with `missing_process_metadata` / `process_not_alive` (or adopted when a live
child is found).

## Unchanged

- `drainRequired:true`: `mode: drain_required`, `skipDrain:false` — the classic
  path, and its early return stays above every snapshot write.
- `not_requested`, `pid_mismatch`: unchanged; both drain.
- ACP / server-stdio runs: still a deliberate `acp_drain_required` drain —
  but only after a successful run-list read. With an unreadable run list the
  server cannot know whether such a run exists, so it stays fail-closed instead
  of guessing "none".
- `drainHeartbeatRunsForShutdown` itself: unchanged.

## Deltas from PZUA-270 (review these)

1. **Scheduler idle wait is not skipped on fail-closed.** Current `master`
   quiesces the scheduler before preparation (see above). The re-land keeps
   that order; the fail-closed decision only owns the *drain*, so a bounded idle
   wait before an unreachable drain is harmless. The original tests asserted
   "idle wait not called" on the failure path; they now assert `failClosed:true`
   plus `shouldSkipHeartbeatRunDrain(...) === true`.
2. **`nextRunEventSeq` no longer exists.** The append is a single CTE
   (`execute`), so the old "closed connection at `nextRunEventSeq`" case and the
   "closed connection at `appendRunEvent`" case are now the same injection point;
   the re-land keeps one test for the append failure (`dbFailingOn(... execute
   containing heartbeat_run_events)`) instead of two that would prove the same
   thing.
3. **Missing snapshot ≠ unknown run list.** Only `activeRunsCaptured:false` means
   "the previous server could not look", so only that flag triggers recovery of
   the still-running rows. A snapshot that is missing altogether means the write
   failed *after* a successful read, so current `master`'s contract stands: the
   preflight ids are reported `lost` (`missing_shutdown_snapshot`) instead of
   being adopted on the strength of a row nobody snapshotted. The preflight ids
   already present in the recovered candidates are filtered out so no run is
   reported twice.
4. **`degradedReasons` is only present when non-empty**, so the non-degraded
   verdict stays byte-for-byte `{mode, skipDrain, activeRunIds}` and existing
   exact-equality assertions keep their meaning.

## Tests

- `server/src/shutdown.test.ts` — fail-closed coordination: a throwing probe, a
  preparation that returns `read_error`/`skipDrain:false` while the probe says
  pending, `throw undefined`, `drain_required` with no pending intent (still
  drains), ACP drain with a pending intent (still drains), and the
  `shouldSkipHeartbeatRunDrain` truth table.
- `server/src/services/hot-restart.test.ts` — disk-only helpers: pre-flag
  snapshots parse as `activeRunsCaptured:true`, the flag survives a write/read
  cycle, `isHotRestartShutdownPending` (pending / drain-required / absent /
  corrupt ⇒ true), and quarantine (moves, keeps bytes, the probe stops seeing it).
- `server/src/__tests__/heartbeat-process-recovery.test.ts` — `CONNECTION_CLOSED`
  injected at the run-list `SELECT` and at the leave-alive run-event append: both
  return `skipDrain:true` with a snapshot on disk; plus the integration case
  (intent present, DB down ⇒ no drain, next boot reports `lost` /
  `missing_process_metadata`), adoption deferring with the intent kept when the
  run table is unreadable, and a corrupt intent quarantined instead of failing
  every future shutdown closed.
