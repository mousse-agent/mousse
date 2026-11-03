/**
 * Switching conversation branches is one three-way merge, worked out before anything is written: from the files as last
 * recorded on the branch being left, onto the files now, towards the selected branch's code. The person's edits made
 * since come along, an overlapping edit refuses the switch with nothing changed, the thread's first branch can be
 * switched back to, and a switch that stopped partway is proven from the files or cancelled, never replayed.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { restoreChangeAsync, takeSnapshotAsync, worktreeTreeAsync } from '../src/mms/actions/snapshots'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { ConversationBranch } from '../src/shared/threadActions'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

let f: ReturnType<typeof gitFoundationFixture>
let cwd: string
let actions: ThreadActionService
let service: ConversationBranchService
beforeEach(async () => {
  f = gitFoundationFixture()
  cwd = (await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)).worktreePath
  actions = new ThreadActionService(f.thread)
  service = new ConversationBranchService(f.thread)
})
afterEach(() => { vi.restoreAllMocks(); f.dispose() })

const write = (path: string, value: string) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), value) }
const read = (path: string) => readFileSync(join(cwd, path), 'utf8')
const turn = (id: string, mutate: () => void, start = 0, conversationBranchId = 'main') =>
  actions.runCheckpointedAction({ ...actionOptions(cwd, id), conversationBranchId, presentationMessageStart: start, presentationMessageEnd: start + 2 }, mutate)
/** HEAD, the branch it is on, every branch and the real index, byte for byte. */
const gitState = () => ({
  head: git(cwd, 'rev-parse', 'HEAD'),
  branch: git(cwd, 'symbolic-ref', '-q', 'HEAD'),
  branches: git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
  index: git(cwd, 'ls-files', '--stage')
})
const allRefs = () => git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)')
const workspace = () => new ThreadWorkspaceManager(f.thread).load()!
const latestSwitch = () => [...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => entry.operationType === 'conversation-activate').at(-1)

/** Two turns on the first branch, the person's own edit, and a fork at the first turn. */
async function forkedWithEdit(): Promise<ConversationBranch> {
  const { action } = await turn('first', () => write('agent.txt', 'first turn\n'))
  await turn('second', () => write('agent.txt', 'second turn\n'), 2)
  write('NOTES.txt', 'WIP2 edit before fork\n')
  return pressed('Fork', () => service.fork(cwd, 'main', action.id, 'Older'))
}

