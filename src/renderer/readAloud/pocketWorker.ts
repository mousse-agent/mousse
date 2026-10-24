import * as ort from 'onnxruntime-web'
import type { PocketTtsModel } from '../../shared/readAloud'
import { runLocalTtsWorker } from './localTtsWorker'
import { createPocketSynthesizer } from './pocketTts'
import { spokenEnglish } from './spokenEnglish'
import { stretchSpeech } from './timeStretch'

/**
 * Pocket TTS: four INT8 ONNX graphs on the bundled WebAssembly runtime; see `pocketTts.ts`. The
 * model has no speed control, so the finished audio is sped up or slowed down, and it garbles
 * digits and symbols, so English text has them written out first.
 */
runLocalTtsWorker<PocketTtsModel>({
  accepts: (model): model is PocketTtsModel => model.runtime === 'pocket',
  load: async ({ model, readFile }) => {
    const text = async (path: string): Promise<string> => new TextDecoder().decode(await readFile(path))
    const paths = {
      textConditioner: model.textConditioner,
      flowLmMain: model.flowLmMain,
      flowLmFlow: model.flowLmFlow,
      mimiDecoder: model.mimiDecoder
    }
    const pocket = await createPocketSynthesizer(ort, {
      bundle: await text(model.bundle),
      tokenizer: await text(model.tokenizer),
      voices: await readFile(model.voicesFile),
      readGraph: (graph) => readFile(paths[graph])
    })
    return {
      synthesize: async (segment, voice, speed) => {
        const audio = await pocket.synthesize(model.language === 'en' ? spokenEnglish(segment) : segment, voice)
        return { samples: stretchSpeech(audio, pocket.sampleRate, speed), sampleRate: pocket.sampleRate }
      }
    }
  }
})
