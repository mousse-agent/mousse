import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type {
  Agent,
  ChatMessage,
  MousseAgentSessionSnapshot,
  NativeLlmContext,
  Project,
  QueuedMessage,
  Task,
  Thread,
  ThreadData
} from '../../shared/types'
import { isDefaultThreadName } from '../../shared/threadTitle'
import { parseMousseAgentSessions } from '../agents/MousseAgentService'
import { normalizeQueuedMessages } from '../queue/ThreadMessageQueue'
import { withThreadDataMutationLock } from '../queue/ThreadExecutionLease'
import type { ProjectManager } from './ProjectManager'
import {
  getActiveThreadPath,
  getMousseHomeDir,
  getThreadsIndexPath
} from './paths'
import { atomicWriteJsonSync } from './AtomicFs'
import { ThreadGenerationStore } from './ThreadGenerationStore'
import { ThreadJournal } from './ThreadJournal'
import { ThreadStorageLayout } from './ThreadStorageLayout'
import { ThreadStorageMigration } from './ThreadStorageMigration'
import { ThreadTrashService } from './ThreadTrashService'

interface ThreadMeta {
  id: string
  name: string
  projectId?: string
  createdAt: string
  updatedAt: string
  modelOverride?: {
    llmProvider: string
    model: string
  }
  /** Opt-in isolated git worktree. OFF by default; undefined treated as false. */
  worktreeEnabled?: boolean
  order: number
  pinnedAt?: string
  settledAt?: string
  /** Set once the user commits the first message (send/enqueue). */
  startedAt?: string
}

interface ActiveThreadState {
  id: string
}

export class ThreadDataStore extends EventEmitter {
  /**
   * Warm list cache. Invalidated on mutations; also keyed by project set so
   * opening/removing a project forces a rescan without an explicit invalidate call.
   */
  private listCache: Thread[] | null = null
  private listCacheProjectsKey: string | null = null
  private standaloneListCache: Thread[] | null = null
  private projectListCache = new Map<string, Thread[]>()
  private readonly storageLayout = new ThreadStorageLayout()
  private readonly storageMigration = new ThreadStorageMigration(this.storageLayout)
  private transactionalOverride?: boolean

  constructor(private projectManager: ProjectManager) {
    super()
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

  createThread(name: string, projectId?: string, projectPath?: string, opts?: { worktreeEnabled?: boolean }): Thread {
    this.invalidateListCache()
    const now = new Date().toISOString()
    const id = uuidv4()
    const meta: ThreadMeta = {
      id,
      name,
      projectId,
      createdAt: now,
      updatedAt: now,
      order: this.nextThreadOrder(projectId, projectPath)
    }
    if (opts?.worktreeEnabled === true) meta.worktreeEnabled = true

    const threadDir = this.resolveThreadDir(meta, projectPath)
    this.ensureThreadDir(threadDir)

    this.writeJsonAtomic(join(threadDir, 'meta.json'), meta)
    this.writeJsonAtomic(join(threadDir, 'messages.json'), [])
    this.writeJsonAtomic(join(threadDir, 'agents.json'), [])
    this.writeJsonAtomic(join(threadDir, 'tasks.json'), [])
    mkdirSync(join(threadDir, 'terminals'), { recursive: true })

    if (!projectId) {
      this.addToStandaloneIndex(meta)
    }

    // This is the authoritative creation notification for every producer:
    // GUI/CLI protocol calls, channels, and scheduled jobs.
    this.emit('created', meta)
    return meta
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

  getThread(id: string): Thread | undefined {
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
      if (existsSync(targetMetaPath) || existsSync(legacyMetaPath)) {
        const threadDir = this.storageMigration.migrateRepository(project.path, project.id, id)
        return JSON.parse(readFileSync(join(threadDir, 'meta.json'), 'utf-8')) as Thread
      }
    }
    return undefined
  }

  updateThreadMeta(
    id: string,
    partial: Partial<Pick<Thread, 'name' | 'modelOverride' | 'worktreeEnabled'>>
  ): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }

