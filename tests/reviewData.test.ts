import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadActionHistory } from '../src/renderer/utils/threadActionHistory'
import type { ThreadAction } from '../src/shared/threadActions'
import { readReviewHistory, readWorkspaceAvailability, turnReturnedToIdle } from '../src/renderer/components/review/reviewData'
import { turnChoices } from '../src/renderer/components/review/reviewModel'

const action = (state: ThreadAction['state']): ThreadAction =>
  ({
    id: 'action-1',
    turnId: 'run:thread:t1:ordinal:1',
    state,
    // `beginTurn` starts an action with equal SHAs and empty arrays; the checkpoint fills them in.
    startSha: 'a'.repeat(40),
    endSha: state === 'running' ? 'a'.repeat(40) : 'b'.repeat(40),
    commits: [],
    changedPaths: state === 'running' ? [] : [{ path: 'a.ts' }],
    createdAt: '2026-10-26T10:00:00.000Z'
  }) as unknown as ThreadAction

const history = (...actions: ThreadAction[]): ThreadActionHistory =>
  ({ actions, receipts: [], journalGeneration: 1 }) as ThreadActionHistory

describe('reading the history the picker lists', () => {
  const list = vi.fn()

  beforeEach(() => {
    list.mockReset()
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, mousse: { actions: { list } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reuses a read made moments ago when nothing asks for a fresh one', async () => {
    list.mockResolvedValue(history(action('running')))
    await readReviewHistory('cached-thread')
    await readReviewHistory('cached-thread')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('reads again after a turn finished, instead of keeping the turn in progress', async () => {
    // The turn row read the history mid-checkpoint a moment ago, so the cache holds the running action.
    list.mockResolvedValueOnce(history(action('running'))).mockResolvedValueOnce(history(action('completed')))
    const before = await readReviewHistory('finished-thread')
    expect(turnChoices(before.actions, [])[0].label).toContain('(in progress)')

    const after = await readReviewHistory('finished-thread', { fresh: true })
    expect(list).toHaveBeenCalledTimes(2)
    const [choice] = turnChoices(after.actions, [])
    expect(choice.running).toBe(false)
    expect(choice.label).not.toContain('(in progress)')
  })

  it('does not hand back a read that is still in flight when the user presses refresh', async () => {
    let finishStale!: (value: ThreadActionHistory) => void
    list.mockReturnValueOnce(new Promise<ThreadActionHistory>((resolve) => { finishStale = resolve }))
    list.mockResolvedValueOnce(history(action('completed')))

    const stale = readReviewHistory('inflight-thread')
    const refreshed = await readReviewHistory('inflight-thread', { fresh: true })
    expect(list).toHaveBeenCalledTimes(2)
    expect(refreshed.actions[0].state).toBe('completed')

    finishStale(history(action('running')))
    expect((await stale).actions[0].state).toBe('running')
  })

  it('only drops the entry of the thread being refreshed', async () => {
    list.mockResolvedValue(history(action('completed')))
    await readReviewHistory('thread-a')
    await readReviewHistory('thread-b')
    list.mockClear()
    await readReviewHistory('thread-a', { fresh: true })
    await readReviewHistory('thread-b')
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith('thread-a')
  })
})

describe('turnReturnedToIdle', () => {
  it('is true only when a running turn settles', () => {
    expect(turnReturnedToIdle('streaming', 'idle')).toBe(true)
    expect(turnReturnedToIdle('tool_running', 'idle')).toBe(true)
    expect(turnReturnedToIdle('idle', 'idle')).toBe(false)
    expect(turnReturnedToIdle('idle', 'thinking')).toBe(false)
    expect(turnReturnedToIdle('streaming', 'tool_running')).toBe(false)
    expect(turnReturnedToIdle(undefined, 'idle')).toBe(false)
  })
})

describe('readWorkspaceAvailability', () => {
  const getStatus = vi.fn()

  beforeEach(() => {
    getStatus.mockReset()
    vi.stubGlobal('window', { mousse: { workspace: { getStatus } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports a ready worktree of its own', async () => {
    getStatus.mockResolvedValue({
      metadata: { lifecycle: 'ready' },
      execution: { lifecycle: 'ready', workspacePath: '/wt/thread', primaryPath: '/repo' }
    })
    expect(await readWorkspaceAvailability('t1')).toBe('own')
  })

  it.each([
    ['a thread that was never provisioned', { metadata: null, execution: { lifecycle: 'unprovisioned', workspacePath: '/repo', primaryPath: '/repo' } }],
    ['a workspace that needs recovery', { metadata: { lifecycle: 'degraded' }, execution: { lifecycle: 'degraded', workspacePath: '/wt/thread', primaryPath: '/repo' } }],
    ['a thread working in the primary checkout', { metadata: { lifecycle: 'ready' }, execution: { lifecycle: 'ready', workspacePath: '/repo', primaryPath: '/repo' } }]
  ])('reports shared for %s', async (_name, status) => {
    getStatus.mockResolvedValue(status)
    expect(await readWorkspaceAvailability('t1')).toBe('shared')
  })

  it('reports shared when the status cannot be read', async () => {
    getStatus.mockRejectedValue(new Error('daemon down'))
    expect(await readWorkspaceAvailability('t1')).toBe('shared')
  })
})
