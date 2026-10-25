import type { Thread } from '../../shared/types'
import { visibleThreads } from '../../shared/threadLineage'
import type { ProtocolClientType, ProtocolEvent } from './types'

/**
 * Which threads a client is shown. The thread inventory is always complete; this is the one place
 * that decides who sees subagent threads. Only the desktop app does: it needs them to fold each
 * under its parent (Lineage, sidebar roll-up). Every other client (CLI, channels, remote devices,
 * tests, unknown) gets lists without subagent threads. A client with no connection at all, such as
 * a remote device's backend, is one of those.
 */
export function connectionSeesSubagents(connection: { readonly clientType?: ProtocolClientType } | undefined): boolean {
  return connection?.clientType === 'gui'
}

/**
 * `threads` as `connection` should see them. `inventory` is the complete list parents are looked up
 * in; give it whenever `threads` is a slice (one project), so a slice never makes a parent look
 * missing and a subagent look orphaned. Filtering happens here, before any limit a caller applies.
 */
export function visibleThreadsFor(
  connection: { readonly clientType?: ProtocolClientType } | undefined,
  threads: readonly Thread[],
  inventory: readonly Thread[] = threads
): Thread[] {
  return connectionSeesSubagents(connection) ? [...threads] : visibleThreads(threads, inventory)
}

/**
 * A pushed `threads.updated` event as one client should receive it. The event in the replay ring
 * carries the complete inventory; each client gets its own projection, applied when the event is
 * delivered, buffered or replayed. Other events, and events for clients that see subagents, are
 * returned as they are.
 */
export function projectEventFor(clientType: ProtocolClientType | undefined, event: ProtocolEvent): ProtocolEvent {
  if (event.type !== 'threads.updated' || connectionSeesSubagents({ clientType })) return event
  const data = event.data
  if (Array.isArray(data)) return { ...event, data: visibleThreads(data as Thread[]) }
  if (data && typeof data === 'object' && Array.isArray((data as { threads?: unknown }).threads)) {
    return { ...event, data: { ...data, threads: visibleThreads((data as { threads: Thread[] }).threads) } }
  }
  return event
}
