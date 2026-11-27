import type { AppletReference } from '../../applets'
import type { BotLook } from './look'
import type { BotChatQuestion } from './questions'
import type { BotChatCard } from './cards'
import type { BotDeviceAccessMode } from './deviceAccess'

export type { BotChatQuestion } from './questions'
export type { BotChatCard } from './cards'

/**
 * What the Bot UI sees of a bot (Bot Phase 1 §5.1.1, bot-ui C2–C8): its state, its chat as rows of
 * `bot_messages`, chips and ask cards. No payload here carries a model or an instance id; the only
 * exception is `BotError.action.instanceId`, which opens a provider's Sign in. Browser-safe.
 */

/** The states the UI shows. "Done" is not one: the renderer plays it on working → idle with `lastOutcome: 'ok'`. */
export type BotState = 'idle' | 'working' | 'needs_you' | 'stuck' | 'paused'

/** An error in plain words with one way out. Never names a model; it may name the provider family. */
export interface BotError {
  /** "Gmail sign-in expired" / "Paused until 14:00 (your Claude usage limit)". */
  text: string
  /** `pick_model` opens About → Runs on (#673: a picked model that can't run). */
  action?: { kind: 'sign_in' | 'open_providers' | 'resume' | 'retry' | 'pick_model'; label: string; instanceId?: string }
}

export type BotChipIcon = 'search' | 'web' | 'read' | 'edit' | 'schedule' | 'memory' | 'ask' | 'think' | 'name' | 'warning'

/** One activity chip (C3), made by Mousse, never by the model. `live` while the call is under way. */
export interface BotChip {
  icon: BotChipIcon
  text: string
  /** The short highlighted part: a domain, a folder name, a schedule label. */
  highlight?: string
  live?: boolean
  /** A thread the call started, messaged or stopped ("use your threads"): the chip offers Open, which shows it. */
  thread?: string
  /** The first line of what the bot sent to that thread, shown on the chip's hover. */
  said?: string
  /** Details on hover: the model, entry and reasoning level of work on a model of its own, or the job a note was for. */
  title?: string
}

export type BotAskStatus = 'open' | 'allowed' | 'not_now' | 'withdrawn'

/** An ask on a bot message (C4): "<name> wants to <title>", the note, then Not now / Allow. */
export interface BotAskCard {
  askId: string
  /** "read files in ~/Documents/Invoices". */
  title: string
  /** One line on the limit: "Only this folder. It can't change anything." */
  note: string
  /** What Allow gives, in full, as the note's tooltip; absent when the note says it all (and from older services). */
  tip?: string
  status: BotAskStatus
  /** `export_memory`: Allow opens a folder picker and calls `bots.memory.export`; it grants nothing. */
  kind?: 'permission' | 'export_memory'
  /**
   * Allow carries work on now, not only from the next run: the work that asked is still running or waits to go on (it
   * continues with the permission), or, for a limit, work that waits on it goes on.
   */
  carriesOn?: true
  /** How many pieces of work an allowed limit carried on, when more than one. */
  carried?: number
  /** A run's ask allowed while none of the bot's runs was running or waiting: the bot has it from its next run. */
  idle?: true
  /**
   * What Allow grants, by name, for an expandable line under the note: an MCP ask's tools ("13 tools": their names), and
   * `more`, what a bot can't use of the server ("2 more of GitHub's tools can't be used by a bot."). Absent from other
   * asks and from older services.
   */
  details?: { summary: string; items: string[]; more?: string }
  /** An MCP ask whose server has not listed its tools yet: Allow is off until they are filled in (Not now works). */
  loading?: true
}

export type BotMessageKind = 'text' | 'run_report' | 'notice' | 'error'

export type BotSnoozeChoice = '10m' | '1h' | 'tomorrow'

