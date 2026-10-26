import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChatGptStore, setStoreHookForTests } from '../../../src/mms/harness/chatgpt/store'
import type { SecretCodec } from '../../../src/mms/providers/secretCodec'

// Another Mousse process on the same ChatGPT store:
//   write-encrypted <path> <barrier>  re-seals the row with a working vault, pausing after the commit
//   recover <path> <barrier> <step>   replaces a damaged database, pausing at <step>
//   read <path>                       reads and prints the outcome as JSON
// A paused child writes `<barrier>/ready` and goes on when `<barrier>/go` appears (or is killed).
const [mode, path, barrier, step] = process.argv.slice(2)

const plain: SecretCodec = { canEncrypt: () => false, encrypt: () => null, decrypt: () => null }
// The same sealing as the tests' fake vault, without requiring encryption.
const vault: SecretCodec = {
  canEncrypt: () => true,
  encrypt: (text: string) => Buffer.from(`vault:${Buffer.from(text).toString('base64')}`),
  decrypt: (stored: Buffer) => {
    const text = stored.toString()
    return text.startsWith('vault:') ? Buffer.from(text.slice(6), 'base64').toString() : null
  }
}

function pauseAt(wanted: string): void {
  setStoreHookForTests((reached) => {
    if (reached !== wanted) return
    writeFileSync(join(barrier, 'ready'), '')
    const wait = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(join(barrier, 'go'))) Atomics.wait(wait, 0, 0, 10)
  })
}

try {
  if (mode === 'write-encrypted') {
    pauseAt('encrypted-committed')
    const store = new ChatGptStore(path, vault)
    const data = store.read()
    store.write({ ...data, credentialEpoch: data.credentialEpoch + 1 })
  } else if (mode === 'recover') {
    pauseAt(step)
    new ChatGptStore(path, plain).recover()
  } else {
    const data = new ChatGptStore(path, plain).read()
    process.stdout.write(JSON.stringify({ ok: true, revision: data.revision, incarnation: data.incarnation, fence: data.signInFence }))
  }
  process.exit(0)
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, failure: (error as { failure?: string }).failure ?? String(error) }))
  process.exit(mode === 'read' ? 0 : 1)
}
