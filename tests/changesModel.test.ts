import { describe, expect, it } from 'vitest'
import { parseDiffFromFile } from '@pierre/diffs'
import type { TurnChoice } from '../src/renderer/components/review/reviewModel'
import type { ReviewFileEntry } from '../src/shared/review'
import {
  changesKeyAction,
  commitLabel,
  contentHash,
  commentTarget,
  defaultScope,
  fileSignature,
  combineUncommittedSides,
  folderTurnRunning,
  footerState,
  hunkLineCounts,
  headerFit,
  hunkAnchor,
  hunkAtLine,
  hunksFromMetadata,
  includeValueForLines,
  latestEndedTurn,
  lineChoicesFor,
  lineIndexesIn,
  matchDaemonHunk,
  mergeUncommittedLists,
  newerTurnNotice,
  nextUnviewed,
  orderRows,
  parseScopeId,
  revertAllowed,
  revertedWhat,
  reviewScopeFor,
  sameChanges,
  scopeEndpoints,
  scopeIdFor,
  scopeInSentence,
  scopeMenuOptions,
  scopeTitle,
  selectionFromChanges,
  selectionFromStatus,
  showIncludeChecks,
  statusWord,
  stepHunk,
  viewedKey,
  viewedMark,
  viewedState,
  type FooterInput,
  type ChangesScopeId,
  type HeaderContent
} from '../src/renderer/components/changes/changesModel'

const turn = (turnId: string, patch: Partial<TurnChoice> = {}): TurnChoice => ({
  turnId,
  label: `${turnId} · 10:00`,
  prompt: `prompt ${turnId}`,
  number: 1,
  endedAt: 1000,
  files: 2,
  undone: false,
  running: false,
  ...patch
})

const entry = (path: string, patch: Partial<ReviewFileEntry> = {}): ReviewFileEntry => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
  countsExact: true,
  ...patch
})

describe('scopes', () => {
  it('reads each menu entry as a comparison, and only the uncommitted diff without a worktree of its own', () => {
    expect(reviewScopeFor('uncommitted', { pinnedTurnId: 'r1', ownWorktree: true })).toEqual({ kind: 'worktree' })
    expect(reviewScopeFor('thread', { pinnedTurnId: null, ownWorktree: true })).toEqual({ kind: 'thread' })
    expect(reviewScopeFor('last', { pinnedTurnId: 'r1', ownWorktree: true })).toEqual({ kind: 'turn', turnId: 'r1' })
    expect(reviewScopeFor('last', { pinnedTurnId: null, ownWorktree: true })).toEqual({ kind: 'worktree' })
    expect(reviewScopeFor('turn:run:thread:a:ordinal:2', { pinnedTurnId: null, ownWorktree: true })).toEqual({ kind: 'turn', turnId: 'run:thread:a:ordinal:2' })
    expect(reviewScopeFor('thread', { pinnedTurnId: null, ownWorktree: false })).toEqual({ kind: 'worktree' })
  })

  it('maps a comment or edit line scope back to a menu entry', () => {
    expect(scopeIdFor({ kind: 'worktree', staged: true })).toBe('uncommitted')
    expect(scopeIdFor({ kind: 'thread' })).toBe('thread')
    expect(scopeIdFor({ kind: 'turn', turnId: 'r1' }, 'r1')).toBe('last')
    expect(scopeIdFor({ kind: 'turn', turnId: 'r2' }, 'r1')).toBe('turn:r2')
    expect(parseScopeId('turn:')).toBeNull()
    expect(parseScopeId('bogus')).toBeNull()
    expect(parseScopeId('last')).toBe('last')
  })

  it('names the scope with the prompt words', () => {
    const choices = [turn('r2', { prompt: 'add login errors' }), turn('r1')]
    expect(scopeTitle('last', { pinnedTurnId: 'r2', choices, ownWorktree: true })).toBe('Last turn · add login errors')
    expect(scopeTitle('turn:r1', { pinnedTurnId: 'r2', choices, ownWorktree: true })).toBe('prompt r1')
    expect(scopeTitle('thread', { pinnedTurnId: null, choices, ownWorktree: true })).toBe('This thread')
    expect(scopeTitle('thread', { pinnedTurnId: null, choices, ownWorktree: false })).toBe('Uncommitted')
  })

  it('lowercases the scope inside a sentence, but not a turn prompt', () => {
    expect(`No changes in ${scopeInSentence('This thread')}`).toBe('No changes in this thread')
    expect(scopeInSentence('Last turn · Add login errors')).toBe('last turn · Add login errors')
    expect(scopeInSentence('Add login errors')).toBe('Add login errors')
  })

  it('lists Last turn, This thread and Uncommitted first, then the turns as a group', () => {
    const options = scopeMenuOptions({ choices: [turn('r2'), turn('r1')], ownWorktree: true, current: 'last' })
    expect(options.map((option) => [option.value, option.group ?? null])).toEqual([
      ['last', null],
      ['thread', null],
      ['uncommitted', null],
      ['turn:r2', 'Turns'],
      ['turn:r1', 'Turns']
    ])
    expect(scopeMenuOptions({ choices: [turn('r1')], ownWorktree: false, current: 'uncommitted' })).toEqual([{ value: 'uncommitted', label: 'Uncommitted' }])
    // A turn reached from a chat edit line stays selectable when the list no longer has it.
    expect(scopeMenuOptions({ choices: [], ownWorktree: true, current: 'turn:gone' }).at(-1)).toEqual({ value: 'turn:gone', label: 'Turn', group: 'Turns' })
  })

  it('offers Last turn only after a turn ended, and This thread only once there is a turn', () => {
    const values = (choices: TurnChoice[], current: ChangesScopeId = 'uncommitted') => scopeMenuOptions({ choices, ownWorktree: true, current }).map((option) => option.value)
    expect(values([])).toEqual(['uncommitted'])
    expect(values([turn('r1', { running: true })])).toEqual(['thread', 'uncommitted', 'turn:r1'])
    expect(values([turn('r1', { undone: true })])).toEqual(['thread', 'uncommitted', 'turn:r1'])
    // The shown scope stays in the menu.
    expect(values([], 'thread')).toEqual(['thread', 'uncommitted'])
  })
})

