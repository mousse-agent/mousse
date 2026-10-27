import { Type, type Tool } from '@earendil-works/pi-ai'
import { plainSchema, truncateForModel, type MousseTool } from './types'

/**
 * The personal-bot app tools (PR 6 §5): `escalate` asks the owner for a permission the bot lacks
 * (the one way to ask, since an ungranted tool does not exist for the model), and `consult` asks
 * one of the bot's context threads. Both exist only on bot turns: they are listed on bot threads
 * and act through the turn's bot authority, which the bot engine fills in.
 */

const PERMISSION = Type.Union([
  Type.Object({ tool: Type.String({ description: 'A tool name, for example read, edit or web_fetch.' }) }),
  Type.Object({ path: Type.String({ description: 'An absolute folder path.' }), access: Type.Union([Type.Literal('read'), Type.Literal('write')]) }),
  Type.Object({ skill: Type.String({ description: 'A skill id.' }) }),
  Type.Object({ mcp: Type.Object({ serverId: Type.String(), tool: Type.String() }) }),
  Type.Object({
    budget: Type.Object({
      key: Type.Union(['maxActiveMs', 'maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'].map((key) => Type.Literal(key))),
      amount: Type.Optional(Type.Number({ description: 'How much more (milliseconds for maxActiveMs).' }))
    })
  })
])

export const BOT_TOOLS: Tool[] = [
  {
    name: 'escalate',
    description: 'Ask your owner for a permission you do not have. Your turn ends; the owner allows or denies it, and you continue afterwards.',
    parameters: Type.Object({
      permission: PERMISSION,
      reason: Type.String({ description: 'Why you need it, in one or two sentences for the owner.' })
    })
  },
  {
    name: 'consult',
    description: 'Ask one of your context threads a question and get its answer. Context threads keep their history between runs.',
    parameters: Type.Object({
      context: Type.String({ description: 'The key of the context thread.' }),
      question: Type.String({ description: 'What to ask it.' })
    })
  }
]

/** Longest consult answer handed back to the bot. */
const CONSULT_ANSWER_CHARS = 16_000

export function botTools(): MousseTool[] {
  const [escalate, consult] = BOT_TOOLS as [Tool, Tool]
  return [
    {
      name: escalate.name,
      description: escalate.description,
      inputSchema: plainSchema(escalate),
      definition: () => escalate,
      // It writes only bots.db, about the caller's own activation.
      access: 'actsAsCaller',
      class: 'read',
      listed: (listing) => listing.botRole !== undefined,
      available: (turn) => (turn.bot?.escalate ? true : 'Only a bot can ask its owner for permissions.'),
      offered: (turn) => Boolean(turn.bot?.escalate),
      describe: () => 'Ask the owner for a permission',
      handler: async (args, ctx) => {
        const bot = ctx.turn.bot
        if (!bot?.escalate) return { text: 'Only a bot can ask its owner for permissions.', isError: true }
        const reason = typeof args.reason === 'string' ? args.reason.slice(0, 2000) : ''
        return { text: bot.escalate({ permission: args.permission, reason, toolCallId: ctx.toolCallId }) }
      }
    },
    {
      name: consult.name,
      description: consult.description,
      inputSchema: plainSchema(consult),
      definition: () => consult,
      access: 'actsAsCaller',
      class: 'read',
      listed: (listing) => listing.botRole === 'activation',
      available: (turn) => (turn.bot?.consult ? true : 'Only a bot\'s main thread can consult its context threads.'),
      offered: (turn) => Boolean(turn.bot?.consult && turn.bot.contexts?.length),
      describe: () => 'Ask a context thread',
      handler: async (args, ctx) => {
        const bot = ctx.turn.bot
        if (!bot?.consult) return { text: 'Only a bot\'s main thread can consult its context threads.', isError: true }
        if (typeof args.context !== 'string' || typeof args.question !== 'string' || !args.question.trim())
          return { text: 'consult needs a context key and a question.', isError: true }
        try {
          const answer = await bot.consult({ context: args.context, question: args.question, signal: ctx.signal })
          return { text: answer.length > CONSULT_ANSWER_CHARS ? truncateForModel(answer) : answer }
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error), isError: true }
        }
      }
    }
  ]
}
