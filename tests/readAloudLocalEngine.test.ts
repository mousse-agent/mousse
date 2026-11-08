import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeakOptions } from '../src/renderer/readAloud/playback'
import type { LocalTtsModelId, NativeSpeechResult } from '../src/shared/readAloud'
import { PauseGate } from '../src/renderer/readAloud/playback'
import { splitSpeechSegments } from '../src/renderer/readAloud/speechText'

vi.mock('../src/renderer/speech/audioLevels', () => ({
  createLevelMeter: () => ({ analyser: { connect: () => undefined }, levels: () => [] })
}))

type Engine = typeof import('../src/renderer/readAloud/localEngine')

const IDLE_MS = 5 * 60_000
const SAMPLE_RATE = 24_000

/** One segment, so one worker. */
const SHORT = 'Hello there, this is the first message.'
const OTHER_SHORT = 'And this is the next paragraph.'
/** Two segments, so two workers. */
const LONG =
  'The quick brown fox jumps over the lazy dog at dusk. ' +
  'Meanwhile the river keeps running past the old stone bridge and the quiet village.'

const loud = (): Float32Array => new Float32Array(2400).fill(0.3)

interface SpeakRequest {
  type: 'speak'
  id?: number
  text: string
  voice: string
}

/** A worker or a native slot as the tests see it, in the order the engine created them. */
interface FakeEngine {
  terminated: number
  speakRequests(): SpeakRequest[]
  /** Sends loud audio for every request that has not been answered. Returns true if it answered any. */
  answerPending(): boolean
  /** The engine stops unexpectedly. */
  fail(message: string): void
}

let engines: FakeEngine[] = []

/** Stands in for a WebAssembly worker: records what the page sends and lets a test answer or fail it. */
class FakeWorker extends EventTarget implements FakeEngine {
  readonly posted: Array<{ type: string; id?: number }> = []
  readonly answered = new Set<number>()
  terminated = 0

  constructor(
    readonly url: URL,
    readonly options?: WorkerOptions
  ) {
    super()
    engines.push(this)
  }

  postMessage(message: { type: string; id?: number }): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated++
  }

  speakRequests(): SpeakRequest[] {
    return this.posted.filter((message): message is SpeakRequest => message.type === 'speak')
  }

  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  fail(message: string): void {
    this.dispatchEvent(Object.assign(new Event('error'), { message }))
  }

  answerPending(): boolean {
    let answered = false
    for (const request of this.speakRequests()) {
      if (this.answered.has(request.id!)) continue
      this.answered.add(request.id!)
      this.reply({ type: 'audio', id: request.id, samples: loud(), sampleRate: SAMPLE_RATE })
      answered = true
    }
    return answered
  }
}

interface NativeRequest extends SpeakRequest {
  resolve: (result: NativeSpeechResult) => void
  reject: (error: Error) => void
  answered: boolean
}

/** Stands in for a native slot behind `window.mousse.readAloud.native*`. */
class FakeSlot implements FakeEngine {
  static exitListeners = new Set<(slotId: number) => void>()
  static next = 1
  readonly id = FakeSlot.next++
  readonly requests: NativeRequest[] = []
  terminated = 0

  constructor(readonly modelId: string) {
    engines.push(this)
  }

  speakRequests(): SpeakRequest[] {
    return this.requests
  }

  answerPending(): boolean {
    let answered = false
    for (const request of this.requests) {
      if (request.answered) continue
      request.answered = true
      request.resolve({ samples: loud(), sampleRate: SAMPLE_RATE })
      answered = true
    }
    return answered
  }

  close(error: Error): void {
    for (const request of this.requests) {
      if (!request.answered) request.reject(error)
      request.answered = true
    }
  }

  fail(): void {
    this.close(new Error('The voice engine stopped unexpectedly'))
    for (const listener of FakeSlot.exitListeners) listener(this.id)
  }
}

const slots = new Map<number, FakeSlot>()

function fakeNative() {
  return {
    nativeOpen: vi.fn(async (modelId: string) => {
      const slot = new FakeSlot(modelId)
      slots.set(slot.id, slot)
      return slot.id
    }),
    nativeSpeak: vi.fn(
      (slotId: number, text: string, voice: string) =>
        new Promise<NativeSpeechResult>((resolve, reject) => {
          slots.get(slotId)!.requests.push({ type: 'speak', text, voice, resolve, reject, answered: false })
        })
    ),
    nativeClose: vi.fn(async (slotId: number) => {
      const slot = slots.get(slotId)!
      slot.terminated++
      slot.close(new Error('The voice engine was stopped'))
    }),
    onNativeSlotExit: vi.fn((listener: (slotId: number) => void) => {
      FakeSlot.exitListeners.add(listener)
      return () => FakeSlot.exitListeners.delete(listener)
    })
  }
}

