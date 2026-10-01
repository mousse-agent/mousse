# Multi-Turn Undo ("Restore To Turn")

**Source documents:** `docs/thread-undo-architecture.md` (Phases 10–11), `docs/subagent-thread-undo-implementation-plan.md`
**Planning basis:** implemented latest-turn undo (`src/mms/actions/UndoService.ts`), redo (`RedoService.ts`), code-only older revert (`CodeRevertService.ts`)
**Delivery model:** gated milestones behind the existing thread-workspace feature flags

## 1. Problem

Conversation undo today only accepts the **latest completed action** on the active branch
(`UndoService.undoLatest`, src/mms/actions/UndoService.ts:34). To rewind several turns, users must
click Undo repeatedly, and there is no affordance to jump back to an arbitrary earlier checkpoint
the way snapshot-style IDEs allow.

All prerequisites already exist: every mutating turn has a durable Git range
`(startSha, endSha]`, an append-only action journal, a native-context boundary, and a proven
compensating-commit undo path. Multi-turn undo is a generalization of existing machinery, not a new
subsystem.

## 2. Goals

1. Restore both **code** and **model context** to any completed action `T` on the active
   conversation branch in one operation: "Restore To Here".
2. Never rewrite Git history: produce exactly **one** compensating commit covering
   `(T.endSha .. HEAD]`, reverted newest-first.
3. Preserve every audit guarantee from single-turn undo: intent persisted before Git, sequencer
   progress across conflicts, Continue/Abort recovery, crash safety at every boundary.
4. Keep undo/redo composable: a restore can itself be redone (revert-the-compensation) as a unit,
   and a subsequent restore to an even earlier point stacks cleanly.
5. GUI, CLI, channel, and scheduler converge on the same journaled operation state.

## 3. Non-Goals

- Snapshot/checkpoint stores outside Git (Cursor-style shadow stores). Git ranges are authoritative.
- Rewinding turns whose context lacks a validated safe boundary (`safeBoundaryProof`) — those keep
  the existing code-only "Revert Code Changes" path.
