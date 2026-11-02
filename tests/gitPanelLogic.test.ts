import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GitChangesList } from '../src/renderer/components/git/GitChangesList'
import { GitSyncBar } from '../src/renderer/components/git/GitSyncBar'
import {
  IDLE_SYNC_ACTIVITY,
  abortLabel,
  discardPrompt,
  fetchResultNotice,
  groupChanges,
  pullChoices,
  pullResultNotice,
  rowActionLabel,
  rowActions,
  sectionAction,
  selectionAfterAction,
  syncActivityLine,
  syncControls,
  syncLabel,
  syncState,
  type SyncActivity
} from '../src/renderer/components/git/gitPanelLogic'
import type { GitFileChange, GitScope, GitStatusSnapshot } from '../src/shared/types'

const project: GitScope = { projectId: 'p1', workspaceThreadId: null }
const thread: GitScope = { projectId: 'p1', workspaceThreadId: 't1' }

const status = (patch: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot => ({
  isRepo: true,
  branch: 'main',
  upstream: 'origin/main',
  tracking: 'tracked',
  ahead: 0,
  behind: 0,
  changes: [],
  hasRemote: true,
  ...patch
})

const change = (path: string, patch: Partial<GitFileChange> = {}): GitFileChange => ({
  path,
  status: 'modified',
  staged: false,
  ...patch
})

describe('sync state', () => {
  it('names where the branch stands against its upstream', () => {
    expect(syncState(status())).toMatchObject({ kind: 'up-to-date', ahead: 0, behind: 0 })
    expect(syncState(status({ behind: 2 }))).toMatchObject({ kind: 'behind', behind: 2 })
    expect(syncState(status({ ahead: 3 }))).toMatchObject({ kind: 'ahead', ahead: 3 })
    expect(syncState(status({ ahead: 1, behind: 2 }))).toMatchObject({ kind: 'diverged', ahead: 1, behind: 2 })
  })

  it('reports conflicted files first, with the files, and what is stopped', () => {
    const state = syncState(status({
      ahead: 1,
      behind: 1,
      inProgress: 'merge',
      changes: [change('a.ts', { status: 'conflicted' }), change('b.ts', { status: 'conflicted' }), change('c.ts')]
    }))
    expect(state).toMatchObject({ kind: 'conflicted', files: ['a.ts', 'b.ts'], what: 'merge' })
  })

  it('reports a stopped merge or rebase without conflicts as in progress', () => {
    expect(syncState(status({ inProgress: 'rebase' }))).toMatchObject({ kind: 'in-progress', what: 'rebase', files: [] })
  })

  it('has no upstream to compare with on a local, detached or unborn branch', () => {
    expect(syncState(status({ tracking: 'none', upstream: null }))).toMatchObject({ kind: 'no-upstream', noUpstream: 'untracked' })
    expect(syncState(status({ tracking: 'detached', branch: null, upstream: null }))).toMatchObject({ kind: 'no-upstream', noUpstream: 'detached' })
    expect(syncState(status({ tracking: 'unborn', upstream: null }))).toMatchObject({ kind: 'no-upstream', noUpstream: 'unborn' })
  })

  it('describes no state for a folder that is not a repository', () => {
    expect(syncState(null)).toBeNull()
    expect(syncState(status({ isRepo: false }))).toBeNull()
  })

  it('words each state in one line', () => {
    const label = (patch: Partial<GitStatusSnapshot>) => syncLabel(syncState(status(patch))!)
    expect(label({})).toBe('Up to date with origin/main')
    expect(label({ behind: 1 })).toBe('Behind origin/main by 1 commit')
    expect(label({ behind: 4 })).toBe('Behind origin/main by 4 commits')
    expect(label({ ahead: 2 })).toBe('Ahead of origin/main by 2 commits')
    expect(label({ ahead: 1, behind: 2 })).toBe('Diverged: 1 ahead, 2 behind')
    expect(label({ changes: [change('a.ts', { status: 'conflicted' })] })).toBe('Conflicted: 1 file')
    expect(label({ changes: [change('a.ts', { status: 'conflicted' }), change('b.ts', { status: 'conflicted' })] })).toBe('Conflicted: 2 files')
    expect(label({ inProgress: 'merge' })).toBe('Merge in progress')
    expect(label({ inProgress: 'rebase' })).toBe('Rebase in progress')
    expect(label({ inProgress: 'cherry-pick' })).toBe('Cherry-pick in progress')
    expect(label({ tracking: 'none', upstream: null })).toBe('No upstream branch')
    expect(label({ tracking: 'detached', branch: null, upstream: null })).toBe('Detached HEAD')
    expect(label({ tracking: 'unborn', upstream: null })).toBe('No commits yet')
  })
})

describe('pull choices and controls', () => {
  it('pulls fast-forward only, and offers merge or rebase once the sides have diverged', () => {
    expect(pullChoices(syncState(status({ behind: 2 })))).toEqual(['ff-only'])
    expect(pullChoices(syncState(status({ ahead: 1 })))).toEqual(['ff-only'])
    expect(pullChoices(syncState(status({ ahead: 1, behind: 2 })))).toEqual(['merge', 'rebase'])
    expect(pullChoices(null)).toEqual(['ff-only'])
  })

  it('enables Fetch and Pull for a tracked branch', () => {
    const controls = syncControls(status({ behind: 1 }), project)
    expect(controls.fetch).toEqual({ enabled: true, reason: null })
    expect(controls.pull).toEqual({ enabled: true, reason: null, choices: ['ff-only'] })
    expect(controls.abort).toBeNull()
  })

  it('gives a reason when Pull cannot run', () => {
    const reason = (patch: Partial<GitStatusSnapshot>, scope: GitScope = project) => syncControls(status(patch), scope).pull.reason
    expect(reason({ tracking: 'none', upstream: null })).toBe('No upstream branch to pull from')
    expect(reason({ tracking: 'detached', branch: null, upstream: null })).toBe('Detached HEAD has no upstream')
    expect(reason({ changes: [change('a.ts', { status: 'conflicted' })] })).toBe('Resolve the conflicted files first')
    expect(reason({ inProgress: 'rebase' })).toBe('Finish or abort the rebase first')
    expect(reason({ inProgress: 'cherry-pick' })).toBe('Finish or abort the cherry-pick first')
    expect(reason({ behind: 1 }, thread)).toBe("Not available in this thread's worktree")
  })

  it('still fetches in a thread worktree, but not without a remote', () => {
    expect(syncControls(status({ behind: 1 }), thread).fetch.enabled).toBe(true)
    expect(syncControls(status({ hasRemote: false, tracking: 'none', upstream: null }), project).fetch).toEqual({ enabled: false, reason: 'No remote configured' })
  })

  it('offers Abort only for a stopped merge or rebase', () => {
    expect(syncControls(status({ inProgress: 'merge' }), project).abort).toBe('merge')
    expect(syncControls(status({ inProgress: 'rebase', changes: [change('a.ts', { status: 'conflicted' })] }), project).abort).toBe('rebase')
    expect(syncControls(status({ inProgress: 'revert' }), project).abort).toBeNull()
    expect(abortLabel('merge')).toBe('Abort merge')
  })

  it('disables both without a repository', () => {
    const controls = syncControls(null, project)
    expect(controls.fetch.enabled).toBe(false)
    expect(controls.pull.enabled).toBe(false)
  })
})

describe('fetch and pull results', () => {
  it('says whether a fetch found anything', () => {
    expect(fetchResultNotice({ behindBefore: 0, behindAfter: 0 })).toBe('Already up to date')
    expect(fetchResultNotice({ behindBefore: 2, behindAfter: 2 })).toBe('Already up to date')
    expect(fetchResultNotice({ behindBefore: 0, behindAfter: 1 })).toBe('Fetched: 1 new commit')
    expect(fetchResultNotice({ behindBefore: 1, behindAfter: 4 })).toBe('Fetched: 3 new commits')
  })

  it('says what a pull did, and what to do when it stopped on conflicts', () => {
    expect(pullResultNotice('up-to-date')).toBe('Already up to date')
    expect(pullResultNotice('fast-forwarded')).toBe('Pulled: fast-forwarded')
    expect(pullResultNotice('merged')).toBe('Pulled: merged')
    expect(pullResultNotice('rebased')).toBe('Pulled: rebased')
    expect(pullResultNotice('conflicted')).toBe('Pull stopped on conflicts. Resolve the conflicted files, or abort.')
  })

  it('shows one line for the activity: progress and results as status, a failure as an alert with its reason', () => {
    expect(syncActivityLine(IDLE_SYNC_ACTIVITY)).toBeNull()
    expect(syncActivityLine({ phase: 'running', action: 'fetch' })).toEqual({ role: 'status', text: 'Fetching…' })
    expect(syncActivityLine({ phase: 'running', action: 'pull' })).toEqual({ role: 'status', text: 'Pulling…' })
    expect(syncActivityLine({ phase: 'done', action: 'fetch', message: 'Fetched: 2 new commits' })).toEqual({ role: 'status', text: 'Fetched: 2 new commits' })
    expect(syncActivityLine({ phase: 'failed', action: 'pull', message: 'Branches have diverged' })).toEqual({ role: 'alert', text: 'Pull failed: Branches have diverged' })
    expect(syncActivityLine({ phase: 'failed', action: 'fetch', message: 'No remote' })?.text).toBe('Fetch failed: No remote')
  })
})

describe('file rows', () => {
  it('stages a file that is not in the index, unstages one that is, and always can discard', () => {
    expect(rowActions(change('a.ts'), project)).toEqual(['stage', 'discard'])
    expect(rowActions(change('a.ts', { staged: true }), project)).toEqual(['unstage', 'discard'])
    expect(rowActions(change('n.ts', { status: 'untracked' }), project)).toEqual(['stage', 'discard'])
    expect(rowActions(change('c.ts', { status: 'conflicted' }), project)).toEqual(['stage', 'discard'])
    expect(rowActions(change('i.log', { status: 'ignored' }), project)).toEqual([])
  })

  it("keeps only discard in a thread's own worktree, where a commit takes every change", () => {
    expect(rowActions(change('a.ts'), thread)).toEqual(['discard'])
    expect(rowActions(change('a.ts', { staged: true }), thread)).toEqual(['discard'])
    expect(sectionAction('staged', project)).toBe('unstage-all')
    expect(sectionAction('changes', project)).toBe('stage-all')
    expect(sectionAction('untracked', project)).toBe('stage-all')
    expect(sectionAction('staged', thread)).toBeNull()
    expect(sectionAction('changes', thread)).toBeNull()
  })

  it('labels each button with the file it acts on', () => {
    expect(rowActionLabel('stage', change('src/a.ts'))).toBe('Stage src/a.ts')
    expect(rowActionLabel('unstage', change('src/a.ts', { staged: true }))).toBe('Unstage src/a.ts')
    expect(rowActionLabel('discard', change('src/a.ts'))).toBe('Discard changes to src/a.ts')
    expect(rowActionLabel('discard', change('new.ts', { status: 'untracked' }))).toBe('Delete untracked file new.ts')
  })

  it('groups files, with a file staged and edited again in both lists and conflicts apart', () => {
    const groups = groupChanges([
      change('mm.ts', { staged: true }),
      change('mm.ts'),
      change('only-staged.ts', { staged: true, status: 'added' }),
      change('new.ts', { status: 'untracked' }),
      change('both.ts', { status: 'conflicted' }),
      change('skip.log', { status: 'ignored' })
    ])
    expect(groups.staged.map((file) => file.path)).toEqual(['mm.ts', 'only-staged.ts'])
    expect(groups.unstaged.map((file) => file.path)).toEqual(['mm.ts'])
    expect(groups.untracked.map((file) => file.path)).toEqual(['new.ts'])
    expect(groups.conflicts.map((file) => file.path)).toEqual(['both.ts'])
  })

  it('moves the open file with the action, and closes a discarded one', () => {
    const open = { path: 'a.ts', staged: false }
    expect(selectionAfterAction(open, 'stage', ['a.ts'])).toEqual({ path: 'a.ts', staged: true })
    expect(selectionAfterAction({ path: 'a.ts', staged: true }, 'unstage', ['a.ts'])).toEqual({ path: 'a.ts', staged: false })
    expect(selectionAfterAction({ path: 'a.ts', staged: true }, 'unstage', 'all')).toEqual({ path: 'a.ts', staged: false })
    expect(selectionAfterAction(open, 'discard', ['a.ts'])).toBeNull()
    expect(selectionAfterAction(open, 'stage', ['other.ts'])).toBe(open)
    expect(selectionAfterAction(open, 'unstage', 'all')).toBe(open)
    expect(selectionAfterAction(null, 'stage', ['a.ts'])).toBeNull()
  })
})

describe('discard confirmation wording', () => {
  it('names one tracked file and warns that it cannot be undone', () => {
    expect(discardPrompt([change('src/a.ts')])).toBe('Discard changes to src/a.ts?\n\nThis cannot be undone.')
  })

  it('says an untracked file will be deleted', () => {
    expect(discardPrompt([change('new.ts', { status: 'untracked' })])).toBe(
      'Delete new.ts?\n\nIt is not tracked by Git, so it will be deleted.\n\nThis cannot be undone.'
    )
  })

  it('lists several files and marks the untracked ones', () => {
    const prompt = discardPrompt([change('a.ts'), change('new.ts', { status: 'untracked' })])
    expect(prompt).toContain('Discard changes to 2 files?')
    expect(prompt).toContain('  a.ts\n')
    expect(prompt).toContain('  new.ts (untracked, will be deleted)')
    expect(prompt.endsWith('This cannot be undone.')).toBe(true)
  })

  it('counts a file staged and edited again once, and shortens a long list', () => {
    expect(discardPrompt([change('mm.ts', { staged: true }), change('mm.ts')])).toBe('Discard changes to mm.ts?\n\nThis cannot be undone.')
    const many = Array.from({ length: 14 }, (_, index) => change(`f${index}.ts`))
    const prompt = discardPrompt(many)
    expect(prompt).toContain('Discard changes to 14 files?')
    expect(prompt).toContain('  f9.ts')
    expect(prompt).not.toContain('f10.ts')
    expect(prompt).toContain('…and 4 more')
  })
})

describe('changes list markup', () => {
  const render = (changes: GitFileChange[], scope: GitScope = project, patch: { selected?: { path: string; staged: boolean } | null; busy?: boolean } = {}) =>
    renderToStaticMarkup(createElement(GitChangesList, {
      changes,
      selected: patch.selected ?? null,
      onSelect: () => undefined,
      scope,
      busy: patch.busy ?? false,
      onRowAction: () => undefined,
      onSectionAction: () => undefined,
      flex: { conflicts: 1, staged: 1, changes: 1, untracked: 1, commits: 1 }
    }))
  const section = (html: string, id: string) => html.split('<div class="git-section"').find((part) => part.includes(`data-section="${id}"`)) ?? ''

  it('shows a file staged and edited again in both sections, each with the actions of its side', () => {
    const html = render([change('mm.ts', { staged: true }), change('mm.ts')])
    const staged = section(html, 'staged')
    const changes = section(html, 'changes')
    expect(staged).toContain('mm.ts')
    expect(staged).toContain('aria-label="Unstage mm.ts"')
    expect(staged).toContain('aria-label="Discard changes to mm.ts"')
    expect(staged).not.toContain('aria-label="Stage mm.ts"')
    expect(staged).toContain('>Unstage all<')
    expect(changes).toContain('mm.ts')
    expect(changes).toContain('aria-label="Stage mm.ts"')
    expect(changes).toContain('aria-label="Discard changes to mm.ts"')
    expect(changes).not.toContain('aria-label="Unstage mm.ts"')
    expect(changes).toContain('>Stage all<')
  })

  it('lists conflicted files in their own section', () => {
    const html = render([change('c.ts', { status: 'conflicted' }), change('a.ts')])
    expect(section(html, 'conflicts')).toContain('c.ts')
    expect(section(html, 'conflicts')).toContain('git-status-badge status-conflicted')
    expect(section(html, 'changes')).not.toContain('c.ts')
  })

  it('hides stage and unstage in a thread worktree and keeps discard', () => {
    const html = render([change('mm.ts', { staged: true }), change('mm.ts'), change('new.ts', { status: 'untracked' })], thread)
    expect(html).not.toContain('aria-label="Stage ')
    expect(html).not.toContain('aria-label="Unstage ')
    expect(html).not.toContain('Stage all')
    expect(html).not.toContain('Unstage all')
    expect(html).toContain('aria-label="Discard changes to mm.ts"')
    expect(html).toContain('aria-label="Delete untracked file new.ts"')
  })

  it('disables the buttons while a Git action runs', () => {
    const html = render([change('a.ts')], project, { busy: true })
    expect(html).toMatch(/aria-label="Stage a.ts"[^>]*disabled=""/)
    expect(html).toMatch(/aria-label="Discard changes to a.ts"[^>]*disabled=""/)
    expect(html).toMatch(/class="git-section-action" disabled=""/)
  })

  it('marks the open row by a class on the row, and shows a clean tree', () => {
    const html = render([change('a.ts'), change('b.ts')], project, { selected: { path: 'b.ts', staged: false } })
    expect(html.match(/git-file-row selected/g)).toHaveLength(1)
    expect(html).toMatch(/git-file-row selected"><button[^>]*aria-current="true"[^>]*><span[^>]*>M<\/span><span class="git-file-path">b.ts</)
    expect(render([])).toContain('Working tree clean')
  })

  it('highlights the selected row with a background only, never an edge bar', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/styles/app.css'), 'utf8')
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`)
      expect(start).toBeGreaterThan(-1)
      return css.slice(start, css.indexOf('}', start))
    }
    const selected = rule('.git-file-row.selected')
    expect(selected).toContain('background:')
    expect(selected).not.toMatch(/border|box-shadow|outline/)
    expect(css).not.toMatch(/\.git-file-row[^{]*::(before|after)/)
  })
})

describe('sync bar markup', () => {
  const render = (patch: Partial<GitStatusSnapshot>, activity: SyncActivity = IDLE_SYNC_ACTIVITY, scope: GitScope = project, busy = false) =>
    renderToStaticMarkup(createElement(GitSyncBar, {
      status: status(patch),
      scope,
      activity,
      busy,
      onFetch: () => undefined,
      onPull: () => undefined,
      onAbort: () => undefined
    }))

  it('shows the state with Fetch and Pull', () => {
    const html = render({ behind: 2 })
    expect(html).toContain('data-state="behind"')
    expect(html).toContain('Behind origin/main by 2 commits')
    expect(html).toMatch(/<button[^>]*>(<svg.*?<\/svg>)?Fetch<\/button>/)
    expect(html).toMatch(/<button[^>]*>(<svg.*?<\/svg>)?Pull<\/button>/)
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('Abort')
  })

  it('offers Merge and Rebase instead of one Pull when diverged', () => {
    const html = render({ ahead: 1, behind: 1 })
    expect(html).toContain('data-state="diverged"')
    expect(html).toContain('aria-label="Pull and merge"')
    expect(html).toContain('aria-label="Pull and rebase"')
    expect(html).not.toMatch(/>Pull<\/button>/)
  })

  it('lists the conflicted state and offers Abort for a stopped merge, with Pull off', () => {
    const html = render({ inProgress: 'merge', changes: [change('a.ts', { status: 'conflicted' })] })
    expect(html).toContain('data-state="conflicted"')
    expect(html).toContain('Conflicted: 1 file')
    expect(html).toContain('Abort merge')
    expect(html).toMatch(/title="Resolve the conflicted files first"[^>]*disabled=""/)
  })

  it('shows progress and results as a status line and a failure with its reason as an alert', () => {
    expect(render({}, { phase: 'running', action: 'fetch' })).toContain('role="status">Fetching…<')
    expect(render({}, { phase: 'running', action: 'fetch' })).toMatch(/aria-busy="true"[^>]*disabled=""[^>]*>(<svg.*?<\/svg>)?Fetching…/)
    expect(render({ behind: 2 }, { phase: 'done', action: 'fetch', message: 'Fetched: 2 new commits' })).toContain('role="status">Fetched: 2 new commits<')
    const failed = render({}, { phase: 'failed', action: 'pull', message: 'Branches have diverged' })
    expect(failed).toContain('role="alert">Pull failed: Branches have diverged<')
    expect(failed).toContain('role="status"></div>')
  })

  it('disables Fetch and Pull while another Git action runs, and Pull in a thread worktree', () => {
    const busy = render({}, IDLE_SYNC_ACTIVITY, project, true)
    expect(busy).toMatch(/title="Another Git action is running"[^>]*disabled=""[^>]*>(<svg.*?<\/svg>)?Fetch/)
    expect(busy).toMatch(/title="Another Git action is running"[^>]*disabled=""[^>]*>(<svg.*?<\/svg>)?Pull/)
    const inThread = render({ behind: 1 }, IDLE_SYNC_ACTIVITY, thread)
    expect(inThread).toMatch(/title="Not available in this thread&#x27;s worktree"[^>]*disabled=""[^>]*>(<svg.*?<\/svg>)?Pull/)
    expect(inThread).toMatch(/<button(?![^>]*disabled)[^>]*>(<svg.*?<\/svg>)?Fetch/)
  })

  it('renders nothing for a folder that is not a repository', () => {
    expect(render({ isRepo: false })).toBe('')
  })
})
