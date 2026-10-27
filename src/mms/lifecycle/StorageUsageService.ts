import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { STORAGE_USAGE_KINDS, type StorageUsageEntry, type StorageUsageKind, type StorageUsageSnapshot } from '../../shared/storage'
import { isSubagentThread } from '../../shared/threadLineage'
import type { Project, Thread } from '../../shared/types'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { measureTree, skipKey, type Measurement } from './diskMeasure'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'

const SCAN_BUDGET_MS = 20_000
const SCAN_ENTRY_BUDGET = 1_000_000
const REST_MS = 2_000
const FIRST_SCAN_DELAY_MS = 2 * 60_000
const SCAN_INTERVAL_MS = 6 * 60 * 60_000
/** The Bridge refuses a result over 64 KiB; the whole reply, names included, is kept well under it. */
export const USAGE_SNAPSHOT_MAX_BYTES = 56 * 1024
/** Longest names tried, in characters as a person sees them; the last step sends no names. */
const NAME_LIMITS = [200, 80, 32, 12, 0]
const CACHE_FILE = 'storage-usage.json'
const RECORD_MAX_BYTES = 4 * 1024 * 1024
const INDEX_MAX_FILES = 20_000
const INDEX_RECORD_MAX_BYTES = 64 * 1024
const BINDING_MAX_FILES = 5_000
const MAX_DATE_MS = 8.64e15

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
  /** What one step of root discovery (one file read or folder listing) costs against the entry budget. */
  discoveryEntryCost?: number
  restMs?: number
  firstScanDelayMs?: number
  intervalMs?: number
  /** Keep scanning in the background until a generation completes. Tests turn it off to step by hand. */
  autoContinue?: boolean
}

/** One folder measured on its own, with what it is attributed to. */
interface UsageRoot {
  id: string
  /** Canonical: no link on the way down from Mousse's data. */
  path: string
  key: string
  kind: StorageUsageKind
  threadId?: string
  projectId?: string
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
  /** Picked up from the cache after a restart: roots already measured in this generation are not measured again. */
  resumed: boolean
}

/** Mousse's data folders, as written and as they really are, and which path components were found free of links. */
interface Containment {
  bases: Array<{ lex: string; real: string }>
  linkFree: Map<string, boolean>
}

const ORDER: Record<StorageUsageKind, number> = { threads: 0, worktrees: 1, browser: 2, logs: 3, other: 4 }

function within(root: string, path: string): boolean {
  const rel = relative(skipKey(root), skipKey(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const rootId = (key: string): string => createHash('sha1').update(key).digest('hex').slice(0, 16)

async function readJson(path: string, maxBytes = RECORD_MAX_BYTES): Promise<unknown> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > maxBytes) return undefined
    return JSON.parse(await readFile(path, 'utf8'))
  } catch { return undefined }
}

async function directories(path: string, limit = 50_000): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).slice(0, limit).map((entry) => join(path, entry.name))
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

/** The first `max` characters a person would count, never cutting inside an emoji or a surrogate pair. */
export function clipName(name: string, max: number): string {
  // A lone surrogate cannot be encoded; the Bridge refuses a whole reply that holds one.
  const wellFormed = String(name ?? '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
  if (max <= 0) return ''
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let taken = 0
    let end = 0
    for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(wellFormed)) {
      if (taken === max) return wellFormed.slice(0, end)
      taken += 1
      end = part.index + part.segment.length
    }
    return wellFormed
  }
  return Array.from(wellFormed).slice(0, max).join('')
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

/** Keeps the ids of the `keep` biggest threads (or projects), counted over all their entries; the others join their kind's total. */
function foldKeeping(entries: readonly StorageUsageEntry[], field: 'threadId' | 'projectId', keep: number): StorageUsageEntry[] {
  const totals = new Map<string, number>()
  for (const entry of entries) if (entry[field]) totals.set(entry[field]!, (totals.get(entry[field]!) ?? 0) + entry.bytes)
  const kept = new Set([...totals].sort((a, b) => b[1] - a[1]).slice(0, keep).map(([id]) => id))
  return merge(entries.map((entry) => {
    if (!entry[field] || kept.has(entry[field]!)) return entry
    const folded = { ...entry }
    delete folded[field]
    return folded
  }))
}

