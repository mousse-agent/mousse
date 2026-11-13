import {
  MAX_WATCHED_BROWSER_FILES,
  MAX_WATCHED_BROWSER_FILES_BYTES,
  MAX_WATCHED_BROWSER_SENT,
  WATCHED_BROWSER_FILES_LIMIT_TEXT,
  WATCHED_BROWSER_HOLD_BEAT_MS,
  WATCHED_BROWSER_HOLD_LEASE_MS,
  WATCHED_BROWSER_PANE,
  WATCHED_BROWSER_RENEW_MS,
  type WatchedBrowserAck,
  type WatchedBrowserChooser,
  type WatchedBrowserDialog,
  type WatchedBrowserFrame,
  type WatchedBrowserHold,
  type WatchedBrowserHoldEnd,
  type WatchedBrowserHolder,
  type WatchedBrowserInput,
  type WatchedBrowserRefusal,
  type WatchedBrowserSent,
  type WatchedBrowserUpdate,
  type WatchedBrowserView
} from '../../browser/watched'

/**
 * A bot's own browser as its owner sees it (the live preview in its replies and the split view).
 * Each bot has one browser, apart from the owner's tabs and every thread's: its own Chromium
 * profile, so sites the owner signs in to there stay signed in for that bot only. No payload names
 * a session, a model or a path. Browser-safe.
 *
 * Watching, holds and input are the general viewer's (`shared/browser/watched.ts`); the names below
 * are the ones the `bots.browser.*` methods have always used.
 */

export type BotBrowserFrame = WatchedBrowserFrame
export type BotBrowserDialog = WatchedBrowserDialog
export type BotBrowserChooser = WatchedBrowserChooser
export type BotBrowserHolder = WatchedBrowserHolder
export type BotBrowserRefusal = WatchedBrowserRefusal
export type BotBrowserAck = WatchedBrowserAck
export type BotBrowserSent = WatchedBrowserSent
export type BotBrowserHold = WatchedBrowserHold
export type BotBrowserHoldEnd = WatchedBrowserHoldEnd
export type BotBrowserInput = WatchedBrowserInput

export interface BotBrowserView extends WatchedBrowserView {
  /** The activations that used the browser, oldest first. */
  activations: string[]
  /** The activation whose tab the view shows: its reply shows the preview. It changes only when that activation ends. */
  activationId?: string
  /** The browser is being set up on this computer (its first use): how far, when known. */
  setup?: { percent?: number }
}

/**
 * What a view that watches a bot's browser is sent (`bots.browser.frame`, on its own connection
 * only, never replayed): a new picture when the page paints, and the rest only when it changes.
 */
export interface BotBrowserFrameEvent extends WatchedBrowserUpdate {
  botId: string
}

/** The connection event a watching view is sent. */
export const BOT_BROWSER_FRAME_EVENT = 'bots.browser.frame'
/** The capability under which `watch` and its pushed pictures are offered. */
export const BOTS_BROWSER_STREAM_CAPABILITY = 'bots.browser.stream.v1'
/** The small preview in a reply: 480 px wide, at most 5 pictures a second. */
export const BOT_BROWSER_PREVIEW_WATCH = { width: 480, fps: 5 } as const
/** The split view: the panel's width up to 960 px, at most 15 a second, 30 while the owner holds the browser. */
export const BOT_BROWSER_PANE_WATCH = WATCHED_BROWSER_PANE
/** How often a view renews its watch (`bots.browser.watch`). */
export const BOT_BROWSER_WATCH_RENEW_MS = WATCHED_BROWSER_RENEW_MS

/** How often a view that holds a bot's browser says it is still there (`bots.browser.hold` `renew`), and how long a hold lasts without. */
export const BOT_BROWSER_HOLD_BEAT_MS = WATCHED_BROWSER_HOLD_BEAT_MS
export const BOT_BROWSER_HOLD_LEASE_MS = WATCHED_BROWSER_HOLD_LEASE_MS
/** The most inputs in one `bots.browser.send`. */
export const MAX_BOT_BROWSER_SENT = MAX_WATCHED_BROWSER_SENT
/** The capability under which `hold` and `send` are offered: a daemon without it takes `control` and `input`. */
export const BOTS_BROWSER_HOLD_CAPABILITY = 'bots.browser.hold.v1'

