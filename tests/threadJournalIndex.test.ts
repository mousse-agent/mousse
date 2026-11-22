/**
 * A thread journal's records, its per-operation and per-type lookups, its receipts and its open operations come without
 * reparsing its history, and still give what a full read gives when another process writes to the same folder. A turn
 * on a long thread reads only the records written since the last turn, and `actions.json` only when it changed.
 */
import * as fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationActionService } from '../src/mms/actions/ConversationActionService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ThreadJournal, type ThreadJournalRecord } from '../src/mms/data/ThreadJournal'
import { acquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { threadRecovery } from '../src/mms/workspace/workspaceRecovery'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { ChangeReceipt, NativeContextBoundary, ThreadAction } from '../src/shared/threadActions'

vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync), openSync: vi.fn(actual.openSync) }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function thread(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mousse-journal-index-')); roots.push(directory)
  return directory
}
const name = (sequence: number) => `${String(sequence).padStart(16, '0')}.json`
/** What another process leaves in the folder: a whole record under its own sequence. */
function outside(directory: string, sequence: number, operationId: string, state: ThreadJournalRecord['state'] = 'running', operationType = 'fixture', details?: unknown): void {
  mkdirSync(join(directory, 'journal'), { recursive: true })
  writeFileSync(join(directory, 'journal', name(sequence)), JSON.stringify({ schemaVersion: 1, sequence, operationId, operationType, state, createdAt: '2026-01-01T00:00:00.000Z', ...(details ? { details } : {}) }))
}
const receipt = (id: string, operationId: string, generation: number) => ({ id, operationId, generation, kind: 'checkpoint', workspaceId: 'w', actor: { kind: 'main' }, beforeSha: 'a', afterSha: 'b', introducedCommits: [], contributions: [], retainedRefs: [], externalEffects: [], createdAt: '2026-01-01T00:00:00.000Z' })
/** The reference: every record file read in name order, as the journal did before it kept an index. */
function diskRecords(directory: string): ThreadJournalRecord[] {
  let names: string[]
  try { names = readdirSync(join(directory, 'journal')).filter((item) => /^\d{16}\.json$/.test(item)).sort() } catch { return [] }
  return names.map((item) => JSON.parse(readFileSync(join(directory, 'journal', item), 'utf8')) as ThreadJournalRecord)
}
function fullRead(directory: string): [string, ThreadJournalRecord][] {
  const latest = new Map<string, ThreadJournalRecord>()
  for (const record of diskRecords(directory)) latest.set(record.operationId, record)
  return [...latest.entries()]
}
/** `ChangeReceiptService.list` as it was: each receipt by id, the latest record winning, in first-seen order. */
function diskReceipts(directory: string): ChangeReceipt[] {
  const receipts = new Map<string, ChangeReceipt>()
  for (const record of diskRecords(directory)) {
    const found = (record.details as { receipt?: ChangeReceipt } | undefined)?.receipt
    if (found?.id) receipts.set(found.id, found)
  }
  return [...receipts.values()]
}
const journalReads = () => vi.mocked(fs.readFileSync).mock.calls.filter(([path]) => String(path).includes(`${sep}journal${sep}`)).length

