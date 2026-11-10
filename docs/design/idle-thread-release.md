# Releasing idle threads from the daemon's memory

Status: implemented in #852 (phase 1) and #853 (phase 2, stacked on #852), both open. Written against `master` at `c93ad82` (after #848). "Built" notes below record where the code differs from the first draft.

## Summary

Once a thread runs a turn, the daemon keeps it loaded until the daemon stops: its transcript, its model context and its turn state. This design releases a thread that has been idle for 10 minutes and reloads it from its thread database the next time something needs it. Nothing on disk changes, and windows see nothing.

Reading the code turned up a second cause that is cheaper to fix and probably larger. At startup, `ThreadRuntimeManager.restoreOnStartup` reads the agents and tasks of every thread that is not settled. That read (`ThreadDbStore.readState`) loads each whole transcript and keeps the last 64 in the thread database cache, whether or not anyone uses them. The plan fixes that first (phase 1, storage only), then releases idle threads (phase 2, run engine).

## 1. What a loaded thread holds

| Holder | Where | What | Size |
|---|---|---|---|
| Session | `OrchestratorService.sessions` → `ThreadSession` | `messages` (the whole transcript, with images and outputs over 64 KB read back from `blobs/`), `nativeContext` (the model context: its own copy of the model-visible history), `queue` (a copy of the queue on disk), turn fields | Text ≈ stored size |
| Thread database cache | `ThreadDbStore.entries` (up to 64 threads, `MAX_CACHED_THREADS`) | A skeleton of every row. Its strings are the same string objects as the session's, so a save can compare by identity | ≈ 0.16 KB per message on top of the shared text |
| Transcript assembler | `OrchestratorService.transcripts` (a WeakMap keyed by session) | Turn assembly state | Freed with the session |
| Runtime | `ThreadRuntimeManager.runtimes` → `ThreadRuntime` | Agents, tasks, activity, PTY ids | Small; kept |
| Turn state | `OrchestratorService.turnStates` | Phase, error, pause | Small; kept |
| Context gauge copy | `OrchestratorService.measured` (#848) | One unloaded thread's copy | One thread at most |
| Run engine | `RunEngine` (SQLite), `epochs` only for runs that have not ended | Runs, effects, inbox, approvals, receipts | On disk; nothing per idle thread |
| Provider process | Claude `LiveSession` (closes after 3 min idle, `LIVE_IDLE_CLOSE_MS`; at most 4), Codex and ACP sessions | Its own process and buffers | Not the session's memory; it does not reference the session |
| Replay ring | `MmsProtocolServer.audienceRings` | Last 512 events per audience, superseded copies dropped (#848) | Not per thread |
| Subscriptions and watchers | `events.subscribe` is per client and profile, not per thread. No file watcher is per thread | none | none |

**Measured** (unit level, `ThreadDbStore.load` + `ThreadSession.load` + `skeletonOf`, heap after forced GC, 3 runs each; synthetic turns of a 400 B prompt, 2 KB thinking, 8 tool results and a 2.5 KB reply):

| Thread | Stored text | Held while loaded | Of which the object graph | Cold reload |
|---|---|---|---|---|
| 20 turns, 6 KB tool results (220 messages) | 1.01 MB | 1.11 MB | 0.04 MB | 12 ms |
| 100 turns, 6 KB (1,100 messages) | 5.04 MB | 5.54 MB | 0.18 MB | 65 ms |
| 100 turns, 1.5 KB (1,100 messages) | 1.61 MB | 2.11 MB | 0.18 MB | 58 ms |

So a loaded thread holds about its stored size: transcript rows plus model context rows (`c:a`, `c:r`), images and large outputs included, plus about 0.3 KB per message. A typical 30-turn coding thread is 2–5 MB. One with screenshots is 10–30 MB. Two consequences:

- **The text is shared by the session and the cache.** Dropping only the session frees about 0.16 KB per message. A release must also drop the cache entry (`ThreadDbStore.forget`).
- **Startup.** `restoreOnStartup` calls `loadThreadWorkState` → `ThreadDbStore.readState` → `fresh()` for every thread that is not settled. That is a full `load` on the event loop, and the last 64 stay in `entries`. With a few hundred threads, the daemon holds 64 whole transcripts from the start: 64 × 2 MB ≈ 130 MB. That is about the gap between a fresh home (127 MB) and the user's 306 MB. It is a hypothesis to confirm on an isolated home with about 100 threads (§6).
- **Measured (#852): the hypothesis does not hold.** The user's real home has 73 `thread.db` files, 20 MB in all (median 208 KB, p90 688 KB, largest 1.4 MB; a size-only listing). On an isolated home with 100 threads sampled from those sizes, startup held 64 threads and 44.5 MB of heap before phase 1, and 0 threads and 37.7 MB after. Private memory went from about 170 MB to 164 MB. Phase 1 saves about 6 MB here, not 130 MB.

## 2. When a thread is idle

`OrchestratorService.releaseHoldReason(threadId)` returns undefined only when every one of these holds (built: it returns the reason the thread stays, for tests and logs). Each one is a cheap in-memory or indexed read.

- **No turn.** `!session.isTurnRunning()`, `!turnAdmitted`, `!drainAfterSettle`, `!abortRequested`, `!stopping`, `sentAfterStop.length === 0`, `setupStop === null`, `executionLease === null`, no `activeTurn` (so no unread `pendingSteer`).
- **No run still going.** No run of the thread that has not ended (`engine.listRuns(threadId)`, paused and waiting continuation runs included). No `turnResults` or `pendingContinuations` entry for it. No undelivered effect in the outbox.
- **Empty queue on disk.** `listPendingQueue` and `listClaimedQueue` of `loadMessageQueue(threadId)` are empty, steer-intent items included. No unfinished queue command (`getQueueJournal().commands.listUnfinished`).
- **Nothing it waits on.** No pending delegations (`ThreadRuntimeManager.pendingDelegations`). No unacknowledged inbox rows. No pending approvals or questions. No pending handoff (`handoffs.pendingForThread`). No `providerBackground`.
- **No provider process.** A new `HarnessGateway.hasLiveProcess(threadId)` (an optional `ProviderAdapter.hasLiveProcess`) returns false. Claude closes its own process after 3 idle minutes, so this rarely waits.
- **No lifecycle work.** No `compactions`, `titleWork`, `folderWaits`, `definitionStops`, `agentCreations`, `startupDrainScheduled`, or `scheduledTurnThreads` entry. `ThreadMutex.isLocked(threadId)` is false. No archive, delete, expiry or retention operation is in flight (the lifecycle store's admission is open and the thread is not `deleted`).
- **Nothing only memory knows.** `failedConnectionRequest === null` (Retry needs it). No transcript row is still open (`isOpenActivityRow`), so a reload's `closeStaleActivity` has nothing to change. The thread is in `thread.db`: threads still on JSON files are not released.
- **Not the first send.** `firstSendPending` is a flag on disk and holds no memory. A thread that has it has never run a turn, so it is never loaded by one.
- **Not shown in a window** (built, decided in review). The window sends `threads.focus` for threads of this computer too. The daemon keeps the shown threads per window connection and forgets them when the connection closes; each new connection of a window (after a daemon restart or a dropped connection) shows the daemon its thread again. A shown thread stays loaded however long it is idle.
- **Built:** a provider process is reported by Claude only (`hasLiveProcess`). Codex and ACP adapters report none: their process does not reference the session, so a reload works either way.

**Policy.**

- Release a thread idle for 10 minutes (`IDLE_RELEASE_MS`), checked by a sweep every 60 s (`unref`'d timer).
- Every `getOrCreateSession` updates its last use. So do snapshot, `changesSince` and context-gauge reads of a loaded thread.
- Keep at most 8 idle loaded threads. Past that, release the least recently used one after 60 s idle.
- The thread database cache gets a byte cap (48 MB of payload) besides its 64 entries. Built: the cap passes over threads a loaded session holds (their text is the session's, so dropping them frees little and the next save would read them again on the event loop). A use moves a thread to the front, not only its load.
- Built: the numbers are constants at the top of `src/mms/orchestrator/ThreadResidency.ts` (`IDLE_RELEASE_MS`, `MAX_IDLE_LOADED`, `LRU_MIN_IDLE_MS`, `IDLE_SWEEP_MS`) and `MAX_CACHED_BYTES` in `threadDbStore.ts`.

## 3. Release and reload

A new `ThreadResidency` (in `src/mms/orchestrator/ThreadResidency.ts`) owns last use, a `warming` count per thread, the sweep and the LRU. A thread's state is **unloaded** (no map entry), **warming** (a reload is reading it in the read worker), or **loaded**. Releasing is a single synchronous step, never a state of its own.

**The lock is run-to-completion.** `releaseIfIdle(threadId)` checks the rule, saves and drops in one synchronous call, with no `await`. A send, Steer, drain or reload is JavaScript on the same event loop, so it runs entirely before or entirely after a release. The thread database save inside it already takes the cross-process `withThreadDataMutationLock`.

`releaseIfIdle(threadId)`:

1. Skip the thread if `warming > 0`, if `releasableNow` is false, or if the thread is the bound session.
2. **Make sure disk has everything.** If a persist timer is pending, clear it and persist now. That write was owed anyway. Otherwise ask `ThreadDbStore.unsaved(dir, change)`, a new dry run of `plan()`. If it reports changes, save them and count `residency.unsavedAtRelease`. Never save unconditionally: every save moves `updatedAt` and sends `threads.touched` (#819), which would reorder the sidebar. A failed save throws and leaves the thread loaded.
   Built: a thread that never saved a model context gets one rebuilt from its transcript at every load (`migrateLegacyContext`). That context is not owed when it equals the rebuild, so loading such a thread and letting it idle writes nothing. The memory test found this: without it every such thread saved at release.
3. Drop: set `session.released = true`, `sessions.delete(threadId)`, `ThreadDbStore.forget(dir)`, clear `measured` if it is this thread. Keep `ThreadRuntime`, `turnStates`, MCP state and the provider registry. Emit nothing.

**Reload.**

- `getOrCreateSession` already rebuilds a session from disk (`loadThreadData`, `restoreDelegatedWorkspace`, `restoreScheduledWorkspace`, the runtime's agents and tasks). It is the path every thread takes after a daemon restart, so release followed by reload equals a restart of that one thread. The rule in §2 makes sure only state that a restart rebuilds is dropped.
- A new `ensureSessionLoaded(threadId)` does `warming++`, `await threads.warmThread(threadId)`, `warming--`, then `getOrCreateSession`. That way the parse happens in the read worker and not on the event loop. Callers that can wait use it: `orchestrator.send` and `queue.promoteToSteer`. Built: the effect worker's `turn.start` and continuation start keep the synchronous load. A thread with a run is never released, so they only cold-load after a restart, as before.
- Synchronous callers keep `getOrCreateSession`, which is correct, only slower (a cold load).

**Races.**

| Case | Outcome |
|---|---|
| Send or Steer arrives during a release | It cannot. Release is one synchronous step, so the send runs before it (the thread is then not idle) or after it (it reloads). |
| Send to a released thread | `ensureSessionLoaded` reloads it. The send's own admission (receipt, #806/#807 binding, queue) runs as today. |
| Steer to a released thread | A released thread has no running run, so `steerRun` is refused by the engine as for any ended run, and #845's rules apply (the message is queued or runs as its own turn). |
| Queue drain | Claims already check delivery against disk under the queue lock (`scheduleQueueDrain`: `acceptedQueueItemIds` against the transcript on disk). Exactly-once never depended on the session. |
| Two reloads at once | Both may warm, which is harmless: the later `remember` wins, and `warm` returns early when the entry exists. The map insert in `getOrCreateSession` is synchronous, so the first creates the session and the second finds it. |
| Release during a reload | `warming > 0` skips the thread. If the reload already finished, the session is fresh and was just used, so it is not idle. |
| Async work holding an old session | Covered by the rule in §2. As a backstop, `get session()` (AsyncLocalStorage), `scheduleQueueDrain` and `persist` re-resolve a session marked `released` by its id, warn once, and count `residency.staleUses`. Built: instead of `liveMessagesForSave` returning nothing, the profile's persist skips a thread with no session (an empty list handed to the save could remove rows), so a stray persist neither reloads nor writes. |
| Crash during a release | Release writes at most one save, one transaction that was owed anyway. Nothing on disk records "released". A crash at any point is a crash of an idle loaded thread, and startup recovery (`reclaimForStartup`, `closeStaleActivity`) works as today. |
| Another process writes the thread | `ThreadDbStore.fresh()` already compares `dbId`, `seq` and `epoch` on every use. A reload reads the newest state. |

## 4. What must never be lost

- **Queued messages, steer items and claims:** on disk, written under the queue lock by `mutateDurableQueue` at every change. The session's `queue` is a copy. The release rule requires an empty queue anyway.
- **Receipts, runs, effects, inbox, approvals:** in the run engine's SQLite, committed by each command.
- **Transcript, model context, agents, tasks:** saved before the drop (step 2). `unsaved()` makes "nothing left to write" a checked fact, not an assumption.
- **Memory-only state:** listed in §2 and required to be empty. A Retry after a failed connection (`failedConnectionRequest`) keeps its thread loaded.

## 5. What windows see

- **Nothing changes.** Release and reload emit no events and do not change `ThreadListVersion`, `threads.updated` or `threads.touched`.
- **Opening a thread.** `thread.snapshot` and `thread.messages` already serve a thread with no session from its database (`readMessagePage`, `seq` and `epoch` for `changesSince`). A released thread opens exactly like one never loaded since start. Because disk equals memory at release, the messages are the same.
- **Status.** `isTurnActive`, `isActiveTurnRunning` and `getTurnState` read only loaded sessions and `turnStates`, so a released thread still shows Done or its error. Activity comes from the `ThreadRuntime`, which is kept, so `activity.snapshot` does not change.
- **Cost of the first action after a release:** the reload, measured at about 12 ms for a 220-message thread and 65 ms for 1,100 messages (about 55 µs per message, most of it in the read worker with `ensureSessionLoaded`). A provider process would have been closed by its own idle timer anyway.

## 6. Tests

**Race tests** (`tests/run/idleThreadRelease.test.ts`, on `phase6Fixture` like `queueSteerExactlyOnce.test.ts`, with an injected clock and `residency.sweepNow()`):

- A turn ends, then the sweep runs: the thread is unloaded, and the next send runs once with the full history.
- Send in the same tick as the sweep, on both orders (`queueMicrotask` and `setImmediate`): one turn, one receipt, `staleUses === 0`.
- Queue A and B behind a turn, then sweep during the drain: nothing is released until the queue is empty, and A and B run once each, in order.
- Steer (#845) on a queued message, then sweep while the steered message is unread: not released. Once it is read and the turn ends: released.
- Stop (#829) with a message sent during the stop, then sweep: not released until the message has run.
- Two `ensureSessionLoaded` calls at once: one session object.
- Sweep while `warmThread` is pending: skipped.
- A failed save at release: the thread stays loaded and nothing is lost.
- Each item in §2 holds the thread loaded on its own (table-driven).
- A subagent child and a scheduled-run thread reload with `sharedWorkspace` and `primaryCheckout` restored. Built: not written; the reload path is `getOrCreateSession`, which restores both for every thread after a restart.
- Release followed by reload yields the same `thread.snapshot` as before. No `threads.updated` or `threads.touched` is emitted, and `updatedAt` does not move.
- Kill during release (a child process killed mid-save, as `platformWorkflowDaemonCrash.test.ts` does): on restart the queue and transcript are intact. Built: the daemon runs in a child process and kills itself (SIGKILL) right before, and in a second test right after, the COMMIT of the release's save, while another thread has a queued message. After a restart the transcript is the last committed one, the queued message runs once, and no turn is sent twice. A separate in-process test covers a save refused before it reaches the database.
- Built, also: a shown thread is never released while any window shows it; the kill switch; the LRU cap; queue, Steer and receipts (a repeated `clientRequestId`) across a release.

**Memory regression** (`tests/idleThreadMemory.test.ts`, heap after forced GC with `v8.setFlagsFromString('--expose-gc')`):

- Load 5 synthetic threads of 1,100 messages, end their turns and sweep. The heap returns within 1 MB of where it started, and `ThreadDbStore` holds no entries for them.
- Phase 1: `restoreOnStartup` over 100 started threads leaves `coldLoads === 0` and no cache entries.

**By hand, once:** private bytes on an isolated home (agent-isolation rules, no window: `--cli service run`) with about 100 copied threads, before and after each phase.

Measured (100 synthetic threads sized from the real size listing, 3 runs each):

| | Private MB | Heap used | Loaded |
|---|---|---|---|
| Startup, master | 170 | 44.5 MB | 64 cached |
| Startup, phase 1 | 164 | 37.7 MB | 0 |
| 20 largest touched, then idle 95 s, phase 1 only | 205 | 69.5 MB | 20 sessions |
| Same, phase 2 (timers shortened to 60 s idle in a local build) | 199 | 48.9 MB | 0 |

Releasing the 20 threads freed the 20 MB of heap they added. Private bytes fell less within the 95 s because V8 keeps freed heap pages for a while.

## 7. Rollout and risks

1. **Phase 1, storage only:**
   - A state-only engine op (`ThreadDbEngine.state`: `SELECT key, payload FROM state`) used by `readState` when the thread is not warm, so startup and runtime hydration never load transcripts.
   - The cache's byte cap.
   - Low risk; no run-engine change.
2. **Phase 2, release behind a feature flag:**
   - The flag is `releaseIdleThreads` in `MousseFeatureFlags`. Decided in review: on by default, so it saves memory; `features.releaseIdleThreads: false` is the kill switch, read at every sweep.
   - Run-engine change (tier 5): council review if the user agrees.
3. **Phase 3, later:**
   - Release threads waiting on subagents. Their wake path already reloads.
   - Close a live provider process first, instead of waiting for it.

| Risk | Mitigation |
|---|---|
| Code keeps a session reference across an `await` the rule does not cover, and writes to a released object | `released` tombstone, re-resolve by id, `staleUses` counter asserted 0 in the suites, the flag to turn it off |
| A release save moves `updatedAt` and reorders the sidebar | Save only what is owed (pending timer, or `unsaved()` is true); test asserts no `threads.touched` |
| Reload stalls the event loop for large threads | `ensureSessionLoaded` warms in the read worker first |
| Release and reload thrash for a thread used every few minutes | 10 min idle, LRU of 8 |
| Something only memory knew is lost | The rule refuses while it is set; a table-driven test per field |
| `closeStaleActivity` on reload marks rows interrupted | Release requires no open activity rows |

## Decisions (were open questions)

1. 10 minutes idle, 8 idle threads kept and a 48 MB cache cap, as constants that are easy to change.
2. A thread a window shows stays loaded however long it is idle.
3. Phase 1 ships first, on its own (#852).
4. A read-only listing of `thread.db` sizes under the user's home was allowed and run (sizes only); see §1.
