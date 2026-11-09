import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { AutomationComputer, AutomationIndex, AutomationItem } from '../../../shared/automations'
import { qualifyRoutedResult } from '../../../shared/bridge/routedIds'
import type { NodeId } from '../../../shared/net'
import { qualifyId } from '../../../shared/threadRef'
import type { CreateScheduledJobInput, ScheduledJob } from '../../../shared/types'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { RemoteAutomationsPart, RemoteAutomationsPort } from '../../protocol/remoteAutomationsPort'
import type { ComputerRef } from './computerErrors'
import type { RoutedClient } from './RoutedClient'

/** How long the list waits for one computer before it shows that computer's last copy. */
const READ_DEADLINE_MS = 4_000
/** The copy kept of one computer's automations, at most. A larger one is not kept (its rows go while it is away). */
const CACHE_MAX_BYTES = 2 * 1024 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

interface CachedPart {
  name: string
  timeZone: string
  seenAt: string
  items: AutomationItem[]
  jobs: ScheduledJob[]
}

export interface RemoteAutomationsOptions {
  client: Pick<RoutedClient, 'call'>
  /** The user's other computers (as the router lists them); undefined while the roster cannot be read. */
  computers(): ComputerRef[] | undefined
  online(node: NodeId): boolean
  /** Whether routing is on: off, nothing of another computer's automations is read or kept. */
  enabled(): boolean
  self(): NodeId | undefined
  /** Where the last copy of each computer's automations is kept. */
  cacheFile: string
  matchProject(node: string, projectPath: string, signal?: AbortSignal): Promise<{ projectId: string; weak: boolean } | null>
  clock?: { now(): number }
  readDeadlineMs?: number
}

/**
 * One computer's answer to `automations.list`, named the way this computer names that computer's things: every
 * thread, project and automation id qualified with its node, so a row opens its thread there and an action on it is
 * routed there.
 */
export function qualifyAutomationIndex(node: string, self: string | undefined, raw: AutomationIndex): { items: AutomationItem[]; jobs: ScheduledJob[] } {
  const named = qualifyRoutedResult('automations.list', raw, { node, ...(self ? { self } : {}) }) as AutomationIndex
  const items = (named.items ?? []).map((item): AutomationItem => {
    const id = qualifyId(node, item.id)
    const link: AutomationItem['link'] = item.link.kind === 'job' ? { ...item.link, jobId: qualifyId(node, item.link.jobId) } : item.link
    // What Needs you answers in place is answered on the computer that holds the ask.
    const { attention: held, ...rest } = item
    const attention = held ? (({ answer: _answer, ...kept }) => kept)(held) : undefined
    return { ...rest, key: `${item.kind}:${id}`, id, link, ...(attention ? { attention } : {}) }
  })
  const jobs = (named.jobs ?? []).map((job) => ({ ...job, id: qualifyId(node, job.id) }))
  return { items, jobs }
}

/**
 * The automations of the user's other computers (the Bridge side of `RemoteAutomationsPort`). Each online computer
 * is asked for its list when the page reads it; what each last sent is kept on disk, so an offline computer's rows
 * stay listed from that copy, marked offline. Nothing is kept while routing is off, and a computer that leaves the
 * device list takes its copy with it.
 */
export class RemoteAutomations implements RemoteAutomationsPort {
  private cache: Record<string, CachedPart> | undefined

  constructor(private readonly options: RemoteAutomationsOptions) {}

  private now(): number {
    return (this.options.clock ?? Date).now()
  }

  computers(): Array<{ node: string; name: string; online: boolean }> | undefined {
    if (!this.options.enabled()) return undefined
    return this.options.computers()?.map(({ node, name }) => ({ node, name, online: this.options.online(node) }))
  }

