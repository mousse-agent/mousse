import { afterEach, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { cleanup, peer, profile, signed } from '../host/helpers'
import { SpaceArchiveHost } from '../../../../src/mms/spaces/archive/SpaceArchiveHost'
import { readVerifiedSpaceArchive } from '../../../../src/mms/spaces/archive/verify'
import { NetError, newId } from '../../../../src/shared/net'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { SpaceImportStage } from '../../../../src/mms/spaces/archive/ImportStage'

afterEach(cleanup)
async function fixture() {
  const p = await profile(),
    created = p.host.create({ name: 'Archive selected Space' }),
    channel = p.host.createChannel(created.space, 'general')
  p.host.post(channel, 'original signed history')
  const other = p.host.create({ name: 'Unrelated Space' }),
    unrelated = p.host.createChannel(other.space, 'private project')
  p.host.post(unrelated, 'must not export')
  const bridge = newId('stream')
  p.store.createStream(
    { id: bridge, kind: 'node.thread', authority: peer(p).node, createdAt: p.clock.now() },
    1
  )
  p.store.appendAsAuthority(
    bridge,
    signed(p, bridge, 'message.posted', { text: 'Bridge excluded' }, { metaEpoch: 1, metaSeq: 0 })
  )
  const archive = new SpaceArchiveHost({
    host: p.host,
    quiesce: async (space, signal) => {
      signal.throwIfAborted()
      expect(space).toBe(created.space)
      // The fixture owns no jobs; inspect actual ledgers before attesting drain.
      expect(Number(p.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n)).toBe(
        0
      )
      expect(
        Number(
          p.db.database
            .prepare(
              "SELECT count(*) AS n FROM net_executions WHERE state NOT IN ('completed','failed','cancelled')"
            )
            .get()!.n
        )
      ).toBe(0)
    }
  })
  p.host.options.archiveAccess = (space, action) => archive.journal.allows(space, action)
  const freeze = archive.freeze(created.space, 'operator archive')
  return {
    p,
    created,
    channel,
    other,
    bridge,
    archive,
    freeze,
    owner: { user: peer(p).user, rootKey: p.keys.rootKey()! },
    directory: join(p.path, 'archive')
  }
}
it('exports only one frozen Space into a new SQLite allowlist, verifies original history, and keeps unrelated authority intact', async () => {
  const f = await fixture(),
    result = await f.archive.export(f.created.space, f.directory, new AbortController().signal)
  expect(f.archive.journal.forSpace(f.created.space)).toMatchObject({
    state: 'exported',
    digest: result.digest,
    frozen: { epoch: f.freeze.epoch, seq: f.freeze.seq }
  })
  expect(f.p.host.canRead(f.channel, peer(f.p))).toBe(true)
  expect(() => f.p.host.post(f.channel, 'frozen write')).toThrow(
    expect.objectContaining({ code: 'space_frozen' })
  )
  f.p.host.post(
    f.p.store.listStreams({ space: f.other.space, kind: 'space.channel' })[0].id,
    'unrelated remains active'
  )
  const verified = readVerifiedSpaceArchive(f.directory, { owner: f.owner })
  try {
    expect([...verified.streams()].map((s) => s.descriptor.id).sort()).toEqual(
      [f.created.meta, f.channel].sort()
    )
    expect(() => {
      verified.manifest.space = newId('space')
    }).toThrow(TypeError)
    expect(
      [...verified.records(f.channel)].map((r) => decodeEnvelope(r.envelope).envelope.body)
    ).toEqual([{ text: 'original signed history' }])
    expect(JSON.stringify(verified.manifest)).not.toContain(f.bridge)
    const db = new DatabaseSync(join(f.directory, 'space.db'), { readOnly: true })
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name)
    ).toEqual(['records', 'refs', 'rosters', 'streams'])
    db.close()
    expect(f.p.store.getStream(f.bridge)).toBeDefined()
  } finally {
    verified.close()
  }
})
it('copies and verifies referenced stored bytes only, retaining no outbox, invite bearer or decrypted cache', async () => {
  const f = await profile(),
    s = f.host.create({ name: 'Blobs' }),
    c = f.host.createChannel(s.space, 'general'),
    data = Buffer.from('content-addressed attachment'),
    blob = `blb_${createHash('sha256').update(data).digest('hex')}` as const
  const input = signed(
    f,
    c,
    'message.posted',
    { text: 'attached' },
    { metaEpoch: 1, metaSeq: 2 },
    { blobs: [{ id: blob, bytes: data.length, mime: 'text/plain' }] }
  )
  f.host.acceptBlob(c, blob, data.length, false, peer(f))
  const upload = f.blobs.begin(blob, data.length, false)
  upload.write(0, data)
  upload.commit()
  f.host.blobCommitted(c, blob, data.length, false, peer(f))
  f.host.append(c, input.id, input.envelope, input.sig, peer(f))
  const invitation = f.host.invite(s.space)
  const archive = new SpaceArchiveHost({
    host: f.host,
    quiesce: async () => {
      expect(f.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)
    }
  })
  archive.freeze(s.space, 'blob boundary')
  const directory = join(f.path, 'archive')
  await archive.export(s.space, directory, new AbortController().signal)
  const verified = readVerifiedSpaceArchive(directory, {
    owner: { user: peer(f).user, rootKey: f.keys.rootKey()! }
  })
  try {
    expect(verified.readBlob(blob, 0, data.length)).toEqual(data)
    expect([...verified.refs()]).toHaveLength(1)
    expect(readFileSync(join(directory, 'manifest.json'), 'utf8')).not.toContain(invitation.text)
  } finally {
    verified.close()
  }
  writeFileSync(join(directory, 'blobs', blob), 'corrupt attachment')
  expect(() =>
    readVerifiedSpaceArchive(directory, {
      owner: { user: peer(f).user, rootKey: f.keys.rootKey()! }
    })
  ).toThrow()
})
it('keeps an aborted quiescence frozen and cannot use a missing drain callback', async () => {
  const f = await fixture()
  const a = new SpaceArchiveHost({
    host: f.p.host,
    quiesce: async () => {
      throw new NetError('cancelled')
    }
  })
  await expect(
    a.export(f.created.space, f.directory, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'cancelled' })
  expect(a.journal.forSpace(f.created.space)?.state).toBe('failedFrozen')
  expect(f.p.host.canRead(f.channel, peer(f.p))).toBe(true)
  expect(() => new SpaceArchiveHost({ host: f.p.host } as never)).toThrow(
    expect.objectContaining({ code: 'forbidden' })
  )
})
it('fences interrupted export durably after reopening without automatically unfreezing', async () => {
  const f = await fixture()
  const op = f.archive.journal.forSpace(f.created.space)!
  f.archive.journal.transition(op.id, 'frozen', 'exporting')
  f.p.store.close()
  f.p.db.close()
  const p = await profile(f.p.clock, 'Owner', f.p.path),
    a = new SpaceArchiveHost({ host: p.host, quiesce: async () => {} })
  expect(a.journal.forSpace(f.created.space)?.state).toBe('failedFrozen')
  expect(p.projection.position(f.created.space)?.status).toBe('frozen')
  expect(() => p.host.post(f.channel, 'must not resume')).toThrow(
    expect.objectContaining({ code: 'space_frozen' })
  )
})
it('rejects tampered table bytes, extra SQL objects and self-asserted owner trust', async () => {
  const f = await fixture()
  await f.archive.export(f.created.space, f.directory, new AbortController().signal)
  expect(() =>
    readVerifiedSpaceArchive(f.directory, {
      owner: { user: f.owner.user, rootKey: Buffer.alloc(32).toString('base64url') }
    })
  ).toThrow(expect.objectContaining({ code: 'forbidden' }))
  const original = join(f.p.path, 'original.db')
  copyFileSync(join(f.directory, 'space.db'), original)
  let db = new DatabaseSync(join(f.directory, 'space.db'))
  db.prepare('UPDATE records SET sig=? WHERE stream=?').run(Buffer.alloc(64), f.channel)
  db.close()
  expect(() => readVerifiedSpaceArchive(f.directory, { owner: f.owner })).toThrow(
    expect.objectContaining({ code: 'bad_request' })
  )
  copyFileSync(original, join(f.directory, 'space.db'))
  db = new DatabaseSync(join(f.directory, 'space.db'))
  db.exec('CREATE TABLE credentials(secret TEXT)')
  db.close()
  expect(() => readVerifiedSpaceArchive(f.directory, { owner: f.owner })).toThrow(
    expect.objectContaining({ code: 'bad_request' })
  )
})
it('does not overwrite an existing archive or unfreeze on filesystem failure', async () => {
  const f = await fixture()
  mkdirSync(f.directory)
  writeFileSync(join(f.directory, 'operator.txt'), 'preserve')
  await expect(
    f.archive.export(f.created.space, f.directory, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(readFileSync(join(f.directory, 'operator.txt'), 'utf8')).toBe('preserve')
  expect(f.archive.journal.forSpace(f.created.space)?.state).toBe('failedFrozen')
})
it('rejects a correctly signed meta history that replayed with an authorization violation', async () => {
  const p = await profile(),
    space = p.host.create({ name: 'Invalid history' }),
    input = signed(
      p,
      space.meta,
      'member.joined',
      {
        member: {
          user: peer(p).user,
          rootKey: p.keys.rootKey()!,
          role: 'owner',
          displayName: 'Second owner'
        }
      },
      { metaEpoch: 1, metaSeq: 1 }
    )
  const out = p.store.appendAsAuthority(space.meta, input)
  p.projection.applyRecord(p.store.getStream(space.meta)!, { ...input, ...out }, 'history')
  expect(p.projection.violations(space.space)).toHaveLength(1)
  const archive = new SpaceArchiveHost({
    host: p.host,
    quiesce: async () => {
      expect(p.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)
    }
  })
  archive.freeze(space.space, 'replay boundary')
  await expect(
    archive.export(space.space, join(p.path, 'invalid-archive'), new AbortController().signal)
  ).rejects.toMatchObject({ code: 'forbidden' })
  expect(archive.journal.forSpace(space.space)?.state).toBe('failedFrozen')
})
it('verifies the real 128-stream export boundary including a signature wrapper above 64KiB and rejects it before import mutation', async () => {
  const p = await profile(),
    space = p.host.create({ name: 'Bounded export' })
  for (let i = 0; i < 127; i++) {
    p.clock.advance(11000)
    p.host.createChannel(space.space, `channel-${i}`)
  }
  const archive = new SpaceArchiveHost({
    host: p.host,
    quiesce: async () => {
      expect(p.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)
    }
  })
  archive.freeze(space.space, 'export cap')
  const directory = join(p.path, '128-streams')
  await archive.export(space.space, directory, new AbortController().signal)
  expect(statSync(join(directory, 'manifest.json')).size).toBeGreaterThan(64 * 1024)
  const verified = readVerifiedSpaceArchive(directory, {
    owner: { user: peer(p).user, rootKey: p.keys.rootKey()! }
  })
  try {
    expect([...verified.streams()]).toHaveLength(128)
    const before = p.db.database.prepare('SELECT count(*) AS n FROM net_generations').get()!.n
    expect(() => SpaceImportStage.prepare(p.db, verified, 'over-import-cap', 'restore')).toThrow(
      expect.objectContaining({ code: 'too_large' })
    )
    expect(p.db.database.prepare('SELECT count(*) AS n FROM net_generations').get()!.n).toBe(before)
    expect(
      p.db.database.prepare('SELECT count(*) AS n FROM net_space_archive_hidden').get()!.n
    ).toBe(0)
  } finally {
    verified.close()
  }
})
