import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorAskView } from '../../src/shared/bridge/editorAsk'
import type { NodeId } from '../../src/shared/net/ids'
import { nextEditorAsk } from '../../src/renderer/lib/editorAsks'
import {
  EDITOR_ASK_RECONCILE_MS,
  currentEditorAsk,
  pendingEditorAsk,
  useEditorAskStore,
  watchEditorAsks
} from '../../src/renderer/stores/editorAskStore'
import { EditorAskPrompt } from '../../src/renderer/components/EditorAskPrompt'

const now = 1_000_000
const ask = (node: string, extra: Partial<EditorAskView> = {}): EditorAskView => ({
  node: node as NodeId,
  name: `Computer ${node.toUpperCase()}`,
  at: now,
  expiresAt: now + 60_000,
  ...extra
})

const globals = globalThis as { window?: unknown; document?: unknown }
const original = { window: globals.window, document: globals.document }

/** A window with the preload calls the store uses. `answers` maps request methods to replies. */
function stubWindow(answers: Record<string, (params: unknown) => Promise<unknown>> = {}, withAskEvents = true) {
  const win = new EventTarget() as EventTarget & Record<string, unknown>
  const askListeners = new Set<() => void>()
  const request = vi.fn((method: string, params: unknown) => {
    const answer = answers[method]
    return answer ? answer(params) : Promise.reject(new Error(`unexpected ${method}`))
  })
  win.mousse = {
    platformRequest: { request },
    net: withAskEvents
      ? {
          onEditorAsks: (cb: () => void) => {
            askListeners.add(cb)
            return () => askListeners.delete(cb)
          }
        }
      : {}
  }
  globals.window = win
  const doc = new EventTarget() as EventTarget & { visibilityState: string }
  doc.visibilityState = 'visible'
  globals.document = doc
  return { win, doc, request, askListeners }
}

beforeEach(() => {
  useEditorAskStore.getState().reset()
  useEditorAskStore.setState({ dismissed: new Map() })
})

afterEach(() => {
  vi.useRealTimers()
  globals.window = original.window
  globals.document = original.document
})

describe('choosing the next ask', () => {
  it('shows the oldest waiting ask first', () => {
    const asks = [ask('b', { at: now + 2 }), ask('a', { at: now + 1 }), ask('c', { at: now + 3 })]
    expect(nextEditorAsk(asks, new Map(), now)?.node).toBe('a')
  })

  it('skips asks that ran out or were closed', () => {
    const asks = [ask('old', { at: now - 5, expiresAt: now }), ask('closed', { at: now - 4 }), ask('open')]
    expect(nextEditorAsk(asks, new Map([['closed', now + 60_000]]), now)?.node).toBe('open')
    expect(nextEditorAsk(asks, new Map([['closed', now + 60_000], ['open', now + 60_000]]), now)).toBeUndefined()
  })

  it('shows a later ask from a computer whose earlier ask was closed', () => {
    expect(nextEditorAsk([ask('a', { expiresAt: now + 90_000 })], new Map([['a', now + 60_000]]), now)?.node).toBe('a')
  })
})

describe('ask store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
  })

  it('loads the asks waiting on this computer', async () => {
    const { request } = stubWindow({ 'bridge.editorAsks': async () => ({ asks: [ask('a')] }) })
    await useEditorAskStore.getState().load()
    expect(request).toHaveBeenCalledWith('bridge.editorAsks', {})
    expect(useEditorAskStore.getState().asks).toEqual([ask('a')])
    expect(currentEditorAsk(useEditorAskStore.getState(), now)?.node).toBe('a')
  })

  it('says nothing when the asks cannot be read', async () => {
    stubWindow({ 'bridge.editorAsks': async () => Promise.reject(new Error('Mousse Net is off.')) })
    await useEditorAskStore.getState().load()
    expect(useEditorAskStore.getState()).toMatchObject({ asks: [], error: '' })
  })

  it.each([
    ['Allow', true],
    ['Not now', false]
  ])('%s answers the ask and moves on', async (_label, allow) => {
    const { request } = stubWindow({
      'bridge.editorAsks': async () => ({ asks: [ask('a', { at: now - 1 }), ask('b')] }),
      'bridge.editorAsk.answer': async () => ({ ok: true, allowed: allow })
    })
    const store = useEditorAskStore.getState()
    await store.load()
    expect(await store.answer('a' as NodeId, allow)).toEqual({ ok: true, allowed: allow })
    expect(request).toHaveBeenLastCalledWith('bridge.editorAsk.answer', { node: 'a', allow })
    const state = useEditorAskStore.getState()
    expect(state.asks.map((row) => row.node)).toEqual(['b'])
    expect(currentEditorAsk(state, now)?.node).toBe('b')
    expect(state.busy).toBe(false)
  })

  it('drops an ask that ran out before the answer', async () => {
    stubWindow({
      'bridge.editorAsks': async () => ({ asks: [ask('a')] }),
      'bridge.editorAsk.answer': async () => ({ ok: false, reason: 'expired' })
    })
    const store = useEditorAskStore.getState()
    await store.load()
    expect(await store.answer('a' as NodeId, true)).toEqual({ ok: false, reason: 'expired' })
    expect(useEditorAskStore.getState()).toMatchObject({ asks: [], error: '' })
  })

  it('keeps the ask and its error when the answer fails', async () => {
    stubWindow({
      'bridge.editorAsks': async () => ({ asks: [ask('a')] }),
      'bridge.editorAsk.answer': async () => Promise.reject(new Error('The background service is not running.'))
    })
    const store = useEditorAskStore.getState()
    await store.load()
    expect(await store.answer('a' as NodeId, true)).toBeUndefined()
    const state = useEditorAskStore.getState()
    expect(currentEditorAsk(state, now)?.node).toBe('a')
    expect(state).toMatchObject({ error: 'The background service is not running.', errorNode: 'a', busy: false })
  })

  it('keeps a closed ask out of the prompt until it runs out, while Devices still has it', async () => {
    stubWindow({ 'bridge.editorAsks': async () => ({ asks: [ask('a')] }) })
    const store = useEditorAskStore.getState()
    await store.load()
    useEditorAskStore.setState({ error: 'failed', errorNode: 'a' })
    store.dismiss('a' as NodeId)
    await store.load()
    let state = useEditorAskStore.getState()
    expect(currentEditorAsk(state, now)).toBeUndefined()
    expect(pendingEditorAsk(state, 'a', now)?.node).toBe('a')
    expect(state.error).toBe('')
    // Once its time has passed, the mark goes with it.
    vi.setSystemTime(now + 60_000)
    await store.load()
    state = useEditorAskStore.getState()
    expect(state.dismissed.size).toBe(0)
  })

  it('drops asks whose time ran out', async () => {
    stubWindow({ 'bridge.editorAsks': async () => ({ asks: [ask('a', { expiresAt: now + 10 }), ask('b')] }) })
    const store = useEditorAskStore.getState()
    await store.load()
    store.dismiss('a' as NodeId)
    store.prune(now + 10)
    const state = useEditorAskStore.getState()
    expect(state.asks.map((row) => row.node)).toEqual(['b'])
    expect(state.dismissed.size).toBe(0)
  })

  it('ignores a list that arrives after a profile switch', async () => {
    let release!: () => void
    stubWindow({
      'bridge.editorAsks': () =>
        new Promise((resolve) => {
          release = () => resolve({ asks: [ask('late')] })
        })
    })
    const pending = useEditorAskStore.getState().load()
    useEditorAskStore.getState().reset()
    release()
    await pending
    expect(useEditorAskStore.getState().asks).toEqual([])
  })
})

