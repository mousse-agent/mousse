/**
 * What a routed call changes on this computer reaches the windows of this computer: the protocol server
 * pushes an event a routed handler raised to its subscribers, and reports a sequence from its own ring.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { LocalMmsClient } from '../../../../src/mms/protocol/client'
import { MmsProtocolServer } from '../../../../src/mms/protocol/server'

describe('events raised by a routed call', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-routed-events-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'gui' })
    await client.connect()
  })

  afterEach(async () => {
    await client.close().catch(() => undefined)
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it("reach a window's subscription in order, with the sequence the routed call reports", async () => {
    const seen: Array<{ type: string; threadId?: string; sequence: number }> = []
    client.onEvent((event) =>
      seen.push({ type: event.type, threadId: event.threadId, sequence: event.sequence })
    )
    await client.subscribe(0)
    expect(mms.protocolSequence()).toBeGreaterThanOrEqual(0)

    mms.events.emit({
      channel: 'protocol:event',
      data: { type: 'actions.updated', data: { threadId: 't-1' }, threadId: 't-1' }
    })
    mms.events.emit({
      channel: 'protocol:event',
      data: { type: 'workspace.updated', data: { threadId: 't-1' }, threadId: 't-1' }
    })
    await vi.waitFor(() =>
      expect(seen.filter((event) => event.threadId === 't-1').map((event) => event.type)).toEqual([
        'actions.updated',
        'workspace.updated'
      ])
    )
    const [first, second] = seen.filter((event) => event.threadId === 't-1')
    expect(second!.sequence).toBe(first!.sequence + 1)
    expect(mms.protocolSequence()).toBe(second!.sequence)
  }, 60_000)

  it('tell in-daemon watchers about a changed thread list, as an event raised by a window does', async () => {
    const lists: unknown[] = []
    mms.events.on('threads:updated', (data) => lists.push(data))
    await client.subscribe(0)
    mms.events.emit({
      channel: 'protocol:event',
      data: { type: 'threads.updated', data: { threads: [] } }
    })
    await vi.waitFor(() => expect(lists).toEqual([{ threads: [] }]))
  }, 60_000)
})
