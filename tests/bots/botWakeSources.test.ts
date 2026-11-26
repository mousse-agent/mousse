/**
 * What a bot's wakes read from the rest of Mousse: a thread as it stands (gone, out of sight, archived, working, idle),
 * a pull request through the owner's project of that repository, and how a bot names a pull request.
 */
import { describe, expect, it } from 'vitest'
import { pullRequestStateOf, pullRequestWakeHappened, wakeThreadState, type WakePullRequestState, type WakeThreadDeps } from '../../src/mms/bots/wakeSources'
import { pullRequestOf } from '../../src/shared/bots/personal/wakes'

describe('a thread as a wake sees it', () => {
  const deps = (over: Partial<WakeThreadDeps> = {}): WakeThreadDeps => ({
    thread: () => ({ name: 'Fix login' }),
    trashed: () => false,
    reachable: () => true,
    working: () => false,
    lastRun: () => ({ status: 'completed', endedAt: '2026-11-15T10:00:00.000Z' }),
    ...over
  })
  it.each([
    ['gone', { thread: () => undefined }, { state: 'deleted' }],
    ['in the trash, even out of sight', { trashed: () => true, reachable: () => false }, { state: 'deleted' }],
    ['out of the bot\'s sight (a bot\'s, private or subagent thread)', { reachable: () => false }, { state: 'unreachable' }],
    ['archived, even while a run is ending', { thread: () => ({ name: 'Fix login', archivedAt: '2026-11-15T10:00:00.000Z' }), working: () => true }, { state: 'archived', title: 'Fix login' }],
    ['working', { working: () => true }, { state: 'running', title: 'Fix login' }],
    ['idle after its last run', {}, { state: 'idle', title: 'Fix login', lastRun: { status: 'completed', endedAt: '2026-11-15T10:00:00.000Z' } }],
    ['idle with no run yet', { lastRun: () => undefined }, { state: 'idle', title: 'Fix login' }]
  ])('%s', (_name, over, expected) => {
    expect(wakeThreadState(deps(over as Partial<WakeThreadDeps>), 'home', 't1')).toEqual(expected)
  })

  /** A wake waits for the run that worked when it was set; the thread's other runs don't end it. */
  const runs: Record<string, { status: string; endedAt?: string; ended: boolean }> = {
    r1: { status: 'failed', endedAt: '2026-11-15T10:00:00.000Z', ended: true },
    r2: { status: 'running', ended: false }
  }
  it.each([
    ['working, as the run it works on now', undefined, { working: () => true }, { state: 'running', title: 'Fix login', runId: 'r2' }],
    ['its run ended, though the next one works now: that run\'s outcome', 'r1', { working: () => true }, { state: 'idle', title: 'Fix login', lastRun: { status: 'failed', endedAt: '2026-11-15T10:00:00.000Z' } }],
    ['its run works, though another run of the thread just ended', 'r2', { lastRun: () => ({ status: 'cancelled' }) }, { state: 'running', title: 'Fix login', runId: 'r2' }],
    ['its run unknown: as the thread stands', 'gone', { working: () => true }, { state: 'running', title: 'Fix login', runId: 'r2' }]
  ])('a wake on one run: %s', (_name, runId, over, expected) => {
    const seen = wakeThreadState(deps({ currentRun: () => 'r2', run: (_thread, id) => runs[id], ...(over as Partial<WakeThreadDeps>) }), 'home', 't1', runId)
    expect(seen).toEqual(expected)
  })
})

describe('a pull request through the owner\'s projects', () => {
  const projects = { '/work/app': 'Acme/App', '/work/site': 'acme/site', '/tmp/plain': null as string | null }
  const read = (pull: (folder: string, number: number) => Promise<WakePullRequestState>) => ({
    folders: () => Object.keys(projects),
    repository: async (folder: string) => {
      const name = projects[folder as keyof typeof projects]
      if (!name) throw new Error('not a GitHub repository')
      return name
    },
    pullRequest: pull
  })
  it('reads it through the project of that repository, whatever the case of its name', async () => {
    const seen: string[] = []
    const state = await pullRequestStateOf(read(async (folder, number) => { seen.push(`${folder}#${number}`); return { state: 'merged', title: 'Fix login', mergedAt: '2026-11-20T10:05:00Z', closedAt: '2026-11-20T10:05:00Z' } }), 'acme/app', 12)
    expect(state).toEqual({ state: 'merged', title: 'Fix login', mergedAt: '2026-11-20T10:05:00Z', closedAt: '2026-11-20T10:05:00Z' })
    expect(seen).toEqual(['/work/app#12'])
  })
  it('says none when no project is that repository, and the host\'s words when the read fails', async () => {
    expect(await pullRequestStateOf(read(async () => ({ state: 'open' })), 'other/app', 1)).toEqual({ none: true })
    expect(await pullRequestStateOf(read(async () => { throw new Error('gh: not signed in') }), 'acme/site', 3)).toEqual({ problem: 'gh: not signed in' })
  })
})

