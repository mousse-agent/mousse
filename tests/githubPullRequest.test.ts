import { describe, expect, it, vi } from 'vitest'
import {
  classifyPullRequestFailure,
  createGhFallbackRunner,
  GitHubService,
  parsePullRequestJson,
  parsePullRequestList,
  summarizeCheckRollup,
  type ExecutableRunner
} from '../src/mms/git/GitHubService'

const enoent = () => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
const failure = (stderr: string) => Object.assign(new Error('exit 1'), { stderr })
const ok = (stdout = '') => ({ stdout, stderr: '' })

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
    expect(summary.checkCounts).toEqual({ passed: 4, failed: 2, pending: 3, total: 9 })
    expect(summary.checks).toBe('failing')
  })

  it.each(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])('treats %s as failed', (conclusion) => {
    expect(summarizeCheckRollup([{ status: 'COMPLETED', conclusion }]).checks).toBe('failing')
  })

  it('is pending when something is queued and nothing failed', () => {
    expect(summarizeCheckRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'QUEUED' }]).checks).toBe('pending')
  })

  it('is passing when every check passed and none without checks', () => {
    expect(summarizeCheckRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]).checks).toBe('passing')
    expect(summarizeCheckRollup([])).toEqual({ checks: 'none', checkCounts: { passed: 0, failed: 0, pending: 0, total: 0 } })
    expect(summarizeCheckRollup(null).checks).toBe('none')
  })
})

describe('parsePullRequestJson', () => {
  it('lowercases the state and includes the check summary', () => {
    const info = parsePullRequestJson(JSON.stringify({
      number: 12, title: 'Add thing', url: 'https://github.com/a/b/pull/12', state: 'MERGED', isDraft: false,
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]
    }))
    expect(info).toMatchObject({ number: 12, state: 'merged', isDraft: false, checks: 'passing', checkCounts: { passed: 1, total: 1 } })
  })

  it('rejects malformed output', () => {
    expect(parsePullRequestJson('not json')).toBeNull()
    expect(parsePullRequestJson('{"number":1}')).toBeNull()
  })
})

describe('classifyPullRequestFailure', () => {
  it('recognises gh error text', () => {
    expect(classifyPullRequestFailure('no pull requests found for branch "x"')).toBe('none')
    expect(classifyPullRequestFailure('none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`')).toBe('not-github')
    expect(classifyPullRequestFailure('To get started with GitHub CLI, please run:  gh auth login')).toBe('unauthenticated')
    expect(classifyPullRequestFailure('HTTP 502')).toBe('error')
  })
})

