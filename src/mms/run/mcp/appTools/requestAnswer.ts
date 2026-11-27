/**
 * `request_answer` (docs/plans/tool-api.md §1.5 "request"): one tool answers a request someone is waiting on. Its
 * kind comes from the request its id names, never from an argument the caller picks, and each kind is answered by the
 * tool that answered it before, with that tool's authority unchanged (`MousseTool.variants`).
 */
import type { ApprovalRequestInfo } from './host'
import { refused } from './refusal'
import { CLIENT_REQUEST_ID_SCHEMA, type AppToolTurn, type JsonSchema, type McpCaller, type MousseTool } from './types'

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

/** What the kind of a request is read from: the requests the threads here wait on, and the subagents' lineage. */
export interface RequestKindSite {
  request(requestId: string): ApprovalRequestInfo | undefined
  parentThread(threadId: string): string | undefined
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/**
 * The kind of the request a call names. A request a thread here waits on is the caller's subagent's when the caller is
 * its direct parent, else another thread's. One no thread here waits on is a question a bot's work asked its owner
 * (the bots keep those), or one already settled, withdrawn or on another computer: the kind the call names then says
 * so in its own words, as its old tool did.
 */
export function requestKindOf(args: Record<string, unknown>, caller: McpCaller, turn: AppToolTurn, site: RequestKindSite): { kind: RequestKind; request?: ApprovalRequestInfo } {
  const requestId = text(args.requestId) ?? text(args.questionId)
  const request = requestId ? site.request(requestId) : undefined
  if (request) return { kind: site.parentThread(request.threadId) === caller.threadId ? 'subagent' : 'approval', request }
  if (isRequestKind(args.kind)) return { kind: args.kind }
  // A bot's relay never names a thread: a call that does is another thread's request.
  const namesThread = text(args.thread) ?? text(args.threadId)
  return { kind: !namesThread && turn.bot?.appTools.has(REQUEST_ANSWER_KINDS.relay.tool) ? 'relay' : 'approval' }
}

/** The arguments the kind's tool takes, from `request_answer`'s or its old name's. */
function variantArgs(kind: RequestKind, args: Record<string, unknown>, request: ApprovalRequestInfo | undefined): Record<string, unknown> {
  const given = (key: string, value: string | undefined) => (value ? { [key]: value } : {})
  const thread = text(args.thread)
  switch (kind) {
    case 'subagent':
      return { ...args, ...given('subagent', text(args.subagent) ?? thread ?? request?.threadId), kind }
    case 'approval':
      return { ...args, ...given('threadId', text(args.threadId) ?? thread ?? request?.threadId), kind }
    case 'relay':
      return { ...args, ...given('questionId', text(args.questionId) ?? text(args.requestId)), kind }
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
    variantOf: (args, { caller, turn }) => {
      const { kind, request } = requestKindOf(args, caller, turn, site)
      // A call under an old name (or one naming its kind) is that kind and no other: its grant holds nothing else.
      if (isRequestKind(args.kind) && args.kind !== kind)
        return { refused: refused('not_granted', `That request is ${REQUEST_ANSWER_KINDS[kind].is}; ${REQUEST_ANSWER_KINDS[args.kind].tool} answers only ${REQUEST_ANSWER_KINDS[args.kind].is}.`, { variant: kind }) }
      const tool = variants[kind]
      if (!tool) return { refused: refused('unavailable', `Nothing here answers ${REQUEST_ANSWER_KINDS[kind].is}.`, { variant: kind }) }
      return { tool, args: variantArgs(kind, args, request) }
    },
    handler: () => {
      throw new Error('request_answer runs as the kind of request its id names (variantOf).')
    }
  }
}