describe('watching for asks', () => {
  it('reads on start, on ask events, on focus and on a slow timer while visible, and stops cleanly', async () => {
    vi.useFakeTimers()
    const { win, doc, request, askListeners } = stubWindow({ 'bridge.editorAsks': async () => ({ asks: [ask('a')] }) })
    const stop = watchEditorAsks()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    for (const listener of askListeners) listener()
    await vi.advanceTimersByTimeAsync(0)
    win.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(EDITOR_ASK_RECONCILE_MS)
    expect(request).toHaveBeenCalledTimes(4)
    doc.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(EDITOR_ASK_RECONCILE_MS * 2)
    expect(request).toHaveBeenCalledTimes(4)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(5)

    stop()
    expect(askListeners.size).toBe(0)
    expect(useEditorAskStore.getState().asks).toEqual([])
    win.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(EDITOR_ASK_RECONCILE_MS * 2)
    expect(request).toHaveBeenCalledTimes(5)
  })

  it('works in a shell without ask events', async () => {
    vi.useFakeTimers()
    const { request } = stubWindow({ 'bridge.editorAsks': async () => ({ asks: [] }) }, false)
    const stop = watchEditorAsks()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe('ask dialog', () => {
  const render = (props: Partial<Parameters<typeof EditorAskPrompt>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(EditorAskPrompt, {
        ask: ask('b', { name: 'Computer B' }),
        busy: false,
        error: '',
        onDecide: () => undefined,
        onClose: () => undefined,
        ...props
      })
    )

  it('asks in plain words, says it gives shell access, and offers Not now then Allow', () => {
    const html = render()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('modal-overlay editor-ask-prompt')
    expect(html).toContain('Let Computer B’s editor connect to this computer?')
    // A title and one short line, nothing more.
    expect(html).toContain('<p class="editor-ask-warning">Gives shell access.</p>')
    expect(html.match(/<p /g)).toHaveLength(1)
    const actions = [...html.matchAll(/data-action="([a-z-]+)"/g)].map((match) => match[1])
    expect(actions).toEqual(['decline-editor-ask', 'allow-editor-ask'])
    expect(html).toContain('Not now</button>')
    expect(html).toContain('Allow</button>')
    expect(html).not.toContain('role="alert"')
  })

  it('shows errors inline and blocks a second answer while one is running', () => {
    const html = render({ busy: true, error: 'The background service is not running.' })
    expect(html).toContain('<p role="alert" class="chat-error">The background service is not running.</p>')
    expect(html.match(/data-action="(allow|decline)-editor-ask" disabled=""/g)).toHaveLength(2)
  })

  it('arms Allow only after a moment, so a click meant for something else cannot grant it', () => {
    // Rendered on the server, the first paint is the unarmed one: Allow is disabled, Not now is not.
    const html = render()
    expect(html).toMatch(/data-action="allow-editor-ask" disabled=""/)
    expect(html).not.toMatch(/data-action="decline-editor-ask" disabled=""/)
  })
})

describe('ask dialog styles', () => {
  it('shares the request prompt layer and tokens, since it renders outside Settings', () => {
    const css = readFileSync('src/renderer/styles/devices.css', 'utf8')
    const start = css.indexOf('.modal-overlay.editor-ask-prompt')
    expect(start).toBeGreaterThan(-1)
    const block = css.slice(start, css.indexOf('}', start))
    expect(block).toMatch(/z-index:\s*calc\(var\(--z-floating,\s*50000\)\s*\+\s*1\)/)
    for (const token of ['--space-4', '--space-12', '--settings-control-h', '--settings-fs-row', '--settings-fs-small']) expect(block).toContain(`${token}:`)
  })
})
