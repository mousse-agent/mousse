import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachedBrowserCommand } from '../src/mms/protocol/connectionCommands'
import type { BrowserActionResult, BrowserObservation, BrowserSessionRecord, BrowserWorkerRequest } from '../src/shared/browser/types'
import { FakeDebugger } from './fixtures/agent-platform/electron-attached-browser/fakeGuest'

const electronState = vi.hoisted(() => ({ partition: {} }))
vi.mock('electron', () => ({ session: { fromPartition: () => electronState.partition } }))

import { AttachedBrowserHost } from '../src/main/browser/AttachedBrowserHost'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

class Contents extends EventEmitter {
  readonly debugger: FakeDebugger
  readonly session = electronState.partition
  destroyed = false
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  constructor(readonly id: number, readonly hostWebContents: Contents | null, readonly page: ConstructorParameters<typeof FakeDebugger>[0]) {
    super(); this.debugger = new FakeDebugger(page)
  }
  isDestroyed() { return this.destroyed }
  getURL() { return this.page.url }
  getTitle() { return this.page.title }
  send(channel: string, payload: unknown) { this.sent.push({ channel, payload }) }
  destroy() { this.destroyed = true; this.page.destroyed = true; this.emit('destroyed') }
}

function browserRequest(profileId: string, method: BrowserWorkerRequest['method'], params: Record<string, unknown>): BrowserWorkerRequest {
  return { version: 1, id: `request_${randomUUID()}`, profileId, method, params }
}

/** Time that moves only when a test moves it, and runs the timers that fall due. */
class FakeClock {
  time = 0
  private readonly timers = new Map<number, { at: number; callback: () => void }>()
  private nextId = 1
  now(): number { return this.time }
  setTimeout(callback: () => void, ms: number): unknown { const id = this.nextId++; this.timers.set(id, { at: this.time + ms, callback }); return id }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  advance(ms: number): void {
    const end = this.time + ms
    while (true) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0]); this.time = due[1].at; due[1].callback()
    }
    this.time = end
  }
}