/** Lets promise callbacks (native slot replies, `onClip`) run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Answers every request, including the ones the answers lead to. */
async function answerAll(): Promise<void> {
  await flush()
  while (engines.some((engine) => engine.answerPending())) await flush()
}

interface FakeSource {
  onended: (() => void) | null
}

class FakeAudioContext {
  static sources: FakeSource[] = []
  readonly currentTime = 0
  readonly sampleRate = SAMPLE_RATE
  readonly destination = {}
  suspend = async (): Promise<void> => undefined
  resume = async (): Promise<void> => undefined
  close = async (): Promise<void> => undefined
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel: () => undefined }
  }
  createBufferSource(): FakeSource & { connect: () => void; start: () => void; stop: () => void } {
    const source = { onended: null as (() => void) | null, connect: () => undefined, start: () => undefined, stop: () => undefined }
    FakeAudioContext.sources.push(source)
    return source
  }
}

interface Read {
  done: Promise<void>
  controller: AbortController
  onPlaying: ReturnType<typeof vi.fn>
}

let engine: Engine
let native: ReturnType<typeof fakeNative>

function startRead(text: string, controller = new AbortController(), modelId: LocalTtsModelId = 'kokoro-82m'): Read {
  const onPlaying = vi.fn()
  const options: SpeakOptions = {
    signal: controller.signal,
    onPlaying,
    voice: undefined,
    speed: () => 1,
    pause: new PauseGate(),
    onLevels: () => undefined
  }
  return { done: engine.speakWithLocalModel(modelId, text, options), controller, onPlaying }
}

/** Voices every segment, plays every clip to its end and waits for the read to resolve. */
async function finishRead(read: Read): Promise<void> {
  await answerAll()
  for (const source of [...FakeAudioContext.sources]) source.onended?.()
  await read.done
}

const workers = (): FakeWorker[] => engines.filter((entry): entry is FakeWorker => entry instanceof FakeWorker)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  engines = []
  slots.clear()
  FakeSlot.exitListeners.clear()
  FakeAudioContext.sources = []
  native = fakeNative()
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('window', { mousse: { readAloud: { readLocalModelFile: vi.fn(async () => new Uint8Array()), ...native } } })
  // The engine keeps its worker pool, timer and request ids at module level.
  vi.resetModules()
  engine = await import('../src/renderer/readAloud/localEngine')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('local read aloud keeps the model loaded between reads', () => {
  it('reuses the loaded slot when the next message starts well after the previous one ended', async () => {
    await finishRead(startRead(SHORT))
    const [slot] = engines
    expect(engines).toHaveLength(1)

    // Moving on to another paragraph takes longer than the old 15 second delay.
    await vi.advanceTimersByTimeAsync(30_000)
    const next = startRead(OTHER_SHORT)
    await flush()

    expect(engines).toHaveLength(1)
    expect(slot.terminated).toBe(0)
    expect(slot.speakRequests()).toHaveLength(2)
    await finishRead(next)
    expect(next.onPlaying).toHaveBeenCalledTimes(1)
  })

  it('drops every slot exactly five minutes after the last read ended, and the next read starts fresh', async () => {
    expect(splitSpeechSegments(LONG)).toHaveLength(2)
    await finishRead(startRead(LONG))
    expect(engines).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(engines.map((entry) => entry.terminated)).toEqual([0, 0])

    await vi.advanceTimersByTimeAsync(1)
    expect(engines.map((entry) => entry.terminated)).toEqual([1, 1])

    await finishRead(startRead(SHORT))
    expect(engines).toHaveLength(3)
  })

  it('keeps the slots for as long as a read is still playing', async () => {
    const read = startRead(LONG)
    await vi.advanceTimersByTimeAsync(2 * IDLE_MS)
    expect(engines.map((entry) => entry.terminated)).toEqual([0, 0])

    await finishRead(read)
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(engines.map((entry) => entry.terminated)).toEqual([0, 0])
  })

  it('counts the delay from the end of the latest read, not from an earlier one', async () => {
    await finishRead(startRead(SHORT))
    await vi.advanceTimersByTimeAsync(4 * 60_000)

    const second = startRead(OTHER_SHORT)
    // The first read's deadline passes while the second is still being voiced.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const [slot] = engines
    expect(slot.terminated).toBe(0)

    await finishRead(second)
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(slot.terminated).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(slot.terminated).toBe(1)
  })
})

