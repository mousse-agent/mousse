import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { MemoryMonitor } from '../src/mms/diagnostics/MemoryMonitor'
import { MemoryLog } from '../src/mms/diagnostics/memoryLog'
import { prepareMemoryMonitor, readThreadMemory } from '../src/mms/diagnostics/startMemoryMonitor'
import { profilerService, setProfilerService, type ProfilerService, type ThreadMemory, type ThreadMemoryEntry } from '../src/mms/diagnostics/profilerService'
import { PROFILER_COLLECT_EVENT, PROFILER_STATE_EVENT, validateAppReport } from '../src/mms/diagnostics/memoryDomain'
import { HeapSummaryError, analyseHeapSnapshotFile, removeLeftoverSummaryFiles, summarizeHeapSnapshot, takeHeapSummary, type HeapSummary } from '../src/mms/diagnostics/heapSummary'
import { WATCH_LIMITS, watchPlan } from '../src/mms/diagnostics/profilerReports'
import { memoryNoticesEnabled } from '../src/renderer/hooks/useMemoryNotices'
import { HEAP_SNAPSHOT_RELATIVE_DIR } from '../src/mms/diagnostics/heapSnapshot'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import { createAppToolRegistry, type AppToolHost, type ProfilerToolHost } from '../src/mms/run/mcp/appTools'
import type { AppToolTurn, ToolCallContext } from '../src/mms/run/mcp/appTools/types'
import { PROFILER_TOOL_NAMES, normalizeProfilerSettings, profilerToolAllowed, type ProfilerSettings, type ProfilerToolName } from '../src/shared/diagnostics/profiler'
import { resolveMemoryThresholds } from '../src/shared/diagnostics/memory'
import type { MousseMainService } from '../src/mms/MousseMainService'
import type { MmsProtocolServer } from '../src/mms/protocol/server'
import type { HandlerContext } from '../src/mms/protocol/handlers'

const T0 = Date.UTC(2026, 10, 11, 8, 0, 0)
const homes: string[] = []

/** A home whose path holds a username, to prove none of it reaches a tool's output. */
function home(name = 'alice'): string {
  const dir = mkdtempSync(join(tmpdir(), `mousse-profiler-${name}-`))
  homes.push(dir)
  return dir
}

