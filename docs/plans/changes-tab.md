# Changes tab

The side pane's Diff tab (`GitPanel`) and Review tab (`ReviewPanel`) become one **Changes** tab. It answers one question: what changed, and what's next?

This doc is the design and the contract between the two PRs that build it:

- **PR A, Git selection and revert (daemon):** include/exclude hunks and lines, commit a selection in a thread's worktree, revert hunks or files with a version-checked restore.
- **PR B, Changes tab (renderer):** the new tab, stacked on PR A.

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

## Contract between PR A and PR B

All new methods go through the usual declaration sites: `mms/protocol/types.ts`, `mms/protocol/gitAccess.ts` (`GIT_ACCESS`), `mms/protocol/client.ts`, `shared/bridge/routed.ts` (one row each, version bump), `shared/bridge/deviceActivity.ts`, `main/registerGuiIpc.ts`, `preload/index.ts`. All Git runs follow #312's rules (`repoPrograms.ts`); reads use `--no-ext-diff --no-textconv`. Writes are `userRequested`.

### Hunks of the uncommitted diff

`git.changes(scope, { paths? })` → for each changed path, the diff **HEAD → working tree**:

```ts
type ChangeHunk = {
  id: string            // content hash of the hunk's removed and added lines plus its context
  oldStart: number; oldLines: number; newStart: number; newLines: number
  lines: Array<{ kind: ' ' | '-' | '+'; text: string; oldNo?: number; newNo?: number }>
  included: 'yes' | 'no' | 'partial'   // project folders: from the index; threads: from the held selection
}
type ChangedFile = {
  path: string; oldPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'conflict' | 'binary'
  version: string        // hash of HEAD blob + index entry + working-tree bytes for this path
  hunks: ChangeHunk[]
  included: 'yes' | 'no' | 'partial'
}
type ChangesResult = {
  files: ChangedFile[]
  selection: 'untouched' | 'chosen'   // 'untouched' = nothing chosen yet (empty index in a project folder, no held selection in a thread)
  truncated: boolean
}
```

### Include and exclude

`git.include(scope, { path, version, hunks?: string[], lines?: { hunk: string; indexes: number[] }[], include: boolean })` → `ChangedFile` (fresh).

- No `hunks` and no `lines` means the whole file.
- Project folders: writes the index entry for `path` so the chosen hunks/lines match the working tree and the rest match HEAD. It never touches other paths or the working tree.
- Thread worktrees: updates the daemon's held selection for that thread (not the index, which threads don't use).
- `version` mismatch → error `stale`; the renderer re-reads and retries nothing by itself.
- `git.include(scope, { all: true, include: boolean })` includes or excludes everything.

### Commit

`git.commit` keeps its shape. In a thread worktree, when the held selection is `chosen`, it commits exactly the selection through a temporary index, as one recorded thread action, without touching the thread's private snapshots (#466). When nothing is chosen it commits everything, as today. After a commit the held selection is cleared.

### Revert and restore

- `git.revert(scope, { path, version, hunks?: string[], lines?: … })` → `{ revertId: string; keptUntil: number; file: ChangedFile | null }`. Makes the chosen hunks (or the whole file) match HEAD in both the working tree and the index. Before writing, it keeps the path's working-tree bytes and index entry (new and deleted files included) as a kept copy, using the existing kept-copy store and retention.
- `git.restoreReverted(scope, { revertId })` → `{ restored: true } | { restored: false; reason: 'changed' | 'expired'; current?: string; kept?: string }`. Restores only if the path still matches what the revert left; otherwise it returns both versions for a comparison and writes nothing.
- `git.revertedList(scope)` → `Array<{ revertId; path; at; keptUntil; summary }>`.
- Binary, symlink and mode-only changes revert only as whole files.
- In a thread worktree, a revert is a recorded thread action like today's discard.

### Errors

`stale`, `turn_running`, `not_a_repository`, `conflict`, `remote_offline` (from Bridge), plus today's Git errors.

## Delivery

- PR A: the methods above, GitService work, routed rows, tests (project folder and thread worktree, stale versions, binary, new/deleted files, restore after later edits, Windows line endings). Reviewed by the council before and after coding.
- PR B: the tab, the store migration (`review` surfaces and saved `mainView: 'review'` become `git`; `surface.review` shortcut overrides are dropped), the side card glance, removal of `GitPanel`/`ReviewPanel` and tests that only covered them, before/after screenshots.

Refs #605.
