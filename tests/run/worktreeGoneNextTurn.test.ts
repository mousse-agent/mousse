/**
 * A thread whose worktree folder an agent removed or emptied keeps working: its next message runs, from the project
 * folder, and the agent is told once why its folder changed. No "paused" banner. A worktree the person gave a new,
 * empty repository ("Initialize Git" on the side card) runs its next turn there. An operation of Mousse's own that did
 * not finish still pauses the thread, as before.
 *
 * What happened to the worktree during the first turn (the agent did it), and, for the last row, after it:
 * - removed: `git worktree remove --force`, then its branch deleted → next turn in the project folder, "is gone"
 * - deleted: the folder deleted outright, Git still registers it → the same
 * - emptied: everything in the folder deleted, `.git` too → next turn in the project folder, "no longer a Git repository"
 * - emptied, then Initialize Git: a repository with no commit → next turn in the worktree folder
 * - emptied while an Undo waits for recovery → still paused; the next message does not run
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadJournal } from '../../src/mms/data/ThreadJournal'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { threadRecovery } from '../../src/mms/workspace/workspaceRecovery'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** One folder however it is spelled; a folder that is gone is compared as written. */
const folder = (path: string): string => {
  let real = resolve(path)
  try { real = realpathSync.native(path) } catch { /* gone */ }
  return process.platform === 'win32' ? real.toLowerCase() : real
}
const same = (a: string | null | undefined, b: string): boolean => Boolean(a) && folder(a!) === folder(b)

/** Deletes everything in `folder`, `.git` included, and keeps the folder. */
const empty = (folder: string): void => {
  for (const entry of readdirSync(folder)) rmSync(join(folder, entry), { recursive: true, force: true })
}

