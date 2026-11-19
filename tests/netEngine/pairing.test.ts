/**
 * Pairing pieces below the owner checks: the ticket a joiner reads before it consents, which client of a pairing
 * new calls use when two connections come up (both orders of their hellos), the removal's prune and the start-up
 * sweep of tombstones, and Start over setting the engine aside with v1's network.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId, type NodeId, type StreamId } from '../../src/shared/net'
import { NetDatabase } from '../../src/mms/net/store/database'
import { EnginePairing } from '../../src/mms/netEngine/pairing'
import { EngineSessions } from '../../src/mms/netEngine/sessions'
import { Channel, type EngineConnection } from '../../src/mms/netEngine/session/transport'
import { EnginePeerStore } from '../../src/mms/netEngine/store'
import { readTicket } from '../../src/mms/netEngine/ticket'
import { fakeLink } from './fakeLink'
import { Fabric } from './checks/harness'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('readTicket', () => {
  /** base64url of a CBOR map, as the helper writes a ticket. */
  const ticket = (fields: Array<[number, Buffer]>): string =>
    Buffer.concat([
      Buffer.from([0xa0 | fields.length]),
      ...fields.flatMap(([key, value]) => [Buffer.from([key]), value])
    ]).toString('base64url')
  const bytes = (value: Buffer) => Buffer.concat([Buffer.from([0x58, value.byteLength]), value])
  const host = Buffer.alloc(65, 4),
    invitation = Buffer.alloc(16, 9)
  const route = Buffer.from('tcp://192.168.1.5:7000')

  it('reads the host, the invitation, the kind, the expiry, the routes and the hash, with or without a link around it', () => {
    const encoded = ticket([
      [1, Buffer.from([0x01])],
      [2, Buffer.from([0x02])],
      [3, bytes(host)],
      [4, Buffer.concat([Buffer.from([0x50]), invitation])],
      [6, Buffer.from([0x1a, 0x6a, 0x00, 0x00, 0x00])],
      [7, Buffer.concat([Buffer.from([0x81, 0x60 | route.byteLength]), route])]
    ])
    const expected = {
      host: host.toString('hex'),
      invitation: invitation.toString('hex'),
      expiresAt: 0x6a000000,
      routes: ['tcp://192.168.1.5:7000'],
      kind: 2,
      // The key of a send link's flow and completion records (wire 10.2): SHA-256 of the CBOR bytes.
      hash: createHash('sha256').update(Buffer.from(encoded, 'base64url')).digest('hex')
    }
    expect(readTicket(encoded)).toEqual(expected)
    expect(readTicket(`mousse://pair#${encoded}`)).toEqual(expected)
  })

  it('refuses what is not a ticket', () => {
    for (const text of [
      '',
      'not base64!',
      Buffer.from([0x01]).toString('base64url'),
      ticket([[3, bytes(host)]])
    ])
      expect(() => readTicket(text)).toThrow(
        expect.objectContaining({ details: expect.objectContaining({ reason: 'bad_ticket' }) })
      )
  })
})

