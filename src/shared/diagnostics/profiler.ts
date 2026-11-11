/**
 * The profiler (Settings → Labs): the memory monitor of `memory.ts`, off until a person turns it on, and the tools
 * agents may use to read it. Off, nothing samples, logs or shows. Everything the tools return is numbers and fixed
 * names, as in the memory log; a per-thread entry carries its thread id, and its title only for a thread of the
 * calling agent's own profile.
 */

/** The agent tools, in the order Settings lists them. */
export const PROFILER_TOOL_NAMES = [
  'profiler_overview',
  'profiler_service_breakdown',
  'profiler_window_breakdown',
  'profiler_gpu_hints',
  'profiler_children',
  'profiler_sample_now',
  'profiler_watch',
  'profiler_heap_summary'
] as const
export type ProfilerToolName = (typeof PROFILER_TOOL_NAMES)[number]

/** Tools whose switch is off until turned on, even with agent access on: a heap snapshot pauses the service. */
export const PROFILER_TOOLS_OFF_BY_DEFAULT: readonly ProfilerToolName[] = ['profiler_heap_summary']

/** Each tool's name in Settings, and what its tooltip says it is for. */
export const PROFILER_TOOL_LABELS: Record<ProfilerToolName, { label: string; detail: string }> = {
  profiler_overview: { label: 'Overview', detail: 'Memory and CPU of every process by role, against the start baseline, with trends and recent breaches.' },
  profiler_service_breakdown: { label: 'Service breakdown', detail: 'The service heap, counts, caches and the memory each loaded or cached thread holds.' },
  profiler_window_breakdown: { label: 'Window breakdown', detail: 'Per window: DOM nodes, mounted turns and rows, images, canvases, applet views and caches with their sizes.' },
  profiler_gpu_hints: { label: 'GPU hints', detail: 'GPU process memory, window sizes and scale, acrylic, WebGL contexts and views.' },
  profiler_children: { label: 'Child processes', detail: 'Provider and tool processes the service started, with their memory.' },
  profiler_sample_now: { label: 'Sample now', detail: 'A fresh sample, with what changed since the last one.' },
  profiler_watch: { label: 'Watch', detail: 'Samples every few seconds for a few minutes, so an agent can act and see what grows.' },
  profiler_heap_summary: {
    label: 'Heap summary',
    detail: 'Takes a service heap snapshot and returns only totals by type. Pauses the service for a few seconds; refused while another turn runs.'
  }
}

export interface ProfilerSettings {
  /**
   * The master switch. Off: nothing samples, logs or shows. Its "Memory notices" switch is `notifications.memoryNotices`,
   * where earlier builds kept it, so a person who turned the notices off keeps them off.
   */
  enabled: boolean
  /** Agents may call the profiler tools whose switch is on. */
  agentAccess: boolean
  tools: Record<ProfilerToolName, boolean>
}

/** The stored settings with defaults filled in: off, agent access off, every tool on but the heap summary. */
export function normalizeProfilerSettings(raw?: Partial<ProfilerSettings> | null): ProfilerSettings {
  const tools = {} as Record<ProfilerToolName, boolean>
  const stored = raw?.tools && typeof raw.tools === 'object' ? (raw.tools as Partial<Record<ProfilerToolName, unknown>>) : {}
  for (const name of PROFILER_TOOL_NAMES) {
    const value = stored[name]
    tools[name] = typeof value === 'boolean' ? value : !PROFILER_TOOLS_OFF_BY_DEFAULT.includes(name)
  }
  return {
    enabled: raw?.enabled === true,
    agentAccess: raw?.agentAccess === true,
    tools
  }
}

/** Whether an agent may use `name` now: the profiler, agent access and the tool's own switch are all on. */
export function profilerToolAllowed(settings: ProfilerSettings | undefined, name: string): boolean {
  if (!settings?.enabled || !settings.agentAccess) return false
  return (PROFILER_TOOL_NAMES as readonly string[]).includes(name) && settings.tools[name as ProfilerToolName] === true
}

/** Why a tool is refused, for the agent. */
export function profilerToolRefusal(settings: ProfilerSettings | undefined, name: string): string | undefined {
  if (!settings?.enabled) return 'The profiler is off. The person can turn it on in Settings → Labs.'
  if (!settings.agentAccess) return 'Agents may not use the profiler. The person can turn on Agent access in Settings → Labs → Profiler.'
  if (!profilerToolAllowed(settings, name)) return `${name} is turned off in Settings → Labs → Profiler.`
  return undefined
}

/** The profiler's state the service reports to the desktop app, which reports its processes only while it is on. */
export interface ProfilerState {
  enabled: boolean
}

/** One window's counters, read on demand (never per frame) when the profiler samples or a tool asks. */
export interface WindowCounters {
  /** The window's content size in DIP, its display's scale factor, and whether it is shown. */
  w?: number
  h?: number
  scale?: number
  visible?: boolean
  domNodes: number
  /** Assistant turns and message rows mounted in the transcript now (the rest are virtualized away). */
  mountedTurns: number
  mountedRows: number
  /** `<img>` elements, and their decoded size estimated at 4 bytes a pixel. */
  images: number
  imagesDecodedMbEstimated: number
  /** Blink's decoded image cache, measured. */
  imageCacheMb?: number
  canvases: number
  /** The canvases' backing stores, estimated at 4 bytes a pixel. */
  canvasMbEstimated: number
  webglContexts: number
  /** In-app browser tabs (`<webview>`) mounted in this window. */
  browserTabs: number
  jsHeapUsedMb: number
  jsHeapTotalMb: number
  /** Named caches of the window's code, by entries (and their limit when there is one). */
  caches: Record<string, WindowCacheSize>
}

/**
 * A window cache's size: its entries and their limit, and for a cache bounded by size, the KB its entries are
 * estimated to hold and its budget.
 */
export interface WindowCacheSize {
  entries: number
  limit?: number
  kbEstimated?: number
  limitKb?: number
}

/** The window cache fields a service from before them refuses as unknown. */
export const NEWER_WINDOW_CACHE_FIELDS = ['kbEstimated', 'limitKb'] as const

/** An applet or in-app browser view the app's main process holds, by size in DIP. */
export interface AppViewInfo {
  role: 'applet' | 'browser'
  w: number
  h: number
  visible: boolean
}
