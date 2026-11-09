/**
 * Reading a thread folder's JSON files: the storage every thread used before `thread.db`, and the source a
 * thread is imported from. Reads are pure file reads, so the thread database worker can use them too;
 * `settleLegacyGenerations` is the one writer, run by the daemon under the thread's lock.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Agent, ChatMessage, MousseAgentSessionSnapshot, NativeLlmContext, Task } from '../../shared/types'
import { parseMousseAgentSessions } from '../agents/legacyAgentSessions'
import { ThreadGenerationStore } from './ThreadGenerationStore'
import { ThreadRecoveryService } from './ThreadRecoveryService'
import type { StoredThreadData } from './threadDb/collections'

export class ThreadDataCorruptionError extends Error {
  constructor(readonly filePath: string, cause?: unknown) {
    super(`Corrupt thread data: ${filePath}${cause instanceof Error ? ` (${cause.message})` : ''}`)
    this.name = 'ThreadDataCorruptionError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateNativeContext(value: unknown, filePath: string): NativeLlmContext | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new ThreadDataCorruptionError(filePath, new Error('expected an object'))
  if (value.version !== 1 && value.version !== 2) {
    throw new ThreadDataCorruptionError(filePath, new Error(`unsupported version ${String(value.version)}`))
  }
  if (!Array.isArray(value.messages)) {
    throw new ThreadDataCorruptionError(filePath, new Error('messages must be an array'))
  }
  if (value.retiredMessages !== undefined && !Array.isArray(value.retiredMessages)) {
    throw new ThreadDataCorruptionError(filePath, new Error('retiredMessages must be an array'))
  }
  if (
    !Number.isSafeInteger(value.activeStartIndex) ||
    (value.activeStartIndex as number) < 0 ||
    (value.activeStartIndex as number) > value.messages.length
  ) {
    throw new ThreadDataCorruptionError(filePath, new Error('activeStartIndex is outside the archive'))
  }
  if (value.fidelity !== 'native' && value.fidelity !== 'legacy-estimated') {
    throw new ThreadDataCorruptionError(filePath, new Error('unsupported fidelity'))
  }
  if (
    value.acceptedQueueItemIds !== undefined &&
    (!Array.isArray(value.acceptedQueueItemIds) ||
      value.acceptedQueueItemIds.some((id) => typeof id !== 'string' || id.length === 0))
  ) {
    throw new ThreadDataCorruptionError(filePath, new Error('acceptedQueueItemIds must be non-empty strings'))
  }
  if (
    value.acceptedSteerItemIds !== undefined &&
    (!Array.isArray(value.acceptedSteerItemIds) ||
      value.acceptedSteerItemIds.some((id) => typeof id !== 'string' || id.length === 0))
  ) {
    throw new ThreadDataCorruptionError(filePath, new Error('acceptedSteerItemIds must be non-empty strings'))
  }
  if (value.compaction !== undefined) {
    if (!isRecord(value.compaction)) {
      throw new ThreadDataCorruptionError(filePath, new Error('compaction must be an object'))
    }
    for (const field of ['generation', 'tokensBefore', 'createdAt'] as const) {
      const number = value.compaction[field]
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
        throw new ThreadDataCorruptionError(filePath, new Error(`invalid compaction.${field}`))
      }
    }
    if (typeof value.compaction.summary !== 'string') {
      throw new ThreadDataCorruptionError(filePath, new Error('invalid compaction.summary'))
    }
  }
  return value as unknown as NativeLlmContext
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T
  } catch (error) {
    throw new ThreadDataCorruptionError(filePath, error)
  }
}

export function validateArray<T>(value: unknown, collection: string, threadDir: string): T[] {
  if (!Array.isArray(value)) {
    throw new ThreadDataCorruptionError(join(threadDir, `${collection}.json`), new Error(`${collection} must be an array`))
  }
  return value as T[]
}

export function parseSessionCollection(raw: unknown, filePath: string): MousseAgentSessionSnapshot[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new ThreadDataCorruptionError(filePath, new Error('sessions must be an array'))
  const sessions = parseMousseAgentSessions(raw)
  if (sessions.length !== raw.length) {
    throw new ThreadDataCorruptionError(filePath, new Error('sessions contain an unsupported record'))
  }
  return sessions
}

/**
 * Durable Mousse subagent sessions of a thread folder. A missing file is an older thread; malformed JSON fails
 * closed, so a later save cannot replace recovery evidence with an empty list.
 */
export function loadMousseAgentSessions(threadDir: string): MousseAgentSessionSnapshot[] {
  const filePath = join(threadDir, 'mousse-agent-sessions.json')
  try {
    if (!existsSync(filePath)) return []
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
    return parseSessionCollection(raw, filePath) ?? []
  } catch (error) {
    if (error instanceof ThreadDataCorruptionError) throw error
    throw new ThreadDataCorruptionError(filePath, error)
  }
}

type Field = 'messages' | 'agents' | 'tasks' | 'llmContext' | 'mousseAgentSessions'

