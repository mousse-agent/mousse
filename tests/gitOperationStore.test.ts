import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitOperationStatusView } from '../src/renderer/components/git/GitOperationStatus'
import { runSync } from '../src/renderer/components/git/gitPanelActions'
import {
  applyOperationEvent,
  describeOperation,
  formatElapsed,
  MAX_OPERATION_LINES,
  newOperationState,
  type GitOperationState
} from '../src/renderer/components/git/gitOperationLogic'
import {
  beginGitOperation,
  cancelGitOperation,
  dismissGitOperation,
  finishGitOperation,
  gitOperationOwner,
  receiveGitOperationEvent,
  trackGitOperation,
  useGitOperationStore
} from '../src/renderer/stores/gitOperationStore'
import type { GitOperationEvent, GitOperationKind } from '../src/shared/types'
import type { SyncActivity } from '../src/renderer/components/git/gitPanelLogic'

const event = (patch: Partial<GitOperationEvent> & Pick<GitOperationEvent, 'phase'>): GitOperationEvent => ({
  operationId: 'op-1', kind: 'push', path: '/repo', at: 1_000, ...patch
})
const running = (kind: GitOperationKind = 'push', startedAt = 0): GitOperationState =>
  applyOperationEvent(newOperationState('op-1', kind, startedAt), event({ kind, phase: 'started', cancellable: kind !== 'checkout' }))

describe('formatElapsed', () => {
  it('counts seconds, then minutes and seconds, then hours and minutes', () => {
    expect([0, 999, 12_000, 59_999, 60_000, 65_000, 3_599_000, 3_600_000, 3_720_000].map(formatElapsed)).toEqual(['0s', '0s', '12s', '59s', '1m 00s', '1m 05s', '59m 59s', '1h 00m', '1h 02m'])
    expect(formatElapsed(-5)).toBe('0s')
  })
})

describe('following an action', () => {
  it('starts, runs a hook, collects output and ends with the daemon\'s outcome', () => {
    let state = newOperationState('op-1', 'push', 0)
    expect(state.phase).toBe('starting')
    state = applyOperationEvent(state, event({ phase: 'started', cancellable: true }))
    expect(state).toMatchObject({ phase: 'running', cancellable: true })
    state = applyOperationEvent(state, event({ phase: 'hook', hook: { name: 'pre-push' } }))
    state = applyOperationEvent(state, event({ phase: 'output', lines: ['a', 'b'] }))
    state = applyOperationEvent(state, event({ phase: 'output', lines: ['c'] }))
    expect(state.hook).toEqual({ name: 'pre-push' })
    expect(state.lines).toEqual(['a', 'b', 'c'])
    state = applyOperationEvent(state, event({ phase: 'failed', message: 'pre-push hook failed (exit 1)', at: 5_000 }))
    expect(state).toMatchObject({ phase: 'failed', message: 'pre-push hook failed (exit 1)', endedAt: 5_000 })
  })

  it('keeps the last 200 lines', () => {
    const lines = Array.from({ length: 450 }, (_, index) => `line ${index}`)
    const state = applyOperationEvent(running(), event({ phase: 'output', lines }))
    expect(state.lines).toHaveLength(MAX_OPERATION_LINES)
    expect(state.lines[0]).toBe('line 250')
    expect(state.lines.at(-1)).toBe('line 449')
  })

  it('ignores another action\'s events, and a second ending after the first', () => {
    const state = running()
    expect(applyOperationEvent(state, event({ operationId: 'other', phase: 'output', lines: ['x'] }))).toBe(state)
    const ended = applyOperationEvent(state, event({ phase: 'cancelled' }))
    expect(ended.phase).toBe('cancelled')
    expect(applyOperationEvent(ended, event({ phase: 'done' })).phase).toBe('cancelled')
    expect(applyOperationEvent(ended, event({ phase: 'started', cancellable: true })).phase).toBe('cancelled')
  })
})

