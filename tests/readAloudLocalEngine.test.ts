import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeakOptions } from '../src/renderer/readAloud/playback'
import type { LocalTtsModelId } from '../src/shared/readAloud'
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
  'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the distant hills. ' +
  'Meanwhile the river keeps running past the old stone bridge and the quiet village by the shore.'

interface SpeakRequest {
  type: 'speak'
  id: number
}

/** Stands in for the Kokoro worker: records what the page sends and lets a test answer or fail it. */
class FakeWorker extends EventTarget {
  static all: FakeWorker[] = []
  readonly posted: Array<{ type: string; id?: number }> = []
  readonly answered = new Set<number>()
  terminated = 0

  constructor(
    readonly url: URL,
    readonly options?: WorkerOptions
  ) {
    super()
    FakeWorker.all.push(this)
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

  /** Sends loud audio for every request that has not been answered. Returns true if it answered any. */
  answerPending(): boolean {
    let answered = false
    for (const request of this.speakRequests()) {
      if (this.answered.has(request.id)) continue
      this.answered.add(request.id)
      this.reply({ type: 'audio', id: request.id, samples: new Float32Array(2400).fill(0.3), sampleRate: SAMPLE_RATE })
      answered = true
    }
    return answered
  }
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
  while (FakeWorker.all.some((worker) => worker.answerPending())) {
    // answering a segment hands the worker its next one, so go around until none is left
  }
  for (const source of [...FakeAudioContext.sources]) source.onended?.()
  await read.done
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  FakeWorker.all = []
  FakeAudioContext.sources = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('window', { mousse: { readAloud: { readLocalModelFile: vi.fn(async () => new Uint8Array()) } } })
  // The engine keeps its worker pool, timer and request ids at module level.
  vi.resetModules()
  engine = await import('../src/renderer/readAloud/localEngine')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('local read aloud keeps the model loaded between reads', () => {
  it('reuses the loaded worker when the next message starts well after the previous one ended', async () => {
    await finishRead(startRead(SHORT))
    const [worker] = FakeWorker.all
    expect(FakeWorker.all).toHaveLength(1)

    // Moving on to another paragraph takes longer than the old 15 second delay.
    await vi.advanceTimersByTimeAsync(30_000)
    const next = startRead(OTHER_SHORT)

    expect(FakeWorker.all).toHaveLength(1)
    expect(worker.terminated).toBe(0)
    expect(worker.speakRequests()).toHaveLength(2)
    await finishRead(next)
    expect(next.onPlaying).toHaveBeenCalledTimes(1)
  })

  it('drops every worker exactly five minutes after the last read ended, and the next read starts fresh', async () => {
    expect(splitSpeechSegments(LONG)).toHaveLength(2)
    await finishRead(startRead(LONG))
    expect(FakeWorker.all).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(FakeWorker.all.map((worker) => worker.terminated)).toEqual([0, 0])

    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWorker.all.map((worker) => worker.terminated)).toEqual([1, 1])

    await finishRead(startRead(SHORT))
    expect(FakeWorker.all).toHaveLength(3)
  })

  it('keeps the workers for as long as a read is still playing', async () => {
    const read = startRead(LONG)
    await vi.advanceTimersByTimeAsync(2 * IDLE_MS)
    expect(FakeWorker.all.map((worker) => worker.terminated)).toEqual([0, 0])

    await finishRead(read)
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(FakeWorker.all.map((worker) => worker.terminated)).toEqual([0, 0])
  })

  it('counts the delay from the end of the latest read, not from an earlier one', async () => {
    await finishRead(startRead(SHORT))
    await vi.advanceTimersByTimeAsync(4 * 60_000)

    const second = startRead(OTHER_SHORT)
    // The first read's deadline passes while the second is still being voiced.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const [worker] = FakeWorker.all
    expect(worker.terminated).toBe(0)

    await finishRead(second)
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(worker.terminated).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(worker.terminated).toBe(1)
  })
})

describe('local read aloud when a read is cut short', () => {
  it('keeps the workers when the read is stopped before any audio arrives', async () => {
    const read = startRead(SHORT)
    const [worker] = FakeWorker.all
    const [request] = worker.speakRequests()

    read.controller.abort()
    await read.done

    expect(worker.posted).toContainEqual({ type: 'cancel', id: request.id })
    expect(worker.terminated).toBe(0)

    // A reply for the stopped read arrives late and must not start any sound.
    worker.reply({ type: 'audio', id: request.id, samples: new Float32Array(2400).fill(0.3), sampleRate: SAMPLE_RATE })
    expect(FakeAudioContext.sources).toHaveLength(0)

    const next = startRead(OTHER_SHORT)
    expect(FakeWorker.all).toHaveLength(1)
    await finishRead(next)
    expect(next.onPlaying).toHaveBeenCalledTimes(1)
  })

  it('starts no worker for empty text or a read that was already stopped', async () => {
    await startRead('   ').done
    const stopped = new AbortController()
    stopped.abort()
    await startRead(SHORT, stopped).done

    expect(FakeWorker.all).toHaveLength(0)
  })

  it('drops the workers at once when a worker fails, and the next read starts fresh', async () => {
    const read = startRead(SHORT)
    const [worker] = FakeWorker.all
    const outcome = expect(read.done).rejects.toThrow('boom')

    worker.fail('boom')
    await outcome

    expect(worker.terminated).toBe(1)
    await finishRead(startRead(OTHER_SHORT))
    expect(FakeWorker.all).toHaveLength(2)
  })

  it('drops the workers at once when the model is removed, without waiting for the delay', async () => {
    await finishRead(startRead(SHORT))
    const [worker] = FakeWorker.all

    engine.disposeLocalEngine()
    expect(worker.terminated).toBe(1)

    await finishRead(startRead(OTHER_SHORT))
    expect(FakeWorker.all).toHaveLength(2)
  })
})

describe('local synthesis for a phone', () => {
  const synthesize = (text: string, onClip: (samples: Float32Array, rate: number) => void | Promise<void>, controller = new AbortController()) =>
    engine.synthesizeWithLocalModel('kokoro-82m', text, { signal: controller.signal, voice: undefined, speed: 1, onClip })

  const answerAll = (): void => {
    while (FakeWorker.all.some((worker) => worker.answerPending())) {
      // answering a segment hands the worker its next one, so go around until none is left
    }
  }

  it('hands over the next clip only after the receiver finished the one before', async () => {
    expect(splitSpeechSegments(LONG)).toHaveLength(2)
    const gates: Array<() => void> = []
    const done = synthesize(LONG, () => new Promise<void>((resolve) => gates.push(resolve)))
    answerAll()
    await vi.advanceTimersByTimeAsync(0)
    // Both segments are voiced, but the second waits for the receiver of the first.
    expect(gates).toHaveLength(1)
    gates[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(gates).toHaveLength(2)
    gates[1]()
    await done
  })

  it('keeps voicing within the lookahead of what the receiver took', async () => {
    const text = Array.from({ length: 40 }, () => LONG).join('\n\n')
    const total = splitSpeechSegments(text).length
    expect(total).toBeGreaterThan(30)
    const gates: Array<() => void> = []
    const controller = new AbortController()
    const done = synthesize(text, () => new Promise<void>((resolve) => gates.push(resolve)), controller)
    answerAll()
    await vi.advanceTimersByTimeAsync(0)
    answerAll()
    const requested = FakeWorker.all.reduce((count, worker) => count + worker.speakRequests().length, 0)
    expect(gates).toHaveLength(1)
    // Eight segments ahead of the one being received, and a little slack for the pool.
    expect(requested).toBeLessThanOrEqual(12)
    controller.abort()
    await done
  })

  it('fails when the receiver fails', async () => {
    const done = synthesize(SHORT, () => Promise.reject(new Error('phone gone')))
    const outcome = expect(done).rejects.toThrow('phone gone')
    answerAll()
    await outcome
  })

  it('stops handing over clips once aborted while the receiver is busy', async () => {
    const gates: Array<() => void> = []
    const controller = new AbortController()
    const onClip = vi.fn(() => new Promise<void>((resolve) => gates.push(resolve)))
    const done = synthesize(LONG, onClip, controller)
    answerAll()
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    gates[0]()
    await done
    await vi.advanceTimersByTimeAsync(0)
    expect(onClip).toHaveBeenCalledTimes(1)
  })
})

describe('local read aloud with more than one model', () => {
  it('starts the worker of the model family and tells it which model to run', async () => {
    await finishRead(startRead(SHORT, new AbortController(), 'kitten-tts-micro'))
    await finishRead(startRead(OTHER_SHORT))

    const [kitten, kokoro] = FakeWorker.all
    expect(kitten.url.pathname).toMatch(/kittenWorker\.ts$/)
    expect(kitten.posted[0]).toEqual({ type: 'init', modelId: 'kitten-tts-micro' })
    expect(kokoro.url.pathname).toMatch(/kokoroWorker\.ts$/)
    expect(kokoro.posted[0]).toEqual({ type: 'init', modelId: 'kokoro-82m' })
  })

  it('replaces the workers when another model is read, and keeps them for the same model', async () => {
    await finishRead(startRead(SHORT, new AbortController(), 'kitten-tts-nano'))
    await finishRead(startRead(OTHER_SHORT, new AbortController(), 'kitten-tts-nano'))
    expect(FakeWorker.all).toHaveLength(1)

    await finishRead(startRead(SHORT, new AbortController(), 'kitten-tts-mini'))
    expect(FakeWorker.all).toHaveLength(2)
    expect(FakeWorker.all[0].terminated).toBe(1)
    expect(FakeWorker.all[1].terminated).toBe(0)
  })

  it('asks for the default voice of the chosen model', async () => {
    const read = startRead(SHORT, new AbortController(), 'kitten-tts-micro')
    const [worker] = FakeWorker.all
    expect(worker.speakRequests()[0]).toMatchObject({ voice: 'Bella' })
    await finishRead(read)
  })

  it('fails the read for a model that no longer exists', async () => {
    await expect(startRead(SHORT, new AbortController(), 'gone' as LocalTtsModelId).done).rejects.toThrow('not available')
    expect(FakeWorker.all).toHaveLength(0)
  })
})
