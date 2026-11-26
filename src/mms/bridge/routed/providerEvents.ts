import type { NodeId } from '../../../shared/net/ids'
import { DomainRpcError } from '../../protocol/domainRegistry'

/** The records about providers a caller's private channel stream carries. */
export type ProviderChannelType = 'providers.operation' | 'providers.changed'

/** How long a computer that worked on Settings → Providers here keeps hearing about its changes, from its last call. */
export const PROVIDER_FOLLOW_MS = 10 * 60_000
/** Changes to the entries reach a following computer at most this often, as one notice. */
export const PROVIDER_CHANGED_GAP_MS = 500
/** How long progress of an operation is kept for the call that started it, which may return after it. */
export const PROVIDER_EARLY_MS = 10_000
const EARLY_OPERATIONS = 64
/** Operations remembered in all at most; one that never ends gives way to newer ones. */
const OWNED_OPERATIONS = 256
const EARLY_EVENTS = 32

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
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ProviderEventRelayOptions {
  /** Adds a record to the private channel stream `node` holds open; false when it holds none. */
  push(node: NodeId, type: ProviderChannelType, data: unknown): boolean
  timers?: Timers
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The owner's side of Settings → Providers of another computer. The page there works through routed
 * `providers.*` calls; this tells it, on its own channel stream, what a window of this computer learns by
 * event: the progress, prompts and outcome of each operation it started (nobody else's), and that the entries
 * changed (a notice only: the page reads the snapshots again with a routed read, so no record is large).
 *
 * Nothing a caller sends is kept here: a key or a pasted answer is in the call, never in an event.
 */
export class ProviderEventRelay {
  private readonly timers: Timers
  /** Computers that called a providers row lately, and until when they hear about changes. */
  private readonly followers = new Map<NodeId, number>()
  /** Operations a computer started here, by id. */
  private readonly operations = new Map<string, NodeId>()
  /** Events of operations no computer has claimed yet: the call that started one may return after its first events. */
  private readonly early = new Map<string, { at: number; events: unknown[] }>()
  private readonly changedTimers = new Map<NodeId, unknown>()

  constructor(private readonly options: ProviderEventRelayOptions) {
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
      if (this.changedTimers.has(node)) continue
      this.changedTimers.set(
        node,
        this.timers.setTimeout(() => {
          this.changedTimers.delete(node)
          this.options.push(node, 'providers.changed', {})
        }, PROVIDER_CHANGED_GAP_MS)
      )
    }
  }

  close(): void {
    for (const handle of this.changedTimers.values()) this.timers.clearTimeout(handle)
    this.changedTimers.clear()
    this.followers.clear()
    this.operations.clear()
    this.early.clear()
  }

  private operation(data: unknown): void {
    if (!isRecord(data) || typeof data.operationId !== 'string') return
    const operationId = data.operationId
    const node = this.operations.get(operationId)
    if (!node) return this.hold(operationId, data)
    this.options.push(node, 'providers.operation', { event: data })
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
