import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import type {
  Agent,
  ChatMessage,
  MousseAgentSessionSnapshot,
  NativeLlmContext,
  QueuedMessage,
  Task,
  Thread,
  ThreadData
} from '../../shared/types'
import { isDefaultThreadName } from '../../shared/threadTitle'
import { parseMousseAgentSessions } from '../agents/MousseAgentService'
import { normalizeQueuedMessages } from '../queue/ThreadMessageQueue'
import type { ProjectManager } from './ProjectManager'
import {
  getActiveThreadPath,
  getMousseHomeDir,
  getProjectThreadDir,
  getStandaloneThreadDir,
  getThreadsIndexPath
} from './paths'

interface ThreadMeta {
  id: string
  name: string
  projectId?: string
  createdAt: string
  updatedAt: string
  order: number
  pinnedAt?: string
  settledAt?: string
  /** Set once the thread has at least one message. */
  startedAt?: string
}

interface ActiveThreadState {
  id: string
}

export class ThreadDataStore {
  constructor(private projectManager: ProjectManager) {}

  createThread(name: string, projectId?: string, projectPath?: string): Thread {
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

    const threadDir = this.resolveThreadDir(meta, projectPath)
    this.ensureThreadDir(threadDir)

    writeFileSync(join(threadDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
    writeFileSync(join(threadDir, 'messages.json'), '[]', 'utf-8')
    writeFileSync(join(threadDir, 'agents.json'), '[]', 'utf-8')
    writeFileSync(join(threadDir, 'tasks.json'), '[]', 'utf-8')
    mkdirSync(join(threadDir, 'terminals'), { recursive: true })

    if (!projectId) {
      this.addToStandaloneIndex(meta)
    }

    return meta
  }

  listThreads(projectId?: string): Thread[] {
    if (projectId) {
      const project = this.projectManager.getProject(projectId)
      if (!project) return []
      return this.scanProjectThreads(project.path)
    }
    return this.readStandaloneIndex()
  }

  listAllThreads(): Thread[] {
    const standalone = this.readStandaloneIndex()
    const projectThreads = this.projectManager.listProjects().flatMap((project) =>
      this.scanProjectThreads(project.path)
    )
    return [...standalone, ...projectThreads]
  }

  getThread(id: string): Thread | undefined {
    const standalone = this.readStandaloneIndex().find((t) => t.id === id)
    if (standalone) return standalone

    for (const project of this.projectManager.listProjects()) {
      const metaPath = join(getProjectThreadDir(project.path, id), 'meta.json')
      if (existsSync(metaPath)) {
        return JSON.parse(readFileSync(metaPath, 'utf-8')) as Thread
      }
    }
    return undefined
  }

  updateThreadMeta(id: string, partial: Partial<Pick<Thread, 'name'>>): Thread {
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
    writeFileSync(join(threadDir, 'meta.json'), JSON.stringify(updated, null, 2), 'utf-8')

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

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
    writeFileSync(join(threadDir, 'meta.json'), JSON.stringify(updated, null, 2), 'utf-8')
    if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
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
    writeFileSync(join(threadDir, 'meta.json'), JSON.stringify(updated, null, 2), 'utf-8')

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

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
      writeFileSync(join(this.resolveThreadDir(thread), 'meta.json'), JSON.stringify(thread, null, 2), 'utf-8')
    }
    if (!projectId) this.writeStandaloneIndex(reordered)
    return reordered
  }

  deleteThread(id: string): void {
    const thread = this.getThread(id)
    if (!thread) return

    const threadDir = this.getThreadDir(id)
    if (existsSync(threadDir)) {
      rmSync(threadDir, { recursive: true, force: true })
    }

    if (!thread.projectId) {
      this.removeFromStandaloneIndex(id)
    }

    const activeId = this.getActiveThreadId()
    if (activeId === id) {
      this.setActiveThreadId(null)
    }
  }

  loadThreadData(id: string): ThreadData {
    const threadDir = this.getThreadDir(id)
    return {
      messages: this.readJsonFile<ChatMessage[]>(join(threadDir, 'messages.json'), []),
      agents: this.readJsonFile<Agent[]>(join(threadDir, 'agents.json'), []),
      tasks: this.readJsonFile<Task[]>(join(threadDir, 'tasks.json'), []),
      llmContext: this.readJsonFile<NativeLlmContext | undefined>(join(threadDir, 'llm-context.json'), undefined),
      mousseAgentSessions: this.loadMousseAgentSessions(threadDir),
      messageQueue: this.readMessageQueueFile(threadDir, id)
    }
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

  saveThreadData(
    id: string,
    data: ThreadData,
    terminalScrollbacks?: Record<string, string>
  ): void {
    const threadDir = this.getThreadDir(id)
    this.ensureThreadDir(threadDir)

    this.writeJsonAtomic(join(threadDir, 'messages.json'), data.messages)
    this.writeJsonAtomic(join(threadDir, 'agents.json'), data.agents)
    this.writeJsonAtomic(join(threadDir, 'tasks.json'), data.tasks)
    if (data.llmContext) this.writeJsonAtomic(join(threadDir, 'llm-context.json'), data.llmContext)
    if (data.mousseAgentSessions) {
      this.writeJsonAtomic(join(threadDir, 'mousse-agent-sessions.json'), data.mousseAgentSessions)
    }
    if (data.messageQueue !== undefined) {
      this.writeJsonAtomic(
        join(threadDir, 'queue.json'),
        normalizeQueuedMessages(data.messageQueue, id)
      )
    }

    if (terminalScrollbacks) {
      const terminalsDir = join(threadDir, 'terminals')
      mkdirSync(terminalsDir, { recursive: true })
      for (const [ptyId, scrollback] of Object.entries(terminalScrollbacks)) {
        writeFileSync(join(terminalsDir, `${ptyId}.txt`), scrollback, 'utf-8')
      }
    }

    const metaPath = join(threadDir, 'meta.json')
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ThreadMeta
      meta.updatedAt = new Date().toISOString()
      if (!meta.startedAt && data.messages.length > 0) {
        meta.startedAt = meta.updatedAt
      }
      writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')

      if (!meta.projectId) {
        this.updateStandaloneIndexEntry(meta)
      }
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
        writeFileSync(join(threadDir, 'meta.json'), JSON.stringify(updated, null, 2), 'utf-8')
      } catch {
        // Still expose startedAt in-memory for this listing.
      }
    }
    if (!updated.projectId) this.writeStandaloneIndexEntryRaw(updated)
    thread.startedAt = updated.startedAt
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
    writeFileSync(getActiveThreadPath(), JSON.stringify({ id }, null, 2), 'utf-8')
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
      const path =
        projectPath ?? this.projectManager.getProject(meta.projectId)?.path
      if (!path) {
        throw new Error(`Project not found for thread: ${meta.id}`)
      }
      return getProjectThreadDir(path, meta.id)
    }
    return getStandaloneThreadDir(meta.id)
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
    writeFileSync(getThreadsIndexPath(), JSON.stringify(threads, null, 2), 'utf-8')
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
    const dataDir = join(projectPath, '.mousse', '.data')
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
    return this.ensureThreadOrders(threads, (ordered) => {
      for (const thread of ordered) {
        writeFileSync(join(this.resolveThreadDir(thread, projectPath), 'meta.json'), JSON.stringify(thread, null, 2), 'utf-8')
      }
    })
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

  private writeJsonAtomic(filePath: string, value: unknown): void {
    const temporary = `${filePath}.${process.pid}.${uuidv4()}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf-8')
    renameSync(temporary, filePath)
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