describe('client selection', () => {
  const node = newId('node') as NodeId
  /** Two outbound connections to one pairing; the other side answers each hello after the delay given. */
  function linked(delays: number[], callMs = 0) {
    const ready: string[] = []
    const inUse: string[] = []
    const sessions = new EngineSessions({
      host: {} as never,
      client: {} as never,
      name: () => 'caller',
      hooks: {
        onClientReady: (id) => ready.push(id),
        onClientClosed: (id) => ready.push(`closed ${id}`),
        onPathInUse: (connection) => inUse.push(connection.id)
      }
    })
    const links = delays.map((delay) => {
      const link = fakeLink({
        ownerOnCaller: node,
        callerOnOwner: newId('node') as NodeId,
        grant: '1',
        endpoint: 'owner'
      })
      link.inbound.onStream((stream) => {
        const channel = new Channel(stream)
        channel.onMessage((message) => {
          if (message.header.t === 'hello')
            setTimeout(() => channel.send({ t: 'hello', proto: 1, name: 'owner' }), delay)
          if (message.header.t === 'call')
            setTimeout(() => {
              channel.send({ t: 'result', result: { on: link.outbound.id } })
              channel.end()
            }, callMs)
        })
      })
      return link
    })
    return { sessions, links, ready, inUse }
  }
  const current = (sessions: EngineSessions): EngineConnection => sessions.client(node).connection

  it('uses the newer connection when the older one answers hello last', async () => {
    const { sessions, links } = linked([80, 5])
    await Promise.all(links.map((link) => sessions.attach(link.outbound)))
    expect(current(sessions)).toBe(links[1]!.outbound)
  })

  it('uses the newer connection when it answers hello last', async () => {
    const { sessions, links } = linked([5, 80])
    await Promise.all(links.map((link) => sessions.attach(link.outbound)))
    expect(current(sessions)).toBe(links[1]!.outbound)
  })

  it('moves to a newer connection, and says it is in use once the call on the older one is answered', async () => {
    const { sessions, links, inUse } = linked([5, 5], 300)
    await sessions.attach(links[0]!.outbound)
    const client = sessions.client(node)
    expect(inUse).toEqual([links[0]!.outbound.id])
    const call = client.rpc('net.info', {}, { id: 'rpc_slow' as never, deadlineMs: 5_000 })
    await sessions.attach(links[1]!.outbound)
    // The same client now sends on the newer connection; the call already sent stays on the older one.
    expect(sessions.client(node)).toBe(client)
    expect(client.connection).toBe(links[1]!.outbound)
    expect(inUse).toEqual([links[0]!.outbound.id])
    expect(await call).toEqual({ on: links[0]!.outbound.id })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inUse).toEqual([links[0]!.outbound.id, links[1]!.outbound.id])
  })

  it('keeps the slot when an older connection closes, and hands it back when the newest does', async () => {
    const { sessions, links, ready } = linked([5, 5])
    await Promise.all(links.map((link) => sessions.attach(link.outbound)))
    links[0]!.cut()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(current(sessions)).toBe(links[1]!.outbound)
    links[1]!.cut()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sessions.online(node)).toBe(false)
    expect(ready.at(-1)).toBe(`closed ${node}`)
  })
})

describe('removal rows', () => {
  function store() {
    const dir = mkdtempSync(join(tmpdir(), 'engine-store-'))
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => db.close()
    )
    return { db, peers: new EnginePeerStore(db) }
  }
  const count = (db: NetDatabase, sql: string, ...args: unknown[]) =>
    Number(db.database.prepare(sql).get(...(args as never[]))?.n)

  it('prunes what a removed pairing left in one step and keeps a tombstone the next start sweeps', () => {
    const { db, peers } = store()
    const row = (name: string) =>
      peers.add({
        endpoint: name,
        fingerprint: `sha256:${name}`,
        grant: name,
        name,
        state: 'connected',
        pairedAt: Date.now()
      })
    const gone = row('gone'),
      kept = row('kept')
    const now = Date.now()
    for (const node of [gone.localId, kept.localId]) {
      db.database
        .prepare(
          'INSERT INTO net_node_policy(node,blocked,max_permission_mode,terminal,editor,bots,agent_reach,work,created_at) VALUES(?,0,?,1,0,1,?,1,?)'
        )
        .run(node, 'ask', 'launched', now)
      const stream = newId('stream') as StreamId
      db.database
        .prepare(
          "INSERT INTO net_streams(id,descriptor,space_id,kind,epoch,head,cursor,retained,active_generation) VALUES(?,'{}',NULL,'thread',1,0,0,0,?)"
        )
        .run(stream, `gen-${stream}`)
      db.database
        .prepare(
          "INSERT INTO net_generations(id,stream,state,epoch,through_seq,projection) VALUES(?,?,'active',1,0,0)"
        )
        .run(`gen-${stream}`, stream)
      peers.bind(stream, node)
    }
    peers.update(gone.localId, { state: 'removing' })
    peers.prune(gone.localId)
    expect(peers.get(gone.localId)?.state).toBe('removed')
    expect(count(db, 'SELECT COUNT(*) AS n FROM net_node_policy WHERE node=?', gone.localId)).toBe(
      0
    )
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM net_engine_streams WHERE peer_local_id=?', gone.localId)
    ).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM net_streams')).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS n FROM net_node_policy WHERE node=?', kept.localId)).toBe(
      1
    )
    // A late write of an aborted handler under the tombstoned id goes with the sweep, then the tombstone.
    db.database
      .prepare(
        'INSERT INTO net_node_policy(node,blocked,max_permission_mode,terminal,editor,bots,agent_reach,work,created_at) VALUES(?,0,?,1,0,1,?,1,?)'
      )
      .run(gone.localId, 'ask', 'launched', now)
    expect(peers.sweep()).toEqual([gone.localId])
    expect(peers.get(gone.localId)).toBeUndefined()
    expect(count(db, 'SELECT COUNT(*) AS n FROM net_node_policy WHERE node=?', gone.localId)).toBe(
      0
    )
    expect(peers.get(kept.localId)?.state).toBe('connected')
  })
})

