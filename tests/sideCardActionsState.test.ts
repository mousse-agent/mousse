import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickActionDialog, QuickActionEditorHost } from '../src/renderer/components/QuickActionEditor'
import { ActionsSection } from '../src/renderer/components/sideCard/ActionsSection'
import {
  ACTIONS_FOCUS_ANCHOR,
  DONE_FEEDBACK_MS,
  ERROR_FEEDBACK_MS,
  refocusActionsSection
} from '../src/renderer/components/sideCard/actionsRunLogic'
import { executeQuickAction } from '../src/renderer/lib/executeQuickAction'
import type { QuickAction } from '../src/renderer/lib/quickActions'
import { useAppStore } from '../src/renderer/stores/appStore'
import { useQuickActionsStore } from '../src/renderer/stores/quickActionsStore'

vi.mock('../src/renderer/lib/executeQuickAction', () => ({ executeQuickAction: vi.fn() }))
// Server rendering has no document to portal into, so the portal renders in place.
vi.mock('../src/renderer/lib/floatingLayer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/lib/floatingLayer')>()),
  FloatingPortal: ({ children }: { children: unknown }) => children
}))
const execute = vi.mocked(executeQuickAction)

const action = (id: string, label = id): QuickAction => ({
  id, label, kind: 'bash', payload: 'echo', createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z'
})
const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const setProfile = (profileId: string) => useAppStore.setState({ profileId })
const runs = () => useQuickActionsStore.getState().runs

const storage = new Map<string, string>()
const initialApp = { ...useAppStore.getInitialState() }
const initialActions = { ...useQuickActionsStore.getInitialState() }

/** Server rendering reads a store's initial state, so what a render should see is seeded there. */
const seedRender = (appProfile: string, actions: Partial<ReturnType<typeof useQuickActionsStore.getState>>) => {
  Object.assign(useAppStore.getInitialState(), { profileId: appProfile })
  Object.assign(useQuickActionsStore.getInitialState(), actions)
}

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) }
  })
  execute.mockReset()
  useQuickActionsStore.setState({ profileId: null, actions: [], runs: {}, editor: null })
  setProfile('alice')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useAppStore.setState({ profileId: 'default' })
  useQuickActionsStore.setState({ profileId: null, actions: [], runs: {}, editor: null })
  Object.assign(useAppStore.getInitialState(), initialApp)
  Object.assign(useQuickActionsStore.getInitialState(), initialActions)
})

describe('run state in the quick actions store', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('keeps running, done and error per profile without any component mounted', async () => {
    const gate = deferred()
    execute.mockReturnValueOnce(gate.promise)
    const pending = useQuickActionsStore.getState().runAction(action('a'), 'alice')
    expect(runs()).toEqual({ alice: { id: 'a', phase: 'running' } })
    gate.resolve()
    await pending
    expect(runs().alice).toEqual({ id: 'a', phase: 'done' })
    vi.advanceTimersByTime(DONE_FEEDBACK_MS)
    expect(runs()).toEqual({})

    execute.mockRejectedValueOnce(new Error('Terminal did not start in time.'))
    await useQuickActionsStore.getState().runAction(action('a'), 'alice')
    vi.advanceTimersByTime(DONE_FEEDBACK_MS)
    expect(runs().alice).toEqual({ id: 'a', phase: 'error', message: 'Terminal did not start in time.' })
    vi.advanceTimersByTime(ERROR_FEEDBACK_MS)
    expect(runs()).toEqual({})
  })

  it('does not start an action again, or another one, while it is running', async () => {
    const gate = deferred()
    execute.mockReturnValue(gate.promise)
    const store = useQuickActionsStore.getState()
    const first = store.runAction(action('a'), 'alice')
    await store.runAction(action('a'), 'alice')
    await store.runAction(action('b'), 'alice')
    expect(execute).toHaveBeenCalledTimes(1)
    gate.resolve()
    await first
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a profile that is not active', async () => {
    await useQuickActionsStore.getState().runAction(action('a'), 'bob')
    expect(execute).not.toHaveBeenCalled()
    expect(runs()).toEqual({})
  })

  it('drops the departing profile feedback on a switch and ignores its late result', async () => {
    const gate = deferred()
    execute.mockReturnValueOnce(gate.promise)
    const pending = useQuickActionsStore.getState().runAction(action('a'), 'alice')
    useQuickActionsStore.getState().syncProfile()
    expect(runs().alice).toEqual({ id: 'a', phase: 'running' })

    setProfile('bob')
    useQuickActionsStore.getState().syncProfile()
    expect(runs()).toEqual({})

    execute.mockResolvedValueOnce(undefined)
    await useQuickActionsStore.getState().runAction(action('b'), 'bob')
    gate.reject(new Error('Profile changed while the quick action was running.'))
    await pending
    vi.advanceTimersByTime(DONE_FEEDBACK_MS - 1)
    expect(runs()).toEqual({ bob: { id: 'b', phase: 'done' } })
  })
})

