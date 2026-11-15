// @vitest-environment jsdom
/**
 * The side card's Git section follows the thread's folder as its repository goes and comes back, without the thread
 * being selected again. The section is mounted as the side card mounts it, with only the daemon stubbed.
 *
 * What happens to the folder of thread t1 (its own worktree) while it stays selected:
 * - the agent removes the repository, and its turn ends -> "Initialize Git" shows at once, the section open
 * - Initialize Git is pressed -> the daemon is asked for the thread's own folder, and the normal Git view is back
 * - the agent brings the repository back itself, and its turn ends -> the normal Git view is back
 * - the folder is an empty folder (Git cannot remove a folder a program holds) -> the same "Initialize Git"
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitSection } from '../../src/renderer/components/sideCard/GitSection'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useGitStatusStore } from '../../src/renderer/stores/gitStatusStore'
import type { GitScope, GitStatusSnapshot, Thread, TurnState } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = '/work/repo'
const WORKTREE = '/home/.mousse/worktrees/threads/t1/main'
const THREAD_SCOPE: GitScope = { projectId: 'p1', workspaceThreadId: 't1' }

type Folder = 'repository' | 'gone' | 'empty'

const repository: GitStatusSnapshot = { isRepo: true, branch: 'mousse/fix-login', upstream: null, tracking: 'none', ahead: 0, behind: 0, changes: [], inProgress: null, hasRemote: false }
const statusOf = (folder: Folder): GitStatusSnapshot => folder === 'repository'
  ? repository
  : { isRepo: false, branch: null, upstream: null, tracking: 'none', ahead: 0, behind: 0, changes: [], ...(folder === 'gone' ? { missing: true } : {}) }

const initialStore = useAppStore.getState()
let host: HTMLDivElement
let root: Root
let folder: Folder
let init: ReturnType<typeof vi.fn>
let statusScopes: GitScope[]

const flush = async () => { await act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const phase = (value: TurnState['phase']) => act(() => {
  useAppStore.setState((s) => ({ turnStates: { ...s.turnStates, t1: { threadId: 't1', turnId: 'u1', phase: value, updatedAt: new Date().toISOString() } } }))
})
/** A turn of the thread runs and ends, with `change` done to the folder while it ran. */
const turnThat = async (change: () => void) => {
  await phase('thinking')
  change()
  await phase('completed')
  await flush()
}
const initButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Initialize Git') ?? null
const branchButton = () => host.querySelector('.side-card-git-branch')
const toggle = () => host.querySelector('.side-card-section-toggle')

beforeEach(async () => {
  folder = 'repository'
  statusScopes = []
  init = vi.fn(async () => { folder = 'repository'; return { status: repository } })
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => WORKTREE, getActiveProjectPath: async () => PROJECT },
    workspace: { getStatus: async () => ({ execution: { projectPath: WORKTREE, lifecycle: 'ready' } }) },
    git: {
      status: vi.fn(async (scope: GitScope) => { statusScopes.push(scope); return statusOf(folder) }),
      log: async () => [],
      branches: async () => ({ current: repository.branch, branches: [repository.branch] }),
      diffStats: async () => ({ additions: 0, deletions: 0, filesChanged: 0 }),
      init
    },
    pullRequests: { get: async () => ({ state: 'none' }) }
  }
  useGitStatusStore.setState({ entries: {} })
  const thread = { id: 't1', name: 'Fix the login', projectId: 'p1', worktreeEnabled: true, startedAt: '2026-11-15T09:00:00.000Z', createdAt: '2026-11-15T09:00:00.000Z', updatedAt: '2026-11-15T09:00:00.000Z' } as unknown as Thread
  useAppStore.setState({ activeThreadId: 't1', profileId: 'prf', projects: [{ id: 'p1', name: 'repo', path: PROJECT, createdAt: '', order: 0 }], threads: [thread], messages: [], turnStates: {}, sideCardCollapsed: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(GitSection, { threadId: 't1' })))
  await flush()
  expect(branchButton()?.textContent).toContain('mousse/fix-login')
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialStore, true)
})

describe('the side card Git section, as the thread\'s repository goes and comes back', () => {
  it.each<[Folder, string]>([['gone', 'Folder not found'], ['empty', 'Not a repository']])('offers Initialize Git at once when the folder is %s, and starting Git there brings the normal view back', async (state, line) => {
    await turnThat(() => { folder = state })
    expect(branchButton()).toBeNull()
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain(line)
    const button = initButton()
    expect(button).not.toBeNull()

    await act(async () => { button!.click() })
    await flush()
    // The thread's own folder, never the project's: the project folder is a repository already.
    expect(init).toHaveBeenCalledWith(THREAD_SCOPE)
    expect(statusScopes.at(-1)).toEqual(THREAD_SCOPE)
    expect(initButton()).toBeNull()
    expect(branchButton()?.textContent).toContain('mousse/fix-login')
    expect(useAppStore.getState().activeThreadId).toBe('t1')
  })

  it('goes back to the normal view when the agent brings the repository back itself', async () => {
    await turnThat(() => { folder = 'gone' })
    expect(initButton()).not.toBeNull()
    await turnThat(() => { folder = 'repository' })
    expect(initButton()).toBeNull()
    expect(branchButton()?.textContent).toContain('mousse/fix-login')
    expect(init).not.toHaveBeenCalled()
  })
})
