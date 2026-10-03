import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { newId, type BlobId } from '../../../src/shared/net'
import type { Mux } from '../../../src/mms/net/contracts'
import { NetSyncSession } from '../../../src/mms/net/sync/session'
import { cleanup, profile } from '../spaces/discovery/profile'

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('keeps a real held snapshot uncertain until its actual source settles while another Space remains usable', async () => {
  const host = profile(), member = profile()
  for (const p of [host, member]) {
    await p.net.request('net.init', { listen: true })
    await p.net.request('net.protect', { passphrase: 'archive-drain-test-protection' })
  }
  const a = host.spaces.host.create({ name: 'Archive selected Space' }), b = host.spaces.host.create({ name: 'Independent Space' })
  const selected = host.spaces.host.createChannel(a.space, 'selected'), unrelated = host.spaces.host.createChannel(b.space, 'unrelated')
  for (const space of [a, b]) {
    await member.spaces.client.join(member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text))
    await member.spaces.client.connect(space.space)
  }
  await member.spaces.client.subscribe(selected)
  const original = member.spaces.client.post(selected, 'original before archive')
  await member.spaces.client.flush(a.space)
  await vi.waitFor(() => expect(member.spaces.store.getById(selected, original)).toBeDefined())
  await member.spaces.client.subscribe(unrelated)
  // Force the actual retention/snapshot path, then hold the actual mux promise
  // even after its AbortSignal fires. No reader/provider settlement is invented.
  vi.spyOn(host.spaces.store, 'snapshotReason').mockImplementationOnce(() => 'cursorTooOld')
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const sources = [...(host.net as unknown as { sessions: Set<NetSyncSession> }).sessions]
  for (const source of sources) {
    const mux = (source as unknown as { mux: Mux }).mux, send = mux.send.bind(mux)
    vi.spyOn(mux, 'send').mockImplementation(async (lane, message, signal) => {
      if (message.header.t === 'snapshot.chunk' && message.header.stream === selected) { entered(); await held }
      return send(lane, message, signal)
    })
  }
  const resubscribe = member.spaces.client.subscribe(selected)
  void resubscribe.catch(() => {})
  await started
  try {
    const draining = host.net.quiesceSpaceStreams(a.space, [a.meta, selected], new AbortController().signal)
    await expect(draining).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(host.net.runtime().db.database.prepare('SELECT 1 AS live').get()).toEqual({ live: 1 })
    const other = member.spaces.client.post(unrelated, 'other Space remains usable')
    await member.spaces.client.flush(b.space)
    expect(member.net.runtime().outbox.get(other)?.state).toBe('sent')
    expect(host.spaces.store.getById(unrelated, other)).toBeDefined()
    release()
    await vi.waitFor(() => expect(sources.flatMap(source => source.archiveTasks(a.space, [a.meta, selected]))).toHaveLength(0))
    await expect(host.net.quiesceSpaceStreams(a.space, [a.meta, selected], new AbortController().signal)).resolves.toBeUndefined()
    expect(host.spaces.store.head(selected).seq).toBe(1)
    expect(sources.some(source => source.state() === 'open')).toBe(true)
  } finally { release() }
}, 15000)

it('refuses an actual unscoped durable upload without cancelling it and permits retry only after it settles', async () => {
  const p = profile(); await p.net.request('net.init', { listen: true })
  const space = p.spaces.host.create({ name: 'Upload boundary' }), channel = p.spaces.host.createChannel(space.space, 'general')
  const bytes = Buffer.from('unscoped local upload'), blob = `blb_${createHash('sha256').update(bytes).digest('hex')}` as BlobId
  const upload = p.net.runtime().blobs.begin(blob, bytes.length, false)
  upload.write(0, bytes)
  await expect(p.net.quiesceSpaceStreams(space.space, [space.meta, channel], new AbortController().signal)).rejects.toMatchObject({ code: 'outcome_uncertain' })
  expect(p.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()?.n).toBe(1)
  upload.abort()
  await expect(p.net.quiesceSpaceStreams(space.space, [space.meta, channel], new AbortController().signal)).resolves.toBeUndefined()
  const other = p.spaces.host.create({ name: 'Other Space' })
  expect(() => p.net.fenceSpaceArchive(space.space, [other.meta])).toThrow(expect.objectContaining({ code: 'forbidden' }))
  // Unknown hidden IDs may deny/cancel only; they never create a descriptor.
  const hidden = newId('stream')
  p.net.fenceSpaceArchive(space.space, [hidden])
  expect(p.spaces.store.getStream(hidden)).toBeUndefined()
  const aborted = new AbortController(); aborted.abort()
  await expect(p.net.quiesceSpaceStreams(space.space, [space.meta, channel], aborted.signal)).rejects.toMatchObject({ code: 'outcome_uncertain' })
})

it.each(['after admission', 'synchronously in handler'])('retains a closed carrier (%s) with an actual RPC that ignores abort until its effect settles', async closeMode => {
  const source = profile(), peer = profile()
  await source.net.request('net.init', { listen: true })
  await source.net.request('net.protect', { passphrase: 'archive-rpc-source-protection' })
  const invite = await source.net.request('bridge.invite', {}) as { invite: string }
  await peer.net.request('bridge.join', { invite: invite.invite })
  const space = source.spaces.host.create({ name: 'Unscoped provider boundary' }), rt = source.net.runtime()
  const carrier = source.net.session(peer.net.runtime().identity.self()!.node) as NetSyncSession
  await vi.waitFor(() => expect(carrier.activeTasks()).toHaveLength(0))
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  rt.db.database.exec('CREATE TABLE archive_drain_witness(value INTEGER NOT NULL)')
  rt.rpc.register({ method: 'test.archiveHeldEffect', capability: 'read', mutating: false, handle: async () => {
    if (closeMode === 'synchronously in handler') source.net.session(peer.net.runtime().identity.self()!.node).close()
    entered(); await held
    rt.db.database.prepare('INSERT INTO archive_drain_witness VALUES(1)').run()
    return { completed: true }
  } })
  const request = peer.net.session(rt.identity.self()!.node).rpc('test.archiveHeldEffect', {}, { id: newId('rpc'), deadlineMs: 15000 })
  void request.catch(() => {})
  await started
  if (closeMode === 'after admission') source.net.session(peer.net.runtime().identity.self()!.node).close()
  try {
    await expect(source.net.quiesceSpaceStreams(space.space, [space.meta], new AbortController().signal)).rejects.toMatchObject({ code: 'outcome_uncertain' })
    await expect(source.net.shutdown()).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(rt.db.database.prepare('SELECT count(*) AS n FROM archive_drain_witness').get()?.n).toBe(0)
    release()
    await vi.waitFor(() => expect(rt.db.database.prepare('SELECT count(*) AS n FROM archive_drain_witness').get()?.n).toBe(1))
    await expect(source.net.shutdown()).resolves.toBeUndefined()
  } finally { release() }
}, 15000)
