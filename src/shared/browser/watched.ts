import type { BrowserAgentCursor } from './agentCursor'
import type { BrowserProblem } from './navigation'
import type { BrowserHumanInput } from './types'
import { validateBrowserHumanInput } from './validation'

/**
 * A browser without a window, as a person's views see it: pictures pushed as the page paints, who
 * holds it, and a hold's numbered input (`src/mms/browser/viewer/WatchedBrowser.ts`). A bot's browser
 * is its first user (`shared/bots/personal/browser.ts` names these for the `bots.browser.*` methods).
 * No payload names a session, a model or a path. Browser-safe.
 */

/** A picture of the watched tab: a JPEG in base64, and the page's size in CSS pixels it shows whole. */
export interface WatchedBrowserFrame {
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
export interface WatchedBrowserDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  defaultPrompt?: string
}

/** A page's request for files, as the view that holds the browser is told it: one or several, and which site asks. */
export interface WatchedBrowserChooser {
  multiple: boolean
  site?: string
}

/**
 * Who holds the browser, as one view sees it: its agent, this view (after its Take over), or
 * another view of the person's (another window).
 */
export type WatchedBrowserHolder = 'bot' | 'this-view' | 'another-view'

/** Why the host refused an input, for the person in one short line (`WatchedBrowserAck.text` says it). */
export type WatchedBrowserRefusal =
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
  /** The host was told to skip this number (`WatchedBrowserSent.skip`): nothing was applied. */
  | 'skipped'
  /** The service never takes this input (too long, malformed): the view drops it, and skips its number. */
  | 'invalid'
  /** It waited too long to be taken (the page did not answer): the view dropped it, and skips its number. */
  | 'dropped'

/** The host's answer to one numbered input of a hold. */
export interface WatchedBrowserAck {
  seq: number
  /** Applied once now; a duplicate of one taken before (never applied again); or refused. */
  status: 'applied' | 'duplicate' | 'refused'
  reason?: WatchedBrowserRefusal
  /** The refusal in one short line, and more for its tooltip (Chromium's code for a page that failed). */
  text?: string
  detail?: string
  /** A copy or cut: the page's selected text, for the person's clipboard alone. */
  copied?: string
}

/**
 * A person's input in a view, at the page's CSS pixels. Files go as the one-time token this
 * computer's own file dialog was answered with, never as paths; none cancels.
 */
export type WatchedBrowserInput = Exclude<BrowserHumanInput, { kind: 'files' }> | { kind: 'files'; token?: string }

/**
 * One numbered input of a hold, or a number to skip (`skip`). Every number the view gives out reaches
 * the host as one or the other, so the host's count never waits on a hole: an input the host refused
 * without using its number (`gap`, `busy`) is sent again while the hold lasts, and one the view gives
 * up on (it waited too long, or the service never takes it) is sent as a skip.
 */
export type WatchedBrowserSent =
  | {
    /** The hold's own count, from 1. */
    seq: number
    /** The picture (`WatchedBrowserFrame.id`) the person acted on. */
    picture?: number
    input: WatchedBrowserInput
  }
  | { seq: number; skip: true }

/** A view's hold of the browser, as the host answers it to that view. */
export interface WatchedBrowserHold {
  id: string
  /** The last input number the host has taken: a view picking the hold up again goes on after it. */
  lastSeq: number
  /** The computer the browser runs on ("Not reaching …"). */
  computer: string
}

/** Why a view's hold ended without its Give back. */
/** What a view asks of its hold: take it (`force`: from another view), say it is still there, or give it back. */
export type WatchedBrowserHoldRequest =
  | { op: 'take'; force?: boolean; platform?: 'mac' | 'other' }
  | { op: 'renew'; holdId: string }
  | { op: 'release'; holdId: string }

export type WatchedBrowserHoldEnd = 'expired' | 'taken' | 'closed' | 'tab-closed'

