import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { classifyGhFailure } from '../src/mms/git/ghRunner'
import {
  classifyPullRequestFailure,
  GitHubCodeHost,
  parsePullRequestJson,
  parsePullRequestList,
  parsePushUrls,
  parseRemotes,
  parseRemoteUrl,
  parseRepositoryIdentity,
  PULL_REQUEST_EXISTS,
  remoteForIdentity,
  removeTempFolder,
  summarizeCheckRollup
} from '../src/mms/git/GitHubCodeHost'
import { createGhFallbackRunner, type ExecutableRunner } from '../src/mms/git/GitHubService'
import { parsePullRequestReference, pullRequestIdentityKey, pullRequestReferenceMismatch } from '../src/shared/pullRequests'

const enoent = () => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
const failure = (stderr: string) => Object.assign(new Error('exit 1'), { stderr })
const ok = (stdout = '') => ({ stdout, stderr: '' })

const FIELDS = 'number,title,url,state,isDraft,statusCheckRollup,isCrossRepository,headRefName,baseRefName'
const identityJson = (url = 'https://github.com/acme/app', nameWithOwner = 'acme/app') => JSON.stringify({ nameWithOwner, url })

describe('summarizeCheckRollup', () => {
  it('counts check runs and status contexts', () => {
    const summary = summarizeCheckRollup([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { status: 'COMPLETED', conclusion: 'SKIPPED' },
      { state: 'SUCCESS' },
      { status: 'IN_PROGRESS', conclusion: '' },
      { state: 'PENDING' },
      { state: 'EXPECTED' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
      { state: 'ERROR' }
    ])
    expect(summary.checkCounts).toEqual({ passed: 4, failed: 2, pending: 3, waiting: 0, total: 9 })
    expect(summary.checks).toBe('failing')
  })

  it.each(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'])('treats %s as failed', (conclusion) => {
    expect(summarizeCheckRollup([{ status: 'COMPLETED', conclusion }]).checks).toBe('failing')
  })

  it('treats a run awaiting maintainer approval as waiting, which is pending and never failing', () => {
    expect(summarizeCheckRollup([{ status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }])).toEqual({
      checks: 'pending',
      checkCounts: { passed: 0, failed: 0, pending: 1, waiting: 1, total: 1 }
    })
    // It is a barrier to "passing", and a real failure still wins over it.
    expect(summarizeCheckRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }]).checks).toBe('pending')
    expect(summarizeCheckRollup([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }]).checks).toBe('failing')
  })

  it('is pending when something is queued and nothing failed', () => {
    expect(summarizeCheckRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'QUEUED' }]).checks).toBe('pending')
  })

  it('is passing when every check passed and none without checks', () => {
    expect(summarizeCheckRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]).checks).toBe('passing')
    expect(summarizeCheckRollup([])).toEqual({ checks: 'none', checkCounts: { passed: 0, failed: 0, pending: 0, waiting: 0, total: 0 } })
    expect(summarizeCheckRollup(null).checks).toBe('none')
  })
})

describe('parsePullRequestJson', () => {
  it('lowercases the state and includes the check summary and branches', () => {
    const info = parsePullRequestJson(JSON.stringify({
      number: 12, title: 'Add thing', url: 'https://github.com/a/b/pull/12', state: 'MERGED', isDraft: false,
      headRefName: 'feature', baseRefName: 'main',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]
    }))
    expect(info).toMatchObject({
      number: 12, state: 'merged', isDraft: false, headRefName: 'feature', baseRefName: 'main',
      checks: 'passing', checkCounts: { passed: 1, total: 1 }
    })
  })

  it('rejects malformed output', () => {
    expect(parsePullRequestJson('not json')).toBeNull()
    expect(parsePullRequestJson('{"number":1}')).toBeNull()
  })
})

describe('classifyPullRequestFailure and classifyGhFailure', () => {
  it('recognises gh error text', () => {
    expect(classifyPullRequestFailure('no pull requests found for branch "x"')).toBe('none')
    expect(classifyPullRequestFailure('none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`')).toBe('not-github')
    expect(classifyPullRequestFailure('To get started with GitHub CLI, please run:  gh auth login')).toBe('unauthenticated')
    expect(classifyPullRequestFailure('HTTP 502')).toBe('error')
  })

  it('also names rate limits and missing pull requests', () => {
    expect(classifyGhFailure('GraphQL: API rate limit exceeded for user ID 1.')).toBe('rate-limited')
    expect(classifyGhFailure('HTTP 403: You have exceeded a secondary rate limit')).toBe('rate-limited')
    // A rate-limit message may suggest signing in; waiting is still the answer.
    expect(classifyGhFailure('API rate limit exceeded. Authenticated requests get a higher limit: gh auth login')).toBe('rate-limited')
    expect(classifyGhFailure('GraphQL: Could not resolve to a PullRequest with the number of 9. (repository.pullRequest)')).toBe('not-found')
    expect(classifyGhFailure('gh: Not Found (HTTP 404)')).toBe('not-found')
    expect(classifyGhFailure('HTTP 502: Bad Gateway')).toBe('error')
    expect(classifyGhFailure('To get started with GitHub CLI, please run:  gh auth login')).toBe('unauthenticated')
    // Callers that only know the older four outcomes see the new ones as plain errors.
    expect(classifyPullRequestFailure('API rate limit exceeded')).toBe('error')
    expect(classifyPullRequestFailure('Could not resolve to a PullRequest')).toBe('error')
  })
})

describe('pullRequestIdentityKey', () => {
  it('ignores case in the host and repository, and tells numbers and hosts apart', () => {
    const key = pullRequestIdentityKey({ host: 'GitHub.com', nameWithOwner: 'Acme/App', number: 7 })
    expect(key).toBe(pullRequestIdentityKey({ host: 'github.com', nameWithOwner: 'acme/app', number: 7 }))
    expect(key).not.toBe(pullRequestIdentityKey({ host: 'github.com', nameWithOwner: 'acme/app', number: 8 }))
    expect(key).not.toBe(pullRequestIdentityKey({ host: 'ghe.example.com', nameWithOwner: 'acme/app', number: 7 }))
  })
})

interface Overrides {
  pr?: () => Promise<{ stdout: string; stderr: string }>
  auth?: () => Promise<{ stdout: string; stderr: string }>
  branch?: string
  defaultBranch?: string
  identity?: (cwd: string | undefined) => string
  create?: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>
  view?: () => Promise<{ stdout: string; stderr: string }>
  remotes?: string
  refs?: string
  api?: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>
}

const prJson = JSON.stringify({
  number: 3, title: 'T', url: 'https://github.com/a/b/pull/3', state: 'OPEN', isDraft: true,
  statusCheckRollup: [], headRefName: 'feature', baseRefName: 'main'
})

