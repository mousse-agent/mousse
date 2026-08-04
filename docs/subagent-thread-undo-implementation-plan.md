# Mousse Subagent and Thread Undo Implementation Plan

**Source documents:** `docs/SUBAGENT_AUDIT.md`, `docs/thread-undo-architecture.md`  
**Planning basis:** current repository state; preserve completed fixes and implement only open or partial work  
**Delivery model:** gated milestones, with thread workspaces and undo disabled until their exit gates pass

## 1. Goals

This plan combines the subagent audit remediation with the thread workspace, checkpoint, publish, undo, fork, and recovery architecture. The work must produce four guarantees:

1. Mousse never deletes or integrates uncommitted, still-running, ambiguously owned, or unrecoverable agent work.
2. Every Git-backed thread executes inside its own durable branch and worktree instead of the primary checkout.
3. Every mutating turn has a durable conversation record and Git range that can be compensated without rewriting history.
4. GUI, CLI, channel, scheduler, and background-agent operations converge on the same thread-owned, repository-locked state after concurrency, conflict, restart, or crash.

## 2. Current-State Delta

The current code already contains useful fixes that must be retained: explicit `AbortController` support for GUI subagents, refusal of normal `complete_task` for `starting`/`running`, durable Mousse transcript snapshots, thread-scoped `ThreadSession` and `ThreadRuntime`, cross-process thread execution leases, protocol-backed CLI access, bounded PTY scrollback, unique-prefix agent lookup, and some worktree path validation.

The remaining delta is:

| Audit item | Current state | Required implementation |
|---|---|---|
| Dirty agent worktree deletion | Partial | `prepareForReady()` currently auto-commits worker changes, and successful merge cleanup still uses `worktree remove --force`. Require worker-authored commits, recheck cleanliness immediately before integration, and never force-remove in a success path. |
| Integration while worker is active | Partial | GUI abort exists and active statuses are rejected, but completion, process termination, readiness, and integration are not one persisted state machine. Normal completion can still consider cancelled/interrupted/completed branches. Stop and await every worker before validation; allow normal integration only from `ready` and persisted conflict retry states. |
| Busy GUI messages are dropped | Open | Protocol returns `{ok:true}` even when the session is missing or busy, and the renderer clears input/loading on IPC completion. Return an explicit send result and preserve rejected input. |
| Ready/completed GUI tabs | Partial | Sessions are retained until finalization, but `ready` sessions still expose a live composer and completed transcript access is inconsistent. Make terminal state explicit, disable the composer, and retain an archived transcript until thread GC. |
| GUI restart/thread ownership | Partial | Snapshots exist, but `MousseAgentService` is global and production restoration is incomplete; persistence can export all live sessions into the wrong thread generation. Make every session and event thread-owned. |
| Cursor concurrency | Open | Cursor scope remains process-global and resets sessions when paths change. Serialize the entire Cursor request lifecycle unless the SDK gains request-local scope. |
| Mousse MCP/Skill policy | Open | `LlmClient` suppresses MCP in Build mode and skill discovery still checks `enableForMainAgent`. Introduce an explicit integration principal. |
| Generated MCP secrets | Open | Generated config contains environment references while `AgentConfigPreparationResult.env` stays empty. Extract literal secrets into deterministic child environment variables with collision checks. |
| Worker exits | Open/partial | PTY exits do not reconcile linked agents; successful headless exit without progress remains running; headless lacks an `error` listener and bounded scrollback. Centralize exit handling. |
| Transactional spawning | Open | Failures after task/worktree allocation can orphan tasks, configs, branches, worktrees, monitors, or processes. Add an allocation ledger and rollback policy. |
| CLI agent management | Partial | CLI now uses the daemon and `agents.list`/`agents.stop` protocol methods exist, but CLI `spawn` and `stop` are disabled and protocol stop lacks thread/merge validation. Implement the documented commands. |
| Non-finite progress | Partial | `TaskQueue` guards non-finite input, but `TaskProgressMonitor` can still propagate `NaN`. Reject invalid values at the protocol boundary and monitor parser. |
| Renderer/scrollback retention | Partial | PTY scrollback is bounded; `AgentsPanel` does not dispose removed xterm instances and headless output is unbounded. Dispose and cap both. |
| Worktree identity/safety foundation | Open | Worktree and branch names use eight-character IDs; `WorktreeManager` has mutable repository root, recursive deletes, unconditional prune, and branch force-delete paths. Replace these before durable thread worktrees. |
| Repository identity/lease | Open | Only per-thread execution/data locks exist. Add stable repository identity and an asynchronous repository mutation lease. |
| Runtime data relocation | Open | Project thread data still lives at `<project>/.mousse/.data`. Move it outside repositories with verified lazy migration. |
| Transactional generations/journal | Open | Thread fields are separately replaced JSON files. Add immutable generations, append-only operation journal, fsync, and startup reconciliation. |
| Durable thread workspace/checkpoints | Open | Main turns, project terminals, Files, and Git still target the project primary checkout. Add workspace resolution and per-turn commits. |
| Publish/undo/fork/redo/trash | Open | No implementation exists. Build these only after the storage and workspace gates pass. |

## 3. Non-Negotiable Invariants

Implement and test these invariants before enabling thread workspaces:

1. Full IDs are used in branch names, refs, worktree directories, journal records, and ownership keys. Short IDs remain display-only and may only be accepted through unambiguous resolution.
2. A Git mutation receives an explicit `RepositoryContext`; no service mutates a selected/global repository root.
3. Lock ordering is always thread execution lease first, repository lease second. No code path may acquire them in reverse.
4. A registered worktree is removed only through Git after path, registration, branch/ref reachability, cleanliness, operation ownership, and process termination checks pass.
5. Dirty or ambiguous state is preserved for recovery. Cleanup never makes an uncertain state “look successful.”
6. Thread runtime data is never stored beneath a repository worktree after migration.
7. Journal intent is durable before a Git/filesystem operation starts. A new thread-data generation becomes current only after Git state is reconciled.
8. Git is authoritative for commits, refs, worktrees, and sequencer files. The journal is authoritative for intended Mousse operations and recovery decisions.
9. All non-ignored changes in a thread worktree at checkpoint time belong to that action, except a small, fixed, documented set of generated internal paths.
10. Tool path capture is diagnostic metadata only; it never determines what is staged.
11. Undo appends compensating commits and conversation events. It never resets or rewrites shared history.
12. Undo/publish/fork/revert is disabled while a turn, descendant agent, workspace mutation, publish, merge, revert, or conflict-resolution operation is active.
13. Non-Git threads keep current execution behavior but report filesystem undo, publish, and Git branching as unavailable.
14. Ignored files, writes outside the workspace, MCP side effects, databases, network calls, external processes, and global commands are reported as non-reversible effects.
15. Keyboard/editor Undo remains unrelated to thread undo.

