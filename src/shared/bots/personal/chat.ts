import type { AppletReference } from '../../applets'
import type { BotLook } from './look'
import type { BotChatQuestion } from './questions'
import type { BotChatCard } from './cards'

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

/** One row of a bot's chat (`bot_messages`). */
/** Mousse's review of a held call, from its stored masked copy. */
export interface BotActionCard {
  actionId: string
  digest: string
  title: string
  serverName: string
  args: unknown
  hasHiddenValues: boolean
  hiddenPaths: string[]
  status: 'open' | 'approved' | 'running' | 'done' | 'failed' | 'uncertain' | 'declined' | 'expired' | 'withdrawn'
  at?: string
  result?: { text: string; toolReportedError?: boolean }
  note?: string
  previous?: { status: 'done' | 'uncertain' | 'failed'; at: string }
  tooLarge?: boolean
}

export interface BotChatMessage {
  action?: BotActionCard
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
  /** Markdown. */
  text: string
  chips: BotChip[]
  ask?: BotAskCard
  error?: BotError
  activationId?: string
  /** Files: the owner's attachments, and pictures a tool handed the bot (kept in its files folder). */
  attachments?: Array<{ name: string; path: string }>
  /** Applets the reply shows under its words, as a thread's reply does (`publish_applet`). Absent from older services. */
  applets?: BotChatApplet[]
  /** The message this one answers, as a short quote: a bot's reply to the owner's message, or the owner's reply to the bot's. */
  replyTo?: BotChatQuote
  /** The owner's message: the request id it was sent with, which matches it to the bubble shown while it was on its way. */
  clientRequestId?: string
  /** A bot's message: the owner's reaction on it, an emoji (`bots.chat.react`). */
  reaction?: string
  /**
   * A bot's question to tap an answer to (`ask_owner`, `bots.questions.answer`); on the owner's message that answered
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
  /** How the last activation ended. */
  lastOutcome?: 'ok' | 'failed' | 'stopped'
  unread: number
  createdAt: string
  /**
   * The thread of its chat: a thread the bot started names it as its launcher (`Thread.createdByThreadId`), which is
   * how the app shows "Started by <name>". Absent from older services.
   */
  homeThreadId?: string
  /** The chat turn that runs now (its status line and Stop); absent while the chat is free. `offline`: it waits for the internet. */
  chat?: { activationId: string; offline?: true }
  /** Work that runs or waits beside the chat (docs/plans/bot-always-free.md), oldest first. */
  work?: BotWorkItem[]
  /**
   * The owner's threads the bot started ("use your threads"), hidden ones too: those that work (oldest first), then those
   * that wait on the owner, then the most recent of those that sit idle or ended (`BOT_LAUNCHED_ENDED_SHOWN`).
   * The bot is busy while any is active (`launchedActive`). Absent from older services and while it started none.
   */
  threads?: BotLaunchedThread[]
  /** Background commands it runs now (`watch_start`), oldest first: the chat's Background work, each with Stop. Absent from older services and while none runs. */
  watchers?: BotWatcherItem[]
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

/**
 * A thread the bot started: its title, its project, and how it stands now: its run works, waits its turn, is held (a
 * usage limit), or waits on the owner (a question or approval in it or in one of its subagents); or its own run ended but
 * its subagents still work (`subagents`); or nothing works and it never ran (`idle`), or its last run finished (`done`), failed (`failed`) or was stopped or cut off (`stopped`). `startedAt`: when its current run
 * started (the thread's creation once none runs); `updatedAt`: when it last changed.
 */
export interface BotLaunchedThread {
  threadId: string
  title: string
  project?: string
  status: 'running' | 'queued' | 'paused' | 'subagents' | 'needs_input' | 'idle' | 'done' | 'failed' | 'stopped'
  startedAt: string
  updatedAt: string
  /** Kept out of the owner's sidebar (`Thread.hidden`): this list is where the owner finds it, and shows it again. */
  hidden?: true
}

/** Whether a thread the bot started keeps it busy: a run of it works, waits its turn, is held, waits on its subagents, or waits on the owner. */
export function launchedActive(thread: Pick<BotLaunchedThread, 'status'>): boolean {
  return thread.status === 'running' || thread.status === 'queued' || thread.status === 'paused' || thread.status === 'subagents' || thread.status === 'needs_input'
}

/** Where a thread the bot started goes in its list: what works, then what waits on the owner, then idle, then ended. */
function launchedRank(status: BotLaunchedThread['status']): number {
  if (status === 'needs_input') return 1
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
    || (launchedActive(a) ? a.startedAt.localeCompare(b.startedAt) : b.updatedAt.localeCompare(a.updatedAt))
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
export interface BotDetail {
  tellingSettings?: import('./tellingSettings').BotTellingPreferences
  telling?: string
  summary: BotSummary
  permissions: BotPermissionItem[]
  runs: BotRunItem[]
  /** Waiting reminders, soonest first; absent from older services. */
  reminders?: BotReminderItem[]
}
