/**
 * What the Devices screen asks this computer about another one: what it did here (from the audit), the
 * "Always" rules a person on it made, and which turns of a thread it sent. Everything is read from this
 * computer's own records; nothing is asked of the other computer, and no path of this computer is returned
 * (a folder the device asked to open is kept hashed in the audit and left out here).
 */
import type { MmsProfileServices } from '../MmsProfileServices'
import type { NetRuntime } from '../net/NetService'
import { NetError, isId, type NodeId } from '../../shared/net'
import {
  BRIDGE_ACTIVITY_METHODS,
  DEVICE_ACTIVITY_ROWS,
  DEVICE_ACTIVITY_WINDOW_MS,
  type BridgeActivityMethod,
  type BridgeActivityParams,
  type DeviceActivity,
  type DeviceActivityEntry,
  type DeviceRulesCleared,
  type DeviceRuleView,
  type MessageSenders
} from '../../shared/bridge/deviceActivity'
import { deviceNameOf } from './routed/deviceName'

const HOUR_MS = 60 * 60 * 1000
/** A run's sender is read from at most this many events; a thread has far fewer turns from other computers. */
const SENDER_EVENTS_MAX = 5_000

function invalid(): never {
  throw new NetError('bad_request')
}

/** Exact local DTOs: a missing, extra or malformed key is refused. */
export function validateActivityParams<M extends BridgeActivityMethod>(
  method: M,
  value: unknown
): BridgeActivityParams[M] {
  if (!(BRIDGE_ACTIVITY_METHODS as readonly string[]).includes(method)) throw new NetError('forbidden')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  const [required, optional]: [string[], string[]] =
    method === 'bridge.activity'
      ? [['node'], []]
      : method === 'bridge.clearDeviceRules'
        ? [['node'], ['threadId', 'ruleId']]
        : [['threadId'], []]
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return invalid()
  if (row.node !== undefined && !isId('node', row.node)) return invalid()
  for (const key of ['threadId', 'ruleId'])
    if (row[key] !== undefined && (typeof row[key] !== 'string' || !row[key] || (row[key] as string).length > 512))
      return invalid()
  // A rule is named by its thread and its id together.
  if (method === 'bridge.clearDeviceRules' && (row.threadId === undefined) !== (row.ruleId === undefined))
    return invalid()
  return structuredClone(row) as unknown as BridgeActivityParams[M]
}

interface Sources {
  services: MmsProfileServices
  runtime: Pick<NetRuntime, 'audit' | 'identity'>
  now: number
}

/** A thread of this computer by id; anything else (a deleted thread, an id of another computer) is not found. */
function threadHere(services: MmsProfileServices, id: string): { name: string } | undefined {
  try {
    return services.threads.getThread(id)
  } catch {
    return undefined
  }
}

/** The audit's name for a folder a device asked to open and was refused; it is a hash of a path, never shown. */
const isHashedPath = (project: string): boolean => project.startsWith('path:')

function entryOf(
  { services }: Sources,
  row: {
    at: number
    method: string
    kind: DeviceActivityEntry['kind']
    outcome: string
    thread?: string
    project?: string
  }
): DeviceActivityEntry {
  const entry: DeviceActivityEntry = {
    at: row.at,
    method: row.method,
    kind: row.kind,
    outcome: row.outcome
  }
  if (row.thread) entry.thread = { id: row.thread, name: threadHere(services, row.thread)?.name ?? null }
  if (row.project && !isHashedPath(row.project))
    entry.project = { name: services.projects.getProject(row.project)?.name ?? null }
  return entry
}

function rulesOf({ services }: Sources, node: NodeId): DeviceRuleView[] {
  return services.orchestrator.listApprovalRulesMadeBy(node).map(({ threadId, rule }) => ({
    threadId,
    threadName: threadHere(services, threadId)?.name ?? null,
    rule
  }))
}

/** What one device did here lately, what it read in the last day, and the "Always" rules it made. */
export function deviceActivityOf(sources: Sources, node: NodeId): DeviceActivity {
  const { runtime, now } = sources
  const since = now - DEVICE_ACTIVITY_WINDOW_MS
  const summary = runtime.audit.summary(node, since)
  const firstHour = Math.floor(now / HOUR_MS) - 23
  const hours = runtime.audit
    .reads(node)
    .filter((row) => row.hour >= firstHour)
    .map(({ hour, calls, bytes }) => ({ hour, calls, bytes }))
  return {
    node,
    since,
    counts: summary.counts,
    uncertain: summary.uncertain,
    refused: summary.refused,
    entries: runtime.audit.recent(DEVICE_ACTIVITY_ROWS, node).map((row) => entryOf(sources, row)),
    reads: {
      calls: hours.reduce((total, row) => total + row.calls, 0),
      bytes: hours.reduce((total, row) => total + row.bytes, 0),
      hours
    },
    rules: rulesOf(sources, node)
  }
}

/**
 * Takes away the "Always" rules a person on `node` made: one rule, or all of them. Only rules whose source
 * approval was answered by that device are reachable, so the owner's own rules and other devices' are kept.
 */
export function clearDeviceRules(
  sources: Sources,
  params: BridgeActivityParams['bridge.clearDeviceRules']
): DeviceRulesCleared {
  const removed = sources.services.orchestrator.clearApprovalRulesMadeBy(
    params.node,
    params.threadId !== undefined && params.ruleId !== undefined
      ? { threadId: params.threadId, ruleId: params.ruleId }
      : undefined
  )
  return { removed, rules: rulesOf(sources, params.node) }
}

/**
 * Which turns of a thread a person on another computer sent: the run each started carries a
 * `run.sent_from` event, and the turn's messages carry the run id as `turnId`. A thread that does not exist
 * here (the id of a thread of another computer) has none.
 */
export function messageSendersOf(sources: Sources, threadId: string): MessageSenders {
  const { services, runtime } = sources
  const runs: MessageSenders['runs'] = {}
  if (!threadHere(services, threadId)) return { runs }
  const rows = services.runEngine.store.db
    .statement(
      "SELECT run_id, payload FROM thread_events WHERE thread_id = ? AND type = 'run.sent_from' AND run_id IS NOT NULL ORDER BY seq LIMIT ?"
    )
    .all(threadId, SENDER_EVENTS_MAX)
  const names = new Map<string, string>()
  for (const row of rows) {
    const runId = String(row.run_id)
    if (runs[runId]) continue
    let node: unknown
    try {
      node = (JSON.parse(String(row.payload)) as { node?: unknown }).node
    } catch {
      continue
    }
    if (!isId('node', node)) continue
    if (!names.has(node)) names.set(node, deviceNameOf(runtime.identity, node as NodeId))
    runs[runId] = { node: node as NodeId, name: names.get(node)! }
  }
  return { runs }
}
