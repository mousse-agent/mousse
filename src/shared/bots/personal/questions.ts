/**
 * A bot's questions to its owner (`question_ask`, issue #1123): a short question with 2–5 answers to tap, or yes/no, and
 * "Other…" for an answer in the owner's own words. Kept in `bots.db` (`bot_questions`, v8), apart from permission asks:
 * a question grants nothing. Browser-safe.
 */

import { cardOf, type BotCard } from './cards'

/** Where a question stands. `moved_on`: the owner wrote something else first (a chat question); its buttons still answer it. */
export type BotQuestionStatus = 'open' | 'answered' | 'defaulted' | 'moved_on' | 'withdrawn'

/** One answer to tap: a short label, and a line more on it when the label needs one. */
export interface BotQuestionChoice {
  label: string
  detail?: string
}

/** What a question asks, as the bot wrote it. */
export interface BotQuestionSpec {
  question: string
  choices: BotQuestionChoice[]
  /** "Other…" is offered: the owner answers in their own words. */
  other: boolean
  /** One card for context (a few options as facts, a gallery), shown on the question's bubble above its answers. */
  card?: BotCard
  /**
   * `false`: work asked without waiting (issue #1372) and keeps working. The answer reaches it as a note while it runs,
   * or carries it on in its thread when its turn has ended. Only work keeps it; a chat turn's question never waits.
   */
  wait?: false
}

/** Whether work keeps working while this question is open (`question_ask` with `wait: false`). */
export function keepsWorking(spec: Pick<BotQuestionSpec, 'wait'>): boolean {
  return spec.wait === false
}

/**
 * What happens when the owner doesn't answer, as the bot chose when it asked: Mousse reminds them (`nudge`, the work keeps
 * waiting), or after `afterMs` the bot goes with `default`, one of its choices (`default`, for a minor, reversible
 * choice). Kept in `bot_questions.follow_json`; `{}` (a question from an earlier build) has none.
 */
export interface BotQuestionFollow {
  kind: 'nudge' | 'default'
  /** From when its bubble is shown to the first nudge, or to the default. */
  afterMs: number
  /** The choice's label the bot goes with (`default` only). */
  default?: string
}

/** What the owner answered after the bot had gone with its default: a choice tapped, or their words. */
export interface BotQuestionLateAnswer {
  choice?: string
  text?: string
  tapped?: true
}

/**
 * How a question was answered: a choice tapped, or words written in reply. `by`: who answered: the owner on the question
 * itself, the bot's chat passing on what the owner wrote there to work that waits on it (`question_answer`), or nobody:
 * the owner didn't answer in time, and the bot went with its own default (`default`, never the owner's words).
 */
export interface BotQuestionAnswer {
  choice?: string
  text?: string
  by: 'owner' | 'chat' | 'default'
  /** Answered by a tap: the bot's label, never the owner's own words. Kept when the answer is forgotten. */
  tapped?: true
  /** A default applied after its time (Mousse was off then): the time it was due. */
  dueAt?: string
  /** The owner's answer after the bot went with its default (`by: 'default'` only). */
  late?: BotQuestionLateAnswer
}

/** A question on a bot's message, as the app draws it: its answers to tap, and where it stands. */
export interface BotChatQuestion {
  questionId: string
  choices: BotQuestionChoice[]
  other: boolean
  status: BotQuestionStatus
  /** The answer: the label tapped, or the start of what the owner wrote. Absent while it is open, or when forgotten. */
  answer?: string
  /** Whether the answer was tapped (`choice`) or written (`text`). */
  answeredWith?: 'choice' | 'text'
  /**
   * Who answered, when it was not the owner on the question itself: the chat, which passed on what they wrote there (a
   * question from work, "Answered in chat: …"), or nobody: the bot went with its default (`defaulted`, "No answer · went
   * with A"; `answer` is the default).
   */
  by?: 'chat' | 'default'
  /** The bot's work waits on it: the work goes on once it is answered. */
  waits?: true
  /** An open question the bot goes with `default` on, at `defaultAt`, if the owner doesn't answer first. */
  default?: string
  defaultAt?: string
  /** What the owner answered after the bot went with its default: the label tapped, or the start of what they wrote. */
  late?: string
  /** This message reminds the owner of the question (a nudge); the question itself is the message it replies to. */
  nudge?: true
  /** A later nudge carries the question's answers while it waits: this row (its bubble, or an earlier nudge) shows none. */
  nudged?: true
}

