import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatGptAuth } from '../../src/mms/harness/chatgpt/chatgptAuth'
import { ChatGptTokenBroker } from '../../src/mms/harness/codex/broker'
import type { CodexInstallation } from '../../src/mms/harness/codex/installation'
import { createManagedCodexRuntime } from '../../src/mms/harness/codex/managedRuntime'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { PI_RETIRED, piDriver } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway, type Harness, type ResolvePurpose, type TurnSpec } from '../../src/mms/harness/gateway'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { LoginSession } from '../../src/mms/providers/LoginSession'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { rewriteMovedDefaults } from '../../src/mms/settings/movedDefaults'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import type { ProviderAdapter, TurnResult } from '../../src/mms/run/adapters/ProviderAdapter'
import { CODEX_CAPABILITIES } from '../../src/mms/run/adapters/codex/CodexAdapter'
import { adapterDriver } from '../../src/mms/run/testkit/harness'
import { FOLDED_INTO_AGENT } from '../../src/shared/harness/move'
import { describeStatus } from '../../src/shared/harness/status'
import { pickerProviders } from '../../src/renderer/lib/providerSnapshots'
import { FakeIssuer, plainCodec } from './chatgpt/fakeIssuer'
import { signIn } from './chatgpt/signInFlow'

/**
 * PR 4 §11: an upgrade with unmoved `pi:openai-codex` and `pi:cursor` entries
 * (`fixtures/pr4-retired-pi/`: dummy credentials, a pinned thread, the default and title model on
 * the entry, a definition whose ref names it). Every request leaves through `fetch`, which records
 * it here and fails; only the fake ChatGPT sign-in service on 127.0.0.1 answers, and only during a
 * move. Nothing runs on a retired entry, nothing reads or refreshes its sign-in, its chats stay, and
 * Move (a fresh sign-in, or the copied API key) re-points everything and deletes the old sign-in.
 */

const FIXTURE = join(__dirname, 'fixtures', 'pr4-retired-pi')
const read = (name: string) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Record<string, any>
const device = { kind: 'device' } as const
const MANAGED = 'codex:managed'
const CURSOR = 'cursor'
const RETIRED_TITLE = 'Retired by this update'
const noop = () => {}

/** Every request any code makes: none may leave for a real host, and a retired entry makes none. */
let requests: string[] = []
let allowLoopback = false
let realFetch: typeof fetch
let issuer: FakeIssuer
let broker: ChatGptTokenBroker
const cleanups: Array<() => unknown> = []

beforeEach(async () => {
  requests = []
  allowLoopback = false
  realFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    requests.push(url.href)
    if (allowLoopback && url.hostname === '127.0.0.1') return realFetch(input, init)
    return Promise.reject(new Error(`Test tried to reach ${url.host}`))
  })
  issuer = await new FakeIssuer().start()
  issuer.onModels = () => ({ status: 200, body: { models: [{ slug: read('thread.json').modelOverride.model, visibility: 'list' }] } })
  broker = new ChatGptTokenBroker()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await broker.close()
  await issuer.stop()
  vi.unstubAllGlobals()
})

