import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '../../../src/shared/net'
import type { Clock, ExecutionKey } from '../../../src/mms/net/contracts'
import { encodeEnvelope } from '../../../src/mms/net/sync/codec'
import type { BlobId, EventId, StoredRecord, StreamDescriptor } from '../../../src/shared/net'

export const profile = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'mousse-net-store-')))
export function fixture() {
  const space = newId('space'); const bot = newId('bot'); const user = newId('user'); const node = newId('node')
  const descriptor: StreamDescriptor = { id: newId('stream'), kind: 'space.channel', authority: node, space, createdAt: 1 }
  let now = 1_000_000
  const clock: Clock = { now: () => now, monotonic: () => now, setTimeout: () => ({ cancel() {} }) }
  return {
    space, bot, user, node, descriptor, clock, setNow: (value: number) => { now = value },
    key: (trigger = newId('event')): ExecutionKey => ({ scope: space, target: bot, trigger }),
    record(seq: number, epoch = 1, id: EventId = newId('event'), blobs?: Array<{ id: BlobId; bytes: number; mime: string }>): StoredRecord {
      return { seq, epoch, recvTs: now, sig: new Uint8Array(64).fill(7), envelope: encodeEnvelope({ v: 1, minor: 0, id, stream: descriptor.id, type: 'message.posted', crit: false, author: { user, node, keyEpoch: 1 }, ts: now, auth: { metaSeq: 1, metaEpoch: epoch }, body: { text: `record ${epoch}/${seq}` }, ...(blobs ? { blobs } : {}) }) }
    }
  }
}
