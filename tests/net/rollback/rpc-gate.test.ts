import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import type { SyncSession } from '../../../src/mms/net/contracts'
import { encodeEnvelope } from '../../../src/mms/net/sync/codec'
import { newId, type StreamDescriptor } from '../../../src/shared/net'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-rpc-gate-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const create = (name: string) =>
    MousseMainService.create({
      homeDir: join(root, name),
      repoRoot: root,
      headless: true,
      requireOwnership: false
    })
  let target = await create('target')
  cleanup.push(() => target.stop())
  const caller = await create('caller')
  cleanup.push(() => caller.stop())
  await target.net.request('net.init', { listen: true })
  await target.net.request('net.protect', { passphrase: 'rpc-gate-target' })
  const invite = (await target.net.request('bridge.invite', {})) as { invite: string }
  await caller.net.request('bridge.join', { invite: invite.invite })
  await caller.net.request('net.protect', { passphrase: 'rpc-gate-caller' })
  const node = target.net.runtime().identity.self()!.node
  await vi.waitFor(() => expect(caller.net.session(node).state()).toBe('open'))
  const session = caller.net.session(node),
    thread = target.threads.createThread('Retained Bridge result'),
    id = newId('rpc')
  const result = await session.rpc('threads.get', { threadId: thread.id }, { id, deadlineMs: 5000 })
  expect(await session.rpcResult(id, { deadlineMs: 5000 })).toEqual(result)
  await target.net
    .runtime()
    .rpc.cancel(id, target.net.session(caller.net.runtime().identity.self()!.node).peer)
  const artifact = (await session.rpc(
    'bridge.artifacts.open',
    { forRpcId: newId('rpc'), forMethod: 'bridge.dispatch' },
    { id: newId('rpc'), idem: 'enabled-artifact', deadlineMs: 5000 }
  )) as StreamDescriptor
  expect(artifact.kind).toBe('node.artifact')
  const space = await target.spaces.local.request('spaces.create', { name: 'Independent Spaces' })

  const restart = async (feature: 'netBridge' | 'netSpaces') => {
    const db = target.net.runtime().db,
      config = JSON.parse(
        db.database.prepare('SELECT value FROM net_service_config').get()!.value as string
      )
    config.features[feature] = false
    db.transaction(() => {
      db.charge(1)
      db.database.prepare('UPDATE net_service_config SET value=?').run(JSON.stringify(config))
    })
    await target.stop()
    target = await create('target')
    await target.net.start()
    await target.net.request('net.unlock', { passphrase: 'rpc-gate-target' })
    expect(target.net.status()).toMatchObject({ enabled: true, features: config.features })
    const rt = target.net.runtime(),
      self = rt.identity.self()!
    const connection = await caller.net.connectDomainSession(
      { ...self, transportKey: rt.keys.nodeKeys().transport, routes: target.net.status().routes },
      new AbortController().signal
    )
    return connection
  }

  const postSpace = async (connection: SyncSession) => {
    const rt = caller.net.runtime(),
      self = rt.identity.self()!,
      head = target.spaces.meta.position(space.space)!,
      event = newId('event')
    const envelope = encodeEnvelope({
      v: 1,
      minor: 0,
      id: event,
      stream: space.channel,
      type: 'message.posted',
      crit: false,
      author: {
        user: self.user,
        node: self.node,
        keyEpoch: target.net.session(self.node).peer.delegation.keyEpoch
      },
      ts: Date.now(),
      auth: { metaEpoch: head.epoch, metaSeq: head.seq },
      body: { text: 'Spaces on the same session after Bridge denial' }
    })
    const receipt = await connection.append(
      space.channel,
      event,
      envelope,
      rt.keys.signAsNode(envelope)
    )
    expect(target.spaces.store.getById(space.channel, event)).toMatchObject(receipt)
    expect(connection.state()).toBe('open')
  }
  return { target: () => target, caller, id, result, artifact, restart, postSpace }
}

