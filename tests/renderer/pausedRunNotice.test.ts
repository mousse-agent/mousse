// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PausedRunNotice, RESUME_STALLED_TEXT, RESUME_WAIT_MS, pausedRunNotice, type PausedRunNoticeInput } from '../../src/renderer/chat/components/PausedRunNotice'
import { ComposerNotice, ComposerNoticeProvider, ComposerNoticeSlot } from '../../src/renderer/components/ComposerNotice'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { createPausedRunClient, type PausedRunClient } from '../../src/renderer/services/pausedRunClient'
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

const notice = () => host.querySelector<HTMLElement>('.composer-notice')
const line = () => host.querySelector<HTMLElement>('.composer-notice-text')
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
const names = () => buttons().map((entry) => entry.getAttribute('aria-label') ?? entry.textContent)
const button = (label: string) => buttons().find((entry) => (entry.getAttribute('aria-label') ?? entry.textContent)?.startsWith(label))!
const click = (target: Element) => act(() => { (target as HTMLElement).click() })

function view(patch: Partial<PausedRunNoticeInput> = {}) {
  const input: PausedRunNoticeInput = { pause: pause(), now: NOW, busy: null, error: null, onResume: vi.fn(), onEndPause: vi.fn(), onDismissError: vi.fn(), ...patch }
  act(() => root.render(createElement(ComposerNotice, pausedRunNotice(input))))
  return input
}

