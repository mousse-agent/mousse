/**
 * Turns Chromium's process list (`app.getAppMetrics()`) into the memory monitor's rows: each process with its kind,
 * its role (main, a window, an applet view, the in-app browser, DevTools, GPU, network...), private memory, working
 * set and CPU, plus the windows' own heap reports. Pure, so it is tested without Electron.
 */
import type { AppHints, AppProcessKind, AppProcessMemory, AppProcessRole } from '../../shared/diagnostics/memory'
import { NEWER_WINDOW_CACHE_FIELDS, type WindowCacheSize, type WindowCounters } from '../../shared/diagnostics/profiler'

/** The fields of Electron's ProcessMetric this reads. Sizes in KB, as Electron gives them. */
export interface MetricLike {
  pid: number
  type: string
  serviceName?: string
  cpu?: { percentCPUUsage?: number }
  memory: { workingSetSize: number; privateBytes?: number }
}

/** A web contents and what it is, by the process it runs in. */
export interface ContentsLike {
  pid: number
  role: Exclude<AppProcessRole, 'main' | 'gpu' | 'network' | 'storage' | 'audio' | 'video-capture' | 'node-utility' | 'utility' | 'other'>
}

/** What a window's preload sent about its renderer, in KB and counts. */
export interface WindowReport {
  usedHeapKb: number
  totalHeapKb: number
  privateKb?: number
  imagesKb?: number
  canvases?: number
  webglContexts?: number
  at: number
}

const KINDS: Record<string, AppProcessKind> = { Browser: 'main', Tab: 'renderer', GPU: 'gpu', Utility: 'utility' }

const UTILITY_ROLES: Array<[RegExp, AppProcessRole]> = [
  [/^network\./, 'network'],
  [/^storage\./, 'storage'],
  [/^audio\./, 'audio'],
  [/^video_capture\./, 'video-capture'],
  [/^node\./, 'node-utility']
]

/** When one renderer hosts several contents, the one that names it best. */
const RENDERER_ORDER: ContentsLike['role'][] = ['window', 'applet', 'browser', 'devtools', 'renderer']

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

/** A cache size a window's preload sent, numbers only; `undefined` without a count of entries. */
export function windowCacheSizeOf(raw: unknown): WindowCacheSize | undefined {
  const value = raw as Record<string, unknown> | null
  const entries = count(value?.entries)
  if (entries === undefined) return undefined
  const limit = count(value?.limit)
  const kbEstimated = count(value?.kbEstimated)
  const limitKb = count(value?.limitKb)
  return {
    entries,
    ...(limit !== undefined ? { limit } : {}),
    ...(kbEstimated !== undefined ? { kbEstimated } : {}),
    ...(limitKb !== undefined ? { limitKb } : {})
  }
}

/**
 * Sends the app's memory report. A service from before the window caches' sizes refuses the whole report as having
 * a field it does not know (`unknown_field`): the report goes again without them. Any other refusal is thrown.
 */
export async function sendAppReport<R extends { windows?: WindowCounters[] }>(request: (report: R) => Promise<unknown>, report: R): Promise<void> {
  try {
    await request(report)
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    const sized = (cache: WindowCacheSize) => NEWER_WINDOW_CACHE_FIELDS.some((field) => cache[field] !== undefined)
    if (code !== 'unknown_field' || !report.windows?.some((w) => Object.values(w.caches).some(sized))) throw error
    const windows = report.windows.map((w) => ({
      ...w,
      caches: Object.fromEntries(Object.entries(w.caches).map(([name, cache]) => [name, { entries: cache.entries, ...(cache.limit !== undefined ? { limit: cache.limit } : {}) }]))
    }))
    await request({ ...report, windows })
  }
}

export function kb(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round((value / 1024) * 10) / 10 : undefined
}

export function utilityRole(serviceName: string | undefined): AppProcessRole {
  for (const [pattern, role] of UTILITY_ROLES) if (serviceName && pattern.test(serviceName)) return role
  return 'utility'
}

