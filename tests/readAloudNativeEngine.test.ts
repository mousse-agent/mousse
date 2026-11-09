import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CANCELLED_RESULT,
  ENGINE_IDLE_MS,
  NATIVE_SLOT_EXIT_CHANNEL,
  NativeTtsSlots,
  type NativeTtsOwner,
  type VoiceEngineProcess
} from '../src/main/readAloud/NativeTtsSlots'
import { VoiceEngineReader, cancelFrame, loadFrame, runFrame, shutdownFrame } from '../src/main/readAloud/voiceEngineProtocol'
import type { KokoroInputs } from '../src/main/readAloud/kokoroText'
import { KOKORO_82M, type KokoroTtsModel } from '../src/shared/readAloud'

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve))
}

type Request =
  | { type: 'load'; path: string }
  | { type: 'run'; id: number; speed: number; style: number[]; inputIds: number[] }
  | { type: 'cancel'; id: number }
  | { type: 'shutdown' }

/** Reads the frames main writes, as the engine does (native/voice-engine/src/protocol.rs). */
function decodeRequests(bytes: Uint8Array): Request[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const requests: Request[] = []
  for (let at = 0; at < bytes.length; ) {
    const length = view.getUint32(at, true)
    const body = bytes.subarray(at + 4, at + 4 + length)
    const read = new DataView(body.buffer, body.byteOffset, body.byteLength)
    at += 4 + length
    if (body[0] === 1) requests.push({ type: 'load', path: new TextDecoder().decode(body.subarray(1)) })
    else if (body[0] === 3) requests.push({ type: 'cancel', id: read.getUint32(1, true) })
    else if (body[0] === 4) requests.push({ type: 'shutdown' })
    else {
      const style = Array.from({ length: 256 }, (_, index) => read.getFloat32(9 + index * 4, true))
      const inputIds = Array.from({ length: (length - 9 - 1024) / 8 }, (_, index) => Number(read.getBigInt64(9 + 1024 + index * 8, true)))
      requests.push({ type: 'run', id: read.getUint32(1, true), speed: read.getFloat32(5, true), style, inputIds })
    }
  }
  return requests
}

/** Frames as the engine writes them. */
const event = {
  frame(body: number[] | Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + body.length)
    new DataView(out.buffer).setUint32(0, body.length, true)
    out.set(body, 4)
    return out
  },
  ready: (): Uint8Array => event.frame([1]),
  loadError: (message: string): Uint8Array => event.frame([2, ...new TextEncoder().encode(message)]),
  audio(id: number, samples: number[]): Uint8Array {
    const body = new Uint8Array(9 + samples.length * 4)
    const view = new DataView(body.buffer)
    body[0] = 3
    view.setUint32(1, id, true)
    view.setUint32(5, 24_000, true)
    samples.forEach((sample, index) => view.setFloat32(9 + index * 4, sample, true))
    return event.frame(body)
  },
  error(id: number, message: string): Uint8Array {
    const body = new Uint8Array([4, 0, 0, 0, 0, ...new TextEncoder().encode(message)])
    new DataView(body.buffer).setUint32(1, id, true)
    return event.frame(body)
  },
  cancelled(id: number): Uint8Array {
    const body = new Uint8Array(5)
    body[0] = 5
    new DataView(body.buffer).setUint32(1, id, true)
    return event.frame(body)
  }
}

/** An engine process that a test answers by hand. */
class FakeEngine implements VoiceEngineProcess {
  static all: FakeEngine[] = []
  readonly emitter = new EventEmitter()
  readonly written: Request[] = []
  killed = 0
  constructor() {
    FakeEngine.all.push(this)
  }
  write(bytes: Uint8Array): void {
    this.written.push(...decodeRequests(bytes))
  }
  onData(listener: (chunk: Uint8Array) => void): void {
    this.emitter.on('data', listener)
  }
  onExit(listener: () => void): void {
    this.emitter.on('exit', listener)
  }
  kill(): void {
    this.killed++
  }
  send(...frames: Uint8Array[]): void {
    for (const frame of frames) this.emitter.emit('data', frame)
  }
  exit(): void {
    this.emitter.emit('exit')
  }
  runs(): Array<Extract<Request, { type: 'run' }>> {
    return this.written.filter((request): request is Extract<Request, { type: 'run' }> => request.type === 'run')
  }
  cancels(): number[] {
    return this.written.flatMap((request) => (request.type === 'cancel' ? [request.id] : []))
  }
}

