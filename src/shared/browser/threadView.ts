import type {
  WatchedBrowserAck,
  WatchedBrowserHold,
  WatchedBrowserHoldRequest,
  WatchedBrowserPageSize,
  WatchedBrowserSent,
  WatchedBrowserUpdate,
  WatchedBrowserView
} from './watched'

/**
 * A thread agent's browser without a window, as the app shows it in that thread's Browser panel: the
 * managed browser an agent of the thread opened (a turn sent from the command line, a custom agent run
 * from the command line, another computer, a schedule or a phone). The person watches it and can take
 * it over and give it back, under the rules of every browser without a window (`watched.ts`). No
 * payload names a session or a path. Browser-safe.
 *
 * Only the app's own window on this computer calls these methods; the files method only its main
 * process. They follow the thread's open session, whichever it is, and say when there is none.
 */

export interface ThreadBrowserView extends WatchedBrowserView {
  /**
   * The agent asked for a person (`browser_request_human`) and waits: the reason it gave. The
   * browser is nobody's until someone takes it over here.
   */
  asks?: string
}

/** What a view that watches a thread's browser is sent (`browser.view.frame`, on its own connection, never replayed). */
export interface ThreadBrowserFrameEvent extends WatchedBrowserUpdate {
  threadId: string
}

/** The connection event a watching view is sent. */
export const BROWSER_VIEW_FRAME_EVENT = 'browser.view.frame'
/** The capability under which the `browser.view.*` methods and their pushed pictures are offered. */
export const BROWSER_VIEW_CAPABILITY = 'browser.view.v1'

/** The longest reason of an agent's ask that a view is told. */
export const MAX_BROWSER_VIEW_ASK_CHARS = 280

/** The thread-browser methods a window's renderer calls. */
export const BROWSER_VIEW_METHODS = ['browser.view.get', 'browser.view.watch', 'browser.view.unwatch', 'browser.view.hold', 'browser.view.send'] as const
export type BrowserViewMethod = (typeof BROWSER_VIEW_METHODS)[number]

/**
 * The files the person chose for a page's file picker, from this computer's own file dialog: the app's
 * main process alone calls it (it is not one of the renderer's methods), on the window's own
 * connection, and gets a one-time token the view sends as its `files` input.
 */
export const BROWSER_VIEW_FILES_METHOD = 'browser.view.files'
export interface BrowserViewFilesApi {
  params: { threadId: string; viewId: string; holdId: string; paths: string[] }
  result: { token: string; count: number }
}

/** What a view asks of its hold: take it (`force`: from another window), say it is still there, or give it back. */
export type BrowserViewHoldRequest = WatchedBrowserHoldRequest

export interface BrowserViewApi {
  /** The thread's browser now, as view `viewId` sees it (who holds it). */
  'browser.view.get': { params: { threadId: string; viewId?: string }; result: { browser: ThreadBrowserView } }
  /**
   * Starts (or renews, or resizes) this connection's watch of the thread's browser: pictures are then
   * pushed as `browser.view.frame` while the page paints, at most `fps` a second and `width` wide (both
   * capped). Renew it every `WATCHED_BROWSER_RENEW_MS`; it ends with `unwatch`, the connection, or a
   * missed renewal. Answers the state and the last picture.
   */
  'browser.view.watch': { params: { threadId: string; watchId: string; width: number; fps: number; viewId?: string; page?: WatchedBrowserPageSize }; result: { browser: ThreadBrowserView } }
  'browser.view.unwatch': { params: { threadId: string; watchId: string }; result: { ok: true } }
  /**
   * A view's hold of the browser: `take` hands it to that view (the agents' actions are refused until it
   * is given back; another view's hold is refused as `held_elsewhere` unless `force`), `renew` keeps it
   * (every `WATCHED_BROWSER_HOLD_BEAT_MS`; it ends after two minutes without), `release` gives it back.
   */
  'browser.view.hold': { params: { threadId: string; viewId: string; request: BrowserViewHoldRequest }; result: { browser: ThreadBrowserView; hold?: WatchedBrowserHold } }
  /** Numbered inputs of a hold, in order, each applied once and answered. */
  'browser.view.send': { params: { threadId: string; viewId: string; holdId: string; inputs: WatchedBrowserSent[] }; result: { acks: WatchedBrowserAck[]; lastSeq: number } }
}
