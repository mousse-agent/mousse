/**
 * `request_answer` (docs/plans/tool-api.md §1.5 "request"): one tool answers a request someone is waiting on. Its
 * kind comes from the request its id names, never from an argument the caller picks, and each kind is answered by the
 * tool that answered it before, with that tool's authority unchanged (`MousseTool.variants`).
 */
import type { ApprovalRequestInfo } from './host'
import { refused } from './refusal'
import { CLIENT_REQUEST_ID_SCHEMA, type JsonSchema, type MousseTool, type ToolOutcome, type VariantSite } from './types'

export const REQUEST_ANSWER_TOOL = 'request_answer'

export type RequestKind = 'subagent' | 'approval' | 'relay'

/**
 * Each kind of request, the old tool that answers it (whose whole authority it keeps), and who may answer. A grant
 * of an old name holds its kind only (`MOUSSE_TOOL_ALIAS_ARGUMENTS`).
 */
export const REQUEST_ANSWER_KINDS: Readonly<Record<RequestKind, { tool: string; is: string; who: string }>> = Object.freeze({
  subagent: {
    tool: 'answer_subagent',
    is: "a question or approval of the caller's own subagent",
    who: 'Its direct parent only. An approval only within the parent\'s own permission mode, never "always", never one the person keeps for themselves (`canAnswerApproval`).'
  },
  approval: {
    tool: 'approval_respond',
    is: "another thread's approval",
    who: 'The profile\'s switch "Agents may answer approvals on other threads"; within the caller\'s own mode; never "always"; never its own thread nor its lineage (its direct subagents\' are `subagent`). The person\'s alone is refused: the provider\'s own checks, the user\'s ask rules, a turn a person started, a thread on another computer. A bot: what its grant and thread rules reach, and the plain questions of threads it started.'
  },
  relay: {
    tool: 'question_answer',
    is: "a question the bot's work asked its owner",
    who: "The bot's chat turn only, passing on the answer its owner gave in the chat."
  }
})

const KINDS = Object.keys(REQUEST_ANSWER_KINDS) as RequestKind[]

function isRequestKind(value: unknown): value is RequestKind {
  return typeof value === 'string' && (KINDS as string[]).includes(value)
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** What the kind of a request is read from: the requests threads here wait on, the subagents' lineage, receipts, bots. */
export interface RequestKindSite {
  request(requestId: string): ApprovalRequestInfo | undefined
  parentThread(threadId: string): string | undefined
  /** The kind an earlier call of the caller's with one of these keys answered (its receipt): a retry replays as it. */
  answered?(callerThreadId: string, keys: readonly string[]): RequestKind | undefined
  /** Whether `requestId` is a question the work of the bot that calls asked its owner. */
  botQuestion?(callerThreadId: string, requestId: string): boolean
}

/** What a call that names no request the caller may answer is told, whether it exists or not. */
export function noSuchRequest(requestId: string): ToolOutcome {
  return refused('scope_denied', `No such request: ${requestId}. It may have been answered or withdrawn already; thread_list lists the requests you may answer.`)
}

/**
 * The kind of the request a call names, from the request itself and never from the call: a retry of an answered call
 * is the kind its receipt says; a request a thread here waits on is the caller's subagent's when the caller is its
 * direct parent, else another thread's; a question a bot's work asked its owner is that bot's to relay. A request
 * found nowhere is no such request, unless the call names its thread (one on another computer, or a plain question a
 * bot answered), which the approval tool refuses or replays in its own words.
 */
export function requestKindOf(args: Record<string, unknown>, site: VariantSite, kinds: RequestKindSite): { kind: RequestKind; request?: ApprovalRequestInfo } | { refused: ToolOutcome } {
  const requestId = text(args.requestId)
  const questionId = text(args.questionId)
  if (requestId && questionId && requestId !== questionId)
    return { refused: refused('invalid_arguments', `requestId ${requestId} and questionId ${questionId} name different requests; give only requestId.`) }
  const id = requestId ?? questionId
  if (!id) return { refused: refused('invalid_arguments', 'request_answer needs the requestId of the request it answers.') }
  const request = kinds.request(id)
  const keys = [text(args.clientRequestId), site.toolCallId].filter((key): key is string => Boolean(key))
  const retried = keys.length ? kinds.answered?.(site.threadId, keys) : undefined
  if (retried) return { kind: retried, ...(request ? { request } : {}) }
  if (request) return { kind: kinds.parentThread(request.threadId) === site.threadId ? 'subagent' : 'approval', request }
  if (site.turn.bot && kinds.botQuestion?.(site.threadId, id)) return { kind: 'relay' }
  return text(args.thread) ?? text(args.threadId) ? { kind: 'approval' } : { refused: noSuchRequest(id) }
}

/**
 * The arguments the kind's tool takes, from `request_answer`'s or its old name's, and the thread it read from the
 * request rather than the call (`conceals`: the caller may not see it, so no refusal names it).
 */
function variantArgs(kind: RequestKind, args: Record<string, unknown>, request: ApprovalRequestInfo | undefined): { args: Record<string, unknown>; inferred?: string } {
  const thread = text(args.thread)
  const named = (key: string, given: string | undefined) => {
    const value = given ?? request?.threadId
    return { args: { ...args, ...(value ? { [key]: value } : {}), kind }, ...(!given && value ? { inferred: value } : {}) }
  }
  switch (kind) {
    case 'subagent':
      return named('subagent', text(args.subagent) ?? thread)
    case 'approval':
      return named('threadId', text(args.threadId) ?? thread)
    case 'relay':
      return { args: { ...args, questionId: text(args.questionId) ?? text(args.requestId), kind } }
  }
}

const ANSWERS_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Each question id of the request mapped to the chosen option id (an array when several are allowed) or to text. On an approval, text that is no option rejects it, and a short note of it (up to 200 characters) reaches its agent, labelled as from an agent.',
  additionalProperties: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }
}

