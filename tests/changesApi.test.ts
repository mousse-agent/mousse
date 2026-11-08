import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changesApi,
  changesErrorText,
  commitSelectionFor,
  fileIncluded,
  mergeFiles,
  selectionEventMatches,
  withInclude,
  type ChangedFile,
  type ChangeHunk
} from '../src/renderer/components/changes/changesApi'
import { GUI_REQUIRED_METHODS } from '../src/main/mms/guiDaemonCompatibility'
import type { GitScope } from '../src/shared/types'

afterEach(() => vi.unstubAllGlobals())

const project: GitScope = { projectId: 'p1', workspaceThreadId: null }
const worktree: GitScope = { projectId: 'p1', workspaceThreadId: 't1' }

const hunk = (id: string, included: ChangeHunk['included'] = 'yes'): ChangeHunk => ({ id, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], included })
const file = (path: string, hunks: ChangeHunk[], extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  change: 'modified',
  kind: 'file',
  binary: false,
  wholeFileOnly: false,
  indexDiverged: false,
  tooLarge: false,
  version: `v-${path}`,
  hunks,
  included: fileIncluded(hunks, 'yes'),
  ...extra
})

describe('the Changes tab daemon calls', () => {
  it('are required of the local service, like the other panels\' methods', () => {
    for (const method of ['git.changes', 'git.include', 'git.undoLastCommit', 'git.revert', 'git.restoreReverted', 'git.revertedList']) {
      expect(GUI_REQUIRED_METHODS).toContain(method)
    }
  })

  it('name the folder by scope and pass the file and the choice as the preload declares them', async () => {
    const git = {
      changes: vi.fn(async () => ({ files: [], selection: { state: 'untouched', token: 'y' }, truncated: false })),
      include: vi.fn(async () => ({ selection: { state: 'chosen', token: 'x' } })),
      revert: vi.fn(async () => ({ revertId: 'r1', keptUntil: 1, path: 'a.ts', version: '' })),
      restoreReverted: vi.fn(async () => ({ restored: true })),
      revertedList: vi.fn(async () => []),
      undoLastCommit: vi.fn(async () => ({}))
    }
    vi.stubGlobal('window', { mousse: { git } })
    const target = file('a.ts', [hunk('h1')])

    await changesApi.changes(worktree)
    expect(git.changes).toHaveBeenLastCalledWith(worktree, undefined)
    await changesApi.changes(project, ['a.ts'])
    expect(git.changes).toHaveBeenLastCalledWith(project, { paths: ['a.ts'] })

    await changesApi.include(project, target, false, { hunks: ['h1'] })
    expect(git.include).toHaveBeenLastCalledWith(project, { path: 'a.ts', version: 'v-a.ts', include: false, hunks: ['h1'] })
    await expect(changesApi.includeAll(project, true)).resolves.toEqual({ state: 'chosen', token: 'x' })
    expect(git.include).toHaveBeenLastCalledWith(project, { all: true, include: true })

    await changesApi.revert(worktree, target, { lines: [{ hunk: 'h1', indexes: [2] }] })
    expect(git.revert).toHaveBeenLastCalledWith(worktree, { path: 'a.ts', version: 'v-a.ts', lines: [{ hunk: 'h1', indexes: [2] }] })
    await changesApi.restoreReverted(worktree, 'r1')
    expect(git.restoreReverted).toHaveBeenLastCalledWith(worktree, 'r1')
    await changesApi.revertedList(project)
    expect(git.revertedList).toHaveBeenLastCalledWith(project)
    await changesApi.undoLastCommit(project, 'abc123')
    expect(git.undoLastCommit).toHaveBeenLastCalledWith(project, 'abc123')
  })

  it('takes a selection event only for the folder it shows', () => {
    // A thread's worktree is named by the thread alone; a project folder by its project, with the thread working there or not.
    expect(selectionEventMatches(worktree, { threadId: 't1' })).toBe(true)
    expect(selectionEventMatches(worktree, { threadId: 't2' })).toBe(false)
    expect(selectionEventMatches(worktree, { projectId: 'p1', threadId: 't1' })).toBe(false)
    expect(selectionEventMatches(project, { projectId: 'p1' })).toBe(true)
    expect(selectionEventMatches(project, { projectId: 'p1', threadId: 't9' })).toBe(true)
    expect(selectionEventMatches(project, { projectId: 'p2' })).toBe(false)
    expect(selectionEventMatches(project, { threadId: 't1' })).toBe(false)
    expect(selectionEventMatches({ projectId: null, workspaceThreadId: null }, {})).toBe(false)
  })

  it('commits everything until something is chosen, then exactly the choice with its token', () => {
    expect(commitSelectionFor(null)).toBeUndefined()
    expect(commitSelectionFor({ state: 'untouched', token: 'a' })).toEqual({ mode: 'all' })
    expect(commitSelectionFor({ state: 'chosen', token: 'b' })).toEqual({ mode: 'chosen', token: 'b' })
  })

  it('words the new errors in a few plain words and leaves Git\'s own message otherwise', () => {
    const fallback = () => 'git said no'
    expect(changesErrorText({ code: 'thread_busy' }, fallback)).toBe('Wait for the turn to end')
    expect(changesErrorText({ code: 'nothing_selected' }, fallback)).toBe('Include something to commit')
    expect(changesErrorText({ code: 'git_undo_root' }, fallback)).toBe("The first commit can't be undone")
    expect(changesErrorText({ code: 'git_failed' }, fallback)).toBe('git said no')
  })
})

