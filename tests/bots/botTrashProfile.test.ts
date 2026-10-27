/**
 * PR 6 §4 through the real profile: trashing a thread of a working bot ends its activation and
 * stops its run before the trash's own idle check, so the trash is not refused. Ordinary threads
 * are trashed as before.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { dispatchMethod } from '../../src/mms/protocol/handlers'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../../src/mms/queue/ThreadExecutionLease'
import type { BotDefinition } from '../../src/shared/bots/personal/definition'
import type { BotStore } from '../../src/mms/bots/store/BotStore'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function profile(domains = new DomainHandlerRegistry(), profileId = randomUUID()): MmsProfileServices {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-trash-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    { providerAuth: auth, domains, installationHome: home, profileId, allowLegacyProjectData: false }
  )
  cleanup.push(() => services.stop())
  return services
}

describe('trashing a working bot\'s thread through the profile', () => {
  it('ends the activation, stops its run, and moves the thread to the trash', async () => {
    const services = profile()
    const bots = services.personalBots!
    const store = (services as unknown as { botStore: BotStore }).botStore
    const home = services.threads.ensureExecutionThread('bot:site-editor', 'Site editor')
    const thread = services.threads.ensureExecutionThread('bot:site-editor:act:a1', 'Site editor: go', undefined, { parentTaskId: home.id })
    store.ensureRegistry('site-editor')
    store.setHomeThread('site-editor', home.id)
    store.putThread({ threadId: home.id, botId: 'site-editor', role: 'home', key: 'home' })
    store.putThread({ threadId: thread.id, botId: 'site-editor', role: 'activation', key: 'main', activationId: 'act_1' })
    store.insertActivation({ id: 'act_1', botId: 'site-editor', revision: 'r', grantDigest: 'g', trigger: { kind: 'manual', input: 'go' }, idempotencyKey: 'manual:1', status: 'running', createdAt: new Date().toISOString() }, {})
    store.moveActivation('act_1', ['running'], 'running', { threadId: thread.id })
    const sent = await services.runEngine.sendWithStart({ kind: 'send', threadId: thread.id, clientRequestId: 'act_1:d1', source: 'bot' }, (runId) => ({ kind: 'bot', runId, threadId: thread.id, activationId: 'act_1', dispatchN: 1 }))
    if (sent.status !== 'accepted') throw new Error('not accepted')
    store.insertDispatch({ activationId: 'act_1', n: 1, kind: 'start', clientRequestId: 'act_1:d1', threadId: thread.id, prompt: { text: 'go' }, policyDigest: 'g' })
    store.setDispatchRun('act_1', 1, sent.runId)
    services.runEngine.markStarting(sent.runId)
    services.runEngine.markRunning(sent.runId)
    // The bot's turn is live: the profile counts it as active work until its thread is stopped.
    const orchestrator = services.orchestrator as unknown as { getOwnedActivity(): Record<string, number>; stopThread(threadId: string, ...rest: unknown[]): Promise<unknown> }
    let live = true
    const activity = orchestrator.getOwnedActivity.bind(orchestrator)
    orchestrator.getOwnedActivity = () => ({ ...activity(), ...(live ? { [`bot-turn:${thread.id}`]: 1 } : {}) })
    orchestrator.stopThread = async (threadId: string) => {
      if (threadId !== thread.id) return
      live = false
      services.runEngine.markTerminal(sent.runId, 'interrupted', { interruptedBy: 'user' })
    }

    await services.trashThread(thread.id)
    expect(bots.getActivation('act_1')).toMatchObject({ status: 'cancelled', endReason: 'thread_trashed' })
    expect(services.runEngine.getRun(sent.runId)!.status).not.toBe('running')
    expect(services.threads.lifecycleStore.get(thread.id)?.state).not.toBe('active')
  }, 60_000)

  it('an ordinary thread is trashed as before', async () => {
    const services = profile()
    const thread = services.threads.createThread('Plain thread')
    await services.trashThread(thread.id)
    expect(services.threads.lifecycleStore.get(thread.id)?.state).not.toBe('active')
  }, 60_000)
})

/** A real profile with one approved bot and a running activation (runtime checks stubbed; no turn runs). */
async function withBot() {
  const domains = new DomainHandlerRegistry()
  const profileId = randomUUID()
  const services = profile(domains, profileId)
  vi.spyOn(services.harness, 'checkPolicy').mockReturnValue({ ok: true })
  vi.spyOn(services.harness, 'nativeToolNames').mockReturnValue({ ok: true, names: [] })
  cleanup.push(() => vi.restoreAllMocks())
  const bots = services.personalBots!
  const definition: BotDefinition = {
    id: 'review-bot', name: 'Review bot', role: 'test',
    main: { key: 'main', title: 'Main', agent: { instructions: '' }, selection: { instanceId: 'pi:test', model: 'test' } },
    context: [], triggers: { manual: true },
    permissions: { tools: [], appTools: [], mcp: [], skills: [], workspace: null, budget: { maxActiveMs: 60_000 }, audience: 'owner' }
  }
  const draft = bots.save(definition)
  bots.publish(definition.id, draft.draftHash)
  bots.approve(definition.id, botManifestDigest(definition.permissions))
  const activation = await bots.activate({ botId: definition.id, input: 'test', clientRequestId: 'one' })
  const home = (services as unknown as { botStore: BotStore }).botStore.registry('review-bot')!.homeThreadId!
  return { services, bots, activation, home, domains, profileId }
}