describe('the paused run notice', () => {
  it('one line: the limit and when it resumes; the time left and the limit\'s name in the tooltip; only Try now and Cancel', () => {
    view()
    expect(line()!.textContent).toMatch(/^Usage limit reached · resumes \S+(\s?[AaPp][Mm])?$/)
    expect(line()!.title).toBe("Resumes in 2h 15m. Claude's 5-hour limit was reached. Continues by itself at reset.")
    expect(notice()!.dataset.tone).toBe('warning')
    expect(names()).toEqual(['Try now', 'Cancel'])
    expect(button('Try now').className).toBe('composer-notice-btn composer-notice-btn-primary')
    expect(button('Cancel').className).toBe('composer-notice-btn')
    expect(button('Cancel').title).toBe('Drop this run; queued messages still send')
    expect(host.querySelector('[aria-haspopup]')).toBeNull()
  })

  it('says an estimated time is approximate', () => {
    view({ pause: pause({ estimated: true }) })
    expect(line()!.textContent).toMatch(/^Usage limit reached · resumes around \S+(\s?[AaPp][Mm])?$/)
  })

  it('with no timer it says when the limit resets, not that it resumes', () => {
    view({ pause: pause({ autoResume: false }) })
    expect(line()!.textContent).toMatch(/^Usage limit reached · resets \S+(\s?[AaPp][Mm])?$/)
    expect(line()!.title).toBe("Resets in 2h 15m. Claude's 5-hour limit was reached. It won't continue by itself. Press Try now once it resets.")
  })

  it('past the reset time it says it is retrying, or that it should have reset', () => {
    view({ now: at(16, 10) })
    expect(line()!.textContent).toBe('Usage limit reached · retrying now')
    expect(line()!.title).not.toMatch(/ in \d/)
    view({ pause: pause({ autoResume: false }), now: at(16, 10) })
    expect(line()!.textContent).toBe('Usage limit reached · should have reset by now')
  })

  it('a continue turn that hit the limit again says it is still limited, with the reset time', () => {
    view({ pause: pause({ again: true, autoResume: false }) })
    expect(line()!.textContent).toMatch(/^Still limited · resets \S+(\s?[AaPp][Mm])?$/)
    expect(line()!.title).toContain("Claude's 5-hour limit was reached again after resuming.")
    expect(names()).toEqual(['Try now', 'Cancel'])
  })

  it('a stale pause says the resume time is unknown, and still offers Try now', () => {
    view({ pause: pause({ autoResume: false, stale: true }), now: at(9, 0, 29) })
    expect(line()!.textContent).toBe('Usage limit reached · resume time unknown')
    expect(line()!.title).toContain("won't continue by itself")
    expect(names()).toContain('Try now')
  })

  it('Try now and Cancel each call their own handler once', () => {
    const input = view()
    const calls = () => [input.onResume, input.onEndPause].map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length)
    click(button('Try now'))
    expect(calls()).toEqual([1, 0])
    click(button('Cancel'))
    expect(calls()).toEqual([1, 1])
  })

  it('has no dismiss: it resolves when the run continues or the pause ends', () => {
    view()
    expect(names()).not.toContain('Dismiss')
  })

  it('while a press is in flight every button ignores presses, and the pressed one says so', () => {
    const input = view({ busy: 'resume' })
    expect(button('Resuming…').getAttribute('aria-busy')).toBe('true')
    for (const entry of buttons().filter((entry) => entry.textContent)) {
      expect(entry.getAttribute('aria-disabled')).toBe('true')
      click(entry)
    }
    expect([input.onResume, input.onEndPause].every((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true)
    view({ busy: 'cancel' })
    expect(names()).toEqual(['Try now', 'Cancelling…'])
    expect(button('Cancelling…').getAttribute('aria-busy')).toBe('true')
  })

  it('a failed press shows as an error line that can be dismissed, with the buttons still there', () => {
    const input = view({ error: 'This run is no longer paused.' })
    expect(notice()!.dataset.tone).toBe('error')
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('This run is no longer paused.')
    expect(names()).toEqual(['Try now', 'Cancel', 'Dismiss'])
    click(button('Dismiss'))
    expect(input.onDismissError).toHaveBeenCalledTimes(1)
  })

  it('is a named group, and a button that goes busy keeps focus', () => {
    view()
    expect(notice()!.getAttribute('role')).toBe('group')
    expect(notice()!.getAttribute('aria-label')).toBe('Run paused by a usage limit')
    button('Try now').focus()
    view({ busy: 'resume' })
    expect(document.activeElement).toBe(button('Resuming…'))
  })
})

describe('the notice on a thread', () => {
  const state = (patch: Partial<TurnState> = {}): TurnState => ({ threadId: 't1', turnId: 'run:1', phase: 'paused', updatedAt: new Date(NOW).toISOString(), pause: pause(), ...patch })
  const clientOf = (patch: Partial<PausedRunClient> = {}): PausedRunClient => ({ resumeNow: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), ...patch })
  const inSlot = (child: ReactNode) => createElement(ComposerNoticeProvider, null, createElement(Fragment, null, createElement(ComposerNoticeSlot), child))
  const show = (threadId: string | null, client: PausedRunClient) =>
    act(() => root.render(inSlot(createElement(PausedRunNotice, { threadId, client }))))
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

  it('Try now says Resuming… from the press until the run continues, and ignores presses meanwhile', async () => {
    const client = clientOf()
    setTurn(state())
    show('t1', client)
    click(button('Try now'))
    expect(client.resumeNow).toHaveBeenCalledWith('run:1', 't1')
    // The daemon took the press; the continue turn has not started yet.
    await flush()
    expect(line()!.textContent).toBe('Usage limit reached · resuming…')
    expect(button('Resuming…').getAttribute('aria-busy')).toBe('true')
    click(button('Resuming…'))
    click(button('Cancel'))
    expect(client.resumeNow).toHaveBeenCalledTimes(1)
    expect(client.cancel).not.toHaveBeenCalled()
    // The continue turn starts: the thread is no longer paused and the notice goes.
    setTurn(state({ turnId: 'run:2', phase: 'thinking', pause: undefined }))
    expect(notice()).toBeNull()
  })

  it('a resume that runs into the limit again shows the new pause as still limited, with Try now back', async () => {
    vi.useFakeTimers({ now: NOW })
    const client = clientOf()
    setTurn(state())
    show('t1', client)
    click(button('Try now'))
    await flush()
    setTurn(state({ turnId: 'run:2', phase: 'thinking', pause: undefined }))
    setTurn(state({ turnId: 'run:2', pause: pause({ runId: 'run:2', again: true }) }))
    expect(line()!.textContent).toMatch(/^Still limited · resumes \S+(\s?[AaPp][Mm])?$/)
    expect(button('Try now').getAttribute('aria-disabled')).toBeNull()
  })

  it('a run still paused long after the daemon took Try now says it did not continue, and Try now works again', async () => {
    vi.useFakeTimers({ now: NOW })
    const client = clientOf()
    setTurn(state())
    show('t1', client)
    click(button('Try now'))
    await flush()
    act(() => { vi.advanceTimersByTime(RESUME_WAIT_MS - 1_000) })
    expect(button('Resuming…')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(RESUME_STALLED_TEXT)
    click(button('Try now'))
    expect(client.resumeNow).toHaveBeenCalledTimes(2)
  })

  it('Cancel asks the daemon to end the pause for that run', async () => {
    const client = clientOf()
    setTurn(state({ pause: pause({ runId: 'run:9' }) }))
    show('t1', client)
    click(button('Cancel'))
    await flush()
    expect(client.cancel).toHaveBeenCalledWith('run:9', 't1')
    expect(client.resumeNow).not.toHaveBeenCalled()
  })

  it('a refused press shows as the error line, and the next press clears it', async () => {
    const refused = Object.assign(new Error('Run run:1 is not paused.'), { code: 'conflict' })
    const client = clientOf({ resumeNow: vi.fn(async () => { throw refused }) })
    setTurn(state())
    show('t1', client)
    click(button('Try now'))
    await flush()
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('This run is no longer paused.')
    click(button('Cancel'))
    await flush()
    expect(client.cancel).toHaveBeenCalledWith('run:1', 't1')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('another failure says what was tried, until dismissed', async () => {
    const client = clientOf({ cancel: vi.fn(async () => { throw new Error('Daemon unavailable') }) })
    setTurn(state())
    show('t1', client)
    click(button('Cancel'))
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
    expect(line()!.title).toContain('in 2h 15m')
    act(() => { vi.advanceTimersByTime(30 * 60_000) })
    expect(line()!.title).toContain('in 1h 45m')
  })
})

describe('the notice on a thread that waits on paused subagents', () => {
  const sub = (id: string, parentThreadId: string) => ({ id, lineage: { parentThreadId, rootThreadId: 'p', relationship: 'subagent' } })
  // p ── c1 ── g1, p ── c2; x is a thread of its own.
  const threads = [{ id: 'p' }, sub('c1', 'p'), sub('g1', 'c1'), sub('c2', 'p'), { id: 'x' }]
  const turn = (threadId: string, patch: Partial<TurnState> = {}): TurnState => ({ threadId, turnId: `run:${threadId}`, phase: 'completed', updatedAt: new Date(NOW).toISOString(), ...patch })
  const pausedTurn = (threadId: string, hours: number, patch: Partial<TurnPause> = {}): TurnState =>
    turn(threadId, { phase: 'paused', pause: pause({ runId: `run:${threadId}`, until: new Date(at(hours)).toISOString(), autoResume: false, ...patch }) })
  const setTurns = (...turns: TurnState[]) => act(() => { useAppStore.setState({ threads: threads as never, turnStates: Object.fromEntries(turns.map((entry) => [entry.threadId, entry])) }) })
  const clientOf = (): PausedRunClient => ({ resumeNow: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) })
  const show = (client: PausedRunClient) =>
    act(() => root.render(createElement(ComposerNoticeProvider, null, createElement(Fragment, null, createElement(ComposerNoticeSlot), createElement(PausedRunNotice, { threadId: 'p', client })))))
  const flush = () => act(async () => { await Promise.resolve() })

  afterEach(() => { useAppStore.setState({ threads: [] }) })

  it('shows the paused subagent\'s reset with only Try now, which resumes that subagent', async () => {
    vi.useFakeTimers({ now: NOW })
    const client = clientOf()
    setTurns(turn('p'), pausedTurn('c1', 15, { runId: 'run:c1' }))
    show(client)
    expect(notice()!.getAttribute('aria-label')).toBe('Subagent paused by a usage limit')
    expect(line()!.textContent).toMatch(/^Subagent hit a usage limit · resets \S+(\s?[AaPp][Mm])?$/)
    expect(names()).toEqual(['Try now'])

    click(button('Try now'))
    await flush()
    expect(client.resumeNow).toHaveBeenCalledWith('run:c1', 'c1')
    expect(line()!.textContent).toBe('Subagent hit a usage limit · resuming…')
    expect(button('Resuming…').getAttribute('aria-busy')).toBe('true')
    // The subagent continues: nothing below the parent is paused any more.
    setTurns(turn('p'), turn('c1', { phase: 'thinking' }))
    expect(notice()).toBeNull()
  })

  it('counts every paused subagent at any depth, shows the soonest reset, resumes each, and ignores other threads', async () => {
    vi.useFakeTimers({ now: NOW })
    const client = clientOf()
    setTurns(turn('p'), pausedTurn('g1', 16), pausedTurn('c2', 15), pausedTurn('x', 14))
    show(client)
    expect(line()!.textContent).toMatch(/^2 subagents hit a usage limit · resets /)
    expect(line()!.title).toContain('Resets in')
    click(button('Try now'))
    await flush()
    expect((client.resumeNow as ReturnType<typeof vi.fn>).mock.calls).toEqual([['run:c2', 'c2'], ['run:g1', 'g1']])
  })

  it('stays Resuming… until every subagent it resumed has continued, and the minute counts from the press', async () => {
    vi.useFakeTimers({ now: NOW })
    setTurns(turn('p'), pausedTurn('c1', 15), pausedTurn('c2', 16))
    show(clientOf())
    click(button('Try now'))
    await flush()
    act(() => { vi.advanceTimersByTime(20_000) })
    // c1 continues first; c2 is still on its way.
    setTurns(turn('p'), turn('c1', { phase: 'thinking' }), pausedTurn('c2', 16))
    expect(line()!.textContent).toBe('Subagent hit a usage limit · resuming…')
    expect(button('Resuming…').getAttribute('aria-busy')).toBe('true')
    // c2 never continues: the minute from the press runs out, not a new minute from c1's start.
    act(() => { vi.advanceTimersByTime(RESUME_WAIT_MS - 20_000) })
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(RESUME_STALLED_TEXT)
    expect(button('Try now').getAttribute('aria-disabled')).toBeNull()
  })

  it('when the last resumed subagent continues, the notice goes', async () => {
    setTurns(turn('p'), pausedTurn('c1', 15), pausedTurn('c2', 16))
    show(clientOf())
    click(button('Try now'))
    await flush()
    setTurns(turn('p'), turn('c1', { phase: 'thinking' }), pausedTurn('c2', 16))
    expect(button('Resuming…')).toBeDefined()
    setTurns(turn('p'), turn('c1', { phase: 'thinking' }), turn('c2', { phase: 'thinking' }))
    expect(notice()).toBeNull()
  })

  it('a subagent that ran into the limit again reads still limited', () => {
    setTurns(turn('p'), pausedTurn('c1', 15, { again: true }))
    show(clientOf())
    expect(line()!.textContent).toMatch(/^Subagent still limited · /)
  })

  it('the thread\'s own pause comes first: its own notice, whose Try now resumes the subagents too', () => {
    setTurns(pausedTurn('p', 15), pausedTurn('c1', 14))
    show(clientOf())
    expect(notice()!.getAttribute('aria-label')).toBe('Run paused by a usage limit')
    expect(names()).toEqual(['Try now', 'Cancel'])
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

describe('the notice when the paused run changes', () => {
  const inSlot = (child: ReactNode) => createElement(ComposerNoticeProvider, null, createElement(Fragment, null, createElement(ComposerNoticeSlot), child))
  const paused = (runId: string): TurnState => ({ threadId: 't1', turnId: runId, phase: 'paused', updatedAt: new Date(NOW).toISOString(), pause: pause({ runId }) })

  it('does not show the failure of a press made for the run before it, and is not busy', async () => {
    let refuse!: () => void
    const resumeNow = vi.fn(() => new Promise<undefined>((_resolve, reject) => { refuse = () => reject(new Error('The service did not answer.')) }))
    const client: PausedRunClient = { resumeNow, cancel: vi.fn(async () => undefined) }
    act(() => { useAppStore.setState({ turnStates: { t1: paused('run:1') } }) })
    act(() => root.render(inSlot(createElement(PausedRunNotice, { threadId: 't1', client }))))
    click(button('Try now'))
    expect(button('Resuming…')).toBeDefined()
    // The run is replaced by another paused run of the same thread.
    act(() => { useAppStore.setState({ turnStates: { t1: paused('run:2') } }) })
    await act(async () => { refuse(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(names()).toEqual(['Try now', 'Cancel'])
  })
})