afterEach(() => {
  setProfilerService(null)
  vi.useRealTimers()
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Strings a tool must never return: the home, the user, a prompt, another profile's title, a token. */
const PRIVATE = ['alice', 'Fix the login page', 'Other profile secret', 'sk-ant-api03-SECRET', 'ghp_SECRETTOKEN', '/home/', 'C:\\Users', '\\\\']

function expectNoPrivateData(text: string, dir: string): void {
  expect(text).not.toContain(dir)
  expect(text).not.toContain(dir.replace(/\\/g, '\\\\'))
  for (const value of PRIVATE) expect(text).not.toContain(value)
  for (const value of [process.env.USERNAME, process.env.USER]) if (value && value.length > 2) expect(text).not.toContain(value)
}

describe('profiler settings', () => {
  it('are off by default: profiler, agent access and the heap summary off; the other tools on', () => {
    const settings = normalizeProfilerSettings()
    expect(settings).toMatchObject({ enabled: false, agentAccess: false })
    for (const name of PROFILER_TOOL_NAMES) expect(settings.tools[name]).toBe(name !== 'profiler_heap_summary')
    expect(normalizeProfilerSettings({ enabled: 'yes' as never, agentAccess: 1 as never })).toMatchObject({ enabled: false, agentAccess: false })
  })

  it('a fresh home is written with the profiler off', () => {
    const dir = home()
    const store = new SettingsStore(MousseConfigStore.load(dir))
    expect(store.get().experimental.profiler).toMatchObject({ enabled: false, agentAccess: false })
    expect(memoryNoticesEnabled(store.get())).toBe(false)
  })

  it('an existing install moves to off quietly, and keeps notices off when they were turned off', () => {
    for (const [legacy, noticesOnceOn] of [[undefined, true], [true, true], [false, false]] as const) {
      const dir = home()
      // An earlier build: its notices switch under notifications, no profiler settings.
      writeFileSync(join(dir, 'mousse.conf'), JSON.stringify({ settings: { notifications: { threadCompletionSound: true, allRemoteThreads: false, ...(legacy === undefined ? {} : { memoryNotices: legacy }) } } }))
      const store = new SettingsStore(MousseConfigStore.load(dir))
      expect(store.get().experimental.profiler).toMatchObject({ enabled: false, agentAccess: false })
      // Nothing shows while the profiler is off.
      expect(memoryNoticesEnabled(store.get())).toBe(false)
      // Turned on later, the notices follow the switch the person left.
      store.set({ experimental: { ...store.get().experimental, profiler: { ...store.get().experimental.profiler, enabled: true } } })
      expect(memoryNoticesEnabled(new SettingsStore(MousseConfigStore.load(dir)).get())).toBe(noticesOnceOn)
    }
  })

  it('a tool is allowed only with the profiler, agent access and its own switch on', () => {
    const base = normalizeProfilerSettings()
    const on = { ...base, enabled: true, agentAccess: true }
    expect(profilerToolAllowed(base, 'profiler_overview')).toBe(false)
    expect(profilerToolAllowed({ ...base, enabled: true }, 'profiler_overview')).toBe(false)
    expect(profilerToolAllowed({ ...base, agentAccess: true }, 'profiler_overview')).toBe(false)
    expect(profilerToolAllowed(on, 'profiler_overview')).toBe(true)
    expect(profilerToolAllowed({ ...on, tools: { ...on.tools, profiler_overview: false } }, 'profiler_overview')).toBe(false)
    // The heap summary stays off with agent access on, until its own switch is.
    expect(profilerToolAllowed(on, 'profiler_heap_summary')).toBe(false)
    expect(profilerToolAllowed({ ...on, tools: { ...on.tools, profiler_heap_summary: true } }, 'profiler_heap_summary')).toBe(true)
    expect(profilerToolAllowed(on, 'web_search')).toBe(false)
  })
})

/** A service with one profile whose settings are a real store, and a protocol server that records its events. */
function fakeService(dir: string) {
  const settings = new SettingsStore(MousseConfigStore.load(dir))
  const events: Array<{ type: string; data: unknown }> = []
  const domains = new DomainHandlerRegistry()
  const profile = {
    settings,
    orchestrator: { activeTurnCount: () => 0, loadedSessionCount: () => 0, loadedThreadIds: () => [], isTurnActive: () => false },
    threads: { threadDbCacheStats: () => ({ threads: 0, bytes: 0, coldLoads: 0, stateReads: 0 }), threadDbCacheEntries: () => [] },
    threadRuntimes: { runtimeCount: () => 0 },
    ptyManager: { list: () => [] }
  }
  const mms = { ...profile, domains, getInstallationHost: () => undefined } as unknown as MousseMainService
  const protocolServer = {
    emitInstallationEvent: (type: string, data: unknown) => events.push({ type, data }),
    replayEventCount: () => 0,
    replayBytes: () => 0
  } as unknown as MmsProtocolServer
  return { settings, events, domains, mms, protocolServer }
}

function testMonitor(dir: string, now: { t: number }) {
  return new MemoryMonitor({
    homeDir: dir,
    version: '0.1.3',
    thresholds: resolveMemoryThresholds('{"serviceSustainMinutes":3}'),
    readCounts: async () => ({ counts: { sqliteConnections: 2, workerThreads: 2, loadedThreads: 1, threadRuntimes: 1, threadCacheThreads: 1, threadCacheMb: 0.5, replayEvents: 12, ptys: 0, fileWatchers: 1, profiles: 1, activeTurns: 0 }, workerHeaps: [4 * 1048576] }),
    readReplayBytes: () => 2 * 1048576,
    now: () => now.t,
    uptime: () => (now.t - T0) / 1000 + 100,
    sampleProcess: async () => ({ rss: 190, private: 150, heapUsed: 60, heapTotal: 80, external: 4, arrayBuffers: 1 }),
    readDetail: () => ({ heapSpaces: { old_space: 50, 'C:\\Users\\alice\\space': 1 }, heap: { totalHeapSize: 80, usedHeapSize: 60, heapSizeLimit: 4096, mallocedMemory: 1, externalMemory: 4, nativeContexts: 1, detachedContexts: 0 } }),
    readChildren: async () => [{ kind: 'claude', mb: 210 }, { kind: '/home/alice/.local/bin/sk-ant-api03-SECRET', mb: 12 }],
    childCount: () => 2,
    cpuUsage: () => ({ user: now.t * 100, system: 0 }),
    log: new MemoryLog(dir, { flushIntervalMs: 1 })
  })
}

const local = { connection: { id: 'gui-1', capabilities: new Set<string>(), clientType: 'gui' } } as unknown as HandlerContext

describe('the profiler in the service', () => {
  it('samples nothing and logs nothing while off, and starts and stops with the switch', async () => {
    vi.useFakeTimers({ now: T0 })
    const dir = home()
    const { settings, events, domains, mms, protocolServer } = fakeService(dir)
    const created: MemoryMonitor[] = []
    const now = { t: T0 }
    const handle = prepareMemoryMonitor({ mms, protocolServer, homeDir: dir, version: '0.1.3', env: {}, createMonitor: () => { const m = testMonitor(dir, now); created.push(m); return m } })!
    handle.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(created).toHaveLength(0)
    expect(existsSync(join(dir, 'diagnostics', 'memory.jsonl'))).toBe(false)
    expect(await domains.dispatch(local, 'diagnostics.memory.state', {})).toEqual({ enabled: false })
    await expect(domains.dispatch(local, 'diagnostics.memory.status', {})).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('Settings → Labs') })
    // Nothing asked the app for anything.
    expect(events).toEqual([])

    settings.set({ experimental: { profiler: { ...settings.get().experimental.profiler, enabled: true } } })
    expect(created).toHaveLength(1)
    expect(events).toEqual([{ type: PROFILER_STATE_EVENT, data: { enabled: true } }])
    expect(await domains.dispatch(local, 'diagnostics.memory.state', {})).toEqual({ enabled: true })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(created[0].samples()).toHaveLength(1)

    settings.set({ experimental: { profiler: { ...settings.get().experimental.profiler, enabled: false } } })
    expect(events.at(-1)).toEqual({ type: PROFILER_STATE_EVENT, data: { enabled: false } })
    const samples = created[0].samples().length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(created[0].samples()).toHaveLength(samples)
    expect(profilerService()?.monitor()).toBeNull()
    handle.stop()
    expect(profilerService()).toBeNull()
  })

  it('asks the app for a report on request and resolves when its answer carries the id', async () => {
    const dir = home()
    const { settings, events, domains, mms, protocolServer } = fakeService(dir)
    settings.set({ experimental: { profiler: { ...settings.get().experimental.profiler, enabled: true } } })
    const handle = prepareMemoryMonitor({ mms, protocolServer, homeDir: dir, version: '0.1.3', env: {}, createMonitor: () => testMonitor(dir, { t: T0 }) })!
    handle.start()
    const service = profilerService()!
    const answered = service.collectApp(true, 1_000)
    const asked = events.find((event) => event.type === PROFILER_COLLECT_EVENT)!.data as { requestId: string; windows: boolean }
    expect(asked.windows).toBe(true)
    const counters = { domNodes: 4_000, mountedTurns: 6, mountedRows: 30, images: 2, imagesDecodedMbEstimated: 1.5, canvases: 1, canvasMbEstimated: 0.5, webglContexts: 1, browserTabs: 0, jsHeapUsedMb: 40, jsHeapTotalMb: 60, caches: { codeHighlight: { entries: 12, limit: 100 } } }
    await domains.dispatch(local, 'diagnostics.memory.appReport', { processes: [{ kind: 'gpu', role: 'gpu', rss: 300 }], requestId: asked.requestId, windows: [{ w: 1200, h: 800, scale: 1.5, visible: true, ...counters }], views: [{ role: 'applet', w: 400, h: 300, visible: true }] })
    expect(await answered).toBe(true)
    expect(service.monitor()!.appWindowDetail()).toMatchObject({ windows: [{ domNodes: 4_000, caches: { codeHighlight: { entries: 12 } } }], views: [{ role: 'applet', w: 400 }] })
    // No app: false once the wait is over.
    expect(await service.collectApp(false, 20)).toBe(false)
    handle.stop()
  })

  it('takes only counters, fixed cache names and view sizes from the app', () => {
    const counters = { domNodes: 1, mountedTurns: 1, mountedRows: 1, images: 0, imagesDecodedMbEstimated: 0, canvases: 0, canvasMbEstimated: 0, webglContexts: 0, browserTabs: 0, jsHeapUsedMb: 1, jsHeapTotalMb: 2, caches: {} }
    expect(validateAppReport({ processes: [], windows: [counters] }).windows).toEqual([counters])
    expect(() => validateAppReport({ processes: [], windows: [{ ...counters, title: 'Fix the login page' }] })).toThrow(/Unexpected field/)
    expect(() => validateAppReport({ processes: [], windows: [{ ...counters, caches: { 'C:/Users/alice': { entries: 1 } } }] })).toThrow(/Unknown cache name/)
    expect(() => validateAppReport({ processes: [], views: [{ role: 'browser', w: 1, h: 1, visible: true, url: 'https://x' }] })).toThrow(/Unexpected field/)
    expect(() => validateAppReport({ processes: [], requestId: '../../etc' })).toThrow(/requestId/)
  })

  it('lists each thread of the caller\'s profile once, and other profiles only as totals', () => {
    const ownOrchestrator = { loadedThreadIds: () => ['t1', 't2'], isTurnActive: (id: string) => id === 't2' }
    const other = {
      orchestrator: { loadedThreadIds: () => ['private-a', 'private-b'], isTurnActive: () => true },
      threads: { threadDbCacheEntries: () => [{ threadId: 'private-a', bytes: 3 * 1048576, idleMs: 5_000 }, { bytes: 1048576, idleMs: 0 }] }
    }
    const { own: entries, others } = readThreadMemory([{
      orchestrator: ownOrchestrator,
      threads: { threadDbCacheEntries: () => [{ threadId: 't1', bytes: 2 * 1048576, idleMs: 120_000 }, { threadId: 't3', bytes: 1048576, idleMs: 0 }, { bytes: 10, idleMs: 0 }] }
    } as never, other as never], ownOrchestrator, T0)
    // Another profile: totals, with no ids, turn states or idle times.
    expect(others).toEqual({ profiles: 1, loadedThreads: 2, cachedThreads: 2, cachedBytes: 4 * 1048576 })
    expect(JSON.stringify(entries)).not.toContain('private-')
    expect(entries).toEqual(expect.arrayContaining([
      { threadId: 't1', loaded: true, cached: true, turnRunning: false, cachedBytes: 2 * 1048576, idleSeconds: 120 },
      { threadId: 't2', loaded: true, cached: false, turnRunning: true, cachedBytes: null, idleSeconds: null },
      { threadId: 't3', loaded: false, cached: true, turnRunning: false, cachedBytes: 1048576, idleSeconds: 0 },
      { loaded: false, cached: true, turnRunning: false, cachedBytes: 10, idleSeconds: 0 }
    ]))
    expect(entries).toHaveLength(4)
  })
})

