import type { AutomationComputer, AutomationItem } from '../../shared/automations'
import type { ScheduledJob } from '../../shared/types'

/**
 * The automations of the user's other computers, for this computer's Automations page (`bridge/routed/remoteAutomations.ts`).
 * Set by Bridge while routing is on; without it the page lists this computer's automations only.
 *
 * Each computer stores and runs its own automations; this port reads them (and keeps the last copy of each, so an
 * offline computer's rows stay listed). Every id it returns is qualified
 * (`<node>:<id>`), the way this computer names another computer's threads.
 */
export interface RemoteAutomationsPart {
  computer: AutomationComputer
  items: AutomationItem[]
  jobs: ScheduledJob[]
}

export interface RemoteAutomationsPort {
  /** The other computers with what each owns: read now from each one that is online, else its last copy (offline). */
  read(signal?: AbortSignal): Promise<RemoteAutomationsPart[]>
  /** The other computers, and whether each is online now; undefined while the device list cannot be read. */
  computers(): Array<{ node: string; name: string; online: boolean }> | undefined
}
