import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { describeRecovery, recoveryErrorText } from '../src/mms/workspace/workspaceRecovery'
import { ManagedConflictService } from '../src/mms/actions/ManagedConflictService'
import { tryGit } from '../src/mms/actions/git'
import { mergeIdentity } from '../src/mms/actions/leftMerge'
import { onGitPolicyEntry, type GitPolicyEntry } from '../src/mms/git/gitPolicy'
import { ensureSnapshotWorkspace } from '../src/mms/workspace/SnapshotWorkspace'
import { existsSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { cancelPendingIntegrations } from '../src/mms/agents/ChildAgentIntegrationService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { actionOptions, git } from './fixtures/gitFoundation'

/** A repository with one commit, a thread directory, and an own Mousse home for the worktree. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-recovery-test-'))
  const repo = join(root, 'primary')
  const home = join(root, 'home')
  const thread = join(root, 'thread')
  for (const dir of [repo, home, thread]) mkdirSync(dir)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'Recovery Test')
  git(repo, 'config', 'user.email', 'recovery@example.test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'value.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  const baseSha = git(repo, 'rev-parse', 'HEAD')
  const previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
  return {
    root, repo, thread, baseSha,
    commit(cwd: string, value: string, path = 'value.txt') {
      writeFileSync(join(cwd, path), value)
      git(cwd, 'add', '--', path)
      git(cwd, 'commit', '-qm', 'fixture change')
      return git(cwd, 'rev-parse', 'HEAD')
    },
    dispose() {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
}

let f: ReturnType<typeof fixture>
beforeEach(() => { f = fixture() })
afterEach(() => f.dispose())

const status = (threadDirectory = f.thread) => describeRecovery(threadDirectory, new ThreadWorkspaceManager(threadDirectory).verify())
const mergeHead = (cwd: string) => tryGit(cwd, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'])

/** A real `git merge` an older version started in `cwd`, stopped on a conflict: its HEAD before, and what it merges. */
function stoppedMerge(cwd: string, side: string) {
  const back = git(cwd, 'branch', '--show-current')
  git(cwd, 'switch', '-q', '-c', side); f.commit(cwd, `${side}\n`)
  const theirs = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'switch', '-q', back); f.commit(cwd, `ours ${side}\n`)
  const before = git(cwd, 'rev-parse', 'HEAD')
  expect(() => git(cwd, 'merge', '-q', '--no-edit', side)).toThrow()
  expect(mergeHead(cwd).stdout).toBe(theirs)
  return { before, theirs }
}

/** The record an upgrade leaves for a subagent merge an older version stopped in the worktree. */
function leftIntegration(threadDirectory: string, cwd: string) {
  const { before, theirs } = stoppedMerge(cwd, 'old-worker')
  const journal = new ThreadJournal(threadDirectory)
  journal.append({ operationId: 'old', operationType: 'child-integration', state: 'prepared', expectedPreState: { preMergeSha: before, workerHeadSha: theirs }, details: { request: { agentId: 'worker', operationId: 'old', expectedWorkerHead: theirs, threadWorkspace: cwd } } })
  journal.append({ operationId: 'old', operationType: 'child-integration', state: 'recovery_required', details: { preMergeSha: before, workerHeadSha: theirs } })
  expect(cancelPendingIntegrations(threadDirectory, cwd)).toEqual([expect.objectContaining({ operationId: 'old', mergeInProgress: cwd })])
  return { before }
}

/** The record recovery leaves for a Publish an older version stopped as a merge in the primary checkout. */
function leftPublishMerge(threadDirectory: string) {
  const { before, theirs } = stoppedMerge(f.repo, 'old-publish')
  const journal = new ThreadJournal(threadDirectory)
  journal.append({ operationId: 'old-publish', operationType: 'publish', state: 'prepared', expectedPreState: { prePublishSha: before, sourceSha: theirs, targetBranch: 'main' } })
  journal.append({ operationId: 'old-publish', operationType: 'publish', state: 'cancelled', details: { recovered: true, prePublishSha: before, mergeInProgress: f.repo, mergeIdentity: mergeIdentity(f.repo), sourceSha: theirs, reason: 'The publish did not land.' } })
  return { before }
}

