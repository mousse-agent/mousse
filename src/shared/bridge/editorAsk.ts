/**
 * Asking another computer for editor connections. A computer that cannot open its editor on another one
 * (the switch "Editor connections from this device" is off there) can ask. The ask is one routed call,
 * `editor.ask`, that needs only the grant every routed call needs ("Works on threads"). It changes nothing
 * on the computer that answers: a person there sees "Allow <computer> to open its editor here?", and only
 * Allow turns the switch on, there. Browser-safe.
 */
import type { NodeId } from '../net/ids'

/** How long an ask waits for an answer before it is dropped. */
export const EDITOR_ASK_TTL_MS = 10 * 60 * 1000
/** After "Not now", the same computer is told "not now" without anyone being asked again, for this long. */
export const EDITOR_ASK_COOLDOWN_MS = 30 * 60 * 1000
/** Asks that reach a person, per computer and hour. More are answered `rate_limited` and raise no notice. */
export const EDITOR_ASKS_PER_HOUR = 3
export const EDITOR_ASK_WINDOW_MS = 60 * 60 * 1000

/** What the owner answers to `editor.ask`. */
export type EditorAskReply =
  /** A person on the owner was asked just now. */
  | { state: 'asked'; expiresAt: number }
  /** An earlier ask is still waiting for its answer; nobody was bothered again. */
  | { state: 'pending'; expiresAt: number }
  /** The switch is already on there, so there was nothing to ask. */
  | { state: 'already_on' }
  /** A person there said "Not now" lately. `retryAt` is when asking raises a notice again. */
  | { state: 'declined_recently'; retryAt: number }
  /** This computer asked too often. `retryAt` is when asking raises a notice again. */
  | { state: 'rate_limited'; retryAt: number }

export const isEditorAskReply = (value: unknown): value is EditorAskReply => {
  if (!value || typeof value !== 'object') return false
  const state = (value as { state?: unknown }).state
  return (
    state === 'asked' ||
    state === 'pending' ||
    state === 'already_on' ||
    state === 'declined_recently' ||
    state === 'rate_limited'
  )
}

/** An ask waiting for a person on this computer, as the windows show it. */
export interface EditorAskView {
  node: NodeId
  /** The name this computer knows the other one by. */
  name: string
  at: number
  expiresAt: number
}

/** What `bridge.editorAsk.answer` did. */
export type EditorAskAnswerResult =
  /** Allow: the switch is on. Not now: the refusal was recorded. */
  | { ok: true; allowed: boolean }
  /** The ask ran out, was answered in another window, or the device was blocked meanwhile. */
  | { ok: false; reason: 'expired' }

/** The audit rows an ask leaves on the owner (`bridge_audit.method`). Notice rows: they are not counted as changes. */
export const EDITOR_ASK_AUDIT = {
  asked: 'editor.ask',
  allowed: 'editor.ask.allowed',
  declined: 'editor.ask.declined'
} as const

/** The longest device name shown in the question, the notice and Devices. */
export const DEVICE_NAME_SHOWN_MAX = 64

/**
 * A device name as a person reads it: control and format characters (newlines, bidirectional overrides, zero-width
 * marks) are dropped, runs of white space become one space, and a long name is cut. A name is the user's own text, but
 * it is shown in a notice and a question that decide shell access, so it must not be able to reorder or break them.
 */
export function cleanDeviceName(name: string, fallback = 'Another computer'): string {
  const cleaned = name
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!cleaned) return fallback
  const letters = [...cleaned]
  return letters.length > DEVICE_NAME_SHOWN_MAX ? `${letters.slice(0, DEVICE_NAME_SHOWN_MAX - 1).join('')}…` : cleaned
}

/** The question as the owner's person reads it. */
export const editorAskQuestion = (device: string): string => `Let ${device}’s editor connect to this computer?`
export const EDITOR_ASK_WARNING = 'Gives shell access.'

/** How long the prompt keeps Allow disabled after it appears, so a click meant for something else cannot grant it. */
export const EDITOR_ASK_ARM_MS = 1_000
