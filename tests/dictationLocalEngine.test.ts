import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const decodeRecording = vi.hoisted(() => vi.fn())

vi.mock('../src/renderer/dictation/audio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/dictation/audio')>()),
  decodeRecording
}))
vi.mock('../src/renderer/speechModels/pageSupport', () => ({ serveModelFiles: () => undefined }))

type Engine = typeof import('../src/renderer/dictation/localEngine')

const SAMPLE_RATE = 16_000

/** Stands in for the transcription worker; a test answers each request when it likes. */
class FakeWorker extends EventTarget {
  static all: FakeWorker[] = []
  readonly requests: Array<{ id: number }> = []
  readonly warms: Array<{ id: number }> = []
  /** The type of every message, in order. */
  readonly sent: string[] = []
  terminated = false
  constructor() {
    super()
    FakeWorker.all.push(this)
  }
  postMessage(message: { type: string; id: number }): void {
    this.sent.push(message.type)
    if (message.type === 'transcribe') this.requests.push({ id: message.id })
    if (message.type === 'warm') this.warms.push({ id: message.id })
  }
  terminate(): void {
    this.terminated = true
  }
  answer(index: number, text: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: { type: 'result', id: this.requests[index].id, text } }))
  }
  finishWarm(index: number, failure?: string): void {
    const id = this.warms[index].id
    const data = failure ? { type: 'error', id, message: failure } : { type: 'result', id, text: '' }
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

let engine: Engine

beforeEach(async () => {
  FakeWorker.all = []
  decodeRecording.mockReset()
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('window', { mousse: { dictation: { readLocalModelFile: vi.fn() } } })
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.resetModules()
  engine = await import('../src/renderer/dictation/localEngine')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('local dictation that the phone cancels', () => {
  it('stops sending segments to the worker once aborted', async () => {
    // 61 seconds at 30 seconds a segment is three segments of speech-like noise.
    decodeRecording.mockResolvedValue(new Float32Array(61 * SAMPLE_RATE).fill(0.2))
    const abort = new AbortController()
    const partials: string[] = []
    const done = engine.transcribeWithLocalModel(
      'moonshine-base',
      new Blob([new Uint8Array([1])]),
      (text) => {
        partials.push(text)
        abort.abort()
      },
      abort.signal
    )
    const outcome = expect(done).rejects.toThrow()
    await vi.waitFor(() => expect(FakeWorker.all[0]?.requests).toHaveLength(1))
    FakeWorker.all[0].answer(0, 'first')
    await outcome
    expect(FakeWorker.all[0].requests).toHaveLength(1)
    expect(partials).toEqual(['first'])
  })

  it('does not decode a recording whose job was cancelled already', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(engine.transcribeWithLocalModel('moonshine-base', new Blob([new Uint8Array([1])]), undefined, abort.signal)).rejects.toThrow()
    expect(decodeRecording).not.toHaveBeenCalled()
    expect(FakeWorker.all).toHaveLength(0)
  })

  it('transcribes every segment when nothing cancels it', async () => {
    decodeRecording.mockResolvedValue(new Float32Array(61 * SAMPLE_RATE).fill(0.2))
    const done = engine.transcribeWithLocalModel('moonshine-base', new Blob([new Uint8Array([1])]))
    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(FakeWorker.all[0]?.requests).toHaveLength(index + 1))
      FakeWorker.all[0].answer(index, `part${index}`)
    }
    expect(await done).toBe('part0 part1 part2')
  })
})

describe('warming the local dictation model when recording starts', () => {
  it('loads the model before the recording reaches it, in the same worker', async () => {
    engine.warmLocalEngine('moonshine-base')
    expect(FakeWorker.all).toHaveLength(1)
    expect(FakeWorker.all[0].sent).toEqual(['init', 'warm'])
    expect(engine.localEngineState('moonshine-base')).toBe('loading')

    FakeWorker.all[0].finishWarm(0)
    await vi.waitFor(() => expect(engine.localEngineState('moonshine-base')).toBe('ready'))

    decodeRecording.mockResolvedValue(new Float32Array(SAMPLE_RATE).fill(0.2))
    const done = engine.transcribeWithLocalModel('moonshine-base', new Blob([new Uint8Array([1])]))
    await vi.waitFor(() => expect(FakeWorker.all[0].requests).toHaveLength(1))
    FakeWorker.all[0].answer(0, 'hello')
    expect(await done).toBe('hello')
    expect(FakeWorker.all).toHaveLength(1)
    expect(FakeWorker.all[0].sent).toEqual(['init', 'warm', 'transcribe'])
  })

  it('warms a model once while it loads and after it is ready', async () => {
    engine.warmLocalEngine('moonshine-base')
    engine.warmLocalEngine('moonshine-base')
    expect(FakeWorker.all[0].warms).toHaveLength(1)
    FakeWorker.all[0].finishWarm(0)
    await vi.waitFor(() => expect(engine.localEngineState('moonshine-base')).toBe('ready'))
    engine.warmLocalEngine('moonshine-base')
    expect(FakeWorker.all[0].warms).toHaveLength(1)
  })

  it('tries again on the next recording after a failed warm-up', async () => {
    engine.warmLocalEngine('moonshine-base')
    FakeWorker.all[0].finishWarm(0, 'Model file unavailable')
    await vi.waitFor(() => expect(engine.localEngineState('moonshine-base')).toBe('cold'))
    engine.warmLocalEngine('moonshine-base')
    expect(FakeWorker.all[0].warms).toHaveLength(2)
  })

  it('replaces the worker when another model is warmed', () => {
    engine.warmLocalEngine('moonshine-base')
    engine.warmLocalEngine('moonshine-tiny')
    expect(FakeWorker.all).toHaveLength(2)
    expect(FakeWorker.all[0].terminated).toBe(true)
    expect(engine.localEngineState('moonshine-base')).toBe('cold')
    expect(engine.localEngineState('moonshine-tiny')).toBe('loading')
  })

  it('keeps a warmed model for the idle period, then shuts its worker down', async () => {
    vi.useFakeTimers()
    engine.warmLocalEngine('moonshine-base')
    FakeWorker.all[0].finishWarm(0)
    // The warm-up settles over a few promise steps; fake timers stay where they are meanwhile.
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
    expect(engine.localEngineState('moonshine-base')).toBe('ready')

    vi.advanceTimersByTime(engine.IDLE_DISPOSE_MS - 1)
    expect(FakeWorker.all[0].terminated).toBe(false)
    vi.advanceTimersByTime(1)
    expect(FakeWorker.all[0].terminated).toBe(true)
    expect(engine.localEngineState('moonshine-base')).toBe('cold')
  })

  it('does not shut the worker down while it is still loading', () => {
    vi.useFakeTimers()
    engine.warmLocalEngine('moonshine-base')
    vi.advanceTimersByTime(engine.IDLE_DISPOSE_MS * 2)
    expect(FakeWorker.all[0].terminated).toBe(false)
  })
})
