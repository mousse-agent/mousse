import { findLocalTtsModel, type LocalTtsModel, type LocalTtsModelId } from '../../shared/readAloud'
import type { LocalTtsWorkerEvent, LocalTtsWorkerRequest } from './localTtsWorker'
import { CLIP_GAP_SECONDS, MAX_START_DELAY_SECONDS, startDelaySeconds, trimSilence, type SegmentTiming } from './localPlayback'
import type { SpeakOptions } from './playback'
import { createLevelMeter } from '../speech/audioLevels'
import { serveModelFiles } from '../speechModels/pageSupport'
import { NativeTtsSlot, nativeKokoroUnavailable, type TtsWorker } from './nativeSlot'
import { splitSpeechSegments } from './speechText'

/**
 * The models run on one WebAssembly thread per worker (only dictation asks for more), at roughly
 * 0.6x to 0.7x real time. Two workers voicing consecutive segments in parallel stay ahead of
 * playback.
 */
const POOL_SIZE = 2
/** Kokoro's native engine voices about 3x real time, so one slot stays ahead of playback. */
const NATIVE_POOL_SIZE = 1
/** Segments voiced ahead of the one playing; each holds a few seconds of audio. */
const LOOKAHEAD_SEGMENTS = 8
/**
 * A loaded worker holds about 500 MB that is only returned when the worker ends, and an open
 * native slot keeps its engine's model loaded, so the pool is shut down after the last playback.
 * The delay is long enough that reading the next paragraph does not pay for loading the model
 * again.
 */
const IDLE_DISPOSE_MS = 5 * 60_000

/**
 * The workers of the model that was used last; another model replaces them. `leases` records which
 * running reads and phone jobs use each worker, so a stopped one can tell whether a worker still
 * voicing its segment is needed by anyone else.
 */
let pool: { model: LocalTtsModel; workers: TtsWorker[]; leases: Map<TtsWorker, Set<object>> } | null = null
/** True while `disposeLocalEngine` ends the jobs; no worker is replaced meanwhile. */
let disposing = false
let lastRequestId = 0
let activeSessions = 0
/** Ends each running read or phone job with an error; its workers are about to be terminated. */
const sessionStops = new Set<(error: Error) => void>()
let idleTimer: ReturnType<typeof setTimeout> | null = null

function send(target: TtsWorker, message: LocalTtsWorkerRequest): void {
  target.postMessage(message)
}

/** Kokoro runs natively unless its engine failed to start this session; the others run on WebAssembly. */
const runsNatively = (model: LocalTtsModel): boolean => model.runtime === 'kokoro' && !nativeKokoroUnavailable()

/** Kokoro gets a native slot unless one failed to start this session; the others get WebAssembly workers. */
function createWorker(model: LocalTtsModel): TtsWorker {
  if (model.runtime === 'kokoro' && !nativeKokoroUnavailable()) return new NativeTtsSlot(model, () => createWebWorker(model))
  return createWebWorker(model)
}

/** Each model family runs in its own worker file. */
function createWebWorker(model: LocalTtsModel): Worker {
  let created: Worker
  switch (model.runtime) {
    case 'kitten':
      created = new Worker(new URL('./kittenWorker.ts', import.meta.url), { type: 'module' })
      break
    case 'supertonic':
      created = new Worker(new URL('./supertonicWorker.ts', import.meta.url), { type: 'module' })
      break
    case 'pocket':
      created = new Worker(new URL('./pocketWorker.ts', import.meta.url), { type: 'module' })
      break
    default:
      created = new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' })
  }
  serveModelFiles(created, (path) => window.mousse.readAloud.readLocalModelFile(model.id, path))
  send(created, { type: 'init', modelId: model.id })
  return created
}

/**
 * Starts workers for `model` for `segments` segments: one for a one-segment message, and never
 * more than the model allows. Another model's workers are replaced, ending the jobs using them.
 * The returned workers are leased to `lease` until `releaseWorkers`.
 */
