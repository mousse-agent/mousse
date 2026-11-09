import { readFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../data/AtomicFs'
import { createSecretCodec, type SecretCodec } from './secretCodec'
import { openSecretFile, sealSecretFile, SecretFileError } from './secretFile'

/**
 * The management keys of local CLI-to-API proxies the user entered in Mousse, one per proxy origin
 * (`http://host:port`), in Mousse's encrypted secret file. A key is only ever used for the origin it
 * was saved for, so a changed base URL never receives it. Nothing here logs, returns or exposes a key
 * beyond `get`, which only the usage reader calls.
 */
export class UsageProxyKeyStore {
  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec = createSecretCodec()
  ) {}

  /** The saved keys, or none when the file is missing; an unreadable file is an error, never data. */
  private read(): { keys: Record<string, string>; encrypted: boolean } {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { keys: {}, encrypted: false }
      throw new SecretFileError('the proxy keys cannot be read', 'unavailable')
    }
    const opened = openSecretFile(raw, this.codec)
    const keys: Record<string, string> = {}
    if (opened.value && typeof opened.value === 'object' && !Array.isArray(opened.value))
      for (const [origin, key] of Object.entries(opened.value as Record<string, unknown>)) if (typeof key === 'string' && key) keys[origin] = key
    return { keys, encrypted: opened.encrypted }
  }

  private write(keys: Record<string, string>, wasEncrypted: boolean): void {
    const { stored } = sealSecretFile(`${JSON.stringify(keys)}\n`, this.codec, wasEncrypted)
    atomicWriteFileSync(this.path, stored, { mode: 0o600 })
  }

  /** The key saved for exactly this origin. */
  get(origin: string): string | undefined {
    try {
      return this.read().keys[origin]
    } catch {
      return undefined
    }
  }

  has(origin: string): boolean {
    return this.get(origin) !== undefined
  }

  /** Saves the key for this origin (replacing one saved before). Throws when it cannot be saved encrypted. */
  set(origin: string, key: string): void {
    const { keys, encrypted } = this.read()
    this.write({ ...keys, [origin]: key }, encrypted)
  }

  /** Forgets the key of this origin; nothing else changes. */
  clear(origin: string): void {
    const { keys, encrypted } = this.read()
    if (!(origin in keys)) return
    const { [origin]: _removed, ...rest } = keys
    this.write(rest, encrypted)
  }
}
