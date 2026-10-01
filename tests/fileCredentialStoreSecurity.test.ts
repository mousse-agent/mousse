import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as atomicFs from '../src/mms/data/AtomicFs'
import { FileCredentialStore } from '../src/mms/providers/FileCredentialStore'
import type { SecretCodec } from '../src/mms/providers/secretCodec'

describe('FileCredentialStore durability and at-rest encryption', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('rejects corrupt JSON without moving or rewriting the original', () => {
    const path = makePath()
    writeFileSync(path, '{ not valid json !!')

    expect(() => new FileCredentialStore(path)).toThrow('invalid JSON')
    expect(readFileSync(path, 'utf-8')).toBe('{ not valid json !!')
    expect(readdirSync(tempDirs[0])).toEqual(['auth.json'])
  })

  it.each(['"just a string"', 'null', '[]', '{"provider":null}', '{"provider":{"type":"unknown"}}'])('rejects invalid structure %s without modifying it', (raw) => {
    const path = makePath()
    writeFileSync(path, raw)
    expect(() => new FileCredentialStore(path)).toThrow('structure is invalid')
    expect(readFileSync(path, 'utf-8')).toBe(raw)
    expect(readdirSync(tempDirs[0])).toEqual(['auth.json'])
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

  it('fails closed and keeps original bytes when decryption fails', async () => {
    const path = makePath()

    const broken = new FileCredentialStore(path, {
      canEncrypt: () => true,
      encrypt: () => Buffer.from('garbage-not-recoverable'),
      decrypt: () => null
    })
    await broken.modify('x', async () => ({ type: 'api_key', key: 'k' }))
    expect(readFileSync(path, 'utf-8')).toContain('__mousse_encrypted_v1')

    const raw = readFileSync(path, 'utf-8')
    expect(() => new FileCredentialStore(path, {
      canEncrypt: () => true,
      encrypt: () => null,
      decrypt: () => null
    })).toThrow('decryption is unavailable or failed')
    expect(() => new FileCredentialStore(path)).toThrow('use the Electron host')
    expect(readFileSync(path, 'utf-8')).toBe(raw)
    expect(readdirSync(tempDirs[0])).toEqual(['auth.json'])
  })

  it('supports a fresh plaintext store under Node without creating a file on read', async () => {
    const path = makePath()
    const store = new FileCredentialStore(path, {
      canEncrypt: () => false,
      encrypt: () => null,
      decrypt: () => null
    })
    expect(readdirSync(tempDirs[0])).toEqual([])
    await store.modify('p', async () => ({ type: 'api_key', key: 'plain-key' }))

    const raw = readFileSync(path, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ p: { type: 'api_key', key: 'plain-key' } })
  })

  it.each([false, true])('does not downgrade an encrypted store when encryption fails (available=%s)', async (available) => {
    const path = makePath()
    const codec = new Rot13Codec()
    const store = new FileCredentialStore(path, codec)
    await store.modify('p', async () => ({ type: 'api_key', key: 'original' }))
    const raw = readFileSync(path, 'utf-8')
    vi.spyOn(codec, 'canEncrypt').mockReturnValue(available)
    vi.spyOn(codec, 'encrypt').mockImplementation(() => null as unknown as Buffer)
    await expect(store.modify('p', async () => ({ type: 'api_key', key: 'replacement' }))).rejects.toThrow('encryption is unavailable or failed')
    await expect(store.delete('p')).rejects.toThrow('encryption is unavailable or failed')
    expect(readFileSync(path, 'utf-8')).toBe(raw)
    expect(await store.read('p')).toEqual({ type: 'api_key', key: 'original' })
    expect(store.isEncryptedAtRest()).toBe(true)
  })

  it('does not save plaintext in a fresh Electron store when its vault is unavailable', async () => {
    const path = makePath()
    const store = new FileCredentialStore(path, {
      encryptionRequired: true,
      canEncrypt: () => false,
      encrypt: () => null,
      decrypt: () => null
    })
    await expect(store.modify('p', async () => ({ type: 'api_key', key: 'secret' }))).rejects.toThrow('encryption is unavailable or failed')
    expect(store.listProviderIds()).toEqual([])
    expect(readdirSync(tempDirs[0])).toEqual([])
  })

  it('does not leak codec or parser error contents and never rewrites invalid decrypted data', () => {
    const path = makePath()
    const raw = JSON.stringify({ __mousse_encrypted_v1: Buffer.from('ciphertext').toString('base64') })
    writeFileSync(path, raw)
    for (const decrypt of [() => { throw new Error('secret-token') }, () => '{"key":"secret-token" broken']) {
      const codec = { canEncrypt: () => true, encrypt: () => null, decrypt }
      let failure: unknown
      try { new FileCredentialStore(path, codec) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).not.toContain('secret-token')
      expect(readFileSync(path, 'utf-8')).toBe(raw)
    }
    expect(readdirSync(tempDirs[0])).toEqual(['auth.json'])
  })

  it.each([null, 7, '', 'not base64!'])('rejects a malformed encrypted envelope without rewriting it (%s)', (payload) => {
    const path = makePath()
    const raw = JSON.stringify({ __mousse_encrypted_v1: payload })
    writeFileSync(path, raw)
    expect(() => new FileCredentialStore(path)).toThrow('encrypted envelope is invalid')
    expect(readFileSync(path, 'utf-8')).toBe(raw)
    expect(readdirSync(tempDirs[0])).toEqual(['auth.json'])
  })

  it('keeps memory and disk unchanged after failed writes and remains usable', async () => {
    const path = makePath()
    const store = new FileCredentialStore(path)
    await store.modify('p', async () => ({ type: 'api_key', key: 'original' }))
    const raw = readFileSync(path, 'utf-8')
    const writer = vi.spyOn(atomicFs, 'atomicWriteFileSync').mockImplementation(() => { throw new Error('secret-token') })
    await expect(store.modify('p', async (current) => {
      if (current?.type === 'api_key') current.key = 'replacement'
      return current
    })).rejects.toThrow('could not be written')
    await expect(store.delete('p')).rejects.toThrow('could not be written')
    expect(await store.read('p')).toEqual({ type: 'api_key', key: 'original' })
    expect(readFileSync(path, 'utf-8')).toBe(raw)
    writer.mockRestore()
    await store.modify('other', async () => ({ type: 'api_key', key: 'next' }))
    expect(new FileCredentialStore(path).listProviderIds()).toEqual(['p', 'other'])
  })

  it('does not allow callback or returned-object mutations to corrupt memory', async () => {
    const store = new FileCredentialStore(makePath())
    await store.modify('p', async () => ({ type: 'api_key', key: 'original' }))
    await expect(store.modify('p', async (current) => {
      if (current?.type === 'api_key') current.key = 'mutated'
      throw new Error('callback failure')
    })).rejects.toThrow('callback failure')
    const read = await store.read('p')
    if (read?.type === 'api_key') read.key = 'mutated'
    expect(await store.read('p')).toEqual({ type: 'api_key', key: 'original' })
  })

  it('rejects stale writers and preserves newly restored or concurrently updated credentials', async () => {
    const path = makePath()
    const first = new FileCredentialStore(path)
    const stale = new FileCredentialStore(path)
    await first.modify('p', async () => ({ type: 'api_key', key: 'latest' }))
    const raw = readFileSync(path, 'utf-8')
    await expect(stale.modify('other', async () => ({ type: 'api_key', key: 'stale' }))).rejects.toThrow('another writer changed')
    expect(readFileSync(path, 'utf-8')).toBe(raw)
    expect(stale.listProviderIds()).toEqual([])
    await expect(first.modify('p', async () => {
      writeFileSync(path, '{"restored":{"type":"api_key","key":"backup"}}')
      return { type: 'api_key', key: 'refresh' }
    })).rejects.toThrow('another writer changed')
    expect(new FileCredentialStore(path).listProviderIds()).toEqual(['restored'])
  })

  it('serializes overlapping provider updates without losing either credential', async () => {
    const path = makePath()
    const store = new FileCredentialStore(path)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = store.modify('first', async () => {
      await gate
      return { type: 'api_key', key: 'one' }
    })
    const second = store.modify('second', async () => ({ type: 'api_key', key: 'two' }))
    release()
    await Promise.all([first, second])
    expect(new FileCredentialStore(path).listProviderIds()).toEqual(['first', 'second'])
  })
})
