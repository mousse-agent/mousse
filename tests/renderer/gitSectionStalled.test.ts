// @vitest-environment jsdom
/**
 * The side card's Git section never waits more than its budget: when the thread's folder lookup or its first status
 * read does not answer (a drive asleep, a busy service), it says "Not answering" with Retry before 3 s, and Retry reads
 * both again. Viewing the section never brings a worktree back, and reads nothing but the lookup and the status first.
 *
 * Stalls: the folder lookup (`git.heads`), the status read, the worktree's drive (the lookup answers it is not
 * answering). Then: a worktree a storage rule retired, which the section names without bringing it back.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitSection } from '../../src/renderer/components/sideCard/GitSection'
import { ChangesPanel } from '../../src/renderer/components/changes/ChangesPanel'
import { WORKSPACE_CHANGED_MESSAGE } from '../../src/shared/types'
import { qualifyId } from '../../src/shared/threadRef'
import { GIT_LOOKUP_BUDGET_MS } from '../../src/renderer/components/sideCard/useStillPending'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useGitStatusStore } from '../../src/renderer/stores/gitStatusStore'
import type { GitHeadsChangedEvent, GitHeadsResult, GitScope, GitStatusSnapshot, GitThreadHead, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = '/work/repo'
const WORKTREE = '/home/.mousse/worktrees/threads/t1/main'
const repository: GitStatusSnapshot = { isRepo: true, branch: 'mousse/fix-login', upstream: null, tracking: 'none', ahead: 0, behind: 0, changes: [], inProgress: null, hasRemote: false }
const ready: GitThreadHead = { own: true, branch: 'mousse/fix-login', folder: WORKTREE, generation: 0, lifecycle: 'ready' }
const never = <T,>() => new Promise<T>(() => undefined)

const initialStore = useAppStore.getState()
let host: HTMLDivElement
let root: Root
let heads: () => Promise<GitHeadsResult>
let status: (scope: GitScope) => Promise<GitStatusSnapshot>
let changed: ((event: GitHeadsChangedEvent) => void) | undefined
let workspaceStatus: () => Promise<unknown>
const init = vi.fn(async () => undefined)
const remoteThread = qualifyId('nod_0123456789abcdefghjkmnpqrs', 't1')
const calls = { getFilesRoot: 0, getStatus: 0, status: 0 }

const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const retryButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry') ?? null
const branchButton = () => host.querySelector('.side-card-git-branch')

beforeEach(() => {
  vi.useFakeTimers()
  calls.getFilesRoot = 0
  calls.getStatus = 0
  calls.status = 0
  heads = async () => ({ projects: {}, threads: { t1: ready } })
  status = async () => repository
  init.mockClear()
  workspaceStatus = async () => ({ retiredByCleanup: { at: '2026-11-20T10:00:00.000Z', rule: 'worktree-inactive' } })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => { calls.getFilesRoot++; return WORKTREE }, getActiveProjectPath: async () => PROJECT },
    workspace: { getStatus: async () => { calls.getStatus++; return workspaceStatus() } },
    git: {
      heads: () => heads(),
      init,
      onSelectionChanged: () => () => undefined,
      status: (scope: GitScope) => { calls.status++; return status(scope) },
      onHeadsChanged: (listener: typeof changed) => { changed = listener; return () => { changed = undefined } },
      log: async () => [],
      branches: async () => ({ current: repository.branch, branches: [repository.branch] }),
      diffStats: async () => ({ additions: 0, deletions: 0, filesChanged: 0 })
    },
    pullRequests: { get: async () => ({ state: 'none' }) },
    review: {
      files: async ({ scope }: { scope: unknown }) => ({
        root: WORKTREE, scope, range: { from: null, to: { kind: 'worktree' } },
        files: [], truncated: false, mergeCommits: 0
      })
    }
  }
  useGitStatusStore.setState({ entries: {} })
  const thread = { id: 't1', name: 'Fix the login', projectId: 'p1', worktreeEnabled: true, startedAt: '2026-11-15T09:00:00.000Z', createdAt: '2026-11-15T09:00:00.000Z', updatedAt: '2026-11-15T09:00:00.000Z' } as unknown as Thread
  useAppStore.setState({ activeThreadId: 't1', profileId: 'prf', projects: [{ id: 'p1', name: 'repo', path: PROJECT, createdAt: '', order: 0 }], threads: [thread], messages: [], turnStates: {}, sideCardCollapsed: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialStore, true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const open = async () => {
  act(() => root.render(createElement(GitSection, { threadId: useAppStore.getState().activeThreadId })))
  await advance(100)
}

it('shows the status from the lookup and one status read, without bringing anything back or reading the workspace', async () => {
  await open()
  expect(branchButton()?.textContent).toContain('mousse/fix-login')
  expect(calls).toEqual({ getFilesRoot: 0, getStatus: 0, status: 1 })
})

it.each<[string, () => void]>([
  ['the folder lookup does not answer', () => { heads = never }],
  ['the status read does not answer', () => { status = never }],
  ['the worktree’s drive is not answering', () => { heads = async () => ({ projects: {}, threads: { t1: { ...ready, folder: undefined, unavailable: 'The drive at E:\\ is not answering.' } } }) }]
])('when %s, says so with Retry within the budget, and Retry reads again', async (_case, stall) => {
  stall()
  await open()
  await advance(GIT_LOOKUP_BUDGET_MS)
  expect(GIT_LOOKUP_BUDGET_MS).toBeLessThan(3_000)
  expect(host.textContent).toContain('Not answering')
  expect(retryButton()).not.toBeNull()

  heads = async () => ({ projects: {}, threads: { t1: ready } })
  status = async () => repository
  await act(async () => { retryButton()!.click() })
  await advance(100)
  expect(branchButton()?.textContent).toContain('mousse/fix-login')
  expect(calls.getFilesRoot).toBe(0)
})

it('names a worktree a storage rule retired, with its note, and never brings it back', async () => {
  heads = async () => ({ projects: {}, threads: { t1: { ...ready, folder: undefined, missing: true } } })
  await open()
  expect(host.textContent).toContain('Worktree not on disk')
  expect(retryButton()).toBeNull()
  expect(calls.getFilesRoot).toBe(0)
  expect(calls.status).toBe(0)
  expect(calls.getStatus).toBeGreaterThan(0)
})

it('a rebuild at the same path blanks the previous branch and displays status for the new generation', async () => {
  await open()
  expect(branchButton()?.textContent).toContain('mousse/fix-login')

  let finish!: (value: GitStatusSnapshot) => void
  status = (scope) => {
    expect(scope).toMatchObject({ workspaceThreadId: 't1', workspaceGeneration: 1 })
    return new Promise((resolve) => { finish = resolve })
  }
  heads = async () => ({ projects: {}, threads: { t1: { ...ready, generation: 1 } } })
  act(() => changed?.({ threadIds: ['t1'] }))
  await advance(100)
  expect(host.textContent).not.toContain('mousse/fix-login')
  await act(async () => finish({ ...repository, branch: 'mousse/rebuilt' }))
  expect(branchButton()?.textContent).toContain('mousse/rebuilt')
})

it('shows a checkout that cannot be read as unavailable and offers Retry', async () => {
  heads = async () => ({ projects: {}, threads: { t1: { ...ready, folder: undefined, unavailable: 'The worktree folder is not a Git checkout.' } } })
  await open()
  expect(host.textContent).toContain('The worktree folder is not a Git checkout.')
  expect(host.textContent).not.toContain('Worktree not on disk')
  expect(retryButton()).not.toBeNull()
})

function selectRemote() {
  const thread = useAppStore.getState().threads[0]!
  useAppStore.setState({ activeThreadId: remoteThread, threads: [{ ...thread, id: remoteThread }] })
}

const setPhase = (threadId: string, phase: 'queued' | 'thinking' | 'streaming') =>
  act(() => { useAppStore.setState({ turnStates: { [threadId]: { threadId, turnId: 'first', phase, updatedAt: '' } } }) })

it.each([false, true])('waits for the first worktree before reading Git (remote: %s)', async (remote) => {
  if (remote) selectRemote()
  else useAppStore.setState((state) => ({
    threads: state.threads.map((thread) => ({ ...thread, startedAt: undefined, name: 'New chat' }))
  }))
  const threadId = remote ? remoteThread : 't1'
  const git = window.mousse.git
  const gitCalls = [vi.spyOn(git, 'status'), vi.spyOn(git, 'log'), vi.spyOn(git, 'branches'), vi.spyOn(git, 'diffStats'), init]
  status = async (scope) => ({ ...repository, branch: scope.workspaceThreadId ? 'mousse/first-turn' : 'master' })
  heads = async () => ({ projects: {}, threads: { t1: { own: true, branch: null, generation: 0, lifecycle: 'unprovisioned' } } })
  workspaceStatus = async () => ({ metadata: null, execution: { projectPath: PROJECT, lifecycle: 'unprovisioned' } })
  await open()
  act(() => {
    useAppStore.setState((state) => ({
      threads: state.threads.map((thread) => ({ ...thread, startedAt: '2026-11-21T10:00:00.000Z' }))
    }))
    setPhase(threadId, 'queued')
  })
  await advance(100)
  heads = async () => ({ projects: {}, threads: { t1: { own: true, branch: null, generation: 0, lifecycle: 'provisioning' } } })
  workspaceStatus = async () => ({ metadata: { lifecycle: 'provisioning' }, execution: { projectPath: PROJECT, lifecycle: 'provisioning' } })
  setPhase(threadId, 'thinking')
  await advance(GIT_LOOKUP_BUDGET_MS)
  expect(host.textContent).toContain('Checking…')
  expect(host.textContent).not.toContain('master')
  for (const call of gitCalls) expect(call).not.toHaveBeenCalled()

  heads = async () => ({ projects: {}, threads: { t1: ready } })
  workspaceStatus = async () => ({ metadata: { lifecycle: 'ready' }, execution: { projectPath: WORKTREE, generation: 0, lifecycle: 'ready' } })
  setPhase(threadId, 'streaming')
  await advance(100)
  expect(branchButton()?.textContent).toContain('mousse/first-turn')
  for (const call of gitCalls.slice(0, 4)) {
    for (const args of call.mock.calls) expect(args).toContainEqual(expect.objectContaining({ workspaceThreadId: threadId }))
  }
})

it.each([
  { surface: 'Git', remote: false },
  { surface: 'Git', remote: true },
  { surface: 'Changes', remote: true }
])('$surface re-resolves a same-path rebuild while an Initialize refresh waits (remote: $remote)', async ({ surface, remote }) => {
  if (remote) selectRemote()
  let generation = 2
  heads = async () => ({ projects: {}, threads: { t1: { ...ready, generation } } })
  workspaceStatus = async () => ({ metadata: { lifecycle: 'ready' }, execution: { projectPath: WORKTREE, generation, lifecycle: 'ready' } })
  status = async () => ({ ...repository, isRepo: false, branch: null })
  if (surface === 'Git') await open()
  else {
    act(() => root.render(createElement(ChangesPanel)))
    await advance(100)
  }

  let finish: (() => void) | undefined
  const seen: GitScope[] = []
  status = async (scope) => {
    seen.push(scope)
    if (seen.length === 1) {
      await new Promise<void>((resolve) => { finish = resolve })
      if (scope.workspaceGeneration !== undefined && scope.workspaceGeneration !== generation) throw new Error(WORKSPACE_CHANGED_MESSAGE)
      return { ...repository, branch: 'stale-branch' }
    }
    return { ...repository, branch: 'mousse/rebuilt' }
  }
  const initialize = [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Initialize'))
  expect(initialize).toBeDefined()
  act(() => initialize!.click())
  await advance(100)
  expect(finish).toBeDefined()
  generation++
  act(() => finish!())
  await advance(100)
  expect(seen.map((scope) => scope.workspaceGeneration)).toEqual([2, 3])
  expect(host.textContent).toContain(surface === 'Git' ? 'mousse/rebuilt' : 'No uncommitted changes')
  expect(host.textContent).not.toContain('stale-branch')
})
