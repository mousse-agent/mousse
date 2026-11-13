import type { BotAskCard, BotChatMessage, BotChip, BotSummary, BotWorkItem } from '../../../shared/bots/personal/chat'

/**
 * How a bot's chat reads as a messenger: what the renderer infers from the chat's rows alone (`bot_messages`), with
 * nothing new from the engine. Browser-safe and pure.
 */

/** A reply this long or longer, or with more than one paragraph, says more than "on it": it stays a message. */
export const HANDOFF_TEXT_MAX = 200

/** A chip of work the chat handed off: "started <title>" (or "will start", when it waits its turn). */
export function isWorkStart(chip: BotChip): boolean {
  return chip.icon === 'think' && (chip.text === 'started' || chip.text === 'will start') && Boolean(chip.highlight)
}

/** A chip of a note the chat passed to running work (`work_note`): "passed on your note", or "noted" as later services word it. */
export function isNotePassed(chip: BotChip): boolean {
  return chip.icon === 'think' && (chip.text === 'passed on your note' || chip.text === 'noted')
}

/** The title of handed-off work, without the model a chip may add ("Vacuum comparison · Opus 5.5"). */
function workTitle(chip: BotChip): string {
  return chip.highlight!.split(' · ')[0]!
}

/**
 * What a bot's message did with work, which the chat also shows outside its steps: the work it started (a 👍 on the
 * owner's message and a quiet line, "alpha started System check"), whether it noted something for work ("Noted" under
 * the owner's message), and `only`: the reply says nothing more than that ("On it.", "I'll use that tab from here on."),
 * one short paragraph with nothing else on the message, so it shows no bubble. `details`: those chips' own hover text
 * (the model of work on a model of its own, the job a note is for), kept on what stands in for them. Null for a message
 * that did neither.
 */