const runner = (overrides: Overrides = {}) =>
  vi.fn<ExecutableRunner>(async (executable, args, options) => {
    if (executable === 'git') {
      if (args[0] === 'symbolic-ref') {
        if (overrides.branch === '') throw failure('fatal')
        return ok(`${overrides.branch ?? 'feature'}\n`)
      }
      if (args[0] === 'remote') {
        return ok(overrides.remotes ?? 'origin\thttps://github.com/acme/app.git (fetch)\norigin\thttps://github.com/acme/app.git (push)\n')
      }
      if (args[0] === 'for-each-ref') return ok(overrides.refs ?? 'HEAD\nmain\nfeature\n')
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    if (args[0] === '--version') return (overrides.auth ?? (async () => ok()))()
    if (args[0] === 'repo') {
      if (args.includes('nameWithOwner,url')) return ok((overrides.identity ?? (() => identityJson()))(options?.cwd))
      return ok(`${overrides.defaultBranch ?? 'main'}\n`)
    }
    if (args[0] === 'pr' && args[1] === 'list') return (overrides.pr ?? (async () => ok(`[${prJson}]`)))()
    if (args[0] === 'pr' && args[1] === 'create') return (overrides.create ?? (async () => ok('https://github.com/acme/app/pull/3\n')))(args)
    if (args[0] === 'pr' && args[1] === 'view') return (overrides.view ?? (async () => ok(prJson)))()
    if (args[0] === 'api') return (overrides.api ?? (async () => ok('octocat\n')))(args)
    throw new Error(`unexpected ${args.join(' ')}`)
  })

const prListCalls = (run: ReturnType<typeof runner>) =>
  run.mock.calls.filter((call) => call[1][0] === 'pr' && call[1][1] === 'list')

describe('GitHubCodeHost.lookupPullRequest', () => {
  it('returns the pull request for the current branch', async () => {
    const run = runner()
    const result = await new GitHubCodeHost(run).lookupPullRequest('/repo')
    expect(result).toMatchObject({
      state: 'found',
      pullRequest: { number: 3, state: 'open', isDraft: true, checks: 'none', headRefName: 'feature', baseRefName: 'main' }
    })
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'list', '--head', 'feature', '--state', 'open', '--limit', '10', '--json', FIELDS], { cwd: '/repo' })
  })

  it('looks up the requested branch, not whatever is checked out when the lookup runs', async () => {
    const run = runner({ branch: 'other' })
    await new GitHubCodeHost(run).lookupPullRequest('/repo', 'feature-a')
    expect(run.mock.calls.some((call) => call[0] === 'git')).toBe(false)
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'list', '--head', 'feature-a', '--state', 'open', '--limit', '10', '--json', FIELDS], { cwd: '/repo' })
  })

  it('prefers an open pull request and falls back to closed or merged ones', async () => {
    const closed = JSON.stringify({ number: 9, title: 'Old', url: 'https://github.com/a/b/pull/9', state: 'MERGED', isDraft: false, statusCheckRollup: [] })
    const run = vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable === 'git') return ok('feature\n')
      if (args[0] === 'repo') return ok(identityJson())
      if (args[0] === 'pr') return ok(args.includes('open') ? '[]' : `[${closed}]`)
      return ok()
    })
    expect(await new GitHubCodeHost(run).lookupPullRequest('/repo')).toMatchObject({ state: 'found', pullRequest: { number: 9, state: 'merged' } })
    expect(run.mock.calls.filter((call) => call[1][0] === 'pr').map((call) => call[1][5])).toEqual(['open', 'all'])
  })

  it('skips a fork pull request whose branch has the same name', () => {
    const fork = JSON.stringify({ number: 12, title: 'Fork', url: 'https://github.com/x/b/pull/12', state: 'OPEN', isDraft: false, statusCheckRollup: [], isCrossRepository: true })
    const own = JSON.stringify({ number: 10, title: 'Own', url: 'https://github.com/a/b/pull/10', state: 'OPEN', isDraft: false, statusCheckRollup: [], isCrossRepository: false })
    expect(parsePullRequestList(`[${fork},${own}]`)).toMatchObject({ number: 10 })
    expect(parsePullRequestList(`[${fork}]`)).toBe('empty')
  })

  it('treats an all-digit branch as a branch, not a pull request number', async () => {
    const run = runner()
    await new GitHubCodeHost(run).lookupPullRequest('/repo', '1234')
    const call = run.mock.calls.find((entry) => entry[1][0] === 'pr')
    expect(call?.[1].slice(0, 4)).toEqual(['pr', 'list', '--head', '1234'])
  })

  it('never passes a branch that could read as a flag', async () => {
    const run = runner()
    expect(await new GitHubCodeHost(run).lookupPullRequest('/repo', '--web')).toMatchObject({ state: 'unavailable', reason: 'error' })
    expect(run.mock.calls.some((call) => call[1][0] === 'pr')).toBe(false)
  })

  it('reports no pull request and whether the branch is the default branch', async () => {
    const pr = async () => ok('[]')
    expect(await new GitHubCodeHost(runner({ pr, branch: 'main' })).lookupPullRequest('/repo')).toEqual({ state: 'none', isDefaultBranch: true })
    expect(await new GitHubCodeHost(runner({ pr, branch: 'feature' })).lookupPullRequest('/repo')).toEqual({ state: 'none', isDefaultBranch: false })
  })

  it('caches the default branch per folder', async () => {
    let now = 1_000_000
    const run = runner({ pr: async () => ok('[]') })
    const host = new GitHubCodeHost(run, () => now)
    // Forced and past the force floor, so each lookup reaches gh even though the repository's answer is fresh.
    await host.lookupPullRequest('/repo', undefined, { force: true })
    now += 5_001
    await host.lookupPullRequest('/repo', undefined, { force: true })
    const defaultBranchCalls = () => run.mock.calls.filter((call) => call[1][0] === 'repo' && call[1].includes('defaultBranchRef'))
    expect(defaultBranchCalls()).toHaveLength(1)
    now += 5_001
    await host.lookupPullRequest('/other', undefined, { force: true })
    expect(defaultBranchCalls()).toHaveLength(2)
  })

  it('reports an unknown default branch when the lookup fails', async () => {
    const run = vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable === 'git') return ok('main\n')
      if (args[0] === 'pr') return ok('[]')
      if (args[0] === 'repo' && args.includes('nameWithOwner,url')) return ok(identityJson())
      if (args[0] === 'repo') throw failure('boom')
      return ok()
    })
    expect(await new GitHubCodeHost(run).lookupPullRequest('/repo')).toEqual({ state: 'none', isDefaultBranch: null })
  })

  it('maps unavailable reasons', async () => {
    const missing = await new GitHubCodeHost(runner({ auth: async () => { throw enoent() } })).lookupPullRequest('/repo')
    expect(missing).toMatchObject({ state: 'unavailable', reason: 'gh-missing' })
    const signedOut = await new GitHubCodeHost(runner({ pr: async () => { throw failure('You are not logged into any GitHub hosts. To log in, run: gh auth login') } })).lookupPullRequest('/repo')
    expect(signedOut).toMatchObject({ state: 'unavailable', reason: 'unauthenticated' })
    const noBranch = await new GitHubCodeHost(runner({ branch: '' })).lookupPullRequest('/repo')
    expect(noBranch).toMatchObject({ state: 'unavailable', reason: 'no-branch' })
    const notGithub = await new GitHubCodeHost(runner({ pr: async () => { throw failure('none of the git remotes configured for this repository point to a known GitHub host') } })).lookupPullRequest('/repo')
    expect(notGithub).toMatchObject({ state: 'unavailable', reason: 'not-github' })
    const other = await new GitHubCodeHost(runner({ pr: async () => { throw failure('HTTP 502: Bad Gateway') } })).lookupPullRequest('/repo')
    expect(other).toMatchObject({ state: 'unavailable', reason: 'error', message: 'HTTP 502: Bad Gateway' })
    // A folder whose repository cannot be identified fails the same way.
    const unidentified = await new GitHubCodeHost(runner({ identity: () => { throw failure('none of the git remotes configured for this repository point to a known GitHub host') } })).lookupPullRequest('/repo')
    expect(unidentified).toMatchObject({ state: 'unavailable', reason: 'not-github' })
  })

  it('probes gh availability once within the cache window', async () => {
    const run = runner()
    const host = new GitHubCodeHost(run)
    await host.lookupPullRequest('/repo', undefined, { force: true })
    await host.lookupPullRequest('/repo', undefined, { force: true })
    expect(run.mock.calls.filter((call) => call[1][0] === '--version')).toHaveLength(1)
  })
})