describe('a choice shown before Git confirms it', () => {
  it('leaves out or includes a whole file with all its hunks', () => {
    const shown = withInclude(file('a.ts', [hunk('h1'), hunk('h2', 'partial')]), false)
    expect(shown.included).toBe('no')
    expect(shown.hunks.map((item) => item.included)).toEqual(['no', 'no'])
    expect(withInclude(shown, true).included).toBe('yes')
  })

  it('leaves out one hunk, and the file reads partly included', () => {
    const shown = withInclude(file('a.ts', [hunk('h1'), hunk('h2')]), false, { hunks: ['h2'] })
    expect(shown.hunks.map((item) => item.included)).toEqual(['yes', 'no'])
    expect(shown.included).toBe('partial')
    // Including it again makes the file whole again.
    expect(withInclude(shown, true, { hunks: ['h2'] }).included).toBe('yes')
  })

  it('marks a hunk partly included when some of its lines change', () => {
    const shown = withInclude(file('a.ts', [hunk('h1'), hunk('h2')]), false, { lines: [{ hunk: 'h1', indexes: [0] }] })
    expect(shown.hunks.map((item) => item.included)).toEqual(['partial', 'yes'])
    expect(shown.included).toBe('partial')
    // Lines of a hunk already in that state leave it as it is.
    expect(withInclude(shown, true, { lines: [{ hunk: 'h2', indexes: [0] }] }).hunks[1].included).toBe('yes')
  })

  it('keeps a file without hunks (binary, rename) as it was unless the whole file is chosen', () => {
    expect(fileIncluded([], 'no')).toBe('no')
    expect(withInclude(file('img.png', [], { binary: true, wholeFileOnly: true }), false).included).toBe('no')
  })

  it('puts re-read files back in place, so no row moves, and drops paths no longer changed', () => {
    const current = [file('a.ts', []), file('b.ts', []), file('c.ts', [])]
    const freshB = file('b.ts', [hunk('h9')])
    expect(mergeFiles(current, ['b.ts'], [freshB]).map((item) => item.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(mergeFiles(current, ['b.ts'], [freshB])[1]).toBe(freshB)
    expect(mergeFiles(current, ['b.ts'], []).map((item) => item.path)).toEqual(['a.ts', 'c.ts'])
    // A rename read under its new path takes the old entry's place by its old path.
    const renamed = file('d.ts', [], { oldPath: 'c.ts', change: 'renamed' })
    expect(mergeFiles([file('a.ts', []), file('c.ts', []), file('e.ts', [])], ['d.ts', 'c.ts'], [renamed]).map((item) => item.path)).toEqual(['a.ts', 'd.ts', 'e.ts'])
  })
})
