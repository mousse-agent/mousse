// @vitest-environment jsdom
/**
 * The sidebar's tab (`threadsSidebarView`) and the workspace beside it (`sidebarMode`) always agree: under Chats the
 * workspace is `ChatWorkspace`, never the new-thread composer or a thread. Something that opens a thread from Chats
 * moves the sidebar to the thread list tab used last; a saved pair that disagrees is repaired from the tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { agreeWithTab, type SidebarTabPair } from '../../src/renderer/stores/sidebarTabAgreement'
import { createAndSelectThread, selectThread } from '../../src/renderer/lib/threadActions'
import { openThread } from '../../src/renderer/lib/openThread'
import { showProjectInSidebar } from '../../src/renderer/lib/sidebarReveal'
import { inboxPageClosed, inboxPageOpened, openRun } from '../../src/renderer/components/automations/inbox/inboxStore'
import type { Thread } from '../../src/shared/types'

const initial = useAppStore.getInitialState()
const select = vi.fn(async () => undefined)

function thread(id: string, startedAt?: string): Thread {
  return { id, name: 'New thread', projectId: 'p1', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...(startedAt ? { startedAt } : {}) } as Thread
}

/** The sidebar on Chats with a bot open, after the person last used `last`. */
function onChats(last: 'projects' | 'threads' = 'projects'): void {
  useAppStore.getState().setThreadsSidebarView(last)
  useAppStore.getState().setThreadsSidebarView('chats')
}

function pair() {
  const { threadsSidebarView, sidebarMode, lastThreadListView } = useAppStore.getState()
  return { threadsSidebarView, sidebarMode, lastThreadListView }
}

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = { threads: { select, create: vi.fn(async () => thread('created')) } }
  useAppStore.setState({ ...initial, threads: [thread('t-old', '2026-11-01T00:00:00Z'), thread('t-draft')], activeThreadId: null })
})
afterEach(() => {
  useAppStore.setState(initial, true)
  select.mockClear()
})

describe('agreeWithTab', () => {
  const base: SidebarTabPair = { threadsSidebarView: 'chats', sidebarMode: 'chats', lastThreadListView: 'threads' }
  // before → update → the pair after it
  const rows: Array<[string, SidebarTabPair, Partial<SidebarTabPair>, Partial<SidebarTabPair>]> = [
    ['the workspace leaves Chats: the tab goes to the list used last', base, { sidebarMode: 'projects' }, { threadsSidebarView: 'threads', sidebarMode: 'projects' }],
    ['the workspace goes to Chats: the tab follows', { ...base, threadsSidebarView: 'projects', sidebarMode: 'projects' }, { sidebarMode: 'chats' }, { threadsSidebarView: 'chats', sidebarMode: 'chats' }],
    ['a tab click onto Chats: the workspace follows', { ...base, threadsSidebarView: 'projects', sidebarMode: 'projects' }, { threadsSidebarView: 'chats' }, { threadsSidebarView: 'chats', sidebarMode: 'chats' }],
    ['a tab click off Chats: the workspace follows and the list is remembered', base, { threadsSidebarView: 'projects' }, { threadsSidebarView: 'projects', sidebarMode: 'projects', lastThreadListView: 'projects' }],
    ['a restored pair that disagrees (Chats tab, thread workspace): the workspace follows the tab', base, { threadsSidebarView: 'chats', sidebarMode: 'projects' }, { threadsSidebarView: 'chats', sidebarMode: 'chats' }],
    ['a restored pair that disagrees (Threads tab, Chats workspace): the workspace follows the tab', base, { threadsSidebarView: 'threads', sidebarMode: 'chats' }, { threadsSidebarView: 'threads', sidebarMode: 'projects' }],
    ['an update that names neither leaves an agreeing pair alone', base, {}, base]
  ]
  it.each(rows)('%s', (_name, before, update, after) => {
    expect({ ...before, ...agreeWithTab(before, update) }).toMatchObject(after)
  })
})