describe('GitHubCodeHost shared read cache', () => {
  it('answers two callers with one gh call', async () => {
    const run = runner()
    const host = new GitHubCodeHost(run)
    const [first, second] = await Promise.all([host.lookupPullRequest('/repo'), host.lookupPullRequest('/repo')])
    expect(second).toBe(first)
    await host.lookupPullRequest('/repo')
    expect(prListCalls(run)).toHaveLength(1)
  })

  it('lets force join a read in flight, and only skips a value older than the force floor', async () => {
    let now = 1_000_000
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = runner({ pr: async () => { await gate; return ok(`[${prJson}]`) } })
    const host = new GitHubCodeHost(run, () => now)
    const first = host.lookupPullRequest('/repo')
    const forced = host.lookupPullRequest('/repo', undefined, { force: true })
    await vi.waitFor(() => expect(prListCalls(run)).toHaveLength(1))
    release()
    await Promise.all([first, forced])
    expect(prListCalls(run)).toHaveLength(1)
    // The value is fresh now: an ordinary call is answered, a forced one reads again once it is 5 s old.
    await host.lookupPullRequest('/repo')
    expect(prListCalls(run)).toHaveLength(1)
    now += 5_001
    await host.lookupPullRequest('/repo', undefined, { force: true })
    expect(prListCalls(run)).toHaveLength(2)
  })

  it('keeps a lookup for 30 seconds', async () => {
    let now = 1_000_000
    const run = runner()
    const host = new GitHubCodeHost(run, () => now)
    await host.lookupPullRequest('/repo')
    now += 29_999
    await host.lookupPullRequest('/repo')
    expect(prListCalls(run)).toHaveLength(1)
    now += 2
    await host.lookupPullRequest('/repo')
    expect(prListCalls(run)).toHaveLength(2)
  })

  it('does not keep a failed lookup', async () => {
    let fail = true
    const run = runner({ pr: async () => { if (fail) throw failure('HTTP 502: Bad Gateway'); return ok(`[${prJson}]`) } })
    const host = new GitHubCodeHost(run)
    expect(await host.lookupPullRequest('/repo')).toMatchObject({ state: 'unavailable', reason: 'error' })
    fail = false
    expect(await host.lookupPullRequest('/repo')).toMatchObject({ state: 'found' })
  })

  it('remembers a folder that is not on GitHub, or a signed-out host, for 30 seconds', async () => {
    let now = 1_000_000
    const run = runner({ identity: () => { throw failure('none of the git remotes point to a known GitHub host') } })
    const host = new GitHubCodeHost(run, () => now)
    expect(await host.lookupPullRequest('/repo')).toMatchObject({ state: 'unavailable', reason: 'not-github' })
    expect(await host.lookupPullRequest('/repo')).toMatchObject({ state: 'unavailable', reason: 'not-github' })
    expect(await host.viewerLogin('/repo')).toBeNull()
    const identityCalls = () => run.mock.calls.filter((call) => call[1].includes('nameWithOwner,url')).length
    expect(identityCalls()).toBe(1)
    now += 30_001
    await host.lookupPullRequest('/repo')
    expect(identityCalls()).toBe(2)
  })

  it('remembers a rate-limited or signed-out lookup briefly, and any other failure not at all', async () => {
    let now = 1_000_000
    let message = 'API rate limit exceeded for user'
    const run = runner({ pr: async () => { throw failure(message) } })
    const host = new GitHubCodeHost(run, () => now)
    expect(await host.lookupPullRequest('/repo')).toMatchObject({ state: 'unavailable', reason: 'error' })
    await host.lookupPullRequest('/repo')
    expect(prListCalls(run)).toHaveLength(1)
    now += 30_001
    message = 'HTTP 502: Bad Gateway'
    await host.lookupPullRequest('/repo')
    await host.lookupPullRequest('/repo')
    expect(prListCalls(run)).toHaveLength(3)
  })

  it('does not let force reach gh more than once every 5 seconds for one branch', async () => {
    let now = 1_000_000
    const run = runner()
    const host = new GitHubCodeHost(run, () => now)
    await host.lookupPullRequest('/repo', undefined, { force: true })
    await host.lookupPullRequest('/repo', undefined, { force: true })
    expect(prListCalls(run)).toHaveLength(1)
    now += 5_001
    await host.lookupPullRequest('/repo', undefined, { force: true })
    expect(prListCalls(run)).toHaveLength(2)
    // A new pull request is never hidden by the floor: creating one forgets earlier reads.
    await host.createPullRequest('/repo', { title: 't', body: '', base: 'main', draft: false, head: 'feature' })
    await host.lookupPullRequest('/repo', undefined, { force: true })
    expect(prListCalls(run)).toHaveLength(3)
  })

  it('shares entries between folders of one repository', async () => {
    const run = runner()
    const host = new GitHubCodeHost(run)
    await host.lookupPullRequest('/repo/main')
    await host.lookupPullRequest('/worktrees/thread-1')
    expect(prListCalls(run)).toHaveLength(1)
    expect(run.mock.calls.filter((call) => call[1].includes('nameWithOwner,url')).map((call) => call[2]?.cwd)).toEqual(['/repo/main', '/worktrees/thread-1'])
  })

  it('does not share entries between two hosts with the same owner and repository', async () => {
    const run = runner({
      identity: (cwd) => (cwd === '/enterprise' ? identityJson('https://ghe.example.com/acme/app') : identityJson())
    })
    const host = new GitHubCodeHost(run)
    await host.lookupPullRequest('/public')
    await host.lookupPullRequest('/enterprise')
    expect(prListCalls(run)).toHaveLength(2)
  })

  it('never reuses a cached "no pull request" answer for a forced lookup, but still joins a read in flight', async () => {
    let listed = '[]'
    const run = runner({ pr: async () => ok(listed) })
    const host = new GitHubCodeHost(run, () => 1_000_000)
    expect(await host.lookupPullRequest('/repo')).toMatchObject({ state: 'none' })
    // Another client opens the pull request; the clock has not moved, so the miss is far younger than the 5 second floor.
    listed = `[${prJson}]`
    expect(await host.lookupPullRequest('/repo')).toMatchObject({ state: 'none' })
    expect(await host.lookupPullRequest('/repo', undefined, { force: true })).toMatchObject({ state: 'found' })
    expect(prListCalls(run).length).toBeGreaterThan(1)
  })

  it('keeps a branch separate from other branches of the repository', async () => {
    const run = runner()
    const host = new GitHubCodeHost(run)
    await host.lookupPullRequest('/repo', 'one')
    await host.lookupPullRequest('/repo', 'two')
    expect(prListCalls(run)).toHaveLength(2)
  })
})

