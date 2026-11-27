import { Type, type Tool } from '@earendil-works/pi-ai'
import type { LlmToolEvent } from '../../../harness/turnEvents'
import type { AppToolHost } from './host'
import {
  abortRace,
  ASK_USER_TIMEOUT_MS,
  disabledInSettings,
  plainSchema,
  truncateForDisplay,
  type AppToolTurn,
  type MousseTool,
  type ToolCallContext,
  type ToolImage,
  type ToolOutcome
} from './types'
import type { UserQuestionAttachments } from '../../../../shared/types'
import { ownList } from '../../../orchestrator/questionAttachments'

type Question = { id: string; prompt: string; options: Array<{ id: string; label: string }>; allowMultiple?: boolean }

const ASK_USER_DEFINITION: Tool = {
  name: 'question_ask',
  description: 'Ask the user one or more clarifying questions. Use when requirements are ambiguous.\n' +
    'Wait (the default) when nothing useful can happen without the answer: the call returns the answers.\n' +
    'Set wait to false when you can carry on with other parts of the job meanwhile: the call returns the question\'s id at once and you keep working. ' +
    'The answer arrives later as a message that names that id: in this turn if it is still running, otherwise as a new turn. ' +
    'Don\'t do the part that needs the answer, and don\'t ask the same thing again, until it comes. ' +
    'Several questions can be open at once. If you no longer need one, withdraw it with question_withdraw.',
  parameters: Type.Object({
    questions: Type.Array(
      Type.Object({
        id: Type.String({ description: 'Stable question id for the answer map.' }),
        prompt: Type.String({ description: 'Question shown to the user.' }),
        options: Type.Array(Type.Object({ id: Type.String(), label: Type.String() })),
        allowMultiple: Type.Optional(Type.Boolean({ description: 'Allow selecting multiple options.' }))
      }),
      { minItems: 1, maxItems: 3 }
    ),
    wait: Type.Optional(Type.Boolean({ description: 'true (default): wait for the answers. false: ask, keep working, and get the answer later.' }))
  })
}

const WITHDRAW_QUESTION_DEFINITION: Tool = {
  name: 'question_withdraw',
  description: 'Withdraw a question you asked with question_ask and wait false, when you no longer need its answer (you found it out, or the plan changed). Its card goes away.',
  parameters: Type.Object({
    questionId: Type.String({ description: 'The id question_ask returned for the question.' })
  })
}

/** What the agent is told after asking without waiting. */
function openQuestionText(questionId: string): string {
  return JSON.stringify({
    questionId,
    status: 'open',
    note: 'The question is shown to the user. Keep working on what does not need the answer. The answer arrives as a message naming this questionId. Withdraw it with question_withdraw if you no longer need it.'
  }, null, 2)
}

/**
 * `question_ask` is offered in Agent mode and in a read-only mode. Subagents and Build/Skill modes go without it so
 * workers implement instead of stopping to ask.
 */
function offeredInMode(turn: AppToolTurn): boolean {
  return turn.modeFacts.readOnly || (!turn.subagent && turn.modeFacts.agent)
}

/** The questions a call names: each with an id, a prompt and at least two options; malformed entries are dropped. */
export function parseQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): Question[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const id = String(record.id ?? '').trim()
    const prompt = String(record.prompt ?? '').trim()
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return []
          const opt = option as Record<string, unknown>
          const optId = String(opt.id ?? '').trim()
          const label = String(opt.label ?? '').trim()
          return optId && label ? [{ id: optId, label }] : []
        })
      : []
    if (!id || !prompt || options.length < 2) return []
    return [{ id, prompt, options, allowMultiple: record.allowMultiple === true }]
  })
}

/**
 * `question_ask`: the thread's question card, answered by the user. With `wait: false` the agent does not wait: the question
 * is saved and shown, its id comes back at once, and the answer reaches the thread later through its inbox.
 * `question_withdraw` takes such a question back.
 */
