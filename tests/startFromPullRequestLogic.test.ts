import { describe, expect, it } from 'vitest'
import type { PullRequestListItem, PullRequestSummary } from '../src/shared/pullRequests'
import {
  filterPullRequests,
  startButtonModel,
  startErrorCode,
  startErrorMessage,
  startReference
} from '../src/renderer/components/startFromPullRequestLogic'

const item = (patch: Partial<PullRequestListItem>): PullRequestListItem => ({
  number: 1,
  title: 'Title',
  url: 'https://github.com/acme/app/pull/1',
  isDraft: false,
  author: 'ann',
  headRefName: 'feature',
  isCrossRepository: false,
  updatedAt: '2026-10-20T10:00:00Z',
  ...patch
})

describe('filterPullRequests', () => {
  const items = [
    item({ number: 12, title: 'Fix login redirect', author: 'ann', headRefName: 'fix-login' }),
    item({ number: 34, title: 'Add dark mode', author: 'bob', headRefName: 'dark' }),
    item({ number: 123, title: 'Refactor store', author: 'cy', headRefName: 'store' })
  ]

  it('keeps everything for an empty query', () => {
    expect(filterPullRequests(items, '   ')).toHaveLength(3)
  })

  it('matches number, title, author and branch, every word, ignoring case and a leading #', () => {
    expect(filterPullRequests(items, '#12').map((entry) => entry.number)).toEqual([12, 123])
    expect(filterPullRequests(items, 'LOGIN fix').map((entry) => entry.number)).toEqual([12])
    expect(filterPullRequests(items, 'bob').map((entry) => entry.number)).toEqual([34])
    expect(filterPullRequests(items, 'store').map((entry) => entry.number)).toEqual([123])
    expect(filterPullRequests(items, 'login bob')).toEqual([])
  })
})

describe('startReference', () => {
  it('prefers what was typed when it names a pull request', () => {
    expect(startReference('https://github.com/acme/app/pull/9', 4)).toBe('https://github.com/acme/app/pull/9')
    expect(startReference(' #9 ', null)).toBe('#9')
    expect(startReference('gh pr checkout 9', 4)).toBe('gh pr checkout 9')
  })

  it('falls back to the picked row when the text only narrows the list', () => {
    expect(startReference('login', 4)).toBe('4')
    expect(startReference('', 4)).toBe('4')
    expect(startReference('login', null)).toBeNull()
    expect(startReference('', null)).toBeNull()
  })

  it('does not start from a number that is not positive', () => {
    expect(startReference('0', null)).toBeNull()
    expect(startReference('0', 5)).toBe('5')
  })
})

describe('startButtonModel', () => {
  const summary = (state: PullRequestSummary['state']): PullRequestSummary => ({
    number: 7, title: 'T', url: 'https://github.com/acme/app/pull/7', state, isDraft: false, author: 'ann', headRefName: 'f', isCrossRepository: false
  })

  it('starts an open pull request nobody works on without any override', () => {
    expect(startButtonModel(summary('open'), [], false)).toEqual({ label: 'Start thread', allowClosed: false, allowDuplicate: false })
    expect(startButtonModel(null, [], false)).toEqual({ label: 'Start thread', allowClosed: false, allowDuplicate: false })
  })

  it('offers a merged or closed pull request as a deliberate start', () => {
    expect(startButtonModel(summary('merged'), [], false)).toEqual({ label: 'Start anyway', allowClosed: true, allowDuplicate: false })
  })

  it('offers another thread when one exists, and says it is starting', () => {
    expect(startButtonModel(summary('open'), [{ id: 't', name: 'PR #7' }], false)).toEqual({ label: 'Start another thread', allowClosed: false, allowDuplicate: true })
    expect(startButtonModel(summary('open'), [], true).label).toBe('Starting…')
  })
})

describe('start errors', () => {
  it('reads the daemon\'s code and the first line of its message', () => {
    const refused = { code: 'pull_request_thread_exists', message: 'Error invoking remote method \'x\': "PR #7" already works on pull request #7.\nmore' }
    expect(startErrorCode(refused)).toBe('pull_request_thread_exists')
    expect(startErrorMessage(refused)).toBe('"PR #7" already works on pull request #7.')
    expect(startErrorCode(new Error('plain'))).toBeNull()
    expect(startErrorMessage({})).toBe('The thread could not be started.')
  })
})