describe('the default scope and freezing', () => {
  const base = { saved: null, lastOpenedAt: 500, lastTurn: { turnId: 'r1', endedAt: 1000 }, hasUncommitted: true, ownWorktree: true, hasTurns: true }

  it('shows Last turn when it ended since the tab was last opened, or on a first open', () => {
    expect(defaultScope(base)).toBe('last')
    expect(defaultScope({ ...base, lastOpenedAt: null, saved: 'thread' })).toBe('last')
  })

  it('restores the user\'s last choice when no newer turn ended', () => {
    expect(defaultScope({ ...base, lastOpenedAt: 2000, saved: 'thread' })).toBe('thread')
  })

  it('otherwise shows Uncommitted when there is something, else This thread', () => {
    expect(defaultScope({ ...base, lastOpenedAt: 2000 })).toBe('uncommitted')
    expect(defaultScope({ ...base, lastOpenedAt: 2000, hasUncommitted: false })).toBe('thread')
    expect(defaultScope({ ...base, lastTurn: null, hasUncommitted: false })).toBe('thread')
  })

  it('never opens on a scope the menu does not offer', () => {
    expect(defaultScope({ ...base, lastTurn: null, hasTurns: false, hasUncommitted: false })).toBe('uncommitted')
    expect(defaultScope({ ...base, lastTurn: null, hasTurns: false, saved: 'thread' })).toBe('uncommitted')
    expect(defaultScope({ ...base, lastTurn: null, saved: 'last', hasUncommitted: false })).toBe('thread')
  })

  it('has only Uncommitted without a worktree of its own', () => {
    expect(defaultScope({ ...base, ownWorktree: false, saved: 'thread' })).toBe('uncommitted')
  })

  it('pins Last turn to the newest ended turn, skipping a running or undone one', () => {
    expect(latestEndedTurn([turn('r3', { running: true }), turn('r2', { undone: true }), turn('r1')])?.turnId).toBe('r1')
    expect(latestEndedTurn([])).toBeNull()
  })

  it('offers a newer turn without switching to it', () => {
    const choices = [turn('r3', { number: 13 }), turn('r2', { number: 12 })]
    expect(newerTurnNotice({ scopeId: 'last', pinnedTurnId: 'r2', choices })).toEqual({ turnId: 'r3', number: 13 })
    expect(newerTurnNotice({ scopeId: 'last', pinnedTurnId: 'r3', choices })).toBeNull()
    expect(newerTurnNotice({ scopeId: 'thread', pinnedTurnId: 'r2', choices })).toBeNull()
    // A turn that is still running is no news yet.
    expect(newerTurnNotice({ scopeId: 'last', pinnedTurnId: 'r2', choices: [turn('r3', { running: true }), turn('r2')] })).toBeNull()
  })
})

