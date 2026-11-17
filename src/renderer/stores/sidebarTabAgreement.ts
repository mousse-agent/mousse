import type { StateCreator, StoreMutatorIdentifier } from 'zustand'

export type SidebarTab = 'projects' | 'threads' | 'chats'
export type WorkspaceMode = 'projects' | 'chats'
export type ThreadListTab = Exclude<SidebarTab, 'chats'>

/** The sidebar's tab, the workspace beside it, and the thread list tab (Projects or Threads) the person used last. */
export interface SidebarTabPair {
  threadsSidebarView: SidebarTab
  sidebarMode: WorkspaceMode
  lastThreadListView: ThreadListTab
}

export function workspaceModeFor(tab: SidebarTab): WorkspaceMode {
  return tab === 'chats' ? 'chats' : 'projects'
}

/**
 * The sidebar tab and the workspace always agree: Chats shows `ChatWorkspace`, Projects and Threads show the thread
 * workspace. An update that disagrees is completed here:
 *
 * - One that names only the workspace (opening a thread, the new-thread screen or a panel surface sets
 *   `sidebarMode: 'projects'`) moves the tab: off Chats to the thread list tab used last, or onto Chats.
 * - Any other (a tab click, a saved workspace restored at launch or on a profile switch) keeps the tab and
 *   the workspace follows it.
 *
 * `lastThreadListView` follows the tab whenever it is Projects or Threads.
 */
export function agreeWithTab<T extends SidebarTabPair>(before: T, patch: Partial<T>): Partial<T> {
  const tab = patch.threadsSidebarView ?? before.threadsSidebarView
  const mode = patch.sidebarMode ?? before.sidebarMode
  const last = patch.lastThreadListView ?? before.lastThreadListView
  let fixed: Partial<SidebarTabPair> | null = null
  if (workspaceModeFor(tab) !== mode) {
    const workspaceLeads = 'sidebarMode' in patch && !('threadsSidebarView' in patch)
    fixed = workspaceLeads
      ? { threadsSidebarView: mode === 'chats' ? 'chats' : last }
      : { sidebarMode: workspaceModeFor(tab) }
  }
  const nextTab = fixed?.threadsSidebarView ?? tab
  if (nextTab !== 'chats' && nextTab !== last) fixed = { ...fixed, lastThreadListView: nextTab }
  return fixed ? { ...patch, ...fixed } : patch
}

type TabAgreement = <
  T extends SidebarTabPair,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = []
>(config: StateCreator<T, Mps, Mcs>) => StateCreator<T, Mps, Mcs>

type TabAgreementImpl = <T extends SidebarTabPair>(config: StateCreator<T, [], []>) => StateCreator<T, [], []>

const tabAgreementImpl: TabAgreementImpl = (config) => (set, get, api) => {
  const agreeing: typeof set = (partial, replace?: boolean) => {
    const before = get()
    const patch = typeof partial === 'function' ? partial(before) : partial
    if (patch === before) return
    const agreed = agreeWithTab(before, patch as Partial<typeof before>)
    if (replace) set(agreed as typeof before, true)
    else set(agreed)
  }
  api.setState = agreeing
  return config(agreeing, get, api)
}

/**
 * Store middleware that runs every update, from inside the store or `setState` outside it, through `agreeWithTab`,
 * so no path can leave the sidebar on one tab and the workspace on the other.
 */
export const tabAgreement = tabAgreementImpl as unknown as TabAgreement
