// Pure rules of the Changes tab: scopes and their defaults, the footer's one next step, viewed marks,
// what the header drops at narrow widths and the keyboard map. No React, Monaco or window access, so
// tests can load it.
import type { ReviewFileEntry, ReviewFileResult, ReviewFilesResult, ReviewScope, ReviewSide } from '../../../shared/review'
import type { TurnChoice } from '../review/reviewModel'
import type { ChangesResult } from './changesApi'

/** What the scope menu offers: Last turn (pinned to one turn), This thread, Uncommitted, or one turn. */
export type ChangesScopeId = 'last' | 'thread' | 'uncommitted' | `turn:${string}`

export function isTurnScopeId(id: string): id is `turn:${string}` {
  return id.startsWith('turn:') && id.length > 'turn:'.length
}

export function parseScopeId(value: string): ChangesScopeId | null {
  if (value === 'last' || value === 'thread' || value === 'uncommitted') return value
  return isTurnScopeId(value) ? value : null
}

/**
 * The comparison a scope reads. A thread without a worktree of its own has no turns and no base, so
 * every scope there is the uncommitted diff. Last turn with no turn yet is the uncommitted diff too.
 */
export function reviewScopeFor(id: ChangesScopeId, input: { pinnedTurnId: string | null; ownWorktree: boolean }): ReviewScope {
  if (!input.ownWorktree || id === 'uncommitted') return { kind: 'worktree' }
  if (id === 'thread') return { kind: 'thread' }
  if (id === 'last') return input.pinnedTurnId ? { kind: 'turn', turnId: input.pinnedTurnId } : { kind: 'worktree' }
  return { kind: 'turn', turnId: id.slice('turn:'.length) }
}

/** The scope a comment pill or a chat edit line names, as a menu entry. */
export function scopeIdFor(scope: ReviewScope, pinnedTurnId: string | null = null): ChangesScopeId {
  if (scope.kind === 'worktree') return 'uncommitted'
  if (scope.kind === 'thread') return 'thread'
  return scope.turnId === pinnedTurnId ? 'last' : `turn:${scope.turnId}`
}

/** The newest turn that changed files and has ended; Last turn pins to it. */
export function latestEndedTurn(choices: readonly TurnChoice[]): TurnChoice | null {
  return choices.find((choice) => !choice.running && !choice.undone) ?? null
}

export interface DefaultScopeInput {
  /** The scope the user last picked in this thread, if any. */
  saved: ChangesScopeId | null
  /** When the tab was last opened on this thread; null when never. */
  lastOpenedAt: number | null
  /** The newest ended turn and when it ended. */
  lastTurn: { turnId: string; endedAt: number | null } | null
  hasUncommitted: boolean
  ownWorktree: boolean
  /** The thread has had a turn that changed files (This thread has something to show). */
  hasTurns: boolean
}

/**
 * A fresh open shows Last turn if it ended since the tab was last opened, otherwise the scope the
 * user last chose, otherwise Uncommitted when there is something uncommitted, otherwise This thread.
 * Last turn and This thread are skipped when the menu would not offer them (no turn yet).
 */
export function defaultScope(input: DefaultScopeInput): ChangesScopeId {
  if (!input.ownWorktree) return 'uncommitted'
  const turn = input.lastTurn
  if (turn && (input.lastOpenedAt === null || (turn.endedAt !== null && turn.endedAt > input.lastOpenedAt))) return 'last'
  const offered = (id: ChangesScopeId) => (id === 'last' ? turn !== null : id === 'thread' ? input.hasTurns : true)
  if (input.saved && offered(input.saved)) return input.saved
  return input.hasUncommitted || !input.hasTurns ? 'uncommitted' : 'thread'
}

/**
 * Last turn stays on the turn it was pinned to. When a newer turn has ended, the header offers it
 * ("Turn 13 finished · Show") and the view never switches by itself.
 */