// The inputs: who writes (this journal, another process), what happens to the folder (missing, gap, removed record,
// replaced folder, a record still being written), the order an operation's records arrive in, and receipts (a new
// one, the same id recorded again).
const rows: { case: string; act: (directory: string, journal: ThreadJournal) => void }[] = [
  { case: 'no journal folder yet', act: () => undefined },
  { case: 'appends through this journal', act: (_, journal) => { journal.append({ operationId: 'a', operationType: 'fixture', state: 'running' }); journal.append({ operationId: 'b', operationType: 'fixture', state: 'running' }) } },
  { case: 'an operation settles later and keeps its first place', act: (directory, journal) => { outside(directory, 3, 'a', 'completed'); journal.append({ operationId: 'c', operationType: 'fixture', state: 'prepared' }) } },
  { case: 'another process appends after the index was read', act: (directory) => outside(directory, 5, 'd') },
  { case: 'a receipt from this journal and one from another process', act: (directory, journal) => { journal.append({ operationId: 'r1', operationType: 'change-checkpoint', state: 'git_applied', details: { receipt: receipt('R1', 'r1', 1) } }); outside(directory, 7, 'r2', 'git_applied', 'change-checkpoint', { receipt: receipt('R2', 'r2', 2) }) } },
  { case: 'the same receipt id recorded again keeps its first place with the latest value', act: (directory) => outside(directory, 8, 'r1', 'completed', 'change-checkpoint', { receipt: { ...receipt('R1', 'r1', 3), afterSha: 'c' } }) },
  { case: 'a gap in the sequence', act: (directory) => outside(directory, 9, 'e', 'completed') },
  { case: 'an earlier record is removed', act: (directory) => unlinkSync(join(directory, 'journal', name(2))) },
  { case: 'an earlier record is removed and one appended', act: (directory) => { unlinkSync(join(directory, 'journal', name(3))); outside(directory, 10, 'f') } },
  { case: 'the folder is replaced with the same names', act: (directory) => { rmSync(join(directory, 'journal'), { recursive: true }); for (const sequence of [1, 4, 5, 9, 10]) outside(directory, sequence, `new-${sequence}`, 'cancelled') } },
  { case: 'the folder is removed', act: (directory) => rmSync(join(directory, 'journal'), { recursive: true }) }
]

const TERMINAL = ['completed', 'failed', 'cancelled']

it('gives the same records, lookups, receipts and open operations, in the same order, as a full read after each change to the folder', () => {
  const directory = thread(); const journal = new ThreadJournal(directory)
  for (const row of rows) {
    row.act(directory, journal)
    const disk = diskRecords(directory)
    expect(journal.list(), row.case).toEqual(disk)
    expect([...journal.latestByOperation().entries()], row.case).toEqual(fullRead(directory))
    expect(journal.unsettled(), row.case).toEqual(fullRead(directory).map(([, record]) => record).filter((record) => !TERMINAL.includes(record.state)))
    for (const [operationId, record] of fullRead(directory)) {
      expect(journal.history(operationId), row.case).toEqual(disk.filter((item) => item.operationId === operationId))
      expect(journal.latestOf(operationId), row.case).toEqual(record)
    }
    expect(journal.ofTypes('change-checkpoint', 'fixture'), row.case).toEqual(disk)
    expect(new ChangeReceiptService(directory, { readOnly: true }).list(), row.case).toEqual(diskReceipts(directory))
    expect(journal.receiptRecords(), row.case).toEqual(disk.flatMap((record) => (record.details as { receipt?: ChangeReceipt } | undefined)?.receipt ?? []))
    expect(journal.latestSequence(), row.case).toBe(disk.length ? Math.max(...disk.map((record) => record.sequence)) : 0)
  }
})

it('a list a caller holds does not change when records are added, and its records cannot be changed', () => {
  const directory = thread(); const journal = new ThreadJournal(directory)
  outside(directory, 1, 'a')
  const held = journal.list()
  journal.append({ operationId: 'b', operationType: 'fixture', state: 'running' })
  expect(journal.list().map((record) => record.operationId)).toEqual(['a', 'b'])
  expect(held.map((record) => record.operationId)).toEqual(['a'])
  expect(() => { (held[0] as { state: string }).state = 'completed' }).toThrow(TypeError)
})

it('a record another process writes while the folder is being read is found by the next read', async () => {
  const directory = thread(); const journal = new ThreadJournal(directory)
  outside(directory, 1, 'a', 'git_applied', 'change-checkpoint', { receipt: receipt('R1', 'a', 1) })
  expect(journal.list()).toHaveLength(1)
  const { readdirSync: listed } = await vi.importActual<typeof import('node:fs')>('node:fs')
  // The other process creates sequence 2 just after this read listed the folder.
  vi.mocked(fs.readdirSync).mockImplementationOnce(((path: fs.PathLike) => {
    const names = listed(path)
    outside(directory, 2, 'b', 'git_applied', 'change-checkpoint', { receipt: receipt('R2', 'b', 2) })
    return names
  }) as typeof fs.readdirSync)
  expect(new ChangeReceiptService(directory).list().map((item) => item.id)).toEqual(['R1'])
  expect(new ChangeReceiptService(directory).list().map((item) => item.id)).toEqual(['R1', 'R2'])
  expect(journal.unsettled().map((record) => record.operationId)).toEqual(['a', 'b'])
})