## 4. Target Storage and Git Layout

### 4.1 Mousse home

```text
<MOUSSE_HOME>/
  repositories/
    <repoId>/
      repository.json
      leases/
        repository.lease
      worktrees/
        threads/<threadId>/<conversationBranchId>/
        agents/<agentId>/
      threads/
        <threadId>/
          manifest.json
          migration.json
          workspace.json
          generations/<generationId>/
            generation.json
            messages.json
            llm-context.json
            agents.json
            tasks.json
            queue.json
            mousse-agent-sessions.json
            conversation-branches.json
            actions.json
          journal/<sequence>.json
          terminals/
          execution.lease
          thread-data.mut.lock
          queue.mut.lock
      trash/
        threads/<threadId>/...
  standalone/.data/<threadId>/...
  repository-identities/<fallbackKey>.json
```

`queue.json` may remain separately lockable during the migration milestone, but each published generation must record the queue revision it observed. Once all producers use the generation store, move queue state into generations and retain a dedicated queue journal/lock for high-frequency claims.

### 4.2 Git metadata

```text
branches:
  mousse/thread/<fullThreadId>/<fullConversationBranchId>
  mousse/agent/<fullAgentId>

retained refs:
  refs/mousse/threads/<fullThreadId>/<fullConversationBranchId>
  refs/mousse/agents/<fullAgentId>
  refs/mousse/recovery/<operationId>
```

Store the repository ID in `<git-common-dir>/mousse/repository.json` when writable. For read-only common directories, store a generated ID under `<MOUSSE_HOME>/repository-identities/` keyed by a normalized common-directory fingerprint, and retain the canonical common-directory path only as a relocatable hint.

## 5. Shared Domain Model

Extend `src/shared/types.ts` and add focused domain types under `src/shared/workspace.ts` and `src/shared/threadActions.ts`.

### 5.1 Identity and workspace types

Define:

- `RepositoryId`, `ConversationBranchId`, `TurnId`, `ActionId`, and `OperationId` as branded strings or consistently documented aliases.
- `RepositoryContext`: repository ID, Git top-level, canonical common directory, primary checkout path, project-relative subdirectory, worktree base, and capability flags.
- `ThreadWorkspaceMetadata`: schema version, repository ID, branch/ref, worktree path, project-relative subdirectory, base/head SHA, active conversation branch, lifecycle, and last verified time.
- `WorkspaceLifecycle`: `unprovisioned | provisioning | ready | missing | conflicted | tombstoned | recovery_required`.
- `WorkspaceCapability`: Git-backed, checkpointable, publishable, and undoable flags plus an unavailable reason.

### 5.2 Action and operation types

Define:

- `ThreadAction`: IDs, branch, parent turn/action, presentation-message range, native-context boundary, `startSha`, `endSha`, ordered child integrations, changed paths/hashes, known external effects, reversibility, status, timestamps, and compensation action when applicable.
- `ConversationBranch`: ID, name, parent branch/turn, Git branch/ref, active action, context pointer, compaction boundary, lifecycle, and creation reason.
- `ThreadOperation`: operation ID/type, action/branch, state, owner, timestamps, expected Git state, sequencer progress, conflict files, error, and recovery decision.
- Action states: `planned | running | checkpointing | completed | stopped | failed | undoing | undo_conflict | undone`.
- Integration states: `planned | worker_stopping | validating | merging | merge_conflict | merged | cleaning | completed | failed`.
- Publish/revert/fork/trash states with the same planned/running/conflict/completed/failed pattern.
- `NativeContextBoundary`: message index, compaction generation, fidelity, and safe-boundary proof.

Add optional `turnId`, `actionId`, and `conversationBranchId` to `ChatMessage` for legacy-compatible migration. New messages must always carry them.

### 5.3 Agent lifecycle types

Replace ad hoc status changes with:

```text
provisioning -> starting -> running -> stopping -> validating -> ready
ready -> merging -> conflict | cleaning -> completed
any active state -> failed | cancelled | interrupted
conflict -> merging | cancelled
```

Add `stopping`, `validating`, and `cleaning` to `AgentStatus`; store transition reason, operation ID, worker exit data, spawn base SHA, worker head SHA, pre-merge SHA, integration SHA, and retained ref on `Agent`. Keep task status user-oriented while deriving it from agent transitions.

Add `MousseAgentSendResult` with `accepted | busy | missing | terminal`, plus current run state and a human-readable reason.

## 6. Milestone A — Immediate Subagent Safety

This milestone is independent of the user-visible undo rollout and should ship first.

### 6.1 Replace mutable worktree roots with explicit repository contexts

**Files:**

- Rewrite `src/mms/worktree/WorktreeManager.ts`.
- Add `src/mms/git/RepositoryIdentity.ts`.
- Add `src/mms/git/RepositoryContext.ts`.
- Add `src/mms/git/GitStateInspector.ts`.
- Update `src/mms/MousseMainService.ts`, `src/mms/orchestrator/OrchestratorService.ts`, and tests constructing `WorktreeManager`.

**Steps:**

