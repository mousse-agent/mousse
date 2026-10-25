import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { RunStoreError } from '../../src/mms/run/db/RunStoreError'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import type { HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import { decodeInstanceConfig } from '../../src/mms/harness/driver'
import { instanceStateDir } from '../../src/mms/harness/instances'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'

const pi = (): PiLoopAdapter => new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))

const fake = (driver: ProviderDriverKind, configured = true): ProviderAdapter => ({
  driver,
  capabilities: pi().capabilities,
  configured: () => configured,
  startTurn: async () => { throw new Error('unused') },
  interrupt: async () => 'not_active'
})

/** An in-memory profile whose stored map is `stored`; `credentials` are the credentialed pi providers. */
const instances = (stored?: Record<string, unknown>, credentials: string[] = []) => {
  let value: unknown = stored
  return new ProviderInstanceService({
    store: { read: () => ({ instances: value, seedVersion: 1 }), write: (next) => { value = next.instances } },
    providerAuth: { credentials: { listProviderIds: () => credentials } }
  })
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-gateway-'))
  homes.push(dir)
  return dir
}

const full = (source = instances(), extra: { models?: Partial<Record<ProviderDriverKind, Array<{ id: string; label: string }>>> } = {}) => {
  const adapters = { pi: pi(), claude: fake('claude'), antigravity: fake('antigravity'), codex: fake('codex') }
  const drivers = Object.values(adapters).map((adapter) =>
    adapterDriver(adapter, { runtime: { models: () => extra.models?.[adapter.driver] ?? [] } }))
  const harness = testHarness({ drivers, instances: source, profileHome: home() })
  return { harness, adapters }
}

