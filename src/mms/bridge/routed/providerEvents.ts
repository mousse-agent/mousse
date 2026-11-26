import type { NodeId } from '../../../shared/net/ids'
import type { ProviderEventEntry, ProviderEventsReply, ProviderOperationEvent } from '../../../shared/harness/types'
import { DomainRpcError } from '../../protocol/domainRegistry'

/** How long a computer that worked on Settings → Providers here keeps hearing about its changes, from its last call. */
export const PROVIDER_FOLLOW_MS = 10 * 60_000
/** How long progress of an operation is kept for the call that started it, which may return after it. */
export const PROVIDER_EARLY_MS = 10_000
/** How long an entry no read has taken is kept for a computer. */
export const PROVIDER_EVENT_KEEP_MS = 2 * 60_000
const EARLY_OPERATIONS = 64
/** Operations remembered in all at most; one that never ends gives way to newer ones. */
const OWNED_OPERATIONS = 256
const EARLY_EVENTS = 32
/** Entries kept per computer at most; the oldest give way. */
const LOG_ENTRIES = 200

/** The routed calls that start an operation and answer `{ operation: { operationId } }`. */
const STARTS_OPERATION = new Set([
  'providers.instances.install',
  'providers.instances.update',
  'providers.instances.signIn'
])
/** The routed calls that name an operation: only the computer that started it may. */
const NAMES_OPERATION = new Set(['providers.instances.cancelInstall', 'providers.instances.respondSignIn'])

const FINISHED = new Set(['completed', 'failed', 'cancelled'])

/**
 * The settings of an entry that decide which program runs there and how: its program, arguments and variables, an
 * ACP registry agent to download, Codex's own download or the user's CLI, and the older launch settings to take back.
 */
const PROGRAM_SETTINGS = ['binaryPath', 'args', 'env', 'source', 'setup', 'useOlderSettings'] as const

/** The routed calls that download and start the program an entry names. */
const INSTALLS = new Set(['providers.instances.install', 'providers.instances.update'])

/**
 * Whether a routed call decides which program runs on the owner: an `add` or `configure` that sets one of the
 * program settings, or an install or update of an entry whose program is an ACP registry agent or a path of its own.
 * Each runs a program of the caller's choosing there, so it needs the same permission as a terminal there.
 * `entry` is the stored settings of the entry the call names.
 */
export function choosesProgram(method: string, params: Record<string, unknown>, entry: (instanceId: string) => Record<string, unknown> | undefined): boolean {
  const settings = method === 'providers.instances.add' ? params.config : method === 'providers.instances.configure' ? params.patch : undefined
  if (isRecord(settings) && PROGRAM_SETTINGS.some((key) => settings[key] !== undefined)) return true
  if (!INSTALLS.has(method) || typeof params.instanceId !== 'string') return false
  const stored = entry(params.instanceId)
  return isRecord(stored?.source) || typeof stored?.binaryPath === 'string'
}

/**
 * A routed providers reply for a computer without terminal access here: an entry's launch arguments and the values
 * of its variables are left out (they often hold keys and tokens), the variables' names stay, and `launchHidden`
 * says so. Every snapshot in the reply is covered, wherever it sits (`snapshot`, `snapshots`, `results[].snapshot`).
 */
export function withHiddenLaunchSettings(value: unknown, depth = 0): unknown {
  if (depth > 6) return value
  if (Array.isArray(value)) return value.map((item) => withHiddenLaunchSettings(item, depth + 1))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'config' && isRecord(inner) && ('env' in inner || 'args' in inner)) {
      const env = isRecord(inner.env) ? Object.fromEntries(Object.keys(inner.env).map((name) => [name, ''])) : {}
      out[key] = { ...inner, args: [], env, launchHidden: true }
    } else out[key] = withHiddenLaunchSettings(inner, depth + 1)
  }
  return out
}

interface Timers {
  now(): number
}

export interface ProviderEventRelayOptions {
  timers?: Timers
}

const realTimers: Timers = { now: () => Date.now() }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

type LoggedEntry = ProviderEventEntry & { at: number }

/**
 * The owner's side of Settings → Providers of another computer. The page there works through routed `providers.*`
 * calls and asks with `providers.events` what a window of this computer learns by event: the progress, prompts and
 * outcome of each operation it started (nobody else's), and that the entries changed (a notice only: the page reads
 * the snapshots again with a routed read).
 *
 * Everything here is in memory, and nothing of it is sent or kept anywhere else: a sign-in's link, device code or
 * error text is never written to disk on either computer. An entry goes once a read moved past it, once the operation
 * it belongs to finished and was read, or after a while; a page that opens later reads from then on, never the past.
 * Nothing a caller sends is kept here either: a key or a pasted answer is in the call, never in an event.
 */
export class ProviderEventRelay {
  private readonly timers: Timers
  /** Computers that called a providers row lately, and until when they hear about changes. */
  private readonly followers = new Map<NodeId, number>()
  /** Operations a computer started here, by id. */
  private readonly operations = new Map<string, NodeId>()
  /** Events of operations no computer has claimed yet: the call that started one may return after its first events. */
  private readonly early = new Map<string, { at: number; events: unknown[] }>()
  /** What each computer has not read yet, numbered. */
  private readonly logs = new Map<NodeId, { seq: number; entries: LoggedEntry[] }>()

  constructor(options: ProviderEventRelayOptions = {}) {
    this.timers = options.timers ?? realTimers
  }

