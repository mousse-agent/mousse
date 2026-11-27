/**
 * The profiler through the app tools, as a bot's turn reaches them: every bot has it without a grant, held to Labs; the
 * grant compiled for the turn's lane, the bot's authority, the registry's listing and per-call check, and the profiler
 * tools' own handlers over a real monitor. The engine side is in tests/bots/botProfiler.test.ts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread, type CompileInput } from '../../src/mms/bots/grants/compile'
import { MemoryMonitor } from '../../src/mms/diagnostics/MemoryMonitor'
import { MemoryLog } from '../../src/mms/diagnostics/memoryLog'
import type { ProfilerService, ThreadMemoryEntry } from '../../src/mms/diagnostics/profilerService'
import type { ProfilerToolHost } from '../../src/mms/run/mcp/appTools'
import { BOT_PROFILER_CHAT_TOOLS, BOT_PROFILER_PERMISSION, BOT_PROFILER_TOOLS, BOT_THREADS_PERMISSION, botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { resolveMemoryThresholds } from '../../src/shared/diagnostics/memory'
import { normalizeProfilerSettings, type ProfilerSettings } from '../../src/shared/diagnostics/profiler'
import type { Thread } from '../../src/shared/types'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-11-15T10:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread
/** Labs → Profiler with agent access on, and every tool's switch on, the heap summary included. */
const ON: ProfilerSettings = (() => {
  const settings = normalizeProfilerSettings({ enabled: true, agentAccess: true })
  return { ...settings, tools: { ...settings.tools, profiler_heap_summary: true } }
})()
const profilerNames = (names: readonly string[]) => names.filter((name) => name.startsWith('profiler_')).sort()

