/** What the window drags out to another app, for the app's main process to turn into a file on disk (`src/main/fileDrag.ts`). */
export type FileDragItem =
  /** A file or folder of the thread's (or project's) folder, relative to it. */
  | { kind: 'workspace'; path: string }
  /** A file a message or the composer names by its absolute path; `name` is what the chip calls it. */
  | { kind: 'attachment'; path: string; name?: string }
  /** A file with no path of its own (a pasted image): its name and bytes. */
  | { kind: 'bytes'; name: string; data: Uint8Array }

export interface FileDragRequest {
  threadId?: string
  projectId?: string
  item: FileDragItem
}

/** What starting a drag answers: the path the system was handed, or why nothing was dragged. */
export type FileDragAnswer = { path: string } | { refused: string }

/** The largest file the window hands over as bytes to drag out. A larger composer file is dragged by its path. */
export const MAX_DRAG_BYTES = 64 * 1024 * 1024
