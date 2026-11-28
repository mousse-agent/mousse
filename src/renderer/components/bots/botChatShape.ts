import { compareLaunched, launchedActive, launchedRecent, launchedGoing, type BotAskCard, type BotChatMessage, type BotChip, type BotLaunchedThread, type BotSummary, type BotWorkItem } from '../../../shared/bots/personal/chat'
import { guardTextCharacters } from '../../../shared/bots/personal/modelSlots'
import { botGroupTime } from './messageGroups'
import { askNoticeText } from '../../../shared/bots/personal/askText'
import { botMessageFrom, type BotMessageFrom } from '../../../shared/bots/personal/botMessages'

/**
 * How a bot's chat reads as a messenger: what the renderer infers from the chat's rows alone (`bot_messages`), with
 * nothing new from the engine. Browser-safe and pure.
 */

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
 * the owner's message), and `only`: the message has nothing but those chips (no words, nothing else on it), so it shows
 * no bubble. A reply with any words always stays a message: a reaction never carries it. `details`: those chips' own
 * hover text (the model of work on a model of its own, the job a note is for), kept on what stands in for them. Null for
 * a message that did neither.
 */
export function workSignalsOf(message: BotChatMessage): { titles: string[]; queued: boolean; noted: boolean; only: boolean; details: string[] } | null {
  if (message.author !== 'bot') return null
  const starts = message.chips.filter(isWorkStart)
  const noted = message.chips.some(isNotePassed)
  if (!starts.length && !noted) return null
  const only = message.kind === 'text' && !message.text.trim() && !message.ask && !message.error && !message.question &&
    !message.attachments?.length && !message.cards?.length && !message.applets?.length &&
    message.chips.every((chip) => isWorkStart(chip) || isNotePassed(chip))
  const details = message.chips.filter((chip) => isWorkStart(chip) || isNotePassed(chip)).flatMap((chip) => (chip.title ? [chip.title] : []))
  return { titles: starts.map(workTitle), queued: starts.length > 0 && starts.every((chip) => chip.text === 'will start'), noted, only, details }
}

/**
 * One row of the transcript: a message, or a quiet centred line between messages. `of`: the message a line stands in
 * for (an answer the owner tapped), so a reply to it, or a quote of it, finds it there.
 */
export type BotChatRow =
  | { kind: 'message'; message: BotChatMessage }
  | { kind: 'system'; id: string; at: string; text: string; title?: string; of?: string; note?: 'info' | 'error'; cut?: true; expiredReviews?: BotChatMessage[]; actionHistory?: BotChatMessage[] }

/** A row of this window only: a `/` command's line, or (`cut`) the words of a reply its turn stopped before finishing. */
export interface BotWindowLine { id: string; at: string; text: string; error?: true; cut?: true; expiredReviews?: BotChatMessage[]; actionHistory?: BotChatMessage[] }

/**
 * `rows` with this window's own lines (`notes`, oldest first: the owner's `/` commands, replies cut off) among them by
 * time: each before the first row that came after it, the newest at the end.
 */
export function withNotes(rows: readonly BotChatRow[], notes: readonly BotWindowLine[]): BotChatRow[] {
  if (!notes.length) return rows as BotChatRow[]
  const merged: BotChatRow[] = []
  let next = 0
  const at = (row: BotChatRow) => Date.parse(row.kind === 'message' ? row.message.at : row.at)
  for (const row of rows) {
    while (next < notes.length && Date.parse(notes[next]!.at) < at(row)) merged.push(noteRow(notes[next++]!))
    merged.push(row)
  }
  while (next < notes.length) merged.push(noteRow(notes[next++]!))
  return merged
}

const noteRow = (note: BotWindowLine): BotChatRow => (note.cut
  ? { kind: 'system', id: note.id, at: note.at, text: note.text, cut: true }
  : { kind: 'system', id: note.id, at: note.at, text: note.text, note: note.error ? 'error' : 'info' })

/**
 * A run of messages the owner's other bots sent this bot, one after another (`botMessageFrom`), which the chat folds
 * behind one quiet line ("Coxy sent 2 messages") so they don't crowd out the owner's own conversation. `id`: its first
 * message's id, which stays as the run grows; `start` and `end`: its rows (`end` exclusive); `senders`: each bot once,
 * in the order they first wrote.
 */
export interface BotExchange { id: string; start: number; end: number; senders: BotMessageFrom[] }