describe('GitHubCodeHost.repositoryIdentity', () => {
  it('reads host and repository from an https URL and from an Enterprise Server URL', async () => {
    const host = new GitHubCodeHost(runner({
      identity: (cwd) => (cwd === '/enterprise' ? identityJson('https://ghe.example.com/acme/app', 'acme/app') : identityJson('https://github.com/Acme/App', 'Acme/App'))
    }))
    expect(await host.repositoryIdentity('/public')).toEqual({ host: 'github.com', nameWithOwner: 'Acme/App' })
    expect(await host.repositoryIdentity('/enterprise')).toEqual({ host: 'ghe.example.com', nameWithOwner: 'acme/app' })
  })

  it('caches the answer for 10 minutes per folder', async () => {
    let now = 5_000_000
    const run = runner()
    const host = new GitHubCodeHost(run, () => now)
    const identityCalls = () => run.mock.calls.filter((call) => call[1].includes('nameWithOwner,url'))
    await host.repositoryIdentity('/repo')
    now += 10 * 60_000 - 1
    await host.repositoryIdentity('/repo')
    expect(identityCalls()).toHaveLength(1)
    now += 2
    await host.repositoryIdentity('/repo')
    expect(identityCalls()).toHaveLength(2)
  })

  it('rejects output it cannot read', async () => {
    await expect(new GitHubCodeHost(runner({ identity: () => 'nope' })).repositoryIdentity('/repo')).rejects.toThrow('unexpected repository response')
    expect(parseRepositoryIdentity('{"nameWithOwner":"acme/app","url":"not a url"}')).toBeNull()
    expect(parseRepositoryIdentity('{"nameWithOwner":"acme","url":"https://github.com/acme"}')).toBeNull()
  })
})

describe('remote URLs', () => {
  it.each([
    ['https://github.com/acme/app.git', 'github.com', 'acme/app'],
    ['https://github.com/acme/app', 'github.com', 'acme/app'],
    ['git@github.com:acme/app.git', 'github.com', 'acme/app'],
    ['ssh://git@github.com/acme/app.git', 'github.com', 'acme/app'],
    ['ssh://git@ghe.example.com:2222/acme/app.git', 'ghe.example.com', 'acme/app'],
    ['https://ghe.example.com/acme/app/', 'ghe.example.com', 'acme/app']
  ])('reads %s', (url, host, nameWithOwner) => {
    expect(parseRemoteUrl(url)).toEqual({ host, nameWithOwner })
  })

  it.each(['/srv/git/app.git', 'C:\\work\\app', 'https://github.com/acme', 'https://github.com/a/b/c'])('does not read %s as a repository', (url) => {
    expect(parseRemoteUrl(url)).toBeNull()
  })

  it('picks the remote that points at the repository, whatever the scheme or case', () => {
    const remotes = parseRemotes([
      'origin\tgit@github.com:me/app.git (fetch)',
      'origin\tgit@github.com:me/app.git (push)',
      'upstream\thttps://github.com/Acme/App.git (fetch)',
      'upstream\thttps://github.com/Acme/App.git (push)'
    ].join('\n'))
    expect(remotes).toEqual([
      { name: 'origin', url: 'git@github.com:me/app.git' },
      { name: 'upstream', url: 'https://github.com/Acme/App.git' }
    ])
    expect(remoteForIdentity(remotes, { host: 'github.com', nameWithOwner: 'acme/app' })).toBe('upstream')
    expect(remoteForIdentity(remotes, { host: 'ghe.example.com', nameWithOwner: 'acme/app' })).toBeNull()
  })
})

describe('GitHubCodeHost.createPullRequest', () => {
  const input = { title: ' Add a thing ', body: 'Why\n\n- one', base: 'main', draft: false, head: 'feature' }
  const bodyFileOf = (args: readonly string[]) => (args.find((arg) => arg.startsWith('--body-file=')) ?? '').slice('--body-file='.length)

  it('creates through a body file, parses the number from the URL and reads the pull request back by number', async () => {
    let bodyFile = ''
    let written = ''
    const run = runner({
      create: async (args) => {
        bodyFile = bodyFileOf(args)
        written = readFileSync(bodyFile, 'utf8')
        return ok('Creating pull request for feature into main in acme/app\n\nhttps://github.com/acme/app/pull/41\n')
      },
      view: async () => ok(JSON.stringify({ number: 41, title: 'Add a thing', url: 'https://github.com/acme/app/pull/41', state: 'OPEN', isDraft: false, statusCheckRollup: [] }))
    })
    const created = await new GitHubCodeHost(run).createPullRequest('/repo', { ...input, head: 'feature' })
    expect(created).toMatchObject({ number: 41, title: 'Add a thing', state: 'open' })
    const create = run.mock.calls.find((call) => call[1][1] === 'create')
    expect(create?.[1]).toEqual(['pr', 'create', '--title=Add a thing', `--body-file=${bodyFile}`, '--base=main', '--head=feature'])
    expect(create?.[2]).toEqual({ cwd: '/repo' })
    expect(written).toBe('Why\n\n- one')
    expect(existsSync(bodyFile)).toBe(false)
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'view', '41', '--json', FIELDS], { cwd: '/repo' })
  })

  it('passes --draft only for a draft', async () => {
    const run = runner()
    await new GitHubCodeHost(run).createPullRequest('/repo', input)
    await new GitHubCodeHost(run).createPullRequest('/repo', { ...input, draft: true })
    const creates = run.mock.calls.filter((call) => call[1][1] === 'create').map((call) => call[1])
    expect(creates[0]).not.toContain('--draft')
    expect(creates[1]).toContain('--draft')
  })

  it('binds every value to its flag, so a value that looks like a flag stays a value', async () => {
    const run = runner()
    await new GitHubCodeHost(run).createPullRequest('/repo', { ...input, title: '--web' })
    const args = run.mock.calls.find((call) => call[1][1] === 'create')?.[1] ?? []
    expect(args[2]).toBe('--title=--web')
    // Every argument after `pr create` is one self-contained `--flag=value`.
    expect(args.slice(2).every((arg) => /^--[a-z-]+=/.test(arg))).toBe(true)
  })

  it('removes the body file when gh fails', async () => {
    let bodyFile = ''
    const run = runner({ create: async (args) => { bodyFile = bodyFileOf(args); throw failure('boom') } })
    await expect(new GitHubCodeHost(run).createPullRequest('/repo', input)).rejects.toThrow('boom')
    expect(bodyFile).not.toBe('')
    expect(existsSync(bodyFile)).toBe(false)
  })

  it('reports a create that printed no pull request URL, with what gh printed', async () => {
    const run = runner({ create: async () => ({ stdout: 'something odd\n', stderr: 'warning: x' }) })
    const error = await new GitHubCodeHost(run).createPullRequest('/repo', input).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('GitHub CLI did not report the new pull request')
    expect(error).toMatchObject({ stdout: 'something odd\n', stderr: 'warning: x' })
  })

  it('says so when the branch already has a pull request, and passes other errors on verbatim', async () => {
    const exists = runner({ create: async () => { throw failure('a pull request for branch "feature" into branch "main" already exists:\nhttps://github.com/acme/app/pull/3') } })
    await expect(new GitHubCodeHost(exists).createPullRequest('/repo', input)).rejects.toMatchObject({ message: 'A pull request for this branch already exists.', code: PULL_REQUEST_EXISTS })
    const other = runner({ create: async () => { throw failure('GraphQL: Head sha can\'t be blank, Base sha can\'t be blank (createPullRequest)') } })
    await expect(new GitHubCodeHost(other).createPullRequest('/repo', input)).rejects.toThrow('GraphQL: Head sha can\'t be blank, Base sha can\'t be blank (createPullRequest)')
    const missing = runner({ create: async () => { throw enoent() } })
    await expect(new GitHubCodeHost(missing).createPullRequest('/repo', input)).rejects.toThrow('GitHub CLI (gh) was not found')
  })

  it('still returns the pull request when it cannot be read back', async () => {
    const run = runner({ view: async () => { throw failure('HTTP 502') } })
    expect(await new GitHubCodeHost(run).createPullRequest('/repo', { ...input, head: 'feature', draft: true })).toMatchObject({
      number: 3, title: 'Add a thing', url: 'https://github.com/acme/app/pull/3', state: 'open', isDraft: true,
      headRefName: 'feature', baseRefName: 'main', checks: 'none'
    })
  })

  it('validates before running anything', async () => {
    const run = runner()
    const host = new GitHubCodeHost(run)
    await expect(host.createPullRequest('/repo', { ...input, title: '   ' })).rejects.toThrow('1–256')
    await expect(host.createPullRequest('/repo', { ...input, title: 'x'.repeat(257) })).rejects.toThrow('1–256')
    await expect(host.createPullRequest('/repo', { ...input, base: '--web' })).rejects.toThrow('Unsupported branch name')
    await expect(host.createPullRequest('/repo', { ...input, head: '-x' })).rejects.toThrow('Unsupported branch name')
    await expect(host.createPullRequest('/repo', { ...input, head: '' })).rejects.toThrow('Name the branch')
    await expect(host.createPullRequest('/repo', { ...input, head: '  ' })).rejects.toThrow('Name the branch')
    await expect(host.createPullRequest('/repo', { ...input, base: ' ' })).rejects.toThrow('base branch')
    expect(run).not.toHaveBeenCalled()
    await host.createPullRequest('/repo', { ...input, title: 'x'.repeat(256) })
  })

  it('forgets earlier lookups of the repository, so the new pull request is found', async () => {
    let listed = '[]'
    const run = runner({ pr: async () => ok(listed) })
    const host = new GitHubCodeHost(run)
    expect(await host.lookupPullRequest('/repo')).toMatchObject({ state: 'none' })
    listed = `[${prJson}]`
    await host.createPullRequest('/repo', input)
    expect(await host.lookupPullRequest('/repo')).toMatchObject({ state: 'found' })
  })
})