1. Resolve `--show-toplevel`, `--git-common-dir`, current worktree path, current branch/HEAD, and project-relative subdirectory from the requested project path.
2. Remove `WorktreeManager.repoRoot`, `setRepoRoot()`, shared `SimpleGit`, and `.mousse-worktrees` beneath the selected checkout.
3. Require `RepositoryContext` for create, validate, merge, cleanup, scan, and branch/ref operations.
4. Use full IDs in `mousse/agent/<agentId>` and `<worktreeBase>/agents/<agentId>`.
5. Parse `git worktree list --porcelain` and verify the exact registered path and branch before any cleanup.
6. Detect `MERGE_HEAD`, `REVERT_HEAD`, `CHERRY_PICK_HEAD`, `BISECT_LOG`, and sequencer/rebase directories before starting an operation. Refuse unrelated state.
7. Remove automatic `git worktree prune`, recursive deletion of pre-existing paths, and unconditional branch force-delete.
8. Provide a separate maintenance API that scans stale registrations and returns a report; pruning requires repository lease, explicit confirmation, and proof that no journal/workspace/retained ref references the entry.
9. In non-Git mode, use a clearly typed temporary workspace capability. Never present a plain directory as a mergeable Git worktree.

### 6.2 Make agent readiness strict and non-destructive

**Files:** `src/mms/worktree/WorktreeManager.ts`, `src/mms/tasks/TaskProgressMonitor.ts`, `src/mms/orchestrator/systemPrompt.ts`, `tests/worktreeReadiness.test.ts`, `tests/worktreeCompletion.test.ts`.

1. Remove auto-stage/auto-commit behavior from `prepareForReady()`.
2. Stop and await the worker before readiness inspection.
3. Remove generated agent integration files using their allocation manifest before checking status. Delete only files whose current hash matches the generated hash; treat modified generated files as recoverable dirty work.
4. Run `git status --porcelain=v2 --untracked-files=all`; exclude only the exact progress file and verified generated paths.
5. Require no staged, unstaged, conflicted, or untracked implementation paths.
6. Verify the actual branch, `spawnBaseSha`, worker `HEAD`, at least one worker-authored commit unless explicitly verification-only, and the changed-path claim.
7. Persist `workerHeadSha` and changed paths before changing the agent to `ready`.
8. Immediately before merge, repeat process-liveness, branch-head, worktree-cleanliness, generated-path, and Git-sequencer checks.
9. Use `git worktree remove <path>` without `--force` after the retained ref and integration journal record are durable.
10. If cleanup fails after merge, keep status `cleaning` and retry idempotently; do not roll back or misreport the already successful merge.

### 6.3 Centralize lifecycle transitions and worker control

**Files:**

- Add `src/mms/agents/AgentLifecycleService.ts`.
- Add `src/mms/agents/AgentSpawnTransaction.ts`.
- Add `src/mms/agents/WorkerHandle.ts`.
- Update `src/mms/orchestrator/OrchestratorService.ts`.
- Update `src/mms/terminals/PtyManager.ts` and `src/mms/terminals/HeadlessAgentRunner.ts`.

1. Make `AgentLifecycleService.transition(agentId, expectedStates, nextState, metadata)` the only registry status mutation path.
2. Reject illegal transitions and make repeated terminal/exit events idempotent.
3. Represent GUI, PTY, and headless workers behind `WorkerHandle.stop()`, `waitForExit()`, `isAlive()`, and exit/error events.
4. Include `threadId`, `agentId`, exit code, signal, error, and intentional-stop token in every worker event.
5. Add a child-process `error` listener and bounded scrollback to `HeadlessAgentRunner`.
6. Include exit code/signal in `PtyManager` exit events.
7. On an unexpected worker exit, perform one final synchronous progress-file reconciliation. If no terminal progress exists, mark the agent/task failed or interrupted with an exact reason instead of leaving it running.
8. Guard delayed interactive launch callbacks with an atomic `starting -> running` transition and cancel the timer during stop/rollback.
9. On completion signal, transition to `stopping`, stop/await the worker, then `validating`; never validate from inside an active GUI tool-loop callback.
10. Permit normal `complete_task` integration only from `ready` and a matching `conflict` retry operation. Recovery of cancelled/interrupted work must be a separate explicit API requiring confirmation.

### 6.4 Make spawning transactional

For each assignment, `AgentSpawnTransaction` records allocated task, worktree, generated config, monitor, worker, and registry entry.

1. Validate assignment, integrations, command construction, and model selection before allocating Git resources where possible.
2. Persist a `provisioning` agent record and operation intent before worktree creation.
3. Allocate in this order: task/agent IDs, repository context/lease, worktree, generated integration manifest, worker, progress monitor, live status.
4. On failure before a worker starts, remove only a verified clean worktree and unreferenced branch, clean generated files, mark task/agent failed, and complete the operation journal.
5. On failure after a worker might have mutated the worktree, stop/await it and preserve branch/worktree/config evidence. Mark the record failed with a recovery path.
6. Make cleanup idempotent so startup reconciliation can finish a partially rolled-back spawn.
7. Persist delegation-batch membership and owning thread instead of keeping it only in `Set`/`WeakMap` memory.

### 6.5 Fix GUI subagent send and transcript behavior

**Files:** `src/mms/agents/MousseAgentService.ts`, `src/mms/orchestrator/OrchestratorService.ts`, `src/mms/protocol/handlers.ts`, `src/mms/protocol/types.ts`, `src/main/ipc/registerGuiIpc.ts`, `src/preload/index.ts`, `src/renderer/components/MousseAgentChat.tsx`, `src/renderer/components/AgentsPanel.tsx`.

1. Require `threadId` for every Mousse-agent protocol request and lifecycle event.
2. Key runtime sessions by `(threadId, agentId)` or instantiate one session store per `ThreadRuntime`; do not use one globally exported session map.
3. Restore each thread’s snapshots during runtime hydration. Convert previously running turns to `interrupted` without auto-restarting them.
4. Persist checkpoints directly to the owning thread generation, independent of selected thread.
5. Return `MousseAgentSendResult` from service through protocol and IPC.
6. Reject busy, missing, ready, completed, cancelled, and unrecoverable sessions explicitly.
7. In `MousseAgentChat`, clear input/attachments only after `accepted`; preserve text and show the reason for `busy`/`terminal`/`missing`.
8. Keep loading until a thread-scoped idle, completed, failed, or interrupted lifecycle event arrives, not until IPC acknowledgement returns.
9. Disable the composer for `ready` and terminal sessions. Show status and recovery/integration guidance.
10. Retain completed/closed transcript snapshots until thread trash GC. Remove only active runtime handles at integration.
11. Dispose xterm instances and wrappers when their agent is no longer visible, on PTY exit, and on panel unmount.