type Envelope = Pick<StorageUsageSnapshot, 'measuredAt' | 'durationMs' | 'partial'>

/**
 * Builds the reply and makes the whole of it, names and envelope included, fit `maxBytes` of UTF-8:
 * first with the full names, then by folding the smallest threads (then projects) into their kind's
 * total, then with shorter names, and last without names. Totals never change. Names are cut on
 * character boundaries, so no reply carries half an emoji.
 */
export function fitUsage(
  entries: readonly StorageUsageEntry[],
  nameOf: { project(id: string): string; thread(id: string): string },
  envelope: Envelope,
  maxBytes = USAGE_SNAPSHOT_MAX_BYTES
): StorageUsageSnapshot {
  const build = (list: StorageUsageEntry[], nameMax: number, condensed: boolean): StorageUsageSnapshot => {
    const names: StorageUsageSnapshot['names'] = { projects: {}, threads: {} }
    if (nameMax > 0) {
      for (const entry of list) {
        if (entry.projectId) names.projects[entry.projectId] = clipName(nameOf.project(entry.projectId), nameMax)
        if (entry.threadId) names.threads[entry.threadId] = clipName(nameOf.thread(entry.threadId), nameMax)
      }
    }
    return { ...envelope, ...(condensed ? { condensed: true as const } : {}), entries: list, names }
  }
  const size = (snapshot: StorageUsageSnapshot): number => Buffer.byteLength(JSON.stringify(snapshot))
  const sorted = merge(entries).sort((a, b) => b.bytes - a.bytes)
  let last = build(sorted, NAME_LIMITS[0], false)
  for (const nameMax of NAME_LIMITS) {
    const whole = build(sorted, nameMax, false)
    if (size(whole) <= maxBytes) return whole
    let base = sorted
    for (const field of ['threadId', 'projectId'] as const) {
      for (const keep of [100, 50, 25, 10, 0]) {
        last = build(foldKeeping(base, field, keep).sort((a, b) => b.bytes - a.bytes), nameMax, true)
        if (size(last) <= maxBytes) return last
      }
      base = foldKeeping(base, field, 0)
    }
  }
  return last
}

/**
 * Disk usage for Settings > Storage, measured in the daemon and cached.
 *
 * The profile's data is split into roots (each thread's folder, each worktree, each browser session,
 * the logs, the remainder). Finding the roots and measuring them both draw on one time and entry
 * budget per scan, and both resume where the last scan stopped, so a large profile finishes over a few
 * scans and the snapshot says it is partial until then. A hard-linked file is counted once across a
 * generation. Every root must be a real folder inside Mousse's data with no link on the way; that is
 * checked when it is found and again just before it is measured.
 *
 * It reads only and takes no lease. A move or removal that is about to happen asks it to `pause()`:
 * the walk stops at the next entry, so no handle of ours is open in a folder that is about to be
 * renamed (Windows refuses the rename otherwise), and it carries on after the pause is released.
 *
 * The snapshot carries ids and names, never paths, and only for threads and projects the profile
 * currently lists. The cache keeps figures and which roots a generation has measured, not paths.
 */
