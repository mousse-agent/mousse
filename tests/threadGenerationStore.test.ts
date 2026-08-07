import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
})
