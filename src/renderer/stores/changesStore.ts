import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ReviewScope } from '../../shared/review'
import { scopeIdFor, type ChangesScopeId } from '../components/changes/changesModel'

/** A line to scroll to once the file is open, for a comment pill that points at a diff. */
export interface ChangesReveal {
  path: string
  line: number
}

/**
 * A file to open once the scope's list is loaded, named as the caller knows it: absolute (a comment pill,
 * an agent's edit) or relative to the worktree. The panel maps it to a changed file; `line` scrolls to it.
 */
export interface ChangesFileTarget {
  path: string
  line?: number
}

export interface ChangesThreadState {
  /** The scope the user last picked here; a fresh open restores it unless a newer turn ended. */
  chosen: ChangesScopeId | null
  /** The scope on screen; null until the panel resolves one. */
  scopeId: ChangesScopeId | null
  /** The turn Last turn shows. It never moves by itself. */
  pinnedTurnId: string | null
  /** When the tab was last open on this thread (ms); null when never. */
  lastOpenedAt: number | null
  /** The one open file card. */
  openPath: string | null
  /** A scope an entry point asked for (a chat edit line, a comment pill); the panel applies it once. */
  requested?: ChangesScopeId
  pendingFile?: ChangesFileTarget
  reveal?: ChangesReveal
}

/** Scroll and expanded context of one file in one scope. */
export interface FileView {
  scrollTop?: number
  expanded?: boolean
}

/** At most this many viewed marks are kept; the oldest go first. */
export const VIEWED_LIMIT = 3000

interface ChangesStoreState {
  byThread: Record<string, ChangesThreadState>
  /** `viewedKey` → the file's version when it was marked viewed. */
  viewed: Record<string, string>
  /** `viewedKey` → scroll and expanded context; kept for the session only. */
  fileViews: Record<string, FileView>
  /** Shows one turn of the thread (a chat edit line); `file` opens that file. */
  openTurn: (threadId: string, turnId: string, file?: string) => void
  /** Shows the whole thread since its base; `file` opens that file. */
  openThread: (threadId: string, file?: string) => void
  /** The user picked a scope; Last turn pins to `pinTurnId`. */
  choose: (threadId: string, scopeId: ChangesScopeId, pinTurnId?: string | null) => void
  /** The panel settled on a scope by itself (a default or a request): not the user's choice. */
  show: (threadId: string, scopeId: ChangesScopeId, pinTurnId?: string | null) => void
  takeRequest: (threadId: string) => ChangesScopeId | undefined
  markOpened: (threadId: string, at: number) => void
  setOpenPath: (threadId: string, path: string | null) => void
  /** A comment pill was clicked: switches to the scope it was made on and remembers its file by absolute path. */
  revealComment: (threadId: string, target: { scope: ReviewScope; absolutePath: string; line: number }) => void
  /** Opens the changed file the pending file maps to and asks for a scroll to its line; null drops the request. */
  resolvePendingFile: (threadId: string, path: string | null) => void
  /** Returns the pending reveal for the file once; later calls get nothing. */
  takeReveal: (threadId: string, path: string) => ChangesReveal | undefined
  markViewed: (key: string, version: string) => void
  clearViewed: (key: string) => void
  saveFileView: (key: string, view: FileView) => void
}

const emptyThread = (): ChangesThreadState => ({ chosen: null, scopeId: null, pinnedTurnId: null, lastOpenedAt: null, openPath: null })

function update(byThread: Record<string, ChangesThreadState>, threadId: string, patch: Partial<ChangesThreadState>): Record<string, ChangesThreadState> {
  return { ...byThread, [threadId]: { ...(byThread[threadId] ?? emptyThread()), ...patch } }
}

/** Keeps the newest `VIEWED_LIMIT` marks; object keys keep insertion order, so the oldest are first. */
export function capViewed(viewed: Record<string, string>, limit = VIEWED_LIMIT): Record<string, string> {
  const keys = Object.keys(viewed)
  if (keys.length <= limit) return viewed
  return Object.fromEntries(keys.slice(keys.length - limit).map((key) => [key, viewed[key]]))
}