  /**
   * A routed call from `node` is about to run. A call that names an operation (cancel, answer a sign-in) must name
   * one that computer started.
   */
  admit(node: NodeId, method: string, params: Record<string, unknown>): void {
    if (!NAMES_OPERATION.has(method)) return
    const operationId = params.operationId
    if (typeof operationId !== 'string' || this.operations.get(operationId) !== node)
      throw new DomainRpcError('not_found', 'That sign-in or install is not running.')
  }

  /** A routed providers call from `node` went through: it follows the changes, and owns the operation it started. */
  called(node: NodeId, method: string, result: unknown): void {
    if (!method.startsWith('providers.')) return
    this.followers.set(node, this.timers.now() + PROVIDER_FOLLOW_MS)
    if (!STARTS_OPERATION.has(method)) return
    const operation = isRecord(result) && isRecord(result.operation) ? result.operation : undefined
    const operationId = typeof operation?.operationId === 'string' ? operation.operationId : undefined
    if (!operationId) return
    this.operations.set(operationId, node)
    if (this.operations.size > OWNED_OPERATIONS) {
      const oldest = this.operations.keys().next().value
      if (oldest !== undefined) this.operations.delete(oldest)
    }
    const held = this.early.get(operationId)
    this.early.delete(operationId)
    for (const event of held?.events ?? []) this.operation(event)
  }

  /** An event of this computer's provider instances (`HarnessInstanceGateway.subscribe`). */
  event(event: { type: 'snapshots' | 'operation'; data: unknown }): void {
    if (event.type === 'operation') return this.operation(event.data)
    // Only the computer's own list: a project's view of it is not what another computer's page shows.
    const scope = isRecord(event.data) && isRecord(event.data.scope) ? event.data.scope : undefined
    if (scope?.kind !== 'device') return
    const now = this.timers.now()
    for (const [node, until] of this.followers) {
      if (until <= now) {
        this.followers.delete(node)
        continue
      }
      // One notice stands for every change until it is read.
      if (!this.logOf(node).entries.some((entry) => entry.kind === 'changed')) this.append(node, { kind: 'changed' })
    }
  }

  /**
   * `providers.events` of `node`: without `after`, where its entries stand now and none of the past; with it, the
   * entries after it. Entries up to `after` were read, and so were the operations whose end this answer carries.
   */
  read(node: NodeId, after: unknown): ProviderEventsReply {
    const log = this.logOf(node)
    this.prune(log)
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return { cursor: log.seq, events: [] }
    log.entries = log.entries.filter((entry) => entry.seq > after)
    const events: ProviderEventEntry[] = log.entries.map(({ at: _at, ...entry }) => entry as ProviderEventEntry)
    const ended = new Set(
      events.flatMap((entry) => (entry.kind === 'operation' && FINISHED.has(entry.event.phase) ? [entry.event.operationId] : []))
    )
    // An operation that ended is never answered again, to this page or a later one.
    if (ended.size) log.entries = log.entries.filter((entry) => entry.kind !== 'operation' || !ended.has(entry.event.operationId))
    if (events.some((entry) => entry.kind === 'changed')) log.entries = log.entries.filter((entry) => entry.kind !== 'changed')
    return { cursor: log.seq, events }
  }

  close(): void {
    this.followers.clear()
    this.operations.clear()
    this.early.clear()
    this.logs.clear()
  }

  private logOf(node: NodeId): { seq: number; entries: LoggedEntry[] } {
    let log = this.logs.get(node)
    if (!log) {
      log = { seq: 0, entries: [] }
      this.logs.set(node, log)
    }
    return log
  }

  private append(node: NodeId, entry: { kind: 'changed' } | { kind: 'operation'; event: ProviderOperationEvent }): void {
    const log = this.logOf(node)
    this.prune(log)
    log.seq += 1
    log.entries.push({ ...entry, seq: log.seq, at: this.timers.now() })
    if (log.entries.length > LOG_ENTRIES) log.entries.splice(0, log.entries.length - LOG_ENTRIES)
  }

  private prune(log: { entries: LoggedEntry[] }): void {
    const now = this.timers.now()
    if (log.entries.some((entry) => entry.at + PROVIDER_EVENT_KEEP_MS <= now))
      log.entries = log.entries.filter((entry) => entry.at + PROVIDER_EVENT_KEEP_MS > now)
  }

  private operation(data: unknown): void {
    if (!isRecord(data) || typeof data.operationId !== 'string') return
    const operationId = data.operationId
    const node = this.operations.get(operationId)
    if (!node) return this.hold(operationId, data)
    this.append(node, { kind: 'operation', event: data as unknown as ProviderOperationEvent })
    if (typeof data.phase === 'string' && FINISHED.has(data.phase)) this.operations.delete(operationId)
  }

  private hold(operationId: string, data: Record<string, unknown>): void {
    const now = this.timers.now()
    for (const [id, held] of this.early) if (held.at + PROVIDER_EARLY_MS <= now) this.early.delete(id)
    let held = this.early.get(operationId)
    if (!held) {
      if (this.early.size >= EARLY_OPERATIONS) {
        const oldest = this.early.keys().next().value
        if (oldest !== undefined) this.early.delete(oldest)
      }
      held = { at: now, events: [] }
      this.early.set(operationId, held)
    }
    if (held.events.length < EARLY_EVENTS) held.events.push(data)
  }
}