describe('what the status says', () => {
  it('shows the verb, the elapsed time, the running hook and the newest line', () => {
    let state = running('push', 0)
    state = applyOperationEvent(state, event({ phase: 'hook', hook: { name: 'pre-push' } }))
    state = applyOperationEvent(state, event({ phase: 'output', lines: ['first', 'Writing objects: 40%'] }))
    expect(describeOperation(state, 65_000)).toMatchObject({ headline: 'Pushing…', elapsed: '1m 05s', hook: 'pre-push', lastLine: 'Writing objects: 40%', running: true, cancelLabel: 'Cancel' })
    // Once the hook ended it is no longer named.
    state = applyOperationEvent(state, event({ phase: 'hook', hook: { name: 'pre-push', exitCode: 0 } }))
    expect(describeOperation(state, 66_000).hook).toBeNull()
  })

  it('names each kind of action', () => {
    const verbs = (['push', 'pull', 'fetch', 'commit', 'checkout'] as const).map((kind) => describeOperation(running(kind), 0).headline)
    expect(verbs).toEqual(['Pushing…', 'Pulling…', 'Fetching…', 'Committing…', 'Switching branch…'])
  })

  it('offers Cancel from the start (a lost first event cannot hide it) except for a branch switch', () => {
    expect(describeOperation(newOperationState('op-1', 'push', 0), 0).cancelLabel).toBe('Cancel')
    expect(describeOperation(newOperationState('op-1', 'checkout', 0), 0).cancelLabel).toBeNull()
    expect(describeOperation(running('checkout'), 0).cancelLabel).toBeNull()
    expect(describeOperation(running('pull'), 0)).toMatchObject({ cancelLabel: 'Cancel', cancelHint: expect.stringContaining('download') })
    expect(describeOperation(running('push'), 0).cancelHint).toBeNull()
  })

  it('takes Cancel away when a pull starts to change files, and says so', () => {
    const merging = applyOperationEvent(running('pull'), event({ kind: 'pull', phase: 'integrating', cancellable: false }))
    expect(describeOperation(merging, 0)).toMatchObject({ headline: 'Updating files…', cancelLabel: null, cancelHint: null, running: true })
    // A late `started` cannot give it back.
    expect(applyOperationEvent(merging, event({ kind: 'pull', phase: 'started', cancellable: true })).cancellable).toBe(false)
    expect(describeOperation(applyOperationEvent(merging, event({ kind: 'pull', phase: 'done' })), 0).headline).toBe('Pull finished')
  })

  it('offers Cancel only while it can work', () => {
    expect(describeOperation({ ...running(), cancelling: true }, 0)).toMatchObject({ headline: 'Cancelling…', cancelLabel: null })
    expect(describeOperation(applyOperationEvent(running(), event({ phase: 'done' })), 0)).toMatchObject({ cancelLabel: null, running: false })
  })

  it('says how an ended action ended, without a clock', () => {
    const failed = applyOperationEvent(running('fetch'), event({ kind: 'fetch', phase: 'failed' }))
    const cancelled = applyOperationEvent(running('pull'), event({ kind: 'pull', phase: 'cancelled' }))
    expect(describeOperation(failed, 9_000)).toMatchObject({ headline: 'Fetch failed', elapsed: null, ended: true })
    expect(describeOperation(cancelled, 9_000)).toMatchObject({ headline: 'Pull cancelled', elapsed: null, ended: true })
  })

  it('cuts a very long line', () => {
    const state = applyOperationEvent(running(), event({ phase: 'output', lines: ['y'.repeat(300)] }))
    expect(describeOperation(state, 0).lastLine).toBe(`${'y'.repeat(100)}…`)
  })
})

describe('the status markup', () => {
  const markup = (state: GitOperationState, now = 0) => renderToStaticMarkup(createElement(GitOperationStatusView, { state, now, onCancel: () => undefined, onDismiss: () => undefined }))

  it('shows a running push with its hook, its last line, the clock, Cancel and the output', () => {
    let state = running('push', 0)
    state = applyOperationEvent(state, event({ phase: 'hook', hook: { name: 'pre-push' } }))
    state = applyOperationEvent(state, event({ phase: 'output', lines: ['one', 'two'] }))
    const html = markup(state, 65_000)
    expect(html).toContain('Pushing…')
    expect(html).toContain('pre-push')
    expect(html).toContain('>two<')
    expect(html).toContain('1m 05s')
    expect(html).toContain('>Cancel<')
    expect(html).toContain('Show output')
    expect(html).toContain('one\ntwo')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('Dismiss')
  })

  it('shows a failed action with its output and Dismiss, and no Cancel', () => {
    const state = applyOperationEvent(applyOperationEvent(running('commit'), event({ kind: 'commit', phase: 'output', lines: ['hook says no'] })), event({ kind: 'commit', phase: 'failed' }))
    const html = markup(state)
    expect(html).toContain('Commit failed')
    expect(html).toContain('hook says no')
    expect(html).toContain('>Dismiss<')
    expect(html).not.toContain('>Cancel')
    expect(html).toContain('data-phase="failed"')
  })

  it('has no output disclosure before there is output', () => {
    expect(markup(running())).not.toContain('Show output')
  })

  it('does not show Cancel for a branch switch', () => {
    expect(markup(running('checkout'))).not.toContain('Cancel')
  })
})

