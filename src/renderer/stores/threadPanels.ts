import type { StateCreator, StoreMutatorIdentifier } from 'zustand'
import type { MainView } from '../../shared/types'

/** The side panel as one thread left it: open or closed, and the tab in front. */
export interface SavedThreadPanel {
  open: boolean
  view: MainView
}

export interface ThreadPanelFields {
  activeThreadId: string | null
  mainAreaOpen: boolean
  mainView: MainView
  /** Each thread's side panel, by thread id. */
  panelByThread: Record<string, SavedThreadPanel>
}

/** Threads remembered; the least recently left are forgotten first. */
export const MAX_SAVED_THREAD_PANELS = 300

/**
 * Completes an update that switches threads: the thread being left keeps its panel as it was, and the thread
 * being opened gets back the panel it had. A thread never opened before, and the new-thread screen (no thread),
 * keep the panel as it is. Fields the update sets itself (opening a thread straight into a panel tab) win over
 * the saved ones, and an update that brings a different `panelByThread` (a saved workspace restored) is left alone.
 */
export function withThreadPanel<T extends ThreadPanelFields>(before: T, patch: Partial<T>): Partial<T> {
  if (!('activeThreadId' in patch) || patch.activeThreadId === before.activeThreadId) return patch
  if (patch.panelByThread !== undefined && patch.panelByThread !== before.panelByThread) return patch
  const leaving = before.activeThreadId
  const entering = patch.activeThreadId ?? null
  let panelByThread = before.panelByThread
  if (leaving !== null) {
    panelByThread = { ...before.panelByThread }
    delete panelByThread[leaving]
    panelByThread[leaving] = { open: before.mainAreaOpen, view: before.mainView }
    const keys = Object.keys(panelByThread)
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SAVED_THREAD_PANELS))) delete panelByThread[key]
  }
  const saved = entering === null ? undefined : before.panelByThread[entering]
  // An update that spreads the whole state names every field (and the same map): only a changed value is its own.
  const spread = patch.panelByThread === before.panelByThread
  const own = (key: 'mainAreaOpen' | 'mainView') => patch[key] !== undefined && (!spread || patch[key] !== before[key])
  const setsOpen = own('mainAreaOpen')
  const setsView = own('mainView')
  return {
    ...patch,
    ...(panelByThread !== before.panelByThread ? { panelByThread } : {}),
    ...(saved && !setsOpen ? { mainAreaOpen: saved.open } : {}),
    ...(saved && !setsView ? { mainView: saved.view } : {})
  }
}

type ThreadPanels = <
  T extends ThreadPanelFields,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = []
>(config: StateCreator<T, Mps, Mcs>) => StateCreator<T, Mps, Mcs>

type ThreadPanelsImpl = <T extends ThreadPanelFields>(config: StateCreator<T, [], []>) => StateCreator<T, [], []>

const threadPanelsImpl: ThreadPanelsImpl = (config) => (set, get, api) => {
  const switching: typeof set = (partial, replace?: boolean) => {
    const before = get()
    const patch = typeof partial === 'function' ? partial(before) : partial
    if (patch === before) return
    const next = withThreadPanel(before, patch as Partial<typeof before>)
    if (replace) set(next as typeof before, true)
    else set(next)
  }
  api.setState = switching
  return config(switching, get, api)
}

/**
 * Store middleware that runs every update, from inside the store or `setState` outside it, through
 * `withThreadPanel`, so every way of switching threads keeps each thread's side panel.
 */
export const threadPanels = threadPanelsImpl as unknown as ThreadPanels
