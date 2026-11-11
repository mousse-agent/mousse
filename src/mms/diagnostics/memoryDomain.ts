/**
 * The memory monitor's protocol methods, for clients on this computer only:
 *
 * - `diagnostics.memory.status`: the latest numbers per process, the trend, breaches and a waiting notice.
 * - `diagnostics.memory.appReport`: the desktop app's main process sends its processes' memory.
 * - `diagnostics.memory.noticeShown`: a window showed the notice; none of that kind again for a day.
 * - `diagnostics.memory.issue`: the prefilled issue's title, body and link. Nothing is sent anywhere.
 *
 * `diagnostics.memory.notice` is the event a due notice raises, sent to every profile's clients.
 */
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import { connectionIsLocal } from '../protocol/threadVisibility'
import type { HandlerContext } from '../protocol/handlers'
import type { AppProcessKind, AppProcessMemory, BreachKind } from '../../shared/diagnostics/memory'
import type { MemoryMonitor } from './MemoryMonitor'

export const MEMORY_DIAGNOSTICS_METHODS = [
  'diagnostics.memory.status',
  'diagnostics.memory.appReport',
  'diagnostics.memory.noticeShown',
  'diagnostics.memory.issue'
] as const

export const MEMORY_NOTICE_EVENT = 'diagnostics.memory.notice'

/** Filled in once the monitor exists; the methods are registered before the protocol server starts. */
export interface MemoryMonitorHolder {
  monitor: MemoryMonitor | null
}

const APP_KINDS: readonly AppProcessKind[] = ['main', 'window', 'gpu', 'utility', 'other']
const BREACH_KINDS: readonly BreachKind[] = ['service-high', 'service-growth', 'app-high', 'counts']
const MAX_APP_PROCESSES = 64
const MAX_MB = 1_000_000

function monitorOf(holder: MemoryMonitorHolder, ctx: HandlerContext): MemoryMonitor {
  if (!connectionIsLocal(ctx.connection)) throw new DomainRpcError('forbidden', 'Memory diagnostics are only available on this computer.')
  if (!holder.monitor) throw new DomainRpcError('unavailable', 'The memory monitor is not running.')
  return holder.monitor
}

function mb(value: unknown, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_MB) throw new DomainRpcError('invalid_params', 'Memory values are MB between 0 and 1,000,000')
  return Math.round(value * 10) / 10
}

/** Only known kinds and numbers are kept; anything else in a report is refused. */
export function validateAppReport(params: unknown): { processes: AppProcessMemory[] } {
  const raw = domainObject(params, ['processes'])
  if (!Array.isArray(raw.processes) || raw.processes.length > MAX_APP_PROCESSES) throw new DomainRpcError('invalid_params', 'processes must be a list of at most 64')
  const processes = raw.processes.map((entry) => {
    const value = domainObject(entry, ['kind', 'rss', 'private', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'])
    if (!APP_KINDS.includes(value.kind as AppProcessKind)) throw new DomainRpcError('invalid_params', 'Unknown process kind')
    const out: AppProcessMemory = { kind: value.kind as AppProcessKind, rss: mb(value.rss, true)! }
    for (const key of ['private', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'] as const) {
      const n = mb(value[key], false)
      if (n !== undefined) out[key] = n
    }
    return out
  })
  return { processes }
}

export function registerMemoryDiagnosticsMethods(registry: DomainHandlerRegistry, holder: MemoryMonitorHolder): () => void {
  const empty = (params: unknown) => (params === undefined || params === null ? {} : domainObject(params, []))
  registry.register({
    method: 'diagnostics.memory.status',
    scope: 'installation',
    validate: empty,
    handle: (ctx) => monitorOf(holder, ctx).status()
  })
  registry.register({
    method: 'diagnostics.memory.appReport',
    scope: 'installation',
    validate: validateAppReport,
    handle: (ctx, input) => {
      const monitor = monitorOf(holder, ctx)
      if (ctx.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Only the desktop app reports its processes.')
      monitor.acceptAppReport(ctx.connection.id, input.processes)
      return { ok: true }
    }
  })
  registry.register({
    method: 'diagnostics.memory.noticeShown',
    scope: 'installation',
    validate: (params) => {
      const raw = domainObject(params, ['kind'])
      if (!BREACH_KINDS.includes(raw.kind as BreachKind)) throw new DomainRpcError('invalid_params', 'Unknown breach kind')
      return { kind: raw.kind as BreachKind }
    },
    handle: (ctx, input) => {
      monitorOf(holder, ctx).noticeShown(input.kind)
      return { ok: true }
    }
  })
  registry.register({
    method: 'diagnostics.memory.issue',
    scope: 'installation',
    validate: empty,
    handle: async (ctx) => await monitorOf(holder, ctx).issue()
  })
  return registry.onConnectionClosed((id) => holder.monitor?.forgetConnection(id))
}
