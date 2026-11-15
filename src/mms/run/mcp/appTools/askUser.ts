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
  type ToolOutcome
} from './types'

type Question = { id: string; prompt: string; options: Array<{ id: string; label: string }>; allowMultiple?: boolean }

const ASK_USER_DEFINITION: Tool = {
  name: 'ask_user',
  description: 'Ask the user one or more clarifying questions before continuing. Use when requirements are ambiguous.',
  parameters: Type.Object({
    questions: Type.Array(
      Type.Object({
        id: Type.String({ description: 'Stable question id for the answer map.' }),
        prompt: Type.String({ description: 'Question shown to the user.' }),
        options: Type.Array(Type.Object({ id: Type.String(), label: Type.String() })),
        allowMultiple: Type.Optional(Type.Boolean({ description: 'Allow selecting multiple options.' }))
      }),
      { minItems: 1, maxItems: 3 }
    )
  })
}

/**
 * `ask_user` is offered in Plan mode and in Agent mode alike. Subagents and Build/Skill modes go without it so
 * workers implement instead of stopping to ask.
 */
function offeredInMode(turn: AppToolTurn): boolean {
  return !turn.discovery && (turn.modeFacts.readOnly || (!turn.subagent && turn.modeFacts.agent))
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

/** `ask_user`: the thread's question card, answered by the user. */
export function askUserTools(host: AppToolHost): MousseTool[] {
  const ask = async (args: Record<string, unknown>, threadId: string | undefined, ctx: ToolCallContext): Promise<ToolOutcome> => {
    try {
      const questions = parseQuestions(args.questions)
      if (questions.length === 0) return { text: 'No valid questions provided.', isError: true }
      if (!threadId) return { text: 'Cannot ask a question without an active thread.', isError: true }
      const answers = await host.askUser(threadId, questions, ctx.transport === 'mcp'
        ? { signal: ctx.signal, timeoutMs: ASK_USER_TIMEOUT_MS }
        // The pi loop's questions keep the service's default wait; its stop dismisses them below.
        : {})
      return { text: JSON.stringify(answers, null, 2), isError: false }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
  const run = async (args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> => {
    const threadId = ctx.transport === 'mcp' ? ctx.caller.threadId : ctx.turn.threadId || undefined
    if (ctx.transport === 'mcp') return ask(args, threadId, ctx)
    const callEvent: LlmToolEvent = {
      kind: 'build_tool_call',
      title: 'Question tool ask_user',
      summary: 'The assistant asked the user a question.',
      details: ['Tool: ask_user'],
      response: JSON.stringify(args, null, 2)
    }
    ctx.timeline?.record(callEvent, 'start')
    ctx.markEffect?.()
    const result = await abortRace(ask(args, threadId, ctx), ctx.signal, () => { if (threadId) host.dismissQuestions?.(threadId) })
    ctx.timeline?.record({
      kind: 'build_tool_result',
      title: 'Question tool ask_user',
      summary: result.isError ? 'The question tool returned an error.' : 'The question tool returned successfully.',
      details: ['Tool: ask_user'],
      response: truncateForDisplay(result.text)
    }, 'complete')
    return result
  }
  return [{
    name: 'ask_user',
    description: `${ASK_USER_DEFINITION.description} Blocks until the user answers (at most one hour) or your run ends.`,
    inputSchema: plainSchema(ASK_USER_DEFINITION),
    definition: () => ASK_USER_DEFINITION,
    access: 'actsAsCaller',
    class: 'read',
    readOnlySafe: true,
    asksUser: 'question',
    available: (turn) => (turn.settingsEnabled('ask_user') ? true : disabledInSettings('ask_user')),
    offered: (turn) => offeredInMode(turn) && turn.settingsEnabled('ask_user'),
    describe: () => 'Question tool ask_user',
    handler: (args, ctx) => run(args, ctx)
  }]
}
