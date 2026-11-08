import { AutoTokenizer, StyleTextToSpeech2Model, env } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'
import { runNativeTtsHost, type NativeSynthesizer } from './nativeTtsHostCore'
import type { NativeTtsHostEvent, NativeTtsHostRequest } from './nativeTtsProtocol'

/**
 * The native read aloud host: a utility process started by `NativeTtsSlots`, one per slot, that
 * runs Kokoro through kokoro-js on onnxruntime-node. Killing it stops a segment mid-synthesis,
 * which a WebAssembly worker cannot do. Model files, voices included, come from main over
 * `parentPort`; the build makes kokoro-js fetch its voices instead of reading them beside itself.
 */

/**
 * ONNX Runtime threads per host. One thread voices at about real time; two are about 1.8x and
 * more add little. Read aloud runs two hosts, so four cores at most.
 */
const THREADS = 2

type KokoroVoice = NonNullable<Parameters<KokoroTTS['generate']>[1]>['voice']

// Nothing is cached on disk or in Cache Storage: the app's verified download stays the only copy.
env.allowLocalModels = false
env.useFSCache = false
env.useBrowserCache = false
const noCache = { match: async () => undefined, put: async () => undefined }
Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open: async () => noCache } })

async function loadKokoro(model: { repo: string; dtype: string }): Promise<NativeSynthesizer> {
  // `KokoroTTS.from_pretrained` drops session options, so the model is built here to set the threads.
  const dtype = model.dtype as 'q8'
  const [voiceModel, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(model.repo, {
      dtype,
      device: 'cpu',
      session_options: { intraOpNumThreads: THREADS }
    }),
    AutoTokenizer.from_pretrained(model.repo)
  ])
  const tts = new KokoroTTS(voiceModel, tokenizer)
  return {
    synthesize: async (text, voice, speed) => {
      const audio = await tts.generate(text, { voice: voice as KokoroVoice, speed })
      return { samples: audio.audio, sampleRate: audio.sampling_rate }
    }
  }
}

const port = process.parentPort
const handle = runNativeTtsHost({ post: (event: NativeTtsHostEvent) => port.postMessage(event), load: loadKokoro })
port.on('message', (event) => handle(event.data as NativeTtsHostRequest))