describe('the operation store', () => {
  let subscribed: ((event: GitOperationEvent) => void) | null = null
  const cancelOperation = vi.fn(async (_id: string) => ({ cancelled: true }))
  beforeEach(() => {
    useGitOperationStore.setState({ operations: {}, waiting: {} })
    cancelOperation.mockClear()
    cancelOperation.mockImplementation(async () => ({ cancelled: true }))
    vi.stubGlobal('window', { mousse: { git: { onOperation: (cb: (event: GitOperationEvent) => void) => { subscribed = cb; return () => undefined }, cancelOperation } } })
  })
  afterEach(() => { vi.unstubAllGlobals() })
  const op = (path = '/repo') => useGitOperationStore.getState().operations[path]

  it('registers an action by path, and routes the daemon\'s events to it by id', () => {
    const id = beginGitOperation('/repo', 'push', 100)
    expect(op()).toMatchObject({ operationId: id, kind: 'push', phase: 'starting', startedAt: 100 })
    expect(subscribed).not.toBeNull()
    subscribed!({ operationId: id, kind: 'push', path: '/elsewhere', phase: 'started', cancellable: true, at: 1 })
    subscribed!({ operationId: id, kind: 'push', path: '/elsewhere', phase: 'output', lines: ['hello'], at: 2 })
    subscribed!({ operationId: 'someone-else', kind: 'push', path: '/repo', phase: 'output', lines: ['stranger'], at: 3 })
    expect(op()).toMatchObject({ phase: 'running', cancellable: true, lines: ['hello'] })
    receiveGitOperationEvent({ operationId: 'unknown', kind: 'fetch', path: '/repo', phase: 'done', at: 4 })
    expect(op().phase).toBe('running')
  })

  it('keeps folders apart', () => {
    const a = beginGitOperation('/repo/a', 'fetch'), b = beginGitOperation('/repo/b', 'pull')
    receiveGitOperationEvent({ operationId: b, kind: 'pull', path: '/repo/b', phase: 'output', lines: ['only b'], at: 1 })
    expect(op('/repo/a').lines).toEqual([])
    expect(op('/repo/b').lines).toEqual(['only b'])
    expect(a).not.toBe(b)
  })

  it('drops a finished action and keeps a failed one with its output until the next action', () => {
    const first = beginGitOperation('/repo', 'commit')
    receiveGitOperationEvent({ operationId: first, kind: 'commit', path: '/repo', phase: 'output', lines: ['hook says no'], at: 1 })
    finishGitOperation('/repo', first, 'failed', 'commit hook failed', 9)
    expect(op()).toMatchObject({ phase: 'failed', message: 'commit hook failed', lines: ['hook says no'], endedAt: 9 })
    const second = beginGitOperation('/repo', 'commit')
    expect(op()).toMatchObject({ operationId: second, phase: 'starting', lines: [] })
    // The first action's late outcome cannot touch the second.
    finishGitOperation('/repo', first, 'failed', 'late')
    expect(op().operationId).toBe(second)
    finishGitOperation('/repo', second, 'done')
    expect(op()).toBeUndefined()
  })

  it('records the outcome of a request: success clears, a cancel is shown as cancelled, any other error as failed', async () => {
    await expect(trackGitOperation('/repo', 'fetch', async () => 'ok')).resolves.toBe('ok')
    expect(op()).toBeUndefined()
    await expect(trackGitOperation('/repo', 'pull', async () => { throw Object.assign(new Error('Cancelled.'), { code: 'git_cancelled' }) })).rejects.toThrow('Cancelled.')
    expect(op()).toMatchObject({ phase: 'cancelled', kind: 'pull' })
    await expect(trackGitOperation('/repo', 'push', async () => { throw Object.assign(new Error('The remote refused the sign-in.'), { code: 'git_auth_failed' }) })).rejects.toThrow('sign-in')
    expect(op()).toMatchObject({ phase: 'failed', message: 'The remote refused the sign-in.' })
  })

  it('passes the id the request runs under', async () => {
    let seen = ''
    await trackGitOperation('/repo', 'push', async (operationId) => { seen = operationId; expect(op().operationId).toBe(operationId) })
    expect(seen).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('cancels by asking the daemon for this action once it can be cancelled', async () => {
    const id = beginGitOperation('/repo', 'push')
    receiveGitOperationEvent({ operationId: id, kind: 'push', path: '/repo', phase: 'started', cancellable: true, at: 1 })
    const first = cancelGitOperation('/repo')
    expect(op().cancelling).toBe(true)
    await cancelGitOperation('/repo')
    await first
    expect(cancelOperation).toHaveBeenCalledTimes(1)
    expect(cancelOperation).toHaveBeenCalledWith(id)
    receiveGitOperationEvent({ operationId: id, kind: 'push', path: '/repo', phase: 'cancelled', at: 2 })
    expect(op()).toMatchObject({ phase: 'cancelled', cancelling: false })
  })

  it('brings the Cancel button back when the daemon says the action cannot be stopped', async () => {
    const id = beginGitOperation('/repo', 'push')
    receiveGitOperationEvent({ operationId: id, kind: 'push', path: '/repo', phase: 'started', cancellable: true, at: 1 })
    cancelOperation.mockImplementationOnce(async () => ({ cancelled: false }))
    await cancelGitOperation('/repo')
    expect(op().cancelling).toBe(false)
    cancelOperation.mockImplementationOnce(async () => { throw new Error('gone') })
    await cancelGitOperation('/repo')
    expect(op().cancelling).toBe(false)
  })

  it('does not cancel a branch switch, or a pull that has begun to merge', async () => {
    beginGitOperation('/switch', 'checkout')
    await cancelGitOperation('/switch')
    const pull = beginGitOperation('/pull', 'pull')
    receiveGitOperationEvent({ operationId: pull, kind: 'pull', path: '/pull', phase: 'integrating', cancellable: false, at: 1 })
    await cancelGitOperation('/pull')
    expect(cancelOperation).not.toHaveBeenCalled()
  })

  it("names the thread to the daemon when the folder is a thread's own worktree, and only then", async () => {
    const threadId = 'nod_0123456789abcdefghjkmnpqrs:thread-1'
    const inThread = beginGitOperation('/worktree', 'push', 1, { threadId })
    expect(op('/worktree').threadId).toBe(threadId)
    await cancelGitOperation('/worktree')
    expect(cancelOperation).toHaveBeenLastCalledWith(inThread, threadId)
    let tracked = ''
    // The request never ends here: the action stays running for Cancel.
    void trackGitOperation('/tracked', 'fetch', (operationId) => { tracked = operationId; return new Promise(() => undefined) }, { threadId })
    expect(op('/tracked').threadId).toBe(threadId)
    await cancelGitOperation('/tracked')
    expect(cancelOperation).toHaveBeenLastCalledWith(tracked, threadId)
    const inProject = beginGitOperation('/repo', 'push')
    expect(op().threadId).toBeUndefined()
    await cancelGitOperation('/repo')
    expect(cancelOperation.mock.lastCall).toEqual([inProject])
  })

  it("names the project to the daemon when the folder is a project's on another computer", async () => {
    const projectId = 'nod_0123456789abcdefghjkmnpqrs:project-1'
    const id = beginGitOperation('/remote-repo', 'pull', 1, { projectId })
    expect(op('/remote-repo')).toMatchObject({ projectId })
    expect(op('/remote-repo').threadId).toBeUndefined()
    await cancelGitOperation('/remote-repo')
    expect(cancelOperation.mock.lastCall).toEqual([id, undefined, projectId])
  })

  it('takes the owner from the scope: a thread or project of another computer, nothing for this one', () => {
    const remoteThread = 'nod_0123456789abcdefghjkmnpqrs:thread-1'
    const remoteProject = 'nod_0123456789abcdefghjkmnpqrs:project-1'
    expect(gitOperationOwner({ projectId: remoteProject, workspaceThreadId: remoteThread })).toEqual({ threadId: remoteThread })
    expect(gitOperationOwner({ projectId: remoteProject, workspaceThreadId: null })).toEqual({ projectId: remoteProject })
    expect(gitOperationOwner({ projectId: 'p', workspaceThreadId: 'thread-1' })).toBeUndefined()
    expect(gitOperationOwner({ projectId: 'p', workspaceThreadId: null })).toBeUndefined()
    expect(gitOperationOwner({ projectId: null, workspaceThreadId: null })).toBeUndefined()
  })

  it('asks to cancel at once, before the first event, since the daemon registers the action first', async () => {
    const id = beginGitOperation('/repo', 'fetch')
    await cancelGitOperation('/repo')
    expect(cancelOperation).toHaveBeenCalledWith(id)
  })

  it('keeps a running action, its output and its Cancel on screen when another starts on the folder', async () => {
    const first = beginGitOperation('/repo', 'push')
    receiveGitOperationEvent({ operationId: first, kind: 'push', path: '/repo', phase: 'started', cancellable: true, at: 1 })
    receiveGitOperationEvent({ operationId: first, kind: 'push', path: '/repo', phase: 'output', lines: ['pre-push is running'], at: 2 })
    const second = beginGitOperation('/repo', 'fetch')
    expect(op()).toMatchObject({ operationId: first, lines: ['pre-push is running'], cancellable: true })
    // The second one's events find it while it waits.
    receiveGitOperationEvent({ operationId: second, kind: 'fetch', path: '/repo', phase: 'output', lines: ['from the fetch'], at: 3 })
    expect(op().operationId).toBe(first)
    expect(op().lines).toEqual(['pre-push is running'])
    // Cancel acts on the shown one.
    await cancelGitOperation('/repo')
    expect(cancelOperation).toHaveBeenCalledWith(first)
    // When the first ends, the second takes its place with what it printed meanwhile.
    finishGitOperation('/repo', first, 'done')
    expect(op()).toMatchObject({ operationId: second, lines: ['from the fetch'] })
    finishGitOperation('/repo', second, 'done')
    expect(op()).toBeUndefined()
  })

  it('shows the next waiting action when the shown one is dismissed or ends by failing, and drops a waiting one that ends unseen', () => {
    const first = beginGitOperation('/repo', 'push')
    const second = beginGitOperation('/repo', 'fetch')
    const third = beginGitOperation('/repo', 'pull')
    finishGitOperation('/repo', second, 'failed', 'no remote')
    receiveGitOperationEvent({ operationId: first, kind: 'push', path: '/repo', phase: 'failed', message: 'rejected', at: 1 })
    expect(op()).toMatchObject({ operationId: third, phase: 'starting' })
    expect(useGitOperationStore.getState().waiting['/repo']).toBeUndefined()
    finishGitOperation('/repo', third, 'failed', 'later')
    expect(op()).toMatchObject({ operationId: third, phase: 'failed' })
    dismissGitOperation('/repo')
    expect(op()).toBeUndefined()
  })

  it('dismisses an outcome', () => {
    const id = beginGitOperation('/repo', 'fetch')
    finishGitOperation('/repo', id, 'failed', 'no remote')
    dismissGitOperation('/repo')
    expect(op()).toBeUndefined()
  })
})

describe('the panel after a cancel', () => {
  it('reports a cancelled fetch or pull as an outcome, not as a failure', async () => {
    const cancelled = vi.fn(async () => { throw Object.assign(new Error('Cancelled.'), { code: 'git_cancelled' }) })
    vi.stubGlobal('window', { mousse: { git: { fetch: cancelled, pull: cancelled, status: vi.fn(async () => ({ isRepo: false })), log: vi.fn(async () => []), branches: vi.fn(async () => ({ current: null, branches: [] })), diffStats: vi.fn(async () => ({ additions: 0, deletions: 0, filesChanged: 0 })) } }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    try {
      const activity: SyncActivity[] = []
      await runSync('/repo', { projectId: 'p', workspaceThreadId: null }, { action: 'fetch' }, (value) => activity.push(value))
      await runSync('/repo', { projectId: 'p', workspaceThreadId: null }, { action: 'pull', strategy: 'ff-only' }, (value) => activity.push(value))
      expect(activity.filter((value) => value.phase !== 'running')).toEqual([
        { phase: 'done', action: 'fetch', message: 'Fetch cancelled' },
        { phase: 'done', action: 'pull', message: 'Pull cancelled' }
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