describe('AttachedBrowserHost production ownership', () => {
  it('routes the registered existing guest and drains raw work before unregistering it', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'mousse-attached-host-'))
    roots.push(artifactRoot)
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    let registration!: { registrationId: string; registrationEpoch: number; uiTabId: string; closureToken: string }
    const binding = { profileId: 'prof_host', epoch: 7 }
    let currentBinding: typeof binding | null = binding
    const host = new AttachedBrowserHost({
      binding: () => currentBinding,
      request: async (_sender, method, raw) => {
        const params = raw as Record<string, unknown>
        calls.push({ method, params })
        if (method === 'browser.attachments.register') {
          registration = params as typeof registration
          return { ...params, profileId: binding.profileId, profileEpoch: binding.epoch, artifactRoot }
        }
        return { ok: true }
      }
    })
    const ownerPage = { url: 'app://mousse', title: 'Mousse', nameValue: '', result: '', posts: 0, cookie: '', destroyed: false, loaderId: 'owner', frameId: 'owner' }
    const guestPage = { url: 'http://127.0.0.1/page', title: 'Fixture', nameValue: '', result: '', posts: 0, cookie: '', destroyed: false, loaderId: 'loader', frameId: 'frame' }
    const owner = new Contents(10, null, ownerPage)
    const guest = new Contents(11, owner, guestPage)
    host.observeGuest(owner as never, guest as never)
    const registered = await host.registerTab(owner as never, { localTabId: 'local_tab', webContentsId: guest.id })
    expect(registered.uiTabId).toBe(registration.uiTabId)

    const invoke = (request: BrowserWorkerRequest) => host.handleCommand(owner as never, {
      commandId: `command_${request.id}`,
      ...registration,
      profileId: binding.profileId,
      profileEpoch: binding.epoch,
      request
    } satisfies AttachedBrowserCommand, new AbortController().signal)
    const opened = await invoke(browserRequest(binding.profileId, 'session.open', {
      uiTabId: registration.uiTabId,
      threadId: 'thread_host'
    }))
    expect(opened.error).toBeUndefined()
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const save = payload.observation.elements.find((element) => element.name === 'Save')!
    const release = guest.debugger.holdMethod('Input.dispatchMouseEvent')
    const action = invoke(browserRequest(binding.profileId, 'act', {
      requestId: 'held_action', sessionId: payload.session.id, tabId: payload.observation.tabId,
      generation: payload.session.generation, observationId: payload.observation.observationId,
      controlLeaseId: payload.session.controlLeaseId, action: { type: 'click', target: { kind: 'ref', ref: save.ref } }
    }))
    await guest.debugger.waitUntilHeld('Input.dispatchMouseEvent')
    guest.destroy()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.some((call) => call.method === 'browser.attachments.unregister')).toBe(false)
    release()
    const outcome = await action
    expect((outcome.result as BrowserActionResult).outcome).toBe('unknown-effect')
    for (let index = 0; index < 50 && !calls.some((call) => call.method === 'browser.attachments.unregister'); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(calls.map((call) => call.method)).toEqual([
      'browser.attachments.register',
      'browser.attachments.unregister'
    ])
    expect(owner.sent.some((event) => event.channel === 'browser:automation-state')).toBe(true)
    // The renderer shows the agent's tab in the thread it names.
    expect(owner.sent).toContainEqual({ channel: 'browser:automation-state', payload: expect.objectContaining({
      owner: 'agent', sessionId: payload.session.id, uiTabId: 'local_tab', threadId: 'thread_host'
    }) })

    const orphanPage = { ...guestPage, destroyed: false, loaderId: 'loader_2', frameId: 'frame_2' }
    const orphanGuest = new Contents(12, owner, orphanPage)
    host.observeGuest(owner as never, orphanGuest as never)
    await host.registerTab(owner as never, { localTabId: 'orphan_tab', webContentsId: orphanGuest.id, threadId: 'thread_host' })
    const orphanRegistration = { ...registration }
    currentBinding = null
    orphanGuest.destroy()
    await new Promise((resolve) => setTimeout(resolve, 10))
    currentBinding = binding
    for (let index = 0; index < 50 && !calls.some((call) => call.method === 'browser.attachments.acknowledgeClosed'); index += 1) {
      await host.acknowledgeClosed(owner as never)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const acknowledged = calls.find((call) => call.method === 'browser.attachments.acknowledgeClosed')
    expect(acknowledged?.params).toMatchObject({
      registrationId: orphanRegistration.registrationId,
      registrationEpoch: orphanRegistration.registrationEpoch,
      closureToken: orphanRegistration.closureToken
    })
    await host.shutdown()
  })

  it('registers a tab that loads again while its unloaded page is still being released', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'mousse-attached-host-'))
    roots.push(artifactRoot)
    const binding = { profileId: 'prof_host', epoch: 7 }
    let releaseUnregister!: () => void
    const unregisterHeld = new Promise<void>((resolve) => { releaseUnregister = resolve })
    const methods: string[] = []
    const host = new AttachedBrowserHost({
      binding: () => binding,
      request: async (_sender, method, raw) => {
        methods.push(method)
        if (method === 'browser.attachments.unregister') await unregisterHeld
        if (method === 'browser.attachments.register') return { ...(raw as object), profileId: binding.profileId, profileEpoch: binding.epoch, artifactRoot }
        return { ok: true }
      }
    })
    const page = (loaderId: string) => ({ url: 'http://127.0.0.1/page', title: 'Fixture', nameValue: '', result: '', posts: 0, cookie: '', destroyed: false, loaderId, frameId: loaderId })
    const owner = new Contents(20, null, page('owner'))
    const first = new Contents(21, owner, page('first'))
    host.observeGuest(owner as never, first as never)
    const before = await host.registerTab(owner as never, { localTabId: 'local_tab', webContentsId: first.id, threadId: 'thread_host' })

    // The window unloads the tab, then shows it again before the old page's registration has ended.
    first.destroy()
    const second = new Contents(22, owner, page('second'))
    host.observeGuest(owner as never, second as never)
    const again = host.registerTab(owner as never, { localTabId: 'local_tab', webContentsId: second.id, threadId: 'thread_host' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseUnregister()
    const after = await again
    expect(after.uiTabId).not.toBe(before.uiTabId)
    expect(methods).toEqual(['browser.attachments.register', 'browser.attachments.unregister', 'browser.attachments.register'])
    await host.shutdown()
  })
})