describe('local read aloud when a read is cut short', () => {
  it('keeps the workers when the read is stopped before any audio arrives', async () => {
    const read = startRead(SHORT)
    await flush()
    const [slot] = engines

    read.controller.abort()
    await read.done
    await flush()

    expect(slot.terminated).toBe(0)
    // A reply for the stopped read arrives late and must not start any sound.
    slot.answerPending()
    await flush()
    expect(FakeAudioContext.sources).toHaveLength(0)

    const next = startRead(OTHER_SHORT)
    expect(engines).toHaveLength(1)
    await finishRead(next)
    expect(next.onPlaying).toHaveBeenCalledTimes(1)
  })

  it('starts no worker for empty text or a read that was already stopped', async () => {
    await startRead('   ').done
    const stopped = new AbortController()
    stopped.abort()
    await startRead(SHORT, stopped).done

    expect(engines).toHaveLength(0)
  })

  it('drops the workers at once when a worker fails, and the next read starts fresh', async () => {
    const read = startRead(SHORT, new AbortController(), 'kitten-tts-micro')
    const [worker] = workers()
    const outcome = expect(read.done).rejects.toThrow('boom')

    worker.fail('boom')
    await outcome

    expect(worker.terminated).toBe(1)
    await finishRead(startRead(OTHER_SHORT, new AbortController(), 'kitten-tts-micro'))
    expect(engines).toHaveLength(2)
  })

  it('drops the slots when a slot that already voiced stops unexpectedly', async () => {
    await finishRead(startRead(SHORT))
    const read = startRead(OTHER_SHORT)
    await flush()
    const outcome = expect(read.done).rejects.toThrow('stopped unexpectedly')

    engines[0].fail('gone')
    await outcome

    expect(engines[0].terminated).toBe(1)
    expect(engines).toHaveLength(1)
  })

  it('drops the slots at once when the model is removed, without waiting for the delay', async () => {
    await finishRead(startRead(SHORT))
    const [slot] = engines

    engine.disposeLocalEngine()
    expect(slot.terminated).toBe(1)

    await finishRead(startRead(OTHER_SHORT))
    expect(engines).toHaveLength(2)
  })

})

describe('local synthesis for a phone', () => {
  const synthesize = (text: string, onClip: (samples: Float32Array, rate: number) => void | Promise<void>, controller = new AbortController()) =>
    engine.synthesizeWithLocalModel('kokoro-82m', text, { signal: controller.signal, voice: undefined, speed: 1, onClip })

  it('hands over the next clip only after the receiver finished the one before', async () => {
    expect(splitSpeechSegments(LONG)).toHaveLength(2)
    const gates: Array<() => void> = []
    const done = synthesize(LONG, () => new Promise<void>((resolve) => gates.push(resolve)))
    await answerAll()
    // Both segments are voiced, but the second waits for the receiver of the first.
    expect(gates).toHaveLength(1)
    gates[0]()
    await flush()
    expect(gates).toHaveLength(2)
    gates[1]()
    await done
  })

  it('keeps voicing within the lookahead of what the receiver took', async () => {
    const text = Array.from({ length: 60 }, () => LONG).join('\n\n')
    const total = splitSpeechSegments(text).length
    expect(total).toBeGreaterThan(30)
    const gates: Array<() => void> = []
    const controller = new AbortController()
    const done = synthesize(text, () => new Promise<void>((resolve) => gates.push(resolve)), controller)
    await answerAll()
    await answerAll()
    const requested = engines.reduce((count, entry) => count + entry.speakRequests().length, 0)
    expect(gates).toHaveLength(1)
    // Eight segments ahead of the one being received, and a little slack for the pool.
    expect(requested).toBeLessThanOrEqual(12)
    controller.abort()
    await done
  })

  it('fails when the receiver fails', async () => {
    const done = synthesize(SHORT, () => Promise.reject(new Error('phone gone')))
    const outcome = expect(done).rejects.toThrow('phone gone')
    await answerAll()
    await outcome
  })

  it('stops handing over clips once aborted while the receiver is busy', async () => {
    const gates: Array<() => void> = []
    const controller = new AbortController()
    const onClip = vi.fn(() => new Promise<void>((resolve) => gates.push(resolve)))
    const done = synthesize(LONG, onClip, controller)
    await answerAll()
    controller.abort()
    gates[0]()
    await done
    await flush()
    expect(onClip).toHaveBeenCalledTimes(1)
  })

})