/** What one view is told of the browser: whether it is open, who holds it, and the followed tab. */
export interface WatchedBrowserView {
  /** Whether the browser is open now. A closed one keeps its last picture. */
  open: boolean
  /** Who uses it: its agent, or the person after Take over. */
  control: 'bot' | 'owner'
  /** The tab the views follow: the tab the person took while they hold the browser, else the one its user follows. */
  tab?: { url: string; title: string }
  /** The latest picture, when asked for (`frame: true`), or the last one once it closed. */
  frame?: WatchedBrowserFrame
  /** Where the agent acted last, while it is recent: drawn over the picture, never in the page. */
  cursor?: BrowserAgentCursor
  /** The followed tab is not the one in front, so Chromium does not paint it: its picture is a still. */
  behind?: boolean
  /** Its page is still loading. */
  loading?: boolean
  /** What its last page ran into (can't reach, blocked) or needs from the person (a sign-in, a human check). */
  problem?: BrowserProblem
  /**
   * Pictures cannot reach a view now, and why (the followed tab closed, the browser does not answer):
   * a view says it is not updating until they can. Absent while they can.
   */
  stalled?: string
  /** Who holds it, for the view that asked (`viewId`): with `control` `owner`, this view or another. */
  holder?: WatchedBrowserHolder
  /** This view's hold, when it holds the browser. */
  hold?: WatchedBrowserHold
  /** The page's open dialog, waiting for an answer. */
  dialog?: WatchedBrowserDialog
  /** The page asks the person for files (`multiple`: more than one), and the site that asks. */
  chooser?: WatchedBrowserChooser
  /** It is not open because its process ended by itself (a crash, the system): the next use starts it again. */
  stopped?: true
  /** It is open in a real window on the screen of the computer it runs on ("Open in a window"): nothing is pictured. */
  windowed?: true
}

/**
 * What a watching view is sent, on its own connection only, never replayed: a new picture when the
 * page paints, and the rest only when it changes. Its user adds what names the browser (a bot's id).
 */
