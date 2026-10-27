// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitSectionView } from '../src/renderer/components/sideCard/GitSection'
import { createBranch, deleteBranch, renameBranch, switchBranch } from '../src/renderer/components/sideCard/branchActions'
import {
  branchActionState,
  branchFailureMessage,
  branchNameError,
  branchRowMenu,
  checkoutFailureCopy,
  deleteBranchPrompt,
  dirtySwitchChoices,
  dirtySwitchMessage,
  isDirtySwitchRefusal,
  localBranchNames,
  STASH_KEPT_NOTICE,
  THREAD_BRANCH_LABEL
} from '../src/renderer/components/sideCard/gitSectionLogic'
import { EMPTY_GIT_ENTRY, useGitStatusStore, type GitStatusView } from '../src/renderer/stores/gitStatusStore'
import type { GitBranchInfo, GitCommit, GitStatusSnapshot } from '../src/shared/types'

const scope = { projectId: 'project-1', workspaceThreadId: null }
const threadScope = { projectId: 'project-1', workspaceThreadId: 'thread-1' }

const repoStatus = (patch: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot => ({
  isRepo: true,
  branch: 'main',
  upstream: 'origin/main',
  tracking: 'tracked',
  ahead: 0,
  behind: 0,
  changes: [],
  ...patch
})

const dirtyStatus = (): GitStatusSnapshot =>
  repoStatus({
    changes: [
      { path: 'a.ts', status: 'modified', staged: false },
      { path: 'b.ts', status: 'untracked', staged: false }
    ]
  })

const commit = (patch: Partial<GitCommit> = {}): GitCommit => ({
  hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  shortHash: 'a1b2c3d',
  message: 'Fix the flaky retry test',
  author: 'Ada',
  date: '2026-10-24T10:00:00Z',
  pushed: true,
  onRemote: true,
  ...patch
})

const BRANCHES: GitBranchInfo = {
  current: 'main',
  branches: ['main', 'dev', 'mousse/thread/t1', 'Mousse/Upper', 'remotes/origin/main']
}

/** What a failed daemon call looks like after it crossed the preload bridge. */
const daemonError = (code: string, message = 'Git said no') => Object.assign(new Error(message), { code })

type Fn = ReturnType<typeof vi.fn>
interface GitMock {
  status: Fn
  log: Fn
  branches: Fn
  diffStats: Fn
  checkout: Fn
  createBranch: Fn
  renameBranch: Fn
  deleteBranch: Fn
  lastCommitMessage: Fn
}

let currentStatus = repoStatus()

const installGit = (patch: Partial<GitMock> = {}): GitMock => {
  const git: GitMock = {
    status: vi.fn(async () => currentStatus),
    log: vi.fn(async () => [commit()]),
    branches: vi.fn(async () => BRANCHES),
    diffStats: vi.fn(async () => ({ additions: 0, deletions: 0, filesChanged: 0 })),
    checkout: vi.fn(async () => ({ status: repoStatus() })),
    createBranch: vi.fn(async () => ({ status: repoStatus() })),
    renameBranch: vi.fn(async () => ({ status: repoStatus() })),
    deleteBranch: vi.fn(async () => ({ status: repoStatus() })),
    lastCommitMessage: vi.fn(async () => null),
    ...patch
  }
  ;(window as unknown as { mousse: unknown }).mousse = { git }
  return git
}

describe('branch name validation', () => {
  const existing = ['main', 'dev']

  it('says nothing about an empty name, since the form is simply not ready', () => {
    expect(branchNameError('', existing)).toBeNull()
    expect(branchNameError('   ', existing)).toBeNull()
  })

  it('accepts ordinary names, including nested ones', () => {
    expect(branchNameError('topic', existing)).toBeNull()
    expect(branchNameError('feature/login-form', existing)).toBeNull()
    expect(branchNameError('release-1.2', existing)).toBeNull()
  })

  it('refuses what Git would refuse', () => {
    for (const bad of ['-x', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[0]', 'a\\b', 'a..b', 'a@{1}', '@', 'a//b', '/a', 'a/', 'a.', 'a.lock', 'x/.hidden']) {
      expect(branchNameError(bad, existing), bad).not.toBeNull()
    }
  })

  it('refuses a name that is taken, exactly', () => {
    expect(branchNameError('dev', existing)).toBe('A branch with that name already exists.')
    expect(branchNameError('Dev', existing)).toBeNull()
  })

  it('refuses names under mousse/ in any case', () => {
    expect(branchNameError('mousse/x', existing)).toMatch(/managed by Mousse/)
    expect(branchNameError('MOUSSE/thread/x', existing)).toMatch(/managed by Mousse/)
    expect(branchNameError('Mousse/x', existing)).toMatch(/managed by Mousse/)
  })
})

describe('branch list helpers', () => {
  it('offers local branches Mousse does not manage', () => {
    expect(localBranchNames(BRANCHES)).toEqual(['main', 'dev'])
    expect(localBranchNames(null)).toEqual([])
  })

  it('gives local branches a menu, with Delete off for the current branch whatever its case', () => {
    expect(branchRowMenu('dev', 'main')).toEqual({ available: true, canRename: true, canDelete: true, deleteReason: null })
    const current = branchRowMenu('main', 'main')
    expect(current.canRename).toBe(true)
    expect(current.canDelete).toBe(false)
    expect(current.deleteReason).toBe('Switch to another branch first')
    expect(branchRowMenu('Main', 'main').canDelete).toBe(false)
    expect(branchRowMenu('dev', null).canDelete).toBe(true)
  })

  it('gives managed and remote-tracking branches no menu', () => {
    for (const name of ['mousse/thread/t1', 'Mousse/Upper', 'MOUSSE/x', 'remotes/origin/main']) {
      expect(branchRowMenu(name, 'main')).toEqual({ available: false, canRename: false, canDelete: false, deleteReason: null })
    }
  })

  it('turns branch actions off in a thread worktree, with the reason', () => {
    expect(branchActionState(null)).toEqual({ enabled: true, reason: null })
    expect(branchActionState('thread-1')).toEqual({ enabled: false, reason: THREAD_BRANCH_LABEL })
  })
})

describe('dirty switch wording', () => {
  it('asks nothing for a clean folder', () => {
    expect(dirtySwitchChoices(0)).toEqual([])
  })

  it('offers bring along (the default), stash and switch, and cancel', () => {
    const choices = dirtySwitchChoices(2)
    expect(choices.map((choice) => choice.label)).toEqual(['Bring changes along', 'Stash and switch', 'Cancel'])
    expect(choices.map((choice) => choice.id)).toEqual(['carry', 'stash', 'cancel'])
    expect(choices.filter((choice) => choice.primary).map((choice) => choice.id)).toEqual(['carry'])
  })

  it('counts the files in the question', () => {
    expect(dirtySwitchMessage(1, 'dev')).toBe('1 file has uncommitted changes. Switch to dev with them, or stash them first and bring them back?')
    expect(dirtySwitchMessage(3, 'dev')).toMatch(/^3 files have uncommitted changes/)
  })

  it('has fixed copy for each refusal and none for other failures', () => {
    expect(isDirtySwitchRefusal('git_checkout_dirty')).toBe(true)
    expect(isDirtySwitchRefusal('git_checkout_untracked_collision')).toBe(true)
    expect(isDirtySwitchRefusal('git_checkout_failed')).toBe(false)
    expect(isDirtySwitchRefusal(null)).toBe(false)
    expect(checkoutFailureCopy('git_checkout_dirty')).toMatch(/Stash and switch/)
    expect(checkoutFailureCopy('git_checkout_untracked_collision')).toMatch(/untracked file/)
    expect(checkoutFailureCopy('git_stash_kept')).toMatch(/kept in the stash/)
    expect(checkoutFailureCopy('git_checkout_failed')).toBeNull()
    expect(checkoutFailureCopy(null)).toBeNull()
  })
})

describe('delete prompt and failure wording', () => {
  it('asks once, then again worded for the commits that would be lost', () => {
    expect(deleteBranchPrompt('dev', 'confirm')).toEqual({
      message: 'Delete branch dev? Commits that other branches have stay where they are.',
      confirmLabel: 'Delete'
    })
    expect(deleteBranchPrompt('dev', 'unmerged')).toEqual({
      message: 'Branch dev has commits not on any other branch. Delete anyway?',
      confirmLabel: 'Delete anyway'
    })
  })

  it('words each daemon refusal, and falls back to Git\'s own message', () => {
    expect(branchFailureMessage(daemonError('git_branch_exists'), 'topic', 'create')).toBe('A branch named topic already exists.')
    expect(branchFailureMessage(daemonError('git_branch_in_worktree'), 'dev', 'delete')).toBe('dev is checked out in another worktree.')
    expect(branchFailureMessage(daemonError('git_branch_current'), 'main', 'delete')).toMatch(/Switch to another branch/)
    expect(branchFailureMessage(daemonError('git_branch_protected'), 'mousse/x', 'delete')).toMatch(/managed by Mousse/)
    expect(branchFailureMessage(daemonError('git_ref_not_found'), 'dev', 'rename')).toBe('dev no longer exists.')
    expect(branchFailureMessage(daemonError('git_checkout_dirty'), 'topic', 'create')).toMatch(/Create the branch without switching/)
    expect(branchFailureMessage(daemonError('task_branch_authoritative'))).toBe(THREAD_BRANCH_LABEL)
    expect(branchFailureMessage(daemonError('git_branch_failed', 'fatal: weird'))).toBe('weird')
  })
})

describe('branch flows', () => {
  beforeEach(() => {
    useGitStatusStore.setState({ entries: {} })
    currentStatus = repoStatus()
  })
  afterEach(() => {
    delete (window as unknown as { mousse?: unknown }).mousse
  })

  describe('switching', () => {
    it('switches a clean folder with no dirty choice and refreshes', async () => {
      const git = installGit()
      await expect(switchBranch('/repo/a', 'dev', scope, null)).resolves.toEqual({ kind: 'switched', notice: null })
      expect(git.checkout).toHaveBeenCalledWith(scope, 'dev', {})
      expect(git.status).toHaveBeenCalledTimes(1)
    })

    it('carries the changes along', async () => {
      const git = installGit()
      await expect(switchBranch('/repo/a', 'dev', scope, 'carry')).resolves.toEqual({ kind: 'switched', notice: null })
      expect(git.checkout).toHaveBeenCalledWith(scope, 'dev', { dirty: 'carry' })
    })

    it('stashes, switches, and says so when the stash is kept', async () => {
      const git = installGit({ checkout: vi.fn(async () => ({ status: repoStatus(), stashKept: true })) })
      await expect(switchBranch('/repo/a', 'dev', scope, 'stash')).resolves.toEqual({ kind: 'switched', notice: STASH_KEPT_NOTICE })
      expect(git.checkout).toHaveBeenCalledWith(scope, 'dev', { dirty: 'stash' })
      expect(STASH_KEPT_NOTICE).toBe('Switched; your stash is kept because it conflicts')
    })

    it('runs nothing when cancelled', async () => {
      const git = installGit()
      await expect(switchBranch('/repo/a', 'dev', scope, 'cancel')).resolves.toEqual({ kind: 'cancelled' })
      expect(git.checkout).not.toHaveBeenCalled()
      expect(git.status).not.toHaveBeenCalled()
    })

    it('reports a refusal to carry with the fixed copy, and refreshes', async () => {
      const git = installGit({ checkout: vi.fn(async () => { throw daemonError('git_checkout_dirty', 'error: Your local changes to the following files would be overwritten') }) })
      const outcome = await switchBranch('/repo/a', 'dev', scope, 'carry')
      expect(outcome).toEqual({ kind: 'refused', message: checkoutFailureCopy('git_checkout_dirty') })
      expect(git.status).toHaveBeenCalledTimes(1)
    })

    it('treats an untracked-file collision as a refusal too', async () => {
      installGit({ checkout: vi.fn(async () => { throw daemonError('git_checkout_untracked_collision') }) })
      expect(await switchBranch('/repo/a', 'dev', scope, 'carry')).toMatchObject({ kind: 'refused' })
    })

    it('reports any other failure as a failure with Git\'s message, and still refreshes', async () => {
      const git = installGit({ checkout: vi.fn(async () => { throw daemonError('git_checkout_failed', 'fatal: invalid reference: dev') }) })
      await expect(switchBranch('/repo/a', 'dev', scope, 'stash')).resolves.toEqual({ kind: 'failed', message: 'invalid reference: dev' })
      expect(git.status).toHaveBeenCalledTimes(1)
    })

    it('says where a failed stash-and-switch left the stash', async () => {
      installGit({ checkout: vi.fn(async () => { throw daemonError('git_stash_kept') }) })
      expect(await switchBranch('/repo/a', 'dev', scope, 'stash')).toEqual({ kind: 'failed', message: checkoutFailureCopy('git_stash_kept') })
    })
  })

  describe('create, rename and delete', () => {
    it('creates and switches from HEAD by default, then refreshes', async () => {
      const git = installGit()
      await expect(createBranch('/repo/a', { name: ' topic ', from: null, checkout: true }, scope)).resolves.toEqual({ ok: true })
      expect(git.createBranch).toHaveBeenCalledWith(scope, 'topic', { checkout: true })
      expect(git.status).toHaveBeenCalledTimes(1)
    })

    it('creates from another branch without switching', async () => {
      const git = installGit()
      await createBranch('/repo/a', { name: 'topic', from: 'dev', checkout: false }, scope)
      expect(git.createBranch).toHaveBeenCalledWith(scope, 'topic', { checkout: false, from: 'dev' })
    })

    it('reports a name that is taken', async () => {
      const git = installGit({ createBranch: vi.fn(async () => { throw daemonError('git_branch_exists') }) })
      await expect(createBranch('/repo/a', { name: 'dev', from: null, checkout: true }, scope)).resolves.toEqual({ ok: false, message: 'A branch named dev already exists.' })
      expect(git.status).toHaveBeenCalledTimes(1)
    })

    it('renames and refreshes, and reports a refusal', async () => {
      const git = installGit()
      await expect(renameBranch('/repo/a', 'dev', ' dev-2 ', scope)).resolves.toEqual({ ok: true })
      expect(git.renameBranch).toHaveBeenCalledWith(scope, 'dev', 'dev-2')
      git.renameBranch.mockRejectedValueOnce(daemonError('git_branch_exists'))
      await expect(renameBranch('/repo/a', 'dev', 'main', scope)).resolves.toEqual({ ok: false, message: 'A branch named main already exists.' })
    })

    it('deletes without force first and refreshes', async () => {
      const git = installGit()
      await expect(deleteBranch('/repo/a', 'dev', 'main', scope, false)).resolves.toEqual({ kind: 'deleted' })
      expect(git.deleteBranch).toHaveBeenCalledWith(scope, 'dev', {})
      expect(git.status).toHaveBeenCalledTimes(1)
    })

    it('asks again for an unmerged branch and deletes it only when told to force', async () => {
      const git = installGit({ deleteBranch: vi.fn(async () => { throw daemonError('git_branch_unmerged') }) })
      await expect(deleteBranch('/repo/a', 'dev', 'main', scope, false)).resolves.toEqual({ kind: 'unmerged' })
      expect(git.deleteBranch).toHaveBeenCalledTimes(1)
      git.deleteBranch.mockResolvedValueOnce({ status: repoStatus() })
      await expect(deleteBranch('/repo/a', 'dev', 'main', scope, true)).resolves.toEqual({ kind: 'deleted' })
      expect(git.deleteBranch).toHaveBeenLastCalledWith(scope, 'dev', { force: true })
    })

    it('does not ask again once force has been refused too', async () => {
      installGit({ deleteBranch: vi.fn(async () => { throw daemonError('git_branch_in_worktree') }) })
      await expect(deleteBranch('/repo/a', 'dev', 'main', scope, true)).resolves.toEqual({ kind: 'failed', message: 'dev is checked out in another worktree.' })
    })

    it('refuses the current branch, in any case, and managed branches, without sending anything', async () => {
      const git = installGit()
      expect(await deleteBranch('/repo/a', 'main', 'main', scope, false)).toMatchObject({ kind: 'failed', message: expect.stringMatching(/Switch to another branch/) })
      expect(await deleteBranch('/repo/a', 'MAIN', 'main', scope, true)).toMatchObject({ kind: 'failed' })
      expect(await deleteBranch('/repo/a', 'mousse/thread/t1', 'main', scope, true)).toMatchObject({ kind: 'failed', message: expect.stringMatching(/managed by Mousse/) })
      expect(await deleteBranch('/repo/a', 'Mousse/Upper', 'main', scope, false)).toMatchObject({ kind: 'failed' })
      expect(git.deleteBranch).not.toHaveBeenCalled()
      expect(git.status).not.toHaveBeenCalled()
    })

    it('shows what the daemon says when it refuses the current branch or a managed one anyway', async () => {
      installGit({ deleteBranch: vi.fn(async () => { throw daemonError('git_branch_current') }) })
      expect(await deleteBranch('/repo/a', 'dev', null, scope, false)).toMatchObject({ kind: 'failed', message: expect.stringMatching(/Switch to another branch/) })
    })

    it('passes the thread scope on, for a daemon that refuses it', async () => {
      const git = installGit({ createBranch: vi.fn(async () => { throw daemonError('task_branch_authoritative') }) })
      await expect(createBranch('/wt', { name: 'x', from: null, checkout: true }, threadScope)).resolves.toEqual({ ok: false, message: THREAD_BRANCH_LABEL })
      expect(git.createBranch).toHaveBeenCalledWith(threadScope, 'x', { checkout: true })
    })
  })
})

describe('branch picker in the side card', () => {
  let host: HTMLDivElement
  let root: Root
  let git: GitMock

  const view = (status: GitStatusSnapshot): GitStatusView => ({
    ...EMPTY_GIT_ENTRY,
    loaded: true,
    refresh: async () => undefined,
    status,
    commits: [commit()],
    branches: BRANCHES,
    diffStats: { additions: 0, deletions: 0, filesChanged: 0 }
  })

  const props = (status: GitStatusSnapshot, workspaceThreadId: string | null = null) => ({
    threadId: 't1',
    projectId: 'project-1',
    workspaceThreadId,
    path: '/repo/a',
    git: view(status),
    collapsedLabel: null,
    now: Date.parse('2026-10-24T10:05:00Z')
  })

  const mount = (status: GitStatusSnapshot = repoStatus()) => {
    currentStatus = status
    act(() => root.render(createElement(GitSectionView, props(status))))
  }

  const settle = async () => {
    for (let round = 0; round < 6; round += 1) {
      await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
    }
  }
  const click = async (element: Element | null | undefined) => {
    if (!element) throw new Error('nothing to click')
    await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await settle()
  }
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const choose = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const byText = (selector: string, text: string | RegExp) =>
    [...document.body.querySelectorAll<HTMLElement>(selector)].find((element) =>
      typeof text === 'string' ? element.textContent?.trim() === text : text.test(element.textContent ?? '')
    )
  const dialog = (label: string | RegExp) =>
    [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((element) => {
      const name = element.getAttribute('aria-label') ?? ''
      return typeof label === 'string' ? name === label : label.test(name)
    })
  const trigger = () => host.querySelector<HTMLButtonElement>('button.side-card-git-branch')
  const openPicker = async () => {
    await click(trigger())
    expect(dialog('Switch branch')).toBeDefined()
  }
  const option = (name: string) => byText('[role="option"]', name)
  const openRowMenu = async (name: string) => {
    await openPicker()
    await click(document.body.querySelector(`[aria-label="Actions for ${name}"]`))
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Element.prototype.scrollIntoView = vi.fn()
    useGitStatusStore.setState({ entries: {} })
    git = installGit()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete (window as unknown as { mousse?: unknown }).mousse
  })

  describe('switching', () => {
    it('switches a clean folder at once, without asking', async () => {
      mount()
      await openPicker()
      await click(option('dev'))
      expect(dialog(/Switch to/)).toBeUndefined()
      expect(git.checkout).toHaveBeenCalledWith(scope, 'dev', {})
      expect(git.status).toHaveBeenCalled()
    })

    it('does nothing when the current branch is picked', async () => {
      mount(dirtyStatus())
      await openPicker()
      await click(option('main'))
      expect(git.checkout).not.toHaveBeenCalled()
      expect(dialog(/Switch to/)).toBeUndefined()
    })

    it('asks what to do with uncommitted changes, and brings them along by default', async () => {
      mount(dirtyStatus())
      await openPicker()
      await click(option('dev'))
      const prompt = dialog('Switch to dev')
      expect(prompt?.textContent).toContain('2 files have uncommitted changes')
      expect([...prompt!.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Bring changes along', 'Stash and switch', 'Cancel'])
      expect(git.checkout).not.toHaveBeenCalled()
      await click(byText('button', 'Bring changes along'))
      expect(git.checkout).toHaveBeenCalledWith(scope, 'dev', { dirty: 'carry' })
      expect(dialog('Switch to dev')).toBeUndefined()
    })

    it('stashes and switches when asked', async () => {
      mount(dirtyStatus())
      await openPicker()
      await click(option('dev'))
      await click(byText('button', 'Stash and switch'))
      expect(git.checkout).toHaveBeenCalledWith(scope, 'dev', { dirty: 'stash' })
      expect(dialog('Switch to dev')).toBeUndefined()
    })

    it('leaves everything as it was on Cancel', async () => {
      mount(dirtyStatus())
      await openPicker()
      await click(option('dev'))
      await click(byText('button', 'Cancel'))
      expect(dialog('Switch to dev')).toBeUndefined()
      expect(git.checkout).not.toHaveBeenCalled()
      expect(git.status).not.toHaveBeenCalled()
    })

    it('keeps the prompt open with the fixed copy when Git will not carry the changes, and Stash still works', async () => {
      git.checkout.mockRejectedValueOnce(daemonError('git_checkout_dirty', 'error: Your local changes to the following files would be overwritten by checkout'))
      mount(dirtyStatus())
      await openPicker()
      await click(option('dev'))
      await click(byText('button', 'Bring changes along'))
      const prompt = dialog('Switch to dev')
      expect(prompt?.querySelector('[role="alert"]')?.textContent).toBe(checkoutFailureCopy('git_checkout_dirty'))
      // The folder was read again, since a refused switch can still have touched it.
      expect(git.status).toHaveBeenCalledTimes(1)
      expect(byText('button', 'Stash and switch')?.hasAttribute('disabled')).toBe(false)
      await click(byText('button', 'Stash and switch'))
      expect(git.checkout).toHaveBeenLastCalledWith(scope, 'dev', { dirty: 'stash' })
      expect(dialog('Switch to dev')).toBeUndefined()
      expect(git.status).toHaveBeenCalledTimes(2)
    })

    it('closes the prompt and shows the error line for a failure that stashing would not fix', async () => {
      git.checkout.mockRejectedValueOnce(daemonError('git_checkout_failed', 'fatal: invalid reference: dev'))
      mount(dirtyStatus())
      await openPicker()
      await click(option('dev'))
      await click(byText('button', 'Stash and switch'))
      expect(dialog('Switch to dev')).toBeUndefined()
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('invalid reference: dev')
      expect(git.status).toHaveBeenCalledTimes(1)
    })

    it('tells the user when the stash was kept', async () => {
      git.checkout.mockResolvedValueOnce({ status: repoStatus(), stashKept: true })
      mount(dirtyStatus())
      await openPicker()
      await click(option('dev'))
      await click(byText('button', 'Stash and switch'))
      expect(host.querySelector('[role="status"]')?.textContent).toBe('Switched; your stash is kept because it conflicts')
      expect(host.querySelector('[role="alert"]')).toBeNull()
    })

    it('shows the switch as running while it does, and refuses a second one', async () => {
      let finish: () => void = () => undefined
      git.checkout.mockImplementationOnce(() => new Promise((done) => { finish = () => done({ status: repoStatus() }) }))
      mount()
      await openPicker()
      await click(option('dev'))
      expect(trigger()?.textContent).toContain('Switching…')
      expect(trigger()?.disabled).toBe(true)
      await act(async () => { finish() })
      await settle()
      expect(trigger()?.textContent).toContain('main')
      expect(git.checkout).toHaveBeenCalledTimes(1)
    })
  })

  describe('creating', () => {
    const openCreate = async () => {
      await openPicker()
      await click(byText('button', 'New branch…'))
      expect(dialog('New branch')).toBeDefined()
    }
    const nameInput = () => dialog('New branch')!.querySelector<HTMLInputElement>('input[type="text"]')!

    it('offers New branch… in the picker', async () => {
      mount()
      await openPicker()
      expect(byText('button', 'New branch…')).toBeDefined()
    })

    it('creates and switches by default, starting from the current branch', async () => {
      mount()
      await openCreate()
      expect(dialog('New branch')!.querySelector<HTMLSelectElement>('select')!.value).toBe('main')
      await type(nameInput(), 'topic')
      await click(byText('button', 'Create and switch'))
      expect(git.createBranch).toHaveBeenCalledWith(scope, 'topic', { checkout: true })
      expect(dialog('New branch')).toBeUndefined()
      expect(git.status).toHaveBeenCalled()
    })

    it('creates without switching, from another branch', async () => {
      mount()
      await openCreate()
      await type(nameInput(), 'topic')
      await choose(dialog('New branch')!.querySelector<HTMLSelectElement>('select')!, 'dev')
      await click(byText('button', 'Create'))
      expect(git.createBranch).toHaveBeenCalledWith(scope, 'topic', { checkout: false, from: 'dev' })
    })

    it('lists only branches that can be started from', async () => {
      mount()
      await openCreate()
      const options = [...dialog('New branch')!.querySelectorAll('option')].map((element) => element.textContent)
      expect(options).toEqual(['main', 'dev'])
    })

    it('explains a bad or taken name and does not send it', async () => {
      mount()
      await openCreate()
      await type(nameInput(), 'two words')
      expect(dialog('New branch')!.querySelector('[role="alert"]')?.textContent).toMatch(/cannot contain spaces/)
      expect(byText('button', 'Create and switch')?.hasAttribute('disabled')).toBe(true)
      await type(nameInput(), 'dev')
      expect(dialog('New branch')!.querySelector('[role="alert"]')?.textContent).toBe('A branch with that name already exists.')
      await type(nameInput(), 'Mousse/x')
      expect(dialog('New branch')!.querySelector('[role="alert"]')?.textContent).toMatch(/managed by Mousse/)
      await click(byText('button', 'Create and switch'))
      expect(git.createBranch).not.toHaveBeenCalled()
    })

    it('keeps the dialog open with the daemon\'s refusal, and refreshes', async () => {
      git.createBranch.mockRejectedValueOnce(daemonError('git_branch_exists'))
      mount()
      await openCreate()
      await type(nameInput(), 'topic')
      await click(byText('button', 'Create and switch'))
      expect(dialog('New branch')!.querySelector('[role="alert"]')?.textContent).toBe('A branch named topic already exists.')
      expect(git.status).toHaveBeenCalledTimes(1)
    })

    it('closes the dialog on Escape without creating anything', async () => {
      mount()
      await openCreate()
      await type(nameInput(), 'topic')
      await act(async () => {
        dialog('New branch')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(dialog('New branch')).toBeUndefined()
      expect(git.createBranch).not.toHaveBeenCalled()
    })
  })

  describe('renaming', () => {
    it('renames a branch from its menu', async () => {
      mount()
      await openRowMenu('dev')
      await click(byText('button', 'Rename…'))
      const form = dialog('Rename dev')!
      const input = form.querySelector<HTMLInputElement>('input')!
      expect(input.value).toBe('dev')
      expect(byText('button', 'Rename')?.hasAttribute('disabled')).toBe(true)
      await type(input, 'dev-2')
      await click(byText('button', 'Rename'))
      expect(git.renameBranch).toHaveBeenCalledWith(scope, 'dev', 'dev-2')
      expect(dialog('Rename dev')).toBeUndefined()
    })

    it('renames the current branch too, and refuses another branch\'s name', async () => {
      mount()
      await openRowMenu('main')
      await click(byText('button', 'Rename…'))
      const input = dialog('Rename main')!.querySelector<HTMLInputElement>('input')!
      await type(input, 'dev')
      expect(dialog('Rename main')!.querySelector('[role="alert"]')?.textContent).toBe('A branch with that name already exists.')
      expect(byText('button', 'Rename')?.hasAttribute('disabled')).toBe(true)
      await type(input, 'trunk')
      await click(byText('button', 'Rename'))
      expect(git.renameBranch).toHaveBeenCalledWith(scope, 'main', 'trunk')
    })

    it('shows the refusal in the dialog', async () => {
      git.renameBranch.mockRejectedValueOnce(daemonError('git_ref_not_found'))
      mount()
      await openRowMenu('dev')
      await click(byText('button', 'Rename…'))
      await type(dialog('Rename dev')!.querySelector<HTMLInputElement>('input')!, 'dev-2')
      await click(byText('button', 'Rename'))
      expect(dialog('Rename dev')!.querySelector('[role="alert"]')?.textContent).toBe('dev-2 no longer exists.')
      expect(git.status).toHaveBeenCalledTimes(1)
    })
  })

  describe('deleting', () => {
    it('asks first, and does nothing on Cancel', async () => {
      mount()
      await openRowMenu('dev')
      await click(byText('button', 'Delete…'))
      expect(dialog('Delete dev')?.textContent).toContain('Delete branch dev?')
      await click(byText('button', 'Cancel'))
      expect(dialog('Delete dev')).toBeUndefined()
      expect(git.deleteBranch).not.toHaveBeenCalled()
    })

    it('deletes after the confirmation and refreshes', async () => {
      mount()
      await openRowMenu('dev')
      await click(byText('button', 'Delete…'))
      await click(byText('button', 'Delete'))
      expect(git.deleteBranch).toHaveBeenCalledWith(scope, 'dev', {})
      expect(dialog('Delete dev')).toBeUndefined()
      expect(git.status).toHaveBeenCalled()
    })

    it('asks a second time for a branch with commits nothing else has, and forces only on that answer', async () => {
      git.deleteBranch.mockRejectedValueOnce(daemonError('git_branch_unmerged'))
      mount()
      await openRowMenu('dev')
      await click(byText('button', 'Delete…'))
      await click(byText('button', 'Delete'))
      expect(dialog('Delete dev')?.textContent).toContain('Branch dev has commits not on any other branch. Delete anyway?')
      expect(git.deleteBranch).toHaveBeenCalledTimes(1)
      await click(byText('button', 'Delete anyway'))
      expect(git.deleteBranch).toHaveBeenLastCalledWith(scope, 'dev', { force: true })
      expect(dialog('Delete dev')).toBeUndefined()
    })

    it('says a branch is checked out in another worktree', async () => {
      git.deleteBranch.mockRejectedValueOnce(daemonError('git_branch_in_worktree'))
      mount()
      await openRowMenu('dev')
      await click(byText('button', 'Delete…'))
      await click(byText('button', 'Delete'))
      expect(dialog('Delete dev')!.querySelector('[role="alert"]')?.textContent).toBe('dev is checked out in another worktree.')
    })

    it('does not offer Delete for the current branch, and says why', async () => {
      mount()
      await openRowMenu('main')
      const remove = byText('button', 'Delete…') as HTMLButtonElement
      expect(remove.disabled).toBe(true)
      expect(remove.title).toBe('Switch to another branch first')
      await click(remove)
      expect(dialog('Delete main')).toBeUndefined()
      expect(git.deleteBranch).not.toHaveBeenCalled()
    })

    it('gives branches under mousse/ and remote-tracking branches no menu at all', async () => {
      mount()
      await openPicker()
      for (const name of ['mousse/thread/t1', 'Mousse/Upper', 'remotes/origin/main']) {
        expect(option(name)).toBeDefined()
        expect(document.body.querySelector(`[aria-label="Actions for ${name}"]`), name).toBeNull()
      }
      expect(document.body.querySelector('[aria-label="Actions for dev"]')).not.toBeNull()
    })
  })

  describe('in a thread worktree', () => {
    it('shows the branch as a disabled label with the reason, and offers nothing', async () => {
      act(() => root.render(createElement(GitSectionView, props(repoStatus({ branch: 'mousse/thread/t1' }), 'thread-1'))))
      expect(trigger()).toBeNull()
      const label = host.querySelector('.side-card-git-branch-static')
      expect(label?.getAttribute('aria-disabled')).toBe('true')
      expect(label?.getAttribute('title')).toBe('This thread works on its own branch')
      expect(label?.getAttribute('aria-label')).toContain('This thread works on its own branch')
      await click(label)
      expect(dialog('Switch branch')).toBeUndefined()
      expect(byText('button', 'New branch…')).toBeUndefined()
      expect(git.checkout).not.toHaveBeenCalled()
    })

    it('renders the same in markup, with no picker button and no New branch', () => {
      const html = renderToStaticMarkup(createElement(GitSectionView, props(repoStatus({ branch: 'mousse/thread/t1' }), 'thread-1')))
      expect(html).toContain('side-card-git-branch-static')
      expect(html).toContain('aria-disabled="true"')
      expect(html).not.toMatch(/<button[^>]*class="side-card-git-branch"/)
      expect(html).not.toContain('New branch')
    })

    it('keeps the picker a button outside a thread worktree', () => {
      const html = renderToStaticMarkup(createElement(GitSectionView, props(repoStatus())))
      expect(html).toMatch(/<button[^>]*class="side-card-git-branch"/)
      expect(html).not.toContain('side-card-git-branch-static')
    })
  })
})

describe('branch dialog styles', () => {
  const css = readFileSync(resolve(__dirname, '../src/renderer/components/sideCard/gitSection.css'), 'utf8')
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`)
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
  }
  const selectors = [
    '.side-card-git-option-row',
    '.side-card-git-option-more',
    '.side-card-git-option-menu',
    '.side-card-git-option-action',
    '.side-card-git-picker-footer',
    '.side-card-git-new-branch',
    '.side-card-git-branch-popover',
    '.side-card-git-branch-form',
    '.side-card-git-branch-input',
    '.side-card-git-branch-message',
    '.side-card-git-branch-choices',
    '.side-card-git-notice'
  ]

  it('defines every rule it relies on', () => {
    for (const selector of selectors) expect(rule(selector), selector).not.toBe('')
  })

  it('marks rows with a background only, never a side or edge bar', () => {
    for (const selector of selectors) {
      expect(rule(selector), selector).not.toMatch(/border-(left|right|inline-start|inline-end)\b/)
      expect(rule(selector), selector).not.toMatch(/box-shadow:\s*inset\s+-?\d+px\s+0/)
    }
    expect(rule('.side-card-git-new-branch:hover')).toMatch(/background:/)
    expect(rule('.side-card-git-option-action:hover:not(:disabled)')).toMatch(/background:/)
  })
})