export function workSignalsOf(message: BotChatMessage): { titles: string[]; queued: boolean; noted: boolean; only: boolean; details: string[] } | null {
  if (message.author !== 'bot') return null
  const starts = message.chips.filter(isWorkStart)
  const noted = message.chips.some(isNotePassed)
  if (!starts.length && !noted) return null
  const text = message.text.trim()
  const only = message.kind === 'text' && !message.ask && !message.error && !message.attachments?.length &&
    message.chips.every((chip) => isWorkStart(chip) || isNotePassed(chip)) &&
    text.length < HANDOFF_TEXT_MAX && !/\n\s*\n|```|^\s*[#|>-]/m.test(text)
  const details = message.chips.filter((chip) => isWorkStart(chip) || isNotePassed(chip)).flatMap((chip) => (chip.title ? [chip.title] : []))
  return { titles: starts.map(workTitle), queued: starts.length > 0 && starts.every((chip) => chip.text === 'will start'), noted, only, details }
}

/**
 * One row of the transcript: a message, or a quiet centred line between messages. `of`: the message a line stands in
 * for (an answer the owner tapped), so a reply to it, or a quote of it, finds it there.
 */
export type BotChatRow =
  | { kind: 'message'; message: BotChatMessage }
  | { kind: 'system'; id: string; at: string; text: string; title?: string; of?: string }

/** The quiet line an answer the owner tapped leaves in place of their bubble: "You answered “Flat B”". */
export function tappedAnswerLine(label: string): string {
  return `You answered “${label}”`
}

/** What a bot's handling left on an owner's message: a 👍 for work it started, "Noted" for a note; `title`: its hover text. */
export interface OwnerMarks { reaction?: string; passedOn?: boolean; title?: string }

/** "alpha started System check", "alpha started A and B". */
function startedLine(botName: string, titles: readonly string[], queued: boolean): string {
  const named = titles.length > 2 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles.join(' and ')
  return `${botName} ${queued ? 'will start' : 'started'} ${named}`
}

/** The quiet line an answered ask leaves: "You let alpha use the browser". */
export function askAnsweredLine(botName: string, ask: Pick<BotAskCard, 'title' | 'status'>): string | undefined {
  if (ask.status === 'allowed') return `You let ${botName} ${ask.title}`
  if (ask.status === 'not_now') return `You said not now to ${botName}: ${ask.title}`
  if (ask.status === 'withdrawn') return `${botName} no longer needs to ${ask.title}`
  return undefined
}

/**
 * The transcript's rows: each message, with the work a reply started as its own quiet line before it (the reply's
 * bubble left out when it said nothing more), each answered ask followed by its line, and each answer the owner tapped
 * to a question as a quiet line where their bubble would be (its hover text the question). `marks` holds what replies
 * left on the owner's messages: the 👍 of started work and "Noted" of a note, on the message the reply answers, else the
 * owner's last message before it. A line's and a mark's hover text is the reply's words when its bubble was left out, and
 * the chips' own hover text (the model of the work, the job a note is for), so nothing a chip said is lost.
 */
export function chatRows(messages: readonly BotChatMessage[], botName: string, answerTip?: (message: BotChatMessage) => string | undefined): { rows: BotChatRow[]; marks: Map<string, OwnerMarks> } {
  const rows: BotChatRow[] = []
  const marks = new Map<string, OwnerMarks>()
  let lastOwner: string | undefined
  for (const message of messages) {
    if (message.author === 'owner') lastOwner = message.id
    // A tapped answer is the bot's own label, so it reads as a quiet line, as an answered ask does.
    if (message.author === 'owner' && message.answers?.tapped) {
      const question = message.replyTo && !message.replyTo.gone ? message.replyTo.text : ''
      rows.push({ kind: 'system', id: `${message.id}:answered`, at: message.at, text: tappedAnswerLine(message.text), of: message.id, ...(question ? { title: question } : {}) })
      continue
    }
    const signals = workSignalsOf(message)
    if (signals) {
      const target = message.replyTo?.author === 'owner' ? message.replyTo.id : lastOwner
      const words = message.text.trim()
      const tip = [...(signals.only && words ? [words] : []), ...signals.details].join('\n')
      if (target) {
        const mark = { ...marks.get(target) }
        if (signals.titles.length) mark.reaction = '👍'
        if (signals.noted) mark.passedOn = true
        if (tip) mark.title = tip
        marks.set(target, mark)
      }
      if (signals.titles.length) rows.push({ kind: 'system', id: `${message.id}:started`, at: message.at, text: startedLine(botName, signals.titles, signals.queued), ...(tip ? { title: tip } : {}) })
      if (signals.only) continue
    }
    rows.push({ kind: 'message', message })
    const answered = message.ask ? askAnsweredLine(botName, message.ask) : undefined
    if (answered) {
      const tip = answerTip?.(message)
      rows.push({ kind: 'system', id: `${message.id}:answered`, at: message.at, text: answered, ...(tip ? { title: tip } : {}) })
    }
  }
  return { rows, marks }
}

/** What the header says under the bot's name, and how it reads. `lead`: the work the line names, whose activity the sticker shows. */
export type BotPresence = { kind: 'typing' | 'busy' | 'free' | 'offline' | 'paused'; text: string; lead?: BotWorkItem }

/** The work the header names: the one running longest, else the first that waits. */
export function leadWork(work: readonly BotWorkItem[]): BotWorkItem | undefined {
  const running = work.filter((item) => item.status !== 'queued')
  const pool = running.length ? running : work
  return [...pool].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]
}

/**
 * The bot's presence under its name: "typing…" while its chat turn writes, "System check +1" while work runs or waits
 * (the work running longest, and how many more; never "+0"), "paused", "waiting for internet", and "free" otherwise.
 * Typing wins over work; the line still opens the work's list.
 */
export function presenceOf(bot: Pick<BotSummary, 'state' | 'work'>, chat: { typing: boolean; offline: boolean }): BotPresence {
  if (bot.state === 'paused') return { kind: 'paused', text: 'paused' }
  if (chat.offline) return { kind: 'offline', text: 'waiting for internet' }
  if (chat.typing) return { kind: 'typing', text: 'typing…' }
  const work = bot.work ?? []
  const lead = leadWork(work)
  if (!lead) return { kind: 'free', text: 'free' }
  return { kind: 'busy', text: work.length > 1 ? `${lead.title} +${work.length - 1}` : lead.title, lead }
}

/** What the sticker on the header's face shows. */
export type BotStickerKind = 'typing' | 'browser' | 'web' | 'search' | 'command' | 'file' | 'schedule' | 'memory' | 'working' | 'paused'

/**
 * The sticker for what the bot does now: a pen while it types, the lead work's live activity (its chip) while it
 * works, a pause when paused; none when it is free or waits for the internet. Work whose activity is unknown (no chip
 * yet, or a kind with no picture of its own) shows "working".
 */
export function stickerOf(presence: BotPresence, chip: BotChip | undefined): BotStickerKind | undefined {
  if (presence.kind === 'typing') return 'typing'
  if (presence.kind === 'paused') return 'paused'
  if (presence.kind !== 'busy') return undefined
  if (!chip || presence.lead?.status !== 'running') return 'working'
  if (/browser/.test(chip.text)) return 'browser'
  if (/command/.test(chip.text)) return 'command'
  if (chip.icon === 'search') return 'search'
  if (chip.icon === 'web') return 'web'
  if (chip.icon === 'read' || chip.icon === 'edit') return 'file'
  if (chip.icon === 'schedule') return 'schedule'
  if (chip.icon === 'memory') return 'memory'
  return 'working'
}

/** A hast node, as Markdown components receive it (`node`). */
interface HastNode { type: string; tagName?: string; value?: string; children?: HastNode[] }

const textOf = (node: HastNode): string => node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join('')
const blank = (node: HastNode) => node.type === 'text' && !node.value?.trim()

/**
 * A list whose every item starts with a bold key ("**CPU:** AMD Ryzen 9", "**RAM**: 19.7 GB free"): it reads as a small
 * card of keys and values. At least two items, keys of at most 32 characters.
 */
export function isKeyValueList(node: HastNode | undefined): boolean {
  const items = (node?.children ?? []).filter((child) => !blank(child))
  if (items.length < 2) return false
  return items.every((item) => {
    if (item.type !== 'element' || item.tagName !== 'li') return false
    const parts = (item.children ?? []).filter((child) => !blank(child))
    const [key, after] = parts
    if (key?.type !== 'element' || key.tagName !== 'strong' || parts.some((part) => part.type === 'element' && ['ul', 'ol', 'p'].includes(part.tagName ?? ''))) return false
    const name = textOf(key).trim()
    return name.length > 0 && name.length <= 33 && (name.endsWith(':') || (after?.type === 'text' && /^\s*:/.test(after.value ?? '')))
  })
}
