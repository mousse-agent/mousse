/**
 * A wake on a thread, through the real profile (`MmsProfileServices`): the run's end is told (its terminal `run.status`)
 * before its turn lets go of the thread, and a queued message can start the next run at once. The wake waiting on that
 * thread still fires, with the run that ended: its outcome comes from the terminal event, not from how the thread stands
 * when it is looked at.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { isThreadWakeRow, type ThreadWakePayload } from '../../src/mms/run/types'
import { wakeFiredLabel } from '../../src/shared/bots/personal/wakes'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

function profile(): MmsProfileServices {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-wake-run-end-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
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

/** A run of `threadId` in `running`, as the turn executor moves it. */
async function running(services: MmsProfileServices, threadId: string, key: string): Promise<string> {
  const sent = await services.runEngine.dispatch({ kind: 'send', threadId, clientRequestId: key, source: 'gui' })
  if (sent.status !== 'accepted') throw new Error('send rejected')
  services.runEngine.markStarting(sent.runId)
  services.runEngine.markRunning(sent.runId)
  return sent.runId
}

describe('a wake on a thread whose run ends while its turn still holds the thread', () => {
  it('fires with that run\'s outcome, though the next run has already started', async () => {
    const services = profile()
    const watcher = services.threads.createThread('Reviewer')
    const worker = services.threads.createThread('Port the parser')
    const first = await running(services, worker.id, 'first')
    services.threadWakes.start()
    const set = await services.threadWakes.add(watcher.id, { brief: 'Review what the parser port wrote.', event: { kind: 'thread', threadId: worker.id } })
    const bots = services.personalBots ? vi.spyOn(services.personalBots, 'threadRunEnded') : undefined

    // The turn has not let go yet when its run's end is told; a queued message starts the next run straight after.
    let turnHeld = true
    const isTurnActive = services.orchestrator.isTurnActive.bind(services.orchestrator)
    vi.spyOn(services.orchestrator, 'isTurnActive').mockImplementation((threadId) => (threadId === worker.id && turnHeld) || isTurnActive(threadId))
    services.runEngine.markTerminal(first, 'failed', { error: 'tests failed' })
    turnHeld = false
    await running(services, worker.id, 'second')
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))

    const rows = services.runEngine.inbox.listForThread(watcher.id).filter(isThreadWakeRow)
    expect(rows.map((row) => (row.payload as ThreadWakePayload).wakeId)).toEqual([set.wakeId])
    expect((rows[0]!.payload as ThreadWakePayload).label).toBe('Following up · "Port the parser" failed')
    expect(services.threadWakes.list(watcher.id)).toEqual([])
    // A bot's wakes on the thread are told the same outcome.
    expect(bots).toBeDefined()
    expect(bots).toHaveBeenCalledWith(worker.id, expect.objectContaining({ status: 'failed' }))
  }, 60_000)

  it('waits for the run that worked when it was set: a queued message taken back does not wake it, and that run\'s end does', async () => {
    const services = profile()
    const watcher = services.threads.createThread('Reviewer')
    const worker = services.threads.createThread('Port the parser')
    const first = await running(services, worker.id, 'first')
    services.threadWakes.start()
    const set = await services.threadWakes.add(watcher.id, { brief: 'Review what the parser port wrote.', event: { kind: 'thread', threadId: worker.id } })
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
    const wakeRows = () => services.runEngine.inbox.listForThread(watcher.id).filter(isThreadWakeRow)

    // A message queued behind the run, then taken back: its queued run ends cancelled (`removeQueuedItem`).
    const queued = await services.runEngine.dispatch({ kind: 'send', threadId: worker.id, clientRequestId: 'queued', source: 'gui' })
    if (queued.status !== 'accepted') throw new Error('send rejected')
    expect(services.runEngine.getRun(queued.runId)?.status).toBe('queued')
    services.runEngine.markTerminal(queued.runId, 'cancelled', { interruptedBy: 'user' })
    await settle()
    expect(wakeRows()).toEqual([])
    expect(services.threadWakes.list(watcher.id).map((wake) => wake.wakeId)).toEqual([set.wakeId])

    services.runEngine.markTerminal(first, 'completed')
    await settle()
    expect(wakeRows().map((row) => [(row.payload as ThreadWakePayload).wakeId, (row.payload as ThreadWakePayload).label]))
      .toEqual([[set.wakeId, wakeFiredLabel({ kind: 'thread', threadId: worker.id, status: 'completed', title: 'Port the parser' })]])
  }, 60_000)

  it('set while a failed run\'s turn still saves it, with a message queued behind: taking that message back fires it with the failed run, not as cancelled', async () => {
    const services = profile()
    const watcher = services.threads.createThread('Reviewer')
    const worker = services.threads.createThread('Port the parser')
    const first = await running(services, worker.id, 'first')
    const queued = await services.runEngine.dispatch({ kind: 'send', threadId: worker.id, clientRequestId: 'queued', source: 'gui' })
    if (queued.status !== 'accepted') throw new Error('send rejected')
    // The run fails; its turn still holds the thread while it saves its checkpoint.
    const isTurnActive = services.orchestrator.isTurnActive.bind(services.orchestrator)
    vi.spyOn(services.orchestrator, 'isTurnActive').mockImplementation((threadId) => threadId === worker.id || isTurnActive(threadId))
    vi.spyOn(services.orchestrator, 'activeTurnRunId').mockImplementation((threadId) => threadId === worker.id ? first : undefined)
    services.runEngine.markTerminal(first, 'failed', { error: 'tests failed' })
    expect(services.runEngine.getRun(queued.runId)?.status).toBe('queued')
    services.threadWakes.start()
    const set = await services.threadWakes.add(watcher.id, { brief: 'Review what the parser port wrote.', event: { kind: 'thread', threadId: worker.id } })

    services.runEngine.markTerminal(queued.runId, 'cancelled', { interruptedBy: 'user' })
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    const rows = services.runEngine.inbox.listForThread(watcher.id).filter(isThreadWakeRow)
    expect(rows.map((row) => [(row.payload as ThreadWakePayload).wakeId, (row.payload as ThreadWakePayload).label]))
      .toEqual([[set.wakeId, wakeFiredLabel({ kind: 'thread', threadId: worker.id, status: 'failed', title: 'Port the parser' })]])
  }, 60_000)
})