export function newerTurnNotice(input: { scopeId: ChangesScopeId; pinnedTurnId: string | null; choices: readonly TurnChoice[] }): { turnId: string; number: number } | null {
  if (input.scopeId !== 'last' || input.pinnedTurnId === null) return null
  const latest = latestEndedTurn(input.choices)
  if (!latest || latest.turnId === input.pinnedTurnId) return null
  const pinned = input.choices.findIndex((choice) => choice.turnId === input.pinnedTurnId)
  const newest = input.choices.indexOf(latest)
  // Only a turn newer than the pinned one (the list is newest first); an undo does not count.
  if (pinned !== -1 && newest > pinned) return null
  return { turnId: latest.turnId, number: latest.number }
}

const firstChars = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** The scope's name on the header and in the menu: "Last turn · add login errors", "This thread", "Uncommitted". */
export function scopeTitle(id: ChangesScopeId, input: { pinnedTurnId: string | null; choices: readonly TurnChoice[]; ownWorktree: boolean }): string {
  if (!input.ownWorktree || id === 'uncommitted') return 'Uncommitted'
  if (id === 'thread') return 'This thread'
  const turnId = id === 'last' ? input.pinnedTurnId : id.slice('turn:'.length)
  const choice = turnId ? input.choices.find((item) => item.turnId === turnId) : undefined
  if (id === 'last') return choice?.prompt ? `Last turn · ${choice.prompt}` : 'Last turn'
  return choice?.prompt ?? 'Turn'
}

/** The scope's name inside a sentence: "No changes in this thread". A turn's prompt words stay as written. */
export function scopeInSentence(title: string): string {
  return /^(Last turn|This thread|Uncommitted)\b/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title
}

/** The label truncated to about 16 characters, for a narrow header; the full label goes in the tooltip. */
export function shortScopeTitle(title: string, max = 16): string {
  return firstChars(title, max)
}

export interface ScopeMenuOption {
  value: string
  label: string
  group?: string
}

/**
 * Last turn · This thread · Uncommitted, then the turns (newest first, by the user's prompt words).
 * Non-grouped entries come first, as `ui/Select` expects. Without a worktree of its own a thread has
 * only Uncommitted. Last turn needs an ended turn and This thread any turn; the shown scope always stays.
 */
export function scopeMenuOptions(input: { choices: readonly TurnChoice[]; ownWorktree: boolean; current: ChangesScopeId }): ScopeMenuOption[] {
  if (!input.ownWorktree) return [{ value: 'uncommitted', label: 'Uncommitted' }]
  const options: ScopeMenuOption[] = []
  if (latestEndedTurn(input.choices) || input.current === 'last') options.push({ value: 'last', label: 'Last turn' })
  if (input.choices.length > 0 || input.current === 'thread') options.push({ value: 'thread', label: 'This thread' })
  options.push({ value: 'uncommitted', label: 'Uncommitted' })
  for (const choice of input.choices) options.push({ value: `turn:${choice.turnId}`, label: choice.label, group: 'Turns' })
  // A turn reached from a chat edit line that the list no longer has (undone, or older) stays selectable.
  if (isTurnScopeId(input.current) && !input.choices.some((choice) => `turn:${choice.turnId}` === input.current)) {
    options.push({ value: input.current, label: 'Turn', group: 'Turns' })
  }
  return options
}

/** The scope menu gets type-to-filter once it holds more than this many entries. */
export const SCOPE_FILTER_AFTER = 8

// ---------------------------------------------------------------------------------------------
// Viewed marks

const sideKey = (side: ReviewSide | null): string => (side === null ? 'empty' : side.kind === 'commit' ? side.sha : side.kind)

/** The two ends of what a scope compares, so a mark made on one comparison never shows on another. */
export function scopeEndpoints(result: Pick<ReviewFilesResult, 'range'>): string {
  return `${sideKey(result.range.from)}..${sideKey(result.range.to)}`
}

