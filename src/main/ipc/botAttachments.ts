import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachmentFileName, attachmentTooLargeText } from '../../shared/bots/personal/attachments'
import { MAX_BOT_CHAT_ATTACHMENT_BYTES } from '../../shared/bots/personal/methods'
import { MAX_STAGED_FILE_BYTES, stagedFileTooLargeText } from '../../shared/attachedFilesMarker'

const DAY_MS = 24 * 60 * 60 * 1000
/** How long a pasted file waits in the temporary folder; the service has copied it long before. */
const BOT_KEEP_MS = DAY_MS
/** A thread's agent reads a pasted file where it was staged, so it stays a week after the thread's last paste. */
const THREAD_KEEP_MS = 7 * DAY_MS
/** A thread id as a folder name: nothing that leaves the folder. */
const THREAD_FOLDER = /^[A-Za-z0-9_-]{1,128}$/

/** Removes what earlier pastes left in `root` more than `keepMs` ago. Best effort. */
function sweep(root: string, now: number, keepMs: number): void {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry)
    try {
      if (now - statSync(path).mtimeMs > keepMs) rmSync(path, { recursive: true, force: true })
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/** A pasted file's name and bytes as the renderer sent them: a string name, and bytes up to `max`. */
function pasted(name: unknown, bytes: unknown, max: number, tooLarge: (name: string) => string): { name: string; data: Uint8Array } {
  if (typeof name !== 'string' || !name.trim() || name.length > 256) throw new Error('A pasted file needs a name.')
  const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null
  if (!data) throw new Error('A pasted file needs its bytes.')
  if (data.byteLength > max) throw new Error(tooLarge(name))
  return { name, data }
}

/**
 * Writes a file pasted into a bot's composer (it has no path on this computer) to
 * `<temp>/mousse-bot-attachments/<id>/<name>` and returns that path, so `bots.chat.send` names it
 * like a picked file; the service then copies it into the bot's files folder. The request comes from
 * the renderer: only a string name and bytes up to the attachment limit are taken.
 */
export function stageBotAttachment(temp: string, name: unknown, bytes: unknown, now = Date.now()): string {
  const file = pasted(name, bytes, MAX_BOT_CHAT_ATTACHMENT_BYTES, attachmentTooLargeText)
  const root = join(temp, 'mousse-bot-attachments')
  sweep(root, now, BOT_KEEP_MS)
  const folder = join(root, randomUUID())
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const path = join(folder, attachmentFileName(file.name))
  writeFileSync(path, file.data, { flag: 'wx', mode: 0o600 })
  return path
}

/**
 * Writes a file pasted into a thread's composer (it has no path on this computer) to
 * `<temp>/mousse-attachments/<thread>/<unique>-<name>` and returns that path, which the message names for the
 * thread's agent. A message for a thread not made yet uses `new`. Thread folders untouched for a week are removed.
 */
export async function stageThreadAttachment(temp: string, threadId: unknown, name: unknown, bytes: unknown, now = Date.now()): Promise<string> {
  const file = pasted(name, bytes, MAX_STAGED_FILE_BYTES, stagedFileTooLargeText)
  const thread = threadId === undefined || threadId === null || threadId === '' ? 'new' : threadId
  if (typeof thread !== 'string' || !THREAD_FOLDER.test(thread)) throw new Error('A pasted file needs a thread.')
  const root = join(temp, 'mousse-attachments')
  sweep(root, now, THREAD_KEEP_MS)
  const folder = join(root, thread)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const path = join(folder, `${randomUUID().slice(0, 8)}-${attachmentFileName(file.name)}`)
  await writeFile(path, file.data, { flag: 'wx', mode: 0o600 })
  return path
}
