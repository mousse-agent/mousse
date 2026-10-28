import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeInstanceConfig, type HarnessDriver } from '../../src/mms/harness/driver'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { createHarnessGateway, type Harness, type TurnSpec } from '../../src/mms/harness/gateway'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { PiStubAdapter } from '../support/piStub'
import type { ProviderAdapter, TurnInput, TurnResult } from '../../src/mms/harness/adapter'
import type { ProviderRef } from '../../src/mms/run/types'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { readTranscript, ReplayTransport } from '../../src/mms/run/testkit/ReplayTransport'
import { replaySdkQuery } from '../../src/mms/run/testkit/sdkQueryReplay'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const noop = () => {}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function turnSpec(instanceId: string, binding: TurnSpec['binding'], options: { threadId: string; attemptId: string; cwd?: string | null; prompt?: string; previous?: TurnSpec['binding'] }): TurnSpec {
  return {
    binding,
    ...(options.previous ? { previous: options.previous } : {}),
    input: {
      runId: `run-${options.attemptId}`, attemptId: options.attemptId, threadId: options.threadId, cwd: options.cwd ?? null, instanceId,
      model: 'm', llmProvider: 'claude-subscription', modelPinned: true, mode: 'agent', prompt: options.prompt ?? 'hello',
      messages: [], nativeHistory: '', signal: new AbortController().signal
    },
    sink: {
      text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop,
      usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop
    },
    control: { drainSteer: () => undefined, heartbeat: noop },
    host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } }
  }
}

const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code)

// -- A fake agent on a harness -------------------------------------------------------------------

const piCapabilities = new PiStubAdapter().capabilities

interface Script {
  /** The inputs the adapter was started with. */
  started: TurnInput[]
  interrupts: ProviderRef[]
  stopThreads: string[]
}

/** An adapter that waits at a gate inside `startTurn`, before or after it publishes its session ref. */
function gatedAdapter(gate: Promise<void>, options: { refBeforeGate?: boolean; script?: Script; stopGate?: Promise<void> } = {}): { adapter: ProviderAdapter; script: Script } {
  const script = options.script ?? { started: [], interrupts: [], stopThreads: [] }
  const adapter: ProviderAdapter = {
    driver: 'claude',
    capabilities: piCapabilities,
    configured: () => true,
    startTurn: async (input, sink): Promise<TurnResult> => {
      script.started.push(input)
      const providerRef: ProviderRef = { provider: 'claude-subscription', instanceId: input.instanceId, model: input.model }
      if (options.refBeforeGate) sink.providerRef(providerRef)
      await gate
      if (!options.refBeforeGate) sink.providerRef(providerRef)
      return {
        text: 'ok', aborted: input.signal.aborted, modelName: input.model, totalResponseTimeMs: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef
      }
    },
    interrupt: async (ref) => {
      script.interrupts.push(ref)
      return 'interrupted'
    },
    stopThread: async (threadId) => {
      script.stopThreads.push(threadId)
      await options.stopGate
      return 'stopped'
    }
  }
  return { adapter, script }
}

/** A driver of added (private-home) instances; each runtime gets the adapter `make` builds. */
function multiDriver(make: () => ProviderAdapter): HarnessDriver {
  const base = adapterDriver(make())
  return {
    ...base,
    multiInstance: true,
    privateHome: true,
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: true }),
    create: (context) => ({ ...base.create(context), adapter: make() })
  }
}

function fakeHarness(make: () => ProviderAdapter, extraDrivers: HarnessDriver[] = []) {
  const profileHome = tempDir('mousse-stop-')
  let stored: unknown
  let seedVersion: number | undefined
  const source = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion }), write: (next) => { stored = next.instances; seedVersion = next.seedVersion } } })
  const pi = adapterDriver(new PiStubAdapter())
  const harness = testHarness({ drivers: [pi, multiDriver(make), ...extraDrivers], instances: source, profileHome })
  const notices: Array<{ threadId: string; text: string }> = []
  harness.setLiveHost({ notice: (threadId, text) => { notices.push({ threadId, text }) } })
  return { harness, profileHome, notices }
}

