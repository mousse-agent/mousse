import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstanceVault } from '../src/mms/harness/vault'
import { FileCredentialStore } from '../src/mms/providers/FileCredentialStore'
import { stableMacSignature, type SecretCodec } from '../src/mms/providers/secretCodec'

/** Reverses bytes: stands in for the keychain an earlier build encrypted with. */
const keychain: SecretCodec = {
  encryptionRequired: true,
  canEncrypt: () => true,
  encrypt: (plain) => Buffer.from(plain).reverse(),
  decrypt: (stored) => Buffer.from(stored).reverse().toString()
}
/** A build without a stable signature: reads what the keychain saved, writes owner-only files. */
const ownerFile: SecretCodec = {
  plainAtRest: true,
  canEncrypt: () => false,
  encrypt: () => null,
  decrypt: keychain.decrypt
}

const directories: string[] = []
function file(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'mousse-nokeychain-'))
  directories.push(directory)
  return join(directory, name)
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('secrets on a macOS build without a stable signature', () => {
  it('uses the keychain only for builds whose signature names a team', () => {
    const developerId = [
      'Executable=/Applications/Mousse.app/Contents/MacOS/Mousse',
      'Authority=Developer ID Application: Example (ABCDE12345)',
      'TeamIdentifier=ABCDE12345'
    ].join('\n')
    const adHoc = ['CodeDirectory v=20400 size=425 flags=0x2(adhoc) hashes=3+7 location=embedded', 'Signature=adhoc', 'TeamIdentifier=not set'].join('\n')
    expect(stableMacSignature(developerId)).toBe(true)
    expect(stableMacSignature(adHoc)).toBe(false)
    expect(stableMacSignature('/Applications/Mousse.app: code object is not signed at all')).toBe(false)
    expect(stableMacSignature('')).toBe(true)
  })

  it('saves provider credentials the keychain encrypted as an owner-only file on first read', async () => {
    const path = file('auth.json')
    await new FileCredentialStore(path, keychain).modify('openai', async () => ({ type: 'api_key', key: 'sk-test' }))
    expect(readFileSync(path, 'utf-8')).toContain('__mousse_encrypted_v1')

    const store = new FileCredentialStore(path, ownerFile)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ openai: { type: 'api_key', key: 'sk-test' } })
    expect(store.isEncryptedAtRest()).toBe(false)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0)

    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-two' }))
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')))).toEqual(['openai', 'anthropic'])
  })

  it('saves instance secrets the keychain encrypted as an owner-only file on first read', () => {
    const path = file('secrets.json')
    new InstanceVault(path, keychain).set('token', 'secret-value')
    expect(readFileSync(path, 'utf-8')).toContain('__mousse_encrypted_v1')

    expect(new InstanceVault(path, ownerFile).get('token')).toBe('secret-value')
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ token: 'secret-value' })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0)
  })
})
