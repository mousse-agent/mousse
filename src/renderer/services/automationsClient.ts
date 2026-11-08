import type { AutomationIndex } from '../../shared/automations'
import type { PlatformRequestApi } from '../../shared/platform'

export interface AutomationsClient {
  /** Every automation of the bound profile in one read-only list (`automations.list`). */
  list(): Promise<AutomationIndex>
}

/** Uses the host's profile-bound bridge. */
export function createAutomationsClient(transport: PlatformRequestApi): AutomationsClient {
  return {
    list: () => transport.request<AutomationIndex>('automations.list', {})
  }
}
