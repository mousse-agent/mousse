/**
 * Privacy → Agent telemetry (plan PR 5 §6): set last on the processes of the agents Mousse sets up,
 * never on the user's own setup, nothing with `agent_default`, and a change reaches the next process
 * while a running turn keeps its own.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentTelemetrySetting } from '../../src/shared/settings'
import { decodeInstanceConfig, type DriverContext, type HarnessDriver } from '../../src/mms/harness/driver'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import { grokDriver } from '../../src/mms/harness/drivers/grok'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway } from '../../src/mms/harness/gateway'
import { instanceEnv } from '../../src/mms/harness/env'
import { observeHarnessSpawns, runHarness, type HarnessSpawn } from '../../src/mms/harness/spawn'
import { ownsSetup, telemetryEnforced, telemetryView } from '../../src/mms/harness/telemetry'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { PiStubAdapter } from '../support/piStub'

const CLAUDE_OFF = { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function store(initial: Record<string, unknown>): ProviderInstanceService {
  let stored: unknown = initial
  return new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
}

describe('which setups the switch applies to', () => {
  const claude = claudeCodeDriver({ builtIn: () => { throw new Error('unused') } })
  const pi = piDriver()
  const codex = codexDriver({ builtIn: () => { throw new Error('unused') } })

  it('a private Claude home and the Pi runtime get their documented variables when off', () => {
    expect(telemetryEnforced(claude, { home: 'private' }, '/profile/harness/claude_work/home', 'off')).toEqual(CLAUDE_OFF)
    // Pi always runs in its Mousse-owned agent dir, and it is a runtime Mousse ships.
    expect(telemetryEnforced(pi, { home: 'default' }, '/profile/harness/pi_openrouter/home', 'off')).toEqual({ PI_TELEMETRY: '0' })
    expect(telemetryEnforced(pi, { home: 'default' }, undefined, 'off')).toEqual({ PI_TELEMETRY: '0' })
  })

  it('the user\'s own Claude Code gets nothing, in both settings', () => {
    for (const setting of ['off', 'agent_default'] as AgentTelemetrySetting[]) expect(telemetryEnforced(claude, { home: 'default' }, undefined, setting)).toBeUndefined()
    expect(telemetryView(claude, { home: 'default' }, undefined, 'off')).toEqual({ state: 'own_settings', agent: 'Claude Code', docsUrl: 'https://code.claude.com/docs/en/data-usage' })
  })

  it('agent_default sets nothing anywhere', () => {
    expect(telemetryEnforced(claude, { home: 'private' }, '/home', 'agent_default')).toBeUndefined()
    expect(telemetryEnforced(pi, { home: 'default' }, '/home', 'agent_default')).toBeUndefined()
    expect(telemetryView(pi, { home: 'default' }, '/home', 'agent_default')).toEqual({ state: 'agent_default', agent: 'Mousse agent' })
  })

  it('an agent with no documented switch gets nothing, even where Mousse owns the setup (managed Codex, Grok, Cursor)', () => {
    expect(ownsSetup(codex, { home: 'default', setup: 'managed' }, undefined)).toBe(true)
    expect(telemetryEnforced(codex, { home: 'default', setup: 'managed' }, '/home', 'off')).toBeUndefined()
    for (const driver of [codex, grokDriver(), cursorDriver()] as HarnessDriver[])
      expect(telemetryView(driver, { home: 'private' }, '/home', 'off'), driver.kind).toMatchObject({ state: 'no_switch' })
  })

  it('a registry or managed agent with the user\'s own executable in its place is the user\'s setup', () => {
    expect(ownsSetup(codex, { home: 'default', setup: 'managed', binaryPath: '/usr/bin/codex' }, undefined)).toBe(false)
    expect(ownsSetup(codex, { home: 'default', setup: 'existing' }, undefined)).toBe(false)
  })
})

describe('spawnHarness', () => {
  it('sets the enforced variables last, over the instance\'s and the caller\'s, in any spelling', async () => {
    const env = instanceEnv({ instanceId: 'pi:x', driver: 'pi', configRevision: 0, home: tempDir('mousse-tel-'), searchPath: [], base: { PATH: process.env.PATH ?? '', pi_telemetry: '1' }, enforced: { PI_TELEMETRY: '0' } })
    const spawns: HarnessSpawn[] = []
    const stop = observeHarnessSpawns((spawned) => spawns.push(spawned))
    try {
      await runHarness(env, 'version', process.execPath, ['-e', ''], { timeoutMs: 20_000, extraEnv: { PI_TELEMETRY: '1' } })
    } finally {
      stop()
    }
    expect(spawns).toHaveLength(1)
    expect(Object.entries(spawns[0]!.env).filter(([name]) => name.toUpperCase() === 'PI_TELEMETRY')).toEqual([['PI_TELEMETRY', '0']])
  })
})

describe('Claude Code', () => {
  it('a private home runs with telemetry off over its own launch variables, the user\'s own never; agent_default leaves them as written', async () => {
    const profileHome = tempDir('mousse-tel-claude-')
    const questions = new UserQuestionService()
    const seen: Record<string, NodeJS.ProcessEnv> = {}
    const runAuth = (instance: string) => async (_binary: string, _args: string[], env: NodeJS.ProcessEnv) => {
      seen[instance] = env
      return JSON.stringify({ loggedIn: true, orgId: `org-${instance}` })
    }
    const builtIn = new ClaudeSubscriptionProviderService(profileHome, questions, { findBinary: () => process.execPath, runAuth: runAuth('claude') })
    let setting: AgentTelemetrySetting = 'off'
    const harness = createHarnessGateway({
      profileHome,
      installationHome: profileHome,
      instanceMap: store({
        claude: { driver: 'claude', enabled: true },
        'claude:work': { driver: 'claude', enabled: true, config: { home: 'private', displayName: 'Work', binaryPath: process.execPath, env: { DISABLE_TELEMETRY: '0', KEEP: 'yes' } } }
      }),
      questions,
      shellPath: async () => ({ entries: [], source: 'failed' }),
      agentTelemetry: () => setting,
      drivers: [
        piDriver(),
        claudeCodeDriver({
          builtIn: () => builtIn,
          pty: { available: () => false },
          createService: (context, options) => new ClaudeSubscriptionProviderService(context.profileHome, questions, { ...options, runAuth: runAuth(context.instanceId) })
        })
      ]
    })
    try {
      const work = await harness.instances.recheck('claude:work')
      await harness.instances.recheck('claude')
      expect(seen['claude:work']).toMatchObject({ ...CLAUDE_OFF, KEEP: 'yes' })
      expect(seen.claude?.DISABLE_TELEMETRY).toBeUndefined()
      expect(seen.claude?.DISABLE_ERROR_REPORTING).toBeUndefined()
      // The editor marks the launch variable the switch overrides.
      expect(work.telemetry).toEqual({ state: 'off', agent: 'Claude Code', variables: ['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'], docsUrl: 'https://code.claude.com/docs/en/data-usage' })
      expect(work.config?.env).toMatchObject({ DISABLE_TELEMETRY: '0' })

      setting = 'agent_default'
      harness.privacyChanged()
      const after = await harness.instances.recheck('claude:work')
      await harness.instances.recheck('claude')
      expect(seen['claude:work']).toMatchObject({ DISABLE_TELEMETRY: '0', KEEP: 'yes' })
      expect(seen['claude:work']?.DISABLE_ERROR_REPORTING).toBeUndefined()
      expect(seen.claude?.DISABLE_TELEMETRY).toBeUndefined()
      expect(after.telemetry).toMatchObject({ state: 'agent_default' })
      expect((await harness.instances.recheck('claude')).telemetry).toMatchObject({ state: 'own_settings' })
    } finally {
      harness.stop()
    }
  })
})

describe('a warm Pi instance toggled off → default → off', () => {
  it('each next process gets the matching variables, and the old runtime stops only after its turn ends', async () => {
    let release: () => void = () => {}
    let entered = 0
    const gated: ProviderAdapter = {
      ...new PiStubAdapter(),
      driver: 'pi',
      capabilities: new PiStubAdapter().capabilities,
      configured: () => true,
      startTurn: async (input) => {
        entered += 1
        await new Promise<void>((resolve) => { release = resolve })
        return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [] }
      },
      interrupt: async () => 'not_active'
    }
    const runtimes: Array<{ enforced: DriverContext['env']['enforced']; stopped: boolean }> = []
    const base = adapterDriver(gated)
    const driver: HarnessDriver = {
      ...base,
      alwaysPrivateHome: true,
      telemetryEnv: piDriver().telemetryEnv,
      decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
      create: (context) => {
        const runtime = { enforced: context.env.enforced, stopped: false }
        runtimes.push(runtime)
        return { ...base.create(context), stop: () => { runtime.stopped = true } }
      }
    }
    let setting: AgentTelemetrySetting = 'off'
    const harness = testHarness({ drivers: [driver], instances: store({ 'pi:openrouter': { driver: 'pi', enabled: true } }), profileHome: tempDir('mousse-tel-pi-'), agentTelemetry: () => setting })
    const instanceId = 'pi:openrouter'
    const noop = () => {}
    const turn = async () => {
      const binding = await harness.bind(harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
      return harness.startTurn({
        binding,
        input: { runId: `r${entered}`, attemptId: `a${entered}`, threadId: 't', cwd: null, instanceId, model: 'm', llmProvider: 'openrouter', modelPinned: true, mode: 'agent', prompt: 'hi', messages: [], signal: new AbortController().signal },
        sink: { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop },
        control: { drainSteer: () => undefined, heartbeat: noop },
        host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } }
      })
    }
    try {
      const first = await turn()
      await vi.waitFor(() => expect(entered).toBe(1))
      expect(runtimes.map((runtime) => runtime.enforced)).toEqual([{ PI_TELEMETRY: '0' }])

      // Off → default while the turn runs: a new runtime without the variable; the old one waits for its turn.
      setting = 'agent_default'
      harness.privacyChanged()
      expect(runtimes.map((runtime) => runtime.enforced)).toEqual([{ PI_TELEMETRY: '0' }, undefined])
      expect(runtimes[0]!.stopped).toBe(false)
      release()
      await first.result
      await vi.waitFor(() => expect(runtimes[0]!.stopped).toBe(true))

      // Default → off: the next one has it again. A change that changes nothing builds nothing.
      const second = await turn()
      await vi.waitFor(() => expect(entered).toBe(2))
      setting = 'off'
      harness.privacyChanged()
      harness.privacyChanged()
      expect(runtimes.map((runtime) => runtime.enforced)).toEqual([{ PI_TELEMETRY: '0' }, undefined, { PI_TELEMETRY: '0' }])
      expect(runtimes[1]!.stopped).toBe(false)
      release()
      await second.result
      await vi.waitFor(() => expect(runtimes[1]!.stopped).toBe(true))
      expect(runtimes[2]!.stopped).toBe(false)
    } finally {
      harness.stop()
    }
  })
})