describe('GitHubCodeHost.listBaseBranches', () => {
  it('lists the branches of the remote that is the repository, default first, without HEAD', async () => {
    const run = runner({
      defaultBranch: 'main',
      remotes: [
        'origin\tgit@github.com:me/app.git (fetch)',
        'origin\tgit@github.com:me/app.git (push)',
        'upstream\thttps://github.com/acme/app.git (fetch)',
        'upstream\thttps://github.com/acme/app.git (push)'
      ].join('\n'),
      refs: 'HEAD\nfeature/x\nmain\nrelease\n'
    })
    expect(await new GitHubCodeHost(run).listBaseBranches('/repo')).toEqual({
      defaultBranch: 'main',
      branches: ['main', 'feature/x', 'release']
    })
    expect(run).toHaveBeenCalledWith('git', ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/upstream'], { cwd: '/repo' })
  })

  it('puts the default branch first even when it was never fetched', async () => {
    const run = runner({ defaultBranch: 'trunk', refs: 'HEAD\nfeature\n' })
    expect(await new GitHubCodeHost(run).listBaseBranches('/repo')).toEqual({ defaultBranch: 'trunk', branches: ['trunk', 'feature'] })
  })

  it('falls back to origin, then to the only remote, when no remote matches', async () => {
    const elsewhere = 'origin\thttps://example.com/other/thing.git (fetch)\nmirror\thttps://example.com/mirror.git (fetch)\n'
    const withOrigin = runner({ remotes: elsewhere })
    await new GitHubCodeHost(withOrigin).listBaseBranches('/repo')
    expect(withOrigin).toHaveBeenCalledWith('git', ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'], { cwd: '/repo' })
    const single = runner({ remotes: 'mirror\thttps://example.com/mirror.git (fetch)\n' })
    await new GitHubCodeHost(single).listBaseBranches('/repo')
    expect(single).toHaveBeenCalledWith('git', ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/mirror'], { cwd: '/repo' })
  })

  it('lists no branches when no remote can be chosen, and keeps an unknown default branch null', async () => {
    const run = vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable === 'git') return ok(args[0] === 'remote' ? 'a\thttps://example.com/a.git (fetch)\nb\thttps://example.com/b.git (fetch)\n' : '')
      if (args.includes('nameWithOwner,url')) return ok(identityJson())
      throw failure('boom')
    })
    expect(await new GitHubCodeHost(run).listBaseBranches('/repo')).toEqual({ defaultBranch: null, branches: [] })
    expect(run.mock.calls.some((call) => call[1][0] === 'for-each-ref')).toBe(false)
  })
})

describe('GitHubCodeHost.remoteForRepository', () => {
  it('names the remote that points at the repository, else origin, else the only remote', async () => {
    const both = [
      'origin\tgit@github.com:me/app.git (fetch)',
      'upstream\thttps://github.com/acme/app.git (fetch)'
    ].join('\n')
    expect(await new GitHubCodeHost(runner({ remotes: both })).remoteForRepository('/repo')).toBe('upstream')
    expect(await new GitHubCodeHost(runner({ remotes: 'origin\thttps://example.com/x.git (fetch)\nb\thttps://example.com/y.git (fetch)' })).remoteForRepository('/repo')).toBe('origin')
    expect(await new GitHubCodeHost(runner({ remotes: 'mirror\thttps://example.com/y.git (fetch)' })).remoteForRepository('/repo')).toBe('mirror')
    expect(await new GitHubCodeHost(runner({ remotes: '' })).remoteForRepository('/repo')).toBeNull()
  })
})

describe('GitHubCodeHost.viewerLogin', () => {
  it('asks the repository\'s own host', async () => {
    const run = runner({ identity: () => identityJson('https://ghe.example.com/acme/app') })
    expect(await new GitHubCodeHost(run).viewerLogin('/repo')).toBe('octocat')
    expect(run).toHaveBeenCalledWith('gh', ['api', '--hostname', 'ghe.example.com', 'user', '--jq', '.login'], { cwd: '/repo' })
  })

  it('caches the login per host for 10 minutes', async () => {
    let now = 9_000_000
    const run = runner({
      identity: (cwd) => (cwd === '/enterprise' ? identityJson('https://ghe.example.com/acme/app') : identityJson())
    })
    const host = new GitHubCodeHost(run, () => now)
    const apiCalls = () => run.mock.calls.filter((call) => call[1][0] === 'api')
    await host.viewerLogin('/a')
    await host.viewerLogin('/b')
    expect(apiCalls()).toHaveLength(1)
    await host.viewerLogin('/enterprise')
    expect(apiCalls()).toHaveLength(2)
    now += 10 * 60_000 + 1
    await host.viewerLogin('/a')
    expect(apiCalls()).toHaveLength(3)
  })

  it('is null when the login cannot be read, and tries again next time', async () => {
    let fail = true
    const run = runner({ api: async () => { if (fail) throw failure('HTTP 502: Bad Gateway'); return ok('octocat\n') } })
    const host = new GitHubCodeHost(run)
    expect(await host.viewerLogin('/repo')).toBeNull()
    fail = false
    expect(await host.viewerLogin('/repo')).toBe('octocat')
  })
})

