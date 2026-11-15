/**
 * What a bot's wakes read from the rest of Mousse: a thread as it stands (gone, out of sight, archived, working, idle),
 * a pull request through the owner's project of that repository, and how a bot names a pull request.
 */
import { describe, expect, it } from 'vitest'
import { pullRequestStateOf, wakeThreadState, type WakeThreadDeps } from '../../src/mms/bots/wakeSources'
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
    ['archived, even while a run is ending', { thread: () => ({ name: 'Fix login', settledAt: '2026-11-15T10:00:00.000Z' }), working: () => true }, { state: 'archived', title: 'Fix login' }],
    ['working', { working: () => true }, { state: 'running', title: 'Fix login' }],
    ['idle after its last run', {}, { state: 'idle', title: 'Fix login', lastRun: { status: 'completed', endedAt: '2026-11-15T10:00:00.000Z' } }],
    ['idle with no run yet', { lastRun: () => undefined }, { state: 'idle', title: 'Fix login' }]
  ])('%s', (_name, over, expected) => {
    expect(wakeThreadState(deps(over as Partial<WakeThreadDeps>), 'home', 't1')).toEqual(expected)
  })
})

describe('a pull request through the owner\'s projects', () => {
  const projects = { '/work/app': 'Acme/App', '/work/site': 'acme/site', '/tmp/plain': null as string | null }
  const read = (pull: (folder: string, number: number) => Promise<{ state: 'open' | 'closed' | 'merged'; title?: string }>) => ({
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
    const state = await pullRequestStateOf(read(async (folder, number) => { seen.push(`${folder}#${number}`); return { state: 'merged', title: 'Fix login' } }), 'acme/app', 12)
    expect(state).toEqual({ state: 'merged', title: 'Fix login' })
    expect(seen).toEqual(['/work/app#12'])
  })
  it('says none when no project is that repository, and the host\'s words when the read fails', async () => {
    expect(await pullRequestStateOf(read(async () => ({ state: 'open' })), 'other/app', 1)).toEqual({ none: true })
    expect(await pullRequestStateOf(read(async () => { throw new Error('gh: not signed in') }), 'acme/site', 3)).toEqual({ problem: 'gh: not signed in' })
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