export const MAX_QUESTION_CHARS = 600
export const MIN_QUESTION_CHOICES = 2
export const MAX_QUESTION_CHOICES = 5
export const MAX_CHOICE_LABEL_CHARS = 40
export const MAX_CHOICE_DETAIL_CHARS = 120

/** The most questions one `question_ask` call may ask together (`questions`). */
export const MAX_QUESTIONS_PER_CALL = 4

/**
 * What `question_ask` is refused with when it repeats a question the owner has not answered or written about since:
 * there is no count of questions, but asking the same thing again is a loop (`questionIdentity`).
 */
export const QUESTION_DUPLICATE_TEXT = "duplicate_ask: You already asked this and your owner hasn't written since. Don't ask it again; decide yourself and say what you assumed, or wait for them to write."

/**
 * A question's identity for repeat checks: its words (case and spacing ignored, without a trailing question mark) and
 * its answers, sorted. Two calls that ask the same thing with the answers in another order are the same question.
 */
export function questionIdentity(spec: Pick<BotQuestionSpec, 'question' | 'choices'>): string {
  const words = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()
  return JSON.stringify([words(spec.question).replace(/[?？]+$/, '').trim(), spec.choices.map((choice) => words(choice.label)).sort()])
}

/** `question_ask`'s answer once the question is kept: it shows under the reply. */
export const QUESTION_ASKED_TEXT = "The owner sees it under your reply, with its buttons. Don't repeat it in your reply; end your turn."

/** `question_ask`'s answer in work: the question is in the chat now, and the work waits for the answer. */
export const QUESTION_WORK_ASKED_TEXT = 'Asked: your owner sees it in the chat, with its buttons. Stop here and end your turn now; you carry on in this thread with their answer.'

/** `question_ask`'s answer in work that asked without waiting: the work goes on, and the answer comes as a note. */
export function questionWorkKeepsWorkingText(questionId: string): string {
  return `Asked (${questionId}): your owner sees it in the chat, with its buttons. Keep working on what doesn't need the answer, and don't do the part that does yet. Their answer reaches you as a note naming this question while you work; if your turn ends first, you carry on in this thread with it.`
}

/** What every call of work's turn after it asked is refused with: the turn ends, and the answer continues the work. */
export const QUESTION_END_TURN_TEXT = 'You asked your owner a question. End your turn now; you continue with their answer.'

/** `question_ask` after `permission_ask` in the same turn: a tap there would count as Not now for the permission. */
export const QUESTION_AFTER_ASK_TEXT = 'Ask it once the owner has answered your permission ask. Finish your message now.'

/** `question_ask` where it is never offered (a scheduled run, a consult, a subagent): the question goes in the report. */
export const QUESTION_NOT_OFFERED_TEXT = "You can't ask your owner from here: carry on, and ask in your report."

/** `question_answer` after the owner forgot what they wrote in that chat turn: nothing of it is passed on. */
export const QUESTION_ANSWER_FORGOTTEN_TEXT = "Your owner removed what they wrote, so it can't be passed on. The question stays open for them to answer."

/** The owner's Continue on work that waits for their answer: the answer is the way on. */
export const QUESTION_WORK_WAITING_TEXT = 'This work waits for your answer to its question. Answer it to let it carry on, or stop it.'

// -- Follow-ups when the owner doesn't answer ------------------------------------------------------------------------

/** The fewest and the most minutes a bot may give its owner before it follows a question up. */
export const MIN_FOLLOW_UP_MINUTES = 15
export const MAX_FOLLOW_UP_MINUTES = 24 * 60
/** When the bot names no time: the first nudge after an hour, a default after half an hour. */
export const DEFAULT_NUDGE_AFTER_MINUTES = 60
export const DEFAULT_ANSWER_AFTER_MINUTES = 30
/** At most this many nudges per question: the first at its time, the next about a day later; then it stays quiet. */
export const MAX_NUDGES_PER_QUESTION = 2
export const NUDGE_AGAIN_MS = 24 * 60 * 60_000
/** A bot's nudges, all its questions together: at most one an hour, and three in any 24 hours. */
export const NUDGE_SPACING_MS = 60 * 60_000
export const MAX_NUDGES_PER_DAY = 3