describe('switching conversation branches', () => {
  it('keeps the person’s edit on disk, and switches back to the first branch exactly, without touching HEAD, the index or branches', async () => {
    const before = gitState()
    const older = await forkedWithEdit()
    // The first fork writes a real record for the branch the thread started on.
    const first = service.list().find((branch) => branch.id === 'main')
    expect(first).toMatchObject({ id: 'main', name: 'Main', retainedRef: 'refs/mousse/threads/task/main', creationReason: 'initial', lifecycle: 'active' })
    expect(first!.contextBoundary).toEqual(actions.latest('main')!.nativeContextBoundary)

    const switched = await pressed('Switch conversation branch', () => service.activate(cwd, older.id))
    expect(switched.branch.id).toBe(older.id)
    expect(read('agent.txt')).toBe('first turn\n')
    expect(read('NOTES.txt')).toBe('WIP2 edit before fork\n')
    expect(workspace().conversationBranchId).toBe(older.id)
    expect(service.list().map((branch) => [branch.id, branch.lifecycle])).toEqual([['main', 'inactive'], [older.id, 'active']])
    // The branch left keeps the files as they were, the person's edit included: restored from its ref, the bytes match.
    expect(git(cwd, 'show', 'refs/mousse/threads/task/main:NOTES.txt')).toBe('WIP2 edit before fork')
    expect(git(cwd, 'show', 'refs/mousse/threads/task/main:agent.txt')).toBe('second turn')

    await pressed('Switch conversation branch', () => service.activate(cwd, 'main'))
    expect(read('agent.txt')).toBe('second turn\n')
    expect(read('NOTES.txt')).toBe('WIP2 edit before fork\n')
    expect(workspace()).toMatchObject({ conversationBranchId: 'main', retainedRef: 'refs/mousse/threads/task/main' })
    expect(service.list().map((branch) => [branch.id, branch.lifecycle])).toEqual([['main', 'active'], [older.id, 'inactive']])
    expect(gitState()).toEqual(before)
    // A turn on the first branch after coming back records only its own work.
    const { action } = await turn('third', () => write('agent.txt', 'third turn\n'), 4)
    expect(action.changedPaths.map((change) => change.path)).toEqual(['agent.txt'])
    expect(gitState()).toEqual(before)
  })

  it('refuses an edit that overlaps with the selected branch, names the file and the branch it stays on, and changes nothing', async () => {
    const older = await forkedWithEdit()
    write('agent.txt', 'edited by the person\n')
    const files = { agent: read('agent.txt'), notes: read('NOTES.txt') }
    const refs = allRefs()
    const state = gitState()
    const branches = service.list()
    const metadata = workspace()
    const recorded = actions.list()

    const refusal = await pressed('Switch conversation branch', () => service.activate(cwd, older.id)).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'restore_conflict', details: { files: ['agent.txt'] } })
    expect((refusal as Error).message).toBe('Switching to Older would overwrite your edits in: agent.txt. They stay on Main. Nothing was changed.')
    expect({ agent: read('agent.txt'), notes: read('NOTES.txt') }).toEqual(files)
    expect(allRefs()).toBe(refs)
    expect(gitState()).toEqual(state)
    expect(service.list()).toEqual(branches)
    expect(workspace()).toEqual(metadata)
    expect(actions.list()).toEqual(recorded)
    expect(latestSwitch()?.state).toBe('failed')
    expect(() => new ChangeReceiptService(f.thread).assertNoPendingOperation()).not.toThrow()
  })

  it('names what it kept when a file no snapshot held was in the way, and the kept copy restores the same bytes', async () => {
    const { action } = await turn('first', () => write('out/result.txt', 'from the turn\n'))
    await turn('second', () => rmSync(join(cwd, 'out'), { recursive: true }), 2)
    const exclude = git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude')
    mkdirSync(dirname(exclude), { recursive: true }); appendFileSync(exclude, 'out/\n')
    write('out/result.txt', 'the person\'s ignored file\n')
    const older = await service.fork(cwd, 'main', action.id, 'Older')

    const { notice } = await pressed('Switch conversation branch', () => service.activate(cwd, older.id))
    expect(read('out/result.txt')).toBe('from the turn\n')
    const ref = /kept under (refs\/mousse\/preserved\/\S+) for/.exec(notice ?? '')?.[1]
    expect(notice).toContain('out/result.txt')
    expect(ref).toBeDefined()
    git(cwd, 'restore', `--source=${ref}`, '--', 'out/result.txt')
    expect(read('out/result.txt')).toBe('the person\'s ignored file\n')
  })

  it('refuses an unknown branch, and a first branch a thread left before it had a record, with a typed error before anything is written', async () => {
    const older = await forkedWithEdit()
    const journal = new ThreadJournal(f.thread).list().length
    await expect(service.activate(cwd, 'no-such-branch')).rejects.toMatchObject({ code: 'conversation_branch_unavailable' })
    expect(new ThreadJournal(f.thread).list()).toHaveLength(journal)

    await pressed('Switch conversation branch', () => service.activate(cwd, older.id))
    // A thread forked and switched before first branches had records: no record of `main` is made up for it.
    const path = join(f.thread, 'conversation-branches.json')
    writeFileSync(path, JSON.stringify(service.list().filter((branch) => branch.id !== 'main')))
    const files = read('agent.txt')
    expect(service.available('main')).toBeUndefined()
    await expect(service.activate(cwd, 'main')).rejects.toMatchObject({ code: 'conversation_branch_unavailable' })
    expect(read('agent.txt')).toBe(files)
    expect(service.list().some((branch) => branch.id === 'main')).toBe(false)
  })

  it('writes the first branch’s record when a thread forked before records existed leaves it', async () => {
    const older = await forkedWithEdit()
    const path = join(f.thread, 'conversation-branches.json')
    writeFileSync(path, JSON.stringify(service.list().filter((branch) => branch.id !== 'main')))
    // Still on the first branch: switching away records it as it is, so it can be switched back to.
    await pressed('Switch conversation branch', () => service.activate(cwd, older.id))
    expect(service.list().find((branch) => branch.id === 'main')).toMatchObject({ lifecycle: 'inactive', creationReason: 'initial' })
    await pressed('Switch conversation branch', () => service.activate(cwd, 'main'))
    expect(read('agent.txt')).toBe('second turn\n')
  })
})

