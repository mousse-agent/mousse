import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetStatus, PlusEnrollmentRequestView } from '../../src/shared/net'
import type { PlusStatus } from '../../src/shared/net/local'
import type { ProtocolEvent } from '../../src/mms/protocol/types'
import { bridgeProtocolEvent } from '../../src/main/mms/protocolEventBridge'
import { PresentationState } from '../../src/main/mms/PresentationState'
import { canApproveEnrollment, formatMatchCode, nextEnrollmentRequest, notifyEnrollmentRequest, phonesBlocked } from '../../src/renderer/lib/plusEnrollment'
import {
  ENROLLMENT_RECONCILE_MS,
  currentEnrollmentRequest,
  useEnrollmentPromptStore,
  watchEnrollmentRequests
} from '../../src/renderer/stores/enrollmentPromptStore'
import { EnrollmentRequestPrompt } from '../../src/renderer/components/EnrollmentRequestPrompt'

const now = 1_000_000
const row = (id: string, extra: Partial<PlusEnrollmentRequestView> = {}): PlusEnrollmentRequestView => ({
  id,
  deviceName: `Phone ${id}`,
  kind: 'phone',
  boxPublicKey: 'box',
  transportFingerprint: 'fp',
  createdAt: now,
  expiresAt: now + 60_000,
  matchCode: '123456',
  ...extra
})

const globals = globalThis as { window?: unknown; document?: unknown; Notification?: unknown }
const original = { window: globals.window, document: globals.document, Notification: globals.Notification }

/** A window with the preload calls the prompt uses. `answers` maps request methods to replies. */
function stubWindow(answers: Record<string, (params: unknown) => Promise<unknown>> = {}) {
  const win = new EventTarget() as EventTarget & Record<string, unknown>
  const netListeners = new Set<() => void>()
  const request = vi.fn((method: string, params: unknown) => {
    const answer = answers[method]
    return answer ? answer(params) : Promise.reject(new Error(`unexpected ${method}`))
  })
  const focusMain = vi.fn(async () => undefined)
  win.mousse = {
    platformRequest: { request },
    window: { focusMain },
    net: {
      onUpdated: (cb: () => void) => {
        netListeners.add(cb)
        return () => netListeners.delete(cb)
      }
    }
  }
  globals.window = win
  const doc = new EventTarget() as EventTarget & { visibilityState: string }
  doc.visibilityState = 'visible'
  globals.document = doc
  return { win, doc, request, focusMain, netListeners }
}

const methods = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map(([method]) => method)
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  useEnrollmentPromptStore.getState().reset()
  useEnrollmentPromptStore.setState({ dismissed: new Set(), notified: new Set() })
})

afterEach(() => {
  vi.useRealTimers()
  globals.window = original.window
  globals.document = original.document
  globals.Notification = original.Notification
})

describe('who can approve requests', () => {
  const plus = { connected: true } as PlusStatus
  const net = { enabled: true, self: { isAuthority: true }, keystore: 'unlocked', protected: true } as unknown as NetStatus

  it('needs sign-in, networking, an unlocked protected keystore and authority', () => {
    expect(canApproveEnrollment(net, plus)).toBe(true)
    expect(canApproveEnrollment(net, { connected: false } as PlusStatus)).toBe(false)
    expect(canApproveEnrollment({ ...net, enabled: false } as NetStatus, plus)).toBe(false)
    expect(canApproveEnrollment({ ...net, keystore: 'locked' } as unknown as NetStatus, plus)).toBe(false)
    expect(canApproveEnrollment({ ...net, protected: false } as NetStatus, plus)).toBe(false)
    expect(canApproveEnrollment({ ...net, self: { isAuthority: false } } as unknown as NetStatus, plus)).toBe(false)
    expect(canApproveEnrollment(undefined, plus)).toBe(false)
  })

  it('says why in one line', () => {
    expect(phonesBlocked(net, plus)).toBeUndefined()
    expect(phonesBlocked({ ...net, keystore: 'locked' } as unknown as NetStatus, plus)).toBe('Unlock this device under Devices to add phones.')
  })
})

describe('choosing the next request', () => {
  it('splits the match code like the phone does', () => {
    expect(formatMatchCode('123456')).toBe('123 456')
  })

  it('asks about the oldest open request first', () => {
    const rows = [row('b', { createdAt: now + 2 }), row('a', { createdAt: now + 1 }), row('c', { createdAt: now + 3 })]
    expect(nextEnrollmentRequest(rows, new Set(), now)?.id).toBe('a')
  })

  it('skips requests that ran out or were closed this session', () => {
    const rows = [row('old', { createdAt: now - 5, expiresAt: now }), row('closed', { createdAt: now - 4 }), row('open')]
    expect(nextEnrollmentRequest(rows, new Set(['closed']), now)?.id).toBe('open')
    expect(nextEnrollmentRequest(rows, new Set(['closed', 'open']), now)).toBeUndefined()
  })
})