async function startOn(harness: Harness, instanceId: string, options: { threadId: string; attemptId: string; previous?: TurnSpec['binding'] }) {
  const binding = await harness.bind(harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
  return { binding, turn: harness.startTurn(turnSpec(instanceId, binding, options)) }
}

describe('stopping chats when an instance is removed or turned off', () => {
  it('removing stops a running turn with the runtime\'s stop and interrupt, tells the thread, and ends it with the typed error', async () => {
    const gate = deferred()
    const { adapter, script } = gatedAdapter(gate.promise, { refBeforeGate: true })
    const { harness, notices } = fakeHarness(() => adapter)
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const { turn } = await startOn(harness, instanceId, { threadId: 'thread-1', attemptId: 'a1' })
    await vi.waitFor(() => expect(script.started).toHaveLength(1))

    await harness.instances.remove(instanceId)
    await vi.waitFor(() => expect(script.stopThreads).toEqual(['thread-1']))
    await vi.waitFor(() => expect(script.interrupts).toHaveLength(1))
    // The adapter sees the abort the gateway added to the turn's own signal.
    expect(script.started[0]!.signal.aborted).toBe(true)
    gate.resolve()
    expect(await codeOf(turn.result)).toBe('instance_unknown')
    expect(notices).toEqual([{ threadId: 'thread-1', text: 'Work was removed from Mousse; this chat was stopped. Choose another model to continue.' }])
    harness.stop()
  })

  it('removing during admission fails the attempt and never reaches the adapter', async () => {
    const identity = deferred<string | undefined>()
    let gateIdentity = false
    const { adapter, script } = gatedAdapter(Promise.resolve())
    const base = multiDriver(() => adapter)
    const driver: HarnessDriver = {
      ...base,
      create: (context) => ({ ...base.create(context), identity: () => (gateIdentity ? identity.promise : Promise.resolve(undefined)) })
    }
    const profileHome = tempDir('mousse-stop-')
    let stored: unknown
    let seedVersion: number | undefined
    const source = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion }), write: (next) => { stored = next.instances; seedVersion = next.seedVersion } } })
    const pi = adapterDriver(new PiStubAdapter())
    const harness = testHarness({ drivers: [pi, driver], instances: source, profileHome })
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    // The first dispatch of a binding uses the account `bind` read; a second one reads it again, which is held here.
    const first = await startOn(harness, instanceId, { threadId: 'thread-1', attemptId: 'a1' })
    await first.turn.result
    expect(script.started).toHaveLength(1)
    gateIdentity = true
    const second = harness.startTurn(turnSpec(instanceId, first.binding, { threadId: 'thread-1', attemptId: 'a2' }))
    await sleep(20)
    await harness.instances.remove(instanceId)
    identity.resolve(undefined)
    expect(await codeOf(second.result)).toBe('instance_unknown')
    expect(script.started).toHaveLength(1)
    harness.stop()
  })

  it('a turn gated after dispatch but before it published a session is aborted, and the session is interrupted when it appears', async () => {
    const gate = deferred()
    const { adapter, script } = gatedAdapter(gate.promise)
    const { harness } = fakeHarness(() => adapter)
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const { turn } = await startOn(harness, instanceId, { threadId: 'thread-1', attemptId: 'a1' })
    await vi.waitFor(() => expect(script.started).toHaveLength(1))

    await harness.instances.setEnabled(instanceId, { kind: 'device' }, false)
    expect(script.started[0]!.signal.aborted).toBe(true)
    expect(script.interrupts).toEqual([])
    gate.resolve()
    expect(await codeOf(turn.result)).toBe('instance_disabled')
    expect(script.interrupts).toEqual([{ provider: 'claude-subscription', instanceId, model: 'm' }])
    harness.stop()
  })

  it('stops a turn on a runtime a reconfiguration replaced, as well as on the current one', async () => {
    const gate = deferred()
    const scripts: Script[] = []
    const { harness, notices } = fakeHarness(() => {
      const made = gatedAdapter(gate.promise, { refBeforeGate: true })
      scripts.push(made.script)
      return made.adapter
    })
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const { turn } = await startOn(harness, instanceId, { threadId: 'thread-1', attemptId: 'a1' })
    await vi.waitFor(() => expect(scripts.some((script) => script.started.length === 1)).toBe(true))
    // A new revision: the turn keeps its runtime, which is retired once the instance is used next.
    await harness.instances.configure(instanceId, { env: { A: '1' } })
    await harness.instances.remove(instanceId)

    const old = scripts.find((script) => script.started.length === 1)!
    await vi.waitFor(() => expect(old.stopThreads).toEqual(['thread-1']))
    gate.resolve()
    expect(await codeOf(turn.result)).toBe('instance_unknown')
    expect(notices).toHaveLength(1)
    harness.stop()
  })

  it('turning off on the device stops running turns; turning off for one project only refuses new ones', async () => {
    const gate = deferred()
    const { adapter, script } = gatedAdapter(gate.promise, { refBeforeGate: true })
    const { harness, notices } = fakeHarness(() => adapter)
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const running = await startOn(harness, instanceId, { threadId: 'thread-1', attemptId: 'a1' })
    await vi.waitFor(() => expect(script.started).toHaveLength(1))

    await harness.instances.setEnabled(instanceId, { kind: 'project', projectId: 'p1' }, false)
    await sleep(20)
    expect(script.stopThreads).toEqual([])
    expect(script.started[0]!.signal.aborted).toBe(false)

    await harness.instances.setEnabled(instanceId, { kind: 'device' }, false)
    await vi.waitFor(() => expect(script.stopThreads).toEqual(['thread-1']))
    gate.resolve()
    expect(await codeOf(running.turn.result)).toBe('instance_disabled')
    expect(notices.map((notice) => notice.text)).toEqual(['Work was turned off on this device; this chat was stopped. Choose another model to continue.'])
    harness.stop()
  })

  it('turn off, turn on: a new turn is admitted, and the old one stays cancelled', async () => {
    const gate = deferred()
    const { adapter, script } = gatedAdapter(gate.promise, { refBeforeGate: true })
    const { harness } = fakeHarness(() => adapter)
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const old = await startOn(harness, instanceId, { threadId: 'thread-1', attemptId: 'a1' })
    await vi.waitFor(() => expect(script.started).toHaveLength(1))

    await harness.instances.setEnabled(instanceId, { kind: 'device' }, false)
    await harness.instances.setEnabled(instanceId, { kind: 'device' }, true)
    const fresh = await startOn(harness, instanceId, { threadId: 'thread-2', attemptId: 'a2' })
    await vi.waitFor(() => expect(script.started).toHaveLength(2))
    gate.resolve()
    expect(await codeOf(old.turn.result)).toBe('instance_disabled')
    await expect(fresh.turn.result).resolves.toMatchObject({ aborted: false, text: 'ok' })
    expect(script.started[1]!.signal.aborted).toBe(false)
    harness.stop()
  })

  it('a stop still draining holds back new turns after the runtime was replaced and the old turn finished', async () => {
    const gate = deferred()
    const stopGate = deferred()
    const scripts: Script[] = []
    const { harness } = fakeHarness(() => {
      const made = gatedAdapter(gate.promise, { refBeforeGate: true, stopGate: stopGate.promise })
      scripts.push(made.script)
      return made.adapter
    })
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const old = await startOn(harness, instanceId, { threadId: 'thread-1', attemptId: 'a1' })
    await vi.waitFor(() => expect(scripts.some((script) => script.started.length === 1)).toBe(true))
    const first = scripts.find((script) => script.started.length === 1)!

    await harness.instances.setEnabled(instanceId, { kind: 'device' }, false)
    await vi.waitFor(() => expect(first.stopThreads).toEqual(['thread-1']))
    // The old attempt ends while its stop is still held, then a setting change replaces the runtime.
    gate.resolve()
    expect(await codeOf(old.turn.result)).toBe('instance_disabled')
    await harness.instances.configure(instanceId, { env: { A: '1' } })
    await harness.instances.setEnabled(instanceId, { kind: 'device' }, true)

    const fresh = await startOn(harness, instanceId, { threadId: 'thread-2', attemptId: 'a2' })
    const next = scripts.at(-1)!
    expect(next).not.toBe(first)
    let settled = false
    void fresh.turn.result.then(() => { settled = true }, () => { settled = true })
    await sleep(50)
    expect(next.started).toHaveLength(0)
    expect(settled).toBe(false)

    stopGate.resolve()
    await expect(fresh.turn.result).resolves.toMatchObject({ aborted: false, text: 'ok' })
    expect(next.started[0]!.signal.aborted).toBe(false)
    harness.stop()
  })

  it('a stop on a replaced runtime that is still finishing a turn holds back new turns too', async () => {
    const gate = deferred()
    const stopGate = deferred()
    const scripts: Script[] = []
    const { harness } = fakeHarness(() => {
      const made = gatedAdapter(gate.promise, { refBeforeGate: true, stopGate: stopGate.promise })
      scripts.push(made.script)
      return made.adapter
    })
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const old = await startOn(harness, instanceId, { threadId: 'thread-1', attemptId: 'a1' })
    void old.turn.result.catch(noop)
    await vi.waitFor(() => expect(scripts.some((script) => script.started.length === 1)).toBe(true))
    const first = scripts.find((script) => script.started.length === 1)!
    await harness.instances.configure(instanceId, { env: { A: '1' } })
    // Using the instance again builds the new runtime and retires the one still running a1.
    const binding = await harness.bind(harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    const next = scripts.at(-1)!
    expect(next).not.toBe(first)

    await harness.instances.setEnabled(instanceId, { kind: 'device' }, false)
    await vi.waitFor(() => expect(first.stopThreads).toEqual(['thread-1']))
    await harness.instances.setEnabled(instanceId, { kind: 'device' }, true)
    const fresh = harness.startTurn(turnSpec(instanceId, binding, { threadId: 'thread-2', attemptId: 'a2' }))
    await sleep(50)
    expect(next.started).toHaveLength(0)

    stopGate.resolve()
    gate.resolve()
    await expect(fresh.result).resolves.toMatchObject({ aborted: false, text: 'ok' })
    harness.stop()
  })

  it('a turn started while the instance is off is refused until it is turned on again', async () => {
    const { adapter, script } = gatedAdapter(Promise.resolve())
    const { harness } = fakeHarness(() => adapter)
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const binding = await harness.bind(harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    await harness.instances.setEnabled(instanceId, { kind: 'device' }, false)
    expect(await codeOf(harness.startTurn(turnSpec(instanceId, binding, { threadId: 'thread-1', attemptId: 'a1' })).result)).toBe('instance_disabled')
    expect(script.started).toHaveLength(0)
    await harness.instances.setEnabled(instanceId, { kind: 'device' }, true)
    await expect(harness.startTurn(turnSpec(instanceId, binding, { threadId: 'thread-1', attemptId: 'a2' })).result).resolves.toMatchObject({ text: 'ok' })
    harness.stop()
  })

  it('removal keeps the home and its sign-in files and deletes the rest; an instance with an empty or no home loses its whole directory', async () => {
    const { adapter } = gatedAdapter(Promise.resolve())
    const { harness, profileHome } = fakeHarness(() => adapter)
    const work = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const plain = await harness.instances.add({ driver: 'claude', config: { displayName: 'Plain' } })
    const bare = await harness.instances.add({ driver: 'claude', config: { displayName: 'Bare' } })
    const workDir = instanceStateDir(profileHome, work.instanceId)
    const plainDir = instanceStateDir(profileHome, plain.instanceId)
    const bareDir = instanceStateDir(profileHome, bare.instanceId)
    rmSync(join(bareDir, 'home'), { recursive: true, force: true })
    writeFileSync(join(bareDir, 'acp.json'), '{}')
    mkdirSync(join(workDir, 'home', 'nested'), { recursive: true })
    writeFileSync(join(workDir, 'home', '.credentials.json'), '{"token":"sentinel"}')
    writeFileSync(join(workDir, 'home', 'auth.json'), '{"token":"sentinel"}')
    writeFileSync(join(workDir, 'home', 'nested', 'x'), 'x')
    writeFileSync(join(workDir, 'acp.json'), '{}')
    writeFileSync(join(workDir, 'settings.json'), '{}')
    mkdirSync(join(workDir, 'sessions'), { recursive: true })
    writeFileSync(join(plainDir, 'acp.json'), '{}')
    mkdirSync(join(plainDir, 'home'), { recursive: true })

    await harness.instances.remove(work.instanceId)
    await harness.instances.remove(plain.instanceId)
    await harness.instances.remove(bare.instanceId)
    expect(readdirSync(workDir).sort()).toEqual(['home'])
    expect(readdirSync(join(workDir, 'home')).sort()).toEqual(['.credentials.json', 'auth.json', 'nested'])
    expect(existsSync(plainDir)).toBe(false)
    expect(existsSync(bareDir)).toBe(false)
    // Re-adding the same name never reuses the kept directory.
    expect((await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })).instanceId).toBe('claude:work-2')
    harness.stop()
  })

  it('a home that cannot be listed is kept, like any other home, and the rest of the state still goes', async () => {
    const { adapter } = gatedAdapter(Promise.resolve())
    const { harness, profileHome } = fakeHarness(() => adapter)
    const warn = vi.spyOn(console, 'warn').mockImplementation(noop)
    try {
      const work = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
      const dir = instanceStateDir(profileHome, work.instanceId)
      // A file where the home directory should be: listing it fails with an error other than "missing".
      rmSync(join(dir, 'home'), { recursive: true, force: true })
      writeFileSync(join(dir, 'home'), 'sentinel sign-in')
      writeFileSync(join(dir, 'settings.json'), '{}')

      await harness.instances.remove(work.instanceId)
      expect(readdirSync(dir).sort()).toEqual(['home'])
      expect(readdirSync(dir, { withFileTypes: true })[0]!.isFile()).toBe(true)
      expect(warn).toHaveBeenCalledWith('[harness] could not delete the files of a removed instance', expect.objectContaining({ instanceId: work.instanceId }))
    } finally {
      warn.mockRestore()
      harness.stop()
    }
  })

  it('after a removal, the thread continues on another instance with its history handed over', async () => {
    const { adapter } = gatedAdapter(Promise.resolve())
    const forgotten: string[] = []
    const codex = adapterDriver({ ...gatedAdapter(Promise.resolve()).adapter, driver: 'codex' }, { runtime: { forgetConversation: (threadId) => { forgotten.push(threadId) } } })
    const { harness } = fakeHarness(() => adapter, [codex])
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const before = await startOn(harness, instanceId, { threadId: 'thread-1', attemptId: 'a1' })
    await before.turn.result

    await harness.instances.remove(instanceId)
    expect(forgotten).toEqual([])
    const next = await startOn(harness, 'codex', { threadId: 'thread-1', attemptId: 'a2', previous: before.binding })
    await next.turn.result
    expect(forgotten).toEqual(['thread-1'])
    harness.stop()
  })
})