export function appProcessRows(
  metrics: readonly MetricLike[],
  contents: readonly ContentsLike[],
  reports: ReadonlyMap<number, WindowReport>,
  main: { heapUsed: number; heapTotal: number; external: number; arrayBuffers: number; privateMb?: number },
  now: number,
  freshMs: number
): AppProcessMemory[] {
  const rendererRole = new Map<number, ContentsLike['role']>()
  for (const entry of contents) {
    const current = rendererRole.get(entry.pid)
    if (!current || RENDERER_ORDER.indexOf(entry.role) < RENDERER_ORDER.indexOf(current)) rendererRole.set(entry.pid, entry.role)
  }
  const rows = metrics.map((metric) => {
    const kind = KINDS[metric.type] ?? 'other'
    const role: AppProcessRole = kind === 'main' ? 'main'
      : kind === 'gpu' ? 'gpu'
        : kind === 'utility' ? utilityRole(metric.serviceName)
          : kind === 'renderer' ? rendererRole.get(metric.pid) ?? 'renderer'
            : 'other'
    const row: AppProcessMemory = { kind, role, rss: kb(metric.memory.workingSetSize) ?? 0 }
    const privateMb = kb(metric.memory.privateBytes)
    if (privateMb !== undefined) row.private = privateMb
    const cpu = metric.cpu?.percentCPUUsage
    if (typeof cpu === 'number' && Number.isFinite(cpu)) row.cpu = Math.round(cpu * 10) / 10
    if (kind === 'main') {
      row.heapUsed = main.heapUsed
      row.heapTotal = main.heapTotal
      row.external = main.external
      row.arrayBuffers = main.arrayBuffers
      if (row.private === undefined && main.privateMb !== undefined) row.private = main.privateMb
    } else if (kind === 'renderer') {
      const report = reports.get(metric.pid)
      if (report && now - report.at < freshMs) {
        row.heapUsed = kb(report.usedHeapKb)
        row.heapTotal = kb(report.totalHeapKb)
        if (row.private === undefined && report.privateKb !== undefined) row.private = kb(report.privateKb)
      }
    }
    return row
  })
  const order: AppProcessRole[] = ['main', 'window', 'applet', 'browser', 'devtools', 'renderer', 'gpu', 'network', 'storage', 'audio', 'video-capture', 'node-utility', 'utility', 'other']
  return rows.sort((a, b) => order.indexOf(a.role ?? 'other') - order.indexOf(b.role ?? 'other'))
}

export interface WindowGeometry {
  w: number
  h: number
  scale: number
  visible: boolean
}

export function appHints(input: {
  windows: readonly WindowGeometry[]
  acrylic: boolean
  contents: readonly ContentsLike[]
  reports: Iterable<WindowReport>
  now: number
  freshMs: number
}): AppHints {
  let surface = 0
  for (const w of input.windows) if (w.visible) surface += w.w * w.h * w.scale * w.scale * 4
  let webglContexts = 0
  let canvases = 0
  let imagesKb: number | undefined
  for (const report of input.reports) {
    if (input.now - report.at >= input.freshMs) continue
    webglContexts += report.webglContexts ?? 0
    canvases += report.canvases ?? 0
    if (report.imagesKb !== undefined) imagesKb = (imagesKb ?? 0) + report.imagesKb
  }
  const count = (role: ContentsLike['role']) => input.contents.filter((entry) => entry.role === role).length
  return {
    windows: input.windows.map((w) => ({ w: Math.round(w.w), h: Math.round(w.h), scale: Math.round(w.scale * 100) / 100, visible: w.visible })),
    surfaceMb: Math.round((surface / (1024 * 1024)) * 10) / 10,
    acrylic: input.acrylic,
    views: { applet: count('applet'), browser: count('browser'), devtools: count('devtools') },
    webglContexts,
    canvases,
    ...(imagesKb !== undefined ? { imagesMb: kb(imagesKb) } : {})
  }
}
