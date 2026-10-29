import { describe, expect, it, vi } from 'vitest'
import type { ThreadActivityState } from '../src/shared/types'
import { threadDescendants, threadHasPendingWork, type ThreadIdleServices } from '../src/mms/lifecycle/threadIdle'

interface Stub {
  turn?: Set<string>; running?: Set<string>; runs?: Record<string, string>
  queue?: Record<string, number>; questions?: Set<string>; ptys?: Record<string, Array<{ ptyId: string; alive: boolean }>>
  activity?: Record<string, ThreadActivityState>; agents?: Record<string, string[]>; children?: Record<string, string>; execution?: string
}
function services(stub: Stub = {}) {
  const getOrHydrate = vi.fn()
  const pty = stub.ptys ?? {}
  const value: ThreadIdleServices & { threadRuntimes: { getOrHydrate: typeof getOrHydrate } } = {
    orchestrator: {
      isTurnActive: (id) => stub.turn?.has(id) ?? false,
      isActiveTurnRunning: (id) => stub.running?.has(id) ?? false
    },
    runEngine: { store: { listNonTerminalRuns: () => Object.entries(stub.runs ?? {}).map(([threadId, status]) => ({ threadId, status })) } },
    pendingQueueLength: (id) => stub.queue?.[id] ?? 0,
    questions: { listPendingForThread: (id) => stub.questions?.has(id) ? [{}] : [] },
    ptyManager: { list: (id) => (pty[id] ?? []).map(({ ptyId }) => ({ ptyId })), isAlive: (ptyId) => Object.values(pty).flat().find((entry) => entry.ptyId === ptyId)?.alive ?? false },
    threadRuntimes: {
      get: (id) => stub.agents?.[id] ? { agents: { list: () => stub.agents![id].map((status) => ({ status })) } } : undefined,
      getActivitySnapshot: () => stub.activity ?? {},
      getOrHydrate
    },
    executionBusy: () => stub.execution,
    listThreads: () => ['root', 'child', 'grandchild', 'other'].map((id) => ({ id, ...(stub.children?.[id] ? { lineage: { parentThreadId: stub.children[id], rootThreadId: 'root', relationship: 'subagent' as const } } : {}) }))
  }
  return value
}

describe('threadHasPendingWork', () => {
  it.each<[string, Stub, string]>([
    ['a running turn', { running: new Set(['root']) }, 'A turn is running'],
    ['an active turn session', { turn: new Set(['root']) }, 'A turn is running'],
    ['a starting run', { runs: { root: 'starting' } }, 'A run is active'],
    ['a running run', { runs: { root: 'running' } }, 'A run is active'],
    ['a run that is finalizing', { runs: { root: 'finalizing' } }, 'A run is active'],
    ['a queued run, which is how a held first turn shows', { runs: { root: 'queued' } }, 'A run is waiting to start'],
    ['a run paused until a usage limit resets, which is neither active nor queued', { runs: { root: 'paused' } }, 'A run is paused until a usage limit resets'],
    ['queued messages', { queue: { root: 2 } }, 'Messages are waiting in the queue'],
    ['a pending question', { questions: new Set(['root']) }, 'A question is waiting for an answer'],
    ['an open terminal', { ptys: { root: [{ ptyId: 'p1', alive: true }] } }, 'A terminal is open'],
    ['a waiting thread', { activity: { root: 'waiting' } }, 'The thread is working or waiting for input'],
    ['a thread that needs input', { activity: { root: 'awaiting_input' } }, 'The thread is working or waiting for input'],
    ['a working thread', { activity: { root: 'processing' } }, 'The thread is working or waiting for input'],
    ['a running agent', { agents: { root: ['running'] } }, 'An agent is running'],
    ['a starting agent', { agents: { root: ['starting'] } }, 'An agent is running'],
    ['a merging agent', { agents: { root: ['merging'] } }, 'An agent is running'],
    ['a workflow or chat that has not finished', { execution: 'A workflow is running or waiting' }, 'A workflow is running or waiting']
  ])('keeps a thread with %s', (_name, stub, reason) => {
    expect(threadHasPendingWork(services(stub), 'root')).toBe(reason)
  })

  it.each<[string, Stub]>([
    ['nothing at all', {}],
    ['a thread whose last turn completed', { activity: { root: 'completed' } }],
    ['an idle thread', { activity: { root: 'idle' } }],
    ['a thread whose terminal exited', { ptys: { root: [{ ptyId: 'p1', alive: false }] } }],
    ['agents that all finished', { agents: { root: ['completed', 'failed', 'interrupted'] } }],
    ['an interrupted agent state', { agents: { root: ['interrupted'] } }]
  ])('treats a thread with %s as idle', (_name, stub) => {
    expect(threadHasPendingWork(services(stub), 'root')).toBeUndefined()
  })

  it('a running descendant subagent at any depth makes the root busy; a finished one does not', () => {
    const children = { child: 'root', grandchild: 'child' }
    expect(threadHasPendingWork(services({ children, running: new Set(['grandchild']) }), 'root')).toBe('A subagent is busy: A turn is running')
    expect(threadHasPendingWork(services({ children, agents: { grandchild: ['running'] } }), 'root')).toBe('A subagent is busy: An agent is running')
    expect(threadHasPendingWork(services({ children, activity: { child: 'completed', grandchild: 'completed' }, agents: { child: ['completed'] } }), 'root')).toBeUndefined()
    expect(threadHasPendingWork(services({ children, running: new Set(['other']) }), 'root')).toBeUndefined()
    expect(threadHasPendingWork(services({ children, runs: { grandchild: 'paused' } }), 'root')).toBe('A subagent is busy: A run is paused until a usage limit resets')
  })

  it('asks the execution lookup about the thread and all its descendants', () => {
    const executionBusy = vi.fn().mockReturnValue(undefined)
    const stubbed = { ...services({ children: { child: 'root', grandchild: 'child' } }), executionBusy }
    threadHasPendingWork(stubbed, 'root')
    expect([...executionBusy.mock.calls[0][0]].sort()).toEqual(['child', 'grandchild', 'root'])
  })

  it('judges a thread with no loaded runtime without hydrating one', () => {
    const stubbed = services({ activity: {} })
    expect(threadHasPendingWork(stubbed, 'root')).toBeUndefined()
    expect(stubbed.threadRuntimes.getOrHydrate).not.toHaveBeenCalled()
  })
})

describe('threadDescendants', () => {
  it('walks lineage downwards and ignores unrelated threads', () => {
    const threads = [{ id: 'root' }, { id: 'a', lineage: { parentThreadId: 'root', rootThreadId: 'root', relationship: 'subagent' as const } }, { id: 'b', lineage: { parentThreadId: 'a', rootThreadId: 'root', relationship: 'subagent' as const } }, { id: 'z' }]
    expect(threadDescendants(threads, 'root').sort()).toEqual(['a', 'b'])
    expect(threadDescendants(threads, 'a')).toEqual(['b'])
    expect(threadDescendants(threads, 'z')).toEqual([])
  })
})
