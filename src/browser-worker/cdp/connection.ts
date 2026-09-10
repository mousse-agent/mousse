import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { fail } from '../errors'
import { CdpAsciiDecoder, encodeCdpMessage } from './framing'

export interface CdpCommandOptions {
  sessionId?: string
  timeoutMs?: number
  signal?: AbortSignal
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  onAbort?: () => void
  signal?: AbortSignal
  method: string
}

const DEFAULT_TIMEOUT_MS = 30_000

export class CdpDisconnectedError extends Error {
  constructor(message = 'CDP pipe disconnected') {
    super(message)
    this.name = 'CdpDisconnectedError'
  }
}

export class CdpConnection extends EventEmitter {
  private readonly decoder = new CdpAsciiDecoder()
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false
  private writeChain = Promise.resolve()

  constructor(private readonly reader: Readable, private readonly writer: Writable) {
    super()
    this.reader.on('data', (chunk: Buffer) => this.onData(chunk))
    this.reader.on('end', () => this.disconnect('CDP pipe ended'))
    this.reader.on('error', (error: Error) => this.disconnect(error.message))
    this.writer.on('error', (error: Error) => this.disconnect(error.message))
  }

  get connected(): boolean {
    return !this.closed
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>, options: CdpCommandOptions = {}): Promise<T> {
    if (this.closed) fail('worker_disconnected', 'CDP pipe is closed')
    const id = this.nextId++
    const message: Record<string, unknown> = { id, method }
    if (params && Object.keys(params).length) message.params = params
    if (options.sessionId) message.sessionId = options.sessionId
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const result = new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: (value) => resolve(value as T), reject, method }
      if (options.signal) {
        if (options.signal.aborted) {
          reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
          return
        }
        pending.signal = options.signal
        pending.onAbort = () => {
          this.pending.delete(id)
          if (pending.timer) clearTimeout(pending.timer)
          reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
        }
        options.signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      pending.timer = setTimeout(() => {
        this.pending.delete(id)
        if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
        reject(Object.assign(new Error(`CDP timeout: ${method}`), { code: 'timeout' }))
      }, timeoutMs)
      this.pending.set(id, pending)
    })
    this.enqueueWrite(encodeCdpMessage(message))
    return result
  }

  async close(): Promise<void> {
    this.disconnect('CDP connection closed')
  }

  private enqueueWrite(buffer: Buffer): void {
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.closed) {
            resolve()
            return
          }
          this.writer.write(buffer, (error) => (error ? reject(error) : resolve()))
        })
    ).catch((error) => {
      this.disconnect(error instanceof Error ? error.message : String(error))
    })
  }

  private onData(chunk: Buffer): void {
    try {
      this.decoder.push(chunk)
      for (const message of this.decoder.shiftAll()) this.dispatch(message)
    } catch (error) {
      this.disconnect(error instanceof Error ? error.message : String(error))
    }
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    const record = message as Record<string, unknown>
    if (typeof record.id === 'number') {
      const pending = this.pending.get(record.id)
      if (!pending) return
      this.pending.delete(record.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
      if (record.error && typeof record.error === 'object') {
        const err = record.error as { message?: unknown; code?: unknown }
        pending.reject(Object.assign(new Error(typeof err.message === 'string' ? err.message : 'CDP error'), { cdpCode: err.code }))
        return
      }
      pending.resolve(record.result)
      return
    }
    if (typeof record.method === 'string') {
      this.emit('event', record.method, record.params, typeof record.sessionId === 'string' ? record.sessionId : undefined)
      this.emit(record.method, record.params, typeof record.sessionId === 'string' ? record.sessionId : undefined)
    }
  }

  private disconnect(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.decoder.reset()
    const error = new CdpDisconnectedError(reason)
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
      pending.reject(error)
    }
    this.emit('disconnect', error)
    try { this.reader.destroy() } catch { /* already closed */ }
    try { this.writer.end() } catch { /* already closed */ }
  }
}