function ensurePool(model: LocalTtsModel, segments: number, lease: object): TtsWorker[] {
  if (pool && pool.model.id !== model.id) disposeLocalEngine('Reading stopped because another voice model started')
  pool ??= { model, workers: [], leases: new Map() }
  const size = Math.min(runsNatively(model) ? NATIVE_POOL_SIZE : (model.maxWorkers ?? POOL_SIZE), segments)
  while (pool.workers.length < size) pool.workers.push(createWorker(model))
  const workers = pool.workers.slice(0, size)
  for (const worker of workers) {
    const holders = pool.leases.get(worker) ?? new Set<object>()
    holders.add(lease)
    pool.leases.set(worker, holders)
  }
  return workers
}

/**
 * Ends `lease` on its workers. A native slot still voicing one of its segments gets `cancel`,
 * which stops it at once. A WebAssembly worker still voicing one is terminated and replaced at
 * once when no other running job holds it, because its synthesis cannot be interrupted and the
 * next read would wait behind it; the replacement loads the model before the next read needs it.
 * A worker another job holds only gets `cancel`, which drops the result.
 */
function releaseWorkers(lease: object, workers: readonly TtsWorker[], inFlight: ReadonlyMap<number, { worker: TtsWorker }>): void {
  const current = disposing ? null : pool
  for (const worker of workers) current?.leases.get(worker)?.delete(lease)
  for (const [id, { worker }] of inFlight) {
    const index = current ? current.workers.indexOf(worker) : -1
    if (current && index >= 0 && !worker.cancelsInPlace && !current.leases.get(worker)?.size) {
      current.leases.delete(worker)
      worker.terminate()
      current.workers[index] = createWorker(current.model)
    } else {
      send(worker, { type: 'cancel', id })
    }
  }
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

/**
 * Drops the loaded model, e.g. after its files were deleted or when it has been idle. Jobs still
 * using it fail with `reason` instead of waiting for workers that no longer answer.
 */
export function disposeLocalEngine(reason = 'The voice model was unloaded while reading'): void {
  cancelIdleDispose()
  disposing = true
  try {
    for (const worker of pool?.workers ?? []) worker.terminate()
    pool = null
    for (const stop of [...sessionStops]) stop(new Error(reason))
  } finally {
    disposing = false
  }
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
    const lease = {}
    const workers = ensurePool(model, segments.length, lease)
    const context = new AudioContext()
    if (pause.paused) void context.suspend().catch(() => undefined)
    else void context.resume().catch(() => undefined)
    const meter = createLevelMeter(context)
    meter.analyser.connect(context.destination)
    onLevels(meter.levels)
    const states: SegmentState[] = segments.map((segment) => ({ chars: segment.length }))
    const inFlight = new Map<number, { index: number; worker: TtsWorker }>()
    const busy = new Set<TtsWorker>()
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
      sessionStops.delete(settle)
      activeSessions--
      if (activeSessions === 0) scheduleIdleDispose()
      if (startTimer) clearTimeout(startTimer)
      unsubscribePause()
      for (const worker of workers) {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onWorkerError)
      }
      releaseWorkers(lease, workers, inFlight)
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
    // Ends every job on the pool, this one included, without replacing the failed worker first.
    const onWorkerError = (event: ErrorEvent): void => disposeLocalEngine(event.message || 'The local voice engine stopped unexpectedly')
    const onAbort = (): void => settle()

    for (const worker of workers) {
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onWorkerError)
    }
    signal.addEventListener('abort', onAbort)
    sessionStops.add(settle)
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
    const lease = {}
    const workers = ensurePool(model, segments.length, lease)
    const results: Array<{ samples: Float32Array; sampleRate: number } | undefined> = []
    const inFlight = new Map<number, { index: number; worker: TtsWorker }>()
    const busy = new Set<TtsWorker>()
    let nextDispatch = 0
    let nextEmit = 0
    let emitting = false
    let settled = false

    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      sessionStops.delete(settle)
      activeSessions--
      if (activeSessions === 0) scheduleIdleDispose()
      for (const worker of workers) {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onWorkerError)
      }
      releaseWorkers(lease, workers, inFlight)
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
    // Ends every job on the pool, this one included, without replacing the failed worker first.
    const onWorkerError = (event: ErrorEvent): void => disposeLocalEngine(event.message || 'The local voice engine stopped unexpectedly')
    const onAbort = (): void => settle()

    for (const worker of workers) {
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onWorkerError)
    }
    signal.addEventListener('abort', onAbort)
    sessionStops.add(settle)
    dispatch()
  })
}