describe('removeTempFolder', () => {
  it('retries and then gives up quietly, so a created pull request is never turned into an error', async () => {
    const remove = vi.fn(async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) })
    await expect(removeTempFolder('/tmp/x', remove as never)).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledWith('/tmp/x', expect.objectContaining({ recursive: true, force: true, maxRetries: 3 }))
  })
})

describe('GitHubCodeHost caches', () => {
  it('keeps a bounded number of lookups, oldest first out', async () => {
    const run = runner()
    const host = new GitHubCodeHost(run)
    for (let index = 0; index < 520; index++) await host.lookupPullRequest('/repo', `branch-${index}`)
    expect(prListCalls(run)).toHaveLength(520)
    // The newest branches are still answered from memory; the first ones were let go.
    await host.lookupPullRequest('/repo', 'branch-519')
    expect(prListCalls(run)).toHaveLength(520)
    await host.lookupPullRequest('/repo', 'branch-0')
    expect(prListCalls(run)).toHaveLength(521)
  })
})

describe('createGhFallbackRunner', () => {
  it('retries Homebrew locations after ENOENT and remembers the one that worked', async () => {
    const base = vi.fn<ExecutableRunner>(async (executable) => {
      if (executable === '/usr/local/bin/gh') return ok('done')
      throw enoent()
    })
    const run = createGhFallbackRunner(base, 'darwin')
    await expect(run('gh', ['--version'])).resolves.toEqual(ok('done'))
    expect(base.mock.calls.map((call) => call[0])).toEqual(['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'])
    base.mockClear()
    await run('gh', ['auth', 'status'])
    expect(base.mock.calls.map((call) => call[0])).toEqual(['/usr/local/bin/gh'])
  })

  it('rethrows the original error when no fallback exists, and skips fallbacks on Windows or for other commands', async () => {
    const base = vi.fn<ExecutableRunner>(async () => { throw enoent() })
    await expect(createGhFallbackRunner(base, 'darwin')('gh', [])).rejects.toMatchObject({ code: 'ENOENT' })
    base.mockClear()
    await expect(createGhFallbackRunner(base, 'win32')('gh', [])).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(createGhFallbackRunner(base, 'darwin')('git', [])).rejects.toMatchObject({ code: 'ENOENT' })
    expect(base.mock.calls.map((call) => call[0])).toEqual(['gh', 'git'])
  })

  it('does not retry when gh runs but fails', async () => {
    const base = vi.fn<ExecutableRunner>(async () => { throw failure('not logged in') })
    await expect(createGhFallbackRunner(base, 'darwin')('gh', [])).rejects.toThrow('exit 1')
    expect(base).toHaveBeenCalledTimes(1)
  })
})

describe('parsePullRequestList', () => {
  it('returns the newest pull request, empty for none, and null for unreadable output', () => {
    expect(parsePullRequestList('[]')).toBe('empty')
    expect(parsePullRequestList('[{"number":7,"title":"T","url":"https://github.com/a/b/pull/7","state":"MERGED","isDraft":false,"statusCheckRollup":[]}]')).toMatchObject({ number: 7, state: 'merged' })
    expect(parsePullRequestList('{"number":7}')).toBeNull()
    expect(parsePullRequestList('nope')).toBeNull()
  })
})

describe('parsePullRequestReference', () => {
  it.each([
    ['123', { number: 123 }],
    ['  #45  ', { number: 45 }],
    ['gh pr checkout 77', { number: 77 }],
    ['gh pr checkout #8', { number: 8 }],
    ['https://github.com/acme/app/pull/12', { number: 12, host: 'github.com', nameWithOwner: 'acme/app' }],
    ['https://github.com/acme/app/pull/12/files', { number: 12, host: 'github.com', nameWithOwner: 'acme/app' }],
    ['https://github.com/acme/app/pull/12#issuecomment-1', { number: 12, host: 'github.com', nameWithOwner: 'acme/app' }],
    ['https://GitHub.com/Acme/App/pull/12?diff=split', { number: 12, host: 'github.com', nameWithOwner: 'Acme/App' }],
    ['https://ghe.example.com/acme/app/pull/3', { number: 3, host: 'ghe.example.com', nameWithOwner: 'acme/app' }],
    ['https://ghe.example.com:8443/acme/app/pull/3', { number: 3, host: 'ghe.example.com:8443', nameWithOwner: 'acme/app' }],
    ['gh pr checkout https://github.com/acme/app/pull/9', { number: 9, host: 'github.com', nameWithOwner: 'acme/app' }]
  ])('reads %j', (text, expected) => {
    expect(parsePullRequestReference(text)).toEqual(expected)
  })

  it.each([
    '',
    '   ',
    '0',
    '#0',
    '-1',
    '1.5',
    '007x',
    '1234567890123456',
    'feature-branch',
    'gh pr checkout feature-branch',
    'gh pr checkout 12 --force',
    'gh pr view 12',
    'https://github.com/acme/app/issues/12',
    'https://github.com/acme/app/pull/0',
    'https://github.com/acme/app/pull/abc',
    'https://github.com/acme/app/pull/-4',
    'https://github.com/acme/pull/12',
    'https://github.com/acme/app/pulls/12',
    'https://github.com//app/pull/12',
    'https://user:secret@github.com/acme/app/pull/12',
    'ftp://github.com/acme/app/pull/12',
    'javascript:alert(1)//acme/app/pull/12',
    'github.com/acme/app/pull/12',
    `https://github.com/acme/app/pull/${'1'.repeat(3000)}`
  ])('refuses %j', (text) => {
    expect(parsePullRequestReference(text)).toBeNull()
  })
})

describe('pullRequestReferenceMismatch', () => {
  const identity = { host: 'github.com', nameWithOwner: 'acme/app' }

  it('accepts a bare number and a URL of the same host and repository, whatever the case', () => {
    expect(pullRequestReferenceMismatch({ number: 4 }, identity)).toBeNull()
    expect(pullRequestReferenceMismatch({ number: 4, host: 'github.com', nameWithOwner: 'acme/app' }, identity)).toBeNull()
    expect(pullRequestReferenceMismatch({ number: 4, host: 'github.com', nameWithOwner: 'Acme/App' }, { host: 'GitHub.com', nameWithOwner: 'acme/app' })).toBeNull()
  })

  it('refuses another repository and another host, naming both', () => {
    expect(pullRequestReferenceMismatch({ number: 4, host: 'github.com', nameWithOwner: 'other/app' }, identity))
      .toBe("That pull request belongs to github.com/other/app, not this project's repository (github.com/acme/app).")
    expect(pullRequestReferenceMismatch({ number: 4, host: 'ghe.example.com', nameWithOwner: 'acme/app' }, identity)).toMatch(/ghe\.example\.com\/acme\/app/)
    // A look-alike host is another host.
    expect(pullRequestReferenceMismatch({ number: 4, host: 'github.com.evil.example', nameWithOwner: 'acme/app' }, identity)).not.toBeNull()
    expect(pullRequestReferenceMismatch({ number: 4, host: 'github.com:8443', nameWithOwner: 'acme/app' }, identity)).not.toBeNull()
  })
})

