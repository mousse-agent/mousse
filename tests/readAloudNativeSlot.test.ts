import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalTtsWorkerEvent, LocalTtsWorkerRequest } from '../src/renderer/readAloud/localTtsWorker'
import type { TtsWorker } from '../src/renderer/readAloud/nativeSlot'
import { KOKORO_82M, type NativeSpeechResult } from '../src/shared/readAloud'

vi.mock('../src/renderer/speech/audioLevels', () => ({
  createLevelMeter: () => ({ analyser: { connect: () => undefined }, levels: () => [] })
}))

type SlotModule = typeof import('../src/renderer/readAloud/nativeSlot')

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const audio = (): NativeSpeechResult => ({ samples: new Float32Array([0.3, 0.3]), sampleRate: 24_000 })

/** `window.mousse.readAloud.native*` with opens and speaks a test settles by hand. */
function fakeNative() {
  const opens: Array<Deferred<number>> = []
  const speaks: Array<{ slotId: number; text: string; reply: Deferred<NativeSpeechResult> }> = []
  const exitListeners = new Set<(slotId: number) => void>()
  const api = {
    nativeOpen: vi.fn(() => {
      const open = deferred<number>()
      opens.push(open)
      return open.promise
    }),
    nativeSpeak: vi.fn((slotId: number, text: string) => {
      const reply = deferred<NativeSpeechResult>()
      speaks.push({ slotId, text, reply })
      return reply.promise
    }),
    nativeCancel: vi.fn(async () => undefined),
    nativeClose: vi.fn(async () => undefined),
    onNativeSlotExit: vi.fn((listener: (slotId: number) => void) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    })
  }
  const exit = (slotId: number): void => {
    for (const listener of exitListeners) listener(slotId)
  }
  return { api, opens, speaks, exitListeners, exit }
}

