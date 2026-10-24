import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionsSection } from '../src/renderer/components/sideCard/ActionsSection'
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

    useQuickActionsStore.getState().add(input('Alice only'))
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
    useQuickActionsStore.getState().add(input('Bob action'))
    expect(stored('bob')?.map((action) => action.label)).toEqual(['Bob action'])
    expect(stored('alice')?.map((action) => action.label)).toEqual(['Commit and push'])
  })

  it('adds, edits and removes through the store and persists each change', () => {
    const store = useQuickActionsStore.getState()
    store.add(input('Status', 'git status'))
    const added = useQuickActionsStore.getState().actions.find((action) => action.label === 'Status')
    expect(added).toMatchObject({ kind: 'bash', payload: 'git status' })

    useQuickActionsStore.getState().update(added!.id, { label: '  Status short  ', kind: 'send-current', payload: 'Show status' })
    expect(useQuickActionsStore.getState().actions.find((action) => action.id === added!.id)).toMatchObject({
      label: 'Status short', kind: 'send-current', payload: 'Show status'
    })
    expect(loadQuickActions('alice').some((action) => action.label === 'Status short')).toBe(true)

    useQuickActionsStore.getState().remove(added!.id)
    expect(labels()).toEqual(['Commit and push'])
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

describe('actions section rendering', () => {
  it('lists each action with an edit control, then the add row', () => {
    useQuickActionsStore.getState().syncProfile()
    useQuickActionsStore.getState().add(input('Run tests', 'npm test'))
    seedRender('alice')
    const html = render()
    expect(html).toContain('Actions')
    expect(html).toContain('Commit and push')
    expect(html).toContain('Run tests')
    expect(html).toContain('aria-label="Edit Run tests"')
    expect(html).toContain('Add action')
    expect(html.indexOf('Add action')).toBeGreaterThan(html.indexOf('Run tests'))
    expect(html).not.toContain('quick-actions-dialog')
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