describe('harness gateway: resolution (absorbs AdapterRegistry)', () => {
  it('resolves each seeded instance to its driver', () => {
    const { harness } = full(instances(undefined, ['openai']))
    expect(harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'm' }, { purpose: 'turn' })).toMatchObject({ instanceId: 'claude', llmProvider: 'claude-subscription', driver: 'claude' })
    expect(harness.resolveStored({ instanceId: 'antigravity', llmProvider: '', model: 'm' }, { purpose: 'turn' })).toMatchObject({ llmProvider: 'antigravity', driver: 'antigravity' })
    expect(harness.resolveStored({ instanceId: 'codex', llmProvider: '', model: 'm' }, { purpose: 'turn' })).toMatchObject({ llmProvider: 'codex', driver: 'codex' })
    expect(harness.resolveStored({ instanceId: 'pi:openai', llmProvider: '', model: 'm' }, { purpose: 'turn' })).toMatchObject({ driver: 'pi', llmProvider: 'openai' })
    expect(harness.resolveStored({ instanceId: 'pi:anthropic', llmProvider: '', model: 'm' }, { purpose: 'turn' })).toMatchObject({ llmProvider: 'anthropic', driver: 'pi' })
  })

  it('routes older llmProvider selections through the legacy mapping', () => {
    const { harness } = full()
    expect(harness.resolveStored({ llmProvider: 'claude-subscription', model: 'm' }, { purpose: 'turn' }).instanceId).toBe('claude')
    expect(harness.resolveStored({ llmProvider: 'openai', model: 'm' }, { purpose: 'turn' }).instanceId).toBe('pi:openai')
    expect(harness.resolveStored({ instanceId: 'claude', llmProvider: 'openai', model: 'm' }, { purpose: 'turn' }).driver).toBe('claude')
  })

  it('rejects unknown and disabled instances by name; stopping still reaches a disabled one', () => {
    const { harness } = full(instances({ codex: { driver: 'codex', enabled: false } }))
    for (const id of ['whatever', 'claude-subscription', 'pi:not-a-provider', 'pi:'])
      expect(codeOf(() => harness.resolveStored({ instanceId: id, llmProvider: '', model: 'm' }, { purpose: 'turn' }))).toBe('provider_instance_unknown')
    expect(codeOf(() => harness.resolveStored({ instanceId: 'codex', llmProvider: '', model: 'm' }, { purpose: 'turn' }))).toBe('provider_instance_disabled')
    expect(harness.resolveStored({ instanceId: 'codex', llmProvider: '', model: 'm' }, { purpose: 'turn', allowDisabled: true }).driver).toBe('codex')
    // The public resolve() reports harness codes.
    expect(codeOf(() => harness.resolve({ instanceId: 'codex', model: 'm' }, { kind: 'device' }, 'composer'))).toBe('instance_disabled')
    expect(codeOf(() => harness.resolve({ instanceId: 'nope', model: 'm' }, { kind: 'device' }, 'composer'))).toBe('instance_unknown')
  })

  it('reports a driver without a runtime as a bad request', () => {
    const harness = testHarness({ adapters: [pi()], instances: instances(), profileHome: home() })
    let error: unknown
    try {
      harness.resolveStored({ instanceId: 'antigravity', llmProvider: '', model: 'm' }, { purpose: 'turn' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(RunStoreError)
    expect((error as RunStoreError).code).toBe('bad_request')
  })

  it('runs an unselected default that names nothing on the pi loop; a blank explicit override is rejected', () => {
    const { harness } = full()
    expect(harness.resolveStored({ llmProvider: '', model: '' }, { purpose: 'turn', unselectedDefault: true })).toMatchObject({ instanceId: 'pi', llmProvider: '', driver: 'pi' })
    expect(harness.resolveStored({ instanceId: 'pi', llmProvider: '', model: '' }, { purpose: 'turn', unselectedDefault: true }).driver).toBe('pi')
    for (const selection of [{ llmProvider: '' }, { instanceId: ' ', llmProvider: ' ' }, { instanceId: 'pi', llmProvider: '' }])
      expect(codeOf(() => harness.resolveStored({ ...selection, model: 'm' }, { purpose: 'turn' }))).toBe('provider_instance_unknown')
  })

  it('offers only enabled, signed-in vendor instances as configured providers', () => {
    const { harness } = full(instances({ antigravity: { driver: 'antigravity', enabled: false } }))
    expect(harness.configuredProviderIds()).toEqual(['claude-subscription', 'codex'])
    const signedOut = testHarness({ adapters: [pi(), fake('claude', false)], instances: instances(), profileHome: home() })
    expect(signedOut.configuredProviderIds()).toEqual([])
  })

  it('refuses a second driver of the same kind', () => {
    expect(() => testHarness({ adapters: [pi(), pi()], profileHome: home() })).toThrow(/already registered/)
  })

  it('keeps today\'s capability values and adds planMode and contextUsage', () => {
    const { harness } = full()
    expect(harness.resolveStored({ instanceId: 'pi:openai', llmProvider: '', model: 'm' }, { purpose: 'turn' }).caps).toMatchObject({ ...pi().capabilities, planMode: true, contextUsage: 'measured' })
  })
})

describe('harness gateway: scope and model prefs', () => {
  it('a project narrows the device setting and never lifts it', async () => {
    const profileHome = home()
    const source = instances({ codex: { driver: 'codex', enabled: false } })
    const adapters = [pi(), fake('claude'), fake('antigravity'), fake('codex')]
    const harness = testHarness({ adapters, instances: source, profileHome })
    const project = { kind: 'project' as const, projectId: 'p1' }

    const off = await harness.instances.setEnabled('claude', project, false)
    expect(off.enabled).toEqual({ device: true, project: false, effective: false, setBy: 'project' })
    expect(codeOf(() => harness.resolve({ instanceId: 'claude', model: 'm' }, project, 'composer'))).toBe('instance_disabled')
    // The device scope is unaffected.
    expect(harness.resolve({ instanceId: 'claude', model: 'm' }, { kind: 'device' }, 'composer').driver).toBe('claude')
    // Device off is a ceiling a project override cannot lift.
    const lifted = await harness.instances.setEnabled('codex', project, true)
    expect(lifted.enabled).toMatchObject({ device: false, project: true, effective: false, setBy: 'device' })

    // Persisted in <profileHome>/harness/scopes.json and read back by a new gateway.
    expect(JSON.parse(readFileSync(join(profileHome, 'harness', 'scopes.json'), 'utf8'))).toMatchObject({ version: 1, projects: { p1: { instances: { claude: { enabled: false } } } } })
    const again = testHarness({ adapters: [pi(), fake('claude'), fake('antigravity'), fake('codex')], instances: source, profileHome })
    expect(codeOf(() => again.resolve({ instanceId: 'claude', model: 'm' }, project, 'turn'))).toBe('instance_disabled')

    // Clearing the override follows the device again.
    expect((await harness.instances.setEnabled('claude', project, null)).enabled).toEqual({ device: true, effective: true, setBy: 'device' })
  })

  it('hidden models are rejected for every purpose and leave the pickers', async () => {
    const store: Record<string, unknown> = {}
    const { harness } = full(instances(undefined, []), { models: { claude: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] } })
    void store
    await harness.instances.setModelPrefs('claude', { hidden: ['opus'], order: ['sonnet'], favorites: ['sonnet'], custom: [{ id: 'opus-x', capabilities: { efforts: ['high'], images: true } }] })
    // Every effort representation of the hidden base: a suffix on the id, or the effort field.
    const representations = [
      { model: 'opus' },
      ...['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ model: `opus:${effort}` })),
      { model: 'opus', effort: 'high' }
    ]
    for (const purpose of ['composer', 'default', 'delegate_task', 'definition', 'workflow', 'channel_model', 'cli_model', 'turn'] as const)
      for (const selection of representations)
        expect(codeOf(() => harness.resolve({ instanceId: 'claude', ...selection }, { kind: 'device' }, purpose)), `${purpose} ${JSON.stringify(selection)}`).toBe('model_hidden')
    for (const selection of representations)
      expect(codeOf(() => harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: selection.model }, { purpose: 'turn' }))).toBe('model_hidden')
    // Another model at an effort still resolves; a colon that is not an effort is part of the id.
    expect(harness.resolve({ instanceId: 'claude', model: 'sonnet:high' }, { kind: 'device' }, 'turn').driver).toBe('claude')
    expect(harness.resolve({ instanceId: 'claude', model: 'opus:thinking' }, { kind: 'device' }, 'turn').driver).toBe('claude')
    // Stopping or reading running work still resolves it.
    expect(harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'opus' }, { purpose: 'turn', allowDisabled: true }).driver).toBe('claude')

    const models = harness.catalog.models('claude', { kind: 'device' })
    expect(models.map((model) => [model.id, model.hidden, model.favorite, model.source])).toEqual([
      ['sonnet', false, true, 'catalog'],
      ['opus', true, false, 'catalog'],
      ['opus-x', false, false, 'custom']
    ])
  })

  it('overlapping prefs saves keep each other: a reorder and stars edit the stored lists', async () => {
    const { harness } = full(instances(undefined, []), { models: { claude: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }] } })
    await harness.instances.setModelPrefs('claude', { star: ['opus'] })
    // Sent together from one view of the page: a reorder, then two stars and a hide.
    await Promise.all([
      harness.instances.setModelPrefs('claude', { order: ['haiku', 'sonnet', 'opus'] }),
      harness.instances.setModelPrefs('claude', { star: ['sonnet'] }),
      harness.instances.setModelPrefs('claude', { star: ['haiku'], unstar: ['opus'] }),
      harness.instances.setModelPrefs('claude', { hide: ['opus'] })
    ])
    const models = harness.catalog.models('claude', { kind: 'device' })
    expect(models.map((model) => [model.id, model.favorite, model.hidden])).toEqual([
      ['haiku', true, false],
      ['sonnet', true, false],
      ['opus', false, true]
    ])
    await harness.instances.setModelPrefs('claude', { unhide: ['opus'], unstar: ['haiku', 'sonnet'] })
    expect(harness.catalog.models('claude', { kind: 'device' }).filter((model) => model.favorite || model.hidden)).toEqual([])
  })
})

