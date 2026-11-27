/**
 * One refusal shape for Mousse tools (docs/plans/tool-api.md §1.2 "Results and refusals"). A refused call is an error
 * result (`isError: true`) whose text is `{ refused: { code, message, retry, ... } }`, on every transport: the Mousse
 * MCP server, a call into the registry in process, a bot's turn and Pi's tool path. JSON-RPC errors are kept for
 * protocol and credential faults (`REFUSAL_FAULT_CODES`).
 *
 * This module imports nothing, so Pi's extension bundle can use it too.
 */

/** Every refusal code a Mousse tool gives. */
export const REFUSAL_CODES = [
  /** The call names a thread, project or job the caller may not reach. */
  'scope_denied',
  /** The caller's permission mode is stricter than what the call would need (a steer of a run bound to a looser mode). */
  'ceiling_exceeded',
  /** A read-only subagent called a tool that changes something. */
  'read_only',
  /**
   * The thread lists the tool but this turn does not hold a capability it needs (§1.3 "Lacks"): `lacks` names it and
   * `fix` what would give it. The older code it was refused under stays in `data.reason`.
   */
  'lacks_capability',
  /** The target is not in a state to take the call now; `data.conflict` names which state. */
  'conflict',
  /** The tool cannot be used in this turn (no browser bound to it, a feature switched off, a missing argument the turn needs). */
  'unavailable',
  /** What the caller is held to (a bot's grant, an agent definition's grants) does not allow the call. */
  'not_granted',
  /** The person was asked and did not approve the call. */
  'not_approved',
  /** The call would wait for a person and nobody answers this run. */
  'needs_person',
  /** The arguments do not describe a call the tool can make. */
  'invalid_arguments',
  /** No tool of that name is offered here (a bot's `use_tool`). */
  'unknown_tool',
  /** The call was cancelled before it ran. */
  'cancelled',
  /**
   * A bot's chat may not finish this call itself: it ran out of the chat's time for quick calls and was stopped cleanly
   * (a call known to only read). `fix` names the tool that does it instead (`work_start`).
   */
  'work_required',
  /**
   * The call may have done something and it can't be told whether it did: it was sent, and its time ran out before it
   * answered. Never repeat it blindly; `fix` names where to check or carry on (`work_start` for a bot's chat).
   */
  'uncertain',
  /** The tool ran and failed, or refused for a reason no other code names. */
  'failed'
] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

/** Whether calling again can help: `never`, `later` (the same call, once the state clears), or `after_change` (a different call). */
export type RefusalRetry = 'never' | 'later' | 'after_change'

export interface Refusal {
  code: RefusalCode
  message: string
  retry: RefusalRetry
  retryAfterSeconds?: number
  /** The capability the caller lacks. */
  lacks?: string
  /** The variant of the tool that was refused (a `kind`, an `intent`). */
  variant?: string
  /** What would let the call through. */
  fix?: string
}

export type RefusalOptions = Partial<Pick<Refusal, 'retry' | 'retryAfterSeconds' | 'lacks' | 'variant' | 'fix'>> & {
  /** Fields kept beside `refused` from the older shapes (`data.conflict` and the like), which prompts and tools read. */
  data?: Record<string, unknown>
}

/** How each code is retried unless the refusal says otherwise. */
const DEFAULT_RETRY: Readonly<Record<RefusalCode, RefusalRetry>> = {
  scope_denied: 'never',
  ceiling_exceeded: 'never',
  read_only: 'never',
  lacks_capability: 'after_change',
  conflict: 'after_change',
  unavailable: 'after_change',
  not_granted: 'after_change',
  not_approved: 'never',
  needs_person: 'never',
  invalid_arguments: 'after_change',
  unknown_tool: 'after_change',
  cancelled: 'later',
  work_required: 'never',
  uncertain: 'never',
  failed: 'after_change'
}

/** A refusal as the text of an error result. */
export function refusalText(code: RefusalCode, message: string, options: RefusalOptions = {}): string {
  const { data, ...rest } = options
  const refused: Refusal = { code, message, retry: rest.retry ?? DEFAULT_RETRY[code] }
  if (rest.retryAfterSeconds !== undefined) refused.retryAfterSeconds = rest.retryAfterSeconds
  if (rest.lacks !== undefined) refused.lacks = rest.lacks
  if (rest.variant !== undefined) refused.variant = rest.variant
  if (rest.fix !== undefined) refused.fix = rest.fix
  return JSON.stringify(data && Object.keys(data).length ? { refused, data } : { refused })
}

