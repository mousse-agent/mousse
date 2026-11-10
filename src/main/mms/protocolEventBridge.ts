/**
 * Map protocol events to existing renderer IPC channel names/payloads.
 */

import type { ProtocolEvent } from '../../mms/protocol'
import type { PresentationState } from './PresentationState'
import type { TurnState, TurnStateSnapshot } from '../../shared/types'

export type BroadcastFn = (channel: string, data: unknown) => void

/**
 * A thread list as the `threads:updated` channel carries it: `{ threads, version }` when the service versioned the
 * snapshot (a push or a `threads.list` reply), so the window can drop one older than a list it already holds;
 * the bare list otherwise.
 */
export function threadListPayload(data: unknown, list: 'threads' | 'all' = 'threads'): unknown {
  const value = data as { threads?: unknown; all?: unknown; version?: unknown } | null
  if (!value || Array.isArray(value) || !Array.isArray(value[list])) return value
  const version = value.version as { epoch?: unknown; seq?: unknown } | undefined
  return version && typeof version.epoch === 'string' && typeof version.seq === 'number'
    ? { threads: value[list], version: { epoch: version.epoch, seq: version.seq, generation: listGeneration(version.epoch) } }
    : value[list]
}

/**
 * Each service store's list epoch, numbered in the order this process first saw it. A store that replaced another (the
 * service restarted, or a profile's services were made again) is first seen later, so it always has the higher number;
 * a list a retired store sent, arriving late, carries the lower one and is dropped by the window.
 */
const epochGenerations = new Map<string, number>()
export function listGeneration(epoch: string): number {
  let generation = epochGenerations.get(epoch)
  if (generation === undefined) {
    generation = epochGenerations.size + 1
    epochGenerations.set(epoch, generation)
  }
  return generation
}

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
    case 'stats.lineEdits.updated': {
      broadcast('lineEdits:updated', (event.data as { snapshot: unknown }).snapshot)
      return true
    }
    case 'projects.updated': {
      const projects =
        (event.data as { projects?: unknown } | null)?.projects ?? event.data
      broadcast('projects:updated', projects)
      return true
    }
    case 'threads.updated': {
      broadcast('threads:updated', threadListPayload(event.data))
      return true
    }
    // Saves that moved only threads' times (`threads.touched`): the window patches those rows.
    case 'threads.touched': {
      const touches = (event.data as { touches?: unknown } | null)?.touches
      if (Array.isArray(touches)) broadcast('threads:touched', touches)
      return true
    }
    case 'subagents.updated': {
      const parentThreadId = (event.data as { parentThreadId?: string } | null)?.parentThreadId
      if (parentThreadId) broadcast('subagents:updated', { parentThreadId })
      return true
    }
    case 'thread.message': {
      const message = (event.data as { message?: unknown } | null)?.message
      if (threadId != null) {
        broadcast('orchestrator:thread-message', { threadId, message })
      }
      return true
    }
    case 'thread.message-updated': {
      const message = (event.data as { message?: unknown } | null)?.message
      if (threadId != null) {
        broadcast('orchestrator:thread-message-updated', { threadId, message })
      }
      return true
    }
    case 'thread.messages': {
      const snapshot = event.data as { messages?: unknown; replace?: boolean } | null
      const messages = snapshot?.messages
      if (threadId != null) {
        broadcast('orchestrator:thread-messages', { threadId, messages, ...(snapshot?.replace === true ? { replace: true } : {}) })
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
        broadcast('orchestrator:connection-failed', event.data)
      }
      return true
    }
    case 'questions.pending': {
      // Pending questions are interactive and must never leak into another selected thread.
      if (isSelected) {
        const approval = (event.data as { approval?: unknown })?.approval
        broadcast('orchestrator:questionsPending', {
          requestId: (event.data as { requestId?: string })?.requestId,
          questions: (event.data as { questions?: unknown })?.questions,
          threadId,
          // A saved approval request says so: the chat shows it inline instead of in the question dialog.
          ...(approval ? { approval } : {})
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
    case 'terminal.activated': {
      if (isSelected) broadcast('pty:activated', event.data)
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
      // The asks other computers made for editor connections changed: windows read the waiting ones again.
      const kind = (event.data as { kind?: unknown } | null)?.kind
      if (kind === 'remote-editor-ask' || kind === 'remote-editor-asks') broadcast('net:editor-asks', null)
      return true
    }
    case 'net.updated': {
      broadcast('net:updated', event.data)
      return true
    }
    case 'scheduled.updated': {
      broadcast(
        'scheduled:updated',
        (event.data as { jobs?: unknown })?.jobs ?? event.data
      )
      return true
    }
    case 'pullRequests.updated': {
      broadcast('pullRequests:updated', event.data)
      return true
    }
    // Another view changed what the next commit takes: the Changes tab reads it again.
    case 'git.selectionChanged': {
      broadcast('git:selectionChanged', event.data)
      return true
    }
    case 'scheduled.status': {
      broadcast(
        'scheduled:status',
        (event.data as { status?: unknown })?.status ?? event.data
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
    case 'providers.install-event': {
      const data = event.data as { event?: unknown }
      if (data?.event) broadcast('providers:install:event', data.event)
      return true
    }
    case 'providers.snapshots': {
      broadcast('providers:snapshots', event.data)
      return true
    }
    case 'providers.operation': {
      const data = event.data as { event?: unknown }
      if (data?.event) broadcast('providers:operation', data.event)
      return true
    }
    case 'mcp.changed': {
      broadcast('mcp:changed', null)
      return true
    }
    case 'bots.changed': {
      broadcast('bots:changed', event.data ?? {})
      return true
    }
    // A chat was created, sent to, answered or settled: the window reads the chats again.
    case 'chats.changed': {
      broadcast('chats:changed', null)
      return true
    }
    case 'bots.message': {
      broadcast('bots:message', event.data)
      return true
    }
    case 'bots.activity': {
      broadcast('bots:activity', event.data)
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
    case 'turn.steered': {
      const text = (event.data as { text?: string })?.text ?? ''
      broadcast('orchestrator:turn-steered', { threadId, text })
      return true
    }
    case 'turn-steered':
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
    /** Older messages the snapshot left out (a long thread of another computer). */
    earlier?: { before: string; count: number }
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
    tasks: snapshot.tasks ?? [],
    ...(snapshot.earlier ? { earlier: snapshot.earlier } : {})
  })
  if (snapshot.connectionFailed) {
    broadcast('orchestrator:connection-failed', undefined)
  }
}
