import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelFileFetch, runNativeTtsHost, type NativeSynthesizer } from '../src/main/readAloud/nativeTtsHostCore'
import type { NativeTtsHostEvent, NativeTtsHostModel, NativeTtsHostRequest } from '../src/main/readAloud/nativeTtsProtocol'
import { NATIVE_SLOT_EXIT_CHANNEL, NativeTtsSlots, type NativeTtsOwner, type NativeTtsProcess } from '../src/main/readAloud/NativeTtsSlots'
import { KOKORO_82M } from '../src/shared/readAloud'

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const BASE = `https://huggingface.co/${REPO}/resolve`
const MODEL: NativeTtsHostModel = {
  id: 'kokoro-82m',
  repo: REPO,
  dtype: 'q8',
  defaultVoice: 'af_heart',
  voices: ['af_heart', 'af_bella'],
  files: ['config.json', 'onnx/model_quantized.onnx', 'voices/af_heart.bin', 'voices/af_bella.bin']
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('native read aloud host: model files', () => {
  const requestFile = vi.fn(async (path: string) => new TextEncoder().encode(`bytes of ${path}`))
  const fetchFile = modelFileFetch(MODEL, requestFile)

  beforeEach(() => requestFile.mockClear())

  it("serves the model's own files, voices included, from main", async () => {
    const response = await fetchFile(`${BASE}/main/voices/af_bella.bin`)
    expect(await response.text()).toBe('bytes of voices/af_bella.bin')
    await fetchFile(new URL(`${BASE}/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model_quantized.onnx`))
    expect(requestFile.mock.calls.map(([path]) => path)).toEqual(['voices/af_bella.bin', 'onnx/model_quantized.onnx'])
  })

  it('decodes the path before checking it', async () => {
    await fetchFile(`${BASE}/main/voices%2Faf_heart.bin`)
    expect(requestFile).toHaveBeenCalledWith('voices/af_heart.bin')
  })

  it.each([
    ['a file the model does not have', `${BASE}/main/voices/af_unknown.bin`],
    ['another repository', 'https://huggingface.co/onnx-community/other/resolve/main/config.json'],
    ['a repository whose name only starts the same', `https://huggingface.co/${REPO}-x/resolve/main/config.json`],
    ['another origin', `https://example.com/${REPO}/resolve/main/config.json`],
    ['plain http', `http://huggingface.co/${REPO}/resolve/main/config.json`],
    ['a file URL', 'file:///C:/Users/me/.mousse/models/tts/kokoro-82m/config.json'],
    ['a path that climbs out', `${BASE}/main/../../../etc/passwd`],
    ['an encoded climb', `${BASE}/main/voices/%2e%2e/%2e%2e/secret`],
    ['malformed percent-encoding', `${BASE}/main/voices/%E0%A4%A.bin`],
    ['a query string', `${BASE}/main/config.json?download=true`],
    ['a revision with a slash', `${BASE}/main/x/config.json`],
    ['an unrelated site', 'https://registry.npmjs.org/kokoro-js']
  ])('refuses %s', async (_label, url) => {
    await expect(fetchFile(url)).rejects.toThrow('may not fetch')
    expect(requestFile).not.toHaveBeenCalled()
  })
})

describe('native read aloud host: messages', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function startHost(synthesize: NativeSynthesizer['synthesize'] = async () => ({ samples: new Float32Array([0.5]), sampleRate: 24_000 })) {
    const posted: NativeTtsHostEvent[] = []
    let loadFailure: Error | null = null
    const load = vi.fn(async (): Promise<NativeSynthesizer> => {
      // The library asks for a file the way transformers.js does.
      const config = await fetch(`${BASE}/main/config.json`)
      if (loadFailure) throw loadFailure
      expect(await config.text()).toBe('{}')
      return { synthesize }
    })
    const handle = runNativeTtsHost({ post: (event) => posted.push(event), load })
    const answerFiles = (): void => {
      for (const event of posted) {
        if (event.type === 'file-request' && !answered.has(event.reqId)) {
          answered.add(event.reqId)
          handle({ type: 'file-response', reqId: event.reqId, bytes: new TextEncoder().encode('{}') })
        }
      }
    }
    const answered = new Set<number>()
    return { posted, handle, load, answerFiles, failLoad: (error: Error) => (loadFailure = error) }
  }

  it('loads the model on init through main, then reports ready', async () => {
    const host = startHost()
    host.handle({ type: 'init', model: MODEL })
    await flush()
    expect(host.posted).toEqual([{ type: 'file-request', reqId: 1, path: 'config.json' }])
    host.answerFiles()
    await flush()
    expect(host.posted.at(-1)).toEqual({ type: 'ready' })
  })

  it('reports a model that fails to load', async () => {
    const host = startHost()
    host.failLoad(new Error('bad model'))
    host.handle({ type: 'init', model: MODEL })
    await flush()
    host.answerFiles()
    await flush()
    expect(host.posted.at(-1)).toEqual({ type: 'load-error', message: 'bad model' })
  })

  it('voices requests after the model loaded, falling back to the default voice for an unknown one', async () => {
    const synthesize = vi.fn(async (text: string) => ({ samples: new Float32Array([text.length]), sampleRate: 24_000 }))
    const host = startHost(synthesize)
    host.handle({ type: 'init', model: MODEL })
    host.handle({ type: 'speak', id: 1, text: 'Hello.', voice: 'af_bella', speed: 1 })
    host.handle({ type: 'speak', id: 2, text: 'Hi.', voice: 'zz_nobody', speed: 1.5 })
    await flush()
    expect(synthesize).not.toHaveBeenCalled()
    host.answerFiles()
    await flush()
    expect(synthesize.mock.calls).toEqual([
      ['Hello.', 'af_bella', 1],
      ['Hi.', 'af_heart', 1.5]
    ])
    expect(host.posted.filter((event) => event.type === 'audio')).toMatchObject([
      { type: 'audio', id: 1, sampleRate: 24_000 },
      { type: 'audio', id: 2, sampleRate: 24_000 }
    ])
  })

  it('answers a request it cannot voice with an error for that request and keeps going', async () => {
    let calls = 0
    const host = startHost(async () => {
      calls++
      if (calls === 1) throw new Error('unvoiceable')
      return { samples: new Float32Array([0.1]), sampleRate: 24_000 }
    })
    host.handle({ type: 'init', model: MODEL })
    await flush()
    host.answerFiles()
    host.handle({ type: 'speak', id: 1, text: '???', voice: 'af_heart', speed: 1 })
    host.handle({ type: 'speak', id: 2, text: 'Fine.', voice: 'af_heart', speed: 1 })
    await flush()
    expect(host.posted.filter((event) => event.type === 'audio' || event.type === 'error')).toMatchObject([
      { type: 'error', id: 1, message: 'unvoiceable' },
      { type: 'audio', id: 2 }
    ])
  })

  it('fails a file main could not read', async () => {
    const host = startHost()
    host.handle({ type: 'init', model: MODEL })
    await flush()
    host.handle({ type: 'file-response', reqId: 1, error: 'Kokoro is not downloaded' })
    await flush()
    expect(host.posted.at(-1)).toEqual({ type: 'load-error', message: 'Kokoro is not downloaded' })
  })
})

