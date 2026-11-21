// @vitest-environment jsdom
/**
 * The side card's Git section never shows another thread's Git state. Switching from a thread whose branch shows to
 * another one, nothing of the first shows: not while the second is being opened (chosen in the sidebar, its view not
 * here yet: `openingThreadId`), and not while its folder lookup and status are on their way. The section says
 * "Checking…" until the second's own answer comes.
 *
 * Switches: to another thread with its own worktree, to a thread in the project's folder, to a thread whose worktree
 * a storage rule retired, and back to the first thread while the second's lookup has not answered.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitSection } from '../../src/renderer/components/sideCard/GitSection'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useGitStatusStore } from '../../src/renderer/stores/gitStatusStore'
import type { GitHeadsRequest, GitScope, GitStatusSnapshot, GitThreadHead, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = '/work/repo'
const status = (branch: string): GitStatusSnapshot => ({ isRepo: true, branch, upstream: null, tracking: 'none', ahead: 0, behind: 0, changes: [], inProgress: null, hasRemote: false })
const own = (id: string): GitThreadHead => ({ own: true, branch: `mousse/${id}`, folder: `/wt/${id}`, generation: 0, lifecycle: 'ready' })
const HEADS: Record<string, GitThreadHead> = {
  a: own('a'),
  b: own('b'),
  folder: { project: true },
  retired: { own: true, branch: 'mousse/retired', generation: 0, lifecycle: 'ready' }
}

const initialStore = useAppStore.getState()
let host: HTMLDivElement
let root: Root
/** Answers held back, by thread (lookup) or folder (status), until the test lets them go. */
let held: Set<string>
const waiting: Array<{ name: string; go: () => void }> = []
const hold = <T,>(name: string, answer: () => T): Promise<T> => held.has(name)
  ? new Promise((resolve) => { waiting.push({ name, go: () => resolve(answer()) }) })
  : Promise.resolve(answer())
const release = async (name: string) => {
  held.delete(name)
  for (const entry of waiting.splice(0)) entry.name === name ? entry.go() : waiting.push(entry)
  await advance(100)
}

const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const shown = () => host.textContent ?? ''
/** Chooses a thread as the sidebar does: held in `openingThreadId` until its view arrives, then shown. */
const choose = async (threadId: string) => {
  act(() => { useAppStore.setState({ openingThreadId: threadId }) })
  await advance(800)
}
const viewArrives = async () => {
  act(() => { useAppStore.setState((s) => ({ activeThreadId: s.openingThreadId, openingThreadId: null })) })
  await advance(50)
}
const select = async (threadId: string) => {
  await choose(threadId)
  await viewArrives()
}
/** The side card's Git section, for the thread the chat shows (as `ThreadSideCard` passes it). */
function Card() {
  return createElement(GitSection, { threadId: useAppStore((s) => s.activeThreadId), projectId: 'p1' })
}

beforeEach(async () => {
  vi.useFakeTimers()
  held = new Set()
  waiting.length = 0
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => PROJECT, getActiveProjectPath: async () => PROJECT },
    workspace: { getStatus: async () => ({}) },
    git: {
      heads: (request: GitHeadsRequest) => {
        const id = request.threadIds![0]!
        return hold(`heads:${id}`, () => ({ projects: {}, threads: { [id]: HEADS[id]! } }))
      },
      status: (scope: GitScope) => {
        const folder = scope.workspaceThreadId ?? 'project'
        return hold(`status:${folder}`, () => status(folder === 'project' ? 'main' : `mousse/${folder}`))
      },
      log: async () => [],
      branches: async () => ({ current: 'main', branches: ['main'] }),
      diffStats: async () => ({ additions: 0, deletions: 0, filesChanged: 0 })
    },
    pullRequests: { get: async () => ({ state: 'none' }) }
  }
  useGitStatusStore.setState({ entries: {} })
  const thread = (id: string, worktreeEnabled = true) => ({ id, name: id, projectId: 'p1', worktreeEnabled, startedAt: '2026-11-15T09:00:00.000Z', createdAt: '2026-11-15T09:00:00.000Z', updatedAt: '2026-11-15T09:00:00.000Z' }) as unknown as Thread
  useAppStore.setState({ activeThreadId: 'a', openingThreadId: null, profileId: 'prf', projects: [{ id: 'p1', name: 'repo', path: PROJECT, createdAt: '', order: 0 }], threads: [thread('a'), thread('b'), thread('folder', false), thread('retired')], messages: [], turnStates: {}, sideCardCollapsed: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(Card)))
  await advance(100)
  expect(shown()).toContain('mousse/a')
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialStore, true)
  vi.useRealTimers()
})

it.each([
  ['another thread with its own worktree', 'b', 'mousse/b'],
  ['a thread in the project’s folder', 'folder', 'main'],
  ['a thread whose worktree was retired', 'retired', 'Worktree not on disk']
])('switching to %s shows nothing of the first thread while its lookup and status are on their way', async (_name, id, answer) => {
  held = new Set([`heads:${id}`, `status:${id === 'folder' ? 'project' : id}`])
  await choose(id)
  expect(shown()).not.toContain('mousse/a')
  expect(shown()).toContain('Checking…')
  await viewArrives()
  await advance(800)
  expect(shown()).not.toContain('mousse/a')
  expect(shown()).toContain('Checking…')

  await release(`heads:${id}`)
  expect(shown()).not.toContain('mousse/a')
  await release(`status:${id === 'folder' ? 'project' : id}`)
  expect(shown()).toContain(answer)
  expect(shown()).not.toContain('mousse/a')
})

it('going back to the first thread before the second answered shows the first again, never the second', async () => {
  held = new Set(['heads:b', 'status:b'])
  await select('b')
  await select('a')
  await release('heads:b')
  await release('status:b')
  expect(shown()).toContain('mousse/a')
  expect(shown()).not.toContain('mousse/b')
})
