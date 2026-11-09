import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
})
