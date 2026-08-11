# Thread Undo, Fork, and Workspace Architecture

Status: Implemented in gated phases. Core schema, repository coordination, external storage, generations/journal, durable workspaces, checkpoints, child integration, publish, compensating undo/redo, conversation forks, protocol/CLI surfaces, and trash lifecycle are implemented behind dependency-checked feature flags.

## Problem

Threads currently have no undo. Regular thread coding tools (`bash`, `edit`, `write`) mutate the
project primary checkout directly, so Mousse cannot distinguish thread changes from user edits or
changes made by another thread. Delegated agents receive isolated worktrees, but successful agent
integration may fast-forward and then delete the branch/worktree without recording any SHAs.
Conversation rows are persisted as independently replaced JSON files, and thread runtime data lives
inside the project working tree.

A durable per-thread workspace with per-turn commits, conversation branching, and Git revert-based
undo solves all of these.

## Core decisions

- Every Git-backed thread owns a durable branch and worktree.
- All non-ignored changes made in that worktree during a turn belong to that turn. Tool-call
  instrumentation is reporting metadata, not the staging authority.
- A turn maps to a Git commit range `(startSha, endSha]`, which may contain child-agent merge
  commits.
- Conversation history is append-only and branchable.
- Undo creates compensating commits; it never rewrites Git history.
- Thread runtime data moves outside the repository before worktrees are introduced.
- Primary-checkout integration is an explicit `Publish` operation.
- Latest-turn undo, conversation fork, older-change revert, and redo ship separately.
- Non-Git threads keep their current execution capabilities, but filesystem undo is unavailable.
- Mousse-managed dev servers are outside this project. External dev servers can run directly in a
  thread worktree (a worktree is a normal directory, so hot reload works the moment the server runs
  inside it).

## Phase 0: Semantics

Define product behavior and invariants before changing storage.

- Introduce `turnId`, `actionId`, `conversationBranchId`, `parentTurnId`, and `operationId`.
- Define an action as a conversation turn plus a Git range `(startSha, endSha]`.
- Permit child-agent merge commits inside an action range.
- Define the main conversation branch and immutable alternate branches.
- Declare all non-ignored changes in a thread worktree to be thread-owned.
- Warn that user edits made directly inside the thread worktree during a turn are included in that
  turn.
- Keep ignored files, out-of-repository writes, MCP effects, databases, network operations, and
  global commands outside filesystem undo guarantees.
- Block Git undo while a turn, descendant agent, publish, merge, revert, or workspace mutation is
  active.
- Define stopped turns as incomplete actions whose partial changes are checkpointed and can be kept
  or undone.
- Define keyboard Edit Undo as unrelated to thread undo.

Exit gate: Written invariants cover clean turns, stopped turns, child merges, conflicts, external
side effects, and published actions.

## Phase 1: Worktree safety

Fix current destructive behavior before introducing durable worktrees.

- Replace first-8-chars identifiers with full IDs.
- Namespace branches as `mousse/thread/<threadId>/<branchId>` and `mousse/agent/<agentId>`.
- Refuse to remove a registered worktree with raw recursive deletion.
- Refuse branch deletion when the branch is checked out, journal-reachable, or retained for
  recovery.
- Remove unconditional `git worktree prune`.
- Make pruning an explicit, validated, repository-locked maintenance operation.
- Derive repository identity and worktree base from `git rev-parse --git-common-dir`, never from
  the currently selected execution directory.
- Replace mutable global `WorktreeManager.repoRoot` with explicit repository/workspace arguments.
- Stop and await worker processes before final readiness validation.
- Re-validate readiness immediately before integration.
- Detect unrelated `MERGE_HEAD`, `REVERT_HEAD`, `CHERRY_PICK_HEAD`, and Git sequencer state.
- Preserve existing branches and worktrees on every ambiguous failure.

Current risk sites: `src/mms/worktree/WorktreeManager.ts:39`, `:80`, `:364`;
`src/mms/orchestrator/OrchestratorService.ts:2286`.

Exit gate: Two repositories and several threads can create, integrate, and clean child worktrees
without shared mutable roots or cross-thread deletion.

## Phase 2: Repository identity and locking

Add repository-wide coordination separate from the existing per-thread lease.

- Create a stable Mousse repository ID stored in the Git common directory, with a Mousse-home
  fallback for read-only repositories.
- Retain the canonical common-directory path as a relocatable hint, not the sole identity.
- Add an asynchronous repository lease.
- Cover worktree create/remove, branch delete, shared-ref updates, merge, revert, publish,
  sequencer recovery, and GC.
- Keep ordinary file editing isolated by worktree and per-thread lease.
- Never busy-spin on the Electron main thread.
- Include pid, token, operation id, timestamps, and heartbeat.
- Apply ownership-checked stale-lock recovery.
- Lock ordering: thread lease first, repository lease second. No operation acquires the reverse.

Exit gate: Concurrent GUI, CLI, channel, and background operations serialize repository mutations
without deadlocks.

## Phase 3: Runtime data relocation

Move thread data outside the Git working tree.