export interface WatchedBrowserUpdate {
  watchId: string
  /** A new picture (`sharp`: taken at full quality once the page was still; `id`: its number, for input on it). */
  frame?: { data: string; mimeType: 'image/jpeg'; width: number; height: number; at: number; sharp?: boolean; id?: number }
  /** Who holds the browser now, as this view sees it (sent when it changes). */
  control?: 'bot' | 'owner'
  holder?: WatchedBrowserHolder
  /** This view's hold ended without its Give back, and why. */
  holdEnded?: WatchedBrowserHoldEnd
  /** The page's dialog opened; null: it was answered. */
  dialog?: WatchedBrowserDialog | null
  /** The page asks for files; null: answered. */
  chooser?: WatchedBrowserChooser | null
  /** The page's size in CSS pixels, when it changed (and with the first picture). */
  viewport?: { width: number; height: number }
  tab?: { url: string; title: string }
  /** Where the agent acts; null clears it. */
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

/**
 * A large view: its picture up to 1920 px wide (the page's width at the screen's pixel ratio, when the
 * view sizes the page), at most 15 pictures a second, 30 while the person holds the browser.
 */
export const WATCHED_BROWSER_PANE = { maxWidth: 1920, fps: 15, heldFps: 30 } as const

/**
 * The page's size, in CSS pixels, and its pixel ratio (`scale`): the default, and the bounds of the
 * size a large view asks for while it shows the browser (its own size, as a window would be). A
 * picture is never more than `maxPicture` pixels across: the ratio comes down first, never below 1.
 */
export const WATCHED_BROWSER_PAGE = {
  default: { width: 1280, height: 720, scale: 1 },
  min: { width: 320, height: 240 },
  max: { width: 1920, height: 2160 },
  maxScale: 2,
  maxPicture: { width: 1920, height: 2160 }
} as const

/** The size a large view asks the page to have: its own, in CSS pixels, and the screen's pixel ratio. */
export interface WatchedBrowserPageSize {
  width: number
  height: number
  scale: number
}

/** The page size a view asked for, within the bounds (`WATCHED_BROWSER_PAGE`); the default for anything else. */
export function watchedBrowserPageSize(asked: { width?: unknown; height?: unknown; scale?: unknown } | undefined): WatchedBrowserPageSize {
  const page = WATCHED_BROWSER_PAGE
  const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  const width = number(asked?.width)
  const height = number(asked?.height)
  if (width === undefined || height === undefined) return { ...page.default }
  const w = Math.round(Math.min(page.max.width, Math.max(page.min.width, width)))
  const h = Math.round(Math.min(page.max.height, Math.max(page.min.height, height)))
  const ratio = Math.min(number(asked?.scale) ?? 1, page.maxScale, page.maxPicture.width / w, page.maxPicture.height / h)
  // In quarters, so a ratio of 1.2499 and 1.25 are one size, and never below 1.
  return { width: w, height: h, scale: Math.max(1, Math.floor(ratio * 4) / 4) }
}

export const sameWatchedBrowserPageSize = (a: WatchedBrowserPageSize | undefined, b: WatchedBrowserPageSize | undefined): boolean =>
  a === b || Boolean(a && b && a.width === b.width && a.height === b.height && a.scale === b.scale)
/**
 * How often a view renews its watch; the host drops one not renewed for three times this. A
 * renewal answers whether pictures can reach the view now, and no picture once it has had one.
 */
export const WATCHED_BROWSER_RENEW_MS = 5_000

/**
 * How often a view that holds the browser says it is still there; a hold not renewed for
 * `WATCHED_BROWSER_HOLD_LEASE_MS` ends, and the browser goes back to its agent.
 */
export const WATCHED_BROWSER_HOLD_BEAT_MS = 5_000
export const WATCHED_BROWSER_HOLD_LEASE_MS = 2 * 60_000
/** The most inputs in one call of a hold's channel. */
export const MAX_WATCHED_BROWSER_SENT = 64

/**
 * The files the person chose for a page's file picker, from this computer's own file dialog: at most
 * `MAX_WATCHED_BROWSER_FILES`, `MAX_WATCHED_BROWSER_FILES_BYTES` in all, each a file.
 */
export const MAX_WATCHED_BROWSER_FILES = 16
export const MAX_WATCHED_BROWSER_FILES_BYTES = 512 * 1024 * 1024
/** What the app says when the chosen files are over the limits. */
export const WATCHED_BROWSER_FILES_LIMIT_TEXT = `Choose at most ${MAX_WATCHED_BROWSER_FILES} files, ${MAX_WATCHED_BROWSER_FILES_BYTES / 1024 / 1024} MB in all.`

/** The one-time token this computer's file dialog was answered with. */
export const WATCHED_BROWSER_FILES_TOKEN = /^files_[A-Za-z0-9-]{8,64}$/

/**
 * A person's input on a hold's channel, checked as the host checks it: every kind a managed tab
 * takes, except that files go as a token, never as paths. Throws what the host would refuse; the
 * view checks each input with this before it numbers it, so an input the host never takes never
 * holds up the ones after it.
 */
export function validateWatchedBrowserInput(value: unknown): WatchedBrowserInput {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  if (record?.kind === 'files') {
    if (Object.keys(record).some((key) => key !== 'kind' && key !== 'token')) throw new Error('invalid_action: files go as the token of this computer\'s file dialog')
    if (record.token === undefined) return { kind: 'files' }
    if (typeof record.token !== 'string' || !WATCHED_BROWSER_FILES_TOKEN.test(record.token)) throw new Error('invalid_action: invalid files token')
    return { kind: 'files', token: record.token }
  }
  return validateBrowserHumanInput(value) as WatchedBrowserInput
}

/** Why the host would refuse an input, in a short line for the person; undefined when it takes it. */
export function watchedBrowserInputProblem(input: WatchedBrowserInput): string | undefined {
  try {
    validateWatchedBrowserInput(input)
    return undefined
  } catch {
    if (input.kind === 'dialog' && (input.text?.length ?? 0) > 4096) return 'Too long: the page takes at most 4,096 characters here'
    if (input.kind === 'type' || input.kind === 'compose') return 'Too long to type at once'
    return 'That can\'t be sent to the page'
  }
}
