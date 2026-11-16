/**
 * Secrets an agent asks for in a thread (#595, the chat part). The agent calls `secret_request`; the person types the
 * value into a private card in the thread; Mousse keeps it in the profile's secret store (the one saved keys use) and
 * the agent gets its name and a private file holding it (`secrets/threads/<thread>/<NAME>`), which it may read and use
 * directly. The value is never part of a message, a tool result, an event, a log or a thread's saved data, and the
 * agent is told never to print it. `secret_run` also gives it to one command as an environment variable or a private
 * file, and `${secret:NAME}` reads it in an MCP server's settings.
 */

import { isKeyName, keyNameOf, MAX_KEY_VALUE_BYTES } from './automationKeys'

/** How long a secret given in a thread is kept: this thread only, 24 hours, or saved in Settings for reuse. */
export type SecretKeep = 'thread' | 'day' | 'saved'

export const SECRET_KEEPS: readonly SecretKeep[] = ['thread', 'day', 'saved']

/** What the card selects first. */
export const DEFAULT_SECRET_KEEP: SecretKeep = 'day'

/** "For a set time": 24 hours from when it was given. */
export const SECRET_DAY_MS = 24 * 60 * 60 * 1000

/** The shortest value Mousse keeps: shorter text would be masked wherever it appears in a thread. */
export const MIN_SECRET_VALUE_LENGTH = 4

/** A request waits at most this long for the person (or until the agent's turn ends). */
export const SECRET_REQUEST_TIMEOUT_MS = 60 * 60 * 1000

/** One pending request, as a card shows it. Never holds a value. */
export interface SecretRequestView {
  requestId: string
  threadId: string
  /** What the agent asks for, e.g. "Hugging Face write token". */
  label: string
  /** Why the agent needs it. */
  reason: string
  /** Where to create it (http or https only). */
  link?: string
  /** What it should look like, e.g. "starts with hf_". */
  format?: string
  /** The name it is kept under, unless that name already holds another secret. */
  name: string
  /** A saved secret already has this name: the card offers to use it instead of typing a new one. */
  savedExists: boolean
  createdAt: string
}

/** One secret in the store, as Settings lists it. Never holds a value. */
export interface SecretEntryView {
  name: string
  label?: string
  /** `key`: saved from an automation's key field, kept until removed. */
  keep: SecretKeep | 'key'
  /** When a `day` secret is deleted. */
  expiresAt?: string
  /** The thread that asked for it. */
  threadId?: string
  threadTitle?: string
  createdAt?: string
  lastUsedAt?: string
}

/** What the person answered on a card. */
export type SecretAnswer =
  | { kind: 'value'; value: string; keep: SecretKeep }
  | { kind: 'use_saved' }
  | { kind: 'decline' }

/** The daemon methods of this feature. A window of the computer that runs the thread calls them; nothing routes them. */
export const SECRET_METHODS = [
  'secrets.requests.list',
  'secrets.requests.answer',
  'secrets.requests.useSaved',
  'secrets.requests.decline',
  'secrets.list',
  'secrets.delete'
] as const

export type SecretMethod = (typeof SECRET_METHODS)[number]

/** The protocol event that says a thread's pending requests changed; it carries only the thread id. */
export const SECRET_REQUESTS_EVENT = 'secrets.requests.changed'

/** The name a request is kept under: the agent's name when it is a key name, else one made from the label. */
export function secretNameFor(input: { name?: unknown; label: string }): string {
  if (isKeyName(input.name)) return input.name
  if (typeof input.name === 'string') {
    const fromName = keyNameOf(input.name)
    if (fromName) return fromName
  }
  return keyNameOf(input.label.replace(/[^A-Za-z0-9 _.-]+/g, ' ').trim().slice(0, 60)) ?? 'SECRET'
}

/** Why a typed value cannot be kept, or undefined when it can. Never repeats the value. */
export function secretValueProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return 'Enter the secret.'
  if (value.length < MIN_SECRET_VALUE_LENGTH) return `A secret is at least ${MIN_SECRET_VALUE_LENGTH} characters.`
  // A command's environment cannot hold a NUL, and a refusal to start one would echo the value.
  if (value.includes('\u0000')) return 'A secret cannot hold a NUL character.'
  if (new TextEncoder().encode(value).length > MAX_KEY_VALUE_BYTES) return 'A secret holds at most 16 KB.'
  return undefined
}

/** What replaces a secret's value wherever it appears in a thread. */
export function secretMask(name: string): string {
  return `[secret ${name} hidden]`
}

/** The card's one line on where the value is kept and for how long. */
export function secretKeepLine(keep: SecretKeep): string {
  switch (keep) {
    case 'thread':
      return "Kept in Mousse's secret store on this computer for this thread only, and deleted with the thread. The agent can use it but never shows it in the chat."
    case 'day':
      return "Kept in Mousse's secret store on this computer for 24 hours, then deleted. The agent can use it but never shows it in the chat."
    case 'saved':
      return "Kept in Mousse's secret store on this computer until you remove it in Settings → Agents → Secrets. The agent can use it but never shows it in the chat."
  }
}

export function secretKeepLabel(keep: SecretKeep): string {
  return keep === 'thread' ? 'This thread only' : keep === 'day' ? '24 hours' : 'Save in Settings'
}

/** A link a card may open: http or https only. */
export function safeSecretLink(link: unknown): string | undefined {
  if (typeof link !== 'string' || link.length > 2048) return undefined
  try {
    const url = new URL(link)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}