describe('GitHubCodeHost.listPullRequests', () => {
  const rows = JSON.stringify([
    { number: 3, title: 'Old', url: 'https://github.com/acme/app/pull/3', state: 'OPEN', isDraft: false, author: { login: 'ann' }, headRefName: 'old', isCrossRepository: false, updatedAt: '2026-10-01T10:00:00Z' },
    { number: 9, title: 'New', url: 'https://github.com/acme/app/pull/9', state: 'OPEN', isDraft: true, author: { login: 'bob' }, headRefName: 'new', headRepositoryOwner: { login: 'bob' }, isCrossRepository: true, updatedAt: '2026-10-20T10:00:00Z' },
    { number: 5, title: 'Merged', url: 'https://github.com/acme/app/pull/5', state: 'MERGED', isDraft: false, author: { login: 'cy' }, headRefName: 'm', isCrossRepository: false, updatedAt: '2026-10-25T10:00:00Z' },
    { number: 'x', title: 'Broken' }
  ])

  const listRunner = (list: () => Promise<{ stdout: string; stderr: string }> = async () => ok(rows)) =>
    vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable === 'git') throw new Error(`unexpected git ${args.join(' ')}`)
      if (args[0] === '--version') return ok()
      if (args[0] === 'repo') return ok(identityJson())
      if (args[0] === 'pr' && args[1] === 'list') return list()
      throw new Error(`unexpected ${args.join(' ')}`)
    })

  it('lists the open pull requests, most recently updated first', async () => {
    const run = listRunner()
    const items = await new GitHubCodeHost(run).listPullRequests('/repo')
    expect(items.map((item) => item.number)).toEqual([9, 3])
    expect(items[0]).toEqual({
      number: 9, title: 'New', url: 'https://github.com/acme/app/pull/9', isDraft: true, author: 'bob',
      headRefName: 'new', isCrossRepository: true, updatedAt: '2026-10-20T10:00:00Z'
    })
    expect(run).toHaveBeenCalledWith(
      'gh',
      ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url,state,isDraft,author,headRefName,headRepositoryOwner,isCrossRepository,updatedAt'],
      { cwd: '/repo' }
    )
  })

  it('bounds the limit and shares one read between callers', async () => {
    const run = listRunner()
    const host = new GitHubCodeHost(run)
    await Promise.all([host.listPullRequests('/repo', { limit: 10_000 }), host.listPullRequests('/other-folder', { limit: 10_000 })])
    const calls = run.mock.calls.filter((call) => call[1][0] === 'pr')
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toContain('200')
  })

  it('names why the list could not be read', async () => {
    await expect(new GitHubCodeHost(listRunner(async () => { throw failure('To get started with GitHub CLI, please run:  gh auth login') })).listPullRequests('/repo'))
      .rejects.toMatchObject({ kind: 'unauthenticated' })
    await expect(new GitHubCodeHost(listRunner(async () => ok('nope'))).listPullRequests('/repo')).rejects.toMatchObject({ kind: 'error' })
    await expect(new GitHubCodeHost(vi.fn<ExecutableRunner>(async () => { throw enoent() })).listPullRequests('/repo')).rejects.toMatchObject({ kind: 'gh-missing' })
  })
})

describe('GitHubCodeHost.remoteForRepository with a repository', () => {
  const base = { host: 'github.com', nameWithOwner: 'acme/app' }
  const remotesRunner = (remotes: string) =>
    vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable === 'git' && args[0] === 'remote') return ok(remotes)
      if (args[0] === 'repo') return ok(identityJson('https://github.com/me/app', 'me/app'))
      throw new Error(`unexpected ${executable} ${args.join(' ')}`)
    })

  it('picks the remote whose URL is that repository, not the fork the folder resolves to', async () => {
    const remotes = ['origin\tgit@github.com:me/app.git (fetch)', 'upstream\thttps://github.com/acme/app.git (fetch)'].join('\n')
    expect(await new GitHubCodeHost(remotesRunner(remotes)).remoteForRepository('/repo', base)).toBe('upstream')
  })

  it('matches https, ssh and scp URLs, with or without .git, ignoring case', async () => {
    for (const url of ['https://github.com/Acme/App.git', 'git@github.com:acme/app', 'ssh://git@github.com/acme/app.git', 'https://github.com/acme/app/']) {
      expect(await new GitHubCodeHost(remotesRunner(`mirror\t${url} (fetch)`)).remoteForRepository('/repo', base)).toBe('mirror')
    }
  })

  it('never falls back to origin or the only remote', async () => {
    expect(await new GitHubCodeHost(remotesRunner('origin\tgit@github.com:me/app.git (fetch)')).remoteForRepository('/repo', base)).toBeNull()
    expect(await new GitHubCodeHost(remotesRunner('origin\thttps://ghe.example.com/acme/app.git (fetch)')).remoteForRepository('/repo', base)).toBeNull()
    expect(await new GitHubCodeHost(remotesRunner('origin\t/srv/git/app.git (fetch)')).remoteForRepository('/repo', base)).toBeNull()
    expect(await new GitHubCodeHost(remotesRunner('')).remoteForRepository('/repo', base)).toBeNull()
  })
})

