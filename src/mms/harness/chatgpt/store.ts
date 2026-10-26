import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync, quarantineUnreadableFileSync } from '../../data/AtomicFs'
import { createSecretCodec, type SecretCodec } from '../../providers/secretCodec'
import { openSecretFile, sealSecretFile, SecretFileError } from '../../providers/secretFile'
import { instanceStateDir } from '../instances'
import { ChatGptAuthError, MESSAGES } from './errors'
import { isRecord } from './http'

/**
 * One instance's ChatGPT connections: `<profileHome>/harness/<instanceId>/chatgpt.json`. Under
 * Electron it is encrypted with the OS vault (required there). A plain-Node daemon writes it as
 * plain JSON with mode 0600 on macOS and Linux; Windows ignores the mode, so there it relies on the
 * profile directory's ACL. Tokens never leave this file except to the token endpoint, the
 * revocation endpoint and Codex's token helper.
 */

export const DIRECT_SCOPE = 'chatgpt.tokens.use.direct'

/** A client registration OpenAI issued to this instance for one account. Kept after sign-out. */
export interface ChatGptRegistration {
  /** `oaiapp_…`. */
  clientId: string
  /** The account's subject for this registration; null until a sign-in on it was verified. */
  subject: string | null
  email: string | null
  /** "Connection N", shown next to the email. */
  label: string
  /** The callback path the registration was made with. Only the port may vary on reauth. */
  redirectPath: string
  /** Whether the last grant allowed ChatGPT plan use. A false value makes the next sign-in ask again. */
  sharing: boolean
}

/** Tokens of one registration. */
export interface ChatGptSession {
  clientId: string
  accessToken: string
  refreshToken: string | null
  /** The ID token of the sign-in. Kept unchanged by refreshes, so the profile key survives them. */
  idToken: string
  expiresAt: number
  earliestRefreshAt: number | null
  scopes: string[]
  savedAt: number
}

export interface ChatGptStoreData {
  version: 1
  /**
   * Moves on with every write. A write must find the revision it read, so a process that lost the
   * lock without knowing (suspended past the lock's max hold) cannot overwrite a newer state.
   */
  revision: number
  /**
   * Moves on with every sign-in commit, activation, sign-out and terminal refresh error, in the
   * same write. It is part of the profile key, so any of them ends what was issued before.
   */
  credentialEpoch: number
  /**
   * The connection in use. When it has no session, the connection expired (signed out by OpenAI);
   * null means signed out in Mousse or never signed in.
   */
  active: string | null
  /**
   * Moves on with every sign-in commit, activation, sign-out and deletion. A sign-in records it
   * when it starts and saves nothing if it moved on meanwhile, so a sign-in that finishes late can
   * never undo one of them. A terminal refresh error does not move it: signing in again is the fix.
   */
  signInFence: number
  /** Most recently used first. */
  registrations: ChatGptRegistration[]
  sessions: ChatGptSession[]
  /**
   * Refresh tokens taken out of use (sign-out, deletion, a sign-in that replaced a session) that
   * still need revoking at OpenAI. They are revoked only after the processes that used them are
   * stopped, and dropped once revocation was attempted.
   */
  pendingRevocations: RevocableToken[]
}

/** A refresh token to revoke at OpenAI. */
export interface RevocableToken {
  clientId: string
  refreshToken: string
}

export function emptyStore(): ChatGptStoreData {
  return { version: 1, revision: 0, credentialEpoch: 0, signInFence: 0, active: null, registrations: [], sessions: [], pendingRevocations: [] }
}

export function chatgptStorePath(profileHome: string, instanceId: string): string {
  return join(instanceStateDir(profileHome, instanceId), 'chatgpt.json')
}

export function chatgptLockPath(profileHome: string, instanceId: string): string {
  return join(instanceStateDir(profileHome, instanceId), 'chatgpt.lock')
}

const str = (value: unknown): value is string => typeof value === 'string'
const strOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function isRegistration(value: unknown): value is ChatGptRegistration {
  return isRecord(value) && str(value.clientId) && /^oaiapp_/.test(value.clientId) && strOrNull(value.subject) &&
    strOrNull(value.email) && str(value.label) && str(value.redirectPath) && typeof value.sharing === 'boolean'
}

function isSession(value: unknown): value is ChatGptSession {
  return isRecord(value) && str(value.clientId) && str(value.accessToken) && strOrNull(value.refreshToken) &&
    str(value.idToken) && finite(value.expiresAt) && (value.earliestRefreshAt === null || finite(value.earliestRefreshAt)) &&
    Array.isArray(value.scopes) && value.scopes.every(str) && finite(value.savedAt)
}

function isRevocable(value: unknown): value is RevocableToken {
  return isRecord(value) && str(value.clientId) && str(value.refreshToken)
}

function decode(value: unknown): ChatGptStoreData | null {
  if (!isRecord(value) || value.version !== 1 || !Number.isInteger(value.revision) || !Number.isInteger(value.credentialEpoch) || !Number.isInteger(value.signInFence) || !strOrNull(value.active)) return null
  if (!Array.isArray(value.registrations) || !value.registrations.every(isRegistration)) return null
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSession)) return null
  if (!Array.isArray(value.pendingRevocations) || !value.pendingRevocations.every(isRevocable)) return null
  return {
    version: 1,
    revision: value.revision as number,
    credentialEpoch: value.credentialEpoch as number,
    signInFence: value.signInFence as number,
    active: value.active,
    registrations: value.registrations,
    sessions: value.sessions,
    pendingRevocations: value.pendingRevocations
  }
}