it.each(['result', 'artifact', 'cancel'] as const)(
  'rejects disabled Bridge %s after a composed profile restart and keeps Spaces on the same TLS session',
  async (path) => {
    const f = await fixture(),
      session = await f.restart('netBridge'),
      target = f.target(),
      rt = target.net.runtime()
    // The original DTO is not retained in the alias table and is not needed by policy.
    const before = rt.db.database.prepare('SELECT * FROM net_rpc_aliases ORDER BY caller,id').all()
    if (path === 'result') {
      await expect(session.rpcResult(f.id, { deadlineMs: 5000 })).rejects.toMatchObject({
        code: 'disabled'
      })
    } else if (path === 'artifact') {
      const peer = target.net.session(f.caller.net.runtime().identity.self()!.node).peer
      expect(() => rt.rpc.authorizedMethod('bridge.dispatch', peer)).toThrow(
        expect.objectContaining({ code: 'disabled' })
      )
      const streams = rt.streams.listStreams(),
        bindings = rt.db.database
          .prepare('SELECT * FROM net_bridge_artifacts ORDER BY stream')
          .all(),
        executions = rt.db.database.prepare('SELECT * FROM net_executions ORDER BY id').all()
      await expect(
        session.rpc(
          'bridge.artifacts.open',
          { forRpcId: newId('rpc'), forMethod: 'bridge.dispatch' },
          { id: newId('rpc'), idem: 'disabled-artifact', deadlineMs: 5000 }
        )
      ).rejects.toMatchObject({ code: 'disabled' })
      expect(rt.streams.listStreams()).toEqual(streams)
      expect(
        rt.db.database.prepare('SELECT * FROM net_bridge_artifacts ORDER BY stream').all()
      ).toEqual(bindings)
      expect(rt.db.database.prepare('SELECT * FROM net_executions ORDER BY id').all()).toEqual(
        executions
      )
    } else {
      const peer = target.net.session(f.caller.net.runtime().identity.self()!.node).peer
      await expect(rt.rpc.cancel(f.id, peer)).rejects.toMatchObject({ code: 'disabled' })
      const cancel = vi.spyOn(rt.rpc, 'cancel')
      await session.rpcCancel(f.id)
      await vi.waitFor(() =>
        expect(cancel).toHaveBeenCalledWith(f.id, expect.objectContaining({ node: peer.node }))
      )
      await expect(cancel.mock.results[0].value).rejects.toMatchObject({ code: 'disabled' })
    }
    expect(
      rt.db.database.prepare('SELECT * FROM net_rpc_aliases ORDER BY caller,id').all()
    ).toEqual(before)
    await f.postSpace(session)
    // Shared Net RPC is still useful on a Spaces-only session.
    expect(
      await session.rpc('authority.transfer.ready', {}, { id: newId('rpc'), deadlineMs: 5000 })
    ).toMatchObject({ protected: true, unlocked: true })
  },
  20000
)

it('checks the upload target family independently while Bridge stays enabled and Spaces is disabled', async () => {
  const f = await fixture(),
    session = await f.restart('netSpaces'),
    rt = f.target().net.runtime()
  expect(await session.rpcResult(f.id, { deadlineMs: 5000 })).toEqual(f.result)
  expect(
    await session.rpc('threads.list', {}, { id: newId('rpc'), deadlineMs: 5000 })
  ).toHaveProperty('threads')
  await rt.rpc.cancel(
    f.id,
    f.target().net.session(f.caller.net.runtime().identity.self()!.node).peer
  )
  expect(
    await session.rpc(
      'bridge.artifacts.open',
      { forRpcId: newId('rpc'), forMethod: 'bridge.dispatch' },
      { id: newId('rpc'), idem: 'bridge-only-artifact', deadlineMs: 5000 }
    )
  ).toMatchObject({
    kind: 'node.artifact',
    artifact: { method: 'bridge.dispatch', capability: 'write' }
  })

  // A registered upload method can belong to a different family than the artifact gateway.
  rt.rpc.register({
    method: 'fixture.space.upload',
    family: 'spaces',
    capability: 'write',
    mutating: true,
    uploadEnabled: true,
    handle: async () => null
  })
  const streams = rt.streams.listStreams(),
    bindings = rt.db.database.prepare('SELECT * FROM net_bridge_artifacts ORDER BY stream').all(),
    aliases = rt.db.database.prepare('SELECT * FROM net_rpc_aliases ORDER BY caller,id').all(),
    executions = rt.db.database.prepare('SELECT * FROM net_executions ORDER BY id').all()
  await expect(
    session.rpc(
      'bridge.artifacts.open',
      { forRpcId: newId('rpc'), forMethod: 'fixture.space.upload' },
      { id: newId('rpc'), idem: 'disabled-space-artifact', deadlineMs: 5000 }
    )
  ).rejects.toMatchObject({ code: 'disabled' })
  expect(rt.streams.listStreams()).toEqual(streams)
  expect(
    rt.db.database.prepare('SELECT * FROM net_bridge_artifacts ORDER BY stream').all()
  ).toEqual(bindings)
  expect(rt.db.database.prepare('SELECT * FROM net_rpc_aliases ORDER BY caller,id').all()).toEqual(
    aliases
  )
  expect(rt.db.database.prepare('SELECT * FROM net_executions ORDER BY id').all()).toEqual(
    executions
  )
  expect(session.state()).toBe('open')
}, 20000)
