import { findLocalTtsModel, type LocalTtsModel, type LocalTtsModelId } from '../../shared/readAloud'
import type { LocalTtsWorkerEvent, LocalTtsWorkerRequest } from './localTtsWorker'
import { CLIP_GAP_SECONDS, MAX_START_DELAY_SECONDS, startDelaySeconds, trimSilence, type SegmentTiming } from './localPlayback'
import type { SpeakOptions } from './playback'
import { createLevelMeter } from '../speech/audioLevels'
import { serveModelFiles } from '../speechModels/pageSupport'
import { splitSpeechSegments } from './speechText'

/**
 * The local models run on single-threaded WebAssembly (the window is not cross-origin isolated),
 * where one worker produces audio at roughly 0.6x to 0.7x real time. Two workers voicing
 * consecutive segments in parallel stay ahead of playback.
 */
const POOL_SIZE = 2
/** Segments voiced ahead of the one playing; each holds a few seconds of audio. */
const LOOKAHEAD_SEGMENTS = 8
/**
 * A loaded worker holds about 500 MB of WebAssembly memory that is only returned when the worker
 * ends, so the pool is shut down after the last playback. The delay is long enough that reading
 * the next paragraph does not pay for loading the model again.
 */
const IDLE_DISPOSE_MS = 5 * 60_000

/** The workers of the model that was used last; another model replaces them. */
let pool: { modelId: LocalTtsModelId; workers: Worker[] } | null = null
let lastRequestId = 0
let activeSessions = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null

function send(target: Worker, message: LocalTtsWorkerRequest): void {
  target.postMessage(message)
}

/** Each model family runs in its own worker file. */
function createWorker(model: LocalTtsModel): Worker {
  const created =
    model.runtime === 'kitten'
      ? new Worker(new URL('./kittenWorker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' })
  serveModelFiles(created, (path) => window.mousse.readAloud.readLocalModelFile(model.id, path))
  send(created, { type: 'init', modelId: model.id })
  return created
}

/** Starts workers for `model` up to `size`; a one-segment message needs only one. */
function ensurePool(model: LocalTtsModel, size: number): Worker[] {
  if (pool && pool.modelId !== model.id) disposeLocalEngine()
  pool ??= { modelId: model.id, workers: [] }
  while (pool.workers.length < size) pool.workers.push(createWorker(model))
  return pool.workers.slice(0, size)
}

function cancelIdleDispose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleDispose(): void {
  cancelIdleDispose()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (activeSessions === 0) disposeLocalEngine()
  }, IDLE_DISPOSE_MS)
}

/** Drops the loaded model, e.g. after its files were deleted or when it has been idle. */
export function disposeLocalEngine(): void {
  cancelIdleDispose()
  for (const worker of pool?.workers ?? []) worker.terminate()
  pool = null
}

interface SegmentState extends SegmentTiming {
  audio?: { samples: Float32Array; sampleRate: number }
}

const seconds = (): number => performance.now() / 1000

