import { describe, expect, it } from 'vitest'
import { PARAKEET_TDT_06B_V3, PARAKEET_TDT_110M, type NemoTransducerSttModel } from '../src/shared/dictation'
import { recognizeNemo, toEncoderInput, type NemoRecognizer, type OrtRuntime } from '../src/renderer/dictation/nemoRecognizer'

class FakeTensor {
  constructor(
    readonly type: string,
    readonly data: ArrayLike<number | bigint>,
    readonly dims: number[]
  ) {}
}

describe('toEncoderInput', () => {
  it('turns [frames, bins] into [bins, frames] and zeroes NaN bins', () => {
    // frames=2, bins=3: rows are frames.
    const out = toEncoderInput([1, 2, 3, 4, Number.NaN, 6], 2, 3)
    expect(Array.from(out)).toEqual([1, 4, 2, 0, 3, 6])
  })
})

/** A recognizer whose three sessions are fakes: the joiner says "token 1" once, then blank for the rest. */
function fakeRecognizer(model: NemoTransducerSttModel, vocabularySize: number) {
  const vocabulary = Array.from({ length: vocabularySize }, (_, index) => (index === vocabularySize - 1 ? '<blk>' : `▁t${index}`))
  const blank = vocabularySize - 1
  const frames = 4
  const decoderCalls: Array<{ token: number; hiddenDims: number[]; cellDims: number[] }> = []
  const encoderInputs: Record<string, FakeTensor>[] = []
  let jointCalls = 0
  const durations = 5
  const logits = (token: number, duration: number): Float32Array => {
    const out = new Float32Array(vocabularySize + durations)
    out[token] = 1
    out[vocabularySize + duration] = 1
    return out
  }

  const recognizer = {
    model,
    ort: { Tensor: FakeTensor } as unknown as OrtRuntime,
    features: (async () => ({ input_features: { dims: [1, frames * 8, model.featureSize], data: new Float32Array(frames * 8 * model.featureSize) } })) as never,
    vocabulary,
    encoder: {
      inputNames: ['audio_signal', 'length'],
      outputNames: ['outputs', 'encoded_lengths'],
      run: async (inputs: Record<string, FakeTensor>) => {
        encoderInputs.push(inputs)
        return {
          outputs: new FakeTensor('float32', new Float32Array(1024 * frames), [1, 1024, frames]),
          encoded_lengths: new FakeTensor('int64', BigInt64Array.from([BigInt(frames)]), [1])
        }
      }
    },
    decoder: {
      inputNames: ['targets', 'target_length', 'h', 'c'],
      outputNames: ['out', 'lengths', 'h2', 'c2'],
      run: async (inputs: Record<string, FakeTensor>) => {
        decoderCalls.push({ token: Number(inputs.targets.data[0]), hiddenDims: inputs.h.dims, cellDims: inputs.c.dims })
        return {
          out: new FakeTensor('float32', new Float32Array(model.predictorSize), [1, model.predictorSize, 1]),
          lengths: new FakeTensor('int32', Int32Array.from([1]), [1]),
          h2: inputs.h,
          c2: inputs.c
        }
      }
    },
    joiner: {
      inputNames: ['enc', 'dec'],
      outputNames: ['out'],
      run: async () => {
        jointCalls += 1
        // Frame 0: emit token 1 and stay; frame 0 again: blank, skip 1; the rest: blank, skip 1.
        return { out: new FakeTensor('float32', jointCalls === 1 ? logits(1, 0) : logits(blank, 1), [1, 1, 1, vocabularySize + durations]) }
      }
    }
  } as unknown as NemoRecognizer
  return { recognizer, decoderCalls, encoderInputs }
}

describe('recognizeNemo', () => {
  it('starts from the vocabulary blank with zeroed LSTM states sized from the manifest', async () => {
    const { recognizer, decoderCalls, encoderInputs } = fakeRecognizer(PARAKEET_TDT_06B_V3, 8193)
    const text = await recognizeNemo(recognizer, new Float32Array(16000))
    expect(text).toBe('t1')
    // The start call and the call after the emitted token both carry a [layers, 1, width] state.
    expect(decoderCalls.map((call) => call.token)).toEqual([8192, 1])
    for (const call of decoderCalls) {
      expect(call.hiddenDims).toEqual([2, 1, 640])
      expect(call.cellDims).toEqual([2, 1, 640])
    }
    // 128 mel bins go to the encoder as [1, bins, frames].
    expect(encoderInputs[0].audio_signal.dims).toEqual([1, 128, 32])
  })

  it('keeps the 110M model on one layer and 80 bins', async () => {
    const { recognizer, decoderCalls, encoderInputs } = fakeRecognizer(PARAKEET_TDT_110M, 1025)
    await recognizeNemo(recognizer, new Float32Array(16000))
    expect(decoderCalls[0]).toEqual({ token: 1024, hiddenDims: [1, 1, 640], cellDims: [1, 1, 640] })
    expect(encoderInputs[0].audio_signal.dims).toEqual([1, 80, 32])
  })
})