describe('harness gateway: instances', () => {
  it('adds a second instance with its own id, config and state directory, and removes it', async () => {
    const profileHome = home()
    let stored: unknown
    const source = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const claude = adapterDriver(fake('claude'))
    const multi = { ...claude, multiInstance: true, privateHome: true, decodeConfig: (raw: Record<string, unknown> | undefined) => decodeInstanceConfig(raw, { privateHome: true }) }
    const harness = testHarness({ drivers: [adapterDriver(pi()), multi], instances: source, profileHome })
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))

    const added = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    expect(added).toMatchObject({ instanceId: 'claude:work', driver: 'claude', displayName: 'Work', builtIn: false, config: { home: 'private', args: [], env: {} } })
    expect((stored as Record<string, unknown>)['claude:work']).toEqual({ driver: 'claude', enabled: true, config: { home: 'private', displayName: 'Work' } })
    expect(events.some((event) => event.type === 'snapshots')).toBe(true)
    // A second one with the same name gets its own id.
    expect((await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })).instanceId).toBe('claude:work-2')

    const configured = await harness.instances.configure('claude:work', { args: ['--verbose'], env: { A: '1' } })
    expect(configured.config).toMatchObject({ args: ['--verbose'], env: { A: '1' } })
    await expect(harness.bind(harness.resolveStored({ instanceId: 'claude:work', llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' }))
      .resolves.toMatchObject({ instanceId: 'claude:work', driver: 'claude', homeId: 'private:claude:work', configRevision: 1, accountGeneration: 0 })

    await expect(harness.instances.remove('claude')).rejects.toMatchObject({ code: 'unsupported' })
    // The private home and the sign-in in it go with the instance.
    const stateDir = instanceStateDir(profileHome, 'claude:work')
    mkdirSync(join(stateDir, 'home'), { recursive: true })
    writeFileSync(join(stateDir, 'home', '.claude.json'), '{"oauthAccount":{"accountUuid":"old"}}')
    await harness.instances.remove('claude:work')
    expect((stored as Record<string, unknown>)['claude:work']).toBeUndefined()
    expect(existsSync(stateDir)).toBe(false)
    expect(codeOf(() => harness.resolveStored({ instanceId: 'claude:work', llmProvider: '', model: 'm' }, { purpose: 'turn' }))).toBe('provider_instance_unknown')
    // Re-adding starts signed out in a fresh home.
    expect((await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })).instanceId).toBe('claude:work')
    expect(existsSync(join(stateDir, 'home', '.claude.json'))).toBe(false)
    // Files a removal could not delete are never reused: the new instance gets another id.
    mkdirSync(instanceStateDir(profileHome, 'claude:other'), { recursive: true })
    expect((await harness.instances.add({ driver: 'claude', config: { displayName: 'Other' } })).instanceId).toBe('claude:other-2')
  })

  it('removal waits for a turn still running on a runtime a reconfiguration replaced', async () => {
    const profileHome = home()
    let stored: unknown
    const source = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    let release: () => void = () => {}
    let entered = false
    const gated: ProviderAdapter = {
      ...fake('claude'),
      startTurn: async (input) => {
        entered = true
        await new Promise<void>((resolve) => { release = resolve })
        return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [] }
      }
    }
    const claude = adapterDriver(gated)
    const multi = { ...claude, multiInstance: true, privateHome: true, decodeConfig: (raw: Record<string, unknown> | undefined) => decodeInstanceConfig(raw, { privateHome: true }) }
    const harness = testHarness({ drivers: [adapterDriver(pi()), multi], instances: source, profileHome })
    const { instanceId } = await harness.instances.add({ driver: 'claude', config: { displayName: 'Work' } })
    const binding = await harness.bind(harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    const noop = () => {}
    const turn = harness.startTurn({
      binding,
      input: { runId: 'r', attemptId: 'a', threadId: 't', cwd: null, instanceId, model: 'm', llmProvider: 'claude-subscription', modelPinned: true, mode: 'agent', prompt: 'hi', messages: [], signal: new AbortController().signal },
      sink: { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop },
      control: { drainSteer: () => undefined, heartbeat: noop },
      host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } }
    })
    await vi.waitFor(() => expect(entered).toBe(true))
    const stateDir = instanceStateDir(profileHome, instanceId)
    // A new revision: the running turn keeps the old runtime, which the next use of the instance retires.
    await harness.instances.configure(instanceId, { env: { A: '1' } })
    await harness.instances.remove(instanceId)
    expect(existsSync(stateDir)).toBe(true)
    release()
    await turn.result
    expect(existsSync(stateDir)).toBe(false)
  })

  it('rejects a second instance of a single-instance driver', async () => {
    const { harness } = full()
    await expect(harness.instances.add({ driver: 'codex' })).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('keeps unknown stored records and fields untouched', async () => {
    let stored: unknown = { future: { driver: 'acp', enabled: true, config: { x: 1 } }, claude: { driver: 'claude', enabled: true, extra: 'kept' } }
    const source = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ adapters: [pi(), fake('claude')], instances: source, profileHome: home() })
    await harness.instances.setEnabled('claude', { kind: 'device' }, false)
    expect(stored).toMatchObject({ future: { driver: 'acp', enabled: true, config: { x: 1 } }, claude: { driver: 'claude', enabled: false, extra: 'kept' } })
  })

  it('runs sign-in as an operation: prompts as events, answered with respondSignIn', async () => {
    const claude = fake('claude')
    let answer: string | undefined
    const driver = adapterDriver(claude, {
      runtime: {
        signIn: async (session) => {
          answer = await session.createAuthCallbacks().prompt({ type: 'select', message: 'Run `claude auth login`, then check again.', options: [{ id: 'check', label: 'Check sign-in' }] })
          return { success: true }
        }
      }
    })
    const harness = testHarness({ drivers: [adapterDriver(pi()), driver], instances: instances(), profileHome: home() })
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))
    const started = await harness.instances.signIn('claude')
    expect(started).toMatchObject({ instanceId: 'claude', kind: 'sign_in' })
    await expect(harness.instances.signIn('claude')).rejects.toMatchObject({ code: 'operation_busy' })
    await waitFor(() => events.some((event) => event.type === 'operation' && event.data.phase === 'prompt'))
    const prompt = events.find((event) => event.type === 'operation' && event.data.phase === 'prompt')
    const promptId = prompt?.type === 'operation' && prompt.data.phase === 'prompt' ? prompt.data.prompt.promptId : ''
    expect(await harness.instances.respondSignIn(started.operationId, { promptId: 'wrong', kind: 'select', value: 'check' })).toBe(false)
    expect(await harness.instances.respondSignIn(started.operationId, { promptId, kind: 'select', value: 'check' })).toBe(true)
    await waitFor(() => events.some((event) => event.type === 'operation' && event.data.phase === 'completed'))
    expect(answer).toBe('check')
    expect(await harness.instances.respondSignIn(started.operationId, { kind: 'cancel' })).toBe(false)
  })

  it('accepts a pasted redirect URL from the browser-link prompt when the code prompt came first (and after a link retry)', async () => {
    let pasted: string | undefined
    const driver = adapterDriver(fake('antigravity'), {
      runtime: {
        // As Antigravity: the pasted-URL fallback waits before the agent prints its link, and the
        // link is printed again on a retry.
        signIn: async (session) => {
          const callback = session.waitForCallbackUrl()
          const notify = session.createAuthCallbacks().notify
          notify({ type: 'auth_url', url: 'https://accounts.example/auth?try=1' })
          notify({ type: 'auth_url', url: 'https://accounts.example/auth?try=2' })
          pasted = await callback
          return { success: pasted.includes('code=abc') }
        }
      }
    })
    const harness = testHarness({ drivers: [adapterDriver(pi()), driver], instances: instances(), profileHome: home() })
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))
    const started = await harness.instances.signIn('antigravity')
    const prompts = () => events.flatMap((event) => (event.type === 'operation' && event.data.phase === 'prompt' ? [event.data.prompt] : []))
    await waitFor(() => prompts().filter((prompt) => prompt.type === 'auth_url').length === 2)
    const [input, , retry] = prompts()
    expect(input.type).toBe('input')
    expect(retry).toMatchObject({ type: 'auth_url', url: 'https://accounts.example/auth?try=2', acceptsRedirectPaste: true })
    // A prompt of another operation's numbering is refused, and says so.
    expect(await harness.instances.respondSignIn(started.operationId, { promptId: 'other', kind: 'redirect_url', value: 'x' })).toBe(false)
    // The dialog answers the link it shows.
    expect(await harness.instances.respondSignIn(started.operationId, { promptId: retry.promptId, kind: 'redirect_url', value: 'http://localhost:1/cb?code=abc' })).toBe(true)
    await waitFor(() => events.some((event) => event.type === 'operation' && event.data.phase === 'completed'))
    expect(pasted).toBe('http://localhost:1/cb?code=abc')
    // Nothing waits any more.
    expect(await harness.instances.respondSignIn(started.operationId, { promptId: retry.promptId, kind: 'redirect_url', value: 'again' })).toBe(false)
  })

  it('runs install as an operation: an id at once, progress as events, cancel ends it', async () => {
    const antigravity = fake('antigravity')
    let release: (() => void) | undefined
    let cancelled = false
    const driver = adapterDriver(antigravity, {
      runtime: {
        install: (onProgress) => new Promise<void>((resolve, reject) => {
          onProgress('Downloading')
          release = () => (cancelled ? reject(new Error('Install cancelled')) : resolve())
        }),
        cancelInstall: () => {
          cancelled = true
          release?.()
          return true
        }
      }
    })
    const harness = testHarness({ drivers: [adapterDriver(pi()), adapterDriver(fake('claude')), driver], instances: instances(), profileHome: home() })
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))
    expect(await harness.instances.cancelInstall('no-such-operation')).toBe(false)
    const started = await harness.instances.install('antigravity')
    expect(started).toMatchObject({ instanceId: 'antigravity', kind: 'install' })
    await expect(harness.instances.install('antigravity')).rejects.toMatchObject({ code: 'operation_busy' })
    await waitFor(() => events.some((event) => event.type === 'operation' && event.data.phase === 'progress'))
    expect(await harness.instances.cancelInstall(started.operationId)).toBe(true)
    await waitFor(() => events.some((event) => event.type === 'operation' && event.data.phase === 'cancelled'))
    expect(await harness.instances.cancelInstall(started.operationId)).toBe(false)
    await expect(harness.instances.install('claude')).rejects.toMatchObject({ code: 'unsupported' })
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
