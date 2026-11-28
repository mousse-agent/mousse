import { APPLET_SOURCE_LIMIT, APPLET_STATE_LIMIT, type AppletReference } from '../../applets'

/**
 * A bot's applets on another of the owner's computers (`docs/bots.md`, "Applets from another computer"): the rows that
 * read and save them there (`bots.applets.get`, `bots.applets.state.get`, `bots.applets.state.save`) and what the
 * viewing computer keeps of them.
 */

/** One page of an applet's source or saved state: 40 KiB, under one reply as base64. */
export const REMOTE_APPLET_PAGE_BYTES = 40 * 1024
/** The largest applet source another device reads (its JSON): the applet limit itself. */
export const REMOTE_APPLET_SOURCE_BYTES = APPLET_SOURCE_LIMIT
/** The largest saved state another device reads (its JSON): the applet state limit, in two pages. */
export const REMOTE_APPLET_STATE_BYTES = APPLET_STATE_LIMIT + 16
/**
 * The largest state another device saves at once (its JSON): one request carries it, whole, within the 48 KiB a routed
 * call may send. Larger state is refused there and stays as it was.
 */
export const REMOTE_APPLET_SAVE_BYTES = 40 * 1024
/** What the copies of other computers' bots' applets may take on the viewing computer, together. */
export const REMOTE_BOT_APPLETS_BYTES = 64 * 1024 * 1024
/** The copies of other computers' bots' applets the viewing computer keeps at most. */
export const REMOTE_BOT_APPLETS_COUNT = 200

/** An applet id or revision id, as the applet store names them. */
export function isAppletId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
}

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

/** An applet's reference as a message of another computer's bot names it (its words are that computer's): well formed. */
export function isAppletReference(value: unknown): value is AppletReference {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  return isAppletId(ref.appletId) && isAppletId(ref.revisionId) && isText(ref.sourceHash, 128) && isText(ref.title, 200) && isText(ref.description, 2000)
}

/** The applets a message shows, each with a well-formed reference; undefined when none. */
export function shownApplets<T extends { reference: AppletReference }>(applets: readonly T[] | undefined): T[] | undefined {
  const kept = Array.isArray(applets) ? applets.filter((applet) => applet && typeof applet === 'object' && isAppletReference(applet.reference)) : []
  return kept.length ? kept : undefined
}

/** One page of an applet's source (`bots.applets.get`): its reference, and a part of its source's JSON. */
export interface RemoteAppletPage extends AppletReference {
  size: number
  offset: number
  dataB64: string
}

/**
 * One page of an applet's saved state (`bots.applets.state.get`): a part of `{ state }` as JSON, and that JSON's hash, so
 * pages read while it was saved again are not joined.
 */
export interface RemoteAppletStatePage {
  size: number
  offset: number
  hash: string
  dataB64: string
}

/** An applet of a bot of another computer, as the window names it: the bot (qualified) and the message that shows it. */
export interface RemoteAppletRef {
  botId: string
  messageId: string
  appletId: string
  revisionId: string
}
