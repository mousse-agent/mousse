/**
 * Owner check `phase1b.no-rpc-without-grant`, the app's side (design §6.3, cases 6 and the app half of 4 to 6): what
 * reaches this computer's daemon from a connection is refused unless it carries the pairing's live grant, and a granted
 * device with its editor switch off reaches the editor tunnels and is refused there. Each case is sent at the stream
 * level, as the route probe sends it, over a link attached to the owner's engine service:
 *
 * - a granted device with the editor off opens `mousse.tunnel` with kind `ssh`: it hears `tunnel.close editor_off`,
 *   and no endpoint session starts and no call is authorized;
 * - a stale grant (a pairing re-made, or one the helper should not have let up) opening `mousse.rpc`,
 *   `mousse.hello` or `mousse.tunnel`: each is refused, and nothing is authorized;
 * - a removed identity: its connection is not attached at all.
 *
 * The wire half of every case, on every route, is the engine kit's probe. Its control here: `tunnel-ignores-editor`
 * fails it with `probe_reached_app`. `scripts/net-engine-check.mjs phase1b.no-rpc-without-grant` runs it.
 */
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId, type NodeId } from '../../../src/shared/net'
import type { EditorEndpointPort } from '../../../src/mms/net/editor/endpoint/port'
import type { EngineMessage } from '../../../src/mms/netEngine/session/frame'
import { Channel, type EngineLabel } from '../../../src/mms/netEngine/session/transport'
import { KEY_B } from '../../net/ssh/bed'
import { fakeLink } from '../fakeLink'
import { Fabric, rowFor, step, type Computer } from './harness'

describe('phase1b.no-rpc-without-grant (app)', () => {
  const fabric = new Fabric()
  const served: NodeId[] = []
  const endpoint: EditorEndpointPort = {
    available: () => true,
    hostKeys: () => [KEY_B],
    serve(stream: Duplex, node: NodeId) {
      served.push(node)
      stream.on('error', () => {})
      stream.pipe(stream)
      return { end: () => stream.destroy(), counts: () => ({ exec: 0, shell: 0, sftp: 0, forwards: 0 }) }
    },
    killDevice: async () => undefined,
    sweep: async () => 0
  }
  let owner: Computer
  let caller: Computer
  let onOwner: NodeId
  let authorized: () => number
  beforeAll(async () => {
    owner = await fabric.computer('owner', (mms) => {
      mms.netEngine.editorTest = { endpoint }
    })
    caller = await fabric.computer('caller')
    ;({ callerOnOwner: onOwner } = await fabric.pair(owner, caller))
    // Every call the owner's dispatcher let through the engine's authorization.
    const spy = vi.spyOn(owner.mms.netEngine, 'authorizeEngine')
    authorized = () => spy.mock.results.filter((result) => result.type === 'return').length
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  /** A connection to the owner as the helper would report one up for `node`, under `grant`. */
  function link(node: NodeId, grant: string) {
    const row = owner.mms.netEngine.peerRows().find((entry) => entry.localId === node)!
    const pair = fakeLink({ ownerOnCaller: newId('node') as NodeId, callerOnOwner: node, grant, endpoint: row.endpoint })
    return { ...pair, attached: owner.mms.netEngine.attach(pair.inbound) }
  }
  /** Sends `header` on a new stream and resolves with the first message back, or how the stream ended. */
  function probe(outbound: ReturnType<typeof link>['outbound'], label: EngineLabel, header: EngineMessage['header']) {
    const channel = new Channel(outbound.open(label))
    const answer = new Promise<{ message?: EngineMessage['header']; ended?: string }>((resolve) => {
      channel.onMessage((message) => resolve({ message: message.header }))
      channel.onEnd((reason) => resolve({ ended: reason ?? 'fin' }))
    })
    channel.send(header)
    return answer
  }
  const tunnelOpen = () => ({ t: 'tunnel.open', tunnel: randomBytes(16).toString('hex'), kind: 'ssh' })

  it('a granted device with its editor switch off is refused at the tunnels, and no endpoint session starts', async () => {
    const row = rowFor(owner, caller)!
    expect(owner.mms.netEngine.status().devices.find((device) => device.node === onOwner)).toBeTruthy()
    const before = authorized()
    const { outbound, attached } = link(onOwner, row.grant)
    await attached
    const answer = await step('wire_accepted', async () => {
      const heard = await probe(outbound, 'mousse.tunnel', tunnelOpen())
      return heard
    })
    await step('probe_reached_app', () => {
      expect(served).toEqual([])
      expect(authorized()).toBe(before)
    })
    await step('wire_accepted', () => expect(answer.message).toMatchObject({ t: 'tunnel.close', reason: 'editor_off' }))
  }, 60_000)

  it('a stale grant reaches nothing: mousse.rpc, mousse.hello and mousse.tunnel are each refused', async () => {
    const before = authorized()
    const { outbound, attached } = link(onOwner, 'stale-grant')
    await attached
    const rpc = await probe(outbound, 'mousse.rpc', {
      t: 'call',
      id: newId('rpc'),
      method: 'routed.threads.list',
      params: {},
      deadline: 5_000
    })
    const hello = await probe(outbound, 'mousse.hello', { t: 'hello', proto: 1, name: 'probe' })
    const tunnel = await probe(outbound, 'mousse.tunnel', tunnelOpen())
    await step('wire_accepted', () => {
      expect(rpc.message).toMatchObject({ t: 'error', error: { code: 'forbidden' } })
      expect(hello.message).toMatchObject({ t: 'error', error: { code: 'forbidden' } })
      expect(tunnel.ended).toBe('forbidden')
    })
    await step('probe_reached_app', () => {
      expect(served).toEqual([])
      expect(authorized()).toBe(before)
    })
  }, 60_000)

  it('a removed identity is not attached', async () => {
    const removed = await fabric.computer('removed')
    const { callerOnOwner } = await fabric.pair(owner, removed)
    const row = owner.mms.netEngine.peerRows().find((entry) => entry.localId === callerOnOwner)!
    await owner.dispatch('netEngine.remove', { node: callerOnOwner }, true)
    const pair = fakeLink({
      ownerOnCaller: newId('node') as NodeId,
      callerOnOwner,
      grant: row.grant,
      endpoint: row.endpoint
    })
    const before = authorized()
    await step('probe_reached_app', async () => {
      await expect(owner.mms.netEngine.attach(pair.inbound)).rejects.toMatchObject({ code: 'forbidden' })
      expect(pair.inbound.isOpen()).toBe(false)
      expect(authorized()).toBe(before)
    })
  }, 60_000)
})