describe('what a thread is waiting on', () => {
  it('says nothing about a thread that is fine', async () => {
    await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    expect(status()).toBeUndefined()
  })

  it('says nothing when the agent switched to its own branch and committed, and leaves both where the agent put them', async () => {
    const manager = new ThreadWorkspaceManager(f.thread)
    const workspace = await manager.provision('task', 'main', f.repo)
    const cwd = workspace.worktreePath
    git(cwd, 'switch', '-q', '-c', 'agent/task')
    const agentTip = f.commit(cwd, 'agent work\n', 'agent.txt')
    await new ThreadActionService(f.thread).checkpointExistingTurn(actionOptions(cwd), workspace.headSha, 'completed')
    expect(manager.verify().lifecycle).toBe('ready')
    expect(status()).toBeUndefined()
    expect(git(cwd, 'branch', '--show-current')).toBe('agent/task')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(agentTip)
  })

  it('pauses the thread for an operation that is waiting, with what Git said and not the command line', async () => {
    await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    new ThreadJournal(f.thread).append({
      operationId: 'undo-1', operationType: 'undo', state: 'recovery_required',
      details: { error: "Error: Command failed: git -c core.fsmonitor=false -c core.hooksPath=/dev/null read-tree -u\nerror: Entry 'value.txt' not uptodate. Cannot merge.\n" }
    })
    expect(new ThreadWorkspaceManager(f.thread).verify().lifecycle).toBe('recovery_required')
    expect(status()).toEqual({ kind: 'paused', reason: "error: Entry 'value.txt' not uptodate. Cannot merge.", operationId: 'undo-1', operationType: 'undo' })
  })

  it('names the operation when it stopped without saying why', async () => {
    await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    new ThreadJournal(f.thread).append({ operationId: 'revert-1', operationType: 'code-revert', state: 'prepared' })
    expect(status()).toEqual({ kind: 'paused', reason: 'The code-revert operation did not finish.', operationId: 'revert-1', operationType: 'code-revert' })
  })

  it('pauses the thread when Git cannot read the worktree', async () => {
    const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    writeFileSync(join(workspace.worktreePath, '.git'), 'gitdir: /nowhere\n')
    expect(status()).toEqual({ kind: 'paused', reason: 'Git cannot read the worktree.' })
  })

  it('reports a merge an earlier version left in the worktree, without pausing the thread, until it is aborted', async () => {
    const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    const { before } = leftIntegration(f.thread, workspace.worktreePath)
    expect(new ThreadWorkspaceManager(f.thread).verify().lifecycle).toBe('ready')
    expect(status()).toEqual({
      kind: 'merge',
      reason: `A merge from an earlier version of Mousse is still in progress in ${workspace.worktreePath}. Abort it, or finish it with Git.`,
      folder: workspace.worktreePath, operationId: 'old', operationType: 'child-integration'
    })
    await new ManagedConflictService(f.thread).abort(workspace.worktreePath, 'old')
    expect(mergeHead(workspace.worktreePath).ok).toBe(false)
    expect(git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(before)
    expect(status()).toBeUndefined()
  })

  it('stops reporting that merge once it is finished with Git, and never reports a merge someone else started', async () => {
    const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    const cwd = workspace.worktreePath
    leftIntegration(f.thread, cwd)
    git(cwd, 'merge', '--abort')
    expect(status()).toBeUndefined()
    // A merge the agent starts later in the same folder is the agent's, not the one recorded.
    stoppedMerge(cwd, 'agent-side')
    expect(status()).toBeUndefined()
  })

  it('never offers a merge started again by hand, even of the same commit at the same HEAD, and Abort leaves its edits alone', async () => {
    const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    const cwd = workspace.worktreePath
    const { before } = leftIntegration(f.thread, cwd)
    expect(status()).toMatchObject({ kind: 'merge' })
    // The person aborts the old merge, starts the same merge again at the same HEAD, and resolves part of it.
    git(cwd, 'merge', '--abort')
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before)
    expect(() => git(cwd, 'merge', '-q', '--no-edit', 'old-worker')).toThrow()
    writeFileSync(join(cwd, 'value.txt'), 'resolved by hand\n')
    expect(status()).toBeUndefined()
    // Abort through any path refuses, clears the record and leaves the merge and the edit as they are.
    await expect(new ManagedConflictService(f.thread).abort(cwd, 'old')).rejects.toThrow(/not the one an earlier version left/)
    expect(readFileSync(join(cwd, 'value.txt'), 'utf8')).toBe('resolved by hand\n')
    expect(mergeHead(cwd).ok).toBe(true)
    expect(new ThreadJournal(f.thread).latestByOperation().get('old')).toMatchObject({ state: 'cancelled', details: { mergeNoLongerRecorded: true } })
    expect(status()).toBeUndefined()
  })

  it('keeps every file, edits in conflicted ones included, before aborting the recorded merge', async () => {
    const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    const cwd = workspace.worktreePath
    leftIntegration(f.thread, cwd)
    // Editing a conflicted file and adding a new one does not make it another merge, but Abort must not lose them.
    writeFileSync(join(cwd, 'value.txt'), 'half resolved\n')
    writeFileSync(join(cwd, 'notes.txt'), 'notes\n')
    expect(status()).toMatchObject({ kind: 'merge', operationId: 'old' })
    const { preservedRef } = await new ManagedConflictService(f.thread).abort(cwd, 'old')
    expect(preservedRef).toMatch(/^refs\/mousse\/preserved\/old-abort-[0-9a-f]{12}$/)
    expect(mergeHead(cwd).ok).toBe(false)
    expect(git(cwd, 'show', `${preservedRef}:value.txt`)).toBe('half resolved')
    expect(git(cwd, 'show', `${preservedRef}:notes.txt`)).toBe('notes')
    expect(new ThreadJournal(f.thread).latestByOperation().get('old')).toMatchObject({ details: { conflictAborted: true, preservedRef } })
  })

  it('never offers a left merge whose record does not say which merge it was', async () => {
    const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    const cwd = workspace.worktreePath
    const { theirs } = stoppedMerge(cwd, 'unrecorded')
    new ThreadJournal(f.thread).append({ operationId: 'older', operationType: 'child-integration', state: 'cancelled', details: { mergeInProgress: cwd, workerHeadSha: theirs } })
    expect(status()).toBeUndefined()
  })

  it('never offers a left merge that Abort would refuse, such as one recorded without the HEAD it started from', async () => {
    const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    const cwd = workspace.worktreePath
    const { theirs } = stoppedMerge(cwd, 'no-base')
    new ThreadJournal(f.thread).append({ operationId: 'no-base', operationType: 'child-integration', state: 'cancelled', details: { mergeInProgress: cwd, mergeIdentity: mergeIdentity(cwd), workerHeadSha: theirs } })
    expect(status()).toBeUndefined()
    await expect(new ManagedConflictService(f.thread).abort(cwd, 'no-base')).rejects.toThrow('Conflict HEAD changed outside the selected operation.')
    expect(mergeHead(cwd).ok).toBe(true)
  })

  it('reports a merge a Publish from an earlier version left in the primary checkout', async () => {
    await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    leftPublishMerge(f.thread)
    expect(status()).toEqual(expect.objectContaining({ kind: 'merge', folder: f.repo, operationId: 'old-publish', operationType: 'publish' }))
  })

  it('reports a Publish that did not finish, without pausing the thread', async () => {
    await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
    new ThreadJournal(f.thread).append({ operationId: 'publish-1', operationType: 'publish', state: 'prepared' })
    expect(new ThreadWorkspaceManager(f.thread).verify().lifecycle).toBe('ready')
    expect(status()).toEqual({ kind: 'publish', reason: 'A Publish did not finish.', operationId: 'publish-1', operationType: 'publish' })
  })
})

