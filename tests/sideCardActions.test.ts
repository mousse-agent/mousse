import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickActionDialog } from '../src/renderer/components/QuickActionEditor'
import { ActionsSection } from '../src/renderer/components/sideCard/ActionsSection'
import {
  DONE_FEEDBACK_MS,
  ERROR_FEEDBACK_MS,
  createRunController,
  type RunFeedback
} from '../src/renderer/components/sideCard/actionsRunLogic'
import type { QuickAction } from '../src/renderer/lib/quickActions'
import { loadQuickActions, saveQuickActions } from '../src/renderer/lib/quickActions'
import { profilePreferenceKey } from '../src/renderer/lib/profilePreferences'
import { useAppStore } from '../src/renderer/stores/appStore'
import { startQuickActionsSync, useQuickActionsStore } from '../src/renderer/stores/quickActionsStore'

const storage = new Map<string, string>()
const stored = (profileId: string) =>
  JSON.parse(storage.get(profilePreferenceKey(profileId, 'quickActions.v1')) ?? 'null') as Array<{ id: string; label: string }> | null
const labels = () => useQuickActionsStore.getState().actions.map((action) => action.label)
const input = (label: string, payload = 'echo hi') => ({ label, kind: 'bash' as const, payload })

const setProfile = (profileId: string) => useAppStore.setState({ profileId })

// Server rendering reads a store's initial state, so the seed goes there too.
const initialApp = { ...useAppStore.getInitialState() }
const initialActions = { ...useQuickActionsStore.getInitialState() }
const seedRender = (appProfile: string) => {
  Object.assign(useAppStore.getInitialState(), { profileId: appProfile })
  const { profileId, actions } = useQuickActionsStore.getState()
  Object.assign(useQuickActionsStore.getInitialState(), { profileId, actions })
}
const render = () => renderToStaticMarkup(createElement(ActionsSection, { threadId: 't1', projectId: null }))

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) }
  })
  useQuickActionsStore.setState({ profileId: null, actions: [] })
  setProfile('alice')
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({ profileId: 'default' })
  useQuickActionsStore.setState({ profileId: null, actions: [] })
  Object.assign(useAppStore.getInitialState(), initialApp)
  Object.assign(useQuickActionsStore.getInitialState(), initialActions)
})

