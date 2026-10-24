import * as ort from 'onnxruntime-web'
import type { KittenTtsModel } from '../../shared/readAloud'
import { KITTEN_SAMPLE_RATE, createKittenSynthesizer } from './kittenTts'
import { runLocalTtsWorker } from './localTtsWorker'

/** KittenTTS: one ONNX graph on the bundled WebAssembly runtime; see `kittenTts.ts`. */
runLocalTtsWorker<KittenTtsModel>({
  accepts: (model): model is KittenTtsModel => model.runtime === 'kitten',
  load: async ({ model, readFile }) => {
    const [graph, config, voices] = await Promise.all([readFile(model.model), readFile(model.config), readFile(model.voicesFile)])
    const kitten = await createKittenSynthesizer(ort, { model: graph, config: new TextDecoder().decode(config), voices })
    return {
      synthesize: async (text, voice, speed) => ({ samples: await kitten.synthesize(text, voice, speed), sampleRate: KITTEN_SAMPLE_RATE })
    }
  }
})
