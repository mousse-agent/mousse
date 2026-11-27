import { DEFAULT_EVENT_WAKE_HOURS, MAX_EVENT_WAKE_HOURS, MAX_SAME_WAKES, pullRequestOf } from '../../../../shared/bots/personal/wakes'
import { ThreadWakeError, type ThreadWakes } from '../../../wakes/ThreadWakes'
import { reminderLabel, reminderTime } from './bots'
import type { AppToolHost } from './host'
import { json, type AppToolTurn, type MousseTool, type ToolCallContext, type ToolOutcome } from './types'

/** The names a thread's agent shares with a personal bot: the same tools, parameters and limits. */
export const THREAD_WAKE_TOOL_NAMES = ['wake', 'reminder_list', 'reminder_cancel'] as const

/**
 * Why a subagent sets no wake-ups: its task ends with its result to its parent, and a later turn of its own would have
 * nobody to report to. The parent, which holds the context, waits instead: on the subagent's thread or the pull request.
 */
export const SUBAGENT_WAKE_REFUSAL = 'A subagent cannot set wake-ups: finish your task and return what you found. The thread that started you can wake on your thread or on the pull request.'

const error = (text: string): ToolOutcome => ({ text, isError: true })

function threadOf(ctx: ToolCallContext): string {
  return ctx.transport === 'mcp' ? ctx.caller.threadId : ctx.turn.threadId
}

const ON = ['merged', 'checks', 'review'] as const

const WAKE_SCHEMA = {
  type: 'object',
  properties: {
    brief: { type: 'string', description: 'What you will do then, standing on its own, as a note to yourself.' },
    inMinutes: { type: 'number', description: 'Minutes from now.' },
    at: { type: 'string', description: 'Local date and time, like 2026-11-14T09:00.' },
    thread: { type: 'string', description: 'Wake when this other thread finishes its turn: its id.' },
    pr: { type: 'string', description: 'Wait on this pull request: "owner/repo#12" or its link. Its repository must be one of the person\'s projects in Mousse.' },
    on: { type: 'string', enum: [...ON], description: 'With pr only: merged (default), reported checks settled (including approval waits), or a new submitted review beyond the reviews seen when this wake was set.' },
    hours: { type: 'number', description: `With thread or pr: how many hours to wait for it before you wake anyway (default ${DEFAULT_EVENT_WAKE_HOURS}, at most ${MAX_EVENT_WAKE_HOURS}).` }
  },
  required: ['brief']
}

/**
 * `wake`, `reminder_list` and `reminder_cancel` for a thread's agent (`ThreadWakes`): it carries on later in its own
 * thread without the person writing. A personal bot keeps its own versions of these names (`botTools`); `shareWakeTools`
 * makes each one tool that serves both. A subagent sets none (`SUBAGENT_WAKE_REFUSAL`). Each acts on the caller's own
 * thread only; a `thread` it waits on is checked by the service (`ThreadWakesDeps.threadState`: a thread that exists,
 * no bot's, and not a private one from a shared thread).
 */
