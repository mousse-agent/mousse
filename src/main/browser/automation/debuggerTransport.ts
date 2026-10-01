import { CdpDisconnectedError } from '../../../browser-worker/cdp/connection'
import type { CdpCommandOptions, CdpEventListener, CdpTransport } from '../../../browser-worker/cdp/transport'
import { fail } from '../../../browser-worker/errors'
import type { GuestDebuggerHandle } from './guestHandle'

const DEFAULT_TIMEOUT_MS = 30_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cancellation?: Error
  timer?: ReturnType<typeof setTimeout>
  onAbort?: () => void
  signal?: AbortSignal
}

export interface DebuggerTransportOptions {
  /** Test seam: hold a CDP method before it reaches the guest. */
  interceptCommand?: (method: string, params?: Record<string, unknown>) => Promise<void> | void
  beforeKeyboardDispatch?: (signal?: AbortSignal) => Promise<void>
}

/**
 * CDP transport over Electron's per-WebContents debugger.
 * Does not discover unrelated targets.
 */
export class ElectronDebuggerTransport implements CdpTransport {
  private readonly listeners = new Map<string, Set<CdpEventListener>>()
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false
  private attachedByUs = false
  private readonly onMessage: (event: unknown, method: string, params: unknown, sessionId: string) => void
  private readonly onDetach: (event: unknown, reason: string) => void

  constructor(
    private readonly debuggerRef: GuestDebuggerHandle,
    private readonly options: DebuggerTransportOptions = {}
  ) {
    this.onMessage = (_event, method, params, sessionId) => {
      this.emit(method, params, sessionId || undefined)
    }
    this.onDetach = (_event, reason) => {
      this.disconnect(`Electron debugger detached: ${reason}`)
    }
  }

  get connected(): boolean {
    return !this.closed && this.debuggerRef.isAttached()
  }

  get attachedByThisBackend(): boolean {
    return this.attachedByUs
  }

  attach(): void {
    if (this.debuggerRef.isAttached()) {
      if (this.attachedByUs) return
      fail('unsupported', 'A debugger is already attached to this tab by another feature')
    }
    this.debuggerRef.attach('1.3')
    this.attachedByUs = true
    this.debuggerRef.on('message', this.onMessage)
    this.debuggerRef.on('detach', this.onDetach)
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>, options: CdpCommandOptions = {}): Promise<T> {
    if (this.closed || !this.debuggerRef.isAttached()) throw new CdpDisconnectedError('Electron debugger is not attached')
    if (this.options.interceptCommand) await this.options.interceptCommand(method, params)
    if (this.closed || !this.debuggerRef.isAttached()) throw new CdpDisconnectedError('Electron debugger is not attached')
    if (options.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
    if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent') {
      await this.options.beforeKeyboardDispatch?.(options.signal)
      if (this.closed || !this.debuggerRef.isAttached()) throw new CdpDisconnectedError('Electron debugger is not attached')
      if (options.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const sessionId = options.sessionId && options.sessionId.length > 0 ? options.sessionId : undefined
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: (value) => resolve(value as T), reject }
      if (options.signal) {
        pending.signal = options.signal
        pending.onAbort = () => {
          this.cancelPending(id, Object.assign(new Error('cancelled'), { code: 'cancelled' }))
        }
        options.signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      pending.timer = setTimeout(() => {
        this.cancelPending(id, Object.assign(new Error(`CDP timeout: ${method}`), { code: 'timeout' }))
        // Electron exposes no per-command cancellation. Detaching the debugger
        // we own is the only way to force a timed-out raw command to settle;
        // the session is invalidated and consequential dispatch stays unknown.
        if (this.attachedByUs) {
          try {
            if (this.debuggerRef.isAttached()) this.debuggerRef.detach()
          } catch { /* detach event/error will be reflected by raw settlement */ }
        }
      }, timeoutMs)
      this.pending.set(id, pending)
      let raw: Promise<unknown>
      try {
        raw = this.debuggerRef.sendCommand(method, params && Object.keys(params).length ? params : undefined, sessionId)
      } catch (error) {
        this.settle(id, undefined, error instanceof Error ? error : new Error(String(error)))
        return
      }
      void raw.then(
        (value) => this.settle(id, value, undefined),
        (error) => {
          const message = error instanceof Error ? error.message : String(error)
          if (/not attached|debugger is not attached|detached/i.test(message)) {
            this.settle(id, undefined, new CdpDisconnectedError(message))
          } else {
            this.settle(id, undefined, error instanceof Error ? error : new Error(message))
          }
        }
      )
    })
  }

  on(event: string, listener: CdpEventListener): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off(event: string, listener: CdpEventListener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  async close(): Promise<void> {
    this.disconnect('Electron debugger transport closed', true)
  }

  /**
   * Detach only if this backend attached the debugger.
   * Foreign attachments are left in place.
   */
  releaseAttachment(): void {
    this.disconnect('Electron debugger attachment released', true)
  }

  private settle(id: number, value: unknown, error: Error | undefined): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
    if (pending.cancellation) pending.reject(pending.cancellation)
    else if (error) pending.reject(error)
    else pending.resolve(value)
  }

  private cancelPending(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending || pending.cancellation) return
    pending.cancellation = error
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = undefined
    }
    if (pending.onAbort && pending.signal) {
      pending.signal.removeEventListener('abort', pending.onAbort)
      pending.onAbort = undefined
    }
  }

  private emit(event: string, params: unknown, sessionId?: string): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) listener(params, sessionId)
  }

  private disconnect(reason: string, detachIfOwned = false): void {
    if (this.closed) return
    this.closed = true
    try {
      this.debuggerRef.off('message', this.onMessage)
      this.debuggerRef.off('detach', this.onDetach)
    } catch { /* already gone */ }
    const error = new CdpDisconnectedError(reason)
    for (const [id, pending] of this.pending) {
      this.cancelPending(id, error)
    }
    this.emit('disconnect', { reason })
    if (detachIfOwned && this.attachedByUs) {
      this.attachedByUs = false
      try {
        if (this.debuggerRef.isAttached()) this.debuggerRef.detach()
      } catch { /* already detached */ }
    } else {
      this.attachedByUs = false
    }
  }
}
