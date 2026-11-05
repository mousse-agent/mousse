// @vitest-environment jsdom
/**
 * Git and pull request actions next to the diff, mounted: Discard waits behind a file's More menu and asks in the
 * app's own dialog, the Create PR form shows only in the surface whose button opened it, the pull request panel offers
 * Create PR for a branch with none, the Commit popover belongs to one folder, and the Start from pull request list picks
 * with Enter before it starts.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscardConfirmDialog } from '../../src/renderer/components/git/DiscardConfirmDialog'
import { GitActionButtons } from '../../src/renderer/components/git/GitActionButtons'
import { GitChangesList } from '../../src/renderer/components/git/GitChangesList'
import { PullRequestPanelView } from '../../src/renderer/components/PullRequestPanel'
import { gitActionRowModel } from '../../src/renderer/components/sideCard/gitSectionLogic'
import { StartFromPullRequestDialog } from '../../src/renderer/components/StartFromPullRequestDialog'
import { EMPTY_GIT_ENTRY, type GitStatusView } from '../../src/renderer/stores/gitStatusStore'
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

describe('discarding a file from the Git panel', () => {
  const list = (onRowAction = vi.fn()) => createElement(GitChangesList, {
    changes: [change('a.ts'), change('new.ts', { status: 'untracked' })],
    selected: null,
    onSelect: () => undefined,
    scope: project,
    busy: false,
    onRowAction,
    onSectionAction: () => undefined,
    flex: { conflicts: 1, staged: 1, changes: 1, untracked: 1, commits: 1 },
    onDividerResize: () => undefined
  })

  it('offers Discard only from the More menu, and gives focus back to it once chosen', async () => {
    const onRowAction = vi.fn()
    await render(list(onRowAction))
    const more = host.querySelector<HTMLButtonElement>('[aria-label="More actions for a.ts"]')
    await click(more)
    const item = document.body.querySelector('[role="menuitem"][aria-label="Discard changes to a.ts"]')
    expect(item?.textContent).toBe('Discard changes…')
    await click(item)
    expect(onRowAction).toHaveBeenCalledWith('discard', expect.objectContaining({ path: 'a.ts' }))
    expect(document.activeElement).toBe(more)
    await click(host.querySelector('[aria-label="More actions for new.ts"]'))
    expect(document.body.querySelector('[role="menuitem"][aria-label="Delete untracked file new.ts"]')?.textContent).toBe('Delete file…')
  })

  it('moves a focused divider with the arrow keys', async () => {
    const onDividerResize = vi.fn()
    await render(createElement(GitChangesList, {
      changes: [change('a.ts'), change('b.ts', { staged: true })],
      selected: null,
      onSelect: () => undefined,
      scope: project,
      busy: false,
      onRowAction: () => undefined,
      onSectionAction: () => undefined,
      flex: { conflicts: 1, staged: 1, changes: 1, untracked: 1, commits: 1 },
      onDividerResize
    }))
    const divider = host.querySelector('[aria-label="Resize Staged and Changes sections"]')
    await key(divider, 'ArrowDown')
    expect(onDividerResize).toHaveBeenLastCalledWith('staged', 'changes', expect.closeTo(0.55))
    await key(divider, 'Home')
    expect(onDividerResize).toHaveBeenLastCalledWith('staged', 'changes', 0.15)
  })

  it('asks in the app dialog with the kept-copy line, focus off the confirming button, and Escape answers no', async () => {
    const onAnswer = vi.fn()
    await render(createElement(DiscardConfirmDialog, {
      question: { message: 'Delete new.ts?\n\nIt is not tracked by Git, so it will be deleted.\n\nA copy is kept for 30 days.', action: 'Delete' },
      onAnswer
    }))
    const dialog = document.body.querySelector('[role="dialog"][aria-label="Delete new.ts?"]')
    expect(dialog?.textContent).toContain('A copy is kept for 30 days.')
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Delete')
    expect(confirm).toBeDefined()
    expect(document.activeElement).not.toBe(confirm)
    await key(document.activeElement, 'Escape')
    expect(onAnswer).toHaveBeenLastCalledWith(false)
    await click(confirm)
    expect(onAnswer).toHaveBeenLastCalledWith(true)
  })
})

describe('the Create PR form in the surface that opened it', () => {
  const view = (): GitStatusView => ({ ...EMPTY_GIT_ENTRY, loaded: true, refresh: async () => undefined, status: status({ changes: [] }) })
  const model = () => gitActionRowModel({
    path: 'k1',
    scope: project,
    projectId: 'p1',
    ownThreadId: 't1',
    status: status({ changes: [] }),
    commitCount: 1,
    pullRequest: { state: 'none', isDefaultBranch: false }
  })
  const row = (hostName: 'side-card' | 'git-panel') => createElement(GitActionButtons, {
    host: hostName,
    path: 'k1',
    scope: project,
    git: view(),
    model: model(),
    running: null,
    begin: () => true,
    end: () => undefined,
    onActionError: () => undefined,
    onNotice: () => undefined
  })

  beforeEach(() => {
    useGitPullRequestStore.setState({ createForm: null, createFormHost: 'side-card' })
    vi.stubGlobal('mousse', {
      pullRequests: {
        draft: vi.fn(() => new Promise(() => {})),
        baseBranches: vi.fn(() => new Promise(() => {}))
      },
      git: { lastCommitMessage: vi.fn(async () => '') }
    })
  })

  it('opens the form from the diff toolbar there, and never a second copy in the side card', async () => {
    await render(createElement('div', null, row('side-card'), row('git-panel')))
    const createButtons = host.querySelectorAll('.side-card-git-pr-create')
    expect(createButtons).toHaveLength(2)
    await click(createButtons[1])
    expect(useGitPullRequestStore.getState().createFormHost).toBe('git-panel')
    expect(document.body.querySelectorAll('[role="dialog"][aria-label="Create pull request"]')).toHaveLength(1)
  })

  it('keeps a form the side card opened out of the diff toolbar', async () => {
    await render(row('git-panel'))
    await act(async () => openCreatePullRequestForm(model().createScope!, 'side-card'))
    expect(document.body.querySelector('[role="dialog"][aria-label="Create pull request"]')).toBeNull()
  })
})

describe('the Commit popover and its folder', () => {
  const view = (): GitStatusView => ({ ...EMPTY_GIT_ENTRY, loaded: true, refresh: async () => undefined, status: status() })
  const row = (path: string, scope: GitScope) => createElement(GitActionButtons, {
    host: 'side-card',
    path,
    scope,
    git: view(),
    model: gitActionRowModel({ path, scope, projectId: scope.projectId, ownThreadId: 't1', status: status(), commitCount: 1, pullRequest: null }),
    running: null,
    begin: () => true,
    end: () => undefined,
    onActionError: () => undefined,
    onNotice: () => undefined
  })

  beforeEach(() => {
    vi.stubGlobal('mousse', {
      pullRequests: { draft: vi.fn(() => new Promise(() => {})), baseBranches: vi.fn(() => new Promise(() => {})) },
      git: { lastCommitMessage: vi.fn(async () => '') }
    })
  })

  it('closes and drops the draft when another folder on the same branch is shown', async () => {
    await render(row('k1', project))
    await click(host.querySelector('.side-card-git-commit-button'))
    const message = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')
    expect(message).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(message, 'fix the login')
      message?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await render(row('k2', { projectId: 'p2', workspaceThreadId: null }))
    expect(document.body.querySelector('textarea[aria-label="Commit message"]')).toBeNull()
    await click(host.querySelector('.side-card-git-commit-button'))
    expect(document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')?.value).toBe('')
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