/** FNV-1a over the text, as 8 hex digits: cheap and stable, for telling one version of a file from another. */
export function contentHash(...parts: ReadonlyArray<string | null | undefined>): string {
  let hash = 0x811c9dc5
  for (const part of parts) {
    const text = part ?? '\u0000'
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** A file's version as the list knows it, before its contents are read: the daemon's version, else its shape. */
export function fileSignature(entry: Pick<ReviewFileEntry, 'status' | 'oldPath' | 'additions' | 'deletions'> & { version?: string }): string {
  if (entry.version) return entry.version
  return contentHash(entry.status, entry.oldPath ?? '', String(entry.additions), String(entry.deletions))
}

/** Where a viewed mark is kept: thread, scope endpoints and path. The value is the file's version. */
export function viewedKey(threadId: string, endpoints: string, path: string): string {
  return `${threadId}\u0000${endpoints}\u0000${path}`
}

export type ViewedState = 'unviewed' | 'viewed' | 'changed'

/**
 * What a mark stores: the list's version of the file and, since a file is always marked while its card is
 * open, a hash of both sides as read.
 */
export function viewedMark(signature: string, contentHashValue: string | null): string {
  return contentHashValue ? `${signature}|${contentHashValue}` : signature
}

/**
 * A mark counts only for the version it was made on; a later version shows the "changed since viewed" dot.
 * The list's version is checked for every row; the content hash only where the file has been read (the open card),
 * which catches an edit that kept the line counts.
 */
export function viewedState(mark: string | undefined, signature: string, contentHashValue: string | null = null): ViewedState {
  if (mark === undefined) return 'unviewed'
  const [markedSignature, markedHash] = mark.split('|')
  if (markedSignature !== signature) return 'changed'
  if (contentHashValue && markedHash && markedHash !== contentHashValue) return 'changed'
  return 'viewed'
}

/** The next file `n` opens after marking one viewed: the next unviewed file after it, wrapping, else none. */
export function nextUnviewed(paths: readonly string[], current: string | null, isViewed: (path: string) => boolean): string | null {
  if (paths.length === 0) return null
  const start = current === null ? -1 : paths.indexOf(current)
  for (let offset = 1; offset <= paths.length; offset++) {
    const path = paths[(start + offset) % paths.length]
    if (path !== current && !isViewed(path)) return path
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Rows

/** A status word only for new, deleted, renamed and conflicted files; a modified file says nothing. */
export function statusWord(status: string): string | null {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'new'
    case 'deleted':
      return 'deleted'
    case 'renamed':
      return 'renamed'
    case 'conflict':
    case 'conflicted':
      return 'conflict'
    default:
      return null
  }
}

/** Rows in path order so they never move; conflicts are pinned on top. */
export function orderRows<T extends { path: string; conflict?: boolean }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (Boolean(a.conflict) !== Boolean(b.conflict)) return a.conflict ? -1 : 1
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
}

/** Two lists show the same changes when every file matches by path, status and line counts. */
export function sameChanges(a: readonly ReviewFileEntry[], b: readonly ReviewFileEntry[]): boolean {
  if (a.length !== b.length) return false
  const shape = (entry: ReviewFileEntry) => `${entry.path}\u0000${entry.oldPath ?? ''}\u0000${entry.status === 'untracked' ? 'added' : entry.status}\u0000${entry.additions}\u0000${entry.deletions}`
  const left = new Set(a.map(shape))
  return b.every((entry) => left.has(shape(entry)))
}

// ---------------------------------------------------------------------------------------------
// Uncommitted: HEAD → working tree, from Git's two diffs

/** Which of Git's two diffs a file shows up in: staged (HEAD → index) and unstaged (index → working tree). */
export interface UncommittedParts {
  staged: boolean
  unstaged: boolean
}

/**
 * Uncommitted is HEAD → working tree, as the hunks Include and Revert act on. Reviews read it as two diffs, so the
 * list is their union by path. A file in both gets its status from both ends; its line counts are only a sum, so the
 * row takes them from the daemon's hunks when it has them.
 */
export function mergeUncommittedLists(unstaged: ReviewFilesResult, staged: ReviewFilesResult | null): { result: ReviewFilesResult; parts: Map<string, UncommittedParts> } {
  const parts = new Map<string, UncommittedParts>()
  if (!staged || staged.unavailable) {
    for (const file of unstaged.files) parts.set(file.path, { staged: false, unstaged: true })
    return { result: unstaged, parts }
  }
  const byPath = new Map<string, ReviewFileEntry>()
  for (const file of staged.files) {
    byPath.set(file.path, file)
    parts.set(file.path, { staged: true, unstaged: false })
  }
  for (const file of unstaged.files) {
    const before = byPath.get(file.path)
    if (!before) {
      byPath.set(file.path, file)
      parts.set(file.path, { staged: false, unstaged: true })
      continue
    }
    parts.set(file.path, { staged: true, unstaged: true })
    // Added in the index stays added; removed in the working tree is deleted; a staged rename keeps its old path.
    const status = before.status === 'added' ? (file.status === 'deleted' ? 'modified' : 'added') : file.status === 'deleted' ? 'deleted' : before.status
    byPath.set(file.path, {
      ...file,
      status,
      ...(before.oldPath ? { oldPath: before.oldPath } : {}),
      additions: before.additions + file.additions,
      deletions: before.deletions + file.deletions,
      binary: before.binary || file.binary,
      countsExact: false
    })
  }
  return {
    result: {
      ...unstaged,
      range: { from: staged.range.from, to: unstaged.range.to },
      files: [...byPath.values()],
      truncated: unstaged.truncated || staged.truncated
    },
    parts
  }
}

/** A file's `+n −m` from the daemon's hunks; null when it has none to count (binary, too large, mode only). */
export function hunkLineCounts(file: { tooLarge?: boolean; hunks: ReadonlyArray<{ lines: ReadonlyArray<{ kind: ' ' | '-' | '+' }> }> }): { additions: number; deletions: number } | null {
  if (file.tooLarge || file.hunks.length === 0) return null
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === '+') additions++
      else if (line.kind === '-') deletions++
    }
  }
  return { additions, deletions }
}

