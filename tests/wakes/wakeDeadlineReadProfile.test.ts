/**
 * A thread's wake on a pull request, through the real profile (`MmsProfileServices`) and the real GitHub code host,
 * whose 30-second read cache a pull request watch shares. Only `gh` is scripted (hand-authored output: it proves
 * Mousse's side, not what gh prints). At the wake's deadline it is read once more, and that read asks GitHub again:
 *
 * - a watch read the pull request just before the deadline (cached "open"), and it merged after that, before the
 *   deadline: the wake fires as merged;
 * - a watch's read started just before the deadline and is still in flight: the deadline read does not join it, and
 *   the wake fires as merged.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import type { ExecutableRunner } from '../../src/mms/git/ghRunner'
import { GitHubCodeHost } from '../../src/mms/git/GitHubCodeHost'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { isThreadWakeRow, type ThreadWakePayload } from '../../src/mms/run/types'
import { wakeFiredLabel } from '../../src/shared/bots/personal/wakes'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

type View = { state: 'OPEN' | 'MERGED'; mergedAt: string | null }

/** A profile whose code host is a real `GitHubCodeHost` over scripted `gh`; `view` answers each `gh pr view`. */
function profile(view: () => Promise<View>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-wake-deadline-')))
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
  let views = 0
  const run: ExecutableRunner = async (executable, args) => {
    if (executable !== 'gh') throw new Error(`unexpected ${executable}`)
    if (args[0] === '--version') return { stdout: '', stderr: '' }
    if (args[0] === 'repo') return { stdout: JSON.stringify({ nameWithOwner: 'acme/app', url: 'https://github.com/acme/app' }), stderr: '' }
    if (args[0] === 'pr' && args[1] === 'view') {
      views += 1
      const { state, mergedAt } = await view()
      return { stdout: JSON.stringify({ number: 13, title: 'Hotfix', url: 'https://github.com/acme/app/pull/13', state, isDraft: false, body: '', author: { login: 'kim' }, baseRefName: 'main', headRefName: 'hotfix', headRefOid: 'abcdef1234567', isCrossRepository: false, reviewDecision: '', updatedAt: '2026-11-26T10:00:00Z', mergedAt, closedAt: mergedAt, reviews: [], comments: [], statusCheckRollup: [] }), stderr: '' }
    }
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  const codeHost = new GitHubCodeHost(run, () => Date.now())
  Object.defineProperty(services.gitService, 'codeHost', { value: codeHost })
  vi.spyOn(services.projects, 'listProjects').mockReturnValue([{ path: home } as ReturnType<typeof services.projects.listProjects>[number]])
  // The wakes' clock and timers from here on; the profile started with real ones, and stops with them.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  return { services, codeHost, home, views: () => views }
}

/** A thread's wake on #13 that gives up six minutes after it was set. */
async function wakeOnThirteen(services: MmsProfileServices) {
  const watcher = services.threads.createThread('Release')
  services.threadWakes.start()
  const set = await services.threadWakes.add(watcher.id, { brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 }, hours: 0.1 })
  const labels = () => services.runEngine.inbox.listForThread(watcher.id).filter(isThreadWakeRow).map((row) => [(row.payload as ThreadWakePayload).wakeId, (row.payload as ThreadWakePayload).label])
  return { deadline: Date.parse(set.dueAt), set, labels }
}

const merged = wakeFiredLabel({ kind: 'pr', repo: 'acme/app', number: 13, state: 'merged' })

describe('at its deadline a wake on a pull request asks GitHub again', () => {
  it('a watch cached it open just before the deadline, and it merged after that: the wake fires as merged', async () => {
    let shown: View = { state: 'OPEN', mergedAt: null }
    const { services, codeHost, home, views } = profile(async () => shown)
    const { deadline, set, labels } = await wakeOnThirteen(services)
    await vi.advanceTimersByTimeAsync(deadline - 10_000 - Date.now())
    // The watch's read, ten seconds before the deadline: cached for thirty.
    await codeHost.getPullRequestDetail(home, 13, { force: true, lineComments: false })
    shown = { state: 'MERGED', mergedAt: new Date(deadline - 5_000).toISOString() }
    const before = views()
    await vi.advanceTimersByTimeAsync(deadline - Date.now() + 1_000)
    expect(views()).toBe(before + 1)
    expect(labels()).toEqual([[set.wakeId, merged]])
  }, 60_000)

  it('a watch\'s read started just before the deadline is still in flight: the deadline read does not join it, and the wake fires as merged', async () => {
    let hold = false
    let release: ((view: View) => void) | undefined
    let shown: View = { state: 'OPEN', mergedAt: null }
    const { services, codeHost, home, views } = profile(() => hold ? new Promise<View>((resolve) => { release = resolve }) : Promise.resolve(shown))
    const { deadline, set, labels } = await wakeOnThirteen(services)
    await vi.advanceTimersByTimeAsync(deadline - 5_000 - Date.now())
    // The watch's read, five seconds before the deadline, waits on GitHub; the pull request merges meanwhile.
    hold = true
    const watchRead = codeHost.getPullRequestDetail(home, 13, { force: true, lineComments: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toBeTypeOf('function')
    hold = false
    shown = { state: 'MERGED', mergedAt: new Date(deadline - 2_000).toISOString() }
    const before = views()
    await vi.advanceTimersByTimeAsync(deadline - Date.now() + 1_000)
    expect(views()).toBe(before + 1)
    expect(labels()).toEqual([[set.wakeId, merged]])
    release!({ state: 'OPEN', mergedAt: null })
    await watchRead
  }, 60_000)
})
