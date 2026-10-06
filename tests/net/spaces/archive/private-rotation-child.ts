import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { FileKeyStore, SqlPrivateStreamKeys } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { newId } from '../../../../src/shared/net'
import { privateContentAAD } from '../../../../src/mms/spaces/private'
import { canonicalJson } from '../../../../src/mms/net/sync/codec'

const [path, mode] = process.argv.slice(2),
  passphrase = 'task-owned-archive-rotation',
  file = join(path, 'input.json')
mkdirSync(path, { recursive: true })
const db = new NetDatabase({ profileDir: path }),
  keys = new FileKeyStore(path, {
    codec: { canEncrypt: () => false, encrypt: () => null, decrypt: () => null },
    passphrase
  })
if (keys.state() === 'missing') await keys.initialize({ asAuthority: true })
else await keys.unlock(passphrase)
const seed = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : {
      space: newId('space'),
      stream: newId('stream'),
      user: newId('user'),
      node: newId('node'),
      operation: randomUUID(),
      sourceHash: 'a'.repeat(64),
      binding: 'b'.repeat(64)
    }
const crypto = new SqlPrivateStreamKeys({
  database: db.database,
  keys,
  node: seed.node,
  user: seed.user,
  spaceForStream: (stream) => {
    if (stream !== seed.stream) throw new Error('Unexpected archive stream')
    return seed.space
  },
  transaction: (work) => db.transaction(work),
  charge: (rows, bytes) => db.charge(rows, bytes),
  checkpoint: (point) => db.checkpoint(point)
})
if (!seed.before) {
  seed.before = crypto.rotate(seed.stream, [{ node: seed.node, agree: keys.nodeKeys().agree }], {
    controller: seed.user,
    participants: [seed.user],
    visibilityEpoch: 1
  })
  crypto.accept(seed.stream, seed.before)
  writeFileSync(file, JSON.stringify(seed))
}
const preparedName = `archive/rotation/${seed.operation}/${seed.stream}/2`,
  snapshot = () => {
    const bundle = JSON.parse(Buffer.from(keys.getSecret(preparedName)!).toString())
    return {
      body: bundle.body,
      original: bundle.original,
      keyHash: createHash('sha256').update(Buffer.from(bundle.key, 'base64url')).digest('hex'),
      oldKeyHash: createHash('sha256')
        .update(keys.getSecret(`private/${seed.stream}/1`)!)
        .digest('hex'),
      installed: !!keys.getSecret(`private/${seed.stream}/2`),
      pending: crypto.preparedRotation(seed.stream)
    }
  }
try {
  if (mode === 'kill')
    Object.defineProperty(db, 'fault', {
      value: (point: string) => {
        if (point === 'spaces.archive.private.bundleDurable') {
          writeFileSync(join(path, 'killed.json'), JSON.stringify(snapshot()))
          process.kill(process.pid, 'SIGKILL')
        }
      }
    })
  const body = crypto.prepareArchiveRotation(
    seed.stream,
    seed.before,
    [{ node: seed.node, agree: keys.nodeKeys().agree }],
    {
      operation: seed.operation,
      sourceHash: seed.sourceHash,
      binding: seed.binding,
      forbiddenPrefixes: seed.before.writers.map((w) => w.noncePrefix),
      sign: (body) => {
        const envelope = canonicalJson({
          v: 1,
          minor: 0,
          id: newId('event'),
          stream: seed.stream,
          type: 'participants.changed',
          crit: false,
          author: { user: seed.user, node: seed.node, keyEpoch: 1 },
          ts: Date.now(),
          auth: { metaEpoch: 2, metaSeq: 1 },
          body
        })
        return { envelope, sig: keys.signAsNode(envelope) }
      }
    }
  )
  const original = crypto.archiveRotationOriginal(seed.stream, seed.operation, body.keyEpoch)
  if (Buffer.from(original.envelope).toString('base64url') !== snapshot().original.envelope)
    throw new Error('Signed original changed')
  crypto.accept(seed.stream, body)
  const aad = privateContentAAD({
    v: 1,
    minor: 0,
    id: newId('event'),
    stream: seed.stream,
    type: 'message.posted',
    crit: false,
    author: { user: seed.user, node: seed.node, keyEpoch: 1 },
    ts: Date.now(),
    auth: { metaEpoch: 2, metaSeq: 1 }
  })
  const bytes = crypto.seal(seed.stream, Buffer.from('Fresh encrypted private message'), aad)
  const opened = Buffer.from(crypto.open(seed.stream, bytes, aad, seed.node)).toString()
  writeFileSync(
    join(path, 'completed.json'),
    JSON.stringify({ ...snapshot(), body, opened, nonce: bytes.nonce })
  )
} finally {
  db.close()
}
