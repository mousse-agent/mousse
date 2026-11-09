import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { settleThreadMutationOwnership } from '../src/mms/queue/ThreadExecutionLease'
import { readThreadRecordSync, threadRecordPath } from '../src/mms/data/threadRecords'
import { ThreadGenerationStore } from '../src/mms/data/ThreadGenerationStore'
import type { ChatMessage, NativeLlmContext } from '../src/shared/types'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function open(home: string, sqlite = true) {
  const threads = new ThreadDataStore(new ProjectManager(home), home, { profileId: 'sqlite-test', allowLegacyProjectData: false })
  threads.setSqliteStoreEnabled(sqlite)
  const coordinator = new ResourceLifecycleCoordinator(threads.lifecycleStore, {
    assertCanTrash: (record) => settleThreadMutationOwnership(record.location),
    drain: async () => undefined,
    settleMutationOwnership: async (record) => settleThreadMutationOwnership(record.location),
    quiesceDisk: async () => { threads.quiesceAllThreadStorage(); return () => undefined },
    projectIndex: (record) => {
      threads.cancelLifecycleQueue(record, record.operations.at(-1)!.id)
      threads.projectLifecycleIndex(record)
    }
  })
  return { threads, coordinator }
}

function home(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-sqlite-store-')))
  homes.push(path)
  return path
}

const message = (id: string, content: string): ChatMessage =>
  ({ id, role: 'user', content, timestamp: '2026-01-01T00:00:00.000Z' }) as ChatMessage
const llmContext = { version: 2, messages: [{ role: 'user', content: 'hello' }], fidelity: 'native', activeStartIndex: 0 } as unknown as NativeLlmContext

/** A thread written by the JSON store, as every thread was before `thread.db`. */
function jsonThread(path: string, messages: ChatMessage[]) {
  const { threads } = open(path, false)
  const thread = threads.createThread('Old', undefined, undefined, { started: true })
  threads.mutateThreadData(thread.id, () => ({ messages, agents: [{ id: 'a1', worktreePath: '/w', branch: 'mousse/agent/a1' } as never], llmContext }))
  return { id: thread.id, dir: threads.getThreadDir(thread.id) }
}

