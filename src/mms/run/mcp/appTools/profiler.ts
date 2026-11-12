import {
  PROFILER_TOOL_NAMES,
  profilerToolAllowed,
  profilerToolRefusal,
  type ProfilerSettings,
  type ProfilerToolName
} from '../../../../shared/diagnostics/profiler'
import { MMS_PROTOCOL_REPLAY_RING_SIZE } from '../../../protocol/types'
import { MAX_CACHED_BYTES, MAX_CACHED_THREADS } from '../../../data/threadDb/threadDbStore'
import { HeapSummaryError } from '../../../diagnostics/heapSummary'
import type { ProfilerService, ThreadMemory } from '../../../diagnostics/profilerService'
import {
  childrenReport,
  gpuHintsReport,
  overviewReport,
  sampleNowReport,
  samplePoint,
  serviceBreakdownReport,
  watchPlan,
  watchReport,
  windowBreakdownReport
} from '../../../diagnostics/profilerReports'
import type { AgentAccessLevel } from '../../../../shared/settings'
import type { Thread } from '../../../../shared/types'
import type { AppToolHost } from './host'
import { agentThreadView, isBotThread, threadVisibleToAgent } from './thread'
import { json, levelAtLeast, type JsonSchema, type MousseTool, type ToolCallContext, type ToolOutcome } from './types'

/** What the profiler tools read, at every call: the profile's switches (Settings → Labs) and the service's profiler. */
export interface ProfilerToolHost {
  settings: ProfilerSettings
  /** Null in a service without a profiler. */
  service: ProfilerService | null
  /** The caller's profile, as its orchestrator: its threads are listed by id, every other profile's only as totals. */
  owner: object
  /**
   * Whether `threadId` has a turn running. The heap summary does not count the caller's own turn, nor the turns of
   * the threads that delegated to it, which wait on it.
   */
  turnActive(threadId: string): boolean
}

/** The caller and the threads that delegated to it, nearest first. */
function delegationChain(host: AppToolHost, threadId: string): string[] {
  const chain: string[] = []
  let current: string | undefined = threadId
  while (current && !chain.includes(current) && chain.length < 32) {
    chain.push(current)
    current = host.threadMeta?.(current)?.lineage?.parentThreadId
  }
  return chain
}

/**
 * The caller's profile's threads held to what `thread_list` shows the calling agent: a thread that is private (unless
 * the caller's is), a bot's or below a bot's, the Automation manager's, or outside the allowed projects (unless the
 * caller launched it) counts only in a total, as does a cache entry no thread of the profile owns, which cannot be
 * checked.
 */
function visibleThreadMemory(threads: ThreadMemory, host: AppToolHost, callerThreadId: string, level: AgentAccessLevel): ThreadMemory {
  const view = agentThreadView(host, callerThreadId)
  const byId = new Map(view.all.map((thread) => [thread.id, thread]))
  const chain = new Set(delegationChain(host, callerThreadId))
  // Below `read`, `thread_list` refuses: only the caller, the threads that delegated to it, its own subagents (which
  // `thread_read` reaches as descendants) and the threads it launched are named. Below `manage`, other threads'
  // subagents stay folded, as `thread_list` folds them.
  const related = (thread: Thread) =>
    chain.has(thread.id) || thread.lineage?.parentThreadId === callerThreadId || thread.createdByThreadId === callerThreadId
  // `thread_list` never lists the Automation manager's thread; it is opened from Automations.
  const named = (thread: Thread) =>
    related(thread) ||
    (!thread.automationManager && levelAtLeast(level, 'read') && (levelAtLeast(level, 'manage') || !thread.lineage?.parentThreadId))
  // A bot thread's subagent inherits its private flag but not `botOwned`, so its lineage root is checked too.
  const belowBot = (thread: Thread) => {
    const rootId = thread.lineage?.rootThreadId
    return Boolean(rootId && rootId !== thread.id && isBotThread(host, rootId, byId.get(rootId)))
  }
  const hidden = { threads: 0, cachedBytes: 0 }
  const own = threads.own.filter((entry) => {
    const thread = entry.threadId ? byId.get(entry.threadId) : undefined
    if (thread && named(thread) && threadVisibleToAgent(host, thread, view) && !belowBot(thread)) return true
    hidden.threads += 1
    hidden.cachedBytes += entry.cachedBytes ?? 0
    return false
  })
  return { own, others: threads.others, hidden }
}

/**
 * Error classes an unexpected error may be reported as; nothing else of it reaches the agent. A `HeapSummaryError`
 * is not one: its fixed text is returned before this is checked.
 */
const KNOWN_ERROR_CLASSES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError'])