### 6.6 Correct Cursor and integration isolation

**Files:** `src/mms/providers/cursorPiProvider.ts`, `src/mms/orchestrator/LlmClient.ts`, `src/mms/integrations/mcp/McpManager.ts`, `src/mms/integrations/agents/AgentConfigManager.ts`, `src/shared/integrations.ts`.

1. Add `IntegrationPrincipal = main | subagent:<AgentTypeId>` and pass it through request-context preparation, MCP discovery/calls, skill discovery/loading, and diagnostics.
2. Resolve `enableForMainAgent` only for `main`; resolve `enableForAgents[agentType]` for subagents. Remove mode-based MCP suppression.
3. Include principal and workspace path in MCP/Skill cache and connection keys so project-local integrations cannot bleed across worktrees.
4. Add `CursorRequestScheduler`. Because the SDK scope is process-global, acquire a fair async mutex before setting scope and retain it until the entire stream/tool turn completes or aborts.
5. Use a stable session key derived from thread/agent identity; never call `process.chdir()`.
6. Add abort-aware mutex waiting and release in `finally`.
7. While rendering external-agent MCP config, replace each literal secret with a deterministic namespaced environment reference and populate `result.env` with the original literal.
8. Detect collisions: identical variable/value may deduplicate; identical variable/different value must receive separate names or fail preparation. Never silently overwrite.
9. Render references in syntax supported by each target CLI and test expansion for Claude, Codex, OpenCode, Cursor, and Mousse.
10. Never log secret values or persist them in the worktree allocation manifest.

### 6.7 Complete CLI agent management and resource bounds

**Files:** `src/cli/commands/agents.ts`, `src/cli/help.ts`, `src/mms/protocol/types.ts`, `src/mms/protocol/handlers.ts`, `src/mms/orchestrator/OrchestratorService.ts`.

1. Add `agents.spawn` protocol method accepting `threadId` plus validated assignments.
2. Make `agents.stop` require `threadId`, resolve exact/unambiguous agent ID within that thread, and accept `merge` only for `ready`/conflict retry unless an explicit recovery flag is supplied.
3. Implement documented CLI `spawn`, `list`, and `stop [--merge]` using the daemon.
4. Resolve thread from `--session`; otherwise use the persisted active thread only when unambiguous. Never silently choose the first open thread.
5. Return structured operation IDs/statuses in JSON mode and readable recovery guidance in text mode.
6. Reject non-finite progress in protocol validation, `TaskProgressMonitor`, and `TaskQueue`; do not coerce it to zero.
7. Cap headless scrollback with the same bounded-ring utility used by PTY output.

### Milestone A acceptance criteria

- A dirty worker completion is rejected and its worktree remains byte-for-byte intact.
- No success path invokes force removal, recursive deletion, automatic prune, or force branch deletion.
- An active GUI/PTY/headless worker is stopped and observed exited before validation.
- A second GUI message returns `busy` and remains in the composer.
- Two Cursor turns for different worktrees cannot overlap the process-global scope.
- Mousse MCP/Skill enablement follows the Mousse-agent toggle independently of the main-agent toggle.
- Generated child environment contains every referenced literal secret without collisions or secret logs.
- Every spawn-stage fault produces either complete rollback of untouched resources or a durable failed/recoverable record.
- CLI agent commands work across separate invocations through the daemon.

## 7. Milestone B — Repository Identity and Locking

### 7.1 Repository identity

Implement `RepositoryIdentityService` in `src/mms/git/RepositoryIdentity.ts`.

1. Resolve identity from `git rev-parse --git-common-dir`, canonicalize it, and distinguish linked worktrees from the primary checkout.
2. Read/create the stable repository ID under the common directory; use the Mousse-home fallback only when common-directory writes fail.
3. Store path hints, filesystem identity where available, creation time, schema version, and last-seen top-level.
4. On moved repositories, search known project paths/common-directory hints, validate the ID, then repair hints without changing `repoId`.
5. Refuse bare repositories and unborn `HEAD` for initial workspace provisioning with a capability reason.

### 7.2 Repository lease

Add `src/mms/git/RepositoryLease.ts`, modeled after but separate from `ThreadExecutionLease`.

1. Use atomic exclusive creation, PID/process-instance/token ownership, operation ID, timestamps, and heartbeat.
2. Provide abortable async acquisition with bounded delay; never busy-spin the Electron/daemon event loop.
3. Reclaim only after ownership/liveness and publication-grace checks.
4. Cover worktree create/remove, branch/ref changes, merge, revert, publish, sequencer recovery, maintenance prune, and GC.
5. Add lock-order assertions in development/tests: a repository lease may be acquired only while the owning thread lease is held, except repository-wide read-only maintenance that acquires no thread lock.
6. Add multi-repository tests proving independent repositories do not block each other.

### Milestone B acceptance criteria

- Concurrent GUI, CLI, channel, scheduler, and background operations serialize mutations in one repository.
- Two repositories proceed concurrently.
- Stale recovery never removes a live foreign lease.
- No lock-order deadlock is possible in fault-injection tests.

## 8. Milestone C — Runtime Data Relocation

**Files:**

- Update `src/mms/data/paths.ts`, `ProjectManager.ts`, `ThreadDataStore.ts`.
- Add `src/mms/data/ThreadStorageLayout.ts`.
- Add `src/mms/data/ThreadMigrationService.ts`.

### Steps

1. Make repository-backed thread lookup resolve to `<MOUSSE_HOME>/repositories/<repoId>/threads/<threadId>`.
2. Retain standalone threads under Mousse home and project membership in metadata/indexes.
3. Stop creating `.mousse/.data` in `ProjectManager.openProject()`.
4. Add repository ID, original project path, Git top-level hint, and project-relative subdirectory to thread metadata.
5. On first access to a legacy project thread:
   - acquire its data mutation lock;
   - create a migration intent record;
   - copy every data file and terminal snapshot to a new staging directory;
   - verify file count, sizes, and hashes;
   - atomically publish the new location/index;
   - write a pointer/marker in the old thread directory;
   - continue reading the old copy only if publication fails.