/** A profiler service over a real monitor, with threads of this profile and of another one. */
function profilerFixture(dir: string, options: { activeTurns?: number; heap?: () => Promise<HeapSummary> } = {}) {
  const now = { t: Date.now() }
  const monitor = testMonitor(dir, now)
  const own: ThreadMemoryEntry[] = [
    { threadId: 'own-1', loaded: true, cached: true, turnRunning: false, cachedBytes: 3 * 1048576, idleSeconds: 60 },
    { threadId: 'own-2', loaded: true, cached: true, turnRunning: true, cachedBytes: 5 * 1048576, idleSeconds: 30 }
  ]
  const threads = vi.fn((_owner: object): ThreadMemory => ({ own, others: { profiles: 1, loadedThreads: 2, cachedThreads: 1, cachedBytes: 2 * 1048576 } }))
  const collect = vi.fn(async (windows: boolean) => {
    monitor.acceptAppReport('gui', [
      { kind: 'main', role: 'main', rss: 200, private: 150, cpu: 1.5 },
      { kind: 'renderer', role: 'window', rss: 400, private: 320, heapUsed: 90, heapTotal: 120 },
      { kind: 'gpu', role: 'gpu', rss: 380, private: 334, cpu: 3 }
    ], { windows: [{ w: 1400, h: 900, scale: 1.5, visible: true }], surfaceMb: 10.8, acrylic: true, views: { applet: 1, browser: 0, devtools: 0 }, webglContexts: 1, canvases: 2, imagesMb: 4 },
    windows ? { windows: [{ w: 1400, h: 900, scale: 1.5, visible: true, domNodes: 5200, mountedTurns: 8, mountedRows: 40, images: 3, imagesDecodedMbEstimated: 2.4, imageCacheMb: 4, canvases: 2, canvasMbEstimated: 1.1, webglContexts: 1, browserTabs: 1, jsHeapUsedMb: 90, jsHeapTotalMb: 120, caches: { codeHighlight: { entries: 30, limit: 100 } } }], views: [{ role: 'applet', w: 640, h: 480, visible: true }] } : undefined)
    return true
  })
  const service: ProfilerService = {
    monitor: () => monitor,
    collectApp: collect,
    threads,
    activeTurns: () => options.activeTurns ?? 1,
    heapSummary: options.heap ?? (async () => { throw new Error('not in this test') }),
    refresh: () => {}
  }
  return { monitor, service, now, collect, threads }
}

const ON: ProfilerSettings = { ...normalizeProfilerSettings(), enabled: true, agentAccess: true }
/** The caller's profile, as the orchestrator the tool host names. */
const OWNER = { profile: 'own' }

/**
 * This profile's threads: `own-1` (the caller), `own-2`, and any `extra` ones, such as the threads that delegated to
 * it or private, bot and out-of-project ones; `projectIds` is the agent's allowed project list.
 */
function toolsFor(
  settings: () => ProfilerSettings,
  service: ProfilerService | null,
  turnActive = (_: string) => true,
  extra: Record<string, Record<string, unknown>> = {},
  projectIds: string[] = []
) {
  const profiler: () => ProfilerToolHost = () => ({ settings: settings(), service, owner: OWNER, turnActive })
  const metas: Record<string, object> = {
    'own-1': { id: 'own-1', name: 'Speed up startup', ...extra['own-1'] },
    'own-2': { id: 'own-2', name: 'Fix the login page', ...extra['own-2'] }
  }
  for (const [id, meta] of Object.entries(extra)) if (!metas[id]) metas[id] = { id, name: 'Fix the login page', ...meta }
  const host: AppToolHost = {
    delegation: () => undefined as never,
    askUser: async () => ({}),
    presentPlan: () => {},
    tasks: () => undefined,
    profiler,
    threadMeta: (threadId: string) => metas[threadId] as never,
    listThreads: () => Object.values(metas) as never,
    agentAccess: () => ({ projectIds }) as never
  } as unknown as AppToolHost
  return createAppToolRegistry({ host }).registry
}

