import type { ModelOverride } from '../../shared/providerInstances'
import { upgradeSelection } from '../../shared/modelSelection'
import type { PermissionMode } from '../../shared/permissionMode'
import { createErrorProvider } from '../../shared/errors'
import { isAgentAccessLevel, narrowAgentAccess, type AgentAccessLevel } from '../../shared/settings'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import { cacheSignature } from './FileSignature'
import { EventEmitter } from 'events'
import { v4 as uuidv4, v5 as uuidv5, validate as uuidValidate, version as uuidVersion } from 'uuid'
import type {
  Agent,
  ChatMessage,
  MousseAgentSessionSnapshot,
  NativeLlmContext,
  Project,
  QueuedMessage,
  SubagentWorkspaceBinding,
  Task,
  Thread,
  ThreadData,
  ThreadLineage,
  ThreadListVersion,
  ThreadRunsOn,
  ThreadSentFrom,
  ThreadStartedFrom
} from '../../shared/types'
import { isDefaultThreadName } from '../../shared/threadTitle'
import { visibleThreads } from '../../shared/threadLineage'
import { normalizeQueuedMessages } from '../queue/ThreadMessageQueue'
import type { QueueJournal } from '../queue/queueJournal'
import { withThreadDataMutationLock } from '../queue/ThreadExecutionLease'
import type { ProjectManager } from './ProjectManager'
import { getMousseHomeDir } from './paths'
import { atomicWriteJsonSync, fsyncDirectorySync } from './AtomicFs'
import { ThreadGenerationStore } from './ThreadGenerationStore'
import { ThreadRecoveryService } from './ThreadRecoveryService'
import { ThreadStorageLayout } from './ThreadStorageLayout'
import { ThreadStorageMigration } from './ThreadStorageMigration'
import { ThreadTrashService, type LegacyTrashDiagnostic } from './ThreadTrashService'
import { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import type { ThreadPullRequestLink } from '../../shared/pullRequests'
import { registerThreadLifecycleGate, withThreadLifecyclePath, withThreadLifecyclePaths } from '../queue/ThreadLifecycleAdmission'
import { FileLockBusyError, withFileLock } from '../scheduled/fileLock'
import { DomainRpcError } from '../protocol/domainRegistry'
import { pathsEqual } from '../profiles/pathSafety'
import {
  legacyFingerprint,
  readJsonFile,
  readLegacyThreadData,
  sameFingerprint,
  hasUnsettledGenerations,
  settleLegacyGenerations,
  ThreadDataCorruptionError,
  validateArray,
  type FileStamp
} from './legacyThreadData'
import { sharedThreadDbClient } from './threadDb/threadDbClient'
import { ThreadDbStore, type ThreadDataChange } from './threadDb/threadDbStore'
import { THREAD_DB_FILE } from './threadDb/threadDbEngine'
import { publishStagedBlobs } from './threadDb/threadBlobs'

export { ThreadDataCorruptionError } from './legacyThreadData'

interface ThreadMeta {
  id: string
  name: string
  projectId?: string
  createdAt: string
  updatedAt: string
  modelOverride?: ModelOverride
  permissionMode?: PermissionMode
  /** `Thread.settingsRevision`. */
  settingsRevision?: number
  /** `Thread.firstSendPending`. */
  firstSendPending?: true
  lineage?: ThreadLineage
  /** The thread whose agent launched this one with `thread_create`; not a subagent relation. */
  createdByThreadId?: string
  startedFrom?: ThreadStartedFrom
  /** See `Thread.sentFrom`. */
  sentFrom?: ThreadSentFrom
  /** See `Thread.runsOn`. */
  runsOn?: ThreadRunsOn
  /** See `Thread.localOnly`. Written only with the first `meta.json`. */
  localOnly?: true
  /** See `Thread.botOwned`. */
  botOwned?: true
  /** See `Thread.automationManager`. */
  automationManager?: true
  /** See `Thread.expiresAt`. */
  expiresAt?: string
  expiryStopsRun?: true
  /** See `Thread.accessCeiling`. */
  accessCeiling?: AgentAccessLevel
  workspaceBinding?: SubagentWorkspaceBinding
  scheduledJobId?: string
  /** Opt-in isolated git worktree. OFF by default; undefined treated as false. */
  worktreeEnabled?: boolean
  /** See `Thread.worktreeStartSha`. */
  worktreeStartSha?: string
  worktreeBaseBranch?: string
  pullRequest?: ThreadPullRequestLink
  order: number
  pinnedAt?: string
  settledAt?: string
  /** Set once the user commits the first message (send/enqueue). */
  startedAt?: string
}

interface ActiveThreadState {
  id: string
}

const threadErrors = createErrorProvider({
  thread_worktree_locked: { category: 'conflict', retryable: false, message: 'Worktree mode can only be changed before the first message.' }
})

export interface ThreadSearchResult {
  threadId: string
  threadName: string
  projectId?: string
  projectName?: string
  matchType: 'thread' | 'project' | 'message'
  snippet?: string
  messageId?: string
}

type ScoredSearchResult = ThreadSearchResult & { score: number }

interface SearchPlan {
  normalized: string
  projectNameById: Map<string, string>
  titles: ScoredSearchResult[]
  /** Threads that may match, in the order transcripts are read. */
  candidates: Thread[]
  /** The candidates whose transcripts a bounded scan reads. */
  scan: Thread[]
}

export interface MessagePageResult {
  messages: ChatMessage[]
  earlier?: { before: string; count: number }
  later?: { after: string; count: number }
  seq: number
  epoch: number
}

export type ThreadImportOutcome =
  | { status: 'imported'; messages: number }
  | { status: 'already' }
  | { status: 'failed'; reason: string }

export interface ThreadDataPatch {
  messages?: ChatMessage[]
  agents?: Agent[]
  tasks?: Task[]
  /** undefined preserves; null explicitly clears the durable context. */
  llmContext?: NativeLlmContext | null
  /** undefined preserves; null explicitly clears durable subagent sessions. */
  mousseAgentSessions?: MousseAgentSessionSnapshot[] | null
}

/** How often a thread in `thread.db` rewrites `meta.json` just to move `updatedAt` (`touchAfterSave`). */
const META_TOUCH_INTERVAL_MS = 30_000
/** How long a project's list lock held by another process is waited for (`withProjectListLock`). */
const LIST_LOCK_WAIT_MS = 5_000

/**
 * Orders for rows in a new sequence that keep as many rows' orders as they can: the longest run of rows whose orders
 * already rise in the new sequence keeps them, and every other row gets an order between its kept neighbours, so moving
 * one thread changes one row. When a gap is too small to split, every row is numbered again from 0.
 */
export function ordersKeeping(orders: readonly number[]): number[] {
  const n = orders.length
  // The longest strictly rising run (patience sorting): `tails[k]` ends the best run of length k + 1.
  const tails: number[] = []
  const previous = new Array<number>(n).fill(-1)
  for (let index = 0; index < n; index += 1) {
    const order = orders[index]!
    if (!Number.isFinite(order)) continue
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (orders[tails[middle]!]! < order) low = middle + 1
      else high = middle
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1
    tails[low] = index
  }
  const kept = new Array<boolean>(n).fill(false)
  for (let index = tails.length ? tails[tails.length - 1]! : -1; index >= 0; index = previous[index]!) kept[index] = true
  const renumbered = (): number[] => orders.map((_order, index) => index)
  if (!kept.some(Boolean)) return renumbered()
  const result = [...orders]
  let start = 0
  while (start < n) {
    if (kept[start]) { start += 1; continue }
    let end = start
    while (end < n && !kept[end]) end += 1
    // Rows start..end-1 move; they go between the kept rows around them.
    const below = start > 0 ? result[start - 1] : undefined
    const above = end < n ? result[end] : undefined
    const count = end - start
    for (let offset = 0; offset < count; offset += 1) {
      const value = below === undefined ? above! - count + offset
        : above === undefined ? below + 1 + offset
          : below + ((above - below) * (offset + 1)) / (count + 1)
      const floor = offset > 0 ? result[start + offset - 1]! : below
      if (!(floor === undefined || value > floor) || !(above === undefined || value < above)) return renumbered()
      result[start + offset] = value
    }
    start = end
  }
  return result
}

/** Runs `write`, and once more if the project's list lock was busy; a second busy list is thrown. */
function retryOnceWhenListBusy<T>(write: () => T): T {
  try {
    return write()
  } catch (error) {
    if (!(error instanceof ThreadListBusyError)) throw error
    return write()
  }
}

/** Refuses a conditional change of a thread's model or mode when its settings revision is no longer `ifRevision`. */
function refuseChangedRevision(thread: Thread, ifRevision: number): void {
  const revision = thread.settingsRevision ?? 0
  if (revision === ifRevision) return
  throw new DomainRpcError('thread_settings_changed', "This thread's model or permissions changed since it was read.", {
    threadId: thread.id,
    revision,
    ...(thread.modelOverride ? { modelOverride: thread.modelOverride } : {}),
    ...(thread.permissionMode ? { permissionMode: thread.permissionMode } : {})
  })
}

/** A project's list lock was not had in time (`LIST_LOCK_WAIT_MS`). Nothing was changed: the caller can try again. */
export class ThreadListBusyError extends Error {
  readonly code = 'thread_list_busy'
  constructor() {
    super('Thread list busy, try again.')
    this.name = 'ThreadListBusyError'
  }
}

/** Blocks for `ms`: the waits here are a few milliseconds, inside synchronous writes that cannot await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Marks a thread exported back to JSON (`exportThreadToJson`); it is not imported again by itself. */
const EXPORTED_MARKER = 'thread-db-exported.json'

/** Import and create files a crashed process left behind; an hour old, so none belongs to an import still running. */
function removeAbandonedImports(threadDir: string): void {
  const cutoff = Date.now() - 60 * 60_000
  for (const name of readdirSync(threadDir)) {
    if (!/^thread\.db\.(import|create)-/.test(name)) continue
    try {
      if (statSync(join(threadDir, name)).mtimeMs < cutoff) rmSync(join(threadDir, name), { recursive: true, force: true })
    } catch {
      // Gone already.
    }
  }
}

export function executionThreadId(executionKey: string): string {
  if (!executionKey || executionKey.length > 1024) throw new Error('Invalid execution thread key')
  return uuidv5('mousse-execution-thread:' + executionKey, uuidv5.URL)
}

/** What `searchThreads` is asked to do for a caller that may see only part of the profile. */
export interface ThreadSearchOptions {
  /** Subagent threads fold under their parent (see `visibleThreads`). */
  hideSubagents?: boolean
  /** Only threads this accepts are searched, applied before the limit. */
  allow?: (thread: Thread) => boolean
  /** Match titles and project names only; no transcript is read. */
  titlesOnly?: boolean
  /** Read transcripts of at most this many threads (the most recently updated first). */
  maxMessageThreads?: number
}

/** A thread's `meta.json`, with a reasoning level packed into its model (written before #490) moved into its own field. */
function readThreadMeta<T extends { modelOverride?: ModelOverride; settingsRevision?: number }>(path: string): T {
  const meta = JSON.parse(readFileSync(path, 'utf-8')) as T
  if (!meta || typeof meta !== 'object') return meta
  // A thread saved before the settings revision existed is at 0: said, so no reader has to guess it.
  const revised = typeof meta.settingsRevision === 'number' ? meta : { ...meta, settingsRevision: 0 }
  return revised.modelOverride ? { ...revised, modelOverride: upgradeSelection(revised.modelOverride) } : revised
}

export class ThreadDataStore extends EventEmitter {
  /**
   * The order of the first row of the user's other computers in a group (a project, or none), when there are
   * any. Set by the Bridge service while threads of other computers are merged into the lists. A thread of this
   * computer moved to the front of its group (or created in it) goes in front of those rows too.
   */
  remoteFloor?: (projectId: string | undefined) => number | undefined
  /**
   * Warm list cache. Invalidated on mutations; also keyed by project set so
   * opening/removing a project forces a rescan without an explicit invalidate call.
   */
  private listCache: Thread[] | null = null
  private listCacheProjectsKey: string | null = null
  private standaloneListCache: Thread[] | null = null
  private projectListCache = new Map<string, Thread[]>()
  private readonly storageLayout: ThreadStorageLayout
  private readonly storageMigration: ThreadStorageMigration
  readonly lifecycleStore: ResourceLifecycleStore
  private lifecycleMigrationDiagnostics: LegacyTrashDiagnostic[] = []

  constructor(private projectManager: ProjectManager, private readonly homeDir = getMousseHomeDir(), options: { allowLegacyProjectData?: boolean; profileId?: string } = {}) {
    super()
    this.storageLayout = new ThreadStorageLayout(homeDir, options.allowLegacyProjectData ?? true)
    this.storageMigration = new ThreadStorageMigration(this.storageLayout)
    this.lifecycleStore = new ResourceLifecycleStore({ profileId: options.profileId ?? 'default', profileHome: homeDir })
    registerThreadLifecycleGate(homeDir, this.lifecycleStore)
    this.refreshLegacyTrash()
  }

  refreshLegacyTrash(): LegacyTrashDiagnostic[] {
    const legacy = new ThreadTrashService(this.homeDir, { strictOwnedRoot: true }).inspectLegacy()
    const diagnostics = [...legacy.diagnostics]
    for (const record of legacy.records) {
      try {
        const managed = this.lifecycleStore.get(record.threadId)
        // A successful new restore supersedes the retained, immutable legacy index.
        if (managed?.locations.some((location) => pathsEqual(location, record.trashPath)) && pathsEqual(managed.originalLocation, record.originalPath)) continue
        this.lifecycleStore.adoptTrashedTask({ taskId: record.threadId, originalLocation: record.originalPath, location: record.trashPath })
      } catch (error) { diagnostics.push({ threadId: record.threadId, reason: (error as Error).message }) }
    }
    this.lifecycleMigrationDiagnostics = diagnostics
    return diagnostics.map((entry) => ({ ...entry }))
  }

  assertLifecycleMutationAvailable(): void {
    const diagnostics = this.refreshLegacyTrash()
    if (diagnostics.length) throw new Error(`Lifecycle migration is blocked: ${diagnostics.map((entry) => entry.reason).join('; ')}`)
  }

  /**
   * Threads kept in `thread.db` (`docs/thread-storage.md`). When on, new threads start in a database and older
   * threads are imported from their JSON files when they are first read. A thread that has a database always uses
   * it, whatever this says.
   */
  setSqliteStoreEnabled(enabled: boolean): void {
    this.sqliteOverride = enabled
  }

  sqliteStoreEnabled(): boolean {
    if (this.sqliteOverride !== undefined) return this.sqliteOverride
    const value = process.env.MOUSSE_SQLITE_THREAD_STORE
    return value === '1' || value === 'true'
  }

  private sqliteOverride?: boolean
  private threadDbStore?: ThreadDbStore

  private threadDb(): ThreadDbStore {
    if (!this.threadDbStore) this.threadDbStore = new ThreadDbStore(sharedThreadDbClient())
    return this.threadDbStore
  }

  /** True when the thread keeps its history in `thread.db`. */
  usesThreadDb(id: string): boolean {
    return ThreadDbStore.usesDb(this.getThreadDir(id))
  }

  /**
   * A page of a thread's visible messages, read in the read worker without loading the thread: the newest, or those
   * just before or after a message. `undefined` when the cursor message is not in the thread. `seq`/`epoch` are
   * where `changesSince` continues from.
   */
  async readMessagePage(id: string, request: { before?: string; after?: string; limit: number; maxBytes: number; images?: boolean }): Promise<MessagePageResult | undefined> {
    const page = await this.threadDb().client.call('page', this.getThreadDir(id), request)
    if (page.missing) return undefined
    return {
      messages: page.messages.map((payload) => JSON.parse(payload) as ChatMessage),
      ...(page.earlier ? { earlier: page.earlier } : {}),
      ...(page.later ? { later: page.later } : {}),
      seq: page.info.seq,
      epoch: page.info.epoch
    }
  }

  /**
   * The visible messages that changed since `seq`, oldest first, and the ids of those removed. `reset` means the
   * reader is too far behind (or the thread was renumbered) and starts again from a page.
   */
  async readMessageChanges(id: string, seq: number, epoch?: number): Promise<{ seq: number; epoch: number; reset: boolean; messages: ChatMessage[]; removed: string[] }> {
    const changes = await this.threadDb().client.call('messageChanges', this.getThreadDir(id), seq, epoch)
    return {
      seq: changes.info.seq,
      epoch: changes.info.epoch,
      reset: changes.reset,
      messages: changes.messages.map((row) => JSON.parse(row.payload) as ChatMessage),
      removed: changes.removed
    }
  }

  /** One message whole, images included, read without loading the thread. */
  async readMessage(id: string, messageId: string): Promise<ChatMessage | undefined> {
    const payload = await this.threadDb().client.call('messageById', this.getThreadDir(id), messageId)
    return payload === undefined ? undefined : (JSON.parse(payload) as ChatMessage)
  }

  /** The thread database's change sequence and epoch, or undefined for a JSON thread. */
  threadDbPosition(id: string): { seq: number; epoch: number } | undefined {
    const dir = this.getThreadDir(id)
    if (!ThreadDbStore.usesDb(dir)) return undefined
    const info = this.threadDb().info(dir)
    return { seq: info.seq, epoch: info.epoch }
  }

  /** How many transcript messages a thread folder holds, without loading them. */
  private messageCountAt(threadDir: string): number {
    if (ThreadDbStore.usesDb(threadDir)) return this.threadDb().messageCount(threadDir)
    return this.readJsonFile<unknown[]>(join(threadDir, 'messages.json'), []).length
  }

  /**
   * Closes this process's connections to a thread's database (checkpointing it) before its folder is moved or purged,
   * and forgets what it held. Nothing to do for a JSON thread.
   */
  quiesceThreadStorage(location: string): void {
    if (!existsSync(join(location, THREAD_DB_FILE))) return
    this.threadDb().client.quiesce(location)
    this.threadDb().forget(location)
  }

  /** Closes every connection this process holds to thread databases (before folders move or are purged). */
  quiesceAllThreadStorage(): void {
    const store = this.threadDbStore
    if (!store) return
    // What each thread holds in memory stays valid: every use checks the database's identity and sequence first.
    store.client.callSync('closeAll')
  }

  /** Writes back and closes the thread databases at shutdown; the next use opens them again. */
  closeThreadStorage(): void {
    this.stopBackgroundImport()
    this.flushMetaTouches()
    this.stopSearchIndexSweep()
    const store = this.threadDbStore
    if (!store) return
    try { store.client.callSync('closeAll') } catch { /* the workers may be gone */ }
    store.forgetAll()
  }

  private readonly importState = new Map<string, { running?: Promise<ThreadImportOutcome>; failures: number; retryAt: number }>()

  /** Starts an import of a JSON thread in the background, unless one ran or failed recently. */
  private scheduleImport(id: string): void {
    if (!this.sqliteStoreEnabled()) return
    const state = this.importState.get(id)
    // A thread exported for an older version stays on JSON until someone imports it on purpose.
    if (existsSync(join(this.getThreadDir(id), EXPORTED_MARKER))) return
    if (state?.running || (state && Date.now() < state.retryAt)) return
    // Never inside the read that noticed it: that read may hold the thread's lock.
    this.importState.set(id, { failures: state?.failures ?? 0, retryAt: Date.now() + 1_000 })
    setImmediate(() => { void this.importThreadStorage(id).catch(() => undefined) })
  }

  /**
   * Moves a JSON thread into `thread.db`: the read worker builds the database from the files and checks every row
   * against them; then, under the thread's lock, the files are checked unchanged and the database is published
   * (never over an existing one). The JSON files stay as they were, as a frozen backup. A failure leaves the thread
   * on JSON, writes the reason to `thread-db-import-error.json` and is retried later.
   */
  importThreadStorage(id: string): Promise<ThreadImportOutcome> {
    const state = this.importState.get(id) ?? { failures: 0, retryAt: 0 }
    if (state.running) return state.running
    this.importState.set(id, state)
    const running = this.runImport(id).then(
      (outcome) => {
        state.running = undefined
        if (outcome.status === 'failed') {
          state.failures += 1
          state.retryAt = Date.now() + Math.min(60 * 60_000, 60_000 * 2 ** Math.min(state.failures, 6))
        } else {
          state.failures = 0
        }
        return outcome
      },
      (error: unknown) => {
        state.running = undefined
        throw error
      }
    )
    state.running = running
    return running
  }

  private async runImport(id: string): Promise<ThreadImportOutcome> {
    const threadDir = this.getThreadDir(id)
    const errorPath = join(threadDir, 'thread-db-import-error.json')
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (ThreadDbStore.usesDb(threadDir)) return { status: 'already' }
        const fingerprint: FileStamp[] = withThreadDataMutationLock(threadDir, () => {
          removeAbandonedImports(threadDir)
          this.settleGenerations(threadDir, id)
          return legacyFingerprint(threadDir)
        })
        const tmpName = `${THREAD_DB_FILE}.import-${process.pid}-${uuidv4()}`
        const built = await this.threadDb().client.callImport('build', threadDir, { tmpName, fingerprint })
        if (!built.ok) continue
        const published = withThreadDataMutationLock(threadDir, () => {
          const tmp = join(threadDir, tmpName)
          try {
            if (ThreadDbStore.usesDb(threadDir)) return 'already' as const
            if (!sameFingerprint(legacyFingerprint(threadDir), fingerprint)) return 'stale' as const
            // The import's blobs first, then the database that refers to them.
            publishStagedBlobs(threadDir, `${tmp}.stage`)
            linkSync(tmp, join(threadDir, THREAD_DB_FILE))
            fsyncDirectorySync(threadDir)
            return 'published' as const
          } finally {
            rmSync(tmp, { force: true })
            rmSync(`${tmp}.stage`, { recursive: true, force: true })
          }
        })
        if (published === 'stale') continue
        rmSync(errorPath, { force: true })
        rmSync(join(threadDir, EXPORTED_MARKER), { force: true })
        if (published === 'already') return { status: 'already' }
        this.noteIndexChange(id, threadDir)
        this.emit('thread-storage-imported', { id, messages: built.messages })
        return { status: 'imported', messages: built.messages }
      }
      throw new Error('The thread kept changing while it was imported')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      try {
        atomicWriteJsonSync(errorPath, { failedAt: new Date().toISOString(), reason })
      } catch {
        // The folder may be gone (trashed meanwhile); the log line below still says why.
      }
      console.warn('thread storage import failed; the thread keeps using its JSON files', { threadId: id, reason })
      this.emit('thread-storage-import-failed', { id, reason })
      return { status: 'failed', reason }
    }
  }

  private readonly settledDirs = new Set<string>()

  /**
   * Ends a thread's use of the transactional store of earlier builds before anything reads or writes its JSON files
   * (`settleLegacyGenerations`), under the thread's lock. One stat when there is nothing to settle.
   */
  private settleGenerations(threadDir: string, id: string): void {
    if (this.settledDirs.has(threadDir)) return
    if (!existsSync(join(threadDir, 'manifest.json')) && (!existsSync(join(threadDir, 'generations')) || !hasUnsettledGenerations(threadDir))) {
      // Settled, or never used the transactional store; the folder is checked again only if a generation appears.
      if (existsSync(join(threadDir, 'generations'))) this.settledDirs.add(threadDir)
      return
    }
    withThreadDataMutationLock(threadDir, () => {
      const outcome = settleLegacyGenerations(threadDir, (data) => this.writeJsonFiles(threadDir, { ...data, messageQueue: [] }))
      if (outcome.kept === 'none') return
      fsyncDirectorySync(threadDir)
      if (outcome.ambiguous) {
        console.warn('thread files and generation differed and their times could not tell which was newer', { threadId: id, kept: outcome.kept, setAside: outcome.backup })
      }
    })
  }

  private backgroundImport?: { stopped: boolean }

  /**
   * Imports every listed thread that is still on JSON files, one at a time in the background, starting after
   * `delayMs`. Each import runs in a worker of its own. A thread whose import failed is tried again when its back-off
   * ends, in a later pass; the passes stop when no thread is waiting for one.
   */
  startBackgroundImport(options: { delayMs?: number; pauseMs?: number; recheckMs?: number } = {}): void {
    if (this.backgroundImport || !this.sqliteStoreEnabled()) return
    const run = { stopped: false }
    this.backgroundImport = run
    const pause = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.() })
    const active = () => !run.stopped && this.sqliteStoreEnabled()
    void (async () => {
      await pause(options.delayMs ?? 10_000)
      while (active()) {
        let nextRetry = Number.POSITIVE_INFINITY
        for (const thread of this.listAllThreads()) {
          if (!active()) break
          let threadDir: string
          try { threadDir = this.listedThreadDir(thread.id) } catch { continue }
          if (ThreadDbStore.usesDb(threadDir) || existsSync(join(threadDir, EXPORTED_MARKER))) continue
          const state = this.importState.get(thread.id)
          if (state?.running) {
            // An import a read started: wait for it, so a failure is still retried by this pass.
            await state.running.catch(() => undefined)
            const after = this.importState.get(thread.id)
            if (after && after.failures > 0 && !ThreadDbStore.usesDb(threadDir)) nextRetry = Math.min(nextRetry, after.retryAt)
            continue
          }
          if (state && Date.now() < state.retryAt) {
            if (state.failures > 0) nextRetry = Math.min(nextRetry, state.retryAt)
            continue
          }
          await this.importThreadStorage(thread.id).catch(() => undefined)
          const after = this.importState.get(thread.id)
          if (after && after.failures > 0) nextRetry = Math.min(nextRetry, after.retryAt)
          await pause(options.pauseMs ?? 50)
        }
        if (!Number.isFinite(nextRetry)) break
        // Woken at least every `recheckMs`, so a back-off cut short is not overslept.
        await pause(Math.min(Math.max(nextRetry - Date.now(), options.pauseMs ?? 50), options.recheckMs ?? 60_000))
      }
      if (this.backgroundImport === run) this.backgroundImport = undefined
    })()
  }

  stopBackgroundImport(): void {
    if (this.backgroundImport) this.backgroundImport.stopped = true
    this.backgroundImport = undefined
  }

  /** How many listed threads use thread.db, are still on JSON, or failed to import (with the reason). */
  threadStorageStatus(): { database: number; json: number; failed: Array<{ threadId: string; reason: string }> } {
    const status = { database: 0, json: 0, failed: [] as Array<{ threadId: string; reason: string }> }
    for (const thread of this.listAllThreads()) {
      let threadDir: string
      try { threadDir = this.listedThreadDir(thread.id) } catch { continue }
      if (ThreadDbStore.usesDb(threadDir)) { status.database += 1; continue }
      status.json += 1
      const error = readJsonFile<{ reason?: string } | undefined>(join(threadDir, 'thread-db-import-error.json'), undefined)
      if (error?.reason) status.failed.push({ threadId: thread.id, reason: error.reason })
    }
    return status
  }

  private readonly downgradeChecked = new Set<string>()

  /**
   * An older build that ran after the import wrote only the JSON files. Those writes are not merged (they could bring
   * back messages removed on purpose): the changed files are kept under `legacy-json/after-downgrade-<time>/` and
   * reported, and the database stays the thread's record.
   */
  private checkForDowngradeWrites(threadDir: string, id: string): void {
    if (this.downgradeChecked.has(threadDir)) return
    this.downgradeChecked.add(threadDir)
    try {
      const recorded = this.threadDb().client.callSync('getInfoValue', threadDir, 'jsonFingerprint')
      if (!recorded) return
      const current = legacyFingerprint(threadDir)
      if (sameFingerprint(current, JSON.parse(recorded) as FileStamp[])) return
      const target = join(threadDir, 'legacy-json', `after-downgrade-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      mkdirSync(target, { recursive: true })
      for (const stamp of current) {
        if (!stamp.exists || stamp.file.includes('/') || stamp.file.includes('\\')) continue
        copyFileSync(join(threadDir, stamp.file), join(target, stamp.file))
      }
      withThreadDataMutationLock(threadDir, () => {
        this.threadDb().save(threadDir, {}, { jsonFingerprint: JSON.stringify(current) })
      })
      console.warn('an older Mousse wrote this thread after it moved to thread.db; those writes are kept, not merged', { threadId: id, keptIn: target })
      this.emit('thread-storage-downgrade-writes', { id, keptIn: target })
    } catch (error) {
      console.warn('could not check a thread for writes by an older Mousse', { threadId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Writes a thread in `thread.db` back as the JSON files older builds read, for going back to one: the flat files
   * and `conversation-state.json`, the generation pointer set aside so either store mode reads them, then the
   * database renamed aside last. A crash before that rename leaves the database in charge, and exporting again
   * repeats the export.
   */
  exportThreadToJson(id: string): { exported: boolean; databaseKeptAs?: string } {
    const threadDir = this.getThreadDir(id)
    return withThreadDataMutationLock(threadDir, () => {
      if (!ThreadDbStore.usesDb(threadDir)) return { exported: false }
      const data = this.threadDb().load(threadDir)
      this.writeJsonFiles(threadDir, { ...data, messageQueue: undefined }, { conversationState: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const manifest = join(threadDir, 'manifest.json')
      if (existsSync(manifest)) renameSync(manifest, `${manifest}.before-export-${stamp}`)
      this.quiesceThreadStorage(threadDir)
      if (existsSync(join(threadDir, `${THREAD_DB_FILE}-wal`))) {
        throw new Error('The thread database is still open in another process; try again when it is idle')
      }
      const kept = join(threadDir, `${THREAD_DB_FILE}.exported-${stamp}`)
      atomicWriteJsonSync(join(threadDir, EXPORTED_MARKER), { exportedAt: new Date().toISOString(), database: kept })
      renameSync(join(threadDir, THREAD_DB_FILE), kept)
      fsyncDirectorySync(threadDir)
      this.downgradeChecked.delete(threadDir)
      return { exported: true, databaseKeptAs: kept }
    })
  }

  private projectsCacheKey(): string {
    return this.projectManager
      .listProjects()
      .map((project) => `${project.id}\0${project.path}`)
      .join('\n')
  }

  private invalidateListCache(): void {
    this.groupSignatures.clear()
    this.dirCache.clear()
    this.listCache = null
    this.listCacheProjectsKey = null
    this.standaloneListCache = null
    this.projectListCache.clear()
  }

  /**
   * Adds a thread this store just created to the warm lists of its group, so the listing that follows a
   * create (every client is sent the whole list) is rebuilt from memory instead of reading every thread's
   * `meta.json` and lifecycle record again. A group that is not cached yet is read from disk as before.
   */
  private addToListCaches(thread: Thread): void {
    this.listCache = null
    if (!this.isLifecycleVisible(thread.id)) {
      this.dropGroupCache(thread.projectId)
      return
    }
    const withThread = (threads: Thread[]): Thread[] =>
      this.sortThreads([...threads.filter((entry) => entry.id !== thread.id), { ...thread }])
    // A project's list was kept in step, or dropped, inside its lock by the write that made the thread
    // (`projectListWrite`); a group not cached is read from disk next time.
    if (!thread.projectId) {
      if (this.standaloneListCache) this.standaloneListCache = withThread(this.standaloneListCache)
    } else {
      const cached = this.projectListCache.get(thread.projectId)
      if (cached) this.projectListCache.set(thread.projectId, withThread(cached))
    }
  }

  /**
   * What a group's files looked like when its list was read. Standalone threads: the index. A project: its thread
   * folder (a thread folder added, moved away or deleted changes it) and the project's list revision, a token every
   * change to the project's thread metadata replaces under the project's list lock (`projectListWrite`), in this
   * process or another. A cached group is reused only while both are unchanged; correctness rests on the lock and the
   * token, the folder is an extra check. A hand edit of one `meta.json` changes neither and shows when the list is
   * next read from disk.
   *
   * A revision is written `pending:<id>` before the metadata write and `done:<id>` after it. A revision that is
   * pending (a writer that stopped between the two) or cannot be read gives no signature, so no process reuses that
   * project's list until a write finishes cleanly; a write that cannot mark its revision pending fails before it
   * changes anything.
   */
  private readonly groupSignatures = new Map<string, string>()
  /** Projects whose list lock this store holds (`projectListWrite`): a nested write is part of the outer one. */
  private readonly heldProjectLocks = new Set<string>()

  private listRevisionPath(projectId: string): string {
    return join(this.homeDir, 'thread-list-revisions', `${basename(this.storageLayout.repositoryRoot(projectId))}.rev`)
  }

  private listLockPath(projectId: string): string {
    return join(this.homeDir, 'thread-list-revisions', `${basename(this.storageLayout.repositoryRoot(projectId))}.lock`)
  }

  /** The project's revision as written: `'-'` when there is none yet, undefined when it cannot be read. */
  private readRevisionToken(projectId: string): string | undefined {
    try {
      return readFileSync(this.listRevisionPath(projectId), 'utf8')
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? '-' : undefined
    }
  }

  /** A file's or folder's `cacheSignature`; `'-'` when it does not exist, undefined when its stats can't be trusted. */
  private stamp(path: string): string | undefined {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false })
    return stat ? cacheSignature(stat) : '-'
  }

  /** Undefined on a file system whose stats cannot be trusted to change (`cacheSignature`): the group is read every time. */
  private groupSignature(projectId?: string): string | undefined {
    if (!projectId) return this.stamp(join(this.homeDir, 'threads-index.json'))
    const folder = this.stamp(this.storageLayout.repositoryRoot(projectId))
    if (folder === undefined) return undefined
    const revision = this.readRevisionToken(projectId)
    if (revision === undefined || (revision !== '-' && !revision.startsWith('done:'))) return undefined
    return `${folder}|${revision}`
  }

  /**
   * Replaces a project's list revision with `<phase>:<id>` and returns it. Throws when it cannot, after a few tries
   * for a reader holding the file open (a Windows sharing violation).
   */
  private publishListRevision(projectId: string, phase: 'pending' | 'done'): string {
    const path = this.listRevisionPath(projectId)
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        mkdirSync(join(this.homeDir, 'thread-list-revisions'), { recursive: true })
        const content = `${phase}:${uuidv4()}`
        writeFileSync(path, content)
        return content
      } catch (error) {
        lastError = error
        const code = (error as NodeJS.ErrnoException)?.code
        if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') break
        sleepSync(20 * (attempt + 1))
      }
    }
    throw new Error(`The thread list revision ${path} could not be written: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  /**
   * The project's list lock, across processes (`withFileLock`). It is the innermost lock: every lifecycle gate a
   * write under it needs is taken before it (`withLifecycleGates`, `withPathGates`; those gates are re-entrant in a
   * process, so the writes under it only re-enter them), and it is held only for synchronous file writes, never across
   * an await. Nothing under it waits on, or fails for, another lock. Another process holding it is waited for, a few
   * milliseconds at a time, for up to LIST_LOCK_WAIT_MS; then `ThreadListBusyError`, with nothing changed.
   */
  private withProjectListLock<T>(projectId: string, fn: () => T): T {
    const path = this.listLockPath(projectId)
    mkdirSync(join(this.homeDir, 'thread-list-revisions'), { recursive: true })
    const deadline = Date.now() + LIST_LOCK_WAIT_MS
    for (;;) {
      let started = false
      try {
        return withFileLock(path, () => {
          started = true
          return fn()
        })
      } catch (error) {
        if (started || !(error instanceof FileLockBusyError)) throw error
        if (Date.now() >= deadline) throw new ThreadListBusyError()
        sleepSync(5 + Math.floor(Math.random() * 10))
      }
    }
  }

  /** Takes these lifecycle gates by task id (re-entrant in a process), one after another, then runs `fn` under them. */
  private withLifecycleGates<T>(taskIds: readonly string[], fn: () => T): T {
    return this.lifecycleStore.withGates(taskIds, fn)
  }

  /** Takes the lifecycle admission of each path for a write (the gates its own write takes), in one loop, then runs `fn`. */
  private withPathGates<T>(paths: readonly string[], fn: () => T): T {
    return withThreadLifecyclePaths(paths, 'write', fn)
  }

  /** A task and its owners, the outermost owner first, as lifecycle records name them. */
  private lifecycleChain(taskId: string | undefined): string[] {
    const ids: string[] = []
    const seen = new Set<string>()
    for (let id = taskId; id && !seen.has(id); id = this.lifecycleStore.get(id)?.parentTaskId) {
      seen.add(id)
      ids.unshift(id)
    }
    return ids
  }

  /**
   * One change to a project's thread metadata (a create, rename, pin, settle, reorder, trash or restore), under the
   * project's list lock:
   * 1. the revision is read; when it is not the one this store last saw for the project (or the store has no list of
   *    it), the cached list is dropped and `write` is told so (`cacheTrusted` false);
   * 2. the revision is marked pending, `write` runs, and the revision is marked done with a new id;
   * 3. only then is this store's signature for the project moved to the new revision, if its list was trusted
   *    throughout. Another store of this process writing inside the same lock (it is re-entrant per process) shows as a
   *    revision that is no longer this write's pending one, and the list is dropped too. A write that adds or removes
   *    no thread folder (`changesFolder` unset) must also find the project's folder as it was before it: a trash or
   *    restore another process made meanwhile moved a folder outside this lock, and the list is dropped.
   */
  private projectListWrite<T>(
    projectId: string,
    write: (cacheTrusted: boolean) => T,
    options: { repair?: boolean; changesFolder?: boolean } = {}
  ): T {
    if (this.heldProjectLocks.has(projectId)) return write(this.projectListCache.has(projectId))
    return this.withProjectListLock(projectId, () => {
      // Trusted only while nothing changed since this store's list was read: the same revision, and the same folder.
      // Every change to the project's folder (a create's `mkdir`, a discard's removal) is made under this lock.
      const current = this.groupSignature(projectId)
      const recorded = this.groupSignatures.get(projectId)
      let trusted = current !== undefined && recorded !== undefined && this.projectListCache.has(projectId) && current === recorded
      if (!trusted) this.dropGroupCache(projectId)
      let pending: string | undefined
      try {
        pending = this.publishListRevision(projectId, 'pending')
      } catch (error) {
        // A repair made while reading a list goes ahead without it; that read is not reused.
        this.dropGroupCache(projectId)
        if (!options.repair) throw error
        trusted = false
      }
      this.heldProjectLocks.add(projectId)
      let result: T
      try {
        result = write(trusted)
      } finally {
        this.heldProjectLocks.delete(projectId)
      }
      const folderAfterWrite = this.stamp(this.storageLayout.repositoryRoot(projectId))
      if (pending === undefined || this.readRevisionToken(projectId) !== pending) trusted = false
      if (!options.changesFolder && folderAfterWrite !== current?.split('|')[0]) trusted = false
      let done: string
      try {
        done = this.publishListRevision(projectId, 'done')
      } catch {
        // The revision stays pending: no process reuses this project's list until a later write finishes.
        this.dropGroupCache(projectId)
        return result
      }
      // Recorded only if, after publishing, the revision is this write's and the folder is as this write left it.
      const signature = trusted ? this.groupSignature(projectId) : undefined
      if (signature !== undefined && signature === `${folderAfterWrite}|${done}`) this.groupSignatures.set(projectId, signature)
      else this.dropGroupCache(projectId)
      return result
    })
  }

  /**
   * Writes a thread's `meta.json` as `change` makes it from the thread as it is now. A project thread is written under
   * its project's list lock: from `known` while this store's list of the project is trusted, else from its `meta.json`
   * read again under the lock, so a change another process made since `known` was read (a mode, a rename) is kept and
   * the settings revision moves on from the one on disk. A standalone thread is written from `known`, as before.
   */
  private writeThreadMeta<T extends Thread>(known: T, change: (base: T, cacheTrusted: boolean) => T): T {
    const path = join(this.getThreadDir(known.id), 'meta.json')
    const projectId = known.projectId
    if (!projectId) {
      const updated = change(this.metaOnDisk(path, known), false)
      this.writeJsonAtomic(path, updated)
      return updated
    }
    return this.withPathGates([path], () => this.projectListWrite(projectId, (cacheTrusted) => {
      const updated = change(cacheTrusted ? known : this.metaOnDisk(path, known), cacheTrusted)
      atomicWriteJsonSync(path, updated)
      return updated
    }))
  }

  /**
   * Whether the project's folder holds a thread `listed` lacks: one with readable metadata that the lifecycle store
   * shows (or has no record of yet). Read only: no registration, no repair, nothing that would take another lock.
   */
  private unlistedThreadInFolder(projectId: string, listed: ReadonlySet<string>): boolean {
    let entries: string[] = []
    try {
      entries = readdirSync(this.storageLayout.repositoryRoot(projectId), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return false
    }
    for (const name of entries) {
      try {
        const id = readThreadMeta<Thread>(join(this.storageLayout.repositoryRoot(projectId), name, 'meta.json')).id
        if (!listed.has(id) && this.isLifecycleVisible(id)) return true
      } catch {
        // A folder without readable metadata is no thread of the list.
      }
    }
    return false
  }

  /** A thread's `meta.json` as it is now, or `known` when it cannot be read as that thread. */
  private metaOnDisk<T extends Thread>(path: string, known: T): T {
    try {
      const meta = readThreadMeta<T>(path)
      return meta.id === known.id ? meta : known
    } catch {
      return known
    }
  }

  /**
   * The order for a new thread of a project, under its list lock: below every order of its trusted list, or, when the
   * list is not trusted, below every order on disk (each thread folder's `meta.json`, read directly: no lifecycle
   * lookups, which would take other locks under this one).
   */
  private projectOrderUnderLock(projectId: string, cacheTrusted: boolean): number {
    const floor = this.remoteFloor?.(projectId)
    let orders: number[]
    if (cacheTrusted) {
      orders = (this.projectListCache.get(projectId) ?? []).map((thread) => thread.order)
    } else {
      orders = []
      const root = this.storageLayout.repositoryRoot(projectId)
      let entries: string[] = []
      try {
        entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      } catch {
        // No thread folder yet.
      }
      for (const name of entries) {
        try {
          const order = readThreadMeta<Thread>(join(root, name, 'meta.json')).order
          if (Number.isFinite(order)) orders.push(order)
        } catch {
          // A folder without readable metadata (being made, or damaged) has no order to stay below.
        }
      }
    }
    return orders.reduce((min, order) => Math.min(min, order), Math.min(0, floor ?? 0)) - 1
  }

  private dropGroupCache(projectId?: string): void {
    this.listCache = null
    this.groupSignatures.delete(projectId ?? '')
    if (projectId) this.projectListCache.delete(projectId)
    else this.standaloneListCache = null
  }

  /** Reads a cached group from disk again when its files changed since it was read (see `groupSignatures`). */
  private refreshGroupIfChanged(projectId?: string): void {
    if (this.groupStale(projectId)) this.dropGroupCache(projectId)
  }

  /** A cached group whose files changed since it was read, or whose list was never certified by a signature. */
  private groupStale(projectId?: string): boolean {
    const cached = projectId ? this.projectListCache.has(projectId) : this.standaloneListCache !== null
    if (!cached) return false
    const recorded = this.groupSignatures.get(projectId ?? '')
    return recorded === undefined || recorded !== this.groupSignature(projectId)
  }

  /**
   * Reads a group from disk with a signature that held for the whole read: taken before and after, and read again
   * when something changed it meanwhile (another process writing mid-scan). After three tries the list is kept without
   * a signature, so it is read again next time.
   */
  private readGroup(projectId: string | undefined, read: () => Thread[]): Thread[] {
    let threads: Thread[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.groupSignature(projectId)
      threads = read()
      const after = this.groupSignature(projectId)
      if (before !== undefined && before === after) {
        this.groupSignatures.set(projectId ?? '', before)
        return threads
      }
      this.groupSignatures.delete(projectId ?? '')
      // Without a trusted signature at all (an untrusted file system, a pending revision) another read cannot help.
      if (before === undefined || after === undefined) return threads
    }
    return threads
  }

  /** Replace one thread in the warm cache (avoids full rescan after meta updates). */
  private patchListCache(thread: Thread): void {
    if (this.listCache) {
      const idx = this.listCache.findIndex((entry) => entry.id === thread.id)
      if (idx >= 0) this.listCache[idx] = thread
      else this.listCache = null
    }
    if (!thread.projectId) {
      if (this.standaloneListCache) {
        const idx = this.standaloneListCache.findIndex((entry) => entry.id === thread.id)
        if (idx >= 0) this.standaloneListCache[idx] = thread
        else this.standaloneListCache = null
      }
    } else {
      const cached = this.projectListCache.get(thread.projectId)
      if (cached) {
        const idx = cached.findIndex((entry) => entry.id === thread.id)
        if (idx >= 0) cached[idx] = thread
        else this.projectListCache.delete(thread.projectId)
      }
    }
  }

  /**
   * `lineage`, `modelOverride`, `workspaceBinding` and `scheduledJobId` are written with the first
   * `meta.json`, so a subagent or a scheduled per-run thread never exists without them. `ownerThreadId` makes the new thread owned by that thread in
   * the lifecycle store: trashing, restoring or purging the owner takes this thread along.
   */
  createThread(
    name: string,
    projectId?: string,
    projectPath?: string,
    opts?: {
      /**
       * The id the thread gets, for a command that decided it before creating anything and may have to
       * finish creating it after a crash. An id that already names a thread is refused.
       */
      id?: string
      /**
       * The thread counts as started from the first write: it is listed, and the app's "New chat" never reuses it as an
       * empty draft. For a thread something other than a person's first message creates.
       */
      started?: boolean
      /** See `Thread.firstSendPending`: the thread is made for a message a window is about to send. */
      firstSendPending?: boolean
      worktreeEnabled?: boolean
      lineage?: ThreadLineage
      modelOverride?: ModelOverride
      permissionMode?: PermissionMode
      workspaceBinding?: SubagentWorkspaceBinding
      ownerThreadId?: string
      /** Never `ownerThreadId`: a launched thread is neither nested under nor deleted with its creator. */
      createdByThreadId?: string
      /** See `Thread.accessCeiling`. */
      accessCeiling?: AgentAccessLevel
      scheduledJobId?: string
      /** See `Thread.runsOn`: a remote subagent's stand-in. */
      runsOn?: ThreadRunsOn
      /** See `Thread.localOnly`. */
      localOnly?: boolean
      /** See `Thread.expiresAt`; checked by the caller. */
      expiresAt?: string
      expiryStopsRun?: boolean
      /** See `Thread.worktreeStartSha`; resolved by the caller. */
      worktreeStart?: { sha: string; branch: string }
    }
  ): Thread {
    const id = opts?.id ?? uuidv4()
    if (opts?.id && this.getThread(opts.id)) throw new Error(`Thread ${opts.id} already exists`)
    const now = new Date().toISOString()
    const meta: ThreadMeta = {
      id,
      name,
      projectId,
      createdAt: now,
      updatedAt: now,
      // A project thread's order is taken under the project's list lock, with its first write (below).
      order: projectId ? 0 : this.nextThreadOrder()
    }
    if (opts?.started === true) meta.startedAt = now
    if (opts?.firstSendPending === true) meta.firstSendPending = true
    // `false` is kept: a thread that chose its project's folder never gets a worktree (`WorkspaceResolver`).
    if (typeof opts?.worktreeEnabled === 'boolean') meta.worktreeEnabled = opts.worktreeEnabled
    if (opts?.lineage) meta.lineage = structuredClone(opts.lineage)
    if (opts?.createdByThreadId) meta.createdByThreadId = opts.createdByThreadId
    if (isAgentAccessLevel(opts?.accessCeiling)) meta.accessCeiling = opts.accessCeiling
    if (opts?.modelOverride) meta.modelOverride = structuredClone(opts.modelOverride)
    if (opts?.permissionMode) meta.permissionMode = opts.permissionMode
    meta.settingsRevision = 0
    if (opts?.workspaceBinding) meta.workspaceBinding = structuredClone(opts.workspaceBinding)
    if (opts?.scheduledJobId) meta.scheduledJobId = opts.scheduledJobId
    if (opts?.runsOn) meta.runsOn = structuredClone(opts.runsOn)
    if (opts?.localOnly === true) meta.localOnly = true
    if (opts?.expiresAt) meta.expiresAt = opts.expiresAt
    if (opts?.expiresAt && opts.expiryStopsRun === true) meta.expiryStopsRun = true
    if (opts?.worktreeStart) {
      meta.worktreeStartSha = opts.worktreeStart.sha
      meta.worktreeBaseBranch = opts.worktreeStart.branch
    }

    try {
      const threadDir = this.resolveThreadDir(meta, projectPath)
      // An owner without a lifecycle record yet (an older thread) is registered first; the child's
      // registration requires an active owner.
      if (opts?.ownerThreadId) this.getThreadDir(opts.ownerThreadId)
      const register = (): void => {
        this.lifecycleStore.registerTask({ taskId: id, location: threadDir, parentTaskId: opts?.ownerThreadId, creating: true })
      }

      if (projectId) {
        // A project's cached list must still match the disk before this create changes its folder.
        this.refreshGroupIfChanged(projectId)
        // The gates the registration and the first writes take (the registry, the owners, the thread), then the
        // project's list lock, and only then any change: a lock not had in time leaves nothing made.
        this.withLifecycleGates(['_registry', ...this.lifecycleChain(opts?.ownerThreadId), id], () => {
          this.projectListWrite(projectId, (cacheTrusted) => {
            register()
            this.ensureThreadDir(threadDir)
            meta.order = this.projectOrderUnderLock(projectId, cacheTrusted)
            atomicWriteJsonSync(join(threadDir, 'meta.json'), meta)
          }, { changesFolder: true })
        })
      } else {
        register()
        this.ensureThreadDir(threadDir)
        this.writeJsonAtomic(join(threadDir, 'meta.json'), meta)
      }
      if (this.sqliteStoreEnabled()) {
        this.threadDb().client.callSync('create', threadDir)
      } else {
        this.writeJsonAtomic(join(threadDir, 'messages.json'), [])
        this.writeJsonAtomic(join(threadDir, 'agents.json'), [])
        this.writeJsonAtomic(join(threadDir, 'tasks.json'), [])
      }
      mkdirSync(join(threadDir, 'terminals'), { recursive: true })

      if (!projectId) {
        this.addToStandaloneIndex(meta)
      }
    } catch (error) {
      // A half-made thread may be on disk: the next listing reads it from there.
      this.invalidateListCache()
      throw error
    }
    this.addToListCaches(meta)

    // This is the authoritative creation notification for every producer:
    // GUI/CLI protocol calls, remote sends, and scheduled jobs.
    this.emit('created', meta)
    return meta
  }

  /**
   * Removes a thread `createThread` made moments ago whose creating command failed before anything
   * used it: its directory, standalone index entry and lifecycle registration. Refuses a thread
   * that already has messages (that is a real thread; trash it through the lifecycle coordinator).
   * An owned subagent is discarded only while its registration still names the owner its lineage
   * says started it; anything else is refused before a file is touched.
   */
  discardUnusedThread(id: string): void {
    const meta = this.getThread(id)
    if (!meta) return
    const threadDir = this.resolveThreadDir(meta)
    const owner = this.lifecycleStore.get(id)?.parentTaskId
    if (owner && owner !== meta.lineage?.parentThreadId)
      throw new Error(`Thread ${id} is owned by ${owner}; only an unused new subagent can be discarded`)
    if (this.messageCountAt(threadDir))
      throw new Error(`Thread ${id} has messages; only an unused new thread can be discarded`)
    this.quiesceThreadStorage(threadDir)
    // The registration goes first: it is the step that can refuse, and a crash after it leaves an
    // unowned empty thread that `discardOrphanedSubagents` removes at the next start, rather than a
    // registration of a missing directory that would stall its owner's trash.
    const forget = (): void => { this.lifecycleStore.forgetCreatedTask(id, owner ? { ownedBy: owner } : undefined) }
    const projectId = meta.projectId
    if (projectId) {
      // The gates forgetting takes, then the project's list lock, and only then any change: a lock not had in time
      // leaves the thread as it was.
      this.withLifecycleGates(['_registry', id], () => {
        this.projectListWrite(projectId, () => {
          forget()
          rmSync(threadDir, { recursive: true, force: true })
        }, { changesFolder: true })
      })
    } else {
      forget()
      this.removeFromStandaloneIndex(id)
      rmSync(threadDir, { recursive: true, force: true })
    }
    this.invalidateListCache()
    // `created` announced it; clients must hear it is gone.
    this.emit('discarded', { id })
  }

  /**
   * Boot repair: a subagent thread whose creating command died before its run-store rows committed
   * has lineage in its metadata but none in the run store. When it is still empty it is discarded.
   * `hasLineageRow` is the run store's answer for a thread id. Returns the discarded ids.
   *
   * `createThread` registers ownership before it writes `meta.json` and the standalone index entry
   * (the writes need the registration), so a death in between leaves an owned lifecycle record no
   * thread listing shows. Those records are found through the lifecycle inventory and discarded too.
   */
  discardOrphanedSubagents(hasLineageRow: (threadId: string) => boolean): string[] {
    const discarded: string[] = []
    for (const thread of this.listAllThreads().filter((entry) => entry.lineage && !hasLineageRow(entry.id))) {
      try {
        this.discardUnusedThread(thread.id)
        discarded.push(thread.id)
      } catch (error) {
        console.warn('orphaned subagent thread kept', { threadId: thread.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    discarded.push(...this.discardHalfCreatedOwnedThreads(hasLineageRow))
    return discarded
  }

  /**
   * Owned threads whose creation died after registration: no `meta.json`, or (standalone) a
   * `meta.json` that never reached the index. Only an empty one without a run-store row, under an
   * owner chain that is still active, is removed: its registration, directory and index entry.
   */
  private discardHalfCreatedOwnedThreads(hasLineageRow: (threadId: string) => boolean): string[] {
    const discarded: string[] = []
    let indexed: Set<string> | undefined
    for (const record of this.lifecycleStore.list()) {
      if (!record.parentTaskId || record.state !== 'active') continue
      const id = record.taskId
      // Workflow execution threads (v5 ids) are owned too, but their admission retries and keeps them.
      if (!uuidValidate(id) || uuidVersion(id) !== 4) continue
      try {
        if (hasLineageRow(id) || !this.isLifecycleVisible(id)) continue
        const metaPath = join(record.location, 'meta.json')
        const meta = existsSync(metaPath) ? this.readJsonFile<ThreadMeta | null>(metaPath, null) : null
        if (meta) {
          indexed ??= new Set(this.readStandaloneIndexRaw().map((entry) => entry.id))
          // Project threads are listed by scanning their directories, so only a standalone one can miss.
          if (meta.projectId || indexed.has(id)) continue
        }
        if (this.messageCountAt(record.location)) continue
        this.quiesceThreadStorage(record.location)
        this.lifecycleStore.forgetCreatedTask(id, { ownedBy: record.parentTaskId })
        if (meta && !meta.projectId) this.removeFromStandaloneIndex(id)
        rmSync(record.location, { recursive: true, force: true })
        discarded.push(id)
      } catch (error) {
        console.warn('half-created owned thread kept', { threadId: id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (discarded.length) {
      this.invalidateListCache()
      this.emit('list-changed', {})
    }
    return discarded
  }

  /**
   * Daemon-owned execution admission: retry/crash recovery keeps one thread and its data.
   * `botOwned` marks a personal bot's thread (`Thread.botOwned`), also one made before the mark existed.
   */
  ensureExecutionThread(executionKey: string, name: string, projectId?: string, ownership?: { parentTaskId: string; runId?: string }, opts?: { localOnly?: boolean; botOwned?: boolean; automationManager?: boolean }): Thread {
    const project = projectId ? this.projectManager.getProject(projectId) : undefined
    if (projectId && !project) throw new Error('Execution project is unavailable')
    const id = executionThreadId(executionKey)
    if (this.lifecycleMigrationDiagnostics.some((entry) => !entry.threadId || entry.threadId === id)) {
      throw new Error('Execution thread identity has unresolved legacy trash ownership')
    }
    const now = new Date().toISOString()
    const initial: ThreadMeta = { id, name, projectId, createdAt: now, updatedAt: now, startedAt: now, order: this.nextThreadOrder(projectId) }
    if (opts?.localOnly === true) initial.localOnly = true
    if (opts?.botOwned === true) initial.botOwned = true
    if (opts?.automationManager === true) initial.automationManager = true
    const threadDir = this.resolveThreadDir(initial, project?.path)
    this.lifecycleStore.registerTask({ taskId: id, location: threadDir, parentTaskId: ownership?.parentTaskId, creating: true })
    this.ensureThreadDir(threadDir)
    return withThreadLifecyclePath(threadDir, 'write', () => withFileLock(join(threadDir, '.execution-init.lock'), () => {
      const metaPath = join(threadDir, 'meta.json')
      let meta = existsSync(metaPath) ? readThreadMeta<ThreadMeta>(metaPath) : initial
      if (meta.id !== id || meta.projectId !== projectId || meta.settledAt) throw new Error('Execution thread identity or state changed')
      if (opts?.botOwned === true && !meta.botOwned && meta !== initial) {
        meta = { ...meta, botOwned: true }
        this.writeJsonAtomic(metaPath, meta)
        const entry = projectId ? undefined : this.readStandaloneIndexRaw().find((thread) => thread.id === id)
        if (entry) this.updateStandaloneIndexEntry({ ...entry, botOwned: true })
      }
      // A previous process may have died between these writes. Preserve every
      // file already present, including messages produced after admission.
      if (this.sqliteStoreEnabled() && !existsSync(join(threadDir, 'messages.json'))) {
        if (!ThreadDbStore.usesDb(threadDir)) this.threadDb().client.callSync('create', threadDir)
      } else if (!ThreadDbStore.usesDb(threadDir)) {
        for (const file of ['messages.json', 'agents.json', 'tasks.json']) {
          const path = join(threadDir, file)
          if (!existsSync(path)) this.writeJsonAtomic(path, [])
        }
      }
      if (!existsSync(metaPath)) this.writeJsonAtomic(metaPath, meta)
      const indexed = !projectId && this.readStandaloneIndexRaw().some((entry) => entry.id === id)
      if (!projectId && !indexed) this.addToStandaloneIndex(meta)
      this.invalidateListCache()
      if (meta === initial || (!projectId && !indexed)) this.emit('created', meta)
      return meta
    }))
  }

  /**
   * Marks each of `threadIds` that is still listed as a personal bot's (`Thread.botOwned`), without
   * touching it: a bot's thread made by an earlier build, or by a bot that never runs again, leaves the
   * lists once its bots.db opens. Returns how many it marked.
   */
  markBotOwned(threadIds: Iterable<string>): number {
    let marked = 0
    for (const id of new Set(threadIds)) {
      const thread = this.getThread(id)
      if (!thread || thread.botOwned) continue
      const updated = this.writeThreadMeta(thread, (base) => ({ ...base, botOwned: true }))
      if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
      this.patchListCache(updated)
      this.emit('updated', updated)
      marked += 1
    }
    return marked
  }

  /** Projects owning grouped threads, in the same order as the desktop sidebar. */
  listProjects(): Project[] {
    return this.projectManager.listProjects()
  }

  listThreads(projectId?: string): Thread[] {
    // A cached group is reused only while its files are as they were when it was read.
    this.refreshGroupIfChanged(projectId)
    if (projectId) {
      const cached = this.projectListCache.get(projectId)
      if (cached) return cached
      const project = this.projectManager.getProject(projectId)
      if (!project) return []
      const threads = this.readGroup(projectId, () => this.scanProjectThreads(project.path))
      this.projectListCache.set(projectId, threads)
      return threads
    }
    if (this.standaloneListCache) return this.standaloneListCache
    const standalone = this.readGroup(undefined, () => this.readStandaloneIndex())
    this.standaloneListCache = standalone
    return standalone
  }

  /** See `ThreadListVersion`: names each snapshot `listAllThreads` takes. */
  private readonly listEpoch = uuidv4()
  private listSeq = 0

  /** `listAllThreads()` with the version of the snapshot it returns, for what is sent to windows. */
  listAllThreadsVersioned(): { threads: Thread[]; version: ThreadListVersion } {
    const threads = this.listAllThreads()
    return { threads, version: { epoch: this.listEpoch, seq: this.listSeq } }
  }

  listAllThreads(): Thread[] {
    this.listSeq += 1
    const projectsKey = this.projectsCacheKey()
    // Every group is checked, not only one a create touched: another process may have changed any of them.
    if (this.listCache && this.listCacheProjectsKey === projectsKey) {
      const stale = [undefined, ...this.projectManager.listProjects().map((project) => project.id)].filter((id) => this.groupStale(id))
      if (!stale.length) return this.listCache
      for (const id of stale) this.dropGroupCache(id)
    }
    // Project set/path changed — drop per-project caches so we do not reuse
    // threads scanned from a previous project path for the same id.
    if (this.listCacheProjectsKey !== projectsKey) {
      this.projectListCache.clear()
      this.listCache = null
    }
    const standalone = this.listThreads()
    const projectThreads = this.projectManager.listProjects().flatMap((project) =>
      this.listThreads(project.id)
    )
    this.listCache = [...standalone, ...projectThreads]
    this.listCacheProjectsKey = projectsKey
    return this.listCache
  }

  /**
   * `listThreads(projectId)` without the subagent threads that sit under a parent. For clients that
   * show threads as a flat list; the parents are looked up in the complete inventory, so
   * a subagent whose parent is in another project, or gone, is still judged correctly.
   */
  listVisibleThreads(projectId?: string): Thread[] {
    return visibleThreads(this.listThreads(projectId), this.listAllThreads())
  }

  /** `listAllThreads()` without the subagent threads that sit under a parent. */
  listAllVisibleThreads(): Thread[] {
    return visibleThreads(this.listAllThreads())
  }

  private isLifecycleVisible(id: string): boolean {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current) {
      if (seen.has(current)) throw new Error('Cyclic lifecycle task ownership')
      seen.add(current)
      const record = this.lifecycleStore.get(current)
      if (!record) return true
      if (record.state !== 'active') return false
      current = record.parentTaskId
    }
    return true
  }

  getThread(id: string): Thread | undefined {
    if (!this.isLifecycleVisible(id)) return undefined
    // Prefer warm list cache (common after list/setModel/pin paths).
    if (this.listCache && this.listCacheProjectsKey === this.projectsCacheKey()) {
      const hit = this.listCache.find((t) => t.id === id)
      if (hit) return hit
    }
    if (this.standaloneListCache) {
      const hit = this.standaloneListCache.find((t) => t.id === id)
      if (hit) return hit
    }
    for (const threads of this.projectListCache.values()) {
      const hit = threads.find((t) => t.id === id)
      if (hit) return hit
    }

    const standalone = this.readStandaloneIndex().find((t) => t.id === id)
    if (standalone) return standalone

    for (const project of this.projectManager.listProjects()) {
      const targetMetaPath = join(this.storageLayout.repositoryThreadDir(project.id, id), 'meta.json')
      const legacyMetaPath = join(this.storageLayout.legacyRepositoryThreadDir(project.path, id), 'meta.json')
      if (existsSync(targetMetaPath) || (this.storageLayout.allowLegacyProjectData && existsSync(legacyMetaPath))) {
        const threadDir = this.storageMigration.migrateRepository(project.path, project.id, id)
        if (!this.lifecycleStore.get(id)) this.lifecycleStore.registerTask({ taskId: id, location: threadDir })
        return readThreadMeta<Thread>(join(threadDir, 'meta.json'))
      }
    }
    return undefined
  }

  /**
   * Runs before any rename: it throws to refuse. A subagent's title is its address among its
   * parent's subagents, so the orchestrator installs a guard that keeps those titles unique.
   */
  setNameGuard(guard: ((thread: Thread, name: string) => void) | null): void {
    this.nameGuard = guard
  }

  private nameGuard: ((thread: Thread, name: string) => void) | null = null

  /**
   * Narrows the thread's access ceiling to `level` (never widens it; see `Thread.accessCeiling`), without
   * touching `updatedAt`. Returns the ceiling now in force.
   */
  capAccessCeiling(id: string, level: AgentAccessLevel): AgentAccessLevel {
    const thread = this.getThread(id)
    if (!thread) throw new Error(`Thread not found: ${id}`)
    const next = narrowAgentAccess(isAgentAccessLevel(thread.accessCeiling) ? thread.accessCeiling : undefined, level) ?? level
    if (thread.accessCeiling !== next) this.updateThreadMeta(id, { accessCeiling: next }, { touch: false })
    return next
  }

  /** `touch: false` keeps `updatedAt`, for repairs that must not reorder the sidebar. */
  updateThreadMeta(
    id: string,
    partial: Partial<Pick<Thread, 'name' | 'titleSource' | 'modelOverride' | 'permissionMode' | 'worktreeEnabled' | 'lineage' | 'createdByThreadId' | 'startedFrom' | 'sentFrom' | 'runsOn' | 'accessCeiling' | 'workspaceBinding' | 'pullRequest' | 'expiresAt' | 'expiryStopsRun'>>,
    opts: { touch?: boolean; ifRevision?: number } = {}
  ): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }
    if (partial.name !== undefined && partial.name !== thread.name) this.nameGuard?.(thread, partial.name)

    const now = new Date().toISOString()
    const updated = this.writeThreadMeta(thread, (base) => {
      // A conditional change (`ifRevision`) is compared with the thread as it is written from: on disk under the list
      // lock when this store's list is not trusted, so a change another process made is never written over.
      if (opts.ifRevision !== undefined) refuseChangedRevision(base, opts.ifRevision)
      return {
        ...base,
        ...partial,
        // Every write of the model or the permission mode, by any route, moves the revision on (`ifRevision`).
        ...('modelOverride' in partial || 'permissionMode' in partial ? { settingsRevision: (base.settingsRevision ?? 0) + 1 } : {}),
        updatedAt: opts.touch === false ? base.updatedAt : now
      }
    })

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

    this.patchListCache(updated)
    this.emit('updated', updated)
    return updated
  }

  /**
   * The thread as its `meta.json` has it now, for a check that must not trust this store's cached row (another process
   * may have changed the thread since): a bound send's settings, a conditional change's revision.
   */
  threadOnDisk(id: string): Thread | undefined {
    const thread = this.getThread(id)
    if (!thread) return undefined
    try {
      return this.metaOnDisk(join(this.getThreadDir(id), 'meta.json'), thread)
    } catch {
      return thread
    }
  }

  setThreadWorktreeEnabled(id: string, enabled: boolean): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }
    // Gate on actual transcript content, not `startedAt`: the latter is
    // backfilled for merely-named threads with zero messages (see
    // ensureStartedAt), which would otherwise lock the toggle on new chats
    // that never ran a turn.
    if (this.messageCountAt(this.getThreadDir(id)) > 0) {
      throw threadErrors.create('thread_worktree_locked')
    }
    const now = new Date().toISOString()
    const updated = this.writeThreadMeta(thread, (base) => ({ ...base, worktreeEnabled: enabled, updatedAt: now }))

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

    this.patchListCache(updated)
    this.emit('list-changed', { id })
    return updated
  }

  setThreadSettled(id: string, settled: boolean): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }

    const now = new Date().toISOString()
    const updated = this.writeThreadMeta(thread, (base) => {
      const next: Thread = { ...base, updatedAt: now }
      if (settled) {
        next.settledAt = now
        delete next.pinnedAt
      } else {
        delete next.settledAt
      }
      return next
    })
    if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
    this.patchListCache(updated)
    this.emit('list-changed', { id })
    return updated
  }

  setThreadPinned(id: string, pinned: boolean): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }

    const now = new Date().toISOString()
    const updated = this.writeThreadMeta(thread, (base) => {
      const next: Thread = { ...base, updatedAt: now }
      if (pinned) next.pinnedAt = now
      else delete next.pinnedAt
      return next
    })

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

    this.patchListCache(updated)
    this.emit('list-changed', { id })
    return updated
  }

  reorderThreads(projectId: string | undefined, threadIds: string[]): Thread[] {
    const threads = projectId ? this.listThreads(projectId) : this.readStandaloneIndex()
    if (threadIds.length !== threads.length || new Set(threadIds).size !== threadIds.length) {
      throw new Error('Thread reorder must include every thread in its group exactly once')
    }
    const byId = new Map(threads.map((thread) => [thread.id, thread]))
    if (threadIds.some((id) => !byId.has(id))) {
      throw new Error('Threads may only be reordered within their current group')
    }
    // Only the rows whose order changes are written (moving one thread writes one row), so the list lock and their
    // gates are held for those writes alone.
    const listed = threadIds.map((id) => byId.get(id)!)
    const orders = ordersKeeping(listed.map((thread) => thread.order))
    const reordered = listed.map((thread, index) => (orders[index] === thread.order ? thread : { ...thread, order: orders[index]! }))
    const changed = reordered.filter((thread, index) => thread !== listed[index])
    const paths = changed.map((thread) => join(this.resolveThreadDir(thread), 'meta.json'))
    // All or nothing: every changed row's gates are taken before the list lock and before any write, so a busy one
    // changes nothing; a write that still fails puts the rows already written back as they were.
    const writeChanged = (cacheTrusted: boolean): void => {
      // Orders are kept relative to the rows around them, so they must be the ones on disk: a list another process
      // changed since it was read is refused before anything is written, and the person tries again.
      if (!cacheTrusted && listed.some((thread) => this.metaOnDisk(join(this.resolveThreadDir(thread), 'meta.json'), thread).order !== thread.order))
        throw new ThreadListBusyError()
      // So must the threads: one another process made since could share an order with a moved row.
      if (!cacheTrusted && projectId && this.unlistedThreadInFolder(projectId, new Set(listed.map((thread) => thread.id))))
        throw new ThreadListBusyError()
      let written = 0
      try {
        for (; written < changed.length; written += 1) this.writeJsonAtomic(paths[written]!, changed[written])
      } catch (error) {
        for (let index = 0; index < written; index += 1) {
          try { this.writeJsonAtomic(paths[index]!, byId.get(changed[index]!.id)) } catch { /* the original failure is reported */ }
        }
        throw error
      }
    }
    if (changed.length) this.withPathGates(paths, () => (projectId ? this.projectListWrite(projectId, writeChanged) : writeChanged(true)))
    if (!projectId) this.writeVisibleStandaloneProjection(reordered)
    this.invalidateListCache()
    this.emit('list-changed', {})
    return reordered
  }

  /** Lifecycle mutations require the daemon coordinator and its execution fence. */
  deleteThread(_id: string): never {
    throw new Error('Thread deletion requires the lifecycle coordinator')
  }

  restoreThreadFromTrash(_id: string): never {
    throw new Error('Thread restore requires the lifecycle coordinator')
  }

  purgeThreadFromTrash(_id: string): never {
    throw new Error('Permanent purge is unavailable in lifecycle Phase 1')
  }

  /** Coordinator post-move projection only. Keep a durable audit of cancelled inputs. */
  cancelLifecycleQueue(record: TaskLifecycleRecord, operationId: string): void {
    const queue = this.readMessageQueueFile(record.location, record.taskId)
    if (!queue.length) return
    const auditPath = join(record.location, 'lifecycle-cancelled-queue.json')
    const audit = this.readJsonFile<Array<{ operationId: string; cancelledAt: string; queue: QueuedMessage[] }>>(auditPath, [])
    if (!Array.isArray(audit)) throw new Error('Corrupt lifecycle queue cancellation audit')
    if (!audit.some((entry) => entry.operationId === operationId)) {
      audit.push({ operationId, cancelledAt: new Date().toISOString(), queue })
      this.writeJsonAtomic(auditPath, audit)
    }
    this.writeJsonAtomic(join(record.location, 'queue.json'), [])
  }

  /** Idempotent index projection; lifecycle location is the durable authority. */
  projectLifecycleIndex(record: TaskLifecycleRecord): void {
    // A thread moved into or out of a project's folder (trash, restore): the project's revision moves under its lock.
    // A purge needs nothing more; the thread had already left the project's folder when it was trashed.
    let projectId: string | undefined
    try {
      projectId = readThreadMeta<ThreadMeta>(join(record.location, 'meta.json')).projectId
    } catch {
      // No metadata where it is now: nothing to tell about a project.
    }
    if (projectId) this.projectListWrite(projectId, () => undefined)
    this.removeFromStandaloneIndex(record.taskId)
    if (record.location === record.originalLocation) {
      const meta = readThreadMeta<ThreadMeta>(join(record.location, 'meta.json'))
      if (meta.id !== record.taskId) throw new Error('Lifecycle thread identity mismatch')
      if (!meta.projectId) this.addToStandaloneIndex(meta)
    } else if (this.getActiveThreadId() === record.taskId) {
      this.setActiveThreadId(null)
    }
    this.invalidateListCache()
    this.emit('list-changed', { id: record.taskId })
  }

  /** Purge projection uses only stable IDs; it never reads already removed conversation data. */
  projectPurgedIndex(record: TaskLifecycleRecord): void {
    this.removeFromStandaloneIndex(record.taskId)
    if (this.getActiveThreadId() === record.taskId) this.setActiveThreadId(null)
    const legacyIndex = join(this.homeDir, 'trash', 'threads', 'index.json')
    if (existsSync(legacyIndex)) {
      const entries = JSON.parse(readFileSync(legacyIndex, 'utf8')) as Array<{ threadId: string }>
      if (!Array.isArray(entries)) throw new Error('Invalid legacy trash index')
      atomicWriteJsonSync(legacyIndex, entries.filter((entry) => entry.threadId !== record.taskId))
    }
    this.invalidateListCache()
    this.emit('list-changed', { id: record.taskId })
  }

  loadThreadData(id: string): ThreadData {
    return this.loadThreadDataFromDir(this.getThreadDir(id), id)
  }

  /**
   * `loadThreadData` for a caller that can wait: a thread in `thread.db` is read off the event loop first, so the
   * synchronous read that follows finds it in memory.
   */
  async loadThreadDataAsync(id: string): Promise<ThreadData> {
    await this.warmThread(id)
    return this.loadThreadData(id)
  }

  /** Reads a thread in `thread.db` into memory off the event loop; JSON threads need nothing. */
  async warmThread(id: string): Promise<void> {
    const threadDir = this.getThreadDir(id)
    if (ThreadDbStore.usesDb(threadDir)) await this.threadDb().warm(threadDir)
  }

  private loadThreadDataFromDir(threadDir: string, id: string): ThreadData {
    if (ThreadDbStore.usesDb(threadDir)) {
      this.checkForDowngradeWrites(threadDir, id)
      return { ...this.threadDb().load(threadDir), messageQueue: this.readMessageQueueFile(threadDir, id) }
    }
    this.settleGenerations(threadDir, id)
    const data = readLegacyThreadData(threadDir)
    this.scheduleImport(id)
    return { ...data, mousseAgentSessions: data.mousseAgentSessions, messageQueue: this.readMessageQueueFile(threadDir, id) }
  }

  /**
   * Atomic read-modify-write for thread data fields (messages/agents/tasks/llm/mousse).
   * Never writes messageQueue — queue remains exclusively via saveMessageQueue/mutateDurableQueue.
   * Concurrent partial updaters must use this so transcript and agent/task writes cannot clobber.
   */
  mutateThreadData(
    id: string,
    mutator: (current: ThreadData) => ThreadDataPatch
  ): ThreadData {
    const threadDir = this.getThreadDir(id)
    return withThreadDataMutationLock(threadDir, () => {
      if (ThreadDbStore.usesDb(threadDir)) {
        this.checkForDowngradeWrites(threadDir, id)
        const stored = this.threadDb().loadLazy(threadDir)
        const queue = this.readMessageQueueFile(threadDir, id)
        const current = Object.defineProperty(stored, 'messageQueue', { value: queue, enumerable: true }) as ThreadData
        const patch = mutator(current)
        const change: ThreadDataChange = {}
        if (patch.messages !== undefined) change.messages = patch.messages
        if (patch.agents !== undefined) change.agents = patch.agents
        if (patch.tasks !== undefined) change.tasks = patch.tasks
        if (patch.llmContext !== undefined) change.llmContext = patch.llmContext
        if (patch.mousseAgentSessions !== undefined) change.mousseAgentSessions = patch.mousseAgentSessions
        this.threadDb().save(threadDir, change)
        if (change.messages !== undefined) this.noteIndexChange(id, threadDir)
        this.touchAfterSave(threadDir, patch.messages ? patch.messages.length > 0 : this.threadDb().messageCount(threadDir) > 0, { throttle: true })
        return {
          messages: patch.messages ?? current.messages,
          agents: patch.agents ?? current.agents,
          tasks: patch.tasks ?? current.tasks,
          llmContext: patch.llmContext === null ? undefined : patch.llmContext ?? current.llmContext,
          mousseAgentSessions: patch.mousseAgentSessions === null ? undefined : patch.mousseAgentSessions ?? current.mousseAgentSessions,
          messageQueue: current.messageQueue
        }
      }
      const current = this.loadThreadDataFromDir(threadDir, id)
      const patch = mutator(current)
      const next: ThreadData = {
        messages: patch.messages ?? current.messages,
        agents: patch.agents ?? current.agents,
        tasks: patch.tasks ?? current.tasks,
        llmContext:
          patch.llmContext === null
            ? undefined
            : patch.llmContext !== undefined
              ? patch.llmContext
              : current.llmContext,
        mousseAgentSessions:
          patch.mousseAgentSessions === null
            ? undefined
            : patch.mousseAgentSessions !== undefined
              ? patch.mousseAgentSessions
              : current.mousseAgentSessions,
        // Preserve in-memory view of queue for callers; disk queue is not written here.
        messageQueue: current.messageQueue
      }
      this.saveThreadDataUnlocked(id, next)
      return next
    })
  }

  private queueJournal: QueueJournal | undefined

  /**
   * The journal of agent commands on queues, set once by the thread owner when the run engine is attached. Every
   * durable queue change finishes the thread's unfinished commands first; a store without one behaves as before.
   */
  setQueueJournal(journal: QueueJournal | undefined): void {
    this.queueJournal = journal
  }

  getQueueJournal(): QueueJournal | undefined {
    return this.queueJournal
  }

  /** Load durable per-thread message queue (queue.json; empty for legacy threads). */
  loadMessageQueue(id: string): QueuedMessage[] {
    const threadDir = this.getThreadDir(id)
    return this.readMessageQueueFile(threadDir, id)
  }

  private readMessageQueueFile(threadDir: string, threadId: string): QueuedMessage[] {
    const raw = this.readJsonFile<unknown>(join(threadDir, 'queue.json'), [])
    if (!Array.isArray(raw)) {
      throw new ThreadDataCorruptionError(
        join(threadDir, 'queue.json'),
        new Error('queue must be an array')
      )
    }
    return normalizeQueuedMessages(raw, threadId)
  }

  /** Atomically persist the message queue for a thread (backwards-compatible queue.json). */
  saveMessageQueue(id: string, queue: QueuedMessage[]): void {
    const threadDir = this.getThreadDir(id)
    this.ensureThreadDir(threadDir)
    const normalized = normalizeQueuedMessages(queue, id)
    this.writeJsonAtomic(join(threadDir, 'queue.json'), normalized)
  }

  /**
   * Full replacement write under the shared mutation lock.
   * Prefer {@link mutateThreadData} for partial updates (messages/agents/tasks/llm/mousse).
   * Callers must pass a complete ThreadData snapshot built under this lock or from live
   * registries at write time — never loadThreadData() outside the lock then save here.
   * Never writes queue.json.
   */
  saveThreadData(
    id: string,
    data: ThreadData,
    terminalScrollbacks?: Record<string, string>
  ): void {
    const threadDir = this.getThreadDir(id)
    withThreadDataMutationLock(threadDir, () => {
      this.saveThreadDataUnlocked(id, data, terminalScrollbacks)
    })
  }

  /**
   * Write thread data files without acquiring the mutation lock.
   * Caller must hold withThreadDataMutationLock (or be the sole writer).
   * Never writes queue.json.
   */
  private saveThreadDataUnlocked(
    id: string,
    data: ThreadData,
    terminalScrollbacks?: Record<string, string>
  ): void {
    const threadDir = this.getThreadDir(id)
    this.ensureThreadDir(threadDir)
    if (ThreadDbStore.usesDb(threadDir)) {
      this.threadDb().save(threadDir, {
        messages: data.messages,
        agents: data.agents,
        tasks: data.tasks,
        llmContext: data.llmContext ?? null,
        mousseAgentSessions: data.mousseAgentSessions ?? null
      })
      this.noteIndexChange(id, threadDir)
      this.writeTerminalScrollbacks(threadDir, terminalScrollbacks)
      this.touchAfterSave(threadDir, data.messages.length > 0, { throttle: true })
      return
    }
    // A thread still on JSON files (its import failed, or the store is off): only the plain files, written whole.
    this.settleGenerations(threadDir, id)
    this.writeJsonFiles(threadDir, data)
    this.writeTerminalScrollbacks(threadDir, terminalScrollbacks)
    this.touchAfterSave(threadDir, data.messages.length > 0)
  }

  private writeTerminalScrollbacks(threadDir: string, terminalScrollbacks?: Record<string, string>): void {
    if (!terminalScrollbacks) return
    const terminalsDir = join(threadDir, 'terminals')
    mkdirSync(terminalsDir, { recursive: true })
    for (const [ptyId, scrollback] of Object.entries(terminalScrollbacks)) {
      writeFileSync(join(terminalsDir, `${ptyId}.txt`), scrollback, 'utf-8')
    }
  }

  /**
   * A save moves `updatedAt`, and the first message marks the thread started. `meta.json` and the standalone index are
   * rewritten (and fsynced) for that, which costs more than a database save itself; so for a thread in `thread.db`
   * the lists in memory move on every save, while the files are written when the thread starts, when the last write
   * is `META_TOUCH_INTERVAL_MS` old, and at shutdown (`closeThreadStorage`).
   */
  private touchAfterSave(threadDir: string, hasMessages: boolean, options: { throttle?: boolean } = {}): void {
    const metaPath = join(threadDir, 'meta.json')
    if (!existsSync(metaPath)) return
    try {
      const meta = readThreadMeta<ThreadMeta>(metaPath)
      const now = new Date().toISOString()
      const starting = !meta.startedAt && hasMessages
      // Its first message is saved: a later send is no longer this thread's first (`Thread.firstSendPending`).
      const firstSent = meta.firstSendPending === true && hasMessages
      meta.updatedAt = now
      if (starting) meta.startedAt = now
      if (firstSent) delete meta.firstSendPending
      const lastWrite = this.metaTouchedAt.get(threadDir) ?? 0
      if (options.throttle && !starting && !firstSent && Date.now() - lastWrite < META_TOUCH_INTERVAL_MS) {
        this.pendingMetaTouch.set(threadDir, now)
        this.patchListCache(meta)
        this.emitTouched(meta)
        return
      }
      this.writeJsonAtomic(metaPath, meta)
      this.metaTouchedAt.set(threadDir, Date.now())
      this.pendingMetaTouch.delete(threadDir)
      if (!meta.projectId) this.updateStandaloneIndexEntry(meta)
      // Keep warm list cache in sync so startedAt/updatedAt surface without a rescan.
      this.patchListCache(meta)
      // A thread's first message lists it, and ends its first-send mark (`Thread.firstSendPending`), which windows read
      // from the list; a later save changes only its time, which windows hear in a small push.
      if (firstSent) this.emit('updated', meta)
      else if (starting) this.emit('list-changed', { id: meta.id })
      else this.emitTouched(meta)
    } catch {
      // Corrupt meta: do not overwrite with a stale reconstructed fallback.
    }
  }

  /**
   * A save moved a thread's `updatedAt` and nothing else a list shows (`touched`). The protocol server sends these
   * as a small, throttled `threads.touched`, so "Needs me", the recent-threads order and row ages follow saves without
   * the whole list. A personal bot's threads are never listed, so their times are not sent either.
   */
  private emitTouched(meta: ThreadMeta): void {
    if (meta.botOwned) return
    this.emit('touched', { id: meta.id, updatedAt: meta.updatedAt })
  }

  private readonly metaTouchedAt = new Map<string, number>()
  private readonly pendingMetaTouch = new Map<string, string>()

  /** Writes the `updatedAt` saves held back (`touchAfterSave`). */
  private flushMetaTouches(): void {
    for (const [threadDir, updatedAt] of [...this.pendingMetaTouch]) {
      this.pendingMetaTouch.delete(threadDir)
      try {
        const metaPath = join(threadDir, 'meta.json')
        if (!existsSync(metaPath)) continue
        const meta = readThreadMeta<ThreadMeta>(metaPath)
        if (meta.updatedAt >= updatedAt) continue
        meta.updatedAt = updatedAt
        this.writeJsonAtomic(metaPath, meta)
        if (!meta.projectId) this.updateStandaloneIndexEntry(meta)
      } catch {
        // A thread moved or gone since; its own record is what counts.
      }
    }
  }

  /**
   * A thread's data as the JSON files every earlier build read. `conversationState` also writes
   * `conversation-state.json` (the export for going back to an older version); a plain save instead removes a
   * leftover one, which would otherwise hold an older copy of the same messages.
   */
  private writeJsonFiles(threadDir: string, data: ThreadData, options: { conversationState?: boolean } = {}): void {
    this.writeJsonAtomic(join(threadDir, 'messages.json'), data.messages)
    this.writeJsonAtomic(join(threadDir, 'agents.json'), data.agents)
    this.writeJsonAtomic(join(threadDir, 'tasks.json'), data.tasks)
    const llmContextPath = join(threadDir, 'llm-context.json')
    if (data.llmContext === undefined) rmSync(llmContextPath, { force: true })
    else this.writeJsonAtomic(llmContextPath, data.llmContext)
    const sessionsPath = join(threadDir, 'mousse-agent-sessions.json')
    if (data.mousseAgentSessions === undefined) rmSync(sessionsPath, { force: true })
    else this.writeJsonAtomic(sessionsPath, data.mousseAgentSessions)
    const conversationState = join(threadDir, 'conversation-state.json')
    if (options.conversationState) {
      // Written last: older builds prefer it when it is at least as new as messages.json.
      this.writeJsonAtomic(conversationState, { schemaVersion: 1, messages: data.messages, llmContext: data.llmContext })
    } else {
      rmSync(conversationState, { force: true })
    }
    // Intentionally do not write queue.json here.
  }

  /**
   * A thread's agents and tasks, and how many subagent sessions and queued messages it has, without loading its
   * transcript (for runtime hydration and the restart pass over every thread).
   */
  loadThreadWorkState(id: string): { agents: Agent[]; tasks: Task[]; sessions: number; queued: number } {
    const threadDir = this.getThreadDir(id)
    if (ThreadDbStore.usesDb(threadDir)) {
      const state = this.threadDb().readState(threadDir)
      return { agents: state.agents as Agent[], tasks: state.tasks as Task[], sessions: state.sessions, queued: this.readMessageQueueFile(threadDir, id).length }
    }
    const data = this.loadThreadData(id)
    return { agents: data.agents, tasks: data.tasks, sessions: data.mousseAgentSessions?.length ?? 0, queued: data.messageQueue?.length ?? 0 }
  }

  /** True once the chat has content (and backfills startedAt for older threads). */
  isThreadStarted(id: string): boolean {
    const thread = this.getThread(id)
    if (!thread) return false
    if (thread.startedAt) return true
    return this.ensureStartedAt(thread)
  }

  /**
   * Mark a draft thread as started so it stays visible in the sidebar.
   * Called when the user commits the first send (before title generation finishes).
   * Idempotent — no-op when `startedAt` is already set.
   */
  markThreadStarted(id: string): { thread: Thread; newlyStarted: boolean } | undefined {
    const thread = this.getThread(id)
    if (!thread) return undefined
    if (thread.startedAt) return { thread, newlyStarted: false }

    const now = new Date().toISOString()
    // Started by another process meanwhile: kept as it is. Tried once more when the list is busy (a run start calls it).
    const updated = retryOnceWhenListBusy(() => this.writeThreadMeta(thread, (base) => (base.startedAt ? base : { ...base, startedAt: now, updatedAt: now })))
    if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
    this.patchListCache(updated)
    this.emit('list-changed', { id })
    return { thread: updated, newlyStarted: updated.startedAt === now }
  }

  /**
   * Move a thread to the top of its sidebar group. User sends only —
   * agent streaming must not change sidebar order.
   */
  bumpThreadToFront(id: string): { thread: Thread; bumped: boolean } | undefined {
    const thread = this.getThread(id)
    if (!thread) return undefined
    if (thread.settledAt) return { thread, bumped: false }

    const siblings = thread.projectId
      ? this.listThreads(thread.projectId)
      : this.readStandaloneIndex()
    // Rows of the user's other computers sort with these (in the same project, or none): the front is theirs too.
    const floor = this.remoteFloor?.(thread.projectId)
    const alreadyFront =
      siblings.every((entry) => entry.id === thread.id || entry.order > thread.order) &&
      (floor === undefined || thread.order < floor)
    if (alreadyFront) return { thread, bumped: false }

    const minOrder = siblings.reduce(
      (min, entry) => Math.min(min, entry.order),
      Math.min(thread.order, floor ?? thread.order)
    )
    // A project thread's order is taken under the project's list lock, below every order on disk when its list is not
    // trusted, as a new thread's is.
    const projectId = thread.projectId
    // Tried once more when the list is busy: a run start calls it.
    const updated = retryOnceWhenListBusy(() => this.writeThreadMeta(thread, (base, cacheTrusted) => ({
      ...base,
      order: projectId ? this.projectOrderUnderLock(projectId, cacheTrusted) : minOrder - 1
    })))
    if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
    this.invalidateListCache()
    this.emit('updated', updated)
    return { thread: updated, bumped: true }
  }

  /**
   * Record a user send: reveal the draft if needed and pin it to the top of
   * its group. Agent/internal writes must not call this.
   */
  touchThreadUserActivity(id: string): { thread: Thread; newlyStarted: boolean; bumped: boolean } | undefined {
    const started = this.markThreadStarted(id)
    if (!started) return undefined
    const bump = this.bumpThreadToFront(id)
    return {
      thread: bump?.thread ?? started.thread,
      newlyStarted: started.newlyStarted,
      bumped: bump?.bumped ?? false
    }
  }

  /**
   * For threads created before startedAt existed: mark started when messages exist
   * (or when the thread already has a real title).
   * Returns whether the thread is started after backfill.
   */
  ensureStartedAt(thread: Thread, projectPath?: string): boolean {
    if (thread.startedAt) return true

    let hasMessages = false
    let threadDir: string | null = null
    try {
      threadDir = this.resolveThreadDir(thread, projectPath)
      hasMessages = this.messageCountAt(threadDir) > 0
    } catch {
      // Project path may be unavailable; fall through to title-based detection.
    }

    // Legacy threads often have a generated title but no startedAt field yet.
    if (!hasMessages && isDefaultThreadName(thread.name)) return false
    if (!hasMessages && !thread.name) return false

    const updated: ThreadMeta = {
      ...thread,
      startedAt: thread.updatedAt || new Date().toISOString()
    }
    if (threadDir) {
      try {
        this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)
      } catch {
        // Still expose startedAt in-memory for this listing.
      }
    }
    if (!updated.projectId) this.writeStandaloneIndexEntryRaw(updated)
    thread.startedAt = updated.startedAt
    this.patchListCache({ ...thread, ...updated })
    return true
  }

  loadTerminalScrollbacks(id: string): Record<string, string> {
    const terminalsDir = join(this.getThreadDir(id), 'terminals')
    if (!existsSync(terminalsDir)) return {}

    const scrollbacks: Record<string, string> = {}
    for (const file of readdirSync(terminalsDir)) {
      if (!file.endsWith('.txt')) continue
      const ptyId = file.slice(0, -4)
      scrollbacks[ptyId] = readFileSync(join(terminalsDir, file), 'utf-8')
    }
    return scrollbacks
  }

  getActiveThreadId(): string | null {
    try {
      if (!existsSync(join(this.homeDir, 'active-thread.json'))) return null
      const state = JSON.parse(readFileSync(join(this.homeDir, 'active-thread.json'), 'utf-8')) as ActiveThreadState
      return state.id ?? null
    } catch {
      return null
    }
  }

  setActiveThreadId(id: string | null): void {
    mkdirSync(this.homeDir, { recursive: true })
    if (!id) {
      if (existsSync(join(this.homeDir, 'active-thread.json'))) {
        rmSync(join(this.homeDir, 'active-thread.json'), { force: true })
      }
      return
    }
    this.writeJsonAtomic(join(this.homeDir, 'active-thread.json'), { id })
  }

  assertThreadAdmission(id: string): void {
    if (!this.lifecycleStore.get(id)) this.getThreadDir(id)
    this.lifecycleStore.captureAdmission(id)
  }

  getThreadDir(id: string): string {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }
    const location = this.resolveThreadDir(thread)
    if (!this.lifecycleStore.get(id)) this.lifecycleStore.registerTask({ taskId: id, location })
    return location
  }

  private resolveThreadDir(meta: ThreadMeta, projectPath?: string): string {
    const managed = this.lifecycleStore.get(meta.id)
    if (managed) {
      this.lifecycleStore.assertPathAdmission(managed.location, 'write')
      return managed.location
    }
    if (meta.projectId) {
      const path = projectPath ?? this.projectManager.getProject(meta.projectId)?.path
      if (!path) throw new Error(`Project not found for thread: ${meta.id}`)
      const location = this.storageMigration.migrateRepository(path, meta.projectId, meta.id)
      if (existsSync(join(location, 'meta.json'))) this.lifecycleStore.registerTask({ taskId: meta.id, location })
      return location
    }
    const location = this.storageMigration.migrateStandalone(meta.id)
    if (existsSync(join(location, 'meta.json'))) this.lifecycleStore.registerTask({ taskId: meta.id, location })
    return location
  }

  private ensureThreadDir(threadDir: string): void {
    withThreadLifecyclePath(threadDir, 'write', () => {
      mkdirSync(threadDir, { recursive: true })
      mkdirSync(join(threadDir, 'terminals'), { recursive: true })
    })
  }

  private readStandaloneIndexRaw(): Thread[] {
    return this.readJsonFile<Thread[]>(join(this.homeDir, 'threads-index.json'), [])
  }

  private readStandaloneIndex(): Thread[] {
    const threads = this.readStandaloneIndexRaw().filter((thread) => this.isLifecycleVisible(thread.id))
    for (const thread of threads) this.ensureStartedAt(thread)
    return this.ensureThreadOrders(threads, (ordered) => this.writeVisibleStandaloneProjection(ordered))
  }

  /** Visibility changes do not delete retained children or their conversation index entries. */
  private writeVisibleStandaloneProjection(visible: Thread[]): void {
    const replaced = new Set(visible.map((thread) => thread.id))
    const retained = this.readStandaloneIndexRaw().filter((thread) => !replaced.has(thread.id))
    this.writeStandaloneIndex([...visible, ...retained])
  }

  private writeStandaloneIndex(threads: Thread[]): void {
    const dir = this.homeDir
    mkdirSync(dir, { recursive: true })
    this.writeJsonAtomic(join(this.homeDir, 'threads-index.json'), threads)
  }

  private addToStandaloneIndex(meta: ThreadMeta): void {
    const index = this.readStandaloneIndexRaw()
    index.push(meta)
    this.writeStandaloneIndex(index)
  }

  private updateStandaloneIndexEntry(thread: Thread): void {
    this.writeStandaloneIndexEntryRaw(thread)
  }

  private writeStandaloneIndexEntryRaw(thread: Thread): void {
    const index = this.readStandaloneIndexRaw()
    const idx = index.findIndex((t) => t.id === thread.id)
    if (idx >= 0) {
      index[idx] = thread
      this.writeStandaloneIndex(index)
    }
  }

  private removeFromStandaloneIndex(id: string): void {
    const index = this.readStandaloneIndexRaw().filter((t) => t.id !== id)
    this.writeStandaloneIndex(index)
  }

  private scanProjectThreads(projectPath: string): Thread[] {
    const project = this.projectManager.listProjects().find((entry) => entry.path === projectPath)
    if (!project) return []

    // Discover legacy directories first; each is atomically migrated before the
    // home-scoped directory is scanned. This keeps reads available on failure.
    const legacyRoot = this.storageLayout.legacyRepositoryRoot(projectPath)
    if (this.storageLayout.allowLegacyProjectData && existsSync(legacyRoot)) {
      for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) this.storageMigration.migrateRepository(projectPath, project.id, entry.name)
      }
    }

    const dataDir = this.storageLayout.repositoryRoot(project.id)
    const threads = this.scanThreadDirectory(dataDir, projectPath)
    return this.ensureThreadOrders(threads, (ordered) => {
      for (const thread of ordered) {
        this.writeJsonAtomic(join(this.resolveThreadDir(thread, projectPath), 'meta.json'), thread, { repair: true })
      }
    })
  }

  private scanThreadDirectory(dataDir: string, projectPath?: string): Thread[] {
    if (!existsSync(dataDir)) return []
    const threads: Thread[] = []
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metaPath = join(dataDir, entry.name, 'meta.json')
      if (!existsSync(metaPath)) continue
      try {
        const thread = readThreadMeta<Thread>(metaPath)
        if (!this.isLifecycleVisible(thread.id)) continue
        if (!this.lifecycleStore.get(thread.id)) this.lifecycleStore.registerTask({ taskId: thread.id, location: join(dataDir, entry.name) })
        this.ensureStartedAt(thread, projectPath)
        threads.push(thread)
      } catch {
        /* skip invalid */
      }
    }
    return threads
  }

  private sortThreads(threads: Thread[]): Thread[] {
    return threads.sort((a, b) => a.order - b.order)
  }

  private nextThreadOrder(projectId?: string): number {
    // The group's warm list, read from disk again when it is not cached or its files changed since, so a thread
    // another process added is listed and the new order is below every order on disk.
    this.refreshGroupIfChanged(projectId)
    const threads = this.listThreads(projectId)
    // A group that also holds rows of other computers starts below their first.
    const floor = this.remoteFloor?.(projectId)
    return threads.reduce((min, thread) => Math.min(min, thread.order), Math.min(0, floor ?? 0)) - 1
  }

  private ensureThreadOrders(threads: Thread[], persist: (threads: Thread[]) => void): Thread[] {
    const missingOrder = threads.some((thread) => !Number.isFinite(thread.order))
    if (missingOrder) {
      const legacyOrder = [...threads].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      legacyOrder.forEach((thread, order) => { thread.order = order })
      persist(threads)
    }
    return this.sortThreads(threads)
  }

  private readJsonFile<T>(filePath: string, fallback: T): T {
    return readJsonFile(filePath, fallback)
  }

  private validateArray<T>(value: unknown, collection: string, threadDir: string): T[] {
    return validateArray<T>(value, collection, threadDir)
  }

  /** Same-directory durable replacement with file and parent-directory fsync. */
  private writeJsonAtomic(filePath: string, value: unknown, options: { repair?: boolean } = {}): void {
    // A thread's meta.json or the standalone index: a write to a group's list, which moves its signature. When
    // the cached list matched the disk before, it still does (every writer here patches or clears the cache).
    const meta = basename(filePath) === 'meta.json' && value && typeof value === 'object' && typeof (value as Thread).id === 'string'
    const group: { projectId?: string } | undefined = filePath === join(this.homeDir, 'threads-index.json')
      ? {}
      : meta ? { projectId: (value as Thread).projectId } : undefined
    if (!group) {
      atomicWriteJsonSync(filePath, value)
      return
    }
    if (group.projectId) {
      const projectId = group.projectId
      // The write's lifecycle gates first, so the list lock is the innermost lock.
      this.withPathGates([filePath], () => this.projectListWrite(projectId, () => atomicWriteJsonSync(filePath, value), options))
      return
    }
    const recorded = this.groupSignatures.get('')
    const inSync = recorded !== undefined && recorded === this.groupSignature()
    atomicWriteJsonSync(filePath, value)
    if (inSync) {
      const signature = this.groupSignature()
      if (signature !== undefined) this.groupSignatures.set('', signature)
      else this.groupSignatures.delete('')
    }
  }

  /**
   * Matches over every thread by default. `hideSubagents` leaves out the threads a thread list would
   * fold under their parent (see `visibleThreads`); it applies before `limit`, so hidden threads
   * never use up result slots.
   *
   * Message matches of threads kept in `thread.db` come from the profile's search index in the read worker
   * (`searchThreadsAsync`); this synchronous form, kept for callers that cannot wait, reads them from each
   * thread's database instead.
   */
  searchThreads(query: string, limit = 50, options: ThreadSearchOptions = {}): ThreadSearchResult[] {
    const plan = this.searchPlan(query, options)
    if (!plan) return []
    const messages: ScoredSearchResult[] = []
    for (const thread of plan.scan) {
      try {
        const threadDir = this.listedThreadDir(thread.id)
        const found = ThreadDbStore.usesDb(threadDir)
          ? this.threadDb().client.callSync('searchTranscript', threadDir, plan.normalized, limit)
          : this.readJsonFile<Array<{ id: string; content: string }>>(join(threadDir, 'messages.json'), [])
        messages.push(...this.messageResults(thread, plan, found))
      } catch {
        /* skip invalid thread data */
      }
    }
    return this.finishSearch([...plan.titles, ...messages], limit)
  }

  /**
   * `searchThreads` off the event loop: threads kept in `thread.db` are matched by the profile's search index
   * (every one of them, with no bound on how many), JSON threads as before. Saves made before the call are
   * indexed before it is answered.
   */
  async searchThreadsAsync(query: string, limit = 50, options: ThreadSearchOptions = {}): Promise<ThreadSearchResult[]> {
    const plan = this.searchPlan(query, options)
    if (!plan) return []
    const messages: ScoredSearchResult[] = []
    const indexed: Array<Thread & { dir: string }> = []
    let budget = options.maxMessageThreads ?? Number.POSITIVE_INFINITY
    if (!options.titlesOnly) {
      for (const thread of plan.candidates) {
        let threadDir: string
        try { threadDir = this.listedThreadDir(thread.id) } catch { continue }
        if (ThreadDbStore.usesDb(threadDir)) {
          indexed.push({ ...thread, dir: threadDir })
          continue
        }
        if (budget <= 0) continue
        budget -= 1
        try {
          messages.push(...this.messageResults(thread, plan, this.readJsonFile<Array<{ id: string; content: string }>>(join(threadDir, 'messages.json'), [])))
        } catch {
          /* skip invalid thread data */
        }
      }
    }
    if (indexed.length) messages.push(...(await this.indexedMessageResults(indexed, plan, limit)))
    return this.finishSearch([...plan.titles, ...messages], limit)
  }

  /**
   * Message matches of threads kept in thread.db, from the search index: in batches until `limit` distinct results
   * are found or the matches run out (a result that repeats another's does not count). If the index cannot answer,
   * each thread's transcript is searched in the read worker instead, so a broken cache never breaks search.
   */
  private async indexedMessageResults(indexed: Array<Thread & { dir: string }>, plan: SearchPlan, limit: number): Promise<ScoredSearchResult[]> {
    const byId = new Map(indexed.map((thread) => [thread.id, thread]))
    const ordered = [...indexed].sort((a, b) => a.name.localeCompare(b.name)).map((thread) => ({ id: thread.id, name: thread.name, dir: thread.dir }))
    const out: ScoredSearchResult[] = []
    const distinct = new Set<string>()
    try {
      this.flushIndexNotices()
      const batch = Math.max(limit, 50)
      for (let offset = 0; distinct.size < limit; offset += batch) {
        const hits = await this.threadDb().client.callIndex('indexSearch', this.homeDir, { query: plan.normalized, threads: ordered, limit: batch, offset })
        for (const hit of hits) {
          const thread = byId.get(hit.threadId)
          if (!thread) continue
          for (const result of this.messageResults(thread, plan, [{ id: hit.messageId, content: hit.body }])) {
            out.push(result)
            distinct.add(`${result.threadId}:${result.messageId}:${result.snippet}`)
          }
        }
        if (hits.length < batch) break
      }
      return out
    } catch (error) {
      console.warn('thread search index could not answer; searching transcripts instead', { error: error instanceof Error ? error.message : String(error) })
      out.length = 0
      distinct.clear()
      // Each thread is read whole (a limit before removing repeats would lose results), and reading stops once
      // enough distinct results are found.
      for (const thread of ordered) {
        if (distinct.size >= limit) break
        try {
          const found = await this.threadDb().client.call('searchTranscript', thread.dir, plan.normalized, Number.MAX_SAFE_INTEGER)
          for (const result of this.messageResults(byId.get(thread.id)!, plan, found)) {
            out.push(result)
            distinct.add(`${result.threadId}:${result.messageId}:${result.snippet}`)
          }
        } catch {
          /* skip a thread that cannot be read now */
        }
      }
      return out
    }
  }

  /** Who may be matched (decided before anything is matched), and the title and project matches. */
  private searchPlan(query: string, options: ThreadSearchOptions): SearchPlan | undefined {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return undefined
    const projectNameById = new Map(this.projectManager.listProjects().map((p) => [p.id, p.name]))
    const inventory = this.listAllThreads()
    let threads = options.hideSubagents ? visibleThreads(inventory) : inventory
    // Who may see a thread is decided before anything is matched, so excluded threads never use up
    // result slots or message scans.
    if (options.allow) threads = threads.filter((thread) => options.allow!(thread))
    // Bounded scans read the transcripts of the most recently updated threads only.
    const scanBudget = options.maxMessageThreads ?? Number.POSITIVE_INFINITY
    if (Number.isFinite(scanBudget) && !options.titlesOnly) threads = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const titles: ScoredSearchResult[] = []
    const candidates: Thread[] = []
    for (const thread of threads) {
      if (thread.settledAt) continue
      // Skip pure empty drafts; startedAt may be backfilled above via ensureStartedAt.
      if (!thread.startedAt && isDefaultThreadName(thread.name)) continue
      const projectName = thread.projectId ? projectNameById.get(thread.projectId) : undefined
      const base = { threadId: thread.id, threadName: thread.name, projectId: thread.projectId, projectName }
      if (thread.name.toLowerCase().includes(normalized)) titles.push({ ...base, matchType: 'thread', score: 0 })
      if (projectName && projectName.toLowerCase().includes(normalized)) titles.push({ ...base, matchType: 'project', score: 1 })
      candidates.push(thread)
    }
    const scan = options.titlesOnly ? [] : candidates.slice(0, Number.isFinite(scanBudget) ? scanBudget : undefined)
    return { normalized, projectNameById, titles, candidates, scan }
  }

  private messageResults(thread: Thread, plan: SearchPlan, messages: Array<{ id: string; content: string }>): ScoredSearchResult[] {
    const out: ScoredSearchResult[] = []
    const projectName = thread.projectId ? plan.projectNameById.get(thread.projectId) : undefined
    for (const message of messages) {
      const content = message.content ?? ''
      const index = content.toLowerCase().indexOf(plan.normalized)
      if (index === -1) continue
      const start = Math.max(0, index - 40)
      const end = Math.min(content.length, index + plan.normalized.length + 40)
      const snippet =
        (start > 0 ? '…' : '') +
        content.slice(start, end).replace(/\s+/g, ' ').trim() +
        (end < content.length ? '…' : '')
      out.push({ threadId: thread.id, threadName: thread.name, projectId: thread.projectId, projectName, matchType: 'message', snippet, messageId: message.id, score: 2 })
    }
    return out
  }

  private finishSearch(results: ScoredSearchResult[], limit: number): ThreadSearchResult[] {
    const seen = new Set<string>()
    return results
      .sort((a, b) => a.score - b.score || a.threadName.localeCompare(b.threadName))
      .filter((result) => {
        const key = `${result.threadId}:${result.matchType}:${result.messageId ?? ''}:${result.snippet ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, limit)
      .map(({ score: _score, ...rest }) => rest)
  }

  /**
   * Folders of listed threads, for reads that visit every thread (search, the index sweep). Resolving a folder
   * reads the thread's lifecycle record, which on hundreds of threads costs more than the search itself. Cleared
   * with the thread lists, so a move or a trash is never served from it.
   */
  private readonly dirCache = new Map<string, string>()

  private listedThreadDir(id: string): string {
    // Lifecycle state is checked every time (another process may have fenced or moved the thread), with one read of
    // the thread's record; only the folder's resolution is cached.
    const record = this.lifecycleStore.get(id)
    if ((record && record.state !== 'active') || (record?.parentTaskId && !this.isLifecycleVisible(record.parentTaskId))) {
      this.dirCache.delete(id)
      throw new Error(`Thread ${id} is not active`)
    }
    let dir = this.dirCache.get(id)
    if (!dir || (record && record.location !== dir)) {
      dir = this.getThreadDir(id)
      this.dirCache.set(id, dir)
    }
    return dir
  }

  private readonly indexDirty = new Map<string, string>()
  private indexTimer?: ReturnType<typeof setTimeout>
  private sweepTimer?: ReturnType<typeof setInterval>

  /** A thread in `thread.db` was saved: its index rows are brought up to date shortly (or before the next search). */
  private noteIndexChange(id: string, threadDir: string): void {
    this.indexDirty.set(id, threadDir)
    if (this.indexTimer) return
    this.indexTimer = setTimeout(() => this.flushIndexNotices(), 1_000)
    this.indexTimer.unref?.()
  }

  /** Sends the pending index notices; the read worker applies them before anything sent later. */
  private flushIndexNotices(): void {
    if (this.indexTimer) clearTimeout(this.indexTimer)
    this.indexTimer = undefined
    if (!this.indexDirty.size || !this.threadDbStore) return
    const targets = [...this.indexDirty].map(([threadId, dir]) => ({ threadId, dir }))
    this.indexDirty.clear()
    this.threadDbStore.client.callIndex('indexUpdate', this.homeDir, targets).catch((error: unknown) => {
      console.warn('thread search index update failed; the next sweep catches up', { error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** Threads kept in `thread.db`, with their folders. */
  private databaseThreads(): Array<{ threadId: string; dir: string }> {
    const out: Array<{ threadId: string; dir: string }> = []
    for (const thread of this.listAllThreads()) {
      try {
        const dir = this.listedThreadDir(thread.id)
        if (ThreadDbStore.usesDb(dir)) out.push({ threadId: thread.id, dir })
      } catch {
        // A thread whose folder cannot be resolved now is not indexed now.
      }
    }
    return out
  }

  /**
   * Keeps the search index matching the thread databases: at once, then every `intervalMs`. Threads whose
   * database files changed since they were indexed (written by another process, or a notice that was lost) are
   * caught up, and threads no longer listed are dropped. A missing or damaged index is rebuilt by the first pass.
   */
  startSearchIndexSweep(intervalMs = 60_000): void {
    if (this.sweepTimer) return
    const sweep = (): void => {
      const live = this.databaseThreads()
      if (!live.length && !this.threadDbStore) return
      this.threadDb().client.callIndex('indexReconcile', this.homeDir, live).catch((error: unknown) => {
        console.warn('thread search index sweep failed', { error: error instanceof Error ? error.message : String(error) })
      })
    }
    sweep()
    this.sweepTimer = setInterval(sweep, intervalMs)
    this.sweepTimer.unref?.()
  }

  stopSearchIndexSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
    this.flushIndexNotices()
  }
}
