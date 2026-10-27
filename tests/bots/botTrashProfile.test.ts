/**
 * PR 6 §4 through the real profile: trashing a thread of a working bot ends its activation and
 * stops its run before the trash's own idle check, so the trash is not refused. Ordinary threads
 * are trashed as before.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BotStore } from '../../src/mms/bots/store/BotStore'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function profile(): MmsProfileServices {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-trash-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    { providerAuth: auth, domains: new DomainHandlerRegistry(), installationHome: home, profileId: randomUUID(), allowLegacyProjectData: false }
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
    orchestrator.getOwnedActivity = () => ({ ...activity(), botTurn: live ? 1 : 0 })
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
