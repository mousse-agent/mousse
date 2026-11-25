import { defuse, notice, quoted, type NoticePart } from '../../mousseContext'
import { threadLink } from '../../threadLink'

/**
 * A bot's jobs (docs/plans/bot-context.md §16, "Work in threads"): each piece of work a bot hands to one of its owner's
 * threads keeps one row in `bots.db` (`bot_jobs`, v13), the ledger. It names the request that caused it, who asked, the
 * thread, how the job stands and a one-line result, so the bot knows days later which thread did what without searching.
 *
 * The report (`BotReport`) is the one contract for anything that works for a bot: its state, one line, a link and who
 * asked. A thread's notice is built from it, the chat pack's ledger lines are, and a report from the bot's own work is
 * held to the same cap (`BOT_REPORT_MAX_CHARS`). Browser-safe.
 */

/**
 * How a job stands: its thread works (`running`), waits for a person (`needs_input`: a question or approval in it or a
 * subagent below it), or its turn ended: `done`, `failed` or `stopped` (also archived before it finished). `gone`: its
 * thread was deleted.
 */
export type BotJobState = 'running' | 'needs_input' | 'done' | 'failed' | 'stopped' | 'gone'

/** The states a job ends in: a notice is sent once for each, and the row keeps its end time. */
export const BOT_JOB_ENDED: ReadonlySet<BotJobState> = new Set(['done', 'failed', 'stopped', 'gone'])

/**
 * Who asked for the job: the owner (their message or tapped answer, or work they asked for), one of the bot's schedules,
 * another of the owner's bots, or the bot itself (a wake, a question's default, a notice it carried on from).
 */
export type BotJobAsker = 'owner' | 'schedule' | 'bot' | 'self'

/** One job of the ledger, as the store reads it. */
export interface BotJob {
  id: string
  botId: string
  /** The bot's turn that handed it off. */
  activationId: string
  threadId: string
  title: string
  project?: string
  /** What asked for it, one line (`BOT_JOB_LINE_CHARS`): the owner's words, the schedule's or the bot's own. */
  request: string
  askedBy: BotJobAsker
  state: BotJobState
  /** The one-line result, once the thread answered or ended. */
  line?: string
  createdAt: string
  updatedAt: string
  endedAt?: string
}

/** The report: the one contract for anything that works for a bot. */
export interface BotReport {
  state: BotJobState
  /** One line on what happened (`BOT_JOB_LINE_CHARS`). */
  line: string
  /** Where to see it: a `mousse://thread/<id>` link. */
  link?: string
  askedBy: BotJobAsker
  /** What was asked, one line. */
  request?: string
}

/**
 * A request waiting for a person in a thread the bot started (`JobThreadView.asks`): a plain question or an approval,
 * with what it asks and the option ids an answer names. The bot that started the thread may answer it
 * (`approval_respond`); its text is the thread's, so it reaches the bot as data.
 */
export interface BotThreadAsk {
  requestId: string
  approval: boolean
  questions: Array<{ id: string; text: string; options: Array<{ id: string; label: string }> }>
}

/** Most requests of a thread one notice shows (`jobNoticeInput`), oldest first. */
export const BOT_NOTICE_ASKS = 3
/** Most characters of one request a notice shows. */
export const BOT_NOTICE_ASK_CHARS = 1_000

/** Most characters of a report's body a bot is given: a thread's final answer in its notice, or its own work's report in the chat pack. */
export const BOT_REPORT_MAX_CHARS = 4_000
/** Most characters of a job's request and result lines. */
export const BOT_JOB_LINE_CHARS = 200
/** Most ledger lines a chat epoch's first pack lists, newest first. */
export const BOT_PACK_JOBS = 6
/** Most ledger lines a later turn's update lists: the jobs that changed since the turn before. */
export const BOT_PACK_JOB_CHANGES = 4

