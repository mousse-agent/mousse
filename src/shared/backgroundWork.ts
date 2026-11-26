/**
 * What a thread runs in the background besides its subagents (issue #1605): its agent's monitors, background commands
 * and `keep_working` holds, and whether its provider still runs background work of its own (Claude's background agents
 * and shells). The daemon pushes it (`thread.backgroundWork`) whenever it changes; the composer's status row joins it
 * with the thread's running subagents.
 */

/** What a thread agent started in the background (`monitor_start`, `background_run`, `keep_working`). */
export type MonitorKind = 'command' | 'url' | 'background' | 'keep_working'
/** Those, and the agent's wake-ups still to come (`wake`): nothing runs for one, the thread carries on when it is due. */
export type BackgroundItemKind = MonitorKind | 'wake'

/**
 * How a monitor, a background command or a `keep_working` hold ended: its script exited, its socket closed, it could not
 * start or broke, its time ran out, it printed too much (`chatty`), it was stopped (by the person, from the app), its
 * thread was stopped, or the daemon restarted under it.
 */
export type MonitorEnd =
  | { reason: 'exit'; code: number | null; signal?: string }
  | { reason: 'closed'; code: number; detail?: string }
  | { reason: 'failed'; message: string }
  | { reason: 'timeout'; minutes: number }
  | { reason: 'chatty'; limit: string }
  | { reason: 'stopped' }
  | { reason: 'thread_stopped' }
  | { reason: 'restart' }

export interface BackgroundWorkItem {
  id: string
  kind: BackgroundItemKind
  /** The agent's short description (a hold's reason). */
  description: string
  /** The script or command, or the socket's address. */
  command?: string
  url?: string
  startedAt: string
  until: string
  /** Its last line of output or message, cut. */
  latest?: string
  /** A wake-up on an event: what it waits for ("when acme/app#12 merges"); its `until` is then when it gives up. */
  waitsFor?: string
}

export interface ThreadBackgroundWork {
  threadId: string
  /** Oldest first. */
  items: BackgroundWorkItem[]
  /** The provider still runs background work for the thread (Claude's agents and shells); it is not listed item by item. */
  providerWork: boolean
  /** The latest line any item reported. */
  latest?: { id: string; line: string; at: string }
  /**
   * The thread's work is not done: a run is live, a notice waits to start or join its next turn, or something it left
   * (the items above, the provider's work, its own subagents) will tell it when it ends. The rule a subagent's task
   * waits by before it publishes (`childBusy`); another computer that sent the thread a task reads it the same way.
   * Absent from older versions.
   */
  busy?: boolean
}

/** The id `threads.stopBackground` takes for the provider's own background work. */
export const PROVIDER_BACKGROUND_ID = 'provider'

/** The counts the status row names: monitors include holds (both wait on something outside), commands the provider's work. */
export interface BackgroundCounts {
  subagents: number
  commands: number
  monitors: number
  /** Wake-ups still to come: counted on their own, since nothing of them runs. */
  wakes: number
}

export function backgroundCounts(work: ThreadBackgroundWork | undefined, runningSubagents: number): BackgroundCounts {
  const items = work?.items ?? []
  return {
    subagents: runningSubagents,
    commands: items.filter((item) => item.kind === 'background').length + (work?.providerWork ? 1 : 0),
    monitors: items.filter((item) => item.kind !== 'background' && item.kind !== 'wake').length,
    wakes: items.filter((item) => item.kind === 'wake').length
  }
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/**
 * "Waiting on 2 subagents, 1 command and 3 monitors", naming only what runs, then the wake-ups set ("1 wake-up set");
 * empty when there is nothing.
 */
export function backgroundHeadline(counts: BackgroundCounts): string {
  const parts = [
    counts.subagents ? plural(counts.subagents, 'subagent', 'subagents') : '',
    counts.commands ? plural(counts.commands, 'command', 'commands') : '',
    counts.monitors ? plural(counts.monitors, 'monitor', 'monitors') : ''
  ].filter(Boolean)
  const wakes = counts.wakes ? `${plural(counts.wakes, 'wake-up', 'wake-ups')} set` : ''
  if (!parts.length) return wakes
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  return `Waiting on ${list}${wakes ? ` · ${wakes}` : ''}`
}