/** Speaks `text` with a local model. Resolves when playback ends or is aborted. */
export function speakWithLocalModel(
  modelId: LocalTtsModelId,
  text: string,
  { signal, onPlaying, voice, speed, pause, onLevels }: SpeakOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve()
    const model = findLocalTtsModel(modelId)
    if (!model) return reject(new Error('This voice model is not available'))
    const segments = splitSpeechSegments(text)
    if (segments.length === 0) return resolve()
    cancelIdleDispose()
    activeSessions++
    const workers = ensurePool(model, Math.min(POOL_SIZE, segments.length))
    const context = new AudioContext()
    if (pause.paused) void context.suspend().catch(() => undefined)
    else void context.resume().catch(() => undefined)
    const meter = createLevelMeter(context)
    meter.analyser.connect(context.destination)
    onLevels(meter.levels)
    const states: SegmentState[] = segments.map((segment) => ({ chars: segment.length }))
    const inFlight = new Map<number, { index: number; worker: Worker }>()
    const busy = new Set<Worker>()
    const sources = new Set<AudioBufferSourceNode>()
    let nextDispatch = 0
    let nextPlay = 0
    let nextStart = 0
    let started = false
    let firstReadyAt: number | null = null
    let startTimer: ReturnType<typeof setTimeout> | null = null
    let settled = false

    const unsubscribePause = pause.subscribe((paused) => {
      void (paused ? context.suspend() : context.resume()).catch(() => undefined)
    })

    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      activeSessions--
      if (activeSessions === 0) scheduleIdleDispose()
      if (startTimer) clearTimeout(startTimer)
      unsubscribePause()
      for (const worker of workers) {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onWorkerError)
      }
      for (const [id, { worker }] of inFlight) send(worker, { type: 'cancel', id })
      inFlight.clear()
      signal.removeEventListener('abort', onAbort)
      for (const source of sources) {
        source.onended = null
        try {
          source.stop()
        } catch {
          /* already stopped */
        }
      }
      sources.clear()
      void context.close().catch(() => undefined)
      if (error) reject(error)
      else resolve()
    }

    const dispatch = (): void => {
      for (const worker of workers) {
        if (nextDispatch >= segments.length || nextDispatch - nextPlay > LOOKAHEAD_SEGMENTS) return
        if (busy.has(worker)) continue
        const id = ++lastRequestId
        busy.add(worker)
        inFlight.set(id, { index: nextDispatch, worker })
        states[nextDispatch].startedAt = seconds()
        send(worker, { type: 'speak', id, text: segments[nextDispatch], voice: voice ?? model.defaultVoice, speed: speed() })
        nextDispatch++
      }
    }

    const schedule = (audio: { samples: Float32Array; sampleRate: number }): void => {
      if (audio.samples.length === 0) return
      const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate)
      buffer.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(meter.analyser)
      const startAt = Math.max(nextStart, context.currentTime + 0.05)
      nextStart = startAt + buffer.duration + CLIP_GAP_SECONDS
      sources.add(source)
      source.onended = () => {
        sources.delete(source)
        drain()
      }
      source.start(startAt)
      if (!started) {
        started = true
        onPlaying()
      }
    }

    // Holds the first clip until synthesis is far enough ahead that no later segment arrives late.
    const readyToStart = (): boolean => {
      if (started || nextPlay > 0) return true
      if (!states[0].audio) return false
      const now = seconds()
      firstReadyAt ??= now
      const delay = Math.min(startDelaySeconds(states, workers.length, now), MAX_START_DELAY_SECONDS - (now - firstReadyAt))
      if (delay <= 0.05) return true
      if (!startTimer) {
        startTimer = setTimeout(() => {
          startTimer = null
          drain()
        }, delay * 1000)
      }
      return false
    }

    // Schedules finished audio in segment order and ends once the last segment has played.
    const drain = (): void => {
      if (settled || !readyToStart()) return
      while (nextPlay < states.length) {
        const state = states[nextPlay]
        if (!state.audio) break
        schedule(state.audio)
        state.audio = undefined
        nextPlay++
        dispatch()
      }
      if (nextPlay >= states.length && sources.size === 0) settle()
    }

    const onMessage = (event: MessageEvent<LocalTtsWorkerEvent>): void => {
      const message = event.data
      if (message.type === 'file-request') return
      const request = inFlight.get(message.id)
      if (!request) return
      inFlight.delete(message.id)
      busy.delete(request.worker)
      if (message.type === 'error') {
        settle(new Error(message.message))
        return
      }
      const state = states[request.index]
      const samples = trimSilence(message.samples, message.sampleRate)
      state.audio = { samples, sampleRate: message.sampleRate }
      state.finishedAt = seconds()
      state.seconds = samples.length / message.sampleRate + CLIP_GAP_SECONDS
      dispatch()
      drain()
    }
    const onWorkerError = (event: ErrorEvent): void => {
      disposeLocalEngine()
      settle(new Error(event.message || 'The local voice engine stopped unexpectedly'))
    }
    const onAbort = (): void => settle()

    for (const worker of workers) {
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onWorkerError)
    }
    signal.addEventListener('abort', onAbort)
    dispatch()
  })
}

