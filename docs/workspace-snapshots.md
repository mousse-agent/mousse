# Workspace snapshots

Status: phases 1 to 3 of [#464](https://github.com/mousse-agent/mousse/issues/464) are implemented: turn snapshots, outside changes, Undo, Redo, revert and conversation forks (1 and 2), then subagent and workflow results, Publish, the Git panel's push, and worktree retirement, cleanup, GC and inventory (3). Phase 4 (projects without Git and standalone threads) is not started.

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

- Mousse never commits on, switches, resets or stages in the thread's branch or index. The one commit it makes is Publish's, in the primary checkout, with the person's own identity.
- Mousse never sets aside or drops a thread's uncommitted work to make room for an operation. An operation that cannot proceed on the files as they are refuses with the file names and changes nothing.
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
| A subagent's retained result (a snapshot of the worker's files) | `refs/mousse/agents/<id>` |
| A workflow agent's spawn snapshot, then its result | `refs/mousse/workflows/<profile>/<thread>/<agent>` (`workspace record` `retainedRef`) |
| The thread's files as last published | `refs/mousse/published/<threadId>` (kept in the primary's repository) |
| A retired worktree | `refs/mousse/lifecycle/<profile>/<thread>/<key>/{base,result,snapshot}` (`snapshot` only when the worktree held uncommitted files) |
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

What still stops a turn: an operation Mousse left unfinished (an interrupted restore, integration or publish), as before. A refused integration or publish leaves nothing unfinished.

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

## Subagent and workflow results

A worker's result is a snapshot of its files: a delegated task's end snapshot, or a workflow agent's. `ChildAgentIntegrationService` brings it into the thread as files, by the same operation as Undo (`restoreChange`):