/** One file's HEAD and working-tree sides from the staged read (HEAD → index) and the unstaged one (index → working tree). */
export function combineUncommittedSides(parts: UncommittedParts, staged: ReviewFileResult | null, unstaged: ReviewFileResult | null): ReviewFileResult | null {
  const base = unstaged ?? staged
  if (!base) return null
  // Not staged: the index is HEAD. Not unstaged: the working tree is the index.
  const original = parts.staged ? staged?.original ?? null : unstaged?.original ?? null
  const modified = parts.unstaged ? unstaged?.modified ?? null : staged?.modified ?? null
  return { ...base, original, modified }
}

// ---------------------------------------------------------------------------------------------
// What to commit

export type CommitSelection =
  /** Nothing chosen: the commit takes everything (Mousse stages it all only when Commit is clicked). */
  | { kind: 'all'; total: number }
  /** Part of the changes is included (the index in a project folder, the held selection in a thread). */
  | { kind: 'some'; included: number; total: number }
  /** The user excluded everything: nothing to commit until something is included. */
  | { kind: 'none'; total: number }

/** From the daemon's hunks when it has them: files that are fully or partly included count. */
export function selectionFromChanges(result: Pick<ChangesResult, 'files' | 'selection'>): CommitSelection {
  const total = result.files.length
  if (result.selection.state === 'untouched') return { kind: 'all', total }
  const included = result.files.filter((file) => file.included !== 'no').length
  if (included === 0) return { kind: 'none', total }
  if (included === total && result.files.every((file) => file.included === 'yes')) return { kind: 'all', total }
  return { kind: 'some', included, total }
}

/** From Git status alone: an empty index is no choice; a prepared index commits exactly what it holds. */
export function selectionFromStatus(counts: { stagedCount: number; changedCount: number }, inThread: boolean): CommitSelection {
  if (inThread || counts.stagedCount === 0 || counts.stagedCount >= counts.changedCount) return { kind: 'all', total: counts.changedCount }
  return { kind: 'some', included: counts.stagedCount, total: counts.changedCount }
}

export function commitLabel(selection: CommitSelection): string {
  if (selection.kind === 'none') return 'Include something to commit'
  // Every file has something in, but not all of it: "5 of 5" would read as everything.
  if (selection.kind === 'some') return selection.included >= selection.total ? `Commit part of ${selection.total}` : `Commit ${selection.included} of ${selection.total}`
  return `Commit all ${selection.total}`
}

// ---------------------------------------------------------------------------------------------
// The footer: one line, one next step

