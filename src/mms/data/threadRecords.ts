/**
 * The records the lifecycle code reads from a thread folder (agents, subagent sessions, messages that embed
 * artifacts), wherever the thread keeps them: its JSON files, or `thread.db`. A record kept in the database is named
 * `<folder>/thread.db#<file name>`, so ownership evidence still names one source per record.
 */
import { existsSync, lstatSync, readFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { sharedThreadDbClient, threadDbWriteCount } from './threadDb/threadDbClient'
import { THREAD_DB_FILE } from './threadDb/threadDbEngine'
import { stampOf } from './threadDb/threadIndex'

const SEPARATOR = '#'

/** Strings that mark a transcript row as embedding an artifact; see `ResourceInventory`. */
export const ARTIFACT_MARKERS = ['"sha256"', '"artifactId"', '"artifactRef"', '"blobId"']

/** Where a thread's record lives: the JSON file, or the record inside the thread's database. */
export function threadRecordPath(location: string, name: string): string {
  return existsSync(join(location, THREAD_DB_FILE)) ? `${join(location, THREAD_DB_FILE)}${SEPARATOR}${name}` : join(location, name)
}

function split(path: string): { location: string; name: string } | undefined {
  const index = path.lastIndexOf(`${THREAD_DB_FILE}${SEPARATOR}`)
  if (index < 0) return undefined
  return { location: dirname(path.slice(0, index + THREAD_DB_FILE.length)), name: path.slice(index + THREAD_DB_FILE.length + 1) }
}

/** The file name a record path stands for (`agents.json` for both a file and a database record). */
export function threadRecordName(path: string): string {
  return split(path)?.name ?? basename(path)
}

/** The folder a record path belongs to. */
export function threadRecordFolder(path: string): string {
  return split(path)?.location ?? dirname(path)
}

/** The file on disk that holds the record (the database for a database record). */
export function threadRecordFile(path: string): string {
  const parts = split(path)
  return parts ? join(parts.location, THREAD_DB_FILE) : path
}

/**
 * Reads a record: the raw text its evidence digest is taken from, and the parsed value. `undefined` when there is no
 * such record. Database records are read by the write worker and its connection is closed again.
 */
export function readThreadRecordSync(path: string): { raw: string; data: unknown } | undefined {
  const parts = split(path)
  if (!parts) {
    if (!existsSync(path)) return undefined
    const raw = readFileSync(path, 'utf8')
    return { raw, data: JSON.parse(raw) as unknown }
  }
  const stat = lstatSync(join(parts.location, THREAD_DB_FILE))
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Thread database is not a regular file')
  const data = sharedThreadDbClient().callSync('readRecord', parts.location, parts.name, parts.name === 'messages.json' ? ARTIFACT_MARKERS : [])
  if (data === undefined) return undefined
  return { raw: JSON.stringify(data), data }
}

/** The raw text of a thread's lifecycle records, as last read from its database with the stamp it had then. */
interface LifecycleRecordsText { stamp: string; agents?: string; sessions?: string; messages: string; size: number }

/**
 * The lifecycle records last read from each thread's database, by folder. An ownership pass reads every thread's
 * records, and a pass runs for each receipt released and each cleanup; opening every database each time made a pass
 * take seconds on the main thread with a few hundred threads. A database whose stamp (`stampOf`) is unchanged holds
 * the same records, so only the text is kept and each caller gets freshly parsed copies. Bounded: past the cap, the
 * records of further threads are read each time, as before.
 */
const lifecycleRecordsCache = new Map<string, LifecycleRecordsText>()
let lifecycleRecordsCacheSize = 0
const LIFECYCLE_RECORDS_CACHE_MAX_CHARS = 16 * 1024 * 1024

/** For tests: how many times a thread's records were read from its database. */
export const lifecycleRecordReads = { count: 0 }

/**
 * Reads `agents.json`, `mousse-agent-sessions.json` and artifact-bearing `messages.json` from a thread's database
 * in a single worker call and database open, or from what that read returned while the database is unchanged.
 */
export function readThreadLifecycleRecordsSync(location: string): {
  agents?: { raw: string; data: unknown }
  sessions?: { raw: string; data: unknown }
  messages: { raw: string; data: unknown }
} {
  const stat = lstatSync(join(location, THREAD_DB_FILE))
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Thread database is not a regular file')
  // Taken before the read: a write during or after it gives the next pass a different stamp. This process's own writes
  // are counted too, whatever the file system's time resolution (`threadDbWriteCount`).
  const stamp = `${stampOf(location)}|${threadDbWriteCount(location)}`
  let text = lifecycleRecordsCache.get(location)
  if (text?.stamp !== stamp) {
    lifecycleRecordReads.count += 1
    const loaded = sharedThreadDbClient().callSync('readLifecycleRecords', location, ARTIFACT_MARKERS) as { agents?: unknown; sessions?: unknown; messages: unknown[] }
    const agents = loaded.agents !== undefined ? JSON.stringify(loaded.agents) : undefined
    const sessions = loaded.sessions !== undefined ? JSON.stringify(loaded.sessions) : undefined
    const messages = loaded.messages.length ? JSON.stringify(loaded.messages) : '[]'
    const fresh: LifecycleRecordsText = { stamp, ...(agents !== undefined ? { agents } : {}), ...(sessions !== undefined ? { sessions } : {}), messages, size: (agents?.length ?? 0) + (sessions?.length ?? 0) + messages.length }
    if (text) {
      lifecycleRecordsCache.delete(location)
      lifecycleRecordsCacheSize -= text.size
    }
    if (lifecycleRecordsCacheSize + fresh.size <= LIFECYCLE_RECORDS_CACHE_MAX_CHARS) {
      lifecycleRecordsCache.set(location, fresh)
      lifecycleRecordsCacheSize += fresh.size
    }
    text = fresh
  }
  return {
    ...(text.agents !== undefined ? { agents: { raw: text.agents, data: JSON.parse(text.agents) as unknown } } : {}),
    ...(text.sessions !== undefined ? { sessions: { raw: text.sessions, data: JSON.parse(text.sessions) as unknown } } : {}),
    messages: { raw: text.messages, data: JSON.parse(text.messages) as unknown }
  }
}

/** `readThreadRecordSync` for a caller that can wait; a file is read without blocking. */
export async function readThreadRecord(path: string): Promise<unknown> {
  const parts = split(path)
  if (!parts) return JSON.parse(await readFile(path, 'utf8')) as unknown
  return sharedThreadDbClient().call('readRecord', parts.location, parts.name, parts.name === 'messages.json' ? ARTIFACT_MARKERS : [])
}
