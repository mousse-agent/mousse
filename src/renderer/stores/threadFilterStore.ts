import { create } from 'zustand'
import type { ThreadFilter, ThreadShow } from '../lib/threadFilter'

/**
 * The sidebar's thread filter (`lib/threadFilter.ts`) and the projects unticked in the Projects tab. Show and the unticked
 * projects are kept per profile on this computer; what is typed, the bot, the project, the computer and Archived last the
 * session.
 */
interface ThreadFilterState extends ThreadFilter {
  /** Project groups the Projects tab leaves out. */
  hiddenProjects: string[]
  profileId: string | null
  /** Reads the profile's saved Show and unticked projects, and clears the rest. */
  load(profileId: string | null): void
  setQuery(query: string): void
  setShow(show: ThreadShow): void
  setProject(projectId: string | null): void
  setBot(botId: string | null): void
  toggleComputer(computerId: string): void
  addComputer(computerId: string): void
  removeComputer(computerId: string): void
  clearComputers(): void
  setArchived(archived: boolean): void
  setProjectHidden(projectId: string, hidden: boolean): void
  clearHiddenProjects(): void
  /** A bot's "See all": its threads, and nothing else narrowing them. */
  showBot(botId: string): void
}

const DEFAULTS: ThreadFilter = { query: '', show: 'mine', projectId: null, botId: null, computerIds: [], archived: false }
const SHOWS: readonly ThreadShow[] = ['mine', 'bots', 'all']

const storageKey = (profileId: string) => `mousse-profile-${profileId}-thread-filter`

function readSaved(profileId: string | null): { show: ThreadShow; hiddenProjects: string[] } {
  const fallback = { show: DEFAULTS.show, hiddenProjects: [] }
  if (!profileId || typeof window === 'undefined') return fallback
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(profileId)) ?? 'null') as { show?: unknown; hiddenProjects?: unknown } | null
    return {
      show: SHOWS.includes(saved?.show as ThreadShow) ? saved!.show as ThreadShow : fallback.show,
      hiddenProjects: Array.isArray(saved?.hiddenProjects) ? saved!.hiddenProjects.filter((id): id is string => typeof id === 'string') : []
    }
  } catch {
    return fallback
  }
}

function save(state: Pick<ThreadFilterState, 'profileId' | 'show' | 'hiddenProjects'>): void {
  if (!state.profileId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(state.profileId), JSON.stringify({ show: state.show, hiddenProjects: state.hiddenProjects }))
  } catch { /* quota or private mode: the filter lasts the session */ }
}

export const useThreadFilterStore = create<ThreadFilterState>((set, get) => {
  const saving = (change: Partial<ThreadFilterState>) => {
    set(change)
    save(get())
  }
  return {
    ...DEFAULTS,
    hiddenProjects: [],
    profileId: null,
    load: (profileId) => {
      if (get().profileId === profileId) return
      set({ ...DEFAULTS, ...readSaved(profileId), profileId })
    },
    setQuery: (query) => set({ query }),
    setShow: (show) => saving({ show }),
    setProject: (projectId) => set({ projectId }),
    setBot: (botId) => set({ botId }),
    toggleComputer: (computerId) => set((state) => ({
      computerIds: state.computerIds.includes(computerId)
        ? state.computerIds.filter((id) => id !== computerId)
        : [...state.computerIds, computerId]
    })),
    addComputer: (computerId) => set((state) => (
      state.computerIds.includes(computerId) ? state : { computerIds: [...state.computerIds, computerId] }
    )),
    removeComputer: (computerId) => set((state) => ({
      computerIds: state.computerIds.filter((id) => id !== computerId)
    })),
    clearComputers: () => set({ computerIds: [] }),
    setArchived: (archived) => set({ archived }),
    setProjectHidden: (projectId, hidden) => {
      const rest = get().hiddenProjects.filter((id) => id !== projectId)
      saving({ hiddenProjects: hidden ? [...rest, projectId] : rest })
    },
    clearHiddenProjects: () => saving({ hiddenProjects: [] }),
    showBot: (botId) => set({ botId, query: '', projectId: null, computerIds: [], archived: false })
  }
})
