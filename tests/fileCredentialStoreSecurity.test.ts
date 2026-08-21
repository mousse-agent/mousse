import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileCredentialStore } from '../src/mms/providers/FileCredentialStore'
import type { SecretCodec } from '../src/mms/providers/secretCodec'

describe('FileCredentialStore durability and at-rest encryption', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function makePath(name = 'auth.json'): string {
    const directory = mkdtempSync(join(tmpdir(), 'mousse-credstore-'))
    tempDirs.push(directory)
    return join(directory, name)
  }

  it('persists credentials through crash-safe atomic replacement', async () => {
    const path = makePath()
    const store = new FileCredentialStore(path)
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'secret-1' }))

    const onDisk = JSON.parse(readFileSync(path, 'utf-8'))
    expect(onDisk).toEqual({ anthropic: { type: 'api_key', key: 'secret-1' } })

    const reloaded = new FileCredentialStore(path)
    expect(await reloaded.read('anthropic')).toEqual({ type: 'api_key', key: 'secret-1' })
  })

  it('quarantines a corrupt file instead of silently resetting it', () => {
    const path = makePath()
    writeFileSync(path, '{ not valid json !!')

    const store = new FileCredentialStore(path)
    expect(store.listProviderIds()).toEqual([])

    const quarantined = readdirSync(tempDirs[0]).filter((f) => f.includes('.corrupt-'))
    expect(quarantined).toHaveLength(1)
    // The corrupt original content is preserved for manual recovery.
    expect(readFileSync(join(tempDirs[0], quarantined[0]), 'utf-8')).toBe('{ not valid json !!')
  })

  it('quarantines a non-object payload instead of silently resetting it', () => {
    const path = makePath()
    writeFileSync(path, '"just a string"')

    const store = new FileCredentialStore(path)
    expect(store.listProviderIds()).toEqual([])
    expect(readdirSync(tempDirs[0]).some((f) => f.includes('.corrupt-'))).toBe(true)
  })

  class Rot13Codec implements SecretCodec {
    canEncrypt(): boolean {
      return true
    }
    encrypt(plain: string): Buffer {
      return Buffer.from(
        plain.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97)),
        'utf-8'
      )
    }
    decrypt(stored: Buffer): string | null {
      return stored.toString('utf-8').replace(/[a-z]/g, (c) =>
        String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97)
      )
    }
  }

  it('round-trips through an injected codec with an encrypted envelope on disk', async () => {
    const path = makePath()
    const codec = new Rot13Codec()
    const store = new FileCredentialStore(path, codec)
    await store.modify('openai', async () => ({ type: 'api_key', key: 'sk-test' }))

    const raw = readFileSync(path, 'utf-8')
    expect(JSON.parse(raw).__mousse_encrypted_v1).toBeDefined()
    expect(raw).not.toContain('sk-test')

    const reloaded = new FileCredentialStore(path, new Rot13Codec())
    expect(await reloaded.read('openai')).toEqual({ type: 'api_key', key: 'sk-test' })
  })

  it('starts empty but keeps the file when decryption fails', async () => {
    const path = makePath()

    const broken = new FileCredentialStore(path, {
      canEncrypt: () => true,
      encrypt: () => Buffer.from('garbage-not-recoverable'),
      decrypt: () => null
    })
    await broken.modify('x', async () => ({ type: 'api_key', key: 'k' }))
    expect(readFileSync(path, 'utf-8')).toContain('__mousse_encrypted_v1')

    const reopened = new FileCredentialStore(path, {
      canEncrypt: () => true,
      encrypt: () => null,
      decrypt: () => null
    })
    expect(reopened.listProviderIds()).toEqual([])
    // Quarantined copy exists; nothing was destroyed.
    expect(readdirSync(tempDirs[0]).some((f) => f.includes('.corrupt-'))).toBe(true)
  })

  it('falls back to plaintext envelope when codec cannot encrypt', async () => {
    const path = makePath()
    const store = new FileCredentialStore(path, {
      canEncrypt: () => false,
      encrypt: () => null,
      decrypt: () => null
    })
    await store.modify('p', async () => ({ type: 'api_key', key: 'plain-key' }))

    const raw = readFileSync(path, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ p: { type: 'api_key', key: 'plain-key' } })
  })
})