// -- The real Claude adapter and service -----------------------------------------------------------

/** A `claude` whose `--version` prints a version (a node script; an npm-style shim on Windows). */
function fakeClaude(): string {
  const dir = tempDir('mousse-fakeclaude-')
  mkdirSync(join(dir, 'node_modules', 'claude'), { recursive: true })
  const script = join(dir, 'node_modules', 'claude', 'cli.js')
  writeFileSync(join(dir, 'node_modules', 'claude', 'package.json'), JSON.stringify({ name: 'claude' }))
  writeFileSync(script, `#!/usr/bin/env node\nconsole.log('2.1.300 (Claude Code)')\n`)
  if (process.platform === 'win32') {
    const shim = join(dir, 'claude.cmd')
    writeFileSync(shim, `@ECHO off\r\n"%~dp0\\node_modules\\claude\\cli.js" %*\r\n`)
    return shim
  }
  chmodSync(script, 0o755)
  return script
}

/**
 * A harness whose added `claude:work` runs the real Claude adapter and service. `gate` holds every
 * integration resolution (after the adapter published its provider ref, before any query);
 * `query` stands for the SDK, and `stopThread` replaces the service's own stop.
 */
function claudeRig(options: {
  gate?: Promise<void>
  query?: (input: { options: { resume?: string; tools?: unknown[] } }) => unknown
  stopThread?: (threadId: string) => Promise<'stopped' | 'not_active'>
} = {}) {
  const profileHome = tempDir('mousse-stop-claude-')
  const binary = fakeClaude()
  const questions = new UserQuestionService()
  const privateHome = join(instanceStateDir(profileHome, 'claude:work'), 'home')
  mkdirSync(privateHome, { recursive: true })
  writeFileSync(join(privateHome, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'user-a', organizationUuid: 'org-1' } }))
  const turnQueries: unknown[] = []
  let resolves = 0
  let sessions = 0
  const query = (input: { options: { resume?: string; tools?: unknown[] } }) => {
    // Model discovery (no tools, no prompt) is not a turn.
    if (Array.isArray(input.options.tools) && !input.options.tools.length)
      return Object.assign((async function* () {})(), { close: () => {}, interrupt: async () => {}, supportedModels: async () => [] })
    turnQueries.push(input)
    if (options.query) return options.query(input)
    const sessionId = input.options.resume ?? `session-${++sessions}`
    return Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: sessionId }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId }
    })(), { close: () => {}, interrupt: async () => {} })
  }
  const stored: unknown = { 'claude:work': { driver: 'claude', enabled: true, config: { home: 'private', displayName: 'Work', binaryPath: binary } } }
  let current = stored
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: current, seedVersion: 1 }), write: (next) => { current = next.instances } } })
  const services: ClaudeSubscriptionProviderService[] = []
  const stopCalls: string[] = []
  const harness = createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap: instances,
    questions,
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      claudeCodeDriver({
        integrations: () => ({
          resolve: async () => {
            resolves += 1
            await options.gate
            return { mcpServers: {}, proxiedServers: {}, env: {}, toolRules: {}, warnings: [] }
          }
        }),
        createService: (context, serviceOptions) => {
          const service = new ClaudeSubscriptionProviderService(context.profileHome, questions, {
            ...serviceOptions,
            live: false,
            runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
            query: query as never
          })
          if (options.stopThread) {
            vi.spyOn(service, 'stopThread').mockImplementation(((threadId: string) => {
              stopCalls.push(threadId)
              return options.stopThread!(threadId)
            }) as never)
          }
          services.push(service)
          return service
        }
      })
    ]
  })
  const notices: Array<{ threadId: string; text: string }> = []
  harness.setLiveHost({ notice: (threadId, text) => { notices.push({ threadId, text }) } })
  const cwd = tempDir('mousse-cwd-')
  return {
    harness,
    notices,
    services,
    stopCalls,
    turnQueries,
    resolves: () => resolves,
    /** A turn of `claude:work` in a project folder (the real service needs one), under Full access as recorded. */
    startWithCwd: async (threadId: string, attemptId: string, prompt?: string) => {
      const binding = await harness.bind(harness.resolveStored({ instanceId: 'claude:work', llmProvider: '', model: 'sonnet' }, { purpose: 'turn' }), { mode: 'agent', permissionMode: 'full' })
      const spec = turnSpec('claude:work', binding, { threadId, attemptId, cwd, ...(prompt ? { prompt } : {}) })
      return harness.startTurn({ ...spec, input: { ...spec.input, model: 'sonnet', permissionMode: 'full' } })
    },
    stop: () => {
      harness.stop()
      for (const service of services) service.stop()
    }
  }
}