/**
 * The runs of other bots' messages among `rows`. Any other row ends a run (the bot's reply, the owner's message, a
 * quiet line), and so does a new day (`days[i]`: the day line above row i, when it has one), so a day line never hides
 * inside a fold.
 */
export function botExchanges(rows: readonly BotChatRow[], days: ReadonlyArray<{ day?: string } | undefined>): BotExchange[] {
  const runs: BotExchange[] = []
  let run: BotExchange | undefined
  rows.forEach((row, index) => {
    const from = row.kind === 'message' && row.message.author === 'bot' ? botMessageFrom(row.message) : undefined
    if (!from) { run = undefined; return }
    if (run && !days[index]?.day) {
      run.end = index + 1
      if (!run.senders.some((sender) => sameSender(sender, from))) run.senders.push(from)
      return
    }
    run = { id: (row as Extract<BotChatRow, { kind: 'message' }>).message.id, start: index, end: index + 1, senders: [from] }
    runs.push(run)
  })
  return runs
}

/** One bot, by its id when both rows keep it, else by the name each holds. */
const sameSender = (a: BotMessageFrom, b: BotMessageFrom) => (a.botId && b.botId ? a.botId === b.botId : a.name === b.name)

/** The quiet line an answer the owner tapped leaves in place of their bubble: "You answered “Flat B”". */
export function tappedAnswerLine(label: string): string {
  return `You answered “${label}”`
}

/**
 * The work the owner's newest answer set going again (a tap on, or a reply to, the question it asked them), while it
 * runs or waits its turn and has posted nothing in the chat since. Such an answer starts no chat turn, so without this
 * the chat shows nothing until the work's next message; `item` is that work as the bot's summary lists it.
 */
export function resumedWork(messages: readonly BotChatMessage[], work: readonly BotWorkItem[] | undefined): BotWorkItem | undefined {
  if (!work?.length) return undefined
  const spoke = new Set<string>()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (!message.activationId) continue
    if (message.author === 'bot') { spoke.add(message.activationId); continue }
    if (!message.answers) continue
    if (spoke.has(message.activationId)) return undefined
    const item = work.find((entry) => entry.id === message.activationId)
    return item && (item.status === 'running' || item.status === 'queued') ? item : undefined
  }
  return undefined
}

/** The quiet line under that answer: "alpha is back on GitHub App", or "alpha will get back to GitHub App" while it waits its turn. */
export function resumedWorkLine(botName: string, item: Pick<BotWorkItem, 'title' | 'status'>): string {
  return item.status === 'queued' ? `${botName} will get back to ${item.title}` : `${botName} is back on ${item.title}`
}

/**
 * What a bot's handling left on an owner's message: a 👍 for work it started, "Noted" for a note; `title`: the note's
 * hover text (the job a note is for). The 👍's hover text only says who reacted; the reply's words never move here.
 */
export interface OwnerMarks { reaction?: string; passedOn?: boolean; title?: string }

/** "alpha started System check", "alpha started A and B". */
function startedLine(botName: string, titles: readonly string[], queued: boolean): string {
  const named = titles.length > 2 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles.join(' and ')
  return `${botName} ${queued ? 'will start' : 'started'} ${named}`
}

/**
 * A bot's message that says nothing but its ask ("Plusy wants to run commands.", `askNoticeText`): a second ask of a
 * turn, or a run's. A message with more, or one renamed since, shows as written.
 */
export function askOnlyNotice(message: BotChatMessage, botName: string): boolean {
  return message.author === 'bot' && !!message.ask && message.text === askNoticeText(botName, message.ask.title) &&
    !message.error && !message.question && !message.attachments?.length && !message.cards?.length && !message.applets?.length
}

/** The quiet line an answered ask leaves: "You let alpha use the browser". */
export function askAnsweredLine(botName: string, ask: Pick<BotAskCard, 'title' | 'status'> & Partial<Pick<BotAskCard, 'note'>>): string | undefined {
  if (ask.status === 'allowed') return ask.title.startsWith('let ‘') ? `You let ${botName}’s automation ${ask.title.slice(4)}` : `You let ${botName} ${ask.title}`
  if (ask.status === 'not_now') return `You said not now to ${botName}: ${ask.title}`
  if (ask.status === 'withdrawn') return ask.title.startsWith('let ‘') && ask.note?.includes('Nothing was allowed.') ? ask.note : `${botName} no longer needs to ${ask.title}`
  return undefined
}