describe('removal racing the pairing', () => {
  it('waits for a grant.add under way, revokes the grant it made, and leaves the row removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-race-'))
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => db.close()
    )
    const peers = new EnginePeerStore(db)
    const endpoint = 'ab'.repeat(32)
    const row = peers.add({
      endpoint,
      fingerprint: 'sha256:x',
      grant: '',
      name: 'Host',
      state: 'joined',
      receipt: 'inv',
      invitation: 'inv',
      pairedAt: Date.now()
    })
    // The helper saves the grant as soon as it reads `grant.add`; its answer comes later.
    const grants = new Map<number, string>()
    let answerGrantAdd = (): void => undefined
    const sent: string[] = []
    const helper = {
      info: {},
      claim: () => undefined,
      dial: async () => undefined,
      request: async (op: string, fields: Record<string, unknown> = {}) => {
        sent.push(op)
        switch (op) {
          case 'grant.add': {
            grants.set(7, String(fields.identity))
            await new Promise<void>((resolve) => (answerGrantAdd = resolve))
            return { grant: 7 }
          }
          case 'grants.list':
            return { grants: [...grants].map(([grant, identity]) => ({ grant, identity, role: 'owner' })) }
          case 'grant.remove':
            return { removed: grants.delete(Number(fields.grant)) }
          default:
            return {}
        }
      }
    }
    const pairing = new EnginePairing({
      peers,
      sessions: { online: () => false } as never,
      helper: () => helper as never,
      teardown: () => undefined,
      changed: () => undefined
    })
    cleanups.push(() => pairing.stop())

    const steps = pairing.advance(row.localId)
    await vi.waitFor(() => expect(sent).toContain('grant.add'))
    const removed = pairing.remove(row.localId)
    expect(peers.get(row.localId)?.state).toBe('removing')
    answerGrantAdd()
    await removed
    await new Promise((resolve) => setImmediate(resolve))

    expect(peers.get(row.localId)?.state).toBe('removed')
    expect([...grants.keys()]).toEqual([])
    // Nothing brings the pairing back at the next start.
    await pairing.reconcileGrants()
    expect(peers.all().filter((r) => r.state !== 'removed')).toEqual([])
    pairing.stop()
    await steps
  })
})

describe('Start over', () => {
  it('sets the engine aside with the network: its devices go, the other computer keeps its row', async () => {
    const fabric = new Fabric()
    cleanups.push(() => fabric.close())
    const owner = await fabric.computer('owner'),
      caller = await fabric.computer('caller')
    const { ownerOnCaller } = await fabric.pair(owner, caller)
    const home = (owner.mms.netEngine as unknown as { options: { profileDir: string } }).options
      .profileDir
    await owner.dispatch('net.startOver', {}, true)
    expect(existsSync(join(home, 'net-engine'))).toBe(false)
    expect(readdirSync(home).some((name) => name.startsWith('net-engine.start-over-'))).toBe(true)
    expect(owner.mms.netEngine.status()).toMatchObject({ enabled: false, on: false, devices: [] })
    // Nothing removes the other side's half (§5.2): it shows the pairing until its owner removes it.
    expect(
      caller.mms.netEngine.peerRows().find((row) => row.localId === ownerOnCaller)?.state
    ).toBe('connected')
  }, 120_000)
})
