import { NetError, type NetErrorCode } from '../../../shared/net/errors'
import { forbiddenReason, type NodeId } from '../../../shared/net'
import { encodeMessage, MessageReader, type EngineMessage } from './frame'

/** The stream labels an engine connection carries (§3.2); the helper passes on only these. */
export const ENGINE_LABELS = [
  'mousse.hello',
  'mousse.rpc',
  'mousse.sub',
  'mousse.blob',
  'mousse.put',
  // Phase 1b: one editor tunnel per stream, opened by the caller (§9.2).
  'mousse.tunnel',
  // Bot traffic, in stream places and credit of its own (mousse-net `BOT_LABELS`): the bots feed and bot chats, bot
  // calls, and the pictures of a bot's live browser view. Threads never ride on these, nor bots on the thread labels.
  'mousse.botsub',
  'mousse.botrpc',
  'mousse.botview'
] as const
export type EngineLabel = (typeof ENGINE_LABELS)[number]

/** The labels that take the bot places of a connection (mousse-net `BOT_LABELS`), apart from the thread ones. */
export const BOT_ENGINE_LABELS: ReadonlySet<EngineLabel> = new Set(['mousse.botsub', 'mousse.botrpc', 'mousse.botview'])
export const isBotLabel = (label: EngineLabel): boolean => BOT_ENGINE_LABELS.has(label)

/**
 * What this app understands beyond protocol 1, said in `mousse.hello` both ways. `one-way`: a computer it let in
 * may never pair back, and its row is complete without that.
 */
export const SESSION_FEATURES = ['one-way'] as const

/**
 * Said beside `SESSION_FEATURES` only while this computer's helper can grant over a live connection
 * (`grant-add-connected`): a computer of a one-way pairing may ask for the other direction (`access.*` messages on
 * one long-lived `mousse.hello` stream the calling side opens with `access.open`).
 */
export const ACCESS_FEATURE = 'access-ask'

/**
 * One stream of a connection, as the helper hands it to the app: ordered bytes each way, a FIN, or a reset.
 * The helper process and the in-memory test link both implement it.
 */
/** A grant's role as the wire defines it (wire §7): 1 to 32 bytes of `[a-z0-9-]`. */
export const GRANT_ROLE = /^[a-z0-9-]{1,32}$/

export interface EngineStream {
  readonly label: EngineLabel
  /**
   * On a stream the other computer opened: the role of this computer's grant it is served under, as the helper
   * named it (`stream.incoming {role}`, pairing flow §8.4). Absent from a helper that does not say.
   */
  readonly role?: string
  write(bytes: Uint8Array): void
  /** FIN: nothing more is written this way. */
  end(): void
  /** Ends both ways at once. */
  reset(reason?: string): void
  /**
   * Settles once a producer may write more (what it wrote has mostly left), or the stream ended. A stream without
   * it never holds a producer back.
   */
  ready?(): Promise<void>
  onData(listener: (bytes: Uint8Array) => void): void
  /** The other side's FIN (no reason) or a reset (with its reason). */
  onEnd(listener: (reason?: string) => void): void
}

/**
 * One connection with one pairing. Inbound connections carry its calls to this computer (serving); outbound ones
 * carry this computer's calls to it (client). `peer` is this computer's local id for the pairing.
 */
/**
 * A connection's route (Phase 1b §7): its pipe kind and the class of the address it reached. A relay connection
 * (Phase 3) has kind `relay`, class `relay` or `relay_bulk`, and the relay's `relay://host:port`.
 */
export interface EngineRoute {
  kind: 'tcp' | 'ws' | 'ssh' | 'relay'
  class: 'lan' | 'tailnet' | 'public' | 'tunnel' | 'ssh' | 'relay' | 'relay_bulk'
  /** A relay connection's destination, `relay://host:port`. */
  destination?: string
}

export interface EngineConnection {
  readonly id: string
  readonly peer: NodeId
  readonly direction: 'inbound' | 'outbound'
  /** On an inbound connection, the grant `conn.up` reported for the caller. */
  readonly grant?: string
  /** On an inbound connection, the endpoint of the caller. */
  readonly endpoint?: string
  /** The route the connection runs over (protocol 1.1 `conn.up.route`), when the helper said. */
  readonly route?: EngineRoute
  /**
   * The other way of a connection that carries calls both ways (wire minor 3): `outbound`, this computer's calls on
   * a connection the other computer dialled; `inbound`, its calls on one this computer dialled. The helper's path
   * is the dialler's, so the path switch never names it.
   */
  readonly reversed?: boolean
  /** Opens a stream; `method` names the call a `mousse.rpc` stream carries, which decides its class. */
  open(label: EngineLabel, method?: string): EngineStream
  onStream(listener: (stream: EngineStream) => void): void
  onClose(listener: (reason: string) => void): void
  close(reason: string): void
  isOpen(): boolean
}

/** Messages over one stream. */
export class Channel {
  private readonly reader = new MessageReader()
  private readonly listeners = new Set<(message: EngineMessage) => void>()
  private readonly endListeners = new Set<(reason?: string) => void>()
  private ended = false
  private writable = true
  constructor(readonly stream: EngineStream) {
    stream.onData((bytes) => {
      let messages: EngineMessage[]
      try {
        messages = this.reader.push(bytes)
      } catch {
        this.reset('bad_message')
        return
      }
      for (const message of messages) for (const listener of this.listeners) listener(message)
    })
    stream.onEnd((reason) => {
      if (reason !== undefined) this.writable = false
      if (this.ended) return
      this.ended = true
      for (const listener of this.endListeners) listener(reason)
    })
  }
  send(header: EngineMessage['header'], parts: readonly Uint8Array[] = []): void {
    if (!this.writable) throw new NetError('peer_offline')
    this.stream.write(encodeMessage(header, parts))
  }
  /** Waits until the stream takes more (`EngineStream.ready`); producers of many messages wait between them. */
  async drained(): Promise<void> {
    await this.stream.ready?.()
  }
  onMessage(listener: (message: EngineMessage) => void): void {
    this.listeners.add(listener)
  }
  onEnd(listener: (reason?: string) => void): void {
    this.endListeners.add(listener)
  }
  end(): void {
    if (!this.writable) return
    this.writable = false
    this.stream.end()
  }
  reset(reason?: string): void {
    this.writable = false
    this.stream.reset(reason)
  }
  isOpen(): boolean {
    return this.writable && !this.ended
  }
}

/** What crosses for an error: its code and, for a refusal, the fixed word that says which kind. */
export interface EngineWireError {
  code: NetErrorCode
  reason?: string
}

export function toWireError(error: unknown): EngineWireError {
  const code = error instanceof NetError ? error.code : 'internal'
  const details = error instanceof NetError ? error.details : undefined
  const reason =
    code === 'forbidden'
      ? forbiddenReason(details)
      : typeof (details as { reason?: unknown } | undefined)?.reason === 'string' &&
          /^[a-z_]{1,64}$/.test((details as { reason: string }).reason)
        ? (details as { reason: string }).reason
        : undefined
  return { code, ...(reason ? { reason } : {}) }
}

export function fromWireError(error: unknown): NetError {
  const wire = error as Partial<EngineWireError> | undefined
  const code = (typeof wire?.code === 'string' ? wire.code : 'internal') as NetErrorCode
  try {
    return new NetError(
      code,
      undefined,
      typeof wire?.reason === 'string' ? { details: { reason: wire.reason } } : undefined
    )
  } catch {
    return new NetError('internal')
  }
}
