# Workspace snapshots

Status: phases 1 to 3 of [#464](https://github.com/mousse-agent/mousse/issues/464) are implemented: turn snapshots, outside changes, Undo, Redo, revert and conversation forks (1 and 2), then subagent and workflow results, Publish, the Git panel's push, and worktree retirement, cleanup, GC and inventory (3). Phase 4 (projects without Git and standalone threads) is not started.

## Why

Mousse used to record a turn by committing on the thread's own branch (`mousse/thread/<id>/main`) through the real index. The agent and the person do their real Git work on that same branch, so the two collided: an agent that switched branches, rebased or reset locked its thread ("Workspace branch changed during execution"), Mousse's `mousse: checkpoint …` and `mousse: undo …` commits ended up in pull requests, and the checkpoint's `git add -A` wiped the agent's staging.

Now a turn is recorded as a private snapshot of the files, stored with Git but kept apart from the branch, HEAD and index. The agent can create branches, commit, rebase and push like in any checkout.

## The model

A **snapshot** is a commit whose tree holds every file of a worktree: tracked and untracked, not ignored, not `.mousse/`. Its parent is the worktree's HEAD when it was taken (none in a repository without a commit). Nothing points at it except refs under `refs/mousse/`, so it belongs to no branch and a push never carries it.

`takeSnapshot` (`src/mms/actions/snapshots.ts`):

1. Uses a private, persistent index at `git rev-parse --git-path mousse/snapshot-index`. Git keeps names it doesn't know in each linked worktree's own Git directory, so every worktree has its own. The index is persistent so Git's stat cache keeps the next snapshot fast. It is seeded from `HEAD` (or empty) when missing, and rebuilt, lock file included, when it is corrupt. Every snapshot also brings it in line with the files Git tracks, for the ones `add -A` cannot see: an ignored file that HEAD or the real index tracks (it was force-added) is added whenever it is on disk, and an ignored file neither tracks any more is dropped. The real index is only read.
2. Runs `GIT_INDEX_FILE=<it> git add -A -- . ':(exclude).mousse'`, `write-tree`, then `commit-tree <tree> [-p HEAD]` as `Mousse <mousse@local>` with the message `mousse snapshot: <reason>` and the trailers `Mousse-Thread`, `Mousse-Operation`, `Mousse-Head` and `Mousse-Branch`. Every command goes through the hardened `git()` helper, standard input and environment included: no repository hook, filter driver or program runs. A nested repository is recorded as a link to its HEAD, as Git does. One with no commit yet (an agent ran `git init` or a project generator inside the worktree) cannot be added, so when `add` fails the snapshot looks for such repositories and leaves them out; the turn is recorded and nothing locks.
3. Never changes HEAD, a branch, the real index or a file. It works during a merge, rebase, revert or cherry-pick and records that (`operationInProgress`) instead of refusing.
4. Reports what it leaves out (`coverageGaps`, carried into the action's and receipt's `git` record): a nested repository with no commit, and a file or folder it cannot read. Git stops at the first file it cannot read, so each one is left out and the add runs again. The receipt says it in words (`notCovered`: "Not covered: vendor/sub (nested repository with no commits), x.bin (unreadable)."), and so does the result of an Undo, Redo or revert. Ignored files are left out by design and never listed.
   A snapshot that cannot be taken at all never locks the thread: the turn starts from the last snapshot recorded, and its end is recorded where it started, with the error as a coverage gap of the whole worktree and the action not undoable.
5. Returns the previous snapshot when the tree and HEAD are what it had (`mousse/snapshot-last.json` next to the index), so a turn that changes nothing starts and ends on one commit.

### Invariants

Mousse observes, records and reports; it never guards or polices agents. Three rules hold everywhere:

1. **Observe.** Snapshots, turn records and Undo never move HEAD, the index or branches. Explicit actions such as Publish do exactly the change their label names.
2. **Snapshot before and after.** Every turn is recorded from a snapshot at its start and one at its end.
3. **Never destroy bytes.** Every removal keeps the bytes somewhere recorded: a retired worktree moves into the trash and is deleted only after a snapshot of it.

In detail:

- Mousse never commits on, switches, resets or stages in the thread's branch or index. The one commit it makes is Publish's, in the primary checkout, with the person's own identity.
- Mousse never sets aside or drops a thread's uncommitted work to make room for an operation. An operation that cannot proceed on the files as they are refuses with the file names and changes nothing.
- A snapshot's parent is the real HEAD and snapshots never chain to each other. Releasing the expired refs of a receipt (`ReceiptRefReleaseService`) therefore frees the snapshots it pinned; nothing else keeps them reachable.
- An action's `startSha` and `endSha` mean "the code before / after". They are snapshots, or branch commits in actions recorded before snapshots; both are commits, so every consumer that reads a tree or a diff keeps working.
- `workspace.json` `branch` stays "the thread branch Mousse created". The agent may be on another branch; nothing follows it. What the thread reports (`ThreadWorkspaceManager.executionContext().branch`) is the branch HEAD is on now, none when detached.
- Only files change when Mousse restores something. HEAD, branches, the real index and the stash are never touched.
- Every ref Mousse writes or deletes is written with `--no-deref`, and a branch name that is a symbolic ref is never followed, so a ref can never move or delete the branch it points at.
- A turn's changes are uncommitted files until someone commits them. That is the normal state between turns.

## Refs and records

| What | Where |
| --- | --- |
| Latest snapshot of a thread | `refs/mousse/threads/<threadId>/<branchId>` (`workspace.json` `retainedRef`), moved by every snapshot receipt |
| Before / after of a change | `refs/mousse/changes/<receiptId>/{before,after}` (exactly this pair; inventory and release assume it) |
| A conversation branch's code | `refs/mousse/conversation-branches/<id>` |
| A chat agent's start and result | `refs/mousse/agents/<id>/base`, `refs/mousse/agents/<id>/result` |
| A delegated task's start and result | `refs/mousse/delegations/<childThreadId>/<delegationId>/{base,result}` (`:` in the id becomes `-`; listed in the subagent thread's `subagent-results.json`) |
| A workflow agent's spawn snapshot and its result | `refs/mousse/workflows/<profile>/<thread>/<agent>-base`, `refs/mousse/workflows/<profile>/<thread>/<agent>` (`workspace record` `retainedRef`) |
| The thread's files as last published | `refs/mousse/published/<threadId>` (kept in the primary's repository) |
| A retired worktree | `refs/mousse/lifecycle/<profile>/<thread>/<key>/{base,result,snapshot}` (`snapshot` only when the worktree held uncommitted files; replaced by the trash expiry's snapshot) |
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

What still stops a turn: an operation Mousse left unfinished (an interrupted restore or checkpoint), until recovery settles it. Recovery runs before the next turn and admits `recovery_required` too, so a thread an older version left waiting unlocks on its own. A refused publish leaves nothing unfinished.

## Checkpoint

`checkpoint()` records the action's end: it takes a snapshot, describes the Git work between the start and the end (`describeGit`), diffs the two trees, records the receipt and pins its refs. A failed or stopped turn is recorded the same way. There is no commit, so a user's own commit that a hook rejected is recorded as a failed action without anything to bypass; the `onFailure: 'record'` option is gone.

A nested snapshot recorded while the action runs becomes one of its `contributions`, found by the action's time window (a snapshot has no ancestry to test).

Interrupted checkpoints recover by taking the snapshot again from the files. If that fails too, the operation stays `recovery_required` with the new error, so the reason shown is what stopped the retake.

## Undo, Redo and revert

All three are one operation, `restoreChange(worktree, { base, ours, theirs })`:

1. `ours` is a snapshot of the files as they are now, taken under the mutation locks.
2. `git merge-tree --write-tree --merge-base=<base> <ours> <theirs>` merges the change in. Undo of a turn uses `base` = the turn's end snapshot, `theirs` = its start snapshot. Redo is Undo of the compensation action (`base` = the state after the undo, `theirs` = the state before it). Reverting an older turn is Undo of that turn against today's files.
3. On conflicts the operation is refused with the conflicting paths (`restore_conflict`) and changes nothing: no journal entry, no file, no state.
4. Otherwise only the files the merge changes are rewritten with `read-tree -m -u <ours> <result>` in a temporary private index (a copy of the persistent one, so Git sees the files still match), and the result is recorded as a new snapshot. A file on disk at a path the restore writes or deletes that `ours` does not hold (an ignored or excluded file, or what fills a folder that becomes a file) is no snapshot's: it is stored first under `refs/mousse/preserved/<operation>-<sha>`, and the result's `notice` names the ref and the files. Every `moveFiles` caller (restore, reconstruction, fork seeding) gets the same protection.

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

Mousse never merges a subagent's or workflow agent's work into its parent. Every completion reports a frozen result to the parent agent, in the result it already receives, and the parent agent brings the work in itself with Git.

The report (`SubagentResultReport`, built by `src/mms/agents/subagentResultReport.ts`) holds:

- where it worked: its worktree, or the parent's own folder, marked as shared;
- `baseSha` and `resultSha`, the files it started from and finished with, each pinned under a `refs/mousse/` ref (table above) that outlives the worktree's cleanup and is deleted only with its thread;
- the files that differ between the two;
- the Git state it left: the branch HEAD is on, HEAD, and the first-parent commits since it started (the latest few, with a count), or that it rewrote history.

As text it ends with how to bring the files in: `git diff --binary <base> <result> | git apply --3way`, or a cherry-pick of the listed commits. A subagent that shared the parent's folder reports the folder's change between its start and end (from the parent's own turn records) and says its changes are already in the parent's files. A worker that changed nothing says so.

Where the report goes:

1. A delegated task: the wake notice the parent reads when the task ends, outside the notice's text budget, and `task_status` (`workspaceResult`, `workspaceResultText`). The base is the start of the subagent's first turn, the result the task's own checkpoint.
2. A chat agent: `finalizeAgent` records the worker's result, pins it, logs the report and marks the agent completed. Nothing is merged.
3. A workflow agent: `reportOwnedAgentWorkspace` pins the spawn snapshot and the result and returns a revision that names the parent's files unchanged, with the report as `result`.

`integrate_delegation` and `integrate_subagent` are no longer offered. A call to either still answers, with `merged: false` and the report. An `integration` run an older version queued ends `cancelled` with a notice that carries the report.

After the upgrade, a merge of a subagent's result that an older version left unfinished (`child-integration` or `change-integration` in `running`, `prepared`, `git_applied` or `recovery_required`) is never run again: `cancelPendingIntegrations` records it as `cancelled`, and the thread gets a message naming it, on the workflow path too. A `git merge` it left stopped in the folder is named in that message ("still in progress in <path>") and can still be aborted with `operations.abort`. The delegation guidance agents see tells the main agent all of this.

## Publish

`PublishService` puts the thread's latest snapshot into the primary checkout as **one commit** on the branch the primary is on, made with the person's own Git identity (`commit-tree` without Mousse's author), so no snapshot and no commit of the agent's reaches the primary's history.

1. The thread's files are snapshotted under the locks. Changes made outside Mousse since the last action are recorded as an action of the user first. If the files are not the ones that were reviewed (`expectedSourceSha` is a snapshot, or any commit with the same files), publishing refuses with "refresh review"; the recorded outside change is what the next review shows.
2. The primary must be on the target branch and clean. Uncommitted files in it are not set aside; they refuse with their names. Ignored files are never written over: a path the published tree adds or changes (or a folder above one) that holds an ignored, untracked file in the primary refuses with the file names before the commit is made, and the fast-forward runs with `--no-overwrite-ignore`.
3. The tree is `merge-tree --write-tree --merge-base=<base> <primary HEAD> <snapshot>`. `base` is the snapshot the thread last published (`refs/mousse/published/<threadId>`), else the workspace's `baseSha`. Using the last published files keeps a second publish from conflicting with the first over lines the thread changed again. A conflict returns `state: 'conflict'` with the file names and changes nothing.
4. When the tree is the primary's own there is nothing to add, and no commit is made. Otherwise the commit is created, `prepared` records it, and `merge --ff-only --no-overwrite-ignore` moves the branch, the index and the files together; Git refuses before touching anything it cannot update. A refused fast-forward closes the attempt as `cancelled` (the branch did not move), so it never leaves the thread waiting.
5. The receipt (`kind: 'publish'`) has `publishedReceiptIds`: the thread's receipts other than publishes, on the active conversation branch, whose action has not been undone. The files are the thread's latest, so those are the changes they contain. Undo of a published receipt stays refused.

Recovery (`PublishService.recoverPending`) only records or cancels; it never publishes again and never touches the primary's files, index or branches. It reads the target branch's tip: when the recorded commit is the tip or an ancestor of it (the person may have committed on top), the publish is recorded as completed; otherwise it is cancelled with the reason. When the primary checkout cannot be read (a disk that is not mounted) nothing is decided and the next recovery tries again. A publish waiting to be settled concerns the primary checkout only, so it never holds up the thread's turns; a new Publish settles it first. A merge a publish from an older version left in progress is reported ("still in progress in <path>") and can still be aborted with `operations.abort`. It settles `prepared`, `git_applied` and `recovery_required` entries alike. A publish interrupted before snapshots was a merge commit and is recognised as landed when the reviewed commit is its ancestor. Calling `publish` again with the operation id of an unfinished attempt settles that attempt the same way first; only when it did not land does the explicit Publish go on.

## Pushing from the Git panel

A push sends commits, so uncommitted files no longer stop it. The result carries `notice` ("Pushed the commits. N uncommitted files were not pushed.") when the worktree holds any. The panel's refusals in a thread's worktree (Pull, Stage, Unstage, Amend) keep their rules and now say they are not available there, not that the branch is "checkpointed".

## Worktree retirement and reconstruction

Storage cleanup, trashed threads and permanent deletion retire worktrees through `WorktreeRetirementService`. Retirement never removes a worktree after a check: it moves it, so a write that lands after the checks is kept.

- `prepare`, under the repository lease, takes a snapshot when the worktree has uncommitted files (modified, deleted or untracked), checks that every file is one the snapshot holds (ignored files still keep the worktree), and pins the snapshot (`…/snapshot`) next to the real HEAD (`…/result`) and the base.
- `retire` moves the folder into Mousse's trash in one step: a rename to `<profile>/trash/worktrees/<thread>/<key>` (fixed per worktree, so a crash after the move finds it), retried briefly on Windows like a thread's folder (`renameFolder`), then `git worktree repair` so Git registers the checkout at its new place. A folder in use fails the rename and stays where it is, intact. The manifest goes from `prepared` to `trashed`.
- The folder in the trash may still be live: a process can keep its working directory there and write. A restore (`reconstruct`) therefore moves the folder back as it is, and nothing is ever rebuilt beside a folder still in the trash.
- The hourly storage run deletes a worktree from the trash once it has waited an hour with nothing in it changing (`expireTrash`). It asks the in-use check first, then takes a snapshot of the folder and pins it in place of the earlier pins, then reads the folder again. When anything changed since the snapshot, it takes another one and the delete waits for the next run; otherwise Git removes it. A pin is never replaced by one that does not contain it: an earlier result or snapshot the folder moved away from stays under `…/kept/<sha>` (listed in the manifest's `keptRefs`) until the owner is permanently deleted. A restore that finds a released branch's commit gone skips it and records it (`branchesNotRestored`). What a snapshot cannot hold (ignored or other files Git does not see, staged changes, an operation in progress) keeps the folder in the trash, with the reason in the report. The manifest becomes `retired`, and a later restore rebuilds the worktree from the snapshot: at the recorded HEAD, on its branch when the tip is still that HEAD (`headBranch`, then the thread's), detached otherwise, with the snapshot's files written by `moveFiles`.
- Permanent deletion of a thread takes its trashed worktree with it.
- The worktree's own `mousse/*` branch is deleted once its tip is HEAD or the commit a pinned snapshot was taken on (or an ancestor of one) and no worktree has it checked out: right after the move when the agent had switched away, otherwise when the trash deletes the folder. The manifest records it (`deletedBranches`) and a restore recreates it at that tip. Branches and worktrees an agent made itself are never touched, and the `refs/mousse/` refs that Undo, restore and subagent reports read stay.
- Staged changes, a merge, rebase or other operation in progress, unresolved conflicts and a sparse checkout with uncommitted files keep the worktree: a snapshot of the files does not hold them. Ignored files, another repository inside it and unpublished commits keep it as before.
- `ThreadWorkspaceManager.restore` without a manifest rebuilds from the retained snapshot (`snapshotOrigin`). Staging is not restored.
- A recorded result that is a snapshot (a workflow agent's, an episode's) is compared with the worktree's files by tree, not with HEAD.
- Cleanup no longer reads `workspace.json` `headSha` as HEAD. A worktree counts as merged when its commits are in the default branch, or when the thread's last publish put exactly the files of HEAD into the primary (`refs/mousse/published/<threadId>`'s tree).
- Permanent deletion asks for confirmation before a retired snapshot is dropped (`discardRequired`), as it does for unpublished commits. It reads the branch from the owner's record, not from the worktree's HEAD.
- The inventory does not compare the worktree's branch with the owner's, claims the `snapshot` pin, `refs/mousse/published/<threadId>` and the subagent result pins, and does not count a workflow agent whose result was pinned and reported as waiting for integration.
- `WorkspaceGcService` never offers a ref for deletion when it points at a snapshot, whatever namespace holds it, and protects `refs/mousse/lifecycle/` and `refs/mousse/published/`.

## Conversation forks

`fork` pins the action's end snapshot (or, for "current code", a snapshot of the files now) under `refs/mousse/conversation-branches/<id>`. No Git branch is made. `activate` records outside changes for the branch being left, keeps the files under that branch's ref (the thread's first branch is not in the list and keeps the thread ref), writes the selected branch's snapshot over the files, and updates `workspace.json`. HEAD, the Git branch and the index stay as they are. A fork's `gitBranch` is the thread's own branch.

Cross-thread fork seeding creates the new worktree at the HEAD the snapshot was taken on, then writes the snapshot's files and makes the snapshot the thread's first one (`provision(…, { snapshot })`).

## Legacy compatibility

- Actions and receipts recorded before snapshots keep commits as `startSha`/`endSha`; Undo, review, forks and retention work on them.
- A thread locked by the old branch or history check has a journal entry in `recovery_required` whose action sits in `actions.json`. `ThreadActionService.recoverPending` (run at the next turn and by `operations.recover`) retakes the snapshot, so the thread unlocks after the upgrade. The same goes for the old "commit landed with files still changed" entry. Tested in `tests/workspaceSnapshots.test.ts`.
- Conversation branches made before snapshots keep their Git branch names; activating one no longer switches to it.
- `isPublished` is a receipt id in a publish receipt's `publishedReceiptIds`, no ancestry. Publishes made before snapshots keep the list they recorded.
- A publish interrupted before snapshots (a merge commit) is recognised as landed by the reviewed commit being an ancestor of the target branch. An unfinished subagent integration from an older version is recorded as cancelled and reported, never replayed.

## Known limits

- Discard (`workspace.discardPendingChanges`), offered for a merge conflict, resets the worktree to HEAD, and uncommitted turn results are part of what it drops. The prompt says so. The files are first recorded as a snapshot of an action of the person (or a plain snapshot; when neither can be taken nothing is discarded), a copy of everything, staged files included, stays under `refs/mousse/discarded/`, and the result carries `backupRef` and a `notice` that says how to bring the files back (`git restore --source=<ref>`).
- Retirement does not keep what is staged (it refuses instead) or the real index; reconstruction starts with an index equal to HEAD.
- The trash expiry has the same small window as any snapshot-then-delete: a write between its snapshot and Git's removal is lost. It waits for an hour with no change first. Permanent deletion of a thread, which the person confirms, deletes the trashed folder right after the move.
- Large untracked files are in every snapshot, as they were in every checkpoint (out of scope in #464).

## Still to do

Phase 4: projects without Git and standalone threads get snapshots and Undo through a hidden store in Mousse's data. The phase 5 documentation of the model's terms follows it.

## Tests

- `tests/workspaceSnapshots.test.ts`: the snapshot model, an agent that switches branches, rewrites history, commits and pushes, creates a repository with no commit, rebase in progress, outside changes, three-way Undo/Redo/revert, recovery including locked legacy threads and a retake that fails again, snapshots that follow force-added ignored files, the branch the thread reports, forks and fork seeding, subagent results (a report with pinned base and result that survive the worktree, the parent's files, HEAD, index and branches untouched, no change, unfinished legacy integrations cancelled and not replayed), Publish (one commit with the person's identity and no snapshot in its history, a second publish, stale review, conflict, dirty primary, missing identity, ignored files never overwritten, recovery that only records or cancels, a refused fast-forward that does not lock), rebuilding a worktree from its snapshot, and GC.
- `tests/worktreeRetirement.test.ts`: retirement moves the folder into the trash with a write that landed after the checks, and a restore moves it back as it is; the trash expiry snapshots, deletes the folder and its branch, and a restore rebuilds both; what a snapshot cannot hold stays in the trash; an agent's own branch and worktree are untouched.
- `tests/storageCleanupService.test.ts`, `tests/resourcePurge.test.ts`: a worktree with uncommitted files moves to the trash and comes back with identical files; a later run deletes it only after an hour with no changes, and a restore still brings back a write made in the trash; permanent deletion asks first and takes the trashed folder with it.
- `tests/dirtyWorkspaceProtocol.test.ts`: push with uncommitted files, and Discard's record and notice.
- Updated for the new model: `tests/dirtyWorkspace*.test.ts`, `tests/reviewRange.test.ts`, `tests/reviewProtocol.test.ts`, `tests/promptUndoUi.test.ts`, `tests/net/bridge/routed/editorFolder.test.ts`, the Git panel tests.
- Process lane, updated for the new model: `tests/turnCheckpointUndo.test.ts`, `tests/gitFoundation{Undo,Recovery,OperationRecovery,Protocol,WorkspaceLifecycle,Integration,PublishGc}.test.ts`, `tests/gitDaemonMethods.test.ts`, `tests/undoRetention.test.ts`, `tests/receiptRefRelease.test.ts`, `tests/conversationForkRetirement.test.ts`, `tests/platformWorkflowWorkspace.test.ts`, `tests/resourceLifecycleAcceptanceInventory.test.ts`, `tests/resourceLifecycleNamedGate.test.ts`, `tests/chatService.test.ts` (a project agent's uncommitted edit stays uncommitted), `tests/resourceLifecycleQualificationStorage.test.ts` (trash moves checkouts with uncommitted files into Mousse's trash and they come back with the same bytes).
