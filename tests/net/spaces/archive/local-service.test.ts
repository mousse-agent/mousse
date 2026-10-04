import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../../../src/mms/protocol/server'
import { LocalMmsClient } from '../../../../src/mms/protocol/client'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { NetError } from '../../../../src/shared/net'
it('operates real protected private/public archives through owner-bound IPC and retains unsupported or unscoped work safely', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archive-owner-ipc-'))),
    home = join(root, 'home'),
    main = await MousseMainService.create({
      homeDir: home,
      repoRoot: root,
      headless: true,
      requireOwnership: false
    }),
    host = main.getInstallationHost()!,
    owner = host.getDefaultProfileId(),
    other = host.manager.create({ displayName: 'Other', slug: 'other' }).id,
    server = new MmsProtocolServer({ mms: main, ownerToken: 'task-owned-archive-owner' }),
    endpoint = await server.start()
  const make = (token = 'task-owned-archive-owner') =>
      new LocalMmsClient({
        homeDir: home,
        endpoint,
        ownerToken: token,
        requestedCapabilities: ['profiles-v1']
      }),
    a = make(),
    b = make(),
    unbound = make(),
    wrong = make('not-owner')
  try {
    await Promise.all([a.connect(), b.connect(), unbound.connect()])
    await expect(wrong.connect()).rejects.toThrow()
    await expect(unbound.request('spaces.archive.status', {})).rejects.toMatchObject({
      code: 'profile_binding_required'
    })
    await a.request('profiles.bind', { profile: owner })
    await b.request('profiles.bind', { profile: other })
    await a.request('net.init', { listen: true, port: 0 })
    await a.request('net.protect', { passphrase: 'task-owned-archive-ipc' })
    const services = await main.getProfileServices(owner),
      spaces = services.spaces,
      rt = services.net.runtime(),
      self = rt.identity.self()!,
      space = spaces.host.create({ name: 'Real archive IPC' }),
      channel = spaces.host.createChannel(space.space, 'general'),
      keep = spaces.host.create({ name: 'Unrelated' }),
      keepChannel = spaces.host.createChannel(keep.space, 'keep')
    const publicEvent = spaces.host.post(channel, 'Original public history'),
      publicId = decodeEnvelope(
        spaces.store.read(
          channel,
          { epoch: publicEvent.epoch, seq: publicEvent.seq - 1 },
          publicEvent.seq,
          65536
        ).records[0].envelope
      ).envelope.id,
      privateCreation = spaces.private.prepareCreation(space.space, channel, [self.user])
    await spaces.private.publishCreation(privateCreation.descriptor.id)
    const privateStream = privateCreation.descriptor.id,
      old = spaces.private.state(privateStream)!.control,
      event = spaces.private.seal(privateStream, 'message.posted', {
        text: 'Original sealed history'
      })
    await spaces.append(privateStream, event.id, event.envelope, event.sig)
    await vi.waitFor(() => expect(services.net.getActiveCount()).toBe(0))
    await expect(a.request('spaces.archive.status', { profileId: other })).rejects.toMatchObject({
      code: 'profile_mismatch'
    })
    await expect(a.request('spaces.archive.status', { profileId: owner })).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(
      a.request('spaces.archive.freeze', { space: space.space, reason: 'cut', quiesced: true })
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      a.request('spaces.archive.import', { path: root, mode: 'restore', privateKey: 'no' })
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(b.request('spaces.archive.status', {})).rejects.toMatchObject({ code: 'disabled' })
    await b.request('net.init', {})
    await b.request('net.protect', { passphrase: 'task-owned-other-archive-ipc' })
    expect(await b.request('spaces.archive.status', {})).toEqual({ operations: [] })
    // The opted-in authority has its own store; the other profile's Space is unknown.
    await expect(
      b.request('spaces.archive.freeze', { space: space.space, reason: 'Wrong profile' })
    ).rejects.toMatchObject({ code: 'stream_unknown' })
    const frozen = await a.request<any>('spaces.archive.freeze', {
      space: space.space,
      reason: 'Owner cut'
    })
    expect(frozen.state).toBe('frozen')
    expect(
      (await a.request<any>('spaces.post', { stream: keepChannel, text: 'Keep writable' })).state
    ).toBe('sent')
    await expect(
      a.request('spaces.post', { stream: channel, text: 'Fenced' })
    ).rejects.toMatchObject({ code: 'space_frozen' })
    const upload = rt.blobs.begin(`blb_${'a'.repeat(64)}`, 1, false)
    await expect(
      a.request('spaces.archive.export', { space: space.space, path: join(root, 'archive') })
    ).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(
      (await a.request<any>('spaces.archive.status', { space: space.space })).operation.state
    ).toBe('failedFrozen')
    expect(spaces.store.getById(privateStream, event.id)).toBeDefined()
    upload.abort()
    const exported = await a.request<any>('spaces.archive.export', {
      space: space.space,
      path: join(root, 'archive')
    })
    expect(exported.state).toBe('exported')
    expect(
      await a.request('spaces.archive.export', { space: space.space, path: join(root, 'archive') })
    ).toEqual(exported)
    const imported = await a.request<any>('spaces.archive.import', {
      path: join(root, 'archive'),
      mode: 'restore'
    })
    expect(imported.state).toBe('importedFrozen')
    expect(
      await a.request('spaces.archive.import', { path: join(root, 'archive'), mode: 'restore' })
    ).toEqual(imported)
    const fault = vi.spyOn(rt.db, 'checkpoint').mockImplementation((point) => {
      if (point === 'spaces.archive.activation.beforeCommit') throw new NetError('cancelled')
    })
    await expect(
      a.request('spaces.archive.activate', { space: space.space })
    ).rejects.toMatchObject({ code: 'cancelled' })
    fault.mockRestore()
    expect(
      (await a.request<any>('spaces.archive.status', { space: space.space })).operation.state
    ).toBe('importedFrozen')
    const activated = await a.request<any>('spaces.archive.activate', { space: space.space })
    expect(activated).toMatchObject({ state: 'activeNew', epoch: 2 })
    expect(await a.request('spaces.archive.activate', { space: space.space })).toEqual(activated)
    expect(spaces.store.getById(channel, publicId)).toBeDefined()
    expect(spaces.store.getById(privateStream, event.id)).toMatchObject({ epoch: 1 })
    const control = spaces.store.read(privateStream, { epoch: 2, seq: 0 }, 1, 65536).records[0],
      fresh = decodeEnvelope(control.envelope).envelope.body as typeof old
    expect(fresh.keyEpoch).toBe(2)
    expect(
      fresh.writers.every((w) =>
        old.writers.every((before) => before.noncePrefix !== w.noncePrefix)
      )
    ).toBe(true)
    const posted = await a.request<any>('spaces.post', {
      stream: channel,
      text: 'After real archive activation'
    })
    expect(posted).toMatchObject({ state: 'sent', position: { epoch: 2, seq: 1 } })
    const freshSealed = spaces.private.seal(privateStream, 'message.posted', {
      text: 'Fresh actual private key'
    })
    await spaces.append(privateStream, freshSealed.id, freshSealed.envelope, freshSealed.sig)
    expect(
      spaces.private.open(privateStream, spaces.store.getById(privateStream, freshSealed.id)!)
    ).toEqual({ text: 'Fresh actual private key' })
    expect(spaces.canStartSpaceWork(keep.space)).toBe(true)
  } finally {
    await Promise.all([a.close(), b.close(), unbound.close(), wrong.close()])
    await server.stop()
    await main.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)

it('refuses a globally pinned foreign private recipient without a trusted archive current-proof port', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archive-foreign-recipient-'))),
    owner = await MousseMainService.create({
      homeDir: join(root, 'owner'),
      repoRoot: root,
      headless: true,
      requireOwnership: false
    }),
    member = await MousseMainService.create({
      homeDir: join(root, 'member'),
      repoRoot: root,
      headless: true,
      requireOwnership: false
    })
  try {
    for (const main of [owner, member]) {
      await main.net.request('net.init', { listen: true, port: 0 })
      await main.net.request('net.protect', { passphrase: 'task-owned-foreign-private' })
    }
    const rt = owner.net.runtime(),
      foreign = member.net.runtime(),
      self = rt.identity.self()!,
      other = foreign.identity.self()!,
      spaces = owner.spaces,
      space = spaces.host.create({ name: 'Foreign archive recipient' }),
      channel = spaces.host.createChannel(space.space, 'general')
    await member.spaces.client.join(
      member.spaces.client.prepareJoin(spaces.host.invite(space.space).text)
    )
    await member.spaces.client.connect(space.space)
    rt.identity.pinUser(other.user, foreign.keys.rootKey()!)
    rt.identity.acceptRoster(foreign.identity.roster()!, foreign.keys.rootKey()!)
    const privateCreation = spaces.private.prepareCreation(space.space, channel, [
      self.user,
      other.user
    ])
    await spaces.private.publishCreation(privateCreation.descriptor.id)
    const sealed = spaces.private.seal(privateCreation.descriptor.id, 'message.posted', {
      text: 'Original authenticated private body'
    })
    await spaces.append(privateCreation.descriptor.id, sealed.id, sealed.envelope, sealed.sig)
    await member.stop()
    await vi.waitFor(() => expect(owner.net.getActiveCount()).toBe(0))
    const archive = owner.bridge.archives
    await archive.request('spaces.archive.freeze', {
      space: space.space,
      reason: 'Foreign recipient unsupported cut'
    })
    await archive.request('spaces.archive.export', {
      space: space.space,
      path: join(root, 'archive')
    })
    await archive.request('spaces.archive.import', { path: join(root, 'archive'), mode: 'restore' })
    await expect(
      archive.request('spaces.archive.activate', { space: space.space })
    ).rejects.toMatchObject({ code: 'profile_unsupported' })
    expect(archive.journal.forSpace(space.space)?.state).toBe('importedFrozen')
    expect(spaces.meta.position(space.space)).toMatchObject({ status: 'frozen', epoch: 1 })
    expect(rt.keys.getSecret(`private/${privateCreation.descriptor.id}/2`)).toBeUndefined()
    expect(spaces.store.getById(privateCreation.descriptor.id, sealed.id)).toBeDefined()
    expect(rt.identity.roster(other.user)).toBeDefined()
  } finally {
    await member.stop()
    await owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 25000)

it('bounds an ignored-abort selected publication without claiming it settled or exposing a successful archive', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archive-publication-bound-'))),
    main = await MousseMainService.create({
      homeDir: join(root, 'home'),
      repoRoot: root,
      headless: true,
      requireOwnership: false
    })
  let release!: () => void
  try {
    await main.net.request('net.init', { listen: true, port: 0 })
    await main.net.request('net.protect', { passphrase: 'task-owned-publication-bound' })
    const space = main.spaces.host.create({ name: 'Selected unfinished publication' }),
      channel = main.spaces.host.createChannel(space.space, 'general')
    await vi.waitFor(() => expect(main.net.getActiveCount()).toBe(0))
    const held = new Promise<void>((resolve) => {
        release = resolve
      }),
      original = main.net.publish.bind(main.net)
    let settled = false
    vi.spyOn(main.net, 'publish').mockImplementationOnce(async () => {
      await held
      settled = true
    })
    main.spaces.host.post(channel, 'Actual committed publication task')
    expect(main.net.getActiveCount()).toBeGreaterThan(0)
    await main.bridge.archives.request('spaces.archive.freeze', {
      space: space.space,
      reason: 'Bound unfinished publication'
    })
    await expect(
      main.bridge.archives.request('spaces.archive.export', {
        space: space.space,
        path: join(root, 'not-published')
      })
    ).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(settled).toBe(false)
    expect(main.bridge.archives.journal.forSpace(space.space)?.state).toBe('failedFrozen')
    expect(main.spaces.store.head(channel).seq).toBe(1)
    release()
    await vi.waitFor(() => expect(settled).toBe(true))
    vi.spyOn(main.net, 'publish').mockImplementation(original)
    expect(
      await main.bridge.archives.request('spaces.archive.export', {
        space: space.space,
        path: join(root, 'published')
      })
    ).toMatchObject({ state: 'exported' })
  } finally {
    release?.()
    await main.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)

it('cancels an actual abort-aware TLS publication before waiting for the composed Space task', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archive-tls-publication-'))),
    owner = await MousseMainService.create({
      homeDir: join(root, 'owner'),
      repoRoot: root,
      headless: true,
      requireOwnership: false
    }),
    member = await MousseMainService.create({
      homeDir: join(root, 'member'),
      repoRoot: root,
      headless: true,
      requireOwnership: false
    })
  try {
    for (const main of [owner, member]) {
      await main.net.request('net.init', { listen: true, port: 0 })
      await main.net.request('net.protect', { passphrase: 'task-owned-tls-publication' })
    }
    const space = owner.spaces.host.create({ name: 'Actual TLS publication drain' }),
      channel = owner.spaces.host.createChannel(space.space, 'general')
    await member.spaces.client.join(
      member.spaces.client.prepareJoin(owner.spaces.host.invite(space.space).text)
    )
    await member.spaces.client.connect(space.space)
    await member.spaces.client.subscribe(channel)
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let aborted = false
    const sessions = [
      ...(
        owner.net as unknown as {
          sessions: Set<import('../../../../src/mms/net/sync/session').NetSyncSession>
        }
      ).sessions
    ]
    for (const session of sessions) {
      const mux = (session as unknown as { mux: import('../../../../src/mms/net/contracts').Mux })
          .mux,
        send = mux.send.bind(mux)
      vi.spyOn(mux, 'send').mockImplementation(async (lane, message, signal) => {
        if (message.header.t === 'events' && message.header.stream === channel) {
          entered()
          await new Promise<void>((_resolve, reject) => {
            const stop = () => {
              aborted = true
              reject(new NetError('cancelled'))
            }
            if (signal?.aborted) stop()
            else signal?.addEventListener('abort', stop, { once: true })
          })
        }
        return send(lane, message, signal)
      })
    }
    owner.spaces.host.post(channel, 'Owned queued TLS publication')
    await started
    await owner.bridge.archives.request('spaces.archive.freeze', {
      space: space.space,
      reason: 'Cancel source before task wait'
    })
    expect(
      await owner.bridge.archives.request('spaces.archive.export', {
        space: space.space,
        path: join(root, 'archive')
      })
    ).toMatchObject({ state: 'exported' })
    expect(aborted).toBe(true)
    expect(owner.net.runtime().db.database.prepare('SELECT 1 AS live').get()).toEqual({ live: 1 })
  } finally {
    await member.stop()
    await owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