const turn = {
  threadId: 'own-1', runId: 'run-1', turnToken: 'tok', mode: 'agent', modeFacts: { readOnly: false, agent: true, build: false }, modeCeiling: 'default',
  subagent: false, discovery: false, actor: { kind: 'main' }, enabledSkills: [], loadedSkills: [], settingsEnabled: () => true
} as unknown as AppToolTurn
function ctx(signal = new AbortController().signal): ToolCallContext {
  return { caller: { threadId: 'own-1', runId: 'run-1', provider: 'claude', modeCeiling: 'default', accessLevel: 'lineage' }, turn, toolCallId: 'call-1', signal, transport: 'mcp' }
}

async function call(registry: ReturnType<typeof toolsFor>, name: ProfilerToolName, args: Record<string, unknown> = {}, context = ctx()) {
  const tool = registry.get(name)!
  const outcome = await tool.handler(args, context)
  return { outcome, value: outcome.isError ? null : JSON.parse(outcome.text) }
}

describe('the profiler tools', () => {
  it('are listed and available only with the profiler, agent access and their own switch on', () => {
    const dir = home()
    const { service } = profilerFixture(dir)
    let settings: ProfilerSettings = normalizeProfilerSettings()
    const registry = toolsFor(() => settings, service)
    const listed = () => registry.listFor({ readOnly: false, modeCeiling: 'default' }).map((tool) => tool.name).filter((name) => name.startsWith('profiler_'))
    const offered = () => registry.offeredFor(turn).map((tool) => tool.name).filter((name) => name.startsWith('profiler_'))
    expect(listed()).toEqual([])
    expect(registry.get('profiler_overview')!.available!(turn)).toMatch(/profiler is off/)
    settings = { ...settings, enabled: true }
    expect(listed()).toEqual([])
    expect(registry.get('profiler_overview')!.available!(turn)).toMatch(/Agent access/)
    settings = { ...settings, agentAccess: true }
    const allButHeap = PROFILER_TOOL_NAMES.filter((name) => name !== 'profiler_heap_summary')
    expect(listed()).toEqual(allButHeap)
    expect(offered()).toEqual(allButHeap)
    expect(registry.get('profiler_heap_summary')!.available!(turn)).toMatch(/turned off/)
    settings = { ...settings, tools: { ...settings.tools, profiler_watch: false, profiler_heap_summary: true } }
    expect(listed()).toEqual(PROFILER_TOOL_NAMES.filter((name) => name !== 'profiler_watch'))
    // Off again: every tool disappears, and a runtime that cached the list is refused at the call.
    settings = { ...settings, enabled: false }
    expect(listed()).toEqual([])
    expect(offered()).toEqual([])
    expect(registry.get('profiler_overview')!.available!(turn)).toMatch(/profiler is off/)
  })

  it('refuse at the call when a switch went off after listing', async () => {
    const dir = home()
    const { service } = profilerFixture(dir)
    let settings = ON
    const registry = toolsFor(() => settings, service)
    settings = { ...ON, agentAccess: false }
    const { outcome } = await call(registry, 'profiler_overview')
    expect(outcome).toMatchObject({ isError: true, text: expect.stringContaining('Agent access') })
  })

  it('are not listed in a service without a profiler', () => {
    const registry = toolsFor(() => ON, null)
    expect(registry.listFor({ readOnly: false, modeCeiling: 'default' }).filter((tool) => tool.name.startsWith('profiler_'))).toEqual([])
  })

  it('profiler_overview: every process by role, the baseline, trends and breaches, numbers only', async () => {
    const dir = home()
    const { service } = profilerFixture(dir)
    const { value, outcome } = await call(toolsFor(() => ON, service), 'profiler_overview')
    expect(value).toMatchObject({ profiler: 'on', serviceUptimeMinutes: expect.any(Number), service: { mb: 150 }, app: { gpuMb: 334, largestWindowMb: 320 }, trend: { serviceMb: [150] }, breaches: [] })
    expect(value.processes.map((row: { label: string }) => row.label)).toEqual(['Service', 'Service workers (1)', 'Provider: claude', 'Provider: other', 'Main', 'Window', 'GPU', 'App total'])
    expect(value.processes.find((row: { label: string }) => row.label === 'GPU')).toMatchObject({ privateMb: 334, workingSetMb: 380, cpuPercent: 3 })
    expectNoPrivateData(outcome.text, dir)
  })

  it('profiler_service_breakdown: heap, counts, caches, this profile\'s threads by id and other profiles as totals', async () => {
    const dir = home()
    const { service, threads } = profilerFixture(dir)
    const { value, outcome } = await call(toolsFor(() => ON, service), 'profiler_service_breakdown')
    expect(threads).toHaveBeenCalledWith(OWNER)
    expect(value).toMatchObject({
      heap: { usedMb: 60, limitMb: 4096 },
      heapSpacesMb: { old_space: 50, other: 1 },
      workerHeapsMb: [4],
      counts: { loadedThreads: 1, cachedThreads: 1, sqliteConnections: 2, childProcesses: 2 },
      caches: { threadDatabase: { threads: 1, mb: 0.5, maxThreads: 64, maxMb: 48 }, replayBuffer: { events: 12, mb: 2, maxEventsPerProfile: 512 } }
    })
    // Ids and numbers only: no titles, not even this profile's (a private or expiring thread's title stays out too).
    expect(value.threads).toEqual([
      { threadId: 'own-2', loaded: true, cached: true, turnRunning: true, cachedMb: 5, idleMinutes: 1 },
      { threadId: 'own-1', loaded: true, cached: true, turnRunning: false, cachedMb: 3, idleMinutes: 1 }
    ])
    expect(value.otherProfiles).toEqual({ profiles: 1, loadedThreads: 2, cachedThreads: 1, cachedMb: 2 })
    expect(value.hiddenThreads).toEqual({ threads: 0, cachedMb: 0 })
    expect(value.bytes).toMatch(/measured/)
    expect(outcome.text).not.toContain('Speed up startup')
    expectNoPrivateData(outcome.text, dir)
  })

  it('profiler_service_breakdown names only the threads thread_list would show; private, bot and out-of-project ones count in a total', async () => {
    const dir = home()
    const { service } = profilerFixture(dir)
    const entry = (threadId: string | undefined, cachedBytes: number): ThreadMemoryEntry =>
      ({ ...(threadId ? { threadId } : {}), loaded: true, cached: true, turnRunning: true, cachedBytes, idleSeconds: 600 })
    service.threads = () => ({
      own: [
        entry('own-1', 1048576),
        entry('launched-1', 1048576),
        entry('private-1', 2 * 1048576),
        entry('private-child-1', 1048576),
        entry('bot-1', 3 * 1048576),
        entry('elsewhere-1', 4 * 1048576),
        entry('unknown-1', 1048576),
        entry(undefined, 1048576)
      ],
      others: { profiles: 0, loadedThreads: 0, cachedThreads: 0, cachedBytes: 0 }
    })
    const extra = {
      'own-1': { projectId: 'p1' },
      // Outside the allowed projects, but the caller launched it: thread_list shows it too.
      'launched-1': { projectId: 'p2', createdByThreadId: 'own-1' },
      'private-1': { projectId: 'p1', localOnly: true },
      // A subagent of a private thread is private too.
      'private-child-1': { projectId: 'p1', lineage: { parentThreadId: 'private-1', rootThreadId: 'private-1', relationship: 'subagent' } },
      'bot-1': { projectId: 'p1', botOwned: true },
      'elsewhere-1': { projectId: 'p2' }
    }
    const { value, outcome } = await call(toolsFor(() => ON, service, undefined, extra, ['p1']), 'profiler_service_breakdown')
    expect(value.threads.map((row: { threadId: string }) => row.threadId).sort()).toEqual(['launched-1', 'own-1'])
    expect(value.hiddenThreads).toEqual({ threads: 6, cachedMb: 12 })
    for (const id of ['private-', 'bot-1', 'elsewhere-1', 'unknown-1']) expect(outcome.text).not.toContain(id)
    expectNoPrivateData(outcome.text, dir)

    // An agent in a private thread sees the private threads, as thread_list shows them to it.
    const fromPrivate = await call(toolsFor(() => ON, service, undefined, { ...extra, 'own-1': { projectId: 'p1', localOnly: true } }, ['p1']), 'profiler_service_breakdown')
    expect(fromPrivate.value.threads.map((row: { threadId: string }) => row.threadId).sort()).toEqual(['launched-1', 'own-1', 'private-1', 'private-child-1'])
    expect(fromPrivate.value.hiddenThreads).toEqual({ threads: 4, cachedMb: 9 })
  })

  it('an unexpected error reaches the agent as fixed text, never its message', async () => {
    const dir = home()
    const { service } = profilerFixture(dir)
    service.threads = () => { throw new Error(`EACCES: permission denied, open '${join(dir, 'threads.db')}'`) }
    const { outcome } = await call(toolsFor(() => ON, service), 'profiler_service_breakdown')
    expect(outcome).toEqual({ isError: true, text: 'The profiler could not finish profiler_service_breakdown (Error). Call again in a few seconds.' })
    expectNoPrivateData(outcome.text, dir)
    // A heap summary that fails the same way.
    const settings = { ...ON, tools: { ...ON.tools, profiler_heap_summary: true } }
    const failing = profilerFixture(dir, { heap: async () => { throw new Error(`EPERM: operation not permitted, unlink '${dir}/x'`) } })
    const heap = await call(toolsFor(() => settings, failing.service), 'profiler_heap_summary')
    expect(heap.outcome).toMatchObject({ isError: true, text: expect.stringContaining('could not finish profiler_heap_summary') })
    expectNoPrivateData(heap.outcome.text, dir)
  })

  it('profiler_heap_summary releases its one-at-a-time hold after a summary fails', async () => {
    const dir = home()
    const settings = { ...ON, tools: { ...ON.tools, profiler_heap_summary: true } }
    const heap = vi.fn(async (): Promise<HeapSummary> => ({ nodes: 1, totalMb: 0, byType: [], topRetainers: [], biggestStrings: [] }))
    heap.mockImplementationOnce(async () => { throw new HeapSummaryError('The heap analysis took too long.') })
    const registry = toolsFor(() => settings, profilerFixture(dir, { activeTurns: 1, heap }).service)
    // A fixed summary error reaches the agent as it is.
    expect((await call(registry, 'profiler_heap_summary')).outcome).toEqual({ isError: true, text: 'The heap analysis took too long.' })
    const next = await call(registry, 'profiler_heap_summary')
    expect(next.outcome.isError).toBeFalsy()
    expect(heap).toHaveBeenCalledTimes(2)
  })

  it('profiler_window_breakdown: counters per window, read from the app on demand', async () => {
    const dir = home()
    const { service, collect } = profilerFixture(dir)
    const { value, outcome } = await call(toolsFor(() => ON, service), 'profiler_window_breakdown')
    expect(collect).toHaveBeenCalledWith(true)
    expect(value.windows).toEqual([{ window: 1, size: { w: 1400, h: 900, scale: 1.5, visible: true }, domNodes: 5200, mountedTurns: 8, mountedRows: 40, images: 3, imagesDecodedMbEstimated: 2.4, imageCacheMb: 4, canvases: 2, canvasMbEstimated: 1.1, webglContexts: 1, browserTabs: 1, jsHeapUsedMb: 90, jsHeapTotalMb: 120, caches: { codeHighlight: { entries: 30, limit: 100 } } }])
    expect(value.views).toEqual({ applet: [{ w: 640, h: 480, visible: true }], browser: [] })
    expect(value.windowProcessesMb).toEqual([320])
    expectNoPrivateData(outcome.text, dir)
  })

  it('profiler_window_breakdown says so when no app answers', async () => {
    const dir = home()
    const { service } = profilerFixture(dir)
    service.collectApp = async () => false
    const { value } = await call(toolsFor(() => ON, service), 'profiler_window_breakdown')
    expect(value).toMatchObject({ app: null })
  })

  it('profiler_gpu_hints and profiler_children: GPU memory, hints, view sizes, children by fixed kind', async () => {
    const dir = home()
    const { service } = profilerFixture(dir)
    const registry = toolsFor(() => ON, service)
    const gpu = await call(registry, 'profiler_gpu_hints')
    expect(gpu.value).toMatchObject({ gpu: { privateMb: 334, workingSetMb: 380 }, hints: { surfaceMb: 10.8, acrylic: true, webglContexts: 1, views: { applet: 1 } }, viewSizes: { applet: [{ w: 640, h: 480 }] } })
    expectNoPrivateData(gpu.outcome.text, dir)
    const children = await call(registry, 'profiler_children')
    expect(children.value).toMatchObject({ processes: [{ kind: 'claude', mb: 210 }, { kind: 'other', mb: 12 }], totalMb: 222 })
    expectNoPrivateData(children.outcome.text, dir)
  })

  it('profiler_sample_now: a fresh sample and what changed since the previous one', async () => {
    const dir = home()
    const { service, monitor } = profilerFixture(dir)
    const registry = toolsFor(() => ON, service)
    await monitor.tick()
    const { value, outcome } = await call(registry, 'profiler_sample_now')
    expect(value.now).toMatchObject({ serviceMb: 150, gpuMb: 334, loadedThreads: 1 })
    expect(value.sincePreviousSample).toMatchObject({ change: expect.any(Object) })
    expect(monitor.samples()).toHaveLength(2)
    expectNoPrivateData(outcome.text, dir)
  })

  it('profiler_watch is bounded: at most every 5 s, for 10 min and 120 points', async () => {
    expect(watchPlan(1, 1000)).toEqual({ intervalSeconds: 5, points: WATCH_LIMITS.maxPoints })
    expect(watchPlan(600, 1000)).toEqual({ intervalSeconds: 60, points: 11 })
    expect(watchPlan(undefined, undefined)).toEqual({ intervalSeconds: 10, points: 13 })
    expect(watchPlan('x', -3)).toEqual({ intervalSeconds: 10, points: 4 })

    vi.useFakeTimers({ now: T0 })
    const dir = home()
    const { service } = profilerFixture(dir)
    const pending = call(toolsFor(() => ON, service), 'profiler_watch', { intervalSeconds: 0, minutes: 60 })
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    const { value, outcome } = await pending
    expect(value.intervalSeconds).toBe(5)
    expect(value.points).toHaveLength(120)
    expect(value.points.at(-1).atSeconds).toBeLessThanOrEqual(600)
    expect(value.points[0]).toMatchObject({ serviceMb: 150, loadedThreads: 1 })
    expectNoPrivateData(outcome.text, dir)
  })

  it('profiler_watch stops when the call is stopped', async () => {
    vi.useFakeTimers({ now: T0 })
    const dir = home()
    const { service } = profilerFixture(dir)
    const abort = new AbortController()
    const pending = call(toolsFor(() => ON, service), 'profiler_watch', { intervalSeconds: 10, minutes: 5 }, ctx(abort.signal))
    await vi.advanceTimersByTimeAsync(25_000)
    abort.abort()
    await vi.advanceTimersByTimeAsync(0)
    const { value } = await pending
    expect(value.stopped).toMatch(/stopped/)
    expect(value.points.length).toBeLessThanOrEqual(4)
  })

  it('profiler_heap_summary refuses while another turn runs, and returns only aggregates', async () => {
    const dir = home()
    const summary: HeapSummary = { nodes: 3, totalMb: 1, byType: [{ type: 'string', count: 1, selfMb: 0.5 }], topRetainers: [{ name: 'Map', count: 1, selfMb: 0.1, retainedMb: 0.6 }], biggestStrings: [{ type: 'string', bytes: 4096, retainedBytes: 4096, content: 'redacted' }] }
    const heap = vi.fn(async () => summary)
    const settings = { ...ON, tools: { ...ON.tools, profiler_heap_summary: true } }
    // Two turns run: the caller's and another.
    const busy = profilerFixture(dir, { activeTurns: 2, heap })
    const refused = await call(toolsFor(() => settings, busy.service), 'profiler_heap_summary')
    expect(refused.outcome).toMatchObject({ isError: true, text: expect.stringContaining('Another turn is running') })
    expect(heap).not.toHaveBeenCalled()
    // Only the caller's own turn runs.
    const idle = profilerFixture(dir, { activeTurns: 1, heap })
    const { value } = await call(toolsFor(() => settings, idle.service), 'profiler_heap_summary', { top: 99 })
    expect(heap).toHaveBeenCalledWith(30)
    expect(Object.keys(value).sort()).toEqual(['biggestStrings', 'byType', 'nodes', 'note', 'topRetainers', 'totalMb'])
  })

  it('profiler_heap_summary runs one at a time: a second call while one runs is refused', async () => {
    const dir = home()
    const summary: HeapSummary = { nodes: 1, totalMb: 0, byType: [], topRetainers: [], biggestStrings: [] }
    let finish!: () => void
    const heap = vi.fn(() => new Promise<HeapSummary>((resolve) => { finish = () => resolve(summary) }))
    const settings = { ...ON, tools: { ...ON.tools, profiler_heap_summary: true } }
    const registry = toolsFor(() => settings, profilerFixture(dir, { activeTurns: 1, heap }).service)
    // Two calls from one turn, in the same moment.
    const first = call(registry, 'profiler_heap_summary')
    const second = call(registry, 'profiler_heap_summary')
    expect((await second).outcome).toMatchObject({ isError: true, text: expect.stringContaining('already running') })
    expect(heap).toHaveBeenCalledTimes(1)
    finish()
    expect((await first).outcome.isError).toBeFalsy()
    // Once it is done, the next one runs.
    const third = call(registry, 'profiler_heap_summary')
    await vi.waitFor(() => expect(heap).toHaveBeenCalledTimes(2))
    finish()
    expect((await third).outcome.isError).toBeFalsy()
  })

  it('profiler_heap_summary from a delegated child does not count the turns waiting on it', async () => {
    const dir = home()
    const heap = vi.fn(async (): Promise<HeapSummary> => ({ nodes: 1, totalMb: 0, byType: [], topRetainers: [], biggestStrings: [] }))
    const settings = { ...ON, tools: { ...ON.tools, profiler_heap_summary: true } }
    // own-1 was delegated by parent-1, itself delegated by root-1: all three have a turn running.
    const chain = { 'own-1': { lineage: { parentThreadId: 'parent-1' } }, 'parent-1': { lineage: { parentThreadId: 'root-1' } }, 'root-1': {} }
    const running = new Set(['own-1', 'parent-1', 'root-1'])
    const turnActive = (id: string) => running.has(id)
    const allowed = await call(toolsFor(() => settings, profilerFixture(dir, { activeTurns: 3, heap }).service, turnActive, chain), 'profiler_heap_summary')
    expect(allowed.outcome.isError).toBeFalsy()
    expect(heap).toHaveBeenCalledTimes(1)
    // A turn outside the chain still counts.
    const refused = await call(toolsFor(() => settings, profilerFixture(dir, { activeTurns: 4, heap }).service, turnActive, chain), 'profiler_heap_summary')
    expect(refused.outcome).toMatchObject({ isError: true, text: expect.stringContaining('Another turn is running (1)') })
    expect(heap).toHaveBeenCalledTimes(1)
  })
})

