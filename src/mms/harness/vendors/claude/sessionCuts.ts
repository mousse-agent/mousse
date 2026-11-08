import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Issue #360: where an undo, an edit or a fork cuts a Claude Code session. Claude Code keeps each
 * session as a JSONL file of entries chained by `parentUuid`; a prompt Mousse pushes is written under
 * the `uuid` Mousse gave it. A turn's last entry is often one Claude Code never streams (an
 * attachment), so a cut is read from the file: the entry the first left-out prompt follows.
 *
 * Reads only, and only the session files of the home a turn runs with (`CLAUDE_CONFIG_DIR`): the SDK's
 * own session helpers read the home of the Mousse process once, so they cannot serve an entry with a
 * home of its own.
 */

/** One turn in a saved session's conversation: the prompt Mousse pushed (absent on a turn Claude started) and the history fingerprint it left. */
export type SessionTurn = { prompt?: string; key?: string }

/** How many turns a saved session remembers; an undo or a fork further back replays the history as text. */
export const KEPT_TURNS = 64

/** The Claude Code home a process started with `env` keeps its sessions in. */
export function claudeHomeOf(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

/** The session's file under any project folder of `home`, or undefined. */
export function sessionFileOf(home: string, sessionId: string): string | undefined {
  const projects = join(home, 'projects')
  let folders: string[]
  try {
    folders = readdirSync(projects)
  } catch {
    return undefined
  }
  for (const folder of folders) {
    const file = join(projects, folder, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return undefined
}

type Entry = { uuid?: unknown; parentUuid?: unknown; isSidechain?: unknown }

function entries(file: string): Entry[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // A file Mousse cannot read (removed meanwhile, no permission) holds no cut: the history goes in as text.
    return []
  }
  const parsed: Entry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (entry && typeof entry === 'object') parsed.push(entry as Entry)
    } catch {
      // A line cut short by a write in progress names no entry.
    }
  }
  return parsed
}

/**
 * Where to cut `sessionId` so that `prompt` and everything after it are left out: the entry the
 * prompt follows. Undefined when the session's file, the prompt or its parent is not found.
 */
export function cutBefore(home: string, sessionId: string, prompt: string): string | undefined {
  const file = sessionFileOf(home, sessionId)
  if (!file) return undefined
  const entry = entries(file).find((candidate) => candidate.uuid === prompt)
  return typeof entry?.parentUuid === 'string' && entry.parentUuid ? entry.parentUuid : undefined
}

/** The session's last entry on its main chain now: a cut that keeps everything written so far. */
export function sessionEnd(home: string, sessionId: string): string | undefined {
  const file = sessionFileOf(home, sessionId)
  if (!file) return undefined
  const all = entries(file)
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const entry = all[index]
    // Entries of the conversation all carry `parentUuid` (null on the first). Metadata Claude Code
    // writes beside them, such as a `custom-title`, can have an id of its own but none.
    if (typeof entry.uuid === 'string' && entry.uuid && 'parentUuid' in entry && entry.isSidechain !== true) return entry.uuid
  }
  return undefined
}

/** Claude Code refused to resume at a cut: the session's file or the cut entry is gone. */
export function cutRefused(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /No conversation found with session ID|No message found with message\.uuid/.test(message)
}
