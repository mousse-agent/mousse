import { writeSync } from 'node:fs'
import { FileKeyStore } from '../../../src/mms/net/identity/FileKeyStore'

const [profile, mode] = process.argv.slice(2)
let armed = false
const keys = new FileKeyStore(profile, { fault(point) {
  if (!armed || point !== 'keys.lockPublished') return
  if (mode === 'kill') process.kill(process.pid, 'SIGKILL')
  if (mode === 'hold') { writeSync(1, 'owned\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
} })
void keys.initialize({ asAuthority: true }).then(() => { armed = true; keys.putSecret('uncommitted', Buffer.from('must not commit')); throw new Error('Expected process loss did not occur.') })
