import type { BotLaunchedThread } from '../../shared/bots/personal/chat'
import { BOT_JOB_LINE_CHARS, jobLine, type BotJob, type BotJobAsker, type BotJobState, type BotThreadAsk } from '../../shared/bots/personal/jobs'
import type { BotActivationRow } from './store/BotStore'

/**
 * The ledger's decisions (docs/plans/bot-context.md §16): who asked for a job, how its thread stands as a job state,
 * and whether a change is worth a notice. `BotEngine` reads and writes; these only decide.
 */

/** A job's thread as the ledger reads it (`BotEngineHost.jobThread`): how it stands, its title, and its last answer. */
export interface JobThreadView {
  /** How it stands, as a bot's list of started threads says (`launchedThreadsOf`), or `gone` when it was deleted. */
  status: BotLaunchedThread['status'] | 'gone'
  title?: string
  /** The final text of its last run, once its turn ended. */
  result?: string
  /** The thread's own requests waiting for a person (not its subagents'), oldest first, when it waits for one. */
  asks?: BotThreadAsk[]
}

/**
 * A thread's standing as a job state: it works (its run, a queued message or its subagents go on, or a usage limit
 * resumes it by itself), it waits for a person (a question or approval, or a pause only a person ends), or its turn
 * ended. Undefined while it never ran: the message the bot sent has not started a turn yet, so nothing changes.
 */
export function jobStateOf(status: JobThreadView['status']): BotJobState | undefined {
  switch (status) {
    case 'gone': return 'gone'
    case 'needs_input':
    case 'on_hold': return 'needs_input'
    case 'running':
    case 'queued':
    case 'paused':
    case 'subagents': return 'running'
    case 'done': return 'done'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    default: return undefined
  }
}

/**
 * What a job does when its thread stands as `next`: nothing (the same state, or not started), a quiet move back to
 * working (a person answered), or a move with a notice to the bot (it waits for a person, or it ended).
 */
export function jobStep(job: Pick<BotJob, 'state'>, next: BotJobState | undefined): { state: BotJobState; notice: boolean } | undefined {
  if (!next || next === job.state) return undefined
  return { state: next, notice: next !== 'running' }
}

/** A line that only lays the answer out: a heading, a rule, or a code fence. */
const LAYOUT_LINE = /^(?:#{1,6}(?:\s|$)|([-*_=])(?:\s*\1){2,}$|```|~~~)/

/**
 * The one-line result of a thread's answer: its first line that says something, past blank lines and layout (a
 * heading, a rule, a code fence); a heading's own words when the answer has nothing else.
 */
export function resultLine(result: string | undefined): string | undefined {
  const lines = (result ?? '').split(/\r?\n/).map((text) => text.trim()).filter(Boolean)
  const line = lines.find((text) => !LAYOUT_LINE.test(text)) ?? lines.map((text) => text.replace(/^#{1,6}\s*/, '').trim()).find(Boolean)
  return line ? jobLine(line) : undefined
}

/**
 * A job thread's answer for its last run (`JobThreadView.result`): the thread's last reply (`lastReply`, its newest
 * assistant message) when it is part of what the run kept (`recorded`, every message of the turn), so a progress
 * message earlier in the turn never stands for its answer; else what the run kept, or the last reply when the run kept
 * nothing (a turn the owner started).
 */
export function jobResultOf(recorded: string | undefined, lastReply: string | undefined): string | undefined {
  const reply = lastReply?.trim()
  if (!recorded?.trim()) return reply || undefined
  // The run's kept text is capped: the reply's start is enough to know it is this run's.
  return reply && recorded.includes(reply.slice(0, BOT_JOB_LINE_CHARS)) ? reply : recorded
}

/**
 * Who asked for a job handed off by turn `row`, and what they asked, one line: the owner's words (their message, or the
 * one the work answers), a schedule's or another bot's, or the bot's own (a wake, a question's default, a notice).
 * `ownerText`: the owner's message the turn answers, when it has one; `sent`: what the bot sent the thread, the request
 * when nothing else says it, or when the owner's message is longer than one line holds (it may ask for several things).
 */
export function jobAskerOf(row: Pick<BotActivationRow, 'lane' | 'idempotencyKey' | 'trigger'>, ownerText: string | undefined, sent: string): { askedBy: BotJobAsker; request: string } {
  const trigger = row.trigger
  const own = (text: string | undefined) => jobLine(text?.trim() ? text : sent)
  if (trigger.kind === 'schedule') return { askedBy: 'schedule', request: own(trigger.input) }
  if (trigger.kind === 'manual' && trigger.fromBot) return { askedBy: 'bot', request: own(trigger.input) }
  // A long message may ask for several things: the part this thread was handed says which one its job is.
  if (ownerText?.trim()) return { askedBy: 'owner', request: jobLine(ownerText.replace(/\s+/g, ' ').trim().length > BOT_JOB_LINE_CHARS && sent.trim() ? sent : ownerText) }
  if (trigger.kind === 'work') return { askedBy: trigger.replyTo ? 'owner' : 'self', request: own(trigger.title) }
  return { askedBy: row.lane === 'chat' && /^(chat|answer):/.test(row.idempotencyKey) ? 'owner' : 'self', request: own(undefined) }
}
