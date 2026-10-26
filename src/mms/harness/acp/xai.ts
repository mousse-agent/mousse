import type { UserQuestion, UserQuestionAnswers } from '../../../shared/types'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import type { AcpClientHandlers } from './connection'
import type { AcpRequestScope } from './permissions'

/**
 * xAI's ACP extensions, as Grok sends them. Grok has used both the `_x.ai/` prefix (ACP's rule for
 * extensions) and a bare `x.ai/`, and may wrap the params as `{ method, params }`; all of these are
 * accepted. Anything else of xAI's is left to the SDK (requests answered "method not found",
 * notifications ignored).
 */

export const XAI_PREFIXES = ['_x.ai/', 'x.ai/'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The params of an xAI message, unwrapped from `{ method, params }`. */
export function xaiParams(params: unknown): Record<string, unknown> {
  if (isRecord(params) && typeof params.method === 'string' && isRecord(params.params)) return params.params
  return isRecord(params) ? params : {}
}

/** `name` under every prefix. */
function both<T>(name: string, value: T): Record<string, T> {
  return Object.fromEntries(XAI_PREFIXES.map((prefix) => [`${prefix}${name}`, value]))
}

/**
 * `ask_user_question`: Grok's questions go to the thread's questions; the answers go back keyed by
 * the question text, as the labels picked. Nothing picked (a stopped turn, dismissed) is `cancelled`.
 */
export async function answerXaiQuestions(questions: UserQuestionService, scope: AcpRequestScope, params: unknown): Promise<unknown> {
  const cancelled = { outcome: 'cancelled' }
  const asked = Array.isArray(xaiParams(params).questions) ? (xaiParams(params).questions as unknown[]).filter(isRecord) : []
  if (scope.aborted() || !scope.threadId || !asked.length) return cancelled
  const shown: Array<UserQuestion & { text: string; labels: Map<string, string> }> = asked.flatMap((question, index) => {
    if (typeof question.question !== 'string' || !question.question.trim()) return []
    const options = Array.isArray(question.options) ? question.options.filter(isRecord) : []
    const labels = new Map<string, string>()
    for (const [position, option] of options.entries())
      if (typeof option.label === 'string' && option.label) labels.set(`option-${position}`, option.label)
    return [{
      id: `q${index}`,
      prompt: question.question,
      text: question.question,
      options: [...labels].map(([id, label]) => ({ id, label })),
      ...(question.multiSelect === true ? { allowMultiple: true } : {}),
      labels
    }]
  })
  if (!shown.length) return cancelled
  let answers: UserQuestionAnswers
  try {
    answers = await questions.requestAnswers(shown.map(({ id, prompt, options, allowMultiple }) => ({ id, prompt, options, ...(allowMultiple ? { allowMultiple } : {}) })), scope.threadId)
  } catch {
    return cancelled
  }
  if (scope.aborted()) return cancelled
  const result: Record<string, string[]> = {}
  for (const question of shown) {
    const answer = answers[question.id]
    const picked = (Array.isArray(answer) ? answer : typeof answer === 'string' ? [answer] : [])
      .map((value) => question.labels.get(value) ?? value)
      .filter((value) => value.trim())
    if (picked.length) result[question.text] = picked
  }
  return Object.keys(result).length ? { outcome: 'accepted', answers: result } : cancelled
}

export interface XaiHooks {
  questions: UserQuestionService
  scope: AcpRequestScope
  /** `session/prompt_complete` for a prompt Mousse tagged, with its params (`stopReason`, an error). */
  promptComplete(promptId: string, params: Record<string, unknown>): void
}

/** Stop reasons of a prompt that finished as asked (ACP's, plus `cancelled`). */
const FINISHED = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'cancelled'])

/**
 * Why a prompt that ended (its reply, or its `prompt_complete`) did not finish: a refusal, an
 * error it reports (a rate limit), or a stop reason Mousse does not know. Undefined when it finished.
 */
export function xaiStopFailure(label: string, outcome: unknown): Error | undefined {
  const value = isRecord(outcome) ? outcome : {}
  const result = isRecord(value.agentResult) ? value.agentResult : {}
  const error = value.error ?? result.error
  if (error !== undefined && error !== null) {
    const message = isRecord(error) && typeof error.message === 'string' ? error.message : typeof error === 'string' ? error : 'an error'
    return new Error(`${label} stopped with ${message}`)
  }
  const reason = value.stopReason
  if (reason === 'refusal') return new Error(`${label} refused this request.`)
  if (typeof reason === 'string' && !FINISHED.has(reason)) return new Error(`${label} stopped early (${reason}).`)
  return undefined
}

/** The client handlers for xAI's extensions. */
export function xaiHandlers(hooks: XaiHooks): Pick<AcpClientHandlers, 'extRequests' | 'extNotifications'> {
  return {
    extRequests: {
      ...both('ask_user_question', (params: unknown) => answerXaiQuestions(hooks.questions, hooks.scope, params)),
      // Mousse runs no Grok plan mode: a request to leave one never blocks the turn.
      ...both('exit_plan_mode', async () => ({ outcome: 'abandoned' }))
    },
    extNotifications: both('session/prompt_complete', (params: unknown) => {
      const value = xaiParams(params)
      if (typeof value.promptId === 'string') hooks.promptComplete(value.promptId, value)
    })
  }
}