Project thread data currently lives at `<project>/.mousse/.data/<threadId>`
(`src/mms/data/paths.ts:100`). That cannot coexist safely with branch checkout and revert.

- Store thread data under `<MOUSSE_HOME>/repositories/<repoId>/threads/<threadId>`.
- Store standalone threads under their existing Mousse-home area.
- Keep repository path and project-relative subdirectory in metadata.
- Add a lazy migration from project-local `.mousse/.data`.
- Copy and verify before switching the active location.
- Leave a migration marker/pointer in the old location.
- Do not delete legacy data until the new generation has loaded successfully after restart.
- Ensure search, channels, scheduler, active-thread restoration, and project removal resolve the
  new location.
- Keep execution leases and queue locks in the relocated thread directory.

Exit gate: Checking out, reverting, deleting, or moving a worktree can never alter conversation
data.

## Phase 4: Transactional thread storage

Replace independently written thread files with immutable generations and an action journal.

- Store each thread generation in an immutable directory containing messages, native context,
  agents, tasks, queue, workspace metadata, and branch heads.
- Atomically switch a small manifest to the current generation.
- Store journal events as immutable, monotonically numbered records rather than one rewriteable
  array.
- Persist intent before starting a filesystem operation.
- Fsync journal records, generation files, the manifest, and parent directories.
- Retry Windows `EPERM`/`EBUSY` rename failures with bounded backoff.
- Git is authoritative for commit/ref existence; the journal is authoritative for intended
  operation state.
- Include a journal generation counter in events and IPC broadcasts.
- Reconcile incomplete operations on startup before accepting another turn.

Suggested states:

```text
planned
running
checkpointing
completed
stopped
failed
undoing
undo_conflict
undone
```

```text
integration states: planned, worker_stopping, validating, merging,
merge_conflict, merged, cleaning, completed
```

Exit gate: Fault injection at every state transition either restores the prior generation or
resumes the recorded operation.

## Phase 5: Worktree provisioning

Create durable thread branches/worktrees lazily.

- Provision on the first mutating turn, not at thread creation.
- Resolve the real Git top-level and preserve the project-relative subdirectory.
- Record repository ID, top-level hint, relative path, branch, path, base SHA, head SHA, schema
  version, lifecycle.
- Place worktrees in a stable repository-level base, never nested beneath another worktree.
- Refuse bare repos/unborn `HEAD` for the initial release.
- Require a clean primary checkout when provisioning the first thread.
- Explain that dirty primary changes are not automatically imported.
- Add explicit dirty-state import later (temporary index + user confirmation).
- Keep worktrees for settled threads initially; reclamation is through explicit GC.
- Detect moved repositories using the repository ID and repair path hints.
- Detect missing/manually removed worktrees and rebuild from retained refs.

Exit gate: A thread survives app/machine restart and recovers its branch/worktree without relying
on reflog.

## Phase 6: Route execution

- Pass explicit workspace paths to all direct coding tools.
- Route project terminals to the active thread workspace.
- Point file explorer / Git panel at the workspace with a visible primary-vs-thread indicator.
- Route channel and scheduler turns through the same workspace resolution.
- Resolve project-local MCP, skills, and agent config from the workspace at turn boundaries; keep
  global config unchanged.
- Remove remaining selected-thread global-root dependencies.
- Branch child agent worktrees from the active thread branch SHA; keep them beside thread
  worktrees, not inside.
- Detect package manifests and surface a workspace-bootstrap requirement.
- Do not copy or symlink `node_modules` automatically; reuse package-manager global caches where
supported.

Exit gate: Background work on thread B can never execute tools or create child worktrees in thread
A's project.

## Phase 7: Per-turn Git checkpoints

Capture each turn as a recoverable commit range.

- At start: require a clean non-ignored worktree; reconcile any prior incomplete action; record
  `startSha`, branch, conversation boundary, compaction state, queue item, descendant-agent set;
  persist `action-start` before model execution.
- During the turn: allow live uncommitted changes; attach child-agent merge records to the action;
  record tool paths for display/diagnostics only; track child-agent lifecycle; warn immediately on
  known external/non-reversible effects.
- At completion: stop/await controlled mutating processes; inspect status; stage all non-ignored
  changes minus a fixed internal exclusion set; commit with `--no-verify`; record ordered child
  merge commits and their mainline parent; record `endSha`, changed paths/hashes, verify result,
  reversibility; publish the new generation only after Git reconciliation.
- Stopped turns: stop controlled processes; commit partial non-ignored changes as an incomplete
  action; preserve the partial model response; offer Keep Partial Changes or Undo Latest Turn.

Exit gate: no later turn accidentally inherits unjournaled changes from an earlier failed/stopped
action.

## Phase 8 — Child agent integration

- Persist `spawnBaseSha`, `workerHeadSha`, `preMergeSha`, `integrationSha`.
- Require committed worker changes.
- Validate against the recorded base and the thread head, not primary `HEAD`.
- Stop the worker before final validation.
- Merge into the thread worktree under the repo lease, `--no-ff`.
- Retain worker commits under `refs/mousse/agents/<id>`.
- Tie the integration commit to the enclosing action.
- Keep conflict state, worker ref, and worktree until resolution/cancellation.
- Remove the physical child worktree only after durability.
- Never rely on a deleted branch name or reflog for recovery.