const DESCRIPTION = 'Answer a request another agent is waiting on, by its requestId. Its kind comes from the id. A question or approval of your own subagent (from its question notice, or continue_subagent\'s needs_answer): only you, its direct parent, answer it. A pending approval of another thread (thread_list lists them with their option ids): needs the profile\'s switch "Agents may answer approvals on other threads", which is off by default, and its transcript shows an agent approved it. You approve only what your own permission mode allows without asking, never "always for this thread", never your own thread\'s request, nor one of your lineage other than your direct subagents\'. A request the provider asks for itself (its own safety check, a path outside the allowed folders, one of the user\'s own ask rules), one on a turn the user started, one on another computer, and a plain question for the user (question_ask) of a thread that is not your subagent are the user\'s alone and are refused. If someone answered first you get already_answered with who decided what, and nothing changes.'

/** A bot's own kind; the bot's text for the approvals of threads it reaches is that tool's (`approval_respond`). */
const RELAY_DESCRIPTION = 'Answer a request someone is waiting on, by its requestId. When your owner answers in the chat a question your work waits on (your situation lists each one, with its id), pass their answer on as answer: only their answer, in their words, never your own guess; if their words could answer more than one question, ask them which first.'

const INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    requestId: { type: 'string', description: 'The request\'s id.' },
    thread: { type: 'string', description: 'The thread that asked (optional: the id names it; checked when given).' },
    answers: ANSWERS_SCHEMA,
    answer: { type: 'string', description: 'A bot only: its owner\'s answer to a question its work asked, in their words.' },
    clientRequestId: CLIENT_REQUEST_ID_SCHEMA
  },
  required: ['requestId']
}

/** `request_answer` over the tools that answer each kind (one the host cannot serve is absent). */
export function requestAnswerTool(variants: Partial<Record<RequestKind, MousseTool>>, site: RequestKindSite): MousseTool {
  return {
    name: REQUEST_ANSWER_TOOL,
    description: DESCRIPTION,
    botDescription: [RELAY_DESCRIPTION, variants.approval?.botDescription].filter(Boolean).join(' '),
    inputSchema: INPUT_SCHEMA,
    // What each kind may do is its own tool's (\`variants\`): a read-only child answers its subagents, never another thread.
    access: 'actsAsCaller',
    class: 'mutation',
    readOnlySafe: true,
    describe: () => 'Answer a request',
    variants: KINDS.flatMap((kind) => variants[kind] ?? []),
    variantOf: (args, at) => {
      const resolved = requestKindOf(args, at, site)
      if ('refused' in resolved) return resolved
      const { kind, request } = resolved
      // A call under an old name (or one naming its kind) is that kind and no other: its grant holds nothing else.
      if (isRequestKind(args.kind) && args.kind !== kind)
        return { refused: refused('not_granted', `That request is ${REQUEST_ANSWER_KINDS[kind].is}; ${REQUEST_ANSWER_KINDS[args.kind].tool} answers only ${REQUEST_ANSWER_KINDS[args.kind].is}.`, { variant: kind }) }
      const tool = variants[kind]
      if (!tool) return { refused: refused('unavailable', `Nothing here answers ${REQUEST_ANSWER_KINDS[kind].is}.`, { variant: kind }) }
      const { args: taken, inferred } = variantArgs(kind, args, request)
      const id = text(args.requestId) ?? text(args.questionId) ?? ''
      return { tool, args: taken, ...(inferred ? { conceals: { threadId: inferred, refusal: noSuchRequest(id) } } : {}) }
    },
    handler: () => {
      throw new Error('request_answer runs as the kind of request its id names (variantOf).')
    }
  }
}
