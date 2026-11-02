import { beforeEach, describe, expect, it, vi } from 'vitest'

const transcribeLocalSamples = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/dictation/localEngine', () => ({ transcribeLocalSamples }))

const { startLiveTranscription } = await import('../src/renderer/dictation/liveTranscription')

const RATE = 16_000
const speech = (seconds: number): Float32Array => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => 0.3 * Math.sin(i * 0.2))
const silence = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * RATE))

/** Stands in for the Web Audio capture; a test sends audio when it likes. */
function fakeCapture() {
  const state = { send: (_samples: Float32Array) => undefined as void, flushes: 0, closed: false }
  const capture = vi.fn(async (_stream: MediaStream, _rate: number, onSamples: (samples: Float32Array) => void) => {
    state.send = onSamples
    return {
      flush: async () => {
        state.flushes++
      },
      close: () => {
        state.closed = true
      }
    }
  })
  return { capture, state }
}

const stream = {} as MediaStream

beforeEach(() => {
  transcribeLocalSamples.mockReset()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

describe('local dictation transcribed while the user speaks', () => {
  it('transcribes each piece at its pause and only the rest after the stop', async () => {
    transcribeLocalSamples.mockResolvedValueOnce('First sentence.').mockResolvedValueOnce('Second one.')
    const { capture, state } = fakeCapture()
    const partials: string[] = []
    const live = await startLiveTranscription('parakeet-tdt-110m', stream, { capture, onPartial: (text) => partials.push(text) })
    state.send(speech(4))
    state.send(silence(0.5))
    await vi.waitFor(() => expect(transcribeLocalSamples).toHaveBeenCalledTimes(1))
    expect(partials).toEqual(['First sentence.'])

    state.send(speech(1))
    const { captured, text } = live.finish()
    await captured
    expect(state.flushes).toBe(1)
    expect(state.closed).toBe(true)
    expect(await text).toBe('First sentence. Second one.')
    expect(transcribeLocalSamples).toHaveBeenCalledTimes(2)
    // The second piece is the audio after the cut: the rest of the pause and the last second.
    expect(transcribeLocalSamples.mock.calls[1][1].length / RATE).toBeCloseTo(1.34, 1)
  })

  it('sends no piece of silence to the model', async () => {
    const { capture, state } = fakeCapture()
    const live = await startLiveTranscription('parakeet-tdt-110m', stream, { capture })
    state.send(silence(2))
    expect(await live.finish().text).toBe('')
    expect(transcribeLocalSamples).not.toHaveBeenCalled()
  })

  it('ignores audio that arrives after the stop', async () => {
    transcribeLocalSamples.mockResolvedValue('hello')
    const { capture, state } = fakeCapture()
    const live = await startLiveTranscription('parakeet-tdt-110m', stream, { capture })
    state.send(speech(1))
    const { captured, text } = live.finish()
    await captured
    state.send(speech(20))
    expect(await text).toBe('hello')
    expect(transcribeLocalSamples).toHaveBeenCalledTimes(1)
  })

  it('reports a failed piece when the recording finishes', async () => {
    transcribeLocalSamples.mockRejectedValueOnce(new Error('The local speech engine was stopped'))
    const { capture, state } = fakeCapture()
    const live = await startLiveTranscription('parakeet-tdt-110m', stream, { capture })
    state.send(speech(4))
    state.send(silence(0.5))
    state.send(speech(1))
    await expect(live.finish().text).rejects.toThrow('The local speech engine was stopped')
  })

  it('drops everything when cancelled', async () => {
    let answer!: (text: string) => void
    transcribeLocalSamples.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const { capture, state } = fakeCapture()
    const partials: string[] = []
    const live = await startLiveTranscription('parakeet-tdt-110m', stream, { capture, onPartial: (text) => partials.push(text) })
    state.send(speech(4))
    state.send(silence(0.5))
    await vi.waitFor(() => expect(transcribeLocalSamples).toHaveBeenCalledTimes(1))
    live.cancel()
    answer('too late')
    await Promise.resolve()
    expect(state.closed).toBe(true)
    expect(partials).toEqual([])
  })
})