Exit gate: An integrated child task can be reverted after its worktree/ordinary branch are removed.

## Phase 9 — Publish

- Record target branch and pre-publish SHA; require a clean primary checkout; acquire the repo
  lease; merge thread branch with `--no-ff`; surface conflicts; keep the thread branch alive; allow
  incremental, later publishes; treat undo after publish as private to the thread until the
  compensation commit is published; always surface "undo not reflected in primary" when relevant;
  persist/resume publish conflicts; never auto-push.

Exit gate: Publishing, undoing, and republishing preserves history and never overwrites dirty
primary checkout work.

## Phase 10 — Latest-turn undo

- Offer Undo only for the latest active turn; require clean worktree, no running descendants;
  acquire both leases; persist intent before invoking Git; revert the action's commits newest-first;
  use recorded mainline for merges (`-m 1`); prefer `--no-commit` per commit followed by one Mousse
  compensation commit; persist sequencer progress; on conflict preserve the state and expose
  Continue/Abort; on success move the active model-context pointer to the parent turn's safe
  boundary; append an undo event (never delete the original turn); retain the previous child as an
  alternate.
- Disable when only known non-reversible effects exist; otherwise warn that only repository changes
  are reverted.

Exit gate: latest-turn undo survives crashes before Git, mid-revert, during conflict, and after
Git but before manifest publication.

## Phase 11 — Fork, older revert, redo

**Continue From Here**: validate the turn ends at a safe native-context boundary; create a new
conversation branch (own context pointer/compaction) and matching Git branch from `endSha`; switch
the worktree only when clean; preserve the abandoned future.

**Revert Older Changes**: label as Revert Code Changes, not conversation undo. Revert the action
range against current Git state; keep later conversation/model context unchanged; warn about
downstream dependencies; persist/resume conflicts like latest undo.

**Redo**: latest-turn redo is revert-the-revert; never re-merge a reverted child branch; activating
an alternate conversation branch is a separate operation preserving both futures.

Exit gate: UI/API treat context rewind, code-only revert, branch activation, and revert-the-revert
as distinct.

## Phase 12 — UI and APIs

- Extend shared types for workspace, action, operation, branch, reversibility, conflict.
- Add orchestrator/service APIs; keep Git operations out of IPC handlers.
- Add IPC/preload methods for status, undo, continue/abort conflict, fork, redo, publish, restore,
  affected files; broadcast journal generation and operation state.
- Assistant-action surfaces: Undo Latest Turn (active latest only); Continue From Here (safe
  completed turn); Revert Code Changes (older reversible turn); Publish status + unpublished count;
  affected files and known external effects; disable with explanation rather than hiding.
- Refresh stale undo affordances when CLI/channel mutate the journal.

Exit gate: two windows and a CLI converge on the same operation state.

## Phase 13 — Trash and GC

- Replace recursive deletion with tombstones; stop main/child/terminal/background work; move data
  to trash; keep refs; hide tombstones; support restore and worktree re-provisioning; GC under the
  repo lease deleting refs only when unreferenced + validated for reachability.
- Never blanket-prune on directory visibility alone; treat settled threads distinctly.

Exit gate: delete, restart, restore, purge are deterministic and tested.

## Phase 14 — Rollout

Ordered, gated:

1. Worktree safety, repo identity, locking.
2. Relocate thread data; migrate legacy threads.
3. Transactional storage + recovery (no execution change).
4. Thread workspaces for new threads behind a flag.
5. Route tools/terminals to thread workspaces.
6. Per-turn checkpoints.
7. Child integration into thread branches.
8. Publish.
9. Latest-turn undo.
10. Continue/revert/redo.
11. Lazy migration of existing project threads.
12. Trash + retention GC default.

Each phase has a kill switch and enough metadata to downgrade without losing work.

### Test matrix

Multiple threads in one repo; concurrent repos; GUI + CLI on one thread; channel turn on a
non-selected thread; scheduler + GUI; dirty / staged / untracked / ignored / conflicted files; user
edits inside a thread worktree mid-turn; stopped turns; child completion during parent stop or
thread switch; crash at every journal + Git transition; merge/undo/publish conflicts; recovery
state; repo moved/renamed; missing worktree; Windows `EPERM`/`EBUSY` and transient unavailability;
project == repo subdirectory; detached/unborn/bare/shallow; hook/LFS/CRLF; submodules/symlinks;
manual branch delete + GC; settle/delete/restore/purge; compaction pre/post fork; tool-call/result
boundaries; published-undo republish; non-Git standalone threads.

## Delivery recommendation

Treat Phases 1-5 as the foundation milestone and re-review before enabling per-turn checkpoints. A
first user-visible release should include: thread workspaces, Publish, latest-turn undo, conflict
recovery, and trash. Continue-from, older-code revert, and redo should ship only after latest-turn
undo is proven under crash and concurrency testing.

This document is a design and proposal; no code changes are included.