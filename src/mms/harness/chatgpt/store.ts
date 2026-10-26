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
 * One instance's ChatGPT connections: `<profileHome>/harness/<instanceId>/chatgpt.json`, encrypted
 * under Electron (required there) and mode 0600 everywhere. Tokens never leave this file except to
 * the token endpoint, the revocation endpoint and Codex's token helper.
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
   * Moves on with every sign-in commit, activation, sign-out and terminal refresh error, in the
   * same write. It is part of the profile key, so any of them ends what was issued before.
   */
  credentialEpoch: number
  /**
   * The connection in use. When it has no session, the connection expired (signed out by OpenAI);
   * null means signed out in Mousse or never signed in.
   */
  active: string | null
  /** Most recently used first. */
  registrations: ChatGptRegistration[]
  sessions: ChatGptSession[]
}

export function emptyStore(): ChatGptStoreData {
  return { version: 1, credentialEpoch: 0, active: null, registrations: [], sessions: [] }
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

function decode(value: unknown): ChatGptStoreData | null {
  if (!isRecord(value) || value.version !== 1 || !Number.isInteger(value.credentialEpoch) || !strOrNull(value.active)) return null
  if (!Array.isArray(value.registrations) || !value.registrations.every(isRegistration)) return null
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSession)) return null
  return {
    version: 1,
    credentialEpoch: value.credentialEpoch as number,
    active: value.active,
    registrations: value.registrations,
    sessions: value.sessions
  }
}

export class ChatGptStore {
  /** Whether the file read last was encrypted: a store never downgrades to plain text. */
  private encrypted = false

  constructor(
    readonly path: string,
    private readonly codec: SecretCodec = createSecretCodec()
  ) {}

  /**
   * The saved connections; empty when none were saved. An unreadable file fails typed, unless
   * `discardUnreadable` (a new sign-in), which sets it aside as `<name>.corrupt-<time>` first.
   */
  read(options: { discardUnreadable?: boolean } = {}): ChatGptStoreData {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.encrypted = this.codec.encryptionRequired === true
        return emptyStore()
      }
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageUnreadable)
    }
    let decoded: ChatGptStoreData | null = null
    try {
      const opened = openSecretFile(raw, this.codec)
      decoded = decode(opened.value)
      if (decoded) this.encrypted = opened.encrypted
    } catch (error) {
      if (!(error instanceof SecretFileError)) throw error
    }
    if (decoded) return decoded
    if (!options.discardUnreadable) throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageUnreadable)
    quarantineUnreadableFileSync(this.path)
    this.encrypted = this.codec.encryptionRequired === true
    return emptyStore()
  }

  write(data: ChatGptStoreData): void {
    let sealed
    try {
      sealed = sealSecretFile(`${JSON.stringify(data, null, 2)}\n`, this.codec, this.encrypted)
    } catch {
      throw new ChatGptAuthError('unsupported', 'storage', MESSAGES.storageEncryption)
    }
    try {
      atomicWriteFileSync(this.path, sealed.stored, { mode: 0o600 })
    } catch {
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite)
    }
    this.encrypted = sealed.encrypted
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