export interface FooterInput {
  /** Review comments waiting in the composer for this thread. */
  pendingComments: number
  /** The remote computer the thread runs on, when it cannot be reached. */
  offlineComputer: string | null
  conflicts: number
  /** Files with uncommitted changes. */
  uncommitted: number
  /** The shown scope is the uncommitted diff, by content. */
  showsUncommitted: boolean
  selection: CommitSelection
  branch: string | null
  onDefaultBranch: boolean
  /** Push or Publish when there is something to push; null otherwise. */
  push: { label: 'Push' | 'Publish'; count: number | null; enabled: boolean } | null
  canCreatePullRequest: boolean
  pullRequest: { number: number; checks: 'passing' | 'failing' | 'pending' | null } | null
}

export type FooterState =
  | { kind: 'send-comments'; count: number }
  | { kind: 'offline'; computer: string }
  | { kind: 'resolve-conflicts'; count: number }
  | { kind: 'commit'; placeholder: string; tinted: boolean; label: string; disabled: boolean }
  | { kind: 'review-uncommitted'; count: number }
  | { kind: 'push'; label: string; enabled: boolean }
  | { kind: 'create-pr' }
  | { kind: 'pull-request'; number: number; checks: 'passing' | 'failing' | 'pending' | null }
  | { kind: 'none' }

export function footerState(input: FooterInput): FooterState {
  if (input.pendingComments > 0) return { kind: 'send-comments', count: input.pendingComments }
  if (input.offlineComputer) return { kind: 'offline', computer: input.offlineComputer }
  if (input.conflicts > 0) return { kind: 'resolve-conflicts', count: input.conflicts }
  if (input.uncommitted > 0) {
    if (!input.showsUncommitted) return { kind: 'review-uncommitted', count: input.uncommitted }
    return {
      kind: 'commit',
      placeholder: input.branch ? `Commit to ${input.branch}` : 'Commit message',
      tinted: input.onDefaultBranch,
      label: commitLabel(input.selection),
      disabled: input.selection.kind === 'none'
    }
  }
  if (input.push) {
    const count = input.push.count === null ? '' : ` ${input.push.count}`
    return { kind: 'push', label: `${input.push.label}${count}`, enabled: input.push.enabled }
  }
  if (input.canCreatePullRequest) return { kind: 'create-pr' }
  if (input.pullRequest) return { kind: 'pull-request', number: input.pullRequest.number, checks: input.pullRequest.checks }
  return { kind: 'none' }
}

/**
 * Whether the Include checkboxes show: while choosing, while anything is left out (or the index was prepared
 * elsewhere), and never where Include is off.
 */
export function showIncludeChecks(input: { canInclude: boolean; choosing: boolean; selection: CommitSelection }): boolean {
  return input.canInclude && (input.choosing || input.selection.kind !== 'all')
}

/**
 * Whether a turn runs where the folder's Git writes would be refused (`thread_busy`): the thread's own worktree
 * follows that thread; a project folder follows every thread working in it.
 */
export function folderTurnRunning(
  scope: { projectId: string | null; workspaceThreadId: string | null },
  threads: ReadonlyArray<{ id: string; projectId?: string | null; worktreeEnabled?: boolean }>,
  phaseOf: (threadId: string) => string | undefined
): boolean {
  const running = (threadId: string) => {
    const phase = phaseOf(threadId)
    return phase !== undefined && phase !== 'idle'
  }
  if (scope.workspaceThreadId) return running(scope.workspaceThreadId)
  if (!scope.projectId) return false
  return threads.some((thread) => thread.projectId === scope.projectId && thread.worktreeEnabled === false && running(thread.id))
}

/** Space on a line selection: leave the lines out when every hunk they touch is fully included, else include them. */
export function includeValueForLines(hunks: ReadonlyArray<{ id: string; included: 'yes' | 'no' | 'partial' }>, choices: ReadonlyArray<{ hunk: string }>): boolean {
  const touched = hunks.filter((hunk) => choices.some((choice) => choice.hunk === hunk.id))
  return !(touched.length > 0 && touched.every((hunk) => hunk.included === 'yes'))
}

/** The lines of a selection, per daemon hunk; hunks the selection does not touch are left out. */
export function lineChoicesFor<T extends { id: string; lines: ReadonlyArray<{ kind: ' ' | '-' | '+'; oldNo?: number; newNo?: number }> }>(
  hunks: readonly T[],
  range: { side: 'additions' | 'deletions'; start: number; end: number }
): Array<{ hunk: string; indexes: number[] }> {
  return hunks.map((hunk) => ({ hunk: hunk.id, indexes: lineIndexesIn(hunk.lines, range) })).filter((choice) => choice.indexes.length > 0)
}