describe('request store', () => {
  it('loads the daemon list', async () => {
    stubWindow({ 'net.plus.enrollment.requests': async () => ({ requests: [row('a')] }) })
    await useEnrollmentPromptStore.getState().load()
    expect(currentEnrollmentRequest(useEnrollmentPromptStore.getState(), now)?.id).toBe('a')
  })

  it('folds a burst of refreshes into one more read', async () => {
    let release!: () => void
    const { request } = stubWindow({
      'net.plus.enrollment.requests': () =>
        new Promise((resolve) => {
          release = () => resolve({ requests: [] })
        })
    })
    const { load } = useEnrollmentPromptStore.getState()
    const first = load()
    void load()
    void load()
    release()
    await flush()
    release()
    await first
    expect(methods(request)).toEqual(['net.plus.enrollment.requests', 'net.plus.enrollment.requests'])
  })

  it('ignores a list that arrives after sign-out', async () => {
    let release!: () => void
    stubWindow({
      'net.plus.enrollment.requests': () =>
        new Promise((resolve) => {
          release = () => resolve({ requests: [row('late')] })
        })
    })
    const pending = useEnrollmentPromptStore.getState().load()
    useEnrollmentPromptStore.getState().reset()
    release()
    await pending
    expect(useEnrollmentPromptStore.getState().requests).toEqual([])
  })

  it('moves on to the next request after a choice', async () => {
    const { request } = stubWindow({
      'net.plus.enrollment.requests': async () => ({ requests: [row('a', { createdAt: now - 1 }), row('b')] }),
      'net.plus.enrollment.approve': async () => ({ approved: true })
    })
    const store = useEnrollmentPromptStore.getState()
    await store.load()
    await store.decide('a', true)
    expect(request).toHaveBeenLastCalledWith('net.plus.enrollment.approve', { id: 'a' })
    expect(currentEnrollmentRequest(useEnrollmentPromptStore.getState(), now)?.id).toBe('b')
    expect(useEnrollmentPromptStore.getState().busy).toBe(false)
  })

  it('keeps the request and its error when a choice fails', async () => {
    stubWindow({
      'net.plus.enrollment.requests': async () => ({ requests: [row('a')] }),
      'net.plus.enrollment.deny': async () => Promise.reject(new Error('Mousse ID is unreachable.'))
    })
    const store = useEnrollmentPromptStore.getState()
    await store.load()
    await store.decide('a', false)
    const state = useEnrollmentPromptStore.getState()
    expect(currentEnrollmentRequest(state, now)?.id).toBe('a')
    expect(state).toMatchObject({ error: 'Mousse ID is unreachable.', errorId: 'a', busy: false })
  })

  it('hides a closed request and its error for the rest of the session', async () => {
    stubWindow({ 'net.plus.enrollment.requests': async () => ({ requests: [row('a')] }) })
    const store = useEnrollmentPromptStore.getState()
    await store.load()
    useEnrollmentPromptStore.setState({ error: 'failed', errorId: 'a' })
    store.dismiss('a')
    await store.load()
    useEnrollmentPromptStore.getState().reset()
    await useEnrollmentPromptStore.getState().load()
    const state = useEnrollmentPromptStore.getState()
    expect(state.requests).toHaveLength(1)
    expect(currentEnrollmentRequest(state, now)).toBeUndefined()
    expect(state.error).toBe('')
  })

  it('forgets closed and notified marks once their request is gone, but not while it is listed', async () => {
    let list = [row('a'), row('b')]
    stubWindow({ 'net.plus.enrollment.requests': async () => ({ requests: list }) })
    const store = useEnrollmentPromptStore.getState()
    await store.load()
    store.dismiss('a')
    store.markNotified('a')
    store.markNotified('b')
    await store.load()
    expect([...useEnrollmentPromptStore.getState().dismissed]).toEqual(['a'])
    list = [row('b')]
    await store.load()
    const state = useEnrollmentPromptStore.getState()
    expect([...state.dismissed]).toEqual([])
    expect([...state.notified]).toEqual(['b'])
  })

  it('forgets marks of requests that ran out or were decided', async () => {
    stubWindow({
      'net.plus.enrollment.requests': async () => ({ requests: [row('a', { expiresAt: now + 10 }), row('b')] }),
      'net.plus.enrollment.approve': async () => ({})
    })
    const store = useEnrollmentPromptStore.getState()
    await store.load()
    for (const id of ['a', 'b']) {
      store.dismiss(id)
      store.markNotified(id)
    }
    store.prune(now + 10)
    expect([...useEnrollmentPromptStore.getState().dismissed]).toEqual(['b'])
    expect([...useEnrollmentPromptStore.getState().notified]).toEqual(['b'])
    await store.decide('b', true)
    expect(useEnrollmentPromptStore.getState().dismissed.size).toBe(0)
    expect(useEnrollmentPromptStore.getState().notified.size).toBe(0)
  })

  it('drops requests whose time ran out', async () => {
    stubWindow({ 'net.plus.enrollment.requests': async () => ({ requests: [row('a', { expiresAt: now + 10 })] }) })
    await useEnrollmentPromptStore.getState().load()
    useEnrollmentPromptStore.getState().prune(now + 10)
    expect(useEnrollmentPromptStore.getState().requests).toEqual([])
  })
})

