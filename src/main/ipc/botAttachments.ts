import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachmentFileName, attachmentTooLargeText } from '../../shared/bots/personal/attachments'
import { MAX_BOT_CHAT_ATTACHMENT_BYTES } from '../../shared/bots/personal/methods'

/** How long a pasted file waits in the temporary folder; the service has copied it long before. */
const KEEP_MS = 24 * 60 * 60 * 1000

/** Removes what earlier pastes left in `root` more than a day ago. Best effort. */
function sweep(root: string, now: number): void {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry)
    try {
      if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { recursive: true, force: true })
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * Writes a file pasted into a bot's composer (it has no path on this computer) to
 * `<temp>/mousse-bot-attachments/<id>/<name>` and returns that path, so `bots.chat.send` names it
 * like a picked file; the service then copies it into the bot's files folder. The request comes from
 * the renderer: only a string name and bytes up to the attachment limit are taken.
 */
export function stageBotAttachment(temp: string, name: unknown, bytes: unknown, now = Date.now()): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 256) throw new Error('A pasted file needs a name.')
  const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null
  if (!data) throw new Error('A pasted file needs its bytes.')
  if (data.byteLength > MAX_BOT_CHAT_ATTACHMENT_BYTES) throw new Error(attachmentTooLargeText(name))
  const root = join(temp, 'mousse-bot-attachments')
  sweep(root, now)
  const folder = join(root, randomUUID())
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const path = join(folder, attachmentFileName(name))
  writeFileSync(path, data, { flag: 'wx', mode: 0o600 })
  return path
}
