# Changes tab

The side pane's Diff tab (`GitPanel`) and Review tab (`ReviewPanel`) become one **Changes** tab. It answers one question: what changed, and what's next?

This doc is the design and the contract between the PRs that build it:

- **A1, Git selection (daemon):** read the uncommitted diff as hunks, include or leave out hunks and lines, commit a selection in project folders and thread worktrees, undo the last local commit.
- **A2, Revert (daemon):** revert hunks or files with a kept copy and a version-checked restore.
- **B, Changes tab (renderer):** the new tab, stacked on A1 and A2.

## Design

### Header (one line)

`[Last turn · add login errors ▾]  3 files · 2 left     ↑2 · Mac   …`

- **Scope menu.** Shared `ui/Select` with grouped headings, no submenus; type-to-filter past about 8 entries. Order: Last turn · This thread · Uncommitted, then a `Turns` group (labelled with the user's prompt words, `turnChoices` in `review/reviewModel.ts`), then a `Commits` group (last 10, then More).
- **Frozen while reading.** Last turn is pinned to its turn id. When a newer turn ends, a quiet `Turn 13 finished · Show` pill appears; the view never switches itself.
- **Counts.** `3 files`; `2 left` appears once something is viewed. Clicking the count opens the file jump (`F`): type-to-filter, line totals per file, filters Unviewed · Commented · Included.
- **Sync chip.** Shown only when it has something to say: ahead/behind, a remote computer (always shown for a remote thread), offline, detached, conflict. Click opens the branch picker, which also holds Pull, Fetch and Abort. Replaces the sync bar.
- **"…" menu.** Choose what to commit (Space), Ignore whitespace, Split (≥700px wide), Undo last commit (local commits only), Restore reverted….
- **At 440px**, what goes first to last: line totals → `N left` → chip text (icon and number stay) → the scope label truncates to about 16 characters with a tooltip. The scope, a remote computer's name and "…" never disappear.

### Body: one accordion of file cards

- Collapsed cards are the file list, in path order, so rows never move. One card is open at a time; its header is sticky. Conflicts are pinned on top.
- Row: chevron · path · a status word only for new/deleted/renamed/conflict · `+n −m` · comment count · faint ✓ when viewed (not a button) · a dot when changed since viewed · "…" (Revert file, Open in Files).
- Unified hunks with 3 context lines; `⋯ 18 lines` expands. Only the open card renders a diff. Scroll and expanded context are remembered per file and scope.
- Hover or focus a hunk: Comment · Revert (Revert only where allowed). Comments work on both sides, including deleted lines, and reach the composer as today (`review-comment` references).
- **Viewed.** `n` or the sticky header's ✓ marks the open file viewed and opens the next. `p` and plain collapse never mark. A mark is keyed by thread + scope endpoints + path + content hash, so it clears when the file changes.
- **Running turn.** Shown live with a dot on the scope; Include and Revert are off until it ends.
- **No jumping.** Include and Revert update the screen on the next frame; Git confirms in the background; rows never move under the cursor.

### Footer: one line, one next step

1. Comments pending → `Send N comments`.
2. Changes to commit, and the shown scope **is** the uncommitted diff (including Last turn when it is identical): `[Commit to feat/login ✦] [Commit all 5 ▾]`. The placeholder names the branch and is tinted on the default branch.
3. Changes to commit, and the shown scope **differs** from the uncommitted diff (by content): `[Review 5 uncommitted →]`, which switches to Uncommitted.
4. Otherwise `Push 2` → `Create PR` → the PR chip `#123 ✓` (opens the Pull request tab) → nothing.

- ✦ is Suggest. Commit ▾ holds Commit and push · Commit, push and open PR · Amend (project folders only).
- Push is never implicit. Conflicts → `Resolve conflicts`. Offline → `Mac offline · Retry`.
- Ctrl/Cmd+Enter submits only from the focused message field or composer.

### Choosing what to commit

- By default everything is included and there are no checkboxes. The UI never says "stage".
- Space on a focused hunk, row checkbox or line selection, or "…" → Choose what to commit, shows Include checkboxes (tri-state on files). The footer reads `Commit 2 of 3`. The checkboxes stay visible while anything is excluded, or when the index was already partly staged outside Mousse. Esc leaves.
- **Project folders:** the checkboxes are the real Git index. Mousse never resets an index someone prepared elsewhere. A file with both staged and unstaged edits shows each hunk's state; the commit takes exactly the index.
- **Empty index vs empty selection.** An untouched empty index is not a choice: the footer says `Commit all 5`, and Mousse stages everything only when that is clicked. If the user excludes everything, the selection is really empty and stays empty after Esc and reopening; the footer reads `Include something to commit` (disabled), with Include all in its menu.
- **Thread worktrees:** the same UI. The daemon holds the selection and applies it at commit time on a temporary index (PR A).

### Revert

- Allowed only in Uncommitted, and in Last turn when it is identical to Uncommitted. Older turns and commits are read-only.
- Revert a hunk, file or selection (`X`): it runs at once; a toast says `Reverted · Undo`, and Ctrl/Cmd+Z undoes it. "…" → Restore reverted… lists reverts while their kept copies last (30 days by default).
- No Revert all: Undo in the chat covers rolling back a whole turn; multi-select plus `X` covers the rest.
- Ship gate: Revert ships only with restore. No confirm dialog.

### Default scope

A chat edit line opens that turn and file. A fresh open shows Last turn if it ended since the tab was last opened, otherwise Uncommitted, otherwise This thread. Reopening restores the user's last chosen scope.

### Empty states

`No uncommitted changes · Last turn: 3 files` (a link). `Not a Git repository · Initialize`. Clone moves to the new-project flow (#483), not here.

### Keys (outside text inputs)

Enter toggles the card · `O` opens in Files · `n` viewed and next · `p` previous · `j`/`k` hunk · Space include (focused hunk or checkbox only) · `X` revert · `C` comment · `F` file jump · Ctrl/Cmd+Z undo revert · Esc leaves selection. `?` lists them.

### Other surfaces

- The side card's Git section becomes a glance: branch · `N files` (opens Changes) · PR chip. Its commit popover, PR form and action buttons go.
- The Pull request tab stays for checks, reviews, conversation and merge. Its empty state already offers Create PR.
- The commit list becomes the scope menu's Commits group.

### Removed

Review tab and its R key · the 300px file sidebar · Staged/Changes/Untracked sections · the Commits section · the sync bar and Fetch/Pull buttons · status letters · the whitespace hint · Refresh · create/clone forms · the side card's commit popover, PR form and action buttons.

## Contract between the daemon PRs and the tab

Three PRs, stacked: **A1** (changes, include, selection commit, undo last commit), **A2** (revert, restore, list), **B** (the tab). Revert ships only inside A2, with restore.

### Common rules

- New methods go through every declaration site: `mms/protocol/types.ts`, `mms/protocol/gitAccess.ts` (`GIT_ACCESS`), `mms/protocol/client.ts`, `shared/bridge/routed.ts` (one row each), `shared/bridge/deviceActivity.ts`, `main/registerGuiIpc.ts`, `preload/index.ts`. The existing `git.commit` routed row changes keys, so its version is bumped.
- Params use `{ threadId?, projectId?, … }` like the other `git.*` methods (not "scope", which is a UI word here).
- Paths are repository-relative with `/`. `path` and `oldPath` go through `gitPaths`, including Bridge's `realpathNative` + `containedPath` check.
- Access: `git.changes`, `git.revertedList` are `owned` (like `git.status`); `git.include`, `git.revert`, `git.restoreReverted`, `git.undoLastCommit` are `userRequested`.
- All Git runs follow #312 (`repoPrograms.ts`); reads use `--no-ext-diff --no-textconv`; untracked paths are read with `-z` and literal pathspecs.
- Every write runs inside `serialized(cwd)`, checks `version` there, and refuses with `thread_busy` while a turn is active on the thread, or, for a project folder, on any thread working in that folder.
- Hunks are always computed without `-w`. While the tab ignores whitespace, Include and Revert are off.

### Reading: `git.changes`

`git.changes({ threadId?, projectId?, paths? })`:

```ts
type ChangeHunk = {
  id: string            // hash of oldStart + the hunk's lines (context, removed, added); unique within the file
  oldStart: number; oldLines: number; newStart: number; newLines: number
  lines: Array<{ kind: ' ' | '-' | '+'; text: string; oldNo?: number; newNo?: number }>
  included: 'yes' | 'no' | 'partial'
}
type ChangedFile = {
  path: string; oldPath?: string           // a rename is one entry covering both paths
  change: 'modified' | 'added' | 'deleted' | 'renamed' | 'conflict'
  kind: 'file' | 'symlink' | 'submodule'
  binary: boolean
  mode?: { old: string; new: string }      // mode-only changes have no hunks
  wholeFileOnly: boolean                   // binary, symlink, submodule, mode, rename, too large, conflict,
                                           // index diverged, or bytes that don't round-trip (see below)
  indexDiverged: boolean                   // the selection holds content that is neither HEAD nor HEAD plus
                                           // some of these hunks (project index), or was chosen against an
                                           // older HEAD or working tree (thread overlay)
  tooLarge: boolean
  version: string                          // HEAD oid, oldPath, path, modes, every index stage,
                                           // working-tree digest, and the selection token
  hunks: ChangeHunk[]
  included: 'yes' | 'no' | 'partial'
}
type ChangesResult = {
  files: ChangedFile[]
  selection: { state: 'untouched' | 'chosen'; token: string }
  truncated: boolean                       // file count over the limit; per-file size uses tooLarge
}
```

- The list is HEAD → working tree, plus untracked files (as `added`), plus files whose selection differs from HEAD even when the working tree equals HEAD.
- `included` is derived from HEAD → selection and selection → working tree, mapped onto the HEAD → working tree hunks. The selection is the index (project folders) or the commit index the thread overlay would build (threads).
- **Round-trip rule.** Hunks are in Git's clean form. A file is `wholeFileOnly` when its bytes might not survive a round trip: any filter or clean driver (LFS included), `ident`, `working-tree-encoding`, or an untrusted repository where drivers are off. Line-ending conversion is allowed only through Git's built-in conversion, never by writing clean text over the file.
- Results over Bridge are ephemeral reads and page above 63 KiB.

### Selection state

- **First choice.** From `untouched`, the first include or exclude starts from everything included (the state `Commit all N` showed), then applies the choice. In a project folder that first step stages everything (`add -A`, excluding `.mousse/**`) before applying the exclusion. This only happens when the index equals HEAD, so it never overwrites staging done elsewhere.
- **Project folders:** the selection is the real index. Mousse never rebuilds an entry from HEAD when the index is diverged; such files allow only whole-file include and exclude (exclude keeps the staged blob as a kept copy first).
  - `state` is `untouched` only when the index equals HEAD and there is no marker. Any other index (for example `git add -p` in a terminal) is already `chosen`.
  - The marker exists only to remember "everything excluded": choosing in Mousse records it, keyed by **(HEAD oid, index tree id)**, in the daemon's per-project state (the project's kept-files owner folder), never in `.git`. While both still match, an index equal to HEAD reads as `chosen`.
  - The marker is cleared by any successful commit, amend, `git.undoLastCommit`, chat Undo or Redo, and any index or HEAD change Mousse did not make. Mousse's own index writes (`git.include`, `git.revert`, `git.restoreReverted`, `git.discard`, and `git.stage`/`git.unstage` from older clients) re-record it only if it still matched just before the write, so neither `Commit 1 of 3` silently becomes `Commit all 3` nor a terminal `git add -A` gets adopted as the person's choice.
  - `write-tree` (which adds tree objects to the repository's object store, harmlessly) failing, for example with unmerged entries, means `untouched`.
  - `token` = hash of (HEAD oid, index tree id, marker).
- **Thread worktrees:** the selection is an **overlay**, not a whole index: only the paths the person changed, each with its chosen entry (blob and mode, or "left out") plus the HEAD entry and working-tree digest it was chosen against. It is stored in the thread's folder, survives restarts and is shared by every client. No overlay = `untouched`.
  - Paths not in the overlay are included as they are in the working tree.
  - An entry stays valid while its HEAD entry is unchanged and its chosen content is still HEAD plus a subset of the current HEAD → working tree hunks (a content test, so a later agent edit elsewhere in the file keeps it valid; `included` is re-derived).
  - An entry that fails that test (an agent or terminal commit, Undo, Redo or pull touching the file, or an edit that undid a chosen hunk) is never applied as stored. The path is `indexDiverged` (whole-file only, listed even when the working tree equals HEAD). An excluded entry takes the current HEAD's version; a chosen-content entry makes a chosen commit fail with `stale` until the person chooses the file again.
  - The commit index is built fresh at commit time: `read-tree <current HEAD>`, then the working tree for changed paths outside the overlay (excluding `.mousse/**`, as commit-all does), then the valid overlay entries. A commit therefore never reverses a newer commit.
  - `token` = hash of (HEAD oid, overlay revision). It changes when HEAD moves or the overlay is written.
- A `git.selectionChanged { threadId? | projectId? }` event tells other views to re-read. It is declared with the other daemon events and forwarded over Bridge like `actions.updated`, which only carries thread events: a project folder's selection change reaches another computer only when it re-reads.

### Include and exclude: `git.include`

`git.include({ threadId?, projectId?, path, version, include, hunks?, lines? })` → `{ path, version, included, selection: { state, token } }`, and `git.include({ threadId?, projectId?, all: true, include })` → `{ selection: { state, token } }`. Results stay small for the Bridge ledger; the tab re-reads with `git.changes({ paths })`.

- No `hunks` and no `lines` = the whole file. `lines: { hunk, indexes }[]` index into `hunk.lines`: leaving out a `-` line keeps that line; leaving out a `+` line drops it.
- A rename includes or excludes both paths together.
- Hunks or lines on a `wholeFileOnly` file → `whole_file_only`. A conflict path → `git_merge_unresolved`. A `version` mismatch → `stale`; the tab re-reads and retries nothing by itself.

### Commit: `git.commit`

New field `selection?: { mode: 'all' } | { mode: 'chosen'; token: string }`.

- `all`: `add -A` (the existing `options.all` path, which excludes `.mousse/**`), in threads and project folders alike.
- `chosen`: the token must match the current selection, else `stale`. This applies to project folders too, so a `git add -A` in a terminal while the tab is open can't sneak excluded files into the commit.
- `chosen`, project folders: commit exactly the index, never `add -A`; an index equal to HEAD → `nothing_selected`.
- `chosen`, threads: commits through the fresh commit index described above, as one recorded thread action, without touching the private snapshots (#466). On success the real index is reset to the new HEAD (mixed; working tree untouched) and the overlay is removed. If HEAD did not move (hook refused, cancel, timeout), the overlay and the real index stay as they were. A crash between the commit and removing the overlay is harmless: the overlay's paths become diverged against the new HEAD.
- Hooks run with the temporary index (as `git commit -- <paths>` already does). A hook that reformats and re-adds files is supported and tested.
- **No field** (older clients): unchanged behavior. A new client sending `selection` to an older computer over Bridge is refused (`computerOutdated`), never downgraded. Both the `git.commit` and `git.suggestCommitMessage` routed rows get `since: { selection: 2 }`.
- `git.suggestCommitMessage` with `selection: chosen` (same token check) describes only the selection.

### Undo last commit: `git.undoLastCommit`

`git.undoLastCommit({ projectId, expectedHead })`: soft reset of one local, unpushed commit (the same checks as `assertAmendable`); working tree and index keep the changes, and the selection marker is cleared.

- Project folders only; threads use Undo in the chat (`git_undo_in_thread`).
- Refused: pushed (`git_amend_pushed`), no commit (`git_amend_no_commit`), a root commit (`git_undo_root`), a merge commit (`git_undo_merge`), a merge or rebase in progress (`git_merge_unresolved`), `expectedHead` mismatch (`stale`).
- A last commit made by a thread working in the project folder can be undone like any other, without a recorded action (amend's precedent).

### Revert and restore (A2)

- `git.revert({ threadId?, projectId?, path, version, hunks?, lines? })` → `{ revertId, keptUntil, path, version }`. Makes the chosen hunks (or the whole file, or both paths of a rename) match HEAD in the working tree and the selection.
  - Before writing, the path's working-tree bytes and index entries (new and deleted files included) are kept as a kept copy under a new `KEEP_COPY_OPERATIONS` type, so the sweep and thread purge cover it.
  - Just before writing, the kept digests are compared with the file again, as `provenDiscard` does; a changed path is left as it is and the call returns `stale`.
  - The owner is chosen like `git.discard`: `recordedThreadTarget` (a thread's worktree, or a thread working in its project's folder) → the thread's folder, and the revert is a recorded thread action; otherwise `projectKeptFilesOwnerFor`.
  - Retention is the owner's window (`keptCopyWindowMs(owner)`), not a fixed 30 days.
  - Whole-file working-tree writes follow `git.discard`'s path and driver rules (LFS and filter files included). Where those rules can't write the file safely, the call is refused with `whole_file_only` and the tab offers Discard instead.
  - In a thread, a whole-file revert takes the path out of the overlay. A hunk revert keeps the overlay entry for the other hunks, so hunks the person left out stay left out.
- The record `revertId → { kept ref, paths, post-revert digests and index entries, at }` is written to the owner's journal, so the list and restore work after a restart.
- `git.restoreReverted({ threadId?, projectId?, revertId })` → `{ restored: true } | { restored: false; reason: 'changed' | 'expired'; currentBlob?: string; keptBlob?: string }`.
  - Restores only if the paths still match what the revert left: the working tree, and in project folders also the index. (A thread's selection is not compared, so choosing another hunk of the same file doesn't block Undo.) Otherwise it returns blob ids for a comparison and writes nothing.
  - Restored hunks come back as they were in project folders (the staged entry is restored). In threads the overlay entries from before the revert come back too, if nobody changed them since, so restored hunks keep their earlier choice.
  - Chat Undo of a recorded revert puts the files back but not the thread's earlier include/leave-out choices; pressing Restore afterwards brings them back (an undo-system change is left for later).
  - Idempotent: if the paths already equal the kept content (a retry, or chat Undo already put it back), returns `restored: true`.
  - `expired` when the kept ref is gone, whatever `keptUntil` said.
  - Uses the same re-checked write as revert (`writeBackKeptFiles` only creates missing files) and puts staged entries back from the kept ref; in the thread cases a restore that writes is a recorded thread action.
- `git.revertedList({ threadId?, projectId? })` → `Array<{ revertId, path, oldPath?, at, keptUntil, summary }>`.

### Errors

| Error | Methods |
| --- | --- |
| `stale` | include, commit (chosen, threads and project folders), suggestCommitMessage (chosen), revert, undoLastCommit |
| `thread_busy` | include, commit (chosen), revert, restore, undoLastCommit |
| `whole_file_only` | include, revert |
| `git_merge_unresolved` | include, revert, undoLastCommit |
| `nothing_selected` | commit (chosen) |
| `git_undo_in_thread`, `git_amend_pushed`, `git_amend_no_commit`, `git_undo_root`, `git_undo_merge` | undoLastCommit |
| `computerOutdated` | commit and suggestCommitMessage with `selection`, over Bridge to an older computer |
| `remote_offline` | all, from Bridge |

`thread_busy` in a project folder also covers chat history work on any thread in that folder (`isConversationHistoryBusy`), as the operations handlers do.

## Delivery

- **A1:** `git.changes`, `git.include`, the project marker and thread overlay, `git.commit` and `git.suggestCommitMessage` selection fields (both routed rows bumped), `git.undoLastCommit`, `git.selectionChanged`.
- **A2:** `git.revert`, `git.restoreReverted`, `git.revertedList`, the new kept-copy operation.
- Tests for A1 and A2: project folder and thread worktree; restart with a held selection; choose a hunk, an agent commits another file, then a chosen commit does not reverse it; choose a hunk, an agent commits the same file, then a chosen commit returns `stale`; a terminal `git add -p` reads as `chosen` and the first include does not run `add -A`; a chosen commit after a terminal `git add -A` returns `stale`; after a chosen commit in a project folder the rest reads `Commit all`; a revert while the marker is set keeps it `chosen`; an older client committing without the field; an index-diverged project file; untracked files; renames; submodule and mode-only changes; duplicate hunks; autocrlf on Windows with a CRLF file and `.gitattributes eol=crlf`; an LFS/filter file falling back to whole-file; a hook refusing a selection commit (selection and real index unchanged); a hook reformatting during a selection commit; Bridge containment through a junction for revert; `thread_busy`; restore after later edits (`changed`), after chat Undo (idempotent) and after expiry; `suggestCommitMessage` with a selection; the `gitAccessTable` and routed-version tests.
- Each daemon PR is reviewed by the council before and after coding.
- **B:** the tab, the store migration (`review` surfaces and saved `mainView: 'review'` become `git`; `surface.review` shortcut overrides are dropped), the side card glance, removal of `GitPanel`/`ReviewPanel` and the tests that only covered them, before/after screenshots.

Refs #605. Tracked in #721.