/** A small heap snapshot in V8's format, holding the private strings a real one would. */
function syntheticSnapshot() {
  const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness']
  const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
  const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']
  const strings = ['', '(GC roots)', 'ThreadSession', 'Fix the login page and push to C:\\Users\\alice\\repo', 'sk-ant-api03-SECRET', 'messages', 'weird name/with path', 'Map']
  const T = (name: string) => nodeTypes.indexOf(name)
  // root -> session -> [prompt string, token string, map]; root -weak-> big string (not retained).
  const nodes = [
    [T('synthetic'), 1, 1, 0, 2],
    [T('object'), 2, 3, 10_000, 3],
    [T('string'), 3, 5, 200_000, 0],
    [T('string'), 4, 7, 50_000, 0],
    [T('object'), 7, 9, 64, 0],
    [T('object'), 6, 11, 32, 0]
  ].map((n) => [...n, 0, 0])
  const NF = nodeFields.length
  const E = (type: string, name: number, to: number) => [edgeTypes.indexOf(type), name, to * NF]
  const edges = [E('element', 1, 1), E('weak', 2, 5), E('property', 5, 2), E('property', 5, 3), E('property', 5, 4)]
  return {
    snapshot: { meta: { node_fields: nodeFields, node_types: [nodeTypes], edge_fields: ['type', 'name_or_index', 'to_node'], edge_types: [edgeTypes] }, node_count: nodes.length, edge_count: edges.length },
    nodes: nodes.flat(),
    edges: edges.flat(),
    strings
  }
}

