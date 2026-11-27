// @vitest-environment jsdom
/**
 * A subagent an agent on computer A started on computer B (`delegate_task` with `computer`) is listed once, below its
 * parent, on both: B's own thread for it carries no `lineage` (its parent is not a thread there), only
 * `startedFrom.agent.subagent`; A has its stand-in, a subagent of the parent, and B's row for the same subagent.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/StartFromPullRequestDialog', () => ({ StartFromPullRequestDialog: () => null }))
vi.mock('../../src/renderer/components/profiles/ProfileSwitcher', () => ({ ProfileSwitcher: () => null }))
vi.mock('../../src/renderer/components/chats/ChatsSidebar', () => ({ ChatsSidebar: () => null }))

const { ThreadsSidebar } = await import('../../src/renderer/components/ThreadsSidebar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useThreadFilterStore } = await import('../../src/renderer/stores/threadFilterStore')

const at = '2026-11-27T10:00:00.000Z'
const A = 'nod_' + 'a'.repeat(26)
const B = 'nod_' + 'b'.repeat(26)
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, ...over })
// Started by the agent of A's thread `p` as its subagent; the remote subagent's thread is hidden, as one is started.
const startedFrom: Thread['startedFrom'] = { node: A, agent: { thread: 'p', title: 'Plan the release', mode: 'default', subagent: true } }

function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = () => new Proxy({} as Record<string, unknown>, { get: (target, key: string) => target[key] ?? call(key) })
  return new Proxy({ git: {} } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? group() })
}

const appKeys = ['projects', 'threads', 'threadActivity', 'activeThreadId', 'threadsSidebarView', 'sidebarMode'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getInitialState()[key]]))
const filterOriginal = useThreadFilterStore.getState().show

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = preload()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appOriginal)
  useThreadFilterStore.setState({ show: filterOriginal })
})

/** The Threads tab with the filter's All, which lists the threads an agent keeps out of the sidebar. */
function listed(threads: Thread[], projects: Project[] = []): string[] {
  useAppStore.setState({ projects, threads, threadActivity: {}, activeThreadId: null, threadsSidebarView: 'threads', sidebarMode: 'projects' })
  act(() => root.render(createElement(ThreadsSidebar)))
  // After the first render, which reads the profile's saved choice.
  act(() => useThreadFilterStore.setState({ show: 'all' }))
  return [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]:not([hidden]) button[data-thread-id]')].map((row) => row.dataset.threadId!)
}

describe('a remote subagent in the sidebar', () => {
  it('on B, the computer that runs it, it is not a row of its own: it is below its parent on A', () => {
    expect(listed([thread(`${A}:p`, 'Plan the release', { node: A }), thread('x', 'Mac build', { hidden: true, startedFrom })])).toEqual([`${A}:p`])
  })

  it('on A, the computer that started it, All lists only its parent, not its stand-in or B\'s row', () => {
    expect(listed([
      thread('p', 'Plan the release'),
      thread('stand-in', 'Mac build', { lineage: { parentThreadId: 'p', rootThreadId: 'p', relationship: 'subagent' }, runsOn: { node: B, computerName: 'Mac mini', ref: `${B}:x` } }),
      thread(`${B}:x`, 'Mac build', { node: B, hidden: true, startedFrom })
    ])).toEqual(['p'])
  })

  it('a computer from before the subagent mark lists it on its own, as before', () => {
    const { subagent: _subagent, ...agent } = startedFrom!.agent!
    expect(listed([thread(`${A}:p`, 'Plan the release', { node: A }), thread('x', 'Mac build', { hidden: true, startedFrom: { node: A, agent } })]).sort()).toEqual([`${A}:p`, 'x'].sort())
  })
})
