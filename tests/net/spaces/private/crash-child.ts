import { readFileSync, writeFileSync } from 'node:fs'
import {
  FileKeyStore,
  NetIdentityService,
  SqlPrivateStreamKeys
} from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { MetaProjection } from '../../../../src/mms/spaces/host'
import { PrivateSpaceService } from '../../../../src/mms/spaces/private'
import { FakeClock } from '../../harness/FakeClock'
async function main() {
  const [path, mode, inputPath] = process.argv.slice(2),
    input = JSON.parse(readFileSync(inputPath, 'utf8')),
    clock = new FakeClock(input.now),
    db = new NetDatabase({
      profileDir: path,
      clock,
      fault: (point) => {
        if (
          (mode === 'snapshot-before' && point === 'spaces.private.snapshot.beforeCommit') ||
          (mode === 'prepare-before' && point === 'spaces.private.prepare.beforeCommit')
        )
          process.kill(process.pid, 'SIGKILL')
      }
    }),
    keys = new FileKeyStore(path)
  await keys.unlock('space-host-test-master')
  const identity = new NetIdentityService({ database: db.database, keys, clock, coordinator: db })
  let privateService: PrivateSpaceService, meta: MetaProjection
  const store = new SqliteStreamStore(db, {
    supports: (descriptor) =>
      descriptor.kind === 'space.meta' || descriptor.kind === 'space.private',
    maxRecordsPerAppend: 64,
    append: (records, descriptor, ...args) =>
      descriptor.kind === 'space.private'
        ? privateService.append(records, descriptor, ...args)
        : meta.append(records, descriptor, ...args),
    finish: (carry, descriptor, target) =>
      descriptor.kind === 'space.private'
        ? privateService.finish(carry, descriptor, target)
        : meta.finish(carry, descriptor, target)
  })
  meta = new MetaProjection({
    db,
    identity,
    store,
    activatePins: (roots) => identity.pinUsers(roots)
  })
  privateService = new PrivateSpaceService({
    db,
    identity,
    keys,
    store,
    meta,
    outbox: new SqliteOutbox(db),
    clock,
    privateKeys: new SqlPrivateStreamKeys({
      database: db.database,
      keys,
      node: identity.self()!.node,
      user: identity.self()!.user,
      spaceForStream: (id) => store.getStream(id)!.space!,
      transaction: (work) => db.transaction(work)
    })
  })
  if (mode.startsWith('snapshot-')) {
    const stage = store.beginSnapshot(input.descriptor.id, input.target)
    for (const record of input.records)
      stage.append([
        {
          ...record,
          envelope: Buffer.from(record.envelope, 'base64url'),
          sig: Buffer.from(record.sig, 'base64url')
        }
      ])
    stage.commit()
  } else {
    const created = privateService.prepareCreation(input.space, input.parent, input.participants)
    writeFileSync(
      inputPath + '.result',
      JSON.stringify({
        descriptor: created.descriptor,
        event: {
          id: created.event.id,
          envelope: Buffer.from(created.event.envelope).toString('base64url'),
          sig: Buffer.from(created.event.sig).toString('base64url')
        },
        parentEvent: {
          id: created.parentEvent.id,
          envelope: Buffer.from(created.parentEvent.envelope).toString('base64url'),
          sig: Buffer.from(created.parentEvent.sig).toString('base64url')
        }
      })
    )
  }
  process.kill(process.pid, 'SIGKILL')
}
void main().catch(() => {
  process.exitCode = 1
})