6. Do not delete legacy data until a later app start successfully loads and validates the new generation. Move legacy data to trash rather than recursively deleting it.
7. Update thread listing/search, active-thread restoration, channel sessions, scheduler jobs, queue leases, project removal, title generation, and protocol snapshots to use the layout resolver.
8. Ensure migration is idempotent after failure at every copy/verify/publish step.

### Milestone C acceptance criteria

- Git checkout/revert/worktree deletion cannot alter thread conversations, tasks, queues, sessions, leases, or terminal data.
- Legacy threads migrate lazily and can recover from interruption without losing either copy.
- Search, channels, scheduler, GUI, and CLI resolve the same relocated directory.

## 9. Milestone D — Transactional Generations and Operation Journal

**Files:**

- Add `src/mms/data/AtomicFs.ts`.
- Add `src/mms/data/ThreadGenerationStore.ts`.
- Add `src/mms/data/ThreadJournal.ts`.
- Add `src/mms/data/ThreadRecoveryService.ts`.
- Refactor `src/mms/data/ThreadDataStore.ts` and `src/mms/MousseMainService.ts`.

### 9.1 Durable writes

1. Implement same-directory temp write, file fsync, rename, and parent-directory fsync.
2. Retry Windows `EPERM`/`EBUSY` rename/open failures with bounded exponential backoff and abort support.
3. Write immutable journal records with monotonically increasing sequence and generation counter.
4. Write complete immutable generation directories, then atomically replace only `manifest.json` to select the current generation.
5. Never mutate a published generation.

### 9.2 Journal protocol

1. Persist operation intent before Git/filesystem execution.
2. Record expected pre-state, each completed substep, resulting Git state, generation ID, and recovery policy.
3. Include journal generation in protocol events so clients can detect stale snapshots.
4. On startup, reconcile every non-terminal operation before accepting a new turn for that thread.
5. If Git completed but manifest publication did not, synthesize/publish the expected generation.
6. If intent exists but Git did not start, safely cancel or resume according to operation type.
7. If Git is in a matching sequencer conflict, restore the conflict operation. If sequencer state is unrelated, mark recovery-required and do not mutate it.

### 9.3 Migration adapter

1. Load current flat files as generation zero.
2. Publish generation one without changing execution behavior.
3. Keep a read-only legacy adapter behind a kill switch until two successful restarts validate generation storage.

### Milestone D acceptance criteria

- Fault injection before/after every journal, Git, generation, manifest, and fsync step either restores the prior generation or resumes the intended operation.
- Two clients observe monotonically increasing generation/journal revisions.
- No partial combination of messages, context, agents, tasks, queue, or workspace metadata becomes current.

## 10. Milestone E — Durable Thread Workspaces

**Files:**

- Add `src/mms/workspace/ThreadWorkspaceManager.ts`.
- Add `src/mms/workspace/WorkspaceResolver.ts`.
- Add `src/mms/workspace/WorkspaceRecoveryService.ts`.
- Update `ThreadSession`, `ThreadRuntime`, `ThreadRuntimeManager`, and `OrchestratorService`.

### Provisioning

1. Treat `agent`, `build`, and mutating skill turns as potentially mutating. Provision lazily before the first such turn; Plan mode remains read-only and may use the primary project path.
2. Require a clean primary checkout for initial provisioning. Explain that dirty primary changes are not imported.
3. Resolve real Git top-level and preserve the project-relative subdirectory in the execution path.
4. Create `mousse/thread/<threadId>/<mainConversationBranchId>` at the recorded primary `HEAD` under thread then repository leases.
5. Place the worktree under the repository-level Mousse-home worktree base, never beneath another checkout.
6. Persist branch, retained ref, worktree path, base/head SHA, relative subdirectory, schema, and lifecycle before exposing the workspace.
7. Keep settled-thread worktrees initially. Reclamation is explicit GC only.
8. On startup, validate branch/ref/worktree registration and HEAD. Rebuild a missing physical worktree from retained refs when clean and unambiguous.
9. Never rely on reflog for recovery.

### Milestone E acceptance criteria

- A thread survives restart, repository move, and manually missing worktree while retaining its branch and data.
- Multiple threads in one repository have independent branches/worktrees.
- Dirty primary provisioning is refused without modifying the checkout.

## 11. Milestone F — Route Every Execution Surface

### 11.1 Daemon/tool routing

Update `src/mms/orchestrator/LlmClient.ts`, `PiCodingTools.ts`, `BuildModeTools.ts`, channel/scheduler turn entry points, and integration discovery.

1. Resolve a `WorkspaceExecutionContext` at every turn boundary.
2. Pass its explicit project-subdirectory path to every coding tool, Git helper, integration lookup, and child-agent spawn.
3. Remove fallback to mutable `WorktreeManager.getRepoRoot()` and selected-thread global roots.
4. Branch child agents from the active thread HEAD, not primary `HEAD`.
5. Resolve project-local MCP, skills, and external-agent config from the workspace at the turn boundary; global config remains global.

### 11.2 Electron-local UI routing

Update `src/main/ipc/registerGuiIpc.ts`, `src/preload/index.ts`, `src/renderer/hooks/useActiveProjectPath.ts`, `FilesPanel.tsx`, `GitPanel.tsx`, and `ProjectTerminalPanel.tsx`.

1. Add daemon method `workspace.resolve` returning authoritative workspace path, primary path, branch, capability, and lifecycle.
2. Stop deriving files/Git/terminal roots from project metadata in Electron.
3. Route Files, Git, and unpinned project terminals to the active thread workspace.
4. Capture thread ID and resolved workspace when creating a PTY; reject arbitrary cwd outside the allowed workspace unless the user explicitly creates an external terminal.
5. Display a persistent `Thread workspace` versus `Primary checkout` indicator and current Mousse branch.
6. For pinned terminals, show their captured cwd/owner and never silently retarget them on thread switch.
7. Detect package manifests and show a bootstrap-needed state. Do not auto-copy or symlink `node_modules`; document reuse of package-manager caches.

