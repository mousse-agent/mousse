import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync, fsyncDirectorySync } from './AtomicFs'

export interface ThreadGenerationData {
  messages: unknown[]
  llmContext?: unknown
  agents: unknown[]
  tasks: unknown[]
  queue: unknown[]
  mousseAgentSessions?: unknown[]
  workspace?: unknown
  conversationBranches?: unknown[]
  actions?: unknown[]
}

export interface ThreadGenerationDescriptor {
  schemaVersion: 1
  generationId: string
  counter: number
  createdAt: string
  journalSequence: number
  observedQueueHash: string
  files: string[]
  /** Optional for v1 compatibility; new generations verify every stored collection. */
  contentHashes?: Record<string, string>
}

export interface ThreadGenerationManifest {
  schemaVersion: 1
  currentGenerationId: string
  generationCounter: number
  journalSequence: number
  publishedAt: string
}

const DATA_FILES: Array<[keyof ThreadGenerationData, string]> = [
  ['messages', 'messages.json'],
  ['llmContext', 'llm-context.json'],
  ['agents', 'agents.json'],
  ['tasks', 'tasks.json'],
  ['queue', 'queue.json'],
  ['mousseAgentSessions', 'mousse-agent-sessions.json'],
  ['workspace', 'workspace.json'],
  ['conversationBranches', 'conversation-branches.json'],
  ['actions', 'actions.json']
]

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function queueHash(queue: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(queue)).digest('hex')
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class ThreadGenerationStore {
  readonly generationsDirectory: string
  readonly manifestPath: string

  constructor(readonly threadDirectory: string) {
    this.generationsDirectory = join(threadDirectory, 'generations')
    this.manifestPath = join(threadDirectory, 'manifest.json')
  }

  getManifest(): ThreadGenerationManifest | undefined {
    if (!existsSync(this.manifestPath)) return undefined
    return readJson<ThreadGenerationManifest>(this.manifestPath)
  }

  hasGeneration(generationId: string): boolean {
    return existsSync(join(this.generationsDirectory, generationId, 'generation.json'))
  }

  loadCurrent(): { descriptor: ThreadGenerationDescriptor; data: ThreadGenerationData } | undefined {
    const manifest = this.getManifest()
    if (!manifest) return undefined
    return this.loadGeneration(manifest.currentGenerationId)
  }

  loadGeneration(generationId: string): { descriptor: ThreadGenerationDescriptor; data: ThreadGenerationData } {
    const directory = join(this.generationsDirectory, generationId)
    const descriptor = readJson<ThreadGenerationDescriptor>(join(directory, 'generation.json'))
    if (descriptor.schemaVersion !== 1) throw new Error(`Unsupported generation schema: ${String(descriptor.schemaVersion)}`)
    if (descriptor.generationId !== generationId) throw new Error(`Generation identity mismatch: ${generationId}`)
    const values: Partial<Record<keyof ThreadGenerationData, unknown>> = {}
    for (const [key, file] of DATA_FILES) {
      if (!descriptor.files.includes(file)) continue
      const value = readJson(join(directory, file))
      const expectedHash = descriptor.contentHashes?.[file]
      if (expectedHash && contentHash(value) !== expectedHash) {
        throw new Error(`Generation content hash mismatch: ${generationId}/${file}`)
      }
      values[key] = value
    }
    return {
      descriptor,
      data: {
        messages: (values.messages as unknown[] | undefined) ?? [],
        agents: (values.agents as unknown[] | undefined) ?? [],
        tasks: (values.tasks as unknown[] | undefined) ?? [],
        queue: (values.queue as unknown[] | undefined) ?? [],
        llmContext: values.llmContext,
        mousseAgentSessions: values.mousseAgentSessions as unknown[] | undefined,
        workspace: values.workspace,
        conversationBranches: values.conversationBranches as unknown[] | undefined,
        actions: values.actions as unknown[] | undefined
      }
    }
  }

  publish(data: ThreadGenerationData, journalSequence: number): ThreadGenerationManifest {
    const descriptor = this.createGeneration(data, journalSequence)
    return this.selectExistingGeneration(descriptor.generationId)
  }

  /**
   * Durably create an immutable generation without moving the manifest pointer.
   * The caller journals the result identity before publishing it, closing the
   * otherwise unrecoverable rename -> manifest crash window.
   */
  createGeneration(data: ThreadGenerationData, journalSequence: number): ThreadGenerationDescriptor {
    const previous = this.getManifest()
    const counter = (previous?.generationCounter ?? 0) + 1
    const generationId = `${String(counter).padStart(12, '0')}-${randomUUID()}`
    mkdirSync(this.generationsDirectory, { recursive: true })
    const staging = join(this.generationsDirectory, `.${generationId}.staging`)
    const target = join(this.generationsDirectory, generationId)
    mkdirSync(staging)
    try {
      const files: string[] = []
      const contentHashes: Record<string, string> = {}
      for (const [key, file] of DATA_FILES) {
        const value = data[key]
        if (value === undefined) continue
        atomicWriteJsonSync(join(staging, file), value)
        files.push(file)
        contentHashes[file] = contentHash(value)
      }
      const descriptor: ThreadGenerationDescriptor = {
        schemaVersion: 1,
        generationId,
        counter,
        createdAt: new Date().toISOString(),
        journalSequence,
        observedQueueHash: queueHash(data.queue),
        files,
        contentHashes
      }
      atomicWriteJsonSync(join(staging, 'generation.json'), descriptor)
      renameSync(staging, target)
      fsyncDirectorySync(this.generationsDirectory)
      return descriptor
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }

  /** Publish an already reconciled immutable generation after crash recovery. */
  selectExistingGeneration(
    generationId: string,
    options: { expectedCurrentGenerationId?: string | null } = {}
  ): ThreadGenerationManifest {
    const descriptor = this.loadGeneration(generationId).descriptor
    const current = this.getManifest()
    if (Object.prototype.hasOwnProperty.call(options, 'expectedCurrentGenerationId')) {
      const observed = current?.currentGenerationId ?? null
      if (observed !== options.expectedCurrentGenerationId) {
        throw new Error(`STALE_THREAD_GENERATION:${observed ?? 'none'}`)
      }
    }
    if (current && descriptor.counter < current.generationCounter) {
      throw new Error('Refusing to move the thread manifest to an older generation')
    }
    if (
      current &&
      descriptor.counter === current.generationCounter &&
      descriptor.generationId !== current.currentGenerationId
    ) {
      throw new Error('Refusing to replace the current generation with a competing generation')
    }
    if (current?.currentGenerationId === generationId) return current
    const manifest: ThreadGenerationManifest = {
      schemaVersion: 1,
      currentGenerationId: generationId,
      generationCounter: descriptor.counter,
      journalSequence: descriptor.journalSequence,
      publishedAt: new Date().toISOString()
    }
    atomicWriteJsonSync(this.manifestPath, manifest)
    return manifest
  }

  /** Locate a durable result when the process died before journaling its id. */
  findGenerationByJournalSequence(journalSequence: number): string | undefined {
    return this.listGenerationIds().find((generationId) => {
      try {
        return this.loadGeneration(generationId).descriptor.journalSequence === journalSequence
      } catch {
        return false
      }
    })
  }

  /** Import legacy flat files as the first immutable generation. */
  importLegacy(read: (file: string, fallback: unknown) => unknown, journalSequence = 0): ThreadGenerationManifest {
    const existing = this.getManifest()
    if (existing) return existing
    return this.publish({
      messages: read('messages.json', []) as unknown[],
      llmContext: read('llm-context.json', undefined),
      agents: read('agents.json', []) as unknown[],
      tasks: read('tasks.json', []) as unknown[],
      queue: read('queue.json', []) as unknown[],
      mousseAgentSessions: read('mousse-agent-sessions.json', undefined) as unknown[] | undefined,
      workspace: read('workspace.json', undefined),
      conversationBranches: read('conversation-branches.json', []) as unknown[],
      actions: read('actions.json', []) as unknown[]
    }, journalSequence)
  }

  listGenerationIds(): string[] {
    if (!existsSync(this.generationsDirectory)) return []
    return readdirSync(this.generationsDirectory)
      .filter((name) => !name.startsWith('.') && existsSync(join(this.generationsDirectory, name, 'generation.json')))
      .sort()
  }
}
