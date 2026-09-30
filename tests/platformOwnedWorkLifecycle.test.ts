import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnedWorkBarrier } from '../src/mms/execution/OwnedWorkBarrier'
import { MousseAgentService } from '../src/mms/agents/MousseAgentService'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME
afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-owned-lifecycle-') || path.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('awaited profile work ownership', () => {
  it('retains ownership after a timeout and settles independent waiters only when the work finishes', async () => {
    const barrier = new OwnedWorkBarrier(), release = deferred()
    const work = barrier.run('held', () => release.promise)
    barrier.beginShutdown()
    await expect(barrier.waitForIdle(10)).rejects.toMatchObject({ code: 'profile_busy', details: { held: 1 } })
    expect(barrier.count).toBe(1)
    expect(() => barrier.run('new', () => undefined)).toThrow('shutting down')
    const one = barrier.waitForIdle(), two = barrier.waitForIdle()
    release.resolve(); await Promise.all([work, one, two])
    expect(barrier.count).toBe(0)
    await barrier.waitForIdle()
  })

  it('aborts and awaits an actual native-agent send even if the presentation session was cleared', async () => {
    const entered = deferred(), release = deferred()
    let signal!: AbortSignal
    const service = new MousseAgentService({ chat: async (history: unknown[], _onTool: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal; entered.resolve(); await release.promise
      return { text: '', aborted: true, nativeMessages: history, modelName: 'fixture', totalResponseTimeMs: 1, totalTokensUsed: 0, tokensPerSecond: 0 }
    } } as never, { completeAgent: async () => undefined })
    service.start('owned-fixture-agent', 'Fixture work', tmpdir())
    await entered.promise
    service.clearSessions()
    service.beginShutdown()
    expect(signal.aborted).toBe(true)
    await expect(service.shutdown(10)).rejects.toMatchObject({ code: 'profile_busy' })
    expect(service.getActiveCount()).toBe(1)
    expect(() => service.start('later', 'No work', tmpdir())).toThrow('shutting down')
    release.resolve(); await service.shutdown()
    expect(service.getActiveCount()).toBe(0)
  })

  it('does not let an old cleared send finalize a restored send with the same agent id', async () => {
    const firstEntered = deferred(), firstRelease = deferred()
    const secondEntered = deferred(), secondRelease = deferred()
    let call = 0
    let secondSignal!: AbortSignal
    const service = new MousseAgentService({ chat: async (history: unknown[], _onTool: unknown, options: { signal: AbortSignal }) => {
      call += 1
      if (call === 1) {
        firstEntered.resolve(); await firstRelease.promise
      } else {
        secondSignal = options.signal; secondEntered.resolve(); await secondRelease.promise
      }
      return { text: 'fixture', aborted: options.signal.aborted, nativeMessages: history, modelName: 'fixture', totalResponseTimeMs: 1, totalTokensUsed: 0, tokensPerSecond: 0 }
    } } as never, { completeAgent: async () => undefined })

    service.start('reused-agent-id', 'Old work', tmpdir())
    await firstEntered.promise
    const snapshot = service.exportSessions()
    service.clearSessions()
    service.restoreSessions(snapshot)
    const replacement = service.send('reused-agent-id', 'New work')
    await secondEntered.promise

    firstRelease.resolve()
    await vi.waitFor(() => expect(service.getActiveCount()).toBe(1))
    expect(service.getRunState('reused-agent-id')).toBe('running')
    expect(service.isTurnActive('reused-agent-id')).toBe(true)

    service.beginShutdown()
    expect(secondSignal.aborted).toBe(true)
    secondRelease.resolve()
    await Promise.all([replacement, service.shutdown()])
  })

  it('observes a rejected background send and still releases lifecycle ownership', async () => {
    const service = new MousseAgentService({ chat: vi.fn() } as never, {
      completeAgent: async () => undefined
    })
    let persists = 0
    service.setPersistCallback(() => {
      persists += 1
      if (persists > 1) throw new Error('fixture persistence failure')
    })
    const failed = new Promise<{ error: Error }>((resolve) => {
      service.once('background-send-failed', resolve)
    })

    service.start('persist-failure', 'Fixture work', tmpdir())
    await expect(failed).resolves.toMatchObject({ error: new Error('fixture persistence failure') })
    expect(service.getActiveCount()).toBe(0)
    expect(service.isTurnActive('persist-failure')).toBe(false)
    expect(service.getRunState('persist-failure')).toBe('failed')
    await service.shutdown()
  })

  it('keeps one profile scheduled turn owned through abort and final writes while another profile stays usable', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = mkdtempSync(join(tmpdir(), 'mousse-owned-lifecycle-')); roots.push(root)
    const main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false, headless: true })
    const release = deferred(), entered = deferred()
    try {
      const bob = main.getInstallationHost()!.manager.create({ displayName: 'Bob', slug: 'bob' })
      const services = await main.getProfileServices(bob.id), marker = join(services.getProfileHomeDir(), 'last-owned-write.txt')
      let signal!: AbortSignal
      vi.spyOn((services.orchestrator as any).llm, 'chat').mockImplementation(async (...args: any[]) => {
        signal = args[2].signal; entered.resolve(); await release.promise
        writeFileSync(marker, 'Final owned write')
        return { text: 'Stopped after cleanup', aborted: true }
      })
      vi.spyOn((main.orchestrator as any).llm, 'chat').mockResolvedValue({ text: 'Other profile works' })
      const run = services.orchestrator.runIsolatedScheduledJob('Fixture owned run')
      await entered.promise
      services.orchestrator.beginShutdown()
      expect(signal.aborted).toBe(true)
      await expect(services.orchestrator.shutdown(10)).rejects.toMatchObject({ code: 'profile_busy' })
      await expect(services.orchestrator.send('Must not enter')).rejects.toMatchObject({ code: 'profile_draining' })
      ;(services.orchestrator as any).boundSession.failedConnectionRequest = { content: 'Must not retry' }
      expect(services.orchestrator.retryLastConnection()).toBe(false)
      expect(existsSync(marker)).toBe(false)
      expect((await main.orchestrator.runIsolatedScheduledJob('Independent fixture')).text).toBe('Other profile works')
      release.resolve(); await Promise.all([run, services.orchestrator.shutdown()])
      expect(existsSync(marker)).toBe(true)
      expect(services.orchestrator.getOwnedActivity()['scheduled-turn'] ?? 0).toBe(0)
    } finally { release.resolve(); await main.stop() }
  }, 20_000)

  it('rejects pending questions without inventing answers and refuses new questions on a stopped service', async () => {
    const questions = new UserQuestionService(), peer = new UserQuestionService()
    const pending = questions.requestAnswers([], 'thread-a').catch((error: unknown) => error)
    questions.shutdown()
    expect(await pending).toBeInstanceOf(DOMException)
    expect(questions.listAllPending()).toEqual([])
    await expect(questions.requestAnswers([], 'thread-a')).rejects.toMatchObject({ code: 'profile_draining' })
    const peerPending = peer.requestAnswers([], 'thread-b').catch((error: unknown) => error)
    expect(peer.listAllPending()).toHaveLength(1)
    peer.shutdown(); await peerPending
  })
})
