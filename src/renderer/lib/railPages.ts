import { TEXT_FIELD_SELECTOR } from '../commands/commandContext'
import { useCommandRegistry } from '../commands/commandRegistry'
import { hasOpenDialog } from '../components/ui/Modal'
import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'

/** The pages the navigation rail opens over the workspace. The rail's Home item returns to the workspace. */
export type RailPage = 'automations' | 'usage' | 'settings'

type RailState = Pick<ReturnType<typeof useAppStore.getState>, 'scheduledOpen' | 'usageOpen' | 'settingsOpen'>

/** The rail page that is open, or null while the workspace shows. One is open at most. */
export function activeRailPage(state: RailState): RailPage | null {
  if (state.settingsOpen) return 'settings'
  if (state.usageOpen) return 'usage'
  if (state.scheduledOpen) return 'automations'
  return null
}

/** Closes every rail page at once, without asking the guards (the caller already did). */
export function closeRailPages(): void {
  const store = useAppStore.getState()
  store.setScheduledOpen(false)
  store.setUsageOpen(false)
  store.setSettingsOpen(false)
}

function setRailPage(page: RailPage | null): void {
  const store = useAppStore.getState()
  if (page === 'automations') store.setScheduledOpen(true)
  else if (page === 'usage') store.setUsageOpen(true)
  else if (page === 'settings') store.setSettingsOpen(true)
  else closeRailPages()
}

/** Opens a rail page after the navigation guards agree. Nothing happens when it is already open. */
export async function openRailPage(page: RailPage): Promise<void> {
  if (activeRailPage(useAppStore.getState()) === page) return
  if (!await confirmNavigation()) return
  setRailPage(page)
}

/** Returns to the workspace from any rail page after the navigation guards agree. */
export async function leaveRailPage(): Promise<void> {
  if (activeRailPage(useAppStore.getState()) === null) return
  if (!await confirmNavigation()) return
  setRailPage(null)
}

/** A rail item click: opens its page, or returns to the workspace when that page is already open. */
export function toggleRailPage(page: RailPage): Promise<void> {
  return activeRailPage(useAppStore.getState()) === page ? leaveRailPage() : openRailPage(page)
}

export interface EscapeTarget {
  key: string
  defaultPrevented: boolean
  isComposing?: boolean
  target: EventTarget | null
}

/**
 * Whether an Escape press should return from a rail page to the workspace: a page is open, nothing
 * else took the key (a menu, a select, an editor), no dialog or palette is open, and focus is not in
 * a text field or terminal, where Escape belongs to the field.
 */
export function escapeLeavesRailPage(event: EscapeTarget, state: RailState = useAppStore.getState()): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false
  // Settings has its own Back button and covers the rail; its sections keep Escape.
  const page = activeRailPage(state)
  if (page === null || page === 'settings') return false
  if (hasOpenDialog() || useCommandRegistry.getState().overlays.length > 0) return false
  const target = event.target as { closest?: (selector: string) => unknown } | null
  if (typeof target?.closest === 'function' && target.closest(`${TEXT_FIELD_SELECTOR}, .xterm, [role="menu"], [role="listbox"]`)) return false
  return true
}
