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
  /** The browser is being set up on this computer (its first use): how far, when known. */
  setup?: { percent?: number }
  /** The followed tab is not the one in front, so Chromium does not paint it: its picture is a still. */
  behind?: boolean
  /**
   * Pictures cannot reach a view now, and why (the followed tab closed, the browser does not answer):
   * a view says it is not updating until they can. Absent while they can.
   */
  stalled?: string
  /** It is not open because its process ended by itself (a crash, the system): the next use starts it again. */
  stopped?: true
}

/** A person's input in the split view, at the page's CSS pixels. */
export type BotBrowserInput = BrowserHumanInput

/**
 * What a view that watches a bot's browser is sent (`bots.browser.frame`, on its own connection
 * only, never replayed): a new picture when the page paints, and the rest only when it changes.
 */
export interface BotBrowserFrameEvent {
  botId: string
  watchId: string
  /** A new picture (`sharp`: taken at full quality once the page was still). */
  frame?: { data: string; mimeType: 'image/jpeg'; width: number; height: number; at: number; sharp?: boolean }
  /** The page's size in CSS pixels, when it changed (and with the first picture). */
  viewport?: { width: number; height: number }
  tab?: { url: string; title: string }
  /** Where the bot acts; null clears it. */
  cursor?: BrowserAgentCursor | null
  /** The followed tab went behind (true) or came to the front (false). */
  behind?: boolean
  /** Pictures stopped (the browser closed, or could not be reached): the view says it is not updating. */
  stalled?: string
  /** Pictures flow again after `stalled`. */
  live?: true
}

/** The connection event a watching view is sent. */
export const BOT_BROWSER_FRAME_EVENT = 'bots.browser.frame'
/** The capability under which `watch` and its pushed pictures are offered. */
export const BOTS_BROWSER_STREAM_CAPABILITY = 'bots.browser.stream.v1'
/** The small preview in a reply: 480 px wide, at most 5 pictures a second. */
export const BOT_BROWSER_PREVIEW_WATCH = { width: 480, fps: 5 } as const
/** The split view: the panel's width up to 960 px, at most 15 a second, 30 while the owner holds the browser. */
export const BOT_BROWSER_PANE_WATCH = { maxWidth: 960, fps: 15, heldFps: 30 } as const
/**
 * How often a view renews its watch; the daemon drops one not renewed for three times this. A
 * renewal answers whether pictures can reach the view now, and no picture once it has had one.
 */
export const BOT_BROWSER_WATCH_RENEW_MS = 5_000

/** The bot-browser methods (`bots.browser.*`), apart from the required Bot UI set: an older daemon lacks them. */
export const BOTS_BROWSER_METHODS = ['bots.browser.get', 'bots.browser.control', 'bots.browser.input', 'bots.browser.open', 'bots.browser.close', 'bots.browser.watch', 'bots.browser.unwatch'] as const
export type BotsBrowserMethod = (typeof BOTS_BROWSER_METHODS)[number]

export interface BotsBrowserApi {
  /** The browser's state; `frame: true` adds a fresh picture (kept for views that do not watch). */
  'bots.browser.get': { params: { botId: string; frame?: boolean }; result: { browser: BotBrowserView } }
  /**
   * Starts (or renews, or resizes) this connection's watch of a bot's browser: pictures are then
   * pushed as `bots.browser.frame` while the page paints, at most `fps` a second and `width` wide
   * (both capped). Renew it every `BOT_BROWSER_WATCH_RENEW_MS`; it ends with `unwatch`, the
   * connection, or a missed renewal. Answers the state and the last picture.
   */
  'bots.browser.watch': { params: { botId: string; watchId: string; width: number; fps: number }; result: { browser: BotBrowserView } }
  'bots.browser.unwatch': { params: { botId: string; watchId: string }; result: { ok: true } }
  /** `owner`: the bot's actions wait while the owner uses the browser; `bot` gives it back. */
  'bots.browser.control': { params: { botId: string; control: 'owner' | 'bot' }; result: { browser: BotBrowserView } }
  /** Only while the owner has control. */
  'bots.browser.input': { params: { botId: string; input: BotBrowserInput }; result: { browser: BotBrowserView } }
  /** Opens the bot's browser for the owner (to sign in for it), under the owner's control. */
  'bots.browser.open': { params: { botId: string; url?: string }; result: { browser: BotBrowserView } }
  'bots.browser.close': { params: { botId: string }; result: { browser: BotBrowserView } }
}
