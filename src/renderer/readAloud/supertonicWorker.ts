import * as ort from 'onnxruntime-web'
import type { SupertonicTtsModel } from '../../shared/readAloud'
import { runLocalTtsWorker } from './localTtsWorker'
import { createSupertonicSynthesizer, parseSupertonicVoice, SUPERTONIC_BASE_SPEED, type SupertonicVoice } from './supertonicTts'

/** Supertonic: four ONNX graphs on the bundled WebAssembly runtime; see `supertonicTts.ts`. */
runLocalTtsWorker<SupertonicTtsModel>({
  accepts: (model): model is SupertonicTtsModel => model.runtime === 'supertonic',
  load: async ({ model, readFile }) => {
    const text = async (path: string): Promise<string> => new TextDecoder().decode(await readFile(path))
    const paths = {
      durationPredictor: model.durationPredictor,
      textEncoder: model.textEncoder,
      vectorEstimator: model.vectorEstimator,
      vocoder: model.vocoder
    }
    const supertonic = await createSupertonicSynthesizer(ort, {
      readGraph: (graph) => readFile(paths[graph]),
      config: await text(model.config),
      indexer: await text(model.indexer)
    })
    const voices = new Map<string, Promise<SupertonicVoice>>()
    const loadVoice = (id: string): Promise<SupertonicVoice> => {
      let voice = voices.get(id)
      if (!voice) {
        voice = text(`${model.voiceStyles}/${id}.json`).then(parseSupertonicVoice)
        voice.catch(() => voices.delete(id))
        voices.set(id, voice)
      }
      return voice
    }
    return {
      synthesize: async (segment, voice, speed) => ({
        samples: await supertonic.synthesize(segment, await loadVoice(voice), speed * SUPERTONIC_BASE_SPEED),
        sampleRate: supertonic.sampleRate
      })
    }
  }
})