class FakeOwner extends EventEmitter implements NativeTtsOwner {
  static next = 1
  readonly id = FakeOwner.next++
  destroyed = false
  readonly sent: Array<[string, unknown]> = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload])
  }
}

const STYLE = new Float32Array(256).map((_, index) => index / 256)
const inputsFor = (text: string): KokoroInputs => ({ inputIds: [0, ...Array.from(text, (character) => character.charCodeAt(0) % 178), 0], style: STYLE })

describe('voice engine frames', () => {
  it('encodes requests as the engine reads them', () => {
    const bytes = [loadFrame('C:\\models\\kokoro.onnx'), runFrame(7, [0, 50, 0], STYLE, 1.25), cancelFrame(7), shutdownFrame()]
    expect(decodeRequests(new Uint8Array(Buffer.concat(bytes)))).toEqual([
      { type: 'load', path: 'C:\\models\\kokoro.onnx' },
      { type: 'run', id: 7, speed: 1.25, style: Array.from(STYLE), inputIds: [0, 50, 0] },
      { type: 'cancel', id: 7 },
      { type: 'shutdown' }
    ])
    expect(() => runFrame(1, [0, 0], new Float32Array(255), 1)).toThrow('256')
  })

  it('reads events split anywhere across chunks', () => {
    const stream = Buffer.concat([event.ready(), event.audio(3, [0.5, -0.25]), event.error(4, 'bad'), event.cancelled(5), event.loadError('no')])
    const reader = new VoiceEngineReader()
    const events = []
    for (let at = 0; at < stream.length; at += 3) events.push(...reader.push(new Uint8Array(stream.subarray(at, at + 3))))
    expect(events).toEqual([
      { type: 'ready' },
      { type: 'audio', id: 3, sampleRate: 24_000, samples: new Float32Array([0.5, -0.25]) },
      { type: 'error', id: 4, message: 'bad' },
      { type: 'cancelled', id: 5 },
      { type: 'load-error', message: 'no' }
    ])
  })

  it('refuses output that is not frames', () => {
    expect(() => new VoiceEngineReader().push(event.frame([9]))).toThrow('unknown event')
    expect(() => new VoiceEngineReader().push(new Uint8Array([0, 0, 0, 0]))).toThrow('frame of 0 bytes')
    expect(() => new VoiceEngineReader().push(event.frame([3, 1, 0, 0, 0, 0, 0]))).toThrow('damaged audio')
  })
})

