import type { AutomationComputer, AutomationItem } from '../../shared/automations'
import type { CreateScheduledJobInput, ScheduledJob } from '../../shared/types'

/**
 * The automations of the user's other computers, for this computer's Automations page (`bridge/routed/remoteAutomations.ts`).
 * Set by Bridge while routing is on; without it the page lists this computer's automations only.
 *
 * Each computer stores and runs its own automations; this port reads them (and keeps the last copy of each, so an
 * offline computer's rows stay listed) and makes the calls that add one there. Every id it returns is qualified
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
  /**
   * Adds an automation on `node`. `input` names that computer's project by its own id. `idem` makes a retry of the
   * same request reach the same execution. Returns the job as that computer stored it (its own, plain ids).
   */
  create(node: string, input: CreateScheduledJobInput, options?: { idem?: string; signal?: AbortSignal }): Promise<ScheduledJob>
  /** Pauses an automation of `node` by its own id (a moved automation keeps its pause). */
  pause(node: string, jobId: string, until?: string, options?: { idem?: string; signal?: AbortSignal }): Promise<void>
  /** The project of `node` that is the same Git repository as the folder `projectPath` here; null when it has none. */
  matchProject(node: string, projectPath: string, signal?: AbortSignal): Promise<{ projectId: string; weak: boolean } | null>
}