/** Mousse's review of a held call, from its stored masked copy. */
export interface BotActionCard {
  actionId: string
  askedAt?: string
  digest: string
  title: string
  serverName: string
  args: unknown
  hasHiddenValues: boolean
  hiddenPaths: string[][]
  status: 'open' | 'approved' | 'running' | 'done' | 'failed' | 'uncertain' | 'declined' | 'expired' | 'withdrawn'
  at?: string
  result?: { text?: string; toolReportedError?: boolean; notSentInTime?: boolean }
  previous?: { status: 'done' | 'uncertain' | 'failed'; at: string }
  tooLarge?: boolean
  /** The stored review was erased by the owner; only its outcome remains. */
  forgotten?: true
}

/** One row of a bot's chat (`bot_messages`). */
export interface BotChatMessage {
  action?: BotActionCard
  /** Only an expired held call of a schedule; adjacent ones fold in chat, rows remain stored. */
  expiredActionSchedule?: string
  /** Sent action instant; formatted in the client clock. */
  actionSentAt?: string
  /** Only delivered text reminders carry snooze replies; older services omit it. */
  reminder?: { expiresAt?: string; snoozedUntil?: string }
  seq: number
  id: string
  at: string
  author: 'owner' | 'bot'
  kind: BotMessageKind
  /** A quiet service line; older apps show its notice as a message. */
  systemLine?: true
  /** A service line's details, shown on hover. */
  systemTitle?: string
  /** Markdown. */
  text: string
  chips: BotChip[]
  ask?: BotAskCard
  error?: BotError
  activationId?: string
  /** Files: the owner's attachments, and pictures a tool handed the bot (kept in its files folder). */
  /** `previewUrl`: the composer's picture of an image still being sent (this window only; never stored or sent). */
  attachments?: Array<{ name: string; path: string; previewUrl?: string }>
  /** Applets the reply shows under its words, as a thread's reply does (`publish_applet`). Absent from older services. */
  applets?: BotChatApplet[]
  /** The message this one answers, as a short quote: a bot's reply to the owner's message, or the owner's reply to the bot's. */
  replyTo?: BotChatQuote
  /** The owner's message: the request id it was sent with, which matches it to the bubble shown while it was on its way. */
  clientRequestId?: string
  /** A bot's message: the owner's reaction on it, an emoji (`bots.chat.react`). */
  reaction?: string
  /**
   * A bot's question to tap an answer to (`question_ask`, `bots.questions.answer`); on the owner's message that answered
   * one, its id alone. Absent from older services.
   */
  question?: BotChatQuestion
  /** The owner's message answered a question (by a tap or in their own words): which one. */
  answers?: { questionId: string; tapped: boolean }
  /**
   * Small cards the bot attached (`show_card`, or a question's card), drawn under its words from the app's own
   * components. Absent from older services.
   */
  cards?: BotChatCard[]
  /**
   * Where `text`'s plain copy of the message's cards and its question's answers starts ("Flat A · Flat B"), for an app
   * that doesn't draw them: an app that does shows `text` up to here, then the cards and the buttons. Absent when the
   * text has none.
   */
  plainFrom?: number
}

/**
 * An applet a bot made: the bot's thread it was published in (the app reads and runs it from there, in the same sandbox
 * as a thread's) and its reference.
 */
export interface BotChatApplet {
  threadId: string
  reference: AppletReference
}

/**
 * A quoted message's line with its applets named first ("Applet: Title · its first line"), so a reply to a message
 * that is mostly an applet says which one, in the app and to the bot. `line` alone when it has none.
 */
export function withAppletNames(line: string, applets: readonly Pick<BotChatApplet, 'reference'>[] | undefined): string {
  const titles = (applets ?? []).map((applet) => applet.reference.title.trim()).filter(Boolean)
  if (!titles.length) return line
  const names = `${titles.length === 1 ? 'Applet' : 'Applets'}: ${titles.join(', ')}`
  return line ? `${names} · ${line}` : names
}

/** A quoted message: its id (to scroll to it), who wrote it and its first line. `gone` when it was removed. */
export interface BotChatQuote {
  id: string
  author: 'owner' | 'bot'
  text: string
  gone?: boolean
}