describe('viewed marks', () => {
  it('keys a mark by thread, the scope\'s two ends and the path', () => {
    const range = { range: { from: { kind: 'commit' as const, sha: 'abc' }, to: { kind: 'worktree' as const } } }
    expect(scopeEndpoints(range)).toBe('abc..worktree')
    expect(scopeEndpoints({ range: { from: null, to: { kind: 'index' } } })).toBe('empty..index')
    expect(viewedKey('t1', 'abc..worktree', 'src/a.ts')).not.toBe(viewedKey('t1', 'def..worktree', 'src/a.ts'))
    expect(viewedKey('t1', 'abc..worktree', 'src/a.ts')).not.toBe(viewedKey('t2', 'abc..worktree', 'src/a.ts'))
  })

  it('uses the daemon\'s version when there is one, else the file\'s shape', () => {
    expect(fileSignature({ ...entry('a'), version: 'v9' })).toBe('v9')
    expect(fileSignature(entry('a'))).toBe(fileSignature(entry('a')))
    expect(fileSignature(entry('a'))).not.toBe(fileSignature(entry('a', { additions: 2 })))
  })

  it('clears when the file changes, including an edit that kept the line counts', () => {
    const signature = fileSignature(entry('a'))
    const hash = contentHash('old', 'new')
    const mark = viewedMark(signature, hash)
    expect(viewedState(undefined, signature)).toBe('unviewed')
    expect(viewedState(mark, signature)).toBe('viewed')
    expect(viewedState(mark, signature, hash)).toBe('viewed')
    expect(viewedState(mark, fileSignature(entry('a', { additions: 3 })))).toBe('changed')
    expect(viewedState(mark, signature, contentHash('old', 'newer'))).toBe('changed')
  })

  it('opens the next unviewed file after the current one, wrapping, and none when all are viewed', () => {
    const viewed = new Set(['b'])
    expect(nextUnviewed(['a', 'b', 'c'], 'a', (path) => viewed.has(path))).toBe('c')
    expect(nextUnviewed(['a', 'b', 'c'], 'c', (path) => viewed.has(path))).toBe('a')
    expect(nextUnviewed(['a', 'b'], 'a', (path) => path === 'a' || viewed.has(path))).toBeNull()
    expect(nextUnviewed([], null, () => false)).toBeNull()
  })

  it('hashes content stably and tells the sides apart', () => {
    expect(contentHash('a', 'b')).toBe(contentHash('a', 'b'))
    expect(contentHash('ab', '')).not.toBe(contentHash('a', 'b'))
    expect(contentHash(null, 'x')).not.toBe(contentHash('', 'x'))
  })
})

describe('rows', () => {
  it('says a status word only for new, deleted, renamed and conflicted files', () => {
    expect(statusWord('modified')).toBeNull()
    expect(statusWord('untracked')).toBe('new')
    expect(statusWord('added')).toBe('new')
    expect(statusWord('deleted')).toBe('deleted')
    expect(statusWord('renamed')).toBe('renamed')
    expect(statusWord('conflict')).toBe('conflict')
  })

  it('keeps rows in path order with conflicts pinned on top', () => {
    const rows = orderRows([{ path: 'b' }, { path: 'a' }, { path: 'z', conflict: true }, { path: 'c' }])
    expect(rows.map((row) => row.path)).toEqual(['z', 'a', 'b', 'c'])
  })

  it('compares two lists by content, whatever their order', () => {
    expect(sameChanges([entry('a'), entry('b')], [entry('b'), entry('a')])).toBe(true)
    expect(sameChanges([entry('a', { status: 'untracked' })], [entry('a', { status: 'added' })])).toBe(true)
    expect(sameChanges([entry('a')], [entry('a', { additions: 4 })])).toBe(false)
    expect(sameChanges([entry('a')], [entry('a'), entry('b')])).toBe(false)
  })
})

describe('what a commit takes', () => {
  it('says Commit all when nothing was chosen, part when part is included, and asks for something when nothing is', () => {
    const file = (path: string, included: 'yes' | 'no' | 'partial') => ({ path, change: 'modified' as const, kind: 'file' as const, binary: false, wholeFileOnly: false, indexDiverged: false, tooLarge: false, version: 'v', hunks: [], included })
    const untouched = { state: 'untouched' as const, token: 't' }
    const chosen = { state: 'chosen' as const, token: 't' }
    expect(selectionFromChanges({ selection: untouched, files: [file('a', 'no'), file('b', 'no')] })).toEqual({ kind: 'all', total: 2 })
    expect(selectionFromChanges({ selection: chosen, files: [file('a', 'yes'), file('b', 'partial'), file('c', 'no')] })).toEqual({ kind: 'some', included: 2, total: 3 })
    expect(selectionFromChanges({ selection: chosen, files: [file('a', 'no')] })).toEqual({ kind: 'none', total: 1 })
    expect(selectionFromChanges({ selection: chosen, files: [file('a', 'yes')] })).toEqual({ kind: 'all', total: 1 })
  })

  it('treats an empty index as no choice and a prepared one as exactly what it holds', () => {
    expect(selectionFromStatus({ stagedCount: 0, changedCount: 5 }, false)).toEqual({ kind: 'all', total: 5 })
    expect(selectionFromStatus({ stagedCount: 2, changedCount: 5 }, false)).toEqual({ kind: 'some', included: 2, total: 5 })
    // A thread's worktree commits everything unless the daemon holds a selection.
    expect(selectionFromStatus({ stagedCount: 2, changedCount: 5 }, true)).toEqual({ kind: 'all', total: 5 })
    expect(commitLabel({ kind: 'all', total: 5 })).toBe('Commit all 5')
    expect(commitLabel({ kind: 'some', included: 2, total: 3 })).toBe('Commit 2 of 3')
    expect(commitLabel({ kind: 'some', included: 3, total: 3 })).toBe('Commit part of 3')
    expect(commitLabel({ kind: 'none', total: 3 })).toBe('Include something to commit')
  })
})

