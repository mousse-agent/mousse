import { permissionModeAllows, type PermissionAction, type PermissionMode } from '../../shared/permissionMode'
import type { LineageRecord } from './types'

/**
 * Who may answer an approval request. One rule for every way in: the GUI, the CLI, Bridge clients,
 * `answer_subagent` and the agent control tools (#184's `approval_respond`). It is enforced where an
 * approval is settled (`UserQuestionService.submitAnswers`), never in a client.
 */

export type Answerer =
  /** The user, through one of their clients. */
  | { kind: 'user'; via?: 'gui' | 'cli' | 'bridge' | 'internal' }
  /** An agent answering for its own subagent, acting within its own run's permission mode. */
  | { kind: 'agent'; threadId: string; runId: string; permissionMode: PermissionMode }

/** What an approval is about: the thread that asked and the kind of action it asks to take. */
export interface ApprovalSubject {
  threadId: string
  action: PermissionAction
  permissionKey: string
}

/** What the answer says: allow or reject, and for an allow, once or for the thread (`always`). */
export interface ApprovalAnswer {
  decision: 'allow' | 'reject'
  scope?: 'once' | 'always'
}

export type ApprovalRefusal = 'own_request' | 'not_parent' | 'mode_forbids' | 'agent_no_standing_grant'

export type ApprovalRights = { ok: true } | { ok: false; code: ApprovalRefusal }

/** Looks up the lineage of a thread (a subagent's parent), or null for a thread without one. */
export type LineageLookup = (threadId: string) => Pick<LineageRecord, 'parentThreadId' | 'relationship'> | null

/**
 * The user may always answer. An agent may answer only for its own direct subagent, only for an
 * action its own permission mode allows without asking, never for its own request, and never with
 * a standing rule ("always"): only a user creates one.
 */
export function canAnswerApproval(
  request: ApprovalSubject,
  answerer: Answerer,
  answer: ApprovalAnswer,
  lineage: LineageLookup
): ApprovalRights {
  if (answerer.kind === 'user') return { ok: true }
  if (request.threadId === answerer.threadId) return { ok: false, code: 'own_request' }
  const link = lineage(request.threadId)
  if (!link || link.parentThreadId !== answerer.threadId || link.relationship !== 'subagent') return { ok: false, code: 'not_parent' }
  if (!permissionModeAllows(answerer.permissionMode, request.action)) return { ok: false, code: 'mode_forbids' }
  if (answer.decision === 'allow' && answer.scope === 'always') return { ok: false, code: 'agent_no_standing_grant' }
  return { ok: true }
}

/** Plain words for a refusal, written for the agent that was refused. */
export function describeApprovalRefusal(code: ApprovalRefusal): string {
  switch (code) {
    case 'own_request': return 'An agent cannot answer its own approval request; the user does.'
    case 'not_parent': return 'Only the parent of a subagent can answer its approval requests.'
    case 'mode_forbids': return 'Your permission mode would ask the user before this kind of action, so you cannot approve it for your subagent. Ask the user to answer it.'
    case 'agent_no_standing_grant': return 'Only the user can approve an action for the whole thread. Approve it once, or ask the user.'
  }
}
