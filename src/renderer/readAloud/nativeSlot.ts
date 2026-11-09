import type { KokoroTtsModel, NativeSpeechResult } from '../../shared/readAloud'
import type { LocalTtsWorkerEvent, LocalTtsWorkerRequest } from './localTtsWorker'

/** What the read aloud engine uses of a worker; a WebAssembly `Worker` or a `NativeTtsSlot`. */
export interface TtsWorker {
  /**
   * True when `cancel` stops a segment being voiced. A WebAssembly worker cannot be interrupted
   * and only drops the result, so a stopped read terminates and replaces it instead.
   */
  readonly cancelsInPlace?: boolean
  postMessage(message: LocalTtsWorkerRequest): void
  addEventListener(type: 'message', listener: (event: MessageEvent<LocalTtsWorkerEvent>) => void): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<LocalTtsWorkerEvent>) => void): void
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  terminate(): void
}

interface SpeakRequest {
  id: number
  text: string
  voice: string
  speed: number
}

/** Set once a slot could not start; Kokoro then runs on WebAssembly until the app restarts. */
let nativeUnavailable = false

/** True after a native slot failed to start in this app session. */
export function nativeKokoroUnavailable(): boolean {
  return nativeUnavailable
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function errorEvent(message: string): ErrorEvent {
  return Object.assign(new Event('error'), { message }) as ErrorEvent
}

/**
 * Kokoro on a native engine slot (the voice engine process main runs), behind the same messages
 * as the WebAssembly worker. Requests run one at a time in the order they were sent. `cancel` and
 * `terminate` stop a segment being voiced at once.
 *
 * When the slot cannot start, or its engine ends before it voiced anything, Kokoro is switched to
 * WebAssembly for the rest of the app session: this slot starts `createFallback()` and hands it the
 * requests that got no answer, so the read carries on. Once the slot has voiced a segment, losing
 * its engine is an `error` event, as a crashed worker is. A segment the engine could not voice is
 * an `error` message for that request and never switches.
 */
export class NativeTtsSlot implements TtsWorker {
  private readonly events = new EventTarget()
  private state: 'opening' | 'open' | 'fallback' | 'failed' | 'closed' = 'opening'
  private slotId: number | null = null
  private readonly queue: SpeakRequest[] = []
  private running: SpeakRequest | null = null
  private readonly cancelled = new Set<number>()
  private voiced = false
  private fallback: TtsWorker | null = null
  private unsubscribeExit: (() => void) | null

  constructor(
    model: KokoroTtsModel,
    private readonly createFallback: () => TtsWorker
  ) {
    const api = window.mousse.readAloud
    this.unsubscribeExit = api.onNativeSlotExit((slotId) => {
      if (slotId === this.slotId) this.onSlotFailed(new Error('The voice engine stopped unexpectedly'))
    })
    api.nativeOpen(model.id).then(
      (slotId) => {
        if (this.state === 'closed') {
          void api.nativeClose(slotId).catch(() => undefined)
          return
        }
        if (this.state !== 'opening') return
        this.slotId = slotId
        this.state = 'open'
        this.pump()
      },
      (error: unknown) => this.onSlotFailed(error)
    )
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<LocalTtsWorkerEvent>) => void): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  addEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
    this.events.addEventListener(type, listener as EventListener)
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<LocalTtsWorkerEvent>) => void): void
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
    this.events.removeEventListener(type, listener as EventListener)
  }

  get cancelsInPlace(): boolean {
    return this.state === 'opening' || this.state === 'open'
  }

  postMessage(message: LocalTtsWorkerRequest): void {
    if (this.state === 'fallback') {
      this.fallback?.postMessage(message)
    } else if (message.type === 'speak') {
      if (this.state === 'closed' || this.state === 'failed') return
      this.queue.push({ id: message.id, text: message.text, voice: message.voice, speed: message.speed })
      this.pump()
    } else if (message.type === 'cancel') {
      const queued = this.queue.findIndex((request) => request.id === message.id)
      if (queued >= 0) {
        this.queue.splice(queued, 1)
      } else if (this.running?.id === message.id && !this.cancelled.has(message.id)) {
        this.cancelled.add(message.id)
        // Only this slot's running segment is in main, so cancelling the slot stops just that one.
        if (this.slotId !== null) void window.mousse.readAloud.nativeCancel(this.slotId).catch(() => undefined)
      }
    }
  }

  terminate(): void {
    if (this.state === 'closed') return
    const slotId = this.slotId
    this.state = 'closed'
    this.slotId = null
    this.unsubscribe()
    this.queue.length = 0
    this.running = null
    this.fallback?.terminate()
    if (slotId !== null) void window.mousse.readAloud.nativeClose(slotId).catch(() => undefined)
  }

  private unsubscribe(): void {
    this.unsubscribeExit?.()
    this.unsubscribeExit = null
  }

  private emit(data: LocalTtsWorkerEvent): void {
    this.events.dispatchEvent(new MessageEvent('message', { data }))
  }

  private pump(): void {
    if (this.state !== 'open' || this.running || this.slotId === null) return
    const request = this.queue.shift()
    if (!request) return
    this.running = request
    window.mousse.readAloud.nativeSpeak(this.slotId, request.text, request.voice, request.speed).then(
      (result: NativeSpeechResult) => {
        if (this.running !== request) return
        this.running = null
        const dropped = this.cancelled.delete(request.id)
        if ('error' in result) {
          if (!dropped) this.emit({ type: 'error', id: request.id, message: result.error })
        } else {
          this.voiced = true
          if (!dropped) this.emit({ type: 'audio', id: request.id, samples: result.samples, sampleRate: result.sampleRate })
        }
        this.pump()
      },
      (error: unknown) => {
        if (this.running === request) this.onSlotFailed(error)
      }
    )
  }

  /** The slot could not open, or its engine ended. */
  private onSlotFailed(error: unknown): void {
    if (this.state !== 'opening' && this.state !== 'open') return
    const slotId = this.slotId
    this.slotId = null
    this.unsubscribe()
    if (slotId !== null) void window.mousse.readAloud.nativeClose(slotId).catch(() => undefined)
    if (this.voiced) {
      this.state = 'failed'
      this.running = null
      this.queue.length = 0
      this.events.dispatchEvent(errorEvent(errorMessage(error) || 'The local voice engine stopped unexpectedly'))
      return
    }
    if (!nativeUnavailable) {
      nativeUnavailable = true
      console.warn(`Read aloud runs Kokoro on WebAssembly for this session: the native engine did not start (${errorMessage(error)})`)
    }
    this.state = 'fallback'
    const unanswered = [this.running, ...this.queue].filter(
      (request): request is SpeakRequest => request !== null && !this.cancelled.has(request.id)
    )
    this.running = null
    this.queue.length = 0
    this.cancelled.clear()
    const fallback = this.createFallback()
    this.fallback = fallback
    fallback.addEventListener('message', (event) => {
      if (event.data.type !== 'file-request') this.emit(event.data)
    })
    fallback.addEventListener('error', (event) => this.events.dispatchEvent(errorEvent(event.message)))
    for (const request of unanswered) fallback.postMessage({ type: 'speak', ...request })
  }
}
