import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { resolveReviewScope } from '../src/mms/actions/reviewRange'
import { listChangedFiles } from '../src/mms/git/reviewDiff'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

let f: ReturnType<typeof gitFoundationFixture>
let cwd: string
let actions: ThreadActionService
beforeEach(async () => {
  f = gitFoundationFixture()
  cwd = (await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)).worktreePath
  actions = new ThreadActionService(f.thread)
})
afterEach(() => f.dispose())

/** Turn ids are Run Engine run ids: `run:thread:<encoded thread id>:ordinal:<n>`. */
const turnId = (ordinal: number): string => `run:thread:abc%3Adef:ordinal:${ordinal}`
const turn = (ordinal: number) => ({ kind: 'turn' as const, turnId: turnId(ordinal) })
const edit = (path: string, value: string) => () => writeFileSync(join(cwd, path), value)
const paths = async (resolved: NonNullable<ReturnType<typeof resolveReviewScope>>) => (await listChangedFiles(resolved.cwd, resolved.range)).files.map((file) => file.path)

describe('resolveReviewScope', () => {
  it('maps a completed turn to its own start and end commits', async () => {
    const before = git(cwd, 'rev-parse', 'HEAD')
    const { action } = await actions.runCheckpointedAction(actionOptions(cwd, turnId(1)), edit('one.txt', '1\n'))
    const resolved = resolveReviewScope(f.thread, turn(1))!
    expect(resolved.unavailable).toBeUndefined()
    expect(resolved.cwd).toBe(cwd)
    expect(resolved.range).toEqual({ from: { kind: 'commit', sha: before }, to: { kind: 'commit', sha: action.endSha } })
    expect(await paths(resolved)).toEqual(['one.txt'])
  })

  it('resolves a stopped turn between two completed turns on its own pair, and the next turn still resolves', async () => {
    await actions.runCheckpointedAction(actionOptions(cwd, turnId(1)), edit('one.txt', '1\n'))
    const stoppedStart = git(cwd, 'rev-parse', 'HEAD')
    const options = actionOptions(cwd, turnId(2))
    actions.beginTurn(options, stoppedStart)
    edit('two.txt', 'partial\n')()
    const stopped = await actions.checkpointExistingTurn(options, stoppedStart, 'stopped')
    expect(stopped.state).toBe('stopped')
    await actions.runCheckpointedAction(actionOptions(cwd, turnId(3)), edit('three.txt', '3\n'))

    const second = resolveReviewScope(f.thread, turn(2))!
    expect(second.range.from).toEqual({ kind: 'commit', sha: stoppedStart })
    expect(second.range.to).toEqual({ kind: 'commit', sha: stopped.endSha })
    expect(await paths(second)).toEqual(['two.txt'])
    const third = resolveReviewScope(f.thread, turn(3))!
    expect(third.range.from).toEqual({ kind: 'commit', sha: stopped.endSha })
    expect(await paths(third)).toEqual(['three.txt'])
  })

  it('maps a running turn made by beginTurn to the working tree, so an uncommitted edit is listed', async () => {
    const startSha = git(cwd, 'rev-parse', 'HEAD')
    const running = actions.beginTurn(actionOptions(cwd, turnId(1)), startSha)
    expect(running).toMatchObject({ endSha: startSha, commits: [], changedPaths: [], state: 'running' })
    edit('value.txt', 'in progress\n')()
    const resolved = resolveReviewScope(f.thread, turn(1))!
    expect(resolved.range).toEqual({ from: { kind: 'commit', sha: startSha }, to: { kind: 'worktree' } })
    expect(await paths(resolved)).toEqual(['value.txt'])
  })

  it('treats a completed turn with equal SHAs as an empty turn, not an error', async () => {
    const { action } = await actions.runCheckpointedAction(actionOptions(cwd, turnId(1)), () => undefined)
    expect(action.endSha).toBe(action.startSha)
    const resolved = resolveReviewScope(f.thread, turn(1))!
    expect(resolved.unavailable).toBeUndefined()
    expect(await paths(resolved)).toEqual([])
  })

  it('reports a turn without an action as not checkpointed', () => {
    expect(resolveReviewScope(f.thread, turn(9))).toMatchObject({ unavailable: 'This turn was not checkpointed' })
  })

  it('ignores a conversation-only action with the same turn id', async () => {
    await actions.runCheckpointedAction(actionOptions(cwd, turnId(1)), edit('one.txt', '1\n'))
    const list = actions.list()
    actions.replace([{ ...list[0], id: 'conversation-action', scope: 'conversation', startSha: 'f'.repeat(40) }, ...list])
    expect(resolveReviewScope(f.thread, turn(1))!.unavailable).toBeUndefined()
  })

  it('maps the thread to its base commit and the working tree', async () => {
    await actions.runCheckpointedAction(actionOptions(cwd, turnId(1)), edit('one.txt', '1\n'))
    edit('loose.txt', 'uncommitted\n')()
    const resolved = resolveReviewScope(f.thread, { kind: 'thread' })!
    expect(resolved.range).toEqual({ from: { kind: 'commit', sha: f.baseSha }, to: { kind: 'worktree' } })
    expect(await paths(resolved)).toEqual(['loose.txt', 'one.txt'])
  })

  it('says the changes are no longer available when a recorded commit is gone', async () => {
    await actions.runCheckpointedAction(actionOptions(cwd, turnId(1)), edit('one.txt', '1\n'))
    actions.replace(actions.list().map((action) => ({ ...action, endSha: 'f'.repeat(40) })))
    expect(resolveReviewScope(f.thread, turn(1))).toMatchObject({ unavailable: 'Changes no longer available: the turn was undone or its checkpoint expired' })
    actions.replace(actions.list().map((action) => ({ ...action, startSha: 'e'.repeat(40) })))
    expect(resolveReviewScope(f.thread, turn(1))!.unavailable).toMatch(/no longer available/)
  })

  it('returns null for a thread without a ready workspace', async () => {
    const other = gitFoundationFixture()
    try {
      expect(resolveReviewScope(other.thread, { kind: 'thread' })).toBeNull()
      expect(resolveReviewScope(other.thread, turn(1))).toBeNull()
    } finally {
      other.dispose()
    }
  })
})
