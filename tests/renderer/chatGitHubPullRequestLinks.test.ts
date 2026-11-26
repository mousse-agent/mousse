// @vitest-environment jsdom
/**
 * Clicking a GitHub pull request link in a chat response opens Mousse's Pull Request viewer side panel
 * instead of a Browser tab, for both the active project's repo and external `owner/repo` links, with a
 * back button to return to the thread's own pull request.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PullRequestDetail, PullRequestIdentity } from '../../src/shared/pullRequests'
import { Markdown } from '../../src/renderer/chat/components/agent-elements/markdown'
import { PullRequestPanel } from '../../src/renderer/components/PullRequestPanel'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { clearViewedPullRequest, useGitPullRequestStore } from '../../src/renderer/stores/pullRequestStore'
import { parseGitHubPullRequestUrl } from '../../src/renderer/utils/chatLinks'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialApp = useAppStore.getInitialState()
const initialPr = useGitPullRequestStore.getInitialState()
let root: Root
let host: HTMLElement
let viewMock: ReturnType<typeof vi.fn>
let openMock: ReturnType<typeof vi.fn>

function sampleDetail(identity: PullRequestIdentity, title: string): PullRequestDetail {
  return {
    identity,
    number: identity.number,
    title,
    url: `https://${identity.host}/${identity.nameWithOwner}/pull/${identity.number}`,
    state: 'open',
    isDraft: false,
    headRefName: 'feat-branch',
    baseRefName: 'main',
    headSha: 'abcdef1234567890',
    headRepository: identity.nameWithOwner,
    baseRepository: identity.nameWithOwner,
    isCrossRepository: false,
    body: 'Pull request description.',
    author: 'alice',
    authorAssociation: 'MEMBER',
    checks: 'passing',
    checkCounts: { passed: 1, failed: 0, pending: 0, waiting: 0, total: 1 },
    reviewDecision: 'approved',
    reviews: [],
    comments: [{
      id: 'c1', author: 'bob', authorAssociation: 'MEMBER', bodyTruncated: false, edited: false,
      body: 'Looks good ![after](https://github.com/user-attachments/assets/abc)',
      createdAt: '2026-11-24T00:00:00Z', url: `https://${identity.host}/${identity.nameWithOwner}/pull/${identity.number}#c1`,
      path: null, line: null, startLine: null, side: null, inReplyTo: null
    }],
    commentsTruncated: false,
    checkRuns: [{ name: 'CI', state: 'passing', url: null }],
    updatedAt: '2026-11-24T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    mergeState: 'clean'
  }
}

beforeEach(() => {
  viewMock = vi.fn(async (identity: PullRequestIdentity) => sampleDetail(identity, `PR ${identity.number} in ${identity.nameWithOwner}`))
  openMock = vi.fn(() => null)
  vi.stubGlobal('open', openMock)
  ;(window as unknown as { mousse: unknown }).mousse = {
    pullRequests: {
      view: viewMock,
      get: vi.fn(async () => ({ state: 'none', isDefaultBranch: true })),
      detail: vi.fn(async () => { throw new Error('unused') })
    }
  }
  useAppStore.setState({
    ...initialApp,
    sidebarMode: 'projects',
    mainView: 'files',
    mainAreaOpen: false,
    activeThreadId: 'thread-1',
    browserTabs: []
  })
  useGitPullRequestStore.setState(initialPr)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  clearViewedPullRequest()
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  delete (window as unknown as { mousse?: unknown }).mousse
  useAppStore.setState(initialApp)
  useGitPullRequestStore.setState(initialPr)
})

describe('parseGitHubPullRequestUrl', () => {
  it.each([
    ['https://github.com/mousse-agent/mousse/pull/1781', { host: 'github.com', nameWithOwner: 'mousse-agent/mousse', number: 1781 }],
    ['https://github.com/other/repo/pull/42/files', { host: 'github.com', nameWithOwner: 'other/repo', number: 42 }],
    ['https://github.com/other/repo/pull/42#discussion_r123', { host: 'github.com', nameWithOwner: 'other/repo', number: 42 }],
    ['https://github.com/mousse-agent/mousse/issues/615', null],
    ['https://github.com/mousse-agent/mousse/tree/master', null],
    ['https://gitlab.com/group/project/-/merge_requests/5', null],
    ['https://example.com/owner/repo/pull/1', null],
    ['1781', null],
  ])('%s -> %j', (href, expected) => {
    expect(parseGitHubPullRequestUrl(href)).toEqual(expected)
  })
})

describe('clicking a GitHub pull request link in chat', () => {
  it('opens the Pull Request viewer side panel instead of a Browser tab for same-repo and external-repo PR links', async () => {
    await act(async () => {
      root.render(
        createElement('div', null,
          createElement(Markdown, { content: 'Review [PR #42](https://github.com/external/project/pull/42/files).' }),
          createElement(PullRequestPanel)
        )
      )
    })

    const link = host.querySelector('a')!
    await act(async () => { link.click() })

    expect(viewMock).toHaveBeenCalledWith({ host: 'github.com', nameWithOwner: 'external/project', number: 42 })
    expect(useAppStore.getState()).toMatchObject({ mainView: 'pullRequest', mainAreaOpen: true, browserTabs: [] })
    expect(openMock).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(host.textContent).toContain('PR 42 in external/project')
    })
    expect(host.querySelector('.pr-panel-repo')?.textContent).toBe('external/project')

    // Comments wait behind Load comments; once loaded, a GitHub attachment shows as an image.
    expect(host.textContent).not.toContain('Looks good')
    const load = [...host.querySelectorAll('button')].find((btn) => btn.textContent?.startsWith('Load comments'))
    await act(async () => { load!.click() })
    expect(host.textContent).toContain('Looks good')
    expect(host.querySelector('.pr-panel-markdown img')?.getAttribute('src')).toBe('https://github.com/user-attachments/assets/abc')

    // The back button clears the linked PR view.
    const back = host.querySelector<HTMLButtonElement>('button[aria-label="Back to this thread’s pull request"]')
    expect(back).not.toBeNull()
    await act(async () => { back!.click() })
    expect(useGitPullRequestStore.getState().viewedPullRequest).toBeNull()
  })

  it('keeps non-PR GitHub links opening in the Browser panel and bot-chat PR links opening externally', async () => {
    await act(async () => {
      root.render(createElement(Markdown, { content: 'See [issue #615](https://github.com/mousse-agent/mousse/issues/615).' }))
    })
    await act(async () => { host.querySelector('a')!.click() })
    expect(viewMock).not.toHaveBeenCalled()
    expect(useAppStore.getState().mainView).toBe('browser')
    expect(useAppStore.getState().browserTabs.map((t) => t.url)).toEqual(['https://github.com/mousse-agent/mousse/issues/615'])

    useAppStore.setState({ sidebarMode: 'chats', mainView: 'files', mainAreaOpen: false, browserTabs: [] })
    await act(async () => {
      root.render(createElement(Markdown, { content: 'See [PR #1781](https://github.com/mousse-agent/mousse/pull/1781).' }))
    })
    await act(async () => { host.querySelector('a')!.click() })
    expect(viewMock).not.toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('https://github.com/mousse-agent/mousse/pull/1781', '_blank', 'noopener,noreferrer')
  })
})