it('throws on a record another process is still writing, as a full read does, and reads it once it is whole', () => {
  const directory = thread(); const journal = new ThreadJournal(directory)
  outside(directory, 1, 'a'); journal.latestByOperation()
  writeFileSync(join(directory, 'journal', name(2)), '')
  expect(() => journal.latestByOperation()).toThrow(SyntaxError)
  expect(() => journal.list()).toThrow(SyntaxError)
  expect(() => new ChangeReceiptService(directory).list()).toThrow(SyntaxError)
  expect(() => journal.unsettled()).toThrow(SyntaxError)
  // The sequence comes from the file names, so the next append does not trip over the unfinished record.
  expect(journal.append({ operationId: 'c', operationType: 'fixture', state: 'running' }).sequence).toBe(3)
  outside(directory, 2, 'b')
  expect([...journal.latestByOperation().keys()]).toEqual(['a', 'b', 'c'])
  expect(journal.list().map((record) => record.operationId)).toEqual(['a', 'b', 'c'])
  expect(journal.unsettled().map((record) => record.operationId)).toEqual(['a', 'b', 'c'])
})

it('an append that loses the race to another process takes the next free sequence', async () => {
  const directory = thread(); const journal = new ThreadJournal(directory)
  outside(directory, 1, 'a')
  const { readdirSync: listed } = await vi.importActual<typeof import('node:fs')>('node:fs')
  // The other process creates sequence 2 between this journal's guess (from the names it listed) and its exclusive create.
  vi.mocked(fs.readdirSync).mockImplementationOnce(((path: fs.PathLike) => {
    const names = listed(path)
    outside(directory, 2, 'theirs')
    return names
  }) as typeof fs.readdirSync)
  expect(journal.append({ operationId: 'ours', operationType: 'fixture', state: 'running' }).sequence).toBe(3)
  expect([...journal.latestByOperation().keys()]).toEqual(['a', 'theirs', 'ours'])
})

