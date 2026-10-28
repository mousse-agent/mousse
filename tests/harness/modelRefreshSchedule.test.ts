/**
 * The model-list schedule: every enabled, signed-in provider instance's list is refreshed in the
 * background (a pass after start-up, then every interval), never under a running chat, two at a
 * time, and when a probe sees a different program. The refresh time is kept with the list.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeInstanceConfig, type DriverRuntime, type HarnessDriver } from '../../src/mms/harness/driver'
import { CLAUDE_CODE_CAPS } from '../../src/mms/harness/drivers/claudeCode'
import { MODEL_REFRESH_INTERVAL_MS, MODEL_REFRESH_STARTUP_DELAY_MS, type Harness, type TurnSpec } from '../../src/mms/harness/gateway'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import type { ProviderAdapter, TurnInput, TurnResult } from '../../src/mms/harness/adapter'
import { testHarness } from '../../src/mms/run/testkit/harness'

const HOUR = 60 * 60_000

/** What the fake agents report and what the harness asked of them. */
interface World {
  signedIn: Set<string>
  /** The list age each instance's runtime keeps ("on disk"). */
  stamps: Map<string, string>
  /** Instances in the order their refresh started. */
  started: string[]
  running: number
  peak: number
  /** Refreshes wait here when set. */
  hold?: Promise<void>
  failing: Set<string>
  /** A turn that has not ended (a chat running on the instance). */
  turn?: Promise<void>
}

function newWorld(signedIn: string[]): World {
  return { signedIn: new Set(signedIn), stamps: new Map(), started: [], running: 0, peak: 0, failing: new Set() }
}

