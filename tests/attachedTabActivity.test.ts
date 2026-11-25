/**
 * The in-app browser is the person's by default: an agent locks a tab only for the step that changes its page, waits
 * while the person uses it (and gives up for the turn if they keep on), never repeats a step whose input reached the
 * page, and works in its thread's own tabs beside the one the person uses.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { BrowserActionResult, BrowserObservation, BrowserSessionRecord, BrowserTab, BrowserWorkerRequest } from '../src/shared/browser/types'
import type { AttachedTabActivity } from '../src/shared/browser/attached'
import { ElectronAttachedBrowserBackend, type AttachedWindowTabs } from '../src/main/browser/automation/backend'
import { TrustedGuestRegistry } from '../src/main/browser/automation/registry'
import { createLoopbackAttachedPolicy } from '../src/main/browser/automation/policy'
import { CONFLICT_BACKOFF_MS, USER_CONFLICT_MESSAGE, USER_CONFLICT_REPEAT_MESSAGE } from '../src/main/browser/automation/session'
import { TabActivity, USER_ACTIVE_LEASE_MS, type ActivityClock } from '../src/main/browser/automation/tabActivity'
import { createFakeGuestPair } from './fixtures/agent-platform/electron-attached-browser/fakeGuest'

const profileId = 'prof_attached'
const profileEpoch = 'epoch_1'
const threadId = 'thread_1'

/** Time that moves only when a test moves it, and runs the timers that fall due. */
class FakeClock implements ActivityClock {
  time = 0
  private readonly timers = new Map<number, { at: number; callback: () => void }>()
  private nextId = 1
  now(): number { return this.time }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + ms, callback })
    return id
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  advance(ms: number): void {
    const end = this.time + ms
    while (true) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.time = due[1].at
      due[1].callback()
    }
    this.time = end
  }
}

function req(method: BrowserWorkerRequest['method'], params: Record<string, unknown>): BrowserWorkerRequest {
  return { version: 1, id: 'id_' + randomUUID(), profileId, method, params }
}

