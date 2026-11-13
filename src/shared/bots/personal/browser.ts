import type { BrowserAgentCursor } from '../../browser/agentCursor'
import type { BrowserProblem } from '../../browser/navigation'
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
  /** The picture's number (rising): input made on it names it, so it lands on what the person saw. */
  id?: number
}

/** A page's open alert, confirm, prompt or leave-page question; its words are the page's own. */
export interface BotBrowserDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  defaultPrompt?: string
}

/**
 * Who holds the bot's browser, as one view sees it: the bot, this view (after its Take over), or
 * another view of the owner's (another window).
 */
export type BotBrowserHolder = 'bot' | 'this-view' | 'another-view'

/** Why the host refused an input, for the person in one short line (`BotBrowserAck.text` says it). */
export type BotBrowserRefusal =
  /** The picture it was made on shows another page, another tab, or what has scrolled out of view. */
  | 'page-changed'
  /** The tab the person took over has closed. */
  | 'tab-closed'
  /** This view does not hold the browser (it was given back, ended, or taken in another window). */
  | 'not-held'
  /** An earlier input did not arrive: send it, and this one again. Its number is not used. */
  | 'gap'
  /** The page waits for its dialog to be answered. */
  | 'dialog'
  | 'too-large'
  /** Too much waits at the host now: send it again a little later. Its number is not used. */
  | 'busy'
  | 'failed'
  /** The host was told to skip this number (`BotBrowserSent.skip`): nothing was applied. */
  | 'skipped'
  /** The service never takes this input (too long, malformed): the view drops it, and skips its number. */
  | 'invalid'
  /** It waited too long to be taken (the page did not answer): the view dropped it, and skips its number. */
  | 'dropped'

/** The host's answer to one numbered input of a hold. */
export interface BotBrowserAck {
  seq: number
  /** Applied once now; a duplicate of one taken before (never applied again); or refused. */
  status: 'applied' | 'duplicate' | 'refused'
  reason?: BotBrowserRefusal
  /** The refusal in one short line, and more for its tooltip (Chromium's code for a page that failed). */
  text?: string
  detail?: string
  /** A copy or cut: the page's selected text, for the person's clipboard alone. */
  copied?: string
}

/**
 * One numbered input of a hold (`bots.browser.send`), or a number to skip (`skip`). Every number the
 * view gives out reaches the host as one or the other, so the host's count never waits on a hole: an
 * input the host refused without using its number (`gap`, `busy`) is sent again while the hold lasts,
 * and one the view gives up on (it waited too long, or the service never takes it) is sent as a skip.
 */
export type BotBrowserSent =
  | {
    /** The hold's own count, from 1. */
    seq: number
    /** The picture (`BotBrowserFrame.id`) the person acted on. */
    picture?: number
    input: BotBrowserInput
  }
  | { seq: number; skip: true }

/** A view's hold of the bot's browser, as the host answers it to that view. */
export interface BotBrowserHold {
  id: string
  /** The last input number the host has taken: a view picking the hold up again goes on after it. */
  lastSeq: number
  /** The computer the browser runs on ("Not reaching …"). */
  computer: string
}

/** Why a view's hold ended without its Give back. */
export type BotBrowserHoldEnd = 'expired' | 'taken' | 'closed' | 'tab-closed'