/** A store a newer Mousse wrote: never read it as corrupt or replace it. */
function isNewer(value: unknown): boolean {
  return isRecord(value) && typeof value.version === 'number' && value.version > 1
}

export class ChatGptStore {
  /** Whether the file read last was encrypted: a store never downgrades to plain text. */
  private encrypted = false
  /** The revision the last read found (0 for no file); null before any read, which expects no file. */
  private readRevision: number | null = null

  constructor(
    readonly path: string,
    private readonly codec: SecretCodec = createSecretCodec()
  ) {}

  /**
   * The saved connections; empty when none were saved.
   * - A file this host cannot decrypt (no vault, locked keyring) or that a newer Mousse wrote fails
   *   typed and is never touched: it may be intact.
   * - A corrupt file fails typed, unless `discardUnreadable` (a new sign-in), which sets it aside as
   *   `<name>.corrupt-<time>`. If it was encrypted, the replacement must be encrypted too.
   */
  read(options: { discardUnreadable?: boolean } = {}): ChatGptStoreData {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.encrypted = this.codec.encryptionRequired === true
        this.readRevision = 0
        return emptyStore()
      }
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageUnreadable)
    }
    this.readRevision = null
    let wasEncrypted = false
    try {
      const opened = openSecretFile(raw, this.codec)
      wasEncrypted = opened.encrypted
      const decoded = decode(opened.value)
      if (decoded) {
        this.encrypted = opened.encrypted
        this.readRevision = decoded.revision
        return decoded
      }
      if (isNewer(opened.value)) throw new ChatGptAuthError('unsupported', 'storage_newer', MESSAGES.storageNewer)
    } catch (error) {
      if (!(error instanceof SecretFileError)) throw error
      if (error.kind === 'unavailable') throw new ChatGptAuthError('unsupported', 'storage_locked', MESSAGES.storageLocked)
      wasEncrypted = error.wasEncrypted
    }
    // A replacement of an encrypted file must be encrypted too (`assertWritable` checks it).
    this.encrypted = wasEncrypted || this.codec.encryptionRequired === true
    if (!options.discardUnreadable) throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageUnreadable)
    quarantineUnreadableFileSync(this.path)
    this.readRevision = 0
    return emptyStore()
  }

  /** The revision saved on disk now: 0 for no file, null when it cannot be read. */
  private savedRevision(): number | null {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null
    }
    try {
      return decode(openSecretFile(raw, this.codec).value)?.revision ?? null
    } catch {
      return null
    }
  }

  /** Fails typed when the next write could not be sealed as required (call after `read`). */
  assertWritable(): void {
    try {
      sealSecretFile('{}', this.codec, this.encrypted)
    } catch {
      throw new ChatGptAuthError('unsupported', 'storage', MESSAGES.storageEncryption)
    }
  }

  /**
   * Saves `data` as the next revision, only if the file still holds the revision the last read
   * found (no file, before any read). Sets `data.revision`. The check and the write are not one
   * atomic step, but they run back to back in synchronous code under the instance lock; what it
   * guards against is a holder that resumes long after it lost the lock.
   */
  write(data: ChatGptStoreData): void {
    const expected = this.readRevision ?? 0
    if (this.savedRevision() !== expected) throw new ChatGptAuthError('operation_busy', 'busy', MESSAGES.storeChanged)
    const next = { ...data, revision: expected + 1 }
    let sealed
    try {
      sealed = sealSecretFile(`${JSON.stringify(next, null, 2)}\n`, this.codec, this.encrypted)
    } catch {
      throw new ChatGptAuthError('unsupported', 'storage', MESSAGES.storageEncryption)
    }
    try {
      atomicWriteFileSync(this.path, sealed.stored, { mode: 0o600 })
    } catch {
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite)
    }
    this.encrypted = sealed.encrypted
    this.readRevision = next.revision
    data.revision = next.revision
  }

  remove(): void {
    rmSync(this.path, { force: true })
  }
}

export function activeSession(data: ChatGptStoreData): ChatGptSession | undefined {
  return data.active === null ? undefined : data.sessions.find((session) => session.clientId === data.active)
}

export function registrationOf(data: ChatGptStoreData, clientId: string): ChatGptRegistration | undefined {
  return data.registrations.find((registration) => registration.clientId === clientId)
}

/**
 * Binds work to the connection it started on, without putting a token or subject in argv:
 * sha256 of `[clientId, subject, idToken, credentialEpoch]`. Refreshes keep it; every sign-in
 * commit, activation, sign-out and terminal refresh error changes it.
 */
export function profileKeyOf(data: ChatGptStoreData): string | undefined {
  const session = activeSession(data)
  if (!session) return undefined
  const subject = registrationOf(data, session.clientId)?.subject ?? null
  return createHash('sha256').update(JSON.stringify([session.clientId, subject, session.idToken, data.credentialEpoch])).digest('hex')
}
