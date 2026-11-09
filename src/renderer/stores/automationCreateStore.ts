import { create } from 'zustand'
import { useAppStore } from './appStore'

/**
 * A request to open the Automations page's composer, prefilled: "Repeat this…" on a thread message. The page shows its list and the row opens with what it carries.
 */
export interface AutomationCreateRequest {
  /** Bumped for each request, so the same request can open the row twice. */
  nonce: number
  prompt?: string
  projectId?: string
}

interface AutomationCreateState {
  request: AutomationCreateRequest | null
}

export const useAutomationCreate = create<AutomationCreateState>(() => ({ request: null }))

/** The page took the request: it is not opened again when the page mounts later. */
export function takeAutomationCreate(): void {
  useAutomationCreate.setState({ request: null })
}

/** Opens Automations with the composer prefilled. */
let nonce = 0

export function openAutomationCreate(prefill: Omit<AutomationCreateRequest, 'nonce'>): void {
  nonce += 1
  useAutomationCreate.setState({ request: { ...prefill, nonce } })
  useAppStore.getState().setScheduledOpen(true)
}