export function threadWakeTools(host: AppToolHost): MousseTool[] {
  if (!host.threadWakes) return []
  const service = (): ThreadWakes | undefined => host.threadWakes?.()
  const subagent = (threadId: string | undefined): boolean => Boolean(threadId && host.subagentThread?.(threadId))
  const listed = (listing: { botRole?: unknown; subagent?: boolean; threadId?: string }): boolean => !listing.botRole && !listing.subagent && !subagent(listing.threadId) && Boolean(service())
  const available = (turn: AppToolTurn): true | string => (subagent(turn.threadId) ? SUBAGENT_WAKE_REFUSAL : service() ? true : 'Wake-ups are not available here.')
  return [
    {
      name: 'wake',
      description: [
        'Carry on later, here in this thread, without the person writing: at a time (inMinutes or at), when another thread finishes its turn (thread: its id), or on a pull request (pr, with on: merged, checks or review; merged by default).',
        'Use it whenever you wait on something that outlasts this turn (a pull request\'s checks or review, a nightly build, a thread you started) instead of a polling script, a monitor that would time out, or a promise to look later. It is kept across restarts of Mousse and the computer sleeping.',
        'brief is what you will do then, standing on its own: you see it with what happened, in a notice (<mousse_notice kind="thread_wake">). An idle thread starts a turn with it, a running turn reads it as a note, and it waits while the thread waits on the person\'s answer. It grants nothing: that turn runs in the thread\'s permission mode, as no person started it.',
        'Checks settle when none are queued or running; checks waiting for approval are reported too. Checks describe only the rollup GitHub currently reports, which may omit required checks or briefly show the previous head after a push: read the framed head commit before acting. Reviews by anyone count, including the person\'s own account and review bots: do not post a review to trigger your own wake.',
        `A wake on a thread or pull request gives up after hours (default ${DEFAULT_EVENT_WAKE_HOURS}, at most ${MAX_EVENT_WAKE_HOURS}) or when the pull request is closed or the thread archived or deleted, and you still wake once and are told why.`,
        `There is no count of wake-ups in a row; only a loop is refused: the same brief, waiting on the same thing, set more than ${MAX_SAME_WAKES} times before the person writes again.`,
        'List and cancel yours with reminder_list and reminder_cancel. The person sees them with the thread\'s background work, and stopping or archiving the thread cancels them. Subagents cannot set wake-ups.',
        'End your turn after setting it, and tell the person in a few words what you will follow up on.'
      ].join(' '),
      inputSchema: WAKE_SCHEMA,
      // It keeps a wake of the caller's own thread; the thread it may wait on is checked by the service.
      access: 'actsAsCaller',
      class: 'mutation',
      listed,
      available,
      describe: () => 'Set a wake-up',
      handler: async (args, ctx) => {
        const threadId = threadOf(ctx)
        if (subagent(threadId)) return error(SUBAGENT_WAKE_REFUSAL)
        const wakes = service()
        if (!wakes) return error('Wake-ups are not available here.')
        const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
        if (!brief) return error('wake needs a brief: what you will do then.')
        const timed = args.inMinutes !== undefined || args.at !== undefined
        if ([timed, args.thread !== undefined, args.pr !== undefined].filter(Boolean).length !== 1)
          return error('Give one of: inMinutes or at (a time), thread (a thread id) or pr (a pull request).')
        if (args.on !== undefined && (args.pr === undefined || !ON.includes(args.on as (typeof ON)[number]))) return error('on needs pr and is merged, checks or review.')
        if (args.hours !== undefined && typeof args.hours !== 'number') return error('hours is a number.')
        const hours = typeof args.hours === 'number' ? { hours: args.hours } : {}
        let input: Parameters<ThreadWakes['add']>[1]
        if (timed) {
          const due = reminderTime(args.inMinutes, args.at)
          if (typeof due === 'string') return error(due)
          input = { brief, dueAt: due.toISOString() }
        } else if (args.thread !== undefined) {
          if (typeof args.thread !== 'string' || !args.thread.trim()) return error("thread is another thread's id.")
          input = { brief, event: { kind: 'thread', threadId: args.thread.trim() }, ...hours }
        } else {
          const pr = pullRequestOf(args.pr)
          if (!pr) return error('pr is a pull request as "owner/repo#12", or its link.')
          input = { brief, event: { kind: 'pr', ...pr, ...(args.on ? { on: args.on as (typeof ON)[number] } : {}) }, ...hours }
        }
        try {
          const added = await wakes.add(threadId, input)
          const when = reminderLabel(new Date(added.dueAt))
          return json({ wakeId: added.wakeId, ...(added.label ? { waitsFor: added.label, givesUpAt: when } : { when }) })
        } catch (failure) {
          if (failure instanceof ThreadWakeError) return error(failure.message)
          throw failure
        }
      }
    },
    {
      name: 'reminder_list',
      description: 'This thread\'s wake-ups still to come: id, time and brief. One that waits on a thread or pull request says what it waits for (its time is then when it gives up).',
      inputSchema: { type: 'object', properties: {} },
      access: 'actsAsCaller',
      class: 'read',
      listed,
      available,
      describe: () => 'List wake-ups',
      handler: (_args, ctx) => {
        const wakes = service()
        if (!wakes) return error('Wake-ups are not available here.')
        return json(wakes.list(threadOf(ctx)).map((view) => ({ reminderId: view.wakeId, dueAt: view.dueAt, when: reminderLabel(new Date(view.dueAt)), text: view.brief, wake: view.waitsFor ?? 'at its time' })))
      }
    },
    {
      name: 'reminder_cancel',
      description: 'Cancel one of this thread\'s wake-ups by its id (see reminder_list).',
      inputSchema: { type: 'object', properties: { reminderId: { type: 'string' } }, required: ['reminderId'] },
      access: 'actsAsCaller',
      class: 'mutation',
      listed,
      available,
      describe: () => 'Cancel a wake-up',
      handler: (args, ctx) => {
        const wakes = service()
        if (!wakes) return error('Wake-ups are not available here.')
        if (typeof args.reminderId !== 'string' || !wakes.cancel(threadOf(ctx), args.reminderId)) return error('This thread has no waiting wake-up with that id. See reminder_list.')
        return json({ cancelled: true })
      }
    }
  ]
}

/**
 * One tool per shared name: a personal bot's turn gets the bot's tool (its description, schema, class, rules and handler), any
 * other thread the thread's. The rest are the bot's tools unchanged, and with no thread version (no service here) the
 * bot's stay as they were.
 */
export function shareWakeTools(botTools: MousseTool[], threadTools: MousseTool[]): MousseTool[] {
  const forThreads = new Map(threadTools.map((tool) => [tool.name, tool]))
  const shared = botTools.map((bot) => {
    const thread = forThreads.get(bot.name)
    if (!thread) return bot
    forThreads.delete(bot.name)
    const { definition: _definition, ...plain } = thread
    // No pi-ai definition: only an agent definition's turn reads one (`listForTurn`), and it gets the plain schema.
    const tool: MousseTool = {
      ...plain,
      botDescription: bot.description,
      botInputSchema: bot.inputSchema,
      ...(bot.class !== thread.class ? { botClass: bot.class } : {}),
      // A thread's version asks its person (`question_ask`); a bot's asks its owner through its own channel.
      ...(thread.asksUser && !bot.asksUser ? { botAsksOwner: true as const } : {}),
      listed: (listing) => (listing.botRole ? bot.listed?.(listing) ?? true : thread.listed?.(listing) ?? true),
      available: (turn) => (turn.bot ? bot.available?.(turn) ?? true : thread.available?.(turn) ?? true),
      offered: (turn) => (turn.bot ? bot.offered?.(turn) ?? true : thread.offered?.(turn) ?? true),
      handler: (args, ctx) => (ctx.turn.bot ? bot.handler(args, ctx) : thread.handler(args, ctx))
    }
    return tool
  })
  return [...shared, ...forThreads.values()]
}
