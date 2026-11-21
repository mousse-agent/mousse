import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trustRepositoryPrograms } from '../../src/mms/git/repoPrograms'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../../src/mms/queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import * as workspaceResolver from '../../src/mms/workspace/WorkspaceResolver'
import { PREPARED_WORKTREE_MAX_AGE_MS, releasePreparedWorkspace, settledPreparation } from '../../src/mms/workspace/workspacePreparation'
import * as checkout from '../../src/mms/worktree/worktreeCheckout'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

function gate() {
  let open!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { wait, open }
}

describe('the first turn in a new worktree', () => {
  let home: string | undefined
  let daemon: Phase6Daemon | undefined
  let unblock: (() => void) | undefined
  const pending: Promise<unknown>[] = []

  afterEach(async () => {
    unblock?.()
    unblock = undefined
    await Promise.allSettled(pending.splice(0))
    await daemon?.shutdown()
    daemon = undefined
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    home = undefined
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  }, 90_000)

  function world() {
    const root = home = mkdtempSync(join(tmpdir(), 'mousse-prepared-'))
    vi.stubEnv('MOUSSE_HOME', root)
    const repo = join(root, 'project')
    mkdirSync(repo)
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@example.test')
    git(repo, 'config', 'user.name', 'Test')
    for (const dir of ['keep', 'omit']) {
      mkdirSync(join(repo, dir))
      writeFileSync(join(repo, dir, 'tracked.txt'), dir)
    }
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    const pi = piAdapter(() => 'Done')
    const d = daemon = phase6Daemon(root, [pi])
    const project = d.projects.openProject(repo)
    const ctx: HandlerContext = {
      mms: { threads: d.store, projects: d.projects, orchestrator: d.orch, settings: { get: () => d.settings } } as HandlerContext['mms'],
      connection: { id: 'window', clientType: 'gui' } as HandlerContext['connection'],
      globalSequence: () => 0
    }
    const thread = (worktreeEnabled = true) => {
      const made = d.store.createThread('New thread', project.id, repo, { worktreeEnabled })
      d.orch.setThreadModelOverride(made.id, PI)
      const directory = d.store.getThreadDir(made.id)
      return { id: made.id, directory, manager: new ThreadWorkspaceManager(directory) }
    }
    const focus = (threadId: string, focused = true) => dispatchMethod(ctx, 'threads.focus', { threadId, focused })
    const toggle = (threadId: string, enabled: boolean) => dispatchMethod(ctx, 'threads.setWorktreeEnabled', { threadId, enabled })
    const send = (threadId: string) => d.orch.send('Read the tracked file', false, { threadId, clientRequestId: threadId, awaitMode: 'ack' })
    return { d, git, repo, thread, pi, focus, toggle, send }
  }

  it('registers a second worktree while the first checkout holds the disk slot', async () => {
    const w = world()
    const first = w.thread()
    const second = w.thread()
    const firstEntered = gate()
    const firstCheckout = gate()
    unblock = firstCheckout.open
    const populate = checkout.populateWorktree
    vi.spyOn(checkout, 'populateWorktree').mockImplementation(async (input) => {
      if (first.manager.load()?.worktreePath === input.worktreePath) {
        await checkout.withCheckoutSlot(input.worktreePath, async () => {
          firstEntered.open()
          await firstCheckout.wait
        })
      }
      return populate(input)
    })

    await w.send(first.id)
    await firstEntered.wait
    await w.send(second.id)
    await waitFor(() => {
      const location = second.manager.load()?.worktreePath
      return Boolean(location && existsSync(join(location, '.git')))
    }, 'the second checkout to register before the first releases its disk slot', 50_000)
    expect(w.pi.turns).toHaveLength(0)
    const registered = w.git(w.repo, 'worktree', 'list', '--porcelain')
    expect(registered).toContain('branch refs/heads/' + first.manager.load()?.branch)
    expect(registered).toContain('branch refs/heads/' + second.manager.load()?.branch)

    firstCheckout.open()
    await waitFor(() => w.pi.turns.length === 2, 'both prompts to reach the provider', 50_000)
    for (const thread of [first, second]) {
      const location = thread.manager.load()!.worktreePath
      expect(w.pi.turns.find((turn) => turn.threadId === thread.id)?.cwd).toBe(location)
      expect(readFileSync(join(location, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
    }
  }, 90_000)

  it.each(['focus', 'toggle'] as const)('starts on %s and claims the same checkout at Send', async (trigger) => {
    const w = world()
    const draft = w.thread(trigger === 'focus')
    const writing = gate()
    const finish = gate()
    const note = gate()
    unblock = () => { finish.open(); note.open() }
    vi.spyOn(workspaceResolver, 'uncommittedLeftBehindNote').mockImplementation(async () => {
      await note.wait
      return 'The project has pending changes.'
    })
    const populate = checkout.populateWorktree
    vi.spyOn(checkout, 'populateWorktree').mockImplementation(async (input) => {
      writing.open()
      await finish.wait
      await populate(input)
    })
    if (trigger === 'focus') await w.focus(draft.id)
    else await w.toggle(draft.id, true)
    pending.push(settledPreparation(draft.directory))
    await writing.wait
    const prepared = draft.manager.load()!
    expect(prepared.lifecycle).toBe('provisioning')
    expect(prepared.prepared).toBeDefined()

    const sent = await w.send(draft.id)
    expect(sent.runId).toBeTruthy()
    expect(w.pi.turns).toHaveLength(0)
    finish.open()
    await waitFor(() => w.pi.turns.length === 1, 'the first prompt to reach the provider', 50_000)
    expect(w.pi.turns[0]).toMatchObject({ threadId: draft.id, cwd: prepared.worktreePath })
    expect(draft.manager.load()).toMatchObject({ lifecycle: 'ready', worktreePath: prepared.worktreePath, branch: prepared.branch })
    expect(draft.manager.load()?.prepared).toBeUndefined()
    expect(readFileSync(join(prepared.worktreePath, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
  }, 90_000)

  it('keeps an open or busy draft and expires it after the windows and writers let go', async () => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    const now = Date.now() + PREPARED_WORKTREE_MAX_AGE_MS + 1_000
    await w.d.orch.sweepAbandonedPreparedWorkspaces(now)
    expect(existsSync(prepared.worktreePath)).toBe(true)
    await w.focus(draft.id, false)
    const writer = tryAcquireExecutionLease(draft.directory, { source: 'test writer' })!
    try {
      expect(await releasePreparedWorkspace(draft.directory)).toBe('busy')
      expect(existsSync(prepared.worktreePath)).toBe(true)
    } finally {
      releaseExecutionLeaseHandle(writer)
    }
    await w.d.orch.sweepAbandonedPreparedWorkspaces(now)
    expect(draft.manager.load()).toBeUndefined()
    expect(existsSync(prepared.worktreePath)).toBe(false)
    expect(w.git(w.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/' + prepared.branch, prepared.retainedRef)).toBe('')
  }, 90_000)

  it('preserves files written into a draft before it is abandoned', async () => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    const ignored = join(prepared.worktreePath, 'ignored.txt')
    writeFileSync(ignored, 'my data')
    expect(await releasePreparedWorkspace(draft.directory)).toBe('kept')
    expect(readFileSync(ignored, 'utf8')).toBe('my data')
    expect(draft.manager.load()?.prepared).toBeDefined()
  }, 90_000)

  it('uses the project’s trusted Git checkout filters in the prepared worktree', async () => {
    const w = world()
    w.git(w.repo, 'config', 'filter.prep-check.smudge', "sed s/raw/filtered/")
    w.git(w.repo, 'config', 'filter.prep-check.clean', "sed s/filtered/raw/")
    w.git(w.repo, 'config', 'filter.prep-check.required', 'true')
    writeFileSync(join(w.repo, '.gitattributes'), '*.fixture filter=prep-check\n')
    writeFileSync(join(w.repo, 'data.fixture'), 'raw\n')
    w.git(w.repo, 'add', '.')
    w.git(w.repo, 'commit', '-qm', 'set filter')
    expect(trustRepositoryPrograms(w.repo)?.filters['filter.prep-check.smudge']).toBeTruthy()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    expect(prepared.lifecycle).toBe('ready')
    expect(readFileSync(join(prepared.worktreePath, 'data.fixture'), 'utf8').trim()).toBe('filtered')
    expect(w.git(prepared.worktreePath, 'status', '--porcelain')).toBe('')
  }, 90_000)

  it('recovers a registered but unwritten sparse checkout, then replaces it if the draft layout changed', async () => {
    const w = world()
    const pattern = join(home!, 'patterns')
    writeFileSync(pattern, 'keep\n')
    w.git(w.repo, 'config', 'extensions.worktreeConfig', 'true')
    w.git(w.repo, 'config', 'mousse.sparseCheckout', pattern)
    const draft = w.thread()
    const interrupted = vi.spyOn(checkout, 'populateWorktree').mockRejectedValueOnce(new Error('interrupted before writing files'))
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const stopped = draft.manager.load()!
    expect(stopped.lifecycle).toBe('provisioning')
    expect(existsSync(join(stopped.worktreePath, 'keep', 'tracked.txt'))).toBe(false)
    interrupted.mockRestore()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    expect(draft.manager.load()?.lifecycle).toBe('ready')
    expect(readFileSync(join(stopped.worktreePath, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(stopped.worktreePath, 'omit'))).toBe(false)

    writeFileSync(pattern, 'omit\n')
    await w.send(draft.id)
    await waitFor(() => w.pi.turns.length === 1, 'the prompt to reach the checkout for the new sparse layout', 50_000)
    const replacement = draft.manager.load()!
    expect(replacement.branch).not.toBe(stopped.branch)
    expect(w.pi.turns[0]?.cwd).toBe(replacement.worktreePath)
    expect(readFileSync(join(replacement.worktreePath, 'omit', 'tracked.txt'), 'utf8')).toBe('omit')
    expect(existsSync(join(replacement.worktreePath, 'keep'))).toBe(false)
    expect(existsSync(join(w.repo, 'keep', 'tracked.txt'))).toBe(true)
  }, 90_000)
})
