import { create } from 'zustand'

type SetUpdate = Set<string> | ((prev: Set<string>) => Set<string>)

/**
 * The sidebar groups showing all their threads (Show more). Kept outside the sidebar, so a
 * sidebar that closes and opens again, or the hover peek, shows the same lists.
 */
export const useSidebarShowMoreStore = create<{ groups: Set<string>; setGroups: (update: SetUpdate) => void }>((set) => ({
  groups: new Set(),
  setGroups: (update) => set((state) => ({ groups: typeof update === 'function' ? update(state.groups) : update }))
}))