export interface SynthesizeOptions {
  signal: AbortSignal
  /** Voice name of the model; its default when undefined. */
  voice: string | undefined
  /** Speaking pace, applied by the model. */
  speed: number
  /**
   * Receives each segment's speech, trimmed of the model's padding, in order. The next segment is
   * handed over only after this returns, and voicing runs only a few segments ahead of what was
   * handed over, so a slow receiver does not pile up audio.
   */
  onClip: (samples: Float32Array, sampleRate: number) => void | Promise<void>
}

/**
 * Voices `text` with a local model without playing it, for a paired phone that plays the
 * audio itself. Segments go to the same worker pool as read aloud; each one is handed over as soon
 * as it and every segment before it are done. Resolves after the last segment, or when aborted;
 * rejects when a segment fails or `onClip` throws.
 */
export function synthesizeWithLocalModel(
  modelId: LocalTtsModelId,
  text: string,
  { signal, voice, speed, onClip }: SynthesizeOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve()
    const model = findLocalTtsModel(modelId)
    if (!model) return reject(new Error('This voice model is not available'))
    const segments = splitSpeechSegments(text)
    if (segments.length === 0) return resolve()
    cancelIdleDispose()
    activeSessions++
    const workers = ensurePool(model, Math.min(POOL_SIZE, segments.length))
    const results: Array<{ samples: Float32Array; sampleRate: number } | undefined> = []
    const inFlight = new Map<number, { index: number; worker: Worker }>()
    const busy = new Set<Worker>()
    let nextDispatch = 0
    let nextEmit = 0
    let emitting = false
    let settled = false

    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      activeSessions--
      if (activeSessions === 0) scheduleIdleDispose()
      for (const worker of workers) {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onWorkerError)
      }
      for (const [id, { worker }] of inFlight) send(worker, { type: 'cancel', id })
      inFlight.clear()
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }

    const dispatch = (): void => {
      for (const worker of workers) {
        if (nextDispatch >= segments.length || nextDispatch - nextEmit > LOOKAHEAD_SEGMENTS) return
        if (busy.has(worker)) continue
        const id = ++lastRequestId
        busy.add(worker)
        inFlight.set(id, { index: nextDispatch, worker })
        send(worker, { type: 'speak', id, text: segments[nextDispatch], voice: voice ?? model.defaultVoice, speed })
        nextDispatch++
      }
    }

    const onMessage = (event: MessageEvent<LocalTtsWorkerEvent>): void => {
      const message = event.data
      if (message.type === 'file-request') return
      const request = inFlight.get(message.id)
      if (!request) return
      inFlight.delete(message.id)
      busy.delete(request.worker)
      if (message.type === 'error') {
        settle(new Error(message.message))
        return
      }
      results[request.index] = { samples: trimSilence(message.samples, message.sampleRate), sampleRate: message.sampleRate }
      void emitReady()
      dispatch()
    }
    const emitReady = async (): Promise<void> => {
      if (emitting) return
      emitting = true
      try {
        while (!settled && nextEmit < segments.length && results[nextEmit]) {
          const clip = results[nextEmit]!
          results[nextEmit] = undefined
          if (clip.samples.length > 0) await onClip(clip.samples, clip.sampleRate)
          // Counted done only now, so voicing stays within the lookahead of what was handed over.
          nextEmit++
          if (signal.aborted || settled) return
          dispatch()
        }
        if (!settled && nextEmit >= segments.length) settle()
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
      } finally {
        emitting = false
      }
    }
    const onWorkerError = (event: ErrorEvent): void => {
      disposeLocalEngine()
      settle(new Error(event.message || 'The local voice engine stopped unexpectedly'))
    }
    const onAbort = (): void => settle()

    for (const worker of workers) {
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onWorkerError)
    }
    signal.addEventListener('abort', onAbort)
    dispatch()
  })
}