describe('editor state in the quick actions store', () => {
  it('opens for a target and closes', () => {
    const store = useQuickActionsStore.getState()
    store.openEditor({ mode: 'edit', action: action('a') }, 'alice')
    expect(useQuickActionsStore.getState().editor).toEqual({ profileId: 'alice', target: { mode: 'edit', action: action('a') } })
    store.closeEditor()
    expect(useQuickActionsStore.getState().editor).toBeNull()
  })

  it('does not open for a profile that is not active', () => {
    useQuickActionsStore.getState().openEditor({ mode: 'add' }, 'bob')
    expect(useQuickActionsStore.getState().editor).toBeNull()
  })

  it('closes when the profile switches', () => {
    useQuickActionsStore.getState().syncProfile()
    useQuickActionsStore.getState().openEditor({ mode: 'add' }, 'alice')
    setProfile('bob')
    useQuickActionsStore.getState().syncProfile()
    expect(useQuickActionsStore.getState().editor).toBeNull()
  })
})

describe('editor host', () => {
  it('renders the open editor outside the card, for the profile it was opened in', () => {
    seedRender('alice', { editor: { profileId: 'alice', target: { mode: 'edit', action: action('a', 'Deploy') } } })
    const html = renderToStaticMarkup(createElement(QuickActionEditorHost))
    expect(html).toContain('aria-label="Edit action"')
    expect(html).toContain('value="Deploy"')
  })

  it('renders nothing when no editor is open or it belongs to another profile', () => {
    seedRender('alice', { editor: null })
    expect(renderToStaticMarkup(createElement(QuickActionEditorHost))).toBe('')
    seedRender('bob', { editor: { profileId: 'alice', target: { mode: 'add' } } })
    expect(renderToStaticMarkup(createElement(QuickActionEditorHost))).toBe('')
  })

  it('uses the shared select for the type field, not a native one', () => {
    const html = renderToStaticMarkup(createElement(QuickActionDialog, { action: null, onSave: () => undefined, onClose: () => undefined }))
    expect(html).not.toContain('<select')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('ui-select')
    expect(html).toContain('Send in current chat')
  })
})

describe('refocusActionsSection', () => {
  const stubDocument = (active: unknown) => {
    const anchor = { focus: vi.fn() }
    const body = {}
    const doc = {
      body,
      activeElement: active === 'body' ? body : active,
      querySelector: vi.fn(() => anchor)
    }
    return { doc: doc as unknown as Document, anchor }
  }

  it('focuses the section when focus fell to the page', () => {
    const { doc, anchor } = stubDocument('body')
    refocusActionsSection(doc)
    expect(doc.querySelector).toHaveBeenCalledWith(`[${ACTIONS_FOCUS_ANCHOR}]`)
    expect(anchor.focus).toHaveBeenCalled()
  })

  it('focuses the section when the focused element was removed', () => {
    const { doc, anchor } = stubDocument({ isConnected: false })
    refocusActionsSection(doc)
    expect(anchor.focus).toHaveBeenCalled()
  })

  it('leaves focus alone when it already sits on a live control', () => {
    const { doc, anchor } = stubDocument({ isConnected: true })
    refocusActionsSection(doc)
    expect(anchor.focus).not.toHaveBeenCalled()
  })
})

describe('actions section accessibility', () => {
  const render = () => renderToStaticMarkup(createElement(ActionsSection, { threadId: 't1', projectId: null }))
  const seedActions = (extra: Partial<ReturnType<typeof useQuickActionsStore.getState>> = {}) =>
    seedRender('alice', { profileId: 'alice', actions: [action('a', 'Run tests'), action('b', 'Lint')], ...extra })

  it('keeps the add row out of the list', () => {
    seedActions()
    const html = render()
    expect(html).toMatch(/role="list"/)
    expect(html).toMatch(/<\/div><button[^>]*side-card-action-add/)
    expect(html).toContain(`${ACTIONS_FOCUS_ANCHOR}=""`)
    expect(html.indexOf('side-card-action-add')).toBeGreaterThan(html.lastIndexOf('role="listitem"'))
  })

  it('renders no list at all when there are no actions', () => {
    seedActions({ actions: [] })
    const html = render()
    expect(html).not.toContain('role="list"')
    expect(html).toContain('Add action')
  })

  it('blocks rows with aria-disabled while an action runs, never the disabled attribute', () => {
    seedActions({ runs: { alice: { id: 'a', phase: 'running' } } })
    const html = render()
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/)
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(4)
    // Only the other row is dimmed; the running one keeps its spinner at full strength.
    expect(html.match(/data-blocked/g)).toHaveLength(1)
    expect(html).toContain('title="An action is running"')
    expect(html).toContain('aria-label="Running"')
  })

  it('leaves every row interactive when nothing runs', () => {
    seedActions()
    const html = render()
    expect(html).not.toContain('aria-disabled')
    expect(html).not.toContain('data-blocked')
  })
})