/** What a listed revert took, without the path the row already shows: "2 hunks", "1 line", "Whole file". */
export function revertedWhat(entry: { path: string; oldPath?: string; summary: string }): string {
  const name = entry.oldPath !== undefined ? `${entry.oldPath} → ${entry.path}` : entry.path
  const suffix = ` of ${name}`
  if (entry.summary.endsWith(suffix)) return entry.summary.slice(0, -suffix.length)
  return entry.summary === name ? 'Whole file' : entry.summary
}

/** Revert is allowed only on the uncommitted diff, and on Last turn while it is identical to it. */
export function revertAllowed(input: { scopeId: ChangesScopeId; showsUncommitted: boolean; turnRunning: boolean; apiAvailable: boolean }): boolean {
  if (!input.apiAvailable || input.turnRunning) return false
  if (input.scopeId === 'uncommitted') return true
  return input.scopeId === 'last' && input.showsUncommitted
}

// ---------------------------------------------------------------------------------------------
// The header at narrow widths

export interface HeaderContent {
  scopeTitle: string
  /** "3 files"; null when there are none (the empty state says so). */
  count: string | null
  /** "2 left", once something is viewed. */
  left: string | null
  /** "+12 −3" */
  totals: string | null
  /** The sync chip's words beside its icon and number ("Mac", "offline"); null when there is no chip. */
  chipText: string | null
  /** The chip's icon and number stay: the room they take. */
  chipCore: string | null
}

export interface HeaderFit {
  showTotals: boolean
  showLeft: boolean
  showChipText: boolean
  /** The scope label as shown; the full one goes in the tooltip. */
  scope: string
}

const CHAR_PX = 7
/** Header padding, the scope chevron, the "…" button and the gaps between items. */
const HEADER_FIXED_PX = 24 + 22 + 28 + 4 * 8
const CHIP_FIXED_PX = 30

const textWidth = (text: string | null) => (text ? text.length * CHAR_PX : 0)

/**
 * What fits on one header line, dropped in order as the pane narrows: line totals, then `N left`, then the
 * chip's text (its icon and number stay), then the scope label truncates to about 16 characters. The
 * scope, a remote computer's name and "…" never disappear.
 */
export function headerFit(width: number, content: HeaderContent, keepChipText = false): HeaderFit {
  const fit: HeaderFit = { showTotals: content.totals !== null, showLeft: content.left !== null, showChipText: content.chipText !== null, scope: content.scopeTitle }
  const needed = () =>
    HEADER_FIXED_PX +
    textWidth(fit.scope) +
    textWidth(content.count) +
    (fit.showLeft ? textWidth(` · ${content.left}`) : 0) +
    (fit.showTotals ? textWidth(content.totals) + 8 : 0) +
    (content.chipCore !== null || content.chipText !== null ? CHIP_FIXED_PX + textWidth(content.chipCore) + (fit.showChipText ? textWidth(content.chipText) + 4 : 0) : 0)
  if (needed() <= width) return fit
  fit.showTotals = false
  if (needed() <= width) return fit
  fit.showLeft = false
  if (needed() <= width) return fit
  // A remote computer's name is never dropped.
  if (!keepChipText) fit.showChipText = false
  if (needed() <= width) return fit
  fit.scope = shortScopeTitle(content.scopeTitle)
  return fit
}

/** Split view needs room for two columns of code. */
export const SPLIT_MIN_WIDTH = 700

// ---------------------------------------------------------------------------------------------
// Keys (outside text inputs)

export type ChangesKeyAction =
  | 'toggle'
  | 'open-in-files'
  | 'viewed-next'
  | 'previous'
  | 'next-hunk'
  | 'previous-hunk'
  | 'include'
  | 'revert'
  | 'comment'
  | 'file-jump'
  | 'undo-revert'
  | 'leave-selection'
  | 'help'

export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