describe('the footer', () => {
  const input = (patch: Partial<FooterInput> = {}): FooterInput => ({
    pendingComments: 0,
    offlineComputer: null,
    conflicts: 0,
    uncommitted: 0,
    showsUncommitted: true,
    selection: { kind: 'all', total: 0 },
    branch: 'feat/login',
    onDefaultBranch: false,
    push: null,
    canCreatePullRequest: false,
    pullRequest: null,
    ...patch
  })

  it('leads with pending comments', () => {
    expect(footerState(input({ pendingComments: 2, uncommitted: 3 }))).toEqual({ kind: 'send-comments', count: 2 })
  })

  it('says the computer is offline, then conflicts', () => {
    expect(footerState(input({ offlineComputer: 'Mac', uncommitted: 3 }))).toEqual({ kind: 'offline', computer: 'Mac' })
    expect(footerState(input({ conflicts: 1, uncommitted: 3 }))).toEqual({ kind: 'resolve-conflicts', count: 1 })
  })

  it('commits when the shown scope is the uncommitted diff, naming the branch and tinting the default branch', () => {
    expect(footerState(input({ uncommitted: 5, selection: { kind: 'all', total: 5 } }))).toEqual({
      kind: 'commit',
      placeholder: 'Commit to feat/login',
      tinted: false,
      label: 'Commit all 5',
      disabled: false
    })
    expect(footerState(input({ uncommitted: 5, onDefaultBranch: true, branch: 'main', selection: { kind: 'all', total: 5 } }))).toMatchObject({ placeholder: 'Commit to main', tinted: true })
    expect(footerState(input({ uncommitted: 3, selection: { kind: 'none', total: 3 } }))).toMatchObject({ label: 'Include something to commit', disabled: true })
  })

  it('offers to review the uncommitted changes when the scope shows something else', () => {
    expect(footerState(input({ uncommitted: 5, showsUncommitted: false }))).toEqual({ kind: 'review-uncommitted', count: 5 })
  })

  it('then Push, Create PR, the pull request chip and nothing', () => {
    expect(footerState(input({ push: { label: 'Push', count: 2, enabled: true }, canCreatePullRequest: true }))).toEqual({ kind: 'push', label: 'Push 2', enabled: true })
    expect(footerState(input({ push: { label: 'Publish', count: null, enabled: true } }))).toEqual({ kind: 'push', label: 'Publish', enabled: true })
    expect(footerState(input({ canCreatePullRequest: true, pullRequest: { number: 4, checks: null } }))).toEqual({ kind: 'create-pr' })
    expect(footerState(input({ pullRequest: { number: 123, checks: 'passing' } }))).toEqual({ kind: 'pull-request', number: 123, checks: 'passing' })
    expect(footerState(input())).toEqual({ kind: 'none' })
  })

  it('allows Revert only on the uncommitted diff, and Last turn while it is the same, never during a turn', () => {
    const ready = { showsUncommitted: true, turnRunning: false, apiAvailable: true }
    expect(revertAllowed({ ...ready, scopeId: 'uncommitted' })).toBe(true)
    expect(revertAllowed({ ...ready, scopeId: 'last' })).toBe(true)
    expect(revertAllowed({ ...ready, scopeId: 'last', showsUncommitted: false })).toBe(false)
    expect(revertAllowed({ ...ready, scopeId: 'thread' })).toBe(false)
    expect(revertAllowed({ ...ready, scopeId: 'turn:r1' })).toBe(false)
    expect(revertAllowed({ ...ready, scopeId: 'uncommitted', turnRunning: true })).toBe(false)
    expect(revertAllowed({ ...ready, scopeId: 'uncommitted', apiAvailable: false })).toBe(false)
  })
})

