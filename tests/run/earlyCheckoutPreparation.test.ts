import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileService } from '../../src/mms/files/FileService'
import type { ChatMode } from '../../src/shared/types'
import * as gitProcess from '../../src/mms/git/runGitProcess'
import { trustRepositoryPrograms } from '../../src/mms/git/repoPrograms'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../../src/mms/queue/ThreadExecutionLease'
import { ThreadRuntimeManager } from '../../src/mms/runtime/ThreadRuntimeManager'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import * as workspaceResolver from '../../src/mms/workspace/WorkspaceResolver'
import { PREPARED_WORKTREE_MAX_AGE_MS, releasePreparedWorkspace, settledPreparation } from '../../src/mms/workspace/workspacePreparation'
import { crashChild } from '../support/build'
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
  let pty: PtyManager | undefined
  const pending: Promise<unknown>[] = []

  afterEach(async () => {
    unblock?.()
    unblock = undefined
    await Promise.allSettled(pending.splice(0))
    await pty?.shutdown()
    pty = undefined
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
    vi.stubEnv('MOUSSE_CHECKOUTS_PER_DISK', '1')
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
    const thread = (worktreeEnabled = true) => {
      const made = d.store.createThread('New thread', project.id, repo, { worktreeEnabled })
      d.orch.setThreadModelOverride(made.id, PI)
      const directory = d.store.getThreadDir(made.id)
      return { id: made.id, directory, manager: new ThreadWorkspaceManager(directory) }
    }
    const focus = (threadId: string, focused = true) => dispatchMethod(ctx, 'threads.focus', { threadId, focused })
    const toggle = (threadId: string, enabled: boolean) => dispatchMethod(ctx, 'threads.setWorktreeEnabled', { threadId, enabled })
    const send = (threadId: string, mode: ChatMode = 'agent') => d.orch.send({ content: 'Read the tracked file', mode }, false, { threadId, clientRequestId: threadId, awaitMode: 'ack' })
    const call = (method: string, params: Record<string, unknown>) => dispatchMethod(ctx, method, params)
    return { d, git, repo, thread, pi, focus, toggle, send, call }
  }

  it('registers a second worktree while the first checkout holds the disk slot', async () => {
    const w = world()
    const first = w.thread()
    const second = w.thread()
    const firstEntered = gate()
    const firstCheckout = gate()
    unblock = firstCheckout.open
    const populate = checkout.populateWorktree
    let writesAdmitted = 0
    vi.spyOn(checkout, 'populateWorktree').mockImplementation((input) => populate({
      ...input,
      beforeCheckout: async () => {
        writesAdmitted++
        if (first.manager.load()?.worktreePath === input.worktreePath) {
          firstEntered.open()
          await firstCheckout.wait
        }
        await input.beforeCheckout?.()
      }
    }))

    await w.send(first.id)
    await firstEntered.wait
    await w.send(second.id)
    await waitFor(() => {
      const location = second.manager.load()?.worktreePath
      return Boolean(location && existsSync(join(location, '.git')))
    }, 'the second checkout to register before the first releases its disk slot', 50_000)
    expect(w.pi.turns).toHaveLength(0)
    expect(writesAdmitted).toBe(1)
    expect(existsSync(join(second.manager.load()!.worktreePath, 'keep', 'tracked.txt'))).toBe(false)
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

  it('keeps a same-OID branch recreated after the release was recorded and Git deleted it', async () => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    await w.focus(draft.id, false)
    const prepared = draft.manager.load()!
    const ref = 'refs/heads/' + prepared.branch
    const run = gitProcess.runGitProcess
    const stop = vi.spyOn(gitProcess, 'runGitProcess').mockImplementation(async (args, options) => {
      const result = await run(args, options)
      if (args.includes('-d') && args.includes(ref) && result.status === 0) {
        w.git(w.repo, 'update-ref', ref, prepared.baseSha)
        throw new Error('Stopped just after the branch delete')
      }
      return result
    })
    expect(await releasePreparedWorkspace(draft.directory)).toBe('kept')
    expect(existsSync(prepared.worktreePath)).toBe(false)
    stop.mockRestore()
    await w.d.shutdown()
    daemon = phase6Daemon(home!, [piAdapter(() => 'Done')])
    await daemon.orch.sweepAbandonedPreparedWorkspaces(Date.now() + PREPARED_WORKTREE_MAX_AGE_MS + 1_000)
    expect(draft.manager.load()).toBeUndefined()
    expect(w.git(w.repo, 'rev-parse', ref)).toBe(prepared.baseSha)
  }, 90_000)

  it('keeps a project file’s editor binding when the checkout is prepared and claimed', async () => {
    const w = world()
    const draft = w.thread()
    const request = { threadId: draft.id, path: 'keep/tracked.txt' }
    const opened = await w.call('files.read', { ...request, bindRoot: true }) as { workspaceRoot: string }
    expect(opened.workspaceRoot).toBe(w.repo)
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    expect(await w.call('files.root', { threadId: draft.id })).toEqual({ root: w.repo })
    await w.call('files.writeDirect', { ...request, expectedRoot: opened.workspaceRoot, content: 'before claim' })
    expect(readFileSync(join(w.repo, request.path), 'utf8')).toBe('before claim')
    expect(readFileSync(join(prepared.worktreePath, request.path), 'utf8')).toBe('keep')
    await w.send(draft.id)
    await waitFor(() => w.pi.turns.length === 1, 'the prepared worktree to be claimed')
    await expect(w.call('files.writeDirect', { ...request, expectedRoot: opened.workspaceRoot, content: 'after claim' }))
      .rejects.toMatchObject({ code: 'file_workspace_changed' })
    expect(readFileSync(join(prepared.worktreePath, request.path), 'utf8')).toBe('keep')
  }, 90_000)

  it.each(['editor', 'terminal'] as const)('claims the checkout for a checkpointed %s before writing', async (writer) => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    await w.focus(draft.id, false)
    if (writer === 'editor') {
      await expect(w.call('files.write', { threadId: draft.id, path: 'added.txt', content: 'written' }))
        .resolves.toMatchObject({ receiptId: expect.any(String) })
    } else {
      const command = process.platform === 'win32'
        ? 'Set-Content -NoNewline -LiteralPath added.txt -Value written; exit'
        : 'printf written > added.txt; exit'
      const output: string[] = []
      pty!.on('data', ({ data }: { data: string }) => output.push(data))
      const exited = once(pty!, 'exit')
      const opened = await w.call('pty.create', { threadId: draft.id, agentId: 'main', command }) as { ptyId: string }
      await waitFor(() => existsSync(join(prepared.worktreePath, 'added.txt')) || !pty!.isAlive(opened.ptyId), 'the terminal command to finish', 30_000)
      expect(existsSync(join(prepared.worktreePath, 'added.txt')), output.join('')).toBe(true)
      await exited
      await pty!.shutdown()
      pty = undefined
    }
    expect(draft.manager.load()?.prepared).toBeUndefined()
    await w.d.orch.sweepAbandonedPreparedWorkspaces(Date.now() + PREPARED_WORKTREE_MAX_AGE_MS + 1_000)
    expect(readFileSync(join(prepared.worktreePath, 'added.txt'), 'utf8')).toBe('written')
    expect(existsSync(join(w.repo, 'added.txt'))).toBe(false)
  }, 90_000)

  it('expires an unclaimed checkout after a read-only first turn', async () => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    await w.send(draft.id, 'ask')
    await waitFor(() => w.pi.turns.length === 1 && !w.d.orch.isActiveTurnRunning(draft.id), 'the read-only turn to end')
    expect(w.pi.turns[0]?.cwd).toBe(w.repo)
    expect(draft.manager.load()?.prepared).toBeDefined()
    await w.focus(draft.id, false)
    await w.d.orch.sweepAbandonedPreparedWorkspaces(Date.now() + PREPARED_WORKTREE_MAX_AGE_MS + 1_000)
    expect(draft.manager.load()).toBeUndefined()
    expect(existsSync(prepared.worktreePath)).toBe(false)
  }, 90_000)

  it.each([false, true])('sends from the latest checkout when two requests overlap and the last is %s', async (enabled) => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    const deleting = gate()
    const finish = gate()
    unblock = finish.open
    const release = ThreadWorkspaceManager.prototype.releasePrepared
    const hold = vi.spyOn(ThreadWorkspaceManager.prototype, 'releasePrepared').mockImplementation(async function (this: ThreadWorkspaceManager, ...args) {
      deleting.open()
      await finish.wait
      return release.apply(this, args)
    })
    const off = w.toggle(draft.id, false)
    pending.push(off)
    await deleting.wait
    const sendChoice = w.toggle(draft.id, enabled)
    pending.push(sendChoice)
    finish.open()
    await sendChoice
    await off
    hold.mockRestore()
    await w.send(draft.id)
    await waitFor(() => w.pi.turns.length === 1, 'the prompt to reach the selected checkout', 50_000)
    expect(w.d.store.getThread(draft.id)?.worktreeEnabled).toBe(enabled)
    expect(w.pi.turns[0]?.cwd).toBe(enabled ? prepared.worktreePath : w.repo)
    expect(existsSync(prepared.worktreePath)).toBe(enabled)
  }, 90_000)

  it('rechecks filter drivers added during the disk wait before writing an untrusted checkout', async () => {
    const w = world()
    const draft = w.thread()
    const global = join(home!, 'gitconfig')
    vi.stubEnv('GIT_CONFIG_GLOBAL', global)
    writeFileSync(global, '')
    writeFileSync(join(w.repo, '.gitattributes'), '*.txt filter=Late\n')
    w.git(w.repo, 'add', '.gitattributes')
    w.git(w.repo, 'commit', '-qm', 'attributes')
    w.git(w.repo, 'config', 'extensions.worktreeConfig', 'true')
    const holding = gate()
    const held = gate()
    unblock = holding.open
    const slot = checkout.withCheckoutSlot(w.repo, async () => { held.open(); await holding.wait })
    pending.push(slot)
    await held.wait
    const made = draft.manager.provision(draft.id, 'main', w.repo, undefined, undefined, undefined, { untrusted: true })
    pending.push(made)
    await waitFor(() => {
      const path = draft.manager.load()?.worktreePath
      return Boolean(path && existsSync(join(path, '.git')))
    }, 'the untrusted worktree to register behind the slot')
    w.git(w.repo, 'config', '--global', 'filter.Late.smudge', 'sed s/keep/FILTER-RAN/')
    w.git(w.repo, 'config', '--global', 'filter.Late.required', 'true')
    holding.open()
    const worktree = await made
    expect(readFileSync(join(worktree.worktreePath, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
    expect(w.git(worktree.worktreePath, 'config', '--worktree', '--get', 'filter.Late.smudge')).toBe('')
    expect(w.git(worktree.worktreePath, 'config', '--worktree', '--get', 'filter.Late.required')).toBe('false')
  }, 90_000)

  it.each(['project subdirectory', 'linked source checkout', 'worktree sparse config', 'effective attributes file'])('invalidates a prepared claim after changing the %s', async (change) => {
    const w = world()
    const draft = w.thread()
    const attrs = join(home!, 'attributes')
    writeFileSync(attrs, '# baseline\n')
    w.git(w.repo, 'config', 'core.attributesFile', attrs)
    w.git(w.repo, 'config', 'extensions.worktreeConfig', 'true')
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    let project = w.repo
    if (change === 'project subdirectory') project = join(w.repo, 'keep')
    if (change === 'linked source checkout') {
      project = join(home!, 'other-checkout')
      w.git(w.repo, 'worktree', 'add', '--detach', project, 'HEAD')
    }
    if (change === 'worktree sparse config') w.git(prepared.worktreePath, 'sparse-checkout', 'set', 'omit')
    if (change === 'effective attributes file') writeFileSync(attrs, '# different\n')
    const lease = tryAcquireExecutionLease(draft.directory, { source: 'test claim' })!
    try {
      await expect(draft.manager.claimPrepared(project, 'main', lease)).resolves.toBeUndefined()
    } finally {
      releaseExecutionLeaseHandle(lease)
    }
    expect(draft.manager.load()).toBeUndefined()
  }, 90_000)

  it('drains a queued preparation on profile shutdown while another checkout still holds the disk slot', async () => {
    const w = world()
    const draft = w.thread()
    const release = gate()
    const held = gate()
    unblock = release.open
    pending.push(checkout.withCheckoutSlot(w.repo, async () => { held.open(); await release.wait }))
    await held.wait
    await w.focus(draft.id)
    await waitFor(() => {
      const fence = join(draft.directory, 'workspace-checkout.json')
      return existsSync(fence) && Boolean(JSON.parse(readFileSync(fence, 'utf8')).registration)
    }, 'the background worktree to register')
    const stopped = draft.manager.load()!
    await w.d.orch.shutdown(10_000)
    expect(draft.manager.load()?.lifecycle).toBe('provisioning')
    expect(existsSync(join(stopped.worktreePath, 'keep', 'tracked.txt'))).toBe(false)
    release.open()
  }, 90_000)

  it('shares the materialization cap across processes and removes an aborted waiter while the slot is held', async () => {
    const w = world()
    const draft = w.thread()
    await checkout.withCheckoutSlot(w.repo, async () => undefined)
    const program = await crashChild('tests/run/checkoutChild.ts', { packages: 'external' })
    const ready = join(home!, 'slot-ready')
    const proceed = join(home!, 'slot-proceed')
    const child = spawn(process.execPath, [program, 'slot', w.repo, ready, proceed], { env: process.env, windowsHide: true, stdio: 'ignore' })
    const exited = once(child, 'exit')
    pending.push(exited)
    unblock = () => { writeFileSync(proceed, '') }
    await waitFor(() => existsSync(ready) || child.exitCode !== null, 'the other process to hold the checkout slot', 30_000)
    expect(child.exitCode).toBeNull()

    const registered = join(home!, 'waiting-worktree')
    await checkout.registerWorktree({ cwd: w.repo, add: ['--detach', registered, 'HEAD'] })
    const abort = new AbortController()
    const queued = checkout.populateWorktree({ worktreePath: registered, plan: { settings: [] }, signal: abort.signal })
    const stopped = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    // This existing slot must prevent the real checkout from acquiring a writer, even in a different process.
    await expect(Promise.race([
      queued.then(() => 'wrote'),
      new Promise((resolve) => { setTimeout(() => resolve('waiting'), 100) })
    ])).resolves.toBe('waiting')
    abort.abort()
    await stopped
    expect(existsSync(join(registered, 'keep', 'tracked.txt'))).toBe(false)

    writeFileSync(proceed, '')
    await exited
    const made = await draft.manager.provision(draft.id, 'main', w.repo)
    expect(readFileSync(join(made.worktreePath, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
  }, 90_000)

  it('leaves a surviving Git writer alone after its owner is killed, then recovers its stale index lock', async () => {
    const w = world()
    const draft = { id: 'crash-thread', directory: join(home!, 'crash-thread') }
    mkdirSync(draft.directory)
    const manager = new ThreadWorkspaceManager(draft.directory)
    const started = join(home!, 'filter-started')
    const proceed = join(home!, 'filter-proceed')
    const filter = join(home!, 'checkout-filter.cjs')
    writeFileSync(filter, [
      'const fs = require("node:fs")',
      'const bytes = fs.readFileSync(0)',
      `fs.writeFileSync(${JSON.stringify(started)}, String(process.pid))`,
      `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(proceed)})) { clearInterval(timer); process.stdout.write(bytes) } }, 15)`
    ].join('\n'))
    writeFileSync(join(w.repo, '.gitattributes'), 'keep/tracked.txt filter=slow\n')
    w.git(w.repo, 'add', '.gitattributes')
    w.git(w.repo, 'commit', '-qm', 'attributes')
    const pathForGit = (path: string) => path.replaceAll('\\', '/')
    w.git(w.repo, 'config', 'filter.slow.smudge', `"${pathForGit(process.execPath)}" "${pathForGit(filter)}"`)
    expect(trustRepositoryPrograms(w.repo)?.filters['filter.slow.smudge']).toBeTruthy()
    const program = await crashChild('tests/run/checkoutChild.ts', { packages: 'external' })
    const child = spawn(process.execPath, [program, 'provision', draft.id, draft.directory, w.repo], { env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const exited = once(child, 'exit')
    const errors: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => { errors.push(chunk) })
    pending.push(exited)
    try {
      await waitFor(() => existsSync(started) || child.exitCode !== null, 'Git to enter its smudge filter', 40_000)
      expect(child.exitCode, Buffer.concat(errors).toString()).toBeNull()
      const workspace = manager.load()!
      const record = JSON.parse(readFileSync(join(draft.directory, 'workspace-checkout.json'), 'utf8'))
      const admin = w.git(workspace.worktreePath, 'rev-parse', '--absolute-git-dir')
      const lock = join(admin, 'index.lock')
      expect(existsSync(lock)).toBe(true)
      child.kill('SIGKILL')
      await exited
      const lease = tryAcquireExecutionLease(draft.directory, { source: 'test restart' })!
      try {
        expect(await manager.resumeInterruptedProvision(w.repo, lease)).toBe(false)
        expect(existsSync(lock)).toBe(true)
        try { process.kill(record.writer.pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        writeFileSync(proceed, '')
        const { checkoutWriterGone } = await import('../../src/mms/workspace/checkoutProcess')
        let gone = false
        const deadline = Date.now() + 10_000
        while (!gone && Date.now() < deadline) {
          gone = await checkoutWriterGone(record)
          if (!gone) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(gone).toBe(true)
        expect(existsSync(lock)).toBe(true)
        expect(await manager.resumeInterruptedProvision(w.repo, lease)).toBe(true)
      } finally {
        releaseExecutionLeaseHandle(lease)
      }
      expect(manager.load()?.lifecycle).toBe('ready')
      expect(readFileSync(join(workspace.worktreePath, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
      expect(existsSync(lock)).toBe(false)
    } finally {
      writeFileSync(proceed, '')
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 90_000)
})
