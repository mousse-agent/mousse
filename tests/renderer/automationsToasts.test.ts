// @vitest-environment jsdom
/**
 * The Automation manager's thread toasts: while the Automations page shows the person's request, the thread's own
 * "Stopped" or "Finished" toast stays quiet (the Drafts card says how it went), and a new request clears the last one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ showToast: vi.fn(() => 1), dismissToastByKey: vi.fn() }))
vi.mock('../../src/renderer/components/ui/Toast', () => toast)

const { showThreadToast, threadToastKey } = await import('../../src/renderer/lib/threadToasts')
const { useInboxStore, startRequest } = await import('../../src/renderer/components/automations/inbox/inboxStore')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

const request = { at: Date.now(), threadId: 'manager', runId: 'run:thread:manager:ordinal:1', text: 'Nightly review', status: 'failed' as const, error: 'No model is set up.', known: [] }

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = { orchestrator: { onTurnState: () => () => undefined, isTurnActive: async () => true }, platformRequest: { request: async () => ({}) } }
  useAppStore.setState({ activeThreadId: null, scheduledOpen: true })
  useInboxStore.setState({ composing: request })
})

afterEach(() => {
  useInboxStore.setState({ composing: null })
  localStorage.clear()
  vi.clearAllMocks()
})

describe('the manager thread\'s toasts', () => {
  it('stay quiet while the page shows the request, and show for any other thread or once the page is closed', () => {
    showThreadToast({ threadId: 'manager', kind: 'idle', threadName: 'Automation manager' })
    expect(toast.showToast).not.toHaveBeenCalled()
    showThreadToast({ threadId: 'another', kind: 'idle', threadName: 'Fix tests' })
    expect(toast.showToast).toHaveBeenCalledTimes(1)
    useAppStore.setState({ scheduledOpen: false })
    showThreadToast({ threadId: 'manager', kind: 'idle', threadName: 'Automation manager' })
    expect(toast.showToast).toHaveBeenCalledTimes(2)
  })

  it('go when a new request starts', () => {
    startRequest({ at: Date.now() + 1, text: 'Weekly cleanup', status: 'working', known: [] })
    expect(toast.dismissToastByKey).toHaveBeenCalledWith(threadToastKey('manager'))
  })
})
