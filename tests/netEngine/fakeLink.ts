/**
 * An in-memory engine link for tests: one outbound connection on the calling computer and the inbound one it
 * reaches on the owner, with streams that carry bytes in order, a FIN or a reset, delivered on a later turn as a
 * network would. A reset drops what was written and not yet delivered, as a QUIC reset abandons unacknowledged data. Every message written is decoded and recorded, so a test can list what crossed.
 */
import type { NodeId } from '../../src/shared/net'
import { MessageReader } from '../../src/mms/netEngine/session/frame'
import type {
  EngineConnection,
  EngineLabel,
  EngineStream
} from '../../src/mms/netEngine/session/transport'

export interface CrossedMessage {
  /** Which way it went: from the calling computer (`caller`) or from the owner. */
  from: 'caller' | 'owner'
  label: EngineLabel
  header: Record<string, unknown>
  /** The raw bytes of the message's parts. */
  parts: Uint8Array[]
}

type Event = { kind: 'data'; bytes: Uint8Array } | { kind: 'end'; reason?: string }

class FakeStream implements EngineStream {
  other!: FakeStream
  private readonly data: Array<(bytes: Uint8Array) => void> = []
  private readonly ends: Array<(reason?: string) => void> = []
  private readonly pending: Event[] = []
  private readonly reader = new MessageReader()
  private writable = true
  private ended = false
  /** Reset by this side: what it wrote and was not delivered yet is dropped. */
  private abandoned = false
  constructor(
    readonly label: EngineLabel,
    private readonly side: 'caller' | 'owner',
    private readonly crossed: CrossedMessage[]
  ) {}
  write(bytes: Uint8Array): void {
    if (!this.writable) throw new Error('written after its end')
    const copy = Uint8Array.from(bytes)
    for (const message of this.reader.push(copy))
      this.crossed.push({ from: this.side, label: this.label, header: message.header, parts: message.parts })
    setImmediate(() => {
      if (!this.abandoned) this.other.deliver({ kind: 'data', bytes: copy })
    })
  }
  end(): void {
    if (!this.writable) return
    this.writable = false
    setImmediate(() => {
      if (!this.abandoned) this.other.deliver({ kind: 'end' })
    })
  }
  reset(reason = 'reset'): void {
    this.writable = false
    this.abandoned = true
    this.other.writable = false
    setImmediate(() => {
      this.other.deliver({ kind: 'end', reason })
      this.deliver({ kind: 'end', reason })
    })
  }
  onData(listener: (bytes: Uint8Array) => void): void {
    this.data.push(listener)
    this.flush()
  }
  onEnd(listener: (reason?: string) => void): void {
    this.ends.push(listener)
    this.flush()
  }
  deliver(event: Event): void {
    this.pending.push(event)
    this.flush()
  }
  private flush(): void {
    // Held until the reader listens, as bytes wait in a socket.
    if (!this.data.length) return
    for (const event of this.pending.splice(0)) {
      if (this.ended) return
      if (event.kind === 'data') for (const listener of this.data) listener(event.bytes)
      else {
        this.ended = true
        for (const listener of this.ends) listener(event.reason)
      }
    }
  }
}

class FakeConnection implements EngineConnection {
  other!: FakeConnection
  private readonly streamListeners: Array<(stream: EngineStream) => void> = []
  private readonly waiting: EngineStream[] = []
  private readonly closeListeners: Array<(reason: string) => void> = []
  private readonly streams: FakeStream[] = []
  private open_ = true
  constructor(
    readonly id: string,
    readonly peer: NodeId,
    readonly direction: 'inbound' | 'outbound',
    private readonly side: 'caller' | 'owner',
    private readonly crossed: CrossedMessage[],
    readonly grant?: string,
    readonly endpoint?: string
  ) {}
  open(label: EngineLabel): EngineStream {
    if (!this.open_) throw new Error('the connection is closed')
    const mine = new FakeStream(label, this.side, this.crossed)
    const theirs = new FakeStream(label, this.other.side, this.crossed)
    mine.other = theirs
    theirs.other = mine
    this.streams.push(mine)
    this.other.streams.push(theirs)
    setImmediate(() => this.other.arrive(theirs))
    return mine
  }
  private arrive(stream: EngineStream): void {
    if (!this.open_) return
    if (!this.streamListeners.length) this.waiting.push(stream)
    for (const listener of this.streamListeners) listener(stream)
  }
  onStream(listener: (stream: EngineStream) => void): void {
    this.streamListeners.push(listener)
    for (const stream of this.waiting.splice(0)) listener(stream)
  }
  onClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener)
  }
  close(reason: string): void {
    if (!this.open_) return
    this.open_ = false
    this.other.open_ = false
    for (const stream of this.streams) stream.reset(reason)
    setImmediate(() => {
      for (const listener of this.closeListeners) listener(reason)
      for (const listener of this.other.closeListeners) listener(reason)
    })
  }
  isOpen(): boolean {
    return this.open_
  }
}

let count = 0

/**
 * A link from the calling computer to the owner. `ownerOnCaller` is the caller's local id for the owner and
 * `callerOnOwner` the owner's for the caller; `grant` is what the owner reports up for the caller.
 */
export function fakeLink(options: {
  ownerOnCaller: NodeId
  callerOnOwner: NodeId
  grant: string
  endpoint: string
  crossed?: CrossedMessage[]
}): { outbound: EngineConnection; inbound: EngineConnection; crossed: CrossedMessage[]; cut(reason?: string): void } {
  const crossed = options.crossed ?? []
  const id = `link-${++count}`
  const outbound = new FakeConnection(id, options.ownerOnCaller, 'outbound', 'caller', crossed)
  const inbound = new FakeConnection(
    id,
    options.callerOnOwner,
    'inbound',
    'owner',
    crossed,
    options.grant,
    options.endpoint
  )
  outbound.other = inbound
  inbound.other = outbound
  return { outbound, inbound, crossed, cut: (reason = 'link_lost') => outbound.close(reason) }
}