describe('GitHubCodeHost.fetchPullRequestHead', () => {
  const SHA = 'a'.repeat(40)
  const pullRequest = { host: 'github.com', nameWithOwner: 'acme/app', number: 7 }
  const fetchRunner = (overrides: { remotes?: string; fetch?: () => Promise<{ stdout: string; stderr: string }>; revParse?: string } = {}) =>
    vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable !== 'git') throw new Error(`unexpected ${executable}`)
      if (args[0] === 'remote') return ok(overrides.remotes ?? 'origin\tgit@github.com:me/app.git (fetch)\nupstream\thttps://github.com/acme/app.git (fetch)\n')
      if (args.includes('fetch')) return (overrides.fetch ?? (async () => ok()))()
      if (args[0] === 'rev-parse') return ok(overrides.revParse ?? `${SHA}\n`)
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

  it('fetches refs/pull/<n>/head from the remote that is the base repository into a ref of its own', async () => {
    const run = fetchRunner()
    expect(await new GitHubCodeHost(run).fetchPullRequestHead('/repo', pullRequest)).toBe(SHA)
    const fetch = run.mock.calls.find((call) => call[1].includes('fetch'))!
    expect(fetch[1]).toEqual(['-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', 'upstream', '+refs/pull/7/head:refs/mousse/pull/7/head'])
    expect(fetch[2]).toEqual({ cwd: '/repo', env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 5 * 60_000 })
    expect(run).toHaveBeenCalledWith('git', ['rev-parse', '--verify', '--quiet', 'refs/mousse/pull/7/head^{commit}'], { cwd: '/repo' })
    // No remote is added and no branch is created.
    expect(run.mock.calls.some((call) => call[1][0] === 'remote' && call[1][1] === 'add')).toBe(false)
  })

  it("refuses when no remote is the pull request's repository, without fetching", async () => {
    const run = fetchRunner({ remotes: 'origin\tgit@github.com:me/app.git (fetch)\n' })
    await expect(new GitHubCodeHost(run).fetchPullRequestHead('/repo', pullRequest))
      .rejects.toThrow("No remote of this checkout points at github.com/acme/app, the pull request's repository. (A remote that reaches it through an SSH host alias is not recognised")
    expect(run.mock.calls.some((call) => call[1].includes('fetch'))).toBe(false)
  })

  it("carries the ref, the remote and Git's own words when the fetch fails", async () => {
    const run = fetchRunner({ fetch: async () => { throw failure("fatal: couldn't find remote ref refs/pull/7/head") } })
    await expect(new GitHubCodeHost(run).fetchPullRequestHead('/repo', pullRequest))
      .rejects.toThrow("Could not fetch refs/pull/7/head from upstream (github.com/acme/app): fatal: couldn't find remote ref refs/pull/7/head")
  })

  it('refuses an unusable number, a remote name that reads as an option, and a ref that is not a commit', async () => {
    const run = fetchRunner()
    await expect(new GitHubCodeHost(run).fetchPullRequestHead('/repo', { ...pullRequest, number: 0 })).rejects.toThrow(/Unsupported pull request number/)
    await expect(new GitHubCodeHost(run).fetchPullRequestHead('/repo', { ...pullRequest, number: 1.5 })).rejects.toThrow(/Unsupported pull request number/)
    const dashed = fetchRunner({ remotes: '--upload-pack=x\thttps://github.com/acme/app.git (fetch)\n' })
    await expect(new GitHubCodeHost(dashed).fetchPullRequestHead('/repo', pullRequest)).rejects.toThrow(/cannot be used/)
    expect(dashed.mock.calls.some((call) => call[1].includes('fetch'))).toBe(false)
    await expect(new GitHubCodeHost(fetchRunner({ revParse: '' })).fetchPullRequestHead('/repo', pullRequest)).rejects.toThrow(/did not produce a commit/)
  })
})

describe('GitHubCodeHost fetch failures and the fetched ref', () => {
  const SHA = 'c'.repeat(40)
  const pullRequest = { host: 'github.com', nameWithOwner: 'acme/app', number: 7 }
  const remotes = 'upstream\thttps://github.com/acme/app.git (fetch)\n'

  const failing = (error: unknown) =>
    vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable === 'git' && args[0] === 'remote') return ok(remotes)
      if (args.includes('fetch')) throw error
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

  it('tells a fetch that was stopped for taking too long from one that failed', async () => {
    const killed = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', stderr: '' })
    await expect(new GitHubCodeHost(failing(killed)).fetchPullRequestHead('/repo', pullRequest)).rejects.toThrow('The fetch did not finish in 5 minutes and was stopped')
  })

  it.each([
    'error: object 1234: zeroPaddedFilemode: contains zero-padded file modes\nfatal: fsck error in packed object',
    'fatal: bad object refs/pull/7/head',
    'error: object abc: badTimezone: invalid author/committer line - bad time zone'
  ])('explains an object Git rejected as malformed: %s', async (message) => {
    await expect(new GitHubCodeHost(failing(failure(message))).fetchPullRequestHead('/repo', pullRequest))
      .rejects.toThrow('Git rejected objects in this pull request as malformed')
  })

  it("leaves other failures in Git's own words", async () => {
    const error = await new GitHubCodeHost(failing(failure('fatal: unable to access: Could not resolve host'))).fetchPullRequestHead('/repo', pullRequest).catch((e: Error) => e)
    expect((error as Error).message).toBe('Could not fetch refs/pull/7/head from upstream (github.com/acme/app): fatal: unable to access: Could not resolve host')
  })

  it('releases the fetched ref only while it still holds the commit, and never throws', async () => {
    const run = vi.fn<ExecutableRunner>(async () => ok())
    await new GitHubCodeHost(run).releasePullRequestHead('/repo', pullRequest, SHA)
    expect(run).toHaveBeenCalledWith('git', ['update-ref', '-d', 'refs/mousse/pull/7/head', SHA], { cwd: '/repo' })
    run.mockClear()
    await new GitHubCodeHost(vi.fn<ExecutableRunner>(async () => { throw failure('cannot lock ref') })).releasePullRequestHead('/repo', pullRequest, SHA)
    await new GitHubCodeHost(run).releasePullRequestHead('/repo', pullRequest, 'not a sha')
    await new GitHubCodeHost(run).releasePullRequestHead('/repo', { ...pullRequest, number: 0 }, SHA)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('remoteForRepository with push URLs', () => {
  const base = { host: 'github.com', nameWithOwner: 'acme/app' }
  const listing = (...lines: string[]) => lines.join('\n')
  const runnerFor = (output: string) =>
    vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable === 'git' && args[0] === 'remote') return ok(output)
      throw new Error('unexpected')
    })
  const ask = (output: string) => new GitHubCodeHost(runnerFor(output)).remoteForRepository('/repo', base, { push: true })

  it('reads the push URLs of every remote, pushurl and rewrites included', () => {
    expect(parsePushUrls(listing('a\thttps://x/y/z (fetch)', 'a\thttps://p/q/r (push)', 'a\thttps://p2/q/r (push)', 'b\tgit@h:o/r (fetch)', 'b\tgit@h:o/r (push)')))
      .toEqual(new Map([['a', ['https://p/q/r', 'https://p2/q/r']], ['b', ['git@h:o/r']]]))
  })

  it('accepts a remote that fetches from and pushes to the repository', async () => {
    expect(await ask(listing('upstream\thttps://github.com/acme/app.git (fetch)', 'upstream\tgit@github.com:acme/app.git (push)'))).toBe('upstream')
  })

  it('refuses a remote that fetches from the repository but pushes elsewhere, with one push URL or several', async () => {
    expect(await ask(listing('upstream\thttps://github.com/acme/app.git (fetch)', 'upstream\tDISABLED (push)'))).toBeNull()
    expect(await ask(listing('upstream\thttps://github.com/acme/app.git (fetch)', 'upstream\thttps://github.com/me/app.git (push)'))).toBeNull()
    expect(await ask(listing('upstream\thttps://github.com/acme/app.git (fetch)', 'upstream\thttps://github.com/acme/app.git (push)', 'upstream\thttps://github.com/me/app.git (push)'))).toBeNull()
    expect(await ask(listing('upstream\thttps://github.com/acme/app.git (fetch)'))).toBeNull()
  })

  it('falls to the next remote that does match on both sides, and ignores push URLs for a fetch-only question', async () => {
    const output = listing(
      'origin\thttps://github.com/acme/app.git (fetch)', 'origin\tDISABLED (push)',
      'mirror\thttps://github.com/acme/app.git (fetch)', 'mirror\thttps://github.com/acme/app.git (push)'
    )
    expect(await ask(output)).toBe('mirror')
    expect(await new GitHubCodeHost(runnerFor(output)).remoteForRepository('/repo', base)).toBe('origin')
  })
})