const PLAIN_KEYS: Record<string, ChangesKeyAction> = {
  Enter: 'toggle',
  o: 'open-in-files',
  n: 'viewed-next',
  p: 'previous',
  j: 'next-hunk',
  k: 'previous-hunk',
  ' ': 'include',
  x: 'revert',
  c: 'comment',
  f: 'file-jump',
  Escape: 'leave-selection'
}

/** The tab's own keys. Nothing fires inside a text field, and Ctrl/Cmd/Alt chords are left to the app except Ctrl/Cmd+Z. */
export function changesKeyAction(event: KeyLike, inTextInput: boolean): ChangesKeyAction | null {
  if (inTextInput) return null
  const mod = Boolean(event.ctrlKey || event.metaKey)
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'z') return 'undo-revert'
  if (mod || event.altKey) return null
  if (event.key === '?') return 'help'
  // Shift is for `?` only; Shift+N and the like stay free.
  if (event.shiftKey) return null
  return PLAIN_KEYS[event.key.length === 1 ? event.key.toLowerCase() : event.key] ?? null
}

/** What `?` lists, in the doc's words. */
export const KEY_HELP: ReadonlyArray<[string, string]> = [
  ['Enter', 'Open or close the file'],
  ['O', 'Open in Files'],
  ['N', 'Mark viewed and open the next'],
  ['P', 'Previous file'],
  ['J / K', 'Next or previous hunk'],
  ['Space', 'Include in the commit'],
  ['X', 'Revert'],
  ['C', 'Comment'],
  ['F', 'Jump to a file'],
  ['Ctrl/Cmd+Z', 'Undo revert'],
  ['Esc', 'Leave the selection']
]

// ---------------------------------------------------------------------------------------------
// Hunks

export interface HunkRange {
  index: number
  /** First and last changed line on the new side, 1-based; for a pure removal, the line it sits after. */
  newStart: number
  newEnd: number
  oldStart: number
  oldEnd: number
  /** Content hash of the changed lines, so a choice on a hunk survives a re-read that left it unchanged. */
  id: string
  additions: number
  deletions: number
}

/** The parts of `@pierre/diffs` metadata the hunk list reads (`parseDiffFromFile`). */
export interface DiffMetadataLike {
  deletionLines: readonly string[]
  additionLines: readonly string[]
  hunks: ReadonlyArray<{
    hunkContent: ReadonlyArray<
      | { type: 'context'; lines: number; additionLineIndex: number; deletionLineIndex: number }
      | { type: 'change'; additions: number; deletions: number; additionLineIndex: number; deletionLineIndex: number }
    >
  }>
}

/**
 * The hunks as the diff draws them (3 context lines, nearby changes share a hunk), with the first and last
 * changed line on each side. Line indexes are into the full files, so a line number is index + 1.
 */
export function hunksFromMetadata(meta: DiffMetadataLike): HunkRange[] {
  return meta.hunks.map((hunk, index) => {
    let additions = 0
    let deletions = 0
    let newStart = 0
    let newEnd = 0
    let oldStart = 0
    let oldEnd = 0
    let newAt = 0
    let oldAt = 0
    const text: string[] = []
    for (const part of hunk.hunkContent) {
      if (part.type === 'context') {
        newAt = part.additionLineIndex + part.lines
        oldAt = part.deletionLineIndex + part.lines
        continue
      }
      if (part.deletions > 0) {
        if (deletions === 0) oldStart = part.deletionLineIndex + 1
        oldEnd = part.deletionLineIndex + part.deletions
        deletions += part.deletions
        for (let line = part.deletionLineIndex; line < part.deletionLineIndex + part.deletions; line++) text.push(`-${meta.deletionLines[line] ?? ''}`)
      }
      if (part.additions > 0) {
        if (additions === 0) newStart = part.additionLineIndex + 1
        newEnd = part.additionLineIndex + part.additions
        additions += part.additions
        for (let line = part.additionLineIndex; line < part.additionLineIndex + part.additions; line++) text.push(`+${meta.additionLines[line] ?? ''}`)
      }
      if (additions === 0) newAt = part.additionLineIndex
      if (deletions === 0) oldAt = part.deletionLineIndex
    }
    return {
      index,
      newStart: additions === 0 ? newAt : newStart,
      newEnd: additions === 0 ? newAt : newEnd,
      oldStart: deletions === 0 ? oldAt : oldStart,
      oldEnd: deletions === 0 ? oldAt : oldEnd,
      id: contentHash(...text),
      additions,
      deletions
    }
  })
}