describe('a switch that stopped after its intent was recorded', () => {
  /** Stops a switch right after the files were written, before the switch was recorded as done. */
  async function stoppedAfterFiles(target: ConversationBranch): Promise<void> {
    const settle = vi.spyOn(ConversationBranchService.prototype as unknown as { settle: () => void }, 'settle').mockImplementationOnce(() => { throw new Error('stopped') })
    await expect(pressed('Switch conversation branch', () => service.activate(cwd, target.id, undefined, () => undefined))).rejects.toThrow('stopped')
    settle.mockRestore()
    expect(latestSwitch()?.state).toBe('prepared')
    expect(() => new ChangeReceiptService(f.thread).assertNoPendingOperation()).toThrow(/recovery required/)
  }

  it('is finished from the files when they match the planned result', async () => {
    const older = await forkedWithEdit()
    await stoppedAfterFiles(older)
    expect(read('agent.txt')).toBe('first turn\n')
    expect(workspace().conversationBranchId).toBe('main')
    const restored: string[] = []
    await service.recoverPending(cwd, (branch) => { restored.push(branch.id) })
    expect(restored).toEqual([older.id])
    expect(latestSwitch()?.state).toBe('completed')
    expect(workspace().conversationBranchId).toBe(older.id)
    expect(service.list().find((branch) => branch.id === older.id)?.lifecycle).toBe('active')
    expect(read('NOTES.txt')).toBe('WIP2 edit before fork\n')
    expect(() => new ChangeReceiptService(f.thread).assertNoPendingOperation()).not.toThrow()
  })

  it('is cancelled when the files still match the state before it, and never replayed', async () => {
    const older = await forkedWithEdit()
    await stoppedAfterFiles(older)
    const intent = latestSwitch()!.details as { ours: string }
    // As if the stop had come before the files changed: they are put back as they were.
    const now = await takeSnapshotAsync(cwd, { reason: 'test' })
    await restoreChangeAsync(cwd, { reason: 'test', base: now.sha, ours: now.sha, theirs: intent.ours })
    expect(read('agent.txt')).toBe('second turn\n')
    const restored: string[] = []
    await service.recoverPending(cwd, (branch) => { restored.push(branch.id) })
    expect(restored).toEqual([])
    expect(latestSwitch()?.state).toBe('cancelled')
    expect(read('agent.txt')).toBe('second turn\n')
    expect(read('NOTES.txt')).toBe('WIP2 edit before fork\n')
    expect(workspace().conversationBranchId).toBe('main')
    expect(service.list().find((branch) => branch.id === older.id)?.lifecycle).toBe('inactive')
    // Nothing waits any more, and the switch can be asked for again.
    await pressed('Switch conversation branch', () => service.activate(cwd, older.id))
    expect(read('agent.txt')).toBe('first turn\n')
  })

  it('stays pending for a person when the files match neither state', async () => {
    const older = await forkedWithEdit()
    await stoppedAfterFiles(older)
    write('surprise.txt', 'x\n')
    const tree = await worktreeTreeAsync(cwd)
    await expect(service.recoverPending(cwd, () => undefined)).rejects.toThrow(/neither the state before nor the state after/)
    expect(latestSwitch()?.state).toBe('prepared')
    expect(await worktreeTreeAsync(cwd)).toBe(tree)
    expect(existsSync(join(cwd, 'surprise.txt'))).toBe(true)
  })
})
