import { create } from 'zustand'
import type { UpdateChannel, UpdateState } from '../../shared/updates'

const INITIAL: UpdateState = {
  phase: 'disabled',
  currentVersion: '',
  channel: 'stable',
  releaseNotes: [],
  omittedReleaseCount: 0
}

/** The main-process updater's state (src/main/updates). Components select only what they show. */
export const useUpdateStore = create<UpdateState>(() => INITIAL)

let subscribed = false

const isState = (value: unknown): value is UpdateState =>
  typeof value === 'object' && value !== null && typeof (value as UpdateState).phase === 'string'

/** Starts mirroring the updater's state into this window. Safe to call more than once. */
export function subscribeToUpdates(): void {
  if (subscribed || typeof window === 'undefined' || !window.mousse?.updates) return
  subscribed = true
  let pushed = false
  window.mousse.updates.onState((state) => {
    if (!isState(state)) return
    pushed = true
    useUpdateStore.setState(state, true)
  })
  void window.mousse.updates.getState().then((state) => {
    // A pushed state is newer than this reply.
    if (!pushed && isState(state)) useUpdateStore.setState(state, true)
  }).catch(() => undefined)
}

const apply = (request: Promise<UpdateState>): Promise<void> =>
  request.then((state) => {
    if (isState(state)) useUpdateStore.setState(state, true)
  }).catch((cause: unknown) => {
    console.error('Update request failed:', cause)
  })

export const updateActions = {
  check: () => apply(window.mousse.updates.check()),
  download: () => apply(window.mousse.updates.download()),
  install: () => apply(window.mousse.updates.install()),
  setChannel: (channel: UpdateChannel) => apply(window.mousse.updates.setChannel(channel))
}