/** One bot as the Bots section and Recent list it. */
export interface BotSummary {
  id: string
  name: string
  description: string
  /** The owner edited the description (its prompt) in About: Reset to default can put the earlier one back. */
  promptEdited?: true
  look: BotLook
  state: BotState
  /** A shown open ask or question needs an answer; absent while paused, independent of errors. */
  needsOwner?: true
  /** The Recent line: "Working…", "Waiting for internet", "Wants to read files in …", "Paused". */
  stateText: string
  /** Set while the bot works but waits for the internet (its state is `working`). */
  waiting?: 'internet'
  error?: BotError
  last?: { text: string; at: string; author: 'owner' | 'bot' }
  /** The bot's latest reply with text, as one clipped line (`replyPreviewText`), for its row in the Bots list. */
  lastReply?: string
  /** How the last activation ended. */
  lastOutcome?: 'ok' | 'failed' | 'stopped'
  unread: number
  createdAt: string
  /**
   * The thread of its chat: a thread the bot started names it as its launcher (`Thread.createdByThreadId`), which is
   * how the app shows "Started by <name>". Absent from older services.
   */
  homeThreadId?: string
  /** Messages to other bots or wakes past the limit between bots, waiting for the owner's Continue or Stop (issue #1443). */
  chainHold?: BotChainHoldView
  /** The chat turn that runs now (its status line and Stop); absent while the chat is free. `offline`: it waits for the internet. */
  chat?: { activationId: string; offline?: true }
  /** Work that runs or waits beside the chat (docs/plans/bot-always-free.md), oldest first. */
  work?: BotWorkItem[]
  /**
   * The owner's threads the bot started ("use your threads"), hidden ones too: those that work (oldest first), then those
   * that wait on the owner (a question, or on hold), then the most recent of those that sit idle or ended in the last six
   * hours and are not archived (`launchedRecent`, at most `BOT_LAUNCHED_ENDED_SHOWN`).
   * The bot is busy while any is active (`launchedActive`); one on hold never makes it busy. Absent from older services and while it started none.
   */
  threads?: BotLaunchedThread[]
  /** Background commands it runs now (`watch_start`), oldest first: the chat's Background work, each with Stop. Absent from older services and while none runs. */
  watchers?: BotWatcherItem[]
  /**
   * Its checklist (`task_create`, `task_update`): the tasks of its chat's thread, then of the threads its work runs in now,
   * oldest first and at most `BOT_TASKS_SHOWN`. Absent from older services and while it keeps none.
   */
  tasks?: BotTaskItem[]
  /**
   * Which devices reach it (About's Devices), on its own computer's window only: anything but `all` shows a lock in the
   * Bots list. Absent from older services and from what other devices get.
   */
  reach?: BotDeviceAccessMode
}

/** How many of a bot's tasks its summary carries. */
export const BOT_TASKS_SHOWN = 50

/** One line of a bot's checklist: its words, how far it is, and the bot's last short note on it. */
export interface BotTaskItem {
  id: string
  text: string
  status: import('../../types').TaskStatus
  /** The bot's latest short progress or failure note. */
  note?: string
}

/** A background command a bot runs now: its title, the command, when it started and when its time limit ends. */
export interface BotWatcherItem {
  id: string
  title: string
  command: string
  startedAt: string
  until: string
  /** Its last line of output, cut. */
  lastLine?: string
}

/** How many of the threads a bot started that ended or sit idle its summary carries, the most recently updated. */
export const BOT_LAUNCHED_ENDED_SHOWN = 30

/** How long a thread the bot started stays under "Recent" after it was last updated: six hours. "See all" lists the rest. */
export const BOT_LAUNCHED_RECENT_MS = 6 * 60 * 60 * 1000

/** Whether a thread the bot started that no longer goes is still listed under "Recent" at `now`: updated in the last six hours. */
export function launchedRecent(thread: Pick<BotLaunchedThread, 'updatedAt'>, now: number): boolean {
  return Date.parse(thread.updatedAt) >= now - BOT_LAUNCHED_RECENT_MS
}

