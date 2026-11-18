import type { BotLaunchedThread } from '../../shared/bots/personal/chat'
import { jobLine, type BotJob, type BotJobAsker, type BotJobState, type BotThreadAsk } from '../../shared/bots/personal/jobs'
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

/** The one-line result of a thread's answer: its first non-empty line. */
export function resultLine(result: string | undefined): string | undefined {
  const line = result?.split(/\r?\n/).find((text) => text.trim())
  return line ? jobLine(line) : undefined
}

/**
 * Who asked for a job handed off by turn `row`, and what they asked, one line: the owner's words (their message, or the
 * one the work answers), a schedule's or another bot's, or the bot's own (a wake, a question's default, a notice).
 * `ownerText`: the owner's message the turn answers, when it has one; `sent`: what the bot sent the thread, the request
 * when nothing else says it.
 */
export function jobAskerOf(row: Pick<BotActivationRow, 'lane' | 'idempotencyKey' | 'trigger'>, ownerText: string | undefined, sent: string): { askedBy: BotJobAsker; request: string } {
  const trigger = row.trigger
  const own = (text: string | undefined) => jobLine(text?.trim() ? text : sent)
  if (trigger.kind === 'schedule') return { askedBy: 'schedule', request: own(trigger.input) }
  if (trigger.kind === 'manual' && trigger.fromBot) return { askedBy: 'bot', request: own(trigger.input) }
  if (ownerText?.trim()) return { askedBy: 'owner', request: jobLine(ownerText) }
  if (trigger.kind === 'work') return { askedBy: trigger.replyTo ? 'owner' : 'self', request: own(trigger.title) }
  return { askedBy: row.lane === 'chat' && /^(chat|answer):/.test(row.idempotencyKey) ? 'owner' : 'self', request: own(undefined) }
}