describe('GitHubService.getPullRequest', () => {
  const prJson = JSON.stringify({ number: 3, title: 'T', url: 'https://github.com/a/b/pull/3', state: 'OPEN', isDraft: true, statusCheckRollup: [] })
  const runner = (overrides: { pr?: () => Promise<{ stdout: string; stderr: string }>; auth?: () => Promise<{ stdout: string; stderr: string }>; branch?: string; defaultBranch?: string } = {}) =>
    vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable === 'git') {
        if (overrides.branch === '') throw failure('fatal')
        return ok(`${overrides.branch ?? 'feature'}\n`)
      }
      if (args[0] === '--version') return (overrides.auth ?? (async () => ok()))()
      if (args[0] === 'pr') return (overrides.pr ?? (async () => ok(`[${prJson}]`)))()
      if (args[0] === 'repo') return ok(`${overrides.defaultBranch ?? 'main'}\n`)
      throw new Error(`unexpected ${args.join(' ')}`)
    })

  it('returns the pull request for the current branch', async () => {
    const run = runner()
    const result = await new GitHubService(run).getPullRequest('/repo')
    expect(result).toMatchObject({ state: 'found', pullRequest: { number: 3, state: 'open', isDraft: true, checks: 'none' } })
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'list', '--head', 'feature', '--state', 'all', '--limit', '1', '--json', 'number,title,url,state,isDraft,statusCheckRollup'], { cwd: '/repo' })
  })

  it('looks up the requested branch, not whatever is checked out when the lookup runs', async () => {
    const run = runner({ branch: 'other' })
    await new GitHubService(run).getPullRequest('/repo', 'feature-a')
    expect(run.mock.calls.some((call) => call[0] === 'git')).toBe(false)
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'list', '--head', 'feature-a', '--state', 'all', '--limit', '1', '--json', 'number,title,url,state,isDraft,statusCheckRollup'], { cwd: '/repo' })
  })

  it('treats an all-digit branch as a branch, not a pull request number', async () => {
    const run = runner()
    await new GitHubService(run).getPullRequest('/repo', '1234')
    const call = run.mock.calls.find((entry) => entry[1][0] === 'pr')
    expect(call?.[1].slice(0, 4)).toEqual(['pr', 'list', '--head', '1234'])
  })

  it('never passes a branch that could read as a flag', async () => {
    const run = runner()
    expect(await new GitHubService(run).getPullRequest('/repo', '--web')).toMatchObject({ state: 'unavailable', reason: 'error' })
    expect(run.mock.calls.some((call) => call[1][0] === 'pr')).toBe(false)
  })

  it('reports no pull request and whether the branch is the default branch', async () => {
    const pr = async () => ok('[]')
    expect(await new GitHubService(runner({ pr, branch: 'main' })).getPullRequest('/repo')).toEqual({ state: 'none', isDefaultBranch: true })
    expect(await new GitHubService(runner({ pr, branch: 'feature' })).getPullRequest('/repo')).toEqual({ state: 'none', isDefaultBranch: false })
  })

  it('caches the default branch per folder', async () => {
    const run = runner({ pr: async () => ok('[]') })
    const service = new GitHubService(run)
    await service.getPullRequest('/repo'); await service.getPullRequest('/repo')
    expect(run.mock.calls.filter((call) => call[1][0] === 'repo')).toHaveLength(1)
    await service.getPullRequest('/other')
    expect(run.mock.calls.filter((call) => call[1][0] === 'repo')).toHaveLength(2)
  })

  it('reports an unknown default branch when the lookup fails', async () => {
    const run = vi.fn<ExecutableRunner>(async (executable, args) => {
      if (executable === 'git') return ok('main\n')
      if (args[0] === 'pr') return ok('[]')
      if (args[0] === 'repo') throw failure('boom')
      return ok()
    })
    expect(await new GitHubService(run).getPullRequest('/repo')).toEqual({ state: 'none', isDefaultBranch: null })
  })

  it('maps unavailable reasons', async () => {
    const missing = await new GitHubService(runner({ auth: async () => { throw enoent() } })).getPullRequest('/repo')
    expect(missing).toMatchObject({ state: 'unavailable', reason: 'gh-missing' })
    const signedOut = await new GitHubService(runner({ pr: async () => { throw failure('You are not logged into any GitHub hosts. To log in, run: gh auth login') } })).getPullRequest('/repo')
    expect(signedOut).toMatchObject({ state: 'unavailable', reason: 'unauthenticated' })
    const noBranch = await new GitHubService(runner({ branch: '' })).getPullRequest('/repo')
    expect(noBranch).toMatchObject({ state: 'unavailable', reason: 'no-branch' })
    const notGithub = await new GitHubService(runner({ pr: async () => { throw failure('none of the git remotes configured for this repository point to a known GitHub host') } })).getPullRequest('/repo')
    expect(notGithub).toMatchObject({ state: 'unavailable', reason: 'not-github' })
    const other = await new GitHubService(runner({ pr: async () => { throw failure('HTTP 502: Bad Gateway') } })).getPullRequest('/repo')
    expect(other).toMatchObject({ state: 'unavailable', reason: 'error', message: 'HTTP 502: Bad Gateway' })
  })

  it('probes gh availability once within the cache window', async () => {
    const run = runner()
    const service = new GitHubService(run)
    await service.getPullRequest('/repo'); await service.getPullRequest('/repo')
    expect(run.mock.calls.filter((call) => call[1][0] === '--version')).toHaveLength(1)
  })

  it('is not blocked by an exclusive operation', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn<ExecutableRunner>(async (executable, args) => {
      if (args[0] === 'pr' && args[1] === 'create') { await gate; return ok() }
      if (executable === 'git') return ok('feature\n')
      if (args[0] === 'pr') return ok(`[${prJson}]`)
      return ok()
    })
    const service = new GitHubService(run)
    const creating = service.createPullRequest('/repo')
    await expect(service.getPullRequest('/repo')).resolves.toMatchObject({ state: 'found' })
    release(); await creating
  })
})

describe('GitHubService.createPullRequest', () => {
  it('runs gh pr create --web in the folder', async () => {
    const run = vi.fn<ExecutableRunner>(async () => ok())
    await new GitHubService(run).createPullRequest('/repo')
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'create', '--web'], { cwd: '/repo' })
  })

  it('surfaces gh errors', async () => {
    const run = vi.fn<ExecutableRunner>(async () => { throw failure('must first push the current branch') })
    await expect(new GitHubService(run).createPullRequest('/repo')).rejects.toThrow('must first push the current branch')
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