/** The Cursor agent, signed in only once it took a key. */
class CursorAgent implements ProviderAdapter {
  readonly driver = 'cursor' as const
  readonly capabilities = CODEX_CAPABILITIES
  async startTurn(): Promise<TurnResult> {
    throw new Error('no turn runs in this test')
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

interface UpgradeOptions {
  /** The stored ChatGPT sign-in expired before the upgrade (a refresh would be due). */
  expired?: boolean
  /** The Cursor agent: signed out in Mousse before, unable to run even with a key, or its install broken. */
  cursor?: { signedOutInMousse?: boolean; runs?: boolean; broken?: boolean; holdAdoption?: Promise<void> }
  /** Custom models the user added under the ChatGPT entry before the upgrade. */
  custom?: boolean
}

/** The fixture's profile after the upgrade: the real credential store and pi driver, fake agents. */
async function upgraded(options: UpgradeOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-pr4-retired-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  cpSync(FIXTURE, home, { recursive: true })
  if (options.expired) {
    const auth = read('auth.json')
    auth['openai-codex'].expires = 1_000
    writeFileSync(join(home, 'auth.json'), JSON.stringify(auth, null, 2))
  }
  const authBefore = readFileSync(join(home, 'auth.json'), 'utf8')
  const providerAuth = new ProviderAuthService(join(home, 'auth.json'))
  cleanups.push(() => providerAuth.stop())
  await providerAuth.init()
  await providerAuth.refreshDynamicModels()

  let instances: Record<string, unknown> = {
    ...read('instances.json').instances,
    [MANAGED]: { driver: 'codex', enabled: true, config: { setup: 'managed', home: 'private' } },
    [CURSOR]: { driver: 'cursor', enabled: true, ...(options.cursor?.signedOutInMousse ? { config: { signedOutInMousse: true } } : {}) }
  }
  // As the profile builds it: pi entries are listed from the real credential service.
  const instanceMap = new ProviderInstanceService({ providerAuth, store: { read: () => ({ instances, seedVersion: 1 }), write: (next) => { instances = next.instances } } })
  // The profile's settings (the real store): the default and the title model name the old entry.
  const settings = new SettingsStore(MousseConfigStore.load(home))
  settings.set(read('settings.json'))
  const holder: { auth?: ChatGptAuth } = {}
  const installation = {
    installed: () => ({ path: join(FIXTURE, 'auth.json'), version: '0.162.1' }),
    acquire: () => () => {},
    unsupportedMessage: () => undefined,
    installing: () => false,
    cancel: () => false
  } as unknown as CodexInstallation
  const adopted: string[] = []
  let adopting = 0
  const chats: unknown[] = []
  let prefsStored: Record<string, unknown> = options.custom
    ? { 'pi:openai-codex': { hidden: [], order: [], favorites: [], custom: [{ id: 'gpt-custom', label: 'My GPT', capabilities: { efforts: [], images: false } }] } }
    : {}
  const harness: Harness = createHarnessGateway({
    profileHome: home,
    installationHome: home,
    instanceMap,
    questions: new UserQuestionService(),
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      piDriver({
        // The legacy loop: nothing may reach it on a retired entry.
        client: () => ({ chat: async (...args: unknown[]) => void chats.push(args) }) as never,
        credentials: () => providerAuth
      }),
      codexDriver({
        builtIn: () => {
          throw new Error('the user’s own Codex is not part of this profile')
        },
        managed: (context) =>
          createManagedCodexRuntime(context, {
            installation,
            broker,
            auth: (auth) => (holder.auth = new ChatGptAuth({ ...auth, endpoints: issuer.endpoints, codec: plainCodec }))
          })
      }),
      adapterDriver(new CursorAgent(), {
        runtime: {
          configured: () => options.cursor?.runs !== false && adopted.length > 0,
          models: () => [{ id: 'composer-1', label: 'Composer 1' }],
          auth: async () => (adopted.length ? { state: 'signed_in', methodLabel: 'API key' } : { state: 'signed_out' }),
          // The real agent checks the key with Cursor before it saves it: a test may hold that reply.
          adoptApiKey: async (key: string) => {
            adopting += 1
            await options.cursor?.holdAdoption
            adopted.push(key)
          },
          signOut: async () => void adopted.splice(0),
          ...(options.cursor?.broken ? { managed: () => ({ path: join(home, 'cursor-host'), broken: 'host.js' }) as never } : {})
        }
      })
    ],
    // Model preferences stored before the upgrade.
    prefs: { read: () => prefsStored, write: (next) => void (prefsStored = next) },
    // What the profile itself rewrites on a Move (as `MmsProfileServices` wires it).
    defaults: {
      rewrite: (from, to) => {
        const { patch, rewritten } = rewriteMovedDefaults(settings.get(), from, to)
        if (patch) settings.set(patch)
        return rewritten
      }
    }
  })
  cleanups.push(() => harness.stop())
  return {
    home,
    harness,
    providerAuth,
    holder,
    adopted,
    chats,
    stored: () => instances,
    prefs: () => prefsStored,
    moveWaiting: () => adopting > 0,
    settings: () => settings.get(),
    authFile: () => JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')) as Record<string, any>,
    authUnchanged: () => readFileSync(join(home, 'auth.json'), 'utf8') === authBefore
  }
}

type Profile = Awaited<ReturnType<typeof upgraded>>

async function settledSnapshots(profile: Profile) {
  await profile.harness.instances.snapshots(device)
  await profile.harness.instances.recheck('pi:openai-codex')
  await profile.harness.instances.recheck('pi:cursor')
  return profile.harness.instances.snapshots(device)
}

function refusal(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

function turnSpec(binding: TurnSpec['binding']): TurnSpec {
  const pinned = read('thread.json')
  return {
    binding,
    input: {
      runId: 'run-1', attemptId: 'attempt-1', threadId: pinned.id, cwd: null, instanceId: binding.instanceId, model: binding.model,
      llmProvider: 'openai-codex', modelPinned: true, mode: 'agent', prompt: 'Keep going',
      messages: pinned.messages, nativeHistory: '', signal: new AbortController().signal
    },
    sink: { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop },
    control: { drainSteer: () => undefined, heartbeat: noop },
    host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } }
  }
}

