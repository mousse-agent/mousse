import { ParakeetFeatureExtractor } from '@huggingface/transformers'
import type * as OrtWeb from 'onnxruntime-web'
import type { NemoTransducerSttModel } from '../../shared/dictation'
import { detokenize, greedyTdtSearch, parseTokens } from './tdtSearch'

/**
 * Parakeet TDT runs as three ONNX models: the FastConformer encoder turns log-mel features into
 * frames, and greedy TDT search (`tdtSearch.ts`) walks the frames with the prediction network
 * (decoder) and the joiner, which scores the next token and how many frames to skip. Everything
 * model-specific (mel bins, state shape, vocabulary) comes from the manifest or the model files, so
 * one implementation serves every NeMo transducer in the list. The ONNX runtime is passed in so the
 * same code runs in the worker (onnxruntime-web) and in Node scripts.
 */

export type OrtRuntime = typeof OrtWeb

/** Most tokens emitted on one frame before the search is forced forward (NeMo's default). */
const MAX_SYMBOLS_PER_FRAME = 10

export interface NemoRecognizer {
  model: NemoTransducerSttModel
  ort: OrtRuntime
  features: ParakeetFeatureExtractor
  encoder: OrtWeb.InferenceSession
  decoder: OrtWeb.InferenceSession
  joiner: OrtWeb.InferenceSession
  vocabulary: string[]
}

export async function loadNemoRecognizer(
  model: NemoTransducerSttModel,
  ort: OrtRuntime,
  readFile: (path: string) => Promise<Uint8Array>
): Promise<NemoRecognizer> {
  const session = async (path: string): Promise<OrtWeb.InferenceSession> =>
    ort.InferenceSession.create(await readFile(path), { executionProviders: ['wasm'] })
  const [encoder, decoder, joiner, tokens] = await Promise.all([
    session(model.encoder),
    session(model.decoder),
    session(model.joiner),
    readFile(model.tokens)
  ])
  const vocabulary = parseTokens(new TextDecoder().decode(tokens))
  // NeMo's preprocessing for these models: 25 ms Hann windows every 10 ms, 0.97 pre-emphasis.
  const features = new ParakeetFeatureExtractor({
    feature_size: model.featureSize,
    sampling_rate: model.sampleRate,
    hop_length: 160,
    n_fft: 512,
    win_length: 400,
    preemphasis: 0.97
  })
  return { model, ort, features, encoder, decoder, joiner, vocabulary }
}

/**
 * The extractor returns [frames, bins]; the encoder takes [bins, frames]. A bin that holds one
 * value throughout (seconds of digital silence) normalizes to NaN in the extractor: its variance
 * rounds below zero. Such a bin carries nothing, so it becomes 0.
 */
export function toEncoderInput(data: ArrayLike<number>, frames: number, bins: number): Float32Array {
  const transposed = new Float32Array(bins * frames)
  for (let frame = 0; frame < frames; frame += 1) {
    for (let bin = 0; bin < bins; bin += 1) {
      const value = data[frame * bins + bin]
      transposed[bin * frames + frame] = Number.isNaN(value) ? 0 : value
    }
  }
  return transposed
}

interface Prediction {
  out: OrtWeb.Tensor
  hidden: OrtWeb.Tensor
  cell: OrtWeb.Tensor
}

export async function recognizeNemo(recognizer: NemoRecognizer, samples: Float32Array): Promise<string> {
  const { model, ort, features, encoder, decoder, joiner, vocabulary } = recognizer
  const { input_features: input } = await features(samples)
  const [, frames, bins] = input.dims as number[]
  const encoded = await encoder.run({
    [encoder.inputNames[0]]: new ort.Tensor('float32', toEncoderInput(input.data as Float32Array, frames, bins), [1, bins, frames]),
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
  const predict = async (token: number, hidden: OrtWeb.Tensor, cell: OrtWeb.Tensor): Promise<Prediction> => {
    const result = await decoder.run({
      [targetsName]: new ort.Tensor('int32', Int32Array.from([token]), [1, 1]),
      [targetLengthName]: new ort.Tensor('int32', Int32Array.from([1]), [1]),
      [hiddenName]: hidden,
      [cellName]: cell
    })
    return { out: result[predictionName], hidden: result[hiddenOutName], cell: result[cellOutName] }
  }
  const stateShape = [model.predictorLayers, 1, model.predictorSize]
  const zeros = (): OrtWeb.Tensor => new ort.Tensor('float32', new Float32Array(model.predictorLayers * model.predictorSize), stateShape)

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
