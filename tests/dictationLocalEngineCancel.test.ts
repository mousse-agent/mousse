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
  constructor() {
    super()
    FakeWorker.all.push(this)
  }
  postMessage(message: { type: string; id: number }): void {
    if (message.type === 'transcribe') this.requests.push({ id: message.id })
  }
  terminate(): void {}
  answer(index: number, text: string): void {
    this.dispatchEvent(new MessageEvent('message', { data: { type: 'result', id: this.requests[index].id, text } }))
  }
}

let engine: Engine

beforeEach(async () => {
  FakeWorker.all = []
  decodeRecording.mockReset()
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('window', { mousse: { dictation: { readLocalModelFile: vi.fn() } } })
  vi.resetModules()
  engine = await import('../src/renderer/dictation/localEngine')
})

afterEach(() => {
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
