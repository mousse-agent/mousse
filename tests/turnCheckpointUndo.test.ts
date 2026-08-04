import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'

const roots: string[] = []
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'mousse-action-')); roots.push(base)
  const repo = join(base, 'repo'); const thread = join(base, 'thread'); mkdirSync(repo); mkdirSync(thread)
  execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo }); execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
  writeFileSync(join(repo, 'value.txt'), 'base\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })
  return { repo, thread }
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const boundary = { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }

describe('turn checkpoints and compensating undo', () => {
  it('commits every non-ignored turn change and undoes it without rewriting history', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    const { action } = await actions.runCheckpointedAction({
      threadId: 'thread', turnId: 'turn', conversationBranchId: 'main', workspacePath: repo,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, () => { writeFileSync(join(repo, 'value.txt'), 'changed\n'); writeFileSync(join(repo, 'new.txt'), 'new\n') })
    expect(action.startSha).toBe(before)
    expect(action.endSha).not.toBe(before)
    expect(action.changedPaths.map((item) => item.path).sort()).toEqual(['new.txt', 'value.txt'])

    const compensation = await new UndoService(thread).undoLatest('main', repo)
    expect(readFileSync(join(repo, 'value.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n')
    expect(compensation.endSha).not.toBe(action.startSha)
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('3')
    expect(actions.get(action.id)?.state).toBe('undone')
  })

  it('records no-op actions so conversation lineage remains complete', async () => {
    const { repo, thread } = fixture(); const actions = new ThreadActionService(thread)
    const { action } = await actions.runCheckpointedAction({
      threadId: 'thread', turnId: 'noop', conversationBranchId: 'main', workspacePath: repo,
      presentationMessageStart: 0, presentationMessageEnd: 1, nativeContextBoundary: boundary
    }, () => undefined)
    expect(action.startSha).toBe(action.endSha)
    expect(action.commits).toEqual([])
    expect(action.state).toBe('completed')
  })
})
