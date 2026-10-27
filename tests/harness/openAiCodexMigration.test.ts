import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatGptAuth } from '../../src/mms/harness/chatgpt/chatgptAuth'
import { ChatGptTokenBroker } from '../../src/mms/harness/codex/broker'
import type { CodexInstallation } from '../../src/mms/harness/codex/installation'
import { createManagedCodexRuntime } from '../../src/mms/harness/codex/managedRuntime'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { piProviderIdOf } from '../../src/shared/providerInstances'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { HarnessScopeStore } from '../../src/mms/harness/scope'
import { LoginSession } from '../../src/mms/providers/LoginSession'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { ThreadMoveBanner } from '../../src/renderer/components/providers/MoveProviderDialog'
import { describeStatus, type InstanceSnapshot } from '../../src/shared/harness/status'
import { threadMoveBanner } from '../../src/shared/harness/move'
import { FakeIssuer, guardNetwork, plainCodec } from './chatgpt/fakeIssuer'
import { signIn } from './chatgpt/signInFlow'
import { cleanupProfiles, FIXTURE, intermediateProfile, read } from './openAiCodexFixture'

/**
 * `pi:openai-codex` in the PR 3 release (PR 3 §5): the PR 2 profile of `fixtures/pr2-openai-codex/`
 * keeps chatting on the legacy loop and carries a persistent Move prompt; the move is explicit,
 * onto a Codex that is installed and signed in (a fresh sign-in, no credential copied), and drops the
 * old sign-in with it. Only fakes: a fake ChatGPT sign-in service, a fake install, a replayed pi loop.
 */

guardNetwork()
const noop = () => {}
const device = { kind: 'device' } as const
const alice = { subject: 'alice', email: 'a@example.com' }
const MANAGED = 'codex:managed'

