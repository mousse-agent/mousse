/**
 * A thread's `actions.json`: its turns and other actions, in order. A turn reads it several times (outside changes, its
 * start, its end, its checkpoint) and rewrites it two or three times, and the file grows with every turn the thread has
 * run. What was read is kept by file signature (`cacheSignature`), so a read of an unchanged file costs one `lstat`, and a
 * write that would leave the bytes as they are is skipped. The cache keeps the parsed actions and a digest of the text,
 * not the text: a file of a long thread is hundreds of kilobytes, and the service keeps it for as long as it runs.
 */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ThreadAction } from '../../shared/threadActions'
import { atomicWriteFileSync } from '../data/AtomicFs'
import { cacheSignature } from '../data/FileSignature'

export const ACTIONS_FILE = 'actions.json'

interface ActionsRead {
  signature: string
  /** The text's length and digest, to tell whether a write would leave the bytes as they are. */
  chars: number
  digest: string
  actions: readonly ThreadAction[]
}

/**
 * The last read of each thread's file, by path. A file whose signature is unchanged holds the same bytes: every write
 * replaces it with a rename, which gives it a new file identity. This process's own writes drop the entry, so they
 * never depend on the file system's time resolution. Bounded: past the cap, the least recently used files are dropped.
 */
const reads = new Map<string, ActionsRead>()
let readChars = 0
const READ_CHARS_MAX = 32 * 1024 * 1024

/** For tests: how many times an `actions.json` was read and parsed, and written. */
export const actionsFileCounts = { reads: 0, writes: 0 }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** The signature of the regular file at `path`: undefined when it is missing, null when it has none to trust. */
function signatureOf(path: string): string | undefined | null {
  try {
    const stats = lstatSync(path, { bigint: true })
    return stats.isFile() ? cacheSignature(stats) ?? null : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function forget(path: string): void {
  const read = reads.get(path)
  if (!read) return
  reads.delete(path)
  readChars -= read.chars
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('base64')
}

function remember(path: string, read: ActionsRead): void {
  if (read.chars > READ_CHARS_MAX) return
  reads.set(path, read)
  readChars += read.chars
  while (readChars > READ_CHARS_MAX) forget(reads.keys().next().value!)
}

/** The file's actions as they are now, shared and frozen; none when there is no file. */
function current(threadDirectory: string): readonly ThreadAction[] {
  const path = join(threadDirectory, ACTIONS_FILE)
  const signature = signatureOf(path)
  const cached = reads.get(path)
  if (signature && cached?.signature === signature) {
    // Most recently used last, for the bound.
    reads.delete(path); reads.set(path, cached)
    return cached.actions
  }
  forget(path)
  if (signature === undefined) return []
  let read: { signature: string | undefined; text: string }
  try {
    const fd = openSync(path, 'r')
    try {
      // The signature of the open file, so it always matches the bytes read.
      read = { signature: cacheSignature(fstatSync(fd, { bigint: true })), text: readFileSync(fd, 'utf8') }
    } finally { closeSync(fd) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  actionsFileCounts.reads += 1
  const actions = deepFreeze(JSON.parse(read.text) as ThreadAction[])
  if (read.signature) remember(path, { signature: read.signature, chars: read.text.length, digest: digestOf(read.text), actions })
  return actions
}

/** The thread's actions, shared and frozen: a caller that changes one copies it first. */
export function readActions(threadDirectory: string): readonly ThreadAction[] {
  return current(threadDirectory)
}

/** The thread's actions as a new list of new objects the caller may change. */
export function readActionsCopy(threadDirectory: string): ThreadAction[] {
  return structuredClone(current(threadDirectory)) as ThreadAction[]
}

/**
 * Replaces the file with `actions`, unless the last read shows it already holds exactly these bytes and its signature
 * says it has not changed since. Nothing is read to decide: without a trusted read, the file is written.
 */
export function writeActions(threadDirectory: string, actions: readonly ThreadAction[]): void {
  const path = join(threadDirectory, ACTIONS_FILE)
  const text = `${JSON.stringify(actions, null, 2)}
`
  const cached = reads.get(path)
  if (cached?.chars === text.length && cached.digest === digestOf(text) && signatureOf(path) === cached.signature) return
  forget(path)
  actionsFileCounts.writes += 1
  atomicWriteFileSync(path, text)
}
