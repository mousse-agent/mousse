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

let pendingDevice: string | undefined

/** Opens Settings, Devices, and brings the row of one device (a node id) into view. */
export function openDevice(node: string): void {
  pendingDevice = node
  openSettingsSection('connections')
  window.dispatchEvent(new CustomEvent('mousse:settings-device', { detail: node }))
}

/** The device requested before Devices was shown, consumed once. */
export function takePendingDevice(): string | undefined {
  const node = pendingDevice
  pendingDevice = undefined
  return node
}
