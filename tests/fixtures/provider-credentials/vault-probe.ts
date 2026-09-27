import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { FileCredentialStore } from '../../../src/mms/providers/FileCredentialStore'

const [phase, root] = process.argv.slice(2)
if (!root || !['write', 'read', 'node-reject'].includes(phase)) throw new Error('Invalid vault fixture arguments')

async function probe(): Promise<void> {
  const path = join(root, 'home', 'auth.json')
  if (phase === 'node-reject') {
    assert.equal(process.versions.electron, undefined)
    assert.throws(() => new FileCredentialStore(path), /decrypt|encrypt|vault|credential/i)
  } else {
    const store = new FileCredentialStore(path)
    if (phase === 'write') {
      await store.modify('fixture-one', async () => ({ type: 'api_key', key: 'synthetic-one' }))
      await store.modify('fixture-two', async () => ({ type: 'api_key', key: 'synthetic-two' }))
    }
    assert.equal(store.isEncryptedAtRest(), true)
    assert.deepEqual(store.listProviderIds().sort(), ['fixture-one', 'fixture-two'])
    assert.deepEqual(await store.read('fixture-one'), { type: 'api_key', key: 'synthetic-one' })
    assert.deepEqual(await store.read('fixture-two'), { type: 'api_key', key: 'synthetic-two' })
  }
  process.stdout.write(`VAULT_PROBE_OK:${phase}\n`)
}

if (phase === 'node-reject') {
  void probe().catch((error) => { console.error(error); process.exitCode = 1 })
} else {
  const runtimeRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
  const { app } = runtimeRequire('electron') as typeof import('electron')
  app.setPath('userData', join(root, 'electron-user-data'))
  void app.whenReady().then(probe).then(() => app.quit(), (error) => {
    console.error(error)
    app.exit(1)
  })
}