describe('quick actions store', () => {
  it('loads the seeded list for a profile and keeps profiles separate', () => {
    useQuickActionsStore.getState().syncProfile()
    expect(labels()).toEqual(['Commit and push'])

    useQuickActionsStore.getState().add(input('Alice only'), 'alice')
    setProfile('bob')
    useQuickActionsStore.getState().syncProfile()
    expect(labels()).toEqual(['Commit and push'])
    expect(stored('alice')?.map((action) => action.label)).toEqual(['Commit and push', 'Alice only'])

    setProfile('alice')
    useQuickActionsStore.getState().syncProfile()
    expect(labels()).toEqual(['Commit and push', 'Alice only'])
  })

  it('writes a mutation to the active profile even if the profile changed since the last load', () => {
    saveQuickActions([], 'bob')
    useQuickActionsStore.getState().syncProfile()
    setProfile('bob')
    useQuickActionsStore.getState().add(input('Bob action'), 'bob')
    expect(stored('bob')?.map((action) => action.label)).toEqual(['Bob action'])
    expect(stored('alice')?.map((action) => action.label)).toEqual(['Commit and push'])
  })

  it('adds, edits and removes through the store and persists each change', () => {
    const store = useQuickActionsStore.getState()
    store.add(input('Status', 'git status'), 'alice')
    const added = useQuickActionsStore.getState().actions.find((action) => action.label === 'Status')
    expect(added).toMatchObject({ kind: 'bash', payload: 'git status' })

    useQuickActionsStore.getState().update(added!.id, { label: '  Status short  ', kind: 'send-current', payload: 'Show status' }, 'alice')
    expect(useQuickActionsStore.getState().actions.find((action) => action.id === added!.id)).toMatchObject({
      label: 'Status short', kind: 'send-current', payload: 'Show status'
    })
    expect(loadQuickActions('alice').some((action) => action.label === 'Status short')).toBe(true)

    useQuickActionsStore.getState().remove(added!.id, 'alice')
    expect(labels()).toEqual(['Commit and push'])
    expect(stored('alice')?.map((action) => action.label)).toEqual(['Commit and push'])
  })

  it('ignores add, update and remove made for a profile that is no longer active', () => {
    useQuickActionsStore.getState().syncProfile()
    const builtIn = useQuickActionsStore.getState().actions[0]
    expect(builtIn.label).toBe('Commit and push')

    // The editor was opened in alice's profile, then the user switched to bob.
    setProfile('bob')
    const stale = useQuickActionsStore.getState()
    stale.update(builtIn.id, { label: 'Edited in alice', kind: 'bash', payload: 'echo alice' }, 'alice')
    stale.add(input('Added in alice'), 'alice')
    stale.remove(builtIn.id, 'alice')

    useQuickActionsStore.getState().syncProfile()
    expect(useQuickActionsStore.getState().profileId).toBe('bob')
    expect(labels()).toEqual(['Commit and push'])
    expect(useQuickActionsStore.getState().actions[0]).toMatchObject({ id: builtIn.id, kind: 'send-current' })
    // Neither profile's saved list changed.
    expect(stored('alice')?.map((action) => action.label)).toEqual(['Commit and push'])
    expect(stored('bob')?.map((action) => action.label)).toEqual(['Commit and push'])
  })

  it('still applies an edit made for the active profile after another profile was open', () => {
    useQuickActionsStore.getState().syncProfile()
    const builtIn = useQuickActionsStore.getState().actions[0]
    setProfile('bob')
    useQuickActionsStore.getState().update(builtIn.id, { label: 'Bob edit', kind: 'bash', payload: 'echo bob' }, 'bob')
    expect(labels()).toEqual(['Bob edit'])
    expect(stored('bob')?.map((action) => action.label)).toEqual(['Bob edit'])
    expect(stored('alice')?.map((action) => action.label)).toEqual(['Commit and push'])
  })

  it('adds an action created by the agent once and ignores malformed ones', () => {
    const created = { id: 'agent-1', label: 'Run tests', kind: 'bash', payload: 'npm test' }
    const store = useQuickActionsStore.getState()
    store.receiveCreated(created)
    useQuickActionsStore.getState().receiveCreated(created)
    useQuickActionsStore.getState().receiveCreated({ label: '', kind: 'bash', payload: 'x' })
    useQuickActionsStore.getState().receiveCreated(null)
    expect(labels()).toEqual(['Commit and push', 'Run tests'])
    expect(stored('alice')?.filter((action) => action.id === 'agent-1')).toHaveLength(1)
  })

  it('feeds onCreated events from the bridge into the store, and follows profile switches', () => {
    let publish!: (raw: unknown) => void
    const unsubscribe = vi.fn()
    vi.stubGlobal('window', {
      mousse: { quickActions: { onCreated: (cb: (raw: unknown) => void) => { publish = cb; return unsubscribe } } }
    })
    const stop = startQuickActionsSync()
    try {
      expect(startQuickActionsSync()).toBe(stop)
      expect(useQuickActionsStore.getState().profileId).toBe('alice')

      const created = { id: 'agent-2', label: 'Lint', kind: 'bash', payload: 'npm run lint' }
      publish(created)
      publish(created)
      expect(labels()).toEqual(['Commit and push', 'Lint'])

      setProfile('bob')
      expect(useQuickActionsStore.getState().profileId).toBe('bob')
      expect(labels()).toEqual(['Commit and push'])
      publish({ id: 'agent-3', label: 'Bob lint', kind: 'bash', payload: 'npm run lint' })
      expect(stored('bob')?.map((action) => action.id)).toContain('agent-3')
      expect(stored('alice')?.map((action) => action.id)).not.toContain('agent-3')
    } finally {
      stop()
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('quick actions sync start', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('subscribes to agent-created actions once when the store module loads, and again calls reuse it', async () => {
    vi.resetModules()
    const onCreated = vi.fn(() => vi.fn())
    vi.stubGlobal('window', { mousse: { quickActions: { onCreated } } })
    const fresh = await import('../src/renderer/stores/quickActionsStore')
    expect(onCreated).toHaveBeenCalledTimes(1)
    const stop = fresh.startQuickActionsSync()
    expect(fresh.startQuickActionsSync()).toBe(stop)
    expect(onCreated).toHaveBeenCalledTimes(1)
    stop()
  })

  it('has one start path: the store module, not the section', () => {
    const section = readFileSync(new URL('../src/renderer/components/sideCard/ActionsSection.tsx', import.meta.url), 'utf8')
    expect(section).not.toContain('startQuickActionsSync')
    const store = readFileSync(new URL('../src/renderer/stores/quickActionsStore.ts', import.meta.url), 'utf8')
    expect(store).toMatch(/window\.mousse\) startQuickActionsSync\(\)/)
  })
})

describe('running actions', () => {
  const action = (id: string): QuickAction => ({
    id, label: id, kind: 'bash', payload: 'echo', createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z'
  })
  const deferred = () => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('reports running, then done, then clears itself', async () => {
    const seen: Array<RunFeedback | null> = []
    const runs = createRunController({ execute: async () => undefined, onFeedback: (feedback) => seen.push(feedback) })
    await runs.run(action('a'), 'alice')
    expect(seen).toEqual([{ id: 'a', phase: 'running' }, { id: 'a', phase: 'done' }])
    vi.advanceTimersByTime(DONE_FEEDBACK_MS)
    expect(seen.at(-1)).toBeNull()
  })

  it('shows a failure message for longer than the done check', async () => {
    const seen: Array<RunFeedback | null> = []
    const runs = createRunController({
      execute: async () => { throw new Error('Profile changed while the quick action was running.') },
      onFeedback: (feedback) => seen.push(feedback)
    })
    await runs.run(action('a'), 'alice')
    expect(seen.at(-1)).toEqual({ id: 'a', phase: 'error', message: 'Profile changed while the quick action was running.' })
    vi.advanceTimersByTime(DONE_FEEDBACK_MS)
    expect(seen.at(-1)).not.toBeNull()
    vi.advanceTimersByTime(ERROR_FEEDBACK_MS)
    expect(seen.at(-1)).toBeNull()
  })

  it('ignores a slow action that finishes after it was cancelled, and clears the feedback', async () => {
    const slow = deferred()
    const seen: Array<RunFeedback | null> = []
    // One controller per profile; the store cancels the departing profile's.
    const forAlice = createRunController({ execute: () => slow.promise, onFeedback: (feedback) => seen.push(feedback) })
    const pending = forAlice.run(action('a'), 'alice')
    forAlice.cancel()
    const bobSeen: Array<RunFeedback | null> = []
    const forBob = createRunController({ execute: () => new Promise<void>(() => undefined), onFeedback: (feedback) => bobSeen.push(feedback) })
    void forBob.run(action('b'), 'bob')

    slow.resolve()
    await pending
    vi.advanceTimersByTime(ERROR_FEEDBACK_MS)
    expect(seen).toEqual([{ id: 'a', phase: 'running' }, null])
    expect(bobSeen).toEqual([{ id: 'b', phase: 'running' }])
  })

  it('ignores a failure that arrives after cancel', async () => {
    const slow = deferred()
    const seen: Array<RunFeedback | null> = []
    const runs = createRunController({ execute: () => slow.promise, onFeedback: (feedback) => seen.push(feedback) })
    const pending = runs.run(action('a'), 'alice')
    runs.cancel()
    slow.reject(new Error('late'))
    await pending
    expect(seen).toEqual([{ id: 'a', phase: 'running' }, null])
  })

  it('does not start a second run while one is still in flight', async () => {
    const first = deferred()
    const seen: Array<RunFeedback | null> = []
    const execute = vi.fn(() => first.promise)
    const runs = createRunController({ execute, onFeedback: (feedback) => seen.push(feedback) })
    const older = runs.run(action('a'), 'alice')
    expect(runs.isRunning()).toBe(true)
    await runs.run(action('a'), 'alice')
    await runs.run(action('b'), 'alice')
    expect(execute).toHaveBeenCalledTimes(1)
    first.resolve()
    await older
    expect(seen).toEqual([{ id: 'a', phase: 'running' }, { id: 'a', phase: 'done' }])
    expect(runs.isRunning()).toBe(false)
    await runs.run(action('b'), 'alice')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('stays blocked after cancel until the action itself settles', async () => {
    const slow = deferred()
    const execute = vi.fn(() => slow.promise)
    const runs = createRunController({ execute, onFeedback: () => undefined })
    const pending = runs.run(action('a'), 'alice')
    runs.cancel()
    expect(runs.isRunning()).toBe(true)
    await runs.run(action('a'), 'alice')
    expect(execute).toHaveBeenCalledTimes(1)
    slow.resolve()
    await pending
    expect(runs.isRunning()).toBe(false)
  })

  it('clears the pending reset timer when cancelled', async () => {
    const seen: Array<RunFeedback | null> = []
    const runs = createRunController({ execute: async () => undefined, onFeedback: (feedback) => seen.push(feedback) })
    await runs.run(action('a'), 'alice')
    runs.cancel()
    const count = seen.length
    vi.advanceTimersByTime(ERROR_FEEDBACK_MS)
    expect(seen).toHaveLength(count)
    expect(seen.at(-1)).toBeNull()
  })
})

describe('quick action editor dialog', () => {
  const dialog = (action: QuickAction | null = null) =>
    renderToStaticMarkup(createElement(QuickActionDialog, {
      action,
      onSave: () => undefined,
      onDelete: action ? () => undefined : undefined,
      onClose: () => undefined
    }))

  it('is a titled modal dialog that can take focus itself', () => {
    const html = dialog()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toMatch(/aria-labelledby="([^"]+)"[\s\S]*<h3 id="\1">Create action<\/h3>/)
    expect(html).toContain('tabindex="-1"')
    expect(dialog({
      id: 'x', label: 'X', kind: 'bash', payload: 'ls', createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z'
    })).toContain('>Edit action</h3>')
  })

  it('uses the shared modal look, with the fields in the body and the buttons in the footer', () => {
    const html = dialog({
      id: 'x', label: 'X', kind: 'bash', payload: 'ls', createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z'
    })
    expect(html).toContain('class="modal-overlay"')
    expect(html).toContain('class="modal"')
    expect(html).toContain('modal-close')
    const body = html.slice(html.indexOf('class="modal-body"'), html.indexOf('class="modal-footer"'))
    const footer = html.slice(html.indexOf('class="modal-footer"'))
    expect(body).toContain('<input')
    expect(body).toContain('<textarea')
    expect(footer).toContain('Delete')
    expect(footer).toContain('Cancel')
    expect(footer).toContain('btn btn-primary')
  })

  it('is built on the shared modal', () => {
    const source = readFileSync(new URL('../src/renderer/components/QuickActionEditor.tsx', import.meta.url), 'utf8')
    expect(source).toContain("import { Modal } from './ui/Modal'")
    expect(source).not.toContain('quick-actions-backdrop')
  })
})

describe('actions section rendering', () => {
  it('lists each action with an edit control, then the add row', () => {
    useQuickActionsStore.getState().syncProfile()
    useQuickActionsStore.getState().add(input('Run tests', 'npm test'), 'alice')
    seedRender('alice')
    const html = render()
    expect(html).toContain('Actions')
    expect(html).toContain('Commit and push')
    expect(html).toContain('Run tests')
    expect(html).toContain('aria-label="Edit Run tests"')
    expect(html).toContain('Add action')
    expect(html.indexOf('Add action')).toBeGreaterThan(html.indexOf('Run tests'))
    expect(html).not.toContain('modal-overlay')
  })

  it('shows only the add row when the list is empty', () => {
    saveQuickActions([], 'alice')
    useQuickActionsStore.getState().syncProfile()
    seedRender('alice')
    const html = render()
    expect(html).toContain('Add action')
    expect(html).not.toContain('side-card-action-run')
  })

  it('renders no list while the store still holds another profile', () => {
    useQuickActionsStore.getState().syncProfile()
    seedRender('bob')
    const html = render()
    expect(html).not.toContain('Commit and push')
    expect(html).toContain('Add action')
  })
})
