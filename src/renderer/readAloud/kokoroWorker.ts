import { env } from '@huggingface/transformers'
import ortMjsUrl from '@onnxruntime-web-dist/ort-wasm-simd-threaded.mjs?url'
import ortWasmUrl from '@onnxruntime-web-dist/ort-wasm-simd-threaded.wasm?url'
import { KOKORO_82M } from '../../shared/readAloud'

/** Messages from the page to the worker. */
export type KokoroWorkerRequest =
  | { type: 'speak'; id: number; text: string }
  | { type: 'cancel'; id: number }
  | { type: 'file-response'; reqId: number; bytes?: ArrayBuffer; error?: string }

/** Messages from the worker to the page. */
export type KokoroWorkerEvent =
  | { type: 'file-request'; reqId: number; path: string }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; message: string }

type KokoroModule = typeof import('kokoro-js')
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

const post = (event: KokoroWorkerEvent, transfer: Transferable[] = []): void => {
  ;(self as unknown as Worker).postMessage(event, transfer)
}

const filePaths = new Set(KOKORO_82M.files.map((file) => file.path))
const modelUrl = new RegExp(`^https://huggingface\\.co/${KOKORO_82M.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/resolve/[^/]+/([^?#]+)`)
const pendingFiles = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>()
let nextFileRequest = 1

function requestFile(path: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reqId = nextFileRequest++
    pendingFiles.set(reqId, { resolve, reject })
    post({ type: 'file-request', reqId, path })
  })
}

// Model files come only from the copy downloaded by the app, never from the network.
const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const match = modelUrl.exec(url)
  if (!match) return realFetch(input, init)
  const path = decodeURIComponent(match[1])
  if (!filePaths.has(path)) return new Response(null, { status: 404 })
  try {
    const bytes = await requestFile(path)
    return new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.byteLength) } })
  } catch {
    return new Response(null, { status: 404 })
  }
}

env.allowLocalModels = false
env.useBrowserCache = false
const wasm = env.backends.onnx.wasm
if (wasm) {
  wasm.numThreads = 1
  wasm.proxy = false
  // The CPU build is bundled with the app; nothing is fetched from a CDN.
  wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl }
}

let kokoro: Promise<{ module: KokoroModule; tts: KokoroInstance }> | null = null

function loadKokoro(): Promise<{ module: KokoroModule; tts: KokoroInstance }> {
  if (!kokoro) {
    const loading = (async () => {
      const module = await import('kokoro-js')
      const tts = await module.KokoroTTS.from_pretrained(KOKORO_82M.repo, { dtype: KOKORO_82M.dtype, device: 'wasm' })
      return { module, tts }
    })()
    loading.catch(() => {
      if (kokoro === loading) kokoro = null
    })
    kokoro = loading
  }
  return kokoro
}

const cancelled = new Set<number>()
let queue: Promise<void> = Promise.resolve()

async function speak(id: number, text: string): Promise<void> {
  try {
    if (cancelled.has(id)) return
    const { module, tts } = await loadKokoro()
    if (cancelled.has(id)) return
    // stream() does not close a plain string input, which would drop the last sentence.
    const splitter = new module.TextSplitterStream()
    splitter.push(text)
    splitter.close()
    for await (const { audio } of tts.stream(splitter, { voice: KOKORO_82M.defaultVoice as 'af_heart' })) {
      if (cancelled.has(id)) return
      const samples = audio.audio
      post({ type: 'audio', id, samples, sampleRate: audio.sampling_rate }, [samples.buffer])
    }
    if (!cancelled.has(id)) post({ type: 'done', id })
  } catch (error) {
    if (!cancelled.has(id)) post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    cancelled.delete(id)
  }
}

self.addEventListener('message', (event: MessageEvent<KokoroWorkerRequest>) => {
  const message = event.data
  if (message.type === 'speak') {
    queue = queue.then(() => speak(message.id, message.text))
  } else if (message.type === 'cancel') {
    cancelled.add(message.id)
  } else if (message.type === 'file-response') {
    const pending = pendingFiles.get(message.reqId)
    if (!pending) return
    pendingFiles.delete(message.reqId)
    if (message.bytes) pending.resolve(message.bytes)
    else pending.reject(new Error(message.error ?? 'Model file unavailable'))
  }
})
