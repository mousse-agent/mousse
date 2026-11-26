import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileService } from '../../src/mms/files/FileService'
import type { ChatMode } from '../../src/shared/types'
import * as gitProcess from '../../src/mms/git/runGitProcess'
import { readProcessEntries } from '../../src/mms/git/stoppedGitTree'
import { trustRepositoryPrograms } from '../../src/mms/git/repoPrograms'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease, waitAcquireExecutionLease } from '../../src/mms/queue/ThreadExecutionLease'
import { ThreadRuntimeManager } from '../../src/mms/runtime/ThreadRuntimeManager'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import * as folderMove from '../../src/mms/lifecycle/renameFolder'
import * as verifiedDelete from '../../src/mms/lifecycle/verifiedDelete'
import * as workspaceResolver from '../../src/mms/workspace/WorkspaceResolver'
import { PREPARED_WORKTREE_MAX_AGE_MS, releasePreparedWorkspace, settledPreparation } from '../../src/mms/workspace/workspacePreparation'
import { crashChild } from '../support/build'
import * as checkout from '../../src/mms/worktree/worktreeCheckout'
import { findCleanupRecord } from '../../src/mms/worktree/verifiedCleanup'
import { defaultThreadWorktreePath } from '../../src/mms/worktree/worktreeLayout'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