describe('local read aloud with more than one model', () => {
  it('starts the worker of the model family and tells it which model to run', async () => {
    await finishRead(startRead(SHORT, new AbortController(), 'kitten-tts-micro'))
    await finishRead(startRead(OTHER_SHORT))

    const [kitten] = workers()
    expect(kitten.url.pathname).toMatch(/kittenWorker\.ts$/)
    expect(kitten.posted[0]).toEqual({ type: 'init', modelId: 'kitten-tts-micro' })
    // Kokoro runs on a native slot instead of a worker.
    expect(workers()).toHaveLength(1)
    expect(native.nativeOpen).toHaveBeenCalledWith('kokoro-82m')
  })

  it('replaces the workers when another model is read, and keeps them for the same model', async () => {
    await finishRead(startRead(SHORT, new AbortController(), 'kitten-tts-nano'))
    await finishRead(startRead(OTHER_SHORT, new AbortController(), 'kitten-tts-nano'))
    expect(engines).toHaveLength(1)

    await finishRead(startRead(SHORT, new AbortController(), 'kitten-tts-mini'))
    expect(engines).toHaveLength(2)
    expect(engines[0].terminated).toBe(1)
    expect(engines[1].terminated).toBe(0)
  })

  it('starts the Supertonic worker for Supertonic', async () => {
    await finishRead(startRead(SHORT, new AbortController(), 'supertonic-3'))
    const [worker] = workers()
    expect(worker.url.pathname).toMatch(/supertonicWorker\.ts$/)
    expect(worker.posted[0]).toEqual({ type: 'init', modelId: 'supertonic-3' })
    expect(worker.speakRequests()[0]).toMatchObject({ voice: 'F1' })
  })

  it('runs Supertonic on one worker even for a long message, since one loaded copy is large', async () => {
    expect(splitSpeechSegments(LONG)).toHaveLength(2)
    await finishRead(startRead(LONG, new AbortController(), 'supertonic-3'))
    expect(engines).toHaveLength(1)
  })

  it("starts the Pocket worker for a Pocket language, with that language's default voice", async () => {
    await finishRead(startRead(SHORT, new AbortController(), 'pocket-tts-fr'))
    const [worker] = workers()
    expect(worker.url.pathname).toMatch(/pocketWorker\.ts$/)
    expect(worker.posted[0]).toEqual({ type: 'init', modelId: 'pocket-tts-fr' })
    expect(worker.speakRequests()[0]).toMatchObject({ voice: 'alba' })
  })

  it('asks for the default voice of the chosen model', async () => {
    const read = startRead(SHORT, new AbortController(), 'kitten-tts-micro')
    expect(workers()[0].speakRequests()[0]).toMatchObject({ voice: 'Bella' })
    await finishRead(read)

    const kokoro = startRead(SHORT)
    await flush()
    expect(engines.at(-1)!.speakRequests()[0]).toMatchObject({ voice: 'af_heart' })
    await finishRead(kokoro)
  })

  it('fails the read for a model that no longer exists', async () => {
    await expect(startRead(SHORT, new AbortController(), 'gone' as LocalTtsModelId).done).rejects.toThrow('not available')
    expect(engines).toHaveLength(0)
  })

  it('ends a read when a phone starts another model, instead of leaving it waiting on stopped slots', async () => {
    const read = startRead(LONG)
    const outcome = expect(read.done).rejects.toThrow('another voice model')
    const kokoro = [...engines]
    const phone = engine.synthesizeWithLocalModel('pocket-tts-fr', SHORT, { signal: new AbortController().signal, voice: undefined, speed: 1, onClip: () => undefined })

    await outcome
    await flush()
    expect(kokoro.map((entry) => entry.terminated)).toEqual([1, 1])
    await answerAll()
    await phone

    // Neither job is left counted as running, so the Pocket worker is still dropped when idle.
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(engines.at(-1)?.terminated).toBe(1)
  })

  it('runs Supertonic on one worker for a phone too', async () => {
    expect(splitSpeechSegments(LONG)).toHaveLength(2)
    const onClip = vi.fn()
    const done = engine.synthesizeWithLocalModel('supertonic-3', LONG, { signal: new AbortController().signal, voice: undefined, speed: 1, onClip })
    expect(engines).toHaveLength(1)
    await answerAll()
    await done
    expect(onClip).toHaveBeenCalledTimes(2)
    expect(engines).toHaveLength(1)
  })
})
