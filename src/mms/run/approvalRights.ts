import { permissionModeAllows, type PermissionAction, type PermissionMode } from '../../shared/permissionMode'
import type { AgentAccessLevel } from '../../shared/settings'
import type { LineageRecord } from './types'

/**
 * Who may answer an approval request. One rule for every way in: the GUI, the CLI, Bridge clients,
 * `answer_subagent` and the agent control tools (#184's `approval_respond`). It is enforced where an
 * approval is settled (`UserQuestionService.submitAnswers`), never in a client.
 */

/**
 * What the profile lets an agent do beyond its own subagents, as it is at the moment the agent answers
 * (`approval_respond`). Absent for every other way an agent answers: those reach the agent's own subagents only.
 */
export interface AgentApprovalAccess {
  /** The agent's effective access level now (what it was granted, narrowed by the profile's setting). */
  level: AgentAccessLevel
  /** The profile's switch "Agents may answer approvals on other threads" (off by default). */
  answerApprovals: boolean
  /** Whether the profile's project list lets agents reach this thread's project. */
  projectAllowed(threadId: string): boolean
}

export type Answerer =
  /** The user, through one of their clients. */
  | { kind: 'user'; via?: 'gui' | 'cli' | 'bridge' | 'internal' }
  /**
   * An agent, acting within its own run's permission mode. It answers for its own subagent, and for a thread
   * outside its lineage only when `access` says the profile allows it. `toolCallId` is the call that answers,
   * kept with the answer so a retry of that call is told from another caller's.
   */
  | { kind: 'agent'; threadId: string; runId: string; permissionMode: PermissionMode; toolCallId?: string; access?: AgentApprovalAccess }

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

export type ApprovalRefusal =
  | 'own_request'
  | 'not_parent'
  | 'approvals_disabled'
  | 'project_not_allowed'
  | 'mode_forbids'
  | 'agent_no_standing_grant'
  | 'bridge_no_standing_grant'

/**
 * The run sources that are a person at their own app or CLI (`RunRecord.source`); anything else is not a person's turn.
 * `resume_now` is the continue turn a person asked for by pressing Resume now; the one the timer sends (`resume`) is not.
 */
const PERSON_SOURCES: ReadonlySet<string> = new Set(['gui', 'cli', 'resume_now'])

/**
 * Whether a person started the turn, which is the only kind of turn a standing "Always for this
 * thread" rule may answer for. A scheduled or webhook-started job, a delegated child, a bot, a workflow
 * or definition step, and a message another agent (or any internal caller) sent to the thread are
 * not: no one is watching them, and a rule made for a person's own turn must not run commands for
 * them. Fails closed: an unknown source is not a person.
 */
export function startedByPerson(run: { origin: string; source: string | null | undefined }): boolean {
  return run.origin === 'interactive' && typeof run.source === 'string' && PERSON_SOURCES.has(run.source)
}

export type ApprovalRights = { ok: true } | { ok: false; code: ApprovalRefusal }

/** Looks up the lineage of a thread (a subagent's parent), or null for a thread without one. */
export type LineageLookup = (threadId: string) => Pick<LineageRecord, 'parentThreadId' | 'relationship'> | null

/** Lineage walks stop here; a deeper chain is treated as no relation, which only ever refuses more. */
const LINEAGE_MAX_DEPTH = 64

/** The threads above `threadId` in the lineage, nearest first. */
function ancestorsOf(threadId: string, lineage: LineageLookup): string[] {
  const out: string[] = []
  let current = threadId
  for (let depth = 0; depth < LINEAGE_MAX_DEPTH; depth += 1) {
    const link = lineage(current)
    if (!link || out.includes(link.parentThreadId)) break
    out.push(link.parentThreadId)
    current = link.parentThreadId
  }
  return out
}

/**
 * The user may always answer. An agent may answer only for an action its own permission mode allows
 * without asking, never for its own request, and never with a standing rule ("always"): only a user
 * creates one. Whose requests it may answer:
 * - its own direct subagent's;
 * - any other thread's, only when its access (`approval_respond`) is `manage`, the profile's switch for
 *   answering approvals is on and the thread's project is one agents may reach. A thread of its own
 *   lineage (a subagent of a subagent, its parent or an ancestor) is never one of those: a subagent
 *   answers nothing above it, and only the direct parent answers for a child.
 */
export function canAnswerApproval(
  request: ApprovalSubject,
  answerer: Answerer,
  answer: ApprovalAnswer,
  lineage: LineageLookup
): ApprovalRights {
  if (answerer.kind === 'user') {
    // A linked device cannot list or revoke rules, so it does not make them either.
    if (answerer.via === 'bridge' && answer.decision === 'allow' && answer.scope === 'always') return { ok: false, code: 'bridge_no_standing_grant' }
    return { ok: true }
  }
  if (request.threadId === answerer.threadId) return { ok: false, code: 'own_request' }
  const link = lineage(request.threadId)
  const ownSubagent = link !== null && link.parentThreadId === answerer.threadId && link.relationship === 'subagent'
  if (!ownSubagent) {
    const access = answerer.access
    if (!access || access.level !== 'manage') return { ok: false, code: 'not_parent' }
    if (ancestorsOf(request.threadId, lineage).includes(answerer.threadId) || ancestorsOf(answerer.threadId, lineage).includes(request.threadId))
      return { ok: false, code: 'not_parent' }
    if (!access.answerApprovals) return { ok: false, code: 'approvals_disabled' }
    let projectAllowed = false
    try {
      projectAllowed = access.projectAllowed(request.threadId)
    } catch {
      projectAllowed = false
    }
    if (!projectAllowed) return { ok: false, code: 'project_not_allowed' }
  }
  if (!permissionModeAllows(answerer.permissionMode, request.action)) return { ok: false, code: 'mode_forbids' }
  if (answer.decision === 'allow' && answer.scope === 'always') return { ok: false, code: 'agent_no_standing_grant' }
  return { ok: true }
}

/** Plain words for a refusal, written for the agent that was refused. */
export function describeApprovalRefusal(code: ApprovalRefusal): string {
  switch (code) {
    case 'own_request': return 'An agent cannot answer its own approval request; the user does.'
    case 'not_parent': return 'Only the parent of a subagent can answer its approval requests.'
    case 'approvals_disabled': return 'The user has not allowed agents to answer approvals on other threads (Settings > Agents). Ask the user to answer it.'
    case 'project_not_allowed': return 'That thread is in a project the user has not given agents access to. Ask the user to answer it.'
    case 'mode_forbids': return 'Your permission mode would ask the user before this kind of action, so you cannot approve it for your subagent. Ask the user to answer it.'
    case 'agent_no_standing_grant': return 'Only the user can approve an action for the whole thread. Approve it once, or ask the user.'
    case 'bridge_no_standing_grant': return 'A linked device can allow a request once. "Always for this thread" is made in the app or the CLI, where the rule can be seen and revoked.'
  }
}