1. `base` is the code the worker started from. A delegated task's is its spawn commit. A workflow agent starts from a snapshot of the thread's files, uncommitted work included (`createAgentWorktree` writes it over the worker's checkout and pins it as `baseSnapshot`), so that is its base.
2. `ours` is a fresh snapshot of the thread, taken under the mutation locks. The thread's uncommitted turn work is in it and stays exactly where it is.
3. `theirs` is the worker's pinned snapshot. The worker may have moved on; nothing else about its worktree is read.
4. A conflict refuses with the file names (`integration_conflict`) and changes nothing: no journal entry, no file, no ref, no pending operation. The worker's result stays pinned.
5. Otherwise only the files the merge changes are rewritten. No commit is made, HEAD, the branches and the real index do not move, and nothing is set aside.

The receipt (`kind: 'integration'`) runs from the snapshot before to the snapshot after and carries `contributions` (`actorId`, `baseSha`, `resultSha`) and the usual `git` record. Recording it moves the thread's latest snapshot, so the next turn finds no outside changes. `refs/mousse/agents/<id>` pins the worker's result.

`prepared` records the snapshot before, the worker's snapshot, the base and the tree the files are about to become. Recovery (`recoverPending`, or an explicit retry of the same operation) merges again from the files as they are: changes that already landed are the same on both sides, so only what is missing is written. A receipt that exists finishes the action's bookkeeping from the receipt. A conflict while recovering cancels the operation, so the thread is not left locked.

"The worker produced no change" is read from the files (the worker's tree against its base), not from commits. A workflow agent that changed nothing records its spawn snapshot as its result.

## Publish

`PublishService` puts the thread's latest snapshot into the primary checkout as **one commit** on the branch the primary is on, made with the person's own Git identity (`commit-tree` without Mousse's author), so no snapshot and no commit of the agent's reaches the primary's history.

1. The thread's files are snapshotted under the locks. Changes made outside Mousse since the last action are recorded as an action of the user first. If the files are not the ones that were reviewed (`expectedSourceSha` is a snapshot, or any commit with the same files), publishing refuses with "refresh review"; the recorded outside change is what the next review shows.
2. The primary must be on the target branch and clean. Uncommitted files in it are not set aside; they refuse with their names.
3. The tree is `merge-tree --write-tree --merge-base=<base> <primary HEAD> <snapshot>`. `base` is the snapshot the thread last published (`refs/mousse/published/<threadId>`), else the workspace's `baseSha`. Using the last published files keeps a second publish from conflicting with the first over lines the thread changed again. A conflict returns `state: 'conflict'` with the file names and changes nothing.
4. When the tree is the primary's own there is nothing to add, and no commit is made. Otherwise the commit is created, `prepared` records it, and `merge --ff-only` moves the branch, the index and the files together; Git refuses before touching anything it cannot update.
5. The receipt (`kind: 'publish'`) has `publishedReceiptIds`: the thread's receipts other than publishes, on the active conversation branch, whose action has not been undone. The files are the thread's latest, so those are the changes they contain. Undo of a published receipt stays refused.

Recovery after an interruption looks at the primary's HEAD: at the recorded commit it completes the record, at the recorded start it makes the move again. A publish interrupted before snapshots was a merge commit and is recognised as landed when the reviewed commit is its ancestor.

## Pushing from the Git panel

A push sends commits, so uncommitted files no longer stop it. The result carries `notice` ("Pushed the commits. N uncommitted files were not pushed.") when the worktree holds any. The panel's refusals in a thread's worktree (Pull, Stage, Unstage, Amend) keep their rules and now say they are not available there, not that the branch is "checkpointed".

## Worktree retirement and reconstruction

Storage cleanup, trashed threads and permanent deletion retire worktrees through `WorktreeRetirementService`.

- A worktree whose files are its HEAD retires as before.
- A worktree with uncommitted files (modified, deleted or untracked) retires too: under the repository lease, `prepare` takes a snapshot, checks that every file is one the snapshot holds (ignored files still keep the worktree), and pins the snapshot (`…/snapshot`) next to the real HEAD (`…/result`) and the base. `retire` checks the files against the snapshot's tree again and only then removes the worktree with `--force`.
- Staged changes, a merge, rebase or other operation in progress, unresolved conflicts and a sparse checkout with uncommitted files keep the worktree: a snapshot of the files does not hold them. Ignored files, another repository inside it and unpublished commits keep it as before.
- The manifest records `snapshotSha`, `snapshotTree` and `headBranch` (the branch HEAD was on, which may be one the agent switched to). Reconstruction creates the worktree at the recorded HEAD, on its branch when the tip is still that HEAD (`headBranch`, then the thread's), detached there otherwise, checks it out, writes the snapshot's files with `moveFiles`, and verifies the content against the manifest. `ThreadWorkspaceManager.restore` without a manifest does the same from the retained snapshot (`snapshotOrigin`). Staging is not restored.
- A recorded result that is a snapshot (a workflow agent's, an episode's) is compared with the worktree's files by tree, not with HEAD.
- Cleanup no longer reads `workspace.json` `headSha` as HEAD. A worktree counts as merged when its commits are in the default branch, or when the thread's last publish put exactly the files of HEAD into the primary (`refs/mousse/published/<threadId>`'s tree).
- Permanent deletion asks for confirmation before a retired snapshot is dropped (`discardRequired`), as it does for unpublished commits. It reads the branch from the owner's record, not from the worktree's HEAD.
- The inventory does not compare the worktree's branch with the owner's, claims the `snapshot` pin and `refs/mousse/published/<threadId>`, and treats a workflow agent whose result is its spawn snapshot as integrated.
- `WorkspaceGcService` never offers a ref for deletion when it points at a snapshot, whatever namespace holds it, and protects `refs/mousse/lifecycle/` and `refs/mousse/published/`.

## Conversation forks

`fork` pins the action's end snapshot (or, for "current code", a snapshot of the files now) under `refs/mousse/conversation-branches/<id>`. No Git branch is made. `activate` records outside changes for the branch being left, keeps the files under that branch's ref (the thread's first branch is not in the list and keeps the thread ref), writes the selected branch's snapshot over the files, and updates `workspace.json`. HEAD, the Git branch and the index stay as they are. A fork's `gitBranch` is the thread's own branch.

Cross-thread fork seeding creates the new worktree at the HEAD the snapshot was taken on, then writes the snapshot's files and makes the snapshot the thread's first one (`provision(…, { snapshot })`).

## Legacy compatibility

- Actions and receipts recorded before snapshots keep commits as `startSha`/`endSha`; Undo, review, forks and retention work on them.
- A thread locked by the old branch or history check has a journal entry in `recovery_required` whose action sits in `actions.json`. `ThreadActionService.recoverPending` (run at the next turn and by `operations.recover`) retakes the snapshot, so the thread unlocks after the upgrade. The same goes for the old "commit landed with files still changed" entry. Tested in `tests/workspaceSnapshots.test.ts`.
- Conversation branches made before snapshots keep their Git branch names; activating one no longer switches to it.
- `isPublished` is a receipt id in a publish receipt's `publishedReceiptIds`, no ancestry. Publishes made before snapshots keep the list they recorded.
- A subagent integration or publish interrupted before snapshots (a merge commit) is recovered: the integration merges the same pinned request again from the files, and the publish is recognised by the reviewed commit being an ancestor of the primary's HEAD.

## Known limits

- Discard (`workspace.discardPendingChanges`), offered for a merge conflict, resets the worktree to HEAD, and uncommitted turn results are part of what it drops. The prompt says so. The files are first recorded as a snapshot of an action of the person, a copy of everything stays under `refs/mousse/discarded/`, and the result carries `backupRef` and a `notice` that says how to bring the files back (`git restore --source=<ref>`).
- Retirement does not keep what is staged (it refuses instead) or the real index; reconstruction starts with an index equal to HEAD.
- Large untracked files are in every snapshot, as they were in every checkpoint (out of scope in #464).

## Still to do

Phase 4: projects without Git and standalone threads get snapshots and Undo through a hidden store in Mousse's data. The phase 5 documentation of the model's terms follows it.

## Tests

- `tests/workspaceSnapshots.test.ts`: the snapshot model, an agent that switches branches, rewrites history, commits and pushes, rebase in progress, outside changes, three-way Undo/Redo/revert, recovery including locked legacy threads, forks and fork seeding, subagent results (files arrive with the thread's uncommitted work and staging kept, conflict refuses and changes nothing, no-change refusal, recovery), Publish (one commit with the person's identity and no snapshot in its history, a second publish, stale review, conflict, dirty primary, missing identity), rebuilding a worktree from its snapshot, and GC.
- `tests/storageCleanupService.test.ts`, `tests/resourcePurge.test.ts`: a worktree with uncommitted files retires into a snapshot and comes back with identical files; what a snapshot cannot hold keeps the worktree; permanent deletion asks first.
- `tests/dirtyWorkspaceProtocol.test.ts`: push with uncommitted files, and Discard's record and notice.
- Updated for the new model: `tests/dirtyWorkspace*.test.ts`, `tests/reviewRange.test.ts`, `tests/reviewProtocol.test.ts`, `tests/promptUndoUi.test.ts`, `tests/net/bridge/routed/editorFolder.test.ts`, the Git panel tests.
- Process lane, updated for the new model: `tests/turnCheckpointUndo.test.ts`, `tests/gitFoundation{Undo,Recovery,OperationRecovery,Protocol,WorkspaceLifecycle,Integration,PublishGc}.test.ts`, `tests/gitDaemonMethods.test.ts`, `tests/undoRetention.test.ts`, `tests/receiptRefRelease.test.ts`, `tests/conversationForkRetirement.test.ts`, `tests/platformWorkflowWorkspace.test.ts`, `tests/resourceLifecycleAcceptanceInventory.test.ts`, `tests/resourceLifecycleNamedGate.test.ts`, `tests/chatService.test.ts` (a project agent's uncommitted edit stays uncommitted), `tests/resourceLifecycleQualificationStorage.test.ts` (trash retires checkouts with uncommitted files and they come back with the same bytes).