/** A refused call's outcome. */
export function refused(code: RefusalCode, message: string, options: RefusalOptions = {}): { text: string; isError: true } {
  return { text: refusalText(code, message, options), isError: true }
}

/** The refusal an error result's text carries, or null when it is not one. */
export function readRefusal(text: string): Refusal | null {
  if (!text.startsWith('{"refused":')) return null
  try {
    const parsed = JSON.parse(text) as { refused?: Refusal }
    return parsed.refused && typeof parsed.refused.code === 'string' && typeof parsed.refused.message === 'string' ? parsed.refused : null
  } catch {
    return null
  }
}

/**
 * An error result in the refusal shape: one already in it as it is, any other with its text as the message. A tool
 * that ran and failed (`ran`, such as a command's non-zero exit with its output) is not refused: its text stays as it is.
 */
export function asRefusal<T extends { text: string; isError?: boolean; ran?: boolean }>(outcome: T, code: RefusalCode = 'failed'): T {
  if (!outcome.isError || outcome.ran || readRefusal(outcome.text)) return outcome
  return { ...outcome, text: refusalText(code, outcome.text || 'The tool failed.') }
}

/** The older JSON-RPC error codes that stay JSON-RPC errors: the credential's turn is over, or the tool is not there. */
export const REFUSAL_FAULT_CODES: ReadonlySet<string> = new Set(['mousse_unauthorized', 'mousse_caller_not_live', 'mousse_unknown_tool'])

const LEGACY_CODES: Readonly<Record<string, RefusalCode>> = {
  mousse_scope_denied: 'scope_denied',
  mousse_read_only: 'read_only',
  mousse_conflict: 'conflict',
  mousse_unknown_tool: 'unknown_tool'
}

/** Conflicts that clear by themselves: the same call may succeed later. */
const LATER_CONFLICTS: ReadonlySet<string> = new Set([
  'thread_paused',
  'questions_pending',
  'agent_queue_full_per_sender',
  'agent_queue_full',
  'duplicate_message',
  'merge_back_pending',
  'steer_target_not_ready',
  'run_paused'
])

/** Conflicts no retry gets past in this turn. */
const NEVER_CONFLICTS: ReadonlySet<string> = new Set(['agent_hops_exceeded', 'device_limit', 'not_started_by_this_computer'])

/** Codes of another computer's refusals that no retry from this one gets past. */
const REMOTE_SCOPE_CODES: ReadonlySet<string> = new Set(['outside_agent_reach', 'computer_not_shared', 'computer_not_allowed', 'remote_from_remote', 'private_thread', 'computer_forbidden'])

/**
 * Another computer's refusal (or one about reaching it), as an error result. Its own code stays as it was, in
 * `data.code`, with the other fields it named (`computer`, `reach`, `computers`, `candidates`).
 */
export function remoteRefusal(code: string, message: string, data: Record<string, unknown> = {}): { text: string; isError: true } {
  const options: RefusalOptions = { data: { ok: false, code, ...data } }
  if (REMOTE_SCOPE_CODES.has(code)) return refused('scope_denied', message, options)
  return refused('unavailable', message, code === 'computer_offline' ? { ...options, retry: 'later' } : options)
}

/**
 * A refusal thrown as an older JSON-RPC code (`McpToolError`), as an error result: its code mapped onto the list, its
 * details kept under `data` with `reason` naming the older code, as the JSON-RPC error's `data` had them.
 */
export function legacyRefusal(code: string, message: string, details: Record<string, unknown> = {}): { text: string; isError: true } {
  // A capability the turn lacks (the authority compiler names it): `lacks_capability`, retried after a change.
  if (typeof details.lacks === 'string') {
    const { lacks, fix, ...rest } = details
    return refused('lacks_capability', message, { lacks, ...(typeof fix === 'string' ? { fix } : {}), data: { ...rest, reason: code } })
  }
  const mapped = LEGACY_CODES[code] ?? 'failed'
  const conflict = typeof details.conflict === 'string' ? details.conflict : undefined
  const retryAfterMs = typeof details.retryAfterMs === 'number' ? details.retryAfterMs : undefined
  let retry: RefusalRetry | undefined
  if (mapped === 'conflict') {
    if (retryAfterMs !== undefined || (conflict && LATER_CONFLICTS.has(conflict))) retry = 'later'
    else if (conflict && NEVER_CONFLICTS.has(conflict)) retry = 'never'
  }
  return refused(mapped, message, {
    ...(retry ? { retry } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) } : {}),
    data: { ...details, reason: code }
  })
}
