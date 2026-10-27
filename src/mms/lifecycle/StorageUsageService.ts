import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import type { StorageUsageEntry, StorageUsageKind, StorageUsageSnapshot } from '../../shared/storage'
import { nearestVisibleAncestor } from '../../shared/threadLineage'
import type { Project, Thread } from '../../shared/types'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { measureTree, skipKey } from './diskMeasure'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'

const SCAN_BUDGET_MS = 20_000
const SCAN_ENTRY_BUDGET = 1_000_000
const REST_MS = 2_000
const FIRST_SCAN_DELAY_MS = 2 * 60_000
const SCAN_INTERVAL_MS = 6 * 60 * 60_000
/** A remote caller's answer must fit well inside one 64 KiB reply. */
export const USAGE_SNAPSHOT_MAX_BYTES = 40_000
const CACHE_FILE = 'storage-usage.json'
const RECORD_MAX_BYTES = 4 * 1024 * 1024
const INDEX_MAX_FILES = 20_000
const INDEX_RECORD_MAX_BYTES = 64 * 1024
const BINDING_MAX_FILES = 5_000
const NAME_MAX = 200

export interface StorageUsageDeps {
  store: ResourceLifecycleStore
  threads: { listAllThreads(): Thread[] }
  projects: { listProjects(): Project[] }
  installationHome: string
  /** True while a cleanup run is changing the disk; timed scans wait for it. */
  busy?: () => boolean
  now?: () => number
  /** Test seams. */
  measure?: typeof measureTree
  scanBudgetMs?: number
  scanEntryBudget?: number
  restMs?: number
  firstScanDelayMs?: number
  intervalMs?: number
  /** Keep scanning in the background until a generation completes. Tests turn it off to step by hand. */
  autoContinue?: boolean
}

/** One folder measured on its own, with what it is attributed to. */
interface UsageRoot {
  id: string
  path: string
  key: string
  kind: StorageUsageKind
  threadId?: string
  projectId?: string
  /** The folder came from a record file: it is measured only if it really sits inside one of these folders. */
  confine?: boolean
  /** Folders inside this one that something else measures. */
  extraSkip?: string[]
}

interface RootResult {
  id: string
  kind: StorageUsageKind
  threadId?: string
  projectId?: string
  bytes: number
  files: number
  estimated?: true
  partial?: true
  measuredAt: number
  generation: number
}

/** A scan generation: the roots in a fixed order, how far the scans have got, and the hard links already counted. */
interface Generation {
  number: number
  roots: UsageRoot[]
  sorted: string[]
  cursor: number
  seen: Set<string>
  complete: boolean
}

const ORDER: Record<StorageUsageKind, number> = { threads: 0, worktrees: 1, browser: 2, logs: 3, other: 4 }

function within(root: string, path: string): boolean {
  const rel = relative(skipKey(root), skipKey(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function readJson(path: string, maxBytes = RECORD_MAX_BYTES): unknown {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > maxBytes) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch { return undefined }
}
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const rootId = (key: string): string => createHash('sha1').update(key).digest('hex').slice(0, 16)

function directories(path: string, limit = 50_000): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).slice(0, limit).map((entry) => join(path, entry.name))
  } catch { return [] }
}

function lowerBound(sorted: readonly string[], value: string): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle] < value) low = middle + 1
    else high = middle
  }
  return low
}

const entryKey = (entry: Pick<StorageUsageEntry, 'kind' | 'projectId' | 'threadId'>): string => `${entry.kind}\0${entry.projectId ?? ''}\0${entry.threadId ?? ''}`

function merge(entries: Iterable<StorageUsageEntry>): StorageUsageEntry[] {
  const merged = new Map<string, StorageUsageEntry>()
  for (const entry of entries) {
    const key = entryKey(entry)
    const into = merged.get(key)
    if (!into) { merged.set(key, { ...entry }); continue }
    into.bytes += entry.bytes
    into.files += entry.files
    if (entry.estimated) into.estimated = true
    if (entry.partial) into.partial = true
  }
  return [...merged.values()]
}

