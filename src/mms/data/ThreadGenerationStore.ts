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
    if (descriptor.generationId !== generationId) throw new Error(`Generation identity mismatch: ${generationId}`)
    const values: Partial<ThreadGenerationData> = {}
    for (const [key, file] of DATA_FILES) {
      if (descriptor.files.includes(file)) values[key] = readJson(join(directory, file))
    }
    return {
      descriptor,
      data: {
        messages: values.messages ?? [],
        agents: values.agents ?? [],
        tasks: values.tasks ?? [],
        queue: values.queue ?? [],
        llmContext: values.llmContext,
        mousseAgentSessions: values.mousseAgentSessions,
        workspace: values.workspace,
        conversationBranches: values.conversationBranches,
        actions: values.actions
      }
    }
  }

  publish(data: ThreadGenerationData, journalSequence: number): ThreadGenerationManifest {
    const previous = this.getManifest()
    const counter = (previous?.generationCounter ?? 0) + 1
    const generationId = `${String(counter).padStart(12, '0')}-${randomUUID()}`
    mkdirSync(this.generationsDirectory, { recursive: true })
    const staging = join(this.generationsDirectory, `.${generationId}.staging`)
    const target = join(this.generationsDirectory, generationId)
    mkdirSync(staging)
    try {
      const files: string[] = []
      for (const [key, file] of DATA_FILES) {
        const value = data[key]
        if (value === undefined) continue
        atomicWriteJsonSync(join(staging, file), value)
        files.push(file)
      }
      const descriptor: ThreadGenerationDescriptor = {
        schemaVersion: 1,
        generationId,
        counter,
        createdAt: new Date().toISOString(),
        journalSequence,
        observedQueueHash: queueHash(data.queue),
        files
      }
      atomicWriteJsonSync(join(staging, 'generation.json'), descriptor)
      renameSync(staging, target)
      fsyncDirectorySync(this.generationsDirectory)
      return this.selectExistingGeneration(generationId)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }

  /** Publish an already reconciled immutable generation after crash recovery. */
  selectExistingGeneration(generationId: string): ThreadGenerationManifest {
    const descriptor = this.loadGeneration(generationId).descriptor
    const current = this.getManifest()
    if (current && descriptor.counter < current.generationCounter) {
      throw new Error('Refusing to move the thread manifest to an older generation')
    }
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
      conversationBranches: [],
      actions: []
    }, journalSequence)
  }

  listGenerationIds(): string[] {
    if (!existsSync(this.generationsDirectory)) return []
    return readdirSync(this.generationsDirectory)
      .filter((name) => !name.startsWith('.') && existsSync(join(this.generationsDirectory, name, 'generation.json')))
      .sort()
  }
}
