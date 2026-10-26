import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFileSync } from '../data/AtomicFs'
import { createSecretCodec, type SecretCodec } from '../providers/secretCodec'

/**
 * Secrets of one instance (`<stateDir>/secrets.json`): string values by name, encrypted at rest
 * with the OS vault whenever Electron offers it, under the same rules as the provider credential
 * file. Only the instance's own runtime reads it; the values never reach a snapshot or a log.
 */

const ENVELOPE_KEY = '__mousse_encrypted_v1'

export class InstanceVault {
  private cache: Record<string, string> | undefined

  constructor(private readonly path: string, private readonly codec: SecretCodec = createSecretCodec()) {}

  private failure(reason: string): Error {
    // Never include parser or codec errors: they may contain secret material.
    return new Error(`Cannot use the saved secrets at ${this.path}: ${reason}.`)
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.cache = {})
      throw this.failure('the file could not be read')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw this.failure('the stored data is invalid')
    }
    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, ENVELOPE_KEY)) {
      const payload = (parsed as Record<string, unknown>)[ENVELOPE_KEY]
      let decrypted: string | null = null
      try {
        decrypted = typeof payload === 'string' ? this.codec.decrypt(Buffer.from(payload, 'base64')) : null
      } catch {
        decrypted = null
      }
      if (decrypted === null) throw this.failure('decryption is unavailable or failed')
      try {
        parsed = JSON.parse(decrypted)
      } catch {
        throw this.failure('the stored data is invalid')
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw this.failure('the stored data is invalid')
    const values = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    return (this.cache = values)
  }

  get(name: string): string | undefined {
    return this.load()[name]
  }

  set(name: string, value: string | undefined): void {
    const next = { ...this.load() }
    if (value === undefined) delete next[name]
    else next[name] = value
    this.write(next)
  }

  clear(): void {
    this.cache = {}
    rmSync(this.path, { force: true })
  }

  private write(values: Record<string, string>): void {
    if (!Object.keys(values).length) return this.clear()
    const serialized = JSON.stringify(values)
    let stored = serialized
    if (this.codec.encryptionRequired || this.codec.canEncrypt()) {
      const encrypted = this.codec.encrypt(serialized)
      // Electron never saves a secret in plain text when its OS vault is unavailable.
      if (!encrypted) throw this.failure('encryption is unavailable; the secret was not saved')
      stored = JSON.stringify({ [ENVELOPE_KEY]: encrypted.toString('base64') })
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    atomicWriteFileSync(this.path, `${stored}\n`, { mode: 0o600 })
    this.cache = values
  }
}
