import { randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { attachedFilesIn } from '../shared/attachedFilesMarker'
import { attachmentFileName } from '../shared/bots/personal/attachments'
import { isQualifiedId } from '../shared/threadRef'
import { MAX_DRAG_BYTES, type FileDragItem, type FileDragRequest } from '../shared/fileDrag'

/**
 * A file dragged out of the window into Finder, File Explorer or another app. The window names what it drags; this
 * process decides which file on disk that is, and only ever hands the system a file that belongs to the thread:
 *
 * - `workspace`: a file or folder of the thread's (or project's) folder, named relative to it. A path that leaves the
 *   folder, also through a symbolic link, is refused.
 * - `attachment`: a file a message or the composer names by its path. It must be in the thread's folder, in the
 *   folder where Mousse keeps the thread's pasted files, or named as an attached file by one of the thread's messages.
 *   When the chip calls it by another name (a pasted file is kept as `1a2b3c4d-notes.txt`), a copy with the chip's name
 *   is dragged instead.
 * - `bytes`: a file that has no path, such as a pasted image kept only in the conversation. It is written to a
 *   temporary folder under its own name.
 *
 * A thread on another computer has its files there: its `workspace` and `attachment` items are refused, and the window
 * keeps its own drag instead. Temporary copies are removed a day later.
 */

export interface FileDragDeps {
  /** The system's temporary folder. */
  temp: string
  /** The folder the Files panel shows for the thread or project; undefined when it has none. */
  filesRoot(scope: { threadId?: string; projectId?: string }): Promise<string | undefined>
  /** The texts of the thread's messages, where `[Attached files: …]` names each sent file's path. */
  messageTexts(threadId: string): Promise<string[]>
  now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Where dragged copies go, one folder per drag, so each keeps its own name. */
export const DRAG_FOLDER = 'mousse-drag'
/** Where a thread's pasted files are kept (`stageThreadAttachment`). */
const STAGED_FOLDER = 'mousse-attachments'
const THREAD_FOLDER = /^[A-Za-z0-9_-]{1,128}$/

export class FileDragRefused extends Error {}

const refuse = (text: string): never => {
  throw new FileDragRefused(text)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const plainPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')

/** The request as the window sent it, checked; refused when it is not one. */
export function fileDragRequest(value: unknown): FileDragRequest {
  if (!isRecord(value) || !isRecord(value.item)) return refuse('That is not a file Mousse can drag.')
  const threadId = typeof value.threadId === 'string' && value.threadId ? value.threadId : undefined
  const projectId = typeof value.projectId === 'string' && value.projectId ? value.projectId : undefined
  const raw = value.item
  let item: FileDragItem | undefined
  if (raw.kind === 'workspace' && plainPath(raw.path)) item = { kind: 'workspace', path: raw.path }
  else if (raw.kind === 'attachment' && plainPath(raw.path) && isAbsolute(raw.path)) {
    item = { kind: 'attachment', path: raw.path, ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}) }
  } else if (raw.kind === 'bytes' && typeof raw.name === 'string' && raw.name && raw.name.length <= 256) {
    const data = raw.data instanceof Uint8Array ? raw.data : raw.data instanceof ArrayBuffer ? new Uint8Array(raw.data) : null
    if (data) {
      if (data.byteLength > MAX_DRAG_BYTES) refuse(`${raw.name} is too large to drag.`)
      item = { kind: 'bytes', name: raw.name, data }
    }
  }
  if (!item) return refuse('That is not a file Mousse can drag.')
  return { ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}), item }
}

/** True when `path` is `folder` or inside it. Both are real paths. */
function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** The real path of `path`, or undefined when nothing is there. */
const real = (path: string): Promise<string | undefined> => realpath(path).catch(() => undefined)

/** Removes drag folders made more than a day ago. Best effort. */
async function sweep(root: string, now: number): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[])
  await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry)
    const info = await stat(path).catch(() => undefined)
    if (info && now - info.mtimeMs > DAY_MS) await rm(path, { recursive: true, force: true }).catch(() => undefined)
  }))
}

/** A new folder for one drag, under the temporary folder. */
async function dragFolder(deps: FileDragDeps): Promise<string> {
  const root = join(deps.temp, DRAG_FOLDER)
  await sweep(root, (deps.now ?? Date.now)())
  const folder = join(root, randomUUID())
  await mkdir(folder, { recursive: true, mode: 0o700 })
  return folder
}

/** `source` under `name` in a new drag folder: a hard link when the disk allows one, else a copy. */
async function namedCopy(source: string, name: string, deps: FileDragDeps): Promise<string> {
  const target = join(await dragFolder(deps), attachmentFileName(name))
  await link(source, target).catch(() => copyFile(source, target))
  return target
}

/** The thread's or project's folder, as a real path. */
async function workspaceRoot(request: FileDragRequest, deps: FileDragDeps): Promise<string | undefined> {
  const scope = request.threadId ? { threadId: request.threadId } : request.projectId ? { projectId: request.projectId } : undefined
  if (!scope) return undefined
  const root = await deps.filesRoot(scope).catch(() => undefined)
  return root ? real(root) : undefined
}

/**
 * The path on this computer to hand the system for a drag, checked as the module comment says. Writes a temporary
 * copy when the item has no file of its own or the file has another name. Throws `FileDragRefused` otherwise.
 */
export async function dragFilePath(value: unknown, deps: FileDragDeps): Promise<string> {
  const request = fileDragRequest(value)
  const { item } = request
  if (item.kind === 'bytes') {
    const target = join(await dragFolder(deps), attachmentFileName(item.name))
    // The folder is private; the file keeps ordinary permissions, as the dropped copy does.
    await writeFile(target, item.data, { flag: 'wx' })
    return target
  }
  if (isQualifiedId(request.threadId) || isQualifiedId(request.projectId)) refuse('Files of a thread on another computer are not dragged out.')

  const root = await workspaceRoot(request, deps)
  if (item.kind === 'workspace') {
    if (!root) return refuse('This thread has no folder to drag from.')
    const path = isAbsolute(item.path) ? item.path : resolve(root, item.path)
    const found = await real(path)
    if (!found || !inside(root, found)) return refuse(`${basename(item.path)} is not in this thread's folder.`)
    const info = await stat(found)
    if (!info.isFile() && !info.isDirectory()) refuse(`${basename(item.path)} is not a file or folder.`)
    return path
  }

  const found = await real(item.path)
  if (!found) return refuse(`Can't find ${basename(item.path)}. It may have been moved or deleted.`)
  if (!(await stat(found)).isFile()) refuse(`${basename(item.path)} is not a file.`)
  const thread = request.threadId && THREAD_FOLDER.test(request.threadId) ? request.threadId : 'new'
  const staged = await real(join(deps.temp, STAGED_FOLDER, thread))
  const allowed = (root && inside(root, found))
    || (staged && inside(staged, found))
    || (request.threadId && (await deps.messageTexts(request.threadId).catch(() => [] as string[]))
      .some((text) => attachedFilesIn(text).some((entry) => entry.path === item.path)))
  if (!allowed) refuse(`${basename(item.path)} is not a file of this thread.`)
  return item.name && attachmentFileName(item.name) !== basename(item.path) ? namedCopy(found, item.name, deps) : item.path
}