let issuer: FakeIssuer
let broker: ChatGptTokenBroker
const homes: string[] = []
beforeEach(async () => {
  issuer = await new FakeIssuer().start()
  issuer.onModels = () => ({ status: 200, body: { models: [{ slug: read('thread.json').modelOverride.model, visibility: 'list' }] } })
  broker = new ChatGptTokenBroker()
})
afterEach(async () => {
  await cleanupProfiles()
  await broker.close()
  await issuer.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** An agent entry that is installed (a fake install) and signs in with ChatGPT (the fake service). */
function managedCodex() {
  const holder: { auth?: ChatGptAuth } = {}
  const installation = {
    installed: () => ({ path: join(FIXTURE, 'auth.json'), version: '0.162.1' }),
    acquire: () => () => {},
    unsupportedMessage: () => undefined,
    installing: () => false,
    cancel: () => false
  } as unknown as CodexInstallation
  const driver = codexDriver({
    builtIn: () => {
      throw new Error('the user’s own Codex is not part of this profile')
    },
    managed: (context) =>
      createManagedCodexRuntime(context, {
        installation,
        broker,
        auth: (options) => (holder.auth = new ChatGptAuth({ ...options, endpoints: issuer.endpoints, codec: plainCodec }))
      })
  })
  return { driver, holder }
}

async function profile() {
  const { driver, holder } = managedCodex()
  let deviceDefault: Record<string, unknown> = read('defaults.json').provider
  const made = await intermediateProfile({
    extraInstances: { [MANAGED]: { driver: 'codex', enabled: true, config: { setup: 'managed', home: 'private' } } },
    drivers: [driver],
    credentials: (auth) => ({
      has: (providerId: string) => providerId in auth,
      logout: async (providerId: string) => void delete auth[providerId],
      getProviderDisplayName: () => 'ChatGPT',
      getConfiguredProviders: () => ('openai-codex' in auth ? [{ id: 'openai-codex', label: 'ChatGPT', authType: 'oauth' as const, source: 'stored' }] : [])
    }),
    gateway: {
      // The profile's settings: the device default names the old entry, and the move rewrites it.
      defaults: {
        rewrite: (from, to) => {
          if (deviceDefault.instanceId !== from) return []
          deviceDefault = { instanceId: to.instanceId, llmProvider: to.llmProvider, model: to.model(deviceDefault.model as string) }
          return ['Default model']
        }
      }
    }
  })
  new HarnessScopeStore(made.profileHome).setDefaultSelection('project-1', { instanceId: 'pi:openai-codex', model: read('thread.json').modelOverride.model })
  return { ...made, holder, deviceDefault: () => deviceDefault }
}

const snapshotOf = async (harness: Harness, instanceId: string): Promise<InstanceSnapshot> => {
  const found = (await harness.instances.snapshots(device)).find((entry) => entry.instanceId === instanceId)
  if (!found) throw new Error(`no snapshot for ${instanceId}`)
  return found
}

/** Signs the managed entry in with ChatGPT (the fake service) and waits for its models. */
async function signManagedIn(made: Awaited<ReturnType<typeof profile>>) {
  // The runtime (and its sign-in) is built when the entry is first read.
  await made.harness.instances.snapshots(device)
  await vi.waitFor(() => {
    if (!made.holder.auth) throw new Error('the entry has no sign-in yet')
  })
  await signIn(issuer, made.holder.auth!, alice)
  await made.harness.instances.recheck(MANAGED)
  await vi.waitFor(() => {
    if (!made.harness.catalog.models(MANAGED, device).length) throw new Error('models not listed yet')
  })
}

describe('openai-codex in the PR 3 release', () => {
  it('the decoder keeps the record, and the snapshot reads ready with the Move step', async () => {
    const { harness, stored } = await profile()
    expect(stored()['pi:openai-codex']).toMatchObject({ driver: 'pi', enabled: true, config: { displayName: 'ChatGPT' } })
    const snapshot = await snapshotOf(harness, 'pi:openai-codex')
    expect(snapshot).toMatchObject({ driver: 'pi', auth: { state: 'signed_in' }, runs: { state: 'yes' }, engine: { effective: 'legacy' } })
    expect(snapshot.nextStep).toEqual({
      action: 'move',
      label: 'Move',
      title: 'Move to ChatGPT subscription',
      detail: 'This connection uses an older sign-in that a coming Mousse update turns off. Your chats stay.'
    })
    expect(describeStatus(snapshot)).toMatchObject({ tone: 'ready', nextStep: null })
    // Control: an entry with no old route going away has no Move step.
    expect((await snapshotOf(harness, MANAGED)).nextStep).toEqual({ action: 'sign_in', label: 'Sign in' })
  })

  it('a signed-out entry keeps Move as its next step: there is no signing in on the old route', async () => {
    const { harness, auth } = await profile()
    delete auth['openai-codex']
    await harness.instances.recheck('pi:openai-codex')
    const snapshot = await snapshotOf(harness, 'pi:openai-codex')
    expect(snapshot.auth.state).toBe('signed_out')
    expect(snapshot.nextStep).toMatchObject({ action: 'move' })
    expect(describeStatus(snapshot)).toMatchObject({ headline: 'Not signed in', nextStep: { action: 'move' } })
  })

  it('a turn on the pinned thread still runs on the legacy loop, and no Pi process starts', async () => {
    const { harness, transport, rpc } = await profile()
    const pinned = read('thread.json')
    const binding = await harness.bind(harness.resolveStored(pinned.modelOverride, { purpose: 'turn' }), { mode: 'agent' })
    expect(binding).toMatchObject({ instanceId: 'pi:openai-codex', driver: 'pi' })
    const spec: TurnSpec = {
      binding,
      input: {
        runId: 'run-1', attemptId: 'attempt-1', threadId: pinned.id, cwd: null, instanceId: 'pi:openai-codex', model: pinned.modelOverride.model,
        llmProvider: 'openai-codex', modelPinned: true, mode: 'agent', prompt: 'Keep going',
        messages: [{ role: 'user', content: 'Keep going', timestamp: 1 }] as never, nativeHistory: '', signal: new AbortController().signal
      },
      sink: { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop },
      control: { drainSteer: () => undefined, heartbeat: noop },
      host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } }
    }
    expect(await harness.startTurn(spec).result).toMatchObject({ text: 'Still on the loop', aborted: false })
    transport.assertDone()
    expect(rpc.starts).toEqual([])
  })

  it('the thread view model shows the banner for a thread on the entry, and only for it', async () => {
    const { harness } = await profile()
    const snapshots = await harness.instances.snapshots(device)
    const selection = read('thread.json').modelOverride
    const banner = threadMoveBanner(selection.instanceId, snapshots)
    expect(banner).toEqual({
      instanceId: 'pi:openai-codex',
      title: 'Move to ChatGPT subscription',
      detail: 'This connection uses an older sign-in that a coming Mousse update turns off. Your chats stay.',
      label: 'Move'
    })
    expect(threadMoveBanner(MANAGED, snapshots)).toBeNull()
    expect(threadMoveBanner(undefined, snapshots)).toBeNull()
    const html = renderToStaticMarkup(createElement(ThreadMoveBanner, { instanceId: selection.instanceId, snapshots }))
    expect(html).toContain('Move to ChatGPT subscription.')
    expect(html).toContain('Your chats stay.')
    expect(html).toMatch(/<button[^>]*>Move<\/button>/)
    expect(renderToStaticMarkup(createElement(ThreadMoveBanner, { instanceId: MANAGED, snapshots }))).toBe('')
  })

  it('the login options lack the openai-codex sign-in, and its credential keeps working', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-pr3-auth-'))
    homes.push(home)
    cpSync(FIXTURE, home, { recursive: true })
    const auth = new ProviderAuthService(join(home, 'auth.json'))
    expect(auth.has('openai-codex')).toBe(true)
    expect(auth.getLoginOptions('oauth').map((option) => option.id)).not.toContain('openai-codex')
    expect(auth.getLoginOptions().filter((option) => option.id === 'openai-codex')).toEqual([])
    // A sign-in that is asked for anyway is refused, and what is saved stays.
    expect(await auth.runOAuthLogin(new LoginSession('retired'), 'openai-codex')).toMatchObject({ success: false })
    expect(auth.has('openai-codex')).toBe(true)
    auth.stop()
  })

  it('a move onto a Codex that is not signed in changes nothing', async () => {
    const made = await profile()
    const { harness, auth, stored, deviceDefault } = made
    const before = JSON.stringify(stored())
    await expect(harness.instances.move('pi:openai-codex', MANAGED)).rejects.toMatchObject({ code: 'signed_out' })
    expect(JSON.stringify(stored())).toBe(before)
    expect(auth['openai-codex']).toBeDefined()
    expect(deviceDefault()).toEqual(read('defaults.json').provider)
    expect(new HarnessScopeStore(made.profileHome).project('project-1')?.defaultSelection).toMatchObject({ instanceId: 'pi:openai-codex' })
    // The pinned thread is still on the old entry.
    expect(harness.resolveStored(read('thread.json').modelOverride, { purpose: 'turn' })).toMatchObject({ instanceId: 'pi:openai-codex', driver: 'pi' })
  })

  it('a move onto a turned-off Codex is refused too', async () => {
    const made = await profile()
    made.harness.instanceMap.setEntry(MANAGED, { driver: 'codex', enabled: false, config: { setup: 'managed', home: 'private' } })
    await expect(made.harness.instances.move('pi:openai-codex', MANAGED)).rejects.toMatchObject({ code: 'unsupported' })
    expect(made.auth['openai-codex']).toBeDefined()
  })

  it('moves after a fresh sign-in: re-points the defaults and the pinned thread, and deletes the old credential', async () => {
    const made = await profile()
    const { harness, auth, stored, deviceDefault } = made
    await signManagedIn(made)
    // Nothing is copied: the new sign-in has tokens of its own.
    expect((await made.holder.auth!.access()).accessToken).not.toBe(read('auth.json')['openai-codex'].access)

    const result = await harness.instances.move('pi:openai-codex', MANAGED)
    const model = read('thread.json').modelOverride.model
    expect(result).toMatchObject({ from: 'pi:openai-codex', to: MANAGED })
    expect(result.rewritten).toEqual(['Default model', expect.stringContaining('Project default (project-1)')])
    expect(stored()['pi:openai-codex']).toEqual({ driver: 'pi', enabled: false, config: { displayName: 'ChatGPT', movedTo: MANAGED } })
    expect(auth['openai-codex']).toBeUndefined()
    expect(deviceDefault()).toMatchObject({ instanceId: MANAGED, model })
    expect(new HarnessScopeStore(made.profileHome).project('project-1')?.defaultSelection).toMatchObject({ instanceId: MANAGED })

    // The pinned thread continues on Codex with its history handed over.
    const resolved = harness.resolveStored(read('thread.json').modelOverride, { purpose: 'turn' })
    expect(resolved).toMatchObject({ instanceId: MANAGED, driver: 'codex', model, movedFrom: 'pi:openai-codex' })

    // A moved entry has no banner, and moving twice is refused.
    const snapshot = await snapshotOf(harness, 'pi:openai-codex')
    expect(snapshot.nextStep).toBeUndefined()
    expect(snapshot.config).toMatchObject({ movedTo: MANAGED })
    expect(threadMoveBanner('pi:openai-codex', await harness.instances.snapshots(device))).toBeNull()
    await expect(harness.instances.move('pi:openai-codex', MANAGED)).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('the PR 2 build still reads the profile after the move: both entries, the old one off with its target', async () => {
    const made = await profile()
    await signManagedIn(made)
    await made.harness.instances.move('pi:openai-codex', MANAGED)
    // A fresh decoder over the stored map (the PR 2 reader, restarted on the moved state).
    const { ProviderInstanceService } = await import('../../src/mms/providers/ProviderInstanceService')
    const reread = new ProviderInstanceService({ store: { read: () => ({ instances: made.stored(), seedVersion: 1 }), write: () => {} } })
    const entries = reread.list()
    expect(entries['pi:openai-codex']).toMatchObject({ driver: 'pi', enabled: false, config: { movedTo: MANAGED } })
    expect(entries[MANAGED]).toMatchObject({ driver: 'codex', enabled: true })
    expect(piProviderIdOf('pi:openai-codex')).toBe('openai-codex')
  })
})