/** A nudge: one fixed line from Mousse (no model call), as a reply to the question's bubble, with its answers again. */
export const NUDGE_TEXT = 'Still need your answer on this one.'

/**
 * A nudge's notification, which a phone shows with no chat around it: the question it reminds of, cut to fit. Built
 * from the question's bubble when it is shown, never stored, so forgetting the bubble leaves no copy of it.
 */
export function nudgeNotificationText(question: string): string {
  return `Still need your answer: ${quoteOf(question, 90)}`
}

/** "30 minutes", "1 hour", "90 minutes". */
export function waitLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

/**
 * `question_ask`'s follow-up, or why not, in words the bot can act on: `ifNoAnswer` `nudge` (the default) or `default`,
 * `after` in minutes (15 to 1440; an hour for a nudge and half an hour for a default when left out), and `default`, one
 * of the question's choices, which a default needs. A `default` given alone means `ifNoAnswer: 'default'`.
 */
export function questionFollowOf(args: Record<string, unknown>, spec: Pick<BotQuestionSpec, 'choices'>): BotQuestionFollow | { problem: string } {
  const named = args.ifNoAnswer
  if (named !== undefined && named !== 'nudge' && named !== 'default') return { problem: "ifNoAnswer is 'nudge' or 'default'." }
  if (args.default !== undefined && typeof args.default !== 'string') return { problem: 'default is the label of one of your choices.' }
  const given = typeof args.default === 'string' ? oneLine(args.default) : ''
  const kind = named ?? (given ? 'default' : 'nudge')
  if (kind === 'nudge' && given) return { problem: "A default goes with ifNoAnswer 'default'; with 'nudge' your owner is reminded instead." }
  if (args.after !== undefined && (typeof args.after !== 'number' || !Number.isFinite(args.after))) return { problem: 'after is a number of minutes.' }
  const minutes = typeof args.after === 'number' ? Math.round(args.after) : kind === 'default' ? DEFAULT_ANSWER_AFTER_MINUTES : DEFAULT_NUDGE_AFTER_MINUTES
  if (minutes < MIN_FOLLOW_UP_MINUTES || minutes > MAX_FOLLOW_UP_MINUTES) return { problem: `after is ${MIN_FOLLOW_UP_MINUTES} to ${MAX_FOLLOW_UP_MINUTES} minutes.` }
  if (kind === 'nudge') return { kind, afterMs: minutes * 60_000 }
  if (!given) return { problem: "ifNoAnswer 'default' needs default: the label of the choice you go with if they don't answer." }
  const choice = spec.choices.find((entry) => entry.label.toLowerCase() === given.toLowerCase())
  if (!choice) return { problem: `default is one of your choices: ${spec.choices.map((entry) => `"${entry.label}"`).join(', ')}.` }
  return { kind, afterMs: minutes * 60_000, default: choice.label }
}

/** Why a default was late, when it was applied after its time: the time it was due, and that Mousse was off then. */
function overdueLine(choice: string, dueClock: string | undefined): string {
  return dueClock ? ` This was due at ${dueClock}; Mousse was off then. Check "${choice}" still makes sense.` : ''
}

/**
 * How work hears that its owner didn't answer and it goes with its own default: the bot's choice, never the owner's
 * words. `dueClock`: the time it was due, when it was applied late.
 */
export function defaultWorkLine(question: string, choice: string, afterMs: number, dueClock?: string): string {
  return `Your owner didn't answer your question "${quoteOf(question, 200)}" within ${waitLabel(afterMs)}, so go with "${choice}", as you said you would, and say so in your report.${overdueLine(choice, dueClock)}`
}

/**
 * The chat's input when the owner didn't answer its question in time: a turn of its own, not the owner's (`question:`),
 * that goes with the default and says so in a line.
 */
