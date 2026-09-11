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
    const registered = await host.registerTab(owner as never, { localTabId: 'local_tab', webContentsId: guest.id, threadId: 'thread_host' })
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
})