export interface BotBrowserView {
  /** Whether the bot's browser is open now. A closed one keeps its last picture. */
  open: boolean
  /** Who uses it: the bot, or the owner after Take over. */
  control: 'bot' | 'owner'
  /**
   * The tab the view follows: the tab the owner took while they hold the browser, else the current tab of the
   * activation it follows (`activationId`), which another run's calls never change.
   */
  tab?: { url: string; title: string }
  /** The activations that used the browser, oldest first. */
  activations: string[]
  /** The activation whose tab the view shows: its reply shows the preview. It changes only when that activation ends. */
  activationId?: string
  /** The latest picture, when asked for (`frame: true`), or the last one once it closed. */
  frame?: BotBrowserFrame
  /** Where the bot acted last, while it is recent: drawn over the picture, never in the page. */
  cursor?: BrowserAgentCursor
  /** The browser is being set up on this computer (its first use): how far, when known. */
  setup?: { percent?: number }
  /** The followed tab is not the one in front, so Chromium does not paint it: its picture is a still. */
  behind?: boolean
  /** Its page is still loading. */
  loading?: boolean
  /** What its last page ran into (can't reach, blocked) or needs from the owner (a sign-in, a human check). */
  problem?: BrowserProblem
  /**
   * Pictures cannot reach a view now, and why (the followed tab closed, the browser does not answer):
   * a view says it is not updating until they can. Absent while they can.
   */
  stalled?: string
  /** Who holds it, for the view that asked (`viewId`): with `control` `owner`, this view or another. */
  holder?: BotBrowserHolder
  /** This view's hold, when it holds the browser. */
  hold?: BotBrowserHold
  /** The page's open dialog, waiting for an answer. */
  dialog?: BotBrowserDialog
  /** The page asks the person for files (`multiple`: more than one), and the site that asks. */
  chooser?: BotBrowserChooser
  /** It is not open because its process ended by itself (a crash, the system): the next use starts it again. */
  stopped?: true
}

/** A page's request for files, as the view that holds the browser is told it: one or several, and which site asks. */
export interface BotBrowserChooser {
  multiple: boolean
  site?: string
}

/**
 * A person's input in the split view, at the page's CSS pixels. Files go as the one-time token this
 * computer's own file dialog was answered with (`bots.browser.files`), never as paths; none cancels.
 */
export type BotBrowserInput = Exclude<BrowserHumanInput, { kind: 'files' }> | { kind: 'files'; token?: string }

/**
 * What a view that watches a bot's browser is sent (`bots.browser.frame`, on its own connection
 * only, never replayed): a new picture when the page paints, and the rest only when it changes.
 */
export interface BotBrowserFrameEvent {
  botId: string
  watchId: string
  /** A new picture (`sharp`: taken at full quality once the page was still; `id`: its number, for input on it). */
  frame?: { data: string; mimeType: 'image/jpeg'; width: number; height: number; at: number; sharp?: boolean; id?: number }
  /** Who holds the browser now, as this view sees it (sent when it changes). */
  control?: 'bot' | 'owner'
  holder?: BotBrowserHolder
  /** This view's hold ended without its Give back, and why. */
  holdEnded?: BotBrowserHoldEnd
  /** The page's dialog opened; null: it was answered. */
  dialog?: BotBrowserDialog | null
  /** The page asks for files; null: answered. */
  chooser?: BotBrowserChooser | null
  /** The page's size in CSS pixels, when it changed (and with the first picture). */
  viewport?: { width: number; height: number }
  tab?: { url: string; title: string }
  /** Where the bot acts; null clears it. */
  cursor?: BrowserAgentCursor | null
  /** The followed tab went behind (true) or came to the front (false). */
  behind?: boolean
  /** Its page started (true) or finished (false) loading. */
  loading?: boolean
  /** What its page ran into or needs; null clears it. */
  problem?: BrowserProblem | null
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

/**
 * How often a view that holds a bot's browser says it is still there (`bots.browser.hold` `renew`);
 * a hold not renewed for `BOT_BROWSER_HOLD_LEASE_MS` ends, and the browser goes back to the bot.
 */
export const BOT_BROWSER_HOLD_BEAT_MS = 5_000
export const BOT_BROWSER_HOLD_LEASE_MS = 2 * 60_000
/** The most inputs in one `bots.browser.send`. */
export const MAX_BOT_BROWSER_SENT = 64
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
export const MAX_BOT_BROWSER_FILES = 16
export const MAX_BOT_BROWSER_FILES_BYTES = 512 * 1024 * 1024
/** What the app says when the chosen files are over the limits. */
export const BOT_BROWSER_FILES_LIMIT_TEXT = `Choose at most ${MAX_BOT_BROWSER_FILES} files, ${MAX_BOT_BROWSER_FILES_BYTES / 1024 / 1024} MB in all.`
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