class Chat implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = { ...CLAUDE_CODE_CAPS }
  constructor(private readonly world: World) {}
  async startTurn(input: TurnInput, sink: Parameters<ProviderAdapter['startTurn']>[1]): Promise<TurnResult> {
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    await this.world.turn
    return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

function agentDriver(world: World): HarnessDriver {
  return {
    kind: 'claude',
    label: 'Fake agent',
    binaryNames: ['mousse-model-refresh-agent-never-on-path'],
    multiInstance: true,
    privateHome: false,
    canInstall: false,
    customModels: true,
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    versionArgs: () => null,
    caps: () => ({ ...CLAUDE_CODE_CAPS }),
    create(context) {
      const id = context.instanceId
      const runtime: DriverRuntime = {
        adapter: new Chat(world),
        configured: () => world.signedIn.has(id),
        models: () => [{ id: 'm', label: 'Model' }],
        auth: async () => (world.signedIn.has(id) ? { state: 'signed_in' } : { state: 'signed_out' }),
        refreshModels: async () => {
          world.started.push(id)
          world.running += 1
          world.peak = Math.max(world.peak, world.running)
          try {
            await world.hold
            if (world.failing.has(id)) throw new Error('the agent did not answer')
            world.stamps.set(id, new Date().toISOString())
          } finally {
            world.running -= 1
          }
        },
        modelsRefreshedAt: () => world.stamps.get(id),
        stop: () => {}
      }
      return runtime
    }
  }
}

describe('model refresh schedule', () => {
  const homes: string[] = []
  const harnesses: Harness[] = []
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    for (const harness of harnesses.splice(0)) harness.stop()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  function fixture(world: World, ids: string[], options: { enabled?: Record<string, boolean> } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'mousse-model-refresh-'))
    homes.push(home)
    const binary = join(home, 'agent.exe')
    writeFileSync(binary, 'agent v1', { mode: 0o755 })
    let stored: unknown = Object.fromEntries(ids.map((id) => [id, { driver: 'claude', enabled: options.enabled?.[id] ?? true, config: { binaryPath: binary } }]))
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [agentDriver(world)], instances, profileHome: home })
    harnesses.push(harness)
    const spec = (binding: TurnSpec['binding']): TurnSpec => ({
      binding,
      input: { threadId: 't', instanceId: binding.instanceId, llmProvider: 'claude-subscription', model: 'm', mode: 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput,
      sink: { providerRef: () => {} } as unknown as TurnSpec['sink'],
      control: {} as TurnSpec['control'],
      host: {} as TurnSpec['host']
    })
    const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
    return { home, binary, harness, spec, advance }
  }

  it('refreshes after the start-up delay, and not before', async () => {
    const world = newWorld(['claude:a'])
    const { harness, advance } = fixture(world, ['claude:a'])
    harness.startModelRefreshSchedule()
    await advance(MODEL_REFRESH_STARTUP_DELAY_MS - 1)
    expect(world.started).toEqual([])
    await advance(1)
    await advance(50)
    expect(world.started).toEqual(['claude:a'])
    const snapshot = (await harness.instances.snapshots({ kind: 'device' }))[0]!
    expect(snapshot.models.source).toBe('live')
    expect(Date.parse(snapshot.models.refreshedAt!)).toBeLessThanOrEqual(Date.now())
  })

  it('leaves a list younger than the interval alone at start-up, then refreshes it each interval', async () => {
    const world = newWorld(['claude:a'])
    // Refreshed an hour before this run started, as read back from disk.
    world.stamps.set('claude:a', new Date(Date.now() - HOUR).toISOString())
    const { harness, advance } = fixture(world, ['claude:a'])
    harness.startModelRefreshSchedule()
    await advance(MODEL_REFRESH_STARTUP_DELAY_MS + 50)
    expect(world.started).toEqual([])
    await advance(MODEL_REFRESH_INTERVAL_MS)
    await advance(50)
    expect(world.started).toEqual(['claude:a'])
    // The refresh that just ended is not skipped as "recent" when the next interval comes round.
    await advance(MODEL_REFRESH_INTERVAL_MS)
    await advance(50)
    expect(world.started).toEqual(['claude:a', 'claude:a'])
  })

  it('refreshes a list that is older than the interval at start-up', async () => {
    const world = newWorld(['claude:a'])
    world.stamps.set('claude:a', new Date(Date.now() - 4 * HOUR).toISOString())
    const { harness, advance } = fixture(world, ['claude:a'])
    harness.startModelRefreshSchedule()
    await advance(MODEL_REFRESH_STARTUP_DELAY_MS + 50)
    expect(world.started).toEqual(['claude:a'])
  })

  it('reads the stored refresh time back into the snapshot', async () => {
    const world = newWorld(['claude:a'])
    const stamp = new Date(Date.now() - 2 * HOUR).toISOString()
    world.stamps.set('claude:a', stamp)
    const { harness } = fixture(world, ['claude:a'])
    const snapshot = (await harness.instances.snapshots({ kind: 'device' }))[0]!
    expect(snapshot.models).toMatchObject({ source: 'live', refreshedAt: stamp })
  })

  it('skips instances that are turned off, signed out, or running a chat, and retries them next cycle', async () => {
    const world = newWorld(['claude:on', 'claude:off', 'claude:busy'])
    const { harness, spec, advance } = fixture(world, ['claude:on', 'claude:off', 'claude:signedout', 'claude:busy'], { enabled: { 'claude:off': false } })
    harness.startModelRefreshSchedule()
    // A chat that has not ended on `claude:busy`.
    let release!: () => void
    world.turn = new Promise<void>((resolve) => { release = resolve })
    await harness.instances.recheck('claude:busy')
    const binding = await harness.bind(harness.resolveStored({ instanceId: 'claude:busy', llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    const turn = harness.startTurn(spec(binding))
    await advance(MODEL_REFRESH_STARTUP_DELAY_MS + 50)
    expect(world.started).toEqual(['claude:on'])
    release()
    await turn.result
    await advance(MODEL_REFRESH_INTERVAL_MS)
    await advance(50)
    expect(world.started.sort()).toEqual(['claude:busy', 'claude:on', 'claude:on'])
  })

  it('runs two refreshes at a time and keeps one per instance', async () => {
    const ids = ['claude:a', 'claude:b', 'claude:c', 'claude:d']
    const world = newWorld(ids)
    let open!: () => void
    world.hold = new Promise<void>((resolve) => { open = resolve })
    const { harness, advance } = fixture(world, ids)
    harness.startModelRefreshSchedule()
    await advance(MODEL_REFRESH_STARTUP_DELAY_MS + 50)
    expect(world.started).toHaveLength(2)
    // The same instances asked for again (the page button, another pass) join what is queued.
    const all = harness.instances.refreshAllModels()
    await advance(50)
    expect(world.started).toHaveLength(2)
    open()
    const results = await all
    await advance(50)
    expect([...world.started].sort()).toEqual(ids)
    expect(world.peak).toBe(2)
    expect(results.map((result) => result.outcome)).toEqual(['refreshed', 'refreshed', 'refreshed', 'refreshed'])
  })

  it('refreshes an instance whose probe finds a different program, not one whose program is unchanged', async () => {
    const world = newWorld(['claude:a'])
    const { harness, binary, advance } = fixture(world, ['claude:a'])
    // The first check only learns the program.
    await harness.instances.recheck('claude:a')
    await advance(50)
    expect(world.started).toEqual([])
    await harness.instances.recheck('claude:a')
    await advance(50)
    expect(world.started).toEqual([])
    // A self-update writes a new program at the same path.
    writeFileSync(binary, 'agent v2, a little longer')
    await harness.instances.recheck('claude:a')
    await advance(50)
    expect(world.started).toEqual(['claude:a'])
  })

  it('stops with the gateway', async () => {
    const world = newWorld(['claude:a'])
    const { harness, advance } = fixture(world, ['claude:a'])
    harness.startModelRefreshSchedule()
    harness.stop()
    await advance(MODEL_REFRESH_STARTUP_DELAY_MS + MODEL_REFRESH_INTERVAL_MS)
    expect(world.started).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes its interval from the test-only variable, with the first pass no later than one interval', async () => {
    vi.stubEnv('MOUSSE_MODEL_REFRESH_INTERVAL_MS', '60000')
    const world = newWorld(['claude:a'])
    const { harness, advance } = fixture(world, ['claude:a'])
    harness.startModelRefreshSchedule()
    await advance(60_000 + 50)
    expect(world.started).toEqual(['claude:a'])
    await advance(60_000)
    await advance(50)
    expect(world.started).toEqual(['claude:a', 'claude:a'])
  })

  it('records a failed refresh on the instance and reports it per instance', async () => {
    const world = newWorld(['claude:a', 'claude:b'])
    world.failing.add('claude:b')
    const { harness } = fixture(world, ['claude:a', 'claude:b', 'claude:signedout'])
    const results = await harness.instances.refreshAllModels()
    expect(results.map((result) => [result.instanceId, result.outcome, result.message])).toEqual([
      ['claude:a', 'refreshed', undefined],
      ['claude:b', 'failed', 'the agent did not answer'],
      ['claude:signedout', 'skipped', 'Not signed in']
    ])
    expect(results[1]!.snapshot.models.error).toBe('the agent did not answer')
  })
})

describe('the model list keeps its refresh time on disk', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('writes the time next to the Claude Code models and reads it after a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-27T10:00:00.000Z'))
      const home = mkdtempSync(join(tmpdir(), 'mousse-claude-stamp-'))
      homes.push(home)
      const binary = join(home, 'claude')
      writeFileSync(binary, 'fixture')
      chmodSync(binary, 0o755)
      const directory = join(home, 'providers', 'claude-subscription')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary }))
      const query = () => Object.assign((async function* () {})(), {
        close: vi.fn(),
        interrupt: vi.fn(async () => {}),
        supportedModels: vi.fn(async () => [{ value: 'sonnet', displayName: 'Sonnet', description: 'model' }])
      }) as unknown as Query
      const make = () => new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
        query: (_input: { options: Options; prompt: unknown }) => query(),
        runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
        live: false,
        launchConfig: () => ({ binaryPath: binary })
      })
      const service = make()
      // The fallback aliases carry no time.
      expect(service.modelsRefreshedAt()).toBeUndefined()
      await service.refreshModels(home)
      expect(service.modelsRefreshedAt()).toBe('2026-10-27T10:00:00.000Z')
      expect(JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8')).modelsRefreshedAt).toBe('2026-10-27T10:00:00.000Z')
      expect(make().modelsRefreshedAt()).toBe('2026-10-27T10:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })
})
