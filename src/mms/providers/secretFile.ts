import { renameSync } from 'node:fs'
import type { SecretCodec } from './secretCodec'

/** The JSON key of an encrypted secret file: `{ "__mousse_encrypted_v1": "<base64>" }`. */
export const SECRET_ENVELOPE_KEY = '__mousse_encrypted_v1'

/**
 * Why a secret file cannot be read or written. The message never carries secret material.
 * - `corrupt`: the file is not valid JSON or not a valid envelope.
 * - `unavailable`: the envelope is fine but this host cannot decrypt it (no vault, another OS
 *   account, a locked keyring). The file may be intact; never discard it.
 * - `encryption`: the data must be encrypted and the vault cannot do it now.
 */
export class SecretFileError extends Error {
  constructor(
    readonly reason: string,
    readonly kind: 'corrupt' | 'unavailable' | 'encryption' = 'corrupt'
  ) {
    super(reason)
    this.name = 'SecretFileError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parse(raw: string): unknown {
  // Never include parser errors: they may quote credential material.
  try { return JSON.parse(raw) } catch { throw new SecretFileError('the stored data is invalid JSON') }
}

/**
 * Moves a file the OS vault encrypted out of the way, next to it, so a build that keeps secrets
 * in owner-only files (`plainAtRest`) starts empty instead of failing. Nothing is deleted.
 */
export function setAsideSecretFile(path: string): void {
  renameSync(path, `${path}.keychain-${Date.now()}`)
}

/** Reads a stored secret file: plain JSON, or the encrypted envelope around it. */
export function openSecretFile(raw: string, codec: SecretCodec): { value: unknown; encrypted: boolean } {
  const parsed = parse(raw)
  if (!isRecord(parsed) || !Object.hasOwn(parsed, SECRET_ENVELOPE_KEY)) return { value: parsed, encrypted: false }
  const payload = parsed[SECRET_ENVELOPE_KEY]
  if (typeof payload !== 'string' || !payload || Buffer.from(payload, 'base64').toString('base64') !== payload) {
    throw new SecretFileError('the encrypted envelope is invalid', 'corrupt')
  }
  let decrypted: string | null
  try { decrypted = codec.decrypt(Buffer.from(payload, 'base64')) } catch { decrypted = null }
  if (decrypted === null) throw new SecretFileError('decryption is unavailable or failed; use the Electron host that saved these credentials', 'unavailable')
  let value: unknown
  try {
    value = parse(decrypted)
  } catch {
    throw new SecretFileError('the stored data is invalid JSON', 'corrupt')
  }
  return { value, encrypted: true }
}

/**
 * The stored form of `serialized`. It is encrypted when the codec requires it (Electron), when the
 * vault is available, or when the file was encrypted before: a store never downgrades to plain text,
 * except under a codec that keeps secrets in owner-only files by design (`plainAtRest`).
 */
export function sealSecretFile(serialized: string, codec: SecretCodec, wasEncrypted: boolean): { stored: string; encrypted: boolean } {
  if (codec.plainAtRest) return { stored: serialized, encrypted: false }
  let encrypted: Buffer | null = null
  try {
    if (wasEncrypted || codec.encryptionRequired || codec.canEncrypt()) {
      encrypted = codec.encrypt(serialized)
      if (!encrypted) throw new Error('encryption unavailable')
    }
  } catch {
    throw new SecretFileError('encryption is unavailable or failed; credentials cannot be saved safely', 'encryption')
  }
  return encrypted
    ? { stored: `${JSON.stringify({ [SECRET_ENVELOPE_KEY]: encrypted.toString('base64') }, null, 2)}\n`, encrypted: true }
    : { stored: serialized, encrypted: false }
}
