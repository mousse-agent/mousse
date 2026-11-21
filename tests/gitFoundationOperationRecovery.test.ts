import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ThreadActionService, UNCAPTURED_START_FILE } from '../src/mms/actions/ThreadActionService'
import { CodeRevertService } from '../src/mms/actions/CodeRevertService'
import { PublishService } from '../src/mms/actions/PublishService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { worktreeTreeAsync } from '../src/mms/actions/snapshots'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { UndoService } from '../src/mms/actions/UndoService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { CRASH_CHILD_REQUIRE, actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

const CRASH_CHILD_TIMEOUT_MS = 60_000
const RECOVERY_TEST_TIMEOUT_MS = 120_000

let f: ReturnType<typeof gitFoundationFixture>
beforeEach(() => { f = gitFoundationFixture() })
afterEach(() => f.dispose())

it.each(['checkpoint', 'revert', 'publish'].flatMap((kind) => ['before', 'after'].map((phase) => ({ kind, phase }))))(
  'recovers $kind after process exit $phase its receipt write without repeating Git', async ({ kind, phase }) => {
    const config: Record<string, unknown> = { kind, phase, thread: f.thread, repo: f.repo }
    let recover: () => Promise<void>
    if (kind === 'checkpoint') {
      config.options = actionOptions(f.repo)
      recover = () => new ThreadActionService(f.thread).recoverPending(f.repo)
    } else if (kind === 'revert') {
      const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'value.txt'), 'to revert\n'))
      config.actionId = action.id
      recover = () => new CodeRevertService(f.thread).recoverPending(f.repo)
    } else {
      const source = f.child('child')
      const result = f.commit(source, 'child result\n')
      config.source = source; config.target = git(f.repo, 'branch', '--show-current')
      config.options = { operationId: 'crash-publish', expectedSourceSha: result, expectedTargetSha: f.baseSha }
      recover = () => new PublishService(f.thread).recoverPending(source, f.repo)
    }
    const configPath = join(f.root, 'crash.json')
    writeFileSync(configPath, JSON.stringify(config))
    const runner = join(f.root, 'operation-crash.mjs')
    await build({ entryPoints: ['tests/fixtures/git-foundation-operation-crash.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: CRASH_CHILD_REQUIRE } })
    const child = spawnSync(process.execPath, [runner, configPath], { env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: CRASH_CHILD_TIMEOUT_MS })
    expect(child.status, child.error?.message ?? child.stderr).toBe(86)
    // A checkpoint or a revert changes files only; publishing moves the primary's branch.
    const movesHead = kind === 'publish'
    const appliedHead = git(f.repo, 'rev-parse', 'HEAD')
    expect(appliedHead === f.baseSha).toBe(!movesHead)
    await recover!()
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(appliedHead)
    // The checkpoint's changes are uncommitted files (a snapshot); the others leave a clean checkout.
    expect(git(f.repo, 'status', '--porcelain')).toBe(kind === 'checkpoint' ? 'M value.txt' : '')
    expect(new ChangeReceiptService(f.thread).list().filter((receipt) => receipt.kind === kind)).toHaveLength(1)
    expect([...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => ['prepared', 'git_applied', 'running', 'context_pending', 'recovery_required'].includes(entry.state))).toEqual([])
    if (kind === 'checkpoint') expect(git(f.repo, 'rev-parse', `${new ThreadActionService(f.thread).latest('main')!.endSha}^{tree}`)).toBe((await worktreeTreeAsync(f.repo)))
    expect(f.read(f.repo)).toBe(kind === 'checkpoint' ? 'checkpoint result\n' : kind === 'revert' ? 'base\n' : 'child result\n')
    const journalSize = new ThreadJournal(f.thread).list().length
    await recover!()
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(appliedHead)
    expect(new ThreadJournal(f.thread).list()).toHaveLength(journalSize)
  }, RECOVERY_TEST_TIMEOUT_MS
)

it('recovers an interrupted nested snapshot before its parent and keeps whole-parent undo at the frontier', async () => {
  const configPath = join(f.root, 'nested.json')
  writeFileSync(configPath, JSON.stringify({ kind: 'nested-checkpoint', phase: 'after', thread: f.thread, repo: f.repo,
    baseSha: f.baseSha, options: actionOptions(f.repo, 'parent-turn') }))
  const runner = join(f.root, 'nested-crash.mjs')
  await build({ entryPoints: ['tests/fixtures/git-foundation-operation-crash.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: CRASH_CHILD_REQUIRE } })
  const child = spawnSync(process.execPath, [runner, configPath], { env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: CRASH_CHILD_TIMEOUT_MS })
  expect(child.status, child.error?.message ?? child.stderr).toBe(86)
  const appliedHead = git(f.repo, 'rev-parse', 'HEAD')
  const actions = new ThreadActionService(f.thread)
  await actions.recoverPending(f.repo)
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(appliedHead)
  expect(actions.list()).toHaveLength(2)
  expect(actions.latest('main')).toMatchObject({ turnId: 'parent-turn', state: 'stopped' })
  expect(git(f.repo, 'rev-parse', `${actions.latest('main')!.endSha}^{tree}`)).toBe((await worktreeTreeAsync(f.repo)))
  expect(actions.list()[0].turnId).toBe('nested-snapshot')
  const parentReceipt = new ChangeReceiptService(f.thread).list().find((receipt) => receipt.id === actions.latest('main')!.receiptId)!
  expect(parentReceipt.contributions.some((item) => item.receiptId === actions.list()[0].receiptId)).toBe(true)
  await pressed('Undo', () => new UndoService(f.thread).undoLatest('main', f.repo))
  expect(f.read(f.repo)).toBe('base\n')
  expect(git(f.repo, 'status', '--porcelain')).toBe('')
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(appliedHead)
}, RECOVERY_TEST_TIMEOUT_MS)

it.each(['before-capture-journal', 'before', 'after'])('a checkpoint in a thread worktree interrupted at %s recovers, with the pin, the record and Undo agreeing', async (phase) => {
  // The receipt's refs and the worktree's pin of its newest snapshot go in one `update-ref --stdin`; the worktree's own
  // record (`workspace.json`) is written only after the journal. A stop between the two must still recover.
  writeFileSync(join(f.thread, 'meta.json'), JSON.stringify({ id: 'task' }))
  const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
  const configPath = join(f.root, 'crash.json')
  writeFileSync(configPath, JSON.stringify({ kind: 'checkpoint', phase, thread: f.thread, repo: workspace.worktreePath, options: actionOptions(workspace.worktreePath) }))
  const runner = join(f.root, 'operation-crash.mjs')
  await build({ entryPoints: ['tests/fixtures/git-foundation-operation-crash.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: CRASH_CHILD_REQUIRE } })
  const child = spawnSync(process.execPath, [runner, configPath], { env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: CRASH_CHILD_TIMEOUT_MS })
  expect(child.status, child.error?.message ?? child.stderr).toBe(86)
  const top = workspace.worktreePath
  const captured = JSON.parse(readFileSync(resolve(top, git(top, 'rev-parse', '--git-path', 'mousse'), 'snapshot-last.json'), 'utf8')).sha
  const pinnedCaptures = () => git(top, 'for-each-ref', '--format=%(*objectname)', 'refs/mousse/checkpoints/')
  expect(pinnedCaptures()).toBe(captured)
  const head = git(top, 'rev-parse', 'HEAD')
  const index = git(top, 'ls-files', '-s')
  const later = join(top, 'later.txt')
  writeFileSync(later, 'saved after the crash\n')
  await new ThreadActionService(f.thread).recoverPending(workspace.worktreePath)
  const latest = new ThreadActionService(f.thread).latest('main')!
  expect(latest.endSha).toBe(captured)
  expect(pinnedCaptures()).toBe('')
  expect(latest.changedPaths.map((change) => change.path)).toEqual(['value.txt'])
  expect(readFileSync(later, 'utf8')).toBe('saved after the crash\n')
  expect(new ChangeReceiptService(f.thread).list().filter((receipt) => receipt.kind === 'checkpoint')).toHaveLength(1)
  expect([...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => ['prepared', 'git_applied', 'running', 'recovery_required'].includes(entry.state))).toEqual([])
  const record = new ThreadWorkspaceManager(f.thread).load()!
  expect(record.snapshotSha).toBe(latest.endSha)
  expect(git(workspace.worktreePath, 'rev-parse', record.retainedRef)).toBe(latest.endSha)
  const receipt = new ChangeReceiptService(f.thread).list().find((item) => item.operationId === latest.id)!
  expect(receipt.retainedRefs.map((ref) => git(workspace.worktreePath, 'rev-parse', ref))).toEqual([receipt.beforeSha, receipt.afterSha])
  expect(f.read(workspace.worktreePath)).toBe('checkpoint result\n')
  await pressed('Undo', () => new UndoService(f.thread).undoLatest('main', workspace.worktreePath))
  expect(f.read(workspace.worktreePath)).toBe('base\n')
  expect(readFileSync(later, 'utf8')).toBe('saved after the crash\n')
  expect(git(top, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(top, 'ls-files', '-s')).toBe(index)
}, RECOVERY_TEST_TIMEOUT_MS)

it.each(['before', 'after'])('Undo keeps a pre-turn save when start capture failed and the process exited %s writing the receipt', async (phase) => {
  writeFileSync(join(f.thread, 'meta.json'), JSON.stringify({ id: 'task' }))
  const { worktreePath: top } = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
  const head = git(top, 'rev-parse', 'HEAD')
  const index = git(top, 'ls-files', '-s')
  writeFileSync(join(top, 'outside.txt'), 'saved before the turn\n')
  // Git cannot acquire the private index lock or remove this directory on retry. The crash child removes it before end capture.
  const startIndexLock = resolve(top, git(top, 'rev-parse', '--git-path', 'mousse/snapshot-index.lock'))
  mkdirSync(startIndexLock)
  const configPath = join(f.root, 'uncaptured.json')
  writeFileSync(configPath, JSON.stringify({ kind: 'checkpoint', phase, thread: f.thread, repo: top, options: actionOptions(top), startIndexLock }))
  const runner = join(f.root, 'operation-crash.mjs')
  await build({ entryPoints: ['tests/fixtures/git-foundation-operation-crash.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: CRASH_CHILD_REQUIRE } })
  const child = spawnSync(process.execPath, [runner, configPath], { env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: CRASH_CHILD_TIMEOUT_MS })
  expect(child.status, child.error?.message ?? child.stderr).toBe(86)
  const captured = git(top, 'for-each-ref', '--format=%(*objectname)', 'refs/mousse/checkpoints/')
  expect(captured).toMatch(/^[a-f0-9]{40}$/)
  expect(new ChangeReceiptService(f.thread).list()).toHaveLength(phase === 'after' ? 1 : 0)

  const actions = new ThreadActionService(f.thread)
  await actions.recoverPending(top)
  const action = actions.latest('main')!
  const receipt = new ChangeReceiptService(f.thread).list().find((item) => item.id === action.receiptId)!
  await pressed('Undo', () => new UndoService(f.thread).undoLatest('main', top))
  expect(f.read(top, 'outside.txt')).toBe('saved before the turn\n')
  expect(f.read(top)).toBe('checkpoint result\n')
  expect(git(top, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(top, 'ls-files', '-s')).toBe(index)
  expect(receipt.notCovered).toContain('start of turn not captured')
  expect(receipt.beforeSha).toBe(captured)
  expect(action).toMatchObject({ startSha: receipt.beforeSha, endSha: captured, changedPaths: [], notCovered: receipt.notCovered })
  expect(existsSync(join(f.thread, UNCAPTURED_START_FILE))).toBe(false)
}, RECOVERY_TEST_TIMEOUT_MS)
