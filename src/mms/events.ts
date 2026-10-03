import { EventEmitter } from 'events'

export type MmsEvent =
  | { channel: 'projects:updated'; data: unknown }
  | { channel: 'threads:updated'; data: unknown }
  | { channel: 'scheduled:updated'; data: unknown }
  | { channel: 'scheduled:status'; data: unknown }
  | { channel: 'channels:updated'; data: unknown }
  | { channel: 'control:status-changed'; data: unknown }
  | { channel: 'control:pairing-request'; data: unknown }
  | { channel: 'net:updated'; data: import('../shared/net/local').NetStatus }

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
      'control:status-changed',
      'control:pairing-request',
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
