/**
 * Switching conversation branches is one three-way merge, worked out before anything is written: from the files as last
 * recorded on the branch being left, onto the files now, towards the selected branch's code. The person's edits made
 * since come along, an overlapping edit refuses the switch with nothing changed, the thread's first branch can be
 * switched back to, and a switch that stopped partway is proven from the files or cancelled, never replayed.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { restoreFileCommand } from '../src/mms/actions/restoreCommands'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { restoreChangeAsync, takeSnapshotAsync } from '../src/mms/actions/snapshots'
import { files as disk } from '../src/mms/actions/steps'
import { UndoService } from '../src/mms/actions/UndoService'
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
/** The line a switch gives for a file it takes out of the folder, with the command that brings it back. */
const leftBehind = (file: string, target: string, left: string, ref: string) =>
  `${file} is now as it was on ${target}. Your version stays on ${left}: switch back to it, or bring it back by running this in ${git(cwd, 'rev-parse', '--show-toplevel')}: ${restoreFileCommand(ref, file, { shell: 'posix', normalized: true })}`
/** Runs the command a switch's line gives for a file, in a shell, in the folder it names. */
const runShown = (notice: string | undefined) => {
  const match = /running this in (.+?): (\(set -C && git cat-file .+? \S+\))(?:\.$| \(kept for |; )/.exec(notice ?? '')
  if (!match) throw new Error(`No command in: ${notice}`)
  execFileSync('sh', ['-c', match[2]!], { cwd: match[1]! })
}
const gitState = () => ({
  head: git(cwd, 'rev-parse', 'HEAD'),
  branch: git(cwd, 'symbolic-ref', '-q', 'HEAD'),
  branches: git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
  index: git(cwd, 'ls-files', '--stage')
})
const tryGitOk = (...args: string[]) => spawnSync('git', args, { cwd }).status === 0
const gitBytes = (object: string) => execFileSync('git', ['cat-file', 'blob', object], { cwd })
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

describe('switching conversation branches', { timeout: 60_000 }, () => {
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
    // The branch left keeps its own code under its ref, without the edit that came along; the files as they were are
    // pinned by the outside-changes record, and restoring the edit from there gives the same bytes.
    expect(git(cwd, 'show', 'refs/mousse/threads/task/main:agent.txt')).toBe('second turn')
    expect(tryGitOk('cat-file', '-e', 'refs/mousse/threads/task/main:NOTES.txt')).toBe(false)
    const outside = actions.list().find((item) => item.turnId.startsWith('user-changes:'))!
    const pinned = new ChangeReceiptService(f.thread).list().find((receipt) => receipt.id === outside.receiptId)!.retainedRefs[1]!
    expect(gitBytes(`${pinned}:NOTES.txt`)).toEqual(Buffer.from('WIP2 edit before fork\n'))

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

describe('a switch that stopped after its intent was recorded', { timeout: 60_000 }, () => {
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

  it('is finished when an unrelated file appeared meanwhile, which stays as it is', async () => {
    const older = await forkedWithEdit()
    await stoppedAfterFiles(older)
    write('surprise.txt', 'x\n')
    await service.recoverPending(cwd, () => undefined)
    expect(latestSwitch()?.state).toBe('completed')
    expect(workspace().conversationBranchId).toBe(older.id)
    expect(read('surprise.txt')).toBe('x\n')
  })

  it('stays pending for a person when only some of the files it writes are as planned', async () => {
    const { action } = await turn('first', () => { write('agent.txt', 'first turn\n'); write('other.txt', 'first other\n') })
    await turn('second', () => { write('agent.txt', 'second turn\n'); write('other.txt', 'second other\n') }, 2)
    const older = await service.fork(cwd, 'main', action.id, 'Older')
    await stoppedAfterFiles(older)
    // As if the stop had come halfway: one file was written, the other was not.
    write('other.txt', 'second other\n')
    await expect(service.recoverPending(cwd, () => undefined)).rejects.toThrow(/neither the state before nor the state after/)
    expect(latestSwitch()?.state).toBe('prepared')
    expect(read('agent.txt')).toBe('first turn\n')
    expect(read('other.txt')).toBe('second other\n')
  })

  it('is finished when the switch wrote a file that is ignored now, which a snapshot can not see', async () => {
    const { action } = await turn('first', () => { write('out/result.txt', 'from the turn\n'); write('agent.txt', 'first\n') })
    await turn('second', () => { rmSync(join(cwd, 'out'), { recursive: true }); write('agent.txt', 'second\n') }, 2)
    const exclude = git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude')
    mkdirSync(dirname(exclude), { recursive: true }); appendFileSync(exclude, 'out/\n')
    const older = await service.fork(cwd, 'main', action.id, 'Older')
    await stoppedAfterFiles(older)
    expect(read('out/result.txt')).toBe('from the turn\n')
    await service.recoverPending(cwd, () => undefined)
    expect(latestSwitch()?.state).toBe('completed')
    expect(workspace().conversationBranchId).toBe(older.id)
    expect(read('agent.txt')).toBe('first\n')
  })
})

describe('a file saved while the switch writes', { timeout: 60_000 }, () => {
  it('settles the switch as not done, names the file, and leaves nothing pending', async () => {
    const { action } = await turn('first', () => write('agent.txt', 'first\n'))
    await turn('second', () => write('agent.txt', 'second\n'), 2)
    const older = await service.fork(cwd, 'main', action.id, 'Older')
    const original = ThreadJournal.prototype.append
    // The person's editor saves the file right after the intent is recorded, before the files are written.
    const append = vi.spyOn(ThreadJournal.prototype, 'append').mockImplementation(function (this: ThreadJournal, entry: Parameters<ThreadJournal['append']>[0]) {
      const recorded = original.call(this, entry)
      if (entry.operationType === 'conversation-activate' && entry.state === 'prepared') write('agent.txt', 'saved by the editor\n')
      return recorded
    })
    const refusal = await pressed('Switch conversation branch', () => service.activate(cwd, older.id)).catch((error: unknown) => error)
    append.mockRestore()
    expect(refusal).toMatchObject({ code: 'restore_conflict', details: { files: ['agent.txt'] } })
    expect((refusal as Error).message).toBe('agent.txt changed while switching to Older. Nothing was changed. Try the switch again.')
    expect(read('agent.txt')).toBe('saved by the editor\n')
    expect(latestSwitch()?.state).toBe('cancelled')
    expect(workspace().conversationBranchId).toBe('main')
    expect(() => new ChangeReceiptService(f.thread).assertNoPendingOperation()).not.toThrow()
    await service.recoverPending(cwd, () => undefined)
    // The next turn runs, and the switch can be asked for again. The turn recorded the saved edit as Main's, so the
    // switch takes it out of the folder and says where it stays.
    await turn('third', () => write('x.txt', 'x\n'), 4)
    const { notice } = await pressed('Switch conversation branch', () => service.activate(cwd, older.id))
    expect(read('agent.txt')).toBe('first\n')
    expect(notice).toBe(`${leftBehind('agent.txt', 'Older', 'Main', 'refs/mousse/threads/task/main')}.`)
  })
})

describe('edits brought along across several switches', { timeout: 60_000 }, () => {
  const sw = (id: string) => pressed('Switch conversation branch', () => service.activate(cwd, id))
  /** Three turns on the first branch, and forks A (first turn), B (second) and C (third). */
  async function threeForks() {
    const { action: one } = await turn('first', () => { write('agent.txt', 'one\n'); write('shared.txt', 'a\nb\nc\n') })
    const { action: two } = await turn('second', () => write('agent.txt', 'two\n'), 2)
    const { action: three } = await turn('third', () => write('agent.txt', 'three\n'), 4)
    const a = await service.fork(cwd, 'main', one.id, 'A')
    const b = await service.fork(cwd, 'main', two.id, 'B')
    const c = await service.fork(cwd, 'main', three.id, 'C')
    return { a, b, c }
  }
  /** No branch but the active one holds the edit; the active one's ref is its latest snapshot, the files as they are. */
  const refsHoldNoEdit = (branches: ConversationBranch[]) => {
    for (const branch of branches.filter((item) => item.lifecycle !== 'active')) expect(tryGitOk('cat-file', '-e', `${branch.retainedRef}:NOTES.txt`)).toBe(false)
  }

  it('main → A → B → A → C → main keeps the edit on disk at every step, and no branch left holds it', async () => {
    const { a, b, c } = await threeForks()
    write('NOTES.txt', 'unique personal WIP\n')
    const before = gitState()
    for (const [branch, agent] of [[a, 'one'], [b, 'two'], [a, 'one'], [c, 'three'], [service.list().find((item) => item.id === 'main')!, 'three']] as const) {
      const { notice } = await sw(branch.id)
      expect(read('NOTES.txt')).toBe('unique personal WIP\n')
      expect(read('agent.txt')).toBe(`${agent}\n`)
      expect(notice).toBeUndefined()
      // The latest snapshot describes the files as they are.
      expect(git(cwd, 'show', `${workspace().snapshotSha}:NOTES.txt`)).toBe('unique personal WIP')
      refsHoldNoEdit(service.list())
    }
    expect(gitState()).toEqual(before)
  })

  it('a line edit in a shared file appears exactly once through main → A → B → main → A → B', async () => {
    const { a, b } = await threeForks()
    write('shared.txt', 'a\nb\nPERSON\nc\n')
    for (const id of [a.id, b.id, 'main', a.id, b.id]) {
      await sw(id)
      expect(read('shared.txt')).toBe('a\nb\nPERSON\nc\n')
    }
  })

  it('an edit extended on the way is never locked out: retyping it, or adding to it, still switches everywhere', async () => {
    const { a, b } = await threeForks()
    write('NOTES.txt', 'line 1\n')
    await sw(a.id)
    write('NOTES.txt', 'line 1\nline 2\n')
    await sw('main')
    expect(read('NOTES.txt')).toBe('line 1\nline 2\n')
    await sw(a.id); await sw(b.id)
    write('NOTES.txt', 'line 1\nline 2\nline 3\n')
    await sw(a.id); await sw('main')
    expect(read('NOTES.txt')).toBe('line 1\nline 2\nline 3\n')
    expect(read('agent.txt')).toBe('three\n')
    refsHoldNoEdit(service.list())
  })

  it('an edit made on a fork comes along to the next branch', async () => {
    const { a, b } = await threeForks()
    await sw(a.id)
    write('NOTES.txt', 'made on A\n')
    await sw(b.id)
    expect(read('NOTES.txt')).toBe('made on A\n')
    expect(read('agent.txt')).toBe('two\n')
  })

  it('an edit a turn recorded into the branch stays with it, and the switch says so with where to get it back', async () => {
    const { action } = await turn('first', () => write('agent.txt', 'first turn\n'))
    write('value.txt', 'the person\'s edit\n')
    // The next turn records the edit as Main's before it runs.
    await turn('second', () => write('agent.txt', 'second turn\n'), 2)
    const older = await service.fork(cwd, 'main', action.id, 'Older')
    const { notice } = await sw(older.id)
    expect(read('value.txt')).toBe('base\n')
    expect(notice).toBe(`${leftBehind('value.txt', 'Older', 'Main', 'refs/mousse/threads/task/main')}.`)
    runShown(notice)
    expect(read('value.txt')).toBe('the person\'s edit\n')
  })

  it('an edit brought along and then recorded by a turn on the fork stays with the fork, and the switch names it', async () => {
    const { a, b } = await threeForks()
    write('NOTES.txt', 'unique personal WIP\n')
    await sw(a.id)
    await turn('on-a', () => write('a-only.txt', 'A work\n'), 2, a.id)
    const { notice } = await sw(b.id)
    expect(existsSync(join(cwd, 'NOTES.txt'))).toBe(false)
    expect(existsSync(join(cwd, 'a-only.txt'))).toBe(false)
    expect(notice).toBe(`${leftBehind('NOTES.txt', 'B', 'A', a.retainedRef)}.`)
    await sw(a.id)
    expect(read('NOTES.txt')).toBe('unique personal WIP\n')
    expect(read('a-only.txt')).toBe('A work\n')
  })

  it('switching leaves the raw index file, HEAD and the branches byte-identical, staged changes included', async () => {
    const { a, b } = await threeForks()
    write('value.txt', 'staged bytes\n'); git(cwd, 'add', 'value.txt'); write('value.txt', 'working bytes\n')
    const index = git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
    const state = () => ({ index: readFileSync(index), ...gitState() })
    const before = state()
    for (const id of [a.id, b.id, 'main']) {
      await sw(id)
      expect(state()).toEqual(before)
      expect(read('value.txt')).toBe('working bytes\n')
    }
  })

  it('in a project-folder thread too: main → A → B keeps the edit', async () => {
    rmSync(f.thread, { recursive: true, force: true }); mkdirSync(f.thread)
    const folder = await new ThreadWorkspaceManager(f.thread).ensureProjectFolder('task', 'main', f.repo)
    cwd = folder!.worktreePath
    actions = new ThreadActionService(f.thread); service = new ConversationBranchService(f.thread)
    const { a, b } = await threeForks()
    write('NOTES.txt', 'unique personal WIP\n')
    await sw(a.id); await sw(b.id)
    expect(read('NOTES.txt')).toBe('unique personal WIP\n')
    expect(read('agent.txt')).toBe('two\n')
    await sw('main')
    expect(read('NOTES.txt')).toBe('unique personal WIP\n')
    expect(read('agent.txt')).toBe('three\n')
  })
})

describe('what a switch keeps, and what it says', { timeout: 60_000 }, () => {
  const sw = (id: string) => pressed('Switch conversation branch', () => service.activate(cwd, id))
  /** Two turns on the first branch, and forks A and B at the first. */
  async function twoForks() {
    const { action } = await turn('first', () => write('agent.txt', 'one\n'))
    await turn('second', () => write('agent.txt', 'two\n'), 2)
    return { a: await service.fork(cwd, 'main', action.id, 'A'), b: await service.fork(cwd, 'main', action.id, 'B') }
  }
  /** Saves `path` with `value` right after the switch records its intent, before it writes the files. */
  const saveDuringSwitch = (path: string, value: string, touch = false) => {
    const original = ThreadJournal.prototype.append
    return vi.spyOn(ThreadJournal.prototype, 'append').mockImplementation(function (this: ThreadJournal, entry: Parameters<ThreadJournal['append']>[0]) {
      const recorded = original.call(this, entry)
      if (entry.operationType === 'conversation-activate' && entry.state === 'prepared') {
        write(path, value)
        if (touch) utimesSync(join(cwd, path), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
      }
      return recorded
    })
  }

  it('a rebuilt worktree has the edits that came along, and the next turn records none of them as deleted', async () => {
    const { a } = await twoForks()
    write('NOTES.txt', 'carried\n')
    await sw(a.id)
    git(f.repo, 'worktree', 'remove', '--force', cwd)
    expect(existsSync(cwd)).toBe(false)
    const restored = await new ThreadWorkspaceManager(f.thread).restore(f.repo)
    expect(restored.lifecycle).toBe('ready')
    expect(read('NOTES.txt')).toBe('carried\n')
    expect(read('agent.txt')).toBe('one\n')
    await turn('on-a', () => write('x.txt', 'x\n'), 2, a.id)
    expect(actions.list().filter((item) => item.conversationBranchId === a.id && item.turnId.startsWith('user-changes:'))).toEqual([])
  })

  it('turns on a fork that put the files back as they arrived still made the edit the fork\'s own', async () => {
    const { a, b } = await twoForks()
    write('NOTES.txt', 'E\n')
    await sw(a.id)
    await turn('a-edit', () => write('NOTES.txt', 'E extended by A\n'), 2, a.id)
    await turn('a-revise', () => write('NOTES.txt', 'E\n'), 4, a.id)
    const { notice } = await sw(b.id)
    expect(existsSync(join(cwd, 'NOTES.txt'))).toBe(false)
    expect(notice).toContain('NOTES.txt is now as it was on B. Your version stays on A')
    expect(git(cwd, 'show', `${a.retainedRef}:NOTES.txt`)).toBe('E')
    await turn('b-work', () => write('B.txt', 'B work\n'), 2, b.id)
    await sw(a.id)
    expect(read('NOTES.txt')).toBe('E\n')
  })

  it('an Undo on a fork back to the files it arrived with still counts as a record of the edit', async () => {
    const { a, b } = await twoForks()
    write('NOTES.txt', 'E\n')
    await sw(a.id)
    await turn('a-work', () => write('A.txt', 'A work\n'), 2, a.id)
    await pressed('Undo', () => new UndoService(f.thread).undoLatest(a.id, cwd))
    await sw(b.id)
    expect(existsSync(join(cwd, 'NOTES.txt'))).toBe(false)
    await sw(a.id)
    expect(read('NOTES.txt')).toBe('E\n')
  })

  it('a switch cancelled by a save, then asked for again, still brings the person\'s edit along', async () => {
    const { a } = await twoForks()
    write('NOTES.txt', 'person WIP\n')
    // The save writes A's own bytes, so the retry merges it cleanly.
    const save = saveDuringSwitch('agent.txt', 'one\n')
    await expect(sw(a.id)).rejects.toMatchObject({ code: 'restore_conflict', details: { files: ['agent.txt'] } })
    save.mockRestore()
    expect(latestSwitch()?.state).toBe('cancelled')
    await sw(a.id)
    expect(read('NOTES.txt')).toBe('person WIP\n')
    expect(read('agent.txt')).toBe('one\n')
  })

  it('a save that keeps the same bytes does not stop the switch', async () => {
    const { a } = await twoForks()
    const save = saveDuringSwitch('agent.txt', 'two\n', true)
    await sw(a.id)
    save.mockRestore()
    expect(read('agent.txt')).toBe('one\n')
    expect(latestSwitch()?.state).toBe('completed')
  })

  it('a turn on the fork that edited the edit that came along is named when the switch takes it out', async () => {
    const { a, b } = await twoForks()
    write('NOTES.txt', 'person line\n')
    await sw(a.id)
    await turn('on-a', () => write('NOTES.txt', 'person line\nagent line\n'), 2, a.id)
    const { notice } = await sw(b.id)
    expect(existsSync(join(cwd, 'NOTES.txt'))).toBe(false)
    expect(notice).toBe(`${leftBehind('NOTES.txt', 'B', 'A', a.retainedRef)}.`)
    runShown(notice)
    expect(read('NOTES.txt')).toBe('person line\nagent line\n')
  })

  it('the restore command in the notice brings back the file exactly as it was, a newer edit in it included', async () => {
    const original = 'alpha\nunchanged one\nunchanged two\nunchanged three\nomega\n'
    const recorded = 'PERSON RECORDED\nunchanged one\nunchanged two\nunchanged three\nomega\n'
    const before = 'PERSON RECORDED\nunchanged one\nunchanged two\nunchanged three\nPERSON LATEST\n'
    const { action } = await turn('first', () => write('value.txt', original))
    write('value.txt', recorded)
    await turn('second', () => write('agent.txt', 'second\n'), 2)
    const a = await service.fork(cwd, 'main', action.id, 'A')
    write('value.txt', before)
    const { notice } = await sw(a.id)
    // The newer line came along; the recorded one is A's now.
    expect(read('value.txt')).toBe('alpha\nunchanged one\nunchanged two\nunchanged three\nPERSON LATEST\n')
    expect(notice).toMatch(/: \(set -C && git cat-file --filters refs\/mousse\/\S+:value\.txt > \.\/value\.txt\.mousse-[0-9a-f]{8} && rm -f \.\/value\.txt && mv \.\/value\.txt\.mousse-[0-9a-f]{8} \.\/value\.txt\) \(kept for .+\)\.$/)
    write('value.txt', 'overwritten\n')
    runShown(notice)
    expect(readFileSync(join(cwd, 'value.txt'))).toEqual(Buffer.from(before))
  })
})

describe.skipIf(process.platform === 'win32')('what a switch notice\'s command makes again', { timeout: 60_000 }, () => {
  const sw = (id: string) => pressed('Switch conversation branch', () => service.activate(cwd, id))
  it('an executable file comes back executable, as the branch has it', async () => {
    const original = '#!/bin/sh\necho one\nunchanged a\nunchanged b\nunchanged c\necho end\n'
    const recorded = '#!/bin/sh\necho RECORDED\nunchanged a\nunchanged b\nunchanged c\necho end\n'
    const before = '#!/bin/sh\necho RECORDED\nunchanged a\nunchanged b\nunchanged c\necho LATEST\n'
    const { action } = await turn('first', () => { write('tool.sh', original); chmodSync(join(cwd, 'tool.sh'), 0o755) })
    write('tool.sh', recorded)
    await turn('second', () => write('agent.txt', 'second\n'), 2)
    const a = await service.fork(cwd, 'main', action.id, 'A')
    write('tool.sh', before)
    const { notice } = await sw(a.id)
    expect(notice).toContain('chmod +x ./tool.sh.mousse-')
    write('tool.sh', 'overwritten\n'); chmodSync(join(cwd, 'tool.sh'), 0o644)
    const command = /running this in (.+?): (\(.+?\))(?: \(kept for |\.$)/.exec(notice!)!
    execFileSync('sh', ['-c', command[2]!], { cwd: command[1]! })
    expect(read('tool.sh')).toBe(before)
    expect(statSync(join(cwd, 'tool.sh')).mode & 0o111).not.toBe(0)
  })
})

describe('recovery read from the files', { timeout: 60_000 }, () => {
  async function stoppedAfterFiles(target: ConversationBranch): Promise<void> {
    const settle = vi.spyOn(ConversationBranchService.prototype as unknown as { settle: () => void }, 'settle').mockImplementationOnce(() => { throw new Error('stopped') })
    await expect(pressed('Switch conversation branch', () => service.activate(cwd, target.id, undefined, () => undefined))).rejects.toThrow('stopped')
    settle.mockRestore()
    expect(latestSwitch()?.state).toBe('prepared')
  }

  it('stays pending when one file it wrote was edited by the person before recovery, and the edit stays', async () => {
    const { action } = await turn('first', () => { write('agent.txt', 'first turn\n'); write('other.txt', 'first other\n') })
    await turn('second', () => { write('agent.txt', 'second turn\n'); write('other.txt', 'second other\n') }, 2)
    const older = await service.fork(cwd, 'main', action.id, 'Older')
    await stoppedAfterFiles(older)
    write('other.txt', 'the person\'s edit\n')
    await expect(service.recoverPending(cwd, () => undefined)).rejects.toThrow(/neither the state before nor the state after/)
    expect(latestSwitch()?.state).toBe('prepared')
    expect(read('other.txt')).toBe('the person\'s edit\n')
  })

  it('finishes a switch that fully landed on a disk that keeps no executable bit', async () => {
    const { action } = await turn('first', () => write('agent.txt', 'first\n'))
    await turn('second', () => write('agent.txt', 'second\n'), 2)
    const older = await service.fork(cwd, 'main', action.id, 'Older')
    await stoppedAfterFiles(older)
    // FAT and exFAT read every file as executable, and Git sets core.fileMode false there.
    git(cwd, 'config', 'core.fileMode', 'false')
    const lstat = disk.lstat
    vi.spyOn(disk, 'lstat').mockImplementation(function* (path: string) {
      const stat = yield* lstat(path)
      if (stat.isFile()) Object.defineProperty(stat, 'mode', { value: stat.mode | 0o111 })
      return stat
    } as typeof disk.lstat)
    await service.recoverPending(cwd, () => undefined)
    expect(latestSwitch()?.state).toBe('completed')
    expect(workspace().conversationBranchId).toBe(older.id)
  })
})