describe('watching for requests', () => {
  it('reads on start, on daemon events and on focus, and stops cleanly', async () => {
    vi.useFakeTimers()
    const { win, request, netListeners } = stubWindow({
      'net.plus.enrollment.requests': async () => ({ requests: [row('a')] })
    })
    const stop = watchEnrollmentRequests()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    for (const listener of netListeners) listener()
    await vi.advanceTimersByTimeAsync(0)
    win.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(3)

    stop()
    expect(netListeners.size).toBe(0)
    expect(useEnrollmentPromptStore.getState().requests).toEqual([])
    win.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(ENROLLMENT_RECONCILE_MS * 2)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('reconciles on a slow timer only while the window is visible', async () => {
    vi.useFakeTimers()
    const { doc, request } = stubWindow({ 'net.plus.enrollment.requests': async () => ({ requests: [] }) })
    const stop = watchEnrollmentRequests()
    await vi.advanceTimersByTimeAsync(ENROLLMENT_RECONCILE_MS)
    expect(request).toHaveBeenCalledTimes(2)
    doc.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(ENROLLMENT_RECONCILE_MS * 3)
    expect(request).toHaveBeenCalledTimes(2)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(3)
    stop()
  })

  it('receives daemon network events through the main process', () => {
    const seen: Array<{ channel: string; data: unknown }> = []
    const event: ProtocolEvent = { kind: 'event', sequence: 1, type: 'net.updated', data: { enabled: true }, ts: new Date().toISOString() }
    expect(bridgeProtocolEvent(event, (channel, data) => seen.push({ channel, data }), new PresentationState())).toBe(true)
    expect(seen).toEqual([{ channel: 'net:updated', data: { enabled: true } }])
  })
})

describe('request dialog', () => {
  const render = (props: Partial<Parameters<typeof EnrollmentRequestPrompt>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(EnrollmentRequestPrompt, {
        request: row('a', { deviceName: 'Pixel 9' }),
        busy: false,
        error: '',
        onDecide: () => undefined,
        onClose: () => undefined,
        ...props
      })
    )

  it('shows the device, match code and both choices', () => {
    const html = render()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('modal-overlay enrollment-prompt')
    expect(html).toContain('Phone wants to join')
    expect(html).toContain('<p class="enrollment-device">Pixel 9</p>')
    expect(html).toContain('Match code <strong>123 456</strong> · approve only if the phone shows it')
    expect(html).toContain('Approve</button>')
    expect(html).toContain('Deny</button>')
    expect(html).not.toContain('role="alert"')
  })

  it('shows errors inline and blocks a second choice while one is running', () => {
    const html = render({ busy: true, error: 'This phone request has expired or was withdrawn.' })
    expect(html).toContain('<p role="alert" class="chat-error">This phone request has expired or was withdrawn.</p>')
    expect(html.match(/<button type="button" class="settings-btn" data-action="(approve|deny)-enrollment" disabled=""/g)).toHaveLength(2)
  })

  it('names a computer request as a computer', () => {
    expect(render({ request: row('a', { kind: 'computer' }) })).toContain('Computer wants to join')
  })
})

describe('background notification', () => {
  it('names the device and match code and brings the window forward on click', () => {
    const { focusMain } = stubWindow()
    const shown: Array<{ title: string; body?: string; onclick?: () => void }> = []
    globals.Notification = class {
      onclick?: () => void
      constructor(
        readonly title: string,
        readonly options: { body?: string }
      ) {
        shown.push(this as never)
      }
    }
    notifyEnrollmentRequest(row('a', { deviceName: 'Pixel 9' }))
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ title: 'Phone wants to join', options: { body: 'Pixel 9 · match code 123 456' } })
    shown[0].onclick?.()
    expect(focusMain).toHaveBeenCalled()
  })

  it('does nothing where notifications are unavailable', () => {
    stubWindow()
    globals.Notification = undefined
    expect(() => notifyEnrollmentRequest(row('a'))).not.toThrow()
  })
})
