// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PausedRunBanner, PausedRunBannerView, type PausedRunBannerViewProps } from '../../src/renderer/chat/components/PausedRunBanner'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { PausedRunClient } from '../../src/renderer/services/pausedRunClient'
import type { TurnPause, TurnState } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = (hours: number, minutes = 0, day = 27) => new Date(2026, 9, day, hours, minutes).getTime()
const NOW = at(13, 25)
const pause = (patch: Partial<TurnPause> = {}): TurnPause => ({
  runId: 'run:1',
  until: new Date(at(15, 40)).toISOString(),
  estimated: false,
  autoResume: true,
  provider: 'claude',
  limitKind: 'five_hour',
  ...patch
})

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState({ turnStates: {} })
  vi.useRealTimers()
})

const text = () => host.textContent ?? ''
const banner = () => host.querySelector<HTMLElement>('.chat-run-paused')
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
const button = (label: string) => buttons().find((entry) => entry.textContent?.startsWith(label))!
const click = (target: Element) => act(() => { (target as HTMLElement).click() })

function view(patch: Partial<PausedRunBannerViewProps> = {}) {
  const props: PausedRunBannerViewProps = { pause: pause(), now: NOW, busy: null, error: null, onResume: vi.fn(), onCancel: vi.fn(), onStop: vi.fn(), ...patch }
  act(() => root.render(createElement(PausedRunBannerView, props)))
  return props
}

describe('the paused run banner', () => {
  it('a timer is armed: the reset time, the time left, the limit, and that it continues by itself', () => {
    view()
    expect(text()).toContain('Paused until')
    expect(text()).toContain('Resets in 2h 15m')
    expect(text()).toContain("Claude's 5-hour limit was reached. Continues by itself at reset.")
    expect(banner()!.dataset.pausedState).toBe('waiting')
    expect(buttons().map((entry) => entry.textContent)).toEqual(['Resume now', 'Cancel', 'Stop'])
  })

  it('says an estimated time is estimated', () => {
    view({ pause: pause({ estimated: true }) })
    expect(host.querySelector('.chat-run-paused-until')!.textContent).toMatch(/^Paused until .+ \(estimated\)$/)
  })

  it('with no timer it says it will not continue by itself', () => {
    view({ pause: pause({ autoResume: false }) })
    expect(text()).toContain("It won't continue by itself. Press Resume now once it resets.")
  })

  it('a stale pause says it will not auto-continue, and still offers Resume now', () => {
    view({ pause: pause({ autoResume: false, stale: true }), now: at(9, 0, 29) })
    expect(banner()!.dataset.pausedState).toBe('stale')
    expect(text()).toContain("won't continue by itself")
    expect(text()).not.toContain('Resets in')
    expect(buttons().map((entry) => entry.textContent)).toContain('Resume now')
  })

  it('past the reset time, an armed pause says it continues shortly', () => {
    view({ now: at(16, 10) })
    expect(banner()!.dataset.pausedState).toBe('due')
    expect(text()).toContain('continues shortly')
  })

  it('Resume now, Cancel and Stop each call their own handler once', () => {
    const props = view()
    click(button('Resume now'))
    expect([props.onResume, props.onCancel, props.onStop].map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 0, 0])
    click(button('Cancel'))
    click(button('Stop'))
    expect([props.onResume, props.onCancel, props.onStop].map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 1])
  })

  it('has no Stop where the shell has none', () => {
    view({ onStop: undefined })
    expect(buttons().map((entry) => entry.textContent)).toEqual(['Resume now', 'Cancel'])
  })

  it('while a press is in flight every button ignores presses and the pressed one says so', () => {
    const props = view({ busy: 'resume' })
    expect(button('Resuming…').getAttribute('aria-busy')).toBe('true')
    for (const entry of buttons()) {
      expect(entry.getAttribute('aria-disabled')).toBe('true')
      click(entry)
    }
    expect([props.onResume, props.onCancel, props.onStop].every((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true)
    view({ busy: 'cancel' })
    expect(button('Cancelling…')).toBeDefined()
  })

  it('shows a failed press inline, as an alert', () => {
    view({ error: 'This run is no longer paused.' })
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('This run is no longer paused.')
  })

  describe('keyboard use', () => {
    it('the buttons are plain buttons in reading order: Resume now, Cancel, Stop', () => {
      view()
      for (const entry of buttons()) {
        expect(entry.tagName).toBe('BUTTON')
        expect(entry.type).toBe('button')
        expect(entry.tabIndex).toBeGreaterThanOrEqual(0)
        expect(entry.disabled).toBe(false)
      }
      const order = Array.from(host.querySelectorAll('button')).map((entry) => entry.textContent)
      expect(order).toEqual(['Resume now', 'Cancel', 'Stop'])
    })

    it('the banner is announced as a status group with the buttons inside it', () => {
      view()
      expect(banner()!.getAttribute('role')).toBe('group')
      expect(banner()!.getAttribute('aria-label')).toBe('Run paused by a usage limit')
      expect(host.querySelector('[role="status"]')!.textContent).toContain('Paused until')
      expect(banner()!.contains(button('Resume now'))).toBe(true)
    })

    it('a button that goes busy keeps focus, so the next Tab continues from it', () => {
      view()
      button('Resume now').focus()
      expect(document.activeElement).toBe(button('Resume now'))
      view({ busy: 'resume' })
      expect(document.activeElement).toBe(button('Resuming…'))
    })
  })
})

