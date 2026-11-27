import { create } from 'zustand'

type SetUpdate = Set<string> | ((prev: Set<string>) => Set<string>)
type FlagUpdate = boolean | ((prev: boolean) => boolean)

/**
 * What the person has open in the sidebar: its groups (projects) and Archived. Kept outside the sidebar, so a
 * sidebar that closes and opens again, or the hover peek, shows the same things open, also from a new thread that
 * has no project of its own to reveal.
 */
export const useSidebarOpenStore = create<{
  groups: Set<string>
  setGroups: (update: SetUpdate) => void
  archived: boolean
  setArchived: (update: FlagUpdate) => void
}>((set) => ({
  groups: new Set(),
  setGroups: (update) => set((state) => ({ groups: typeof update === 'function' ? update(state.groups) : update })),
  archived: false,
  setArchived: (update) => set((state) => ({ archived: typeof update === 'function' ? update(state.archived) : update }))
}))