describe('the header at narrow widths', () => {
  const content: HeaderContent = {
    scopeTitle: 'Last turn · add login errors to the form',
    count: '3 files',
    left: '2 left',
    totals: '+120 −34',
    chipText: 'detached',
    chipCore: '↑2'
  }

  it('fits everything when there is room', () => {
    expect(headerFit(900, content)).toEqual({ showTotals: true, showLeft: true, showChipText: true, scope: content.scopeTitle })
  })

  it('at a 440px pane keeps the scope, the count and the chip, and drops the totals and N left', () => {
    const at440 = headerFit(440, content)
    expect(at440.showTotals).toBe(false)
    expect(at440.showLeft).toBe(false)
    expect(headerFit(300, content).scope.length).toBeLessThanOrEqual(16)
  })

  it('keeps a remote computer\'s name', () => {
    const remote = { ...content, chipText: 'Studio Mac mini' }
    expect(headerFit(300, remote, true).showChipText).toBe(true)
    expect(headerFit(300, remote, false).showChipText).toBe(false)
  })

  it('leaves the count out when there are no files, which leaves the scope more room', () => {
    const empty = { ...content, left: null, totals: null, chipText: null }
    expect(headerFit(440, empty).scope).not.toBe(content.scopeTitle)
    expect(headerFit(440, { ...empty, count: null }).scope).toBe(content.scopeTitle)
  })

  it('drops totals before N left', () => {
    let previous = headerFit(2000, content)
    for (let width = 2000; width > 200; width -= 10) {
      const fit = headerFit(width, content)
      if (!fit.showLeft) expect(fit.showTotals).toBe(false)
      if (!fit.showChipText) expect(fit.showLeft).toBe(false)
      if (fit.scope !== content.scopeTitle) expect(fit.showChipText).toBe(false)
      // Narrower never brings something back.
      if (!previous.showTotals) expect(fit.showTotals).toBe(false)
      previous = fit
    }
  })
})

describe('keys', () => {
  it('maps the tab\'s keys outside text inputs', () => {
    const action = (key: string, extra = {}) => changesKeyAction({ key, ...extra }, false)
    expect(action('Enter')).toBe('toggle')
    expect(action('o')).toBe('open-in-files')
    expect(action('O', { shiftKey: true })).toBeNull()
    expect(action('n')).toBe('viewed-next')
    expect(action('p')).toBe('previous')
    expect(action('j')).toBe('next-hunk')
    expect(action('k')).toBe('previous-hunk')
    expect(action(' ')).toBe('include')
    expect(action('x')).toBe('revert')
    expect(action('c')).toBe('comment')
    expect(action('f')).toBe('file-jump')
    expect(action('Escape')).toBe('leave-selection')
    expect(action('?', { shiftKey: true })).toBe('help')
    expect(action('z', { ctrlKey: true })).toBe('undo-revert')
    expect(action('z', { metaKey: true })).toBe('undo-revert')
  })

  it('leaves text fields and other chords alone', () => {
    expect(changesKeyAction({ key: 'n' }, true)).toBeNull()
    expect(changesKeyAction({ key: 'z', ctrlKey: true }, true)).toBeNull()
    expect(changesKeyAction({ key: 'f', ctrlKey: true }, false)).toBeNull()
    expect(changesKeyAction({ key: 'z', ctrlKey: true, shiftKey: true }, false)).toBeNull()
    expect(changesKeyAction({ key: 'n', altKey: true }, false)).toBeNull()
  })

  it('steps through hunks without wrapping', () => {
    expect(stepHunk(0, null, 1)).toBeNull()
    expect(stepHunk(3, null, 1)).toBe(0)
    expect(stepHunk(3, null, -1)).toBe(2)
    expect(stepHunk(3, 2, 1)).toBe(2)
    expect(stepHunk(3, 0, -1)).toBe(0)
    expect(stepHunk(3, 1, 1)).toBe(2)
  })
})

