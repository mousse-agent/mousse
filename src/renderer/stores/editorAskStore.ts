import { useEffect } from 'react'
import { create } from 'zustand'
import type { EditorAskAnswerResult, EditorAskView } from '../../shared/bridge/editorAsk'
import type { NodeId } from '../../shared/net/ids'
import { answerEditorAsk, listEditorAsks, nextEditorAsk } from '../lib/editorAsks'

/** Backstop for a missed ask event. */
export const EDITOR_ASK_RECONCILE_MS = 30_000

interface EditorAskState {
  asks: EditorAskView[]
  /**
   * Asks closed without an answer, by computer, with the time each runs out. The prompt stays closed
   * until then; Settings → Devices still shows the ask.
   */
  dismissed: ReadonlyMap<string, number>
  busy: boolean
  error: string
  /** Computer the error belongs to, so it never shows on another ask. */
  errorNode?: string
  load: () => Promise<void>
  /** Resolves what the daemon answered, or undefined when the call failed. */
  answer: (node: NodeId, allow: boolean) => Promise<EditorAskAnswerResult | undefined>
  dismiss: (node: NodeId) => void
  /** Drops asks whose time ran out, and the closed marks of expired ones. */
  prune: (now?: number) => void
  reset: () => void
}

const message = (cause: unknown) => String((cause as Error | null)?.message ?? cause)

const forgetExpired = (marks: ReadonlyMap<string, number>, now: number): ReadonlyMap<string, number> => {
  const kept = new Map([...marks].filter(([, expiresAt]) => expiresAt > now))
  return kept.size === marks.size ? marks : kept
}

const forgetNode = (marks: ReadonlyMap<string, number>, node: string): ReadonlyMap<string, number> => {
  if (!marks.has(node)) return marks
  const kept = new Map(marks)
  kept.delete(node)
  return kept
}

let loading: { owner: number; again: boolean; promise: Promise<void> } | undefined
let generation = 0

export const useEditorAskStore = create<EditorAskState>((set, get) => ({
  asks: [],
  dismissed: new Map(),
  busy: false,
  error: '',

  load: () => {
    // Events can arrive in bursts; one read runs at a time and one more follows if any came in meanwhile.
    if (loading?.owner === generation) {
      loading.again = true
      return loading.promise
    }
    const entry = { owner: generation, again: false, promise: Promise.resolve() }
    loading = entry
    entry.promise = (async () => {
      try {
        do {
          entry.again = false
          // Net may be off or the daemon older: nothing to show, and nothing to say about it.
          const asks = await listEditorAsks().catch(() => undefined)
          if (asks && entry.owner === generation) set((state) => ({ asks, dismissed: forgetExpired(state.dismissed, Date.now()) }))
        } while (entry.again && entry.owner === generation)
      } finally {
        if (loading === entry) loading = undefined
      }
    })()
    return entry.promise
  },

  answer: async (node, allow) => {
    const owner = generation
    set({ busy: true, error: '', errorNode: undefined })
    try {
      const result = await answerEditorAsk(node, allow)
      // An ask that ran out or was answered in another window is gone either way.
      if (owner === generation) {
        set((state) => ({ asks: state.asks.filter((ask) => ask.node !== node), dismissed: forgetNode(state.dismissed, node) }))
      }
      return result
    } catch (cause) {
      if (owner === generation) set({ error: message(cause), errorNode: node })
      return undefined
    } finally {
      if (owner === generation) set({ busy: false })
    }
  },

  dismiss: (node) =>
    set((state) => {
      const expiresAt = state.asks.find((ask) => ask.node === node)?.expiresAt
      return {
        ...(expiresAt === undefined ? {} : { dismissed: new Map(state.dismissed).set(node, expiresAt) }),
        ...(state.errorNode === node ? { error: '', errorNode: undefined } : {})
      }
    }),

  prune: (now = Date.now()) => {
    const state = get()
    const asks = state.asks.filter((ask) => ask.expiresAt > now)
    const dismissed = forgetExpired(state.dismissed, now)
    if (asks.length !== state.asks.length || dismissed !== state.dismissed) set({ asks, dismissed })
  },

  reset: () => {
    // Late answers from before a sign-out or profile switch are ignored.
    generation++
    set({ asks: [], busy: false, error: '', errorNode: undefined })
  }
}))

/** The ask the prompt shows, if any. */
export const currentEditorAsk = (state: Pick<EditorAskState, 'asks' | 'dismissed'>, now = Date.now()): EditorAskView | undefined =>
  nextEditorAsk(state.asks, state.dismissed, now)

/** The ask waiting from one computer, closed or not: Devices shows it until it is answered or runs out. */
export const pendingEditorAsk = (state: Pick<EditorAskState, 'asks'>, node: string, now = Date.now()): EditorAskView | undefined =>
  state.asks.find((ask) => ask.node === node && ask.expiresAt > now)

/**
 * Keeps the asks fresh: on every ask event from the main process, when the window comes back, and every
 * {@link EDITOR_ASK_RECONCILE_MS} while it is visible. Stopping forgets them.
 */
export function watchEditorAsks(): () => void {
  const { load } = useEditorAskStore.getState()
  const refresh = () => void load()
  const refreshVisible = () => {
    if (document.visibilityState === 'visible') refresh()
  }
  refresh()
  const stopEvents = window.mousse.net?.onEditorAsks?.(refresh)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refreshVisible)
  const timer = setInterval(refreshVisible, EDITOR_ASK_RECONCILE_MS)
  return () => {
    stopEvents?.()
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refreshVisible)
    clearInterval(timer)
    useEditorAskStore.getState().reset()
  }
}

/** Watches for asks while `active`; stops and forgets them otherwise. One watcher per window: the prompt host. */
export function useEditorAskWatch(active: boolean, profileId: string | null): void {
  useEffect(() => {
    if (!active) return
    return watchEditorAsks()
  }, [active, profileId])
}
