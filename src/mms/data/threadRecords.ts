/**
 * The records the lifecycle code reads from a thread folder (agents, subagent sessions, messages that embed
 * artifacts), wherever the thread keeps them: its JSON files, or `thread.db`. A record kept in the database is named
 * `<folder>/thread.db#<file name>`, so ownership evidence still names one source per record.
 */
import { existsSync, lstatSync, readFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { sharedThreadDbClient } from './threadDb/threadDbClient'
import { THREAD_DB_FILE } from './threadDb/threadDbEngine'

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

/** `readThreadRecordSync` for a caller that can wait; a file is read without blocking. */
export async function readThreadRecord(path: string): Promise<unknown> {
  const parts = split(path)
  if (!parts) return JSON.parse(await readFile(path, 'utf8')) as unknown
  return sharedThreadDbClient().call('readRecord', parts.location, parts.name, parts.name === 'messages.json' ? ARTIFACT_MARKERS : [])
}