/** The WebAssembly worker the adapter falls back to. */
class FallbackWorker extends EventTarget implements TtsWorker {
  readonly posted: LocalTtsWorkerRequest[] = []
  terminated = 0
  postMessage(message: LocalTtsWorkerRequest): void {
    this.posted.push(message)
  }
  terminate(): void {
    this.terminated++
  }
  reply(data: LocalTtsWorkerEvent): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

let slotModule: SlotModule
let native: ReturnType<typeof fakeNative>
let fallbacks: FallbackWorker[]
let warn: ReturnType<typeof vi.spyOn>

function openSlot() {
  const messages: LocalTtsWorkerEvent[] = []
  const errors: string[] = []
  const slot = new slotModule.NativeTtsSlot(KOKORO_82M, () => {
    const worker = new FallbackWorker()
    fallbacks.push(worker)
    return worker
  })
  slot.addEventListener('message', (event) => messages.push(event.data))
  slot.addEventListener('error', (event) => errors.push(event.message))
  return { slot, messages, errors }
}

const speak = (id: number, text = `segment ${id}`): LocalTtsWorkerRequest => ({ type: 'speak', id, text, voice: 'af_heart', speed: 1 })

beforeEach(async () => {
  native = fakeNative()
  fallbacks = []
  vi.stubGlobal('window', { mousse: { readAloud: native.api } })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  // The "native engine unavailable" flag is module state.
  vi.resetModules()
  slotModule = await import('../src/renderer/readAloud/nativeSlot')
})

afterEach(() => {
  warn.mockRestore()
  vi.unstubAllGlobals()
})

describe('native read aloud slot', () => {
  it('holds requests until the slot has opened, then voices them one at a time in order', async () => {
    const { slot, messages } = openSlot()
    slot.postMessage(speak(1))
    slot.postMessage(speak(2))
    await flush()
    expect(native.api.nativeSpeak).not.toHaveBeenCalled()

    native.opens[0].resolve(7)
    await flush()
    expect(native.speaks.map((entry) => [entry.slotId, entry.text])).toEqual([[7, 'segment 1']])

    native.speaks[0].reply.resolve(audio())
    await flush()
    expect(native.speaks.map((entry) => entry.text)).toEqual(['segment 1', 'segment 2'])
    native.speaks[1].reply.resolve(audio())
    await flush()
    expect(messages.map((message) => [message.type, 'id' in message ? message.id : undefined])).toEqual([
      ['audio', 1],
      ['audio', 2]
    ])
  })

  it('closes the slot as soon as it opens when it was terminated before', async () => {
    const { slot } = openSlot()
    slot.postMessage(speak(1))
    slot.terminate()
    native.opens[0].resolve(3)
    await flush()
    expect(native.api.nativeClose).toHaveBeenCalledWith(3)
    expect(native.api.nativeSpeak).not.toHaveBeenCalled()
  })

  it('closes the slot on terminate and stops listening for exits', async () => {
    const { slot } = openSlot()
    native.opens[0].resolve(4)
    await flush()
    expect(native.exitListeners.size).toBe(1)
    slot.terminate()
    expect(native.api.nativeClose).toHaveBeenCalledWith(4)
    expect(native.exitListeners.size).toBe(0)
  })

  it('stops a cancelled running request in the engine and drops its answer, and never sends one cancelled while queued', async () => {
    const { slot, messages } = openSlot()
    native.opens[0].resolve(1)
    slot.postMessage(speak(1))
    slot.postMessage(speak(2))
    slot.postMessage(speak(3))
    await flush()
    expect(slot.cancelsInPlace).toBe(true)
    slot.postMessage({ type: 'cancel', id: 1 })
    slot.postMessage({ type: 'cancel', id: 1 })
    slot.postMessage({ type: 'cancel', id: 2 })
    expect(native.api.nativeCancel.mock.calls).toEqual([[1]])
    native.speaks[0].reply.resolve({ error: 'The segment was cancelled' })
    await flush()
    expect(native.speaks.map((entry) => entry.text)).toEqual(['segment 1', 'segment 3'])
    native.speaks[1].reply.resolve(audio())
    await flush()
    expect(messages).toMatchObject([{ type: 'audio', id: 3 }])
    // Audio that arrives for a cancelled request is dropped as well.
    slot.postMessage(speak(4))
    await flush()
    slot.postMessage({ type: 'cancel', id: 4 })
    native.speaks[2].reply.resolve(audio())
    await flush()
    expect(messages).toHaveLength(1)
  })

  it('cancels a request that is waiting for the slot to open without telling main', async () => {
    const { slot } = openSlot()
    slot.postMessage(speak(1))
    slot.postMessage({ type: 'cancel', id: 1 })
    native.opens[0].resolve(2)
    await flush()
    expect(native.api.nativeSpeak).not.toHaveBeenCalled()
    expect(native.api.nativeCancel).not.toHaveBeenCalled()
  })

  it('reports a segment the engine could not voice as an error for that request, and keeps the native engine', async () => {
    const { slot, messages, errors } = openSlot()
    native.opens[0].resolve(1)
    slot.postMessage(speak(1))
    await flush()
    native.speaks[0].reply.resolve({ error: 'Voice af_nicole could not be downloaded' })
    await flush()

    expect(messages).toEqual([{ type: 'error', id: 1, message: 'Voice af_nicole could not be downloaded' }])
    expect(errors).toEqual([])
    expect(fallbacks).toHaveLength(0)
    expect(slotModule.nativeKokoroUnavailable()).toBe(false)
  })

  it('ignores exits of other slots', async () => {
    const { slot, errors } = openSlot()
    native.opens[0].resolve(1)
    slot.postMessage(speak(1))
    await flush()
    native.exit(2)
    await flush()
    expect(errors).toEqual([])
    expect(fallbacks).toHaveLength(0)
  })
})

describe('native read aloud slot falling back to WebAssembly', () => {
  it('switches to a WebAssembly worker when the slot cannot open, and sends it the waiting request once', async () => {
    const { slot, messages } = openSlot()
    slot.postMessage(speak(1))
    native.opens[0].reject(new Error('onnxruntime binding failed to load'))
    await flush()

    expect(slotModule.nativeKokoroUnavailable()).toBe(true)
    // A WebAssembly worker cannot stop mid-segment.
    expect(slot.cancelsInPlace).toBe(false)
    const [worker] = fallbacks
    expect(worker.posted).toEqual([speak(1)])
    // Later messages go to the worker, and its answers come out of the slot.
    slot.postMessage(speak(2))
    worker.reply({ type: 'audio', id: 1, samples: new Float32Array([0.3]), sampleRate: 24_000 })
    expect(worker.posted).toEqual([speak(1), speak(2)])
    expect(messages).toMatchObject([{ type: 'audio', id: 1 }])

    slot.terminate()
    expect(worker.terminated).toBe(1)
  })

  it('switches when the engine ends before the slot voiced anything, re-sending the requests that got no answer', async () => {
    const { slot, errors } = openSlot()
    native.opens[0].resolve(5)
    slot.postMessage(speak(1))
    slot.postMessage(speak(2))
    await flush()

    native.exit(5)
    native.speaks[0].reply.reject(new Error('The voice engine stopped unexpectedly'))
    await flush()

    expect(errors).toEqual([])
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0].posted).toEqual([speak(1), speak(2)])
  })

