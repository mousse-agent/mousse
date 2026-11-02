/**
 * Mousse's thread actions (checkpoints, Undo, Discard, Publish) run their Git and file work without blocking the
 * daemon. The async helpers answer as Git does, the synchronous Git runner that remains gives the same answers; an
 * action whose Git does not answer holds only its own thread, and a second action on that thread still waits for the first.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { gitAsync, inspectPendingChangesAsync, runGitProcess, tryGit, tryGitAsync } from '../src/mms/actions/git'
import { takeSnapshotAsync, worktreeTreeAsync } from '../src/mms/actions/snapshots'
import { testHarness } from '../src/mms/run/testkit/harness'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'
import { piAdapter } from './run/phase6Fixture'
import { PI_TEST_CAPABILITIES } from './support/piStub'

const previousPath = process.env.PATH

/** Whether `promise` is still pending after a few turns of the event loop. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  for (let turn = 0; turn < 5 && !settled; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  return !settled
}

let f: ReturnType<typeof gitFoundationFixture>
beforeEach(() => { f = gitFoundationFixture() })
afterEach(() => {
  process.env.PATH = previousPath
  vi.restoreAllMocks()
  f.dispose()
})

describe('the async helpers', () => {
  it('answer as Git does, and as the synchronous runner that remains', async () => {
    writeFileSync(join(f.repo, 'value.txt'), 'changed\n')
    writeFileSync(join(f.repo, 'new.txt'), 'new\n')
    expect(await inspectPendingChangesAsync(f.repo)).toMatchObject({ files: expect.arrayContaining(['new.txt', 'value.txt']), unmerged: [] })
    // The worktree's files as a tree, without writing a commit: the snapshot taken next has the same tree.
    const tree = await worktreeTreeAsync(f.repo)
    const snapshot = await takeSnapshotAsync(f.repo, { reason: 'test' })
    expect(snapshot.tree).toBe(tree)
    // The files did not change, so both name the snapshot just taken.
    expect(await takeSnapshotAsync(f.repo, { reason: 'test' })).toEqual(snapshot)
    expect(await tryGitAsync(f.repo, ['rev-parse', '--verify', '-q', 'nothing'])).toEqual(tryGit(f.repo, ['rev-parse', '--verify', '-q', 'nothing']))
    // A failed command carries Git's own message, as `execFileSync` does.
    await expect(gitAsync(f.repo, ['rev-parse', '--verify', 'nothing^{commit}'])).rejects.toMatchObject({ status: 128, stderr: expect.stringContaining('fatal') })
  })

  it('count a run cut off at the output limit as failed, even when Git exited 0 first', async () => {
    // One byte past the 1 MiB both forms read by default.
    writeFileSync(join(f.repo, 'large.bin'), Buffer.alloc(1024 * 1024 + 1, 0x61))
    const blob = git(f.repo, 'hash-object', '-w', 'large.bin').trim()
    const sync = tryGit(f.repo, ['cat-file', '-p', blob])
    const async = await tryGitAsync(f.repo, ['cat-file', '-p', blob])
    expect(sync.ok).toBe(false)
    expect(async.ok).toBe(sync.ok)
  })

  it('report output past the limit as spawnSync does', async () => {
    const sync = spawnSync('git', ['log', '-p'], { cwd: f.repo, encoding: 'utf8', maxBuffer: 10 })
    const async = await runGitProcess(['log', '-p'], { cwd: f.repo, env: process.env, maxBuffer: 10 })
    expect(async.error?.code).toBe((sync.error as NodeJS.ErrnoException).code)
    expect(async.status).toBe(sync.status)
  })
})

describe.skipIf(process.platform === 'win32')('a thread action whose Git does not answer', () => {
  let mms: MousseMainService

  beforeEach(async () => {
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    vi.spyOn(mms.orchestrator, 'capabilitiesForThread').mockReturnValue(PI_TEST_CAPABILITIES as never)
  }, 30_000)
  afterEach(async () => {
    process.env.PATH = previousPath
    await mms.stop()
  })

  /** A thread with one finished turn, and its worktree. */
  async function threadWithTurn() {
    const ctx = { mms, globalSequence: () => 0 }
    const provider = mms.providerAuth.models.getProviders().find((item) => mms.providerAuth.models.getModels(item.id).length > 0)!
    mms.settings.set({ provider: { llmProvider: provider.id, model: mms.providerAuth.models.getModels(provider.id)[0].id } })
    mms.orchestrator.setHarness(testHarness({ adapters: [piAdapter((input) => { writeFileSync(join(input.cwd!, 'value.txt'), 'turn\n'); return 'Done.' })], profileHome: mms.getProfileHomeDir() }))
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Slow folder', project.id)
    await dispatchMethod(ctx, 'orchestrator.send', { threadId: thread.id, content: 'Change it.', mode: 'agent' })
    const worktree = new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()!.worktreePath
    return { ctx, thread, worktree, project }
  }

  /**
   * A `git` first on PATH: in `folder`, every command that writes (to the object store, an index, a ref or the files)
   * is logged, and `commit-tree` answers `seconds` late. `started` appears once a slow `commit-tree` has started.
   */
  function slowCommits(folder: string, seconds: number): { started: string; log: string } {
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const bin = join(f.root, 'bin')
    mkdirSync(bin, { recursive: true })
    const started = join(f.root, 'commit-started')
    const log = join(f.root, 'writes.log')
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      `if [ "$(pwd -P)" = "$(cd "${folder}" && pwd -P)" ]; then`,
      '  case "$*" in *write-tree*|*commit-tree*|*update-ref*|*read-tree*|*" add "*|*reset*|*clean*) echo "$*" >> "' + log + '";; esac',
      `  case "$*" in *commit-tree*) : > "${started}"; sleep ${seconds};; esac`,
      'fi',
      `exec "${real}" "$@"`,
      ''
    ].join('\n'))
    chmodSync(join(bin, 'git'), 0o755)
    process.env.PATH = `${bin}${delimiter}${previousPath}`
    return { started, log }
  }

  const lines = (log: string): number => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0

  it('holds only its own thread: other requests answer meanwhile', async () => {
    const { ctx, thread, worktree, project } = await threadWithTurn()
    writeFileSync(join(worktree, 'value.txt'), 'edited by hand\n')
    const { started } = slowCommits(worktree, 3)
    const begun = Date.now()
    // Discard records the files first: a snapshot, whose commit takes 3 seconds here.
    const discarding = dispatchMethod(ctx, 'workspace.discardPendingChanges', { threadId: thread.id, confirmed: true })
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 })
    expect(await pending(discarding)).toBe(true)
    await expect(dispatchMethod(ctx, 'threads.get', { threadId: thread.id })).resolves.toBeDefined()
    await expect(dispatchMethod(ctx, 'git.status', { projectId: project.id })).resolves.toMatchObject({ status: { isRepo: true } })
    await expect(dispatchMethod(ctx, 'settings.get', {})).resolves.toBeDefined()
    expect(Date.now() - begun).toBeLessThan(2500)
    expect(await pending(discarding)).toBe(true)
    // Once Git answers, the action finishes as usual.
    await expect(discarding).resolves.toMatchObject({ backupRef: expect.stringMatching(/^refs\/mousse\/discarded\//) })
    expect(git(worktree, 'status', '--porcelain')).toBe('')
  }, 40_000)

  /**
   * A `git` first on PATH that answers `seconds` late, once, to the status read retirement makes in `folder` before it
   * snapshots the checkout (`status --porcelain=v1 --untracked-files=all`, which nothing else runs there). The command is
   * written to the returned file when it starts, so the test can tell it ran.
   */
  function slowRetirementStatus(folder: string, seconds: number): string {
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const bin = join(f.root, 'bin')
    mkdirSync(bin, { recursive: true })
    const started = join(f.root, 'retirement-status-started')
    const resolved = execFileSync('sh', ['-c', `cd "${folder}" && pwd -P`], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      `if [ "$(pwd -P)" = "${resolved}" ] && [ ! -e "${started}" ]; then`,
      '  case "$*" in *" status --porcelain=v1 --untracked-files=all")',
      `    echo "$*" > "${started}"; sleep ${seconds};;`,
      '  esac',
      'fi',
      `exec "${real}" "$@"`,
      ''
    ].join('\n'))
    chmodSync(join(bin, 'git'), 0o755)
    process.env.PATH = `${bin}${delimiter}${previousPath}`
    return started
  }

  it('cleanup of a trashed thread holds only that thread: other requests answer while its retirement waits on Git', async () => {
    const { ctx, thread, worktree, project } = await threadWithTurn()
    const other = mms.threads.createThread('Another thread', project.id)
    const started = slowRetirementStatus(worktree, 3)
    const begun = Date.now()
    // Trash retires the thread's checkout in the same request; retirement's status read of it takes 3 seconds.
    const trashing = dispatchMethod(ctx, 'threads.trash', { threadId: thread.id })
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 })
    expect(readFileSync(started, 'utf8')).toMatch(/ status --porcelain=v1 --untracked-files=all$/m)
    expect(await pending(trashing)).toBe(true)
    await expect(dispatchMethod(ctx, 'threads.get', { threadId: other.id })).resolves.toBeDefined()
    await expect(dispatchMethod(ctx, 'git.status', { projectId: project.id })).resolves.toMatchObject({ status: { isRepo: true } })
    await expect(dispatchMethod(ctx, 'settings.get', {})).resolves.toBeDefined()
    expect(Date.now() - begun).toBeLessThan(2500)
    expect(await pending(trashing)).toBe(true)
    // Once Git answers, the trash finishes as usual, and the checkout went to the trash.
    await expect(trashing).resolves.toMatchObject({ ok: true })
    expect(existsSync(worktree)).toBe(false)
  }, 40_000)

  it('a second action on the same thread runs no Git of its own until the first has finished', async () => {
    const { ctx, thread, worktree } = await threadWithTurn()
    writeFileSync(join(worktree, 'value.txt'), 'edited by hand\n')
    const { started, log } = slowCommits(worktree, 2)
    const first = dispatchMethod(ctx, 'workspace.discardPendingChanges', { threadId: thread.id, confirmed: true })
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 })
    const second = dispatchMethod(ctx, 'workspace.discardPendingChanges', { threadId: thread.id, confirmed: true })
    // The first is inside its slow commit; nothing else writes in the folder while it is.
    const during = lines(log)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(lines(log)).toBe(during)
    expect(await pending(first)).toBe(true)
    await expect(first).resolves.toBeDefined()
    await expect(second).resolves.toBeDefined()
    expect(lines(log)).toBeGreaterThan(during)
  }, 40_000)
})
