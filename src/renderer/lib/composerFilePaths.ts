import { isImageMimeType } from '../utils/imageAttachments'
import { ipcErrorLine } from './errorText'

/** What a thread's composer says when files are attached to a thread whose agent runs on another computer. */
export const REMOTE_FILES_REFUSAL = "Files can't be attached to threads on another computer yet."

/** What it says when pasted text, written into the message for a thread on another computer, makes it too long. */
export const REMOTE_PASTE_TOO_LONG = 'This pasted text is too long for a thread on another computer.'

/** A file the composer holds: its bytes, or (given back from a queued message) only its path. */
interface ComposerFile {
  id: string
  file: File
  path?: string
}

/** An image the model receives inline (a vision payload); every other file is sent as its path. */
export function sentInline(file: File): boolean {
  return isImageMimeType(file.type)
}

/** The files sent as paths, not inline. */
export function fileAttachments<T extends ComposerFile>(files: readonly T[]): T[] {
  return files.filter((attached) => !sentInline(attached.file))
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