describe('hunks', () => {
  const lines = (count: number, change: Record<number, string> = {}) =>
    Array.from({ length: count }, (_, index) => change[index + 1] ?? `line ${index + 1}`).join('\n') + '\n'

  it('finds the hunks as the diff draws them, with 3 context lines', () => {
    const before = lines(40)
    const after = lines(40, { 5: 'changed 5', 30: 'changed 30' })
    const meta = parseDiffFromFile({ name: 'a.ts', contents: before }, { name: 'a.ts', contents: after }, { context: 3 })
    const hunks = hunksFromMetadata(meta)
    expect(hunks.map((hunk) => [hunk.newStart, hunk.newEnd, hunk.oldStart, hunk.oldEnd, hunk.additions, hunk.deletions])).toEqual([
      [5, 5, 5, 5, 1, 1],
      [30, 30, 30, 30, 1, 1]
    ])
    expect(hunks[0].id).not.toBe(hunks[1].id)
    expect(hunkAtLine(hunks, 'additions', 30)?.index).toBe(1)
    expect(hunkAtLine(hunks, 'deletions', 5)?.index).toBe(0)
    expect(hunkAtLine(hunks, 'additions', 12)).toBeNull()
  })

  it('comments on one line: the selection, else the hovered line in the hunk, else its first changed line', () => {
    // One hunk: changes at 1, 5 and 11 with unchanged lines between them.
    const meta = parseDiffFromFile({ name: 'a', contents: lines(30) }, { name: 'a', contents: lines(30, { 1: 'a', 5: 'b', 11: 'c' }) }, { context: 3 })
    const hunks = hunksFromMetadata(meta)
    expect(hunks).toHaveLength(1)
    const [hunk] = hunks
    expect([hunk.newStart, hunk.newEnd]).toEqual([1, 11])
    const selection = { side: 'additions' as const, start: 3, end: 6 }
    expect(commentTarget({ selection, hovered: { side: 'additions', line: 5 }, hunk, hunks })).toEqual(selection)
    expect(commentTarget({ selection: null, hovered: { side: 'additions', line: 5 }, hunk, hunks })).toEqual({ side: 'additions', start: 5, end: 5 })
    expect(commentTarget({ selection: null, hovered: { side: 'deletions', line: 5 }, hunk, hunks })).toEqual({ side: 'deletions', start: 5, end: 5 })
    expect(commentTarget({ selection: null, hovered: null, hunk, hunks })).toEqual({ side: 'additions', start: 1, end: 1 })
    // The pointer resting outside the focused hunk does not pull the comment there.
    expect(commentTarget({ selection: null, hovered: { side: 'additions', line: 25 }, hunk, hunks })).toEqual({ side: 'additions', start: 1, end: 1 })
    // No hunk focused: the hovered line, else nothing.
    expect(commentTarget({ selection: null, hovered: { side: 'additions', line: 25 }, hunk: null, hunks })).toEqual({ side: 'additions', start: 25, end: 25 })
    expect(commentTarget({ selection: null, hovered: null, hunk: null, hunks })).toBeNull()
    // A pure removal comments on its first removed line.
    const [removal] = hunksFromMetadata(parseDiffFromFile({ name: 'a', contents: lines(10) }, { name: 'a', contents: lines(10).replace('line 4' + String.fromCharCode(10), '') }, { context: 3 }))
    expect(commentTarget({ selection: null, hovered: null, hunk: removal, hunks: [removal] })).toEqual({ side: 'deletions', start: 4, end: 4 })
  })

  it('anchors a pure removal on the side it changes, and keeps an id for the same change elsewhere', () => {
    const before = lines(10)
    const after = before.replace('line 4\n', '')
    const [hunk] = hunksFromMetadata(parseDiffFromFile({ name: 'a', contents: before }, { name: 'a', contents: after }, { context: 3 }))
    expect(hunk.additions).toBe(0)
    expect(hunkAnchor(hunk)).toEqual({ side: 'deletions', lineNumber: 4 })
    const moved = hunksFromMetadata(parseDiffFromFile({ name: 'a', contents: `x\n${before}` }, { name: 'a', contents: `x\n${after}` }, { context: 3 }))[0]
    expect(moved.id).toBe(hunk.id)
  })

  it('merges changes closer than twice the context into one hunk', () => {
    const meta = parseDiffFromFile({ name: 'a', contents: lines(30) }, { name: 'a', contents: lines(30, { 10: 'x', 15: 'y' }) }, { context: 3 })
    expect(hunksFromMetadata(meta)).toHaveLength(1)
  })

  it('matches a drawn hunk to the daemon\'s by overlapping lines, and picks lines inside a selection', () => {
    const before = lines(40)
    const after = lines(40, { 30: 'changed 30' })
    const [hunk] = hunksFromMetadata(parseDiffFromFile({ name: 'a', contents: before }, { name: 'a', contents: after }, { context: 3 }))
    const daemon = [
      { id: 'h1', oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 },
      { id: 'h2', oldStart: 27, oldLines: 7, newStart: 27, newLines: 7 }
    ]
    expect(matchDaemonHunk(hunk, daemon)?.id).toBe('h2')
    const daemonLines = [
      { kind: ' ' as const, newNo: 29, oldNo: 29 },
      { kind: '-' as const, oldNo: 30 },
      { kind: '+' as const, newNo: 30 },
      { kind: '+' as const, newNo: 31 }
    ]
    expect(lineIndexesIn(daemonLines, { side: 'additions', start: 31, end: 30 })).toEqual([2, 3])
    expect(lineIndexesIn(daemonLines, { side: 'deletions', start: 30, end: 30 })).toEqual([1])
  })
})