describe('native read aloud slots in main', () => {
  let downloaded: boolean
  let slots: NativeTtsSlots
  let owner: FakeOwner
  let spawnError: Error | null
  const prepare = vi.fn(async (_model: KokoroTtsModel, text: string, _voice: string): Promise<KokoroInputs> => inputsFor(text))

  function create(options: Partial<ConstructorParameters<typeof NativeTtsSlots>[0]> = {}): NativeTtsSlots {
    return new NativeTtsSlots({
      spawn: () => {
        if (spawnError) throw spawnError
        return new FakeEngine()
      },
      isDownloaded: async () => downloaded,
      modelPath: async (model) => `/models/${model.id}/onnx/model_quantized.onnx`,
      prepare,
      ...options
    })
  }

  beforeEach(() => {
    FakeEngine.all = []
    downloaded = true
    spawnError = null
    prepare.mockClear()
    slots = create()
    owner = new FakeOwner()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Opens a slot, answering the engine's load when it is new. */
  async function openReady(by: FakeOwner = owner): Promise<{ slotId: number; engine: FakeEngine }> {
    const engines = FakeEngine.all.length
    const opening = slots.open(by, 'kokoro-82m')
    await flush()
    const engine = FakeEngine.all.at(-1)!
    if (FakeEngine.all.length > engines) engine.send(event.ready())
    return { slotId: await opening, engine }
  }

  /** Speaks and waits until the engine has the run. */
  async function speakSent(slotId: number, text = 'Hello.'): Promise<{ result: Promise<unknown>; id: number }> {
    const engine = FakeEngine.all.at(-1)!
    const before = engine.runs().length
    const result = slots.speak(owner, slotId, text, 'af_heart', 1)
    await flush()
    expect(engine.runs()).toHaveLength(before + 1)
    return { result, id: engine.runs().at(-1)!.id }
  }

  it('starts an engine with the model file and resolves once the model loaded', async () => {
    const opening = slots.open(owner, 'kokoro-82m')
    await flush()
    const [engine] = FakeEngine.all
    expect(engine.written).toEqual([{ type: 'load', path: '/models/kokoro-82m/onnx/model_quantized.onnx' }])
    engine.send(event.ready())
    expect(await opening).toBeGreaterThan(0)
  })

  it('runs every slot of every window on one engine and opens later slots without loading again', async () => {
    const first = await openReady()
    const second = await openReady()
    const other = await openReady(new FakeOwner())
    expect(FakeEngine.all).toHaveLength(1)
    expect(new Set([first.slotId, second.slotId, other.slotId]).size).toBe(3)
    expect(first.engine.written.filter((request) => request.type === 'load')).toHaveLength(1)
  })

  it('sends the prepared input and relays audio and per-segment errors', async () => {
    const { slotId, engine } = await openReady()
    const first = await speakSent(slotId, 'Hi.')
    const second = await speakSent(slotId, 'Yo.')
    expect(prepare).toHaveBeenCalledWith(KOKORO_82M, 'Hi.', 'af_heart')
    expect(engine.runs()[0]).toMatchObject({ speed: 1, inputIds: inputsFor('Hi.').inputIds, style: Array.from(STYLE) })
    engine.send(event.audio(first.id, [0.5]), event.error(second.id, 'unvoiceable'))
    expect(await first.result).toEqual({ samples: new Float32Array([0.5]), sampleRate: 24_000 })
    expect(await second.result).toEqual({ error: 'unvoiceable' })
  })

  it('reports a segment that could not be prepared as its error', async () => {
    const { slotId, engine } = await openReady()
    prepare.mockRejectedValueOnce(new Error('No network'))
    expect(await slots.speak(owner, slotId, 'Hi.', 'af_bella', 1)).toEqual({ error: 'No network' })
    expect(engine.runs()).toHaveLength(0)
  })

  it('cancels a running segment in the engine and keeps the slot open', async () => {
    const { slotId, engine } = await openReady()
    const running = await speakSent(slotId)
    slots.cancel(owner, slotId)
    expect(engine.cancels()).toEqual([running.id])
    engine.send(event.cancelled(running.id))
    expect(await running.result).toEqual(CANCELLED_RESULT)
    // Audio that was already on its way is dropped too.
    const next = await speakSent(slotId)
    slots.cancel(owner, slotId)
    engine.send(event.audio(next.id, [0.1]))
    expect(await next.result).toEqual(CANCELLED_RESULT)
    expect(engine.killed).toBe(0)
    expect(slots.size).toBe(1)
  })

  it('cancels a segment still being prepared without sending it', async () => {
    const { slotId, engine } = await openReady()
    let release!: () => void
    prepare.mockImplementationOnce((_model, text) => new Promise((resolve) => (release = () => resolve(inputsFor(text)))))
    const pending = slots.speak(owner, slotId, 'Hi.', 'af_heart', 1)
    slots.cancel(owner, slotId)
    release()
    expect(await pending).toEqual(CANCELLED_RESULT)
    expect(engine.runs()).toHaveLength(0)
    expect(engine.cancels()).toEqual([])
  })

  it('closes a slot by cancelling its segments in the engine, which keeps running', async () => {
    const { slotId, engine } = await openReady()
    const running = await speakSent(slotId)
    slots.close(owner, slotId)
    await expect(running.result).rejects.toThrow('stopped')
    expect(engine.cancels()).toEqual([running.id])
    expect(engine.killed).toBe(0)
    expect(slots.size).toBe(0)
    // The engine's late answer is ignored.
    engine.send(event.cancelled(running.id))
    expect(owner.sent).toEqual([])
  })

  it('ends the engine a while after its last slot closed, and not when a slot opens meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = await openReady()
    slots.close(owner, first.slotId)
    vi.advanceTimersByTime(ENGINE_IDLE_MS - 1)
    const second = await openReady()
    expect(second.engine).toBe(first.engine)
    vi.advanceTimersByTime(ENGINE_IDLE_MS * 2)
    expect(first.engine.killed).toBe(0)
    slots.close(owner, second.slotId)
    vi.advanceTimersByTime(ENGINE_IDLE_MS)
    expect(first.engine.killed).toBe(1)
    expect(slots.engineCount).toBe(0)
    // The engine ending now is not reported to anyone, and the next open starts a new one.
    first.engine.exit()
    expect(owner.sent).toEqual([])
    const third = await openReady()
    expect(third.engine).not.toBe(first.engine)
  })

  it.each([
    ['an unknown model', 'nope'],
    ['a model of another family', 'kitten-tts-micro'],
    ['a model id that is not a string', 42]
  ])('refuses %s', async (_label, modelId) => {
    await expect(slots.open(owner, modelId)).rejects.toThrow('no native engine')
    expect(FakeEngine.all).toHaveLength(0)
  })

  it('refuses a model that is not downloaded', async () => {
    downloaded = false
    await expect(slots.open(owner, 'kokoro-82m')).rejects.toThrow('not downloaded')
    expect(FakeEngine.all).toHaveLength(0)
  })

  it('fails the open when there is no engine', async () => {
    spawnError = new Error('The native voice engine is not part of this build')
    await expect(slots.open(owner, 'kokoro-82m')).rejects.toThrow('not part of this build')
    expect(slots.size).toBe(0)
  })

  it('fails every waiting open and ends the engine when the model does not load', async () => {
    const one = slots.open(owner, 'kokoro-82m')
    await flush()
    const two = slots.open(new FakeOwner(), 'kokoro-82m')
    await flush()
    expect(FakeEngine.all).toHaveLength(1)
    FakeEngine.all[0].send(event.loadError('bad model'))
    await expect(one).rejects.toThrow('bad model')
    await expect(two).rejects.toThrow('bad model')
    expect(FakeEngine.all[0].killed).toBe(1)
    expect([slots.size, slots.engineCount]).toEqual([0, 0])
  })

  it('fails the open when the engine exits while loading', async () => {
    const opening = slots.open(owner, 'kokoro-82m')
    await flush()
    FakeEngine.all[0].exit()
    await expect(opening).rejects.toThrow('did not start')
    expect(owner.sent).toEqual([])
  })

  it('fails pending segments and tells every window with an open slot when the engine exits', async () => {
    const { slotId, engine } = await openReady()
    const otherOwner = new FakeOwner()
    const other = await openReady(otherOwner)
    const running = await speakSent(slotId)
    engine.exit()
    await expect(running.result).rejects.toThrow('stopped unexpectedly')
    expect(owner.sent).toEqual([[NATIVE_SLOT_EXIT_CHANNEL, { slotId }]])
    expect(otherOwner.sent).toEqual([[NATIVE_SLOT_EXIT_CHANNEL, { slotId: other.slotId }]])
    expect([slots.size, slots.engineCount]).toEqual([0, 0])
  })

  it('ends the engine when its output is not frames', async () => {
    const { slotId, engine } = await openReady()
    engine.send(event.frame([9]))
    expect(engine.killed).toBe(1)
    expect(owner.sent).toEqual([[NATIVE_SLOT_EXIT_CHANNEL, { slotId }]])
  })

  it.each([
    ['empty text', '', 'af_heart', 1, 'Text must be'],
    ['text over the limit', 'x'.repeat(1001), 'af_heart', 1, 'Text must be'],
    ['text that is not a string', 7, 'af_heart', 1, 'Text must be'],
    ['a voice that is not a string', 'Hi.', null, 1, 'Unknown voice'],
    ['a voice name that is too long', 'Hi.', 'v'.repeat(65), 1, 'Unknown voice'],
    ['a speed that is not a number', 'Hi.', 'af_heart', '1', 'Speed must be'],
    ['a speed that is not finite', 'Hi.', 'af_heart', Number.NaN, 'Speed must be'],
    ['an infinite speed', 'Hi.', 'af_heart', Number.POSITIVE_INFINITY, 'Speed must be'],
    ['a speed below the range', 'Hi.', 'af_heart', 0.4, 'Speed must be'],
    ['a speed above the range', 'Hi.', 'af_heart', 2.1, 'Speed must be']
  ])('refuses %s', async (_label, text, voice, speed, message) => {
    const { slotId, engine } = await openReady()
    expect(() => slots.speak(owner, slotId, text, voice, speed)).toThrow(message)
    await flush()
    expect(prepare).not.toHaveBeenCalled()
    expect(engine.runs()).toEqual([])
  })

  it('accepts text at the limit and any voice name, which the front end replaces when unknown', async () => {
    const { slotId } = await openReady()
    void slots.speak(owner, slotId, 'x'.repeat(1000), 'zz_nobody', 2)
    await flush()
    expect(prepare).toHaveBeenCalledWith(KOKORO_82M, 'x'.repeat(1000), 'zz_nobody')
  })

  it("refuses another window's slot", async () => {
    const { slotId, engine } = await openReady()
    const other = new FakeOwner()
    expect(() => slots.speak(other, slotId, 'Hi.', 'af_heart', 1)).toThrow('not running')
    expect(() => slots.cancel(other, slotId)).toThrow('not running')
    expect(() => slots.close(other, slotId)).toThrow('not running')
    expect(() => slots.speak(owner, 'x', 'Hi.', 'af_heart', 1)).toThrow('not running')
    expect(engine.cancels()).toEqual([])
    expect(slots.size).toBe(1)
  })

  it('refuses requests before the model loaded', async () => {
    const opening = slots.open(owner, 'kokoro-82m')
    await flush()
    // Slot ids are not known before the open resolves; a guessed one is refused.
    expect(() => slots.speak(owner, 1, 'Hi.', 'af_heart', 1)).toThrow('still loading')
    FakeEngine.all[0].send(event.ready())
    await opening
  })

  it('opens at most four slots per window', async () => {
    for (let index = 0; index < 4; index++) await openReady()
    await expect(slots.open(owner, 'kokoro-82m')).rejects.toThrow('Too many')
    // Another window has its own allowance.
    await openReady(new FakeOwner())
    expect(slots.size).toBe(5)
  })

  it.each([
    ['reloads', (by: FakeOwner) => by.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })],
    ['crashes', (by: FakeOwner) => by.emit('render-process-gone')]
  ])('opens no slot when the page %s while the download is being checked', async (_label, pageGoes) => {
    let answer: ((downloaded: boolean) => void) | null = null
    slots = create({
      // Only the first check waits for the test.
      isDownloaded: () => (answer ? Promise.resolve(true) : new Promise<boolean>((resolve) => (answer = resolve)))
    })
    const opening = slots.open(owner, 'kokoro-82m')
    pageGoes(owner)
    answer!(true)
    await expect(opening).rejects.toThrow('reloaded')
    expect(FakeEngine.all).toHaveLength(0)
    expect(slots.size).toBe(0)
    // The new page in the same window opens normally.
    expect((await openReady()).slotId).toBeGreaterThan(0)
  })

  it('gives up an open whose page reloads while the model loads, and lets the engine idle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const opening = slots.open(owner, 'kokoro-82m')
    await flush()
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    FakeEngine.all[0].send(event.ready())
    await expect(opening).rejects.toThrow('stopped')
    expect(slots.size).toBe(0)
    vi.advanceTimersByTime(ENGINE_IDLE_MS)
    expect(FakeEngine.all[0].killed).toBe(1)
  })

  it.each([
    ['closes', (by: FakeOwner) => by.emit('destroyed')],
    ['loses its renderer', (by: FakeOwner) => by.emit('render-process-gone')],
    ['reloads', (by: FakeOwner) => by.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })]
  ])('closes every slot of a window that %s and stops its segments', async (_label, pageEvent) => {
    const first = await openReady()
    await openReady()
    await openReady(new FakeOwner())
    const running = await speakSent(first.slotId)
    pageEvent(owner)
    await expect(running.result).rejects.toThrow()
    expect(first.engine.cancels()).toEqual([running.id])
    expect(slots.size).toBe(1)
    expect(first.engine.killed).toBe(0)
  })

  it('keeps the slots on in-page and subframe navigation', async () => {
    await openReady()
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(slots.size).toBe(1)
  })

  it('ends every engine on dispose without reporting it to the windows', async () => {
    const { slotId, engine } = await openReady()
    const running = await speakSent(slotId)
    slots.dispose()
    await expect(running.result).rejects.toThrow('quitting')
    expect(engine.killed).toBe(1)
    expect(owner.sent).toEqual([])
  })
})
