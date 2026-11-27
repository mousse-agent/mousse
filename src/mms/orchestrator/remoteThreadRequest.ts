import { DomainRpcError } from '../protocol/domainRegistry'
import type { AgentRemoteThreadRequest } from '../run/mcp/appTools'

/**
 * The command kind of the receipt `thread_create` with `computer` writes (issue #1160). It shares the key space of
 * `thread_create` on this computer (`thread_create:<caller>:<clientRequestId>`), so one key is one launch, here or there.
 */
export const REMOTE_THREAD_COMMAND = 'remote_thread_create'

/** The arguments of a launch in one stable form: two calls with the same key must carry the same one. */
export function remoteThreadFingerprint(request: AgentRemoteThreadRequest): string {
  return JSON.stringify([
    'remote',
    request.computer.trim().toLowerCase(),
    request.projectId ?? null,
    request.title ?? null,
    request.workspace,
    request.instanceId ?? null,
    request.model ?? null,
    request.effort ?? null,
    request.firstMessage ?? null,
    request.firstMessage === undefined ? null : request.mode ?? 'agent',
    // A bot's project here; absent from an agent's launch, so a key stored before it keeps its fingerprint.
    ...(request.fromProjectId !== undefined ? [request.fromProjectId] : []),
    // Asked for only when the agent gave it, so a key stored before it keeps its fingerprint.
    ...(request.hidden !== undefined ? [{ hidden: request.hidden }] : []),
    // A thread in no project there; absent before it, so a key stored before it keeps its fingerprint.
    ...(request.noProject ? [{ noProject: true }] : [])
  ])
}

/**
 * A failed call to the other computer as a refusal the agent can act on, named for which it was: offline, not sharing
 * its threads with this computer, outdated, or not allowing this computer's agents. Any other code is that computer's own.
 */
export function remoteThreadRefusal(error: unknown, computerName: string): { code: string; message: string } {
  const code = error instanceof DomainRpcError ? error.code : 'computer_unreachable'
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'computer_offline':
    case 'bridge_off':
      return { code: 'computer_offline', message: message || `${computerName} is offline.` }
    case 'computer_forbidden':
      return { code: 'computer_not_shared', message: `${computerName} does not share its threads with this computer: ${message}` }
    case 'computer_outdated':
      return { code: 'computer_outdated', message: `Update Mousse on ${computerName} to start threads there.` }
    case 'agent_reach':
      return { code: 'computer_not_allowed', message: `${computerName} does not let this computer's agents start threads there: ${message}` }
    default:
      return { code, message }
  }
}
