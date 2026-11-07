import { Type, type Tool } from '@earendil-works/pi-ai'
import { BOT_DEPTHS, MAX_BOT_DESCRIPTION_CHARS, MAX_BOT_NAME_CHARS, MAX_BOT_SCHEDULES, type BotDepth, type BotLane, type BotSchedule } from '../../../../shared/bots/personal/definition'
import { botScheduleLabel } from '../../../../shared/scheduleLabel'
import { scheduleProblem } from '../../../bots/triggers/scheduler'
import type { BotActivityContext, BotActivitySink, BotToolHost } from '../../../bots/seams'
import { computeNextRun } from '../../../scheduled/computeNextRun'
import { json, plainSchema, truncateForModel, type MousseTool, type ToolCallContext, type ToolOutcome } from './types'

/**
 * The personal-bot app tools (PR 6 §5, Bot Phase 1 §5.5, §5.6, §5.10). They exist only on bot
 * turns and act on the bot itself, never on another thread:
 * - `escalate` asks the owner for a permission the bot lacks (the one way to ask, since an
 *   ungranted tool does not exist for the model);
 * - `consult` asks one of the bot's context threads;
 * - `bot_schedule_add`, `bot_schedule_remove`, `bot_schedule_list` keep the bot's own schedules (in
 *   `bots.db`; the job scheduler's tools already own the `schedule_*` names);
 * - `set_profile` renames it or changes its description;
 * - `set_depth` and `use_model` change how much time it takes and, in words the owner used, its
 *   model. Their effects never reach the UI.
 * The bot and the lane always come from the engine (`BotToolHost.activationOf`), never from
 * arguments. An unattended run may look at its schedules and change its depth for itself, but only
 * the owner's chat changes the bot for good.
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
  }),
  Type.Object({ ask: Type.Literal('export_memory') }, { description: 'The owner asked you to export your memory: they pick a folder.' })
])

const WHEN = Type.Union([
  Type.Object({ kind: Type.Literal('interval'), minutes: Type.Integer({ description: 'Every this many minutes; at least 5.' }) }),
  Type.Object({ kind: Type.Literal('cron'), expr: Type.String({ description: 'Five-field cron in this computer\'s local time, for example "0 9 * * 1-5" for weekdays at 9:00.' }) })
])

const SCOPE = Type.Union([Type.Literal('now'), Type.Literal('always')], { description: 'now: for this conversation or run only; always: from now on.' })

export const BOT_TOOLS: Tool[] = [
  {
    name: 'escalate',
    description: 'Ask your owner for a permission you do not have, in one plain sentence. In the chat, the owner answers after your message and you continue then. In a run, carry on without it and say in your report what you skipped.',
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
  },
  {
    name: 'bot_schedule_add',
    description: `Run yourself on a schedule: each time, you get the prompt as your task. At most ${MAX_BOT_SCHEDULES} schedules, at most every 5 minutes. Returns the schedule's id and its label; confirm it to the owner in words.`,
    parameters: Type.Object({
      when: WHEN,
      prompt: Type.String({ description: 'What to do on each run, in your own words.' })
    })
  },
  {
    name: 'bot_schedule_remove',
    description: 'Remove one of your schedules by its id (see bot_schedule_list).',
    parameters: Type.Object({ scheduleId: Type.String() })
  },
  {
    name: 'bot_schedule_list',
    description: 'List your schedules: id, label and next run.',
    parameters: Type.Object({})
  },
  {
    name: 'set_profile',
    description: `Change your name (at most ${MAX_BOT_NAME_CHARS} characters) or your description (at most ${MAX_BOT_DESCRIPTION_CHARS}), when the owner asks.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String())
    })
  },
  {
    name: 'set_depth',
    description: 'Take more time to think (deep), be quicker (quick) or go back to normal. Use it when the owner asks you to think harder or be faster, or when a task needs it.',
    parameters: Type.Object({
      depth: Type.Union(BOT_DEPTHS.map((depth) => Type.Literal(depth))),
      scope: SCOPE
    })
  },
  {
    name: 'use_model',
    description: 'Only when the owner names a model: use it, as they said it. If it is not available here, say so plainly and carry on.',
    parameters: Type.Object({
      model: Type.String({ description: 'The model, in the owner\'s words.' }),
      scope: SCOPE
    })
  }
]

/** Longest consult answer handed back to the bot. */
const CONSULT_ANSWER_CHARS = 16_000
/** The shortest time between two runs of one schedule. */
export const MIN_BOT_SCHEDULE_MINUTES = 5