/** The error's class, when it is one of the known ones; otherwise `Error`. */
function errorClass(caught: unknown): string {
  const name = caught instanceof Error ? caught.name : undefined
  return typeof name === 'string' && KNOWN_ERROR_CLASSES.has(name) ? name : 'Error'
}

/** A heap summary running in this service: one at a time, whatever profile or turn asked. */
let heapSummaryRunning = false

const NO_ARGS: JsonSchema = { type: 'object', properties: {}, additionalProperties: false }

const DESCRIPTIONS: Record<ProfilerToolName, string> = {
  profiler_overview:
    "Start here when Mousse is slow or uses too much memory. Every Mousse process by role (service, its workers and providers, main, each window, applet views, in-app browser, GPU, utilities) with private memory, working set, CPU and JS heap; the service against its start baseline; trends; limits broken now. Numbers only.",
  profiler_service_breakdown:
    "When the background service is the big one: its V8 heap and heap spaces, worker heaps, counts (loaded and cached threads, runtimes, workers, SQLite connections, replay buffer, terminals, file watchers, child processes) against their bounds, cache sizes, and each of this profile's threads in memory you may list, by id, with its measured cache size; private, bot and out-of-scope threads and other profiles as totals.",
  profiler_window_breakdown:
    "When a window's renderer is big or the UI is slow: per window, DOM nodes, mounted turns and rows, images with decoded size, canvases, WebGL contexts, in-app browser tabs, JS heap, and the window's caches (parsed Markdown, highlighted code) with their entries and estimated size; applet and browser views with their sizes. Read on demand from the open app.",
  profiler_gpu_hints:
    "When the GPU process is big: its memory, the windows' sizes and scale, the pixels they draw, acrylic, WebGL contexts, canvases, and applet, browser and DevTools views.",
  profiler_children:
    "When provider or tool processes may hold memory: every process the service started, by kind (claude, codex, mcp...), with its memory, and totals by kind.",
  profiler_sample_now:
    "A fresh sample now, and what changed since the previous one. Use it before and after an action to see what it costs.",
  profiler_watch:
    "Samples every intervalSeconds (5 to 60) for minutes (at most 10, 120 points), so you can do something in parallel and see which numbers grow. Returns the series, the change and what grew most.",
  profiler_heap_summary:
    "When the service heap grows and the breakdown does not say why: takes a service heap snapshot, analyses it in a worker and returns only totals: the constructors that retain most, counts and sizes by type, and the largest strings by size (content redacted). Pauses the service for a few seconds; refused while another turn or another summary runs."
}

const SCHEMAS: Partial<Record<ProfilerToolName, JsonSchema>> = {
  profiler_watch: {
    type: 'object',
    properties: {
      intervalSeconds: { type: 'number', minimum: 5, maximum: 60, description: 'Seconds between samples, 5 to 60. Default 10.' },
      minutes: { type: 'number', minimum: 0.5, maximum: 10, description: 'How long to watch, at most 10 minutes. Default 2.' }
    },
    additionalProperties: false
  },
  profiler_heap_summary: {
    type: 'object',
    properties: { top: { type: 'integer', minimum: 5, maximum: 30, description: 'How many entries per list, 5 to 30. Default 15.' } },
    additionalProperties: false
  }
}

const error = (text: string): ToolOutcome => ({ text, isError: true })

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * The profiler's tools (Settings → Labs → Profiler): an agent reads what loads Mousse while the person keeps working.
 * Each is listed and offered only while the profiler, "Agents can read the profiler" and the tool's own switch are on, and checked
 * again at the call. They return numbers and fixed names only; a thread is named by its id alone, and only when it
 * belongs to the caller's profile. Other profiles belong to other people and count only in totals.
 */
export function profilerTools(host: AppToolHost): MousseTool[] {
  const reach = (): ProfilerToolHost | undefined => host.profiler?.()
  const allowed = (name: ProfilerToolName): boolean => {
    const profiler = reach()
    return Boolean(profiler?.service) && profilerToolAllowed(profiler!.settings, name)
  }
  return PROFILER_TOOL_NAMES.map((name): MousseTool => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: SCHEMAS[name] ?? NO_ARGS,
    access: 'reads',
    class: 'read',
    readOnlySafe: true,
    listed: () => allowed(name),
    offered: () => allowed(name),
    available: () => {
      const profiler = reach()
      if (!profiler?.service) return 'This Mousse service has no profiler.'
      return profilerToolRefusal(profiler.settings, name) ?? true
    },
    describe: () => `Profiler ${name.replace('profiler_', '').replace(/_/g, ' ')}`,
    handler: async (args, ctx) => {
      const profiler = reach()
      const refusal = !profiler?.service ? 'This Mousse service has no profiler.' : profilerToolRefusal(profiler.settings, name)
      if (refusal) return error(refusal)
      const service = profiler!.service!
      try {
        // A profile that opened after the service started, with the profiler on, starts it here.
        if (!service.monitor()) service.refresh()
        const monitor = service.monitor()
        if (!monitor) return error('The profiler is starting. Call again in a few seconds.')
        return await run(name, args, ctx, { profiler: profiler!, service, monitor, host })
      } catch (caught) {
        // Only fixed text reaches the agent: a Node error's message can name a file under the home folder.
        if (caught instanceof HeapSummaryError) return error(caught.message)
        return error(`The profiler could not finish ${name} (${errorClass(caught)}). Call again in a few seconds.`)
      }
    }
  }))
}

