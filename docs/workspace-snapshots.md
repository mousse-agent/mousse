# Workspace snapshots

Status: phases 1 and 2 of [#464](https://github.com/mousse-agent/mousse/issues/464) are implemented (turn snapshots, outside changes, Undo, Redo, revert and conversation forks). Phase 3 (subagent and workflow results, Publish, worktree retirement) still uses the commit-based code behind the shortcuts listed at the end. Phase 4 (projects without Git) is not started.

## Why

Mousse used to record a turn by committing on the thread's own branch (`mousse/thread/<id>/main`) through the real index. The agent and the person do their real Git work on that same branch, so the two collided: an agent that switched branches, rebased or reset locked its thread ("Workspace branch changed during execution"), Mousse's `mousse: checkpoint …` and `mousse: undo …` commits ended up in pull requests, and the checkpoint's `git add -A` wiped the agent's staging.

Now a turn is recorded as a private snapshot of the files, stored with Git but kept apart from the branch, HEAD and index. The agent can create branches, commit, rebase and push like in any checkout.

## The model

A **snapshot** is a commit whose tree holds every file of a worktree: tracked and untracked, not ignored, not `.mousse/`. Its parent is the worktree's HEAD when it was taken (none in a repository without a commit). Nothing points at it except refs under `refs/mousse/`, so it belongs to no branch and a push never carries it.

`takeSnapshot` (`src/mms/actions/snapshots.ts`):

1. Uses a private, persistent index at `git rev-parse --git-path mousse/snapshot-index`. Git keeps names it doesn't know in each linked worktree's own Git directory, so every worktree has its own. The index is persistent so Git's stat cache keeps the next snapshot fast. It is seeded from `HEAD` (or empty) when missing, and rebuilt, lock file included, when it is corrupt.
2. Runs `GIT_INDEX_FILE=<it> git add -A -- . ':(exclude).mousse'`, `write-tree`, then `commit-tree <tree> [-p HEAD]` as `Mousse <mousse@local>` with the message `mousse snapshot: <reason>` and the trailers `Mousse-Thread`, `Mousse-Operation`, `Mousse-Head` and `Mousse-Branch`. Every command goes through the hardened `git()` helper: no repository hook, filter driver or program runs.
3. Never changes HEAD, a branch, the real index or a file. It works during a merge, rebase, revert or cherry-pick and records that (`operationInProgress`) instead of refusing.
4. Returns the previous snapshot when the tree and HEAD are what it had (`mousse/snapshot-last.json` next to the index), so a turn that changes nothing starts and ends on one commit.

### Invariants

- Mousse never commits on, switches, resets or stages in the thread's branch or index. The one exception is the commit-based paths in the phase 3 list.
- A snapshot's parent is the real HEAD and snapshots never chain to each other. Releasing the expired refs of a receipt (`ReceiptRefReleaseService`) therefore frees the snapshots it pinned; nothing else keeps them reachable.
- An action's `startSha` and `endSha` mean "the code before / after". They are snapshots, or branch commits in actions recorded before snapshots; both are commits, so every consumer that reads a tree or a diff keeps working.
- `workspace.json` `branch` stays "the thread branch Mousse created". The agent may be on another branch; nothing follows it.
- Only files change when Mousse restores something. HEAD, branches, the real index and the stash are never touched.
- A turn's changes are uncommitted files until someone commits them. That is the normal state between turns.

## Refs and records

| What | Where |
| --- | --- |
| Latest snapshot of a thread | `refs/mousse/threads/<threadId>/<branchId>` (`workspace.json` `retainedRef`), moved by every snapshot receipt |
| Before / after of a change | `refs/mousse/changes/<receiptId>/{before,after}` (exactly this pair; inventory and release assume it) |
| A conversation branch's code | `refs/mousse/conversation-branches/<id>` |
| A subagent's retained result | `refs/mousse/agents/<id>` |
| The thread's last snapshot, as data | `workspace.json` `snapshotSha`; `headSha` is the last HEAD Mousse saw (informational) |

`ThreadAction` (`src/shared/threadActions.ts`):

- `startSha`, `endSha`: the snapshots around the action.
- `changedPaths`: the files that differ between the two trees.
- `commits`: the real commits the action added to HEAD, first parent only, oldest first. Empty when HEAD did not move or history was rewritten.
- `git`: `{ headBefore, headAfter, branchBefore, branchAfter, rewroteHistory, operationInProgress? }`. The same record is on the receipt; a receipt with `git` is a snapshot receipt.
- `notice`: a line Undo, Redo or revert shows with its result (see below).

## Turn admission and outside changes

`ThreadActionService.recordOutsideChanges` (called where `saveUserChanges` used to be):

1. Takes a snapshot of the files.
2. Compares its tree with the latest recorded snapshot: `snapshotSha`, else the latest action's end, else `headSha` (a workspace from before snapshots), else HEAD.
3. When they differ, the files were changed outside a Mousse action (an editor, a terminal, `git` in a shell). That is recorded as a completed action of the actor `user` with a receipt, a turn id `user-changes:<id>`, no messages and no conversation start boundary, so the app never offers it as a turn to undo. The turn then starts from that snapshot, and Undo of the turn leaves the edits alone.
4. When they are the same, nothing is recorded and the new snapshot becomes the latest.

Turn start no longer requires a clean worktree, no longer moves uncommitted changes aside, and no longer compares the branch name or HEAD. `ThreadWorkspaceManager.verify` reports a workspace ready when the worktree exists and no Mousse operation is waiting for recovery (`recovery_required`, `prepared`, `git_applied`, `context_pending`).

What still stops a turn: an operation Mousse left unfinished (a subagent merge conflict, an interrupted restore), as before.

## Checkpoint

`checkpoint()` records the action's end: it takes a snapshot, describes the Git work between the start and the end (`describeGit`), diffs the two trees, records the receipt and pins its refs. A failed or stopped turn is recorded the same way. There is no commit, so a user's own commit that a hook rejected is recorded as a failed action without anything to bypass; the `onFailure: 'record'` option is gone.

A subagent's result or a nested snapshot recorded while the action runs becomes one of its `contributions`, found by the action's time window (a snapshot has no ancestry to test).

Interrupted checkpoints recover by taking the snapshot again from the files.

## Undo, Redo and revert

All three are one operation, `restoreChange(worktree, { base, ours, theirs })`:

1. `ours` is a snapshot of the files as they are now, taken under the mutation locks.
2. `git merge-tree --write-tree --merge-base=<base> <ours> <theirs>` merges the change in. Undo of a turn uses `base` = the turn's end snapshot, `theirs` = its start snapshot. Redo is Undo of the compensation action (`base` = the state after the undo, `theirs` = the state before it). Reverting an older turn is Undo of that turn against today's files.
3. On conflicts the operation is refused with the conflicting paths (`restore_conflict`) and changes nothing: no journal entry, no file, no state.
4. Otherwise only the files the merge changes are rewritten with `read-tree -m -u <ours> <result>` in a temporary private index (a copy of the persistent one, so Git sees the files still match), and the result is recorded as a new snapshot.

Refused beforehand: a merge, rebase, revert or cherry-pick in progress or an unresolved conflict in the worktree (`workspace_conflict`, with Discard for a merge, none for a rebase), an expired action, a published action, and a later change that depends on the target. Revert also refuses an action whose start and end trees are the same.

Deviation from the first design: Undo does not require the files to equal the turn's end snapshot. Requiring it would refuse whenever the person has an edit in progress, which Undo has handled since #432. The three-way merge keeps edits to other files and refuses only edits that overlap.

HEAD and the real index never move. Undoing a turn whose commits are still on the branch leaves those commits there; `git status` shows the restore as ordinary changes. When any of the turn's commits is reachable from a `refs/remotes/*` ref the result carries `notice`: "These commits were already pushed to <ref>; Undo restores files only." (Redo has none; revert says "Revert".) `PromptUndoControls` shows it next to "Turn undone" until dismissed.

### Recovery

`prepared` records the snapshot before (`ours`) and the tree the files are about to become (`expectedTree`). After an interruption (`UndoService.recoverPending`, `CodeRevertService.recoverPending`) the files tell what happened:

| Files | Meaning |
| --- | --- |
| A receipt exists for the operation | the restore landed; the action is finished from the receipt |
| The tree equals `expectedTree` | landed; a snapshot and the receipt are recorded now |
| The tree equals `ours` | not applied; the operation is cancelled and the target is undoable again |
| Anything else | stays pending (`recovery_required`) for a person; nothing is overwritten |

Intents written before snapshots (no `ours`) are proven the old way, by HEAD and the commit message, so an operation interrupted across the upgrade still settles.

## Conversation forks

`fork` pins the action's end snapshot (or, for "current code", a snapshot of the files now) under `refs/mousse/conversation-branches/<id>`. No Git branch is made. `activate` records outside changes for the branch being left, keeps the files under that branch's ref (the thread's first branch is not in the list and keeps the thread ref), writes the selected branch's snapshot over the files, and updates `workspace.json`. HEAD, the Git branch and the index stay as they are. A fork's `gitBranch` is the thread's own branch.

Cross-thread fork seeding creates the new worktree at the HEAD the snapshot was taken on, then writes the snapshot's files and makes the snapshot the thread's first one (`provision(…, { snapshot })`).

## Legacy compatibility

- Actions and receipts recorded before snapshots keep commits as `startSha`/`endSha`; Undo, review, forks and retention work on them.
- A thread locked by the old branch or history check has a journal entry in `recovery_required` whose action sits in `actions.json`. `ThreadActionService.recoverPending` (run at the next turn and by `operations.recover`) retakes the snapshot, so the thread unlocks after the upgrade. The same goes for the old "commit landed with files still changed" entry. Tested in `tests/workspaceSnapshots.test.ts`.
- Conversation branches made before snapshots keep their Git branch names; activating one no longer switches to it.
- `isPublished` is a receipt id in a publish receipt's `publishedReceiptIds`, no ancestry. Publish fills the list for snapshot receipts whose commits are in the published commit (see below).

## Known limits

- Discard (`workspace.discardPendingChanges`), offered for a merge conflict, resets the worktree to HEAD, and uncommitted turn results are part of what it drops. A copy stays under `refs/mousse/discarded/`.
- A worktree with uncommitted files is not retired by storage cleanup (`WorktreeRetirementService.inspectContent` refuses dirty content), so such worktrees are kept until phase 3 retires from snapshots.
- Large untracked files are in every snapshot, as they were in every checkpoint (out of scope in #464).

## Phase 3 TODO

Shortcuts taken to keep these paths working while turns became snapshots. Each should be replaced, not extended.

1. **Subagent results (`ChildAgentIntegrationService`).** A worker's result is its end snapshot, merged into the thread with `git merge --no-ff <snapshot>` behind `pinnedWorkerSha`. That puts a snapshot commit in the thread branch's history, and it commits on the branch. Replace with a file-level three-way merge (`mergeTrees` base = spawn base, ours = current snapshot, theirs = worker snapshot) recorded as a snapshot receipt, or one squashed commit, never a merge of snapshot history. A conflict still leaves the merge in progress and sets the thread's uncommitted work aside under `refs/mousse/pending-changes/`; with turn results uncommitted, that is a data-safety risk until integration stops merging. After a merge the latest snapshot is adopted (`ChangeReceiptService.adoptSnapshot`) outside the receipt, so a crash in between shows up as outside changes at the next turn.
2. **Worker and workflow worktrees.** They checkpoint as snapshots too: their results are uncommitted files and `HEAD` stays at the spawn base. `snapshotOwnedParent` no longer checkpoints the parent (its uncommitted files are set aside around the merge). `createAgentWorktree` writes the thread's snapshot files into the new worker worktree. Workflow admission no longer compares HEAD or branch for isolated children (`expectedHeadSha` is now unused). `isWorkflowRevisionCurrent` uses receipt generations instead of ancestry for snapshot receipts.
3. **Publish.** It still merges the thread worktree's HEAD, so uncommitted turn results are not published; the person commits them first (Git panel). `completePublish` marks a snapshot receipt published when every commit the receipt added is in the published commit. Replace with one squashed commit built from the latest snapshot, filling `publishedReceiptIds` by receipt.
4. **Retirement, cleanup and GC.** `WorktreeRetirementService`, `StorageCleanupService` (`headSha` must equal HEAD to retire) and `ResourcePurgeService` assume a clean worktree at a commit. Retire from the snapshot (reconstruct at `snapshotOrigin(...).head` and write the files back) and decide what `headSha` means for them. `ThreadWorkspaceManager.restore` without a manifest already does this: it recreates the worktree from the thread branch and writes the retained snapshot's files over it, and refuses when the branch is gone.
5. **Inventory.** `ResourceInventory` treats `workspace.json` `branch` and `retainedRef` as owned refs. The retained ref now holds a snapshot; the branch is the thread's own, though the agent may be on another. Fork conversation branches have no Git branch of their own any more.
6. **Git panel rules** (`git_amend_in_thread`, `git_thread_dirty` before push, `thread_worktree_checkpointed`) are unchanged and out of scope; their wording about "checkpointed" is stale.
7. **Phase 4:** projects without Git and standalone threads (a hidden store in Mousse's data).
8. **GLOSSARY:** this change adds **Snapshot**; the issue's phase 5 asks for the rest of the model's terms once phase 3 settles them.

## Tests

- New: `tests/workspaceSnapshots.test.ts` (snapshot model, an agent that switches branches, rewrites history, commits and pushes, rebase in progress, outside changes, three-way Undo/Redo/revert, recovery including locked legacy threads, forks, fork seeding, a subagent's pinned snapshot).
- Updated for the new model: `tests/dirtyWorkspace*.test.ts`, `tests/reviewRange.test.ts`, `tests/reviewProtocol.test.ts`, `tests/promptUndoUi.test.ts`, `tests/net/bridge/routed/editorFolder.test.ts`.
- Updated without being run (they are in the `process` lane, which this change was developed without): `tests/turnCheckpointUndo.test.ts`, `tests/gitFoundation{Undo,Recovery,OperationRecovery,Protocol,WorkspaceLifecycle}.test.ts`, `tests/gitDaemonMethods.test.ts`, `tests/undoRetention.test.ts`, `tests/receiptRefRelease.test.ts`, `tests/conversationForkRetirement.test.ts`, `tests/platformWorkflowWorkspace.test.ts`. Run them before relying on phase 3.
