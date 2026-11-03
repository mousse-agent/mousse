import { ParakeetFeatureExtractor } from '@huggingface/transformers'
import type * as OrtWeb from 'onnxruntime-web'
import type { NemoTransducerSttModel } from '../../shared/dictation'
import { MAX_RESCORED_TERMS, type DictationVocabularyTerm } from '../../shared/dictationVocabulary'
import { detokenize, greedyTdtSearch, parseTokens } from './tdtSearch'
import { DEFAULT_BOOST, decodedWords, findCandidates, tdtSequenceScore, tokenizeTerm, type VocabularyCandidate } from './vocabularyRescoring'

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
  /** Piece text to id, and the longest piece, for writing vocabulary terms as pieces. */
  pieces: Map<string, number>
  longestPiece: number
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
  const pieces = new Map(vocabulary.map((piece, id) => [piece, id] as const))
  const longestPiece = vocabulary.reduce((longest, piece) => Math.max(longest, piece.length), 0)
  // NeMo's preprocessing for these models: 25 ms Hann windows every 10 ms, 0.97 pre-emphasis.
  const features = new ParakeetFeatureExtractor({
    feature_size: model.featureSize,
    sampling_rate: model.sampleRate,
    hop_length: 160,
    n_fft: 512,
    win_length: 400,
    preemphasis: 0.97
  })
  return { model, ort, features, encoder, decoder, joiner, vocabulary, pieces, longestPiece }
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

export async function recognizeNemo(
  recognizer: NemoRecognizer,
  samples: Float32Array,
  terms: readonly DictationVocabularyTerm[] = []
): Promise<string> {
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
  const emitted: Array<{ frame: number; before: Prediction }> = []
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
    },
    onEmit: ({ frame: at, before }) => emitted.push({ frame: at, before })
  })
  if (terms.length === 0) return detokenize(vocabulary, tokens)
  const words = decodedWords(vocabulary, tokens)
  const candidates = findCandidates(words, terms.slice(0, MAX_RESCORED_TERMS))
  if (candidates.length === 0) return detokenize(vocabulary, tokens)

  /** Log probability of writing `pieces` over frames `[from, to)`, continuing from `before`. */
  const score = async (pieces: number[], before: Prediction, from: number, to: number): Promise<number> => {
    const span = to - from
    const encoderSlice = new Float32Array(dim * span)
    for (let row = 0; row < dim; row += 1) encoderSlice.set(frameData.subarray(row * steps + from, row * steps + to), row * span)
    const predicted = await decoder.run({
      [targetsName]: new ort.Tensor('int32', Int32Array.from(pieces), [1, pieces.length]),
      [targetLengthName]: new ort.Tensor('int32', Int32Array.from([pieces.length]), [1]),
      [hiddenName]: before.hidden,
      [cellName]: before.cell
    })
    // The joiner scores every frame against the prediction after each prefix of `pieces` at once.
    const after = predicted[predictionName].data as Float32Array
    const first = before.out.data as Float32Array
    const size = first.length
    const width = pieces.length + 1
    const predictions = new Float32Array(size * width)
    for (let row = 0; row < size; row += 1) {
      predictions[row * width] = first[row]
      predictions.set(after.subarray(row * pieces.length, (row + 1) * pieces.length), row * width + 1)
    }
    const joined = await joiner.run({
      [joiner.inputNames[0]]: new ort.Tensor('float32', encoderSlice, [1, dim, span]),
      [joiner.inputNames[1]]: new ort.Tensor('float32', predictions, [1, size, width])
    })
    const grid = joined[joiner.outputNames[0]].data as Float32Array
    const classes = grid.length / (span * width)
    return tdtSequenceScore(span, pieces, blank, (at, u) => grid.subarray((at * width + u) * classes, (at * width + u + 1) * classes))
  }

  const usable = Math.min(length, steps)
  const heardScores = new Map<string, number>()
  const choices: Array<{ candidate: VocabularyCandidate; margin: number; written: number[] }> = []
  for (const candidate of candidates) {
    const first = words[candidate.startWord]
    const last = words[candidate.endWord - 1]
    const from = emitted[first.start].frame
    const to = candidate.endWord < words.length ? emitted[words[candidate.endWord].start].frame : usable
    const termPieces = tokenizeTerm(candidate.term.term, recognizer.pieces, recognizer.longestPiece)
    if (to <= from || !termPieces) continue
    const written = [...termPieces, ...tokens.slice(last.end - last.punctuation, last.end)]
    if (candidate.spellingOnly) {
      choices.push({ candidate, margin: Number.POSITIVE_INFINITY, written })
      continue
    }
    const key = `${candidate.startWord}:${candidate.endWord}`
    let heard = heardScores.get(key)
    if (heard === undefined) {
      heard = await score(tokens.slice(first.start, last.end), emitted[first.start].before, from, to)
      heardScores.set(key, heard)
    }
    const margin = (await score(written, emitted[first.start].before, from, to)) + DEFAULT_BOOST * termPieces.length - heard
    if (margin >= 0) choices.push({ candidate, margin, written })
  }
  if (choices.length === 0) return detokenize(vocabulary, tokens)

  // The clearest wins first; a span that overlaps one already taken stays as heard.
  choices.sort((a, b) => b.margin - a.margin)
  const taken = new Array<boolean>(words.length).fill(false)
  const replacements = new Map<number, { endWord: number; written: number[] }>()
  for (const { candidate, written } of choices) {
    if (taken.slice(candidate.startWord, candidate.endWord).some(Boolean)) continue
    taken.fill(true, candidate.startWord, candidate.endWord)
    replacements.set(candidate.startWord, { endWord: candidate.endWord, written })
  }
  const rewritten: number[] = []
  for (let index = 0; index < words.length; ) {
    const replacement = replacements.get(index)
    if (replacement) {
      rewritten.push(...replacement.written)
      index = replacement.endWord
    } else {
      rewritten.push(...tokens.slice(words[index].start, words[index].end))
      index += 1
    }
  }
  return detokenize(vocabulary, rewritten)
}