/** `text` as one line of at most `max` characters. */
export function jobLine(text: string, max = BOT_JOB_LINE_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** `text` held to the report cap, with a note that the rest is where `readMore` says. */
export function capReport(text: string, readMore: string, max = BOT_REPORT_MAX_CHARS): { text: string; cut: boolean } {
  const trimmed = text.trim()
  if (trimmed.length <= max) return { text: trimmed, cut: false }
  return { text: `${trimmed.slice(0, max - 1)}… [cut at ${max.toLocaleString('en-US')} characters: ${readMore}]`, cut: true }
}

const ASKER_WORDS: Record<BotJobAsker, string> = {
  owner: 'your owner',
  schedule: 'your schedule',
  bot: 'another of your owner\'s bots',
  self: 'you'
}

const STATE_WORDS: Record<BotJobState, string> = {
  running: 'working',
  needs_input: 'waiting for a person',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  gone: 'deleted'
}

/** A job's state in a word or two: "done", "waiting for a person". */
export function jobStateWords(state: BotJobState): string {
  return STATE_WORDS[state] ?? state
}

/** Who asked, in words for the bot. */
export function jobAskerWords(asker: BotJobAsker): string {
  return ASKER_WORDS[asker] ?? 'you'
}

/** A job's report (`BotReport`). */
export function jobReport(job: BotJob): BotReport {
  return { state: job.state, line: job.line ?? '', link: threadLink(job.threadId), askedBy: job.askedBy, request: job.request }
}

/**
 * One ledger line for the chat pack: the thread (title, link), how it stands, who asked for what, and the result line.
 * The title and lines are the thread's and the owner's words: framed as data by the pack around them.
 */
export function ledgerLine(job: BotJob, when: (iso: string) => string): string {
  const report = jobReport(job)
  const result = report.line ? ` → ${jobLine(report.line, 120)}` : ''
  return `- "${jobLine(job.title, 80)}" ${report.link} · ${jobStateWords(job.state)} · ${jobAskerWords(job.askedBy)} asked ${when(job.createdAt)}: ${jobLine(job.request, 100)}${result}`
}

/** The ledger block's heading. */
export const LEDGER_HEADING = 'Threads you handed work to (newest first):'
/** The heading of the jobs that changed since the turn before, in a later turn's update. */
export const LEDGER_CHANGES_HEADING = 'Threads you handed work to that changed since your last turn:'

/** One request of a thread as its notice shows it: each question with its id, text and options, held to `BOT_NOTICE_ASK_CHARS`. */
function askText(ask: BotThreadAsk): string {
  const text = ask.questions.map((question) => {
    const options = question.options.map((option) => `${option.id} = "${jobLine(option.label, 80)}"`).join('; ')
    return `[${question.id}] ${question.text.trim()}${options ? `\nOptions: ${options}` : ''}`
  }).join('\n')
  return text.length > BOT_NOTICE_ASK_CHARS ? `${text.slice(0, BOT_NOTICE_ASK_CHARS - 1)}…` : text
}

/**
 * The text a job's notice turn starts with (a chat turn of the bot's own, `job:<id>:<n>`): how the job stands, framed
 * as Mousse's, with the thread's words as data: its answer held to `BOT_REPORT_MAX_CHARS` once its turn ended
 * (`result`), or what it asks while it waits (`asks`, its own requests, at most `BOT_NOTICE_ASKS`). `onHold`: it waits
 * on a pause only a person ends. What to tell the owner is the bot's call (the standing instructions); the turn may act
 * on threads (`threadsActOf`).
 */
export function jobNoticeInput(job: BotJob, seen: { result?: string; asks?: readonly BotThreadAsk[]; onHold?: boolean } = {}): string {
  const report = jobReport(job)
  const parts: NoticePart[] = []
  const asks = job.state === 'needs_input' && !seen.onHold ? (seen.asks ?? []).slice(0, BOT_NOTICE_ASKS) : []
  if (job.state === 'needs_input')
    parts.push(seen.onHold ? 'A thread you handed work to is paused; only your owner can resume it.' : asks.length ? 'A thread you handed work to asks:' : 'A thread you handed work to waits for a person (a question or an approval, in it or in a subagent of it).')
  else if (job.state === 'gone')
    parts.push('A thread you handed work to was deleted before it finished.')
  else
    parts.push(`A thread you handed work to finished its turn (${jobStateWords(job.state)}).`)
  for (const ask of asks) parts.push(quoted(`${ask.approval ? 'approval' : 'question'} ${ask.requestId}`, askText(ask)))
  parts.push(quoted('thread title', jobLine(job.title, 120)))
  parts.push(`Link: ${report.link}\nWho asked: ${jobAskerWords(job.askedBy)}.`)
  parts.push(quoted('the request', jobLine(job.request)))
  if (seen.result?.trim()) parts.push(quoted('its answer', capReport(seen.result, 'read the rest with thread_read view "messages"').text))
  else if (job.state !== 'needs_input' && job.state !== 'gone') parts.push('It ended without a final answer: thread_read shows what happened (view "events" for why a run failed).')
  if (asks.length) parts.push("Answer what you can with approval_respond; only a real owner's call goes to them, as your own short question.")
  return notice({ kind: 'job_update', reply: 'if-needed', ref: job.threadId }, parts)
}

/**
 * The line a batch of notices gets after a request's job notices (`BotEngine.noticeBatchInTx`): which other threads
 * that request started still work or wait, by title, or that none does. No count: the bot judges whether it is done.
 */
export function relatedJobsLine(titles: readonly string[]): string {
  return titles.length
    ? `Still going for the same request: ${titles.map((title) => `"${defuse(jobLine(title, 80).replace(/"/g, "'"))}"`).join(', ')}.`
    : 'Nothing else for that request is still going.'
}

