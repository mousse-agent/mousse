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
    } } as never, { spawnAgents: async () => [], completeAgent: async () => undefined })
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
