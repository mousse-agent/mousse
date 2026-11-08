// @vitest-environment jsdom
/**
 * Git and pull request actions, mounted: the Create PR form shows only in the surface whose button opened it, the pull
 * request panel offers Create PR for a branch with none, the commit message belongs to one folder, and the Start from
 * pull request list picks with Enter before it starts.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangesFooter } from '../../src/renderer/components/changes/ChangesFooter'
import { PullRequestPanelView } from '../../src/renderer/components/PullRequestPanel'
import { gitActionRowModel } from '../../src/renderer/components/sideCard/gitSectionLogic'
import { StartFromPullRequestDialog } from '../../src/renderer/components/StartFromPullRequestDialog'
import { openCreatePullRequestForm, useGitPullRequestStore } from '../../src/renderer/stores/pullRequestStore'
import type { PullRequestListItem } from '../../src/shared/pullRequests'
import type { GitFileChange, GitScope, GitStatusSnapshot } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView ??= () => undefined

const openThreadFromPullRequest = vi.fn(async () => undefined)
vi.mock('../../src/renderer/lib/threadActions', () => ({
  openThreadFromPullRequest: (...args: unknown[]) => openThreadFromPullRequest(...(args as [])),
  selectThread: vi.fn(async () => undefined)
}))

const project: GitScope = { projectId: 'p1', workspaceThreadId: null }
const change = (path: string, patch: Partial<GitFileChange> = {}): GitFileChange => ({ path, status: 'modified', staged: false, ...patch })
const status = (patch: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot => ({
  isRepo: true,
  branch: 'feature/login',
  upstream: 'origin/feature/login',
  tracking: 'tracked',
  ahead: 0,
  behind: 0,
  changes: [change('a.ts')],
  inProgress: null,
  hasRemote: true,
  ...patch
} as GitStatusSnapshot)

let host: HTMLDivElement
let root: Root
const render = async (element: ReturnType<typeof createElement>) => {
  await act(async () => root.render(element))
}
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('element not found')
  await act(async () => { (element as HTMLElement).click() })
}
const key = async (element: Element | null | undefined, name: string) => {
  if (!element) throw new Error('element not found')
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  openThreadFromPullRequest.mockClear()
})

describe('the Create PR form in the surface that opened it', () => {
  const model = () => gitActionRowModel({
    path: 'k1',
    scope: project,
    projectId: 'p1',
    ownThreadId: 't1',
    status: status({ changes: [], ahead: 0 }),
    commitCount: 1,
    pullRequest: { state: 'none', isDefaultBranch: false }
  })
  const footer = () => createElement(ChangesFooter, {
    state: { kind: 'create-pr' },
    path: 'k1',
    scope: project,
    commits: [],
    model: model(),
    running: null,
    begin: () => true,
    end: () => undefined,
    onReviewUncommitted: () => undefined,
    onResolveConflicts: () => undefined,
    onRetry: () => undefined
  })

  beforeEach(() => {
    useGitPullRequestStore.setState({ createForm: null, createFormHost: 'changes' })
    vi.stubGlobal('mousse', {
      pullRequests: {
        draft: vi.fn(() => new Promise(() => {})),
        baseBranches: vi.fn(() => new Promise(() => {}))
      },
      git: { lastCommitMessage: vi.fn(async () => '') }
    })
  })

  it('opens the form from the Changes footer, there', async () => {
    await render(footer())
    const create = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Create PR')
    await click(create)
    expect(useGitPullRequestStore.getState().createFormHost).toBe('changes')
    expect(document.body.querySelectorAll('[role="dialog"][aria-label="Create pull request"]')).toHaveLength(1)
  })

  it('keeps a form the pull request panel opened out of the Changes footer', async () => {
    await render(footer())
    await act(async () => openCreatePullRequestForm(model().createScope!, 'pull-request-panel'))
    expect(document.body.querySelector('[role="dialog"][aria-label="Create pull request"]')).toBeNull()
  })
})

describe('the commit message and its folder', () => {
  const footer = (path: string, scope: GitScope) => createElement(ChangesFooter, {
    state: { kind: 'commit', placeholder: 'Commit to feature/login', tinted: false, label: 'Commit all 1', disabled: false },
    path,
    scope,
    commits: [],
    model: gitActionRowModel({ path, scope, projectId: scope.projectId, ownThreadId: 't1', status: status(), commitCount: 1, pullRequest: null }),
    running: null,
    begin: () => true,
    end: () => undefined,
    onReviewUncommitted: () => undefined,
    onResolveConflicts: () => undefined,
    onRetry: () => undefined
  })

  beforeEach(() => {
    vi.stubGlobal('mousse', {
      pullRequests: { draft: vi.fn(() => new Promise(() => {})), baseBranches: vi.fn(() => new Promise(() => {})) },
      git: { lastCommitMessage: vi.fn(async () => '') }
    })
  })

  it('names the branch in the placeholder and drops the draft when another folder is shown', async () => {
    await render(footer('k1', project))
    const message = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')
    expect(message?.placeholder).toBe('Commit to feature/login')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(message, 'fix the login')
      message?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')?.value).toBe('fix the login')
    await render(footer('k2', { projectId: 'p2', workspaceThreadId: null }))
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')?.value).toBe('')
  })
})

describe('the pull request panel without a pull request', () => {
  it('names the branch and offers Create PR', async () => {
    await render(createElement(PullRequestPanelView, {
      state: { kind: 'none', branch: 'feature/login' },
      createAction: createElement('button', { type: 'button', className: 'pr-panel-create' }, 'Create PR')
    }))
    expect(host.textContent).toContain('feature/login has no pull request yet.')
    expect(host.textContent).not.toContain('side card')
    expect(host.querySelector('.pr-panel-create')).not.toBeNull()
  })
})

describe('starting a thread from a pull request', () => {
  const item = (number: number, title: string): PullRequestListItem => ({
    number,
    title,
    url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false,
    author: 'ann',
    headRefName: `feature/${number}`,
    isCrossRepository: false,
    updatedAt: '2026-10-20T10:00:00Z'
  })

  beforeEach(() => {
    vi.stubGlobal('mousse', {
      pullRequests: {
        list: vi.fn(async () => [item(7, 'Retry the login'), item(9, 'Retry uploads'), item(11, 'Dark mode')]),
        resolve: vi.fn(() => new Promise(() => {}))
      }
    })
  })

  it('leads with the project and where the thread starts', async () => {
    await render(createElement(StartFromPullRequestDialog, { projectId: 'p1', projectName: 'app', onClose: () => undefined }))
    expect(document.body.querySelector('.start-from-pr-lead')?.textContent).toBe('app · Starts in its own worktree')
  })

  it('moves through the filtered results with the arrows and picks with Enter, starting nothing', async () => {
    await render(createElement(StartFromPullRequestDialog, { projectId: 'p1', projectName: 'app', onClose: () => undefined }))
    const input = document.body.querySelector<HTMLInputElement>('.start-from-pr-input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'retry')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const options = () => [...document.body.querySelectorAll('[role="option"]')]
    expect(options()).toHaveLength(2)
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id)
    await key(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1].id)
    await key(input, 'Enter')
    expect(options()[1].getAttribute('aria-selected')).toBe('true')
    expect(openThreadFromPullRequest).not.toHaveBeenCalled()
    // Within the list the arrows move focus, one result at a time.
    await act(async () => (options()[0] as HTMLElement).focus())
    await key(options()[0], 'ArrowDown')
    expect(document.activeElement).toBe(options()[1])
    expect(options()[1].getAttribute('tabindex')).toBe('0')
    expect(options()[0].getAttribute('tabindex')).toBe('-1')
  })
})
