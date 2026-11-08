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
  action?: { kind: 'sign_in' | 'open_providers' | 'resume' | 'retry'; label: string; instanceId?: string }
}

export type BotChipIcon = 'search' | 'web' | 'read' | 'edit' | 'schedule' | 'memory' | 'ask' | 'think' | 'name' | 'warning'

/** One activity chip (C3), made by Mousse, never by the model. `live` while the call is under way. */
export interface BotChip {
  icon: BotChipIcon
  text: string
  /** The short highlighted part: a domain, a folder name, a schedule label. */
  highlight?: string
  live?: boolean
}

export type BotAskStatus = 'open' | 'allowed' | 'not_now' | 'withdrawn'

/** An ask on a bot message (C4): "<name> wants to <title>", the note, then Not now / Allow. */
export interface BotAskCard {
  askId: string
  /** "read files in ~/Documents/Invoices". */
  title: string
  /** One line on the limit: "Only this folder. It can't change anything." */
  note: string
  status: BotAskStatus
  /** `export_memory`: Allow opens a folder picker and calls `bots.memory.export`; it grants nothing. */
  kind?: 'permission' | 'export_memory'
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
  attachments?: Array<{ name: string; path: string }>
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
}

/** One thing a bot may use, in About → Can use. `id` is the permission's fingerprint. */
export interface BotPermissionItem {
  id: string
  title: string
  note: string
  grantedAt: string
}

/** One of a bot's runs, in About → Runs. */
export interface BotRunItem {
  id: string
  /** "every weekday · 09:00". */
  label: string
  nextAt?: string
  kind: 'schedule'
}

/** About this bot. */
export interface BotDetail {
  summary: BotSummary
  permissions: BotPermissionItem[]
  runs: BotRunItem[]
}
