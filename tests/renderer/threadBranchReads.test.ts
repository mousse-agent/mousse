// @vitest-environment jsdom
/**
 * Thread cards name their branch from one `git.heads` call for every card shown, never a Git status read. They read
 * again together on window focus, for the thread whose run ended (and every project), and for a thread whose branch
 * Mousse changed (`git.headsChanged`). A read that fails keeps what the cards show, and is read again a while later.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitHeadsChangedEvent, GitHeadsRequest, GitHeadsResult } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let hook: typeof import('../../src/renderer/hooks/useThreadBranch')
let appStore: typeof import('../../src/renderer/stores/appStore')['useAppStore']
let calls: GitHeadsRequest[]
let answer: (request: GitHeadsRequest) => Promise<GitHeadsResult>
let headsChanged: ((event: GitHeadsChangedEvent) => void) | undefined

const THREADS = [
  { id: 't1', projectId: 'p1' },
  { id: 't2', projectId: 'p1' },
  { id: 't3', projectId: 'p2', worktreeEnabled: false }
]
let branches: Record<string, string>

function bridge() {
  const fail = () => { throw new Error('a card must not run a Git status read') }
  ;(window as unknown as { mousse: unknown }).mousse = {
    git: {
      status: fail,
      heads: vi.fn((request: GitHeadsRequest) => { calls.push(request); return answer(request) }),
      onHeadsChanged: (cb: (event: GitHeadsChangedEvent) => void) => { headsChanged = cb; return () => { headsChanged = undefined } }
    },
    workspace: { getStatus: fail }
  }
}

const fromBranches = async (request: GitHeadsRequest): Promise<GitHeadsResult> => ({
  projects: Object.fromEntries((request.projectIds ?? []).map((id) => [id, { repo: true, branch: branches[id]! }])),
  threads: Object.fromEntries((request.threadIds ?? []).map((id) => [id, { own: true, branch: branches[id]! }]))
})

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1); for (let pass = 0; pass < 8; pass++) await Promise.resolve() })
}

function showCards() {
  const Card = ({ thread }: { thread: (typeof THREADS)[number] }) => {
    const branch = hook.useThreadBranch(thread, thread.id)
    return createElement('li', { 'data-id': thread.id }, branch?.branch ?? '')
  }
  act(() => root.render(createElement('ul', null, ...THREADS.map((thread) => createElement(Card, { key: thread.id, thread })))))
}
const shown = () => THREADS.map((thread) => host.querySelector(`[data-id="${thread.id}"]`)?.textContent)
const sorted = (request: GitHeadsRequest) => ({ threadIds: [...request.threadIds ?? []].sort(), projectIds: [...request.projectIds ?? []].sort() })

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  ;({ useAppStore: appStore } = await import('../../src/renderer/stores/appStore'))
  appStore.setState({ profileReady: true, warmView: null, turnStates: {} })
  hook = await import('../../src/renderer/hooks/useThreadBranch')
  calls = []
  branches = { p1: 'main', p2: 'develop', t1: 'mousse/fix-build', t2: 'mousse/docs' }
  answer = fromBranches
  bridge()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

it('every card shown is read in one call, and nothing reads again until something happens', async () => {
  showCards()
  await settle()
  expect(calls.map(sorted)).toEqual([{ threadIds: ['t1', 't2'], projectIds: ['p1', 'p2'] }])
  expect(shown()).toEqual(['mousse/fix-build', 'mousse/docs', 'develop'])
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(calls).toHaveLength(1)
})

it('focus reads every card again in one call; a call that fails keeps what the cards show', async () => {
  showCards()
  await settle()
  answer = () => Promise.reject(new Error('The drive or folder at E: is not answering.'))
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await settle()
  expect(calls).toHaveLength(2)
  expect(shown()).toEqual(['mousse/fix-build', 'mousse/docs', 'develop'])

  answer = fromBranches
  branches.p2 = 'release'
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await settle()
  expect(sorted(calls[2]!)).toEqual({ threadIds: ['t1', 't2'], projectIds: ['p1', 'p2'] })
  expect(shown()).toEqual(['mousse/fix-build', 'mousse/docs', 'release'])
})

it('a run that ends reads its thread and the projects; a branch Mousse renamed is read when it says so', async () => {
  showCards()
  await settle()
  const phase = (value: string) => act(() => {
    appStore.setState({ turnStates: { t1: { threadId: 't1', turnId: 'u1', phase: value, updatedAt: '' } } } as never)
  })
  phase('thinking')
  branches.t1 = 'agent-switched'
  phase('completed')
  await settle()
  expect(sorted(calls.at(-1)!)).toEqual({ threadIds: ['t1'], projectIds: ['p1', 'p2'] })
  expect(shown()[0]).toBe('agent-switched')

  branches.t2 = 'mousse/named-by-title'
  await act(async () => { headsChanged?.({ threadIds: ['t2'] }) })
  await settle()
  expect(sorted(calls.at(-1)!)).toEqual({ threadIds: ['t2'], projectIds: [] })
  expect(shown()[1]).toBe('mousse/named-by-title')
})

it('a thread in its project’s folder names the project’s branch', async () => {
  answer = async (request) => ({ ...(await fromBranches(request)), threads: Object.fromEntries((request.threadIds ?? []).map((id) => [id, { project: true as const }])) })
  showCards()
  await settle()
  expect(shown()).toEqual(['main', 'main', 'develop'])
})

it('a detached HEAD names its commit, and a read that fails for one card keeps what that card named', async () => {
  showCards()
  await settle()
  answer = async (request) => {
    const result = await fromBranches(request)
    result.threads.t1 = { own: true, branch: null, detachedAt: 'abc1234', generation: 0, lifecycle: 'ready' }
    result.threads.t2 = { error: 'The drive at E:\ is not answering.' }
    return result
  }
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await settle()
  expect(shown()).toEqual(['detached abc1234', 'mousse/docs', 'develop'])
})

it('a card that first shows names what it named at the last launch, then what is read now', async () => {
  hook.seedBranchReads({ threads: { t1: { own: true, branch: 'mousse/last-time', generation: 0, lifecycle: 'ready' } }, projects: { p2: { repo: true, branch: 'develop' } } }, { t1: 'p1', t2: 'p1' })
  showCards()
  // Before any read has answered.
  expect(shown()[0]).toBe('mousse/last-time')
  expect(shown()[2]).toBe('develop')
  await settle()
  expect(sorted(calls[0]!)).toEqual({ threadIds: ['t1', 't2'], projectIds: ['p1', 'p2'] })
  expect(shown()).toEqual(['mousse/fix-build', 'mousse/docs', 'develop'])
})

it('a card whose read failed is read again a while later, so it never stays without its branch', async () => {
  answer = async (request) => ({ ...(await fromBranches(request)), threads: { ...(await fromBranches(request)).threads, t1: { error: 'The drive at E:\ is not answering.' } } })
  showCards()
  await settle()
  expect(shown()).toEqual(['', 'mousse/docs', 'develop'])

  answer = fromBranches
  await act(async () => { await vi.advanceTimersByTimeAsync(hook.FAILED_READ_AGAIN_MS) })
  await settle()
  expect(sorted(calls.at(-1)!)).toEqual({ threadIds: ['t1'], projectIds: [] })
  expect(shown()[0]).toBe('mousse/fix-build')
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(calls).toHaveLength(2)
})