describe('the text of a failed operation', () => {
  it('keeps a plain message, without the Error: prefix', () => {
    expect(recoveryErrorText(new Error('Interrupted commit needs recovery.'))).toBe('Interrupted commit needs recovery.')
    expect(recoveryErrorText('Error: The publish did not land.')).toBe('The publish did not land.')
  })

  it('drops the command line of a failed Git command and keeps what Git said', () => {
    const failed = "Error: Command failed: git -c core.fsmonitor=false -c core.hooksPath=/dev/null add -A -- . :(exclude).mousse\nerror: 'tool/' does not have a commit checked out\nfatal: adding files failed\n"
    expect(recoveryErrorText(failed)).toBe("error: 'tool/' does not have a commit checked out fatal: adding files failed")
    expect(recoveryErrorText('Command failed: git status')).toBe('A Git command failed without saying why.')
  })
})

describe('through the daemon', () => {
  /** A daemon with one thread on the project. `projectPath` is how the project was added (a link to the repository, say). */
  async function daemonThread(projectPath = f.repo) {
    const home = join(f.root, 'mms-home')
    mkdirSync(home)
    const mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const thread = mms.threads.createThread('Waiting', mms.projects.openProject(projectPath).id)
    const directory = mms.threads.getThreadDir(thread.id)
    const cwd = (await new WorkspaceResolver(directory, thread.id, projectPath).resolve('agent')).workspacePath!
    const call = (method: string, params: Record<string, unknown> = {}) => dispatchMethod({ mms, globalSequence: () => 0 }, method, { threadId: thread.id, ...params })
    const recovery = async () => (await call('workspace.getStatus') as { recovery?: unknown }).recovery
    return { mms, directory, cwd, call, recovery, threadId: thread.id, projectId: thread.projectId! }
  }

  it('workspace.getStatus reports a Publish that did not finish, and operations.recover settles it', async () => {
    const d = await daemonThread()
    try {
      const prePublishSha = git(f.repo, 'rev-parse', 'HEAD')
      const sourceSha = git(d.cwd, 'rev-parse', 'HEAD')
      const publishSha = git(f.repo, 'commit-tree', git(d.cwd, 'rev-parse', 'HEAD^{tree}'), '-p', prePublishSha, '-m', 'interrupted')
      new ThreadJournal(d.directory).append({ operationId: 'interrupted', operationType: 'publish', state: 'prepared', expectedPreState: { prePublishSha, targetBranch: git(f.repo, 'branch', '--show-current'), sourceSha, publishSha }, details: { threadWorkspace: d.cwd, primaryCheckout: f.repo } })
      expect(await d.recovery()).toMatchObject({ kind: 'publish', operationId: 'interrupted' })
      await expect(d.call('operations.recover')).resolves.toEqual({ ok: true, settled: true })
      expect(await d.recovery()).toBeUndefined()
      // Nothing was published by recovery, and the primary checkout is where it was.
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(prePublishSha)
    } finally {
      await d.mms.stop()
    }
  })

  it('operations.abort aborts a merge an earlier version left, and workspace.getStatus stops reporting it', async () => {
    const d = await daemonThread()
    try {
      const { before } = leftPublishMerge(d.directory)
      expect(await d.recovery()).toMatchObject({ kind: 'merge', folder: f.repo, operationId: 'old-publish' })
      const aborted = await d.call('operations.abort', { operationId: 'old-publish' }) as { ok: boolean; preservedRef: string }
      expect(aborted).toEqual({ ok: true, preservedRef: expect.stringMatching(/^refs\/mousse\/preserved\/old-publish-abort-/) })
      expect(git(f.repo, 'rev-parse', '--verify', aborted.preservedRef)).toMatch(/^[0-9a-f]{40}$/)
      expect(mergeHead(f.repo).ok).toBe(false)
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before)
      expect(await d.recovery()).toBeUndefined()
      // A second press has nothing to abort, and says so in words.
      await expect(d.call('operations.abort', { operationId: 'old-publish' })).rejects.toMatchObject({ code: 'abort_failed', message: 'No matching operation conflict is active.' })
    } finally {
      await d.mms.stop()
    }
  })

  it('operations.recover clears the record of a left merge that was replaced, so it is never offered again', async () => {
    const d = await daemonThread()
    try {
      leftPublishMerge(d.directory)
      git(f.repo, 'merge', '--abort')
      expect(() => git(f.repo, 'merge', '-q', '--no-edit', 'old-publish')).toThrow()
      expect(await d.recovery()).toBeUndefined()
      await expect(d.call('operations.recover')).resolves.toMatchObject({ ok: true })
      const latest = new ThreadJournal(d.directory).latestByOperation().get('old-publish')!
      expect(latest).toMatchObject({ state: 'cancelled', details: { mergeNoLongerRecorded: true } })
      expect((latest.details as { mergeInProgress?: unknown }).mergeInProgress).toBeUndefined()
      // The person's merge is untouched.
      expect(mergeHead(f.repo).ok).toBe(true)
    } finally {
      await d.mms.stop()
    }
  })

  it('operations.recover says a Publish still waits while the project folder cannot be read, instead of reporting success', async () => {
    // The project was added through a link that is then gone, as with a drive that is not mounted.
    const link = join(f.root, 'project-link')
    symlinkSync(f.repo, link)
    const d = await daemonThread(link)
    try {
      const prePublishSha = git(f.repo, 'rev-parse', 'HEAD')
      new ThreadJournal(d.directory).append({ operationId: 'interrupted', operationType: 'publish', state: 'prepared', expectedPreState: { prePublishSha, targetBranch: git(f.repo, 'branch', '--show-current'), sourceSha: git(d.cwd, 'rev-parse', 'HEAD') } })
      rmSync(link)
      const result = await d.call('operations.recover') as Record<string, unknown>
      expect(result).toMatchObject({ ok: true, settled: false, recovery: { kind: 'publish', operationId: 'interrupted' } })
      expect(result.stillWaiting).toBe("the project folder can't be read, so Mousse can't tell yet whether the Publish reached its branch")
      expect(new ThreadJournal(d.directory).latestByOperation().get('interrupted')?.state).toBe('prepared')
      // Once the folder is back, the same press settles it.
      symlinkSync(f.repo, link)
      await expect(d.call('operations.recover')).resolves.toEqual({ ok: true, settled: true })
    } finally {
      await d.mms.stop()
    }
  })

  it('operations.recover runs a stopped release of old Undo history again, and says so when it still cannot finish', async () => {
    const d = await daemonThread()
    try {
      // A release interrupted after its intent was written, whose receipt is gone, cannot finish.
      new ThreadJournal(d.directory).append({ operationId: 'release-1', operationType: 'undo-ref-release', state: 'prepared', details: { version: 1, receiptId: '00000000-0000-0000-0000-000000000000', repositoryId: 'repo', refs: [] } })
      expect(await d.recovery()).toMatchObject({ kind: 'paused', operationType: 'undo-ref-release' })
      const result = await d.call('operations.recover') as Record<string, unknown>
      expect(result).toMatchObject({ ok: true, settled: false, recovery: { kind: 'paused', operationType: 'undo-ref-release' } })
      expect(result.stillWaiting).toMatch(/^old Undo history could not be released yet: \S/)
    } finally {
      await d.mms.stop()
    }
  })

  it('Try recovery and Abort during a running turn are refused at once, in plain words', async () => {
    const d = await daemonThread()
    try {
      vi.spyOn(d.mms.orchestrator, 'isTurnActive').mockReturnValue(true)
      const started = Date.now()
      await expect(d.call('operations.recover')).rejects.toMatchObject({ code: 'thread_busy', message: 'The current turn is still running. Try again once it finishes.' })
      await expect(d.call('operations.abort', { operationId: 'any' })).rejects.toMatchObject({ code: 'operation_not_found' })
      leftPublishMerge(d.directory)
      await expect(d.call('operations.abort', { operationId: 'old-publish' })).rejects.toMatchObject({ code: 'thread_busy' })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(mergeHead(f.repo).ok).toBe(true)
    } finally {
      vi.restoreAllMocks()
      await d.mms.stop()
    }
  })

  describe('under MOUSSE_GIT_POLICY=refuse', () => {
    let entries: GitPolicyEntry[]
    let stop: () => void
    const previous = process.env.MOUSSE_GIT_POLICY
    beforeEach(() => {
      process.env.MOUSSE_GIT_POLICY = 'refuse'
      entries = []
      stop = onGitPolicyEntry((entry) => entries.push(entry))
    })
    afterEach(() => {
      stop()
      if (previous === undefined) delete process.env.MOUSSE_GIT_POLICY
      else process.env.MOUSSE_GIT_POLICY = previous
    })
    const violations = () => entries.filter((entry) => entry.kind === 'violation').map((entry) => `${entry.command} (${entry.decision.reason})`)

    it('a thread in a folder without Git, paused by a waiting operation, shows the banner, and Try recovery runs with no violation', async () => {
      const folder = join(f.root, 'plain-folder')
      mkdirSync(folder)
      writeFileSync(join(folder, 'notes.txt'), 'one\n')
      const d = await daemonThread(folder)
      try {
        // The thread records its turns in a hidden store, since the folder has no Git of its own.
        // The thread records its turns in a hidden store, as its first turn does, and has no worktree.
        const store = ensureSnapshotWorkspace({ threadDirectory: d.directory, threadId: d.threadId, workTree: folder, projectId: d.projectId })
        await new ThreadActionService(d.directory).runCheckpointedAction({ ...actionOptions(store.record.workTree, 'turn-1'), threadId: d.threadId }, () => writeFileSync(join(folder, 'notes.txt'), 'two\n'))
        expect(new ThreadWorkspaceManager(d.directory).load()).toBeUndefined()
        expect(new ThreadWorkspaceManager(d.directory).loadOrSnapshot()).toMatchObject({ snapshotOnly: true, worktreePath: realpathSync(folder) })
        expect(await d.recovery()).toBeUndefined()
        // Mousse stopped while it recorded the next turn: its intent is written, its snapshot is not.
        const [previousAction] = new ThreadActionService(d.directory).list().slice(-1)
        const interrupted = { ...structuredClone(previousAction!), id: randomUUID(), turnId: 'turn-2', startSha: previousAction!.endSha, state: 'running' as const, receiptId: undefined, completedAt: undefined }
        writeFileSync(join(folder, 'notes.txt'), 'three\n')
        new ThreadJournal(d.directory).append({ operationId: interrupted.id, operationType: 'action-checkpoint', state: 'prepared', details: { action: interrupted, actionState: 'completed' } })
        // Before, only a worktree's workspace.json was read, and this thread showed nothing.
        expect(await d.recovery()).toEqual({ kind: 'paused', reason: 'The action-checkpoint operation did not finish.', operationId: interrupted.id, operationType: 'action-checkpoint' })
        // Try recovery retakes the snapshot through the thread's hidden store, and nothing waits after it.
        await expect(d.call('operations.recover')).resolves.toEqual({ ok: true, settled: true })
        expect(await d.recovery()).toBeUndefined()
        expect(new ThreadJournal(d.directory).latestByOperation().get(interrupted.id)?.state).toBe('completed')
        // The folder stays the person's: no Git of its own appeared in it.
        expect(existsSync(join(folder, '.git'))).toBe(false)
        expect(violations()).toEqual([])
        // Nothing ran beyond what the method declares either.
        expect(entries).toEqual([])
      } finally {
        await d.mms.stop()
      }
    })

    it('Try recovery and Abort the merge on a worktree thread run with no violation', async () => {
      const d = await daemonThread()
      try {
        const prePublishSha = git(f.repo, 'rev-parse', 'HEAD')
        new ThreadJournal(d.directory).append({ operationId: 'interrupted', operationType: 'publish', state: 'prepared', expectedPreState: { prePublishSha, targetBranch: git(f.repo, 'branch', '--show-current'), sourceSha: git(d.cwd, 'rev-parse', 'HEAD') } })
        await expect(d.call('operations.recover')).resolves.toEqual({ ok: true, settled: true })
        const { before } = leftPublishMerge(d.directory)
        const aborted = await d.call('operations.abort', { operationId: 'old-publish' }) as { preservedRef: string }
        expect(mergeHead(f.repo).ok).toBe(false)
        expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before)
        expect(git(f.repo, 'rev-parse', '--verify', aborted.preservedRef)).toMatch(/^[0-9a-f]{40}$/)
        expect(violations()).toEqual([])
        // Nothing ran beyond what the method declares either.
        expect(entries).toEqual([])
      } finally {
        await d.mms.stop()
      }
    })
  })

  it('operations.recover refuses with what stopped recovery, not an internal error', async () => {
    const d = await daemonThread()
    try {
      // An undo an older version stopped after it moved files: recovery finds the worktree no longer matches.
      new ThreadJournal(d.directory).append({ operationId: 'undo-1', operationType: 'undo', state: 'git_applied', details: { actionId: 'missing-action', preUndoSha: f.baseSha } })
      expect(await d.recovery()).toMatchObject({ kind: 'paused', operationId: 'undo-1' })
      const refused = await d.call('operations.recover').then(() => undefined, (error: unknown) => error)
      expect(refused).toMatchObject({ code: 'recovery_failed', message: 'Undo recovery intent is missing.' })
    } finally {
      await d.mms.stop()
    }
  })
})