const storage = createJSONStorage(() =>
  typeof window !== 'undefined' && window.localStorage
    ? window.localStorage
    : { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
)

/** Per-thread state of the Changes tab. The user's scope choice and viewed marks survive a restart. */
export const useChangesStore = create<ChangesStoreState>()(
  persist(
    (set, get) => ({
      byThread: {},
      viewed: {},
      fileViews: {},
      openTurn: (threadId, turnId, file) =>
        set((s) => {
          const pinned = s.byThread[threadId]?.pinnedTurnId ?? null
          return { byThread: update(s.byThread, threadId, { requested: scopeIdFor({ kind: 'turn', turnId }, pinned), openPath: null, pendingFile: file ? { path: file } : undefined }) }
        }),
      openThread: (threadId, file) =>
        set((s) => ({ byThread: update(s.byThread, threadId, { requested: 'thread', openPath: null, pendingFile: file ? { path: file } : undefined }) })),
      choose: (threadId, scopeId, pinTurnId) =>
        set((s) => ({
          byThread: update(s.byThread, threadId, {
            chosen: scopeId,
            scopeId,
            ...(scopeId === 'last' && pinTurnId !== undefined ? { pinnedTurnId: pinTurnId } : {})
          })
        })),
      show: (threadId, scopeId, pinTurnId) =>
        set((s) => ({
          byThread: update(s.byThread, threadId, { scopeId, ...(scopeId === 'last' && pinTurnId !== undefined ? { pinnedTurnId: pinTurnId } : {}) })
        })),
      takeRequest: (threadId) => {
        const requested = get().byThread[threadId]?.requested
        if (requested === undefined) return undefined
        set((s) => ({ byThread: update(s.byThread, threadId, { requested: undefined }) }))
        return requested
      },
      markOpened: (threadId, at) => set((s) => ({ byThread: update(s.byThread, threadId, { lastOpenedAt: at }) })),
      setOpenPath: (threadId, openPath) => set((s) => ({ byThread: update(s.byThread, threadId, { openPath }) })),
      revealComment: (threadId, { scope, absolutePath, line }) =>
        set((s) => {
          const pinned = s.byThread[threadId]?.pinnedTurnId ?? null
          return { byThread: update(s.byThread, threadId, { requested: scopeIdFor(scope, pinned), pendingFile: { path: absolutePath, line } }) }
        }),
      resolvePendingFile: (threadId, path) =>
        set((s) => {
          const current = s.byThread[threadId]
          if (!current?.pendingFile) return s
          const { pendingFile, ...rest } = current
          const next: ChangesThreadState = !path
            ? rest
            : pendingFile.line === undefined
              ? { ...rest, openPath: path }
              : { ...rest, openPath: path, reveal: { path, line: pendingFile.line } }
          return { byThread: { ...s.byThread, [threadId]: next } }
        }),
      takeReveal: (threadId, path) => {
        const pending = get().byThread[threadId]?.reveal
        if (!pending || pending.path !== path) return undefined
        set((s) => {
          const { reveal: _taken, ...rest } = s.byThread[threadId]
          return { byThread: { ...s.byThread, [threadId]: rest } }
        })
        return pending
      },
      markViewed: (key, version) =>
        set((s) => {
          const { [key]: _old, ...rest } = s.viewed
          return { viewed: capViewed({ ...rest, [key]: version }) }
        }),
      clearViewed: (key) =>
        set((s) => {
          if (!(key in s.viewed)) return s
          const { [key]: _old, ...rest } = s.viewed
          return { viewed: rest }
        }),
      saveFileView: (key, view) => set((s) => ({ fileViews: { ...s.fileViews, [key]: { ...s.fileViews[key], ...view } } }))
    }),
    {
      name: 'mousse-changes-tab',
      version: 1,
      storage,
      // Only the choice, the pin, when the tab was last open and the marks: not the open file or pending requests.
      partialize: (state) => ({
        viewed: state.viewed,
        byThread: Object.fromEntries(
          Object.entries(state.byThread).map(([threadId, thread]) => [
            threadId,
            { chosen: thread.chosen, scopeId: null, pinnedTurnId: thread.pinnedTurnId, lastOpenedAt: thread.lastOpenedAt, openPath: null }
          ])
        )
      }) as unknown as ChangesStoreState
    }
  )
)
