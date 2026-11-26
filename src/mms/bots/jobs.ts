import type { BotLaunchedThread } from '../../shared/bots/personal/chat'
import { jobLine, type BotJob, type BotJobAsker, type BotJobState, type BotThreadAsk } from '../../shared/bots/personal/jobs'
import { modelFacingReplyText } from '../../shared/applets'
import type { ChatMessage } from '../../shared/types'
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

/** A heading's own words, without its marks; empty for a line that is no heading. */
function headingWords(line: string): string {
  return /^#{1,6}(?:\s|$)/.test(line) ? line.replace(/^#{1,6}/, '').replace(/\s#+$/, '').trim() : ''
}

/**
 * The one-line result of a thread's answer: its first line that says something, past blank lines and layout (a
 * heading, a rule, a code fence); a heading's own words when the answer has nothing else. None when it is layout only
 * (rules, empty fences, bare heading marks): a ledger line is never a delimiter.
 */
export function resultLine(result: string | undefined): string | undefined {
  const lines = (result ?? '').split(/\r?\n/).map((text) => text.trim()).filter(Boolean)
  const line = lines.find((text) => !LAYOUT_LINE.test(text)) ?? lines.map(headingWords).find((words) => words && !LAYOUT_LINE.test(words))
  return line ? jobLine(line) : undefined
}

/** A reply a reader reads: the assistant's own words, not a tool row, a progress note or a hidden row. */
function isReply(message: ChatMessage): boolean {
  return message.role === 'assistant' && (!message.kind || message.kind === 'message') && !message.hidden && typeof message.content === 'string' && message.content.trim().length > 0
}

/**
 * The reply run `runId` ended on, found by the run's own id in a thread's transcript (`messages`), never by its text:
 * the reply that carries the run's id (`turnId`, set on a turn's final reply), else the last reply between the message
 * that opened the run (it carries the id too) and the next run's first message. A run that wrote no reply, or left no
 * message of its own, has none: an earlier turn's reply is never its.
 */
export function runReplyOf(messages: readonly ChatMessage[], runId: string): ChatMessage | undefined {
  let opened = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.turnId !== runId) continue
    if (isReply(message)) return message
    opened = index
  }
  if (opened === -1) return undefined
  let last: ChatMessage | undefined
  for (let index = opened + 1; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.turnId !== undefined && message.turnId !== runId) break
    if (isReply(message)) last = message
  }
  return last
}

/**
 * A job thread's answer for run `runId` (`JobThreadView.result`): the reply the run ended on (`runReplyOf`), so a
 * progress message earlier in the turn never stands for it, as a model reads it (`modelFacingReplyText`: applet fences
 * cut, each published applet named by its reference line, never its source). A run with no reply of its own has what
 * it kept (`recorded`, already read that way), or nothing.
 */
export function jobResultOf(recorded: string | undefined, messages: readonly ChatMessage[], runId: string): string | undefined {
  const reply = runReplyOf(messages, runId)
  const text = reply ? modelFacingReplyText(reply).trim() : ''
  return text || (recorded?.trim() ? recorded : undefined)
}

/**
 * Who asked for a job handed off by turn `row`, and what they asked, one line: the owner's words (their message, or the
 * one the work answers), a schedule's or another bot's, or the bot's own (a wake, a question's default, a notice).
 * `ownerText`: the owner's words the turn answers, when it has them; `sent`: what the bot sent the thread. An owner's
 * job is named by `sent`, the part of their words this thread was handed (one message may ask for several things), and
 * by their whole message only when the thread was handed nothing.
 */
export function jobAskerOf(row: Pick<BotActivationRow, 'lane' | 'idempotencyKey' | 'trigger'>, ownerText: string | undefined, sent: string): { askedBy: BotJobAsker; request: string } {
  const trigger = row.trigger
  const own = (text: string | undefined) => jobLine(text?.trim() ? text : sent)
  if (trigger.kind === 'schedule') return { askedBy: 'schedule', request: own(trigger.input) }
  if (trigger.kind === 'manual' && trigger.fromBot) return { askedBy: 'bot', request: own(trigger.input) }
  // A message may ask for several things, on several lines or in one short one: the part this thread was handed says
  // which one its job is. Handed nothing to name, the job is the whole message, cut to the line.
  if (ownerText?.trim()) return { askedBy: 'owner', request: jobLine(sent.trim() ? sent : ownerText) }
  if (trigger.kind === 'work') return { askedBy: trigger.replyTo ? 'owner' : 'self', request: own(trigger.title) }
  return { askedBy: row.lane === 'chat' && /^(chat|answer):/.test(row.idempotencyKey) ? 'owner' : 'self', request: own(undefined) }
}