/**
 * A thread the bot started: its title, its project, and how it stands now: its run works, waits its turn, is held (a
 * usage limit it resumes from by itself), or waits on the owner (a question or approval in it or in one of its subagents); or its own run ended but
 * its subagents still work (`subagents`); or nothing in it moves until the owner continues it (`on_hold`: a pause only
 * Resume now ends, messages a Stop held for Send now, or a queue stopped at a message whose turn could not start); or nothing works and it never ran (`idle`), or its last run finished (`done`), failed (`failed`) or was stopped or cut off (`stopped`). `startedAt`: when its current run
 * started (the thread's creation once none runs); `updatedAt`: when it last changed.
 */
export interface BotLaunchedThread {
  threadId: string
  title: string
  project?: string
  status: 'running' | 'queued' | 'paused' | 'subagents' | 'needs_input' | 'on_hold' | 'idle' | 'done' | 'failed' | 'stopped'
  startedAt: string
  updatedAt: string
  /** Kept out of the owner's sidebar (`Thread.hidden`): this list is where the owner finds it, and shows it again. */
  hidden?: true
}

/**
 * Whether a thread the bot started keeps it busy: a run of it works, waits its turn, is held, waits on its subagents, or
 * waits on the owner's answer. A thread on hold (`on_hold`) does not: nothing in it runs until the owner continues it.
 */
export function launchedActive(thread: Pick<BotLaunchedThread, 'status'>): boolean {
  return thread.status === 'running' || thread.status === 'queued' || thread.status === 'paused' || thread.status === 'subagents' || thread.status === 'needs_input'
}

/** Whether a thread the bot started is listed with what still goes: it keeps the bot busy, or it is on hold for the owner. */
export function launchedGoing(thread: Pick<BotLaunchedThread, 'status'>): boolean {
  return launchedActive(thread) || thread.status === 'on_hold'
}

/** Where a thread the bot started goes in its list: what works, then what waits on the owner, then idle, then ended. */
function launchedRank(status: BotLaunchedThread['status']): number {
  if (status === 'needs_input' || status === 'on_hold') return 1
  if (status === 'idle') return 2
  if (status === 'done' || status === 'failed' || status === 'stopped') return 3
  return 0
}

/**
 * The order of the threads a bot started, in its summary and its list alike: what works, then what waits on the owner
 * (each the longest going first), then idle ones, then ended ones (each the most recently updated first).
 */
export function compareLaunched(a: BotLaunchedThread, b: BotLaunchedThread): number {
  return launchedRank(a.status) - launchedRank(b.status)
    || (launchedGoing(a) ? a.startedAt.localeCompare(b.startedAt) : b.updatedAt.localeCompare(a.updatedAt))
    || a.threadId.localeCompare(b.threadId)
}

/** One piece of work in the line above the composer: what it is about, and whether it runs, waits or is held. */
export interface BotWorkItem {
  id: string
  title: string
  status: 'running' | 'queued' | 'waiting_for_internet' | 'paused'
  /**
   * Why it is held (`paused`): `answer`, it waits for the owner's answer to the question it asked them. Absent from older
   * services, whose apps show it as held.
   */
  wait?: { dueAt: string; event: import('./wakes').BotWakeEvent | null }
  waitsFor?: 'answer'
  /** First line of a held action, supplied by Mousse. */
  detail?: string
  startedAt: string
  /** A scheduled run rather than work the chat started. */
  scheduled?: true
  /**
   * The model the owner asked for this work alone, when it is not the bot's usual one: `name` on the line ("Opus 5.5"),
   * `detail` on hover ("Opus 5.5 on Claude Code, high reasoning, for this work only").
   */
  model?: { name: string; detail: string }
  /**
   * Its subagents that run now, each by its title and its model in plain words with its entry ("Opus 5.5 on Claude
   * Code"), and what it runs without because that entry would hold it less tightly than the work's ("run commands").
   */
  subagents?: Array<{ title: string; model: string; lacks?: string[] }>
}