describe('AttachedBrowserHost tabs and the person using them', () => {
  const page = (title: string) => ({ url: 'http://127.0.0.1/page', title, nameValue: '', result: '', posts: 0, cookie: '', destroyed: false, loaderId: title, frameId: title })
  async function window() {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'mousse-attached-host-'))
    roots.push(artifactRoot)
    const binding = { profileId: 'prof_host', epoch: 7 }
    const registrations = new Map<string, { registrationId: string; registrationEpoch: number; uiTabId: string; closureToken: string }>()
    const clock = new FakeClock()
    const sleeps: number[] = []
    const requests: Array<[string, unknown]> = []
    const host = new AttachedBrowserHost({
      binding: () => binding,
      request: async (_sender, method, raw) => {
        requests.push([method, raw])
        const params = raw as { registrationId: string; registrationEpoch: number; uiTabId: string; closureToken: string }
        if (method === 'browser.attachments.register') {
          registrations.set(params.uiTabId, params)
          return { ...params, profileId: binding.profileId, profileEpoch: binding.epoch, artifactRoot }
        }
        return { ok: true }
      }
    }, { activityClock: clock, sleep: async (ms) => { sleeps.push(ms); clock.advance(ms) } })
    const owner = new Contents(30, null, page('owner'))
    let nextId = 31
    const tab = async (localTabId: string, threadId?: string, openRequestId?: string, agentOpened?: boolean) => {
      const guest = new Contents(nextId++, owner, page(localTabId))
      host.observeGuest(owner as never, guest as never)
      const { uiTabId } = await host.registerTab(owner as never, { localTabId, webContentsId: guest.id, ...(threadId ? { threadId } : {}), ...(openRequestId ? { openRequestId } : {}), ...(agentOpened ? { agentOpened } : {}) })
      return { guest, uiTabId }
    }
    const invoke = (uiTabId: string, method: BrowserWorkerRequest['method'], params: Record<string, unknown>) => host.handleCommand(owner as never, {
      commandId: `command_${randomUUID()}`, ...registrations.get(uiTabId)!, profileId: binding.profileId, profileEpoch: binding.epoch,
      request: browserRequest(binding.profileId, method, params)
    } satisfies AttachedBrowserCommand, new AbortController().signal)
    const activityOf = (localTabId: string) => owner.sent
      .filter((event) => event.channel === 'browser:automation-state' && (event.payload as { uiTabId: string }).uiTabId === localTabId)
      .map((event) => (event.payload as { activity?: string }).activity).at(-1) ?? 'idle'
    return { host, owner, clock, sleeps, requests, tab, invoke, activityOf }
  }

  it('makes a tab the person\'s on their click, key or own navigation in it, and on the window\'s reports, with no script in the page', async () => {
    const w = await window()
    const { guest } = await w.tab('local_a', 'thread_host')
    guest.emit('input-event', {}, { type: 'mouseDown' })
    expect(w.activityOf('local_a')).toBe('user-active')
    w.clock.advance(3_000)
    expect(w.activityOf('local_a')).toBe('idle')
    guest.emit('input-event', {}, { type: 'mouseMove' })
    expect(w.activityOf('local_a')).toBe('idle')
    guest.emit('before-input-event', {}, { type: 'keyDown', key: 'a' })
    expect(w.activityOf('local_a')).toBe('user-active')
    w.clock.advance(3_000)
    // A navigation the page started is its own; one from the address bar, back or reload is the person's.
    guest.emit('did-start-navigation', { url: 'http://127.0.0.1/next', isMainFrame: true, isSameDocument: false, initiator: {} })
    expect(w.activityOf('local_a')).toBe('idle')
    guest.emit('did-start-navigation', { url: 'http://127.0.0.1/next', isMainFrame: true, isSameDocument: false })
    expect(w.activityOf('local_a')).toBe('user-active')
    w.clock.advance(3_000)
    w.host.reportActivity(w.owner as never, { localTabId: 'local_a', kind: 'pin', pin: 'address' })
    w.clock.advance(60_000)
    expect(w.activityOf('local_a')).toBe('user-active')
    w.host.reportActivity(w.owner as never, { localTabId: 'local_a', kind: 'unpin', pin: 'address' })
    w.clock.advance(3_000)
    expect(w.activityOf('local_a')).toBe('idle')
    expect(guest.debugger.attached).toBe(false)
    await w.host.shutdown()
  })

  it('offers a thread\'s agent only its own tabs and those kept in every thread, and opens its new tabs through the window', async () => {
    const w = await window()
    const a = await w.tab('local_a', 'thread_host')
    await w.tab('local_b', 'thread_host')
    await w.tab('local_shared')
    const other = await w.tab('local_other', 'thread_2')
    // Another thread's tab is never opened for this thread's agent.
    const refused = await w.invoke(other.uiTabId, 'session.open', { uiTabId: other.uiTabId, threadId: 'thread_host' })
    expect(refused.error?.code).toBe('policy_denied')
    const opened = await w.invoke(a.uiTabId, 'session.open', { uiTabId: a.uiTabId, threadId: 'thread_host' })
    expect(opened.error).toBeUndefined()
    const sessionId = (opened.result as { session: BrowserSessionRecord }).session.id
    const titles = async () => {
      const listed = await w.invoke(a.uiTabId, 'tabs.list', { sessionId })
      return (listed.result as { tabs: Array<{ title: string }> }).tabs.map((tab) => tab.title).sort()
    }
    expect(await titles()).toEqual(['local_a', 'local_b', 'local_shared'])
    // A tab the window moves to another thread leaves this agent's view.
    w.host.setTabOwner(w.owner as never, 'local_b', 'thread_2')
    expect(await titles()).toEqual(['local_a', 'local_shared'])

    // A new tab, while the person uses another, opens behind it.
    w.host.reportActivity(w.owner as never, { localTabId: 'local_shared', kind: 'input' })
    const created = w.invoke(a.uiTabId, 'tabs.new', { sessionId })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const commandEvent = w.owner.sent.find((event) => event.channel === 'browser:tab-command')
    expect(commandEvent?.payload).toMatchObject({ kind: 'open', threadId: 'thread_host', activate: false })
    await w.tab('local_new', 'thread_host', (commandEvent!.payload as { requestId: string }).requestId)
    const result = await created
    expect(result.error).toBeUndefined()
    expect(result.result).toMatchObject({ title: 'local_new', active: true })
    expect(await titles()).toEqual(['local_a', 'local_new', 'local_shared'])
    expect(w.sleeps).toEqual([])
    await w.host.shutdown()
  })

  it('takes a tab moved to another thread from this thread\'s agent and ends its handover; moving its first tab ends the session', async () => {
    const w = await window()
    const a = await w.tab('local_a', 'thread_host')
    const b = await w.tab('local_b', 'thread_host')
    const opened = await w.invoke(a.uiTabId, 'session.open', { uiTabId: a.uiTabId, threadId: 'thread_host' })
    const sessionId = (opened.result as { session: BrowserSessionRecord }).session.id
    const listed = (await w.invoke(a.uiTabId, 'tabs.list', { sessionId })).result as { tabs: Array<{ id: string; title: string }> }
    const tabOf = (title: string) => listed.tabs.find((tab) => tab.title === title)!.id
    expect((await w.invoke(a.uiTabId, 'tabs.switch', { sessionId, tabId: tabOf('local_b') })).error).toBeUndefined()
    // The agent hands local_b to the person, then the window moves local_b to another thread.
    expect((await w.invoke(a.uiTabId, 'control.take', { sessionId, owner: 'human' })).error).toBeUndefined()
    expect(w.activityOf('local_b')).toBe('waiting-human')
    w.host.setTabOwner(w.owner as never, 'local_b', 'thread_2')
    expect(w.activityOf('local_b')).toBe('idle')
    // The daemon hears it too, so the thread that lost the tab asks for a new one.
    expect(w.requests).toContainEqual(['browser.attachments.owner', { uiTabId: b.uiTabId, threadId: 'thread_2' }])
    // The agent goes on in its own tab, never the one now another thread's.
    const observed = await w.invoke(a.uiTabId, 'observe', { sessionId })
    expect(observed.error).toBeUndefined()
    expect((observed.result as BrowserObservation).tabId).toBe(tabOf('local_a'))
    w.host.setTabOwner(w.owner as never, 'local_a', 'thread_2')
    expect((await w.invoke(a.uiTabId, 'observe', { sessionId })).ok).toBe(false)
    await w.host.shutdown()
  })

  it('tells the person\'s key in the page from the agent\'s own click while the click is being sent', async () => {
    const w = await window()
    const a = await w.tab('local_a', 'thread_host')
    const opened = await w.invoke(a.uiTabId, 'session.open', { uiTabId: a.uiTabId, threadId: 'thread_host' })
    const session = (opened.result as { session: BrowserSessionRecord }).session
    const clickSave = async (requestId: string) => {
      const observation = (await w.invoke(a.uiTabId, 'observe', { sessionId: session.id })).result as BrowserObservation
      const save = observation.elements.find((element) => element.name === 'Save')!
      return w.invoke(a.uiTabId, 'act', {
        requestId, sessionId: session.id, tabId: observation.tabId, generation: observation.generation,
        observationId: observation.observationId, controlLeaseId: session.controlLeaseId,
        action: { type: 'click', target: { kind: 'ref', ref: save.ref } }
      })
    }
    // The page's mouse events raised by the agent's own click are its own.
    let release = a.guest.debugger.holdMethod('Input.dispatchMouseEvent')
    let action = clickSave('own_click')
    await a.guest.debugger.waitUntilHeld('Input.dispatchMouseEvent')
    a.guest.emit('input-event', {}, { type: 'mouseDown' })
    release()
    expect((await action).result).toMatchObject({ outcome: 'verified' })
    expect(w.activityOf('local_a')).not.toBe('user-active')
    // A key the person presses while the click is in flight is theirs: the click stops and is not sent again.
    release = a.guest.debugger.holdMethod('Input.dispatchMouseEvent')
    action = clickSave('cut_click')
    await a.guest.debugger.waitUntilHeld('Input.dispatchMouseEvent')
    a.guest.emit('before-input-event', {}, { type: 'keyDown', key: 'a' })
    release()
    expect((await action).result).toMatchObject({ outcome: 'unknown-effect', code: 'human_controlled' })
    expect(w.activityOf('local_a')).toBe('user-active')
    expect(w.sleeps).toEqual([])
    await w.host.shutdown()
  })

  it('keeps a handover when the window gives the shared tab to the thread whose agent asked for it', async () => {
    const w = await window()
    const a = await w.tab('local_a', 'thread_host')
    await w.tab('local_shared')
    const opened = await w.invoke(a.uiTabId, 'session.open', { uiTabId: a.uiTabId, threadId: 'thread_host' })
    const sessionId = (opened.result as { session: BrowserSessionRecord }).session.id
    const listed = (await w.invoke(a.uiTabId, 'tabs.list', { sessionId })).result as { tabs: Array<{ id: string; title: string }> }
    const shared = listed.tabs.find((tab) => tab.title === 'local_shared')!.id
    expect((await w.invoke(a.uiTabId, 'tabs.switch', { sessionId, tabId: shared })).error).toBeUndefined()
    expect((await w.invoke(a.uiTabId, 'control.take', { sessionId, owner: 'human' })).error).toBeUndefined()
    w.host.setTabOwner(w.owner as never, 'local_shared', 'thread_host')
    // Still the person's until they press Resume agent.
    expect(w.activityOf('local_shared')).toBe('waiting-human')
    w.host.setTabOwner(w.owner as never, 'local_shared', 'thread_2')
    expect(w.activityOf('local_shared')).toBe('idle')
    await w.host.shutdown()
  })

  it('never gives a shared tab one agent drives to another thread\'s agent, and leaves it working for the first', async () => {
    const w = await window()
    const a = await w.tab('local_a', 'thread_host')
    const shared = await w.tab('local_shared')
    const opened = await w.invoke(a.uiTabId, 'session.open', { uiTabId: a.uiTabId, threadId: 'thread_host' })
    const sessionId = (opened.result as { session: BrowserSessionRecord }).session.id
    const listed = (await w.invoke(a.uiTabId, 'tabs.list', { sessionId })).result as { tabs: Array<{ id: string; title: string }> }
    const sharedTab = listed.tabs.find((tab) => tab.title === 'local_shared')!.id
    expect((await w.invoke(a.uiTabId, 'tabs.switch', { sessionId, tabId: sharedTab })).error).toBeUndefined()
    // The daemon offers the same tab, kept in every thread, to another thread's agent.
    const refused = await w.invoke(shared.uiTabId, 'session.open', { uiTabId: shared.uiTabId, threadId: 'thread_2' })
    expect(refused.error?.code).toBe('human_controlled')
    const observed = await w.invoke(a.uiTabId, 'observe', { sessionId, tabId: sharedTab })
    expect(observed.error).toBeUndefined()
    expect((observed.result as BrowserObservation).tabId).toBe(sharedTab)
    await w.host.shutdown()
  })

  it('takes the wheel events that follow the agent\'s scroll for its own, and the person\'s later scroll for theirs', async () => {
    const w = await window()
    const a = await w.tab('local_a', 'thread_host')
    const opened = await w.invoke(a.uiTabId, 'session.open', { uiTabId: a.uiTabId, threadId: 'thread_host' })
    const session = (opened.result as { session: BrowserSessionRecord }).session
    const step = async (action: Record<string, unknown>) => {
      const observation = (await w.invoke(a.uiTabId, 'observe', { sessionId: session.id })).result as BrowserObservation
      return w.invoke(a.uiTabId, 'act', {
        requestId: 'req_' + randomUUID(), sessionId: session.id, tabId: observation.tabId, generation: observation.generation,
        observationId: observation.observationId, controlLeaseId: session.controlLeaseId,
        action: action.type === 'click' ? { type: 'click', target: { kind: 'ref', ref: observation.elements.find((element) => element.name === 'Save')!.ref } } : action
      })
    }
    // The order Electron 43 gives: the page's wheel event while the agent's command runs, then more once it returned.
    const release = a.guest.debugger.holdMethod('Input.dispatchMouseEvent')
    const scrolling = step({ type: 'scroll', deltaX: 0, deltaY: 400 })
    await a.guest.debugger.waitUntilHeld('Input.dispatchMouseEvent')
    a.guest.emit('input-event', {}, { type: 'mouseWheel' })
    release()
    expect((await scrolling).result).toMatchObject({ outcome: 'verified' })
    a.guest.emit('input-event', {}, { type: 'gestureScrollBegin' })
    w.clock.advance(100)
    a.guest.emit('input-event', {}, { type: 'mouseWheel' })
    expect(w.activityOf('local_a')).not.toBe('user-active')
    // The next step runs at once.
    expect((await step({ type: 'click' })).result).toMatchObject({ outcome: 'verified' })
    expect(w.sleeps).toEqual([])
    // The person's own scroll, after the agent's has settled, is theirs.
    w.clock.advance(1_000)
    a.guest.emit('input-event', {}, { type: 'mouseWheel' })
    expect(w.activityOf('local_a')).toBe('user-active')
    await w.host.shutdown()
  })

  it('routes a session\'s commands through the tab they moved to when its first tab closes, and closes only tabs an agent opened', async () => {
    const w = await window()
    const a = await w.tab('local_a', 'thread_host', undefined, true)
    const b = await w.tab('local_b', 'thread_host', undefined, true)
    await w.tab('local_person', 'thread_host')
    const opened = await w.invoke(a.uiTabId, 'session.open', { uiTabId: a.uiTabId, threadId: 'thread_host' })
    const sessionId = (opened.result as { session: BrowserSessionRecord }).session.id
    const listed = (await w.invoke(a.uiTabId, 'tabs.list', { sessionId })).result as { tabs: Array<{ id: string; title: string }> }
    const tabOf = (title: string) => listed.tabs.find((tab) => tab.title === title)!.id
    // A tab the person opened keeps its page.
    expect((await w.invoke(a.uiTabId, 'tabs.close', { sessionId, tabId: tabOf('local_person') })).error?.code).toBe('policy_denied')
    expect((await w.invoke(a.uiTabId, 'tabs.switch', { sessionId, tabId: tabOf('local_b') })).error).toBeUndefined()
    const closed = await w.invoke(a.uiTabId, 'tabs.close', { sessionId, tabId: tabOf('local_a') })
    expect(closed.result).toMatchObject({ anchorUiTabId: b.uiTabId })
    expect(w.owner.sent).toContainEqual({ channel: 'browser:tab-command', payload: { kind: 'close', localTabId: 'local_a' } })
    // From now on the session's commands come through local_b's registration, never local_a's.
    const observed = await w.invoke(b.uiTabId, 'observe', { sessionId })
    expect(observed.error).toBeUndefined()
    expect((observed.result as BrowserObservation).tabId).toBe(tabOf('local_b'))
    expect((await w.invoke(a.uiTabId, 'observe', { sessionId })).error?.code).toBe('policy_denied')
    await w.host.shutdown()
  })

  it('hands a tab back with Resume agent, and has no call to take one over', async () => {
    const w = await window()
    const a = await w.tab('local_a', 'thread_host')
    const opened = await w.invoke(a.uiTabId, 'session.open', { uiTabId: a.uiTabId, threadId: 'thread_host' })
    const sessionId = (opened.result as { session: BrowserSessionRecord }).session.id
    await w.host.resumeAgent(w.owner as never, 'local_a')
    expect(w.requests).toContainEqual(['browser.sessions.resume', { sessionId, threadId: 'thread_host' }])
    expect('control' in w.host).toBe(false)
    expect(w.requests.map(([method]) => method)).not.toContain('browser.sessions.takeControl')
    await w.host.shutdown()
  })
})