describe('a bot\'s profiler tools', () => {
  let fx: DelegationFixture | undefined
  let base: string | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
    if (base) rmSync(base, { recursive: true, force: true })
    base = undefined
  })

  /**
   * A bot whose chat thread is `home`, holding a live run. `botTools` is what its turn is compiled with (a chat turn has
   * `frontDesk`); `grant` adds permissions to the starter grant (none by default: the profiler needs none). `settings` is
   * Labs → Profiler, read at every call.
   */
  const world = async (options: { grant?: string[]; botTools?: Partial<NonNullable<CompileInput['botTools']>>; role?: 'activation' | 'context'; settings?: () => ProfilerSettings } = {}) => {
    fx = delegationFixture()
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-profiler-')))
    const profile = join(base, 'profile')
    const scratch = join(profile, 'bots', 'scratch', 'act-1')
    mkdirSync(scratch, { recursive: true })
    const starter = botStarterManifest()
    const grant = { ...starter, appTools: [...starter.appTools, ...(options.grant ?? [])] }
    const compiled = compileBotThread({
      grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: profile,
      nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 600_000 },
      botTools: { escalate: true, consult: false, memory: true, profiler: true, ...options.botTools }
    })
    if (!compiled.ok) throw new Error(compiled.error.message)
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation', permissions: compiled.permissions, waiting: () => false,
      counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
    })
    const homeRun = await fx.runningRun('home')
    // The owner's threads: ordinary ones, a private one, another bot's chat and the bot's own, a subagent, the Automation manager's.
    const threads = new Map<string, Thread>([
      ['home', thread('home', { botOwned: true } as Partial<Thread>)],
      ['other-bot', thread('other-bot', { botOwned: true } as Partial<Thread>)],
      ['mine', thread('mine', { name: 'Fix the login page' })],
      ['elsewhere', thread('elsewhere', { projectId: 'p2' })],
      ['private', thread('private', { localOnly: true })],
      ['subagent', thread('subagent', { lineage: { parentThreadId: 'mine', rootThreadId: 'mine', relationship: 'subagent' } } as Partial<Thread>)],
      ['manager', thread('manager', { name: 'Automation manager', automationManager: true } as Partial<Thread>)]
    ])
    const monitor = new MemoryMonitor({
      homeDir: base,
      version: '0.1.3',
      thresholds: resolveMemoryThresholds('{}'),
      readCounts: async () => ({ counts: { sqliteConnections: 2, workerThreads: 2, loadedThreads: 1, threadRuntimes: 1, threadCacheThreads: 1, threadCacheMb: 0.5, replayEvents: 12, ptys: 0, fileWatchers: 1, profiles: 1, activeTurns: 0 }, workerHeaps: [] }),
      readReplayBytes: () => 0,
      sampleProcess: async () => ({ rss: 190, private: 150, heapUsed: 60, heapTotal: 80, external: 4, arrayBuffers: 1 }),
      readDetail: () => ({ heapSpaces: { old_space: 50 }, heap: { totalHeapSize: 80, usedHeapSize: 60, heapSizeLimit: 4096, mallocedMemory: 1, externalMemory: 4, nativeContexts: 1, detachedContexts: 0 } }),
      readChildren: async () => [],
      childCount: () => 0,
      log: new MemoryLog(base, { flushIntervalMs: 1 })
    })
    // Every thread above holds memory, so the breakdown has an entry for each.
    const own: ThreadMemoryEntry[] = [...threads.keys()].map((threadId) => ({ threadId, loaded: true, cached: true, turnRunning: false, cachedBytes: 1048576, idleSeconds: 60 }))
    const service: ProfilerService = {
      monitor: () => monitor,
      collectApp: async () => false,
      threads: () => ({ own, others: { profiles: 0, loadedThreads: 0, cachedThreads: 0, cachedBytes: 0 } }),
      activeTurns: () => 0,
      heapSummary: async () => { throw new Error('a bot never reaches the heap summary') },
      refresh: () => {}
    }
    const settings = options.settings ?? (() => ON)
    const fake = fakeAppToolHost({
      threadMeta: (id) => threads.get(id),
      listThreads: () => [...threads.values()],
      botRole: (id) => (id === 'home' ? options.role ?? 'activation' : id === 'other-bot' ? 'activation' : undefined),
      profiler: (): ProfilerToolHost => ({ settings: settings(), service, owner: {}, turnActive: () => false })
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'home', runId: homeRun.runId, bot: authority }))
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const outcome = await registry.call(name, args, request({ threadId: 'home', runId: homeRun.runId }))
      // A refusal reads as its words; its shape is checked in toolRefusalShape.test.ts.
      return { error: outcome.isError === true, text: refusalOf(outcome)?.message ?? outcome.text }
    }
    const listed = () => profilerNames(registry.listForThread('home', homeRun.runId).map((tool) => tool.name))
    return { compiled, call, listed, runId: homeRun.runId, registry }
  }

  // What each kind of turn is offered and listed. The heap summary is in no row: no bot ever gets it.
  const lanes: Array<[string, Parameters<typeof world>[0], readonly string[]]> = [
    ['work (a run\'s main turn)', {}, BOT_PROFILER_TOOLS],
    ['a chat turn: all but the minutes-long watch', { botTools: { frontDesk: true } }, BOT_PROFILER_CHAT_TOOLS],
    // A grant an older build approved with "use the profiler" gives nothing more.
    ['a grant that still names the old permission', { grant: [BOT_PROFILER_PERMISSION] }, BOT_PROFILER_TOOLS],
    ['a consult', { botTools: { profiler: undefined } }, []],
    // A thread's subagent may read the profiler, so a bot's work's subagent may too, within the grant.
    ['a subagent of its work', { botTools: { subagent: true } }, BOT_PROFILER_TOOLS],
    ['a subagent compiled without it', { botTools: { subagent: true, profiler: undefined } }, []]
  ]
  it.each(lanes)('%s', async (_name, options, shown) => {
    const { compiled, listed } = await world(options)
    expect(profilerNames(compiled.permissions.appTools)).toEqual([...shown].sort())
    expect(profilerNames(compiled.policy.tools!.allow)).toEqual([...shown].sort())
    expect(listed()).toEqual([...shown].sort())
  })

  it('the work runs a profiler tool with no grant for it; the heap summary never runs, even with its switch on', async () => {
    const allowed = await world()
    expect(BOT_PROFILER_TOOLS).not.toContain('profiler_heap_summary')
    expect(allowed.listed()).not.toContain('profiler_heap_summary')
    const overview = await allowed.call('profiler_overview')
    expect(overview.error).toBe(false)
    expect(JSON.parse(overview.text)).toMatchObject({ profiler: 'on' })
    expect(await allowed.call('profiler_heap_summary')).toMatchObject({ error: true, text: expect.stringMatching(/not allowed to use profiler_heap_summary/) })
  })

  it('with Labs off, or agent access off, a bot gets the plain refusal', async () => {
    let settings = ON
    const { call, listed } = await world({ settings: () => settings })
    settings = { ...ON, enabled: false }
    expect(listed()).toEqual([])
    expect(await call('profiler_overview')).toEqual({ error: true, text: 'The profiler is off. The person can turn it on in Settings → Labs.' })
    settings = { ...ON, agentAccess: false }
    expect(await call('profiler_sample_now')).toMatchObject({ error: true, text: expect.stringMatching(/^Agents may not use the profiler\./) })
    settings = { ...ON, tools: { ...ON.tools, profiler_children: false } }
    expect(await call('profiler_children')).toEqual({ error: true, text: 'profiler_children is turned off in Settings → Labs → Profiler.' })
  })

  // Which threads the breakdown names for a bot: what thread_list would list it, and nothing without "use your threads".
  const named: Array<[string, string[], string[]]> = [
    ['without "use your threads", none: every thread counts only in the total', [], []],
    ['with it, only the owner\'s ordinary threads; never private, bot, subagent or Automation manager threads', [BOT_THREADS_PERMISSION], ['elsewhere', 'mine']]
  ]
  it.each(named)('profiler_service_breakdown for a bot %s', async (_name, grant, ids) => {
    const { call } = await world({ grant, botTools: { threads: 'read' } })
    const outcome = await call('profiler_service_breakdown')
    expect(outcome.error).toBe(false)
    const value = JSON.parse(outcome.text) as { threads: Array<{ threadId: string }>; hiddenThreads: { threads: number } }
    expect(value.threads.map((row) => row.threadId).sort()).toEqual(ids)
    expect(value.hiddenThreads.threads).toBe(7 - ids.length)
    for (const hidden of ['home', 'other-bot', 'private', 'subagent', 'manager']) expect(outcome.text).not.toContain(`"${hidden}"`)
  })
})
