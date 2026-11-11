// @vitest-environment jsdom
/**
 * The Steer block while its steer is held for a running tool (docs/design/steer-and-interruptions.md §2.10): the wait
 * line and its tooltip, Send now, "Sending…" until the steer goes in, a stale click, and a hold that clears or changes.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SteerGroup } from '../../src/renderer/chat/components/agent-elements/steer-group'
import { HeldSteerContext, newestSteerMessageId, type HeldSteerState } from '../../src/renderer/chat/components/agent-elements/steer-hold'
import type { HeldSteer } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let steerNow: ReturnType<typeof vi.fn>
let outcome: ((payload: { threadId?: string; requestId: string; outcome: 'applied' | 'stale' }) => void) | undefined
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  steerNow = vi.fn(async () => ({ ok: true }))
  outcome = undefined
  vi.stubGlobal('mousse', {
    orchestrator: {
      steerNow,
      onSteerNow: (cb: typeof outcome) => {
        outcome = cb
        return () => { if (outcome === cb) outcome = undefined }
      }
    }
  })
  ;(window as unknown as { mousse: unknown }).mousse = (globalThis as unknown as { mousse: unknown }).mousse
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const steered = (id: string, text: string, steerItemId?: string): UIMessage => ({
  id, role: 'user', parts: [{ type: 'text', text }], metadata: { steered: true, ...(steerItemId ? { steerItemId } : {}) }
} as UIMessage)
const UserMessage = ({ message }: { message: UIMessage }) => createElement('div', { className: 'bubble' }, (message.parts[0] as { text: string }).text)
const hold = (patch: Partial<HeldSteer> = {}): HeldSteer => ({
  waitsFor: 'Bash', detail: 'npm test', tools: 1, since: '2026-11-12T10:00:00.000Z', holdGeneration: 3, itemIds: ['item-1'], runId: 'run-1', ...patch
})

function show(state: HeldSteerState | null, messages: UIMessage[] = [steered('m1', 'use pnpm, not npm', 'item-1')]) {
  act(() => root.render(createElement(HeldSteerContext.Provider, { value: state },
    createElement(SteerGroup, { messages, UserMessageComponent: UserMessage as never }))))
}
/** The label row as it reads on screen: hidden text (a button's description) left out. */
const label = () => {
  const copy = host.querySelector('.steer-group-label')!.cloneNode(true) as HTMLElement
  for (const hidden of copy.querySelectorAll('[hidden]')) hidden.remove()
  return copy
}
const wait = () => host.querySelector<HTMLElement>('.steer-hold-wait')
const button = () => host.querySelector<HTMLButtonElement>('.steer-hold-send')

