import { create } from 'zustand'
import type { UpdateChannel, UpdateState } from '../../shared/updates'
import { ipcErrorLine } from '../lib/errorText'

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

/** The state with its error message in plain words. */
function readable(state: UpdateState): UpdateState {
  if (!state.error) return state
  return { ...state, error: { ...state.error, message: updateErrorMessage(state.error.message, state.error.during) } }
}

/** Starts mirroring the updater's state into this window. Safe to call more than once. */
export function subscribeToUpdates(): void {
  if (subscribed || typeof window === 'undefined' || !window.mousse?.updates) return
  subscribed = true
  let pushed = false
  window.mousse.updates.onState((state) => {
    if (!isState(state)) return
    pushed = true
    useUpdateStore.setState(readable(state), true)
  })
  void window.mousse.updates.getState().then((state) => {
    // A pushed state is newer than this reply.
    if (!pushed && isState(state)) useUpdateStore.setState(readable(state), true)
  }).catch(() => undefined)
}

type UpdateStep = NonNullable<UpdateState['error']>['during']

const FALLBACK_MESSAGE: Record<UpdateStep, string> = {
  check: 'Mousse could not check for updates.',
  download: 'Mousse could not download the update.',
  install: 'Mousse could not install the update.'
}

/** What a failed update request says: its own first line, without Electron's call prefix. */
export function updateErrorMessage(cause: unknown, during: UpdateStep): string {
  return (cause == null ? '' : ipcErrorLine(cause)) || FALLBACK_MESSAGE[during]
}

/**
 * The state for a request that failed before the updater could report on it (the call itself
 * was rejected), shaped like the updater's own failures so every view shows and retries it alike.
 */
export function stateAfterFailedRequest(state: UpdateState, during: UpdateStep, cause: unknown): UpdateState {
  const error = { message: updateErrorMessage(cause, during), during }
  if (during === 'install') return { ...state, phase: 'downloaded', error }
  const { downloadPercent: _percent, ...rest } = state
  return { ...rest, phase: 'error', error }
}

/** Retries whichever step last failed. */
export function retryUpdate(): Promise<void> {
  const { error } = useUpdateStore.getState()
  if (error?.during === 'download') return updateActions.download()
  if (error?.during === 'install') return updateActions.install()
  return updateActions.check()
}

/** Hides the shown error; a download that failed goes back to being offered. */
export function dismissUpdateError(): void {
  const { error, phase, availableVersion, ...rest } = useUpdateStore.getState()
  if (!error) return
  const next = phase === 'error' ? (availableVersion ? 'available' : 'idle') : phase
  useUpdateStore.setState({ ...rest, phase: next, ...(availableVersion ? { availableVersion } : {}) }, true)
}

const apply = (request: Promise<UpdateState>, during: UpdateStep): Promise<void> =>
  request.then((state) => {
    if (isState(state)) useUpdateStore.setState(readable(state), true)
  }).catch((cause: unknown) => {
    console.error('Update request failed:', cause)
    useUpdateStore.setState(stateAfterFailedRequest(useUpdateStore.getState(), during, cause), true)
  })

export const updateActions = {
  check: () => apply(window.mousse.updates.check(), 'check'),
  download: () => apply(window.mousse.updates.download(), 'download'),
  install: () => apply(window.mousse.updates.install(), 'install'),
  setChannel: (channel: UpdateChannel) => apply(window.mousse.updates.setChannel(channel), 'check')
}
