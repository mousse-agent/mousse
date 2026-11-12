import { randomUUID } from 'node:crypto'
import { Type, type Tool } from '@earendil-works/pi-ai'
import { BOT_DEPTHS, MAX_BOT_DESCRIPTION_CHARS, MAX_BOT_NAME_CHARS, MAX_BOT_SCHEDULES, type BotDepth, type BotLane, type BotSchedule } from '../../../../shared/bots/personal/definition'
import { botScheduleLabel } from '../../../../shared/scheduleLabel'
import { botScheduleProblem } from '../../../scheduled/botJobs'
import type { BotActivityContext, BotActivitySink, BotToolHost } from '../../../bots/seams'
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
  Type.Object({ tool: Type.String({ description: 'A tool name, for example read, edit, web_fetch, or shell to run commands.' }) }),
  Type.Object({ path: Type.String({ description: 'Any absolute folder path: this asks to use files anywhere on this computer, read and write, once.' }), access: Type.Union([Type.Literal('read'), Type.Literal('write')]) }),
  Type.Object({ skill: Type.String({ description: 'A skill id.' }) }),
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
    description: 'Ask your owner for a permission you do not have, in one plain sentence. Ask as soon as you need it; never ask the owner whether to ask. In the chat, the owner answers after your message and you continue then. In a run, carry on without it and say in your report what you skipped.',
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
  },
  {
    name: 'work_start',
    description: 'Hand work that takes more than a moment to a run of its own, so you stay free to talk: anything on the web or in the browser, running commands, research, writing a document, or several steps. It runs beside this chat and reports to the owner when done, as a reply to their message. Up to 3 pieces of work run at once, so a quick lookup can start beside a long job; more wait their turn. The run sees your memory but not this chat, so the brief must stand on its own: what to do, everything the owner told you that matters, and what the report should contain. Then tell the owner in one short line that you are on it.',
    parameters: Type.Object({
      title: Type.String({ description: 'A few words the owner will recognise, like "Vacuum comparison".' }),
      brief: Type.String({ description: 'The whole task, standing on its own.' })
    })
  },
  {
    name: 'work_list',
    description: 'What you are working on now (running or waiting, with what it is doing), and the last few pieces that ended, with their ids and the start of their reports. Use it when the owner asks how something is going.',
    parameters: Type.Object({})
  },
  {
    name: 'work_stop',
    description: 'Stop a piece of work by its id (see work_list), when the owner asks or it is no longer needed.',
    parameters: Type.Object({ workId: Type.String() })
  },
  {
    name: 'work_note',
    description: 'Pass something the owner added to work that is running or waiting (by its id, see work_list): it takes it into account before it reports. If the owner changed the task entirely, stop the work and start new work instead.',
    parameters: Type.Object({
      workId: Type.String(),
      note: Type.String({ description: 'What the owner added, standing on its own.' })
    })
  },
  {
    name: 'remind',
    description: 'Remind the owner once, at a time: give inMinutes for "in 20 minutes", or at for a date and time in their local time ("2026-11-14T09:00"). text is what you will say then, written to the owner. Add work (a brief) to do something at that time instead of only saying it, for example check the weather and tell them. Repeating reminders are schedules (bot_schedule_add). Confirm the time to the owner in words.',
    parameters: Type.Object({
      text: Type.String({ description: 'The reminder, as you will say it to the owner.' }),
      inMinutes: Type.Optional(Type.Number({ description: 'Minutes from now.' })),
      at: Type.Optional(Type.String({ description: 'Local date and time, like 2026-11-14T09:00.' })),
      work: Type.Optional(Type.Object({
        title: Type.String(),
        brief: Type.String({ description: 'What to do at that time, standing on its own; its report goes to the owner.' })
      }))
    })
  },
  {
    name: 'reminder_list',
    description: 'Your reminders still to come: id, time and text.',
    parameters: Type.Object({})
  },
  {
    name: 'reminder_cancel',
    description: 'Cancel one of your reminders by its id (see reminder_list).',
    parameters: Type.Object({ reminderId: Type.String() })
  }
]

