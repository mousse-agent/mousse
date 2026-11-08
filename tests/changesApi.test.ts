import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changesApi,
  changesApiAvailable,
  changesErrorText,
  changesTarget,
  commitSelectionFor,
  revertAvailable,
  undoLastCommitAvailable
} from '../src/renderer/components/changes/changesApi'

afterEach(() => vi.unstubAllGlobals())

describe('the Changes tab daemon calls', () => {
  it('stays off until the preload exposes the methods, and Revert only with its restore', () => {
    vi.stubGlobal('window', { mousse: { git: { status: vi.fn() } } })
    expect(changesApiAvailable()).toBe(false)
    expect(revertAvailable()).toBe(false)
    expect(undoLastCommitAvailable()).toBe(false)
    vi.stubGlobal('window', { mousse: { git: { changes: vi.fn(), include: vi.fn(), revert: vi.fn() } } })
    expect(changesApiAvailable()).toBe(true)
    expect(revertAvailable()).toBe(false)
    vi.stubGlobal('window', { mousse: { git: { changes: vi.fn(), include: vi.fn(), revert: vi.fn(), restoreReverted: vi.fn(), revertedList: vi.fn(), undoLastCommit: vi.fn() } } })
    expect(revertAvailable()).toBe(true)
    expect(undoLastCommitAvailable()).toBe(true)
  })

  it('names the folder by the thread whose worktree it is, else the project', () => {
    expect(changesTarget({ projectId: 'p1', workspaceThreadId: 't1' })).toEqual({ threadId: 't1' })
    expect(changesTarget({ projectId: 'p1', workspaceThreadId: null })).toEqual({ projectId: 'p1' })
    expect(changesTarget({ projectId: null, workspaceThreadId: null })).toBeNull()
  })

  it('sends the target with the input as one params object', async () => {
    const include = vi.fn(async () => ({ selection: { state: 'chosen', token: 'x' } }))
    const changes = vi.fn(async () => ({ files: [], selection: { state: 'untouched', token: 'y' }, truncated: false }))
    vi.stubGlobal('window', { mousse: { git: { include, changes } } })
    await changesApi.include({ projectId: 'p1' }, { path: 'a.ts', version: 'v1', include: false, hunks: ['h1'] })
    expect(include).toHaveBeenCalledWith({ projectId: 'p1', path: 'a.ts', version: 'v1', include: false, hunks: ['h1'] })
    await changesApi.changes({ threadId: 't1' }, ['a.ts'])
    expect(changes).toHaveBeenCalledWith({ threadId: 't1', paths: ['a.ts'] })
  })

  it('refuses with a code when a method is missing, and listens to nothing without the event', () => {
    vi.stubGlobal('window', { mousse: { git: {} } })
    expect(() => changesApi.revertedList({ projectId: 'p1' })).toThrow(expect.objectContaining({ code: 'unavailable' }))
    expect(changesApi.onSelectionChanged(() => undefined)).toBeTypeOf('function')
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
    expect(changesErrorText({ code: 'git_failed' }, fallback)).toBe('git said no')
  })
})
