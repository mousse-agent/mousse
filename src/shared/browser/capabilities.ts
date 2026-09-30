import { ATTACHED_CAPABILITY_DEFAULT } from './attached'
import type { BrowserAction, BrowserSessionRecord } from './types'

export interface BrowserBackendCapabilities {
  backend: BrowserSessionRecord['backend']
  tabs: Array<'list' | 'new' | 'switch' | 'close'>
  actions: Array<BrowserAction['type']>
  screenshots: boolean
  uploads: boolean
  downloads: boolean
}
const actions: Array<BrowserAction['type']> = ['navigate', 'back', 'forward', 'reload', 'click', 'double-click', 'hover', 'fill', 'type', 'key', 'select', 'check', 'scroll', 'drag', 'upload', 'dialog']

/** Host-owned backend support, intersected with the current model's vision binding. */
export function browserBackendCapabilities(backend: BrowserSessionRecord['backend'], vision = false, actual?: { screenshots?: boolean }): BrowserBackendCapabilities {
  const attached = backend === 'electron-attached'
  const uploads = !attached || ATTACHED_CAPABILITY_DEFAULT.capabilities.actions.artifactUpload
  return {
    backend,
    tabs: attached ? Object.entries(ATTACHED_CAPABILITY_DEFAULT.capabilities.tabs).filter(([, supported]) => supported).map(([name]) => name as 'list' | 'switch') : ['list', 'new', 'switch', 'close'],
    actions: actions.filter((action) => action !== 'upload' || uploads),
    screenshots: vision && (actual?.screenshots ?? !attached),
    uploads,
    downloads: !attached
  }
}
