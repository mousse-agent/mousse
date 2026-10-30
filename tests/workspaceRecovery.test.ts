import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { describeRecovery, recoveryErrorText, switchBackToThreadBranch } from '../src/mms/workspace/workspaceRecovery'
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
    child(branch: string) {
      const path = join(root, branch)
      git(repo, 'worktree', 'add', '-q', '-b', branch, path, baseSha)
      return path
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

/** A provisioned thread whose agent checked out its own branch and committed there, so the end-of-turn checkpoint failed. */
async function lockedThread() {
  const manager = new ThreadWorkspaceManager(f.thread)
  const workspace = await manager.provision('task', 'main', f.repo)
  const cwd = workspace.worktreePath
  git(cwd, 'switch', '-q', '-c', 'agent/task')
  f.commit(cwd, 'agent work\n', 'agent.txt')
  const actions = new ThreadActionService(f.thread)
  await expect(actions.checkpointExistingTurn(actionOptions(cwd), workspace.headSha, 'completed')).rejects.toThrow(/branch changed/)
  return { manager, workspace, cwd, actions }
}

describe('why a thread needs recovery', () => {
  it('says nothing about a thread that is fine', async () => {
    const manager = new ThreadWorkspaceManager(f.thread)
    await manager.provision('task', 'main', f.repo)
    expect(describeRecovery(f.thread, manager.verify())).toBeUndefined()
  })

  it('names the branch the agent switched to and the checkpoint that could not finish', async () => {
    const { manager, workspace } = await lockedThread()
    const verified = manager.verify()
    expect(verified.lifecycle).toBe('recovery_required')
    const recovery = describeRecovery(f.thread, verified)!
    expect(recovery.branch).toEqual({ expected: workspace.branch, actual: 'agent/task' })
    expect(recovery.operationType).toBe('action-checkpoint')
    expect(recovery.operationId).toEqual(expect.any(String))
    expect(recovery.reason).toBe(`The worktree is on branch agent/task instead of ${workspace.branch}.`)
  })

  it('gives the checkpoint’s own error when the history changed on the thread branch', async () => {
    const manager = new ThreadWorkspaceManager(f.thread)
    const first = await manager.provision('task', 'main', f.repo)
    const actions = new ThreadActionService(f.thread)
    await actions.runCheckpointedAction(actionOptions(first.worktreePath, 'first'), () => writeFileSync(join(first.worktreePath, 'value.txt'), 'first\n'))
    const workspace = manager.load()!
    // The agent rewrites history: the recorded head is no longer an ancestor of HEAD.
    git(workspace.worktreePath, 'reset', '-q', '--hard', f.baseSha)
    f.commit(workspace.worktreePath, 'rewritten\n')
    await expect(actions.checkpointExistingTurn(actionOptions(workspace.worktreePath, 'second'), f.baseSha, 'completed')).rejects.toThrow(/diverged/)
    const recovery = describeRecovery(f.thread, manager.verify())!
    expect(recovery.branch).toBeUndefined()
    expect(recovery.reason).toMatch(/history diverged during execution/)
    expect(recovery.operationType).toBe('action-checkpoint')
  })

  it('gives what Git said, not the command line, when a Git command stopped the checkpoint', async () => {
    const manager = new ThreadWorkspaceManager(f.thread)
    const workspace = await manager.provision('task', 'main', f.repo)
    // A nested repository with no commit makes `git add -A` fail.
    const tool = join(workspace.worktreePath, 'tool')
    mkdirSync(tool); git(tool, 'init', '-q')
    await expect(new ThreadActionService(f.thread).checkpointExistingTurn(actionOptions(workspace.worktreePath), workspace.headSha, 'completed')).rejects.toThrow(/does not have a commit checked out/)
    const recovery = describeRecovery(f.thread, manager.verify())!
    expect(recovery.reason).toMatch(/^error: 'tool\/' does not have a commit checked out/)
    expect(recovery.reason).not.toMatch(/Command failed|core\.fsmonitor/)
  })

  it('says the history changed when HEAD moved with no operation recorded', async () => {
    const manager = new ThreadWorkspaceManager(f.thread)
    const workspace = await manager.provision('task', 'main', f.repo)
    f.commit(workspace.worktreePath, 'by hand\n')
    const recovery = describeRecovery(f.thread, manager.verify())!
    expect(recovery).toEqual({ reason: 'The worktree’s history changed outside Mousse.' })
  })
})

describe('switching back to the thread branch', () => {
  it('puts the worktree back, keeps the agent’s commits on its own branch, and recovery then clears the thread', async () => {
    const { manager, workspace, cwd, actions } = await lockedThread()
    const agentTip = git(cwd, 'rev-parse', 'HEAD')
    const result = switchBackToThreadBranch(manager.load()!)
    expect(result.from).toBe('agent/task')
    expect(result.message).toBe(`Switched the worktree back to ${workspace.branch}. The agent’s commits stay on agent/task.`)
    expect(git(cwd, 'branch', '--show-current')).toBe(workspace.branch)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(workspace.headSha)
    expect(git(f.repo, 'rev-parse', 'agent/task')).toBe(agentTip)
    expect(manager.verify().lifecycle).toBe('ready')

    await actions.recoverPending(cwd)
    expect(describeRecovery(f.thread, manager.verify())).toBeUndefined()
    expect(() => new ChangeReceiptService(f.thread).assertNoPendingOperation()).not.toThrow()
    const { action } = await actions.runCheckpointedAction(actionOptions(cwd, 'next'), () => writeFileSync(join(cwd, 'next.txt'), 'next\n'))
    expect(action.state).toBe('completed')
  })

  it('refuses when files are changed and stays on the agent’s branch', async () => {
    const { manager, cwd } = await lockedThread()
    writeFileSync(join(cwd, 'agent.txt'), 'edited\n')
    expect(() => switchBackToThreadBranch(manager.load()!)).toThrow(/agent\/task has uncommitted changes \(agent\.txt\)/)
    expect(git(cwd, 'branch', '--show-current')).toBe('agent/task')
  })

  it('refuses while a merge is in progress', async () => {
    const { manager, cwd } = await lockedThread()
    f.commit(cwd, 'agent side\n')
    const other = f.child('other-side')
    f.commit(other, 'other side\n')
    expect(() => git(cwd, 'merge', '--no-edit', 'other-side')).toThrow()
    expect(() => switchBackToThreadBranch(manager.load()!)).toThrow(/merge is in progress on agent\/task/)
    expect(git(cwd, 'branch', '--show-current')).toBe('agent/task')
  })

  it('refuses when the thread branch moved since Mousse saved it', async () => {
    const { manager, workspace, cwd } = await lockedThread()
    git(f.repo, 'update-ref', `refs/heads/${workspace.branch}`, git(cwd, 'rev-parse', 'HEAD'))
    expect(() => switchBackToThreadBranch(manager.load()!)).toThrow(/moved since Mousse last saw it/)
    expect(git(cwd, 'branch', '--show-current')).toBe('agent/task')
  })

  it('refuses a detached HEAD and a worktree already on its branch', async () => {
    const { manager, cwd, workspace } = await lockedThread()
    git(cwd, 'switch', '-q', '--detach')
    expect(() => switchBackToThreadBranch(manager.load()!)).toThrow(/not on a branch/)
    git(cwd, 'switch', '-q', workspace.branch)
    expect(() => switchBackToThreadBranch(manager.load()!)).toThrow(/already on/)
  })
})

describe('the text of a failed operation', () => {
  it('keeps a plain message, without the Error: prefix', () => {
    expect(recoveryErrorText(new Error('Interrupted commit needs recovery.'))).toBe('Interrupted commit needs recovery.')
    expect(recoveryErrorText('Error: Workspace branch changed during execution; recovery is required.')).toBe('Workspace branch changed during execution; recovery is required.')
  })

  it('drops the command line of a failed Git command and keeps what Git said', () => {
    const failed = "Error: Command failed: git -c core.fsmonitor=false -c core.hooksPath=/dev/null add -A -- . :(exclude).mousse\nerror: 'tool/' does not have a commit checked out\nfatal: adding files failed\n"
    expect(recoveryErrorText(failed)).toBe("error: 'tool/' does not have a commit checked out fatal: adding files failed")
    expect(recoveryErrorText('Command failed: git status')).toBe('A Git command failed without saying why.')
  })
})

describe('operations.recover', () => {
  it('refuses with what stopped recovery, not an internal error', async () => {
    const home = join(f.root, 'mms-home')
    mkdirSync(home)
    const mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    try {
      const thread = mms.threads.createThread('Locked', mms.projects.openProject(f.repo).id)
      const directory = mms.threads.getThreadDir(thread.id)
      const cwd = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
      const tool = join(cwd, 'tool')
      mkdirSync(tool); git(tool, 'init', '-q')
      const workspace = new ThreadWorkspaceManager(directory).load()!
      await expect(new ThreadActionService(directory).checkpointExistingTurn({ ...actionOptions(cwd), threadId: thread.id }, workspace.headSha, 'completed')).rejects.toThrow()

      // Recovery retakes the checkpoint, which fails the same way while the nested repository is there.
      const refused = await dispatchMethod({ mms, globalSequence: () => 0 }, 'operations.recover', { threadId: thread.id }).then(() => undefined, (error: unknown) => error)
      expect(refused).toMatchObject({ code: 'recovery_failed', message: expect.stringMatching(/^error: 'tool\/' does not have a commit checked out/) })
    } finally {
      await mms.stop()
    }
  })
})