  async read(signal?: AbortSignal): Promise<RemoteAutomationsPart[]> {
    if (!this.options.enabled()) {
      this.dropCache()
      return []
    }
    const listed = this.options.computers()
    // A roster that cannot be read now changes nothing on disk, and lists no other computer.
    if (!listed) return []
    const cache = this.loadCache()
    const present = new Set(listed.map((ref) => ref.node as string))
    let dirty = false
    for (const node of Object.keys(cache)) if (!present.has(node)) { delete cache[node]; dirty = true }
    const parts = await Promise.all(listed.map(async (ref): Promise<RemoteAutomationsPart> => {
      const known = cache[ref.node]
      const base: AutomationComputer = { name: ref.name, timeZone: known?.timeZone ?? '', local: false, node: ref.node }
      if (this.options.online(ref.node)) {
        try {
          const deadline = AbortSignal.timeout(this.options.readDeadlineMs ?? READ_DEADLINE_MS)
          const raw = await this.options.client.call(ref.node, 'automations.list', {}, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline })
          if (isRecord(raw) && Array.isArray(raw.items)) {
            const index = raw as unknown as AutomationIndex
            const { items, jobs } = qualifyAutomationIndex(ref.node, this.options.self(), index)
            const timeZone = typeof index.computer?.timeZone === 'string' && index.computer.timeZone ? index.computer.timeZone : base.timeZone
            const computer: AutomationComputer = { ...base, timeZone }
            const copy: CachedPart = { name: ref.name, timeZone, seenAt: new Date(this.now()).toISOString(), items, jobs }
            if (Buffer.byteLength(JSON.stringify(copy)) <= CACHE_MAX_BYTES) cache[ref.node] = copy
            else delete cache[ref.node]
            dirty = true
            return { computer, items: items.map((item) => ({ ...item, computer })), jobs }
          }
        } catch {
          // Not reached in time, refused or outdated: its last copy shows, marked offline.
        }
      }
      return offlinePart(base, known)
    }))
    if (dirty) this.writeCache(cache)
    return parts
  }

  async create(node: string, input: CreateScheduledJobInput, options: { idem?: string; signal?: AbortSignal } = {}): Promise<ScheduledJob> {
    const result = await this.options.client.call(node as NodeId, 'scheduled.create', { input }, options)
    const job = isRecord(result) ? result.job : undefined
    if (!isRecord(job) || typeof job.id !== 'string') throw new Error('The other computer did not confirm the automation.')
    return job as unknown as ScheduledJob
  }

  async resume(node: string, jobId: string, options: { idem?: string; signal?: AbortSignal } = {}): Promise<void> {
    await this.options.client.call(node as NodeId, 'scheduled.resume', { id: jobId }, options)
  }

  matchProject(node: string, projectPath: string, signal?: AbortSignal): Promise<{ projectId: string; weak: boolean } | null> {
    return this.options.matchProject(node, projectPath, signal)
  }

  private loadCache(): Record<string, CachedPart> {
    if (this.cache) return this.cache
    let loaded: Record<string, CachedPart> = {}
    try {
      if (existsSync(this.options.cacheFile)) {
        const parsed = JSON.parse(readFileSync(this.options.cacheFile, 'utf8')) as unknown
        if (isRecord(parsed))
          for (const [node, entry] of Object.entries(parsed))
            if (isRecord(entry) && Array.isArray(entry.items) && Array.isArray(entry.jobs) && typeof entry.name === 'string')
              loaded[node] = entry as unknown as CachedPart
      }
    } catch {
      // An unreadable copy is no copy: the rows come back when the computer answers.
      loaded = {}
    }
    this.cache = loaded
    return loaded
  }

  private writeCache(cache: Record<string, CachedPart>): void {
    this.cache = cache
    try {
      atomicWriteJsonSync(this.options.cacheFile, cache)
    } catch {
      // The copy in memory still serves; the next read writes it again.
    }
  }

  private dropCache(): void {
    if (this.cache && !Object.keys(this.cache).length) return
    this.cache = {}
    try {
      rmSync(this.options.cacheFile, { force: true })
    } catch {
      // Tried again on the next read.
    }
  }
}

/**
 * A computer that cannot be reached: its last copy, marked offline. Its timed automations wait for it (the waiting
 * reason is offline), whatever they were doing when it was last seen.
 */
export function offlinePart(base: AutomationComputer, known: CachedPart | undefined): RemoteAutomationsPart {
  const computer: AutomationComputer = { ...base, offline: true, ...(known ? { seenAt: known.seenAt } : {}) }
  const items = (known?.items ?? []).map((item): AutomationItem => {
    const waits = !item.paused && (item.next || item.active)
    const { active: _active, ...rest } = item
    return {
      ...rest,
      computer,
      ...(waits ? { active: { at: item.next?.at ?? item.active!.at, state: 'waiting' as const, reason: 'offline' as const } } : {})
    }
  })
  return { computer, items, jobs: known?.jobs ?? [] }
}