export function askUserTools(host: AppToolHost): MousseTool[] {
  const ask = async (args: Record<string, unknown>, threadId: string | undefined, ctx: ToolCallContext): Promise<ToolOutcome> => {
    try {
      const questions = parseQuestions(args.questions)
      if (questions.length === 0) return { text: 'No valid questions provided.', isError: true }
      if (!threadId) return { text: 'Cannot ask a question without an active thread.', isError: true }
      if (args.wait === false || args.wait === 'false') {
        if (!host.askWithoutWaiting) return { text: 'Asking without waiting is not available here; ask with wait true.', isError: true }
        const runId = (ctx.transport === 'mcp' ? ctx.caller.runId : ctx.turn.runId) || null
        return { text: openQuestionText(host.askWithoutWaiting(threadId, questions, runId)), isError: false }
      }
      // Images sent with the answers come back as images too; the answers name their saved files.
      const images: ToolImage[] = []
      const onAttachments = (attachments: UserQuestionAttachments): void => {
        for (const question of questions)
          for (const image of ownList(attachments, question.id) ?? []) images.push({ data: image.data, mimeType: image.mimeType })
      }
      const answers = await host.askUser(threadId, questions, ctx.transport === 'mcp'
        ? { signal: ctx.signal, timeoutMs: ASK_USER_TIMEOUT_MS, onAttachments }
        // The pi loop's questions keep the service's default wait; its stop dismisses them below.
        : { onAttachments })
      return { text: JSON.stringify(answers, null, 2), isError: false, ...(images.length ? { images } : {}) }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
  const run = async (args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> => {
    const threadId = ctx.transport === 'mcp' ? ctx.caller.threadId : ctx.turn.threadId || undefined
    if (ctx.transport === 'mcp') return ask(args, threadId, ctx)
    const callEvent: LlmToolEvent = {
      kind: 'build_tool_call',
      title: 'Question tool question_ask',
      summary: 'The assistant asked the user a question.',
      details: ['Tool: question_ask'],
      response: JSON.stringify(args, null, 2)
    }
    ctx.timeline?.record(callEvent, 'start')
    ctx.markEffect?.()
    const result = await abortRace(ask(args, threadId, ctx), ctx.signal, () => { if (threadId) host.dismissQuestions?.(threadId) })
    ctx.timeline?.record({
      kind: 'build_tool_result',
      title: 'Question tool question_ask',
      summary: result.isError ? 'The question tool returned an error.' : 'The question tool returned successfully.',
      details: ['Tool: question_ask'],
      response: truncateForDisplay(result.text)
    }, 'complete')
    return result
  }
  const withdraw = (args: Record<string, unknown>, ctx: ToolCallContext): ToolOutcome => {
    const threadId = ctx.transport === 'mcp' ? ctx.caller.threadId : ctx.turn.threadId || undefined
    const questionId = String(args.questionId ?? '').trim()
    if (!questionId) return { text: 'question_withdraw needs the questionId question_ask returned.', isError: true }
    if (!threadId || !host.withdrawQuestion) return { text: 'Cannot withdraw a question without an active thread.', isError: true }
    return host.withdrawQuestion(threadId, questionId)
      ? { text: `Question ${questionId} is withdrawn.`, isError: false }
      : { text: `Question ${questionId} is not open in this thread: it was already answered, dismissed, withdrawn or closed. If an answer came, it is in a message naming this id.`, isError: true }
  }
  return [{
    name: 'question_ask',
    description: `${ASK_USER_DEFINITION.description} A call that waits returns when the user answers (at most one hour) or your run ends.`,
    inputSchema: plainSchema(ASK_USER_DEFINITION),
    definition: () => ASK_USER_DEFINITION,
    access: 'actsAsCaller',
    class: 'read',
    readOnlySafe: true,
    asksUser: 'question',
    available: (turn) => (turn.settingsEnabled('question_ask') ? true : disabledInSettings('question_ask')),
    offered: (turn) => offeredInMode(turn) && turn.settingsEnabled('question_ask'),
    describe: () => 'Question tool question_ask',
    handler: (args, ctx) => run(args, ctx)
  }, {
    name: 'question_withdraw',
    description: WITHDRAW_QUESTION_DEFINITION.description,
    inputSchema: plainSchema(WITHDRAW_QUESTION_DEFINITION),
    definition: () => WITHDRAW_QUESTION_DEFINITION,
    access: 'actsAsCaller',
    class: 'read',
    readOnlySafe: true,
    // Offered with `question_ask`, and only where a question can be asked without waiting.
    available: (turn) => (turn.settingsEnabled('question_ask') ? true : disabledInSettings('question_ask')),
    offered: (turn) => offeredInMode(turn) && turn.settingsEnabled('question_ask') && host.withdrawQuestion !== undefined,
    describe: () => 'Question tool question_withdraw',
    handler: async (args, ctx) => withdraw(args, ctx)
  }]
}
