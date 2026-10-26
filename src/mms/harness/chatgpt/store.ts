import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
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
   * The database this data was read from: random, made with the database and new whenever a
   * damaged one is replaced. `write` commits only to the same database, so revisions that restart
   * in a replacement can never admit data read from the old one. Empty when no database existed.
   */
  incarnation: string
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
  return { version: 1, revision: 0, incarnation: '', credentialEpoch: 0, signInFence: 0, active: null, registrations: [], sessions: [], pendingRevocations: [] }
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
type Payload = Omit<ChatGptStoreData, 'revision' | 'signInFence' | 'incarnation'>

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

/**
 * The database layout. A database with a higher `user_version` was made by a newer Mousse.
 * 2 added `meta` (the incarnation); a version-1 database gains it on open.
 */
const SCHEMA_VERSION = 2
const SCHEMA = `
CREATE TABLE IF NOT EXISTS store (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  encrypted INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
const SQLITE_CANTOPEN = 14
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

/** A replacement database is built as `chatgpt.db.new-<uuid>` before it takes the name. */
const TEMPORARY_INFIX = '.new-'
/** How long an operation waits for another process's maintenance to finish. */
const MUTEX_WAIT_MS = 15_000

/** Saved before a damaged database is swapped out, so a crash mid-swap can be finished. */
interface SwapIntent {
  temporary: string
  aside: string
}

/**
 * Tests only: runs at named points inside the maintenance mutex, so a test can pause or "crash"
 * (throw) there: after an encrypted commit before its marker is promoted, after a replacement is
 * built before its swap intent is saved, and between the two halves of a swap.
 */
type StoreHookStep = 'encrypted-committed' | 'swap-built' | 'swap-moved'
let storeHook: ((step: StoreHookStep) => void) | null = null
export function setStoreHookForTests(hook: ((step: StoreHookStep) => void) | null): void {
  storeHook = hook
}

/** Mutexes this process holds, by control database, so maintenance can nest. */
const heldMutexes = new Map<string, { depth: number }>()

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
      if (version < SCHEMA_VERSION) {
        database.exec(`BEGIN IMMEDIATE; ${SCHEMA}`)
        try {
          // Another process may have made the schema first; its incarnation stands.
          database.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('incarnation', ?)").run(randomUUID())
          database.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`)
        } catch (error) {
          try { database.exec('ROLLBACK') } catch { /* already rolled back */ }
          throw error
        }
      }
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

  private incarnation(database: DatabaseSync): string {
    const select = () => database.prepare("SELECT value FROM meta WHERE key = 'incarnation'").get() as { value: string } | undefined
    let found = select()
    if (!found) {
      // A lost incarnation is given a new one: data read before cannot match it, which is safe.
      database.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('incarnation', ?)").run(randomUUID())
      found = select()
    }
    if (!found) throw corrupt()
    return found.value
  }

  /** Decodes a row. A payload this host cannot decrypt or a newer Mousse wrote fails typed. */
  private decode(row: Row | undefined, incarnation: string): ChatGptStoreData {
    if (!row) return { ...emptyStore(), incarnation }
    let value: unknown
    try {
      value = openSecretFile(row.payload, this.codec).value
    } catch (error) {
      if (error instanceof SecretFileError && error.kind === 'unavailable') throw new ChatGptAuthError('unsupported', 'storage_locked', MESSAGES.storageLocked)
      throw corrupt()
    }
    const payload = decodePayload(value)
    if (payload) return { ...payload, revision: row.revision, signInFence: row.fence, incarnation }
    if (isNewer(value)) throw new ChatGptAuthError('unsupported', 'storage_newer', MESSAGES.storageNewer)
    throw corrupt()
  }

  /**
   * The saved connections, with the revision they were read at; empty when none were saved.
   * A payload this host cannot decrypt (no vault, locked keyring) or that a newer Mousse wrote
   * fails typed and is never touched. A corrupt payload or database fails typed (`storage`).
   */
  read(): ChatGptStoreData {
    // Maintenance is never done without the mutex: a read that finds some takes it and redoes it.
    if (this.needsMaintenance()) this.withMutex(() => this.maintain())
    if (!existsSync(this.path)) {
      // A database set aside earlier and now missing must be recovered, not read as never written.
      if (this.wasSetAside()) throw corrupt()
      // A store never written reads as empty without creating anything.
      return emptyStore()
    }
    let snapshot: ChatGptStoreData | 'missing' | 'needs_write'
    try {
      snapshot = this.readOnly()
    } catch (error) {
      if (error instanceof CorruptDatabase) throw corrupt()
      throw error
    }
    if (snapshot === 'missing') {
      if (this.wasSetAside()) throw corrupt()
      return emptyStore()
    }
    if (snapshot !== 'needs_write') return snapshot
    // An older layout or a lost incarnation needs a write: do it like any other, under the mutex.
    try {
      return this.withMutex(() => this.withDatabase((database) => this.decode(this.row(database), this.incarnation(database))))
    } catch (error) {
      if (error instanceof CorruptDatabase) throw corrupt()
      throw error
    }
  }

  /**
   * An unlocked read opens the database read-only, so it can never create a file at the live name
   * (for example while a swap has moved the original aside). `missing` when there is no database,
   * `needs_write` when the layout must be upgraded or the incarnation is lost.
   */
  private readOnly(): ChatGptStoreData | 'missing' | 'needs_write' {
    let database: DatabaseSync
    try {
      database = new DatabaseSync(this.path, { readOnly: true })
    } catch (error) {
      const code = sqliteCode(error)
      if (code === SQLITE_CANTOPEN) return 'missing'
      if (code === SQLITE_NOTADB || code === SQLITE_CORRUPT) throw new CorruptDatabase()
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageUnreadable)
    }
    try {
      database.exec('PRAGMA busy_timeout=5000')
      const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      if (version > SCHEMA_VERSION) throw new ChatGptAuthError('unsupported', 'storage_newer', MESSAGES.storageNewer)
      if (version < SCHEMA_VERSION) return 'needs_write'
      const found = database.prepare("SELECT value FROM meta WHERE key = 'incarnation'").get() as { value: string } | undefined
      if (!found) return 'needs_write'
      return this.decode(this.row(database), found.value)
    } catch (error) {
      if (error instanceof ChatGptAuthError) throw error
      const code = sqliteCode(error)
      if (code === SQLITE_CANTOPEN) return 'missing'
      if (code === SQLITE_NOTADB || code === SQLITE_CORRUPT) throw new CorruptDatabase()
      if (code === SQLITE_BUSY) throw new ChatGptAuthError('operation_busy', 'busy', MESSAGES.busy)
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageUnreadable)
    } finally {
      try { database.close() } catch { /* already closed */ }
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
    return this.withMutex(() => {
      this.maintain()
      return this.recoverHolding()
    })
  }

  private recoverHolding(): ChatGptStoreData {
    if (!existsSync(this.path)) return this.replaceDamagedFile()
    let promote = false
    try {
      const recovered = this.withDatabase((database) => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const row = this.row(database)
          const incarnation = this.incarnation(database)
          let data: ChatGptStoreData
          try {
            data = this.decode(row, incarnation)
          } catch (error) {
            if (!(error instanceof ChatGptAuthError) || error.failure !== 'storage' || !row) throw error
            database.prepare('INSERT INTO set_aside (at, revision, encrypted, payload) VALUES (?, ?, ?, ?)').run(Date.now(), row.revision, row.encrypted, row.payload)
            const fresh = { ...emptyStore(), signInFence: row.fence + 1, incarnation }
            const sealed = this.seal(fresh, row.encrypted === 1)
            if (sealed.encrypted) this.beginEncrypted()
            promote = sealed.encrypted
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
      if (promote) {
        storeHook?.('encrypted-committed')
        this.promoteEncrypted()
      }
      return recovered
    } catch (error) {
      if (!(error instanceof CorruptDatabase)) {
        if (promote) this.settlePending()
        throw error
      }
      return this.replaceDamagedFile()
    }
  }

  /**
   * Replaces a damaged (or missing, after a damaged one was set aside) database file.
   *
   * The complete replacement is built first, under a temporary name, sealed as the old store
   * required; a seal that fails leaves everything untouched. A swap intent naming both files is
   * saved next, so a crash at any later point is finished or rolled back by the next open
   * (`maintain`), and a missing database is never mistaken for a store never written. The old
   * journal files move aside before the old database, so the new database never meets an old
   * WAL. Any failure puts back what moved and removes the replacement; only a completed swap
   * counts as recovered. The replacement has a new incarnation, so data read from the old file can
   * never commit to it, and a clock-based fence above any the old one handed out.
   */
  private replaceDamagedFile(): ChatGptStoreData {
    const encrypt = this.codec.encryptionRequired === true || (existsSync(this.path) && wasEncryptedFile(this.path))
    const fresh: ChatGptStoreData = { ...emptyStore(), signInFence: Date.now(), incarnation: randomUUID() }
    const sealed = this.seal(fresh, encrypt)
    const pending = sealed.encrypted && this.beginEncrypted()
    const temporary = `${this.path}${TEMPORARY_INFIX}${randomUUID()}`
    const giveUp = (error: ChatGptAuthError): never => {
      rmSync(temporary, { force: true })
      rmSync(this.swapIntentPath(), { force: true })
      if (pending) rmSync(this.pendingMarker(), { force: true })
      throw error
    }
    try {
      const database = new DatabaseSync(temporary)
      try {
        try { chmodSync(temporary, 0o600) } catch { /* Windows: the profile directory's ACL applies */ }
        database.exec(`${SCHEMA} PRAGMA user_version=${SCHEMA_VERSION};`)
        database.prepare("INSERT INTO meta (key, value) VALUES ('incarnation', ?)").run(fresh.incarnation)
        database.prepare('INSERT INTO store (id, revision, fence, encrypted, payload) VALUES (1, 1, ?, ?, ?)').run(fresh.signInFence, sealed.encrypted ? 1 : 0, sealed.stored)
      } finally {
        database.close()
      }
    } catch {
      giveUp(new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite))
    }
    storeHook?.('swap-built')
    const aside = `${this.path}.corrupt-${new Date().toISOString().replace(/:/g, '-')}`
    try {
      atomicWriteJsonSync(this.swapIntentPath(), { temporary, aside } satisfies SwapIntent, { mode: 0o600 })
    } catch {
      giveUp(new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite))
    }
    const moved: string[] = []
    const putBack = () => {
      for (const suffix of moved) {
        try { renameSync(`${aside}${suffix}`, `${this.path}${suffix}`) } catch { /* left beside the copy */ }
      }
    }
    try {
      for (const suffix of ['-wal', '-shm', '']) {
        if (!existsSync(`${this.path}${suffix}`)) continue
        renameSync(`${this.path}${suffix}`, `${aside}${suffix}`)
        moved.push(suffix)
      }
    } catch {
      putBack()
      giveUp(new ChatGptAuthError('operation_busy', 'storage', MESSAGES.storageSetAside))
    }
    // Tests only: a crash between the two halves of the swap (no clean-up runs).
    storeHook?.('swap-moved')
    try {
      renameSync(temporary, this.path)
    } catch {
      putBack()
      giveUp(new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite))
    }
    rmSync(this.swapIntentPath(), { force: true })
    if (pending) this.promoteEncrypted()
    return { ...fresh, revision: 1 }
  }

  private swapIntentPath(): string {
    return `${this.path}.swap`
  }

  /** The sidecar database whose write lock is the maintenance mutex. Never replaced. */
  private controlPath(): string {
    return join(dirname(this.path), 'chatgpt.control.db')
  }

  /**
   * Runs `work` holding the maintenance mutex: a `BEGIN IMMEDIATE` transaction on the sidecar
   * control database, held for the whole call and rolled back afterwards. SQLite's lock belongs to
   * the OS: it ends when its process does, and it never expires while the process lives, however
   * long it is suspended. Every write, every recovery and every maintenance action (settling a
   * pending marker, finishing or rolling back a swap, clearing replacements) runs under it, so
   * whatever maintenance finds that is not being worked on now was abandoned. `work` is
   * synchronous. Nested calls in this process share the outer hold.
   */
  private withMutex<T>(work: () => T): T {
    const key = this.controlPath()
    const held = heldMutexes.get(key)
    if (held) {
      held.depth++
      try {
        return work()
      } finally {
        held.depth--
      }
    }
    mkdirSync(dirname(key), { recursive: true, mode: 0o700 })
    let control: DatabaseSync
    try {
      control = new DatabaseSync(key)
    } catch {
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite)
    }
    try {
      try {
        control.exec(`PRAGMA busy_timeout=${MUTEX_WAIT_MS}`)
        control.exec('BEGIN IMMEDIATE')
      } catch (error) {
        if (sqliteCode(error) === SQLITE_BUSY) throw new ChatGptAuthError('operation_busy', 'busy', MESSAGES.busy)
        throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite)
      }
      heldMutexes.set(key, { depth: 1 })
      try {
        return work()
      } finally {
        heldMutexes.delete(key)
        try { control.exec('ROLLBACK') } catch { /* nothing to roll back */ }
      }
    } finally {
      try { control.close() } catch { /* already closed */ }
    }
  }

  /** Whether there is maintenance to do: a pending marker, a swap intent or a replacement file. */
  private needsMaintenance(): boolean {
    if (existsSync(this.pendingMarker()) || existsSync(this.swapIntentPath())) return true
    return this.temporaries().length > 0
  }

  private temporaries(): string[] {
    const prefix = `${basename(this.path)}${TEMPORARY_INFIX}`
    try {
      return readdirSync(dirname(this.path)).filter((name) => name.startsWith(prefix)).map((name) => join(dirname(this.path), name))
    } catch {
      return []
    }
  }

  /**
   * Maintenance, under the mutex only. Nothing else holds it, so any swap intent, replacement file
   * or pending marker found here belongs to a process that died:
   * - a swap intent is finished if its replacement is complete, or rolled back if it is gone;
   * - replacement files are removed;
   * - a pending marker is promoted if the committed row is encrypted, or removed if not.
   */
  private maintain(): void {
    const intentPath = this.swapIntentPath()
    if (existsSync(intentPath)) {
      let intent: SwapIntent | null = null
      try {
        const parsed = JSON.parse(readFileSync(intentPath, 'utf8')) as Partial<SwapIntent>
        if (typeof parsed.temporary === 'string' && typeof parsed.aside === 'string') intent = { temporary: parsed.temporary, aside: parsed.aside }
      } catch {
        // Saved atomically, so unreadable means damaged; nothing can be finished from it.
      }
      const stuck = () => new ChatGptAuthError('protocol', 'storage_swap', MESSAGES.storageSwapStuck(intentPath))
      if (intent && !existsSync(this.path)) {
        try {
          if (existsSync(intent.temporary)) {
            renameSync(intent.temporary, this.path)
          } else if (existsSync(intent.aside)) {
            for (const suffix of ['-wal', '-shm']) {
              if (existsSync(`${intent.aside}${suffix}`)) renameSync(`${intent.aside}${suffix}`, `${this.path}${suffix}`)
            }
            renameSync(intent.aside, this.path)
          }
        } catch {
          throw stuck()
        }
      }
      // Neither half of the swap is left (or the intent is unreadable) and no database is in place:
      // nothing can be finished safely, and the intent is kept for a person to look at.
      if (!existsSync(this.path)) throw stuck()
      rmSync(intentPath, { force: true })
    }
    for (const file of this.temporaries()) rmSync(file, { force: true })
    this.settlePending()
  }

  /** Settles a pending marker from the committed row (under the mutex). */
  private settlePending(): void {
    if (!existsSync(this.pendingMarker()) || !existsSync(this.path)) return
    let encrypted: boolean
    try {
      encrypted = this.withDatabase((database) => this.row(database)?.encrypted === 1)
    } catch {
      // Unreadable now: the pending marker stays and keeps encryption required until settled.
      return
    }
    if (encrypted) this.promoteEncrypted()
    else rmSync(this.pendingMarker(), { force: true })
  }

  /** Whether a damaged database was set aside here, so a missing one is not a store never written. */
  private wasSetAside(): boolean {
    const prefix = `${basename(this.path)}.corrupt-`
    try {
      return readdirSync(dirname(this.path)).some((name) => name.startsWith(prefix) && !name.endsWith('-wal') && !name.endsWith('-shm'))
    } catch {
      return false
    }
  }

  /**
   * The store has held encrypted data: from then on it only accepts encrypted payloads, even when
   * its database is replaced. Kept as a file beside the database. It is written only once an
   * encrypted row is committed: before the commit a pending marker is written, and the next open
   * promotes or removes it from the committed row, so a rejected write never changes the policy
   * and a crash between commit and promotion loses nothing.
   */
  private encryptionMarker(): string {
    return join(dirname(this.path), 'chatgpt.encrypted')
  }

  private pendingMarker(): string {
    return `${this.encryptionMarker()}.pending`
  }

  /** Writes the pending marker when the final one is missing. True when this call wrote it. */
  private beginEncrypted(): boolean {
    if (existsSync(this.encryptionMarker())) return false
    try {
      writeFileSync(this.pendingMarker(), '', { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw new ChatGptAuthError('protocol', 'storage', MESSAGES.storageWrite)
    }
  }

  private promoteEncrypted(): void {
    try {
      writeFileSync(this.encryptionMarker(), '', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return
    }
    rmSync(this.pendingMarker(), { force: true })
  }

  private seal(data: ChatGptStoreData, wasEncrypted: boolean): { stored: string; encrypted: boolean } {
    const { revision: _revision, signInFence: _fence, incarnation: _incarnation, ...payload } = data
    const required = wasEncrypted || existsSync(this.encryptionMarker()) || existsSync(this.pendingMarker())
    try {
      return sealSecretFile(`${JSON.stringify(payload)}\n`, this.codec, required)
    } catch {
      throw new ChatGptAuthError('unsupported', 'storage', MESSAGES.storageEncryption)
    }
  }

  /**
   * Fails typed when the current row could not be written back as required (a vault that is down,
   * or a store that once held encrypted data under a host that cannot encrypt).
   */
  assertWritable(): void {
    if (this.needsMaintenance()) this.withMutex(() => this.maintain())
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
   * Commits `data` if the row still has `data.revision` in the same database (`data.incarnation`),
   * and sets `data.revision` to the new one.
   * Otherwise another operation committed first: `operation_busy`, read again. A payload is sealed
   * like the row it replaces, so a store never goes from encrypted to plain text; a vault that
   * cannot seal it now fails `storage` (or `storage_locked`), never `operation_busy`.
   */
  write(data: ChatGptStoreData): void {
    this.withMutex(() => {
      this.maintain()
      this.writeHolding(data)
    })
  }

  private writeHolding(data: ChatGptStoreData): void {
    const changed = () => new ChatGptAuthError('operation_busy', 'busy', MESSAGES.storeChanged)
    let incarnation = ''
    let encrypted = false
    if (!existsSync(this.path) && this.wasSetAside()) throw corrupt()
    try {
      this.withDatabase((database) => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const row = this.row(database)
          incarnation = this.incarnation(database)
          const sealed = this.seal(data, row ? row.encrypted === 1 : false)
          encrypted = sealed.encrypted
          if (encrypted) this.beginEncrypted()
          if (!row) {
            // Only data read before anything was saved, or from this same database, may create the row.
            if (data.revision !== 0 || (data.incarnation !== '' && data.incarnation !== incarnation)) throw changed()
            database.prepare('INSERT INTO store (id, revision, fence, encrypted, payload) VALUES (1, 1, ?, ?, ?)').run(data.signInFence, sealed.encrypted ? 1 : 0, sealed.stored)
          } else {
            const result = database
              .prepare(
                "UPDATE store SET revision = revision + 1, fence = ?, encrypted = ?, payload = ? WHERE id = 1 AND revision = ? AND EXISTS (SELECT 1 FROM meta WHERE key = 'incarnation' AND value = ?)"
              )
              .run(data.signInFence, sealed.encrypted ? 1 : 0, sealed.stored, data.revision, data.incarnation)
            if (Number(result.changes) !== 1) throw changed()
          }
          database.exec('COMMIT')
        } catch (error) {
          try { database.exec('ROLLBACK') } catch { /* already rolled back */ }
          throw error
        }
      })
    } catch (error) {
      // A rejected write must not change the encryption policy: settle from the committed row.
      if (encrypted) this.settlePending()
      if (error instanceof CorruptDatabase) throw corrupt()
      throw error
    }
    if (encrypted) {
      storeHook?.('encrypted-committed')
      this.promoteEncrypted()
    }
    data.revision += 1
    data.incarnation = incarnation
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