it('a chat turn on a long journal reads only the records written since the last turn', () => {
  const directory = thread()
  for (let sequence = 1; sequence <= 300; sequence += 1) outside(directory, sequence, `old-${Math.ceil(sequence / 3)}`, sequence % 3 ? 'prepared' : 'completed')
  const boundary = (messageIndex: number): NativeContextBoundary => ({ messageIndex, compactionGeneration: 0, fidelity: 'exact', safeBoundaryProof: 'fixture-boundary' })
  const turn = (turnId: string) => {
    const lease = acquireExecutionLease(directory, { source: 'fixture-turn' })
    try {
      const service = new ConversationActionService(directory)
      service.recover(lease, () => undefined)
      service.begin(turnId, 'main', 0, boundary(0), lease)
      service.settle(turnId, 2, boundary(2), 'completed', false, lease)
    } finally { releaseExecutionLeaseHandle(lease) }
  }
  turn('first')
  vi.mocked(fs.readFileSync).mockClear()
  turn('second')
  // The first turn's three records; before the index, each of the turn's five journal reads parsed all 303.
  expect(journalReads()).toBe(3)
  expect(fullRead(directory).filter(([, record]) => record.operationType === 'conversation-checkpoint').map(([, record]) => record.state)).toEqual(['completed', 'completed'])
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const at = (messageIndex: number): NativeContextBoundary => ({ messageIndex, compactionGeneration: 0, fidelity: 'exact', safeBoundaryProof: 'fixture-boundary' })

/** A thread whose earlier `turns` code turns are on disk as a turn leaves them: three journal records each (one with its receipt) and its action. */
function longThread(turns: number): { repo: string; directory: string } {
  const base = thread(); const repo = join(base, 'repo'); const directory = join(base, 'thread'); mkdirSync(repo); mkdirSync(directory)
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test'); git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'value.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  const head = git(repo, 'rev-parse', 'HEAD')
  const actions: ThreadAction[] = []
  for (let turn = 0, sequence = 0; turn < turns; turn += 1) {
    const id = `00000000-0000-4000-8000-${String(turn).padStart(12, '0')}`
    const action: ThreadAction = {
      id, turnId: `old-${turn}`, conversationBranchId: 'main', actor: { kind: 'main' }, presentationMessageStart: turn, presentationMessageEnd: turn + 1,
      nativeContextStartBoundary: at(turn), nativeContextBoundary: at(turn + 1), startSha: head, endSha: head, commits: [], childIntegrations: [], changedPaths: [],
      externalEffects: [], reversible: true, state: 'completed', createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', receiptId: `R-${turn}`
    }
    actions.push(action)
    outside(directory, ++sequence, id, 'running', 'action-checkpoint', { action })
    outside(directory, ++sequence, id, 'git_applied', 'change-checkpoint', { receipt: receipt(`R-${turn}`, id, turn + 1) })
    outside(directory, ++sequence, id, 'completed', 'action-checkpoint', { actionState: 'completed' })
  }
  writeFileSync(join(directory, 'actions.json'), `${JSON.stringify(actions, null, 2)}\n`)
  return { repo, directory }
}

/** A code turn as the run engine drives it, then the thread's status read as opening it does. */
async function codeTurn(repo: string, directory: string, turnId: string, start: number): Promise<void> {
  const lease = acquireExecutionLease(directory, { source: 'fixture-turn' })
  try {
    const service = new ThreadActionService(directory)
    await service.recoverPending(repo, lease)
    const { startSha, startCheck } = await service.recordOutsideChanges({ threadId: 'thread', conversationBranchId: 'main', workspacePath: repo, heldThreadLease: lease })
    const options = { threadId: 'thread', turnId, conversationBranchId: 'main', workspacePath: repo, presentationMessageStart: start, presentationMessageEnd: start, nativeContextStartBoundary: at(start), nativeContextBoundary: at(start), heldThreadLease: lease }
    service.beginTurn(options, startSha, startCheck)
    writeFileSync(join(repo, 'value.txt'), `${turnId}\n`)
    await service.checkpointExistingTurn({ ...options, presentationMessageEnd: start + 1, nativeContextBoundary: at(start + 1) }, startSha, 'completed')
  } finally { releaseExecutionLeaseHandle(lease) }
  await threadRecovery(directory, repo)
  new ThreadWorkspaceManager(directory).branchRecord()
}

const isActionsFile = (path: unknown) => typeof path === 'string' && basename(path) === 'actions.json'
/** Reads of `actions.json`: by path, or by opening it to read. */
const actionsReads = () => vi.mocked(fs.readFileSync).mock.calls.filter(([path]) => isActionsFile(path)).length
  + vi.mocked(fs.openSync).mock.calls.filter(([path, flags]) => isActionsFile(path) && (flags ?? 'r') === 'r').length
/** Writes of `actions.json`: each one creates its temporary file. */
const actionsWrites = () => vi.mocked(fs.openSync).mock.calls.filter(([path]) => /^actions\.json\..+\.tmp$/.test(basename(String(path)))).length

it('a code turn and the thread open after it read only the journal records written since, and actions.json only after it was written', async () => {
  const measure = async (turns: number) => {
    const { repo, directory } = longThread(turns)
    await codeTurn(repo, directory, 'first', turns)
    vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.openSync).mockClear()
    await codeTurn(repo, directory, 'second', turns + 1)
    const counts = { journal: journalReads(), actionsReads: actionsReads(), actionsWrites: actionsWrites() }
    expect(new ThreadActionService(directory).list().map((action) => action.turnId).slice(-2)).toEqual(['first', 'second'])
    expect(new ChangeReceiptService(directory).list()).toHaveLength(turns + 2)
    return counts
  }
  const short = await measure(10)
  const long = await measure(400)
  // The same work whatever the history: before, every whole-journal read parsed all 1,200 earlier records.
  expect(long).toEqual(short)
  // The first turn's records and the second's own; before, each turn read actions.json about twice per write.
  expect(long.journal).toBeLessThan(20)
  expect(long.actionsReads).toBeLessThanOrEqual(long.actionsWrites)
}, 60_000)
