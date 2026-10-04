import { Duplex } from 'node:stream'
import { NetError } from '../../../shared/net'
import type { Route } from '../../../shared/net'
import type { Clock, Listener, Transport, TransportStatus } from '../contracts'
import { systemClock } from '../clock'

type Pending = { bytes: Buffer; done: (error?: Error | null) => void }

export class MemoryDirection {
  private stalled = false
  private dropping = false
  private corruptBytes = 0
  private transform?: (bytes: Buffer) => Buffer
  private rate?: number
  private queue: Pending[] = []
  private timer?: { cancel(): void }
  private scheduled = false
  private closed = false
  private blocked = false
  constructor(
    private readonly clock: Clock,
    private readonly receiver: Duplex
  ) {}
  stall(): void {
    this.stalled = true
  }
  resume(): void {
    this.stalled = false
    this.schedule()
  }
  halfOpen(): void {
    this.dropping = true
    this.schedule()
  }
  heal(): void {
    this.dropping = false
    this.stalled = false
    this.schedule()
  }
  slow(bytesPerTick: number): void {
    if (!Number.isSafeInteger(bytesPerTick) || bytesPerTick <= 0)
      throw new RangeError('Invalid rate')
    this.rate = bytesPerTick
  }
  corrupt(nextNBytes: number): void {
    if (!Number.isSafeInteger(nextNBytes) || nextNBytes < 0)
      throw new RangeError('Invalid corruption length')
    this.corruptBytes = nextNBytes
  }
  tamper(fn: (bytes: Buffer) => Buffer): void {
    this.transform = fn
  }
  write(bytes: Buffer, done: Pending['done']): void {
    if (this.closed) {
      done(new Error('Connection closed'))
      return
    }
    try {
      let copy: Buffer = Buffer.from(bytes)
      const n = Math.min(copy.length, this.corruptBytes)
      for (let i = 0; i < n; i++) copy[i] ^= 1
      this.corruptBytes -= n
      if (this.transform) copy = this.transform(copy)
      this.queue.push({ bytes: copy, done })
      this.schedule()
    } catch (cause) {
      done(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }
  readable(): void {
    this.blocked = false
    this.schedule()
  }
  close(): void {
    this.closed = true
    this.timer?.cancel()
    this.timer = undefined
    for (const pending of this.queue.splice(0)) pending.done(new Error('Connection closed'))
  }
  private schedule(): void {
    if (
      this.closed ||
      this.scheduled ||
      this.timer ||
      this.stalled ||
      this.blocked ||
      this.queue.length === 0
    )
      return
    if (this.rate && !this.dropping) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, 1)
    } else {
      this.scheduled = true
      queueMicrotask(() => {
        this.scheduled = false
        this.flush()
      })
    }
  }
  private flush(): void {
    if (this.closed || this.stalled || this.blocked) return
    const item = this.queue[0]
    if (!item) return
    if (this.dropping) {
      this.queue.shift()
      item.done()
    } else {
      const count = Math.min(item.bytes.length, this.rate ?? item.bytes.length)
      const chunk = item.bytes.subarray(0, count)
      item.bytes = item.bytes.subarray(count)
      if (chunk.length) this.blocked = !this.receiver.push(chunk)
      if (!item.bytes.length) {
        this.queue.shift()
        item.done()
      }
    }
    this.schedule()
  }
}

export interface MemoryConnection {
  from: string
  to: string
  a: Duplex
  b: Duplex
  forward: MemoryDirection
  backward: MemoryDirection
  cut(): void
}

export function memoryPair(clock: Clock = systemClock, from = 'a', to = 'b'): MemoryConnection {
  let forward: MemoryDirection
  let backward: MemoryDirection
  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    forward.close()
    backward.close()
    a.destroy()
    b.destroy()
  }
  const a = new Duplex({
    read() {
      backward.readable()
    },
    write(chunk, _encoding, done) {
      forward.write(chunk, done)
    },
    final(done) {
      b.push(null)
      done()
    },
    destroy(error, done) {
      close()
      done(error)
    }
  })
  const b = new Duplex({
    read() {
      forward.readable()
    },
    write(chunk, _encoding, done) {
      backward.write(chunk, done)
    },
    final(done) {
      a.push(null)
      done()
    },
    destroy(error, done) {
      close()
      done(error)
    }
  })
  // Fault-induced errors are visible to listeners without requiring every test
  // to install a handler before tearing down a half-open connection.
  a.on('error', () => {})
  b.on('error', () => {})
  forward = new MemoryDirection(clock, b)
  backward = new MemoryDirection(clock, a)
  return { from, to, a, b, forward, backward, cut: close }
}