describe('the heap summary', () => {
  it('sums retained sizes by constructor and never reads string content out', () => {
    const summary = summarizeHeapSnapshot(syntheticSnapshot(), 10)
    expect(summary.nodes).toBe(5)
    expect(summary.topRetainers[0]).toMatchObject({ name: 'ThreadSession', count: 1 })
    expect(summary.topRetainers.find((entry) => entry.name === 'ThreadSession')!.retainedMb).toBeCloseTo((10_000 + 200_000 + 50_000 + 64) / 1048576, 1)
    expect(summary.biggestStrings).toEqual([
      { type: 'string', bytes: 200_000, retainedBytes: 200_000, content: 'redacted' },
      { type: 'string', bytes: 50_000, retainedBytes: 50_000, content: 'redacted' }
    ])
    // The weakly held object is not reachable, and a name that is not an identifier is dropped.
    expect(summary.topRetainers.map((entry) => entry.name)).not.toContain('weird name/with path')
    const text = JSON.stringify(summary)
    for (const value of ['Fix the login page', 'sk-ant-api03-SECRET', 'alice', 'messages']) expect(text).not.toContain(value)
  })

  it('analyses a real snapshot in a worker, and deletes the file whatever happens', async () => {
    const dir = home()
    // A real V8 snapshot, of a small worker's heap.
    const file = join(dir, 'real.heapsnapshot')
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker("const v8 = require('node:v8'); const { workerData, parentPort } = require('node:worker_threads'); globalThis.kept = 'Fix the login page ' + 'x'.repeat(5000); v8.writeHeapSnapshot(workerData); parentPort.postMessage('done')", { eval: true, workerData: file })
      worker.once('message', () => { void worker.terminate(); resolve() })
      worker.once('error', reject)
    })
    const summary = await analyseHeapSnapshotFile(file, 10)
    expect(summary.nodes).toBeGreaterThan(1000)
    expect(summary.byType.map((entry) => entry.type)).toContain('string')
    expect(summary.biggestStrings.length).toBeGreaterThan(0)
    expect(JSON.stringify(summary)).not.toContain('Fix the login page')

    const written: string[] = []
    const result = await takeHeapSummary(dir, 10, { write: (target) => { writeFileSync(target, JSON.stringify(syntheticSnapshot())); written.push(target); return target }, analyse: (target, top) => analyseHeapSnapshotFile(target, top) })
    expect(result.nodes).toBe(5)
    expect(readdirSync(join(dir, HEAP_SNAPSHOT_RELATIVE_DIR))).toEqual([])
    // A parse error comes back by its class alone: its message would quote the file.
    const failed = takeHeapSummary(dir, 10, { write: (target) => { writeFileSync(target, 'not json Fix the login page'); return target } })
    await expect(failed).rejects.toThrow(/heap analysis failed \(SyntaxError\)/)
    await failed.catch((error: Error) => expect(error.message).not.toContain('Fix the login page'))
    expect(readdirSync(join(dir, HEAP_SNAPSHOT_RELATIVE_DIR))).toEqual([])
  })

  it('refuses a snapshot over the size cap before reading it, with numbers only', async () => {
    const dir = home()
    const file = join(dir, 'big.heapsnapshot')
    writeFileSync(file, Buffer.alloc(3 * 1048576, 32))
    const refused = analyseHeapSnapshotFile(file, 10, { maxFileMb: 2 })
    await expect(refused).rejects.toThrow('The service heap snapshot is 3 MB; the summary reads at most 2 MB. Use profiler_service_breakdown instead.')
    await refused.catch((error: Error) => expectNoPrivateData(error.message, dir))
    // Through the summary too: refused, and the file deleted.
    await expect(takeHeapSummary(dir, 10, {
      write: (target) => { writeFileSync(target, Buffer.alloc(3 * 1048576, 32)); return target },
      analyse: (target, top) => analyseHeapSnapshotFile(target, top, { maxFileMb: 2 })
    })).rejects.toThrow(/at most 2 MB/)
    expect(readdirSync(join(dir, HEAP_SNAPSHOT_RELATIVE_DIR))).toEqual([])
  })

  it('refuses a heap clearly too big for the cap before writing a snapshot, with numbers only', async () => {
    const dir = home()
    const write = vi.fn((target: string) => { writeFileSync(target, '{}'); return target })
    const analyse = async (): Promise<HeapSummary> => ({ nodes: 0, totalMb: 0, byType: [], topRetainers: [], biggestStrings: [] })
    // Over twice the cap: refused, and nothing written, not even the folder.
    const refused = takeHeapSummary(dir, 10, { write, analyse, maxFileMb: 2, heapUsedBytes: () => 5 * 1048576 })
    await expect(refused).rejects.toThrow(new HeapSummaryError('The service heap uses 5 MB; its snapshot would pass the 2 MB the summary reads. Use profiler_service_breakdown instead.'))
    await refused.catch((caught: Error) => expectNoPrivateData(caught.message, dir))
    expect(write).not.toHaveBeenCalled()
    expect(existsSync(join(dir, HEAP_SNAPSHOT_RELATIVE_DIR))).toBe(false)
    // Under twice the cap, the snapshot is written and the cap on the file decides.
    await expect(takeHeapSummary(dir, 10, { write, analyse, maxFileMb: 2, heapUsedBytes: () => 3 * 1048576 })).resolves.toMatchObject({ nodes: 0 })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('a folder it cannot create or a file it cannot delete never puts the home path in an error', async () => {
    const dir = home()
    const analyse = async (): Promise<HeapSummary> => ({ nodes: 7, totalMb: 0, byType: [], topRetainers: [], biggestStrings: [] })
    // `diagnostics` is a file: creating the snapshot folder fails with an error naming the path.
    writeFileSync(join(dir, 'diagnostics'), 'not a folder')
    const failed = takeHeapSummary(dir, 10, { write: (target) => target, analyse })
    await expect(failed).rejects.toThrow(new HeapSummaryError('The heap snapshot could not be written.'))
    await failed.catch((caught: Error) => expectNoPrivateData(caught.message, dir))

    // A summary whose file cannot be deleted (here a folder, so the delete throws) still returns its summary.
    const other = home()
    const summary = await takeHeapSummary(other, 10, { write: (target) => { mkdirSync(target); return target }, analyse })
    expect(summary.nodes).toBe(7)
  })

  it('a worker over its heap limit fails with a fixed message', async () => {
    const dir = home()
    const file = join(dir, 'real-size.heapsnapshot')
    // Valid JSON whose parse needs far more than the limit allows.
    writeFileSync(file, `{"snapshot":{"meta":{}},"nodes":[${'1,'.repeat(4_000_000)}1],"edges":[],"strings":[]}`)
    await expect(analyseHeapSnapshotFile(file, 10, { workerHeapMb: 8 })).rejects.toThrow(/memory limit|failed in its worker/)
  })

  it('deletes heap summary files a crash left behind, at service start and before each summary, and keeps asked-for snapshots', async () => {
    const dir = home()
    const folder = join(dir, HEAP_SNAPSHOT_RELATIVE_DIR)
    const leave = () => {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'agent-1700000000000.heapsnapshot'), '{"Fix the login page":1}')
      writeFileSync(join(folder, 'heap-2026-11-11T08-00-00-000Z.heapsnapshot'), '{}')
    }
    leave()
    expect(removeLeftoverSummaryFiles(dir)).toBe(1)
    expect(readdirSync(folder)).toEqual(['heap-2026-11-11T08-00-00-000Z.heapsnapshot'])
    expect(removeLeftoverSummaryFiles(home())).toBe(0)

    // Before a summary: the leftover is gone before the new file is written.
    leave()
    let seen: string[] = []
    await takeHeapSummary(dir, 10, { write: (target) => { seen = readdirSync(folder); writeFileSync(target, '{}'); return target }, analyse: async () => ({ nodes: 0, totalMb: 0, byType: [], topRetainers: [], biggestStrings: [] }) })
    expect(seen).toEqual(['heap-2026-11-11T08-00-00-000Z.heapsnapshot'])

    // At service start, even with the profiler off.
    leave()
    const { mms, protocolServer } = fakeService(dir)
    const handle = prepareMemoryMonitor({ mms, protocolServer, homeDir: dir, version: '0.1.3', env: {}, createMonitor: () => testMonitor(dir, { t: T0 }) })!
    expect(readdirSync(folder)).toEqual(['heap-2026-11-11T08-00-00-000Z.heapsnapshot'])
    handle.stop()
  })
})