/**
 * The files the person chose for a page's file picker, from this computer's own file dialog: the app's
 * main process opens the dialog and alone calls this (it is not one of the renderer's methods), on
 * the window's own connection. The daemon checks the hold and the open picker, and the files (at most
 * `MAX_BOT_BROWSER_FILES`, `MAX_BOT_BROWSER_FILES_BYTES` in all, each a file), and answers a one-time
 * token the view sends as its `files` input.
 */
export const BOT_BROWSER_FILES_METHOD = 'bots.browser.files'
export const MAX_BOT_BROWSER_FILES = MAX_WATCHED_BROWSER_FILES
export const MAX_BOT_BROWSER_FILES_BYTES = MAX_WATCHED_BROWSER_FILES_BYTES
/** What the app says when the chosen files are over the limits. */
export const BOT_BROWSER_FILES_LIMIT_TEXT = WATCHED_BROWSER_FILES_LIMIT_TEXT
export interface BotBrowserFilesApi {
  params: { botId: string; viewId: string; holdId: string; paths: string[] }
  result: { token: string; count: number }
}

/** The bot-browser methods (`bots.browser.*`), apart from the required Bot UI set: an older daemon lacks them. */
export const BOTS_BROWSER_METHODS = ['bots.browser.get', 'bots.browser.control', 'bots.browser.input', 'bots.browser.open', 'bots.browser.close', 'bots.browser.watch', 'bots.browser.unwatch', 'bots.browser.hold', 'bots.browser.send'] as const
export type BotsBrowserMethod = (typeof BOTS_BROWSER_METHODS)[number]

/** What a view asks of its hold: take it (`force`: from another view), say it is still there, or give it back. */
export type BotBrowserHoldRequest =
  | { op: 'take'; force?: boolean; platform?: 'mac' | 'other' }
  | { op: 'renew'; holdId: string }
  | { op: 'release'; holdId: string }

export interface BotsBrowserApi {
  /** The browser's state; `frame: true` adds a fresh picture (kept for views that do not watch). `viewId`: who holds it, as this view sees it. */
  'bots.browser.get': { params: { botId: string; frame?: boolean; viewId?: string }; result: { browser: BotBrowserView } }
  /**
   * Starts (or renews, or resizes) this connection's watch of a bot's browser: pictures are then
   * pushed as `bots.browser.frame` while the page paints, at most `fps` a second and `width` wide
   * (both capped). Renew it every `BOT_BROWSER_WATCH_RENEW_MS`; it ends with `unwatch`, the
   * connection, or a missed renewal. Answers the state and the last picture.
   */
  'bots.browser.watch': { params: { botId: string; watchId: string; width: number; fps: number; viewId?: string }; result: { browser: BotBrowserView } }
  'bots.browser.unwatch': { params: { botId: string; watchId: string }; result: { ok: true } }
  /**
   * A view's hold of the browser (`viewId`: the view's own id, kept across its reloads). `take` hands
   * the browser to that view: the bot's actions wait (a view that holds it already picks its hold up
   * again, at the host's last input number; another view's hold is refused as `held_elsewhere` unless
   * `force`). `renew` keeps it (every `BOT_BROWSER_HOLD_BEAT_MS`; an ended hold is refused as
   * `hold_ended`). `release` gives it back.
   */
  'bots.browser.hold': { params: { botId: string; viewId: string; request: BotBrowserHoldRequest }; result: { browser: BotBrowserView; hold?: BotBrowserHold } }
  /**
   * Numbered inputs of a hold, in order: each is applied once, in number order, and answered (applied,
   * a duplicate, or refused with a reason). Several may be on their way at once.
   */
  'bots.browser.send': { params: { botId: string; viewId: string; holdId: string; inputs: BotBrowserSent[] }; result: { acks: BotBrowserAck[]; lastSeq: number } }
  /** An older app's Take over (`owner`) and Give back (`bot`): a hold of its window's own. */
  'bots.browser.control': { params: { botId: string; control: 'owner' | 'bot' }; result: { browser: BotBrowserView } }
  /** An older app's input, while it holds the browser (`control`). */
  'bots.browser.input': { params: { botId: string; input: BotBrowserInput }; result: { browser: BotBrowserView } }
  /** Opens the bot's browser for the owner (to sign in for it), under the owner's control: a hold of `viewId`'s. */
  'bots.browser.open': { params: { botId: string; url?: string; viewId?: string; platform?: 'mac' | 'other' }; result: { browser: BotBrowserView; hold?: BotBrowserHold } }
  'bots.browser.close': { params: { botId: string }; result: { browser: BotBrowserView } }
}
