import type { AppletReference } from '../../applets'
import type { BotLook } from './look'

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

/** One row of a bot's chat (`bot_messages`). */
export interface BotChatMessage {
  seq: number
  id: string
  at: string
  author: 'owner' | 'bot'
  kind: BotMessageKind
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
}

/**
 * An applet a bot made: the bot's thread it was published in (the app reads and runs it from there, in the same sandbox
 * as a thread's) and its reference.
 */
export interface BotChatApplet {
  threadId: string
  reference: AppletReference
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
  look: BotLook
  state: BotState
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
}

/** One piece of work in the line above the composer: what it is about, and whether it runs, waits or is held. */
export interface BotWorkItem {
  id: string
  title: string
  status: 'running' | 'queued' | 'waiting_for_internet' | 'paused'
  startedAt: string
  /** A scheduled run rather than work the chat started. */
  scheduled?: true
  /**
   * The model the owner asked for this work alone, when it is not the bot's usual one: `name` on the line ("Opus 5.5"),
   * `detail` on hover ("Opus 5.5 on Claude Code, high reasoning, for this work only").
   */
  model?: { name: string; detail: string }
}

/** One thing a bot may use, in About → Can use. `id` is the permission's fingerprint. */
export interface BotPermissionItem {
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
}

/** One of a bot's waiting reminders (one-off, not yet said), in About → Runs. */
export interface BotReminderItem {
  id: string
  dueAt: string
  text: string
  /** It starts work at its time rather than only saying `text`. */
  work?: true
}

/** About this bot. */
export interface BotDetail {
  summary: BotSummary
  permissions: BotPermissionItem[]
  runs: BotRunItem[]
  /** Waiting reminders, soonest first; absent from older services. */
  reminders?: BotReminderItem[]
}
