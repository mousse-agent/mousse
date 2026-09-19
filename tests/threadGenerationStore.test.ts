import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicWriteJsonSync } from '../src/mms/data/AtomicFs'
import { ThreadGenerationStore } from '../src/mms/data/ThreadGenerationStore'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { ThreadRecoveryService } from '../src/mms/data/ThreadRecoveryService'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'

const roots: string[] = []
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mousse-generation-'))
  roots.push(value)
  return value
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function snapshot(message: string) {
  return { messages: [{ content: message }], agents: [], tasks: [], queue: [] }
}

describe('transactional thread generations', () => {
  it('publishes complete immutable generations through one manifest pointer', () => {
    const directory = root()
    const store = new ThreadGenerationStore(directory)
    const first = store.publish(snapshot('one'), 1)
    const second = store.publish(snapshot('two'), 2)

    expect(first.generationCounter).toBe(1)
    expect(second.generationCounter).toBe(2)
    expect(store.loadCurrent()?.data.messages).toEqual([{ content: 'two' }])
    expect(store.loadGeneration(first.currentGenerationId).data.messages).toEqual([{ content: 'one' }])
    expect(store.listGenerationIds()).toHaveLength(2)
    expect(existsSync(join(directory, 'generations', first.currentGenerationId, 'messages.json'))).toBe(true)
  })

  it('rejects a generation whose stored collection no longer matches its descriptor', () => {
    const directory = root()
    const store = new ThreadGenerationStore(directory)
    const manifest = store.publish(snapshot('original'), 1)
    writeFileSync(
      join(directory, 'generations', manifest.currentGenerationId, 'messages.json'),
      JSON.stringify([{ content: 'tampered' }]),
      'utf8'
    )
    expect(() => store.loadCurrent()).toThrow(/content hash mismatch/)
  })

  it('keeps append-only monotonic journal records', () => {
    const directory = root()
    const journal = new ThreadJournal(directory)
    journal.append({ operationId: 'op', operationType: 'save', state: 'planned' })
    journal.append({ operationId: 'op', operationType: 'save', state: 'completed' })
    expect(journal.list().map((record) => record.sequence)).toEqual([1, 2])
    expect(journal.latestByOperation().get('op')?.state).toBe('completed')
  })

  it('republishes a reconciled generation after a manifest gap', () => {
    const directory = root()
    const store = new ThreadGenerationStore(directory)
    const journal = new ThreadJournal(directory)
    const intent = journal.append({ operationId: 'op', operationType: 'save', state: 'running' })
    const manifest = store.publish(snapshot('durable'), intent.sequence)
    // Simulate a crash after the generation was reconciled but before the intended manifest publication.
    atomicWriteJsonSync(store.manifestPath, {
      schemaVersion: 1,
      currentGenerationId: 'missing',
      generationCounter: 0,
      journalSequence: 0,
      publishedAt: new Date(0).toISOString()
    })
    journal.append({
      operationId: 'op',
      operationType: 'save',
      state: 'running',
      resultGenerationId: manifest.currentGenerationId
    })

    const result = new ThreadRecoveryService(store, journal).reconcile()
    expect(result.repairedGeneration).toBe(manifest.currentGenerationId)
    expect(store.loadCurrent()?.data.messages).toEqual([{ content: 'durable' }])
    expect(journal.latestByOperation().get('op')?.state).toBe('completed')
  })

  it('recovers the production staged-generation state and is idempotent', () => {
    const directory = root()
    const store = new ThreadGenerationStore(directory)
    const journal = new ThreadJournal(directory)
    const intent = journal.append({ operationId: 'op', operationType: 'thread-data-save', state: 'planned' })
    journal.append({
      operationId: 'op', operationType: 'thread-data-save', state: 'running',
      details: { intentSequence: intent.sequence }
    })
    const generation = store.createGeneration(snapshot('durable'), intent.sequence)
    journal.append({
      operationId: 'op', operationType: 'thread-data-save', state: 'running',
      resultGenerationId: generation.generationId,
      details: { intentSequence: intent.sequence, generationDurable: true }
    })

    const recovery = new ThreadRecoveryService(store, journal)
    expect(recovery.reconcile().repairedGeneration).toBe(generation.generationId)
    const recordsAfterFirst = journal.list().length
    expect(recovery.reconcile()).toEqual({ cancelledOperations: [], recoveryRequired: [] })
    expect(journal.list()).toHaveLength(recordsAfterFirst)
    expect(store.loadCurrent()?.data.messages).toEqual([{ content: 'durable' }])
  })

  it('does not repeatedly append recovery-required or move backward across repairs', () => {
    const directory = root()
    const store = new ThreadGenerationStore(directory)
    const older = store.publish(snapshot('older'), 1)
    const newer = store.publish(snapshot('newer'), 2)
    atomicWriteJsonSync(store.manifestPath, {
      schemaVersion: 1,
      currentGenerationId: 'missing',
      generationCounter: 0,
      journalSequence: 0,
      publishedAt: new Date(0).toISOString()
    })
    const journal = new ThreadJournal(directory)
    journal.append({
      operationId: 'newer', operationType: 'save', state: 'running',
      resultGenerationId: newer.currentGenerationId
    })
    journal.append({
      operationId: 'older', operationType: 'save', state: 'running',
      resultGenerationId: older.currentGenerationId
    })
    journal.append({ operationId: 'ambiguous', operationType: 'git', state: 'running' })

    const recovery = new ThreadRecoveryService(store, journal)
    recovery.reconcile()
    expect(store.loadCurrent()?.data.messages).toEqual([{ content: 'newer' }])
    const count = journal.list().length
    expect(recovery.reconcile()).toEqual({ cancelledOperations: [], recoveryRequired: [] })
    expect(journal.list()).toHaveLength(count)
    expect(journal.latestByOperation().get('ambiguous')?.state).toBe('recovery_required')
  })

  it('cancels planned work but marks ambiguous running work recovery-required', () => {
    const directory = root()
    const journal = new ThreadJournal(directory)
    journal.append({ operationId: 'planned', operationType: 'save', state: 'planned' })
    journal.append({ operationId: 'running', operationType: 'git', state: 'running' })
    const result = new ThreadRecoveryService(new ThreadGenerationStore(directory), journal).reconcile()
    expect(result.cancelledOperations).toEqual(['planned'])
    expect(result.recoveryRequired).toEqual(['running'])
  })

  it('projects ThreadDataStore saves into a current immutable generation behind the flag', () => {
    const home = root()
    const previousHome = process.env.MOUSSE_HOME
    const previousFlag = process.env.MOUSSE_TRANSACTIONAL_THREAD_STORE
    process.env.MOUSSE_HOME = home
    process.env.MOUSSE_TRANSACTIONAL_THREAD_STORE = '1'
    try {
      const projects = new ProjectManager()
      const threads = new ThreadDataStore(projects)
      projects.setThreadStore(threads)
      const thread = threads.createThread('transactional')
      threads.saveThreadData(thread.id, {
        messages: [{ id: 'm', role: 'user', content: 'durable', timestamp: new Date().toISOString() }],
        agents: [],
        tasks: [],
        messageQueue: []
      })
      expect(threads.loadThreadData(thread.id).messages[0]?.content).toBe('durable')
      const directory = threads.getThreadDir(thread.id)
      expect(new ThreadGenerationStore(directory).getManifest()?.generationCounter).toBe(1)
      expect(new ThreadJournal(directory).latestByOperation().values().next().value?.state).toBe('completed')
    } finally {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      if (previousFlag === undefined) delete process.env.MOUSSE_TRANSACTIONAL_THREAD_STORE
      else process.env.MOUSSE_TRANSACTIONAL_THREAD_STORE = previousFlag
    }
  })

  it('uses live queue authority and preserves action/branch/workspace collections', () => {
    const home = root()
    const projects = new ProjectManager()
    const threads = new ThreadDataStore(projects, home)
    projects.setThreadStore(threads)
    threads.setTransactionalStoreEnabled(true)
    const thread = threads.createThread('collections')
    const directory = threads.getThreadDir(thread.id)
    atomicWriteJsonSync(join(directory, 'workspace.json'), { lifecycle: 'ready' })
    atomicWriteJsonSync(join(directory, 'actions.json'), [{ id: 'action-1' }])
    atomicWriteJsonSync(join(directory, 'conversation-branches.json'), [{ id: 'branch-1' }])
    threads.saveThreadData(thread.id, { messages: [], agents: [], tasks: [] })
    threads.saveMessageQueue(thread.id, [{
      id: 'q1', threadId: thread.id, content: 'live', enqueuedAt: new Date().toISOString(),
      order: 0, intent: 'normal', state: 'pending'
    }])

    expect(threads.loadThreadData(thread.id).messageQueue.map((item) => item.id)).toEqual(['q1'])
    const current = new ThreadGenerationStore(directory).loadCurrent()!.data
    expect(current.actions).toEqual([{ id: 'action-1' }])
    expect(current.conversationBranches).toEqual([{ id: 'branch-1' }])
    expect(current.workspace).toEqual({ lifecycle: 'ready' })
  })

  it('fails closed on corrupt thread JSON and preserves the original bytes', () => {
    const home = root()
    const projects = new ProjectManager()
    const threads = new ThreadDataStore(projects, home)
    projects.setThreadStore(threads)
    const thread = threads.createThread('corrupt')
    const messagesPath = join(threads.getThreadDir(thread.id), 'messages.json')
    writeFileSync(messagesPath, '{broken', 'utf8')
    expect(() => threads.loadThreadData(thread.id)).toThrow(/Corrupt thread data/)
    expect(readFileSync(messagesPath, 'utf8')).toBe('{broken')
  })
})