  it('switches once for both slots when both fail together, and produces no clip twice', async () => {
    const first = openSlot()
    const second = openSlot()
    first.slot.postMessage(speak(1))
    second.slot.postMessage(speak(2))
    native.opens[0].reject(new Error('no binding'))
    native.opens[1].reject(new Error('no binding'))
    await flush()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(fallbacks.map((worker) => worker.posted)).toEqual([[speak(1)], [speak(2)]])
    fallbacks[0].reply({ type: 'audio', id: 1, samples: new Float32Array([0.3]), sampleRate: 24_000 })
    fallbacks[1].reply({ type: 'audio', id: 2, samples: new Float32Array([0.3]), sampleRate: 24_000 })
    expect(first.messages).toMatchObject([{ type: 'audio', id: 1 }])
    expect(second.messages).toMatchObject([{ type: 'audio', id: 2 }])
  })

  it('reports an error instead once the slot has voiced, as a crashed worker does', async () => {
    const { slot, errors } = openSlot()
    native.opens[0].resolve(6)
    slot.postMessage(speak(1))
    await flush()
    native.speaks[0].reply.resolve(audio())
    await flush()
    slot.postMessage(speak(2))
    await flush()

    native.exit(6)
    native.speaks[1].reply.reject(new Error('The voice engine stopped unexpectedly'))
    await flush()

    expect(errors).toEqual(['The voice engine stopped unexpectedly'])
    expect(fallbacks).toHaveLength(0)
    expect(slotModule.nativeKokoroUnavailable()).toBe(false)
  })
})

describe('the read aloud engine after a native slot failed', () => {
  it('starts WebAssembly workers for Kokoro for the rest of the session', async () => {
    const created: URL[] = []
    class FakeWorker extends FallbackWorker {
      constructor(url: URL) {
        super()
        created.push(url)
      }
    }
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('window', { mousse: { readAloud: { ...native.api, readLocalModelFile: vi.fn() } } })
    const engine = await import('../src/renderer/readAloud/localEngine')
    const { slot } = openSlot()
    native.opens[0].reject(new Error('no binding'))
    await flush()
    slot.terminate()
    created.length = 0

    vi.stubGlobal('AudioContext', class {
      currentTime = 0
      destination = {}
      resume = async () => undefined
      suspend = async () => undefined
      close = async () => undefined
    })
    const controller = new AbortController()
    const read = engine.speakWithLocalModel('kokoro-82m', 'Hello there.', {
      signal: controller.signal,
      onPlaying: () => undefined,
      voice: undefined,
      speed: () => 1,
      pause: { paused: false, subscribe: () => () => undefined } as never,
      onLevels: () => undefined
    })
    expect(native.api.nativeOpen).toHaveBeenCalledTimes(1)
    expect(created.map((url) => url.pathname)).toEqual([expect.stringMatching(/kokoroWorker\.ts$/)])
    controller.abort()
    await read
  })
})