describe('round 2: the trash cancels bot work only when it is accepted', () => {
  it('a stale trash is refused and leaves the activation running', async () => {
    const { services, bots, activation } = await withBot()
    const record = services.threads.lifecycleStore.require(activation.threadId!)
    await expect(services.trashThread(record.taskId, 'stale-trash', record.generation + 1)).rejects.toMatchObject({ code: 'stale' })
    expect(services.threads.lifecycleStore.require(record.taskId).state).toBe('active')
    expect(bots.getActivation(activation.id).status).toBe('running')
  }, 60_000)

  it('replaying an old, completed trash after a restore leaves new work alone', async () => {
    const { services, bots, activation, home } = await withBot()
    await bots.stop(activation.id)
    await services.trashThread(home, 'first-trash')
    await services.restoreThread(home, 'restore')
    const next = await bots.activate({ botId: 'review-bot', input: 'new', clientRequestId: 'two' })
    expect(next.status).toBe('running')
    await services.trashThread(home, 'first-trash')
    expect(services.threads.lifecycleStore.require(home).state).toBe('active')
    expect(bots.getActivation(next.id).status).toBe('running')
  }, 60_000)

  it('a provider stop that never settles is bounded: the trash is refused busy and nothing moves', async () => {
    const { services, bots, activation } = await withBot()
    ;(bots as unknown as { host: { quiesceTimeoutMs?: number } }).host.quiesceTimeoutMs = 300
    // The bot's run is live, and its provider stop never settles.
    const runId = services.runEngine.listRuns(activation.threadId!)[0].runId
    services.runEngine.markStarting(runId)
    services.runEngine.markRunning(runId)
    vi.spyOn(services.orchestrator, 'stopThread').mockImplementation(() => new Promise(() => {}))
    await expect(services.trashThread(activation.threadId!)).rejects.toMatchObject({ code: 'busy' })
    expect(services.threads.lifecycleStore.require(activation.threadId!).state).not.toBe('trashed')
  }, 60_000)
})

describe('round 2: deleting a bot through the real request path', () => {
  it('trashes its home thread once; a home thread restored afterwards stays where the owner put it', async () => {
    const { services, bots, activation, home, domains, profileId } = await withBot()
    registerPersonalBotMethods(domains, () => bots)
    await dispatchMethod({ mms: services, connection: { id: 'test', binding: { profileId, epoch: 1 }, capabilities: new Set() } } as never, 'bots.definitions.delete', { botId: 'review-bot' })
    expect(services.threads.lifecycleStore.require(home).state).toBe('trashed')
    expect(bots.getActivation(activation.id).status).toBe('cancelled')
    await services.restoreThread(home, 'owner-restore')
    await bots.finishDeletions()
    expect(services.threads.lifecycleStore.require(home).state).toBe('active')
  }, 60_000)
})

describe('round 3: a running bot holding its thread\'s execution lease', () => {
  it('an accepted trash stops the bot, then trashes the thread', async () => {
    const { services, bots, activation } = await withBot()
    const threadId = activation.threadId!
    const run = services.runEngine.listRuns(threadId)[0]
    services.runEngine.markStarting(run.runId)
    services.runEngine.markRunning(run.runId)
    // The real turn lease, as `executeTurn` holds it; stopping the turn lets go of it and ends the run.
    let lease = tryAcquireExecutionLease(services.threads.getThreadDir(threadId), { source: 'orchestrator' })
    expect(lease).not.toBeNull()
    cleanup.push(() => { if (lease) releaseExecutionLeaseHandle(lease) })
    let live = true
    const stop = vi.spyOn(services.orchestrator, 'stopThread').mockImplementation(async () => {
      live = false
      if (lease) releaseExecutionLeaseHandle(lease)
      lease = null
      services.runEngine.markTerminal(run.runId, 'interrupted', { interruptedBy: 'user' })
      return undefined as never
    })
    vi.spyOn(services.orchestrator, 'getOwnedActivity').mockImplementation(() => (live ? { [`bot-turn:${threadId}`]: 1 } : {}))
    await services.trashThread(threadId, 'trash-running-bot')
    expect(stop).toHaveBeenCalled()
    expect(bots.getActivation(activation.id)).toMatchObject({ status: 'cancelled', endReason: 'thread_trashed' })
    expect(services.threads.lifecycleStore.require(threadId).state).toBe('trashed')
  }, 60_000)

  it('a trash refused by other work leaves the bot running', async () => {
    const { services, bots, activation } = await withBot()
    const stop = vi.spyOn(services.orchestrator, 'stopThread')
    // An ordinary turn elsewhere in the profile: the trash is refused at admission.
    vi.spyOn(services.orchestrator, 'getOwnedActivity').mockReturnValue({ turn: 1 })
    await expect(services.trashThread(activation.threadId!, 'refused-trash')).rejects.toMatchObject({ code: 'busy' })
    expect(stop).not.toHaveBeenCalled()
    expect(bots.getActivation(activation.id).status).toBe('running')
    expect(services.threads.lifecycleStore.require(activation.threadId!).state).toBe('active')
  }, 60_000)
})
