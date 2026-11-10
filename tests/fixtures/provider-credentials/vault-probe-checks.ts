import assert from 'node:assert/strict'
import { join } from 'node:path'
import { FileCredentialStore } from '../../../src/mms/providers/FileCredentialStore'

export type VaultPhase = 'write' | 'read' | 'node-reject'

/** The phase and fixture root from the command line, as the vault test passes them. */
export function vaultArguments(allowed: readonly VaultPhase[]): { phase: VaultPhase; root: string } {
  const [phase, root] = process.argv.slice(2)
  if (!root || !allowed.includes(phase as VaultPhase)) throw new Error('Invalid vault fixture arguments')
  return { phase: phase as VaultPhase, root }
}

/** Opens the credential vault under `root` and checks what this phase should find there. */
export async function probe(phase: VaultPhase, root: string): Promise<void> {
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