function foldKeeping(entries: readonly StorageUsageEntry[], field: 'threadId' | 'projectId', keep: number): StorageUsageEntry[] {
  const ranked = entries.filter((entry) => entry[field]).sort((a, b) => b.bytes - a.bytes)
  const kept = new Set(ranked.slice(0, keep))
  return merge(entries.map((entry) => {
    if (!entry[field] || kept.has(entry)) return entry
    const folded = { ...entry }
    delete folded[field]
    return folded
  }))
}

/**
 * Keeps an answer small enough for a remote reply: when the entries do not fit, the smallest
 * threads (then projects) lose their id and join the total for their kind. Totals never change.
 */
export function condenseUsage(entries: StorageUsageEntry[], maxBytes: number): { entries: StorageUsageEntry[]; condensed: boolean } {
  const size = (list: readonly StorageUsageEntry[]): number => JSON.stringify(list).length
  if (size(entries) <= maxBytes) return { entries, condensed: false }
  let base = entries
  for (const field of ['threadId', 'projectId'] as const) {
    for (const keep of [100, 50, 25, 10, 0]) {
      const folded = foldKeeping(base, field, keep)
      if (size(folded) <= maxBytes) return { entries: folded, condensed: true }
    }
    base = foldKeeping(base, field, 0)
  }
  return { entries: base, condensed: true }
}

/**
 * Disk usage for Settings > Storage, measured in the daemon and cached.
 *
 * The profile's data is split into roots (each thread's folder, each worktree, each browser session,
 * the logs, the remainder), and every root is measured on its own, in a fixed order, within a time
 * and entry budget per scan. A scan continues where the last one stopped (a cursor over the roots), and
 * counts a hard-linked file once across the whole generation, so a large profile finishes over a few
 * scans and the snapshot says it is partial until then. Reads only: it takes no lease and cannot
 * block, or be blocked by, a cleanup run; whatever a run removes meanwhile is skipped and the next scan
 * (a run that removed something asks for one) corrects the numbers.
 *
 * The snapshot carries ids and names, never paths, and only for threads and projects the profile
 * currently lists.
 */
export class StorageUsageService {
  private readonly results = new Map<string, RootResult>()
  private generation?: Generation
  private generationNumber = 0
  private loadedComplete = false
  private loaded = false
  private durationMs = 0
  private scanning?: { promise: Promise<void>; fresh: boolean }
  private loop?: Promise<void>
  private freshRequested = false
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private sleepers = new Set<() => void>()
  private interval?: ReturnType<typeof setInterval>
  private rescan?: ReturnType<typeof setTimeout>
  private stopping = false
  private readonly now: () => number
  private readonly measureRoot: typeof measureTree

  constructor(private readonly deps: StorageUsageDeps) {
    this.now = deps.now ?? Date.now
    this.measureRoot = deps.measure ?? measureTree
  }

  start(): void {
    if (this.interval) return
    this.stopping = false
    const delay = this.deps.firstScanDelayMs ?? FIRST_SCAN_DELAY_MS
    const first = setTimeout(() => { this.timers.delete(first); void this.background(this.isComplete()) }, delay)
    first.unref()
    this.timers.add(first)
    this.interval = setInterval(() => { void this.background(this.isComplete()) }, this.deps.intervalMs ?? SCAN_INTERVAL_MS)
    this.interval.unref()
  }

