/**
 * Reading a GitHub pull request by explicit repository identity (`host`, `owner/repo`, `number`)
 * without a local checkout: passes `--repo <host>/<owner>/<repo>` to `gh pr view`, shares the
 * identity cache, validates inputs, and reports clean failures when `gh` cannot read it.
 */
import { describe, expect, it } from 'vitest'
import { GitHubCodeHost, PullRequestReadError } from '../src/mms/git/GitHubCodeHost'

function fakeViewOutput(number: number, nameWithOwner: string): string {
  return JSON.stringify({
    number,
    title: `Linked PR #${number}`,
    url: `https://github.com/${nameWithOwner}/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    body: 'Details here.',
    author: 'alice',
    headRefName: 'feature',
    baseRefName: 'main',
    headSha: '1234567890abcdef',
    headRepository: nameWithOwner,
    isCrossRepository: false,
    reviewDecision: 'APPROVED',
    updatedAt: '2026-11-24T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    reviews: [],
    comments: [],
    checks: []
  })
}

describe('GitHubCodeHost.getPullRequestDetailByIdentity', () => {
  it('reads an external repository PR using --repo without requiring a local git cwd and caches by identity', async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
    const host = new GitHubCodeHost(async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd })
      if (args[0] === '--version') return { stdout: 'gh version 2.60.0\n', stderr: '' }
      if (args[0] === 'pr' && args[1] === 'view') return { stdout: fakeViewOutput(42, 'other/repo'), stderr: '' }
      if (args[0] === 'api' && args.includes('.author_association')) return { stdout: 'MEMBER\n', stderr: '' }
      if (args[0] === 'api') return { stdout: '[]\n', stderr: '' }
      throw new Error(`Unexpected call: ${args.join(' ')}`)
    })

    const first = await host.getPullRequestDetailByIdentity({ host: 'github.com', nameWithOwner: 'other/repo', number: 42 })
    expect(first.number).toBe(42)
    expect(first.title).toBe('Linked PR #42')
    expect(first.identity).toEqual({ host: 'github.com', nameWithOwner: 'other/repo', number: 42 })

    const viewCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'view')
    expect(viewCall?.args).toContain('--repo')
    expect(viewCall?.args).toContain('github.com/other/repo')
    expect(viewCall?.cwd).toBeUndefined()

    const countBefore = calls.length
    const second = await host.getPullRequestDetailByIdentity({ host: 'github.com', nameWithOwner: 'other/repo', number: 42 })
    expect(second).toEqual(first)
    expect(calls.length).toBe(countBefore)
  })

  it('rejects invalid host, repository, or number before invoking gh', async () => {
    let called = false
    const host = new GitHubCodeHost(async () => { called = true; return { stdout: '', stderr: '' } })
    for (const bad of [
      { host: 'github.com', nameWithOwner: 'other/repo', number: 0 },
      { host: '--evil', nameWithOwner: 'other/repo', number: 1 },
      { host: 'github.com', nameWithOwner: '-owner/repo', number: 1 },
      { host: 'github.com', nameWithOwner: 'onlyone', number: 1 },
      { host: 'github.com/bad', nameWithOwner: 'other/repo', number: 1 },
    ]) {
      await expect(host.getPullRequestDetailByIdentity(bad)).rejects.toBeInstanceOf(PullRequestReadError)
    }
    expect(called).toBe(false)
  })
})