### Milestone F acceptance criteria

- A background turn on thread B cannot execute tools, open a terminal, discover project integrations, or spawn a child from thread A or the primary checkout.
- Files and Git panels always show the same workspace used by the model.
- Existing external development servers work when started from the thread worktree.

## 12. Milestone G — Per-Turn Git Checkpoints

**Files:**

- Add `src/mms/actions/ThreadActionService.ts`.
- Add `src/mms/actions/TurnCheckpointService.ts`.
- Add `src/mms/actions/ExternalEffectTracker.ts`.
- Integrate with `OrchestratorService.send()` and abort/failure paths.

### 12.1 Begin action

1. Acquire the thread execution lease and reconcile incomplete prior operations.
2. Resolve/provision the workspace and require a clean non-ignored status.
3. Record `startSha`, branch/ref, conversation parent, presentation-message boundary, native-context boundary, compaction state, queue claim, and descendant-agent set.
4. Persist `action-start` before appending/executing the model turn.
5. Refuse the turn with a recoverable explanation if prior unjournaled changes exist.

### 12.2 During action

1. Permit live uncommitted changes.
2. Attach child-agent spawn/integration events to the action.
3. Capture tool-touched paths only for display/diagnostics.
4. Record known external effects from MCP tools, out-of-workspace writes, shell classifications, and long-lived processes when detectable.
5. Stop/await all Mousse-controlled mutating child processes before checkpointing.

### 12.3 Complete action

1. Inspect status and stage all non-ignored changes with a fixed pathspec exclusion list.
2. Commit with `--no-verify` and an explicit Mousse identity; do not invoke user hooks.
3. If child merge commits already changed HEAD, permit an action range with multiple commits and no final content commit when the worktree is clean.
4. Record ordered commits, merge mainline parent, `endSha`, changed paths and blob hashes, verification result, reversibility, and external effects.
5. Publish the new generation only after commit/ref reconciliation.
6. Record no-op actions with `startSha === endSha` so conversation lineage remains complete.

### 12.4 Stop/failure

1. Abort model/tool work and await controlled processes.
2. Checkpoint partial non-ignored changes as an incomplete action.
3. Preserve the partial assistant response and safe native context.
4. Offer `Keep Partial Changes` and `Undo Latest Turn` when repository changes exist.
5. Ensure the next turn never inherits unjournaled changes.

### Milestone G acceptance criteria

- Every completed, stopped, or failed mutating turn has a durable action and reconciled Git range.
- Child merge commits can exist inside one action range.
- No later turn inherits unexplained changes.
- Ignored and known external effects are accurately excluded/warned.

## 13. Milestone H — Child-Agent Integration Into Thread Branches

**Files:** add `src/mms/agents/ChildAgentIntegrationService.ts`; refactor integration code out of `OrchestratorService` and `WorktreeManager`.

1. Create child branches at the enclosing action’s current thread HEAD and persist `spawnBaseSha`.
2. Require worker commits and a clean stopped worktree.
3. Persist `preMergeSha`, acquire the repository lease, revalidate thread HEAD and worker HEAD, then merge into the thread worktree with `--no-ff --no-edit`.
4. Persist merge intent and conflict state. Keep worker worktree, branch, retained ref, and thread merge state during conflict.
5. On success, create/update `refs/mousse/agents/<agentId>` before deleting the ordinary branch or physical worktree.
6. Persist `integrationSha`, parent/mainline information, and changed paths on the enclosing action.
7. Remove the worktree without force only after the journal/generation/ref are durable.
8. Make retry idempotent when the integration commit is already an ancestor.
9. Do not auto-merge cancelled/interrupted/failed agents. Add an explicit `recoverAgentWork` operation for deliberate recovery.

### Milestone H acceptance criteria

- Integrated agent work is undoable after ordinary agent branch/worktree cleanup.
- Conflict and crash recovery never lose the worker commit or thread pre-merge SHA.
- Agent integration never touches primary `HEAD`.

## 14. Milestone I — Publish

**Files:** add `src/mms/actions/PublishService.ts`; extend `GitService` only with low-level explicit-cwd operations.

1. Expose publish status: target branch, unpublished action/commit count, previous publish SHA, and whether an undo is private to the thread.
2. Require clean primary checkout and no unrelated sequencer state.
3. Acquire thread then repository leases; persist target branch and pre-publish SHA.
4. Merge the active thread branch into the selected primary branch with `--no-ff`.
5. Persist conflicts and support Continue/Abort after restart. Abort returns primary to the recorded pre-publish SHA only through Git’s matching merge-abort state.
6. Keep thread branches/refs alive after publish and support incremental later publishes.
7. Never auto-push.
8. If an action was undone after publish, label the compensation as not reflected in primary until a later publish includes it.

### Milestone I acceptance criteria

- Publish refuses dirty primary state and never overwrites it.
- Conflict recovery survives restart.
- Publish, private undo, and republish preserve auditable history.

## 15. Milestone J — Latest-Turn Undo and Conflict Recovery

**Files:**

- Add `src/mms/actions/UndoService.ts`.
- Add `src/mms/actions/ConflictResolutionService.ts`.
- Add `src/mms/actions/ActionQueryService.ts`.

### Undo eligibility

1. Only the latest action on the active conversation branch is eligible for conversation undo.
2. Require a clean thread worktree, no live descendants, no active mutating process, no queue claim being executed, and no other operation.
3. Disable when there is no repository change and only known non-reversible effects; otherwise warn that only repository changes will be compensated.
4. Persist undo intent and expected HEAD before Git.

### Git compensation