function harness() {
  const clock = new FakeClock()
  const sleeps: number[] = []
  const hooks: { onSleep?: () => void; intercept?: (method: string) => void; journal?: (entry: { phase: string }) => void } = {}
  const commands: string[] = []
  const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
  const pairs = new Map<string, ReturnType<typeof createFakeGuestPair>>()
  const owners = new Map<string, string | null>()
  const window = { opened: [] as boolean[], closed: [] as string[], reanchored: [] as string[] }
  const add = (uiTabId: string, owner: string | null) => {
    const pair = createFakeGuestPair({ profileId })
    ;(pair.guest as unknown as { title: string }).title = uiTabId
    registry.registerGuest({ guest: pair.guest, owner: pair.owner, profileId, profileEpoch, uiTabId,
      thread: owner ? { kind: 'thread', threadId: owner } : { kind: 'unbound' } })
    pairs.set(uiTabId, pair)
    owners.set(uiTabId, owner)
    return pair
  }
  // eslint-disable-next-line prefer-const
  let backend: ElectronAttachedBrowserBackend
  const tabs: AttachedWindowTabs = {
    visible: (thread) => [...owners].filter(([, owner]) => owner === null || owner === thread).map(([id]) => id),
    claim: (uiTabId, thread) => { registry.reassignThread(uiTabId, thread) },
    open: async ({ threadId: thread, activate }) => {
      window.opened.push(activate)
      const uiTabId = `uitab_new_${window.opened.length}`
      add(uiTabId, thread)
      return uiTabId
    },
    close: (uiTabId) => { window.closed.push(uiTabId) },
    reanchor: (_sessionId, uiTabId) => { window.reanchored.push(uiTabId) },
    anyUserActive: () => [...owners.keys()].some((id) => backend.activityFor(id).userActive())
  }
  backend = new ElectronAttachedBrowserBackend({
    registry, policy: createLoopbackAttachedPolicy(), journal: { append: (entry) => { hooks.journal?.(entry) } }, tabs,
    activityClock: clock,
    sleep: async (ms, signal) => {
      sleeps.push(ms)
      hooks.onSleep?.()
      if (signal?.aborted) throw signal.reason
      clock.advance(ms)
    },
    interceptCommand: (method) => { commands.push(method); hooks.intercept?.(method) }
  })
  const activity = (uiTabId: string) => backend.activityFor(uiTabId)
  const states = (uiTabId: string) => {
    const seen: AttachedTabActivity[] = []
    activity(uiTabId).onChange((state) => seen.push(state))
    return seen
  }
  const open = async (uiTabId = 'uitab_a', thread = threadId) => {
    const opened = await backend.call(req('session.open', { uiTabId, threadId: thread }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    return (opened.result as { session: BrowserSessionRecord }).session
  }
  const observe = async (sessionId: string, tabId?: string) => {
    const observed = await backend.call(req('observe', { sessionId, ...(tabId ? { tabId } : {}) }))
    expect(observed.ok, JSON.stringify(observed.error)).toBe(true)
    return observed.result as BrowserObservation
  }
  const fill = async (session: BrowserSessionRecord, text: string, options: { turn?: string; tabId?: string; signal?: AbortSignal } = {}) => {
    const observation = await observe(session.id, options.tabId)
    const name = observation.elements.find((element) => element.name === 'Name')!
    return backend.call(req('act', {
      requestId: 'req_' + randomUUID(), sessionId: session.id, tabId: observation.tabId, generation: observation.generation,
      observationId: observation.observationId, controlLeaseId: session.controlLeaseId,
      action: { type: 'fill', target: { kind: 'ref', ref: name.ref }, text },
      ...(options.turn ? { turn: options.turn } : {})
    }), options.signal ? { signal: options.signal } : {})
  }
  const tabsCall = async (sessionId: string, method: 'tabs.list' | 'tabs.switch' | 'tabs.new' | 'tabs.close', params: Record<string, unknown> = {}) =>
    backend.call(req(method, { sessionId, ...params }))
  const listTabs = async (sessionId: string) => {
    const listed = await tabsCall(sessionId, 'tabs.list')
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true)
    return (listed.result as { tabs: BrowserTab[] }).tabs
  }
  return { clock, sleeps, hooks, commands, registry, pairs, owners, add, window, backend, activity, states, open, observe, fill, tabsCall, listTabs }
}

describe('who is using a tab', () => {
  it('is the person for 3 s after their last input, then nobody, on its own', () => {
    const clock = new FakeClock()
    const activity = new TabActivity(clock)
    const seen: AttachedTabActivity[] = []
    activity.onChange((state) => seen.push(state))
    activity.noteUserInput('window')
    expect(activity.state()).toBe('user-active')
    clock.advance(USER_ACTIVE_LEASE_MS - 1)
    expect(activity.userActive()).toBe(true)
    clock.advance(1)
    expect(activity.state()).toBe('idle')
    expect(seen).toEqual(['user-active', 'idle'])
  })

  it('stays the person\'s while the address bar or picker is in use, and for a full lease after', () => {
    const clock = new FakeClock()
    const activity = new TabActivity(clock)
    activity.pin('address')
    clock.advance(60_000)
    expect(activity.state()).toBe('user-active')
    activity.unpin('address')
    clock.advance(USER_ACTIVE_LEASE_MS - 1)
    expect(activity.state()).toBe('user-active')
    clock.advance(1)
    expect(activity.state()).toBe('idle')
  })

  it('does not take the page\'s input events raised by the agent\'s own input for the person\'s', () => {
    const activity = new TabActivity(new FakeClock())
    const release = activity.beginSynthetic('pointer')
    activity.noteUserInput('guest', 'pointer')
    expect(activity.userActive()).toBe(false)
    // Input on the app's own surface around the page is always the person's.
    activity.noteUserInput('window')
    expect(activity.userActive()).toBe(true)
    release()
  })

  it('counts the person\'s keys while the agent clicks, and their clicks while it types', () => {
    const clock = new FakeClock()
    const activity = new TabActivity(clock)
    const clicking = activity.beginSynthetic('pointer')
    activity.noteUserInput('guest', 'key')
    expect(activity.userActive()).toBe(true)
    clicking()
    clock.advance(USER_ACTIVE_LEASE_MS)
    const typing = activity.beginSynthetic('key')
    activity.noteUserInput('guest', 'key')
    expect(activity.userActive()).toBe(false)
    activity.noteUserInput('guest', 'pointer')
    expect(activity.userActive()).toBe(true)
    typing()
  })

  it('stops a running agent step on the person\'s input, but not on the agent\'s own navigation', () => {
    const activity = new TabActivity(new FakeClock())
    let preempted = 0
    activity.onPreempt(() => { preempted += 1 })
    const release = activity.beginAgent()
    expect(activity.state()).toBe('agent-busy')
    activity.noteUserNavigation()
    expect(activity.userActive()).toBe(false)
    expect(preempted).toBe(0)
    activity.noteUserInput('guest', 'pointer')
    expect(preempted).toBe(1)
    release()
    expect(activity.state()).toBe('user-active')
  })

  it('shows a handover over a step, a step over a wait, and a wait over the person', () => {
    const activity = new TabActivity(new FakeClock())
    activity.noteUserInput('window')
    const waiting = activity.beginWaiting()
    expect(activity.state()).toBe('agent-waiting')
    const busy = activity.beginAgent()
    expect(activity.state()).toBe('agent-busy')
    activity.setHumanHold(true)
    expect(activity.state()).toBe('waiting-human')
    activity.setHumanHold(false)
    busy()
    waiting()
    expect(activity.state()).toBe('user-active')
  })
})

describe('an agent step in the person\'s tab', () => {
  it('locks the tab only while a step changes the page; opening and reading it never do', async () => {
    const h = harness()
    h.add('uitab_a', threadId)
    const seen = h.states('uitab_a')
    const session = await h.open()
    await h.observe(session.id)
    expect(seen).toEqual([])
    let during: AttachedTabActivity | undefined
    h.hooks.intercept = (method) => { if (method === 'Input.insertText') during = h.activity('uitab_a').state() }
    const filled = await h.fill(session, 'Ada')
    expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
    expect(during).toBe('agent-busy')
    expect(seen).toEqual(['agent-busy', 'idle'])
    // Reading while the person uses the tab neither waits nor locks.
    h.activity('uitab_a').noteUserInput('window')
    await h.observe(session.id)
    expect(h.sleeps).toEqual([])
    expect(h.activity('uitab_a').state()).toBe('user-active')
    await h.backend.shutdown()
  })

  it('waits, a step longer each time, while the person uses the tab, then acts', async () => {
    const h = harness()
    const page = h.add('uitab_a', threadId).page
    const session = await h.open()
    const seen = h.states('uitab_a')
    h.activity('uitab_a').noteUserInput('window')
    const filled = await h.fill(session, 'Ada')
    expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
    // The lease ends 3 s after the input: the third wait (at 3.5 s) is the last.
    expect(h.sleeps).toEqual([500, 1000, 2000])
    expect(seen).toContain('agent-waiting')
    expect(page.nameValue).toBe('Ada')
    await h.backend.shutdown()
  })

  it('gives way after the last wait, and at once the second time in the same turn', async () => {
    const h = harness()
    const page = h.add('uitab_a', threadId).page
    const session = await h.open()
    h.activity('uitab_a').pin('address')
    const first = await h.fill(session, 'Ada', { turn: 'run_1/turn_1' })
    expect(first.ok).toBe(false)
    expect(first.error).toMatchObject({ code: 'human_controlled', message: USER_CONFLICT_MESSAGE })
    expect(h.sleeps).toEqual([...CONFLICT_BACKOFF_MS])
    h.sleeps.length = 0
    const again = await h.fill(session, 'Ada', { turn: 'run_1/turn_1' })
    expect(again.error).toMatchObject({ code: 'human_controlled', message: USER_CONFLICT_REPEAT_MESSAGE })
    expect(h.sleeps).toEqual([])
    // A new turn waits again.
    const next = await h.fill(session, 'Ada', { turn: 'run_1/turn_2' })
    expect(next.error).toMatchObject({ code: 'human_controlled', message: USER_CONFLICT_MESSAGE })
    expect(h.sleeps).toEqual([...CONFLICT_BACKOFF_MS])
    expect(page.nameValue).toBe('')
    expect(h.commands).not.toContain('Input.insertText')
    await h.backend.shutdown()
  })

  it('stops waiting when the call is cancelled', async () => {
    const h = harness()
    h.add('uitab_a', threadId)
    const session = await h.open()
    h.activity('uitab_a').pin('address')
    const controller = new AbortController()
    h.hooks.onSleep = () => controller.abort()
    const cancelled = await h.fill(session, 'Ada', { signal: controller.signal })
    expect(cancelled.error?.code).toBe('cancelled')
    expect(h.sleeps).toEqual([500])
    expect(h.activity('uitab_a').state()).toBe('user-active')
    await h.backend.shutdown()
  })

  it('tries a step again once the person is done, when their input stopped it before it reached the page', async () => {
    const h = harness()
    const page = h.add('uitab_a', threadId).page
    const session = await h.open()
    await h.observe(session.id)
    let armed = false
    h.hooks.intercept = () => {
      if (!armed) return
      armed = false
      h.activity('uitab_a').noteUserInput('guest', 'pointer')
    }
    // The first command the step sends resolves its target, before any input.
    const observation = await h.observe(session.id)
    armed = true
    const filled = await h.backend.call(req('act', {
      requestId: 'req_retry', sessionId: session.id, tabId: observation.tabId, generation: observation.generation,
      observationId: observation.observationId, controlLeaseId: session.controlLeaseId,
      action: { type: 'fill', target: { kind: 'ref', ref: observation.elements.find((element) => element.name === 'Name')!.ref }, text: 'Ada' }
    }))
    expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
    expect((filled.result as BrowserActionResult).outcome).toBe('verified')
    expect(h.sleeps).toEqual([500, 1000, 2000])
    expect(h.commands.filter((method) => method === 'Input.insertText')).toHaveLength(1)
    expect(page.nameValue).toBe('Ada')
    await h.backend.shutdown()
  })

  it('never sends a step again once its input reached the page', async () => {
    const h = harness()
    const page = h.add('uitab_a', threadId).page
    const session = await h.open()
    h.hooks.intercept = (method) => { if (method === 'Input.insertText') h.activity('uitab_a').noteUserInput('window') }
    const filled = await h.fill(session, 'Ada')
    expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
    expect(filled.result).toMatchObject({ outcome: 'unknown-effect', dispatched: true, takeover: 'unknown', code: 'human_controlled' })
    expect(h.commands.filter((method) => method === 'Input.insertText')).toHaveLength(1)
    expect(h.sleeps).toEqual([])
    expect(page.nameValue).not.toBe('Ada')
    expect(h.activity('uitab_a').state()).toBe('user-active')
    await h.backend.shutdown()
  })

  it('never sends a step again when the person cuts in while its outcome is written', async () => {
    const h = harness()
    h.add('uitab_a', threadId)
    const session = await h.open()
    h.hooks.intercept = (method) => { if (method === 'Input.insertText') throw new Error('The page went away mid-step') }
    h.hooks.journal = (entry) => { if (entry.phase === 'outcome') h.activity('uitab_a').noteUserInput('window') }
    const filled = await h.fill(session, 'Ada')
    expect(filled.ok).toBe(false)
    expect(h.commands.filter((method) => method === 'Input.insertText')).toHaveLength(1)
    expect(h.sleeps).toEqual([])
    await h.backend.shutdown()
  })

  it('never loads a URL again once it was sent, and tells the agent the person took over', async () => {
    const h = harness()
    h.add('uitab_a', threadId)
    await h.open()
    h.hooks.intercept = (method) => { if (method === 'Page.navigate') h.activity('uitab_a').noteUserInput('window') }
    // Opening the tab again at a URL: the person's click lands after the navigation was sent.
    const reopened = await h.backend.call(req('session.open', { uiTabId: 'uitab_a', threadId, url: 'http://127.0.0.1/next' }))
    expect(reopened.error).toMatchObject({ code: 'human_controlled', message: expect.stringContaining('took over the browser') })
    expect(h.commands.filter((method) => method === 'Page.navigate')).toHaveLength(1)
    expect(h.sleeps).toEqual([])
    await h.backend.shutdown()
  })

  it('counts the person\'s keys in the page while the agent clicks, and never the agent\'s own input', async () => {
    const h = harness()
    const page = h.add('uitab_a', threadId).page
    const session = await h.open()
    // The page's events raised by the agent's own click and keys are its own.
    h.hooks.intercept = (method) => {
      if (method === 'Input.dispatchMouseEvent') h.activity('uitab_a').noteUserInput('guest', 'pointer')
      if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent') h.activity('uitab_a').noteUserInput('guest', 'key')
    }
    const own = await h.fill(session, 'Ada')
    expect(own.result).toMatchObject({ outcome: 'verified' })
    expect(page.nameValue).toBe('Ada')
    expect(h.activity('uitab_a').userActive()).toBe(false)
    // A key the person presses while the agent's click is in flight is theirs.
    let pressed = false
    h.hooks.intercept = (method) => {
      if (method === 'Input.dispatchMouseEvent' && !pressed) { pressed = true; h.activity('uitab_a').noteUserInput('guest', 'key') }
    }
    const cut = await h.fill(session, 'Grace')
    expect(cut.result).toMatchObject({ outcome: 'unknown-effect', takeover: 'unknown', code: 'human_controlled' })
    expect(h.activity('uitab_a').state()).toBe('user-active')
    await h.backend.shutdown()
  })
})

describe('an agent\'s tabs', () => {
  const setup = async () => {
    const h = harness()
    h.add('uitab_a', threadId)
    h.add('uitab_b', threadId)
    h.add('uitab_shared', null)
    h.add('uitab_other', 'thread_2')
    const session = await h.open()
    return { h, session }
  }
  const byTitle = (tabs: BrowserTab[], title: string) => tabs.find((tab) => tab.title === title)!

  it('lists the thread\'s own tabs and the shared ones, never another thread\'s, with the active one and the person\'s', async () => {
    const { h, session } = await setup()
    h.activity('uitab_b').noteUserInput('window')
    const tabs = await h.listTabs(session.id)
    expect(tabs.map((tab) => tab.title).sort()).toEqual(['uitab_a', 'uitab_b', 'uitab_shared'])
    expect(byTitle(tabs, 'uitab_a')).toMatchObject({ active: true })
    expect(byTitle(tabs, 'uitab_b')).toMatchObject({ active: false, userActive: true })
    expect(byTitle(tabs, 'uitab_a').userActive).toBeUndefined()
    // A tab moved to another thread drops out of the agent's view.
    h.owners.set('uitab_b', 'thread_2')
    expect((await h.listTabs(session.id)).map((tab) => tab.title).sort()).toEqual(['uitab_a', 'uitab_shared'])
    for (const tab of tabs) expect(tab).toEqual({ id: expect.stringMatching(/^tab_/), title: expect.any(String), url: expect.any(String), active: expect.any(Boolean), ...(tab.userActive ? { userActive: true } : {}) })
    await h.backend.shutdown()
  })

  it('works in one tab while the person uses another, with no wait', async () => {
    const { h, session } = await setup()
    h.activity('uitab_a').pin('address')
    const tabs = await h.listTabs(session.id)
    const switched = await h.tabsCall(session.id, 'tabs.switch', { tabId: byTitle(tabs, 'uitab_b').id })
    expect(switched.ok, JSON.stringify(switched.error)).toBe(true)
    const filled = await h.fill(session, 'Ada', { tabId: byTitle(tabs, 'uitab_b').id })
    expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
    expect(h.sleeps).toEqual([])
    expect(h.pairs.get('uitab_b')!.page.nameValue).toBe('Ada')
    expect(h.pairs.get('uitab_a')!.page.nameValue).toBe('')
    expect(h.activity('uitab_a').state()).toBe('user-active')
    await h.backend.shutdown()
  })

  it('binds a shared tab to the thread when it switches to it', async () => {
    const { h, session } = await setup()
    const tabs = await h.listTabs(session.id)
    const switched = await h.tabsCall(session.id, 'tabs.switch', { tabId: byTitle(tabs, 'uitab_shared').id })
    expect(switched.ok, JSON.stringify(switched.error)).toBe(true)
    expect(h.registry.descriptorOf('uitab_shared').thread).toEqual({ kind: 'thread', threadId })
    expect(h.registry.descriptorOf('uitab_other').thread).toEqual({ kind: 'thread', threadId: 'thread_2' })
    await h.backend.shutdown()
  })

  it('opens a new tab behind the one the person uses, and in front when nobody does', async () => {
    const { h, session } = await setup()
    h.activity('uitab_b').noteUserInput('window')
    const behind = await h.tabsCall(session.id, 'tabs.new')
    expect(behind.ok, JSON.stringify(behind.error)).toBe(true)
    expect(behind.result).toMatchObject({ title: 'uitab_new_1', active: true })
    expect(h.registry.descriptorOf('uitab_new_1').thread).toEqual({ kind: 'thread', threadId })
    h.clock.advance(USER_ACTIVE_LEASE_MS)
    const front = await h.tabsCall(session.id, 'tabs.new')
    expect(front.ok, JSON.stringify(front.error)).toBe(true)
    expect(h.window.opened).toEqual([false, true])
    await h.backend.shutdown()
  })

  it('refuses to close a tab the person is using, or one it cannot see', async () => {
    const { h, session } = await setup()
    const tabs = await h.listTabs(session.id)
    h.activity('uitab_b').noteUserInput('window')
    const refused = await h.tabsCall(session.id, 'tabs.close', { tabId: byTitle(tabs, 'uitab_b').id })
    expect(refused.error?.code).toBe('human_controlled')
    const unseen = await h.tabsCall(session.id, 'tabs.close', { tabId: 'tab_' + randomUUID() })
    expect(unseen.ok).toBe(false)
    expect(h.window.closed).toEqual([])
    h.clock.advance(USER_ACTIVE_LEASE_MS)
    const closed = await h.tabsCall(session.id, 'tabs.close', { tabId: byTitle(tabs, 'uitab_b').id })
    expect(closed.ok, JSON.stringify(closed.error)).toBe(true)
    expect(h.window.closed).toEqual(['uitab_b'])
    await h.backend.shutdown()
  })

  it('lets one thread switch to a shared tab that another thread has also listed: listing holds nothing', async () => {
    const { h, session } = await setup()
    const other = await h.open('uitab_other', 'thread_2')
    const shared = byTitle(await h.listTabs(session.id), 'uitab_shared').id
    const sharedForOther = byTitle(await h.listTabs(other.id), 'uitab_shared').id
    const switched = await h.tabsCall(session.id, 'tabs.switch', { tabId: shared })
    expect(switched.ok, JSON.stringify(switched.error)).toBe(true)
    // Now it is driven: the other thread's agent is refused it.
    const refused = await h.tabsCall(other.id, 'tabs.switch', { tabId: sharedForOther })
    expect(refused.error).toMatchObject({ code: 'invalid_action', message: 'Another agent is using this tab' })
    await h.backend.shutdown()
  })

  it('never closes a tab another agent drives', async () => {
    const h = harness()
    h.add('uitab_a', threadId)
    h.add('uitab_b', threadId)
    // Another run of the same thread drives uitab_b; this agent sees it in its list.
    const other = await h.backend.call(req('session.open', { uiTabId: 'uitab_b', threadId, runId: 'run_2' }))
    expect(other.ok, JSON.stringify(other.error)).toBe(true)
    const session = await h.open()
    const refused = await h.tabsCall(session.id, 'tabs.close', { tabId: byTitle(await h.listTabs(session.id), 'uitab_b').id })
    expect(refused.error).toMatchObject({ code: 'invalid_action', message: expect.stringContaining('Another agent is using this tab') })
    expect(h.window.closed).toEqual([])
    await h.backend.shutdown()
  })

  it('moves its commands to another tab when its first tab closes', async () => {
    const { h, session } = await setup()
    const tabs = await h.listTabs(session.id)
    await h.tabsCall(session.id, 'tabs.switch', { tabId: byTitle(tabs, 'uitab_b').id })
    const closed = await h.tabsCall(session.id, 'tabs.close', { tabId: byTitle(tabs, 'uitab_a').id })
    expect(closed.ok, JSON.stringify(closed.error)).toBe(true)
    expect(closed.result).toMatchObject({ anchorUiTabId: 'uitab_b' })
    expect(h.window).toMatchObject({ closed: ['uitab_a'], reanchored: ['uitab_b'] })
    const observed = await h.observe(session.id)
    expect(observed.tabId).toBe(byTitle(tabs, 'uitab_b').id)
    await h.backend.shutdown()
  })
})
