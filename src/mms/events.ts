import { EventEmitter } from 'events'

export type MmsEvent =
  | { channel: 'projects:updated'; data: unknown }
  | { channel: 'threads:updated'; data: unknown }
  | { channel: 'scheduled:updated'; data: unknown }
  | { channel: 'scheduled:status'; data: unknown }
  | { channel: 'channels:updated'; data: unknown }
  | { channel: 'agents:updated'; data: unknown }
  | { channel: 'tasks:updated'; data: unknown }

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

  onAny(handler: (channel: string, data: unknown) => void): void {
    this.emitter.on('projects:updated', (data) => handler('projects:updated', data))
    this.emitter.on('threads:updated', (data) => handler('threads:updated', data))
    this.emitter.on('scheduled:updated', (data) => handler('scheduled:updated', data))
    this.emitter.on('scheduled:status', (data) => handler('scheduled:status', data))
    this.emitter.on('channels:updated', (data) => handler('channels:updated', data))
    this.emitter.on('agents:updated', (data) => handler('agents:updated', data))
    this.emitter.on('tasks:updated', (data) => handler('tasks:updated', data))
  }
}