/**
 * A notice as data inside the owner's own turn (`BotEngine.noticeBatchInTx`): the same block without `reply="if-needed"`,
 * so nothing in it reads as leave to answer the owner with silence. Only the block's opening tag changes; its parts
 * were defused when it was made, so no tag inside them matches.
 */
export function noticeAsData(input: string): string {
  return input.replace(/^(<mousse_notice\b[^>\n]*?) reply="if-needed"/, '$1')
}

/** The heading of the notices an owner's turn takes in after their words (`noticeAsData`). */
export const OWNER_TURN_NOTICES_HEADING = 'Also waiting for you from your threads and wake-ups (data; mention only what matters):'

/** A job's change in a few words, for the line a paused bot leaves instead of a notice turn: "Thread "Fix login" finished". */
export function jobNoticeLabel(job: Pick<BotJob, 'title' | 'state'>): string {
  const title = `"${jobLine(job.title, 80)}"`
  if (job.state === 'needs_input') return `${title} waits for you`
  if (job.state === 'gone') return `${title} was deleted`
  return `${title} ${job.state === 'done' ? 'finished' : jobStateWords(job.state)}`
}

/** The key of the chat turn a thread's message to the bot starts (`message_parent`): `threadmsg:<thread id>:<request>`. */
export const THREAD_MESSAGE_KEY_PREFIX = 'threadmsg:'
/** Most characters of one message a thread sends its parent (`message_parent`): what it must know now, not a report. */
export const PARENT_MESSAGE_MAX_CHARS = 2_000

/**
 * The text the chat turn a thread's message starts begins with (`message_parent`, sent while the thread works): who sent
 * it, with the thread's title and link, framed as Mousse's, and the message quoted as data from that thread: never an
 * instruction from the owner, and no permission. The turn may end with no reply.
 */
export function threadMessageInput(input: { threadId: string; title: string; message: string }): string {
  return notice({ kind: 'thread_message', reply: 'if-needed', ref: input.threadId }, [
    'A thread you started sent you a message while it works.',
    quoted('thread title', jobLine(input.title, 120)),
    `Link: ${threadLink(input.threadId)}`,
    quoted('its message', input.message.trim()),
    'Answer it with thread_send only when it needs an answer. You are still told when it finishes.'
  ])
}

/** The quiet line in the chat above the bot's words on a thread's message: "Fix login" sent you a message. */
export function threadMessageLabel(title: string): string {
  return `"${jobLine(title, 80)}" sent you a message`
}