/** A host process that a test answers by hand. */
class FakeProcess extends EventEmitter implements NativeTtsProcess {
  static all: FakeProcess[] = []
  readonly received: NativeTtsHostRequest[] = []
  killed = 0
  constructor() {
    super()
    FakeProcess.all.push(this)
  }
  postMessage(message: NativeTtsHostRequest): void {
    this.received.push(message)
  }
  kill(): boolean {
    this.killed++
    return true
  }
  send(event: NativeTtsHostEvent): void {
    this.emit('message', event)
  }
  speakIds(): number[] {
    return this.received.flatMap((message) => (message.type === 'speak' ? [message.id] : []))
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

describe('native read aloud slots in main', () => {
  let downloaded: boolean
  const readFile = vi.fn(async (_modelId: string, path: string): Promise<Uint8Array> => {
    if (path === 'voices/af_nicole.bin') throw new Error('No network')
    return new Uint8Array([1, 2, 3])
  })
  let slots: NativeTtsSlots
  let owner: FakeOwner

  beforeEach(() => {
    FakeProcess.all = []
    downloaded = true
    readFile.mockClear()
    slots = new NativeTtsSlots({ fork: () => new FakeProcess(), readFile, isDownloaded: async () => downloaded })
    owner = new FakeOwner()
  })

  /** Opens a slot and lets its host report the model loaded. */
  async function openReady(by: FakeOwner = owner): Promise<{ slotId: number; host: FakeProcess }> {
    const opening = slots.open(by, 'kokoro-82m')
    await flush()
    const host = FakeProcess.all.at(-1)!
    host.send({ type: 'ready' })
    return { slotId: await opening, host }
  }

  it('starts a host for a downloaded Kokoro model and resolves once its model loaded', async () => {
    const opening = slots.open(owner, 'kokoro-82m')
    await flush()
    const [host] = FakeProcess.all
    expect(host.received[0]).toEqual({
      type: 'init',
      model: {
        id: 'kokoro-82m',
        repo: KOKORO_82M.repo,
        dtype: 'q8',
        defaultVoice: 'af_heart',
        voices: KOKORO_82M.voices.map((voice) => voice.id),
        files: KOKORO_82M.files.map((file) => file.path)
      }
    })
    host.send({ type: 'ready' })
    expect(await opening).toBeGreaterThan(0)
  })

  it.each([
    ['an unknown model', 'nope', 'no native engine'],
    ['a model of another family', 'kitten-tts-micro', 'no native engine'],
    ['a model id that is not a string', 42, 'no native engine']
  ])('refuses %s', async (_label, modelId, message) => {
    await expect(slots.open(owner, modelId)).rejects.toThrow(message)
    expect(FakeProcess.all).toHaveLength(0)
  })

  it('refuses a model that is not downloaded', async () => {
    downloaded = false
    await expect(slots.open(owner, 'kokoro-82m')).rejects.toThrow('not downloaded')
    expect(FakeProcess.all).toHaveLength(0)
  })

  it('fails the open and kills the host when the model does not load', async () => {
    const opening = slots.open(owner, 'kokoro-82m')
    await flush()
    FakeProcess.all[0].send({ type: 'load-error', message: 'bad model' })
    await expect(opening).rejects.toThrow('bad model')
    expect(FakeProcess.all[0].killed).toBe(1)
    expect(slots.size).toBe(0)
  })

  it('fails the open when the host exits while loading', async () => {
    const opening = slots.open(owner, 'kokoro-82m')
    await flush()
    FakeProcess.all[0].emit('exit', 1)
    await expect(opening).rejects.toThrow('stopped unexpectedly')
  })

  it('relays speech and per-request errors from the host', async () => {
    const { slotId, host } = await openReady()
    const first = slots.speak(owner, slotId, 'Hello.', 'af_heart', 1)
    const second = slots.speak(owner, slotId, 'Hi.', 'af_heart', 1)
    const [one, two] = host.speakIds()
    host.send({ type: 'audio', id: one, samples: new Float32Array([0.5]), sampleRate: 24_000 })
    host.send({ type: 'error', id: two, message: 'unvoiceable' })
    expect(await first).toEqual({ samples: new Float32Array([0.5]), sampleRate: 24_000 })
    expect(await second).toEqual({ error: 'unvoiceable' })
  })

  it("answers the host's file requests from the model download, errors included", async () => {
    const { host } = await openReady()
    host.send({ type: 'file-request', reqId: 1, path: 'voices/af_bella.bin' })
    host.send({ type: 'file-request', reqId: 2, path: 'voices/af_nicole.bin' })
    await flush()
    expect(readFile.mock.calls).toEqual([
      ['kokoro-82m', 'voices/af_bella.bin'],
      ['kokoro-82m', 'voices/af_nicole.bin']
    ])
    expect(host.received.slice(1)).toEqual([
      { type: 'file-response', reqId: 1, bytes: new Uint8Array([1, 2, 3]) },
      { type: 'file-response', reqId: 2, error: 'No network' }
    ])
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
    const { slotId, host } = await openReady()
    expect(() => slots.speak(owner, slotId, text, voice, speed)).toThrow(message)
    expect(host.speakIds()).toEqual([])
  })

  it('accepts text at the limit and an unknown voice name, which the host replaces', async () => {
    const { slotId, host } = await openReady()
    void slots.speak(owner, slotId, 'x'.repeat(1000), 'zz_nobody', 2)
    expect(host.speakIds()).toHaveLength(1)
  })

  it("refuses another window's slot", async () => {
    const { slotId, host } = await openReady()
    const other = new FakeOwner()
    expect(() => slots.speak(other, slotId, 'Hi.', 'af_heart', 1)).toThrow('not running')
    expect(() => slots.close(other, slotId)).toThrow('not running')
    expect(() => slots.speak(owner, 'x', 'Hi.', 'af_heart', 1)).toThrow('not running')
    expect(host.killed).toBe(0)
  })

  it('refuses requests before the model loaded', async () => {
    const opening = slots.open(owner, 'kokoro-82m')
    await flush()
    // Slot ids are not known before the open resolves; a guessed one is refused.
    expect(() => slots.speak(owner, 1, 'Hi.', 'af_heart', 1)).toThrow('still loading')
    FakeProcess.all[0].send({ type: 'ready' })
    await opening
  })

  it('runs at most four slots per window', async () => {
    for (let index = 0; index < 4; index++) await openReady()
    await expect(slots.open(owner, 'kokoro-82m')).rejects.toThrow('Too many')
    // Another window has its own allowance.
    await openReady(new FakeOwner())
    expect(slots.size).toBe(5)
  })

  it('kills the host on close and fails its pending requests', async () => {
    const { slotId, host } = await openReady()
    const pending = slots.speak(owner, slotId, 'Hi.', 'af_heart', 1)
    slots.close(owner, slotId)
    await expect(pending).rejects.toThrow('stopped')
    expect(host.killed).toBe(1)
    expect(slots.size).toBe(0)
    // A closed slot exiting afterwards is not reported.
    host.emit('exit', 0)
    expect(owner.sent).toEqual([])
  })

  it('fails pending requests and tells the window when a host exits unexpectedly', async () => {
    const { slotId, host } = await openReady()
    const pending = slots.speak(owner, slotId, 'Hi.', 'af_heart', 1)
    host.emit('exit', 3)
    await expect(pending).rejects.toThrow('stopped unexpectedly')
    expect(owner.sent).toEqual([[NATIVE_SLOT_EXIT_CHANNEL, { slotId }]])
    expect(slots.size).toBe(0)
  })

  it.each([
    ['closes', (by: FakeOwner) => by.emit('destroyed')],
    ['loses its renderer', (by: FakeOwner) => by.emit('render-process-gone')],
    ['reloads', (by: FakeOwner) => by.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })]
  ])('kills every slot of a window that %s', async (_label, event) => {
    const first = await openReady()
    const second = await openReady()
    const other = await openReady(new FakeOwner())
    event(owner)
    expect([first.host.killed, second.host.killed, other.host.killed]).toEqual([1, 1, 0])
    expect(slots.size).toBe(1)
  })

  it('keeps the slots on in-page and subframe navigation', async () => {
    const { host } = await openReady()
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(host.killed).toBe(0)
  })
})
