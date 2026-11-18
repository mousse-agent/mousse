/**
 * A thread journal's latest-record index and next sequence come without reparsing its history, and still give what a
 * full read gives when another process writes to the same folder.
 */
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationActionService } from '../src/mms/actions/ConversationActionService'
import { ThreadJournal, type ThreadJournalRecord } from '../src/mms/data/ThreadJournal'
import { acquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import type { NativeContextBoundary } from '../src/shared/threadActions'

vi.mock('node:fs', async (load) => {
  const actual = await load<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync) }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function thread(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mousse-journal-index-')); roots.push(directory)
  return directory
}
const name = (sequence: number) => `${String(sequence).padStart(16, '0')}.json`
/** What another process leaves in the folder: a whole record under its own sequence. */
function outside(directory: string, sequence: number, operationId: string, state: ThreadJournalRecord['state'] = 'running'): void {
  mkdirSync(join(directory, 'journal'), { recursive: true })
  writeFileSync(join(directory, 'journal', name(sequence)), JSON.stringify({ schemaVersion: 1, sequence, operationId, operationType: 'fixture', state, createdAt: '2026-01-01T00:00:00.000Z' }))
}
/** The reference: every record read and folded in order, as the journal did before it kept an index. */
function fullRead(directory: string): [string, ThreadJournalRecord][] {
  const latest = new Map<string, ThreadJournalRecord>()
  for (const record of new ThreadJournal(directory, { readOnly: true }).list()) latest.set(record.operationId, record)
  return [...latest.entries()]
}
const journalReads = () => vi.mocked(fs.readFileSync).mock.calls.filter(([path]) => String(path).includes(`${sep}journal${sep}`)).length

// The inputs: who writes (this journal, another process), what happens to the folder (missing, gap, removed record,
// replaced folder, a record still being written), and the order an operation's records arrive in.
const rows: { case: string; act: (directory: string, journal: ThreadJournal) => void }[] = [
  { case: 'no journal folder yet', act: () => undefined },
  { case: 'appends through this journal', act: (_, journal) => { journal.append({ operationId: 'a', operationType: 'fixture', state: 'running' }); journal.append({ operationId: 'b', operationType: 'fixture', state: 'running' }) } },
  { case: 'an operation settles later and keeps its first place', act: (directory, journal) => { outside(directory, 3, 'a', 'completed'); journal.append({ operationId: 'c', operationType: 'fixture', state: 'prepared' }) } },
  { case: 'another process appends after the index was read', act: (directory) => outside(directory, 5, 'd') },
  { case: 'a gap in the sequence', act: (directory) => outside(directory, 9, 'e', 'completed') },
  { case: 'an earlier record is removed', act: (directory) => unlinkSync(join(directory, 'journal', name(2))) },
  { case: 'an earlier record is removed and one appended', act: (directory) => { unlinkSync(join(directory, 'journal', name(3))); outside(directory, 10, 'f') } },
  { case: 'the folder is replaced with the same names', act: (directory) => { rmSync(join(directory, 'journal'), { recursive: true }); for (const sequence of [1, 4, 5, 9, 10]) outside(directory, sequence, `new-${sequence}`, 'cancelled') } },
  { case: 'the folder is removed', act: (directory) => rmSync(join(directory, 'journal'), { recursive: true }) }
]

it('gives the same latest records, in the same order, as a full read after each change to the folder', () => {
  const directory = thread(); const journal = new ThreadJournal(directory)
  for (const row of rows) {
    row.act(directory, journal)
    expect([...journal.latestByOperation().entries()], row.case).toEqual(fullRead(directory))
    expect(journal.latestSequence(), row.case).toBe(fullRead(directory).length ? Math.max(...new ThreadJournal(directory, { readOnly: true }).list().map((record) => record.sequence)) : 0)
  }
})

it('throws on a record another process is still writing, as a full read does, and reads it once it is whole', () => {
  const directory = thread(); const journal = new ThreadJournal(directory)
  outside(directory, 1, 'a'); journal.latestByOperation()
  writeFileSync(join(directory, 'journal', name(2)), '')
  expect(() => journal.latestByOperation()).toThrow(SyntaxError)
  expect(() => journal.list()).toThrow(SyntaxError)
  // The sequence comes from the file names, so the next append does not trip over the unfinished record.
  expect(journal.append({ operationId: 'c', operationType: 'fixture', state: 'running' }).sequence).toBe(3)
  outside(directory, 2, 'b')
  expect([...journal.latestByOperation().keys()]).toEqual(['a', 'b', 'c'])
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