/** A thread's data from its plain files, and the file each field was read from. */
function readFlatThreadData(threadDir: string): { data: StoredThreadData; sources: Record<Field, string> } {
  const conversationStatePath = join(threadDir, 'conversation-state.json')
  const legacyMessagesPath = join(threadDir, 'messages.json')
  const llmContextPath = join(threadDir, 'llm-context.json')
  const conversationStateFresh = existsSync(conversationStatePath) &&
    statSync(conversationStatePath).mtimeMs >= Math.max(
      existsSync(legacyMessagesPath) ? statSync(legacyMessagesPath).mtimeMs : 0,
      existsSync(llmContextPath) ? statSync(llmContextPath).mtimeMs : 0
    )
  const conversationState = conversationStateFresh ? readJsonFile<unknown>(conversationStatePath, undefined) : undefined
  let conversationMessages: ChatMessage[] | undefined
  let conversationContext: NativeLlmContext | undefined
  if (conversationState !== undefined) {
    if (!isRecord(conversationState) || conversationState.schemaVersion !== 1) {
      throw new ThreadDataCorruptionError(conversationStatePath, new Error('unsupported conversation-state schema'))
    }
    conversationMessages = validateArray<ChatMessage>(conversationState.messages, 'messages', threadDir)
    conversationContext = validateNativeContext(conversationState.llmContext, conversationStatePath)
  }
  return {
    data: {
      messages: conversationMessages ?? validateArray<ChatMessage>(readJsonFile<unknown>(legacyMessagesPath, []), 'messages', threadDir),
      agents: validateArray<Agent>(readJsonFile<unknown>(join(threadDir, 'agents.json'), []), 'agents', threadDir),
      tasks: validateArray<Task>(readJsonFile<unknown>(join(threadDir, 'tasks.json'), []), 'tasks', threadDir),
      llmContext: conversationContext ?? validateNativeContext(readJsonFile<unknown>(llmContextPath, undefined), llmContextPath),
      mousseAgentSessions: loadMousseAgentSessions(threadDir)
    },
    sources: {
      messages: conversationMessages ? conversationStatePath : legacyMessagesPath,
      agents: join(threadDir, 'agents.json'),
      tasks: join(threadDir, 'tasks.json'),
      llmContext: conversationState !== undefined ? conversationStatePath : llmContextPath,
      mousseAgentSessions: join(threadDir, 'mousse-agent-sessions.json')
    }
  }
}

/**
 * A thread's data from its JSON files. A thread that once used the transactional store of earlier builds is read
 * from its current generation until `settleLegacyGenerations` has run; the daemon runs that before any other read
 * or write, so this choice is only a reader's that does not hold the lock. The queue is not part of it
 * (`queue.json` is read on its own).
 */
export function readLegacyThreadData(threadDir: string): StoredThreadData {
  if (existsSync(join(threadDir, 'manifest.json'))) {
    const generation = readCurrentGeneration(threadDir)
    if (generation) return generation
  }
  return readFlatThreadData(threadDir).data
}

function readCurrentGeneration(threadDir: string): StoredThreadData | undefined {
  const current = new ThreadGenerationStore(threadDir).loadCurrent()
  if (!current) return undefined
  const generationDir = join(threadDir, 'generations', current.descriptor.generationId)
  return {
    messages: validateArray<ChatMessage>(current.data.messages, 'messages', threadDir),
    agents: validateArray<Agent>(current.data.agents, 'agents', threadDir),
    tasks: validateArray<Task>(current.data.tasks, 'tasks', threadDir),
    llmContext: validateNativeContext(current.data.llmContext, join(generationDir, 'llm-context.json')),
    mousseAgentSessions: parseSessionCollection(current.data.mousseAgentSessions, join(generationDir, 'mousse-agent-sessions.json'))
  }
}

function comparable(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) => {
    if (!isRecord(item)) return item
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(item).sort()) out[key] = item[key]
    return out
  }) ?? 'null'
}