export class StorageUsageService {
  private readonly results = new Map<string, RootResult>()
  private generation?: Generation
  private generationNumber = 0
  private loadedComplete = false
  private resumable = false
  private loaded = false
  private durationMs = 0
  private discovery?: AsyncGenerator<number, UsageRoot[], void>
  private scanning?: Promise<void>
  private abort?: AbortController
  private holds = 0
  private loop?: Promise<void>
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
    const first = setTimeout(() => { this.timers.delete(first); void this.background() }, this.deps.firstScanDelayMs ?? FIRST_SCAN_DELAY_MS)
    first.unref()
    this.timers.add(first)
    this.interval = setInterval(() => { void this.background() }, this.deps.intervalMs ?? SCAN_INTERVAL_MS)
    this.interval.unref()
  }

  /** Stops the timers and the walk in progress (at its next entry), and waits for it to end. */
  async stop(): Promise<void> {
    this.stopping = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.interval) clearInterval(this.interval)
    if (this.rescan) clearTimeout(this.rescan)
    this.interval = this.rescan = undefined
    this.abort?.abort()
    for (const wake of [...this.sleepers]) wake()
    await this.scanning?.catch(() => undefined)
    await this.loop?.catch(() => undefined)
  }

  /**
   * Stops scanning until the returned function is called, and returns once the walk has stopped and
   * holds no handle. Await it before renaming or removing something a scan may be walking. Pauses
   * stack, and the walk resumes from the root it was in.
   */
  async pause(): Promise<() => void> {
    this.holds += 1
    this.abort?.abort()
    await this.scanning?.catch(() => undefined)
    let released = false
    return () => { if (!released) { released = true; this.holds -= 1 } }
  }

  /**
   * The cached snapshot. With nothing cached yet, or when `refresh` is set, it scans first: one more
   * scan of the pass under way, or a new pass when the last one is complete. Otherwise it never
   * touches the disk.
   */
  async measure(options: { refresh?: boolean } = {}): Promise<StorageUsageSnapshot> {
    this.load()
    if (options.refresh || !this.results.size) {
      await this.scan()
      this.continueInBackground()
    }
    return this.snapshot()
  }

  /** One more scan of the current pass (a new one when none is under way). The scan a timer would run. */
  async continueScan(): Promise<StorageUsageSnapshot> {
    this.load()
    await this.scan()
    return this.snapshot()
  }

  /** Something on disk changed (a removal): measure again shortly, carrying on with a pass that is under way. */
  rescanSoon(): void {
    if (this.stopping || this.rescan) return
    this.rescan = setTimeout(() => { this.rescan = undefined; void this.background() }, this.deps.restMs ?? REST_MS)
    this.rescan.unref()
  }

  /** True while this pass has measured every root. */
  isComplete(): boolean {
    this.load()
    return this.generation ? this.generation.complete : this.loadedComplete
  }

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
    let oldest = this.now()
    if (results.length) { oldest = Infinity; for (const result of results) if (result.measuredAt < oldest) oldest = result.measuredAt }
    const current = this.generation?.number ?? this.generationNumber
    return fitUsage(
      attributed,
      { project: (id) => projects.get(id)?.name ?? '', thread: (id) => threads.get(id)?.name ?? '' },
      {
        measuredAt: new Date(oldest).toISOString(),
        durationMs: this.durationMs,
        partial: !this.isComplete() || results.some((result) => result.partial || result.generation < current)
      }
    )
  }

  // ---- Scanning ----

  private scan(): Promise<void> {
    if (!this.scanning) {
      const promise: Promise<void> = this.runScan().finally(() => { if (this.scanning === promise) this.scanning = undefined })
      this.scanning = promise
    }
    return this.scanning
  }

  private async runScan(): Promise<void> {
    if (this.holds > 0 || this.stopping) return
    const budgetMs = this.deps.scanBudgetMs ?? SCAN_BUDGET_MS
    const entryBudget = this.deps.scanEntryBudget ?? SCAN_ENTRY_BUDGET
    const discoveryCost = this.deps.discoveryEntryCost ?? 1
    const controller = new AbortController()
    this.abort = controller
    const { signal } = controller
    const started = this.now()
    let timeLeft = budgetMs
    let entriesLeft = entryBudget
    let foundRoots = false
    let attempted = false
    try {
      // A finished pass is not continued: the next scan finds the roots again and measures them from the first.
      if (!this.discovery && (!this.generation || this.generation.complete)) this.discovery = this.discover()
      while (this.discovery && !signal.aborted && timeLeft > 0 && entriesLeft > 0) {
        foundRoots = true
        const began = this.now()
        const step = await this.discovery.next()
        timeLeft -= this.now() - began
        if (step.done) { this.beginGeneration(step.value); this.discovery = undefined }
        else entriesLeft -= step.value * discoveryCost
      }
      const generation = this.generation
      if (!this.discovery && generation && !generation.complete) {
        const containment = await this.containment()
        while (generation.cursor < generation.roots.length && !signal.aborted) {
          if (timeLeft <= 0 || entriesLeft <= 0) break
          const root = generation.roots[generation.cursor]
          if (generation.resumed && this.results.get(root.id)?.generation === generation.number) { generation.cursor += 1; continue }
          // The first root of a scan that did not also find roots gets the whole budget. One that runs
          // out of a smaller share is measured again first thing next scan, with a full budget, rather
          // than kept as a fragment.
          const first = !attempted && !foundRoots
          attempted = true
          const added: string[] = []
          const seen = {
            has: (key: string) => generation.seen.has(key),
            add: (key: string) => { if (!generation.seen.has(key)) { generation.seen.add(key); added.push(key) } return generation.seen },
            delete: (key: string) => { const index = added.indexOf(key); if (index >= 0) added.splice(index, 1); return generation.seen.delete(key) }
          }
          const began = this.now()
          // Still the folder that was found: no link has appeared on the way to it since.
          const placed = await this.contain(root.path, containment)
          const gone: Measurement = { bytes: 0, files: 0, entries: 0, estimated: false, partial: false, unreadable: 1 }
          const measured: Measurement = placed.path && skipKey(placed.path) === root.key
            ? await this.measureRoot(root.path, { mode: 'usage', budgetMs: timeLeft, maxEntries: entriesLeft, signal, seen, skip: this.skipFor(generation, root) })
            : gone
          timeLeft -= this.now() - began
          entriesLeft -= measured.entries + placed.cost
          if (measured.stopped === 'aborted' || (measured.stopped && !first)) {
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
      }
      this.durationMs = Math.max(0, this.now() - started)
      this.persist()
    } catch {
      // A scan that fails leaves the cache as it was; the next one finds the roots again.
      this.discovery = undefined
    } finally {
      if (this.abort === controller) this.abort = undefined
    }
  }

  private skipFor(generation: Generation, root: UsageRoot): Set<string> {
    const skip = new Set<string>(root.extraSkip)
    const prefix = root.key.endsWith(sep) ? root.key : root.key + sep
    for (let index = lowerBound(generation.sorted, prefix); index < generation.sorted.length && generation.sorted[index].startsWith(prefix); index++) skip.add(generation.sorted[index])
    return skip
  }

  private beginGeneration(roots: UsageRoot[]): void {
    // After a restart, a pass the cache says was unfinished carries on instead of starting over.
    const resumed = !this.generation && this.resumable && this.generationNumber > 0
    this.resumable = false
    this.generationNumber = resumed ? this.generationNumber : this.generationNumber + 1
    this.generation = {
      number: this.generationNumber,
      roots,
      sorted: roots.map((root) => root.key).sort(),
      cursor: 0,
      seen: new Set(),
      complete: roots.length === 0,
      resumed
    }
    const live = new Set(roots.map((root) => root.id))
    for (const id of [...this.results.keys()]) if (!live.has(id)) this.results.delete(id)
  }

  // ---- Finding the roots ----

  private async containment(): Promise<Containment> {
    const bases: Containment['bases'] = []
    for (const lex of [this.deps.installationHome, this.deps.store.profileHome]) {
      try { bases.push({ lex, real: await realpath(lex) }) } catch { /* Absent: nothing is inside it. */ }
    }
    return { bases, linkFree: new Map() }
  }

  /**
   * The canonical path of `path` if it is inside one of Mousse's data folders and no component below
   * that folder is a link (a symlink or a junction); undefined if it is elsewhere, missing or reached
   * through a link. `cost` counts the `lstat` calls made.
   */
  private async contain(path: string, containment: Containment): Promise<{ path?: string; cost: number }> {
    let cost = 0
    for (const base of containment.bases) {
      // The path may be written with the folder's name as given or as it really is.
      const inside = (origin: string): string | undefined => {
        const rel = relative(origin, path)
        return rel !== '' && (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) ? undefined : rel
      }
      const rel = inside(base.lex) ?? inside(base.real)
      if (rel === undefined) continue
      let current = base.real
      if (rel !== '') {
        for (const part of rel.split(sep)) {
          current = join(current, part)
          const key = skipKey(current)
          let free = containment.linkFree.get(key)
          if (free === undefined) {
            cost += 1
            try { free = !(await lstat(current)).isSymbolicLink() } catch { free = false }
            containment.linkFree.set(key, free)
          }
          if (!free) return { cost }
        }
      }
      return { path: current, cost }
    }
    return { cost }
  }

  /**
   * Finds the roots one small step at a time (a file read, a folder listing, a few `lstat` calls),
   * yielding the number of calls each step made. The scan charges them to its budget and can stop
   * between any two steps; the generator keeps its place for the next scan.
   */
  private async *discover(): AsyncGenerator<number, UsageRoot[], void> {
    const { store, installationHome } = this.deps
    const profileHome = store.profileHome
    const containment = await this.containment()
    let owed = 1
    const step = (): number => { const cost = owed; owed = 0; return cost }
    const threads = this.deps.threads.listAllThreads()
    const threadsById = new Map(threads.map((thread) => [thread.id, thread]))
    const projectIds = new Set(this.deps.projects.listProjects().map((project) => project.id))
    yield step()

    interface TaskRow { taskId: string; state: string; location: string; parentTaskId?: string }
    const records: TaskRow[] = []
    const tasks = join(store.root, 'tasks')
    let names: string[] = []
    try { names = (await readdir(tasks)).filter((name) => name.endsWith('.json')) } catch { /* No lifecycle records: the profile remainder still counts. */ }
    owed += 1
    for (const name of names) {
      const value = object(await readJson(join(tasks, name), 1024 * 1024))
      owed += 2
      if (value && typeof value.taskId === 'string' && typeof value.state === 'string' && typeof value.location === 'string' && value.state !== 'purged' && isAbsolute(value.location))
        records.push({ taskId: value.taskId, state: value.state, location: value.location, ...(text(value.parentTaskId) ? { parentTaskId: text(value.parentTaskId) } : {}) })
      yield step()
    }
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
    /** The thread a person sees for this one: a subagent is its root thread's. */
    const visibleRoot = (id: string): Thread | undefined => {
      const visited = new Set<string>()
      let current = threadsById.get(id)
      while (current && isSubagentThread(current) && !visited.has(current.id)) {
        visited.add(current.id)
        const parent = threadsById.get(current.lineage!.parentThreadId)
        if (!parent) break
        current = parent
      }
      return current
    }
    /** A live thread owns what its subagents hold; a trashed or unknown one owns nothing in the lists. */
    const owner = (taskId: string | undefined): { threadId?: string; projectId?: string } => {
      if (!taskId) return {}
      const top = topParent(taskId)
      if (byId.get(top)?.state !== 'active') return {}
      const thread = visibleRoot(top)
      if (!thread) return {}
      return { threadId: thread.id, ...(thread.projectId && projectIds.has(thread.projectId) ? { projectId: thread.projectId } : {}) }
    }

    const homes = (lex: string): string[] => [lex, ...containment.bases.filter((base) => base.lex === lex).map((base) => base.real)]
    const roots: UsageRoot[] = []
    const claimed = new Set<string>()
    const push = async (kind: StorageUsageKind, path: string | undefined, attribution: { threadId?: string; projectId?: string } = {}, extra: { extraSkip?: string[]; worktree?: boolean } = {}): Promise<void> => {
      if (!path || !isAbsolute(path)) return
      if (extra.worktree && !isWorktreePlace(path, homes(installationHome), homes(profileHome))) return
      const placed = await this.contain(path, containment)
      owed += placed.cost
      if (!placed.path) return
      const key = skipKey(placed.path)
      if (claimed.has(key)) return
      claimed.add(key)
      roots.push({ id: rootId(key), path: placed.path, key, kind, ...attribution, ...(extra.extraSkip ? { extraSkip: extra.extraSkip } : {}) })
    }

    // Each thread's own folder; trashed and unknown threads are not attributed.
    for (const record of records) {
      await push('threads', record.location, owner(record.taskId))
      yield step()
    }
    // Worktrees named by a thread's records, then by workflow bindings. A named path counts only in a place worktrees live.
    for (const record of records) {
      const attribution = owner(record.taskId)
      const paths = [text(object(await readJson(join(record.location, 'workspace.json')))?.worktreePath)]
      owed += 2
      for (const name of ['agents.json', 'mousse-agent-sessions.json']) {
        const rows = await readJson(join(record.location, name))
        owed += 2
        if (Array.isArray(rows)) for (const row of rows.slice(0, 500)) paths.push(text(object(row)?.worktreePath))
      }
      for (const path of paths) await push('worktrees', path, attribution, { worktree: true })
      yield step()
    }
    const bindings = join(profileHome, 'workflow-agent-bindings', 'workspaces')
    let bindingNames: string[] = []
    try { bindingNames = (await readdir(bindings)).filter((entry) => entry.endsWith('.json')).slice(0, BINDING_MAX_FILES) } catch { /* No workflow bindings. */ }
    owed += 1
    for (const name of bindingNames) {
      const binding = object(await readJson(join(bindings, name), INDEX_RECORD_MAX_BYTES))
      owed += 2
      await push('worktrees', text(binding?.worktreePath), owner(text(binding?.threadId)), { worktree: true })
      yield step()
    }
    // Browser data: sessions and saved artifacts, attributed through the artifact index.
    const browser = join(profileHome, 'browser')
    const indexRoot = join(browser, 'artifact-index')
    const artifactOwner = new Map<string, string>()
    const sessionOwner = new Map<string, string>()
    let indexNames: string[] = []
    try { indexNames = (await readdir(indexRoot)).filter((entry) => entry.endsWith('.json')).slice(0, INDEX_MAX_FILES) } catch { /* No browser index. */ }
    owed += 1
    for (const name of indexNames) {
      const record = object(await readJson(join(indexRoot, name), INDEX_RECORD_MAX_BYTES))
      owed += 2
      const scope = object(record?.scope)
      const threadId = text(scope?.threadId)
      if (threadId) {
        const artifactId = text(object(record?.ref)?.id)
        const sessionId = text(scope?.sessionId)
        if (artifactId && /^[A-Za-z0-9-]{8,64}$/.test(artifactId)) artifactOwner.set(artifactId, threadId)
        if (sessionId && /^[A-Za-z0-9:_-]{1,160}$/.test(sessionId)) sessionOwner.set(sessionId, threadId)
      }
      yield step()
    }
    for (const [artifactId, threadId] of artifactOwner) {
      await push('browser', join(profileHome, 'artifacts', artifactId), owner(threadId))
      yield step()
    }
    const sessions = await this.safeDirectories(join(browser, 'worker-artifacts', store.profileId), containment)
    owed += sessions.cost + 1
    yield step()
    for (const session of sessions.paths) {
      await push('browser', session, owner(sessionOwner.get(basename(session))))
      yield step()
    }
    await push('browser', join(browser, 'user-data'))
    for (const folder of [join(installationHome, 'logs'), join(profileHome, 'logs')]) await push('logs', folder)
    yield step()
    // Worktree folders nothing names: whatever is left in them, unattributed.
    const repositories = await this.safeDirectories(join(installationHome, 'repositories'), containment)
    owed += repositories.cost + 1
    yield step()
    for (const repository of repositories.paths) {
      await push('worktrees', join(repository, 'worktrees'))
      yield step()
    }
    await push('worktrees', join(installationHome, 'wf'))
    // The rest, so the total matches the disk: this profile's folder, then the installation's own files
    // (other profiles are left out; they are not this profile's data).
    await push('other', profileHome)
    if (skipKey(installationHome) !== skipKey(profileHome)) await push('other', installationHome, {}, { extraSkip: [skipKey(join(installationHome, 'profiles'))] })
    yield step()

    return roots
      .map((root, index) => ({ root, index }))
      .sort((a, b) => ORDER[a.root.kind] - ORDER[b.root.kind] || a.index - b.index)
      .map(({ root }) => root)
  }

  /** The folders directly inside `path`, listed only when `path` itself is inside Mousse's data with no link on the way. */
  private async safeDirectories(path: string, containment: Containment): Promise<{ paths: string[]; cost: number }> {
    const placed = await this.contain(path, containment)
    if (!placed.path) return { paths: [], cost: placed.cost }
    return { paths: await directories(placed.path), cost: placed.cost }
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
    if (this.deps.autoContinue === false || this.stopping || (this.isComplete() && !this.discovery)) return
    void this.background()
  }

  /**
   * Scans until the pass is complete, resting between scans (twice as long as a scan took, at least a
   * little) and waiting while a cleanup run or a pause holds the disk. A complete pass is followed by
   * a new one only when this is called again (the timer, or a removal).
   */
  private background(): Promise<void> {
    if (this.loop) return this.loop
    const rest = this.deps.restMs ?? REST_MS
    const loop: Promise<void> = (async () => {
      while (!this.stopping) {
        while ((this.deps.busy?.() || this.holds > 0) && !this.stopping) await this.sleep(rest)
        if (this.stopping) break
        await this.scan()
        if (this.isComplete() && !this.discovery) break
        await this.sleep(Math.max(rest, 2 * this.durationMs))
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
      const value = object(JSON.parse(readFileSync(this.cachePath, 'utf8')))
      if (!value || value.schemaVersion !== 1 || !Array.isArray(value.results) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return
      const loaded: RootResult[] = []
      for (const row of value.results) {
        const result = object(row)
        const valid = result
          && typeof result.id === 'string' && /^[0-9a-f]{16}$/.test(result.id)
          && typeof result.kind === 'string' && STORAGE_USAGE_KINDS.includes(result.kind as StorageUsageKind)
          && Number.isSafeInteger(result.bytes) && (result.bytes as number) >= 0
          && Number.isSafeInteger(result.files) && (result.files as number) >= 0
          && Number.isFinite(result.measuredAt) && Math.abs(result.measuredAt as number) <= MAX_DATE_MS
          && Number.isSafeInteger(result.generation) && (result.generation as number) >= 0 && (result.generation as number) <= (value.generation as number)
        // One bad row means the file is not trusted as a whole: start cold.
        if (!valid) return
        loaded.push({
          id: result.id as string,
          kind: result.kind as StorageUsageKind,
          ...(text(result.threadId) ? { threadId: text(result.threadId) } : {}),
          ...(text(result.projectId) ? { projectId: text(result.projectId) } : {}),
          bytes: result.bytes as number,
          files: result.files as number,
          ...(result.estimated === true ? { estimated: true as const } : {}),
          ...(result.partial === true ? { partial: true as const } : {}),
          measuredAt: result.measuredAt as number,
          generation: result.generation as number
        })
      }
      for (const result of loaded) this.results.set(result.id, result)
      this.generationNumber = value.generation as number
      this.loadedComplete = value.complete === true
      this.resumable = !this.loadedComplete && loaded.length > 0
      this.durationMs = Number.isFinite(value.durationMs) && (value.durationMs as number) >= 0 ? value.durationMs as number : 0
    } catch { /* An unreadable cache is a cold start. */ }
  }

  /**
   * Figures only: no path is stored. `complete` and the generation number let a restart carry on with
   * an unfinished pass (roots measured in it are kept, the rest are measured); the hard links counted
   * before the restart are not remembered, so a file shared between a root measured before and one
   * measured after it can be counted twice until the next pass.
   */
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

/**
 * Where a worktree path named by a record may be: strictly below the managed worktree folders, never the
 * data folders themselves or anything else in them.
 */
function isWorktreePlace(path: string, installationHomes: readonly string[], profileHomes: readonly string[]): boolean {
  const below = (homes: readonly string[]): string[] | undefined => {
    for (const home of homes) {
      const rel = relative(home, path)
      if (rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) return rel.split(sep).map((part) => part.toLowerCase())
    }
    return undefined
  }
  const installation = below(installationHomes)
  if (installation) {
    if (installation[0] === 'repositories' && installation[2] === 'worktrees' && (installation[3] === 'threads' || installation[3] === 'agents') && installation.length >= 5) return true
    if (installation[0] === 'wf' && installation.length >= 2) return true
  }
  const profile = below(profileHomes)
  return !!profile && profile[0] === 'workflow-agent-bindings' && profile[1] === 'workspaces' && profile.length >= 3
}
