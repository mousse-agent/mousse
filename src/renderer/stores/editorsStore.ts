import { create } from 'zustand'
import type { EditorInfo } from '../../shared/types'
import { sameEditors } from '../components/sideCard/openInEditor'

/**
 * Editors detected on this computer, read once per app session and shared by
 * every card mount. `null` until the first read succeeds.
 */
interface EditorsState {
  editors: EditorInfo[] | null
}

export const useEditorsStore = create<EditorsState>(() => ({ editors: null }))

let pending: Promise<void> | null = null

function read(refresh: boolean): Promise<void> {
  if (pending) return pending
  pending = window.mousse.editors.list(refresh ? { refresh: true } : undefined)
    .then((editors) => {
      const current = useEditorsStore.getState().editors
      if (!current || !sameEditors(current, editors)) useEditorsStore.setState({ editors })
    })
    .catch(() => { /* Keep what is shown; the next read tries again. */ })
    .finally(() => { pending = null })
  return pending
}

/** Reads the list unless it is already loaded. */
export function loadEditors(): Promise<void> {
  return useEditorsStore.getState().editors ? Promise.resolve() : read(false)
}

/** Detects again, so newly installed editors appear. Failures are ignored. */
export function refreshEditors(): Promise<void> {
  return read(true)
}