    const updated: Thread = {
      ...thread,
      ...partial,
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

  setThreadWorktreeEnabled(id: string, enabled: boolean): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }
    // Gate on actual transcript content, not `startedAt`: the latter is
    // backfilled for merely-named threads with zero messages (see
    // ensureStartedAt), which would otherwise lock the toggle on new chats
    // that never ran a turn.
    const messages = this.loadThreadData(id).messages
    if (messages.length > 0) {
      throw new Error('Worktree mode can only be changed before the first message.')
    }
    const updated: Thread = {
      ...thread,
      updatedAt: new Date().toISOString()
    }
    if (enabled) updated.worktreeEnabled = true
    else delete updated.worktreeEnabled

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
    if (!projectId) this.writeStandaloneIndex(reordered)
    this.invalidateListCache()
    return reordered
  }

  deleteThread(id: string): void {
    const thread = this.getThread(id)
    if (!thread) return

    const threadDir = this.getThreadDir(id)
    if (existsSync(threadDir)) {
      new ThreadTrashService().trash(id, threadDir)
    }

    if (!thread.projectId) {
      this.removeFromStandaloneIndex(id)
    }

    this.invalidateListCache()

    const activeId = this.getActiveThreadId()
    if (activeId === id) {
      this.setActiveThreadId(null)
    }
  }

  restoreThreadFromTrash(id: string): Thread {
    const record = new ThreadTrashService().restore(id)
    const metaPath = join(record.originalPath, 'meta.json')
    if (!existsSync(metaPath)) throw new Error(`Restored thread metadata is missing: ${id}`)
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Thread
    if (!meta.projectId) this.addToStandaloneIndex(meta as ThreadMeta)
    this.invalidateListCache()
    return meta
  }

  purgeThreadFromTrash(id: string): void {
    new ThreadTrashService().purge(id)
    this.invalidateListCache()
  }

  loadThreadData(id: string): ThreadData {
    const threadDir = this.getThreadDir(id)
    return this.loadThreadDataFromDir(threadDir, id)
  }

  private loadThreadDataFromDir(threadDir: string, id: string): ThreadData {
    if (this.transactionalStoreEnabled()) {
      const current = new ThreadGenerationStore(threadDir).loadCurrent()
      if (current) {
        return {
          messages: current.data.messages as ChatMessage[],
          agents: current.data.agents as Agent[],
          tasks: current.data.tasks as Task[],
          llmContext: current.data.llmContext as NativeLlmContext | undefined,
          mousseAgentSessions: parseMousseAgentSessions(current.data.mousseAgentSessions),
          messageQueue: normalizeQueuedMessages(current.data.queue, id)
        }
      }
    }
    return {
      messages: this.readJsonFile<ChatMessage[]>(join(threadDir, 'messages.json'), []),
      agents: this.readJsonFile<Agent[]>(join(threadDir, 'agents.json'), []),
      tasks: this.readJsonFile<Task[]>(join(threadDir, 'tasks.json'), []),
      llmContext: this.readJsonFile<NativeLlmContext | undefined>(
        join(threadDir, 'llm-context.json'),
        undefined
      ),
      mousseAgentSessions: this.loadMousseAgentSessions(threadDir),
      messageQueue: this.readMessageQueueFile(threadDir, id)
    }
  }

  /**
   * Atomic read-modify-write for thread data fields (messages/agents/tasks/llm/mousse).
   * Never writes messageQueue — queue remains exclusively via saveMessageQueue/mutateDurableQueue.
   * Concurrent partial updaters must use this so transcript and agent/task writes cannot clobber.
   */
  mutateThreadData(
    id: string,
    mutator: (current: ThreadData) => {
      messages?: ChatMessage[]
      agents?: Agent[]
      tasks?: Task[]
      llmContext?: NativeLlmContext
      mousseAgentSessions?: MousseAgentSessionSnapshot[]
    }
  ): ThreadData {
    const threadDir = this.getThreadDir(id)
    return withThreadDataMutationLock(threadDir, () => {
      const current = this.loadThreadDataFromDir(threadDir, id)
      const patch = mutator(current)
      const next: ThreadData = {
        messages: patch.messages ?? current.messages,
        agents: patch.agents ?? current.agents,
        tasks: patch.tasks ?? current.tasks,
        llmContext: patch.llmContext !== undefined ? patch.llmContext : current.llmContext,
        mousseAgentSessions:
          patch.mousseAgentSessions !== undefined
            ? patch.mousseAgentSessions
            : current.mousseAgentSessions,
        // Preserve in-memory view of queue for callers; disk queue is not written here.
        messageQueue: current.messageQueue
      }
      this.saveThreadDataUnlocked(id, next)
      return next
    })
  }

  /** Load durable per-thread message queue (queue.json; empty for legacy threads). */
  loadMessageQueue(id: string): QueuedMessage[] {
    const threadDir = this.getThreadDir(id)
    return this.readMessageQueueFile(threadDir, id)
  }

  private readMessageQueueFile(threadDir: string, threadId: string): QueuedMessage[] {
    const raw = this.readJsonFile<unknown>(join(threadDir, 'queue.json'), [])
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
    const transactional = this.transactionalStoreEnabled()
    const journal = transactional ? new ThreadJournal(threadDir) : undefined
    const operationId = transactional ? uuidv4() : undefined
    const intent = journal?.append({
      operationId: operationId!,
      operationType: 'thread-data-save',
      state: 'planned',
      expectedPreState: new ThreadGenerationStore(threadDir).getManifest()
    })

    try {
      // Flat files remain a compatibility projection while generation storage rolls out.
      this.writeJsonAtomic(join(threadDir, 'messages.json'), data.messages)
      this.writeJsonAtomic(join(threadDir, 'agents.json'), data.agents)
      this.writeJsonAtomic(join(threadDir, 'tasks.json'), data.tasks)
      if (data.llmContext) this.writeJsonAtomic(join(threadDir, 'llm-context.json'), data.llmContext)
      if (data.mousseAgentSessions) {
        this.writeJsonAtomic(join(threadDir, 'mousse-agent-sessions.json'), data.mousseAgentSessions)
      }
      // Intentionally do not write queue.json here.

      if (terminalScrollbacks) {
        const terminalsDir = join(threadDir, 'terminals')
        mkdirSync(terminalsDir, { recursive: true })
        for (const [ptyId, scrollback] of Object.entries(terminalScrollbacks)) {
          writeFileSync(join(terminalsDir, `${ptyId}.txt`), scrollback, 'utf-8')
        }
      }

      let resultGenerationId: string | undefined
      if (transactional) {
        const queue = data.messageQueue ?? this.readMessageQueueFile(threadDir, id)
        const manifest = new ThreadGenerationStore(threadDir).publish({
          messages: data.messages,
          agents: data.agents,
          tasks: data.tasks,
          llmContext: data.llmContext,
          queue,
          mousseAgentSessions: data.mousseAgentSessions,
          conversationBranches: [],
          actions: []
        }, intent!.sequence)
        resultGenerationId = manifest.currentGenerationId
        journal!.append({
          operationId: operationId!,
          operationType: 'thread-data-save',
          state: 'completed',
          resultGenerationId
        })
      }

      const metaPath = join(threadDir, 'meta.json')
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ThreadMeta
          meta.updatedAt = new Date().toISOString()
          if (!meta.startedAt && data.messages.length > 0) {
            meta.startedAt = meta.updatedAt
          }
          this.writeJsonAtomic(metaPath, meta)

          if (!meta.projectId) {
            this.updateStandaloneIndexEntry(meta)
          }
          // Keep warm list cache in sync so startedAt/updatedAt surface without a rescan.
          this.patchListCache(meta)
        } catch {
          // Corrupt meta: do not overwrite with a stale reconstructed fallback.
        }
      }
    } catch (error) {
      journal?.append({
        operationId: operationId!,
        operationType: 'thread-data-save',
        state: 'failed',
        details: { error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    }
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
      const messages = this.readJsonFile<ChatMessage[]>(join(threadDir, 'messages.json'), [])
      hasMessages = messages.length > 0
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
      if (!existsSync(getActiveThreadPath())) return null
      const state = JSON.parse(readFileSync(getActiveThreadPath(), 'utf-8')) as ActiveThreadState
      return state.id ?? null
    } catch {
      return null
    }
  }

  setActiveThreadId(id: string | null): void {
    mkdirSync(getMousseHomeDir(), { recursive: true })
    if (!id) {
      if (existsSync(getActiveThreadPath())) {
        rmSync(getActiveThreadPath(), { force: true })
      }
      return
    }
    this.writeJsonAtomic(getActiveThreadPath(), { id })
  }

  getThreadDir(id: string): string {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }
    return this.resolveThreadDir(thread)
  }

  private resolveThreadDir(meta: ThreadMeta, projectPath?: string): string {
    if (meta.projectId) {
      const path = projectPath ?? this.projectManager.getProject(meta.projectId)?.path
      if (!path) throw new Error(`Project not found for thread: ${meta.id}`)
      return this.storageMigration.migrateRepository(path, meta.projectId, meta.id)
    }
    return this.storageMigration.migrateStandalone(meta.id)
  }

  private ensureThreadDir(threadDir: string): void {
    mkdirSync(threadDir, { recursive: true })
    mkdirSync(join(threadDir, 'terminals'), { recursive: true })
  }

  private readStandaloneIndexRaw(): Thread[] {
    return this.readJsonFile<Thread[]>(getThreadsIndexPath(), [])
  }

  private readStandaloneIndex(): Thread[] {
    const threads = this.readStandaloneIndexRaw()
    for (const thread of threads) this.ensureStartedAt(thread)
    return this.ensureThreadOrders(threads, (ordered) => this.writeStandaloneIndex(ordered))
  }

  private writeStandaloneIndex(threads: Thread[]): void {
    const dir = getThreadsIndexPath().replace(/[/\\]threads-index\.json$/, '')
    mkdirSync(dir, { recursive: true })
    this.writeJsonAtomic(getThreadsIndexPath(), threads)
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
    if (existsSync(legacyRoot)) {
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
        const thread = JSON.parse(readFileSync(metaPath, 'utf-8')) as Thread
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
    return threads.reduce((min, thread) => Math.min(min, thread.order), 0) - 1
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
    try {
      if (!existsSync(filePath)) return fallback
      return JSON.parse(readFileSync(filePath, 'utf-8')) as T
    } catch {
      return fallback
    }
  }

  /**
   * Load durable Mousse subagent sessions for a thread directory.
   * Missing, unreadable, or corrupted files yield an empty list (legacy-safe).
   */
  private loadMousseAgentSessions(threadDir: string): MousseAgentSessionSnapshot[] {
    const filePath = join(threadDir, 'mousse-agent-sessions.json')
    try {
      if (!existsSync(filePath)) return []
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
      return parseMousseAgentSessions(raw)
    } catch {
      return []
    }
  }

  /** Same-directory durable replacement with file and parent-directory fsync. */
  private writeJsonAtomic(filePath: string, value: unknown): void {
    atomicWriteJsonSync(filePath, value)
  }

  searchThreads(query: string, limit = 50): Array<{
    threadId: string
    threadName: string
    projectId?: string
    projectName?: string
    matchType: 'thread' | 'project' | 'message'
    snippet?: string
    messageId?: string
  }> {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []

    const results: Array<{
      threadId: string
      threadName: string
      projectId?: string
      projectName?: string
      matchType: 'thread' | 'project' | 'message'
      snippet?: string
      messageId?: string
      score: number
    }> = []

    const projects = this.projectManager.listProjects()
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]))
    const threads = this.listAllThreads()

    for (const thread of threads) {
      if (thread.settledAt) continue
      // Skip pure empty drafts; startedAt may be backfilled above via ensureStartedAt.
      if (!thread.startedAt && isDefaultThreadName(thread.name)) continue
      const projectName = thread.projectId ? projectNameById.get(thread.projectId) : undefined

      if (thread.name.toLowerCase().includes(normalized)) {
        results.push({
          threadId: thread.id,
          threadName: thread.name,
          projectId: thread.projectId,
          projectName,
          matchType: 'thread',
          score: 0
        })
      }

      if (projectName && projectName.toLowerCase().includes(normalized)) {
        results.push({
          threadId: thread.id,
          threadName: thread.name,
          projectId: thread.projectId,
          projectName,
          matchType: 'project',
          score: 1
        })
      }

      try {
        const messages = this.readJsonFile<Array<{ id: string; content: string }>>(
          join(this.getThreadDir(thread.id), 'messages.json'),
          []
        )
        for (const message of messages) {
          const content = message.content ?? ''
          const index = content.toLowerCase().indexOf(normalized)
          if (index === -1) continue

          const start = Math.max(0, index - 40)
          const end = Math.min(content.length, index + normalized.length + 40)
          const snippet =
            (start > 0 ? '…' : '') +
            content.slice(start, end).replace(/\s+/g, ' ').trim() +
            (end < content.length ? '…' : '')

          results.push({
            threadId: thread.id,
            threadName: thread.name,
            projectId: thread.projectId,
            projectName,
            matchType: 'message',
            snippet,
            messageId: message.id,
            score: 2
          })
        }
      } catch {
        /* skip invalid thread data */
      }
    }

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
}
