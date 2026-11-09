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
import { join } from 'path'
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
import { ThreadJournal } from './ThreadJournal'
import { ThreadRecoveryService } from './ThreadRecoveryService'
import { ThreadStorageLayout } from './ThreadStorageLayout'
import { ThreadStorageMigration } from './ThreadStorageMigration'
import { ThreadTrashService, type LegacyTrashDiagnostic } from './ThreadTrashService'
import { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import type { ThreadPullRequestLink } from '../../shared/pullRequests'
import { registerThreadLifecycleGate, withThreadLifecyclePath } from '../queue/ThreadLifecycleAdmission'
import { withFileLock } from '../scheduled/fileLock'
import { pathsEqual } from '../profiles/pathSafety'
import {
  legacyFingerprint,
  readJsonFile,
  readLegacyThreadData,
  sameFingerprint,
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
function readThreadMeta<T extends { modelOverride?: ModelOverride }>(path: string): T {
  const meta = JSON.parse(readFileSync(path, 'utf-8')) as T
  return meta?.modelOverride ? { ...meta, modelOverride: upgradeSelection(meta.modelOverride) } : meta
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
  private transactionalOverride?: boolean
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
    const transactional = this.transactionalStoreEnabled()
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (ThreadDbStore.usesDb(threadDir)) return { status: 'already' }
        const fingerprint: FileStamp[] = withThreadDataMutationLock(threadDir, () => {
          removeAbandonedImports(threadDir)
          if (transactional && existsSync(join(threadDir, 'manifest.json'))) {
            new ThreadRecoveryService(new ThreadGenerationStore(threadDir)).reconcile()
          }
          return legacyFingerprint(threadDir)
        })
        const tmpName = `${THREAD_DB_FILE}.import-${process.pid}-${uuidv4()}`
        const built = await this.threadDb().client.call('build', threadDir, { tmpName, transactional, fingerprint })
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
      this.writeCompatibilityProjection(threadDir, { ...data, messageQueue: undefined })
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

  setTransactionalStoreEnabled(enabled: boolean): void {
    this.transactionalOverride = enabled
  }

  private transactionalStoreEnabled(): boolean {
    if (this.transactionalOverride !== undefined) return this.transactionalOverride
    const value = process.env.MOUSSE_TRANSACTIONAL_THREAD_STORE
    return value === '1' || value === 'true'
  }

  private projectsCacheKey(): string {
    return this.projectManager
      .listProjects()
      .map((project) => `${project.id}\0${project.path}`)
      .join('\n')
  }

  private invalidateListCache(): void {
    this.dirCache.clear()
    this.listCache = null
    this.listCacheProjectsKey = null
    this.standaloneListCache = null
    this.projectListCache.clear()
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
    this.invalidateListCache()
    const now = new Date().toISOString()
    const meta: ThreadMeta = {
      id,
      name,
      projectId,
      createdAt: now,
      updatedAt: now,
      order: this.nextThreadOrder(projectId, projectPath)
    }
    if (opts?.started === true) meta.startedAt = now
    // `false` is kept: a thread that chose its project's folder never gets a worktree (`WorkspaceResolver`).
    if (typeof opts?.worktreeEnabled === 'boolean') meta.worktreeEnabled = opts.worktreeEnabled
    if (opts?.lineage) meta.lineage = structuredClone(opts.lineage)
    if (opts?.createdByThreadId) meta.createdByThreadId = opts.createdByThreadId
    if (isAgentAccessLevel(opts?.accessCeiling)) meta.accessCeiling = opts.accessCeiling
    if (opts?.modelOverride) meta.modelOverride = structuredClone(opts.modelOverride)
    if (opts?.permissionMode) meta.permissionMode = opts.permissionMode
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

    const threadDir = this.resolveThreadDir(meta, projectPath)
    // An owner without a lifecycle record yet (an older thread) is registered first; the child's
    // registration requires an active owner.
    if (opts?.ownerThreadId) this.getThreadDir(opts.ownerThreadId)
    this.lifecycleStore.registerTask({ taskId: id, location: threadDir, parentTaskId: opts?.ownerThreadId, creating: true })
    this.ensureThreadDir(threadDir)

    this.writeJsonAtomic(join(threadDir, 'meta.json'), meta)
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
    this.lifecycleStore.forgetCreatedTask(id, owner ? { ownedBy: owner } : undefined)
    if (!meta.projectId) this.removeFromStandaloneIndex(id)
    rmSync(threadDir, { recursive: true, force: true })
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
    if (discarded.length) this.invalidateListCache()
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
    const initial: ThreadMeta = { id, name, projectId, createdAt: now, updatedAt: now, startedAt: now, order: this.nextThreadOrder(projectId, project?.path) }
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
      const updated: Thread = { ...thread, botOwned: true }
      this.writeJsonAtomic(join(this.getThreadDir(id), 'meta.json'), updated)
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
    if (projectId) {
      const cached = this.projectListCache.get(projectId)
      if (cached) return cached
      const project = this.projectManager.getProject(projectId)
      if (!project) return []
      const threads = this.scanProjectThreads(project.path)
      this.projectListCache.set(projectId, threads)
      return threads
    }
    if (this.standaloneListCache) return this.standaloneListCache
    const standalone = this.readStandaloneIndex()
    this.standaloneListCache = standalone
    return standalone
  }

  listAllThreads(): Thread[] {
    const projectsKey = this.projectsCacheKey()
    if (this.listCache && this.listCacheProjectsKey === projectsKey) {
      return this.listCache
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
    partial: Partial<Pick<Thread, 'name' | 'modelOverride' | 'permissionMode' | 'worktreeEnabled' | 'lineage' | 'createdByThreadId' | 'startedFrom' | 'sentFrom' | 'runsOn' | 'accessCeiling' | 'workspaceBinding' | 'pullRequest' | 'expiresAt' | 'expiryStopsRun'>>,
    opts: { touch?: boolean } = {}
  ): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }
    if (partial.name !== undefined && partial.name !== thread.name) this.nameGuard?.(thread, partial.name)

    const updated: Thread = {
      ...thread,
      ...partial,
      updatedAt: opts.touch === false ? thread.updatedAt : new Date().toISOString()
    }

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

    this.patchListCache(updated)
    this.emit('updated', updated)
    return updated
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
    const updated: Thread = {
      ...thread,
      worktreeEnabled: enabled,
      updatedAt: new Date().toISOString()
    }

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

    this.patchListCache(updated)
    return updated
  }

  setThreadSettled(id: string, settled: boolean): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }

    const updated: Thread = {
      ...thread,
      updatedAt: new Date().toISOString()
    }

    if (settled) {
      updated.settledAt = updated.updatedAt
      delete updated.pinnedAt
    } else {
      delete updated.settledAt
    }

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)
    if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
    this.patchListCache(updated)
    return updated
  }

  setThreadPinned(id: string, pinned: boolean): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }

    const updated: Thread = {
      ...thread,
      updatedAt: new Date().toISOString()
    }

    if (pinned) {
      updated.pinnedAt = updated.updatedAt
    } else {
      delete updated.pinnedAt
    }

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

    this.patchListCache(updated)
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
    const reordered = threadIds.map((id, order) => ({ ...byId.get(id)!, order }))
    for (const thread of reordered) {
      this.writeJsonAtomic(join(this.resolveThreadDir(thread), 'meta.json'), thread)
    }
    if (!projectId) this.writeVisibleStandaloneProjection(reordered)
    this.invalidateListCache()
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
    this.removeFromStandaloneIndex(record.taskId)
    if (record.location === record.originalLocation) {
      const meta = readThreadMeta<ThreadMeta>(join(record.location, 'meta.json'))
      if (meta.id !== record.taskId) throw new Error('Lifecycle thread identity mismatch')
      if (!meta.projectId) this.addToStandaloneIndex(meta)
    } else if (this.getActiveThreadId() === record.taskId) {
      this.setActiveThreadId(null)
    }
    this.invalidateListCache()
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
  }

  loadThreadData(id: string): ThreadData {
    const threadDir = this.getThreadDir(id)
    if (ThreadDbStore.usesDb(threadDir)) return this.loadThreadDataFromDir(threadDir, id)
    if (!this.transactionalStoreEnabled()) return this.loadThreadDataFromDir(threadDir, id)
    return withThreadDataMutationLock(threadDir, () => {
      if (ThreadDbStore.usesDb(threadDir)) return this.loadThreadDataFromDir(threadDir, id)
      new ThreadRecoveryService(new ThreadGenerationStore(threadDir)).reconcile()
      return this.loadThreadDataFromDir(threadDir, id)
    })
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
    const data = readLegacyThreadData(threadDir, { transactional: this.transactionalStoreEnabled() })
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
      if (this.transactionalStoreEnabled()) {
        new ThreadRecoveryService(new ThreadGenerationStore(threadDir)).reconcile()
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
      if (this.transactionalStoreEnabled() && !ThreadDbStore.usesDb(threadDir)) {
        new ThreadRecoveryService(new ThreadGenerationStore(threadDir)).reconcile()
      }
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
    const transactional = this.transactionalStoreEnabled()
    const journal = transactional ? new ThreadJournal(threadDir) : undefined
    const operationId = transactional ? uuidv4() : undefined
    const generationStore = transactional ? new ThreadGenerationStore(threadDir) : undefined
    const expectedManifest = generationStore?.getManifest()
    const intent = journal?.append({
      operationId: operationId!,
      operationType: 'thread-data-save',
      state: 'planned',
      expectedPreState: expectedManifest
    })
    let committed = false

    try {
      if (transactional) {
        journal!.append({
          operationId: operationId!,
          operationType: 'thread-data-save',
          state: 'running',
          details: { intentSequence: intent!.sequence }
        })
        // queue.json is authoritative and is only observed here. Actions,
        // branches and workspace are owned by their domain services, so an
        // unrelated transcript save must carry them forward rather than
        // replacing them with empty placeholders.
        const queue = this.readMessageQueueFile(threadDir, id)
        const generation = generationStore!.createGeneration({
          messages: data.messages,
          agents: data.agents,
          tasks: data.tasks,
          llmContext: data.llmContext,
          queue,
          mousseAgentSessions: data.mousseAgentSessions,
          workspace: this.readJsonFile<unknown>(join(threadDir, 'workspace.json'), undefined),
          conversationBranches: this.validateArray<unknown>(
            this.readJsonFile<unknown>(join(threadDir, 'conversation-branches.json'), []),
            'conversation-branches',
            threadDir
          ),
          actions: this.validateArray<unknown>(
            this.readJsonFile<unknown>(join(threadDir, 'actions.json'), []),
            'actions',
            threadDir
          )
        }, intent!.sequence)
        journal!.append({
          operationId: operationId!,
          operationType: 'thread-data-save',
          state: 'running',
          resultGenerationId: generation.generationId,
          details: { intentSequence: intent!.sequence, generationDurable: true }
        })
        generationStore!.selectExistingGeneration(generation.generationId, {
          expectedCurrentGenerationId: expectedManifest?.currentGenerationId ?? null
        })
        journal!.append({
          operationId: operationId!,
          operationType: 'thread-data-save',
          state: 'completed',
          resultGenerationId: generation.generationId,
          details: { intentSequence: intent!.sequence }
        })
        committed = true

        // Flat files are a compatibility projection, never the transaction
        // authority. A projection failure cannot turn a committed checkpoint
        // into a failed/ambiguous operation.
        try {
          this.writeCompatibilityProjection(threadDir, data)
        } catch (projectionError) {
          journal!.append({
            operationId: operationId!,
            operationType: 'thread-data-save',
            state: 'completed',
            resultGenerationId: generation.generationId,
            details: {
              intentSequence: intent!.sequence,
              compatibilityProjectionError:
                projectionError instanceof Error ? projectionError.message : String(projectionError)
            }
          })
        }
      } else {
        this.writeCompatibilityProjection(threadDir, data)
      }

      this.writeTerminalScrollbacks(threadDir, terminalScrollbacks)
      this.touchAfterSave(threadDir, data.messages.length > 0)
    } catch (error) {
      if (!committed) {
        journal?.append({
          operationId: operationId!,
          operationType: 'thread-data-save',
          state: 'failed',
          details: {
            intentSequence: intent?.sequence,
            error: error instanceof Error ? error.message : String(error)
          }
        })
      }
      throw error
    }
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
      meta.updatedAt = now
      if (starting) meta.startedAt = now
      const lastWrite = this.metaTouchedAt.get(threadDir) ?? 0
      if (options.throttle && !starting && Date.now() - lastWrite < META_TOUCH_INTERVAL_MS) {
        this.pendingMetaTouch.set(threadDir, now)
        this.patchListCache(meta)
        return
      }
      this.writeJsonAtomic(metaPath, meta)
      this.metaTouchedAt.set(threadDir, Date.now())
      this.pendingMetaTouch.delete(threadDir)
      if (!meta.projectId) this.updateStandaloneIndexEntry(meta)
      // Keep warm list cache in sync so startedAt/updatedAt surface without a rescan.
      this.patchListCache(meta)
    } catch {
      // Corrupt meta: do not overwrite with a stale reconstructed fallback.
    }
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

  private writeCompatibilityProjection(threadDir: string, data: ThreadData): void {
    this.writeJsonAtomic(join(threadDir, 'messages.json'), data.messages)
    this.writeJsonAtomic(join(threadDir, 'agents.json'), data.agents)
    this.writeJsonAtomic(join(threadDir, 'tasks.json'), data.tasks)
    const llmContextPath = join(threadDir, 'llm-context.json')
    if (data.llmContext === undefined) rmSync(llmContextPath, { force: true })
    else this.writeJsonAtomic(llmContextPath, data.llmContext)
    const sessionsPath = join(threadDir, 'mousse-agent-sessions.json')
    if (data.mousseAgentSessions === undefined) rmSync(sessionsPath, { force: true })
    else this.writeJsonAtomic(sessionsPath, data.mousseAgentSessions)
    // Publish the transcript + native context pair last. Readers prefer this
    // single atomic unit; the preceding files remain compatibility projections.
    this.writeJsonAtomic(join(threadDir, 'conversation-state.json'), {
      schemaVersion: 1,
      messages: data.messages,
      llmContext: data.llmContext
    })
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
    const updated: ThreadMeta = {
      ...thread,
      startedAt: now,
      updatedAt: now
    }

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)
    if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
    this.patchListCache(updated)
    return { thread: updated, newlyStarted: true }
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
    const updated: Thread = { ...thread, order: minOrder - 1 }
    this.writeJsonAtomic(join(this.getThreadDir(id), 'meta.json'), updated)
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
      this.lifecycleStore.withPathAdmission(managed.location, 'write', () => undefined)
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
        this.writeJsonAtomic(join(this.resolveThreadDir(thread, projectPath), 'meta.json'), thread)
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

  private nextThreadOrder(projectId?: string, projectPath?: string): number {
    const threads = projectId
      ? this.scanProjectThreads(projectPath ?? this.projectManager.getProject(projectId)?.path ?? '')
      : this.readStandaloneIndex()
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
  private writeJsonAtomic(filePath: string, value: unknown): void {
    atomicWriteJsonSync(filePath, value)
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
    if (indexed.length) {
      this.flushIndexNotices()
      const byId = new Map(indexed.map((thread) => [thread.id, thread]))
      const ordered = [...indexed].sort((a, b) => a.name.localeCompare(b.name)).map((thread) => ({ id: thread.id, name: thread.name, dir: thread.dir }))
      const hits = await this.threadDb().client.call('indexSearch', this.homeDir, { query: plan.normalized, threads: ordered, limit: limit * 4 })
      for (const hit of hits) {
        const thread = byId.get(hit.threadId)
        if (thread) messages.push(...this.messageResults(thread, plan, [{ id: hit.messageId, content: hit.body }]))
      }
    }
    return this.finishSearch([...plan.titles, ...messages], limit)
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
    let dir = this.dirCache.get(id)
    if (!dir) {
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
    this.threadDbStore.client.call('indexUpdate', this.homeDir, targets).catch((error: unknown) => {
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
      this.threadDb().client.call('indexReconcile', this.homeDir, live).catch((error: unknown) => {
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
