import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSecretCodec, type SecretCodec } from '../../providers/secretCodec'
import { openSecretFile, sealSecretFile, SecretFileError } from '../../providers/secretFile'
import { instanceStateDir } from '../instances'
import { ChatGptAuthError, MESSAGES } from './errors'
import { isRecord } from './http'

/**
 * One instance's ChatGPT connections: a small SQLite database,
 * `<profileHome>/harness/<instanceId>/chatgpt.db`, with one row. The row holds the connections as a
 * sealed payload (encrypted with the OS vault under Electron, where that is required; plain JSON in
 * a plain-Node daemon, with the file at mode 0600 on macOS and Linux and the profile directory's
 * ACL on Windows), plus two plain columns: `revision` and `fence`.
 *
 * Every write is a conditional update: `revision = revision + 1 WHERE revision = <the revision this
 * operation read>`, inside `BEGIN IMMEDIATE`. The expected revision travels with the data the
 * operation read, never with the store object, so unrelated reads cannot change it. SQLite's locks
 * belong to the OS and end with the process, so a suspended or crashed process can never commit
 * over a newer state: it loses the race and reads again. Network calls happen outside any
 * transaction.
 *
 * Tokens never leave this database except to the token endpoint, the revocation endpoint and
 * Codex's token helper.
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
   * The row's revision when this data was read. `write` commits only if the row still has it, and
   * then sets it to the new revision.
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
   * Stored as a plain column, so it survives a payload that cannot be read.
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
  return join(instanceStateDir(profileHome, instanceId), 'chatgpt.db')
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

/** The sealed part of the row: everything except the revision and the fence. */
type Payload = Omit<ChatGptStoreData, 'revision' | 'signInFence'>

function decodePayload(value: unknown): Payload | null {
  if (!isRecord(value) || value.version !== 1 || !Number.isInteger(value.credentialEpoch) || !strOrNull(value.active)) return null
  if (!Array.isArray(value.registrations) || !value.registrations.every(isRegistration)) return null
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSession)) return null
  if (!Array.isArray(value.pendingRevocations) || !value.pendingRevocations.every(isRevocable)) return null
  return {
    version: 1,
    credentialEpoch: value.credentialEpoch as number,
    active: value.active,
    registrations: value.registrations,
    sessions: value.sessions,
    pendingRevocations: value.pendingRevocations
  }
}

/** A payload a newer Mousse wrote: never read it as corrupt or replace it. */
function isNewer(value: unknown): boolean {
  return isRecord(value) && typeof value.version === 'number' && value.version > 1
}

/** The database layout. A database with a higher `user_version` was made by a newer Mousse. */
const SCHEMA_VERSION = 1
const SCHEMA = `
CREATE TABLE IF NOT EXISTS store (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  encrypted INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS set_aside (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  encrypted INTEGER NOT NULL,
  payload TEXT NOT NULL
);
`

// SQLite primary result codes (node:sqlite reports extended codes in `errcode`).
const SQLITE_BUSY = 5
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

function sqliteCode(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown })?.errcode
  return typeof code === 'number' ? code & 0xff : undefined
}

/** The database file itself is damaged (not a payload problem). */
class CorruptDatabase extends Error {}

interface Row {
  revision: number
  fence: number
  encrypted: number
  payload: string
}

const corrupt = () => new ChatGptAuthError('protocol', 'storage', MESSAGES.storageUnreadable)

/** Whether a damaged database file still shows encrypted payloads, so its replacement stays encrypted. */
function wasEncryptedFile(path: string): boolean {
  try {
    return readFileSync(path).includes('__mousse_encrypted_v1')
  } catch {
    return false
  }
}

export class ChatGptStore {
  constructor(
    readonly path: string,
    private readonly codec: SecretCodec = createSecretCodec()
  ) {}

