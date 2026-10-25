import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainView } from '../src/shared/types'
import type { ChatReference } from '../src/shared/chatReferences'
import { sanitizeSavedWorkspace, useAppStore } from '../src/renderer/stores/appStore'
import { openChatReference } from '../src/renderer/components/ReferencePill'

// Workspaces saved before the Agents tab was removed still name it.
const legacy = (mainView: string, openedSurfaceKinds: unknown) => ({ mainView: mainView as MainView, openedSurfaceKinds: openedSurfaceKinds as MainView[] })

describe('sanitizeSavedWorkspace', () => {
  it.each([
    ['agents is the view and the only open surface', legacy('agents', ['agents']), { mainView: 'browser', openedSurfaceKinds: [] }],
    ['agents is the view and nothing is open', legacy('agents', []), { mainView: 'browser', openedSurfaceKinds: [] }],
    ['agents is the view beside other surfaces', legacy('agents', ['agents', 'terminal', 'files']), { mainView: 'terminal', openedSurfaceKinds: ['terminal', 'files'] }],
    ['agents sits in the middle of the open surfaces', legacy('files', ['terminal', 'agents', 'files']), { mainView: 'files', openedSurfaceKinds: ['terminal', 'files'] }],
    ['no agents anywhere', legacy('git', ['files', 'git']), { mainView: 'git', openedSurfaceKinds: ['files', 'git'] }],
    ['open surfaces were never saved as a list', legacy('agents', undefined), { mainView: 'browser', openedSurfaceKinds: [] }]
  ])('%s', (_name, saved, expected) => {
    expect(sanitizeSavedWorkspace(saved)).toMatchObject(expected)
  })

  it('keeps unrelated saved fields', () => {
    expect(sanitizeSavedWorkspace({ ...legacy('agents', ['agents']), sidebarWidth: 41, chatMode: 'plan' })).toMatchObject({ sidebarWidth: 41, chatMode: 'plan' })
  })
})

describe('profile activation with saved workspaces', () => {
  it('drops the retired view when a profile loads and keeps it dropped across profile switches', () => {
    const saved = new Map<string, string>([
      ['mousse-profile-old-workspace', JSON.stringify({ mainView: 'agents', openedSurfaceKinds: ['agents', 'terminal'], sidebarWidth: 37 })],
      ['mousse-profile-only-agents-workspace', JSON.stringify({ mainView: 'agents', openedSurfaceKinds: ['agents'] })]
    ])
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) }, removeItem: (key: string) => { saved.delete(key) } } })
    const { activateProfile } = useAppStore.getState()

    activateProfile('old')
    expect(useAppStore.getState()).toMatchObject({ profileId: 'old', mainView: 'terminal', openedSurfaceKinds: ['terminal'], sidebarWidth: 37 })

    activateProfile('only-agents')
    expect(useAppStore.getState()).toMatchObject({ profileId: 'only-agents', mainView: 'browser', openedSurfaceKinds: [] })

    // A profile with nothing saved starts on the default view with nothing open.
    activateProfile('fresh')
    expect(useAppStore.getState()).toMatchObject({ profileId: 'fresh', mainView: 'browser', openedSurfaceKinds: [] })

    // Leaving a profile saved it; coming back must not bring the Agents view back.
    activateProfile('old')
    expect(JSON.parse(saved.get('mousse-profile-old-workspace')!)).toMatchObject({ mainView: 'terminal', openedSurfaceKinds: ['terminal'] })
    expect(useAppStore.getState()).toMatchObject({ profileId: 'old', mainView: 'terminal', openedSurfaceKinds: ['terminal'] })
    vi.unstubAllGlobals()
  })
})

describe('view fallbacks when a surface or document closes', () => {
  beforeEach(() => {
    useAppStore.setState({ agents: [], mainView: 'browser', openedSurfaceKinds: [], documentTabs: [], activeDocumentTabId: null, documentsTabVisible: false })
  })

  it('moves to the first remaining open surface, ignoring any running agents', () => {
    useAppStore.setState({ agents: [{ id: 'live' } as never], mainView: 'files', openedSurfaceKinds: ['terminal', 'files'] })
    useAppStore.getState().closeSurfaceKind('files')
    expect(useAppStore.getState()).toMatchObject({ mainView: 'terminal', openedSurfaceKinds: ['terminal'] })
  })

  it('keeps the view when the last surface closes (the empty area shows the surface picker)', () => {
    useAppStore.setState({ mainView: 'git', openedSurfaceKinds: ['git'] })
    useAppStore.getState().closeSurfaceKind('git')
    expect(useAppStore.getState()).toMatchObject({ mainView: 'git', openedSurfaceKinds: [] })
  })

  it('leaves the view alone when another surface closes', () => {
    useAppStore.setState({ mainView: 'terminal', openedSurfaceKinds: ['terminal', 'files'] })
    useAppStore.getState().closeSurfaceKind('files')
    expect(useAppStore.getState().mainView).toBe('terminal')
  })

  it.each([
    ['an open surface', ['files'] as MainView[], 'files'],
    ['nothing open', [] as MainView[], 'browser']
  ])('closing the last document falls back to %s', (_name, opened, expected) => {
    useAppStore.setState({ openedSurfaceKinds: opened })
    const id = useAppStore.getState().openDocument('Notes', '# notes')
    expect(useAppStore.getState().mainView).toBe('documents')
    useAppStore.getState().closeDocumentTab(id)
    expect(useAppStore.getState()).toMatchObject({ mainView: expected, documentsTabVisible: false })
  })

  it('stays on documents while another document remains', () => {
    const first = useAppStore.getState().openDocument('One', '1')
    useAppStore.getState().openDocument('Two', '2')
    useAppStore.getState().closeDocumentTab(first)
    expect(useAppStore.getState().mainView).toBe('documents')
  })
})

describe('old agent references', () => {
  const agentRef = (extra: Partial<ChatReference>): ChatReference => ({ id: 'ref', kind: 'agent', title: 'Old agent', agentId: 'agent-1', sessionId: 'pty-1', ...extra })
  const select = vi.fn(async () => {})
  beforeEach(() => {
    select.mockClear()
    vi.stubGlobal('window', { mousse: { threads: { select } } })
    useAppStore.setState({ activeThreadId: 'current', mainView: 'files', mainAreaOpen: false, openedSurfaceKinds: ['files'] })
  })

  it('opens the thread that owns the agent and leaves the main area alone', () => {
    openChatReference(agentRef({ threadId: 'owner' }))
    expect(select).toHaveBeenCalledWith('owner')
    expect(useAppStore.getState()).toMatchObject({ activeThreadId: 'owner', mainView: 'files', mainAreaOpen: false, openedSurfaceKinds: ['files'] })
  })

  it('does nothing more when that thread is already open', () => {
    openChatReference(agentRef({ threadId: 'current' }))
    expect(select).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeThreadId).toBe('current')
  })

  it('does nothing without a thread to open', () => {
    openChatReference(agentRef({}))
    expect(select).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({ activeThreadId: 'current', mainView: 'files' })
  })
})