/** The checkout child as an ES module with its packages from the installation: Git starts through `gitSpawn`, which reads `import.meta.url`. */
const CHECKOUT_CHILD_BUILD = {
  format: 'esm' as const, packages: 'external' as const, banner: {
    js: 'import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(import.meta.url); const __dirname = import.meta.dirname; const __filename = import.meta.filename;'
  }
}

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
    const toggle = (threadId: string, enabled: boolean, picked = false) => dispatchMethod(ctx, 'threads.setWorktreeEnabled', { threadId, enabled, picked })
    const send = (threadId: string, mode: ChatMode = 'agent', clientRequestId = threadId) => d.orch.send({ content: 'Read the tracked file', mode }, false, { threadId, clientRequestId, awaitMode: 'ack' })
    const call = (method: string, params: Record<string, unknown>) => dispatchMethod(ctx, method, params)
    return { d, git, repo, thread, pi, focus, toggle, send, call }
  }

  /**
   * A trusted smudge filter on every file. Git writes .gitattributes and .gitignore through it first. Its first run for
   * keep/tracked.txt starts a child and both wait until `proceed` exists, so Git holds the worktree's index.lock
   * meanwhile. Every other run passes the file through at once.
   */
  function stallingCheckout(w: ReturnType<typeof world>) {
    const started = join(home!, 'stalled-checkout-pids')
    const proceed = join(home!, 'release-stalled-checkout')
    const filter = join(home!, 'stalled-checkout.cjs')
    writeFileSync(filter, [
      'const fs = require("node:fs")',
      'const { spawn } = require("node:child_process")',
      'const [started, proceed, path, parent] = process.argv.slice(2)',
      'const wait = (finish) => { const timer = setInterval(() => { if (fs.existsSync(proceed)) { clearInterval(timer); finish() } }, 15) }',
      'if (parent) {',
      '  fs.writeFileSync(started, JSON.stringify([Number(parent), process.pid]))',
      '  wait(() => {})',
      '} else {',
      '  const bytes = fs.readFileSync(0)',
      '  if (path !== "keep/tracked.txt" || fs.existsSync(started)) process.stdout.write(bytes)',
      '  else {',
      '    spawn(process.execPath, [__filename, started, proceed, path, String(process.pid)], { stdio: "ignore" }).unref()',
      '    wait(() => process.stdout.write(bytes))',
      '  }',
      '}'
    ].join('\n'))
    writeFileSync(join(w.repo, '.gitattributes'), '* filter=stall\n')
    w.git(w.repo, 'add', '.gitattributes')
    w.git(w.repo, 'commit', '-qm', 'attributes')
    const quote = (path: string) => '"' + path.replaceAll('\\', '/') + '"'
    w.git(w.repo, 'config', 'filter.stall.smudge', [process.execPath, filter, started, proceed].map(quote).join(' ') + ' %f')
    expect(trustRepositoryPrograms(w.repo)?.filters['filter.stall.smudge']).toBeTruthy()
    let pids: number[] | undefined
    return {
      proceed,
      /** Waits for the filter and its child to start. */
      async running() {
        await waitFor(() => {
          try { pids = JSON.parse(readFileSync(started, 'utf8')) as number[]; return true } catch { return false }
        }, 'the checkout filter and its child to start', 30_000)
      },
      /** The filter's processes still running. */
      async live() {
        const entries = await readProcessEntries()
        expect(entries).toBeDefined()
        return entries!.filter((entry) => pids!.includes(entry.pid) && !entry.zombie).map((entry) => entry.pid)
      }
    }
  }

  /** Whether the disk slot is free now: a slot user of the same disk starts within a few seconds. */
  async function diskSlotFree(path: string): Promise<boolean> {
    const used = checkout.withCheckoutSlot(path, async () => true)
    pending.push(used)
    return await Promise.race([used, new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 5_000) })])
  }

  /** Whether nothing holds the thread's lease. */
  function leaseFree(directory: string): boolean {
    const lease = tryAcquireExecutionLease(directory, { source: 'test after Stop' })
    if (lease) releaseExecutionLeaseHandle(lease)
    return Boolean(lease)
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

  it('retries a legacy failed provision when the path and registration are absent', async () => {
    const w = world()
    const draft = w.thread()
    const interrupted = vi.spyOn(checkout, 'registerWorktree').mockRejectedValueOnce(new Error('worktree add failed'))
    await expect(draft.manager.provision(draft.id, 'main', w.repo)).rejects.toThrow('worktree add failed')
    interrupted.mockRestore()
    const failed = draft.manager.load()!
    expect(failed.lifecycle).toBe('provisioning')
    expect(existsSync(failed.worktreePath)).toBe(false)
    rmSync(join(draft.directory, 'workspace-checkout.json'))
    await w.send(draft.id)
    await waitFor(() => w.pi.turns.length === 1, 'the prompt to reach the retried checkout', 50_000)
    expect(w.pi.turns[0]?.cwd).toBe(draft.manager.load()?.worktreePath)
    expect(readFileSync(join(w.pi.turns[0]!.cwd, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
  }, 90_000)

  it('can send from the project folder after a draft checkout path is occupied', async () => {
    const w = world()
    const draft = w.thread()
    const { repositoryId } = await draft.manager.resolveRepositoryAsync(w.repo)
    const occupied = defaultThreadWorktreePath(home!, repositoryId, draft.id, 'main')
    mkdirSync(join(occupied, '..'), { recursive: true })
    writeFileSync(occupied, 'user file')
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    await w.toggle(draft.id, false, true)
    await w.send(draft.id)
    await waitFor(() => w.pi.turns.length === 1, 'the prompt to reach the project folder', 50_000)
    expect(w.pi.turns[0]?.cwd).toBe(w.repo)
    expect(readFileSync(occupied, 'utf8')).toBe('user file')
  }, 90_000)

  it('drains the expiry sweep on profile shutdown', async () => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    await w.focus(draft.id, false)
    const prepared = draft.manager.load()!
    const renamed = gate()
    const finish = gate()
    unblock = finish.open
    const rename = folderMove.renameFolderAsync
    vi.spyOn(folderMove, 'renameFolderAsync').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (from === prepared.worktreePath) {
        renamed.open()
        await finish.wait
      }
    })
    const sweep = w.d.orch.sweepAbandonedPreparedWorkspaces(Date.now() + PREPARED_WORKTREE_MAX_AGE_MS + 1_000)
    pending.push(sweep)
    await expect(Promise.race([renamed.wait.then(() => 'renamed'), sweep.then(() => 'early end')])).resolves.toBe('renamed')
    await expect(w.d.orch.shutdown(50)).rejects.toMatchObject({ code: 'profile_busy', details: { 'workspace-expiry': 1 } })
    finish.open()
    await w.d.orch.shutdown()
    expect(draft.manager.load()).toBeUndefined()
    expect(w.git(w.repo, 'worktree', 'list', '--porcelain')).not.toContain(prepared.branch)
  }, 90_000)

  it.each(['null device', 'Git without attribute variables'] as const)('claims the prepared checkout when using %s', async (configuration) => {
    const w = world()
    const draft = w.thread()
    if (configuration === 'null device') {
      w.git(w.repo, 'config', 'core.attributesFile', process.platform === 'win32' ? 'NUL' : '/dev/null')
    } else {
      const run = gitProcess.runGitProcess
      vi.spyOn(gitProcess, 'runGitProcess').mockImplementation((args, options) =>
        args.includes('var') && args.some((arg) => arg === 'GIT_ATTR_GLOBAL' || arg === 'GIT_ATTR_SYSTEM')
          ? Promise.resolve({ status: 129, stdout: '', stderr: 'usage: git var', stdoutBytes: Buffer.alloc(0) })
          : run(args, options))
    }
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    expect(prepared.lifecycle).toBe('ready')
    await w.send(draft.id)
    await waitFor(() => w.pi.turns.length === 1, 'the prompt to reach the prepared checkout', 50_000)
    expect(w.pi.turns[0]?.cwd).toBe(prepared.worktreePath)
    expect(draft.manager.load()?.prepared).toBeUndefined()
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
    await waitFor(() => w.pi.turns.length === 1, 'the prepared worktree to be claimed', 50_000)
    await expect(w.call('files.writeDirect', { ...request, expectedRoot: opened.workspaceRoot, content: 'after claim' }))
      .rejects.toMatchObject({ code: 'file_workspace_changed' })
    expect(readFileSync(join(prepared.worktreePath, request.path), 'utf8')).toBe('keep')
  }, 90_000)

  // A terminal on such a draft opens in the project folder and claims nothing (`emptyThreadCheckoutSwitch.test.ts`).
  it('claims the checkout for a checkpointed editor before writing', async () => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    await w.focus(draft.id, false)
    await expect(w.call('files.write', { threadId: draft.id, path: 'added.txt', content: 'written' }))
      .resolves.toMatchObject({ receiptId: expect.any(String) })
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

  it.each([
    { enabled: false, blocked: false },
    { enabled: true, blocked: false },
    { enabled: true, blocked: true }
  ])('uses the latest choice after rename ($enabled, cleanup blocked: $blocked)', async ({ enabled, blocked }) => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    const deleting = gate()
    const finish = gate()
    let deletingPath: string | undefined
    unblock = finish.open
    const rename = folderMove.renameFolderAsync
    if (blocked) vi.spyOn(verifiedDelete, 'deleteVerifiedAsync').mockResolvedValueOnce({ kept: 'Files are in use', readOnly: true })
    const hold = vi.spyOn(folderMove, 'renameFolderAsync').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (from === prepared.worktreePath) {
        deletingPath = to
        expect(existsSync(to)).toBe(true)
        deleting.open()
        await finish.wait
      }
    })
    const off = w.toggle(draft.id, false, true)
    pending.push(off)
    await deleting.wait
    const sendChoice = w.toggle(draft.id, enabled, true)
    pending.push(sendChoice)
    finish.open()
    await sendChoice
    await off
    hold.mockRestore()
    expect(deletingPath && existsSync(deletingPath)).toBe(blocked)
    expect(draft.manager.load()?.branch).not.toBe(prepared.branch)
    await w.send(draft.id)
    await waitFor(() => w.pi.turns.length === 1, 'the prompt to reach the selected checkout', 50_000)
    expect(w.d.store.getThread(draft.id)?.worktreeEnabled).toBe(enabled)
    const cwd = w.pi.turns[0]?.cwd
    expect(cwd).toBe(enabled ? draft.manager.load()?.worktreePath : w.repo)
    if (enabled) {
      expect(cwd).not.toContain('.deleting-')
      expect(readFileSync(join(cwd!, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
      expect(draft.manager.load()?.branch).not.toBe(prepared.branch)
    }
    if (blocked) expect(readFileSync(join(deletingPath!, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
    else expect(w.git(w.repo, 'worktree', 'list', '--porcelain')).not.toContain(prepared.branch)
  }, 90_000)

  it('uses a fresh worktree for Send after a locked registration survives draft deletion', async () => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    const remove = verifiedDelete.deleteVerifiedAsync
    // Lock the actual Git registration after the proof has removed the files, before cleanup unregisters it.
    const lock = vi.spyOn(verifiedDelete, 'deleteVerifiedAsync').mockImplementationOnce(async (input) => {
      const result = await remove(input)
      expect(existsSync(input.root)).toBe(false)
      w.git(w.repo, 'worktree', 'lock', '--reason', 'held by another Git client', prepared.worktreePath)
      return result
    })
    await w.toggle(draft.id, false, true)
    lock.mockRestore()
    const cleanup = await findCleanupRecord(home!, prepared.worktreePath)
    expect(cleanup?.branch).toBe(prepared.branch)
    expect(existsSync(cleanup!.deletingPath)).toBe(false)
    expect(existsSync(prepared.worktreePath)).toBe(false)
    const registrations = () => w.git(w.repo, 'worktree', 'list', '--porcelain')
    expect(registrations()).toContain('locked held by another Git client')

    await w.toggle(draft.id, true, true)
    await w.send(draft.id)
    await waitFor(() => w.pi.turns.length === 1 || !w.d.orch.isActiveTurnRunning(draft.id), 'Send to settle')
    const claimed = draft.manager.load()!
    expect(w.pi.turns[0]?.cwd).toBe(claimed.worktreePath)
    expect(claimed.worktreePath).not.toBe(prepared.worktreePath)
    expect(claimed.prepared).toBeUndefined()
    expect(readFileSync(join(claimed.worktreePath, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
    expect(registrations()).toContain('locked held by another Git client')
  }, 90_000)

  it('sends from the project folder while keeping a dirty draft', async () => {
    const w = world()
    const draft = w.thread()
    await w.focus(draft.id)
    await settledPreparation(draft.directory)
    const prepared = draft.manager.load()!
    const tracked = join(prepared.worktreePath, 'keep', 'tracked.txt')
    const untracked = join(prepared.worktreePath, 'draft.txt')
    writeFileSync(tracked, 'draft edit')
    w.git(prepared.worktreePath, 'add', 'keep/tracked.txt')
    writeFileSync(untracked, 'only in the draft')
    const dirty = w.git(prepared.worktreePath, 'status', '--porcelain')
    expect(dirty).toContain('M  keep/tracked.txt')

    await w.toggle(draft.id, false, true)
    await w.send(draft.id)
    await waitFor(() => w.pi.turns.length === 1 || !w.d.orch.isActiveTurnRunning(draft.id), 'Send to settle')
    expect(w.pi.turns[0]?.cwd).toBe(w.repo)
    expect(draft.manager.load()).toMatchObject({ kind: 'project-folder', worktreePath: w.repo })
    expect(w.git(prepared.worktreePath, 'status', '--porcelain')).toBe(dirty)
    expect(readFileSync(tracked, 'utf8')).toBe('draft edit')
    expect(readFileSync(untracked, 'utf8')).toBe('only in the draft')
  }, 90_000)

  it.each(['disk wait', 'Git invocation'] as const)('ignores a filter added at the %s when writing an untrusted checkout', async (stage) => {
    const w = world()
    const draft = w.thread()
    const global = join(home!, 'gitconfig')
    vi.stubEnv('GIT_CONFIG_GLOBAL', global)
    writeFileSync(global, '')
    writeFileSync(join(w.repo, '.gitattributes'), '*.txt filter=Late\n')
    w.git(w.repo, 'add', '.gitattributes')
    w.git(w.repo, 'commit', '-qm', 'attributes')
    w.git(w.repo, 'config', 'extensions.worktreeConfig', 'true')
    if (stage === 'Git invocation') {
      const patterns = join(home!, 'untrusted-patterns')
      writeFileSync(patterns, 'keep\n')
      w.git(w.repo, 'config', 'mousse.sparseCheckout', patterns)
    }
    const holding = gate()
    const held = gate()
    const addFilter = () => {
      w.git(w.repo, 'config', '--global', 'filter.Late.smudge', 'sed s/keep/FILTER-RAN/')
      w.git(w.repo, 'config', '--global', 'filter.Late.required', 'true')
    }
    if (stage === 'Git invocation') {
      const run = gitProcess.runGitProcess
      vi.spyOn(gitProcess, 'runGitProcess').mockImplementation((args, options) => {
        if (args.includes('checkout') && args.at(-1) === 'HEAD') addFilter()
        return run(args, options)
      })
    }
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
    if (stage === 'disk wait') addFilter()
    holding.open()
    const worktree = await made
    expect(readFileSync(join(worktree.worktreePath, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
    if (stage === 'Git invocation') expect(existsSync(join(worktree.worktreePath, 'omit'))).toBe(false)
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
    const program = await crashChild('tests/run/checkoutChild.ts', CHECKOUT_CHILD_BUILD)
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

  it('stops a live checkout and its descendants before the disk slot and thread lease are reused', async () => {
    const w = world()
    const draft = w.thread()
    const stall = stallingCheckout(w)
    const { proceed, live } = stall

    const abort = new AbortController()
    unblock = () => { writeFileSync(proceed, ''); abort.abort() }
    const active = draft.manager.provision(draft.id, 'main', w.repo, abort.signal)
    const stopped = active.then(() => 'completed', (error: Error) => error.name)
    pending.push(stopped)
    await stall.running()
    expect(await live()).toHaveLength(2)
    expect(tryAcquireExecutionLease(draft.directory, { source: 'test while checkout is active' })).toBeNull()

    const waiting = join(home!, 'waiting-after-stop')
    await checkout.registerWorktree({ cwd: w.repo, add: ['--detach', waiting, 'HEAD'] })
    const next = checkout.populateWorktree({
      worktreePath: waiting, plan: { settings: [] },
      beforeCheckout: async () => { expect(await live()).toEqual([]) }
    })
    const nextLease = waitAcquireExecutionLease(draft.directory, { source: 'test after checkout stops', maxAttempts: 200, retryDelayMs: 50 })
      .then(async (lease) => {
        try { expect(await live()).toEqual([]) } finally { releaseExecutionLeaseHandle(lease) }
      })
    pending.push(next, nextLease)
    abort.abort()
    await Promise.all([expect(stopped).resolves.toBe('AbortError'), next, nextLease])
    expect(readFileSync(join(waiting, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
    expect(existsSync(proceed)).toBe(false)
  }, 35_000)

  it('lets the next Send finish a checkout that Stop ended while Git held the index lock', async () => {
    const w = world()
    const thread = w.thread()
    const stall = stallingCheckout(w)
    unblock = () => { writeFileSync(stall.proceed, '') }
    await w.send(thread.id)
    await stall.running()
    expect(await stall.live()).toHaveLength(2)
    const stopped = thread.manager.load()!
    const lock = join(w.git(stopped.worktreePath, 'rev-parse', '--absolute-git-dir'), 'index.lock')
    expect(existsSync(lock)).toBe(true)
    // Git wrote these before the stalled file. They stay untracked, because Git never wrote the index.
    expect(readFileSync(join(stopped.worktreePath, '.gitattributes'), 'utf8')).toContain('filter=stall')
    expect(readFileSync(join(stopped.worktreePath, '.gitignore'), 'utf8')).toBe('ignored.txt\n')

    await w.d.orch.stopThread(thread.id, 'user')
    await waitFor(() => leaseFree(thread.directory), 'the stopped turn to let go of the thread', 30_000)
    expect(await stall.live()).toEqual([])
    expect(await diskSlotFree(w.repo)).toBe(true)
    expect(existsSync(lock)).toBe(false)
    expect(thread.manager.load()?.lifecycle).toBe('provisioning')
    expect(w.pi.turns).toHaveLength(0)

    await w.send(thread.id, 'agent', 'retry')
    await waitFor(() => w.pi.turns.length === 1, 'the retried prompt to reach the provider', 50_000)
    expect(w.pi.turns[0]).toMatchObject({ threadId: thread.id, cwd: stopped.worktreePath })
    expect(thread.manager.load()).toMatchObject({ lifecycle: 'ready', branch: stopped.branch })
    expect(readFileSync(join(stopped.worktreePath, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
    expect(w.git(stopped.worktreePath, 'status', '--porcelain')).toBe('')
    expect(existsSync(stall.proceed)).toBe(false)
  }, 90_000)

  it('stops the checkout a draft is preparing when Stop ends the Send waiting for it', async () => {
    const w = world()
    const draft = w.thread()
    const stall = stallingCheckout(w)
    unblock = () => { writeFileSync(stall.proceed, '') }
    await w.focus(draft.id)
    await stall.running()
    const prepared = draft.manager.load()!
    expect(prepared.prepared).toBeDefined()

    await w.send(draft.id)
    await waitFor(() => {
      const state = w.d.orch.getTurnState(draft.id)
      return state.step?.kind === 'preparing' && state.step.what === 'worktree'
    }, 'the turn to wait for the draft’s worktree')
    expect(await stall.live()).toHaveLength(2)
    expect(readFileSync(join(prepared.worktreePath, '.gitignore'), 'utf8')).toBe('ignored.txt\n')

    await w.d.orch.stopThread(draft.id, 'user')
    // Stop returns once the checkout has exited and let go of what it held.
    expect(await stall.live()).toEqual([])
    expect(leaseFree(draft.directory)).toBe(true)
    expect(await diskSlotFree(w.repo)).toBe(true)
    expect(w.pi.turns).toHaveLength(0)

    await w.send(draft.id, 'agent', 'retry')
    await waitFor(() => w.pi.turns.length === 1, 'the retried prompt to reach the provider', 50_000)
    expect(w.pi.turns[0]).toMatchObject({ threadId: draft.id, cwd: prepared.worktreePath })
    expect(readFileSync(join(prepared.worktreePath, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
    expect(w.git(prepared.worktreePath, 'status', '--porcelain')).toBe('')
    expect(existsSync(stall.proceed)).toBe(false)
  }, 90_000)

  it('preserves the disk slot after a crash until the surviving Git writer finishes', async () => {
    const w = world()
    await checkout.withCheckoutSlot(w.repo, async () => undefined)
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
    const program = await crashChild('tests/run/checkoutChild.ts', CHECKOUT_CHILD_BUILD)
    const child = spawn(process.execPath, [program, 'provision', draft.id, draft.directory, w.repo], { env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const exited = once(child, 'exit')
    const errors: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => { errors.push(chunk) })
    pending.push(exited)
    try {
      await waitFor(() => existsSync(started) || child.exitCode !== null, 'Git to enter its smudge filter', 40_000)
      expect(child.exitCode, Buffer.concat(errors).toString()).toBeNull()
      const workspace = manager.load()!
      const admin = w.git(workspace.worktreePath, 'rev-parse', '--absolute-git-dir')
      const lock = join(admin, 'index.lock')
      expect(existsSync(lock)).toBe(true)
      child.kill('SIGKILL')
      await exited
      expect(() => process.kill(Number(readFileSync(started, 'utf8')), 0)).not.toThrow()
      const waiting = join(home!, 'next-worktree')
      await checkout.registerWorktree({ cwd: w.repo, add: ['--detach', waiting, 'HEAD'] })
      const enteredSlot = gate()
      const next = checkout.populateWorktree({
        worktreePath: waiting, plan: { settings: [] }, beforeCheckout: async () => { enteredSlot.open() }
      })
      pending.push(next)
      const lease = tryAcquireExecutionLease(draft.directory, { source: 'test restart' })!
      try {
        expect(await manager.resumeInterruptedProvision(w.repo, lease)).toBe(false)
        expect(existsSync(lock)).toBe(true)
        await expect(Promise.race([
          enteredSlot.wait.then(() => 'admitted'),
          new Promise((resolve) => { setTimeout(() => resolve('waiting'), 250) })
        ])).resolves.toBe('waiting')
        writeFileSync(proceed, '')
        await next
        expect(readFileSync(join(waiting, 'keep', 'tracked.txt'), 'utf8')).toBe('keep')
        expect(existsSync(lock)).toBe(false)

        // Git takes index.lock while waiting for update-index input. This is a later, live writer
        // in the same registration, after the recorded checkout writer has already exited.
        const foreign = spawn('git', ['update-index', '--index-info'], {
          cwd: workspace.worktreePath, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']
        })
        const foreignExited = once(foreign, 'exit')
        foreign.stdin!.on('error', () => {})
        try {
          await waitFor(() => existsSync(lock), 'the second Git writer to lock the index')
          expect(await manager.resumeInterruptedProvision(w.repo, lease)).toBe(false)
          expect(existsSync(lock)).toBe(true)
        } finally {
          foreign.stdin!.end()
          await foreignExited
        }
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
