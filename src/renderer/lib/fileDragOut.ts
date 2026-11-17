import type { DragEvent } from 'react'
import { attachmentFileName } from '../../shared/bots/personal/attachments'
import type { ChatReference } from '../../shared/chatReferences'
import type { FileDragAnswer, FileDragItem } from '../../shared/fileDrag'
import { isQualifiedId } from '../../shared/threadRef'

/**
 * Dragging a file out of the window into Finder, File Explorer or another app. A row or chip's `dragstart` cancels the
 * window's own drag and asks the app to start the system's drag of the real file (`window.mousse.fileDrag`). That drag
 * can also be dropped back on the window: the composer then asks `ownFileDrop` what it was, so a file tree row still
 * adds its reference there and a composer chip is not attached twice.
 */

/** What a drag dropped back on the composer means. Absent: an ordinary dropped file, attached. */
export type InAppDrop =
  | { kind: 'reference'; reference: Omit<ChatReference, 'id'> & { id?: string } }
  /** Dropped where it already is (a composer chip on its composer): nothing happens. */
  | { kind: 'ignore' }

type Bridge = NonNullable<Window['mousse']>['fileDrag']

export interface DragOut {
  /** The file's name as the window shows it; a drop back on the window is matched by it until the path is known. */
  name: string
  threadId?: string | null
  projectId?: string | null
  /**
   * What is dragged: a file of the thread's folder or an attached file by its path (both read on this computer, so not
   * dragged from a thread on another one), or bytes the window holds, read when the drag starts.
   */
  item?: FileDragItem | (() => Promise<FileDragItem>)
  /** Instead of `item`: a file the composer holds, handed over by the app's own bridge. */
  composerFile?: File
  inApp?: InAppDrop
}

interface Outgoing {
  names: string[]
  path?: string
  inApp?: InAppDrop
}

let outgoing: Outgoing | null = null
let listening = false

/** Once the mouse moves with no button down, or is pressed again, the drag is over wherever it ended. */
function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('mousemove', (event) => { if (event.buttons === 0) outgoing = null }, true)
  window.addEventListener('mousedown', () => { outgoing = null }, true)
}

const scopeOf = (drag: DragOut): { threadId?: string; projectId?: string } => ({
  ...(drag.threadId ? { threadId: drag.threadId } : {}),
  ...(drag.projectId ? { projectId: drag.projectId } : {})
})

/** True when the item names a file on the computer that runs the thread. */
const readsThreadFiles = (drag: DragOut): boolean =>
  !drag.composerFile && typeof drag.item === 'object' && drag.item.kind !== 'bytes'

/**
 * Turns a `dragstart` into the system's drag of a file. False when the window keeps its own drag instead: no bridge
 * (an older app), or a file that lives on another computer.
 */
export function startDragOut(event: Pick<DragEvent, 'preventDefault'>, drag: DragOut, bridge: Bridge | undefined = window.mousse?.fileDrag): boolean {
  const { item, composerFile } = drag
  if (!bridge || (!item && !composerFile)) return false
  if (readsThreadFiles(drag) && (isQualifiedId(drag.threadId) || isQualifiedId(drag.projectId))) return false
  event.preventDefault()
  listen()
  const drop: Outgoing = { names: [drag.name, attachmentFileName(drag.name)], ...(drag.inApp ? { inApp: drag.inApp } : {}) }
  outgoing = drop
  const scope = scopeOf(drag)
  const started: Promise<FileDragAnswer> = composerFile
    ? bridge.startComposerFile(composerFile, scope)
    : (typeof item === 'function' ? item() : Promise.resolve(item!)).then((resolved) => bridge.start({ ...scope, item: resolved }))
  void started.then(
    (answer) => {
      if ('path' in answer) drop.path = answer.path
      else {
        if (outgoing === drop) outgoing = null
        console.warn(`[drag] ${answer.refused}`)
      }
    },
    (error: unknown) => {
      if (outgoing === drop) outgoing = null
      console.warn('[drag] the file could not be dragged', error)
    }
  )
  return true
}

/**
 * When `files` dropped on the window are the file this window is dragging out, what that drag means here; undefined
 * for any other drop. Matched by path once the app said which file it dragged, by name before that (on Windows the
 * app answers only after the drop).
 */
export function ownFileDrop(files: readonly File[], pathOf: (file: File) => string = (file) => window.mousse?.fileDrag?.pathOf(file) ?? ''): InAppDrop | null | undefined {
  const drop = outgoing
  if (!drop || files.length !== 1) return undefined
  const file = files[0]!
  const ours = drop.path ? pathOf(file) === drop.path : drop.names.includes(file.name)
  if (!ours) return undefined
  outgoing = null
  return drop.inApp ?? null
}

/** The bytes and name of an image the window shows (a `data:` or `blob:` URL), as a file to drag. */
export async function imageDragItem(url: string, name: string | undefined): Promise<FileDragItem> {
  const data = url.startsWith('data:') ? dataUrlBytes(url) : new Uint8Array(await (await fetch(url)).arrayBuffer())
  const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? ''
  return { kind: 'bytes', name: imageFileName(name, mime), data }
}

function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(',')
  const body = url.slice(comma + 1)
  if (!/;base64$/i.test(url.slice(0, comma))) return new TextEncoder().encode(decodeURIComponent(body))
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif'
}

/** An image's name with an extension, so the dropped file opens as an image. */
export function imageFileName(name: string | undefined, mime: string): string {
  const base = name?.trim() || 'image'
  if (/\.[A-Za-z0-9]{1,5}$/.test(base)) return base
  return `${base}.${IMAGE_EXTENSIONS[mime.toLowerCase()] ?? 'png'}`
}
