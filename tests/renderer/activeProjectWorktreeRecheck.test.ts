// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useActiveProjectLocation } from '../../src/renderer/hooks/useActiveProjectPath'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { ActiveProject } from '../../src/renderer/lib/activeProject'
import { qualifyId } from '../../src/shared/threadRef'
import type { Thread, TurnState } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = '/work/repo'
const WORKTREE = '/home/.mousse/worktrees/threads/t1/main'
const initialStore = useAppStore.getState()
let host: HTMLDivElement
let root: Root
let worktreeReady = false
let lookups = 0
let seen: ActiveProject | null = null

function Probe() {
  seen = useActiveProjectLocation()
  return null
}

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const phase = (value: TurnState['phase']) => act(() => {
  useAppStore.setState((s) => ({ turnStates: { ...s.turnStates, t1: { threadId: 't1', turnId: 'u1', phase: value, updatedAt: new Date().toISOString() } } }))
})

beforeEach(() => {
  worktreeReady = false
  lookups = 0
  seen = null
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => (worktreeReady ? WORKTREE : PROJECT), getActiveProjectPath: async () => PROJECT },
    git: {
      // The worktree is made by the first turn: until then the thread works in no folder of its own.
      heads: async () => {
        lookups++
        return { projects: {}, threads: { t1: worktreeReady ? { own: true, branch: 'mousse/t1', folder: WORKTREE } : { own: true, branch: null, generation: 0, lifecycle: 'unprovisioned' } } }
      }
    }
  }
  const thread = { id: 't1', name: 'Sync the local repository', projectId: 'p1', worktreeEnabled: true, startedAt: '2026-11-10T09:51:00.000Z', createdAt: '2026-11-10T09:51:00.000Z', updatedAt: '2026-11-10T09:51:00.000Z' } as unknown as Thread
  useAppStore.setState({ activeThreadId: 't1', profileId: 'prf', projects: [{ id: 'p1', name: 'repo', path: PROJECT, createdAt: '', order: 0 }], threads: [thread], messages: [], turnStates: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialStore, true)
})

describe('the folder of a new worktree thread', () => {
  it('becomes the thread worktree once its first turn has made it, without selecting the thread again', async () => {
    act(() => root.render(createElement(Probe)))
    await flush()
    expect(seen).toMatchObject({ path: null, workspaceThreadId: 't1', loading: true })

    await phase('queued')
    await flush()
    worktreeReady = true // The turn made the worktree.
    await phase('thinking')
    await flush()
    expect(seen).toMatchObject({ path: WORKTREE, workspaceThreadId: 't1', key: 'thread:t1' })

    // Found once: later phases do not look again.
    const after = lookups
    await phase('streaming')
    await phase('completed')
    await flush()
    expect(lookups).toBe(after)
    expect(seen).toMatchObject({ path: WORKTREE, workspaceThreadId: 't1' })
  })
})

it('uses the owning computer’s workspace lookup for a remote thread', async () => {
  const node = 'nod_0123456789abcdefghjkmnpqrs'
  const threadId = qualifyId(node, 't1')
  const projectId = qualifyId(node, 'p1')
  const thread = useAppStore.getState().threads[0]!
  useAppStore.setState({ activeThreadId: threadId, threads: [{ ...thread, id: threadId, projectId, node }] })

  const getActiveProjectPath = vi.fn(async () => PROJECT)
  const getStatus = vi.fn(async () => ({ metadata: { lifecycle: 'ready' }, execution: { projectPath: WORKTREE, lifecycle: 'ready', generation: 4 } }))
  const heads = vi.fn()
  // The window reads the computers too; none are listed here.
  const platformRequest = { request: async () => { throw new Error('Net is off') } }
  ;(window as unknown as { mousse: unknown }).mousse = { app: { getActiveProjectPath }, workspace: { getStatus }, git: { heads }, platformRequest }
  act(() => root.render(createElement(Probe)))
  await flush()
  expect(getStatus).toHaveBeenCalledWith(threadId, false)
  expect(seen).toMatchObject({ path: WORKTREE, workspaceThreadId: threadId, workspaceGeneration: 4 })
  expect(heads).not.toHaveBeenCalled()
  expect(getActiveProjectPath).not.toHaveBeenCalled()
})

describe('a remote thread whose computer was offline when its folder was looked up', () => {
  const node = 'nod_0123456789abcdefghjkmnpqrs'
  const threadId = qualifyId(node, 't1')
  let online = false
  let netChanged: (() => void) | undefined
  let getStatus: ReturnType<typeof vi.fn>
  let profiles = 0

  beforeEach(() => {
    online = false
    const thread = useAppStore.getState().threads[0]!
    // A profile of its own: a lookup of the same thread made in the last two seconds would be shared.
    useAppStore.setState({ profileId: `prf-${++profiles}`, activeThreadId: threadId, threads: [{ ...thread, id: threadId, projectId: qualifyId(node, 'p1'), node }] })
    getStatus = vi.fn(async () => {
      if (!online) throw new Error("Error invoking remote method 'workspace:getStatus': Error: The Mac is offline.")
      return { metadata: { lifecycle: 'ready' }, execution: { projectPath: WORKTREE, lifecycle: 'ready', generation: 4 } }
    })
    // The computers as the window reads them: the device list, and Net's word that a device connected or dropped.
    const request = vi.fn(async (method: string) => {
      if (method === 'net.status') return { enabled: false, keystore: 'unlocked' }
      if (method === 'netEngine.status') return { on: true }
      if (method === 'bridge.nodes') return { nodes: [{ node, name: 'Mac', kind: 'desktop', state: online ? 'open' : 'closed' }] }
      throw new Error(`unexpected ${method}`)
    })
    ;(window as unknown as { mousse: unknown }).mousse = {
      app: { getActiveProjectPath: async () => PROJECT },
      workspace: { getStatus },
      git: { heads: vi.fn() },
      platformRequest: { request },
      net: { onUpdated: (listener: () => void) => { netChanged = listener; return () => { netChanged = undefined } } }
    }
  })

  it('shows the folder once that computer is listed online again, without Retry', async () => {
    act(() => root.render(createElement(Probe)))
    await flush()
    expect(seen).toMatchObject({ path: null, workspaceThreadId: threadId })
    expect(seen?.unavailable).toMatch(/offline/)

    online = true
    await act(async () => { netChanged?.() })
    await flush()
    await flush()
    expect(seen).toMatchObject({ path: WORKTREE, workspaceThreadId: threadId, workspaceGeneration: 4 })
  })

  it('looks again at most once per reading of the computers while the lookup keeps failing', async () => {
    // The device list says online, but the lookup still fails (the computer dropped again in between).
    online = true
    getStatus.mockRejectedValue(new Error('The Mac is offline.'))
    act(() => root.render(createElement(Probe)))
    for (let i = 0; i < 5; i += 1) await flush()
    const settled = getStatus.mock.calls.length
    expect(settled).toBeLessThanOrEqual(2)
    for (let i = 0; i < 5; i += 1) await flush()
    expect(getStatus.mock.calls.length).toBe(settled)

    await act(async () => { netChanged?.() })
    for (let i = 0; i < 3; i += 1) await flush()
    expect(getStatus.mock.calls.length).toBe(settled + 1)
  })
})