function mtimeOf(path: string): number {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

export interface SettleOutcome {
  /** Which copy the thread now reads: nothing to settle, the generation, or the plain files. */
  kept: 'none' | 'generation' | 'files'
  /** True when the two copies differed and their times could not say which was written last. */
  ambiguous?: boolean
  /** Where the copy that lost was set aside, when there was one. */
  backup?: string
}

/**
 * Ends a thread's use of the transactional store of earlier builds, once, so every later read and write uses the
 * plain files alone. The caller holds the thread's lock. A crash's unfinished generation is finished first. Then
 * the current generation and the plain files are compared field by field:
 *
 * - equal: nothing to choose;
 * - every field that differs is in a file written after the generation was selected: the plain files were written
 *   by a build with the store off again, and they win;
 * - otherwise the generation wins (those builds wrote the plain files only as a copy of it, after it, and a copy
 *   cut short leaves some files older), and is written as the plain files.
 *
 * The copy that loses is never lost: plain files that are replaced are copied to `legacy-json/settled-<time>/`
 * first, and a generation stays in `generations/`. The generation pointer is renamed to
 * `manifest.json.settled-<time>`. When times cannot tell the copies apart (equal times, a clock change, copied
 * files), the outcome says so.
 */
/**
 * True when a thread folder still has the transactional store's files to settle: a generation pointer, or
 * generations a crash left before the first pointer was written, and no record that it was settled.
 */
export function hasUnsettledGenerations(threadDir: string): boolean {
  if (existsSync(join(threadDir, 'manifest.json'))) return true
  if (!existsSync(join(threadDir, 'generations'))) return false
  try {
    return !readdirSync(threadDir).some((name) => name.startsWith('manifest.json.settled-'))
  } catch {
    return false
  }
}

export function settleLegacyGenerations(threadDir: string, writeFlat: (data: StoredThreadData) => void): SettleOutcome {
  const manifestPath = join(threadDir, 'manifest.json')
  if (!hasUnsettledGenerations(threadDir)) return { kept: 'none' }
  // When the generation was selected: before a crash's unfinished generation is finished here, the pointer's time;
  // a generation finished now was written when that crash happened, not now.
  const selectedBefore = mtimeOf(manifestPath)
  const recovered = new ThreadRecoveryService(new ThreadGenerationStore(threadDir)).reconcile().repairedGeneration
  const selectedAt = recovered ? Math.max(selectedBefore, mtimeOf(join(threadDir, 'generations', recovered, 'generation.json'))) : selectedBefore
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outcome: SettleOutcome = { kept: 'files' }
  const generation = readCurrentGeneration(threadDir)
  if (generation) {
    const flat = readFlatThreadData(threadDir)
    const fields: Field[] = ['messages', 'agents', 'tasks', 'llmContext', 'mousseAgentSessions']
    const differing = fields.filter((field) => {
      const ours = field === 'mousseAgentSessions' ? (generation[field]?.length ? generation[field] : []) : generation[field]
      const theirs = field === 'mousseAgentSessions' ? (flat.data[field]?.length ? flat.data[field] : []) : flat.data[field]
      return comparable(ours) !== comparable(theirs)
    })
    if (differing.length) {
      // A field whose file is gone (the plain writer removes the sessions or context file when there are none)
      // says nothing about when it was written; the files that are there decide.
      const present = differing.filter((field) => existsSync(flat.sources[field]))
      const times = present.map((field) => mtimeOf(flat.sources[field]))
      const filesWin = times.length > 0 && times.every((time) => time > selectedAt)
      outcome.ambiguous = present.length < differing.length || times.some((time) => time === selectedAt) || (!filesWin && times.some((time) => time > selectedAt))
      if (!filesWin) {
        const backup = join(threadDir, 'legacy-json', `settled-${stamp}`)
        mkdirSync(backup, { recursive: true })
        for (const file of LEGACY_DATA_FILES) {
          if (file !== 'manifest.json' && existsSync(join(threadDir, file))) copyFileSync(join(threadDir, file), join(backup, file))
        }
        writeFlat(generation)
        outcome.kept = 'generation'
        outcome.backup = backup
      } else {
        outcome.backup = join(threadDir, 'generations')
      }
    } else {
      outcome.kept = 'generation'
    }
  }
  // The record that the thread was settled: the old pointer, or an empty one when a crash left none.
  const settled = join(threadDir, `manifest.json.settled-${stamp}`)
  if (existsSync(manifestPath)) renameSync(manifestPath, settled)
  else writeFileSync(settled, '{}\n')
  return outcome
}

/** The files a thread's data may be read from, in the thread folder (and its current generation). */
export const LEGACY_DATA_FILES = [
  'conversation-state.json',
  'messages.json',
  'agents.json',
  'tasks.json',
  'llm-context.json',
  'mousse-agent-sessions.json',
  'manifest.json'
] as const

export interface FileStamp { file: string; exists: boolean; size?: number; mtimeMs?: number; ino?: number }

/**
 * What the JSON source of a thread looks like on disk now: every data file, the root generation pointer and the
 * files of the generation it selects, with whether each exists. Two equal fingerprints mean nobody wrote.
 */
export function legacyFingerprint(threadDir: string): FileStamp[] {
  const files: string[] = [...LEGACY_DATA_FILES]
  try {
    const manifest = readJsonFile<{ currentGenerationId?: unknown } | undefined>(join(threadDir, 'manifest.json'), undefined)
    if (manifest && typeof manifest.currentGenerationId === 'string' && /^[\w.-]+$/.test(manifest.currentGenerationId)) {
      const generation = join('generations', manifest.currentGenerationId)
      for (const file of ['generation.json', 'messages.json', 'llm-context.json', 'agents.json', 'tasks.json', 'mousse-agent-sessions.json']) {
        files.push(join(generation, file))
      }
    }
  } catch {
    // An unreadable pointer is fingerprinted by its own stamp.
  }
  return files.map((file) => {
    try {
      const stat = statSync(join(threadDir, file))
      return { file, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }
    } catch {
      return { file, exists: false }
    }
  })
}

export function sameFingerprint(a: FileStamp[], b: FileStamp[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
