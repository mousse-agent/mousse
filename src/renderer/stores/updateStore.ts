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

/** Starts mirroring the updater's state into this window. Safe to call more than once. */
export function subscribeToUpdates(): void {
  if (subscribed || typeof window === 'undefined' || !window.mousse?.updates) return
  subscribed = true
  let pushed = false
  window.mousse.updates.onState((state) => {
    pushed = true
    useUpdateStore.setState(state, true)
  })
  void window.mousse.updates.getState().then((state) => {
    // A pushed state is newer than this reply.
    if (!pushed) useUpdateStore.setState(state, true)
  }).catch(() => undefined)
}

const apply = (request: Promise<UpdateState>): Promise<void> =>
  request.then((state) => useUpdateStore.setState(state, true)).catch((cause: unknown) => {
    console.error('Update request failed:', cause)
  })

export const updateActions = {
  check: () => apply(window.mousse.updates.check()),
  download: () => apply(window.mousse.updates.download()),
  install: () => apply(window.mousse.updates.install()),
  setChannel: (channel: UpdateChannel) => apply(window.mousse.updates.setChannel(channel))
}

/** Whether the rail shows the update button: something to download, install, or retry. */
export function updateNeedsAttention(state: Pick<UpdateState, 'phase' | 'error'>): boolean {
  return state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded' ||
    state.phase === 'installing' || (state.phase === 'error' && state.error?.during !== 'check')
}
