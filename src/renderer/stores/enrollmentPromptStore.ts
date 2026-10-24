import { useEffect } from 'react'
import { create } from 'zustand'
import type { PlusEnrollmentRequestView } from '../../shared/net'
import { decideEnrollmentRequest, listEnrollmentRequests, nextEnrollmentRequest } from '../lib/plusEnrollment'

/** Backstop for missed `net:updated` events, and what restarts the daemon's mailbox poll after it stops. */
export const ENROLLMENT_RECONCILE_MS = 30_000

interface EnrollmentPromptState {
  requests: PlusEnrollmentRequestView[]
  /** Requests closed without a choice, kept while the request is listed; Settings → Devices still lists them. */
  dismissed: ReadonlySet<string>
  /** Requests a system notification was already shown for. */
  notified: ReadonlySet<string>
  busy: boolean
  error: string
  /** Request the error belongs to, so it never shows on the next one. */
  errorId?: string
  load: () => Promise<void>
  decide: (id: string, approve: boolean) => Promise<void>
  dismiss: (id: string) => void
  markNotified: (id: string) => void
  /** Drops requests whose time ran out, and the marks kept for them. */
  prune: (now?: number) => void
  reset: () => void
}

const message = (cause: unknown) => String((cause as Error | null)?.message ?? cause)

/** Closed and notified marks only matter while their request is listed; drop the rest. */
const forgetGone = (requests: readonly PlusEnrollmentRequestView[], marks: ReadonlySet<string>): ReadonlySet<string> => {
  const kept = new Set(requests.map((row) => row.id).filter((id) => marks.has(id)))
  return kept.size === marks.size ? marks : kept
}

const withRequests = (state: Pick<EnrollmentPromptState, 'dismissed' | 'notified'>, requests: PlusEnrollmentRequestView[]) => ({
  requests,
  dismissed: forgetGone(requests, state.dismissed),
  notified: forgetGone(requests, state.notified)
})

let loading: { owner: number; again: boolean; promise: Promise<void> } | undefined
let generation = 0

export const useEnrollmentPromptStore = create<EnrollmentPromptState>((set, get) => ({
  requests: [],
  dismissed: new Set(),
  notified: new Set(),
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
          const requests = await listEnrollmentRequests().catch(() => undefined)
          if (requests && entry.owner === generation) set((state) => withRequests(state, requests))
        } while (entry.again && entry.owner === generation)
      } finally {
        if (loading === entry) loading = undefined
      }
    })()
    return entry.promise
  },

  decide: async (id, approve) => {
    const owner = generation
    set({ busy: true, error: '', errorId: undefined })
    try {
      await decideEnrollmentRequest(id, approve)
      if (owner === generation) set((state) => withRequests(state, state.requests.filter((row) => row.id !== id)))
    } catch (cause) {
      if (owner === generation) set({ error: message(cause), errorId: id })
    } finally {
      if (owner === generation) set({ busy: false })
    }
  },

  dismiss: (id) =>
    set((state) => ({
      dismissed: new Set(state.dismissed).add(id),
      ...(state.errorId === id ? { error: '', errorId: undefined } : {})
    })),

  markNotified: (id) => set((state) => ({ notified: new Set(state.notified).add(id) })),

  prune: (now = Date.now()) => {
    const { requests } = get()
    const open = requests.filter((row) => row.expiresAt > now)
    if (open.length !== requests.length) set((state) => withRequests(state, open))
  },

  reset: () => {
    // Late answers from before a sign-out or profile switch are ignored.
    generation++
    set({ requests: [], busy: false, error: '', errorId: undefined })
  }
}))

/** The request the dialog shows, if any. */
export const currentEnrollmentRequest = (
  state: Pick<EnrollmentPromptState, 'requests' | 'dismissed'>,
  now = Date.now()
): PlusEnrollmentRequestView | undefined => nextEnrollmentRequest(state.requests, state.dismissed, now)

/**
 * Keeps the request list fresh: on every `net:updated` event (the daemon sends one when its list
 * changes), when the window comes back, and every {@link ENROLLMENT_RECONCILE_MS} while it is visible.
 */
export function watchEnrollmentRequests(): () => void {
  const { load } = useEnrollmentPromptStore.getState()
  const refresh = () => void load()
  const refreshVisible = () => {
    if (document.visibilityState === 'visible') refresh()
  }
  refresh()
  const stopEvents = window.mousse.net?.onUpdated(refresh)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refreshVisible)
  const timer = setInterval(refreshVisible, ENROLLMENT_RECONCILE_MS)
  return () => {
    stopEvents?.()
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refreshVisible)
    clearInterval(timer)
    useEnrollmentPromptStore.getState().reset()
  }
}

/** Watches for phone requests while `active`; stops and forgets them otherwise. */
export function useEnrollmentRequestWatch(active: boolean, profileId: string | null): void {
  useEffect(() => {
    if (!active) return
    return watchEnrollmentRequests()
  }, [active, profileId])
}