describe('stopping the profiler', () => {
  it('a sample still reading when the monitor stops writes no line and raises no notice', async () => {
    const dir = home()
    let release!: () => void
    const onNotice = vi.fn()
    const log = new MemoryLog(dir, { flushIntervalMs: 1 })
    const monitor = new MemoryMonitor({
      homeDir: dir,
      version: '0.1.3',
      // Any service size breaks this limit, so a finished sample would raise a notice.
      thresholds: resolveMemoryThresholds('{"servicePrivateMb":1,"serviceSevereMb":2,"serviceSustainMinutes":0}'),
      readCounts: async () => ({ counts: { sqliteConnections: 0, workerThreads: 0, loadedThreads: 0, threadRuntimes: 0, threadCacheThreads: 0, threadCacheMb: 0, replayEvents: 0, ptys: 0, fileWatchers: 0, profiles: 1, activeTurns: 0 }, workerHeaps: [] }),
      sampleProcess: () => new Promise((resolve) => { release = () => resolve({ rss: 900, private: 900, heapUsed: 60, heapTotal: 80, external: 4, arrayBuffers: 1 }) }),
      readDetail: () => ({ heapSpaces: {}, heap: { totalHeapSize: 80, usedHeapSize: 60, heapSizeLimit: 4096, mallocedMemory: 1, externalMemory: 4, nativeContexts: 1, detachedContexts: 0 } }),
      readChildren: async () => [],
      childCount: () => 0,
      onNotice,
      log
    })
    const pending = monitor.tick()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    monitor.stop()
    release()
    await pending
    log.flushSync()
    expect(monitor.samples()).toHaveLength(0)
    const file = join(dir, 'diagnostics', 'memory.jsonl')
    const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).type) : []
    expect(lines).not.toContain('sample')
    expect(onNotice).not.toHaveBeenCalled()
    // A tick after stop does nothing at all.
    await monitor.tick()
    expect(monitor.samples()).toHaveLength(0)
  })

  it('stops the monitor when the last profile with the profiler on is archived or removed', async () => {
    const dir = home()
    const { settings, domains, mms, protocolServer } = fakeService(dir)
    settings.set({ experimental: { profiler: { ...settings.get().experimental.profiler, enabled: true } } })
    const profile = { ...(mms as unknown as Record<string, unknown>) }
    let live: unknown[] = [profile]
    const withHost = { ...(mms as unknown as Record<string, unknown>), getInstallationHost: () => ({ liveServices: () => live }) } as unknown as MousseMainService
    const handle = prepareMemoryMonitor({ mms: withHost, protocolServer, homeDir: dir, version: '0.1.3', env: {}, createMonitor: () => testMonitor(dir, { t: T0 }) })!
    handle.start()
    expect(profilerService()!.monitor()).not.toBeNull()
    live = []
    domains.notifyProfileDisposed('profile-2')
    expect(profilerService()!.monitor()).toBeNull()
    handle.stop()
  })
})