1. Enumerate `(startSha, endSha]` newest-first.
2. Revert each commit with `--no-commit`; use the recorded `-m 1` mainline for merge commits.
3. Produce one Mousse compensation commit after all reversions are staged and verified.
4. Persist current commit index and sequencer state after every step.
5. On conflict, retain Git state and mark `undo_conflict`; expose affected files and exact Continue/Abort actions.
6. Continue only after no unmerged paths remain and the sequencer matches the operation. Abort only the matching revert and return to recorded pre-undo state.
7. On success, append an undo action/event, set the active context pointer to the parent turn’s safe boundary, and retain the undone future as an alternate branch/lineage.
8. If Git succeeds before generation publication, startup recovery must publish the compensation action instead of attempting the revert again.

### Milestone J acceptance criteria

- Undo survives crash before Git, mid-range, during conflict, after Git, and before manifest publication.
- Original messages/actions/commits remain present; no history is rewritten.
- Merge-containing actions undo correctly using recorded mainline parents.

## 16. Milestone K — Continue From Here, Older Revert, and Redo

**Files:** add `src/mms/actions/ConversationBranchService.ts` and `src/mms/actions/RedoService.ts`.

### Continue From Here

1. Permit only completed turns with a validated native-context safe boundary.
2. Create a new conversation branch record and matching Git branch/ref at the selected action `endSha`.
3. Require a clean workspace before switching the physical worktree.
4. Copy the context pointer/compaction boundary, not mutable message arrays.
5. Preserve the abandoned future as an immutable alternate.

### Revert Code Changes

1. Label older-action operation `Revert Code Changes`, never conversation undo.
2. Keep current conversation/model context unchanged.
3. Revert the old action range against current HEAD, warn about downstream dependencies, and use the same journal/conflict machinery as latest undo.

### Redo

1. Implement latest-turn redo as revert-the-compensation.
2. Never re-merge a deleted/reverted child branch.
3. Treat activating an alternate conversation branch as a separate operation from redo.

### Milestone K acceptance criteria

- UI/API distinguish context rewind, code-only revert, branch activation, and revert-the-revert.
- Both futures remain durable and selectable.
- Unsafe tool-call/result or compaction boundaries cannot be forked.

## 17. Milestone L — Protocol, CLI, and Renderer

### 17.1 Protocol and preload

Extend `src/mms/protocol/types.ts`, `handlers.ts`, validators, event bridge, `src/main/ipc/registerGuiIpc.ts`, and `src/preload/index.ts` with:

- `workspace.getStatus`, `workspace.restore`;
- `actions.list`, `actions.getAffectedFiles`;
- `actions.undoLatest`, `actions.revertCode`, `actions.redo`;
- `actions.fork`, `actions.activateBranch`;
- `operations.get`, `operations.continue`, `operations.abort`;
- `publish.status`, `publish.start`;
- `threads.trash`, `threads.restore`, `threads.purge`.

Every mutating request includes `threadId` and expected journal generation. Return a stale-generation error with a fresh status instead of executing against stale UI state. Broadcast thread ID, operation ID/state, journal generation, workspace status, and affected action IDs.

### 17.2 Renderer

**Files:** `AssistantMessageActions.tsx`, `OrchestratorChat.tsx`, `GitPanel.tsx`, `ThreadsSidebar.tsx`, `ThreadsContextMenu.tsx`, new `ThreadOperationBanner.tsx`, `WorkspaceStatusBadge.tsx`, and `AffectedFilesDialog.tsx`.

1. Add `Undo Latest Turn` only to the active latest completed action.
2. Add `Continue From Here` to safe completed turns.
3. Add `Revert Code Changes` to older reversible actions.
4. Show disabled controls with reasons instead of hiding them.
5. Display changed files/hashes, known external effects, reversibility, publish state, and unpublished count.
6. Show conflict banner with Continue/Abort and file list after restart.
7. Refresh action affordances when CLI/channel/scheduler operations advance the journal.
8. Add a clear primary-versus-thread workspace badge to Files, Git, terminal, and chat header.
9. Keep editor-local undo behavior unchanged and label thread undo explicitly.

### 17.3 CLI

Add commands such as:

```text
mousse-cli workspace status --session <thread>
mousse-cli publish --session <thread>
mousse-cli undo --session <thread>
mousse-cli operation continue|abort --session <thread>
mousse-cli fork --session <thread> --turn <id>
mousse-cli revert-code --session <thread> --action <id>
mousse-cli redo --session <thread>
```

Require explicit confirmation flags for destructive/recovery operations in non-interactive mode. JSON output includes operation and journal generation.

### Milestone L acceptance criteria

- Two GUI windows and a CLI converge on one operation state.
- Stale clients cannot start an operation.
- Every disabled action explains the invariant blocking it.

## 18. Milestone M — Trash, Restore, and GC

**Files:** add `src/mms/data/ThreadTrashService.ts` and `src/mms/workspace/WorkspaceGcService.ts`; replace direct recursive deletion in `ThreadDataStore.deleteThread()`.

1. Persist tombstone intent and stop/await the main turn, descendants, PTYs, headless workers, GUI sessions, questions, and scheduler/channel claims.
2. Move the thread generation directory to repository trash atomically where possible; keep retained refs and journal metadata.
3. Hide tombstoned threads from normal listings but support restore and worktree reprovisioning.
4. Run GC only under repository lease.
5. Delete physical worktrees only after registration, cleanliness, reachability, and ownership validation.
6. Delete refs only when no active/tombstoned generation, action, operation, publish record, or recovery record references them and Git reachability checks pass.
7. Never infer deletability from directory visibility and never blanket-prune.
8. Add retention settings and a dry-run GC report before enabling automatic purge.

### Milestone M acceptance criteria

- Delete, restart, restore, and purge are deterministic.
- Settled, tombstoned, and purged are distinct states.
- GC cannot remove commits required by undo, redo, publish, alternate branches, or agent recovery.

## 19. Feature Flags and Rollout

Add durable flags with safe dependencies:

1. `subagentLifecycleV2` — on after Milestone A.
2. `repositoryCoordination` — on after Milestone B.
3. `externalThreadStorage` — migrate/read new layout after Milestone C.
4. `transactionalThreadStore` — generations/journal after Milestone D.
5. `threadWorkspaces` — new Git-backed threads after Milestone E/F.
6. `turnCheckpoints` — after Milestone G/H.
7. `publish` — after Milestone I.
8. `latestTurnUndo` — after Milestone J.
9. `conversationBranches` and `codeRevertRedo` — after Milestone K.
10. `threadTrashGc` — after Milestone M.