/** The hunk a line of the diff belongs to, by side and line number. */
export function hunkAtLine(hunks: readonly HunkRange[], side: 'additions' | 'deletions', line: number): HunkRange | null {
  for (const hunk of hunks) {
    if (side === 'additions' && hunk.additions > 0 && line >= hunk.newStart && line <= hunk.newEnd) return hunk
    if (side === 'deletions' && hunk.deletions > 0 && line >= hunk.oldStart && line <= hunk.oldEnd) return hunk
  }
  return null
}

/** Where a hunk's actions attach: under its last added line, else under its last removed line. */
export function hunkAnchor(hunk: HunkRange): { side: 'additions' | 'deletions'; lineNumber: number } {
  return hunk.additions > 0 ? { side: 'additions', lineNumber: hunk.newEnd } : { side: 'deletions', lineNumber: hunk.oldEnd }
}

/**
 * The lines `C` or a hunk's Comment button comments on: the selected lines, else the line under the pointer
 * when it is inside the hunk, else the hunk's first changed line. Never the whole hunk, which can span many
 * unchanged lines between its changes.
 */
export function commentTarget(input: {
  selection: { side: 'additions' | 'deletions'; start: number; end: number } | null
  hovered: { side: 'additions' | 'deletions'; line: number } | null
  hunk: HunkRange | null
  hunks: readonly HunkRange[]
}): { side: 'additions' | 'deletions'; start: number; end: number } | null {
  if (input.selection) return input.selection
  const hovered = input.hovered
  if (hovered && (input.hunk === null || hunkAtLine(input.hunks, hovered.side, hovered.line)?.index === input.hunk.index)) {
    return { side: hovered.side, start: hovered.line, end: hovered.line }
  }
  const hunk = input.hunk
  if (!hunk) return null
  return hunk.additions > 0 ? { side: 'additions', start: hunk.newStart, end: hunk.newStart } : { side: 'deletions', start: hunk.oldStart, end: hunk.oldStart }
}

/** `j`/`k` from the focused hunk; from none, `j` starts at the first and `k` at the last. */
export function stepHunk(count: number, focused: number | null, step: 1 | -1): number | null {
  if (count === 0) return null
  if (focused === null) return step === 1 ? 0 : count - 1
  return Math.min(count - 1, Math.max(0, focused + step))
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** The daemon's hunk a drawn hunk stands for: the first whose lines overlap it on the side it changes. */
export function matchDaemonHunk<T extends { oldStart: number; oldLines: number; newStart: number; newLines: number }>(hunk: HunkRange, daemon: readonly T[]): T | null {
  const overlaps = (start: number, count: number, from: number, to: number) => count > 0 && start <= to && start + count - 1 >= from
  for (const candidate of daemon) {
    if (hunk.additions > 0 && overlaps(candidate.newStart, candidate.newLines, hunk.newStart, hunk.newEnd)) return candidate
    if (hunk.additions === 0 && overlaps(candidate.oldStart, candidate.oldLines, hunk.oldStart, hunk.oldEnd)) return candidate
  }
  return null
}

/** The indexes of a daemon hunk's changed lines inside a line selection, for including part of a hunk. */
export function lineIndexesIn(
  lines: ReadonlyArray<{ kind: ' ' | '-' | '+'; oldNo?: number; newNo?: number }>,
  range: { side: 'additions' | 'deletions'; start: number; end: number }
): number[] {
  const from = Math.min(range.start, range.end)
  const to = Math.max(range.start, range.end)
  const indexes: number[] = []
  lines.forEach((line, index) => {
    if (range.side === 'additions' && line.kind === '+' && line.newNo !== undefined && line.newNo >= from && line.newNo <= to) indexes.push(index)
    if (range.side === 'deletions' && line.kind === '-' && line.oldNo !== undefined && line.oldNo >= from && line.oldNo <= to) indexes.push(index)
  })
  return indexes
}