describe('a thread whose worktree is gone or emptied', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    home = undefined
  })

  /**
   * One thread on a Git project. Its first turn makes the worktree, writes a file there, then `during` runs on the
   * worktree as the agent's last step; `after` runs between the turns. The next message is sent and its outcome read.
   */
  const run = async (during: (worktree: string, projectDir: string, threadDir: string) => void, after?: (worktree: string) => void) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-worktree-gone-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project'); mkdirSync(projectDir)
    git(projectDir, 'init', '-q'); git(projectDir, 'config', 'user.name', 'Test'); git(projectDir, 'config', 'user.email', 'test@example.test')
    writeFileSync(join(projectDir, 'README'), 'base\n'); git(projectDir, 'add', '.'); git(projectDir, 'commit', '-qm', 'base')
    let threadDir = ''
    const pi = piAdapter((input) => {
      if (input.prompt.endsWith('First')) {
        writeFileSync(join(input.cwd!, 'first.txt'), 'first\n')
        during(input.cwd!, projectDir, threadDir)
      }
      if (input.prompt.endsWith('Second')) writeFileSync(join(input.cwd!, 'second.txt'), 'second\n')
      return `reply to ${input.prompt.split('\n').at(-1)}`
    })
    const d = (daemon = phase6Daemon(home, [pi]))
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Thread', project.id)
    threadDir = d.store.getThreadDir(thread.id)
    d.orch.setThreadModelOverride(thread.id, PI)
    const first = await d.orch.send({ content: 'First', mode: 'agent' }, false, { threadId: thread.id, clientRequestId: 'first' })
    expect(first.message).toBe('reply to First')
    const worktree = new ThreadWorkspaceManager(threadDir).load()!.worktreePath
    expect(same(pi.turns[0]!.cwd, worktree)).toBe(true)
    after?.(worktree)
    // A paused thread refuses the send itself: `refused` holds why, and `second` is then undefined.
    let refused: unknown
    const second = (await d.orch.send({ content: 'Second', mode: 'agent' }, false, { threadId: thread.id, clientRequestId: 'second' })
      .catch((error: unknown): undefined => { refused = error; return undefined }))!
    const recovery = await threadRecovery(threadDir, projectDir)
    return { d, pi, thread, threadDir, projectDir, worktree, second, refused, recovery }
  }

  /** The next turn ran in the project folder, told the agent once, and nothing waits on recovery. */
  const ranFromProject = async (outcome: Awaited<ReturnType<typeof run>>, says: RegExp) => {
    const { d, pi, thread, projectDir, worktree, second, recovery } = outcome
    expect(second.message).toBe('reply to Second')
    expect(second.queued).toBeFalsy()
    expect(d.engine.getRun(second.runId!)?.status).toBe('completed')
    expect(pi.turns).toHaveLength(2)
    expect(same(pi.turns[1]!.cwd, projectDir)).toBe(true)
    expect(existsSync(join(projectDir, 'second.txt'))).toBe(true)
    expect(pi.turns[1]!.prompt).toContain(worktree)
    expect(pi.turns[1]!.prompt).toMatch(says)
    expect(pi.turns[1]!.prompt).toContain(`working from the project folder ${projectDir}`)
    expect(recovery).toBeUndefined()
    expect(d.orch.listQueue(thread.id)).toEqual([])
    // Once: the turn after it runs there too, without the line again.
    const third = await d.orch.send({ content: 'Third', mode: 'agent' }, false, { threadId: thread.id, clientRequestId: 'third' })
    expect(third.message).toBe('reply to Third')
    expect(same(pi.turns[2]!.cwd, projectDir)).toBe(true)
    expect(pi.turns[2]!.prompt).not.toContain(worktree)
  }

  it('removed: the next message runs from the project folder, and the agent is told its worktree is gone', async () => {
    const outcome = await run((worktree, projectDir) => {
      const branch = git(worktree, 'branch', '--show-current')
      git(projectDir, 'worktree', 'remove', '--force', worktree)
      git(projectDir, 'branch', '-D', branch)
    })
    expect(existsSync(outcome.worktree)).toBe(false)
    await ranFromProject(outcome, /is gone/)
  }, 60_000)

  it('deleted: a folder deleted without Git runs the same way', async () => {
    const outcome = await run((worktree) => rmSync(worktree, { recursive: true, force: true }))
    expect(existsSync(outcome.worktree)).toBe(false)
    await ranFromProject(outcome, /is gone/)
  }, 60_000)

  it('emptied: the next message runs from the project folder, and the agent is told it is no longer a Git repository', async () => {
    const outcome = await run((worktree) => empty(worktree))
    expect(readdirSync(outcome.worktree)).toEqual([])
    await ranFromProject(outcome, /is no longer a Git repository/)
  }, 60_000)

  it('emptied, then Initialize Git: the next message runs in the worktree folder, with no commit there yet', async () => {
    const { d, pi, worktree, second, recovery } = await run((folder) => empty(folder), (folder) => git(folder, 'init', '-q'))
    expect(second.message).toBe('reply to Second')
    expect(d.engine.getRun(second.runId!)?.status).toBe('completed')
    expect(same(pi.turns[1]!.cwd, worktree)).toBe(true)
    expect(existsSync(join(worktree, 'second.txt'))).toBe(true)
    expect(pi.turns[1]!.prompt).not.toContain('working from the project folder')
    expect(recovery).toBeUndefined()
    // Still no commit: Mousse made none in the person's new repository.
    expect(() => git(worktree, 'rev-parse', '--verify', 'HEAD')).toThrow()
  }, 60_000)

  it('emptied while an Undo waits for recovery: the thread stays paused and the next message does not run', async () => {
    const { d, pi, thread, second, refused, recovery } = await run((worktree, _projectDir, threadDir) => {
      empty(worktree)
      new ThreadJournal(threadDir).append({ operationId: 'undo-1', operationType: 'undo', state: 'recovery_required', details: { error: 'Error: the undo stopped' } })
    })
    expect(pi.turns).toHaveLength(1)
    expect(second).toBeUndefined()
    expect(refused).toMatchObject({ code: 'workspace_recovery_required' })
    expect(recovery).toMatchObject({ kind: 'paused', operationId: 'undo-1' })
    await waitFor(() => pi.turns.length === 1, 'nothing to run', 1_000)
    expect(d.orch.getMessages(thread.id).some((message) => message.content === 'reply to Second')).toBe(false)
  }, 60_000)
})