Rules:

- A flag cannot enable unless all predecessor schema/features are present.
- Disabling a flag must never route an already provisioned thread back to the primary checkout. Such threads remain on the safe workspace path or become read-only recovery-required.
- Every phase records enough metadata for downgrade tooling to export conversations and preserve refs/worktrees.
- Re-review Milestones B–E before enabling per-turn checkpoints.
- First user-visible release should include thread workspaces, checkpoints, child integration, Publish, latest-turn undo, conflict recovery, and trash. Fork/older revert/redo ships later.

## 20. Test Plan

### 20.1 Update existing regression tests

- `tests/worktreeReadiness.test.ts`: replace “safely commits dirty worker changes” with rejection/preservation; assert no forced cleanup.
- `tests/worktreeCompletion.test.ts`: add immediate pre-merge dirty recheck and cleanup-failure idempotency.
- `tests/agentLifecycleStatus.test.ts`: test transition table, ready-only normal integration, delayed callback fencing, final progress reconciliation, and explicit recovery of cancelled work.
- `tests/mousseAgent.test.ts`, `mousseAgentChat.test.ts`, `mousseAgentDurableSessions.test.ts`: test send results, composer preservation, terminal-state disablement, and thread-owned persistence.
- `tests/cursorPiProvider.test.ts`: test whole-request serialization and stable scope keys.
- `tests/integrations.test.ts`: test principals, generated secret environment, collisions, and no secret persistence/logging.
- `tests/taskProgressMonitor.test.ts`: test `NaN`, infinities, strings, and malformed partial JSON.
- `tests/ptyLiveness.test.ts`: test PTY/headless exit/error mapping and bounded output.
- `tests/cliLaunch.test.ts`: test daemon-backed spawn/list/stop across separate clients.

### 20.2 Add foundation tests

- `tests/repositoryIdentity.test.ts`: linked worktrees, moved repo, read-only fallback, subdirectory project, bare/unborn refusal.
- `tests/repositoryLease.test.ts`: contention, heartbeat, stale recovery, abort, lock ordering, multi-repo concurrency.
- `tests/threadStorageMigration.test.ts`: copy/verify/publish/restart failures and legacy fallback.
- `tests/threadGenerationStore.test.ts`: immutable generations, fsync/rename retry, monotonic journal, stale generation.
- `tests/threadRecovery.test.ts`: fault injection at every operation transition.
- `tests/threadWorkspace.test.ts`: provisioning, missing worktree rebuild, dirty primary refusal, retained refs.
- `tests/workspaceRouting.test.ts`: GUI/CLI/channel/scheduler/background/terminal/files/Git isolation.

### 20.3 Add action/integration tests

- `tests/turnCheckpoint.test.ts`: clean/no-op/dirty/staged/untracked/ignored/stopped/failed turns and external effects.
- `tests/childIntegration.test.ts`: base/head validation, no-ff merge, retained agent ref, conflict, crash, cleanup retry.
- `tests/publish.test.ts`: dirty primary, incremental publish, conflict continue/abort, no auto-push.
- `tests/threadUndo.test.ts`: simple, multi-commit, merge commit, no-op, stopped turn, conflict, and all crash boundaries.
- `tests/conversationFork.test.ts`: safe boundary, compaction boundary, alternate preservation, branch activation.
- `tests/codeRevertRedo.test.ts`: older code-only revert and revert-the-revert.
- `tests/threadTrashGc.test.ts`: tombstone/restore/purge and ref reachability.
- `tests/operationProtocol.test.ts`: two windows/CLI, stale journal generation, event convergence.

### 20.4 Required matrix

Run the above across:

- multiple threads in one repository and concurrent repositories;
- GUI plus CLI on one thread;
- channel/scheduler turns on a non-selected thread;
- dirty, staged, untracked, ignored, conflicted, and user-edited-mid-turn files;
- child completion during parent stop/thread switch;
- merge, undo, revert, and publish conflicts;
- repository move/rename and missing worktree;
- Windows `EPERM`/`EBUSY` injection;
- project equal to repository root and project as repository subdirectory;
- detached, unborn, bare, and shallow repositories;
- hooks, LFS, CRLF, submodules, and symlinks;
- manual branch deletion and aggressive Git GC;
- compaction before/after fork and tool-call/result boundaries;
- non-Git standalone threads.

Each milestone must pass `npm run typecheck`, focused tests, then `npm test -- --reporter=verbose` before its feature flag advances.

## 21. Documentation Deliverables

Update alongside implementation:

1. `docs/ARCHITECTURE.md`: repository identity, lock ordering, thread workspace ownership, generation/journal recovery, action ranges, and retained refs.
2. `docs/CLI.md`: agent management, workspace status, publish, undo, conflict, fork, revert, redo, trash, and JSON contracts.
3. `docs/CONFIGURATION.md`: feature flags, worktree base, retention/GC, integration principals, and non-reversible effects.
4. `docs/STARTUP.md`: migration and recovery ordering.
5. `README.md`: primary checkout versus thread workspace and Publish workflow.
6. Mark each `docs/SUBAGENT_AUDIT.md` finding resolved only when its regression tests pass.
7. Change `docs/thread-undo-architecture.md` status from proposed to implemented in phases, linking schema versions and rollout flags.

## 22. Final Completion Criteria

The combined project is complete when:

- no audited subagent path can silently lose work, cross thread/repository ownership, drop accepted input, leak secrets, or remain indefinitely active after exit;
- all project mutation surfaces use the owning thread workspace;
- every mutating turn and child integration has a durable, recoverable Git/action record;
- Publish is the only normal path from a thread branch to the primary checkout;
- latest-turn undo uses compensating commits and survives conflict/crash;
- fork, older code revert, redo, trash, restore, and GC preserve all referenced histories;
- GUI, CLI, channel, scheduler, and background events remain thread-scoped and generation-consistent;
- the complete fault-injection/concurrency matrix and TypeScript checks pass on supported platforms.