  async stop(): Promise<void> {
    this.stopping = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.interval) clearInterval(this.interval)
    if (this.rescan) clearTimeout(this.rescan)
    this.interval = this.rescan = undefined
    for (const wake of [...this.sleepers]) wake()
    await this.scanning?.promise.catch(() => undefined)
    await this.loop?.catch(() => undefined)
  }

  /**
   * The cached snapshot. With nothing cached yet, or when `refresh` is set, it scans first (a refresh
   * starts a new generation). Otherwise it never touches the disk.
   */
  async measure(options: { refresh?: boolean } = {}): Promise<StorageUsageSnapshot> {
    this.load()
    if (options.refresh) {
      await this.scan(true)
      this.continueInBackground()
    } else if (!this.results.size) {
      await this.scan(false)
      this.continueInBackground()
    }
    return this.snapshot()
  }

  /** One more scan of the current generation (a new one when none is under way). The scan a timer would run. */
  async continueScan(): Promise<StorageUsageSnapshot> {
    this.load()
    await this.scan(false)
    return this.snapshot()
  }

  /** Something big changed on disk (a cleanup run removed data): rescan shortly, from the start. */
  rescanSoon(): void {
    if (this.stopping || this.rescan) return
    this.rescan = setTimeout(() => { this.rescan = undefined; void this.background(true) }, this.deps.restMs ?? REST_MS)
    this.rescan.unref()
  }

  /** True while this generation has measured every root. */
  isComplete(): boolean {
    this.load()
    return this.generation ? this.generation.complete : this.loadedComplete
  }

  /** The cached snapshot, or undefined when nothing has been measured. */
  snapshot(): StorageUsageSnapshot {
    this.load()
    const threads = new Map(this.deps.threads.listAllThreads().map((thread) => [thread.id, thread]))
    const projects = new Map(this.deps.projects.listProjects().map((project) => [project.id, project]))
    const results = [...this.results.values()]
    const attributed: StorageUsageEntry[] = results.filter((result) => result.bytes > 0 || result.files > 0).map((result) => {
      const thread = result.threadId ? threads.get(result.threadId) : undefined
      const projectId = thread?.projectId && projects.has(thread.projectId) ? thread.projectId : undefined
      return {
        kind: result.kind,
        ...(thread ? { threadId: thread.id } : {}),
        ...(projectId ? { projectId } : {}),
        bytes: result.bytes,
        files: result.files,
        ...(result.estimated ? { estimated: true as const } : {}),
        ...(result.partial ? { partial: true as const } : {})
      }
    })
    const { entries, condensed } = condenseUsage(merge(attributed).sort((a, b) => b.bytes - a.bytes), USAGE_SNAPSHOT_MAX_BYTES)
    const names: StorageUsageSnapshot['names'] = { projects: {}, threads: {} }
    for (const entry of entries) {
      if (entry.projectId) names.projects[entry.projectId] = (projects.get(entry.projectId)?.name ?? '').slice(0, NAME_MAX)
      if (entry.threadId) names.threads[entry.threadId] = (threads.get(entry.threadId)?.name ?? '').slice(0, NAME_MAX)
    }
    const oldest = results.length ? Math.min(...results.map((result) => result.measuredAt)) : this.now()
    const current = this.generation?.number ?? this.generationNumber
    return {
      measuredAt: new Date(oldest).toISOString(),
      durationMs: this.durationMs,
      partial: !this.isComplete() || results.some((result) => result.partial || result.generation < current),
      ...(condensed ? { condensed: true as const } : {}),
      entries,
      names
    }
  }

  // ---- Scanning ----

  private scan(fresh: boolean): Promise<void> {
    if (this.scanning) {
      if (!fresh || this.scanning.fresh) return this.scanning.promise
      return this.scanning.promise.then(() => this.scan(true))
    }
    let promise!: Promise<void>
    promise = this.runScan(fresh).finally(() => { if (this.scanning?.promise === promise) this.scanning = undefined })
    this.scanning = { promise, fresh }
    return promise
  }

  private async runScan(fresh: boolean): Promise<void> {
    const budgetMs = this.deps.scanBudgetMs ?? SCAN_BUDGET_MS
    const entryBudget = this.deps.scanEntryBudget ?? SCAN_ENTRY_BUDGET
    const started = this.now()
    try {
      // A finished generation is not continued: the next scan measures everything again, from the first root.
      if (fresh || !this.generation || this.generation.complete) await this.beginGeneration()
      const generation = this.generation!
      let timeLeft = budgetMs
      let entriesLeft = entryBudget
      const real = this.realFolders()
      while (generation.cursor < generation.roots.length && !this.stopping) {
        if (timeLeft <= 0 || entriesLeft <= 0) break
        const root = generation.roots[generation.cursor]
        // The first root of a scan gets the whole budget. A later one that runs out of its share is
        // measured again first thing next scan, with a full budget, rather than kept as a fragment.
        const first = timeLeft === budgetMs && entriesLeft === entryBudget
        const added: string[] = []
        const seen = {
          has: (key: string) => generation.seen.has(key),
          add: (key: string) => { if (!generation.seen.has(key)) { generation.seen.add(key); added.push(key) } return generation.seen }
        }
        const began = this.now()
        const measured = root.confine && !real.some((folder) => this.confined(folder, root.path))
          ? { bytes: 0, files: 0, entries: 0, estimated: false, partial: false, unreadable: 0 }
          : await this.measureRoot(root.path, { mode: 'usage', budgetMs: timeLeft, maxEntries: entriesLeft, seen, skip: this.skipFor(generation, root) })
        timeLeft -= this.now() - began
        entriesLeft -= measured.entries
        if (measured.stopped && !first) {
          for (const key of added) generation.seen.delete(key)
          break
        }
        this.results.set(root.id, {
          id: root.id,
          kind: root.kind,
          ...(root.threadId ? { threadId: root.threadId } : {}),
          ...(root.projectId ? { projectId: root.projectId } : {}),
          bytes: measured.bytes,
          files: measured.files,
          ...(measured.estimated || measured.unreadable > 0 ? { estimated: true as const } : {}),
          ...(measured.stopped ? { partial: true as const } : {}),
          measuredAt: this.now(),
          generation: generation.number
        })
        generation.cursor += 1
      }
      generation.complete = generation.cursor >= generation.roots.length
      this.durationMs = Math.max(0, this.now() - started)
      this.persist()
    } catch {
      // A scan that fails leaves the cache as it was; the next one tries again.
    }
  }

  private realFolders(): string[] {
    const folders: string[] = []
    for (const path of [this.deps.installationHome, this.deps.store.profileHome]) {
      try { folders.push(realpathSync(path)) } catch { /* Absent: nothing can be confined to it. */ }
    }
    return folders
  }

  private confined(realFolder: string, path: string): boolean {
    try { return within(realFolder, realpathSync(path)) } catch { return false }
  }

  private skipFor(generation: Generation, root: UsageRoot): Set<string> {
    const skip = new Set<string>(root.extraSkip)
    const prefix = root.key.endsWith(sep) ? root.key : root.key + sep
    for (let index = lowerBound(generation.sorted, prefix); index < generation.sorted.length && generation.sorted[index].startsWith(prefix); index++) skip.add(generation.sorted[index])
    return skip
  }

  private async beginGeneration(): Promise<void> {
    const roots = await this.buildRoots()
    this.generationNumber += 1
    this.generation = {
      number: this.generationNumber,
      roots,
      sorted: roots.map((root) => root.key).sort(),
      cursor: 0,
      seen: new Set(),
      complete: roots.length === 0
    }
    const live = new Set(roots.map((root) => root.id))
    for (const id of [...this.results.keys()]) if (!live.has(id)) this.results.delete(id)
  }

  /** Splits the profile's data into folders to measure, each with what it belongs to. Reads small records only. */
  private async buildRoots(): Promise<UsageRoot[]> {
    const { store, installationHome } = this.deps
    const profileHome = store.profileHome
    const threads = this.deps.threads.listAllThreads()
    const threadsById = new Map(threads.map((thread) => [thread.id, thread]))
    const projectIds = new Set(this.deps.projects.listProjects().map((project) => project.id))
    let records: TaskLifecycleRecord[] = []
    try { records = store.list().filter((record) => record.state !== 'purged') } catch { /* No lifecycle records: the profile remainder still counts. */ }
    const byId = new Map(records.map((record) => [record.taskId, record]))

    const topParent = (taskId: string): string => {
      const visited = new Set<string>()
      let current = taskId
      for (let parent = byId.get(current)?.parentTaskId; parent && byId.has(parent) && !visited.has(parent); parent = byId.get(current)?.parentTaskId) {
        visited.add(current)
        current = parent
      }
      return current
    }
    /** A live thread owns what its subagents hold; a trashed or unknown one owns nothing in the lists. */
    const owner = (taskId: string | undefined): { threadId?: string; projectId?: string } => {
      if (!taskId) return {}
      const top = topParent(taskId)
      const record = byId.get(top)
      if (!record || record.state !== 'active') return {}
      const id = nearestVisibleAncestor(top, threads) ?? top
      const thread = threadsById.get(id)
      if (!thread) return {}
      return { threadId: thread.id, ...(thread.projectId && projectIds.has(thread.projectId) ? { projectId: thread.projectId } : {}) }
    }

    const roots: UsageRoot[] = []
    const claimed = new Set<string>()
    const push = (kind: StorageUsageKind, path: string | undefined, attribution: { threadId?: string; projectId?: string } = {}, extra: Partial<UsageRoot> = {}): void => {
      if (!path || !isAbsolute(path) || !existsSync(path)) return
      const key = skipKey(path)
      if (claimed.has(key)) return
      claimed.add(key)
      roots.push({ id: rootId(key), path, key, kind, ...attribution, ...extra })
    }
    const insideData = (path: string | undefined): path is string => !!path && isAbsolute(path) && (within(installationHome, path) || within(profileHome, path))
    let visited = 0
    const yieldNow = async (): Promise<void> => { if (++visited % 100 === 0) await new Promise<void>((done) => setImmediate(done)) }

    // Each thread's own folder; trashed and unknown threads are not attributed.
    for (const record of records) {
      await yieldNow()
      push('threads', record.location, owner(record.taskId))
    }
    // Worktrees named by a thread's records, then by workflow bindings. A named path is trusted only inside Mousse's data.
    for (const record of records) {
      await yieldNow()
      const attribution = owner(record.taskId)
      const paths = [text(object(readJson(join(record.location, 'workspace.json')))?.worktreePath)]
      for (const name of ['agents.json', 'mousse-agent-sessions.json']) {
        const rows = readJson(join(record.location, name))
        if (Array.isArray(rows)) for (const row of rows.slice(0, 500)) paths.push(text(object(row)?.worktreePath))
      }
      for (const path of paths) if (insideData(path)) push('worktrees', path, attribution, { confine: true })
    }
    const bindings = join(profileHome, 'workflow-agent-bindings', 'workspaces')
    try {
      for (const name of readdirSync(bindings).filter((entry) => entry.endsWith('.json')).slice(0, BINDING_MAX_FILES)) {
        await yieldNow()
        const binding = object(readJson(join(bindings, name), INDEX_RECORD_MAX_BYTES))
        const path = text(binding?.worktreePath)
        if (insideData(path)) push('worktrees', path, owner(text(binding?.threadId)), { confine: true })
      }
    } catch { /* No workflow bindings. */ }
    // Browser data: sessions and saved artifacts, attributed through the artifact index.
    const browser = join(profileHome, 'browser')
    const indexRoot = join(browser, 'artifact-index')
    const artifactOwner = new Map<string, string>()
    const sessionOwner = new Map<string, string>()
    try {
      for (const name of readdirSync(indexRoot).filter((entry) => entry.endsWith('.json')).slice(0, INDEX_MAX_FILES)) {
        await yieldNow()
        const record = object(readJson(join(indexRoot, name), INDEX_RECORD_MAX_BYTES))
        const scope = object(record?.scope)
        const threadId = text(scope?.threadId)
        if (!threadId) continue
        const artifactId = text(object(record?.ref)?.id)
        const sessionId = text(scope?.sessionId)
        if (artifactId && /^[A-Za-z0-9-]{8,64}$/.test(artifactId)) artifactOwner.set(artifactId, threadId)
        if (sessionId && /^[A-Za-z0-9:_-]{1,160}$/.test(sessionId)) sessionOwner.set(sessionId, threadId)
      }
    } catch { /* No browser index. */ }
    for (const [artifactId, threadId] of artifactOwner) push('browser', join(profileHome, 'artifacts', artifactId), owner(threadId))
    for (const session of directories(join(browser, 'worker-artifacts', store.profileId))) push('browser', session, owner(sessionOwner.get(basename(session))))
    push('browser', join(browser, 'user-data'))
    // Logs.
    for (const folder of [join(installationHome, 'logs'), join(profileHome, 'logs')]) push('logs', folder)
    // Worktree folders nothing names: whatever is left in them, unattributed.
    for (const repository of directories(join(installationHome, 'repositories'))) push('worktrees', join(repository, 'worktrees'))
    push('worktrees', join(installationHome, 'wf'))
    // The rest, so the total matches the disk: this profile's folder, then the installation's own files
    // (other profiles are left out; they are not this profile's data).
    push('other', profileHome)
    if (skipKey(installationHome) !== skipKey(profileHome)) push('other', installationHome, {}, { extraSkip: [skipKey(join(installationHome, 'profiles'))] })

    return roots
      .map((root, index) => ({ root, index }))
      .sort((a, b) => ORDER[a.root.kind] - ORDER[b.root.kind] || a.index - b.index)
      .map(({ root }) => root)
  }

  // ---- Background ----

  private sleep(ms: number): Promise<void> {
    return new Promise((done) => {
      const wake = (): void => { clearTimeout(timer); this.timers.delete(timer); this.sleepers.delete(wake); done() }
      const timer = setTimeout(wake, ms)
      timer.unref()
      this.timers.add(timer)
      this.sleepers.add(wake)
    })
  }

  private continueInBackground(): void {
    if (this.deps.autoContinue === false || this.stopping || this.isComplete()) return
    void this.background(false)
  }

  /**
   * Scans until the generation is complete, resting between scans (at least as long as a scan took)
   * and waiting while a cleanup run is changing the disk. `fresh` starts a new generation first.
   */
  private background(fresh: boolean): Promise<void> {
    if (this.loop) {
      // A scan loop is already running; a request for a fresh generation is picked up on its next turn.
      if (fresh) this.freshRequested = true
      return this.loop
    }
    const rest = this.deps.restMs ?? REST_MS
    this.freshRequested = fresh
    const loop = (async () => {
      while (!this.stopping) {
        while (this.deps.busy?.() && !this.stopping) await this.sleep(rest)
        if (this.stopping) break
        const asFresh = this.freshRequested
        this.freshRequested = false
        await this.scan(asFresh)
        if (this.isComplete() && !this.freshRequested) break
        await this.sleep(Math.max(rest, this.durationMs))
      }
    })().finally(() => { if (this.loop === loop) this.loop = undefined })
    this.loop = loop
    return loop
  }

  // ---- Cache ----

  private get cachePath(): string { return join(this.deps.store.root, CACHE_FILE) }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.cachePath)) return
      assertLifecyclePath(this.deps.store.root, this.cachePath)
      const value = object(readJson(this.cachePath, 16 * 1024 * 1024))
      if (!value || value.schemaVersion !== 1 || !Array.isArray(value.results)) return
      for (const row of value.results) {
        const result = object(row)
        if (!result || typeof result.id !== 'string' || !(result.kind as string in ORDER) || !Number.isFinite(result.bytes) || !Number.isFinite(result.files) || !Number.isFinite(result.measuredAt) || !Number.isFinite(result.generation)) continue
        this.results.set(result.id, {
          id: result.id,
          kind: result.kind as StorageUsageKind,
          ...(text(result.threadId) ? { threadId: text(result.threadId) } : {}),
          ...(text(result.projectId) ? { projectId: text(result.projectId) } : {}),
          bytes: result.bytes as number,
          files: result.files as number,
          ...(result.estimated ? { estimated: true as const } : {}),
          ...(result.partial ? { partial: true as const } : {}),
          measuredAt: result.measuredAt as number,
          generation: result.generation as number
        })
      }
      this.generationNumber = Number.isSafeInteger(value.generation) ? value.generation as number : 0
      this.loadedComplete = value.complete === true
      this.durationMs = Number.isFinite(value.durationMs) ? value.durationMs as number : 0
    } catch { /* An unreadable cache is a cold start. */ }
  }

  /** Figures only: no path is stored, so the cache says nothing the snapshot would not. */
  private persist(): void {
    try {
      assertLifecyclePath(this.deps.store.root, this.cachePath)
      atomicWriteJsonSync(this.cachePath, {
        schemaVersion: 1,
        generation: this.generation?.number ?? this.generationNumber,
        complete: this.generation?.complete ?? this.loadedComplete,
        durationMs: this.durationMs,
        results: [...this.results.values()]
      })
    } catch { /* The cache is an optimization. */ }
  }
}
