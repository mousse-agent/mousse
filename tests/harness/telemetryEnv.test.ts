/**
 * Each connection's agent telemetry (Settings → Providers): Off by default where Mousse set the agent
 * up, the agent's own setting on the user's own CLI until they flip it, set last over the
 * connection's launch variables, and a change reaches the next process while a running turn keeps
 * its own.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeInstanceConfig, type DriverContext, type HarnessDriver } from '../../src/mms/harness/driver'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import { grokDriver } from '../../src/mms/harness/drivers/grok'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway } from '../../src/mms/harness/gateway'
import { instanceEnv } from '../../src/mms/harness/env'
import { observeHarnessSpawns, runHarness, type HarnessSpawn } from '../../src/mms/harness/spawn'
import { telemetryEnforced, telemetryView } from '../../src/mms/harness/telemetry'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { asInstanceConfigPatch } from '../../src/mms/protocol/validators'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { PiStubAdapter } from '../support/piStub'

const CLAUDE_OFF = { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
const CODEX_OFF = ['-c', 'analytics.enabled=false']

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

describe('what each connection gets', () => {
  const unused = () => { throw new Error('unused') }
  const claude = claudeCodeDriver({ builtIn: unused })
  const codex = codexDriver({ builtIn: unused })
  const pi = piDriver()

  it('agents Mousse set up are Off by default: a private Claude home, the Mousse agent, managed Codex', () => {
    expect(telemetryEnforced(claude, { home: 'private' }, '/profile/harness/claude_work/home')).toEqual({ env: CLAUDE_OFF })
    expect(telemetryEnforced(pi, { home: 'default' }, '/profile/harness/pi_openrouter/home')).toEqual({ env: { PI_TELEMETRY: '0' } })
    expect(telemetryEnforced(codex, { home: 'private', setup: 'managed' }, '/profile/harness/codex_managed/home')).toEqual({ args: CODEX_OFF })
    expect(telemetryView(claude, { home: 'private' }, '/home')).toEqual({ setting: 'off', defaultSetting: 'off', variables: ['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'], docsUrl: 'https://code.claude.com/docs/en/data-usage' })
  })

  it('the user\'s own CLIs keep their own setting until the user flips it', () => {
    expect(telemetryEnforced(claude, { home: 'default' }, undefined)).toBeUndefined()
    expect(telemetryEnforced(codex, { home: 'default' }, undefined)).toBeUndefined()
    expect(telemetryView(codex, { home: 'default' }, undefined)).toEqual({ setting: 'agent_setting', defaultSetting: 'agent_setting', args: CODEX_OFF })
    // Flipped to Off: only through what Mousse launches.
    expect(telemetryEnforced(claude, { home: 'default', telemetry: 'off' }, undefined)).toEqual({ env: CLAUDE_OFF })
    expect(telemetryEnforced(codex, { home: 'default', telemetry: 'off' }, undefined)).toEqual({ args: CODEX_OFF })
  })

  it('agents Mousse set up can be given back to their own setting', () => {
    expect(telemetryEnforced(pi, { home: 'default', telemetry: 'agent_setting' }, '/home')).toBeUndefined()
    expect(telemetryEnforced(codex, { home: 'private', setup: 'managed', telemetry: 'agent_setting' }, '/home')).toBeUndefined()
    expect(telemetryView(pi, { home: 'default', telemetry: 'agent_setting' }, '/home')).toEqual({ setting: 'agent_setting', defaultSetting: 'off', variables: ['PI_TELEMETRY'] })
  })

  it('an agent with no documented switch says so and gets nothing', () => {
    for (const driver of [grokDriver(), cursorDriver(), acpDriver()] as HarnessDriver[]) {
      expect(telemetryView(driver, { home: 'private', telemetry: 'off' }, '/home'), driver.kind).toEqual({ setting: 'none' })
      expect(telemetryEnforced(driver, { home: 'private', telemetry: 'off' }, '/home'), driver.kind).toBeUndefined()
    }
  })

  it('the setting is stored per connection and checked at the protocol', () => {
    expect(decodeInstanceConfig({ telemetry: 'off' }, { privateHome: false })).toMatchObject({ telemetry: 'off' })
    expect(decodeInstanceConfig({ telemetry: 'on' }, { privateHome: false }).telemetry).toBeUndefined()
    expect(asInstanceConfigPatch({ telemetry: 'agent_setting' })).toEqual({ telemetry: 'agent_setting' })
    expect(() => asInstanceConfigPatch({ telemetry: 'on' })).toThrow(/telemetry/)
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
  it('Off wins over the connection\'s own variables; the user\'s own Claude Code is unchanged until flipped; flipping back leaves them as written', async () => {
    const profileHome = tempDir('mousse-tel-claude-')
    const questions = new UserQuestionService()
    const seen: Record<string, NodeJS.ProcessEnv> = {}
    const runAuth = (instance: string) => async (_binary: string, _args: string[], env: NodeJS.ProcessEnv) => {
      seen[instance] = env
      return JSON.stringify({ loggedIn: true, orgId: `org-${instance}` })
    }
    // As the profile wires its built-in service: the switch comes from the gateway.
    const builtIn: ClaudeSubscriptionProviderService = new ClaudeSubscriptionProviderService(profileHome, questions, {
      findBinary: () => process.execPath,
      runAuth: runAuth('claude'),
      launchConfig: () => harness.launchFor('claude'),
      telemetryEnv: () => harness.enforcedFor('claude').env
    })
    const harness = createHarnessGateway({
      profileHome,
      installationHome: profileHome,
      instanceMap: store({
        // Its executable set, so the check never looks for a Claude Code installed on this machine.
        claude: { driver: 'claude', enabled: true, config: { binaryPath: process.execPath, env: { DISABLE_TELEMETRY: '0' } } },
        'claude:work': { driver: 'claude', enabled: true, config: { home: 'private', displayName: 'Work', binaryPath: process.execPath, env: { DISABLE_TELEMETRY: '0', KEEP: 'yes' } } }
      }),
      questions,
      shellPath: async () => ({ entries: [], source: 'failed' }),
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
      const own = await harness.instances.recheck('claude')
      expect(seen['claude:work']).toMatchObject({ ...CLAUDE_OFF, KEEP: 'yes' })
      expect(work.telemetry).toMatchObject({ setting: 'off', defaultSetting: 'off' })
      // The user's own Claude Code: exactly its own variables.
      expect(seen.claude?.DISABLE_TELEMETRY).toBe('0')
      expect(seen.claude?.DISABLE_ERROR_REPORTING).toBeUndefined()
      expect(own.telemetry).toMatchObject({ setting: 'agent_setting', defaultSetting: 'agent_setting' })

      // The user flips their own Claude Code to Off: the next process has the switch, over their variable.
      expect((await harness.instances.configure('claude', { telemetry: 'off' })).telemetry).toMatchObject({ setting: 'off' })
      await harness.instances.recheck('claude')
      expect(seen.claude).toMatchObject(CLAUDE_OFF)

      // The private entry back to the agent's own setting: its variables as written.
      await harness.instances.configure('claude:work', { telemetry: 'agent_setting' })
      await harness.instances.recheck('claude:work')
      expect(seen['claude:work']).toMatchObject({ DISABLE_TELEMETRY: '0', KEEP: 'yes' })
      expect(seen['claude:work']?.DISABLE_ERROR_REPORTING).toBeUndefined()
    } finally {
      harness.stop()
    }
  })
})

describe('a warm connection toggled off → own setting → off', () => {
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
      telemetryOff: piDriver().telemetryOff,
      decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
      create: (context) => {
        const runtime = { enforced: context.env.enforced, stopped: false }
        runtimes.push(runtime)
        return { ...base.create(context), stop: () => { runtime.stopped = true } }
      }
    }
    const noSwitch = adapterDriver({ ...new PiStubAdapter(), driver: 'grok' } as ProviderAdapter)
    const harness = testHarness({ drivers: [driver, noSwitch], instances: store({ 'pi:openrouter': { driver: 'pi', enabled: true }, grok: { driver: 'grok', enabled: true } }), profileHome: tempDir('mousse-tel-pi-') })
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

      // Off → the agent's own setting while the turn runs: a new runtime without the variable; the old one waits for its turn.
      await harness.instances.configure(instanceId, { telemetry: 'agent_setting' })
      await vi.waitFor(() => expect(runtimes).toHaveLength(2))
      expect(runtimes[1]!.enforced).toBeUndefined()
      expect(runtimes[0]!.stopped).toBe(false)
      release()
      await first.result
      await vi.waitFor(() => expect(runtimes[0]!.stopped).toBe(true))

      // → Off again: the next one has it.
      const second = await turn()
      await vi.waitFor(() => expect(entered).toBe(2))
      await harness.instances.configure(instanceId, { telemetry: 'off' })
      await vi.waitFor(() => expect(runtimes).toHaveLength(3))
      expect(runtimes[2]!.enforced).toEqual({ PI_TELEMETRY: '0' })
      expect(runtimes[1]!.stopped).toBe(false)
      release()
      await second.result
      await vi.waitFor(() => expect(runtimes[1]!.stopped).toBe(true))

      // An agent without a switch refuses the setting.
      await expect(harness.instances.configure('grok', { telemetry: 'off' })).rejects.toMatchObject({ code: 'unsupported' })
    } finally {
      harness.stop()
    }
  })
})
