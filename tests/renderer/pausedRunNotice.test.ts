// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PausedRunNotice, pausedRunNotice, type PausedRunNoticeInput } from '../../src/renderer/chat/components/PausedRunNotice'
import { ComposerNotice, ComposerNoticeProvider, ComposerNoticeSlot } from '../../src/renderer/components/ComposerNotice'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { createPausedRunClient, type PausedRunClient } from '../../src/renderer/services/pausedRunClient'
import { isTurnActivePhase, type TurnPause, type TurnState } from '../../src/shared/types'

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

const notice = () => host.querySelector<HTMLElement>('.composer-notice')
const line = () => host.querySelector<HTMLElement>('.composer-notice-text')
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
const names = () => buttons().map((entry) => entry.getAttribute('aria-label') ?? entry.textContent)
const button = (label: string) => buttons().find((entry) => (entry.getAttribute('aria-label') ?? entry.textContent)?.startsWith(label))!
const click = (target: Element) => act(() => { (target as HTMLElement).click() })
const key = (target: Element, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
const STOP = 'Stop thread and subagents'
const openMenu = () => { click(button('More')); return menuItems() }

function view(patch: Partial<PausedRunNoticeInput> = {}) {
  const input: PausedRunNoticeInput = { pause: pause(), now: NOW, busy: null, error: null, onResume: vi.fn(), onEndPause: vi.fn(), onDismissError: vi.fn(), onStop: vi.fn(), ...patch }
  act(() => root.render(createElement(ComposerNotice, pausedRunNotice(input))))
  return input
}

describe('the paused run notice', () => {
  it('one line: the limit, when it resumes and the time left; the limit\'s name in the tooltip; Try now, Don\'t resume and More', () => {
    view()
    expect(line()!.textContent).toMatch(/^Usage limit reached · resumes .+ \(in 2h 15m\)$/)
    expect(line()!.title).toBe("Claude's 5-hour limit was reached. Continues by itself at reset.")
    expect(notice()!.dataset.tone).toBe('warning')
    expect(names()).toEqual(['Try now', "Don't resume", 'More'])
    expect(button("Don't resume").title).toBe('Drop this run; queued messages still send')
    expect(button('More').title).toBe('More')
    expect(button('More').getAttribute('aria-haspopup')).toBe('menu')
  })

  it('keeps Stop in reach: the composer shows no Stop while a run is paused', () => {
    expect(isTurnActivePhase('paused')).toBe(false)
  })

  it('says an estimated time is approximate', () => {
    view({ pause: pause({ estimated: true }) })
    expect(line()!.textContent).toMatch(/^Usage limit reached · resumes around .+ \(in 2h 15m\)$/)
  })

  it('with no timer it says when the limit resets, not that it resumes', () => {
    view({ pause: pause({ autoResume: false }) })
    expect(line()!.textContent).toMatch(/^Usage limit reached · resets .+ \(in 2h 15m\)$/)
    expect(line()!.title).toContain("It won't continue by itself. Press Try now once it resets.")
  })

  it('past the reset time it says it is retrying, or that it should have reset', () => {
    view({ now: at(16, 10) })
    expect(line()!.textContent).toBe('Usage limit reached · retrying now')
    view({ pause: pause({ autoResume: false }), now: at(16, 10) })
    expect(line()!.textContent).toBe('Usage limit reached · should have reset by now')
  })

  it('a stale pause says the resume time is unknown, and still offers Try now', () => {
    view({ pause: pause({ autoResume: false, stale: true }), now: at(9, 0, 29) })
    expect(line()!.textContent).toBe('Usage limit reached · resume time unknown')
    expect(line()!.title).toContain("won't continue by itself")
    expect(names()).toContain('Try now')
  })

  it('Try now, Don\'t resume and the menu\'s Stop each call their own handler once', () => {
    const input = view()
    const calls = () => [input.onResume, input.onEndPause, input.onStop!].map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length)
    click(button('Try now'))
    expect(calls()).toEqual([1, 0, 0])
    click(button("Don't resume"))
    expect(calls()).toEqual([1, 1, 0])
    expect(menu()).toBeNull()
    expect(openMenu().map((item) => item.textContent)).toEqual([STOP])
    click(menuItems()[0]!)
    expect(calls()).toEqual([1, 1, 1])
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(button('More'))
  })

  it('the menu works from the keyboard: an arrow opens it on its one item, Escape closes it back to More', () => {
    const input = view()
    button('More').focus()
    key(button('More'), 'ArrowDown')
    expect(menu()).not.toBeNull()
    expect(button('More').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(menuItems()[0])
    key(menuItems()[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(menuItems()[0])
    key(menuItems()[0]!, 'Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(button('More'))
    expect(input.onStop).not.toHaveBeenCalled()
  })

  it('has no More where the shell has no Stop', () => {
    view({ onStop: undefined })
    expect(names()).toEqual(['Try now', "Don't resume"])
  })

  it('has no dismiss: it resolves when the run continues or the pause ends', () => {
    view()
    expect(names()).not.toContain('Dismiss')
  })

  it('while a press is in flight every button and the menu\'s Stop ignore presses, and the pressed one says so', () => {
    const input = view({ busy: 'resume' })
    expect(button('Trying…').getAttribute('aria-busy')).toBe('true')
    for (const entry of buttons().filter((entry) => entry.textContent)) {
      expect(entry.getAttribute('aria-disabled')).toBe('true')
      click(entry)
    }
    const [stop] = openMenu()
    expect(stop!.getAttribute('aria-disabled')).toBe('true')
    click(stop!)
    expect([input.onResume, input.onEndPause, input.onStop!].every((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true)
    view({ busy: 'cancel' })
    expect(button('Cancelling…')).toBeDefined()
  })

  it('a failed press shows as an error line that can be dismissed, with the buttons still there', () => {
    const input = view({ error: 'This run is no longer paused.' })
    expect(notice()!.dataset.tone).toBe('error')
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('This run is no longer paused.')
    expect(names()).toEqual(['Try now', "Don't resume", 'More', 'Dismiss'])
    click(button('Dismiss'))
    expect(input.onDismissError).toHaveBeenCalledTimes(1)
  })

  it('is a named group, and a button that goes busy keeps focus', () => {
    view()
    expect(notice()!.getAttribute('role')).toBe('group')
    expect(notice()!.getAttribute('aria-label')).toBe('Run paused by a usage limit')
    button('Try now').focus()
    view({ busy: 'resume' })
    expect(document.activeElement).toBe(button('Trying…'))
  })
})

describe('the notice on a thread', () => {
  const state = (patch: Partial<TurnState> = {}): TurnState => ({ threadId: 't1', turnId: 'run:1', phase: 'paused', updatedAt: new Date(NOW).toISOString(), pause: pause(), ...patch })
  const clientOf = (patch: Partial<PausedRunClient> = {}): PausedRunClient => ({ resumeNow: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), ...patch })
  const inSlot = (child: ReactNode) => createElement(ComposerNoticeProvider, null, createElement(Fragment, null, createElement(ComposerNoticeSlot), child))
  const show = (threadId: string | null, client: PausedRunClient, onStop?: () => void) =>
    act(() => root.render(inSlot(createElement(PausedRunNotice, { threadId, client, ...(onStop ? { onStop } : {}) }))))
  const setTurn = (turn: TurnState | undefined) => act(() => { useAppStore.setState({ turnStates: turn ? { [turn.threadId]: turn } : {} }) })
  const flush = () => act(async () => { await Promise.resolve() })

  it('shows in the slot only for a paused thread', () => {
    const client = clientOf()
    setTurn(state({ phase: 'thinking', pause: undefined }))
    show('t1', client)
    expect(notice()).toBeNull()
    setTurn(state())
    expect(notice()).not.toBeNull()
    setTurn(state({ phase: 'idle', pause: undefined }))
    expect(notice()).toBeNull()
    show(null, client)
    expect(notice()).toBeNull()
  })

  it('Try now asks the daemon to continue that run, and a second press while it is in flight does nothing', async () => {
    const resume = vi.fn(() => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 0)))
    const client = clientOf({ resumeNow: resume })
    setTurn(state())
    show('t1', client)
    click(button('Try now'))
    expect(resume).toHaveBeenCalledWith('run:1', 't1')
    click(button('Trying…'))
    click(button("Don't resume"))
    expect(resume).toHaveBeenCalledTimes(1)
    expect(client.cancel).not.toHaveBeenCalled()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    expect(button('Try now').getAttribute('aria-disabled')).toBeNull()
  })

  it('Don\'t resume asks the daemon to end the pause for that run', async () => {
    const client = clientOf()
    setTurn(state({ pause: pause({ runId: 'run:9' }) }))
    show('t1', client)
    click(button("Don't resume"))
    await flush()
    expect(client.cancel).toHaveBeenCalledWith('run:9', 't1')
    expect(client.resumeNow).not.toHaveBeenCalled()
  })

  it('the menu\'s Stop goes through the thread stop it is given', () => {
    const onStop = vi.fn()
    setTurn(state())
    show('t1', clientOf(), onStop)
    click(openMenu()[0]!)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('a refused press shows as the error line, and the next press clears it', async () => {
    const refused = Object.assign(new Error('Run run:1 is not paused.'), { code: 'conflict' })
    const client = clientOf({ resumeNow: vi.fn(async () => { throw refused }) })
    setTurn(state())
    show('t1', client)
    click(button('Try now'))
    await flush()
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('This run is no longer paused.')
    click(button("Don't resume"))
    await flush()
    expect(client.cancel).toHaveBeenCalledWith('run:1', 't1')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('another failure says what was tried, until dismissed', async () => {
    const client = clientOf({ cancel: vi.fn(async () => { throw new Error('Daemon unavailable') }) })
    setTurn(state())
    show('t1', client)
    click(button("Don't resume"))
    await flush()
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Could not cancel the run: Daemon unavailable')
    click(button('Dismiss'))
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(notice()!.dataset.tone).toBe('warning')
  })

  it('a new pause (another run) starts without the last one\'s error', async () => {
    const client = clientOf({ resumeNow: vi.fn(async () => { throw new Error('x') }) })
    setTurn(state())
    show('t1', client)
    click(button('Try now'))
    await flush()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    setTurn(state({ turnId: 'run:2', pause: pause({ runId: 'run:2' }) }))
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps the time left current while the thread stays paused', () => {
    vi.useFakeTimers({ now: NOW })
    setTurn(state())
    show('t1', clientOf())
    expect(line()!.textContent).toContain('in 2h 15m')
    act(() => { vi.advanceTimersByTime(30 * 60_000) })
    expect(line()!.textContent).toContain('in 1h 45m')
  })
})

describe('the paused run client', () => {
  it('names the run, and the thread when it is given, so a thread on another computer can be reached', async () => {
    const request = vi.fn(async () => ({ runId: 'run:1' }))
    const client = createPausedRunClient({ request } as never)
    await client.resumeNow('run:1', 'nod_0123456789abcdefghjkmnpqrs:t1')
    await client.cancel('run:2', 'nod_0123456789abcdefghjkmnpqrs:t1')
    await client.resumeNow('run:3')
    await client.cancel('run:4')
    expect(request.mock.calls).toEqual([
      ['runs.resumeNow', { runId: 'run:1', threadId: 'nod_0123456789abcdefghjkmnpqrs:t1' }],
      ['runs.cancelPause', { runId: 'run:2', threadId: 'nod_0123456789abcdefghjkmnpqrs:t1' }],
      ['runs.resumeNow', { runId: 'run:3' }],
      ['runs.cancelPause', { runId: 'run:4' }]
    ])
  })
})
