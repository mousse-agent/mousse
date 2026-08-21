import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { dirname } from 'path'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { atomicWriteFileSync } from '../data/AtomicFs'
import { createSecretCodec, type SecretCodec } from './secretCodec'

const ENVELOPE_KEY = '__mousse_encrypted_v1'

interface EncryptedEnvelope {
  [ENVELOPE_KEY]: string
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[ENVELOPE_KEY] === 'string'
  )
}

export class FileCredentialStore implements CredentialStore {
  private data = new Map<string, Credential>()
  private chains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec = createSecretCodec()
  ) {
    this.load()
  }

  listProviderIds(): string[] {
    return [...this.data.keys()]
  }

  has(providerId: string): boolean {
    return this.data.has(providerId)
  }

  async list() {
    return [...this.data.entries()].map(([providerId, credential]) => ({
      providerId,
      type: credential.type
    }))
  }

  get(providerId: string): Credential | undefined {
    return this.data.get(providerId)
  }

  /** True when the on-disk format is OS-vault-encrypted (Electron safeStorage). */
  isEncryptedAtRest(): boolean {
    return this.codec.canEncrypt()
  }

  private load(): void {
    this.ensureParentDir()
    if (!existsSync(this.path)) {
      this.persist()
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf-8'))
    } catch (error) {
      this.quarantineCorruptFile(error)
      this.data = new Map()
      return
    }

    if (isEncryptedEnvelope(parsed)) {
      const decrypted = this.codec.decrypt(Buffer.from(parsed[ENVELOPE_KEY], 'base64'))
      if (decrypted === null) {
        console.error(`[FileCredentialStore] Failed to decrypt ${this.path}`)
        this.quarantineCorruptFile(new Error('safeStorage decryption failed'))
        this.data = new Map()
        return
      }
      try {
        const inner = JSON.parse(decrypted) as Record<string, Credential>
        this.data = new Map(Object.entries(inner))
        return
      } catch (error) {
        this.quarantineCorruptFile(error)
        this.data = new Map()
        return
      }
    }

    if (typeof parsed !== 'object' || parsed === null) {
      this.quarantineCorruptFile(new Error('auth.json is not an object'))
      this.data = new Map()
      return
    }

    this.data = new Map(Object.entries(parsed as Record<string, Credential>))
  }

  /**
   * Move an unreadable credential file aside instead of overwriting it, so a
   * transient parse failure or decryption error can never silently destroy
   * stored credentials.
   */
  private quarantineCorruptFile(cause: unknown): void {
    const suffix = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, suffix)
      console.error(
        `[FileCredentialStore] Corrupt credential file moved to ${suffix} ` +
          `(cause: ${cause instanceof Error ? cause.message : String(cause)})`
      )
    } catch (renameError) {
      console.error(
        '[FileCredentialStore] Corrupt credential file could not be quarantined:',
        cause instanceof Error ? cause.message : String(cause),
        '|',
        renameError instanceof Error ? renameError.message : String(renameError)
      )
    }
  }

  private ensureParentDir(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }

  private persist(): void {
    this.ensureParentDir()
    const serialized = JSON.stringify(Object.fromEntries(this.data), null, 2)
    const encrypted = this.codec.encrypt(serialized)
    // Crash-safe replacement (temp file -> fsync -> rename) so a crash mid-write
    // can never truncate auth.json and lose every stored credential.
    atomicWriteFileSync(
      this.path,
      encrypted ? this.serializeEncrypted(encrypted) : serialized,
      { mode: 0o600 }
    )
    chmodSync(this.path, 0o600)
  }

  private serializeEncrypted(payload: Buffer): string {
    return `${JSON.stringify({ [ENVELOPE_KEY]: payload.toString('base64') }, null, 2)}\n`
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    const next = (async () => {
      await previous.catch(() => {})
      return task()
    })()
    this.chains.set(providerId, next.catch(() => {}))
    return next
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.data.get(providerId)
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = this.data.get(providerId)
      const next = await fn(current)
      if (next !== undefined) {
        this.data.set(providerId, next)
        this.persist()
        return next
      }
      return current
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      if (!this.data.delete(providerId)) return
      this.persist()
    })
  }
}
