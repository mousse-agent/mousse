import { useEffect } from 'react'
import { create } from 'zustand'
import type { PlusEnrollmentRequestView } from '../../shared/net'
import { decideEnrollmentRequest, listEnrollmentRequests, nextEnrollmentRequest } from '../lib/plusEnrollment'

/** Backstop for missed `net:updated` events, and what restarts the daemon's mailbox poll after it stops. */
export const ENROLLMENT_RECONCILE_MS = 30_000

interface EnrollmentPromptState {
  requests: PlusEnrollmentRequestView[]
  /**
   * Requests closed without a choice, with the time each runs out; Settings → Devices still lists
   * them. Kept across profile switches until then, so switching back does not ask again.
   */
  dismissed: ReadonlyMap<string, number>
  /** Requests a system notification was already shown for, with the time each runs out. */
  notified: ReadonlyMap<string, number>
  busy: boolean
  error: string
  /** Request the error belongs to, so it never shows on the next one. */
  errorId?: string
  load: () => Promise<void>
  decide: (id: string, approve: boolean) => Promise<void>
  dismiss: (id: string) => void
  markNotified: (id: string) => void
  /** Drops requests whose time ran out, and the marks kept for expired ones. */
  prune: (now?: number) => void
  reset: () => void
}

const message = (cause: unknown) => String((cause as Error | null)?.message ?? cause)

/** Closed and notified marks only matter until their request runs out; drop the rest. */
const forgetExpired = (marks: ReadonlyMap<string, number>, now: number): ReadonlyMap<string, number> => {
  const kept = new Map([...marks].filter(([, expiresAt]) => expiresAt > now))
  return kept.size === marks.size ? marks : kept
}

const forgetId = (marks: ReadonlyMap<string, number>, id: string): ReadonlyMap<string, number> => {
  if (!marks.has(id)) return marks
  const kept = new Map(marks)
  kept.delete(id)
  return kept
}

const withRequests = (
  state: Pick<EnrollmentPromptState, 'dismissed' | 'notified'>,
  requests: PlusEnrollmentRequestView[],
  now = Date.now()
) => ({
  requests,
  dismissed: forgetExpired(state.dismissed, now),
  notified: forgetExpired(state.notified, now)
})

const markFor = (state: Pick<EnrollmentPromptState, 'requests'>, marks: ReadonlyMap<string, number>, id: string) => {
  const expiresAt = state.requests.find((row) => row.id === id)?.expiresAt
  return expiresAt === undefined ? marks : new Map(marks).set(id, expiresAt)
}

let loading: { owner: number; again: boolean; promise: Promise<void> } | undefined
let generation = 0

export const useEnrollmentPromptStore = create<EnrollmentPromptState>((set, get) => ({
  requests: [],
  dismissed: new Map(),
  notified: new Map(),
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
      if (owner === generation) {
        set((state) => {
          const next = withRequests(state, state.requests.filter((row) => row.id !== id))
          return { ...next, dismissed: forgetId(next.dismissed, id), notified: forgetId(next.notified, id) }
        })
      }
    } catch (cause) {
      if (owner === generation) set({ error: message(cause), errorId: id })
    } finally {
      if (owner === generation) set({ busy: false })
    }
  },

  dismiss: (id) =>
    set((state) => ({
      dismissed: markFor(state, state.dismissed, id),
      ...(state.errorId === id ? { error: '', errorId: undefined } : {})
    })),

  markNotified: (id) => set((state) => ({ notified: markFor(state, state.notified, id) })),

  prune: (now = Date.now()) => {
    const state = get()
    const next = withRequests(state, state.requests.filter((row) => row.expiresAt > now), now)
    if (next.requests.length !== state.requests.length || next.dismissed !== state.dismissed || next.notified !== state.notified) set(next)
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
