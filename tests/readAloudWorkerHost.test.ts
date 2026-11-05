import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalTtsWorkerEvent, LocalTtsWorkerRequest, TtsSynthesizer } from '../src/renderer/readAloud/localTtsWorker'

const setup = vi.hoisted(() => vi.fn(() => ({ handleMessage: () => false })))
vi.mock('../src/renderer/speechModels/workerSupport', () => ({ setupLocalModelWorker: setup }))

/** Stands in for the worker's `self`: the page side sends with `send` and reads `posted`. */
class FakeSelf extends EventTarget {
  readonly posted: LocalTtsWorkerEvent[] = []
  postMessage(event: LocalTtsWorkerEvent): void {
    this.posted.push(event)
  }
  send(message: LocalTtsWorkerRequest): void {
    this.dispatchEvent(new MessageEvent('message', { data: message }))
  }
}

let host: FakeSelf
let finishLoad: () => void
let synthesize: ReturnType<typeof vi.fn<TtsSynthesizer['synthesize']>>
let load: ReturnType<typeof vi.fn<() => Promise<TtsSynthesizer>>>

/** Lets the worker's queue run until nothing more happens. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  host = new FakeSelf()
  vi.stubGlobal('self', host)
  setup.mockClear()
  synthesize = vi.fn(async () => ({ samples: new Float32Array(10), sampleRate: 24_000 }))
  const loaded = new Promise<void>((resolve) => (finishLoad = resolve))
  vi.resetModules()
  const { runLocalTtsWorker } = await import('../src/renderer/readAloud/localTtsWorker')
  load = vi.fn(async () => {
    await loaded
    return { synthesize }
  })
  runLocalTtsWorker({ accepts: (model) => model.runtime === 'kokoro', load } as Parameters<typeof runLocalTtsWorker>[0])
  host.send({ type: 'init', modelId: 'kokoro-82m', threads: 2 })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local read aloud worker loading ahead', () => {
  it('runs the model with the threads the page asked for', () => {
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ threads: 2 }))
  })

  it('loads the model without voicing anything, and answers ready', async () => {
    host.send({ type: 'warm', id: 1 })
    finishLoad()
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    expect(synthesize).not.toHaveBeenCalled()
    expect(host.posted).toEqual([expect.objectContaining({ type: 'ready', id: 1 })])
  })

  it('voices a segment that arrives during loading as soon as the model is loaded, without loading twice', async () => {
    host.send({ type: 'warm', id: 1 })
    host.send({ type: 'speak', id: 2, text: 'Hello there.', voice: 'af_heart', speed: 1 })
    finishLoad()
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    expect(synthesize.mock.calls.map((call) => call[0])).toEqual(['Hello there.'])
    expect(host.posted.map((event) => event.type)).toEqual(['ready', 'audio'])
  })

  it('answers a failed load on the warm request, and the next request tries again', async () => {
    load.mockRejectedValueOnce(new Error('file missing'))
    host.send({ type: 'warm', id: 1 })
    await settle()
    expect(host.posted).toEqual([{ type: 'error', id: 1, message: 'file missing' }])

    host.send({ type: 'speak', id: 2, text: 'Hello there.', voice: 'af_heart', speed: 1 })
    finishLoad()
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
    expect(host.posted.at(-1)).toMatchObject({ type: 'audio', id: 2 })
  })
})
