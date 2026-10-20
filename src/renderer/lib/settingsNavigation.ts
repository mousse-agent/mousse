import { useAppStore } from '../stores/appStore'

let pendingSection: string | undefined

/** Opens settings at a section, whether or not the settings page is already mounted. */
export function openSettingsSection(section: string): void {
  pendingSection = section
  useAppStore.getState().setSettingsOpen(true)
  window.dispatchEvent(new CustomEvent('mousse:settings-section', { detail: section }))
}

/** The section requested before the settings page mounted, consumed once. */
export function takePendingSettingsSection(): string | undefined {
  const section = pendingSection
  pendingSection = undefined
  return section
}