describe('retired legacy-only Pi connections', () => {
  it('the table is the agents table for every retired provider', () => {
    for (const [providerId, retired] of Object.entries(PI_RETIRED)) expect(FOLDED_INTO_AGENT[providerId]).toBe(retired.moveTo)
    expect(Object.keys(PI_RETIRED).sort()).toEqual(['cursor', 'openai-codex'])
  })

  it.each([false, true])('startup, the providers page and the usage page make no request (sign-in expired: %s)', async (expired) => {
    const profile = await upgraded({ expired })
    const snapshots = await settledSnapshots(profile)
    for (const [instanceId, target] of [['pi:openai-codex', 'ChatGPT subscription'], ['pi:cursor', 'Cursor']] as const) {
      const snapshot = snapshots.find((entry) => entry.instanceId === instanceId)!
      // The record and its sign-in as stored; nothing runs, and Move is the next step.
      expect(snapshot).toMatchObject({ driver: 'pi', enabled: { device: true }, auth: { state: 'signed_in' }, runs: { state: 'no' } })
      expect(snapshot.nextStep).toEqual({ action: 'move', label: 'Move', title: RETIRED_TITLE, detail: `Move to ${target} to keep chatting. Your chats stay.` })
      expect(describeStatus(snapshot)).toMatchObject({ headline: RETIRED_TITLE, tone: 'warning', nextStep: { action: 'move' } })
      // The composer reads the snapshot's models: a retired entry offers none.
      expect(snapshot.models.entries).toEqual([])
    }
    // Nor do the pickers that read the pi listings (composer, defaults, channels, settings).
    const offered = profile.harness.instanceMap.llmProviders().map((option) => option.instanceId)
    expect(offered).not.toContain('pi:openai-codex')
    expect(offered).not.toContain('pi:cursor')
    expect(profile.providerAuth.getConfiguredLlmProviders().map((option) => option.id)).toEqual([])
    expect(profile.providerAuth.getCatalogLlmProviders().map((option) => option.id)).not.toContain('openai-codex')
    // Settings still lists the entry (it is configured, and has a Move).
    expect(profile.harness.instanceMap.configuredProviders().map((option) => option.instanceId)).toContain('pi:openai-codex')
    // Refreshing models leaves a retired entry alone.
    const refreshed = await profile.harness.instances.refreshAllModels()
    expect(refreshed.filter((entry) => entry.instanceId.startsWith('pi:')).map((entry) => [entry.instanceId, entry.outcome, entry.message])).toEqual([
      ['pi:openai-codex', 'skipped', 'Retired by this update'],
      ['pi:cursor', 'skipped', 'Retired by this update']
    ])
    // The usage page lists the entry without a meter.
    const usage = await profile.providerAuth.getUsage()
    expect(usage.providers.find((entry) => entry.id === 'openai-codex')).toMatchObject({ status: 'unavailable', windows: [] })
    expect(await profile.providerAuth.getSubscriptionUsage('openai-codex')).toBeUndefined()
    expect(profile.providerAuth.getLoginOptions().filter((option) => option.id in PI_RETIRED)).toEqual([])
    expect(requests).toEqual([])
    expect(profile.authUnchanged()).toBe(true)
  })

  it.each([false, true])('a turn, a title, a definition and a schedule are refused provider_retired with no request (sign-in expired: %s)', async (expired) => {
    const profile = await upgraded({ expired })
    const { harness } = profile
    const pinned = read('thread.json').modelOverride
    const purposes: ResolvePurpose[] = ['composer', 'default', 'turn', 'title', 'definition', 'workflow', 'schedule', 'channel_model', 'delegate_task']
    for (const purpose of purposes)
      expect(refusal(() => harness.resolveStored(pinned, { purpose })), purpose).toMatchObject({
        code: 'provider_retired',
        // It says where to go: a channel has no Move button.
        message: 'ChatGPT was retired by a Mousse update. Move it to ChatGPT subscription in Settings → Providers to keep chatting. Your chats stay.'
      })
    expect(refusal(() => harness.resolve({ instanceId: 'pi:cursor', model: 'composer-1' }, device, 'turn'))).toMatchObject({ code: 'provider_retired' })
    // Selections from before instances (a provider name only) read retired, never unknown.
    for (const llmProvider of ['openai-codex', 'cursor'])
      expect(refusal(() => harness.resolveStored({ llmProvider, model: 'm' }, { purpose: 'turn' })), llmProvider).toMatchObject({ code: 'provider_retired' })
    // The definition's ref and the title model name the entry too.
    expect(refusal(() => harness.resolveStored(read('definition.json').ref, { purpose: 'definition' }))).toMatchObject({ code: 'provider_retired' })
    await expect(harness.oneShot({ selection: read('settings.json').title, purpose: 'title', system: 's', prompt: 'p', maxChars: 40 })).rejects.toMatchObject({ code: 'provider_retired' })
    // A binding made before the upgrade (a retried or recovered attempt) does not run either.
    const binding = await harness.bind(harness.resolveStored(pinned, { purpose: 'turn', allowDisabled: true }), { mode: 'agent' })
    await expect(harness.startTurn(turnSpec(binding)).result).rejects.toMatchObject({ code: 'provider_retired' })
    expect(profile.chats).toEqual([])
    // Asked directly, the credential store resolves no auth for it: no token is read or refreshed.
    const model = profile.providerAuth.models.getModels('openai-codex')[0]!
    expect(await profile.providerAuth.models.getAuth(model)).toBeUndefined()
    expect(requests).toEqual([])
    expect(profile.authUnchanged()).toBe(true)
  })

  it('turned off, or with a binding signed out in Mousse, the refusal still points to Move', async () => {
    const profile = await upgraded()
    const { harness } = profile
    const pinned = read('thread.json').modelOverride
    const binding = await harness.bind(harness.resolveStored(pinned, { purpose: 'turn', allowDisabled: true }), { mode: 'agent' })
    harness.instanceMap.setEntry('pi:openai-codex', { driver: 'pi', enabled: false, config: { displayName: 'ChatGPT', signedOutInMousse: true } })
    expect(refusal(() => harness.resolveStored(pinned, { purpose: 'turn' }))).toMatchObject({ code: 'provider_retired' })
    await expect(harness.startTurn(turnSpec(binding)).result).rejects.toMatchObject({ code: 'provider_retired' })
    expect(profile.chats).toEqual([])
  })

  it('offers no sign-in: the gateway and the credential service (the protocol and CLI path) refuse it, and the stored sign-in stays', async () => {
    const profile = await upgraded()
    await expect(profile.harness.instances.signIn('pi:openai-codex', 'api_key')).rejects.toMatchObject({ code: 'provider_retired' })
    await expect(profile.harness.instances.signIn('pi:cursor', 'api_key')).rejects.toMatchObject({ code: 'provider_retired' })
    expect(await profile.providerAuth.runApiKeyLogin(new LoginSession('retired-key'), 'openai-codex')).toMatchObject({ success: false, error: expect.stringContaining('Move it to ChatGPT subscription') })
    expect(await profile.providerAuth.runOAuthLogin(new LoginSession('retired-oauth'), 'openai-codex')).toMatchObject({ success: false })
    await expect(profile.providerAuth.setApiKey('cursor', 'typed-key')).rejects.toThrow('Move it to Cursor')
    expect(profile.authUnchanged()).toBe(true)
    expect(requests).toEqual([])
  })

  it('keeps the history and lets running work be read or stopped', async () => {
    const profile = await upgraded()
    // Reading or stopping work (`allowDisabled`) still finds the entry.
    expect(profile.harness.resolveStored(read('thread.json').modelOverride, { purpose: 'turn', allowDisabled: true })).toMatchObject({ instanceId: 'pi:openai-codex', driver: 'pi' })
    // The thread's messages are its own; the upgrade changes nothing in the profile's files.
    expect(JSON.parse(readFileSync(join(profile.home, 'thread.json'), 'utf8'))).toEqual(read('thread.json'))
    expect(profile.stored()['pi:openai-codex']).toEqual(read('instances.json').instances['pi:openai-codex'])
    expect(profile.providerAuth.has('openai-codex')).toBe(true)
    // The model pickers offer nothing on a retired entry.
    const offered = profile.harness.instanceMap.llmProviders().map((option) => option.instanceId)
    expect(offered).not.toContain('pi:openai-codex')
    expect(offered).not.toContain('pi:cursor')
    expect(requests).toEqual([])
  })

  it('Move after a fresh ChatGPT sign-in re-points the default, the title model and the pinned chat, and deletes the old sign-in', async () => {
    const profile = await upgraded({ expired: true })
    await profile.harness.instances.snapshots(device)
    await vi.waitFor(() => {
      if (!profile.holder.auth) throw new Error('the entry has no sign-in yet')
    })
    allowLoopback = true
    await signIn(issuer, profile.holder.auth!, { subject: 'alice', email: 'a@example.com' })
    await profile.harness.instances.recheck(MANAGED)
    await vi.waitFor(() => {
      if (!profile.harness.catalog.models(MANAGED, device).length) throw new Error('models not listed yet')
    })

    const result = await profile.harness.instances.move('pi:openai-codex', MANAGED)
    expect(result).toMatchObject({ from: 'pi:openai-codex', to: MANAGED, oldSignIn: 'removed', rewritten: ['Default model', 'Chat titles: Automatic'] })
    const model = read('thread.json').modelOverride.model
    // The default follows the entry; the title model becomes Automatic (Codex cannot name chats).
    expect(profile.settings().provider).toMatchObject({ instanceId: MANAGED, model })
    expect(profile.settings().title).toMatchObject({ llmProvider: '', model: '' })
    expect(profile.settings().title.instanceId ?? '').toBe('')
    expect(profile.stored()['pi:openai-codex']).toEqual({ driver: 'pi', enabled: false, config: { displayName: 'ChatGPT', movedTo: MANAGED } })
    expect(profile.authFile()['openai-codex']).toBeUndefined()
    // The pinned chat and the definition continue on the agent.
    expect(profile.harness.resolveStored(read('thread.json').modelOverride, { purpose: 'turn' })).toMatchObject({ instanceId: MANAGED, driver: 'codex', movedFrom: 'pi:openai-codex' })
    expect(profile.harness.resolveStored(read('definition.json').ref, { purpose: 'turn' })).toMatchObject({ instanceId: MANAGED })
    // The moved entry has no prompt left, and nothing but the fake sign-in service was reached.
    const snapshot = (await profile.harness.instances.snapshots(device)).find((entry) => entry.instanceId === 'pi:openai-codex')!
    expect(snapshot.nextStep).toBeUndefined()
    expect(requests.every((url) => new URL(url).hostname === '127.0.0.1')).toBe(true)
  })

  it('Move of the retired Cursor key copies it to the Cursor agent and deletes the old one', async () => {
    const profile = await upgraded()
    // Without the key copied and with the agent not signed in, nothing moves.
    await expect(profile.harness.instances.move('pi:cursor', CURSOR)).rejects.toMatchObject({ code: 'signed_out' })
    expect(profile.authFile().cursor).toBeDefined()
    const result = await profile.harness.instances.move('pi:cursor', CURSOR, { copyKey: true })
    expect(result).toMatchObject({ from: 'pi:cursor', to: CURSOR, oldSignIn: 'removed' })
    expect(profile.adopted).toEqual(['dummy-cursor-api-key'])
    expect(profile.authFile().cursor).toBeUndefined()
    // The ChatGPT entry is untouched.
    expect(profile.authFile()['openai-codex']).toBeDefined()
    // An old Cursor selection (a provider name, no instance) follows the Move, with the old
    // sign-in and registration gone.
    expect(profile.harness.resolveStored({ llmProvider: 'cursor', model: 'composer-1' }, { purpose: 'turn' })).toMatchObject({ instanceId: CURSOR, movedFrom: 'pi:cursor' })
    expect(requests).toEqual([])
  })

  it('a Cursor agent signed out in Mousse takes the copied key as its sign-in, and the move runs', async () => {
    const profile = await upgraded({ cursor: { signedOutInMousse: true } })
    expect(await profile.harness.instances.move('pi:cursor', CURSOR, { copyKey: true })).toMatchObject({ oldSignIn: 'removed' })
    const target = (await profile.harness.instances.snapshots(device)).find((entry) => entry.instanceId === CURSOR)!
    expect(target.auth.state).toBe('signed_in')
    expect((profile.stored()[CURSOR] as { config?: Record<string, unknown> }).config?.signedOutInMousse).not.toBe(true)
  })

  it('a Cursor agent that cannot run with the copied key moves nothing, and the old key stays', async () => {
    const profile = await upgraded({ cursor: { runs: false } })
    await expect(profile.harness.instances.move('pi:cursor', CURSOR, { copyKey: true })).rejects.toMatchObject({
      code: 'signed_out',
      message: expect.stringContaining('Nothing moved, and Cursor keeps its key')
    })
    expect(profile.authFile().cursor).toBeDefined()
    expect(profile.stored()['pi:cursor']).toEqual(read('instances.json').instances['pi:cursor'])
  })

  it('a Cursor agent whose install is broken gets no key, and nothing moves', async () => {
    const profile = await upgraded({ cursor: { broken: true } })
    await expect(profile.harness.instances.move('pi:cursor', CURSOR, { copyKey: true })).rejects.toMatchObject({ code: 'signed_out', message: expect.stringContaining('Install') })
    expect(profile.adopted).toEqual([])
    expect(profile.authFile().cursor).toBeDefined()
  })

  it('custom models added under a retired entry are kept but offered nowhere, and no new one is taken', async () => {
    const profile = await upgraded({ custom: true })
    const snapshots = await settledSnapshots(profile)
    const snapshot = snapshots.find((entry) => entry.instanceId === 'pi:openai-codex')!
    expect(snapshot.models.entries).toEqual([])
    expect(snapshot.models.canAddCustom).toBe(false)
    expect(profile.harness.catalog.models('pi:openai-codex', device)).toEqual([])
    // The composer's own picker, from the snapshots and the pi listings.
    const picked = pickerProviders(snapshots, profile.harness.instanceMap.llmProviders())
    expect(picked.map((provider) => provider.instanceId)).not.toContain('pi:openai-codex')
    // A new custom model is refused; the stored one stays for older versions and history.
    await expect(
      profile.harness.instances.setModelPrefs('pi:openai-codex', { custom: [{ id: 'gpt-other', label: 'Other', capabilities: { efforts: [], images: false } }] })
    ).rejects.toMatchObject({ code: 'provider_retired' })
    expect(profile.prefs()['pi:openai-codex']).toMatchObject({ custom: [{ id: 'gpt-custom' }] })
    expect(refusal(() => profile.harness.resolveStored({ instanceId: 'pi:openai-codex', llmProvider: 'openai-codex', model: 'gpt-custom' }, { purpose: 'turn' }))).toMatchObject({ code: 'provider_retired' })
    expect(requests).toEqual([])
  })

  it('a sign-out of the Cursor agent while its key is copied wins: the sign-out stands, nothing moves, and the old key stays', async () => {
    let release!: () => void
    const holdAdoption = new Promise<void>((resolve) => (release = resolve))
    const profile = await upgraded({ cursor: { holdAdoption } })
    const moving = profile.harness.instances.move('pi:cursor', CURSOR, { copyKey: true })
    const settled = moving.then(() => 'moved', (error: unknown) => error)
    // The Move waits for Cursor's answer about the key; meanwhile the user signs the agent out.
    await vi.waitFor(() => {
      if (!profile.moveWaiting()) throw new Error('the move has not reached the key copy yet')
    })
    const signedOut = await profile.harness.instances.signOut(CURSOR)
    expect(signedOut.auth.state).toBe('signed_out')
    release()
    expect(await settled).toMatchObject({ code: 'signed_out', message: expect.stringContaining('signed out during the move') })
    // The sign-out stands, the old entry is not moved, and it keeps its key.
    expect((profile.stored()[CURSOR] as { config?: Record<string, unknown> }).config?.signedOutInMousse).toBe(true)
    const target = (await profile.harness.instances.snapshots(device)).find((entry) => entry.instanceId === CURSOR)!
    expect(target.auth.state).toBe('signed_out')
    expect(profile.stored()['pi:cursor']).toEqual(read('instances.json').instances['pi:cursor'])
    expect(profile.authFile().cursor).toBeDefined()
    expect(requests).toEqual([])
  })
})