export function defaultChatInput(question: string, choice: string, afterMs: number, dueClock?: string): string {
  return `[Mousse] You asked your owner "${quoteOf(question, 200)}" and said you'd go with "${choice}" if they didn't answer within ${waitLabel(afterMs)}. They haven't. Go with "${choice}" now and tell them in one short line, like "No answer, so I went with ${choice}."${overdueLine(choice, dueClock)}`
}

/** The line before the owner's answer to a question the bot had already gone ahead on with its default. */
export function lateAnsweringLine(question: string, choice: string): string {
  return `(Answering your question late: "${quoteOf(question, 200)}". You had already gone with "${choice}".)`
}

/**
 * The note running work gets when its owner answers late the question it went on with its default for. Only their answer:
 * the question and the default are in the work's thread already, and the note goes with the owner's message on Forget.
 */
export function lateWorkNote(answer: string): string {
  return `Your owner answered your earlier question late, after you went with your default: ${answer.trim()}. Change course if you still can, and say so in your report.`
}

/** One line, cut to `max` characters. */
function quoteOf(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * How work that waited on its question hears the answer when it carries on: the question, and the owner's answer (or,
 * from the chat, what the chat passed on of the owner's words there).
 */
export function workAnswerLine(question: string, answer: string, by: BotQuestionAnswer['by']): string {
  return `Your owner answered your question "${quoteOf(question, 200)}"${by === 'chat' ? ' in the chat' : ''}: ${answer.trim()}`
}

/** The answer to a question work asked without waiting, delivered as a note while the work runs: tagged with the question. */
export function openQuestionAnswerNote(questionId: string, line: string): string {
  return `[${questionId}] ${line} Carry on with the part that needed it.`
}

/** The line work posts when it ends because the question it waited on is gone (forgotten, or withdrawn). */
export function questionGoneText(title: string): string {
  return `I stopped "${title}": the question I was waiting on is gone. Ask me again if you still want it.`
}

/**
 * What the chat is told of a question its work waits on (its situation): its words, its answers, the work's title, and
 * the default the work goes with at a time (`defaultAt`, a clock time) if the owner doesn't answer first.
 */
export function waitingQuestionLine(input: { questionId: string; question: string; choices: string; title: string; default?: string; defaultAt?: string }): string {
  const fallback = input.default && input.defaultAt ? ` If they haven't answered by ${input.defaultAt}, it goes with "${input.default}".` : ''
  return `"${input.title}" waits for the owner's answer to your question "${quoteOf(input.question, 160)}"${input.choices ? ` (${input.choices})` : ''} [${input.questionId}].${fallback} If the owner answers it in the chat, pass it on with request_answer.`
}

/** How a question's answers read as text (older apps, notifications, the journal): "Flat A · Flat B · Something else". */
export function plainChoices(spec: Pick<BotQuestionSpec, 'choices' | 'other'>): string {
  return [...spec.choices.map((choice) => choice.label), ...(spec.other ? ['Something else'] : [])].join(' · ')
}

/** Text that is one line: whitespace runs as one space, trimmed. */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * `question_ask`'s arguments as a question, or why not, in words the bot can act on. `choices` are 2–5 labels (strings, or
 * `{ label, detail? }`), each label one line of at most 40 characters and each different; `yesNo` is Yes and No. A
 * question needs its answers: an open question with none is the bot's reply, not a question.
 */