describe('opening a thread or the new-thread screen from Chats', () => {
  // Each is a path that set only the workspace and used to leave the sidebar on Chats.
  const paths: Array<[string, () => unknown]> = [
    ['new thread (shortcut, title bar, palette)', () => createAndSelectThread()],
    ['a search result or notification (selectThread)', () => selectThread('t-old')],
    ['a link to another thread (openThread)', () => openThread('t-old')],
    ['the store switching threads', () => useAppStore.getState().switchToThread('t-old')],
    ['a panel surface opening', () => useAppStore.getState().openSurfaceKind('files')],
    ['the panel view changing', () => useAppStore.getState().setMainView('git')]
  ]
  it.each(paths)('%s moves the sidebar to the list tab used last', async (_name, open) => {
    for (const last of ['projects', 'threads'] as const) {
      onChats(last)
      await open()
      expect(pair()).toEqual({ threadsSidebarView: last, sidebarMode: 'projects', lastThreadListView: last })
    }
  })

  it('the action itself still happens', async () => {
    onChats()
    await createAndSelectThread()
    const opened = useAppStore.getState().activeThreadId
    expect(opened).toBeTruthy()
    expect(select).toHaveBeenCalledWith(opened)
  })
})

describe('moving the tab', () => {
  it('opening a bot or chat (Chats tab) shows Chats; the title bar path to a project shows its threads', () => {
    useAppStore.getState().setThreadsSidebarView('chats')
    expect(pair()).toMatchObject({ threadsSidebarView: 'chats', sidebarMode: 'chats' })
    showProjectInSidebar('p1')
    expect(pair()).toMatchObject({ threadsSidebarView: 'projects', sidebarMode: 'projects' })
  })
})

describe('a saved workspace is repaired when its profile is activated', () => {
  const profile = 'tab-agree'
  afterEach(() => window.localStorage.removeItem(`mousse-profile-${profile}-workspace`))
  const saved: Array<[string, Record<string, unknown>, ReturnType<typeof pair>]> = [
    ['Chats tab with the thread workspace (the reported state)', { threadsSidebarView: 'chats', sidebarMode: 'projects' }, { threadsSidebarView: 'chats', sidebarMode: 'chats', lastThreadListView: 'projects' }],
    ['Threads tab with the Chats workspace', { threadsSidebarView: 'threads', sidebarMode: 'chats' }, { threadsSidebarView: 'threads', sidebarMode: 'projects', lastThreadListView: 'threads' }],
    ['an agreeing pair from before the list tab was remembered', { threadsSidebarView: 'chats', sidebarMode: 'chats' }, { threadsSidebarView: 'chats', sidebarMode: 'chats', lastThreadListView: 'projects' }],
    ['an agreeing pair with the list tab remembered', { threadsSidebarView: 'chats', sidebarMode: 'chats', lastThreadListView: 'threads' }, { threadsSidebarView: 'chats', sidebarMode: 'chats', lastThreadListView: 'threads' }]
  ]
  it.each(saved)('%s', (_name, workspace, expected) => {
    window.localStorage.setItem(`mousse-profile-${profile}-workspace`, JSON.stringify(workspace))
    useAppStore.getState().activateProfile(profile)
    expect(pair()).toEqual(expected)
  })
})

describe('the Automations exception', () => {
  it('a run opened from Chats shows its thread, and closing the page gives Chats back with both agreeing', () => {
    onChats('threads')
    inboxPageOpened()
    openRun({ id: 'run-1', threadId: 't-old' })
    expect(useAppStore.getState()).toMatchObject({ activeThreadId: 't-old', sidebarMode: 'projects', threadsSidebarView: 'threads' })
    inboxPageClosed()
    expect(pair()).toMatchObject({ threadsSidebarView: 'chats', sidebarMode: 'chats' })
  })
})
