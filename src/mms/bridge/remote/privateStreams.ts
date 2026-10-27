import type { NodeId } from '../../../shared/net'
import { isId } from '../../../shared/net'
import { ROUTED_STREAM_KINDS, type RoutedStreamKind } from '../../../shared/bridge/routed'

/**
 * Private streams: display streams that one computer of the user reads and no other, because the
 * records are not for phones or for another computer (a device's own approval cards, subagent rows,
 * Git progress, terminal output). They are stored and served like the shared display streams, and
 * their identity here is the key they are stored under.
 */
export interface PrivateSpec {
  /** The only node that may read the stream. */
  reader: NodeId
  kind: RoutedStreamKind
  /**
   * What the stream is about: a thread id (`thread`), `<thread id>:<pty id>` (`terminal`), nothing for
   * `lists` and `channel`.
   */
  subject: string
}

const PREFIX = 'private:'

/** Real thread ids never contain a colon, so a key that starts with this cannot name a thread. */
export const isPrivateKey = (key: string): boolean => key.startsWith(PREFIX)

export const privateKey = (spec: PrivateSpec): string =>
  `${PREFIX}${spec.reader}:${spec.kind}:${spec.subject}`

export function parsePrivateKey(key: string): PrivateSpec | undefined {
  if (!isPrivateKey(key)) return undefined
  const first = key.indexOf(':', PREFIX.length)
  const second = key.indexOf(':', first + 1)
  if (first < 0 || second < 0) return undefined
  const reader = key.slice(PREFIX.length, first)
  const kind = key.slice(first + 1, second)
  if (!isId('node', reader) || !(ROUTED_STREAM_KINDS as readonly string[]).includes(kind))
    return undefined
  return { reader, kind: kind as RoutedStreamKind, subject: key.slice(second + 1) }
}

/** The ids a private stream's records carry as `threadId`, so a reader's projection can check them. */
export const PRIVATE_LISTS_SUBJECT = 'mousse:lists'
export const PRIVATE_CHANNEL_SUBJECT = 'mousse:channel'
export const privateRecordSubject = (spec: PrivateSpec): string => {
  switch (spec.kind) {
    case 'thread':
      return spec.subject
    case 'lists':
      return PRIVATE_LISTS_SUBJECT
    case 'channel':
      return PRIVATE_CHANNEL_SUBJECT
    case 'terminal':
      return `mousse:pty:${terminalParts(spec.subject).ptyId}`
  }
}

/** A terminal stream's subject, split into the thread it belongs to and the terminal. */
export function terminalParts(subject: string): { threadId: string; ptyId: string } {
  const at = subject.indexOf(':')
  return { threadId: subject.slice(0, at), ptyId: subject.slice(at + 1) }
}

/**
 * What one computer may hold open at once on this one: 16 thread streams, one lists stream, one
 * channel stream and 4 terminals. Together the computers may hold 32 thread streams.
 */
export const PRIVATE_STREAM_QUOTA: Readonly<Record<RoutedStreamKind, number>> = Object.freeze({
  thread: 16,
  lists: 1,
  channel: 1,
  terminal: 4
})
export const PRIVATE_THREAD_STREAMS_TOTAL = 32

/** Records a private terminal stream keeps for a reader that is catching up, which is far more than a thread stream. */
export const PRIVATE_TERMINAL_RING_ROWS = 4096
export const PRIVATE_TERMINAL_RING_BYTES = 8 * 1024 * 1024
