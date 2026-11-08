import { constants, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { attachmentFileName, attachmentTooLargeText } from '../../../shared/bots/personal/attachments'
import { MAX_BOT_CHAT_ATTACHMENT_BYTES, type BotChatAttachment } from '../../../shared/bots/personal/methods'
import { BotEngineError } from '../activation/BotEngine'

/** A file copied for the bot: the name the owner gave it and where its copy is. */
export interface SavedBotAttachment {
  name: string
  path: string
}

function day(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Refuses the message when a file is gone, is a folder, or is over the size limit; nothing is copied then. */
function checkAttachment(file: BotChatAttachment): void {
  let stat
  try {
    stat = statSync(file.path)
  } catch {
    throw new BotEngineError('bot_attachment_refused', `${file.name} is no longer there.`)
  }
  if (stat.isDirectory()) throw new BotEngineError('bot_attachment_refused', `${file.name} is a folder. Attach the files in it instead.`)
  if (!stat.isFile()) throw new BotEngineError('bot_attachment_refused', `${file.name} is not a file.`)
  if (stat.size > MAX_BOT_CHAT_ATTACHMENT_BYTES) throw new BotEngineError('bot_attachment_refused', attachmentTooLargeText(file.name))
}

/**
 * Copies the files of one chat message into the bot's files folder, under `attachments/<date>/`, so
 * the bot reads them with the files folder its grant always holds, and never needs the folder the
 * owner keeps them in. A name already taken that day gets " (2)", " (3)", … before its extension;
 * nothing is overwritten.
 */
export function copyBotAttachments(filesFolder: string, files: readonly BotChatAttachment[], now: number): SavedBotAttachment[] {
  for (const file of files) checkAttachment(file)
  const folder = join(filesFolder, 'attachments', day(now))
  const saved: SavedBotAttachment[] = []
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    for (const file of files) {
      const name = attachmentFileName(file.name)
      const ext = extname(name)
      const stem = name.slice(0, name.length - ext.length)
      for (let copy = 1; ; copy += 1) {
        const path = join(folder, copy === 1 ? name : `${stem} (${copy})${ext}`)
        try {
          copyFileSync(file.path, path, constants.COPYFILE_EXCL)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw error
        }
        saved.push({ name: file.name, path })
        break
      }
    }
  } catch (error) {
    removeBotAttachments(saved)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOSPC' || code === 'EDQUOT') throw new BotEngineError('storage_full', 'I can\'t save your files. Free some disk space.')
    throw new BotEngineError('bot_attachment_refused', `I can't save your files: ${(error as Error).message}`)
  }
  return saved
}

/** Removes copies `copyBotAttachments` made for a message that was never recorded. */
export function removeBotAttachments(saved: readonly SavedBotAttachment[]): void {
  for (const file of saved) rmSync(file.path, { force: true })
}
