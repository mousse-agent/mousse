import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitSectionView } from '../src/renderer/components/sideCard/GitSection'
import {
  branchChoices,
  branchLabel,
  branchSearchAria,
  changedFileCount,
  changesSummary,
  diffStatLabel,
  formatCommitLine,
  gitCollapsedLabel,
  gitErrorMessage,
  relativeTime,
  untrackedFileCount
} from '../src/renderer/components/sideCard/gitSectionLogic'
import {
  EMPTY_GIT_ENTRY,
  anyTurnEnded,
  checkoutGitBranch,
  commitGitChanges,
  refreshGitStatus,
  retainGitPath,
  useGitStatusStore,
  type GitStatusView
} from '../src/renderer/stores/gitStatusStore'
import type {
  GitBranchInfo,
  GitCommit,
  GitDiffStats,
  GitStatusSnapshot,
  TurnState,
  TurnStateSnapshot
} from '../src/shared/types'

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

const commit = (patch: Partial<GitCommit> = {}): GitCommit => ({
  hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  shortHash: 'a1b2c3d',
  message: 'Fix the flaky retry test',
  author: 'Ada',
  date: '2026-10-24T10:00:00Z',
  pushed: false,
  onRemote: false,
  ...patch
})

interface GitMock {
  status: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  branches: ReturnType<typeof vi.fn>
  diffStats: ReturnType<typeof vi.fn>
  checkout: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  push: ReturnType<typeof vi.fn>
}