/** Longest consult answer handed back to the bot. */
const CONSULT_ANSWER_CHARS = 16_000

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
const CHAT_ONLY = 'Only your chat hands out work and sets reminders. In a run, do the work yourself and say in your report what should happen next.'
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
    ownTool(byName.get('work_start')!, deps, {
      class: 'mutation',
      describe: () => 'Start work',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        if (call.lane !== 'chat') return error(CHAT_ONLY)
        const brief = typeof args.brief === 'string' ? args.brief.trim().slice(0, MAX_WORK_BRIEF_CHARS) : ''
        if (!brief) return error('work_start needs a brief that stands on its own.')
        const title = typeof args.title === 'string' ? args.title : ''
        try {
          const started = await call.deps.host.work.start(call.botId, call.activationId, { title, brief, key: `${call.activationId}:${ctx.toolCallId ?? randomUUID()}` })
          const result = { ...started, note: started.status === 'queued' ? `It starts when there is room, after: ${started.ahead.join('; ')}. Tell the owner it waits its turn.` : started.status === 'ended' ? 'This work already ran and ended; see work_list for its report.' : 'It is running, beside anything else you are working on. Tell the owner you are on it; its report reaches them by itself.' }
          call.deps.activity?.onAppResult(call.activity, 'work_start', started)
          return json(result)
        } catch (failure) {
          return error(failure instanceof Error ? failure.message : String(failure))
        }
      }
    }),
    ownTool(byName.get('work_list')!, deps, {
      class: 'read',
      describe: () => 'List work',
      handler: async (_args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        return json(call.deps.host.work.list(call.botId))
      }
    }),
    ownTool(byName.get('work_stop')!, deps, {
      class: 'mutation',
      describe: () => 'Stop work',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        if (call.lane !== 'chat') return error(CHAT_ONLY)
        if (typeof args.workId !== 'string' || !args.workId) return error('work_stop needs a work id (see work_list).')
        const result = await call.deps.host.work.stop(call.botId, args.workId)
        call.deps.activity?.onAppResult(call.activity, 'work_stop', { result })
        if (result === 'not_found') return error('You have no work with that id. See work_list.')
        return json({ result })
      }
    }),
    ownTool(byName.get('work_note')!, deps, {
      class: 'mutation',
      describe: () => 'Add to work',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        if (call.lane !== 'chat') return error(CHAT_ONLY)
        if (typeof args.workId !== 'string' || !args.workId || typeof args.note !== 'string' || !args.note.trim()) return error('work_note needs a work id and the note.')
        const result = call.deps.host.work.note(call.botId, args.workId, args.note, call.activationId)
        call.deps.activity?.onAppResult(call.activity, 'work_note', { result })
        if (result === 'not_found') return error('You have no work with that id. See work_list.')
        if (result === 'ended') return json({ result, note: 'That work already finished, so it never saw this. Start new work for it if it still matters.' })
        if (result === 'held') return json({ result, note: 'That work is held (it stopped part-way), so it can\'t take notes. Stop it and start new work with this if it still matters.' })
        return json({ result, note: 'It takes this into account before it reports.' })
      }
    }),
    ownTool(byName.get('remind')!, deps, {
      class: 'mutation',
      describe: () => 'Set a reminder',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        if (call.lane !== 'chat') return error(CHAT_ONLY)
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        if (!text) return error('remind needs the text you will say.')
        const due = reminderTime(args.inMinutes, args.at)
        if (typeof due === 'string') return error(due)
        const work = args.work && typeof args.work === 'object' ? args.work as { title?: unknown; brief?: unknown } : undefined
        const brief = typeof work?.brief === 'string' ? work.brief.trim().slice(0, MAX_WORK_BRIEF_CHARS) : ''
        try {
          const added = call.deps.host.reminders.add(call.botId, call.activationId, {
            dueAt: due.toISOString(),
            text,
            ...(brief ? { work: { title: typeof work?.title === 'string' ? work.title : '', brief } } : {})
          })
          const result = { ...added, label: reminderLabel(new Date(added.dueAt)) }
          call.deps.activity?.onAppResult(call.activity, 'remind', result)
          return json(result)
        } catch (failure) {
          return error(failure instanceof Error ? failure.message : String(failure))
        }
      }
    }),
    ownTool(byName.get('reminder_list')!, deps, {
      class: 'read',
      describe: () => 'List reminders',
      handler: async (_args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        return json(call.deps.host.reminders.list(call.botId).map((reminder) => ({ ...reminder, when: reminderLabel(new Date(reminder.dueAt)) })))
      }
    }),
    ownTool(byName.get('reminder_cancel')!, deps, {
      class: 'mutation',
      describe: () => 'Cancel a reminder',
      handler: async (args, ctx) => {
        const call = botCall(deps, ctx)
        if (isOutcome(call)) return call
        if (call.lane !== 'chat') return error(CHAT_ONLY)
        if (typeof args.reminderId !== 'string' || !call.deps.host.reminders.cancel(call.botId, args.reminderId)) return error('You have no waiting reminder with that id. See reminder_list.')
        const result = { cancelled: true as const }
        call.deps.activity?.onAppResult(call.activity, 'reminder_cancel', result)
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

/** The longest brief a piece of work or a work reminder takes. */
const MAX_WORK_BRIEF_CHARS = 32 * 1024

/**
 * A reminder's time from `remind`'s arguments: minutes from now, or a local date and time (an ISO time with an offset
 * is taken as it is). A plain sentence when neither is usable, for the bot.
 */
export function reminderTime(inMinutes: unknown, at: unknown, now: Date = new Date()): Date | string {
  const hasMinutes = typeof inMinutes === 'number' && Number.isFinite(inMinutes)
  const hasAt = typeof at === 'string' && at.trim() !== ''
  if (hasMinutes === hasAt) return 'Give either inMinutes or at.'
  if (hasMinutes) {
    if ((inMinutes as number) < 1) return 'A reminder is at least a minute from now.'
    return new Date(now.getTime() + Math.round(inMinutes as number) * 60_000)
  }
  const text = (at as string).trim()
  const usage = 'at is a local date and time like 2026-11-14T09:00.'
  // "2026-11-14T09:00" (or with a space): the owner's local time. A field out of range is refused, never rolled over.
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (local) {
    const [year, month, day, hour, minute, second] = local.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number]
    const date = new Date(year, month - 1, day, hour, minute, second)
    const same = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute
    return same ? date : usage
  }
  // Anything else must say its own offset ("…Z", "…+05:30"); a date alone has no time to say it at. Its fields must be
  // in range as written: a day the month doesn't have is refused.
  const zoned = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.exec(text)
  if (!zoned) return usage
  const [year, month, day, hour, minute] = zoned.slice(1, 6).map(Number) as [number, number, number, number, number]
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59) return usage
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? usage : date
}

/** A reminder's time in plain words for its chip and list: "18:42", or "Sat 14 Nov · 09:00". */
export function reminderLabel(at: Date, now: Date = new Date()): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  if (at.toDateString() === now.toDateString()) return time
  const day = at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
  return `${day} · ${time}`
}
