import { KOKORO_82M } from '../../shared/readAloud'
import { setupLocalModelWorker, type ModelFileRequest, type ModelFileResponse } from '../speechModels/workerSupport'

/** Messages from the page to the worker. */
export type KokoroWorkerRequest =
  | { type: 'speak'; id: number; text: string }
  | { type: 'cancel'; id: number }
  | ModelFileResponse

/** Messages from the worker to the page. */
export type KokoroWorkerEvent =
  | ModelFileRequest
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; message: string }

type KokoroModule = typeof import('kokoro-js')
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

const post = (event: KokoroWorkerEvent, transfer: Transferable[] = []): void => {
  ;(self as unknown as Worker).postMessage(event, transfer)
}

const support = setupLocalModelWorker({ repo: KOKORO_82M.repo, files: KOKORO_82M.files, post })

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
  if (support.handleMessage(message)) return
  if (message.type === 'speak') {
    queue = queue.then(() => speak(message.id, message.text))
  } else if (message.type === 'cancel') {
    cancelled.add(message.id)
  }
})