describe('when what a pull request wake waits for happened, by the host clock', () => {
  const at = (iso: string) => Date.parse(iso)
  const checks = (...completedAt: Array<string | undefined>) => completedAt.map((time, index) => ({ name: `c${index}`, state: 'passing' as const, ...(time ? { completedAt: time } : {}) }))
  it.each<[string, 'merged' | 'checks' | 'review' | undefined, WakePullRequestState, number | undefined]>([
    ['merged: its merge', undefined, { state: 'merged', mergedAt: '2026-11-20T10:05:00Z' }, at('2026-11-20T10:05:00Z')],
    ['merged while it waited on checks: its merge', 'checks', { state: 'merged', mergedAt: '2026-11-20T10:05:00Z' }, at('2026-11-20T10:05:00Z')],
    ['closed: its close', undefined, { state: 'closed', closedAt: '2026-11-20T10:06:00Z' }, at('2026-11-20T10:06:00Z')],
    ['checks: the last to finish', 'checks', { state: 'open', headSha: 'abc1234', checkRuns: checks('2026-11-20T10:01:00Z', '2026-11-20T10:04:00Z') }, at('2026-11-20T10:04:00Z')],
    ['checks with one of no time: none', 'checks', { state: 'open', headSha: 'abc1234', checkRuns: checks('2026-11-20T10:01:00Z', undefined) }, undefined],
    ['review: when it was submitted', 'review', { state: 'open', reviews: [{ id: 'r1', state: 'approved', author: 'kim', submittedAt: '2026-11-20T10:03:00Z' }] }, at('2026-11-20T10:03:00Z')],
    ['merged by an older host with no time: none', undefined, { state: 'merged' }, undefined]
  ])('%s', (_name, on, read, expected) => {
    const happened = pullRequestWakeHappened({ kind: 'pr', repo: 'acme/app', number: 12, ...(on ? { on } : {}), ...(on === 'review' ? { reviewAfter: { at: null, ids: [] } } : {}) }, read, '2026-11-20T10:00:00Z')
    expect(happened).toBeDefined()
    expect(happened!.at).toBe(expected)
  })

  /** One read shows what the wake waits for and the merge or close: the one that came first, by its own time, wins. */
  const review = (submittedAt?: string) => ({ id: 'r1', state: 'approved' as const, author: 'kim', ...(submittedAt ? { submittedAt } : {}) })
  it.each<[string, 'checks' | 'review', WakePullRequestState, string]>([
    ['a review, then the merge: the review', 'review', { state: 'merged', mergedAt: '2026-11-20T10:07:00Z', reviews: [review('2026-11-20T10:05:00Z')] }, 'review'],
    ['the merge, then a review: the merge', 'review', { state: 'merged', mergedAt: '2026-11-20T10:05:00Z', reviews: [review('2026-11-20T10:07:00Z')] }, 'pr_merged'],
    ['a review, then the close: the review', 'review', { state: 'closed', closedAt: '2026-11-20T10:07:00Z', reviews: [review('2026-11-20T10:05:00Z')] }, 'review'],
    ['a review, and a merge with no time: the review', 'review', { state: 'merged', reviews: [review('2026-11-20T10:05:00Z')] }, 'review'],
    ['checks finished, then the merge: the checks', 'checks', { state: 'merged', mergedAt: '2026-11-20T10:07:00Z', headSha: 'abc1234', checkRuns: checks('2026-11-20T10:05:00Z') }, 'checks'],
    ['checks with no time, and the merge: the merge', 'checks', { state: 'merged', mergedAt: '2026-11-20T10:07:00Z', headSha: 'abc1234', checkRuns: checks(undefined) }, 'pr_merged']
  ])('%s', (_name, on, read, expected) => {
    const happened = pullRequestWakeHappened({ kind: 'pr', repo: 'acme/app', number: 12, on, ...(on === 'review' ? { reviewAfter: { at: null, ids: [] } } : {}) }, read, '2026-11-20T10:00:00Z')
    const fired = happened!.fired
    expect(fired.kind === 'ended' ? fired.reason : fired.kind === 'pr' ? fired.state : fired.kind).toBe(expected)
  })
})

describe('how a bot names a pull request', () => {
  it.each([
    ['acme/app#12', { repo: 'acme/app', number: 12 }],
    ['https://github.com/acme/app/pull/12', { repo: 'acme/app', number: 12 }],
    ['https://github.com/acme/app/pull/12/files', { repo: 'acme/app', number: 12 }],
    [{ repo: 'acme/app', number: 12 }, { repo: 'acme/app', number: 12 }],
    ['#12', undefined],
    ['acme/app', undefined],
    ['https://gitlab.com/acme/app/-/merge_requests/12', undefined],
    [{ repo: 'acme/app', number: 0 }, undefined]
  ])('%j', (given, expected) => {
    expect(pullRequestOf(given)).toEqual(expected)
  })
})


it('preserves current-head checks and submitted reviews through the project reader', async () => {
  const detail = { state: 'open' as const, headSha: 'new-head', checkRuns: [{ name: 'test', state: 'pending' as const, url: null }], reviews: [{ id: 'review', state: 'approved' as const, author: 'reviewer', submittedAt: '2026-11-16T10:00:00Z' }] }
  expect(await pullRequestStateOf({ folders: () => ['/app'], repository: async () => 'acme/app', pullRequest: async () => detail }, 'acme/app', 12)).toMatchObject(detail)
})
