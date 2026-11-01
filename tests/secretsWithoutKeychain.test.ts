import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstanceVault } from '../src/mms/harness/vault'
import { FileKeyStore, setAsideKeychainNetwork } from '../src/mms/net/identity'
import { FileCredentialStore } from '../src/mms/providers/FileCredentialStore'
import { stableMacSignature, type SecretCodec } from '../src/mms/providers/secretCodec'

/** Reverses bytes: stands in for the keychain an earlier build saved through. */
const keychain: SecretCodec = {
  encryptionRequired: true,
  canEncrypt: () => true,
  encrypt: (plain) => Buffer.from(plain).reverse(),
  decrypt: (stored) => Buffer.from(stored).reverse().toString()
}
/** A build without a stable signature: never asks the keychain, writes owner-only files. */
const ownerFile: SecretCodec = {
  plainAtRest: true,
  canEncrypt: () => false,
  encrypt: () => null,
  decrypt: () => null
}

const directories: string[] = []
function directory(): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-nokeychain-')))
  directories.push(created)
  return created
}
afterEach(() => {
  for (const created of directories.splice(0)) rmSync(created, { recursive: true, force: true })
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

  it('sets provider credentials saved through the keychain aside and saves new ones as an owner-only file', async () => {
    const dir = directory(),
      path = join(dir, 'auth.json')
    await new FileCredentialStore(path, keychain).modify('openai', async () => ({ type: 'api_key', key: 'sk-old' }))
    const saved = readFileSync(path, 'utf-8')

    const store = new FileCredentialStore(path, ownerFile)
    expect(store.listProviderIds()).toEqual([])
    const aside = readdirSync(dir).find((name) => name.startsWith('auth.json.keychain-'))!
    expect(readFileSync(join(dir, aside), 'utf-8')).toBe(saved)

    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-new' }))
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ anthropic: { type: 'api_key', key: 'sk-new' } })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('sets instance secrets saved through the keychain aside', () => {
    const dir = directory(),
      path = join(dir, 'secrets.json')
    new InstanceVault(path, keychain).set('token', 'old-value')

    const vault = new InstanceVault(path, ownerFile)
    expect(vault.get('token')).toBeUndefined()
    expect(readdirSync(dir).some((name) => name.startsWith('secrets.json.keychain-'))).toBe(true)
    vault.set('token', 'new-value')
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ token: 'new-value' })
  })

  it('moves network data saved through the keychain aside so networking starts over', async () => {
    const profile = directory()
    await new FileKeyStore(profile, { codec: keychain }).initialize({ asAuthority: true })
    expect(setAsideKeychainNetwork(profile, keychain)).toBe(false)
    expect(setAsideKeychainNetwork(profile, ownerFile)).toBe(true)
    expect(readdirSync(profile).filter((name) => name.startsWith('net'))).toEqual([expect.stringMatching(/^net\.keychain-\d+$/)])
    expect(setAsideKeychainNetwork(profile, ownerFile)).toBe(false)

    const keys = new FileKeyStore(profile, { codec: ownerFile })
    expect(keys.state()).toBe('missing')
    await keys.initialize({ asAuthority: true })
    expect(JSON.parse(readFileSync(join(profile, 'net', 'keys.json'), 'utf-8')).mode).toBe('plain')
    expect(keys.protectedAtRest()).toBe(true)
  })
})