export function questionSpecOf(args: Record<string, unknown>): BotQuestionSpec | { problem: string } {
  const question = typeof args.question === 'string' ? args.question.trim() : ''
  if (!question) return { problem: 'question_ask needs the question, standing on its own.' }
  if (question.length > MAX_QUESTION_CHARS) return { problem: `Keep the question under ${MAX_QUESTION_CHARS} characters.` }
  if (args.yesNo !== undefined && args.yesNo !== true) return { problem: 'yesNo is true, or left out.' }
  if (args.other !== undefined && typeof args.other !== 'boolean') return { problem: 'other is true or false.' }
  if (args.wait !== undefined && typeof args.wait !== 'boolean') return { problem: 'wait is true or false.' }
  const other = args.other !== false
  // One card for context, checked as `show_card` checks it.
  const card = args.card === undefined ? undefined : cardOf(args.card)
  if (card && 'problem' in card) return { problem: `card: ${card.problem}` }
  const carded = { ...(card ? { card } : {}), ...(args.wait === false ? { wait: false as const } : {}) }
  if (args.yesNo === true) {
    if (args.choices !== undefined) return { problem: 'Give choices or yesNo, not both.' }
    return { question, choices: [{ label: 'Yes' }, { label: 'No' }], other, ...carded }
  }
  if (!Array.isArray(args.choices)) return { problem: `Give ${MIN_QUESTION_CHOICES} to ${MAX_QUESTION_CHOICES} choices, or yesNo.` }
  if (args.choices.length < MIN_QUESTION_CHOICES || args.choices.length > MAX_QUESTION_CHOICES)
    return { problem: `Give ${MIN_QUESTION_CHOICES} to ${MAX_QUESTION_CHOICES} choices.` }
  const choices: BotQuestionChoice[] = []
  for (const entry of args.choices) {
    const given = typeof entry === 'string' ? { label: entry } : entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
    const label = typeof given?.label === 'string' ? oneLine(given.label) : ''
    if (!label) return { problem: 'Each choice is a short label, or { label, detail }.' }
    if (label.length > MAX_CHOICE_LABEL_CHARS) return { problem: `Keep each choice's label to ${MAX_CHOICE_LABEL_CHARS} characters; put more in its detail.` }
    if (given?.detail !== undefined && typeof given.detail !== 'string') return { problem: 'A choice\'s detail is text.' }
    const detail = typeof given?.detail === 'string' ? oneLine(given.detail) : ''
    if (detail.length > MAX_CHOICE_DETAIL_CHARS) return { problem: `Keep each choice's detail to ${MAX_CHOICE_DETAIL_CHARS} characters.` }
    if (choices.some((choice) => choice.label.toLowerCase() === label.toLowerCase())) return { problem: 'Give each choice a different label.' }
    choices.push({ label, ...(detail ? { detail } : {}) })
  }
  return { question, choices, other, ...carded }
}

/** One question of an `question_ask` call, as Mousse keeps it: what it asks, and what happens if the owner doesn't answer. */
export interface BotQuestionAsk {
  spec: BotQuestionSpec
  /** Absent: nothing follows it up (as an earlier build kept it). `question_ask` always names one. */
  follow?: BotQuestionFollow
}

/**
 * `question_ask`'s arguments as the questions it asks, or why not: one question (`question` and its answers), or up to
 * `MAX_QUESTIONS_PER_CALL` together (`questions`, each with its own answers and follow-up). `wait` is the call's, for
 * every question in it. The same question twice in one call is refused.
 */
export function questionAsksOf(args: Record<string, unknown>): BotQuestionAsk[] | { problem: string } {
  if (args.questions === undefined) {
    const spec = questionSpecOf(args)
    if ('problem' in spec) return spec
    const follow = questionFollowOf(args, spec)
    return 'problem' in follow ? follow : [{ spec, follow }]
  }
  if (args.question !== undefined) return { problem: 'Give question or questions, not both.' }
  if (!Array.isArray(args.questions) || args.questions.length === 0) return { problem: 'questions is a list of questions, each with question and its choices or yesNo.' }
  if (args.questions.length > MAX_QUESTIONS_PER_CALL) return { problem: `Ask at most ${MAX_QUESTIONS_PER_CALL} questions at once. Ask the ones that matter most now.` }
  const asks: BotQuestionAsk[] = []
  for (const [index, item] of args.questions.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { problem: `questions[${index}] is a question: { question, choices or yesNo }.` }
    if ('wait' in item) return { problem: 'wait goes beside questions, for all of them.' }
    const given = { ...(item as Record<string, unknown>), ...(args.wait !== undefined ? { wait: args.wait } : {}) }
    const spec = questionSpecOf(given)
    if ('problem' in spec) return { problem: `questions[${index}]: ${spec.problem}` }
    const follow = questionFollowOf(given, spec)
    if ('problem' in follow) return { problem: `questions[${index}]: ${follow.problem}` }
    if (asks.some((ask) => questionIdentity(ask.spec) === questionIdentity(spec))) return { problem: 'Ask each question once.' }
    asks.push({ spec, follow })
  }
  return asks
}