describe('choosing what to commit', () => {
  it('shows the Include boxes while choosing or while anything is left out, never where Include is off', () => {
    const all = { kind: 'all', total: 3 } as const
    const some = { kind: 'some', included: 2, total: 3 } as const
    expect(showIncludeChecks({ canInclude: true, choosing: false, selection: all })).toBe(false)
    expect(showIncludeChecks({ canInclude: true, choosing: true, selection: all })).toBe(true)
    // Esc leaves choosing, but a selection that leaves something out keeps its boxes.
    expect(showIncludeChecks({ canInclude: true, choosing: false, selection: some })).toBe(true)
    expect(showIncludeChecks({ canInclude: true, choosing: false, selection: { kind: 'none', total: 3 } })).toBe(true)
    expect(showIncludeChecks({ canInclude: false, choosing: true, selection: some })).toBe(false)
  })

  it('reads Commit 2 of 3 once a file is left out, and Commit all when everything is back in', () => {
    const file = (path: string, included: 'yes' | 'no' | 'partial') => ({ path, included }) as never
    expect(commitLabel(selectionFromChanges({ selection: { state: 'chosen', token: 't' }, files: [file('a', 'yes'), file('b', 'partial'), file('c', 'no')] }))).toBe('Commit 2 of 3')
    expect(commitLabel(selectionFromChanges({ selection: { state: 'chosen', token: 't' }, files: [file('a', 'yes'), file('b', 'yes')] }))).toBe('Commit all 2')
  })

  it('follows the turns that would make a write refuse with thread_busy', () => {
    const threads = [
      { id: 'own', projectId: 'p1', worktreeEnabled: true },
      { id: 'here', projectId: 'p1', worktreeEnabled: false },
      { id: 'elsewhere', projectId: 'p2', worktreeEnabled: false }
    ]
    const phases = (running: string[]) => (id: string) => (running.includes(id) ? 'running' : 'idle')
    // A thread's worktree: only that thread.
    expect(folderTurnRunning({ projectId: 'p1', workspaceThreadId: 'own' }, threads, phases(['here']))).toBe(false)
    expect(folderTurnRunning({ projectId: 'p1', workspaceThreadId: 'own' }, threads, phases(['own']))).toBe(true)
    // A project folder: any thread working in it, not one in its own worktree or another project.
    expect(folderTurnRunning({ projectId: 'p1', workspaceThreadId: null }, threads, phases(['own', 'elsewhere']))).toBe(false)
    expect(folderTurnRunning({ projectId: 'p1', workspaceThreadId: null }, threads, phases(['here']))).toBe(true)
    expect(folderTurnRunning({ projectId: 'p1', workspaceThreadId: null }, threads, () => undefined)).toBe(false)
  })

  it('maps a line selection onto the daemon hunks it touches, and Space includes unless all of them are in', () => {
    const hunks = [
      { id: 'h1', included: 'yes' as const, lines: [{ kind: ' ' as const, oldNo: 1, newNo: 1 }, { kind: '-' as const, oldNo: 2 }, { kind: '+' as const, newNo: 2 }] },
      { id: 'h2', included: 'no' as const, lines: [{ kind: '+' as const, newNo: 10 }, { kind: '+' as const, newNo: 11 }] }
    ]
    expect(lineChoicesFor(hunks, { side: 'additions', start: 2, end: 10 })).toEqual([{ hunk: 'h1', indexes: [2] }, { hunk: 'h2', indexes: [0] }])
    expect(lineChoicesFor(hunks, { side: 'deletions', start: 2, end: 2 })).toEqual([{ hunk: 'h1', indexes: [1] }])
    expect(lineChoicesFor(hunks, { side: 'additions', start: 20, end: 30 })).toEqual([])
    expect(includeValueForLines(hunks, [{ hunk: 'h1' }])).toBe(false)
    expect(includeValueForLines(hunks, [{ hunk: 'h1' }, { hunk: 'h2' }])).toBe(true)
  })
})

describe('restore reverted', () => {
  it("says what each revert took without repeating the row's path", () => {
    expect(revertedWhat({ path: 'src/a.ts', summary: '2 hunks of src/a.ts' })).toBe('2 hunks')
    expect(revertedWhat({ path: 'src/a.ts', summary: '1 line of src/a.ts' })).toBe('1 line')
    expect(revertedWhat({ path: 'src/a.ts', summary: 'src/a.ts' })).toBe('Whole file')
    expect(revertedWhat({ path: 'b.ts', oldPath: 'a.ts', summary: 'a.ts → b.ts' })).toBe('Whole file')
  })
})