/** What the bot app tools reach beside the turn's authority. `MmsProfileServices` supplies it. */
export interface BotAppToolDeps {
  /** The engine's side (WP2). */
  host: BotToolHost
  /** Outcome chips: new schedules, renames, depth. */
  activity?: BotActivitySink
  /** `use_model`: whether the owner's words name a model a bot can run here (`BotModelChooser.namedAvailable`). */
  models?: { namedAvailable(model: string): Promise<boolean> }
}

const NOT_A_BOT = 'Only a bot can use this.'
const OWNER_ONLY = 'Only the owner can change this, in your chat. Suggest it in your report instead.'
const error = (text: string): ToolOutcome => ({ text, isError: true })

interface BotCall {
  deps: BotAppToolDeps
  botId: string
  activationId: string
  lane: BotLane
  activity: BotActivityContext
}

/** The bot a call belongs to, from the engine: the turn's authority and the thread must agree. */
function botCall(deps: (() => BotAppToolDeps | undefined) | undefined, ctx: ToolCallContext): BotCall | ToolOutcome {
  const resolved = deps?.()
  const authority = ctx.turn.bot
  if (!resolved || !authority) return error(NOT_A_BOT)
  const activation = resolved.host.activationOf(ctx.caller.threadId)
  if (!activation || activation.activationId !== authority.activationId) return error(NOT_A_BOT)
  return {
    deps: resolved,
    botId: activation.botId,
    activationId: activation.activationId,
    lane: activation.lane,
    // App tools know the activation; the sink finds its current dispatch.
    activity: { botId: activation.botId, activationId: activation.activationId, dispatchId: '' }
  }
}

const isOutcome = (value: BotCall | ToolOutcome): value is ToolOutcome => 'text' in value

/** Why a schedule time can't be used, or undefined: the scheduler's own check, plus at most every 5 minutes. */
export function botScheduleProblem(when: unknown, prompt: unknown, now: Date = new Date()): string | undefined {
  const problem = scheduleProblem({ id: 'new', when, prompt } as BotSchedule)
  if (problem) return problem
  const schedule = when as BotSchedule['when']
  if (schedule.kind === 'interval') return schedule.minutes < MIN_BOT_SCHEDULE_MINUTES ? `A schedule runs at most every ${MIN_BOT_SCHEDULE_MINUTES} minutes.` : undefined
  // A cron expression: no two of its next runs closer than 5 minutes.
  let previous = computeNextRun({ kind: 'cron', expr: schedule.expr }, null, now)
  for (let step = 0; previous && step < 30; step += 1) {
    const next = computeNextRun({ kind: 'cron', expr: schedule.expr }, previous, now)
    if (!next) break
    if (Date.parse(next) - Date.parse(previous) < MIN_BOT_SCHEDULE_MINUTES * 60_000) return `A schedule runs at most every ${MIN_BOT_SCHEDULE_MINUTES} minutes.`
    previous = next
  }
  return undefined
}

/** A tool's common shape: listed and offered on bot activation threads only. */
function ownTool(tool: Tool, deps: (() => BotAppToolDeps | undefined) | undefined, part: Pick<MousseTool, 'class' | 'describe' | 'handler'>): MousseTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: plainSchema(tool),
    definition: () => tool,
    // It writes only bots.db, about the caller's own bot.
    access: 'actsAsCaller',
    listed: (listing) => listing.botRole === 'activation',
    available: (turn) => (turn.bot && deps?.() ? true : NOT_A_BOT),
    offered: (turn) => Boolean(turn.bot && deps?.()),
    ...part
  }
}

