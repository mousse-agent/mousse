// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useActiveProjectLocation } from '../../src/renderer/hooks/useActiveProjectPath'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { ActiveProject } from '../../src/renderer/lib/activeProject'
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
    workspace: {
      getStatus: async () => {
        lookups++
        return worktreeReady ? { execution: { projectPath: WORKTREE, lifecycle: 'ready' } } : { execution: { lifecycle: 'unprovisioned' } }
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
    // Selected before the first turn: no worktree yet, so the project folder (and its branch) shows.
    expect(seen).toMatchObject({ path: PROJECT, workspaceThreadId: null })

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
