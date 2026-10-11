import { createServer } from 'node:net'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { EnrollmentService, EnrollmentGateway } from '../../../src/mms/net/enrollment'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { systemClock } from '../../../src/mms/net/clock'
const [path, mode] = process.argv.slice(2)
async function main() {
  const initialKeys = new FileKeyStore(path)
  await initialKeys.unlock('enrollment-test-master')
  const server = createServer((raw) => {
    void openSecureChannel(raw, {
      role: 'server',
      credentials: initialKeys.tlsCredentials(),
      deadlineMs: 2000
    })
      .then(async (channel) => {
        const db = new NetDatabase({ profileDir: path }),
          keys = new FileKeyStore(path)
        await keys.unlock('enrollment-test-master')
        const identity = new NetIdentityService({
          database: db.database,
          keys,
          clock: systemClock,
          coordinator: db
        })
        const service = new EnrollmentService({
          db,
          keys,
          identity,
          clock: systemClock,
          routes() {
            throw new Error('Receiving enrollment needs no route regeneration.')
          },
          fault() {
            if (mode === 'kill') process.kill(process.pid, 'SIGKILL')
          }
        })
        const gateway = new EnrollmentGateway({ channel, service })
        void gateway.completed.finally(() => db.close()).catch(() => {})
      })
      .catch(() => raw.destroy())
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No TCP address.')
    process.stdout.write(JSON.stringify({ port: address.port }) + '\n')
  })
}
void main()