describe('stopping chats on the real Claude adapter', () => {
  it('removing mid-stream ends the turn through its abort, asks the service to stop the thread, tells the thread, and settles the result', async () => {
    const transcript = readTranscript(join(__dirname, '..', 'run', 'fixtures', 'stop-mid-stream', 'claude-subscription.ndjson'))
    let rig: ReturnType<typeof claudeRig>
    const transport = new ReplayTransport(transcript, { onCue: async () => { await rig.harness.instances.remove('claude:work') } })
    rig = claudeRig({ query: replaySdkQuery(transport) as never, stopThread: async () => 'not_active' })
    try {
      const turn = await rig.startWithCwd('thread-1', 'a1', 'Write a long essay')
      expect(await codeOf(turn.result)).toBe('instance_unknown')
      transport.assertDone()
      await vi.waitFor(() => expect(rig.stopCalls).toEqual(['thread-1']))
      expect(rig.notices).toEqual([{ threadId: 'thread-1', text: expect.stringContaining('Work was removed from Mousse; this chat was stopped.') }])
    } finally {
      rig.stop()
    }
  }, 30_000)

  it.each([
    ['remove', 'instance_unknown', 'was removed from Mousse'],
    ['turn off', 'instance_disabled', 'was turned off on this device']
  ] as const)('%s while the turn awaits its integrations: releasing them never starts a query', async (how, code, text) => {
    const gate = deferred()
    const rig = claudeRig({ gate: gate.promise })
    try {
      const turn = await rig.startWithCwd('thread-1', 'a1')
      await vi.waitFor(() => expect(rig.resolves()).toBe(1))
      if (how === 'remove') await rig.harness.instances.remove('claude:work')
      else await rig.harness.instances.setEnabled('claude:work', { kind: 'device' }, false)
      gate.resolve()
      expect(await codeOf(turn.result)).toBe(code)
      expect(rig.turnQueries).toHaveLength(0)
      expect(rig.notices).toEqual([{ threadId: 'thread-1', text: expect.stringContaining(text) }])
    } finally {
      rig.stop()
    }
  }, 30_000)

  it('turning on again while a stop is still draining: the old turn stays cancelled and a new turn waits for the stop', async () => {
    const gate = deferred()
    const stop = deferred<'stopped'>()
    const rig = claudeRig({ gate: gate.promise, stopThread: () => stop.promise })
    try {
      const old = await rig.startWithCwd('thread-a', 'a1')
      await vi.waitFor(() => expect(rig.resolves()).toBe(1))

      await rig.harness.instances.setEnabled('claude:work', { kind: 'device' }, false)
      await vi.waitFor(() => expect(rig.stopCalls).toEqual(['thread-a']))
      // The service's stop is still pending when the instance is turned on again.
      await rig.harness.instances.setEnabled('claude:work', { kind: 'device' }, true)

      gate.resolve()
      expect(await codeOf(old.result)).toBe('instance_disabled')
      expect(rig.turnQueries).toHaveLength(0)

      const fresh = await rig.startWithCwd('thread-b', 'a2')
      let settled = false
      void fresh.result.then(() => { settled = true }, () => { settled = true })
      await sleep(50)
      expect(rig.resolves()).toBe(1)
      expect(settled).toBe(false)
      expect(rig.turnQueries).toHaveLength(0)

      stop.resolve('stopped')
      await expect(fresh.result).resolves.toMatchObject({ aborted: false, text: 'ok' })
      expect(rig.resolves()).toBe(2)
      expect(rig.turnQueries).toHaveLength(1)
      // The turn off told the stopped thread once, and the new thread nothing.
      expect(rig.notices.map((notice) => notice.threadId)).toEqual(['thread-a'])
    } finally {
      rig.stop()
    }
  }, 30_000)
})