  /**
   * Opens the database for one operation and closes it afterwards, so no handle outlives the
   * operation (a later rename-aside, and test cleanup, can always proceed).
   */
  private withDatabase<T>(work: (database: DatabaseSync) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const created = !existsSync(this.path)
    let database: DatabaseSync
    try {
      database = new DatabaseSync(this.path)
    } catch (error) {
      if (sqliteCode(error) === SQLITE_NOTADB || sqliteCode(error) === SQLITE_CORRUPT) throw new CorruptDatabase()
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite)
    }
    try {
      if (created) {
        try { chmodSync(this.path, 0o600) } catch { /* Windows: the profile directory's ACL applies */ }
      }
      database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      if (version > SCHEMA_VERSION) throw new ChatGptAuthError('unsupported', 'storage_newer', MESSAGES.storageNewer)
      if (version < SCHEMA_VERSION) database.exec(`BEGIN IMMEDIATE; ${SCHEMA} PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`)
      return work(database)
    } catch (error) {
      if (error instanceof ChatGptAuthError || error instanceof CorruptDatabase) throw error
      const code = sqliteCode(error)
      if (code === SQLITE_NOTADB || code === SQLITE_CORRUPT) throw new CorruptDatabase()
      if (code === SQLITE_BUSY) throw new ChatGptAuthError('operation_busy', 'busy', MESSAGES.busy)
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite)
    } finally {
      try { database.close() } catch { /* already closed */ }
    }
  }

  private row(database: DatabaseSync): Row | undefined {
    return database.prepare('SELECT revision, fence, encrypted, payload FROM store WHERE id = 1').get() as Row | undefined
  }

  /** Decodes a row. A payload this host cannot decrypt or a newer Mousse wrote fails typed. */
  private decode(row: Row | undefined): ChatGptStoreData {
    if (!row) return emptyStore()
    let value: unknown
    try {
      value = openSecretFile(row.payload, this.codec).value
    } catch (error) {
      if (error instanceof SecretFileError && error.kind === 'unavailable') throw new ChatGptAuthError('unsupported', 'storage_locked', MESSAGES.storageLocked)
      throw corrupt()
    }
    const payload = decodePayload(value)
    if (payload) return { ...payload, revision: row.revision, signInFence: row.fence }
    if (isNewer(value)) throw new ChatGptAuthError('unsupported', 'storage_newer', MESSAGES.storageNewer)
    throw corrupt()
  }

  /**
   * The saved connections, with the revision they were read at; empty when none were saved.
   * A payload this host cannot decrypt (no vault, locked keyring) or that a newer Mousse wrote
   * fails typed and is never touched. A corrupt payload or database fails typed (`storage`).
   */
  read(): ChatGptStoreData {
    // A store never written reads as empty without creating anything.
    if (!existsSync(this.path)) return emptyStore()
    try {
      return this.withDatabase((database) => this.decode(this.row(database)))
    } catch (error) {
      if (error instanceof CorruptDatabase) throw corrupt()
      throw error
    }
  }

  /**
   * Sets a corrupt store aside and starts an empty one, keeping the encryption requirement:
   * - a corrupt payload moves to the `set_aside` table in the same transaction, and the fence moves
   *   on, so an attempt that read the old row cannot commit;
   * - a corrupt database file is renamed to `<name>.corrupt-<time>`. If the rename fails (Windows,
   *   another process has it open) nothing changes and this fails typed: the store is never
   *   treated as recovered while the damaged file is still in place. The new database's fence
   *   starts from the clock, above any fence the old one could have handed out.
   * Anything else (a locked vault, a newer Mousse, a readable store) is returned or thrown as `read`.
   */
  recover(): ChatGptStoreData {
    try {
      return this.withDatabase((database) => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const row = this.row(database)
          let data: ChatGptStoreData
          try {
            data = this.decode(row)
          } catch (error) {
            if (!(error instanceof ChatGptAuthError) || error.failure !== 'storage' || !row) throw error
            database.prepare('INSERT INTO set_aside (at, revision, encrypted, payload) VALUES (?, ?, ?, ?)').run(Date.now(), row.revision, row.encrypted, row.payload)
            const fresh = { ...emptyStore(), signInFence: row.fence + 1 }
            const sealed = this.seal(fresh, row.encrypted === 1)
            database.prepare('UPDATE store SET revision = revision + 1, fence = ?, encrypted = ?, payload = ? WHERE id = 1').run(fresh.signInFence, sealed.encrypted ? 1 : 0, sealed.stored)
            data = { ...fresh, revision: row.revision + 1 }
          }
          database.exec('COMMIT')
          return data
        } catch (error) {
          try { database.exec('ROLLBACK') } catch { /* already rolled back */ }
          throw error
        }
      })
    } catch (error) {
      if (!(error instanceof CorruptDatabase)) throw error
      const aside = `${this.path}.corrupt-${new Date().toISOString().replace(/:/g, '-')}`
      try {
        renameSync(this.path, aside)
      } catch {
        throw new ChatGptAuthError('operation_busy', 'storage', MESSAGES.storageSetAside)
      }
      for (const suffix of ['-wal', '-shm']) {
        try { renameSync(`${this.path}${suffix}`, `${aside}${suffix}`) } catch { /* absent */ }
      }
      const fresh = { ...emptyStore(), signInFence: Date.now() }
      this.write(fresh, { encrypt: this.codec.encryptionRequired === true || wasEncryptedFile(aside) })
      return fresh
    }
  }

  private seal(data: ChatGptStoreData, wasEncrypted: boolean): { stored: string; encrypted: boolean } {
    const { revision: _revision, signInFence: _fence, ...payload } = data
    try {
      return sealSecretFile(`${JSON.stringify(payload)}\n`, this.codec, wasEncrypted)
    } catch {
      throw new ChatGptAuthError('unsupported', 'storage', MESSAGES.storageEncryption)
    }
  }

  /** Fails typed when the current row could not be written back as required (a vault that is down). */
  assertWritable(): void {
    if (!existsSync(this.path)) {
      this.seal(emptyStore(), false)
      return
    }
    try {
      this.withDatabase((database) => {
        const row = this.row(database)
        this.seal(emptyStore(), row ? row.encrypted === 1 : false)
      })
    } catch (error) {
      if (error instanceof CorruptDatabase) {
        // The replacement must be encrypted when the vault requires it or the damaged file was.
        this.seal(emptyStore(), wasEncryptedFile(this.path))
        return
      }
      throw error
    }
  }

  /**
   * Commits `data` if the row still has `data.revision`, and sets `data.revision` to the new one.
   * Otherwise another operation committed first: `operation_busy`, read again. A payload is sealed
   * like the row it replaces, so a store never goes from encrypted to plain text; a vault that
   * cannot seal it now fails `storage` (or `storage_locked`), never `operation_busy`.
   */
  write(data: ChatGptStoreData, options: { encrypt?: boolean } = {}): void {
    try {
      this.withDatabase((database) => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const row = this.row(database)
          const sealed = this.seal(data, options.encrypt === true || (row ? row.encrypted === 1 : false))
          if (!row) {
            if (data.revision !== 0) throw new ChatGptAuthError('operation_busy', 'busy', MESSAGES.storeChanged)
            database.prepare('INSERT INTO store (id, revision, fence, encrypted, payload) VALUES (1, 1, ?, ?, ?)').run(data.signInFence, sealed.encrypted ? 1 : 0, sealed.stored)
          } else {
            const result = database
              .prepare('UPDATE store SET revision = revision + 1, fence = ?, encrypted = ?, payload = ? WHERE id = 1 AND revision = ?')
              .run(data.signInFence, sealed.encrypted ? 1 : 0, sealed.stored, data.revision)
            if (Number(result.changes) !== 1) throw new ChatGptAuthError('operation_busy', 'busy', MESSAGES.storeChanged)
          }
          database.exec('COMMIT')
        } catch (error) {
          try { database.exec('ROLLBACK') } catch { /* already rolled back */ }
          throw error
        }
      })
    } catch (error) {
      if (error instanceof CorruptDatabase) throw corrupt()
      throw error
    }
    data.revision += 1
  }

  /** The rows set aside as corrupt (tests and support). */
  setAside(): number {
    return this.withDatabase((database) => Number((database.prepare('SELECT count(*) AS n FROM set_aside').get() as { n: number }).n))
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