describe('the Steer block of a held steer', () => {
  it('reads "Steer · Waits for Bash · Send now", with the command in the tooltip and the stop in the button\'s', () => {
    show({ threadId: 't1', held: hold() })
    expect(label().textContent).toBe('Steer·Waits for Bash·Send now')
    expect(wait()!.getAttribute('title')).toBe('Goes in when Bash finishes\nnpm test')
    expect(button()!.getAttribute('title')).toBe('Stop Bash and send now')
    // A quiet text button: no border, no fill.
    expect(button()!.className).toBe('steer-hold-send')
  })

  it('the button\'s accessible name starts with what it shows, and its description gives the command (a tooltip on text cannot take focus)', () => {
    show({ threadId: 't1', held: hold() })
    expect(button()!.getAttribute('aria-label')).toBe('Send now: stops Bash')
    expect(button()!.getAttribute('aria-label')!.startsWith(button()!.textContent!)).toBe(true)
    const described = button()!.getAttribute('aria-describedby')
    expect(described).toBeTruthy()
    expect(document.getElementById(described!)!.textContent).toBe('Goes in when Bash finishes\nnpm test')
  })

  it('with several tools: "Waits for 2 tools", and the tooltip lists them', () => {
    show({ threadId: 't1', held: hold({ tools: 2, toolList: [{ name: 'Bash', detail: 'npm test' }, { name: 'Bash', detail: 'npm run lint' }] }) })
    expect(wait()!.textContent).toBe('Waits for 2 tools')
    expect(wait()!.getAttribute('title')).toBe('Goes in when 2 tools finish\nBash: npm test\nBash: npm run lint')
    expect(button()!.getAttribute('title')).toBe('Stop 2 tools and send now')
  })

  it('shows nothing for a hold that names none of the block\'s messages, and nothing without a hold', () => {
    show({ threadId: 't1', held: hold({ itemIds: ['another'] }) })
    expect(wait()).toBeNull()
    show({ threadId: 't1' })
    expect(wait()).toBeNull()
    expect(label().textContent).toBe('Steer')
  })

  it('a hold with no queue item (a device\'s limited steer, a run-bound steer) shows on the newest Steer block only', () => {
    const older = [steered('m1', 'an older steer')]
    const newest = [steered('m2', 'the steer that waits')]
    show({ threadId: 't1', held: hold({ itemIds: [] }), newestSteerId: 'm2' }, older)
    expect(wait()).toBeNull()
    show({ threadId: 't1', held: hold({ itemIds: [] }), newestSteerId: 'm2' }, newest)
    expect(wait()!.textContent).toBe('Waits for Bash')
    expect(button()!.textContent).toBe('Send now')
  })

  it('newestSteerMessageId finds the last steered user message', () => {
    const plain = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as UIMessage
    const reply = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] } as UIMessage
    expect(newestSteerMessageId([plain, steered('s1', 'a'), reply, steered('s2', 'b'), reply])).toBe('s2')
    expect(newestSteerMessageId([plain, reply])).toBeUndefined()
  })

  it('keeps the tool\'s name while the hold waits out the window after its result', () => {
    // The service keeps the last tool's name in `waitsFor` with no tool running.
    show({ threadId: 't1', held: hold({ tools: 0 }) })
    expect(wait()!.textContent).toBe('Waits for Bash')
  })

  it('Send now names the run, the hold and its items, reads "Sending…", and the line clears once the steer goes in', async () => {
    show({ threadId: 't1', held: hold() })
    await act(async () => button()!.click())
    expect(steerNow).toHaveBeenCalledExactlyOnceWith({ threadId: 't1', runId: 'run-1', holdGeneration: 3, itemIds: ['item-1'], clientRequestId: expect.any(String) })
    expect(button()!.textContent).toBe('Sending…')
    // Unavailable while it sends, but still focusable: `aria-disabled`, not `disabled`, so keyboard focus stays on it.
    expect(button()!.disabled).toBe(false)
    expect(button()!.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement === button() || button()!.tabIndex >= 0).toBe(true)
    // A second click while sending sends nothing.
    await act(async () => button()!.click())
    expect(steerNow).toHaveBeenCalledTimes(1)
    act(() => outcome?.({ threadId: 't1', requestId: steerNow.mock.calls[0]![0].clientRequestId, outcome: 'applied' }))
    show({ threadId: 't1' })
    expect(wait()).toBeNull()
    expect(button()).toBeNull()
  })

  it('a stale click gives the button back for the hold shown then', async () => {
    show({ threadId: 't1', held: hold() })
    await act(async () => button()!.click())
    expect(button()!.textContent).toBe('Sending…')
    act(() => outcome?.({ requestId: 'someone-else', outcome: 'stale' }))
    expect(button()!.textContent).toBe('Sending…')
    act(() => outcome?.({ requestId: steerNow.mock.calls[0]![0].clientRequestId, outcome: 'stale' }))
    expect(button()!.textContent).toBe('Send now')
  })

  it('a refused click (the run is not active any more) gives the button back', async () => {
    steerNow.mockResolvedValueOnce({ ok: false, reason: 'run_not_active' })
    show({ threadId: 't1', held: hold() })
    await act(async () => button()!.click())
    expect(button()!.textContent).toBe('Send now')
  })

  it('"Sending…" ends when the hold changes generation, or clears, with no event', async () => {
    show({ threadId: 't1', held: hold() })
    await act(async () => button()!.click())
    expect(button()!.textContent).toBe('Sending…')
    // A steer joined: a new hold, with its own button.
    show({ threadId: 't1', held: hold({ holdGeneration: 4, itemIds: ['item-1', 'item-2'] }) })
    expect(button()!.textContent).toBe('Send now')
    await act(async () => button()!.click())
    expect(button()!.textContent).toBe('Sending…')
    // Stop, a restart or the turn's end clear the hold without either event.
    show({ threadId: 't1' })
    expect(button()).toBeNull()
    show({ threadId: 't1', held: hold({ holdGeneration: 5 }) })
    expect(button()!.textContent).toBe('Send now')
  })
})
