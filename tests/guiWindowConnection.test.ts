/**
 * A window's own connection to the service (#1042): it carries every update of the window's threads, so main notices
 * when it drops and opens it again without waiting for the window's next request, acts on a gap found while
 * subscribing, numbers its events the way the service sends them, and can tell that events never arrived.
 */
import { mkdtempSync, rmSync } from 'fs'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { GuiMmsController } from '../src/main/mms/GuiMmsController'
import { LocalMmsClient } from '../src/mms/protocol/client'
import type { ProtocolEvent } from '../src/mms/protocol/types'

type Internals = {
  windowSessions: Map<number, { client: LocalMmsClient }>
}
type Ring = { push: (type: string, data: unknown, threadId?: string, profileId?: string) => ProtocolEvent; currentSequence: number }

describe("a window's own service connection", () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string
  let gui: GuiMmsController
  const log: Array<{ event: string; fields: Record<string, unknown> }> = []

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-gui-link-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'daemon' })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
    mms.getOwnerLease()?.setEndpoint(endpoint)
    gui = new GuiMmsController({ homeDir: home, disableAutoStart: true, endpointOverride: endpoint, ownerTokenOverride: ownerToken })
    log.length = 0
    gui.setConnectionLog({ write: (event, fields = {}) => void log.push({ event, fields }) })
    await gui.start()
  })

  afterEach(async () => {
    await gui.stop()
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const windowSender = (id: number) => Object.assign(new EventEmitter(), { id, isDestroyed: () => false }) as unknown as WebContents
  const ringOf = (profileId: string): Ring => (server as unknown as { ringFor: (id: string) => Ring }).ringFor(profileId)

  it('is opened again by itself when the service drops it, and the window is told to catch up', async () => {
    const sender = windowSender(901)
    await gui.prepareWindow(sender)
    const internals = gui as unknown as Internals
    const first = internals.windowSessions.get(901)!.client
    const reopened = vi.fn()
    gui.on('window-session-reopened', reopened)

    // The service closes the connection (a restart, or a window too slow to read): no request follows.
    ;(first as unknown as { socket: { destroy: () => void } }).socket.destroy()
    await vi.waitFor(() => expect(reopened).toHaveBeenCalledWith({ senderId: 901 }), { timeout: 5_000 })

    const second = internals.windowSessions.get(901)!.client
    expect(second).not.toBe(first)
    expect(second.connected).toBe(true)
    expect(gui.getWindowBindingForSender(901)).not.toBeNull()
    expect(log.map((line) => line.event)).toEqual(expect.arrayContaining(['window.subscribed', 'window.lost', 'window.reopened']))
    expect(log.find((line) => line.event === 'window.lost')?.fields).toMatchObject({ window: 901 })
    expect(log.filter((line) => line.event === 'window.subscribed').map((line) => line.fields.how)).toEqual(['opened', 'reopened'])

    // Live updates reach the new connection.
    const events: string[] = []
    gui.on('window-event', ({ senderId, event }: { senderId: number; event: ProtocolEvent }) => { if (senderId === 901) events.push(event.type) })
    await gui.runWithSender(sender, () => gui.request('threads.create', { name: 'After' }))
    await vi.waitFor(() => expect(events).toContain('threads.updated'))
  })

  it("is not opened again after main closed it itself", async () => {
    const sender = windowSender(902)
    await gui.prepareWindow(sender)
    const reopened = vi.fn()
    gui.on('window-session-reopened', reopened)
    await gui.stop()
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(reopened).not.toHaveBeenCalled()
    expect(log.some((line) => line.event === 'window.lost')).toBe(false)
    await gui.start()
  })

  it('asks for a catch-up at once when its subscription reports a gap, without waiting for another event', async () => {
    for (let i = 0; i < 600; i += 1) ringOf(mms.profileId).push('test.filler', { i })
    const resnapshots = vi.fn()
    gui.on('window-resnapshot', resnapshots)
    await gui.prepareWindow(windowSender(903))
    expect(resnapshots).toHaveBeenCalledWith({ senderId: 903 })
    expect(log.find((line) => line.event === 'window.subscribed')?.fields).toMatchObject({ window: 903, gap: true })
  })

  it("hears its first live updates when the service's installation-wide counter is ahead of its profile's", async () => {
    // Events of another profile advance the installation-wide counter, not this profile's.
    const installation = (server as unknown as { ring: Ring }).ring
    for (let i = 0; i < 50; i += 1) installation.push('other.profile', { i })
    const sender = windowSender(904)
    await gui.prepareWindow(sender)
    const events: string[] = []
    gui.on('window-event', ({ senderId, event }: { senderId: number; event: ProtocolEvent }) => { if (senderId === 904) events.push(event.type) })
    await gui.runWithSender(sender, () => gui.request('threads.create', { name: 'First live update' }))
    await vi.waitFor(() => expect(events).toContain('threads.updated'))
    await vi.waitFor(() => expect((gui as unknown as Internals).windowSessions.get(904)!.client.lastKnownSequence).toBe(ringOf(mms.profileId).currentSequence))
  })

  it('a replay that skips numbers the ring replaced with newer copies is not a gap', async () => {
    const ring = ringOf(mms.profileId)
    for (let i = 0; i < 5; i += 1) {
      ring.push('thread.message-updated', { message: { id: 'm1', content: `v${i}` } }, 't-replaced')
      ring.push('test.between', { i })
    }
    await gui.prepareWindow(windowSender(905))
    expect((gui as unknown as Internals).windowSessions.get(905)!.client.requiresResnapshot).toBe(false)
  })

  it("tells when the service sent the window events it never received", async () => {
    const sender = windowSender(906)
    await gui.prepareWindow(sender)
    const { thread } = await gui.runWithSender(sender, () => gui.request<{ thread: { id: string } }>('threads.create', { name: 'Status' }))
    await vi.waitFor(async () => expect((await gui.turnStatusForSender(906, thread.id)).behind).toBe(false))
    const status = await gui.turnStatusForSender(906, thread.id)
    expect(status.activeTurn).toEqual({ active: false, running: false })

    // An event the service numbered but the window never got (pushed to the ring without being sent).
    ringOf(mms.profileId).push('turn.state', { threadId: thread.id, turnId: null, phase: 'idle', updatedAt: new Date().toISOString() }, thread.id, mms.profileId)
    expect((await gui.turnStatusForSender(906, thread.id)).behind).toBe(true)
  })
})

describe("the service's hello", () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-hello-'))
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'daemon' })
    await mms.start()
    server = new MmsProtocolServer({ mms, ownerToken: mms.getOwnerLease()!.owner.token, version: 'test' })
    await server.start()
  })
  afterEach(async () => {
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
  })

  it("reports the default profile's event number, the one an unbound client is sent", async () => {
    const installation = (server as unknown as { ring: Ring }).ring
    for (let i = 0; i < 20; i += 1) installation.push('other.profile', { i })
    const client = new LocalMmsClient({ homeDir: home, ownerToken: mms.getOwnerLease()!.owner.token, endpoint: server.endpoint!, clientType: 'cli' })
    try {
      const hello = await client.connect()
      expect(hello.globalSequence).toBe(server.globalSequence)
      expect(hello.globalSequence).toBeLessThan(installation.currentSequence)
    } finally {
      await client.close()
    }
  })
})
