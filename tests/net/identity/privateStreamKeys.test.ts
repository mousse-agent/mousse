import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore, SqlPrivateStreamKeys } from '../../../src/mms/net/identity'
import { canonicalJson } from '../../../src/mms/net/sync/codec'
import { newId } from '../../../src/shared/net/ids'
import type { Envelope, NodeId, SpaceId, StreamId, UserId } from '../../../src/shared/net'
import type { KeyStore, PrivateStreamKeys } from '../../../src/mms/net/contracts'
import fixture from '../../../test-vectors/net/security/private-crypto.json'

type Control = NonNullable<Envelope<'participants.changed'>['body']>
const directories: string[] = [],
  databases: DatabaseSync[] = []
async function participant(user = newId('user'), space = newId('space')) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-private-')))
  directories.push(dir)
  const keys = new FileKeyStore(dir)
  await keys.initialize({ asAuthority: false })
  const db = new DatabaseSync(join(dir, 'net', 'net.db'))
  databases.push(db)
  db.exec('PRAGMA journal_mode=WAL')
  const node = newId('node'),
    privateKeys = new SqlPrivateStreamKeys({
      database: db,
      keys,
      node,
      user,
      spaceForStream: () => space
    })
  return { dir, keys, db, node, user, privateKeys, space }
}
afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close()
    } catch {
      /* Closed in restart scenario. */
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function aad(stream: StreamId, node: NodeId, user: UserId): Buffer {
  return Buffer.concat([
    Buffer.from('mousse-net/private-content/v1\0'),
    canonicalJson({
      v: 1,
      minor: 0,
      id: newId('event'),
      stream,
      type: 'message.posted',
      crit: false,
      author: { user, node, keyEpoch: 1 },
      ts: 1000,
      auth: { metaEpoch: 1, metaSeq: 1 }
    })
  ])
}

describe('PrivateStreamKeys real storage and crypto', () => {
  it('adopts signed-controller-validated rotation before sealing, encrypts for two nodes and survives reopening', async () => {
    const a = await participant(),
      b = await participant(newId('user'), a.space),
      stream = newId('stream')
    const body = a.privateKeys.rotate(
      stream,
      [
        { node: a.node, agree: a.keys.nodeKeys().agree },
        { node: b.node, agree: b.keys.nodeKeys().agree }
      ],
      { controller: a.user, participants: [a.user, b.user], visibilityEpoch: 1 }
    )!
    const bound = aad(stream, a.node, a.user),
      text = Buffer.from('private body canary')
    expect(() => a.privateKeys.seal(stream, text, bound)).toThrow(
      expect.objectContaining({ code: 'meta_stale' })
    )
    const normalized = JSON.parse(Buffer.from(canonicalJson(body)).toString()) as Control
    a.privateKeys.accept(stream, normalized)
    b.privateKeys.accept(stream, normalized)
    const sealed = a.privateKeys.seal(stream, text, bound)
    expect(Buffer.from(b.privateKeys.open(stream, sealed, bound))).toEqual(text)
    const blob = a.privateKeys.sealBlob(stream, Buffer.from('private attachment canary'))
    expect(Buffer.from(blob.bytes).toString()).not.toContain('private attachment canary')
    expect(Buffer.from(b.privateKeys.openBlob(stream, blob.keyEpoch, blob.bytes)).toString()).toBe(
      'private attachment canary'
    )
    expect(Buffer.from(sealed.nonce, 'base64url').readBigUInt64BE(4)).toBe(1n)
    expect(Buffer.from(blob.bytes).readBigUInt64BE(13)).toBe(2n)
    a.db.close()
    const db = new DatabaseSync(join(a.dir, 'net', 'net.db'))
    databases.push(db)
    const reopened = new SqlPrivateStreamKeys({
      database: db,
      keys: new FileKeyStore(a.dir),
      node: a.node,
      user: a.user,
      spaceForStream: () => a.space
    })
    expect(
      Buffer.from(reopened.seal(stream, text, bound).nonce, 'base64url').readBigUInt64BE(4)
    ).toBe(3n)
  })

  it('recovers the exact prepared rotation after restart before control adoption', async () => {
    const a = await participant(),
      stream = newId('stream')
    const prepared = a.privateKeys.rotate(
      stream,
      [{ node: a.node, agree: a.keys.nodeKeys().agree }],
      { controller: a.user, participants: [a.user], visibilityEpoch: 1 }
    )
    a.db.close()
    const db = new DatabaseSync(join(a.dir, 'net', 'net.db'))
    databases.push(db)
    const recovered = new SqlPrivateStreamKeys({
      database: db,
      keys: new FileKeyStore(a.dir),
      node: a.node,
      user: a.user,
      spaceForStream: () => a.space
    })
    expect(recovered.preparedRotation(stream)).toEqual(prepared)
    expect(() =>
      recovered.seal(stream, Buffer.from('unpublished'), aad(stream, a.node, a.user))
    ).toThrow(expect.objectContaining({ code: 'meta_stale' }))
    recovered.accept(stream, recovered.preparedRotation(stream)!)
    expect(recovered.preparedRotation(stream)).toBeUndefined()
    expect(
      recovered.seal(stream, Buffer.from('committed'), aad(stream, a.node, a.user)).keyEpoch
    ).toBe(1)
  })

  it('rotates future keys after participant removal while old recipient retains old historical plaintext', async () => {
    const a = await participant(),
      b = await participant(newId('user'), a.space),
      stream = newId('stream'),
      bound = aad(stream, a.node, a.user)
    const first = a.privateKeys.rotate(
      stream,
      [
        { node: a.node, agree: a.keys.nodeKeys().agree },
        { node: b.node, agree: b.keys.nodeKeys().agree }
      ],
      { controller: a.user, participants: [a.user, b.user], visibilityEpoch: 1 }
    )!
    a.privateKeys.accept(stream, first)
    b.privateKeys.accept(stream, first)
    const old = a.privateKeys.seal(stream, Buffer.from('old secret'), bound)
    const next = a.privateKeys.rotate(stream, [{ node: a.node, agree: a.keys.nodeKeys().agree }], {
      controller: a.user,
      participants: [a.user],
      visibilityEpoch: 2
    })!
    a.privateKeys.accept(stream, next)
    b.privateKeys.accept(stream, next)
    expect(next).toMatchObject({ keyEpoch: 2, visibilityEpoch: 2 })
    const current = a.privateKeys.seal(stream, Buffer.from('future secret'), bound)
    expect(() => b.privateKeys.open(stream, current, bound)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(Buffer.from(b.privateKeys.open(stream, old, bound)).toString()).toBe('old secret')
    expect(() =>
      b.privateKeys.seal(stream, Buffer.from('unauthorized'), aad(stream, b.node, b.user))
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
  })

  it('node-only rotation keeps visibility and rejects changed wrapped contexts before adoption', async () => {
    const a = await participant(),
      b = await participant(newId('user'), a.space),
      stream = newId('stream')
    const body = a.privateKeys.rotate(
      stream,
      [
        { node: a.node, agree: a.keys.nodeKeys().agree },
        { node: b.node, agree: b.keys.nodeKeys().agree }
      ],
      { controller: a.user, participants: [a.user, b.user], visibilityEpoch: 1 }
    )!
    a.privateKeys.accept(stream, body)
    const tampered = structuredClone(body)
    tampered.wrapped.find((row) => row.node === b.node)!.ephemeral = a.keys.nodeKeys().agree
    expect(() => b.privateKeys.accept(stream, tampered)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(b.db.prepare('SELECT COUNT(*) AS count FROM net_private_control').get()!.count).toBe(0)
    b.privateKeys.accept(stream, body)
    const next = a.privateKeys.rotate(stream, [{ node: a.node, agree: a.keys.nodeKeys().agree }], {
      controller: a.user,
      participants: [a.user, b.user],
      visibilityEpoch: 1
    })!
    expect(next.visibilityEpoch).toBe(1)
    a.privateKeys.accept(stream, next)
  })

  it('detects rollback of the SQLite nonce counter against its independently durable key-file anchor', async () => {
    const a = await participant(),
      stream = newId('stream'),
      bound = aad(stream, a.node, a.user)
    const body = a.privateKeys.rotate(stream, [{ node: a.node, agree: a.keys.nodeKeys().agree }], {
      controller: a.user,
      participants: [a.user],
      visibilityEpoch: 1
    })!
    a.privateKeys.accept(stream, body)
    a.privateKeys.seal(stream, Buffer.from('first'), bound)
    a.db.prepare('UPDATE net_private_nonce SET counter=? WHERE stream=?').run('0', stream)
    expect(() => a.privateKeys.seal(stream, Buffer.from('duplicate nonce attempt'), bound)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    const next = a.privateKeys.rotate(stream, [{ node: a.node, agree: a.keys.nodeKeys().agree }], {
      controller: a.user,
      participants: [a.user],
      visibilityEpoch: 1
    })!
    a.privateKeys.accept(stream, next)
    expect(a.privateKeys.seal(stream, Buffer.from('new epoch'), bound).keyEpoch).toBe(2)
  })

  it('rewraps to a newly authorized same-user node without changing audience or existing writer prefix', async () => {
    const a = await participant(),
      replacement = await participant(a.user, a.space),
      stream = newId('stream')
    const first = a.privateKeys.rotate(stream, [{ node: a.node, agree: a.keys.nodeKeys().agree }], {
      controller: a.user,
      participants: [a.user],
      visibilityEpoch: 1
    })!
    a.privateKeys.accept(stream, first)
    const wrap = a.privateKeys.rewrap(stream, 1, {
      node: replacement.node,
      agree: replacement.keys.nodeKeys().agree
    })
    const updated: Control = {
      ...first,
      wrapped: [...first.wrapped, wrap],
      writers: [
        ...first.writers,
        {
          node: replacement.node,
          noncePrefix: Buffer.from('unique-prefix').subarray(0, 4).toString('base64url')
        }
      ]
    }
    a.privateKeys.accept(stream, updated)
    replacement.privateKeys.accept(stream, updated)
    const bound = aad(stream, a.node, a.user),
      sealed = a.privateKeys.seal(stream, Buffer.from('rewrapped'), bound)
    expect(Buffer.from(replacement.privateKeys.open(stream, sealed, bound)).toString()).toBe(
      'rewrapped'
    )
    expect(updated).toMatchObject({ keyEpoch: 1, visibilityEpoch: 1 })
  })

  it('matches the frozen real X25519/HKDF/AES-GCM wrap, content and encrypted-blob known answers', () => {
    const seed = Buffer.from(fixture.wrap.recipientPrivateRaw, 'base64url')
    const privateKey = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), seed]),
      type: 'pkcs8',
      format: 'der'
    })
    const secrets = new Map<string, Uint8Array>()
    // This fixture adapter supplies only key operations used by accept/seal; durable behavior is tested above.
    const keys = {
      nodeKeys: () => ({ agree: fixture.wrap.info.recipientAgreementKey }),
      agree: (peer: Uint8Array) =>
        diffieHellman({
          privateKey,
          publicKey: createPublicKey({
            key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(peer)]),
            type: 'spki',
            format: 'der'
          })
        }),
      putSecret: (name: string, bytes: Uint8Array) => {
        secrets.set(name, Uint8Array.from(bytes))
      },
      getSecret: (name: string) => secrets.get(name)
    } as unknown as KeyStore
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    const node = fixture.wrap.info.node as NodeId,
      user = fixture.content.metadata.author.user as UserId,
      space = fixture.wrap.info.space as SpaceId,
      stream = fixture.wrap.info.stream as StreamId
    const privateKeys: PrivateStreamKeys = new SqlPrivateStreamKeys({
      database: db,
      keys,
      node,
      user,
      spaceForStream: () => space
    })
    privateKeys.accept(stream, {
      controller: user,
      participants: [user],
      keyEpoch: 1,
      visibilityEpoch: 1,
      writers: [{ node, noncePrefix: fixture.content.writerPrefix }],
      wrapped: [
        {
          node,
          recipientAgreementKey: fixture.wrap.info.recipientAgreementKey,
          ephemeral: fixture.wrap.info.ephemeral,
          nonce: fixture.wrap.nonce,
          ct: fixture.wrap.ciphertext
        }
      ]
    })
    const bound = Buffer.from(fixture.content.aad, 'base64url')
    expect(
      privateKeys.seal(stream, Buffer.from(fixture.content.plaintext, 'base64url'), bound)
    ).toEqual(fixture.content.sealed)
    expect(
      Buffer.from(
        privateKeys.sealBlob(stream, Buffer.from(fixture.blob.plaintext, 'base64url')).bytes
      ).toString('base64url')
    ).toBe(fixture.blob.storedBytes)
    const corrupt = { ...fixture.content.sealed, ct: Buffer.alloc(32).toString('base64url') }
    expect(() => privateKeys.open(stream, corrupt, bound)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
  })
})
