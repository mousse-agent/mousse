import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../src/renderer/stores/appStore'
import { qualifyId } from '../src/shared/threadRef'
import {
  browserCompatibleUserAgent,
  isAllowedBrowserPopupUrl
} from '../src/main/browser/browserPolicy'

function resetBrowserTabs(): void {
  useAppStore.setState({
    browserTabs: [],
    browserActiveTabByThread: {},
    projectTerminalTabs: [],
    activeProjectTerminalTabByThread: {}
  })
}

afterEach(() => {
  resetBrowserTabs()
})

describe('ensureBrowserTab', () => {
  it('creates a single default tab for a thread', () => {
    const id = useAppStore.getState().ensureBrowserTab('thread-a')
    const { browserTabs } = useAppStore.getState()
    expect(browserTabs).toHaveLength(1)
    expect(browserTabs[0]).toMatchObject({
      id,
      ownerThreadId: 'thread-a',
      url: 'about:blank',
      title: 'New tab'
    })
  })

  it('is idempotent under double-invoke (Strict Mode)', () => {
    const first = useAppStore.getState().ensureBrowserTab('thread-a')
    const second = useAppStore.getState().ensureBrowserTab('thread-a')
    expect(first).toBe(second)
    expect(useAppStore.getState().browserTabs).toHaveLength(1)
  })

  it('does not add a thread tab when a pinned tab already exists', () => {
    const pinned = useAppStore.getState().addBrowserTab(null)
    const ensured = useAppStore.getState().ensureBrowserTab('thread-a')
    expect(ensured).toBe(pinned)
    expect(useAppStore.getState().browserTabs).toHaveLength(1)
    expect(useAppStore.getState().browserTabs[0].ownerThreadId).toBeNull()
  })

  it('keeps separate unpinned tabs for different threads', () => {
    useAppStore.getState().addBrowserTab('thread-a')
    useAppStore.getState().ensureBrowserTab('thread-b')
    const tabs = useAppStore.getState().browserTabs
    expect(tabs).toHaveLength(2)
    expect(tabs.map((tab) => tab.ownerThreadId).sort()).toEqual(['thread-a', 'thread-b'])
  })
})

describe('thread workspace persistence', () => {
  it('removes pinned browser and terminal tabs from every thread', () => {
    const browserId = useAppStore.getState().addBrowserTab(null)
    const terminalId = useAppStore.getState().addProjectTerminalTab(null)
    useAppStore.getState().setActiveBrowserTab('thread-a', browserId)
    useAppStore.getState().setActiveBrowserTab('thread-b', browserId)
    useAppStore.getState().setActiveProjectTerminalTab('thread-a', terminalId)
    useAppStore.getState().setActiveProjectTerminalTab('thread-b', terminalId)

    useAppStore.getState().closeBrowserTab(browserId)
    useAppStore.getState().closeProjectTerminalTab(terminalId)

    const state = useAppStore.getState()
    expect(state.browserTabs).toEqual([])
    expect(state.projectTerminalTabs).toEqual([])
    expect(state.browserActiveTabByThread).toMatchObject({ 'thread-a': '', 'thread-b': '' })
    expect(state.activeProjectTerminalTabByThread).toMatchObject({ 'thread-a': '', 'thread-b': '' })
  })

  it('ignores late backend updates after a terminal tab has closed', () => {
    const terminalId = useAppStore.getState().addProjectTerminalTab(null)
    useAppStore.getState().closeProjectTerminalTab(terminalId)
    useAppStore.getState().updateProjectTerminalTab(terminalId, { ptyId: null, exited: true })
    expect(useAppStore.getState().projectTerminalTabs).toEqual([])
  })

  it('retains terminal bindings and cwd independently across thread switches', () => {
    const first = useAppStore.getState().addProjectTerminalTab('thread-a')
    const second = useAppStore.getState().addProjectTerminalTab('thread-b')
    useAppStore.getState().updateProjectTerminalTab(first, {
      ptyId: 'pty-a',
      cwd: '/projects/a'
    })
    useAppStore.getState().updateProjectTerminalTab(second, {
      ptyId: 'pty-b',
      cwd: '/projects/b'
    })

    useAppStore.getState().setActiveThreadId('thread-b')

    expect(useAppStore.getState().projectTerminalTabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first, ownerThreadId: 'thread-a', ptyId: 'pty-a', cwd: '/projects/a' }),
      expect.objectContaining({ id: second, ownerThreadId: 'thread-b', ptyId: 'pty-b', cwd: '/projects/b' })
    ]))
  })
})

describe("a thread's browser tabs when the thread leaves", () => {
  const thread = (id: string, archivedAt?: string) => ({ id, name: id, order: 0, ...(archivedAt ? { archivedAt } : {}) })
  const setThreads = (threads: ReturnType<typeof thread>[]) => useAppStore.setState({ threads: threads as never })
  const tabOwners = () => useAppStore.getState().browserTabs.map((tab) => tab.ownerThreadId)
  // A thread from another computer has a qualified id; it leaves the list while that computer is away.
  const remote = qualifyId('nod_0123456789abcdefghjkmnpqrs', 'thread_r')

  afterEach(() => setThreads([]))

  it.each([
    { case: 'archived', next: [thread('thread_a', '2026-11-15T00:00:00Z'), thread('thread_b'), thread(remote)], left: [null, 'thread_b', remote] },
    { case: 'deleted', next: [thread('thread_b'), thread(remote)], left: [null, 'thread_b', remote] },
    { case: 'archived already and listed again', start: 'archived', next: [thread('thread_a', '2026-11-16T00:00:00Z'), thread('thread_b'), thread(remote)], left: [null, 'thread_a', 'thread_b', remote] },
    { case: 'of another computer and out of reach', next: [thread('thread_a'), thread('thread_b')], left: [null, 'thread_a', 'thread_b', remote] },
    { case: 'gone with the whole list (a list not loaded yet)', next: [], left: [null, 'thread_a', 'thread_b', remote] }
  ])('closes only the right tabs when a thread is $case', ({ start, next, left }) => {
    setThreads([thread('thread_a', start ? '2026-11-15T00:00:00Z' : undefined), thread('thread_b'), thread(remote)])
    const shared = useAppStore.getState().addBrowserTab(null)
    for (const owner of ['thread_a', 'thread_b', remote]) useAppStore.getState().addBrowserTab(owner)
    setThreads(next)
    expect(tabOwners()).toEqual(left)
    expect(useAppStore.getState().browserTabs[0].id).toBe(shared)
  })
})

describe('embedded browser authentication policy', () => {
  it('uses a Chromium-compatible user agent without Electron branding', () => {
    const userAgent = browserCompatibleUserAgent(
      'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36 Electron/43.2.0 Mousse/0.1.0'
    )
    expect(userAgent).toBe('Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36')
  })

  it('allows web auth popups but rejects privileged protocols', () => {
    expect(isAllowedBrowserPopupUrl('about:blank')).toBe(true)
    expect(isAllowedBrowserPopupUrl('https://accounts.google.com/signin')).toBe(true)
    expect(isAllowedBrowserPopupUrl('http://localhost:3000/login')).toBe(true)
    expect(isAllowedBrowserPopupUrl('file:///tmp/secret')).toBe(false)
    expect(isAllowedBrowserPopupUrl('javascript:alert(1)')).toBe(false)
  })
})
