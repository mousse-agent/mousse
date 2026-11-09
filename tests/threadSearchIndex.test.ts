import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { BLOB_TEXT_THRESHOLD } from '../src/mms/data/threadDb/threadBlobs'
import { INDEX_FILE } from '../src/mms/data/threadDb/threadIndex'
import { closeSharedThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import type { ChatMessage } from '../src/shared/types'

const homes: string[] = []
const stores: ThreadDataStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.closeThreadStorage()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function open(home: string): ThreadDataStore {
  const threads = new ThreadDataStore(new ProjectManager(home), home, { profileId: 'index-test', allowLegacyProjectData: false })
  threads.setSqliteStoreEnabled(true)
  stores.push(threads)
  return threads
}

function home(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-index-')))
  homes.push(path)
  return path
}

const message = (id: string, content: string): ChatMessage =>
  ({ id, role: 'user', content, timestamp: '2026-01-01T00:00:00.000Z' }) as ChatMessage

function thread(store: ThreadDataStore, name: string, messages: ChatMessage[]): string {
  const created = store.createThread(name, undefined, undefined, { started: true })
  store.mutateThreadData(created.id, () => ({ messages }))
  return created.id
}

const messageIds = (results: Array<{ matchType: string; messageId?: string }>): string[] =>
  results.filter((result) => result.matchType === 'message').map((result) => result.messageId!)

describe('thread search index', () => {
  it('finds a message right after it is saved, and forgets it once removed or edited', async () => {
    const store = open(home())
    const id = thread(store, 'Alpha', [message('m1', 'the zebra crossing'), message('m2', 'nothing')])
    expect(messageIds(await store.searchThreadsAsync('zebra'))).toEqual(['m1'])
    store.mutateThreadData(id, (current) => ({ messages: current.messages.map((m) => (m.id === 'm2' ? { ...m, content: 'a zebra too' } : m)) }))
    expect(messageIds(await store.searchThreadsAsync('zebra')).sort()).toEqual(['m1', 'm2'])
    store.mutateThreadData(id, (current) => ({ messages: current.messages.filter((m) => m.id !== 'm1') }))
    expect(messageIds(await store.searchThreadsAsync('zebra'))).toEqual(['m2'])
  })

  it('matches substrings literally, short queries included', async () => {
    const store = open(home())
    thread(store, 'Literal', [message('pct', 'progress 100% done'), message('under', 'snake_case name'), message('plain', 'percent done')])
    expect(messageIds(await store.searchThreadsAsync('100%'))).toEqual(['pct'])
    expect(messageIds(await store.searchThreadsAsync('e_c'))).toEqual(['under'])
    expect(messageIds(await store.searchThreadsAsync('%'))).toEqual(['pct'])
    expect(messageIds(await store.searchThreadsAsync('DONE')).sort()).toEqual(['pct', 'plain'])
  })

  it('searches text kept in blobs', async () => {
    const store = open(home())
    thread(store, 'Long', [message('long', `${'x'.repeat(BLOB_TEXT_THRESHOLD)} needle at the end`)])
    expect(messageIds(await store.searchThreadsAsync('needle at the end'))).toEqual(['long'])
  })

  it('decides who may be matched before the limit', async () => {
    const store = open(home())
    const hidden = thread(store, 'A hidden', [message('h1', 'shared word'), message('h2', 'shared word again')])
    thread(store, 'B shown', [message('s1', 'shared word')])
    const results = await store.searchThreadsAsync('shared word', 1, { allow: (t) => t.id !== hidden })
    expect(messageIds(results)).toEqual(['s1'])
  })

  it('sees writes made by another process', async () => {
    const path = home()
    const store = open(path)
    const id = thread(store, 'Shared', [message('m1', 'first')])
    expect(messageIds(await store.searchThreadsAsync('second'))).toEqual([])
    const peer = open(path)
    peer.mutateThreadData(id, (current) => ({ messages: [...current.messages, message('m2', 'second entry')] }))
    expect(messageIds(await store.searchThreadsAsync('second'))).toEqual(['m2'])
  })

  it('rebuilds a missing or damaged index from the thread databases', async () => {
    const path = home()
    const store = open(path)
    thread(store, 'Kept', [message('m1', 'rebuild me')])
    expect(messageIds(await store.searchThreadsAsync('rebuild'))).toEqual(['m1'])
    store.closeThreadStorage()
    // A restart: the workers stop, and the index file is lost and replaced by junk.
    await closeSharedThreadDbClient()
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(path, INDEX_FILE + suffix), { force: true })
    writeFileSync(join(path, INDEX_FILE), 'not a database')
    const restarted = open(path)
    expect(messageIds(await restarted.searchThreadsAsync('rebuild'))).toEqual(['m1'])
    expect(existsSync(join(path, INDEX_FILE))).toBe(true)
  })

  it('counts results after removing repeats, so a limit is filled when there are enough', async () => {
    const store = open(home())
    const repeats = Array.from({ length: 9 }, () => message('dup', 'same needle'))
    thread(store, 'Repeats', [...repeats, message('other', 'another needle')])
    expect(messageIds(await store.searchThreadsAsync('needle', 2))).toEqual(['dup', 'other'])
  })

  it("returns a thread's matches in transcript order, as the transcript search does", async () => {
    const store = open(home())
    const id = thread(store, 'Order', [message('first', 'match one'), message('second', 'match two')])
    // A message inserted before the others later still sorts by its place, not by when it was written.
    store.mutateThreadData(id, (current) => ({ messages: [message('zero', 'match zero'), ...current.messages] }))
    expect(messageIds(await store.searchThreadsAsync('match'))).toEqual(['zero', 'first', 'second'])
    expect(messageIds(await store.searchThreadsAsync('match', 1))).toEqual(messageIds(store.searchThreads('match', 1)))
  })

  it('never answers for a thread that is being moved, even from a warm cache', async () => {
    const store = open(home())
    const id = thread(store, 'Fenced', [message('m1', 'hidden needle')])
    expect(messageIds(await store.searchThreadsAsync('needle'))).toEqual(['m1'])
    store.lifecycleStore.update(id, (record) => { record.state = 'draining' as never })
    expect(messageIds(await store.searchThreadsAsync('needle'))).toEqual([])
  })

  it('catches up a write whose file times were put back', async () => {
    const path = home()
    const store = open(path)
    const id = thread(store, 'Stamp', [message('m1', 'first')])
    expect(messageIds(await store.searchThreadsAsync('second'))).toEqual([])
    const dir = join(path, 'thread-data', 'standalone', id)
    const times = ['thread.db', 'thread.db-wal'].filter((name) => existsSync(join(dir, name))).map((name) => [name, statSync(join(dir, name))] as const)
    open(path).mutateThreadData(id, (current) => ({ messages: [...current.messages, message('m2', 'second entry')] }))
    for (const [name, stat] of times) if (existsSync(join(dir, name))) utimesSync(join(dir, name), stat.atime, stat.mtime)
    expect(messageIds(await store.searchThreadsAsync('second'))).toEqual(['m2'])
  })

  it('falls back to the transcripts when the index is locked, and never replaces it', async () => {
    const path = home()
    const store = open(path)
    thread(store, 'Locked', [message('m1', 'locked needle')])
    expect(messageIds(await store.searchThreadsAsync('needle'))).toEqual(['m1'])
    const before = statSync(join(path, INDEX_FILE)).ino
    await closeSharedThreadDbClient()
    const holder = new DatabaseSync(join(path, INDEX_FILE))
    holder.exec('BEGIN EXCLUSIVE')
    try {
      expect(messageIds(await open(path).searchThreadsAsync('needle'))).toEqual(['m1'])
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    expect(statSync(join(path, INDEX_FILE)).ino).toBe(before)
  }, 30_000)

  it('rebuilds tables damaged after the index was opened', async () => {
    const path = home()
    const store = open(path)
    thread(store, 'Damaged', [message('m1', 'damaged needle')])
    expect(messageIds(await store.searchThreadsAsync('needle'))).toEqual(['m1'])
    const other = new DatabaseSync(join(path, INDEX_FILE))
    other.exec('DROP TABLE msg_fts')
    other.close()
    // The first search after the damage still answers (from the transcripts); the next one from a rebuilt index.
    expect(messageIds(await store.searchThreadsAsync('needle'))).toEqual(['m1'])
    expect(messageIds(await store.searchThreadsAsync('needle'))).toEqual(['m1'])
  })

  it('matches as JavaScript lowercases, for short and long queries', async () => {
    const store = open(home())
    thread(store, 'Unicode', [message('e', 'Élan'), message('i', 'İxyz here')])
    expect(messageIds(await store.searchThreadsAsync('é'))).toEqual(['e'])
    expect(messageIds(await store.searchThreadsAsync('i\u0307x'))).toEqual(['i'])
  })

  it('falls back instead of answering from rows a busy index could not bring up to date', async () => {
    const path = home()
    const store = open(path)
    const id = thread(store, 'Busy', [message('m1', 'first')])
    expect(messageIds(await store.searchThreadsAsync('first'))).toEqual(['m1'])
    store.mutateThreadData(id, (current) => ({ messages: [...current.messages, message('m2', 'second')] }))
    const holder = new DatabaseSync(join(path, INDEX_FILE))
    holder.exec('BEGIN IMMEDIATE')
    try {
      expect(messageIds(await store.searchThreadsAsync('second'))).toEqual(['m2'])
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
  }, 30_000)

  it('fills the limit after removing repeats when it falls back too', async () => {
    const path = home()
    const store = open(path)
    thread(store, 'Repeats', [...Array.from({ length: 60 }, () => message('dup', 'dup needle')), message('other', 'other needle')])
    expect(messageIds(await store.searchThreadsAsync('needle', 2))).toEqual(['dup', 'other'])
    const other = new DatabaseSync(join(path, INDEX_FILE))
    other.exec('DROP TABLE msg_fts')
    other.close()
    expect(messageIds(await store.searchThreadsAsync('needle', 2))).toEqual(['dup', 'other'])
  })
})

