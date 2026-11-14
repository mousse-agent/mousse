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
 * How a question was answered: a choice tapped, or words written in reply. `by`: who answered: the owner on the question
 * itself, or the bot's chat passing on what the owner wrote there to work that waits on it (`question_answer`).
 */
export interface BotQuestionAnswer {
  choice?: string
  text?: string
  by: 'owner' | 'chat'
  /** Answered by a tap: the bot's label, never the owner's own words. Kept when the answer is forgotten. */
  tapped?: true
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
  /** The owner answered it in the chat, which passed it on (a question from work): "Answered in chat: …". */
  by?: 'chat'
  /** The bot's work waits on it: the work goes on once it is answered. */
  waits?: true
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

/** What the chat is told of a question its work waits on (its situation): its words, its answers, and the work's title. */
export function waitingQuestionLine(input: { questionId: string; question: string; choices: string; title: string }): string {
  return `"${input.title}" waits for the owner's answer to your question "${quoteOf(input.question, 160)}"${input.choices ? ` (${input.choices})` : ''} [${input.questionId}]. If the owner answers it in the chat, pass it on with question_answer.`
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
