import { create } from 'zustand'
import {
  createQuickAction,
  loadQuickActions,
  sanitizeQuickAction,
  saveQuickActions,
  type QuickAction,
  type QuickActionKind
} from '../lib/quickActions'
import { useAppStore } from './appStore'

export interface QuickActionInput {
  label: string
  kind: QuickActionKind
  payload: string
}

interface QuickActionsState {
  /** Profile the list was loaded for; null until the first load. */
  profileId: string | null
  actions: QuickAction[]
  /** Load the active profile's list when it is not the one already held. */
  syncProfile: () => void
  /**
   * Edits take the profile they were opened for and do nothing once another profile is
   * active: ids such as the built-in action's are shared between profiles.
   */
  add: (input: QuickActionInput, profileId: string) => void
  update: (id: string, input: QuickActionInput, profileId: string) => void
  remove: (id: string, profileId: string) => void
  /** Add an action published by the agent; ignores malformed payloads and ids already present. */
  receiveCreated: (raw: unknown) => void
}

export const useQuickActionsStore = create<QuickActionsState>((set, get) => {
  /** Apply a change to the active profile's list and persist it under that profile. */
  const commit = (change: (current: QuickAction[]) => QuickAction[]) => {
    get().syncProfile()
    const { profileId, actions } = get()
    if (!profileId) return
    const next = change(actions)
    if (next === actions) return
    set({ actions: next })
    saveQuickActions(next, profileId)
  }

  /** `commit`, unless the profile the edit was made for is no longer the active one. */
  const commitFor = (profileId: string, change: (current: QuickAction[]) => QuickAction[]) => {
    if (useAppStore.getState().profileId !== profileId) return
    commit(change)
  }

  return {
    profileId: null,
    actions: [],
    syncProfile: () => {
      const profileId = useAppStore.getState().profileId
      if (!profileId || get().profileId === profileId) return
      set({ profileId, actions: loadQuickActions(profileId) })
    },
    add: (input, profileId) => commitFor(profileId, (current) => [...current, createQuickAction(input)]),
    update: (id, input, profileId) =>
      commitFor(profileId, (current) =>
        current.map((action) =>
          action.id === id
            ? {
                ...action,
                label: input.label.trim(),
                kind: input.kind,
                payload: input.payload,
                updatedAt: new Date().toISOString()
              }
            : action
        )
      ),
    remove: (id, profileId) => commitFor(profileId, (current) => current.filter((action) => action.id !== id)),
    receiveCreated: (raw) => {
      const action = sanitizeQuickAction(raw)
      if (!action) return
      commit((current) => (current.some((entry) => entry.id === action.id) ? current : [...current, action]))
    }
  }
})

let stopSync: (() => void) | null = null

/**
 * Keep the store on the active profile and feed it agent-created actions. The
 * agent publishes approved actions over `quickActions:created` whether or not
 * the side card is on screen, so this runs for the life of the app. Safe to call
 * more than once. Returns a function that stops the subscriptions.
 */
export function startQuickActionsSync(): () => void {
  if (stopSync) return stopSync
  const unsubscribeProfile = useAppStore.subscribe((state, previous) => {
    if (state.profileId !== previous.profileId) useQuickActionsStore.getState().syncProfile()
  })
  // Guarded for stale preloads that predate the bridge.
  const subscribe = typeof window === 'undefined' ? undefined : window.mousse?.quickActions?.onCreated
  const unsubscribeCreated =
    typeof subscribe === 'function'
      ? subscribe((raw: unknown) => useQuickActionsStore.getState().receiveCreated(raw))
      : undefined
  useQuickActionsStore.getState().syncProfile()
  const stop = () => {
    unsubscribeProfile()
    unsubscribeCreated?.()
    stopSync = null
  }
  stopSync = stop
  return stop
}

const NO_ACTIONS: QuickAction[] = []

/** The active profile's quick actions; empty for the instant a profile switch has not loaded yet. */
export function useQuickActions(): { profileId: string; actions: QuickAction[] } {
  const profileId = useAppStore((state) => state.profileId)
  const loadedFor = useQuickActionsStore((state) => state.profileId)
  const actions = useQuickActionsStore((state) => state.actions)
  return { profileId, actions: loadedFor === profileId ? actions : NO_ACTIONS }
}

if (typeof window !== 'undefined' && window.mousse) startQuickActionsSync()
