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
import { GIT_LOOKUP_BUDGET_MS } from '../../src/renderer/components/sideCard/useStillPending'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useGitStatusStore } from '../../src/renderer/stores/gitStatusStore'
import type { GitHeadsResult, GitStatusSnapshot, GitThreadHead, Thread } from '../../src/shared/types'

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
let status: () => Promise<GitStatusSnapshot>
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
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => { calls.getFilesRoot++; return WORKTREE }, getActiveProjectPath: async () => PROJECT },
    workspace: { getStatus: async () => { calls.getStatus++; return { retiredByCleanup: { at: '2026-11-20T10:00:00.000Z', rule: 'worktree-inactive' } } } },
    git: {
      heads: () => heads(),
      status: () => { calls.status++; return status() },
      log: async () => [],
      branches: async () => ({ current: repository.branch, branches: [repository.branch] }),
      diffStats: async () => ({ additions: 0, deletions: 0, filesChanged: 0 })
    },
    pullRequests: { get: async () => ({ state: 'none' }) }
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
})

const open = async () => {
  act(() => root.render(createElement(GitSection, { threadId: 't1' })))
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
  heads = async () => ({ projects: {}, threads: { t1: { ...ready, folder: undefined } } })
  await open()
  expect(host.textContent).toContain('Worktree not on disk')
  expect(retryButton()).toBeNull()
  expect(calls.getFilesRoot).toBe(0)
  expect(calls.status).toBe(0)
  expect(calls.getStatus).toBeGreaterThan(0)
})
