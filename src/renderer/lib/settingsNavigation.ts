import { useAppStore } from '../stores/appStore'

let pendingSection: string | undefined
let pendingAnchor: string | undefined

/**
 * Opens settings at a section, whether or not the settings page is already mounted, and with
 * `anchor` brings that setting into view (as a search result does).
 */
export function openSettingsSection(section: string, anchor?: string): void {
  pendingSection = section
  pendingAnchor = anchor
  useAppStore.getState().setSettingsOpen(true)
  window.dispatchEvent(new CustomEvent('mousse:settings-section', { detail: section }))
}

/**
 * Where an old link to the Account page (`account`, or the older `profile`) goes: Mousse ID sign-in
 * at the top of Devices when this build has the service, otherwise Activity, the rest of that page.
 */
export const accountSection = (mousseId: boolean): 'connections' | 'activity' => mousseId ? 'connections' : 'activity'

/** The setting to bring into view with the last requested section, consumed once. */
export function takePendingSettingsAnchor(): string | undefined {
  const anchor = pendingAnchor
  pendingAnchor = undefined
  return anchor
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

let pendingProvider: string | undefined

/**
 * Opens Settings, Providers, with one entry's card open (an instance id): a bot's Sign in. With
 * `anchor`, that setting of the entry is brought into view.
 */
export function openProvider(instanceId: string, anchor?: string): void {
  pendingProvider = instanceId
  openSettingsSection('providers', anchor)
  window.dispatchEvent(new CustomEvent('mousse:settings-provider', { detail: instanceId }))
}

/** The entry requested before Providers was shown, consumed once. */
export function takePendingProvider(): string | undefined {
  const instanceId = pendingProvider
  pendingProvider = undefined
  return instanceId
}
