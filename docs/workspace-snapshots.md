# Workspace snapshots

Status: phases 1 to 4 of [#464](https://github.com/mousse-agent/mousse/issues/464) are implemented: turn snapshots, outside changes, Undo, Redo, revert and conversation forks (1 and 2), then subagent and workflow results, Publish, the Git panel's push, and worktree retirement, cleanup, GC and inventory (3), then projects without Git and threads with no project, through a hidden store (4). The model's terms in the glossary and the architecture doc (5) follow.

## Why

Mousse used to record a turn by committing on the thread's own branch (`mousse/thread/<id>/main`) through the real index. The agent and the person do their real Git work on that same branch, so the two collided: an agent that switched branches, rebased or reset locked its thread ("Workspace branch changed during execution"), Mousse's `mousse: checkpoint …` and `mousse: undo …` commits ended up in pull requests, and the checkpoint's `git add -A` wiped the agent's staging.

Now a turn is recorded as a private snapshot of the files, stored with Git but kept apart from the branch, HEAD and index. The agent can create branches, commit, rebase and push like in any checkout.

## The model

A **snapshot** is a commit whose tree holds every file of a worktree: tracked and untracked, not ignored, not `.mousse/`. Its parent is the worktree's HEAD when it was taken (none in a folder with no Git Mousse may use: see "Folders without Git"). Nothing points at it except refs under `refs/mousse/`, so it belongs to no branch and a push never carries it.

`takeSnapshot` (`src/mms/actions/snapshots.ts`):

1. Uses a private, persistent index at `git rev-parse --git-path mousse/snapshot-index`. Git keeps names it doesn't know in each linked worktree's own Git directory, so every worktree has its own. The index is persistent so Git's stat cache keeps the next snapshot fast. It is seeded from `HEAD` (or empty) when missing, and rebuilt, lock file included, when it is corrupt. Every snapshot also brings it in line with the files Git tracks, for the ones `add -A` cannot see: an ignored file that HEAD or the real index tracks (it was force-added) is added whenever it is on disk, and an ignored file neither tracks any more is dropped. The real index is only read.
2. Runs `GIT_INDEX_FILE=<it> git add -A -- . ':(exclude).mousse'`, `write-tree`, then `commit-tree <tree> [-p HEAD]` as `Mousse <mousse@local>` with the message `mousse snapshot: <reason>` and the trailers `Mousse-Thread`, `Mousse-Operation`, `Mousse-Head` and `Mousse-Branch`. Every command goes through the hardened `git()` helper, standard input and environment included: no repository hook, filter driver or program runs. A nested repository is recorded as a link to its HEAD, as Git does. One with no commit yet (an agent ran `git init` or a project generator inside the worktree) cannot be added, so when `add` fails the snapshot looks for such repositories and leaves them out; the turn is recorded and nothing locks.
3. Never changes HEAD, a branch, the real index or a file. It works during a merge, rebase, revert or cherry-pick and records that (`operationInProgress`) instead of refusing.
4. Reports what it leaves out (`coverageGaps`, carried into the action's and receipt's `git` record): a nested repository with no commit, a nested repository whose own files differ from its commit (only the commit is recorded), and a file or folder it cannot read. Git stops at the first file it cannot read, so each one is left out and the add runs again. The receipt says it in words (`notCovered`: "Not covered: vendor/sub (nested repository with no commits), x.bin (unreadable)."), and so does the result of an Undo, Redo or revert. Ignored files are left out by design and never listed.
   A snapshot that cannot be taken at all never locks the thread. When the start of a turn cannot be captured, no older snapshot stands in for it: the turn is recorded from its end, so no file is attributed to it and Undo rewinds the conversation without restoring files, and the gap says "start of turn not captured". When its end cannot be captured, the end is recorded where the turn started, with the error as a coverage gap of the whole worktree and the action not undoable; the next record of outside changes holds that turn's changes and says so in its `notice`.
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
- `workspace.json` `branch` stays "the thread branch Mousse created". It is named once, when the worktree is made at the thread's first editing turn: `mousse/<slug>` from the thread's first message (lowercase ASCII, at most 40 characters, `-2`, `-3` … when the name is taken), or `mousse/thread-<id>` when the message has no usable word. It is never renamed. Threads made before that keep their `mousse/thread/<threadId>/<branchId>` branches, which are still Mousse's. Every branch under `mousse/` is Mousse's; one the agent makes elsewhere is never touched. The agent may be on another branch; nothing follows it. What the thread reports (`ThreadWorkspaceManager.executionContext().branch`) is the branch HEAD is on now, none when detached.
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
| The same, in a folder without Git | `snapshot-workspace.json` `snapshotSha`, and the pin `refs/mousse/threads/<threadId>/main` in the hidden store |

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
4. Otherwise only the files the merge changes are rewritten with `read-tree -m -u <ours> <result>` in a temporary private index (a copy of the persistent one, so Git sees the files still match), and the result is recorded as a new snapshot. A file on disk at a path the restore writes or deletes that `ours` does not hold (an ignored or excluded file, or what fills a folder that becomes a file) is no snapshot's: it is stored first under `refs/mousse/preserved/<operation>-<sha>`, and the result's `notice` names the ref and the files. Every `moveFiles` caller (restore, reconstruction, fork seeding) gets the same protection. A folder in the way that is too large or deep to keep file by file (over 10,000 files or 64 levels), or that holds another repository, refuses the restore before anything is written, naming the folder; a restore never goes ahead with part of it unkept.

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

Recovery (`PublishService.recoverPending`) only records or cancels; it never publishes again and never touches the primary's files, index or branches. It reads the target branch's tip: when the recorded commit is the tip or an ancestor of it (the person may have committed on top), the publish is recorded as completed; otherwise it is cancelled with the reason. When the primary checkout cannot be read (a disk that is not mounted) nothing is decided and the next recovery tries again; when it reads and the target branch no longer exists, the publish is cancelled ("target branch <x> no longer exists"). A publish waiting to be settled concerns the primary checkout only, so it never holds up the thread's turns; a new Publish settles it first. A merge a publish from an older version left in progress is reported ("still in progress in <path>") and can still be aborted with `operations.abort`. It settles `prepared`, `git_applied` and `recovery_required` entries alike. A publish interrupted before snapshots was a merge commit and is recognised as landed when the reviewed commit is its ancestor. Calling `publish` again with the operation id of an unfinished attempt settles that attempt the same way first; only when it did not land does the explicit Publish go on.

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

## Folders without Git

A project that is not a Git repository, a repository with no commit yet, and a thread with no project (it runs in a private scratch folder its runtime keeps for it) get the same snapshots, Undo, Redo, revert and per-turn review as a Git thread. There is no worktree and no branch: the folder is the person's, so the snapshots live in a **hidden store** of Mousse's own and the folder never gains a `.git`.

### The store

A repository Mousse creates (`git init --bare --template=`, then `core.bare=false`, `gc.auto=0`) and uses only as `git --git-dir=<store> --work-tree=<folder>`.

| Folder | Store | Shared by |
| --- | --- | --- |
| A project that is not a Git repository, or has no commit yet | `<MOUSSE_HOME>/project-data/<projectId>/snapshots.git` | the project's threads |
| A thread with no project (its runtime's scratch folder) | `<MOUSSE_HOME>/thread-snapshots/<threadId>/snapshots.git` | the thread |

A repository with no commit is treated like a folder with no repository: its own `.git` is excluded and never read or written by a snapshot. A project that is a bare repository is not a candidate. The store has no HEAD and no branch, so a snapshot there has no parent, and its `git` record has no `headBefore`, `headAfter` or branch.

The store's own index (`<store>/index`) is the persistent snapshot index, so `git diff <snapshot>` against the folder, which the review reads, sees the files as of the last snapshot. `info/exclude` is rewritten with each turn: `.git/`, `.mousse/`, `node_modules/`, `.venv/`, `venv/`, `__pycache__/`, `.DS_Store`, and, at the top of the folder only, `/dist/`, `/build/`, `/target/`, `/.next/`, `/.cache/` (a source folder called `build` deeper down stays). The folder's own `.gitignore` files apply as in any repository, but they cannot take the built-in list back in: after every `git add`, whatever is under it leaves the store's index (`git rm --cached` with the list as glob pathspecs, `builtInPathspecs`), and the size limits count without it.

A store records exact bytes. Every store command runs isolated from the person's Git setup (`isolatedEnv`): no system or global config (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` pointing at an empty file), no system attributes (`GIT_ATTR_NOSYSTEM`), no config from the environment, and fixed settings (`core.autocrlf=false`, `core.safecrlf=false`, empty `core.attributesFile` and `core.excludesFile`, an empty `core.hooksPath`, `core.fsmonitor=false`, `core.symlinks` at the platform default). The store's `info/attributes`, which outranks every `.gitattributes`, sets `* -text -filter -ident !eol !working-tree-encoding !diff !merge`. So no filter, end-of-line conversion or re-encoding runs on the way in or out, whatever the person's global config or the folder's attributes say.

### How Git reaches the store

A store belongs to the threads that recorded turns in it, never to the folder. `src/mms/git/hiddenStore.ts` keeps a scope (`AsyncLocalStorage`); Mousse's own Git helpers (`actions/git.ts`) and the review's `guardedSimpleGit` add `--git-dir`/`--work-tree` (or `GIT_DIR`/`GIT_WORK_TREE`) only for a command run inside the scope of a store, on a path inside its folder. The scope is opened for a thread, from its own `snapshot-workspace.json` (`threadSnapshotStore`, `inThreadSnapshotScope` in `SnapshotWorkspace.ts`): `withGitMutationLocks` opens it for every snapshot, restore, receipt and recovery, and the read paths (the review's turn and thread scopes, `commitExists` for them, the restore review's `restoreDiff`) open it for the thread they read. Nothing else is redirected, so the Git panel and everything else see the folder as it is.

That is what lets a folder become a repository later. When someone runs `git init` in a project folder, a thread that started in the store keeps it (`WorkspaceResolver` gives it no worktree, with `unavailableReason: 'snapshot-store'`), and its Undo, Redo and review keep working from the store. A new thread uses the repository like any other, and none of Mousse's commands for it, or for the Git panel, go through the store. The store's `info/exclude` leaves the new `.git/` out.

A hidden store has no index of the person's, merge or rebase: `inspectPendingChanges`, `operationInProgress` and `requireClean` report nothing waiting.

### What is saved, and what is not covered

What a snapshot leaves out is reported in the same shape as for a Git thread: `coverageGaps` on the snapshot and in the turn's `git` record, and a `notCovered` line ("Not covered: data/big.bin (over 50 MB), node_modules (dependency or build folder, never kept in snapshots).") on its receipt, on the action and on the result of an Undo, Redo or revert that involves it. Missing coverage never stops a turn and never locks the thread. Before a snapshot is taken in a hidden store, `git ls-files --cached --others --exclude-standard` lists what `git add -A` is about to add, and:

- a file over 50 MB is left out, dropped from the store's index (so no older copy of it can be restored over it) and reported;
- a folder the built-in list excludes that is there (`node_modules/`, `.venv/`, `/dist/` and the rest; not `.git/`, `.mousse/`, `__pycache__/` or `.DS_Store`) is reported; what the folder's own `.gitignore` files leave out is not, as for a Git thread;
- an unreadable file or folder, and a nested repository with no commit, are left out and reported, and a nested repository with uncommitted changes is named (only its commit is recorded), as for a Git thread. Git in a nested repository always runs as that repository's own (`outsideHiddenStore`), never through the store.

A whole folder cannot be snapshotted when it is a home or system folder (the filesystem root, the home folder, or a folder that holds it: `isUnsafeSnapshotRoot`), or past 50,000 files or 1 GB in total (`configureSnapshotLimits` changes the limits for a test; a listing that does not fit in memory or does not end in a minute counts as too many files). That is a `SnapshotRefusedError` with a message the person can read ("Undo is off for this folder because it is too large (more than 50,000 files).") and it never fails a turn:

- At turn start, the turn runs without snapshots. Its conversation is recorded alone (a conversation action) with the message as its `notice` and the whole folder as not covered (`notCovered: "Not covered: . (too large (more than 50,000 files))."`), so Undo of that turn takes back the conversation and says why the files stay. The reason is kept in `snapshot-workspace.json` (`off`) and cleared by the next turn that can take a snapshot.
- If no snapshot can be taken at the end of a turn (the folder grew past a limit, or anything else failed), the turn is recorded as Git threads record it: it ends where it started, cannot be undone, and its receipt and action name the whole folder (`.`) as not covered.
- Any other failure at turn start, with no earlier snapshot to start from, is handled like a refusal, with `Undo is off for this folder: <what Git said>`.

### Admission and turns

`OrchestratorService` decides per turn (`snapshotFolderFor`): a turn that changes files (`agent`, `build`, a skill; not a read-only turn, a bot's, or a subagent's shared view) in a thread with no worktree of its own and a folder as above is recorded in the folder's store. The project's folder is the project's path; for a thread with no project it is the folder the selected runtime keeps for the thread (`ProviderAdapter.standaloneWorkspace`, implemented by Claude Code and Codex). A runtime that keeps no such folder records the conversation only, as before.

The turn then runs exactly as a Git thread's: `recordOutsideChanges` takes the first snapshot (changes made outside Mousse become an action of the person), `beginTurn`, and `checkpointExistingTurn` at the end; interrupted checkpoints and Undo operations recover at the next turn start. `capability.checkpointable` stays false for these threads, so everything that needs an owned Git workspace (isolated subagents, workflow integration, Publish) refuses as it did before.

When the folder a thread's runtime uses changes (another provider's scratch folder), the thread keeps its history and the first turn in the new folder records the difference as outside changes.

### Threads that share a folder

The store is the lock: `withGitMutationLocks` takes the store's lease, not the thread's repository, so threads of one project take turns on snapshots and restores. Their edits meanwhile are simply files in one folder: a thread's start snapshot includes what the others did before it, and what they do during its turn is part of its turn.

Undo is the same three-way restore, so one thread's Undo keeps the files another thread wrote, and an overlap refuses with the file names and changes nothing. While another thread's turn is running in the folder, the restore gate refuses with `workspace_shared`, as for any two threads in one workspace (`liveWorkspaceClaims`); idle threads sharing the folder do not count as sharing it, because the merge protects their edits.

### Undo, Redo, revert and review

The services take the folder as their `workspacePath` and need no other change. The code that reads a thread's `workspace.json` for them (the protocol handlers, the review, the retention sweep, recovery) reads `ThreadWorkspaceManager.loadOrSnapshot()` instead: `workspace.json` when the thread has a worktree, else the snapshot workspace as the same shape with `snapshotOnly: true`, `lifecycle: 'ready'`, `conversationBranchId: 'main'` and the thread pin as `retainedRef`. `snapshot-workspace.json` is a different file on purpose: `workspace.json` means "Mousse made this worktree and may retire, rebuild and delete it", and every worktree rule (retirement, cleanup, rebuilding, Publish, inventory) reads only that file, so none of them can reach a folder that is the person's.

`actions.list` offers Undo and Redo as for a Git thread, so `PromptUndoControls` needs no special case. The review's turn scope is the pair of snapshots read from the store; its thread scope starts at the first recorded action. The Git panel's working-tree scope says "Not a Git repository" until the folder is one, and then shows the repository.

Refused or absent, as before: Publish (`workspace_not_ready`), push, forks and branch activation, isolated subagents and workflow worktrees, retirement, cleanup and rebuilding.

### Lifecycle

- Receipts' refs expire with the Undo window as for a worktree. `releaseSnapshotRefs` (the hourly sweeper, and `actions.sweepRetention`) deletes an expired receipt's pair while it still points where the receipt says, then runs `git gc --prune=now` on the store. That is the one place Mousse collects garbage, and only in a store it owns, never in a person's repository; the thread's latest-snapshot pin and the other threads' refs keep what they hold.
- Deleting a thread for good releases what it pinned (`releaseThreadSnapshots`, run when the purge starts, while the receipts that name the refs still exist): a thread with no project loses its whole store; a thread of a project loses its pin, receipt pairs and conversation-branch pins in the project store, and the store is collected. Removing a project removes `project-data/<projectId>`.
- The thread's own folder holds only `snapshot-workspace.json`, so the permanent-delete preview, which hashes and bounds everything in a thread's folder, never reads a store.

### Deviations from the first design

- A thread with no project keeps its store beside the project stores, not inside its thread data: a permanent delete reads and bounds the whole thread folder, and a store can hold a gigabyte.
- `resolveRepositoryIdentity` no longer writes `mousse/repository-location.json` into a folder that is not a repository. It did so for every non-Git project, and the file would have been recorded by the first snapshot as a change of the person's.
- `.mousse/` is left out through the store's exclude list and, if a `.gitignore` takes it back in, by dropping it from the index; Git refuses `add` with an exclusion pathspec that names an ignored path.

### Known limits

- Nested repositories with commits are recorded as links, not read.
- A store only shrinks when a receipt expires or a thread or project goes. A deleted thread whose purge never ran leaves its store until the profile's data is cleaned by hand.
- The three-way restore protects another thread's edits, not its running turn's: Undo waits for it (the gate refuses), but the two turns' edits to one file are not separated.
- A snapshot in a hidden store is taken with the person's own (global and system) Git configuration, such as `core.autocrlf` and an installed filter; the folder's own repository configuration, if it has one, is not read for its settings, only checked for programs that must not run.

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

The phase 5 documentation of the model's terms (the architecture doc's body and the glossary) follows.