describe('the banner on a thread', () => {
  const state = (patch: Partial<TurnState> = {}): TurnState => ({ threadId: 't1', turnId: 'run:1', phase: 'paused', updatedAt: new Date(NOW).toISOString(), pause: pause(), ...patch })
  const clientOf = (patch: Partial<PausedRunClient> = {}): PausedRunClient => ({ resumeNow: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), ...patch })
  const show = (threadId: string | null, client: PausedRunClient, onStop?: () => void) =>
    act(() => root.render(createElement(PausedRunBanner, { threadId, client, ...(onStop ? { onStop } : {}) })))
  const setTurn = (turn: TurnState | undefined) => act(() => { useAppStore.setState({ turnStates: turn ? { [turn.threadId]: turn } : {} }) })
  const flush = () => act(async () => { await Promise.resolve() })

  it('shows only for a paused thread', () => {
    const client = clientOf()
    setTurn(state({ phase: 'thinking', pause: undefined }))
    show('t1', client)
    expect(banner()).toBeNull()
    setTurn(state())
    expect(banner()).not.toBeNull()
    setTurn(state({ phase: 'idle', pause: undefined }))
    expect(banner()).toBeNull()
    show(null, client)
    expect(banner()).toBeNull()
  })

  it('Resume now asks the daemon to continue that run, then waits for the turn state to change', async () => {
    const resume = vi.fn(() => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 0)))
    const client = clientOf({ resumeNow: resume })
    setTurn(state())
    show('t1', client)
    click(button('Resume now'))
    expect(resume).toHaveBeenCalledWith('run:1')
    expect(button('Resuming…').getAttribute('aria-disabled')).toBe('true')
    // A second press while the first is in flight does nothing.
    click(button('Resuming…'))
    click(button('Cancel'))
    expect(resume).toHaveBeenCalledTimes(1)
    expect(client.cancel).not.toHaveBeenCalled()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    expect(button('Resume now').getAttribute('aria-disabled')).toBe('false')
  })

  it('Cancel asks the daemon to end the pause for that run', async () => {
    const client = clientOf()
    setTurn(state({ pause: pause({ runId: 'run:9' }) }))
    show('t1', client)
    click(button('Cancel'))
    await flush()
    expect(client.cancel).toHaveBeenCalledWith('run:9')
    expect(client.resumeNow).not.toHaveBeenCalled()
  })

  it('Stop goes through the thread stop it is given', () => {
    const onStop = vi.fn()
    setTurn(state())
    show('t1', clientOf(), onStop)
    click(button('Stop'))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('a refused press (the run is no longer paused) shows inline and leaves the buttons usable', async () => {
    const refused = Object.assign(new Error('Run run:1 is not paused.'), { code: 'conflict' })
    const client = clientOf({ resumeNow: vi.fn(async () => { throw refused }) })
    setTurn(state())
    show('t1', client)
    click(button('Resume now'))
    await flush()
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('This run is no longer paused.')
    expect(button('Resume now').getAttribute('aria-disabled')).toBe('false')
    // Cancel still works after the failure.
    click(button('Cancel'))
    await flush()
    expect(client.cancel).toHaveBeenCalledWith('run:1')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('another failure says what was tried', async () => {
    const client = clientOf({ cancel: vi.fn(async () => { throw new Error('Daemon unavailable') }) })
    setTurn(state())
    show('t1', client)
    click(button('Cancel'))
    await flush()
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Could not cancel the paused run: Daemon unavailable')
  })

  it('a new pause (another run) starts without the last one\'s error', async () => {
    const client = clientOf({ resumeNow: vi.fn(async () => { throw new Error('x') }) })
    setTurn(state())
    show('t1', client)
    click(button('Resume now'))
    await flush()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    setTurn(state({ turnId: 'run:2', pause: pause({ runId: 'run:2' }) }))
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps the time left current while the thread stays paused', () => {
    vi.useFakeTimers({ now: NOW })
    setTurn(state())
    show('t1', clientOf())
    expect(text()).toContain('Resets in 2h 15m')
    act(() => { vi.advanceTimersByTime(30 * 60_000) })
    expect(text()).toContain('Resets in 1h 45m')
  })
})