- Per-turn selective cherry-pick undo within the restored range (e.g., "undo turns 3 and 7 but not
  5"). Ranges are contiguous by design; fork-from-checkpoint covers exploratory alternatives.
- Changes to Publish semantics. Restoring published actions stays thread-private until republish,
  reusing the existing labeling rules (thread-undo-architecture.md Phase 9).

## 4. Semantics

### 4.1 Eligibility

A restore-to-T operation on branch `B` requires:

1. Workspace lifecycle `ready`; clean worktree; no running turn, descendant agent, publish, merge,
   or other workspace mutation (same guards as `withGitMutationLocks` + `requireClean`).
2. `T.state === 'completed'` and `T.conversationBranchId === B`.
3. `HEAD === last action's endSha` on `B` (linear tail; see 4.3 for intervening undos/redos).
4. `T.nativeContextBoundary.safeBoundaryProof` present. Without it, offer only code-only revert.
5. No non-reversible external effects in the range without an explicit user warning; if any action
   in the range is flagged non-reversible-only, disable with explanation rather than hiding
   (Phase 12 convention).

### 4.2 Operation shape

One journal operation (`operationType: 'undo'`, new `mode: 'range'` discriminator):

- Enumerate the commit set from the **journal**, not `git rev-list`: walk actions after `T` on `B`
  newest-first and collect their recorded `commits[]` (this attributes each conflict to its owning
  action and preserves child-merge mainline decisions).
- Revert each commit `--no-commit` newest-first, `-m 1` when parents > 1 (unchanged logic from
  `UndoService.ts:46-64`).
- Create a single compensation commit `mousse: restore to turn <T.turnId>` when the index is dirty.
- Record one `ThreadAction` of subtype restore:
  `startSha = preRestoreSha`, `endSha = new HEAD`, `commits = [endSha]`,
  `nativeContextBoundary = T.nativeContextBoundary`.
- Mark every intervening action `undone`, each linking `compensationActionId` to the shared
  compensation. Nothing is deleted; the abandoned future remains inspectable and forkable.
- Move the active conversation pointer for `B` to `T.nativeContextBoundary`
  (same mechanism as latest undo's parent-boundary move).

### 4.3 Intervening undos and redos

The tail after `T` may contain compensation actions from earlier undos and redo reverts. Rules:

- Their commits are ordinary members of the revert set — no special casing needed because they were
  committed normally onto the branch.
- If an intervening action is in state `undone` / `undo_conflict` / `undoing`, refuse the restore
  until it settles (no nesting active recovery operations).

### 4.4 Redo interaction

- `actions.redo` after a restore reverses the entire compensation in one step (restore-everything),
  matching the existing revert-the-compensation model. Per-turn redo out of a multi-turn restore is
  explicitly not offered; "Continue From Here" fork remains the alternative-future path.

### 4.5 Published actions

If any action in `(T .. HEAD]` was published before the restore:

- Proceed identically; the compensation is thread-private.
- Surface the existing "not reflected in primary" status until republish includes it.

### 4.6 Conflicts and recovery

Reuse the single-turn conflict protocol verbatim, extended with progress position:

- Journal event gains `details.rangeProgress = { index, total, currentCommit, targetActionId }`.
- On conflict: preserve index and staged state, mark the owning action `undo_conflict`, expose
  affected files plus which turn introduced the conflicting change.
- Continue: resume at the recorded position (`git revert --continue` then proceed to next commit).
- Abort: `git revert --abort`, return every touched action to `completed`, verify
  `HEAD === preRestoreSha` before publishing the manifest.

## 5. Current-State Delta

| Area | Current state | Required work |
|---|---|---|
| Range selection | Only `.at(-1)` completed action accepted | Branch-tail walk over `ThreadActionService.list()` with settlement checks |
| Revert execution | Single action's `commits` array | Ordered multi-action commit plan with per-commit ownership metadata |
| Context pointer | Moves to `target.presentationMessageEnd` / parent boundary | Accept arbitrary `T.nativeContextBoundary`; reuse fork's safe-boundary validation (`ConversationBranchService.ts:46`) |
| Journal schema | `expectedPreState {preUndoSha, actionId}` | Add `mode`, `targetActionId`, `rangeProgress` |
| Protocol | `actions.undoLatest`, `actions.revertCode`, `actions.redo` | Add `actions.restoreTo` |
| IPC/preload | `actions:undoLatest` | Add `actions:restoreTo` |
| Renderer | Undo enabled on latest action only (`AssistantMessageActions.tsx:99`) | Restore affordance on any eligible completed action with eligibility reasons |
| CLI | `undo\|redo --session <id>` | `restore --session <id> --to <actionId>` (+ `--to-turn <n>` sugar) |

## 6. Milestones

### M1 — Service core

- Extend `UndoService` with `restoreTo(branchId, workspacePath, targetActionId)` sharing the
  existing lock acquisition, journal append, and compensation-recording helpers; refactor
  `undoLatest` to delegate with the tail action.
- Commit-plan builder with ownership attribution and settlement validation.
- Exit gate: unit tests cover empty range, single action, N actions, interleaved compensation
  commits, refusal on unsettled tail, HEAD drift, and non-ready workspace.

### M2 — Conflict recovery

- Range-progress journal events; resume-at-position continue; abort restores exact pre-state.
- Exit gate: fault injection mid-range (before Git, between commits, during conflict, after final
  commit before manifest publish) either resumes correctly or restores the prior generation.

### M3 — Protocol, IPC, CLI

- `actions.restoreTo` in `protocol/types.ts` + `handlers.ts`; preload bridge; broadcast
  `actions.updated` with journal generation.
- `mousse-cli restore` with JSON contract documented in `docs/CLI.md`.
- Exit gate: two windows plus a CLI observe identical operation state for one restore.

### M4 — Renderer surfaces

- "Restore To Here" on completed actions with valid boundaries; disabled-with-reason otherwise;
  preview of cumulative affected files and external effects before confirmation; published-range
  warning; refresh stale affordances on `actions.updated`.
- Exit gate: UAT checklist covers restore-from-depth-1, depth-N, post-publish restore, conflict UX.

## 7. Test Matrix

- Depth 1 (parity with undoLatest), depth 2, depth N spanning stopped turns and child integrations.
- Range containing a prior undo's compensation and a redo's revert.
- Child-agent merge commits inside multiple actions (mainline `-m 1` correctness across the range).
- Conflict at first, middle, and final commit; continue and abort paths; crash between each.
- Target action lacking `safeBoundaryProof` (falls back to code-only revert offer).
- Actions in the range previously published; republish includes compensation.
- Dirty worktree, running descendant, concurrent CLI/GUI invocation (lock rejection).
- Windows `EPERM`/`EBUSY` retries during compensation commit.
- Non-Git threads and threads without workspaces (feature unavailable messaging unchanged).

## 8. Rollout

Ship behind the existing undo feature flag, defaulting off; enable after M1–M2 gates pass, then
surface renderer affordances with M4. Kill switch removes the `actions.restoreTo` surface without
touching stored journals; any interrupted restore completes or aborts through the M2 recovery path
regardless of flag state.
