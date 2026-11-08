import type { BrowserAgentCursor } from '../../browser/agentCursor'
import type { BrowserHumanInput } from '../../browser/types'

/**
 * A bot's own browser as its owner sees it (the live preview in its replies and the split view).
 * Each bot has one browser, apart from the owner's tabs and every thread's: its own Chromium
 * profile, so sites the owner signs in to there stay signed in for that bot only. No payload names
 * a session, a model or a path. Browser-safe.
 */

/** A picture of the bot's tab: a JPEG in base64, and the page's size in CSS pixels it shows whole. */
export interface BotBrowserFrame {
  data: string
  mimeType: 'image/jpeg'
  width: number
  height: number
  viewport: { width: number; height: number }
  /** When it was taken (ms since the epoch). */
  at: number
}

export interface BotBrowserView {
  /** Whether the bot's browser is open now. A closed one keeps its last picture. */
  open: boolean
  /** Who uses it: the bot, or the owner after Take over. */
  control: 'bot' | 'owner'
  /** The tab the view follows: the one the bot (or the owner) used last. */
  tab?: { url: string; title: string }
  /** The activations that used the browser, oldest first: their replies show its preview. */
  activations: string[]
  /** The activation using it now, while it runs. */
  activationId?: string
  /** The latest picture, when asked for (`frame: true`), or the last one once it closed. */
  frame?: BotBrowserFrame
  /** Where the bot acted last, while it is recent: drawn over the picture, never in the page. */
  cursor?: BrowserAgentCursor
}

/** A person's input in the split view, at the page's CSS pixels. */
export type BotBrowserInput = BrowserHumanInput

/** The bot-browser methods (`bots.browser.*`), apart from the required Bot UI set: an older daemon lacks them. */
export const BOTS_BROWSER_METHODS = ['bots.browser.get', 'bots.browser.control', 'bots.browser.input', 'bots.browser.open', 'bots.browser.close'] as const
export type BotsBrowserMethod = (typeof BOTS_BROWSER_METHODS)[number]

export interface BotsBrowserApi {
  'bots.browser.get': { params: { botId: string; frame?: boolean }; result: { browser: BotBrowserView } }
  /** `owner`: the bot's actions wait while the owner uses the browser; `bot` gives it back. */
  'bots.browser.control': { params: { botId: string; control: 'owner' | 'bot' }; result: { browser: BotBrowserView } }
  /** Only while the owner has control. */
  'bots.browser.input': { params: { botId: string; input: BotBrowserInput }; result: { browser: BotBrowserView } }
  /** Opens the bot's browser for the owner (to sign in for it), under the owner's control. */
  'bots.browser.open': { params: { botId: string; url?: string }; result: { browser: BotBrowserView } }
  'bots.browser.close': { params: { botId: string }; result: { browser: BotBrowserView } }
}
