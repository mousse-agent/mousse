/**
 * A bot's questions to its owner (`ask_owner`, issue #1123): a short question with 2–5 answers to tap, or yes/no, and
 * "Other…" for an answer in the owner's own words. Kept in `bots.db` (`bot_questions`, v8), apart from permission asks:
 * a question grants nothing. Browser-safe.
 */

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

/** At most one question per chat turn (its activation), however many dispatches it takes. */
export const MAX_QUESTIONS_PER_CHAT_TURN = 1
/** A piece of work asks one question at a time: it waits on it, and may ask another once it carries on with the answer. */
export const MAX_OPEN_QUESTIONS_PER_WORK = 1
/** At most this many of a bot's questions are open at once. */
export const MAX_OPEN_QUESTIONS_PER_BOT = 6
/** At most this many new questions per bot in any 24 hours. */
export const MAX_NEW_QUESTIONS_PER_DAY = 20

/** The tool's answer over any cap. */
export const QUESTIONS_ENOUGH_TEXT = "You've asked enough for now. Decide yourself and say what you assumed."

/** `ask_owner`'s answer once the question is kept: it shows under the reply. */
export const QUESTION_ASKED_TEXT = "The owner sees it under your reply, with its buttons. Don't repeat it in your reply; end your turn."

/** `ask_owner`'s answer in work: the question is in the chat now, and the work waits for the answer. */
export const QUESTION_WORK_ASKED_TEXT = 'Asked: your owner sees it in the chat, with its buttons. Stop here and end your turn now; you carry on in this thread with their answer.'

/** What every call of work's turn after it asked is refused with: the turn ends, and the answer continues the work. */
export const QUESTION_END_TURN_TEXT = 'You asked your owner a question. End your turn now; you continue with their answer.'

/** `ask_owner` after `escalate` in the same turn: a tap there would count as Not now for the permission. */
export const QUESTION_AFTER_ASK_TEXT = 'Ask it once the owner has answered your permission ask. Finish your message now.'

/** `ask_owner` where it is never offered (a scheduled run, a consult, a subagent): the question goes in the report. */
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
/** No nudge and no default between these hours in the owner's time zone: they wait until the morning. */
export const QUIET_FROM_HOUR = 22
export const QUIET_UNTIL_HOUR = 8

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
 * `ask_owner`'s follow-up, or why not, in words the bot can act on: `ifNoAnswer` `nudge` (the default) or `default`,
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
  return `"${input.title}" waits for the owner's answer to your question "${quoteOf(input.question, 160)}"${input.choices ? ` (${input.choices})` : ''} [${input.questionId}].${fallback} If the owner answers it in the chat, pass it on with question_answer.`
}

/** How a question's answers read as text (older apps, notifications, the journal): "Flat A · Flat B · Something else". */
export function plainChoices(spec: Pick<BotQuestionSpec, 'choices' | 'other'>): string {
  return [...spec.choices.map((choice) => choice.label), ...(spec.other ? ['Something else'] : [])].join(' · ')
}

/** Text that is one line: whitespace runs as one space, trimmed. */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * `ask_owner`'s arguments as a question, or why not, in words the bot can act on. `choices` are 2–5 labels (strings, or
 * `{ label, detail? }`), each label one line of at most 40 characters and each different; `yesNo` is Yes and No. A
 * question needs its answers: an open question with none is the bot's reply, not a question.
 */
export function questionSpecOf(args: Record<string, unknown>): BotQuestionSpec | { problem: string } {
  const question = typeof args.question === 'string' ? args.question.trim() : ''
  if (!question) return { problem: 'ask_owner needs the question, standing on its own.' }
  if (question.length > MAX_QUESTION_CHARS) return { problem: `Keep the question under ${MAX_QUESTION_CHARS} characters.` }
  if (args.yesNo !== undefined && args.yesNo !== true) return { problem: 'yesNo is true, or left out.' }
  if (args.other !== undefined && typeof args.other !== 'boolean') return { problem: 'other is true or false.' }
  const other = args.other !== false
  if (args.yesNo === true) {
    if (args.choices !== undefined) return { problem: 'Give choices or yesNo, not both.' }
    return { question, choices: [{ label: 'Yes' }, { label: 'No' }], other }
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
  return { question, choices, other }
}