export class MemoryNetwork {
  readonly connections: MemoryConnection[] = []
  private listeners = new Map<string, (stream: Duplex, from: string) => void>()
  private refused = new Set<string>()
  private partitions = new Set<string>()
  constructor(readonly clock: Clock = systemClock) {}
  private key(a: string, b: string): string {
    return JSON.stringify([a, b].sort())
  }
  listen(address: string, accept: (stream: Duplex, from: string) => void): Listener {
    if (this.listeners.has(address)) throw new NetError('conflict', 'Address already listening.')
    this.listeners.set(address, accept)
    return {
      close: async () => {
        if (this.listeners.get(address) === accept) this.listeners.delete(address)
      }
    }
  }
  dial(from: string, to: string, signal: AbortSignal): Duplex {
    if (signal.aborted) throw new NetError('cancelled')
    const accept = this.listeners.get(to)
    if (!accept || this.refused.has(to) || this.partitions.has(this.key(from, to)))
      throw new NetError('route_unreachable')
    const connection = memoryPair(this.clock, from, to)
    this.connections.push(connection)
    connection.a.once('close', () => {
      const index = this.connections.indexOf(connection)
      if (index >= 0) this.connections.splice(index, 1)
    })
    const abort = () => connection.cut()
    signal.addEventListener('abort', abort, { once: true })
    connection.a.once('close', () => signal.removeEventListener('abort', abort))
    try {
      accept(connection.b, from)
    } catch (cause) {
      connection.cut()
      throw cause
    }
    return connection.a
  }
  refuseDial(address: string): void {
    this.refused.add(address)
  }
  allowDial(address: string): void {
    this.refused.delete(address)
  }
  partition(a: string, b: string): void {
    this.partitions.add(this.key(a, b))
    for (const link of this.connections)
      if (this.key(link.from, link.to) === this.key(a, b)) {
        link.forward.halfOpen()
        link.backward.halfOpen()
      }
  }
  heal(): void {
    this.partitions.clear()
    for (const link of this.connections) {
      link.forward.heal()
      link.backward.heal()
    }
  }
  dispose(): void {
    for (const link of [...this.connections]) link.cut()
    this.listeners.clear()
  }
}

export class MemoryTransport implements Transport {
  readonly id = 'memory'
  readonly traits = { canListen: true, canDial: true, readsPlaintext: false, needsAccount: false }
  private state: TransportStatus['state'] = 'disabled'
  private listeners = new Set<(status: TransportStatus) => void>()
  private accepts = new Set<Listener>()
  private streams = new Set<Duplex>()
  constructor(
    readonly network: MemoryNetwork,
    readonly address: string
  ) {}
  private change(state: TransportStatus['state']): void {
    this.state = state
    for (const listener of this.listeners) listener(this.status())
  }
  async provision(): Promise<void> {
    this.change('ready')
  }
  async listen(onConnection: Parameters<Transport['listen']>[0]): Promise<Listener> {
    if (this.state !== 'ready') throw new NetError('route_unreachable')
    const listener = this.network.listen(this.address, (stream, from) => {
      this.track(stream)
      onConnection(stream, { transport: this.id, remoteAddress: from })
    })
    this.accepts.add(listener)
    return {
      close: async () => {
        await listener.close()
        this.accepts.delete(listener)
      }
    }
  }
  async dial(route: Route, signal: AbortSignal): Promise<Duplex> {
    if (this.state !== 'ready' || route.transport !== this.id)
      throw new NetError('route_unreachable')
    const stream = this.network.dial(this.address, route.address, signal)
    this.track(stream)
    return stream
  }
  private track(stream: Duplex): void {
    this.streams.add(stream)
    stream.once('close', () => this.streams.delete(stream))
  }
  status(): TransportStatus {
    return {
      state: this.state,
      routes:
        this.state === 'ready' ? [{ transport: 'memory', address: this.address, priority: 0 }] : []
    }
  }
  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  async teardown(): Promise<void> {
    for (const listener of this.accepts) await listener.close()
    this.accepts.clear()
    for (const stream of this.streams) stream.destroy()
    this.streams.clear()
    this.change('disabled')
  }
}