type Monitor = NonNullable<ReturnType<ProfilerService['monitor']>>

async function run(
  name: ProfilerToolName,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  env: { profiler: ProfilerToolHost; service: ProfilerService; monitor: Monitor; host: AppToolHost }
): Promise<ToolOutcome> {
  const { service, monitor } = env
  const latest = () => { const all = monitor.samples(); return all.length ? all[all.length - 1] : null }
  switch (name) {
    case 'profiler_overview': {
      if (!monitor.samples().length) {
        await service.collectApp(false)
        await monitor.tick()
      }
      return json(overviewReport(monitor.status(), monitor.thresholds, Date.now()))
    }
    case 'profiler_service_breakdown': {
      const sample = await monitor.measure({ children: true })
      return json(serviceBreakdownReport({
        sample,
        detail: monitor.readDetailNow(),
        thresholds: monitor.thresholds,
        threads: visibleThreadMemory(service.threads(env.profiler.owner), env.host, ctx.caller.threadId, ctx.level ?? 'lineage'),
        cacheLimits: { threads: MAX_CACHED_THREADS, mb: MAX_CACHED_BYTES / 1048576 },
        replayLimitPerProfile: MMS_PROTOCOL_REPLAY_RING_SIZE
      }))
    }
    case 'profiler_window_breakdown': {
      const answered = await service.collectApp(true)
      return json(windowBreakdownReport(answered ? monitor.appWindowDetail() : null, answered ? await monitor.measure() : latest(), Date.now()))
    }
    case 'profiler_gpu_hints': {
      const answered = await service.collectApp(true)
      const sample = await monitor.measure()
      return json({ ...gpuHintsReport(sample, answered ? monitor.appWindowDetail() : null), ...(answered ? {} : { app: null }) })
    }
    case 'profiler_children':
      return json(childrenReport(await monitor.readChildrenNow()))
    case 'profiler_sample_now': {
      const previous = latest()
      await service.collectApp(false)
      await monitor.tick()
      const sample = latest()
      if (!sample || sample === previous) return error('The sample failed. Call again in a few seconds.')
      return json(sampleNowReport(sample, previous))
    }
    case 'profiler_watch': {
      const plan = watchPlan(args.intervalSeconds, args.minutes)
      const points: Array<{ atSeconds: number } & ReturnType<typeof samplePoint>> = []
      const start = Date.now()
      let stopped: string | undefined
      for (let i = 0; i < plan.points; i++) {
        if (i > 0) await sleep(plan.intervalSeconds * 1000, ctx.signal)
        if (ctx.signal.aborted) {
          stopped = 'The call was stopped.'
          break
        }
        if (service.monitor() !== monitor) {
          stopped = 'The profiler was turned off.'
          break
        }
        await service.collectApp(false, 2_000)
        const sample = await monitor.measure()
        points.push({ atSeconds: Math.round((Date.now() - start) / 1000), ...samplePoint(sample) })
      }
      return json(watchReport(plan, points, stopped))
    }
    case 'profiler_heap_summary': {
      // Checked and claimed before any await, so two calls in the same moment cannot both pass.
      if (heapSummaryRunning) return error('A heap summary is already running. Call again when it is done.')
      // The caller's turn, and the turns of the threads that delegated to it (they wait on it), do not count.
      const mine = delegationChain(env.host, ctx.caller.threadId).filter((id) => env.profiler.turnActive(id)).length
      const others = service.activeTurns() - mine
      if (others > 0) return error(`Another turn is running (${others}). A heap snapshot pauses the service; call again when only this turn runs.`)
      const top = typeof args.top === 'number' && Number.isFinite(args.top) ? Math.min(30, Math.max(5, Math.round(args.top))) : 15
      heapSummaryRunning = true
      try {
        const summary = await service.heapSummary(top)
        return json({ ...summary, note: 'Totals only. Names are constructor names from code or node types; string content is never read out. The snapshot file was deleted.' })
      } finally {
        heapSummaryRunning = false
      }
    }
  }
  return error(`Unknown tool: ${name}`)
}
