import { ParakeetFeatureExtractor } from '@huggingface/transformers'
import * as ort from 'onnxruntime-web'
import { PARAKEET_TDT_110M } from '../../shared/dictation'
import { localModelFileUrl } from '../../shared/localModels'
import { setupLocalModelWorker } from '../speechModels/workerSupport'
import { detokenize, greedyTdtSearch, parseTokens } from './tdtSearch'
import type { LocalSttWorkerEvent, LocalSttWorkerRequest } from './workerProtocol'

/**
 * Parakeet TDT runs as three ONNX models: the FastConformer encoder turns log-mel features into
 * frames, and greedy TDT search (`tdtSearch.ts`) walks the frames with the prediction network
 * (decoder) and the joiner, which scores the next token and how many frames to skip.
 */

const model = PARAKEET_TDT_110M
/** Most tokens emitted on one frame before the search is forced forward (NeMo's default). */
const MAX_SYMBOLS_PER_FRAME = 10

const post = (event: LocalSttWorkerEvent): void => {
  ;(self as unknown as Worker).postMessage(event)
}

// Also points onnxruntime-web, which transformers.js shares, at the bundled WebAssembly files.
const support = setupLocalModelWorker({ repo: model.repo, files: model.files, post })

interface Recognizer {
  features: ParakeetFeatureExtractor
  encoder: ort.InferenceSession
  decoder: ort.InferenceSession
  joiner: ort.InferenceSession
  vocabulary: string[]
}

async function readModelFile(path: string): Promise<Uint8Array> {
  const response = await fetch(localModelFileUrl(model, path))
  if (!response.ok) throw new Error(`${model.label} file ${path} is unavailable`)
  return new Uint8Array(await response.arrayBuffer())
}

async function session(path: string): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(await readModelFile(path), { executionProviders: ['wasm'] })
}

let recognizer: Promise<Recognizer> | null = null

function loadRecognizer(): Promise<Recognizer> {
  if (!recognizer) {
    const loading = (async () => {
      const [encoder, decoder, joiner, tokens] = await Promise.all([
        session(model.encoder),
        session(model.decoder),
        session(model.joiner),
        readModelFile(model.tokens)
      ])
      const vocabulary = parseTokens(new TextDecoder().decode(tokens))
      // NeMo's preprocessing for this model: 25 ms Hann windows every 10 ms, 0.97 pre-emphasis.
      const features = new ParakeetFeatureExtractor({
        feature_size: model.featureSize,
        sampling_rate: model.sampleRate,
        hop_length: 160,
        n_fft: 512,
        win_length: 400,
        preemphasis: 0.97
      })
      return { features, encoder, decoder, joiner, vocabulary }
    })()
    loading.catch(() => {
      if (recognizer === loading) recognizer = null
    })
    recognizer = loading
  }
  return recognizer
}

interface Prediction {
  out: ort.Tensor
  hidden: ort.Tensor
  cell: ort.Tensor
}

async function recognize(samples: Float32Array): Promise<string> {
  const { features, encoder, decoder, joiner, vocabulary } = await loadRecognizer()
  const { input_features: input } = await features(samples)
  const [, frames, bins] = input.dims as number[]
  // The extractor returns [1, frames, bins]; the encoder takes [1, bins, frames].
  // A bin that holds one value throughout (seconds of digital silence) normalizes to NaN in the
  // extractor: its variance rounds below zero. Such a bin carries nothing, so it becomes 0.
  const data = input.data as Float32Array
  const transposed = new Float32Array(bins * frames)
  for (let frame = 0; frame < frames; frame += 1) {
    for (let bin = 0; bin < bins; bin += 1) {
      const value = data[frame * bins + bin]
      transposed[bin * frames + frame] = Number.isNaN(value) ? 0 : value
    }
  }
  const encoded = await encoder.run({
    [encoder.inputNames[0]]: new ort.Tensor('float32', transposed, [1, bins, frames]),
    [encoder.inputNames[1]]: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1])
  })
  const output = encoded[encoder.outputNames[0]]
  const length = Number((encoded[encoder.outputNames[1]].data as BigInt64Array)[0])
  const [, dim, steps] = output.dims as number[]
  const frameData = output.data as Float32Array
  const frame = new Float32Array(dim)

  // sherpa-onnx names the decoder's LSTM state tensors after graph nodes, so they are used by position.
  const [targetsName, targetLengthName, hiddenName, cellName] = decoder.inputNames
  const [predictionName, , hiddenOutName, cellOutName] = decoder.outputNames
  const predict = async (token: number, hidden: ort.Tensor, cell: ort.Tensor): Promise<Prediction> => {
    const result = await decoder.run({
      [targetsName]: new ort.Tensor('int32', Int32Array.from([token]), [1, 1]),
      [targetLengthName]: new ort.Tensor('int32', Int32Array.from([1]), [1]),
      [hiddenName]: hidden,
      [cellName]: cell
    })
    return { out: result[predictionName], hidden: result[hiddenOutName], cell: result[cellOutName] }
  }
  const zeros = (): ort.Tensor => new ort.Tensor('float32', new Float32Array(model.predictorSize), [1, 1, model.predictorSize])

  const blank = vocabulary.length - 1
  const tokens = await greedyTdtSearch<Prediction>({
    frames: Math.min(length, steps),
    blank,
    maxSymbolsPerFrame: MAX_SYMBOLS_PER_FRAME,
    start: () => predict(blank, zeros(), zeros()),
    predict: (token, previous) => predict(token, previous.hidden, previous.cell),
    joint: async (step, prediction) => {
      for (let index = 0; index < dim; index += 1) frame[index] = frameData[index * steps + step]
      const joined = await joiner.run({
        [joiner.inputNames[0]]: new ort.Tensor('float32', frame, [1, dim, 1]),
        [joiner.inputNames[1]]: prediction.out
      })
      return joined[joiner.outputNames[0]].data as Float32Array
    }
  })
  return detokenize(vocabulary, tokens)
}

let queue: Promise<void> = Promise.resolve()

async function transcribe(id: number, samples: Float32Array): Promise<void> {
  try {
    post({ type: 'result', id, text: await recognize(samples) })
  } catch (error) {
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
  }
}

self.addEventListener('message', (event: MessageEvent<LocalSttWorkerRequest>) => {
  const message = event.data
  if (support.handleMessage(message)) return
  if (message.type === 'transcribe') queue = queue.then(() => transcribe(message.id, message.samples))
})
