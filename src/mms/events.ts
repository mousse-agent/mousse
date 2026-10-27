import { EventEmitter } from 'events'

export type MmsEvent =
  | { channel: 'projects:updated'; data: unknown }
  | { channel: 'threads:updated'; data: unknown }
  | { channel: 'scheduled:updated'; data: unknown }
  | { channel: 'scheduled:status'; data: unknown }
  | { channel: 'channels:updated'; data: unknown }
  | { channel: 'net:updated'; data: import('../shared/net/local').NetStatus }
  | { channel: 'providers:install'; data: import('../shared/providerAuth').CliInstallEvent }
  /**
   * An event a request handler raised outside the protocol server, to be pushed to this daemon's
   * subscribers (its windows) like one raised by a window's own request. A routed call from another
   * computer uses it, so the windows on the computer that runs the thread hear what it changed.
   */
  | { channel: 'protocol:event'; data: ProtocolEventRequest }
  /**
   * An event about one thread that a request handler raised, as the protocol server pushed it to its
   * subscribers, whichever window or computer asked. In-daemon watchers (the private stream another
   * computer reads) follow the thread through it.
   */
  | { channel: 'thread:event'; data: ProtocolEventRequest }

export interface ProtocolEventRequest {
  type: string
  data: unknown
  threadId?: string
}

export type MmsEventChannel = MmsEvent['channel']

type MmsEventHandler = (data: unknown) => void

export class MmsEventBus {
  private emitter = new EventEmitter()

  on(channel: MmsEventChannel, handler: MmsEventHandler): void {
    this.emitter.on(channel, handler)
  }

  off(channel: MmsEventChannel, handler: MmsEventHandler): void {
    this.emitter.off(channel, handler)
  }

  emit<E extends MmsEvent>(event: E): void {
    this.emitter.emit(event.channel, event.data)
  }

  /** Broadcast helper matching legacy `(channel, data)` signature. */
  broadcast(channel: string, data: unknown): void {
    this.emitter.emit(channel, data)
  }

  onAny(handler: (channel: string, data: unknown) => void): () => void {
    const channels: MmsEventChannel[] = [
      'projects:updated',
      'threads:updated',
      'scheduled:updated',
      'scheduled:status',
      'channels:updated',
      'net:updated'
    ]
    const listeners = channels.map((channel) => {
      const listener = (data: unknown): void => handler(channel, data)
      this.emitter.on(channel, listener)
      return { channel, listener }
    })
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const { channel, listener } of listeners) this.emitter.off(channel, listener)
    }
  }
}
