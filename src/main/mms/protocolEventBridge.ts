/**
 * Map protocol events to existing renderer IPC channel names/payloads.
 */

import type { ProtocolEvent } from '../../mms/protocol'
import type { PresentationState } from './PresentationState'
import type { TurnState, TurnStateSnapshot } from '../../shared/types'

export type BroadcastFn = (channel: string, data: unknown) => void

/**
 * Bridge a protocol event onto the preload-compatible IPC bus.
 * Returns true if the event was mapped.
 */
export function bridgeProtocolEvent(
  event: ProtocolEvent,
  broadcast: BroadcastFn,
  presentation: PresentationState,
  activitySnapshot?: Record<string, string>
): boolean {
  const activeId = presentation.getActiveThreadId()
  const threadId = event.threadId
  const isSelected =
    threadId != null && (threadId === activeId || (threadId === '__unbound__' && activeId == null))

  switch (event.type) {
    case 'projects.updated': {
      const projects =
        (event.data as { projects?: unknown } | null)?.projects ?? event.data
      broadcast('projects:updated', projects)
      return true
    }
    case 'threads.updated': {
      const threads = (event.data as { threads?: unknown } | null)?.threads ?? event.data
      broadcast('threads:updated', threads)
      return true
    }
    case 'thread.message': {
      const message = (event.data as { message?: unknown } | null)?.message
      if (threadId != null) {
        broadcast('orchestrator:thread-message', { threadId, message })
      }
      if (isSelected) {
        broadcast('orchestrator:message', message)
      }
      return true
    }
    case 'thread.message-updated': {
      const message = (event.data as { message?: unknown } | null)?.message
      if (threadId != null) {
        broadcast('orchestrator:thread-message-updated', { threadId, message })
      }
      if (isSelected) {
        broadcast('orchestrator:message-updated', message)
      }
      return true
    }
    case 'thread.messages': {
      const messages = (event.data as { messages?: unknown } | null)?.messages
      if (threadId != null) {
        broadcast('orchestrator:thread-messages', { threadId, messages })
      }
      if (isSelected) {
        broadcast('orchestrator:messages', messages)
      }
      return true
    }
    case 'queue.updated': {
      const items = (event.data as { items?: unknown } | null)?.items
      if (threadId != null) {
        broadcast('queue:updated', { threadId, items })
      }
      return true
    }
    case 'connection.failed': {
      if (isSelected || threadId == null) {
        broadcast('orchestrator:connection-failed', undefined)
      }
      return true
    }
    case 'questions.pending': {
      // Pending questions are interactive and must never leak into another selected thread.
      if (isSelected) {
        broadcast('orchestrator:questionsPending', {
          requestId: (event.data as { requestId?: string })?.requestId,
          questions: (event.data as { questions?: unknown })?.questions,
          threadId
        })
      }
      return true
    }
    case 'agents.updated': {
      // The existing renderer stores one selected thread's registry. Background
      // runtime updates remain available through snapshots but must not replace it.
      if (isSelected) {
        const agents = (event.data as { agents?: unknown })?.agents ?? event.data
        broadcast('agents:updated', agents)
      }
      return true
    }
    case 'tasks.updated': {
      if (isSelected) {
        const tasks = (event.data as { tasks?: unknown })?.tasks ?? event.data
        broadcast('tasks:updated', tasks)
      }
      return true
    }
    case 'agent.spawned': {
      if (isSelected) {
        const agent = (event.data as { agent?: unknown })?.agent ?? event.data
        broadcast('agent:spawned', agent)
      }
      return true
    }
    case 'agent.activated': {
      if (isSelected) broadcast('agent:activated', event.data)
      return true
    }
    case 'terminal.activated': {
      if (isSelected) broadcast('pty:activated', event.data)
      return true
    }
    case 'mousse-agent.message': {
      if (isSelected) broadcast('mousse-agent:message', event.data)
      return true
    }
    case 'mousse-agent.message-updated': {
      if (isSelected) broadcast('mousse-agent:message-updated', event.data)
      return true
    }
    case 'mousse-agent.messages-sync': {
      if (isSelected) broadcast('mousse-agent:messages-sync', event.data)
      return true
    }
    case 'mousse-agent.complete': {
      if (isSelected) broadcast('mousse-agent:complete', event.data)
      return true
    }
    case 'mousse-agent.connection-failed': {
      if (isSelected) broadcast('mousse-agent:connection-failed', event.data)
      return true
    }
    case 'pty.data': {
      broadcast('pty:data', event.data)
      return true
    }
    case 'pty.exit': {
      broadcast('pty:exit', event.data)
      return true
    }
    case 'pty.created': {
      // optional — UI may refresh list
      return true
    }
    case 'ui.document-open': {
      broadcast('document:opened', event.data)
      return true
    }
    case 'ui.quick-action-created': {
      broadcast('quickActions:created', event.data)
      return true
    }
    case 'ui.focus-intent': {
      // Electron main decides whether to focus a window
      return true
    }
    case 'ui.notify': {
      return true
    }
    case 'scheduled.updated': {
      broadcast(
        'scheduled:updated',
        (event.data as { jobs?: unknown })?.jobs ?? event.data
      )
      return true
    }
    case 'scheduled.status': {
      broadcast(
        'scheduled:status',
        (event.data as { status?: unknown })?.status ?? event.data
      )
      return true
    }
    case 'channels.updated': {
      broadcast(
        'channels:updated',
        (event.data as { snapshot?: unknown })?.snapshot ?? event.data
      )
      return true
    }
    case 'channels.activity': {
      broadcast(
        'channels:activity',
        (event.data as { event?: unknown })?.event ?? event.data
      )
      return true
    }
    case 'settings.changed': {
      broadcast(
        'settings:changed',
        (event.data as { settings?: unknown })?.settings ?? event.data
      )
      return true
    }
    case 'providers.changed': {
      broadcast(
        'providers:changed',
        (event.data as { providers?: unknown })?.providers ?? event.data
      )
      return true
    }
    case 'providers.login-event': {
      const data = event.data as { event?: unknown }
      if (data?.event) broadcast('providers:login:event', data.event)
      return true
    }
    case 'mcp.changed': {
      broadcast('mcp:changed', null)
      return true
    }
    case 'activity':
    case 'activity.snapshot': {
      // Prefer daemon-authoritative full map. Never broadcast a one-thread replacement
      // object — the renderer treats the payload as the complete activity snapshot.
      const activity =
        activitySnapshot ??
        (event.data as { activity?: Record<string, string> } | null)?.activity
      if (activity && typeof activity === 'object' && !Array.isArray(activity)) {
        broadcast('threads:activity', activity)
      }
      // Single-thread-only payloads are ignored here; registerGuiIpc turn handlers
      // merge into ThreadActivityTracker and rebroadcast the full snapshot.
      return true
    }
    case 'turn.started':
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.aborted':
      return true
    case 'turn.state': {
      const raw = event.data as (TurnState & { state?: TurnState; snapshot?: TurnStateSnapshot }) | null
      const state = (raw as { state?: TurnState } | null)?.state ?? raw
      if ((state as TurnState | null)?.threadId) {
        broadcast('orchestrator:turn-state', state)
      }
      const snapshot =
        (event.data as { snapshot?: TurnStateSnapshot } | null)?.snapshot ??
        (event.data as { turns?: TurnStateSnapshot } | null)?.turns ??
        (raw as { snapshot?: TurnStateSnapshot } | null)?.snapshot
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        broadcast('turns:state', snapshot)
      }
      return true
    }
    case 'turn.snapshot':
    case 'turns.state':
    case 'turns.snapshot': {
      const snapshot =
        (event.data as { snapshot?: TurnStateSnapshot } | null)?.snapshot ??
        (event.data as { turns?: TurnStateSnapshot } | null)?.turns ??
        (event.data as { activity?: TurnStateSnapshot } | null)?.activity ??
        (event.data as TurnStateSnapshot | null)
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        broadcast('turns:state', snapshot)
      }
      return true
    }
    case 'thread.title-generation-failed': {
      const err = (event.data as { error?: string })?.error ?? 'Title generation failed'
      broadcast('threads:title-generation-failed', { threadId, error: err })
      console.error(`[title] generation failed for ${threadId}: ${err}`)
      return true
    }
    case 'turn.steered':
    case 'server.shutdown':
      return true
    case 'questions.cleared': {
      // A pending question resolved without this GUI answering it (answered
      // elsewhere, dismissed, timed out, or default-rejected by a preempting
      // send). Tell the selected thread's composer to drop the stale prompt —
      // otherwise the modal/inline approval lingers after the daemon moved on.
      if (isSelected) {
        broadcast('orchestrator:questionsCleared', {
          requestId: (event.data as { requestId?: string })?.requestId,
          threadId
        })
      }
      return true
    }
    default:
      return false
  }
}

/** Apply an authoritative thread snapshot onto IPC channels (reload/resnapshot path). */
export function broadcastThreadSnapshot(
  threadId: string,
  snapshot: {
    messages: unknown
    queue: unknown
    connectionFailed?: boolean
    agents?: unknown
    tasks?: unknown
  },
  broadcast: BroadcastFn,
  presentation: PresentationState
): void {
  broadcast('queue:updated', { threadId, items: snapshot.queue })
  if (presentation.getActiveThreadId() !== threadId) {
    // Background resync: keep thread-scoped messages available for any listener.
    broadcast('orchestrator:thread-messages', {
      threadId,
      messages: snapshot.messages
    })
    return
  }
  // Selected thread: one combined view event so the renderer can apply
  // messages + agents + tasks in a single store update (avoids 3–4 paints).
  broadcast('thread:view', {
    threadId,
    messages: snapshot.messages,
    agents: snapshot.agents ?? [],
    tasks: snapshot.tasks ?? []
  })
  if (snapshot.connectionFailed) {
    broadcast('orchestrator:connection-failed', undefined)
  }
}
