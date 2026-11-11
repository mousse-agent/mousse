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
import { APP_PROCESS_KINDS, APP_PROCESS_ROLES, BREACH_KINDS, type AppHints, type AppProcessKind, type AppProcessMemory, type AppProcessRole, type BreachKind } from '../../shared/diagnostics/memory'
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

const MAX_APP_PROCESSES = 64
const MAX_WINDOWS = 32
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

function count(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000) throw new DomainRpcError('invalid_params', `${name} must be a count`)
  return value
}

function validateHints(value: unknown): AppHints {
  const raw = domainObject(value, ['windows', 'surfaceMb', 'acrylic', 'views', 'webglContexts', 'canvases', 'imagesMb'])
  if (!Array.isArray(raw.windows) || raw.windows.length > MAX_WINDOWS) throw new DomainRpcError('invalid_params', 'windows must be a list of at most 32')
  const windows = raw.windows.map((entry) => {
    const w = domainObject(entry, ['w', 'h', 'scale', 'visible'])
    const scale = typeof w.scale === 'number' && Number.isFinite(w.scale) && w.scale > 0 && w.scale <= 16 ? Math.round(w.scale * 100) / 100 : 1
    if (typeof w.visible !== 'boolean') throw new DomainRpcError('invalid_params', 'visible must be a boolean')
    return { w: count(w.w, 'w'), h: count(w.h, 'h'), scale, visible: w.visible }
  })
  const views = domainObject(raw.views, ['applet', 'browser', 'devtools'])
  if (typeof raw.acrylic !== 'boolean') throw new DomainRpcError('invalid_params', 'acrylic must be a boolean')
  const imagesMb = mb(raw.imagesMb, false)
  return {
    windows,
    surfaceMb: mb(raw.surfaceMb, true)!,
    acrylic: raw.acrylic,
    views: { applet: count(views.applet, 'applet'), browser: count(views.browser, 'browser'), devtools: count(views.devtools, 'devtools') },
    webglContexts: count(raw.webglContexts, 'webglContexts'),
    canvases: count(raw.canvases, 'canvases'),
    ...(imagesMb !== undefined ? { imagesMb } : {})
  }
}

/** Only known kinds, roles and numbers are kept; anything else in a report is refused. */
export function validateAppReport(params: unknown): { processes: AppProcessMemory[]; hints?: AppHints } {
  const raw = domainObject(params, ['processes', 'hints'])
  if (!Array.isArray(raw.processes) || raw.processes.length > MAX_APP_PROCESSES) throw new DomainRpcError('invalid_params', 'processes must be a list of at most 64')
  const processes = raw.processes.map((entry) => {
    const value = domainObject(entry, ['kind', 'role', 'cpu', 'rss', 'private', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'])
    if (!APP_PROCESS_KINDS.includes(value.kind as AppProcessKind)) throw new DomainRpcError('invalid_params', 'Unknown process kind')
    if (value.role !== undefined && !APP_PROCESS_ROLES.includes(value.role as AppProcessRole)) throw new DomainRpcError('invalid_params', 'Unknown process role')
    const out: AppProcessMemory = { kind: value.kind as AppProcessKind, rss: mb(value.rss, true)! }
    if (value.role !== undefined) out.role = value.role as AppProcessRole
    for (const key of ['private', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'cpu'] as const) {
      const n = mb(value[key], false)
      if (n !== undefined) out[key] = n
    }
    return out
  })
  return { processes, ...(raw.hints !== undefined ? { hints: validateHints(raw.hints) } : {}) }
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
      monitor.acceptAppReport(ctx.connection.id, input.processes, input.hints)
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