export function botTools(deps?: () => BotAppToolDeps | undefined): MousseTool[] {
  const byName = new Map(BOT_TOOLS.map((tool) => [tool.name, tool]))
  const escalate = byName.get('escalate')!
  const consult = byName.get('consult')!
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
    },
    ownTool(byName.get('bot_schedule_add')!, deps, {
      class: 'mutation',
      describe: () => 'Add a schedule',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        if (call.lane !== 'chat') return error(OWNER_ONLY)
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        const problem = botScheduleProblem(args.when, prompt)
        if (problem) return error(problem)
        if (call.deps.host.schedules.list(call.botId).length >= MAX_BOT_SCHEDULES)
          return error(`You already have ${MAX_BOT_SCHEDULES} schedules, the most a bot can have. Remove one first.`)
        const when = args.when as BotSchedule['when']
        try {
          const added = call.deps.host.schedules.add(call.botId, { when: when.kind === 'interval' ? { kind: 'interval', minutes: when.minutes } : { kind: 'cron', expr: when.expr.trim() }, prompt })
          const result = { scheduleId: added.scheduleId, label: added.label || botScheduleLabel(when) }
          call.deps.activity?.onAppResult(call.activity, 'bot_schedule_add', result)
          return json(result)
        } catch (failure) {
          return error(failure instanceof Error ? failure.message : String(failure))
        }
      }
    }),
    ownTool(byName.get('bot_schedule_remove')!, deps, {
      class: 'mutation',
      describe: () => 'Remove a schedule',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        if (call.lane !== 'chat') return error(OWNER_ONLY)
        if (typeof args.scheduleId !== 'string' || !args.scheduleId) return error('bot_schedule_remove needs a schedule id (see bot_schedule_list).')
        if (!call.deps.host.schedules.remove(call.botId, args.scheduleId)) return error('You have no schedule with that id. See bot_schedule_list.')
        const result = { removed: true as const }
        call.deps.activity?.onAppResult(call.activity, 'bot_schedule_remove', result)
        return json(result)
      }
    }),
    ownTool(byName.get('bot_schedule_list')!, deps, {
      class: 'read',
      describe: () => 'List schedules',
      handler: async (_args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        return json(call.deps.host.schedules.list(call.botId))
      }
    }),
    ownTool(byName.get('set_profile')!, deps, {
      class: 'mutation',
      describe: () => 'Change name or description',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        if (call.lane !== 'chat') return error(OWNER_ONLY)
        const name = typeof args.name === 'string' ? args.name.replace(/\s+/g, ' ').trim() : undefined
        const description = typeof args.description === 'string' ? args.description.trim() : undefined
        if (name === undefined && description === undefined) return error('set_profile needs a name or a description.')
        if (name !== undefined && (!name || name.length > MAX_BOT_NAME_CHARS)) return error(`A name is 1 to ${MAX_BOT_NAME_CHARS} characters.`)
        if (description !== undefined && (!description || description.length > MAX_BOT_DESCRIPTION_CHARS)) return error(`A description is 1 to ${MAX_BOT_DESCRIPTION_CHARS} characters.`)
        const profile = { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) }
        try {
          call.deps.host.setProfile(call.botId, profile)
        } catch (failure) {
          return error(failure instanceof Error ? failure.message : String(failure))
        }
        const result = { ok: true as const }
        call.deps.activity?.onAppResult(call.activity, 'set_profile', result)
        return json(result)
      }
    }),
    ownTool(byName.get('set_depth')!, deps, {
      class: 'mutation',
      describe: () => 'Change how much time to take',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        const depth = args.depth as BotDepth
        if (!BOT_DEPTHS.includes(depth)) return error('depth is quick, normal or deep.')
        const scope = args.scope === 'always' ? 'always' : args.scope === 'now' ? 'now' : undefined
        if (!scope) return error('scope is now or always.')
        if (scope === 'always' && call.lane !== 'chat') return error(OWNER_ONLY)
        try {
          call.deps.host.setModel(call.botId, call.activationId, scope, { depth })
        } catch (failure) {
          return error(failure instanceof Error ? failure.message : String(failure))
        }
        const result = { ok: true as const, note: scope === 'now' ? 'Mousse continues your turn with the new depth right after this. Carry on where you left off.' : 'Saved: your next conversations and runs use it.' }
        call.deps.activity?.onAppResult(call.activity, 'set_depth', result)
        return json(result)
      }
    }),
    ownTool(byName.get('use_model')!, deps, {
      class: 'mutation',
      describe: () => 'Change how it works',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        // Only the owner names a model, in the chat: a run never switches on its own.
        if (call.lane !== 'chat') return error(OWNER_ONLY)
        const model = typeof args.model === 'string' ? args.model.trim().slice(0, 100) : ''
        if (!model) return error('use_model needs the model, as the owner said it.')
        const scope = args.scope === 'always' ? 'always' : args.scope === 'now' ? 'now' : undefined
        if (!scope) return error('scope is now or always.')
        const available = call.deps.models ? await call.deps.models.namedAvailable(model) : false
        if (!available) return json({ ok: false, reason: 'That model is not available here. You stay on automatic; tell the owner plainly, without naming other models.' })
        try {
          call.deps.host.setModel(call.botId, call.activationId, scope, { mode: 'named', model })
        } catch (failure) {
          return error(failure instanceof Error ? failure.message : String(failure))
        }
        return json({ ok: true })
      }
    })
  ]
}