describe('threads kept in thread.db', () => {
  it('starts new threads in a database and keeps their data across a restart', () => {
    const path = home()
    const { threads } = open(path)
    const thread = threads.createThread('New')
    const dir = threads.getThreadDir(thread.id)
    expect(existsSync(join(dir, 'thread.db'))).toBe(true)
    expect(existsSync(join(dir, 'messages.json'))).toBe(false)
    threads.mutateThreadData(thread.id, () => ({ messages: [message('m1', 'one')], llmContext }))
    threads.mutateThreadData(thread.id, (current) => ({ messages: [...current.messages, message('m2', 'two')] }))
    const restarted = open(path).threads
    const data = restarted.loadThreadData(thread.id)
    expect(data.messages.map((m) => m.content)).toEqual(['one', 'two'])
    expect(data.llmContext).toEqual(llmContext)
    expect(restarted.getThread(thread.id)?.startedAt).toBeTruthy()
    expect(existsSync(join(dir, 'conversation-state.json'))).toBe(false)
  })

  it('imports a JSON thread, checks it, and keeps the JSON files untouched as a backup', async () => {
    const path = home()
    const { id, dir } = jsonThread(path, [message('m1', 'one'), message('m2', 'two')])
    const before = Object.fromEntries(['messages.json', 'agents.json', 'llm-context.json'].map((name) => [name, readFileSync(join(dir, name), 'utf8')]))
    const { threads } = open(path)
    const legacy = threads.loadThreadData(id)
    expect(await threads.importThreadStorage(id)).toEqual({ status: 'imported', messages: 2 })
    expect(threads.loadThreadData(id)).toEqual(legacy)
    // New writes go to the database only.
    threads.mutateThreadData(id, (current) => ({ messages: [...current.messages, message('m3', 'three')] }))
    for (const [name, text] of Object.entries(before)) expect(readFileSync(join(dir, name), 'utf8')).toBe(text)
    expect(open(path).threads.loadThreadData(id).messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(await threads.importThreadStorage(id)).toEqual({ status: 'already' })
    expect(readdirSync(dir).filter((name) => name.startsWith('thread.db.'))).toEqual([])
  })

  it('imports a thread that used the transactional store from its current generation', async () => {
    const path = home()
    const { id, dir } = jsonThread(path, [message('flat', 'older flat copy')])
    // The generation is newer than the flat files, as the transactional store left it.
    new ThreadGenerationStore(dir).publish({ messages: [message('gen', 'from the generation')], agents: [], tasks: [], queue: [] }, 1)
    const { threads } = open(path)
    expect(await threads.importThreadStorage(id)).toMatchObject({ status: 'imported' })
    expect(threads.loadThreadData(id).messages.map((m) => m.id)).toEqual(['gen'])
  })

  it('writes only the plain files for a thread still on JSON', () => {
    const path = home()
    const { id, dir } = jsonThread(path, [message('m1', 'one')])
    // What an earlier build left: the same messages a second time.
    writeFileSync(join(dir, 'conversation-state.json'), JSON.stringify({ schemaVersion: 1, messages: [message('m1', 'one')], llmContext }))
    const { threads } = open(path, false)
    threads.mutateThreadData(id, (current) => ({ messages: [...current.messages, message('m2', 'two')] }))
    expect(existsSync(join(dir, 'conversation-state.json'))).toBe(false)
    expect(existsSync(join(dir, 'generations'))).toBe(false)
    expect(threads.loadThreadData(id).messages).toHaveLength(2)
  })

  it('imports every listed JSON thread in the background', async () => {
    const path = home()
    const first = jsonThread(path, [message('a', 'a')])
    const second = jsonThread(path, [message('b', 'b')])
    const { threads } = open(path)
    expect(threads.threadStorageStatus()).toMatchObject({ database: 0, json: 2 })
    threads.startBackgroundImport({ delayMs: 0, pauseMs: 0 })
    for (let i = 0; i < 100 && threads.threadStorageStatus().database < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    threads.stopBackgroundImport()
    expect(threads.threadStorageStatus()).toEqual({ database: 2, json: 0, failed: [] })
    expect(existsSync(join(first.dir, 'thread.db')) && existsSync(join(second.dir, 'thread.db'))).toBe(true)
  })

  it('a thread whose import fails keeps working from JSON and says why', async () => {
    const path = home()
    const { id, dir } = jsonThread(path, [message('m1', 'one')])
    // Something in the way of publishing: the database name is taken by a folder.
    mkdirSync(join(dir, 'thread.db.blocker'))
    writeFileSync(join(dir, 'messages.json.bad'), '')
    const { threads } = open(path)
    writeFileSync(join(dir, 'messages.json'), '{ not json')
    const outcome = await threads.importThreadStorage(id)
    expect(outcome.status).toBe('failed')
    expect(JSON.parse(readFileSync(join(dir, 'thread-db-import-error.json'), 'utf8')).reason).toMatch(/Corrupt thread data/)
    expect(existsSync(join(dir, 'thread.db'))).toBe(false)
    writeFileSync(join(dir, 'messages.json'), JSON.stringify([message('m1', 'fixed')]))
    expect(threads.loadThreadData(id).messages[0].content).toBe('fixed')
    expect(await threads.importThreadStorage(id)).toMatchObject({ status: 'imported' })
    expect(existsSync(join(dir, 'thread-db-import-error.json'))).toBe(false)
  })

  it('removes import files a crashed process left behind', async () => {
    const path = home()
    const { id, dir } = jsonThread(path, [message('m1', 'one')])
    const abandoned = join(dir, 'thread.db.import-99999-dead')
    writeFileSync(abandoned, 'half written')
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(abandoned, old, old)
    const { threads } = open(path)
    expect(await threads.importThreadStorage(id)).toMatchObject({ status: 'imported' })
    expect(existsSync(abandoned)).toBe(false)
  })

  it('keeps writes an older build made after the import, without merging them', async () => {
    const path = home()
    const { id, dir } = jsonThread(path, [message('m1', 'one')])
    const { threads } = open(path)
    await threads.importThreadStorage(id)
    // An older build only knows the JSON files.
    writeFileSync(join(dir, 'conversation-state.json'), JSON.stringify({ schemaVersion: 1, messages: [message('m1', 'one'), message('old', 'from old build')] }))
    const restarted = open(path).threads
    const seen: unknown[] = []
    restarted.on('thread-storage-downgrade-writes', (event) => seen.push(event))
    expect(restarted.loadThreadData(id).messages.map((m) => m.id)).toEqual(['m1'])
    expect(seen).toHaveLength(1)
    const kept = readdirSync(join(dir, 'legacy-json'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dir, 'legacy-json', kept[0]!, 'conversation-state.json'), 'utf8')).toContain('from old build')
    // Reported once, not on every read.
    open(path).threads.loadThreadData(id)
    expect(readdirSync(join(dir, 'legacy-json'))).toHaveLength(1)
  })

  it('exports a thread back to the JSON files an older build reads', async () => {
    const path = home()
    const { id, dir } = jsonThread(path, [message('m1', 'one')])
    const { threads } = open(path)
    await threads.importThreadStorage(id)
    threads.mutateThreadData(id, (current) => ({ messages: [...current.messages, message('m2', 'after import')] }))
    const exported = threads.exportThreadToJson(id)
    expect(exported.exported).toBe(true)
    expect(existsSync(join(dir, 'thread.db'))).toBe(false)
    expect(existsSync(exported.databaseKeptAs!)).toBe(true)
    const older = open(path, false).threads
    expect(older.loadThreadData(id).messages.map((m) => m.content)).toEqual(['one', 'after import'])
  })

  it('moves to the trash and back with its database, and the lifecycle readers find its agents', async () => {
    const path = home()
    const { threads, coordinator } = open(path)
    const thread = threads.createThread('Moving', undefined, undefined, { started: true })
    threads.mutateThreadData(thread.id, () => ({ messages: [message('m1', 'kept')], agents: [{ id: 'a1', worktreePath: '/w/a1', branch: 'mousse/agent/a1' } as never] }))
    const dir = threads.getThreadDir(thread.id)
    expect(threadRecordPath(dir, 'agents.json')).toBe(join(dir, 'thread.db#agents.json'))
    expect(readThreadRecordSync(threadRecordPath(dir, 'agents.json'))?.data).toEqual([{ id: 'a1', worktreePath: '/w/a1', branch: 'mousse/agent/a1' }])
    // The trash inventory reads the agent from the database and refuses to lose its worktree.
    await expect(coordinator.trash({ taskId: thread.id, operationId: 'trash-refused' })).rejects.toThrow(/\/w\/a1/)
    threads.mutateThreadData(thread.id, () => ({ agents: [] }))
    await coordinator.trash({ taskId: thread.id, operationId: 'trash' })
    expect(existsSync(join(dir, 'thread.db'))).toBe(false)
    await coordinator.restore({ taskId: thread.id, operationId: 'restore' })
    expect(threads.loadThreadData(thread.id).messages.map((m) => m.content)).toEqual(['kept'])
    threads.mutateThreadData(thread.id, (current) => ({ messages: [...current.messages, message('m2', 'after restore')] }))
    expect(open(path).threads.loadThreadData(thread.id).messages).toHaveLength(2)
  })

  it('searches transcripts kept in the database', () => {
    const path = home()
    const { threads } = open(path)
    const thread = threads.createThread('Searchable', undefined, undefined, { started: true })
    threads.mutateThreadData(thread.id, () => ({ messages: [message('m1', 'the quick "brown" fox'), message('m2', 'nothing here')] }))
    const results = threads.searchThreads('"brown"')
    expect(results).toEqual([expect.objectContaining({ threadId: thread.id, matchType: 'message', messageId: 'm1' })])
  })

  it('finds non-ASCII text whatever its case', () => {
    const path = home()
    const { threads } = open(path)
    const thread = threads.createThread('Accents', undefined, undefined, { started: true })
    threads.mutateThreadData(thread.id, () => ({ messages: [message('m1', 'Un ÉLAN rare')] }))
    expect(threads.searchThreads('élan').map((hit) => hit.messageId)).toEqual(['m1'])
  })

  it('reports message counts without loading a thread', () => {
    const path = home()
    const { threads } = open(path)
    const thread = threads.createThread('Empty')
    expect(() => threads.setThreadWorktreeEnabled(thread.id, true)).not.toThrow()
    threads.mutateThreadData(thread.id, () => ({ messages: [message('m1', 'one')] }))
    expect(() => open(path).threads.setThreadWorktreeEnabled(thread.id, false)).toThrow()
  })
})