/** One thing a bot may use, in About → Can use. `id` is the permission's fingerprint. */
export interface BotPermissionItem {
  /** At least one granted tool of this service asks first. */
  asksFirst?: true
  /** Absent on older services, which cannot switch permissions. */
  enabled?: boolean
  /** Devices need Full access to allow this permission. */
  needsFullAccess?: true
  /** Every bot has it by default (MCP and each server, skills, automation tools): it can be switched off, not removed. */
  builtIn?: true
  /** "Allow everything" is on and gives it: it can be switched off, not removed. Absent from older services. */
  fromFullTrust?: true
  /** The id of the row it belongs under (one MCP server under MCP): shown inset below it. */
  under?: string
  id: string
  title: string
  note: string
  grantedAt: string
  /** It names something no longer set up here (an MCP server removed from Mousse): it grants nothing until removed. */
  gone?: true
  /**
   * A short mark beside the title when it gives nothing now ("Gone from Mousse", "Switched off", "MCP is off",
   * "Changed"); the note says why and what can be done. Absent from older services, which send `gone` only.
   */
  mark?: string
}

/** One of a bot's runs, in About → Runs. */
export interface BotRunItem {
  id: string
  /** "every weekday · 09:00". */
  label: string
  nextAt?: string
  kind: 'schedule'
  /** Its automation's job (an automation card finds it by this). Absent from older services. */
  jobId?: string
  /** Paused (from Automations, or a card's Pause). */
  paused?: true
  /** Its automation's name ("Morning PR digest"). Absent from older services. */
  name?: string
  /** What each run does, in the automation's own words, cut to a line or two. Absent from older services. */
  does?: string
  /** When it last ran and how that run ended. Absent before its first run. */
  lastAt?: string
  lastOutcome?: 'ok' | 'failed' | 'stopped'
}

/** One of a bot's waiting reminders (one-off, not yet said), in About → Runs. */
export interface BotReminderItem {
  ownerSet?: boolean | null
  id: string
  dueAt: string
  text: string
  /** It starts work at its time rather than only saying `text`. */
  work?: true
  /**
   * A wake: the bot carries on by itself at its time, or once what this says happens ("when acme/app#12 merges"; empty
   * for a time alone), and `dueAt` is then when it gives up. Absent from older services.
   */
  wake?: string
}

/** About this bot. */
/** What a bot holds for its owner (`BotSummary.chainHold`): its batch, how many steps, and to which bots. */
export interface BotChainHoldView {
  /** The batch an answer names: the oldest held step (`bots.chainHold.answer`). */
  holdId: string
  held: number
  /** The bots its held messages are for, by name. */
  to: string[]
  /** Held wake-ups. */
  wakes: number
}

export interface BotDetail {
  summary: BotSummary
  permissions: BotPermissionItem[]
  /** "Allow everything" is on (`BotManifest.fullTrust`). Absent from older services, which have no such switch. */
  fullTrust?: boolean
  runs: BotRunItem[]
  /** Waiting reminders, soonest first; absent from older services. */
  reminders?: BotReminderItem[]
  /** What its chat turns of the last week cost; absent before one reported usage, and from older services. */
  usage?: BotTurnUsageSummary
  /** Its chat's context and prompt cache, from its latest chat turn that reached the model. Absent before one did. */
  context?: BotContextSummary
}

/**
 * A bot chat's context as its latest turn measured it (`bot_turn_usage`): the tokens its last request carried, of the
 * model's window, how that turn's input split between the prompt cache and fresh tokens, and when the cache was last
 * fed and how long the provider keeps it.
 */
export interface BotContextSummary {
  /** Tokens the last request carried (fresh input, cache reads and cache writes). Absent when the runtime reports none. */
  used?: number
  /** The model's context window. Absent when the provider gives none. */
  window?: number
  /** The model that answered, by id. */
  model?: string
  /** That turn's input over all its requests: read from the cache, written to it, sent fresh. */
  turn: { cacheRead: number; cacheWrite: number; fresh: number }
  /** When its last request went out (ms since epoch). */
  lastRequestAt: number
  /** How long the provider keeps the cache (ms). Absent when it gives no lifetime. */
  cacheTtlMs?: number
}

/**
 * The bot's chat turns of the last week, as the runtimes reported them: how many, the input tokens a turn sent (fresh
 * input, cache reads and cache writes together), its output, and the share of input read from the prompt cache (0-1).
 */
export interface BotTurnUsageSummary {
  turns: number
  inputPerTurn: number
  outputPerTurn: number
  cachedShare: number
}
