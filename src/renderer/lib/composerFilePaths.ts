import { ipcErrorLine } from './errorText'
import { isInlineCandidate } from './attachmentPreparation'

/** What a thread's composer says when files are attached to a thread whose agent runs on another computer. */
export const REMOTE_FILES_REFUSAL = "Files can't be attached to threads on another computer yet."

/** What it says when a message is longer than a thread takes. */
export const MESSAGE_TOO_LONG = 'This message is too long to send. Shorten it, or paste the long text so it goes as a file.'

/** What it says when pasted text, written into the message for a thread on another computer, makes it too long. */
export const REMOTE_PASTE_TOO_LONG = 'This pasted text is too long for a thread on another computer.'

/** A file the composer holds: its bytes, or (given back from a queued message) only its path. */
interface ComposerFile {
  id: string
  file: File
  path?: string
  /** What the message calls the file, when not its file name. */
  label?: string
  /** An image sent as its path, not inline (`preparedSend`). */
  asPath?: boolean
}

/** An image the model receives inline (a vision payload, fitted at attach: `attachmentPreparation.ts`); every other file is sent as its path. */
export function sentInline(file: File): boolean {
  return isInlineCandidate(file)
}

/** The files sent as paths, not inline. */
export function fileAttachments<T extends ComposerFile>(files: readonly T[]): T[] {
  return files.filter((attached) => attached.asPath || attached.path !== undefined || !sentInline(attached.file))
}

/**
 * Each path-sent file's path on this computer, by attached id: its own path when it has one (dropped, picked, or
 * given back with a path), else a temporary copy written for the thread. Throws with a line to show when a file
 * can't be staged.
 */
export async function composerFilePaths(files: readonly ComposerFile[], threadId: string | null | undefined): Promise<Map<string, string>> {
  const pending = fileAttachments(files)
  const paths = new Map<string, string>()
  if (!pending.length) return paths
  const stage = window.mousse.threads.attachmentPath as ((file: File, threadId?: string | null) => Promise<string>) | undefined
  for (const attached of pending) {
    if (attached.path) {
      paths.set(attached.id, attached.path)
      continue
    }
    if (!stage) throw new Error('Restart Mousse to attach files.')
    try {
      paths.set(attached.id, await stage(attached.file, threadId ?? null))
    } catch (error) {
      throw new Error(ipcErrorLine(error) || `${attached.file.name} couldn't be attached.`)
    }
  }
  return paths
}
