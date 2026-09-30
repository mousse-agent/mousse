import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

describe('Git foundation undo recovery', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  it.each(['receipt', 'context'])('recovers after a process exit at the %s durable boundary exactly once', async (phase) => {
    const actions = new ThreadActionService(f.thread)
    const { action } = await actions.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'value.txt'), 'changed\n'))
    const runner = join(f.root, 'crash-child.mjs')
    await build({ entryPoints: ['tests/fixtures/git-foundation-crash-child.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const child = spawnSync(process.execPath, [runner, f.thread, f.repo, phase], {
      env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: 20_000
    })
    expect(child.status, child.stderr).toBe(86)
    expect(f.read(f.repo)).toBe('base\n')
    const compensatedHead = git(f.repo, 'rev-parse', 'HEAD')
    const restore = vi.fn()
    await new UndoService(f.thread).recoverPending(f.repo, restore)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore.mock.calls[0][0]).toMatchObject({ id: action.id })
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(compensatedHead)
    expect(actions.list()).toHaveLength(2)
    expect(actions.latest('main')?.endSha).toBe(compensatedHead)
    expect(new ChangeReceiptService(f.thread).list()).toHaveLength(2)
    expect([...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => ['prepared', 'git_applied', 'context_pending'].includes(entry.state))).toEqual([])
    await new UndoService(f.thread).recoverPending(f.repo, restore)
    expect(restore).toHaveBeenCalledTimes(1)
  }, 30_000)

  it.each(['receipt', 'context'])('preserves the original conversation range when recovering redo at %s then undoing again', async (phase) => {
    const actions = new ThreadActionService(f.thread)
    const { action } = await actions.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'value.txt'), 'changed\n'))
    await new UndoService(f.thread).undoLatest('main', f.repo)
    const runner = join(f.root, 'redo-crash-child.mjs')
    await build({ entryPoints: ['tests/fixtures/git-foundation-crash-child.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const child = spawnSync(process.execPath, [runner, f.thread, f.repo, phase, 'redo'], {
      env: { ...process.env, MOUSSE_HOME: f.home }, windowsHide: true, encoding: 'utf8', timeout: 20_000
    })
    expect(child.status, child.stderr).toBe(86)
    expect(f.read(f.repo)).toBe('changed\n')
    const restoredHead = git(f.repo, 'rev-parse', 'HEAD')
    const restore = vi.fn()
    await new UndoService(f.thread).recoverPending(f.repo, restore)
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ id: action.id, presentationMessageStart: 0, presentationMessageEnd: 2 }), 'redo')
    expect(actions.latest('main')).toMatchObject({ presentationMessageStart: 0, presentationMessageEnd: 2 })
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(restoredHead)
    const undoAgain = vi.fn()
    await new UndoService(f.thread).undoLatest('main', f.repo, undefined, undefined, undoAgain)
    expect(f.read(f.repo)).toBe('base\n')
    expect(undoAgain).toHaveBeenCalledWith(expect.objectContaining({ presentationMessageStart: 0, nativeContextStartBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact', safeBoundaryProof: 'fixture' } }), 'undo')
  }, 30_000)

  it('recovers a context failure after Git compensation without applying Git twice or losing the original boundary', async () => {
    const actions = new ThreadActionService(f.thread)
    const { action } = await actions.runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'value.txt'), 'changed\n'))
    const failedRestore = vi.fn(() => { throw new Error('injected context storage interruption') })
    await expect(new UndoService(f.thread).undoLatest('main', f.repo, undefined, undefined, failedRestore))
      .rejects.toThrow('injected context storage interruption')
    expect(f.read(f.repo)).toBe('base\n')
    const compensatedHead = git(f.repo, 'rev-parse', 'HEAD')
    const pending = [...new ThreadJournal(f.thread).latestByOperation().values()].find((entry) => entry.operationType === 'undo')!
    expect(pending.state).toBe('context_pending')
    await expect(new UndoService(f.thread).undoLatest('main', f.repo)).rejects.toThrow(/recovery required/i)
    const restore = vi.fn()
    // A fresh service instance reads only durable state, as it would after restart.
    await new UndoService(f.thread).recoverPending(f.repo, restore)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore.mock.calls[0][0]).toMatchObject({ id: action.id, nativeContextStartBoundary: { messageIndex: 0 } })
    expect(restore.mock.calls[0][1]).toBe('undo')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(compensatedHead)
    expect(actions.list()).toHaveLength(2)
    expect(new ChangeReceiptService(f.thread).list()).toHaveLength(2)
    expect(new ThreadJournal(f.thread).latestByOperation().get(pending.operationId)?.state).toBe('completed')
    await new UndoService(f.thread).recoverPending(f.repo, restore)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(compensatedHead)
  }, 30_000)

  it('refuses context recovery after an unmanaged HEAD change and preserves the pending evidence', async () => {
    await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(f.repo), () => writeFileSync(join(f.repo, 'value.txt'), 'changed\n'))
    await expect(new UndoService(f.thread).undoLatest('main', f.repo, undefined, undefined, () => { throw new Error('interrupt') })).rejects.toThrow('interrupt')
    const moved = f.commit(f.repo, 'outside change\n')
    const restore = vi.fn()
    await expect(new UndoService(f.thread).recoverPending(f.repo, restore)).rejects.toThrow(/HEAD/)
    expect(restore).not.toHaveBeenCalled()
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(moved)
    expect([...new ThreadJournal(f.thread).latestByOperation().values()].some((entry) => entry.state === 'context_pending')).toBe(true)
  })
})