describe('Uncommitted as HEAD → working tree', () => {
  const entry = (path: string, status: ReviewFileEntry['status'], additions: number, deletions = 0, extra: Partial<ReviewFileEntry> = {}): ReviewFileEntry =>
    ({ path, status, additions, deletions, binary: false, countsExact: true, ...extra })
  const list = (files: ReviewFileEntry[], range: { from: unknown; to: unknown }) =>
    ({ root: '/repo', scope: { kind: 'worktree' }, range, files, truncated: false, mergeCommits: 0 }) as never

  it("joins Git's staged and unstaged lists by path and remembers where each file came from", () => {
    const unstaged = list([entry('a.ts', 'modified', 1), entry('new.ts', 'untracked', 4)], { from: { kind: 'index' }, to: { kind: 'worktree' } })
    const staged = list([entry('a.ts', 'modified', 3, 1), entry('b.ts', 'added', 2), entry('c.ts', 'renamed', 0, 0, { oldPath: 'old.ts' })], { from: { kind: 'commit', sha: 'h' }, to: { kind: 'index' } })
    const { result, parts } = mergeUncommittedLists(unstaged, staged)
    expect(result.range).toEqual({ from: { kind: 'commit', sha: 'h' }, to: { kind: 'worktree' } })
    expect(Object.fromEntries(result.files.map((file) => [file.path, [file.status, file.additions, file.deletions, file.countsExact]]))).toEqual({
      'a.ts': ['modified', 4, 1, false],
      'b.ts': ['added', 2, 0, true],
      'c.ts': ['renamed', 0, 0, true],
      'new.ts': ['untracked', 4, 0, true]
    })
    expect(parts.get('a.ts')).toEqual({ staged: true, unstaged: true })
    expect(parts.get('b.ts')).toEqual({ staged: true, unstaged: false })
    expect(parts.get('new.ts')).toEqual({ staged: false, unstaged: true })
  })

  it('keeps an added or renamed file so, and a file removed from the working tree is deleted', () => {
    const unstaged = list([entry('b.ts', 'modified', 1), entry('c.ts', 'modified', 1), entry('d.ts', 'deleted', 0, 5)], { from: { kind: 'index' }, to: { kind: 'worktree' } })
    const staged = list([entry('b.ts', 'added', 2), entry('c.ts', 'renamed', 0, 0, { oldPath: 'old.ts' }), entry('d.ts', 'modified', 1)], { from: null, to: { kind: 'index' } })
    const files = mergeUncommittedLists(unstaged, staged).result.files
    expect(files.find((file) => file.path === 'b.ts')?.status).toBe('added')
    expect(files.find((file) => file.path === 'c.ts')).toMatchObject({ status: 'renamed', oldPath: 'old.ts' })
    expect(files.find((file) => file.path === 'd.ts')?.status).toBe('deleted')
  })

  it('falls back to the unstaged list when the staged one could not be read', () => {
    const unstaged = list([entry('a.ts', 'modified', 1)], { from: { kind: 'index' }, to: { kind: 'worktree' } })
    const { result, parts } = mergeUncommittedLists(unstaged, null)
    expect(result).toBe(unstaged)
    expect(parts.get('a.ts')).toEqual({ staged: false, unstaged: true })
  })

  it('reads HEAD from the staged diff and the working tree from the unstaged one', () => {
    const side = (content: string) => ({ content, size: content.length })
    const fromHead = { root: '/r', path: 'a.ts', original: side('head'), modified: side('index') }
    const fromIndex = { root: '/r', path: 'a.ts', original: side('index'), modified: side('work') }
    expect(combineUncommittedSides({ staged: true, unstaged: true }, fromHead, fromIndex)).toMatchObject({ original: side('head'), modified: side('work') })
    expect(combineUncommittedSides({ staged: true, unstaged: false }, fromHead, null)).toMatchObject({ original: side('head'), modified: side('index') })
    expect(combineUncommittedSides({ staged: false, unstaged: true }, null, fromIndex)).toMatchObject({ original: side('index'), modified: side('work') })
    // Added in the index: no HEAD side.
    expect(combineUncommittedSides({ staged: true, unstaged: true }, { ...fromHead, original: null }, fromIndex)?.original).toBeNull()
    expect(combineUncommittedSides({ staged: true, unstaged: true }, null, null)).toBeNull()
  })

  it("counts a file's lines from the daemon's hunks", () => {
    const hunk = (...kinds: Array<' ' | '-' | '+'>) => ({ lines: kinds.map((kind) => ({ kind })) })
    expect(hunkLineCounts({ hunks: [hunk(' ', '-', '+', '+'), hunk('+')] })).toEqual({ additions: 3, deletions: 1 })
    expect(hunkLineCounts({ hunks: [] })).toBeNull()
    expect(hunkLineCounts({ tooLarge: true, hunks: [hunk('+')] })).toBeNull()
  })
})
