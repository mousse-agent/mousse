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
  if (typeof window.mousse.threads.attachmentPath !== 'function') throw new Error('Restart Mousse to attach files.')
  for (const attached of pending) {
    if (attached.path) {
      paths.set(attached.id, attached.path)
      continue
    }
    try {
      paths.set(attached.id, await stagedPath(attached.file, threadId ?? null))
    } catch (error) {
      throw new Error(ipcErrorLine(error) || `${attached.file.name} couldn't be attached.`)
    }
  }
  return paths
}

/**
 * Each file's path for a thread, asked once: a dropped or picked file answers its own path (no copy), a pasted one is
 * written to a temporary file. Kept by file while it is held, so staging at attach (`prestageImages`) is not done
 * again at send; a failed one is asked again.
 */
const staged = new WeakMap<File, Map<string, Promise<string>>>()

function stagedPath(file: File, threadId: string | null): Promise<string> {
  const byThread = staged.get(file) ?? new Map<string, Promise<string>>()
  staged.set(file, byThread)
  const key = threadId ?? ''
  let path = byThread.get(key)
  if (!path) {
    const stage = window.mousse.threads.attachmentPath as (file: File, threadId?: string | null) => Promise<string>
    path = stage(file, threadId)
    byThread.set(key, path)
    path.catch(() => { if (byThread.get(key) === path) byThread.delete(key) })
  }
  return path
}

/**
 * Writes the attached images that have no path of their own (pasted ones) to temporary files as they are attached,
 * so the send, which names every inline image's file as well, does not wait for it. Failures wait for the send,
 * which tries again and says why.
 */
export function prestageImages(files: readonly ComposerFile[], threadId: string | null | undefined): void {
  if (typeof window.mousse?.threads?.attachmentPath !== 'function') return
  for (const attached of files) {
    if (attached.path || attached.asPath || !sentInline(attached.file)) continue
    if (window.mousse.fileDrag?.pathOf?.(attached.file)) continue
    void stagedPath(attached.file, threadId ?? null).catch(() => undefined)
  }
}
