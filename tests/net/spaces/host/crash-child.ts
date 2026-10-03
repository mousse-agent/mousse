import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { FileKeyStore, NetIdentityService } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { SqliteQuotaRateLedger } from '../../../../src/mms/net/store/limits'
import { openSecureChannel } from '../../../../src/mms/net/link/secureChannel'
import { EnrollmentService, EnrollmentGateway } from '../../../../src/mms/net/enrollment'
import { MetaProjection, SpaceHostService } from '../../../../src/mms/spaces/host'
import { systemClock } from '../../../../src/mms/net/clock'
import type { RoutesRecord } from '../../../../src/shared/net'
async function main() {
  const [path, mode, inputPath] = process.argv.slice(2),
    db = new NetDatabase({
      profileDir: path,
      fault: (point) => {
        if (
          (mode === 'before' && point === 'spaces.join.beforeCommit') ||
          (mode === 'snapshot-before' && point === 'snapshot.activate.beforeCommit')
        )
          process.kill(process.pid, 'SIGKILL')
      }
    }),
    keys = new FileKeyStore(path)
  await keys.unlock('space-host-test-master')
  const identity = new NetIdentityService({
    database: db.database,
    keys,
    clock: systemClock,
    coordinator: db
  })
  let projection: MetaProjection
  const store = new SqliteStreamStore(db, {
      maxRecordsPerAppend: 64,
      append: (...args) => projection.append(...args),
      finish: (...args) => projection.finish(...args)
    }),
    limits = new SqliteQuotaRateLedger(db)
  projection = new MetaProjection({
    db,
    identity,
    store,
    activatePins: (roots) => identity.pinUsers(roots)
  })
  if (mode.startsWith('snapshot-')) {
    const input = JSON.parse(readFileSync(inputPath, 'utf8')),
      stage = store.beginSnapshot(input.descriptor.id, input.target)
    for (const record of input.records)
      stage.append([
        {
          ...record,
          envelope: Buffer.from(record.envelope, 'base64url'),
          sig: Buffer.from(record.sig, 'base64url')
        }
      ])
    stage.commit()
    process.kill(process.pid, 'SIGKILL')
    return
  }
  const routes = () =>
    identity.signAsNode({
      v: 1,
      node: identity.self()!.node,
      version: 1,
      issuedAt: systemClock.now(),
      routes: [{ transport: 'direct', address: '127.0.0.1:4000', priority: 1 }]
    } satisfies RoutesRecord)
  const host = new SpaceHostService({ db, identity, keys, store, projection, limits, routes }),
    enrollment = new EnrollmentService({ db, identity, keys, clock: systemClock, routes })
  if (mode === 'after') host.onAppend(() => process.kill(process.pid, 'SIGKILL'))
  const server = createServer(async (raw) => {
    try {
      const channel = await openSecureChannel(raw, {
          role: 'server',
          credentials: keys.tlsCredentials(),
          deadlineMs: 3000
        }),
        gateway = new EnrollmentGateway({ channel, service: enrollment, spaceJoin: host })
      void gateway.completed.catch(() => {})
    } catch {
      raw.destroy()
    }
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address && typeof address !== 'string')
      process.stdout.write(JSON.stringify({ port: address.port }) + '\n')
  })
}
void main().catch(() => {
  process.exitCode = 1
})