const installGit = (patch: Partial<GitMock> = {}): GitMock => {
  const git: GitMock = {
    status: vi.fn(async () => repoStatus()),
    log: vi.fn(async () => [commit()]),
    branches: vi.fn(async (): Promise<GitBranchInfo> => ({ current: 'main', branches: ['main', 'dev'] })),
    diffStats: vi.fn(async (): Promise<GitDiffStats> => ({ additions: 4, deletions: 1, filesChanged: 2 })),
    checkout: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    ...patch
  }
  vi.stubGlobal('window', {
    mousse: { git },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  return git
}

describe('shared git status store', () => {
  beforeEach(() => {
    useGitStatusStore.setState({ entries: {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shares one fetch between concurrent requests for the same path', async () => {
    const git = installGit()
    await Promise.all([refreshGitStatus('/repo/a'), refreshGitStatus('/repo/a'), refreshGitStatus('/repo/a', { quiet: true })])
    expect(git.status).toHaveBeenCalledTimes(1)
    expect(git.log).toHaveBeenCalledTimes(1)
    expect(git.branches).toHaveBeenCalledTimes(1)
    expect(git.diffStats).toHaveBeenCalledTimes(1)
    const entry = useGitStatusStore.getState().entries['/repo/a']
    expect(entry.loaded).toBe(true)
    expect(entry.loading).toBe(false)
    expect(entry.status?.branch).toBe('main')
    expect(entry.commits).toHaveLength(1)
    expect(entry.diffStats?.additions).toBe(4)
  })

  it('fetches paths independently', async () => {
    const git = installGit()
    await Promise.all([refreshGitStatus('/repo/a'), refreshGitStatus('/repo/b')])
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(git.status).toHaveBeenCalledWith(undefined, '/repo/a')
    expect(git.status).toHaveBeenCalledWith(undefined, '/repo/b')
  })

  it('skips an ordinary request while the data is fresh, but a forced refresh refetches', async () => {
    const git = installGit()
    await refreshGitStatus('/repo/a')
    await refreshGitStatus('/repo/a')
    expect(git.status).toHaveBeenCalledTimes(1)
    await refreshGitStatus('/repo/a', { force: true })
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('fetches again once the data has gone stale', async () => {
    vi.useFakeTimers()
    const git = installGit()
    await refreshGitStatus('/repo/a')
    vi.advanceTimersByTime(5000)
    await refreshGitStatus('/repo/a')
    expect(git.status).toHaveBeenCalledTimes(2)
  })

  it('queues exactly one more fetch when a forced refresh arrives mid-fetch', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const git = installGit({
      status: vi.fn()
        .mockImplementationOnce(async () => { await gate; return repoStatus({ branch: 'old' }) })
        .mockImplementation(async () => repoStatus({ branch: 'new' }))
    })
    const first = refreshGitStatus('/repo/a')
    const forced = refreshGitStatus('/repo/a', { force: true })
    const forcedAgain = refreshGitStatus('/repo/a', { force: true })
    release?.()
    await Promise.all([first, forced, forcedAgain])
    expect(git.status).toHaveBeenCalledTimes(2)
    expect(useGitStatusStore.getState().entries['/repo/a'].status?.branch).toBe('new')
  })

  it('does not flag loading for quiet refreshes of loaded data', async () => {
    installGit()
    await refreshGitStatus('/repo/a')
    const seen: boolean[] = []
    const stop = useGitStatusStore.subscribe((state) => seen.push(state.entries['/repo/a'].loading))
    await refreshGitStatus('/repo/a', { force: true, quiet: true })
    stop()
    expect(seen).not.toContain(true)
  })

  it('flags loading only for the first fetch of a folder, never for a later refresh', async () => {
    installGit()
    const seen: boolean[] = []
    const stop = useGitStatusStore.subscribe((state) => seen.push(state.entries['/repo/a']?.loading))
    await refreshGitStatus('/repo/a')
    expect(seen).toContain(true)
    seen.length = 0
    // What the Git panel asks for on mount and from its refresh button.
    await refreshGitStatus('/repo/a', { force: true })
    await refreshGitStatus('/repo/a', { force: true, quiet: false })
    stop()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).not.toContain(true)
  })

  it('keeps loaded data free of loading when a refresh joins a fetch already running', async () => {
    installGit()
    await refreshGitStatus('/repo/a')
    const first = refreshGitStatus('/repo/a', { force: true })
    const joined = refreshGitStatus('/repo/a')
    expect(useGitStatusStore.getState().entries['/repo/a'].loading).toBe(false)
    await Promise.all([first, joined])
  })

  it('clears commits, branches and stats for a folder that is not a repo', async () => {
    installGit({ status: vi.fn(async () => repoStatus({ isRepo: false, branch: null, tracking: 'none' })) })
    await refreshGitStatus('/plain')
    const entry = useGitStatusStore.getState().entries['/plain']
    expect(entry.loaded).toBe(true)
    expect(entry.status?.isRepo).toBe(false)
    expect(entry.commits).toEqual([])
    expect(entry.branches).toBeNull()
    expect(entry.diffStats).toBeNull()
  })

  it('records a failed status fetch without rejecting', async () => {
    installGit({ status: vi.fn(async () => { throw new Error('spawn failed') }) })
    await expect(refreshGitStatus('/broken')).resolves.toBeUndefined()
    const entry = useGitStatusStore.getState().entries['/broken']
    expect(entry.loaded).toBe(true)
    expect(entry.error).toBe('spawn failed')
    expect(entry.loading).toBe(false)
  })

  it('keeps unchanged data by reference across refreshes', async () => {
    installGit()
    await refreshGitStatus('/repo/a')
    const before = useGitStatusStore.getState().entries['/repo/a']
    await refreshGitStatus('/repo/a', { force: true })
    const after = useGitStatusStore.getState().entries['/repo/a']
    expect(after.status).toBe(before.status)
    expect(after.commits).toBe(before.commits)
    expect(after.branches).toBe(before.branches)
  })

  it('refreshes after a checkout and after a commit', async () => {
    const git = installGit()
    await refreshGitStatus('/repo/a')
    await checkoutGitBranch('/repo/a', 'dev')
    expect(git.checkout).toHaveBeenCalledWith('dev', undefined, '/repo/a')
    expect(git.status).toHaveBeenCalledTimes(2)
    await commitGitChanges('/repo/a', 'Add things', 'project-1')
    expect(git.commit).toHaveBeenCalledWith('Add things', 'project-1', '/repo/a', { amend: false })
    expect(git.status).toHaveBeenCalledTimes(3)
  })

  it('does not refresh after a checkout that fails', async () => {
    const git = installGit({ checkout: vi.fn(async () => { throw new Error('local changes would be overwritten') }) })
    await refreshGitStatus('/repo/a')
    await expect(checkoutGitBranch('/repo/a', 'dev')).rejects.toThrow('overwritten')
    expect(git.status).toHaveBeenCalledTimes(1)
  })

  it('refreshes retained paths when the window regains focus, and stops after release', async () => {
    vi.useFakeTimers()
    const git = installGit()
    const listeners = new Map<string, () => void>()
    const win = (globalThis as unknown as { window: { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> } }).window
    win.addEventListener.mockImplementation((type: string, listener: () => void) => { listeners.set(type, listener) })
    const releaseOne = retainGitPath('/repo/a')
    const releaseTwo = retainGitPath('/repo/a')
    expect(win.addEventListener).toHaveBeenCalledTimes(1)
    await refreshGitStatus('/repo/a')
    vi.advanceTimersByTime(5000)
    listeners.get('focus')?.()
    await vi.waitFor(() => expect(git.status).toHaveBeenCalledTimes(2))
    releaseOne()
    expect(win.removeEventListener).not.toHaveBeenCalled()
    releaseTwo()
    expect(win.removeEventListener).toHaveBeenCalledWith('focus', listeners.get('focus'))
  })
})

describe('retainGitPath release', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is idempotent: a second call does not take a count that belongs to another holder', () => {
    installGit()
    const win = (globalThis as unknown as { window: { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> } }).window
    const releaseOne = retainGitPath('/repo/held')
    const releaseTwo = retainGitPath('/repo/held')
    releaseOne()
    releaseOne()
    releaseOne()
    // The second holder still keeps the path, and the shared listener, alive.
    expect(win.removeEventListener).not.toHaveBeenCalled()
    releaseTwo()
    expect(win.removeEventListener).toHaveBeenCalledTimes(1)
    releaseTwo()
    expect(win.removeEventListener).toHaveBeenCalledTimes(1)
  })
})

describe('anyTurnEnded', () => {
  const turn = (threadId: string, phase: TurnState['phase']): TurnState => ({
    threadId, turnId: 't', phase, updatedAt: '2026-10-24T10:00:00Z'
  })
  const snapshot = (...turns: TurnState[]): TurnStateSnapshot => Object.fromEntries(turns.map((t) => [t.threadId, t]))

  it('detects a running turn finishing', () => {
    expect(anyTurnEnded(snapshot(turn('a', 'streaming')), snapshot(turn('a', 'completed')))).toBe(true)
    expect(anyTurnEnded(snapshot(turn('a', 'tool_running')), snapshot(turn('a', 'stopped')))).toBe(true)
  })

  it('ignores turns that keep running, start, or were already finished', () => {
    expect(anyTurnEnded(snapshot(turn('a', 'thinking')), snapshot(turn('a', 'streaming')))).toBe(false)
    expect(anyTurnEnded(snapshot(turn('a', 'completed')), snapshot(turn('a', 'streaming')))).toBe(false)
    expect(anyTurnEnded(snapshot(turn('a', 'completed')), snapshot(turn('a', 'completed')))).toBe(false)
    const same = snapshot(turn('a', 'streaming'))
    expect(anyTurnEnded(same, same)).toBe(false)
  })
})

describe('git section formatting', () => {
  const NOW = Date.parse('2026-10-24T12:00:00Z')

  it('labels the diff stat with a real minus sign and flags zeros', () => {
    expect(diffStatLabel({ additions: 12, deletions: 3, filesChanged: 2 })).toEqual({
      added: '+12', removed: '−3', untracked: null, addedZero: false, removedZero: false, text: '+12 −3'
    })
    const onlyAdds = diffStatLabel({ additions: 5, deletions: 0, filesChanged: 1 })
    expect(onlyAdds.removedZero).toBe(true)
    expect(onlyAdds.addedZero).toBe(false)
    expect(diffStatLabel(null)).toMatchObject({ text: '+0 −0', addedZero: true, removedZero: true })
  })

  it('adds a short count of new files after the diff stat, since a diff never includes them', () => {
    const withNew = diffStatLabel({ additions: 0, deletions: 0, filesChanged: 0 }, 1)
    expect(withNew).toMatchObject({ untracked: '1 new', text: '+0 −0 · 1 new', addedZero: true, removedZero: true })
    expect(diffStatLabel({ additions: 4, deletions: 1, filesChanged: 2 }, 3).text).toBe('+4 −1 · 3 new')
    expect(diffStatLabel({ additions: 4, deletions: 1, filesChanged: 2 }).untracked).toBeNull()
    expect(diffStatLabel(null, 0).text).toBe('+0 −0')
  })

  it('counts only untracked files as new', () => {
    const status = repoStatus({
      changes: [
        { path: 'a.ts', status: 'modified', staged: false },
        { path: 'b.ts', status: 'untracked', staged: false },
        { path: 'c.ts', status: 'untracked', staged: false },
        { path: 'dist/x', status: 'ignored', staged: false }
      ]
    })
    expect(untrackedFileCount(status)).toBe(2)
    expect(untrackedFileCount(repoStatus())).toBe(0)
    expect(untrackedFileCount(null)).toBe(0)
  })

  it('summarizes changed files and ignores ignored ones', () => {
    const status = repoStatus({
      changes: [
        { path: 'a.ts', status: 'modified', staged: false },
        { path: 'b.ts', status: 'untracked', staged: false },
        { path: 'dist/x', status: 'ignored', staged: false }
      ]
    })
    expect(changedFileCount(status)).toBe(2)
    expect(changesSummary(status)).toBe('2 files changed')
    expect(changesSummary(repoStatus({ changes: [{ path: 'a.ts', status: 'added', staged: true }] }))).toBe('1 file changed')
    expect(changesSummary(repoStatus())).toBe('No changes')
    expect(changesSummary(null)).toBe('No changes')
  })

  it('formats relative time compactly', () => {
    const ago = (ms: number) => new Date(NOW - ms).toISOString()
    expect(relativeTime(ago(10_000), NOW)).toBe('now')
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5m')
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3h')
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe('2d')
    expect(relativeTime(ago(21 * 86_400_000), NOW)).toBe('3w')
    expect(relativeTime(ago(90 * 86_400_000), NOW)).toBe('3mo')
    expect(relativeTime(ago(800 * 86_400_000), NOW)).toBe('2y')
    expect(relativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe('now')
    expect(relativeTime('not a date', NOW)).toBe('')
  })

  it('builds the commit line from the first message line and keeps the full message for the tooltip', () => {
    const line = formatCommitLine(
      commit({ message: 'Fix the flaky retry test\n\nThe timer was shared.', date: '2026-10-24T11:55:00Z' }),
      NOW
    )
    expect(line.subject).toBe('Fix the flaky retry test')
    expect(line.shortHash).toBe('a1b2c3d')
    expect(line.when).toBe('5m')
    expect(line.title).toContain('The timer was shared.')
    expect(line.title).toContain('a1b2c3d')
    expect(formatCommitLine(commit({ message: '  ' }), NOW).subject).toBe('(no message)')
  })

  it('lists local branches before remote ones and filters by the query', () => {
    const info: GitBranchInfo = { current: 'main', branches: ['remotes/origin/main', 'main', 'feature/login', 'remotes/origin/dev'] }
    expect(branchChoices(info, '')).toEqual(['main', 'feature/login', 'remotes/origin/main', 'remotes/origin/dev'])
    expect(branchChoices(info, ' LOG ')).toEqual(['feature/login'])
    expect(branchChoices(info, 'zzz')).toEqual([])
    expect(branchChoices(null, '')).toEqual([])
  })

  it('names the branch, including a detached or unborn checkout', () => {
    expect(branchLabel(repoStatus())).toBe('main')
    expect(branchLabel(repoStatus({ branch: null, tracking: 'detached' }))).toBe('Detached HEAD')
    expect(branchLabel(repoStatus({ branch: null, tracking: 'unborn' }))).toBe('No branch')
    expect(branchLabel(null)).toBe('No branch')
  })

  it('reduces a git failure to one readable line', () => {
    const raw = new Error(
      "Error invoking remote method 'git:checkout': Error: error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes"
    )
    expect(gitErrorMessage(raw)).toBe('Your local changes to the following files would be overwritten by checkout:')
    expect(gitErrorMessage('fatal: not a git repository')).toBe('not a git repository')
    expect(gitErrorMessage(new Error(''))).toBe('Git command failed')
  })
})

describe('git section stylesheet', () => {
  const css = readFileSync(resolve(__dirname, '../src/renderer/components/sideCard/gitSection.css'), 'utf8')
  // Body of the rule that opens with exactly this selector.
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`)
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
  }

  it('keeps the popover free of transitions, so focus can move in once it is positioned', () => {
    expect(rule('.side-card-git-popover')).toMatch(/transition:\s*none/)
  })

  it('marks the selected branch with a neutral fill, not an accent tint', () => {
    const selected = rule(".side-card-git-option[aria-selected='true']")
    expect(selected).toMatch(/background:\s*var\(--ui-pressed\)/)
    expect(selected).not.toContain('accent')
  })

  it('leaves the commit submit buttons neutral', () => {
    expect(rule('.side-card-git-submit')).not.toMatch(/accent/)
    expect(rule('.side-card-git-submit-quiet')).not.toMatch(/accent/)
  })

  it('removes the global focus ring from the branch search', () => {
    const focus = rule('.side-card-git-search input:focus')
    expect(focus).toMatch(/box-shadow:\s*none/)
    expect(focus).toMatch(/outline:\s*none/)
    expect(focus).toMatch(/border:\s*0/)
  })

  it('keeps the action buttons on one line and the branch name the part that shrinks', () => {
    expect(rule('.side-card-git-commit-button,\n.side-card-git-push')).toMatch(/flex:\s*none/)
    expect(rule('.side-card-git-commit-button,\n.side-card-git-push')).toMatch(/white-space:\s*nowrap/)
    expect(rule('.side-card-git-branch')).toMatch(/min-width:\s*0/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.side-card-git-pr-pending \{\s*animation: none/)
  })
})

describe('branch search semantics', () => {
  it('describes a combobox that controls the branch list and points at the active option', () => {
    expect(branchSearchAria('list-1', 2, 5)).toEqual({
      role: 'combobox',
      'aria-expanded': true,
      'aria-controls': 'list-1',
      'aria-autocomplete': 'list',
      'aria-activedescendant': 'list-1-2'
    })
  })

  it('points at no option when nothing matches', () => {
    expect(branchSearchAria('list-1', 0, 0)['aria-activedescendant']).toBeUndefined()
  })
})

describe('git section collapsed state', () => {
  const base = { hasProject: true, pathPending: false, hasPath: true, loaded: true, status: repoStatus() }

  it('stays expanded for a loaded repository', () => {
    expect(gitCollapsedLabel(base)).toBeNull()
  })

  it('collapses to one line for each reason there is nothing to manage', () => {
    expect(gitCollapsedLabel({ ...base, hasProject: false })).toBe('Git: no project')
    expect(gitCollapsedLabel({ ...base, pathPending: true })).toBe('Git: checking…')
    expect(gitCollapsedLabel({ ...base, hasPath: false })).toBe('Git: no project folder')
    expect(gitCollapsedLabel({ ...base, loaded: false, status: null })).toBe('Git: checking…')
    expect(gitCollapsedLabel({ ...base, status: null })).toBe('Git: unavailable')
    expect(gitCollapsedLabel({ ...base, status: repoStatus({ isRepo: false, branch: null }) })).toBe('Git: not a repository')
  })
})

describe('git section markup', () => {
  const view = (patch: Partial<GitStatusView> = {}): GitStatusView => ({
    ...EMPTY_GIT_ENTRY,
    loaded: true,
    refresh: async () => undefined,
    ...patch
  })
  const render = (props: { git: GitStatusView; collapsedLabel: string | null; path?: string | null }) =>
    renderToStaticMarkup(createElement(GitSectionView, {
      threadId: 't1',
      projectId: 'p1',
      path: props.path === undefined ? '/repo/a' : props.path,
      git: props.git,
      collapsedLabel: props.collapsedLabel,
      now: Date.parse('2026-10-24T10:05:00Z')
    }))

  it('renders only the quiet line when the folder is not a repository', () => {
    const html = render({
      git: view({ status: repoStatus({ isRepo: false, branch: null }) }),
      collapsedLabel: 'Git: not a repository'
    })
    expect(html).toContain('Git: not a repository')
    expect(html).toContain('side-card-git-quiet')
    expect(html).not.toContain('side-card-git-branch')
    expect(html).not.toContain('Commit')
    expect(html).not.toContain('<h3')
  })

  it('renders the quiet line for a thread without a project', () => {
    const html = render({ git: view(), collapsedLabel: 'Git: no project', path: null })
    expect(html).toContain('Git: no project')
    expect(html).not.toContain('side-card-git-branch')
  })

  it('renders branch, changes, latest commit and an enabled commit button for a repo with changes', () => {
    const html = render({
      git: view({
        status: repoStatus({ changes: [{ path: 'a.ts', status: 'modified', staged: false }] }),
        commits: [commit()],
        branches: { current: 'main', branches: ['main', 'dev'] },
        diffStats: { additions: 12, deletions: 3, filesChanged: 1 }
      }),
      collapsedLabel: null
    })
    expect(html).toContain('Git</h3>')
    expect(html).toContain('>main<')
    expect(html).toContain('1 file changed')
    expect(html).toContain('+12')
    expect(html).toContain('−3')
    expect(html).toContain('Fix the flaky retry test')
    expect(html).toContain('a1b2c3d')
    expect(html).toContain('>5m<')
    expect(html).toMatch(/<button[^>]*class="side-card-git-commit-button"(?![^>]*disabled)/)
  })

  it('counts a lone new file in the changes row and keeps the zero figures muted', () => {
    const html = render({
      git: view({
        status: repoStatus({ changes: [{ path: 'new.ts', status: 'untracked', staged: false }] }),
        commits: [commit()],
        branches: { current: 'main', branches: ['main'] },
        diffStats: { additions: 0, deletions: 0, filesChanged: 0 }
      }),
      collapsedLabel: null
    })
    expect(html).toContain('1 file changed')
    expect(html).toContain('data-zero="true">+0')
    expect(html).toContain('data-zero="true">−0')
    expect(html).toContain('side-card-git-new">· 1 new<')
    expect(html).toContain('+0 −0 · 1 new')
  })

  it('shows no new-file count when nothing is untracked', () => {
    const html = render({
      git: view({
        status: repoStatus({ changes: [{ path: 'a.ts', status: 'modified', staged: false }] }),
        diffStats: { additions: 2, deletions: 0, filesChanged: 1 }
      }),
      collapsedLabel: null
    })
    expect(html).not.toContain('side-card-git-new')
  })

  it('disables the commit button and mutes the stat when there are no changes', () => {
    const html = render({
      git: view({
        status: repoStatus(),
        commits: [commit({ pushed: true, onRemote: true })],
        branches: { current: 'main', branches: ['main'] },
        diffStats: { additions: 0, deletions: 0, filesChanged: 0 }
      }),
      collapsedLabel: null
    })
    expect(html).toContain('No changes')
    expect(html).toMatch(/class="side-card-git-commit-button"[^>]*disabled/)
    expect(html).toContain('title="No changes to commit"')
    expect(html).toContain('data-zero="true">+0')
    expect(html).toContain('data-zero="true">−0')
  })
})
