import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileService } from '../../src/mms/files/FileService'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../../src/mms/queue/ThreadExecutionLease'
import { ThreadRuntimeManager } from '../../src/mms/runtime/ThreadRuntimeManager'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { phase6Daemon, PI, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

/**
 * Switching an empty chat between its project folder and a worktree, after something already gave it a workspace
 * record. Inputs: the record's kind (project folder, worktree), what happened in it (nothing, a turn), and whether a
 * terminal is open in it (holding the thread's lease). Only a project-folder record of a thread where nothing ran and
 * no terminal is open is dropped; every other switch is refused with `worktree_locked`, at once, so the window makes a
 * new thread for the send.
 */
describe('switching the checkout of an empty chat that already has a workspace', () => {
  let home: string | undefined
  let daemon: Phase6Daemon | undefined
  let pty: PtyManager | undefined

  afterEach(async () => {
    await pty?.shutdown()
    pty = undefined
    await daemon?.shutdown()
    daemon = undefined
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    home = undefined
    vi.unstubAllEnvs()
  }, 90_000)

  function world() {
    const root = home = mkdtempSync(join(tmpdir(), 'mousse-checkout-switch-'))
    vi.stubEnv('MOUSSE_HOME', root)
    const repo = join(root, 'project')
    mkdirSync(repo)
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@example.test')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'tracked.txt'), 'base')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    const pi = piAdapter(() => 'Done')
    const d = daemon = phase6Daemon(root, [pi])
    const project = d.projects.openProject(repo)
    pty = new PtyManager()
    const ctx: HandlerContext = {
      mms: {
        threads: d.store, projects: d.projects, orchestrator: d.orch, settings: { get: () => d.settings },
        fileService: new FileService(), ptyManager: pty, threadRuntimes: new ThreadRuntimeManager(),
        lineEditStats: { record: () => undefined }
      } as HandlerContext['mms'],
      connection: { id: 'window', clientType: 'gui' } as HandlerContext['connection'],
      globalSequence: () => 0
    }
    const thread = (worktreeEnabled: boolean) => {
      const made = d.store.createThread('New thread', project.id, repo, { worktreeEnabled })
      d.orch.setThreadModelOverride(made.id, PI)
      const directory = d.store.getThreadDir(made.id)
      return { id: made.id, directory, manager: new ThreadWorkspaceManager(directory) }
    }
    const toggle = (threadId: string, enabled: boolean) => dispatchMethod(ctx, 'threads.setWorktreeEnabled', { threadId, enabled, picked: true })
    const send = (threadId: string) => d.orch.send({ content: 'Read the tracked file', mode: 'agent' }, false, { threadId, clientRequestId: threadId, awaitMode: 'ack' })
    const call = (method: string, params: Record<string, unknown>) => dispatchMethod(ctx, method, params)
    const pins = (threadId: string) => git(repo, 'for-each-ref', '--format=%(refname)', `refs/mousse/threads/${threadId}/`)
    return { d, git, repo, thread, pi, toggle, send, call, pins }
  }

  it('drops the project-folder record of a chat where nothing ran, and the send runs in a worktree', async () => {
    const w = world()
    const chat = w.thread(false)
    // What a branch switch or a terminal on the empty chat leaves: the record and its pin, nothing else.
    await chat.manager.ensureProjectFolder(chat.id, 'main', w.repo)
    expect(chat.manager.load()?.kind).toBe('project-folder')
    expect(w.pins(chat.id)).not.toBe('')
    const head = w.git(w.repo, 'rev-parse', 'HEAD')

    const switched = await w.toggle(chat.id, true) as { thread: { worktreeEnabled?: boolean } }
    expect(switched.thread.worktreeEnabled).toBe(true)
    expect(w.pins(chat.id)).toBe('')
    expect(w.git(w.repo, 'rev-parse', 'HEAD')).toBe(head)

    await w.send(chat.id)
    await waitFor(() => w.pi.turns.length === 1, 'the first turn to start', 50_000)
    expect(w.pi.turns[0]?.cwd).not.toBe(w.repo)
    expect(chat.manager.load()?.kind).not.toBe('project-folder')
  }, 90_000)

  it('refuses at once while a terminal is open in the project folder, and keeps its record', async () => {
    const w = world()
    const chat = w.thread(false)
    await chat.manager.ensureProjectFolder(chat.id, 'main', w.repo)
    // An open terminal holds the thread's lease for as long as it runs.
    const terminal = tryAcquireExecutionLease(chat.directory, { source: 'task-terminal' })!
    try {
      await expect(w.toggle(chat.id, true)).rejects.toMatchObject({ code: 'worktree_locked' })
    } finally {
      releaseExecutionLeaseHandle(terminal)
    }
    expect(chat.manager.load()?.kind).toBe('project-folder')
    expect(w.pins(chat.id)).not.toBe('')
  }, 90_000)

  it('refuses after a turn ran in the project folder, and keeps its record', async () => {
    const w = world()
    const chat = w.thread(false)
    await w.send(chat.id)
    await waitFor(() => w.pi.turns.length === 1 && w.d.orch.getMessages(chat.id).some((message) => message.role === 'assistant'), 'the turn to finish', 50_000)
    expect(chat.manager.load()?.kind).toBe('project-folder')
    await expect(w.toggle(chat.id, true)).rejects.toMatchObject({ code: 'worktree_locked' })
    expect(chat.manager.load()?.kind).toBe('project-folder')
    expect(w.pins(chat.id)).not.toBe('')
  }, 90_000)

  it('refuses the project folder for a chat whose worktree was already made, and keeps the worktree', async () => {
    const w = world()
    const chat = w.thread(true)
    // A file written from the editor makes the chat's worktree first.
    await w.call('files.write', { threadId: chat.id, path: 'added.txt', content: 'written' })
    const worktree = chat.manager.load()!
    expect(worktree.kind).not.toBe('project-folder')
    await expect(w.toggle(chat.id, false)).rejects.toMatchObject({ code: 'worktree_locked' })
    expect(existsSync(join(worktree.worktreePath, 'added.txt'))).toBe(true)
  }, 90_000)
})
