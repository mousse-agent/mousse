import { describe, expect, it } from 'vitest'
import { failureReason, isGitHubSignedOut, isGitHubSignedOutError } from '../src/renderer/lib/githubSignIn'
import { readFailure, signInHint } from '../src/renderer/components/startFromPullRequestLogic'

describe('telling a signed-out GitHub CLI from other failures', () => {
  it('follows the daemon\'s reason when it gives one', () => {
    expect(isGitHubSignedOut({ reason: 'unauthenticated', message: 'anything' })).toBe(true)
    expect(isGitHubSignedOut({ reason: 'not-found', message: 'run gh auth login' })).toBe(false)
    expect(isGitHubSignedOut({ reason: 'error', message: 'You are not logged in' })).toBe(false)
  })

  it('without a reason, matches only the CLI\'s sign-in words', () => {
    expect(isGitHubSignedOut({ message: 'To get started with GitHub CLI, please run:  gh auth login' })).toBe(true)
    expect(isGitHubSignedOut({ message: 'You are not logged into any GitHub hosts.' })).toBe(true)
    expect(isGitHubSignedOut({ message: 'gh pr view failed — not signed in to github.com for /x.' })).toBe(true)
    expect(isGitHubSignedOut({ message: 'HTTP 502: Bad gateway' })).toBe(false)
    expect(isGitHubSignedOut({ message: 'the signed-in account may not see it' })).toBe(false)
    // A rate limit can suggest signing in; waiting is what fixes it.
    expect(isGitHubSignedOut({ message: 'API rate limit exceeded. Try gh auth login for a higher limit.' })).toBe(false)
    expect(isGitHubSignedOut({ message: '' })).toBe(false)
  })

  it('reads the reason a bridged failure carries', () => {
    const bridged = { code: 'pull_request_unavailable', message: 'x', details: { reason: 'unauthenticated' } }
    expect(failureReason(bridged)).toBe('unauthenticated')
    expect(failureReason(new Error('x'))).toBeNull()
    expect(failureReason({ details: { number: 7 } })).toBeNull()
    expect(isGitHubSignedOutError(bridged)).toBe(true)
    expect(isGitHubSignedOutError(new Error('Command failed: gh pr list\nTo get started with GitHub CLI, please run:  gh auth login'))).toBe(true)
    expect(isGitHubSignedOutError({ code: 'pull_request_not_found', message: 'gh auth login', details: { reason: 'not-found' } })).toBe(false)
  })

  it('keeps the dialog\'s failures: signed out without words, others with their own', () => {
    expect(readFailure({ message: 'x', details: { reason: 'unauthenticated' } })).toEqual({ signedOut: true })
    expect(readFailure(new Error('HTTP 502: Bad gateway'))).toEqual({ signedOut: false, message: 'HTTP 502: Bad gateway' })
    expect(signInHint(null)).toBe('Run gh auth login in a terminal')
    expect(signInHint('Mac mini')).toBe('Run gh auth login in a terminal on Mac mini')
  })
})
