import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstanceVault } from '../src/mms/harness/vault'
import { FileKeyStore, setAsideKeychainNetwork } from '../src/mms/net/identity'
import { FileCredentialStore } from '../src/mms/providers/FileCredentialStore'
import { UsageProxyKeyStore } from '../src/mms/providers/usageProxyKeys'
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

/**
 * A signed macOS build's keychain item, which only it opens: it reads what it saved itself. `answers`
 * is false while the keychain is locked or missing.
 */
function ownItem(answers = true, own = true): SecretCodec {
  const tag = Buffer.from('own-item:')
  return {
    encryptionRequired: true,
    ownKeychainItem: own,
    canEncrypt: () => answers,
    encrypt: (plain) => (answers ? Buffer.concat([tag, Buffer.from(plain)]) : null),
    decrypt: (stored) => {
      if (!answers || !stored.subarray(0, tag.length).equals(tag)) throw new Error('Error while decrypting the ciphertext')
      return stored.subarray(tag.length).toString()
    }
  }
}

describe('secrets on a signed macOS build, which uses a keychain item of its own', () => {
  const asideOf = (dir: string, name: string) => readdirSync(dir).filter((entry) => entry.startsWith(`${name}.keychain-`))

  it('sets provider credentials saved through the old item aside and saves new ones through its own', async () => {
    const dir = directory(),
      path = join(dir, 'auth.json')
    await new FileCredentialStore(path, keychain).modify('openai', async () => ({ type: 'api_key', key: 'sk-old' }))
    const saved = readFileSync(path, 'utf-8')

    const store = new FileCredentialStore(path, ownItem())
    expect(store.listProviderIds()).toEqual([])
    expect(asideOf(dir, 'auth.json').map((name) => readFileSync(join(dir, name), 'utf-8'))).toEqual([saved])

    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-new' }))
    expect(new FileCredentialStore(path, ownItem()).listProviderIds()).toEqual(['anthropic'])
    expect(readFileSync(path, 'utf-8')).not.toContain('sk-new')
  })

  it('keeps data it cannot read while the keychain is locked, and on other systems', async () => {
    const dir = directory(),
      path = join(dir, 'auth.json')
    await new FileCredentialStore(path, keychain).modify('openai', async () => ({ type: 'api_key', key: 'sk-old' }))
    const saved = readFileSync(path, 'utf-8')

    expect(() => new FileCredentialStore(path, ownItem(false))).toThrow()
    expect(() => new FileCredentialStore(path, ownItem(true, false))).toThrow()
    expect(readFileSync(path, 'utf-8')).toBe(saved)
    expect(asideOf(dir, 'auth.json')).toEqual([])
  })

  it('sets instance secrets and proxy keys saved through the old item aside', () => {
    const dir = directory()
    new InstanceVault(join(dir, 'secrets.json'), keychain).set('token', 'old-value')
    new UsageProxyKeyStore(join(dir, 'proxy-keys.json'), keychain).set('http://127.0.0.1:8317', 'old-key')

    const vault = new InstanceVault(join(dir, 'secrets.json'), ownItem())
    expect(vault.get('token')).toBeUndefined()
    vault.set('token', 'new-value')
    expect(new InstanceVault(join(dir, 'secrets.json'), ownItem()).get('token')).toBe('new-value')

    const proxyKeys = new UsageProxyKeyStore(join(dir, 'proxy-keys.json'), ownItem())
    expect(proxyKeys.get('http://127.0.0.1:8317')).toBeUndefined()
    proxyKeys.set('http://127.0.0.1:8317', 'new-key')
    expect(new UsageProxyKeyStore(join(dir, 'proxy-keys.json'), ownItem()).get('http://127.0.0.1:8317')).toBe('new-key')

    expect(asideOf(dir, 'secrets.json')).toHaveLength(1)
    expect(asideOf(dir, 'proxy-keys.json')).toHaveLength(1)
  })

  it('moves network data saved through the old item aside, and keeps its own', async () => {
    const old = directory(),
      own = directory()
    await new FileKeyStore(old, { codec: keychain }).initialize({ asAuthority: true })
    await new FileKeyStore(own, { codec: ownItem() }).initialize({ asAuthority: true })

    expect(setAsideKeychainNetwork(old, ownItem(false))).toBe(false)
    expect(setAsideKeychainNetwork(own, ownItem())).toBe(false)
    expect(new FileKeyStore(own, { codec: ownItem() }).state()).toBe('unlocked')

    expect(setAsideKeychainNetwork(old, ownItem())).toBe(true)
    expect(readdirSync(old).filter((name) => name.startsWith('net'))).toEqual([expect.stringMatching(/^net\.keychain-\d+$/)])
    expect(new FileKeyStore(old, { codec: ownItem() }).state()).toBe('missing')
  })
})