/**
 * The transcript's rows: each message, with the work a reply started as its own quiet line before it (the reply's
 * bubble left out only when it has no words), each answered ask followed by its line, and each answer the owner tapped
 * to a question as a quiet line where their bubble would be (its hover text the question). `marks` holds what replies
 * left on the owner's messages: the 👍 of started work and "Noted" of a note, on the message the reply answers, else the
 * owner's last message before it. A line's and a mark's hover text is the chips' own hover text (the model of the work,
 * the job a note is for), so nothing a chip said is lost; a reply's words always show in its own bubble.
 */
export function chatRows(messages: readonly BotChatMessage[], botName: string, answerTip?: (message: BotChatMessage) => string | undefined): { rows: BotChatRow[]; marks: Map<string, OwnerMarks> } {
  const rows: BotChatRow[] = []
  const marks = new Map<string, OwnerMarks>()
  let lastOwner: string | undefined
  let expired: { schedule: string; count: number; row: Extract<BotChatRow, { kind: 'system' }> } | undefined
  const latestAction = new Map<string, BotChatMessage>()
  for (const message of messages) if (message.action) {
    const first = latestAction.get(message.action.actionId)
    latestAction.set(message.action.actionId, { ...message, action: { ...message.action, askedAt: message.action.askedAt ?? first?.action?.askedAt ?? first?.at ?? message.at } })
  }
  const foldedActions = new Set(messages.filter(message => message.expiredActionSchedule && message.action).map(message => message.action!.actionId))
  const nudgeOf = (message: BotChatMessage) => Boolean(message.action && /^bm_action_.*_n[12]$/.test(message.id))
  const earlierLine = (message: BotChatMessage): Extract<BotChatRow, { kind: 'system' }> => ({
    kind: 'system', id: message.id, at: message.at, of: message.id,
    text: `${guardTextCharacters(message.action!.title).replace(/\s+/g, ' ')} · ${nudgeOf(message) ? 'Reminded' : 'Asked'} ${botGroupTime(message.at)}`
  })
  for (const message of messages) {
    const nudge = nudgeOf(message)
    if (nudge && message.action && foldedActions.has(message.action.actionId)) {
      // The newest review is represented inside its schedule fold. Earlier nudge copies stay quiet here.
      // All history for this call belongs inside its expired review.
      continue
    }
    if (!nudge && message.expiredActionSchedule) {
      if (expired?.schedule === message.expiredActionSchedule) expired.count++
      else {
        const line: Extract<BotChatRow, { kind: 'system' }> = { kind: 'system', id: message.id, at: message.at, text: 'Expired · not sent', of: message.id }
        expired = { schedule: message.expiredActionSchedule, count: 1, row: line }
        rows.push(line)
      }
      if (message.action) {
        const newest = latestAction.get(message.action.actionId) ?? message
        ;(expired.row.expiredReviews ??= []).push({ ...newest, action: { ...message.action, askedAt: message.action.askedAt ?? message.at } })
      }
      const reviews = expired.row.expiredReviews
      const names = reviews?.map(review => guardTextCharacters(review.action!.title).replace(/\s+/g, ' '))
      const name = names?.length === expired.count && names.every(title => title === names[0]) ? `: ${names[0]}` : ''
      expired.row.text = `${expired.count === 1 ? 'Expired' : `${expired.count} expired`} · not sent${name}`
      continue
    }
    if (!nudge) expired = undefined
    if (message.action && latestAction.get(message.action.actionId)?.id !== message.id) {
      rows.push(earlierLine(message))
      continue
    }
    if (message.author === 'owner') lastOwner = message.id
    // A tapped answer is the bot's own label, so it reads as a quiet line, as an answered ask does.
    if (message.author === 'owner' && message.answers?.tapped) {
      const question = message.replyTo && !message.replyTo.gone ? message.replyTo.text : ''
      rows.push({ kind: 'system', id: `${message.id}:answered`, at: message.at, text: tappedAnswerLine(message.text), of: message.id, ...(question ? { title: question } : {}) })
      continue
    }
    if (message.systemLine) {
      rows.push({ kind: 'system', id: message.id, at: message.at, text: message.text, of: message.id, ...(message.systemTitle ? { title: message.systemTitle } : {}) })
      continue
    }
    const signals = workSignalsOf(message)
    if (signals) {
      const target = message.replyTo?.author === 'owner' ? message.replyTo.id : lastOwner
      const tip = signals.details.join('\n')
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
    // A message that is only an ask shows the ask alone, as on a reply; once answered, only the line the answer leaves.
    if (askOnlyNotice(message, botName)) {
      if (message.ask!.status === 'open') {
        rows.push({ kind: 'message', message: { ...message, text: '' } })
        continue
      }
      const answered = askAnsweredLine(botName, message.ask!)
      if (answered) {
        const tip = answerTip?.(message)
        rows.push({ kind: 'system', id: `${message.id}:answered`, at: message.at, text: answered, of: message.id, ...(tip ? { title: tip } : {}) })
        continue
      }
    }
    rows.push({ kind: 'message', message: message.action ? latestAction.get(message.action.actionId)! : message })
    const answered = message.ask ? askAnsweredLine(botName, message.ask) : undefined
    if (answered) {
      const tip = answerTip?.(message)
      rows.push({ kind: 'system', id: `${message.id}:answered`, at: message.at, text: answered, ...(tip ? { title: tip } : {}) })
    }
  }
  return { rows, marks }
}

/**
 * One step as a line of plain words: "Searched the web · vacuum prices", "Started thread: Fix the login page". Mousse
 * writes these from the calls it allowed (shared/bots/personal/chips.ts), never from model text.
 */
export function stepText(chip: BotChip): string {
  const text = chip.text.charAt(0).toUpperCase() + chip.text.slice(1)
  return chip.highlight ? `${text}${chip.thread ? ': ' : ' · '}${chip.highlight}` : text
}

/**
 * The line beside a bot's typing dots: only the bot's own words (`status`, its latest line before a slow step). Mousse
 * adds none of its own ("Reading your message", "Writing a reply", the live step): without the bot's words, the dots
 * show alone (`idle`, an empty line).
 */
export function botDoingLine(now: { status?: string }): { text: string; own?: true; idle?: true } {
  return now.status ? { text: now.status, own: true } : { text: '', idle: true }
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
 * (the work running longest, and how many more, threads it manages included; never "+0"), "Managing Dictation mock-ups"
 * or "Managing 2 threads" while only threads it started still work, "paused", "waiting for internet", and "free"
 * otherwise. Threads that ended, sit idle or are on hold for the owner are listed but never make it busy. Typing wins
 * over work; the line still opens the list.
 */
export function presenceOf(bot: Pick<BotSummary, 'state' | 'work' | 'threads' | 'watchers'>, chat: { typing: boolean; offline: boolean }): BotPresence {
  if (bot.state === 'paused') return { kind: 'paused', text: 'paused' }
  if (chat.offline) return { kind: 'offline', text: 'waiting for internet' }
  if (chat.typing) return { kind: 'typing', text: 'typing…' }
  const work = bot.work ?? []
  const threads = botActiveThreads(bot)
  const watchers = bot.watchers ?? []
  const lead = leadWork(work)
  if (lead) {
    const more = work.length - 1 + threads.length + watchers.length
    return { kind: 'busy', text: more > 0 ? `${lead.title} +${more}` : lead.title, lead }
  }
  const more = watchers.length ? ` +${watchers.length}` : ''
  if (threads.length === 1) return { kind: 'busy', text: `Managing ${threads[0]!.title}${more}` }
  if (threads.length) return { kind: 'busy', text: `Managing ${threads.length} threads${more}` }
  // Only background commands: it is free to talk, and says what it waits on.
  if (watchers.length === 1) return { kind: 'free', text: `Waiting on ${watchers[0]!.title}` }
  if (watchers.length) return { kind: 'free', text: `Waiting on ${watchers.length} things` }
  return { kind: 'free', text: 'free' }
}

/**
 * The threads a bot started that keep it busy now (working, queued, held, waiting on subagents or on the owner's
 * answer), in list order. The one source for "Managing 2 threads" under its name and the threads its hover card lists.
 */
export function botActiveThreads(bot: Pick<BotSummary, 'threads'>): BotLaunchedThread[] {
  return (bot.threads ?? []).filter(launchedActive).sort(compareLaunched)
}

/**
 * The first line of a bot's hover card in the sidebar: how its chat stands ("Free to chat", "Typing…", "Paused",
 * "Waiting for internet", what it needs from the owner), then how many threads it works on, counted from
 * `botActiveThreads` like the line under its name: "Free to chat · working on 2 threads".
 */
export function botCardStatus(bot: Pick<BotSummary, 'state' | 'stateText' | 'needsOwner' | 'waiting' | 'chat' | 'threads'>): string {
  const offline = Boolean(bot.chat?.offline) || bot.waiting === 'internet'
  const chat = bot.state === 'paused' ? 'Paused'
    : bot.needsOwner || bot.state === 'needs_you' || bot.state === 'stuck' ? bot.stateText || 'Needs you'
    : offline ? 'Waiting for internet'
    : bot.chat ? 'Typing…'
    : 'Free to chat'
  const count = botActiveThreads(bot).length
  return count ? `${chat} · working on ${count === 1 ? '1 thread' : `${count} threads`}` : chat
}

/** How a bot's line in the sidebar reads: `working` in purple, `needs` (it waits on its owner) in amber, `idle` in grey. */
export type BotRowTone = 'working' | 'needs' | 'idle'

/**
 * The line under a bot's name in the sidebar's Bots list, in words coloured by `tone`: what waits on the owner ("Wants to
 * use files on this computer"), what it works on (the header's line: "System check +1", "Typing…"), or "Paused",
 * "Waiting for internet", "Waiting on …", and "Idle" when there is nothing at all. `resting` (only for "Idle"): its face
 * sleeps.
 */
export function botRowLine(bot: Pick<BotSummary, 'state' | 'stateText' | 'needsOwner' | 'waiting' | 'chat' | 'work' | 'threads' | 'watchers'>): { tone: BotRowTone; text: string; resting: boolean } {
  const line = (tone: BotRowTone, text: string, resting = false) => ({ tone, text, resting })
  if (bot.state === 'paused') return line('idle', 'Paused')
  if (bot.needsOwner || bot.state === 'needs_you' || bot.state === 'stuck') return line('needs', bot.stateText || 'Needs you')
  const offline = Boolean(bot.chat?.offline) || bot.waiting === 'internet'
  const presence = presenceOf(bot, { typing: Boolean(bot.chat) && !offline, offline })
  if (presence.kind === 'offline') return line('idle', 'Waiting for internet')
  if (presence.kind === 'typing') return line('working', 'Typing…')
  if (presence.kind === 'busy') return line('working', presence.text)
  if (bot.state === 'working') return line('working', bot.stateText || 'Working…')
  if (presence.text !== 'free') return line('idle', presence.text)
  return line('idle', 'Idle', true)
}

/** How a thread the bot started looks in its list: the tint of its row (`working` blue, `waiting` amber, `done` green, `failed` red), and its label. */
export type LaunchedTone = 'working' | 'waiting' | 'idle' | 'done' | 'failed'

/**
 * The tone and the words for where a thread the bot started stands: "working", "waiting on subagents", "waiting on you"
 * (a question, or on hold until the owner continues it), "done", "stopped".
 */
export function launchedLook(status: BotLaunchedThread['status']): { tone: LaunchedTone; label: string } {
  if (status === 'needs_input' || status === 'on_hold') return { tone: 'waiting', label: 'waiting on you' }
  if (status === 'queued') return { tone: 'working', label: 'queued' }
  if (status === 'paused') return { tone: 'working', label: 'held' }
  if (status === 'subagents') return { tone: 'working', label: 'waiting on subagents' }
  if (status === 'idle') return { tone: 'idle', label: 'idle' }
  if (status === 'done') return { tone: 'done', label: 'done' }
  if (status === 'failed') return { tone: 'failed', label: 'failed' }
  if (status === 'stopped') return { tone: 'failed', label: 'stopped' }
  return { tone: 'working', label: 'working' }
}

/**
 * The threads the bot started, split for its list: those still going (working first, then waiting on the owner, on hold
 * too), and the rest under "Recent" (idle, then ended, the most recently updated first), in the summary's order (`compareLaunched`).
 * "Recent" keeps only those updated in the six hours before `now` (`launchedRecent`): one drops off by itself while the list is open.
 */
export function launchedGroups(threads: readonly BotLaunchedThread[], now: number): { going: BotLaunchedThread[]; ended: BotLaunchedThread[] } {
  const ordered = [...threads].sort(compareLaunched)
  return { going: ordered.filter(launchedGoing), ended: ordered.filter((thread) => !launchedGoing(thread) && launchedRecent(thread, now)) }
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