## Tests

- `tests/workspaceSnapshots.test.ts`: the snapshot model, an agent that switches branches, rewrites history, commits and pushes, creates a repository with no commit, rebase in progress, outside changes, three-way Undo/Redo/revert, recovery including locked legacy threads and a retake that fails again, snapshots that follow force-added ignored files, the branch the thread reports, forks and fork seeding, subagent results (a report with pinned base and result that survive the worktree, the parent's files, HEAD, index and branches untouched, no change, unfinished legacy integrations cancelled and not replayed), Publish (one commit with the person's identity and no snapshot in its history, a second publish, stale review, conflict, dirty primary, missing identity, ignored files never overwritten, recovery that only records or cancels, a refused fast-forward that does not lock), rebuilding a worktree from its snapshot, and GC.
- `tests/worktreeRetirement.test.ts`: retirement moves the folder into the trash with a write that landed after the checks, and a restore moves it back as it is; the trash expiry snapshots, deletes the folder and its branch, and a restore rebuilds both; what a snapshot cannot hold stays in the trash; an agent's own branch and worktree are untouched.
- `tests/storageCleanupService.test.ts`, `tests/resourcePurge.test.ts`: a worktree with uncommitted files moves to the trash and comes back with identical files; a later run deletes it only after an hour with no changes, and a restore still brings back a write made in the trash; permanent deletion asks first and takes the trashed folder with it.
- `tests/snapshotWorkspace.test.ts`, `tests/snapshotWorkspaceProtocol.test.ts` (folders without Git): a turn is a snapshot and Undo restores it with no `.git` in the folder, `.gitignore` and the built-in list are honored, a repository with no commit keeps its `.git`; what a snapshot leaves out (files over the size limit, excluded folders, unreadable files, whole folders past a limit) is reported as coverage gaps; a thread keeps its store after `git init` while a new thread uses the repository; review from the store; threads that share a folder (Undo keeps the other's edits, overlap refuses, the store is the lock); a thread with no project; release and garbage collection; thread and project deletion; and the whole of it through the daemon with a scripted runtime.
- `tests/dirtyWorkspaceProtocol.test.ts`: push with uncommitted files, and Discard's record and notice.
- Updated for the new model: `tests/dirtyWorkspace*.test.ts`, `tests/reviewRange.test.ts`, `tests/reviewProtocol.test.ts`, `tests/promptUndoUi.test.ts`, `tests/net/bridge/routed/editorFolder.test.ts`, the Git panel tests.
- Process lane, updated for the new model: `tests/turnCheckpointUndo.test.ts`, `tests/gitFoundation{Undo,Recovery,OperationRecovery,Protocol,WorkspaceLifecycle,Integration,PublishGc}.test.ts`, `tests/gitDaemonMethods.test.ts`, `tests/undoRetention.test.ts`, `tests/receiptRefRelease.test.ts`, `tests/conversationForkRetirement.test.ts`, `tests/platformWorkflowWorkspace.test.ts`, `tests/resourceLifecycleAcceptanceInventory.test.ts`, `tests/resourceLifecycleNamedGate.test.ts`, `tests/chatService.test.ts` (a project agent's uncommitted edit stays uncommitted), `tests/resourceLifecycleQualificationStorage.test.ts` (trash moves checkouts with uncommitted files into Mousse's trash and they come back with the same bytes).
