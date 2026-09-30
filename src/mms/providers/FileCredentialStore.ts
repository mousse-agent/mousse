import { readFileSync } from 'fs'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { atomicWriteFileSync } from '../data/AtomicFs'
import { withFileLock } from '../scheduled/fileLock'
import { createSecretCodec, type SecretCodec } from './secretCodec'

const ENVELOPE_KEY = '__mousse_encrypted_v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCredential(value: unknown): value is Credential {
  if (!isRecord(value)) return false
  if (value.type === 'api_key') {
    return (value.key === undefined || typeof value.key === 'string') &&
      (value.env === undefined || (isRecord(value.env) && Object.values(value.env).every((v) => typeof v === 'string')))
  }
  return value.type === 'oauth' && typeof value.refresh === 'string' &&
    typeof value.access === 'string' && typeof value.expires === 'number' && Number.isFinite(value.expires)
}

export class FileCredentialStore implements CredentialStore {
  private data = new Map<string, Credential>()
  private chain: Promise<unknown> = Promise.resolve()
  private source: string | null = null
  private encrypted = false

  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec = createSecretCodec()
  ) {
    this.load()
  }

  private failure(reason: string): Error {
    // Never include parser/codec errors: they may contain credential material.
    return new Error(`Cannot use provider credentials at ${this.path}: ${reason}. The credential file was not changed. Open Mousse with the original OS account and Electron data directory, or restore a verified backup before retrying.`)
  }

  private readSource(): string | null {
    try {
      return readFileSync(this.path, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw this.failure('the file could not be read')
    }
  }

  private parse(raw: string): unknown {
    try { return JSON.parse(raw) } catch { throw this.failure('the stored data is invalid JSON') }
  }

  private load(): void {
    this.source = this.readSource()
    // Reading a missing store must not create or overwrite anything.
    if (this.source === null) return
    let parsed = this.parse(this.source)
    if (isRecord(parsed) && Object.hasOwn(parsed, ENVELOPE_KEY)) {
      const payload = parsed[ENVELOPE_KEY]
      if (typeof payload !== 'string' || !payload ||
        Buffer.from(payload, 'base64').toString('base64') !== payload) {
        throw this.failure('the encrypted envelope is invalid')
      }
      let decrypted: string | null
      try { decrypted = this.codec.decrypt(Buffer.from(payload, 'base64')) } catch { decrypted = null }
      if (decrypted === null) throw this.failure('decryption is unavailable or failed; use the Electron host that saved these credentials')
      parsed = this.parse(decrypted)
      this.encrypted = true
    }
    if (!isRecord(parsed) || !Object.values(parsed).every(isCredential)) {
      throw this.failure('the credential structure is invalid')
    }
    this.data = new Map(Object.entries(parsed) as [string, Credential][])
  }

  listProviderIds(): string[] { return [...this.data.keys()] }
  has(providerId: string): boolean { return this.data.has(providerId) }
  async list() {
    return [...this.data.entries()].map(([providerId, credential]) => ({ providerId, type: credential.type }))
  }
  get(providerId: string): Credential | undefined {
    const value = this.data.get(providerId)
    return value === undefined ? undefined : structuredClone(value)
  }
  /** Whether the current file is encrypted (not merely whether encryption is available). */
  isEncryptedAtRest(): boolean { return this.encrypted }

  private persist(next: Map<string, Credential>): void {
    const serialized = JSON.stringify(Object.fromEntries(next), null, 2)
    let encrypted: Buffer | null = null
    try {
      const available = this.codec.canEncrypt()
      if (this.encrypted || this.codec.encryptionRequired || available) {
        encrypted = this.codec.encrypt(serialized)
        if (!encrypted) throw new Error('encryption unavailable')
      }
    } catch {
      throw this.failure('encryption is unavailable or failed; credentials cannot be saved safely')
    }
    const stored = encrypted
      ? `${JSON.stringify({ [ENVELOPE_KEY]: encrypted.toString('base64') }, null, 2)}\n`
      : serialized
    // Serialize cooperating writers and reject stale instances rather than losing
    // updates made while an asynchronous OAuth refresh/login was in flight.
    withFileLock(`${this.path}.lock`, () => {
      if (this.readSource() !== this.source) {
        throw this.failure('another writer changed the file; reconnect to the owning daemon before retrying')
      }
      try { atomicWriteFileSync(this.path, stored, { mode: 0o600 }) } catch {
        throw this.failure('the credential update could not be written')
      }
      this.source = stored
      this.encrypted = encrypted !== null
      this.data = next
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task)
    this.chain = next.catch(() => {})
    return next
  }

  async read(providerId: string): Promise<Credential | undefined> { return this.get(providerId) }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const next = await fn(this.get(providerId))
      if (next === undefined) return this.get(providerId)
      if (!isCredential(next)) throw this.failure('the replacement credential structure is invalid')
      const updated = new Map(this.data)
      updated.set(providerId, structuredClone(next))
      this.persist(updated)
      return this.get(providerId)
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.data.has(providerId)) return
      const updated = new Map(this.data)
      updated.delete(providerId)
      this.persist(updated)
    })
  }
}
